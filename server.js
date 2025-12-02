import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { initDb, db } from "./db.js";

dotenv.config();

// ---------------------------------------------------------------------
// 🗄️ DB : s'assurer que les colonnes existent
// ---------------------------------------------------------------------

async function ensureSchema() {
  async function addColumnIfMissing(table, column, type) {
    try {
      await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      console.log(`✅ Colonne ajoutée : ${table}.${column}`);
    } catch (e) {
      if (e.message?.includes("duplicate column name")) {
        console.log(`ℹ️ Colonne déjà présente : ${table}.${column}`);
      } else {
        console.warn(`⚠️ Problème ajout colonne ${column} :`, e.message);
      }
    }
  }

  await addColumnIfMissing("initial_stock", "product_title", "TEXT");
  await addColumnIfMissing("initial_stock", "variant_title", "TEXT");
  await addColumnIfMissing("initial_stock", "image", "TEXT");
}

await initDb();
await ensureSchema();

// ---------------------------------------------------------------------
// 📦 Config Shopify
// ---------------------------------------------------------------------

const RAW_SHOP_NAME = (process.env.SHOP_NAME || "").trim();
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const API_VERSION = process.env.API_VERSION || "2024-10";

let SHOP_DOMAIN = RAW_SHOP_NAME
  .replace(/^https?:\/\//, "")
  .replace(/\/admin.*$/i, "")
  .replace(/\/$/, "");

if (!SHOP_DOMAIN.includes(".")) SHOP_DOMAIN = `${SHOP_DOMAIN}.myshopify.com`;

console.log("🛍️ Shopify domain utilisé :", SHOP_DOMAIN);

// ---------------------------------------------------------------------
// 🌐 App Express
// ---------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------
// 🔁 Utilitaires
// ---------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Renvoie la réponse complète (data + headers)
async function shopifyGetRaw(pathUrl, params = {}, retry = 0) {
  const url = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/${pathUrl}`;
  console.log("➡️ Shopify GET (raw) :", url, params);

  try {
    const res = await axios.get(url, {
      headers: { "X-Shopify-Access-Token": ADMIN_API_TOKEN },
      params,
    });
    return res;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 429 && retry < 5) {
      const retryAfter = Number(err.response.headers["retry-after"] || 2);
      console.log(`⚠️ 429 Too Many Requests → Attente ${retryAfter}s`);
      await sleep(retryAfter * 1000 + 300);
      return shopifyGetRaw(pathUrl, params, retry + 1);
    }
    console.error("❌ Shopify error (raw)", status, err.response?.data || err.message);
    throw err;
  }
}

// Version simple (seulement data)
async function shopifyGet(pathUrl, params = {}, retry = 0) {
  const res = await shopifyGetRaw(pathUrl, params, retry);
  return res.data;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// ---------------------------------------------------------------------
// 📥 Récupère TOUS les produits qui ont TOUTES les balises demandées
// ---------------------------------------------------------------------

async function fetchProductsByTags(tagsArray) {
  const requiredTags = tagsArray
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  if (!requiredTags.length) {
    console.log("⚠️ fetchProductsByTags appelé sans tags utiles");
    return [];
  }

  let results = [];
  let pageInfo = null;

  while (true) {
    let params;
    if (!pageInfo) {
      params = {
        limit: 250,
        fields: "id,title,tags,variants,images",
      };
    } else {
      params = {
        limit: 250,
        page_info: pageInfo,
      };
    }

    const res = await shopifyGetRaw("products.json", params);
    const products = res.data.products || [];

    if (!products.length) break;

    for (const p of products) {
      if (!p.tags) continue;

      const tags = p.tags
        .split(",")
        .map((t) => t.trim().toLowerCase());

      // 👉 On ne retient le produit que si TOUTES les balises demandées sont présentes
      const hasAll = requiredTags.every((rt) => tags.includes(rt));
      if (hasAll) {
        results.push(p);
      }
    }

    const linkHeader = res.headers["link"] || res.headers["Link"];
    if (!linkHeader || !linkHeader.includes('rel="next"')) {
      break;
    }

    const match = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>; rel="next"/);
    if (!match) break;
    pageInfo = match[1];
  }

  console.log(
    `📦 fetchProductsByTags(${requiredTags.join(" & ")}) → ${results.length} produits`
  );
  return results;
}

// ---------------------------------------------------------------------
// 📸 SNAPSHOT STOCK INITIAL (multi-balises)
// ---------------------------------------------------------------------

app.post("/api/initial_stock/snapshot", async (req, res) => {
  try {
    const { season } = req.body;
    if (!season) return res.status(400).json({ error: "season required" });

    // Exemple d'input : "FW25, HOMME" ou "adidas;FW25"
    const raw = season.trim();
    const tagParts = raw.split(/[;,]/).map((t) => t.trim()).filter(Boolean);

    if (!tagParts.length) {
      return res.status(400).json({ error: "no valid tags in season field" });
    }

    console.log("📌 Snapshot pour les balises :", tagParts.join(" & "));

    // 1) Tous les produits qui ont TOUTES ces balises
    const taggedProducts = await fetchProductsByTags(tagParts);

    console.log(
      `📦 ${taggedProducts.length} produits avec toutes les balises [${tagParts.join(
        ", "
      )}]`
    );

    // 2) Préparation des variantes
    const variantMeta = [];
    const inventoryItemIdsSet = new Set();

    for (const p of taggedProducts) {
      const image = p.images?.[0]?.src || null;

      for (const v of p.variants || []) {
        variantMeta.push({
          variant_id: v.id,
          inventory_item_id: v.inventory_item_id,
          product_title: p.title,
          variant_title: v.title,
          image,
        });

        if (v.inventory_item_id) {
          inventoryItemIdsSet.add(v.inventory_item_id);
        }
      }
    }

    const inventoryItemIds = Array.from(inventoryItemIdsSet);

    console.log(
      `🧮 Total variantes : ${variantMeta.length}, inventory_item_ids uniques : ${inventoryItemIds.length}`
    );

    // 3) Récupération des stocks par paquets
    const inventoryMap = new Map();
    const chunks = chunkArray(inventoryItemIds, 40);

    for (let i = 0; i < chunks.length; i++) {
      console.log(`📡 Lecture inventaire chunk ${i + 1}/${chunks.length}`);

      const data = await shopifyGet("inventory_levels.json", {
        inventory_item_ids: chunks[i].join(","),
        limit: 250,
      });

      const levels = data.inventory_levels || [];
      for (const lvl of levels) {
        const id = lvl.inventory_item_id;
        const current = inventoryMap.get(id) || 0;
        inventoryMap.set(id, current + (lvl.available || 0));
      }

      if (i + 1 < chunks.length) await sleep(600);
    }

    // 4) Sauvegarde dans la DB
    const toInsert = variantMeta.map((v) => ({
      variant_id: v.variant_id,
      product_title: v.product_title,
      variant_title: v.variant_title,
      image: v.image,
      initial_qty: inventoryMap.get(v.inventory_item_id) || 0,
      // On enregistre la "saison" telle que saisie (ex: "FW25, HOMME")
      season: raw,
    }));

    await Promise.all(
      toInsert.map((i) =>
        db.run(
          `REPLACE INTO initial_stock 
           (variant_id, product_title, variant_title, image, initial_qty, season, snapshot_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            i.variant_id,
            i.product_title,
            i.variant_title,
            i.image,
            i.initial_qty,
            i.season,
            new Date().toISOString(),
          ]
        )
      )
    );

    console.log("✅ Snapshot terminé :", toInsert.length, "lignes.");
    res.json({ success: true, inserted: toInsert.length });
  } catch (e) {
    console.error("❌ snapshot error", e);
    res.status(500).json({ error: "snapshot failed" });
  }
});

