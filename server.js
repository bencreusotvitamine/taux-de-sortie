import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { initDb, db } from "./db.js";

dotenv.config();
await initDb();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const SHOP_NAME = process.env.SHOP_NAME;
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const API_VERSION = process.env.API_VERSION || "2024-10";

if (!SHOP_NAME || !ADMIN_API_TOKEN) {
  console.warn("⚠️ SHOP_NAME ou ADMIN_API_TOKEN non définis dans .env");
}

// -----------------------------------------------------
// 🟢 Fonction intelligente shopifyGet() avec délai anti-429
// -----------------------------------------------------
async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shopifyGet(pathUrl, params = {}) {
  const url = `https://${SHOP_NAME}/admin/api/${API_VERSION}/${pathUrl}`;

  console.log("➡️ Appel Shopify :", url);

  try {
    const res = await axios.get(url, {
      headers: { "X-Shopify-Access-Token": ADMIN_API_TOKEN },
      params,
    });

    await delay(150); // ralentit un peu les requêtes pour éviter 429
    return res.data;
  } catch (e) {
    if (e.response?.status === 429) {
      console.log("⏳ 429 reçu → pause 2 secondes…");
      await delay(2000);
      return shopifyGet(pathUrl, params); // retry automatique
    }

    console.error("❌ shopifyGet error:", e);
    throw e;
  }
}

// -----------------------------------------------------
// 🟦 API SNAPSHOT — Recherche par TAG (saison)
// -----------------------------------------------------
app.post("/api/initial_stock/snapshot", async (req, res) => {
  try {
    const { season } = req.body;
    if (!season) return res.status(400).json({ error: "season required" });

    console.log("📌 Snapshot saison =", season);

    const products = await shopifyGet("products.json", {
      limit: 250,
      fields: "id,title,tags,variants,images",
    });

    // 👉 filtrage par TAG
    const taggedProducts = products.products.filter((p) =>
      p.tags.toLowerCase().includes(season.toLowerCase())
    );

    const toInsert = [];

    for (const p of taggedProducts) {
      const productImage = p.images?.[0]?.src || null;

      for (const v of p.variants) {
        const inv = await shopifyGet("inventory_levels.json", {
          inventory_item_ids: v.inventory_item_id,
        });

        let qty = 0;
        if (inv?.inventory_levels?.length) {
          qty = inv.inventory_levels.reduce((acc, lvl) => acc + lvl.available, 0);
        }

        toInsert.push({
          variant_id: v.id,
          product_title: p.title,
          variant_title: v.title,
          image: productImage,
          initial_qty: qty,
          season,
        });
      }
    }

    const queries = toInsert.map((i) =>
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
    );

    await Promise.all(queries);

    res.json({ success: true, inserted: toInsert.length });
  } catch (e) {
    console.error("❌ snapshot error", e);
    res.status(500).json({ error: "snapshot failed" });
  }
});

// -----------------------------------------------------
// 🟧 Webhook : orders/create
// -----------------------------------------------------
app.post("/webhooks/orders_create", async (req, res) => {
  try {
    const order = req.body;
    if (!order?.line_items) return res.status(400).end();

    const ops = order.line_items.map((line) =>
      db.run(
        `INSERT INTO sales (variant_id, sku, qty, order_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          line.variant_id,
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

// -----------------------------------------------------
// 🟪 Webhook : inventory_levels/update
// -----------------------------------------------------
app.post("/webhooks/inventory_levels_update", async (req, res) => {
  try {
    const payload = req.body;

    await db.run(
      `INSERT INTO inventory_changes
       (inventory_item_id, location_id, available, recorded_at)
       VALUES (?, ?, ?, ?)`,
      [
        payload.inventory_item_id,
        payload.location_id,
        payload.available,
        new Date().toISOString(),
      ]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("❌ inventory webhook error", e);
    res.status(500).json({ error: "inventory webhook failed" });
  }
});

// -----------------------------------------------------
// 🟩 API SELL-THROUGH (pour ton tableau)
// -----------------------------------------------------
app.get("/api/sellthrough", async (req, res) => {
  try {
    const { season } = req.query;
    if (!season) return res.status(400).json({ error: "season param required" });

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

// -----------------------------------------------------
// 🚀 Démarrage serveur
// -----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 TAUX DE SORTIE actif sur port ${PORT}`);
});
