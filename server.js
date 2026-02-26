import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";
import { initDb, db } from "./db.js";

dotenv.config();
await initDb();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// =====================
// ENV
// =====================
const SHOP_NAME = process.env.SHOP_NAME; // ex: vitamine-clubfr.myshopify.com
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const API_VERSION = process.env.API_VERSION || "2024-10";

if (!SHOP_NAME || !ADMIN_API_TOKEN) {
  console.warn("⚠️ SHOP_NAME ou ADMIN_API_TOKEN non définis dans les variables d'environnement (Render).");
}

// =====================
// Axios + keep-alive
// =====================
const httpsAgent = new https.Agent({ keepAlive: true });

const http = axios.create({
  httpsAgent,
  timeout: 30000,
  headers: { "X-Shopify-Access-Token": ADMIN_API_TOKEN },
});

// =====================
// Helpers
// =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeTag(t) {
  return String(t || "")
    .trim()
    .toLowerCase();
}

// L’utilisateur met "adidas" ou "adidas, fw25" ou "adidas + fw25"
function parseTagsInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return [];
  return raw
    .split(/[,;+]/g)
    .map((s) => normalizeTag(s))
    .filter(Boolean);
}

function productHasAllTags(product, requiredTags) {
  if (!requiredTags.length) return true;
  const tags = (product.tags || "")
    .split(",")
    .map((t) => normalizeTag(t));
  return requiredTags.every((rt) => tags.includes(rt));
}

/**
 * Shopify GET avec retry automatique sur 429 (Retry-After)
 */
async function shopifyGet(pathUrl, params = {}, attempt = 0) {
  const url = `https://${SHOP_NAME}/admin/api/${API_VERSION}/${pathUrl}`;

  try {
    // Petit log utile (sans token)
    console.log(`➡️ Appel Shopify : ${url}`);

    const res = await http.get(url, { params });
    return res.data;
  } catch (err) {
    const status = err?.response?.status;

    if (status === 429 && attempt < 8) {
      const retryAfterSec = Number(err.response.headers["retry-after"] || 2);
      const waitMs = Math.max(1000, retryAfterSec * 1000);
      console.warn(`⏳ 429 Shopify (rate limit). Retry dans ${waitMs}ms (attempt ${attempt + 1}/8)`);
      await sleep(waitMs);
      return shopifyGet(pathUrl, params, attempt + 1);
    }

    throw err;
  }
}

/**
 * Récupère tous les produits (pagination since_id)
 * Attention : REST ne filtre pas par tags → on filtre côté code
 */
async function fetchAllProducts() {
  const all = [];
  let since_id = 0;

  while (true) {
    // On garde la payload raisonnable
    const data = await shopifyGet("products.json", {
      limit: 250,
      since_id,
      fields: "id,title,handle,tags,image,variants",
    });

    const batch = data?.products || [];
    if (!batch.length) break;

    all.push(...batch);
    since_id = batch[batch.length - 1].id;

    // petite pause pour rester cool
    await sleep(350);
  }

  return all;
}

/**
 * inventory_levels en batch (ex: 50 inventory_item_ids par appel)
 * Retourne Map(inventory_item_id -> qty totale)
 */
async function fetchInventoryLevelsByInventoryItemIds(inventoryItemIds) {
  const map = new Map();
  const ids = Array.from(new Set(inventoryItemIds.filter(Boolean)));

  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);

    const data = await shopifyGet("inventory_levels.json", {
      inventory_item_ids: chunk.join(","),
    });

    const levels = data?.inventory_levels || [];
    for (const lvl of levels) {
      const key = String(lvl.inventory_item_id);
      const prev = map.get(key) || 0;
      map.set(key, prev + (lvl.available || 0));
    }

    // cadence douce pour éviter les 429
    await sleep(350);
  }

  return map;
}

// =====================
// API
// =====================

/**
 * Snapshot stock de départ basé sur balise(s)
 * Body: { season: "adidas" } ou { season: "adidas, fw25" }
 */