// ---------------------------------------------------------------------
// 📥 IMPORT MANUEL (optionnel)
// ---------------------------------------------------------------------

app.post("/api/initial_stock/import", async (req, res) => {
  try {
    const { season, items } = req.body;
    if (!season || !items)
      return res.status(400).json({ error: "season + items required" });

    await Promise.all(
      items.map((i) =>
        db.run(
          `REPLACE INTO initial_stock 
           (variant_id, product_title, variant_title, image, initial_qty, season, snapshot_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            i.variant_id,
            i.product_title || null,
            i.variant_title || null,
            i.image || null,
            i.initial_qty || 0,
            season,
            new Date().toISOString(),
          ]
        )
      )
    );

    res.json({ success: true, inserted: items.length });
  } catch (e) {
    console.error("❌ import error", e);
    res.status(500).json({ error: "import failed" });
  }
});

// ---------------------------------------------------------------------
// 🧾 Webhook : orders/create
// ---------------------------------------------------------------------

app.post("/webhooks/orders_create", async (req, res) => {
  try {
    const order = req.body;

    if (!order?.line_items) return res.status(400).end();

    const ops = order.line_items.map((line) =>
      db.run(
        `INSERT INTO sales (variant_id, sku, qty, order_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          line.variant_id || null,
          line.sku || null,
          line.quantity || 0,
          order.id,
          order.created_at,
        ]
      )
    );

    await Promise.all(ops);
    res.json({ success: true });
  } catch (e) {
    console.error("❌ orders_create webhook error", e);
    res.status(500).json({ error: "webhook failed" });
  }
});

// ---------------------------------------------------------------------
// 📦 Webhook : inventory_levels/update (optionnel)
// ---------------------------------------------------------------------

app.post("/webhooks/inventory_levels_update", async (req, res) => {
  try {
    const p = req.body;

    await db.run(
      `INSERT INTO inventory_changes
       (inventory_item_id, location_id, available, recorded_at)
       VALUES (?, ?, ?, ?)`,
      [
        p.inventory_item_id || null,
        p.location_id || null,
        p.available || 0,
        new Date().toISOString(),
      ]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("❌ inventory webhook error", e);
    res.status(500).json({ error: "inventory webhook failed" });
  }
});

// ---------------------------------------------------------------------
// 📊 API SELL-THROUGH (tableau)
// ---------------------------------------------------------------------

app.get("/api/sellthrough", async (req, res) => {
  try {
    const { season } = req.query;
    if (!season) return res.status(400).json({ error: "season required" });

    const initial = await db.all(
      `SELECT * FROM initial_stock WHERE season = ?`,
      [season]
    );

    const sales = await db.all(
      `SELECT variant_id, SUM(qty) AS sold FROM sales GROUP BY variant_id`
    );

    const soldMap = new Map(sales.map((s) => [String(s.variant_id), s.sold]));

    const results = initial.map((i) => {
      const sold = soldMap.get(String(i.variant_id)) || 0;
      const pct = i.initial_qty ? (sold / i.initial_qty) * 100 : 0;

      return {
        product_title: i.product_title,
        variant_title: i.variant_title,
        image: i.image,
        initial: i.initial_qty,
        sold,
        sell_through_pct: Number(pct.toFixed(1)),
      };
    });
    // 🔤 Tri alphabétique
results.sort((a, b) => a.product_title.localeCompare(b.product_title));


    res.json(results);
  } catch (e) {
    console.error("❌ sellthrough error", e);
    res.status(500).json({ error: "sellthrough failed" });
  }
});

// ---------------------------------------------------------------------
// 🚀 Start server
// ---------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 TAUX DE SORTIE démarré sur port ${PORT}`);
});
