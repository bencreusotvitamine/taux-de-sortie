import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { initDb, db } from "./db.js";

dotenv.config();

// ---------------------------------------------------------------------
// 🗄️ Sécurité : on s'assure que la DB est prête et a bien les colonnes
// ---------------------------------------------------------------------

async function ensureSchema() {
  // Ajoute une colonne si elle n'existe pas déjà
  async function addColumnIfMissing(table, column, type) {
    try {
      await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      console.log(`✅ Colonne ajoutée : ${table}.${column}`);
    } catch (e) {
      // SQLite renvoie une erreur si la colonne existe déjà → on ignore
      if (e.message?.includes("duplicate column name")) {
        console.log(`ℹ️ Colonne déjà présente : ${table}.${column}`);
      } else {
        console.warn(
          `⚠️ Problème lors de l'ajout de ${table}.${column} :`,
          e.message
        );
      }
    }
  }

  // On s'assure que initial_stock possède bien ces colonnes
  await addColumnIfMissing("initial_stock", "product_title", "TEXT");
  await addColumnIfMissing("initial_stock", "variant_title", "TEXT");
  await addColumnIfMissing("initial_stock", "image", "TEXT");
}

await initDb();
await ensureSchema();

// ---------------------------------------------------------------------
// 📦 Config Shopify (SHOP_NAME peut être domaine ou URL complète)
// ---------------------------------------------------------------------

const RAW_SHOP_NAME = (process.env.SHOP_NAME || "").trim();
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const API_VERSION = process.env.API_VERSION || "2024-10";

if (!RAW_SHOP_NAME || !ADMIN_API_TOKEN) {
  console.warn("⚠️ SHOP_NAME ou ADMIN_API_TOKEN non définis dans les variables d'environnement");
}

// Normalisation du domaine Shopify
let SHOP_DOMAIN = RAW_SHOP_NAME
  .replace(/^https?:\/\//, "") // enlève https://
  .replace(/\/admin.*$/i, "")  // enlève /admin/...
  .replace(/\/$/, "");         // enlève / final

if (!SHOP_DOMAIN.includes(".")) {
  SHOP_DOMAIN = `${SHOP_DOMAIN}.myshopify.com`;
}

console.log("🛍️  Domaine Shopify utilisé :", SHOP_DOMAIN);

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

async function shopifyGet(pathUrl, params = {}, retry = 0) {
  const url = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/${pathUrl}`;
  console.log("➡️ Appel Shopify :", url, params);

  try {
    const res = await axios.get(url, {
      headers: { "X-Shopify-Access-Token": ADMIN_API_TOKEN },
      params,
    });
    return res.data;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 429 && retry < 5) {
      // Limite Shopify dépassée → on attend et on réessaie
      const retryAfterHeader = err.response.headers["retry-after"];
      const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : 2;
      console.warn(
        `⚠️ Rate limit 429. Attente ${retryAfterSec}s puis retry (${retry + 1}/5).`
      );
      await sleep(retryAfterSec * 1000 + 200);
      return shopifyGet(pathUrl, params, retry + 1);
    }

    console.error("❌ Shopify error", status, err.response?.data || err.message);
    throw err;
  }
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------
// 📸 SNAPSHOT STOCK INITIAL (filtré par TAG = Saison)
// ---------------------------------------------------------------------

app.post("/api/initial_stock/snapshot", async (req, res) => {
  try {
    const { season } = req.body;
    if (!season) return res.status(400).json({ error: "season required" });

    const tag = season.trim();
    const tagLower = tag.toLowerCase();
    console.log("📌 Snapshot pour la balise (saison) :", tag);

    // 1) Récupérer jusqu'à 250 produits
    const productsData = await shopifyGet("products.json", {
      limit: 250,
      fields: "id,title,tags,variants,images",
    });
    const allProducts = productsData.products || [];

    // 2) Filtrer par balise
    const taggedProducts = allProducts.filter((p) => {
      if (!p.tags) return false;
      return p.tags
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .includes(tagLower);
    });

    console.log(
      `📦 ${allProducts.length} produits trouvés, ${taggedProducts.length} avec la balise '${tag}'`
    );

    // 3) Construire la liste des variantes et des inventory_item_ids
    const variantMeta = [];
    const inventoryItemIdsSet = new Set();

    for (const p of taggedProducts) {
      const productImage = p.images?.[0]?.src || null;

      for (const v of p.variants || []) {
        variantMeta.push({
          variant_id: v.id,
          inventory_item_id: v.inventory_item_id,
          product_title: p.title,
          variant_title: v.title,
          image: productImage,
        });

        if (v.inventory_item_id) {
          inventoryItemIdsSet.add(v.inventory_item_id);
        }
      }
    }

    const inventoryItemIds = Array.from(inventoryItemIdsSet);
    console.log(
      `🧮 ${variantMeta.length} variantes, ${inventoryItemIds.length} inventory_item_ids uniques`
    );

    // 4) Récupérer les niveaux de stock par paquets
    const chunkSize = 40;
    const idChunks = chunkArray(inventoryItemIds, chunkSize);
    const inventoryMap = new Map(); // inventory_item_id -> qty

    for (let index = 0; index < idChunks.length; index++) {
      const idsChunk = idChunks[index];
      console.log(
        `📡 Chunk ${index + 1}/${idChunks.length} - ${idsChunk.length} IDs`
      );

      const invData = await shopifyGet("inventory_levels.json", {
        inventory_item_ids: idsChunk.join(","),
        limit: 250,
      });

      const levels = invData.inventory_levels || [];
      for (const lvl of levels) {
        const id = lvl.inventory_item_id;
        const current = inventoryMap.get(id) || 0;
        inventoryMap.set(id, current + (lvl.available ?? 0));
      }

      if (index + 1 < idChunks.length) {
        await sleep(600); // petite pause entre les paquets
      }
    }

    console.log(
      `📊 Inventaire récupéré pour ${inventoryMap.size} inventory_item_ids`
    );

    // 5) Préparer les lignes à insérer
    const toInsert = variantMeta.map((m) => ({
      variant_id: m.variant_id,
      product_title: m.product_title,
      variant_title: m.variant_title,
      image: m.image,
      initial_qty: inventoryMap.get(m.inventory_item_id) || 0,
      season: tag,
    }));

    // 6) Sauvegarde en DB
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

    console.log(`✅ Snapshot terminé. Lignes insérées : ${toInsert.length}`);
    res.json({ success: true, inserted: toInsert.length });
  } catch (e) {
    console.error("❌ snapshot error", e);
    res.status(500).json({ error: "snapshot failed" });
  }
});

// ---------------------------------------------------------------------
// (Optionnel) Import manuel initial_stock via JSON/CSV
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
// 🧾 Webhook : orders/create → enregistrement des ventes
// ---------------------------------------------------------------------

app.post("/webhooks/orders_create", async (req, res) => {
  try {
    const order = req.body;
    if (!order || !order.line_items) return res.status(400).end();

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
    console.error("❌ webhook orders_create error", e);
    res.status(500).json({ error: "webhook failed" });
  }
});

// ---------------------------------------------------------------------
// 📦 Webhook : inventory_levels/update (optionnel / historique)
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
// 📊 API SELL-THROUGH → données pour ton tableau
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

    res.json(results);
  } catch (e) {
    console.error("❌ sellthrough error", e);
    res.status(500).json({ error: "sellthrough failed" });
  }
});

// ---------------------------------------------------------------------
// 🚀 Démarrage du serveur
// ---------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 TAUX DE SORTIE démarrée sur le port ${PORT}`);
});