app.post("/api/initial_stock/snapshot", async (req, res) => {
  try {
    const { season } = req.body;
    if (!season) return res.status(400).json({ error: "season required" });

    const requiredTags = parseTagsInput(season);

    // 1) produits
    const products = await fetchAllProducts();

    // 2) filtre tags
    const selected = requiredTags.length
      ? products.filter((p) => productHasAllTags(p, requiredTags))
      : products;

    if (!selected.length) {
      return res.status(200).json({ success: true, inserted: 0, message: "Aucun produit trouvé pour ces balises." });
    }

    // 3) récupère tous les inventory_item_id des variantes
    const allVariants = [];
    for (const p of selected) {
      for (const v of p.variants || []) {
        allVariants.push({
          product_id: p.id,
          product_title: p.title,
          product_image: p.image?.src || null,
          variant_id: v.id,
          variant_title: v.title,
          sku: v.sku || null,
          inventory_item_id: v.inventory_item_id,
        });
      }
    }

    const inventoryItemIds = allVariants.map((x) => x.inventory_item_id);
    const invMap = await fetchInventoryLevelsByInventoryItemIds(inventoryItemIds);

    // 4) écrit en DB (1 ligne par variante)
    const now = new Date().toISOString();

    const insertPromises = allVariants.map((x) => {
      const qty = invMap.get(String(x.inventory_item_id)) || 0;

      return db.run(
        `REPLACE INTO initial_stock
          (variant_id, sku, initial_qty, season, snapshot_at, product_id, product_title, product_image, variant_title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          x.variant_id,
          x.sku,
          qty,
          season, // on stocke exactement ce que tu as tapé (ex: "adidas, fw25")
          now,
          x.product_id,
          x.product_title,
          x.product_image,
          x.variant_title,
        ]
      );
    });

    await Promise.all(insertPromises);

    res.json({ success: true, inserted: allVariants.length });
  } catch (e) {
    console.error("❌ snapshot error", e?.response?.data || e);
    res.status(500).json({ error: "snapshot failed" });
  }
});

/**
 * Webhook orders/create
 * (si tu utilises ça, garde. Sinon pas grave.)
 */
app.post("/webhooks/orders_create", async (req, res) => {
  try {
    const order = req.body;
    if (!order || !order.line_items) return res.status(400).end();

    const ops = [];
    for (const line of order.line_items) {
      ops.push(
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
    }
    await Promise.all(ops);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "webhook failed" });
  }
});

/**
 * SELLTHROUGH regroupé par PRODUIT (1 ligne = 1 produit)
 * Query: /api/sellthrough?season=adidas,fw25
 */
app.get("/api/sellthrough", async (req, res) => {
  try {
    const { season } = req.query;
    if (!season) return res.status(400).json({ error: "season param required" });

    // Récupère snapshot
    const initial = await db.all(
      `SELECT * FROM initial_stock WHERE season = ?`,
      [season]
    );

    // Récupère ventes
    const sales = await db.all(
      `SELECT variant_id, SUM(qty) as sold
       FROM sales
       GROUP BY variant_id`
    );
    const soldMap = new Map(sales.map((s) => [String(s.variant_id), Number(s.sold || 0)]));

    // Regroupe par produit
    const productMap = new Map();

    for (const row of initial) {
      const sold = soldMap.get(String(row.variant_id)) || 0;

      const pid = String(row.product_id || "unknown");
      if (!productMap.has(pid)) {
        productMap.set(pid, {
          product_id: row.product_id,
          product_title: row.product_title || "(sans titre)",
          product_image: row.product_image || null,
          stock_initial: 0,
          sold: 0,
          rate: null,
          variants: [],
        });
      }

      const p = productMap.get(pid);
      p.stock_initial += Number(row.initial_qty || 0);
      p.sold += Number(sold || 0);

      p.variants.push({
        variant_id: row.variant_id,
        variant_title: row.variant_title || null,
        sku: row.sku || null,
        stock_initial: Number(row.initial_qty || 0),
        sold: Number(sold || 0),
        rate: row.initial_qty ? Number(((sold / row.initial_qty) * 100).toFixed(1)) : null,
      });
    }

    const results = Array.from(productMap.values()).map((p) => {
      const rate = p.stock_initial ? (p.sold / p.stock_initial) * 100 : null;
      return {
        ...p,
        rate: rate == null ? null : Number(rate.toFixed(1)),
        variants_count: p.variants.length,
      };
    });

    // Tri alphabétique par titre
    results.sort((a, b) => String(a.product_title).localeCompare(String(b.product_title), "fr", { sensitivity: "base" }));

    res.json(results);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "sellthrough failed" });
  }
});

/**
 * TOP 10 meilleures + pires sorties (sur la sélection season)
 * GET /api/top10?season=adidas
 */
app.get("/api/top10", async (req, res) => {
  try {
    const { season } = req.query;
    if (!season) return res.status(400).json({ error: "season param required" });

    // On réutilise l’API sellthrough (logique identique)
    const initial = await db.all(`SELECT * FROM initial_stock WHERE season = ?`, [season]);
    const sales = await db.all(`SELECT variant_id, SUM(qty) as sold FROM sales GROUP BY variant_id`);
    const soldMap = new Map(sales.map((s) => [String(s.variant_id), Number(s.sold || 0)]));

    const productMap = new Map();
    for (const row of initial) {
      const sold = soldMap.get(String(row.variant_id)) || 0;
      const pid = String(row.product_id || "unknown");

      if (!productMap.has(pid)) {
        productMap.set(pid, {
          product_id: row.product_id,
          product_title: row.product_title || "(sans titre)",
          product_image: row.product_image || null,
          stock_initial: 0,
          sold: 0,
        });
      }
      const p = productMap.get(pid);
      p.stock_initial += Number(row.initial_qty || 0);
      p.sold += Number(sold || 0);
    }

    const arr = Array.from(productMap.values()).map((p) => ({
      ...p,
      rate: p.stock_initial ? Number(((p.sold / p.stock_initial) * 100).toFixed(1)) : 0,
    }));

    // Meilleurs: taux DESC
    const best = [...arr].sort((a, b) => b.rate - a.rate).slice(0, 10);

    // Pires: taux ASC
    const worst = [...arr].sort((a, b) => a.rate - b.rate).slice(0, 10);

    res.json({ best, worst });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "top10 failed" });
  }
});

// =====================
// Start
// =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ App TAUX DE SORTIE démarrée sur port ${PORT}`));
