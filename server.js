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

// CONFIG (à remplir dans .env)
// SHOP_NAME=ta-boutique.myshopify.com
// ADMIN_API_TOKEN=token_admin_de_ton_app_personnalisee

const SHOP_NAME = process.env.SHOP_NAME; // ex: vitamine-club.myshopify.com
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const API_VERSION = process.env.API_VERSION || "2024-10"; // ajuste si besoin

if (!SHOP_NAME || !ADMIN_API_TOKEN) {
  console.warn("⚠️ SHOP_NAME ou ADMIN_API_TOKEN non définis dans .env");
}

// --- Utilitaires pour appeler Shopify Admin REST ---
async function shopifyGet(pathUrl, params = {}) {
  const url = `https://${SHOP_NAME}/admin/api/${API_VERSION}/${pathUrl}`;
  const res = await axios.get(url, {
    headers: { "X-Shopify-Access-Token": ADMIN_API_TOKEN },
    params,
  });
  return res.data;
}

// --- API : snapshot du stock de départ ---
app.post("/api/initial_stock/snapshot", async (req, res) => {
  try {
    const { season } = req.body;
    if (!season) return res.status(400).json({ error: "season required" });

    const products = await shopifyGet("products.json", { limit: 250 });

    const toInsert = [];
    for (const p of products.products) {
      for (const v of p.variants) {
        const inv = await shopifyGet("inventory_levels.json", {
          inventory_item_ids: v.inventory_item_id,
        });
        let qty = 0;
        if (inv && inv.inventory_levels && inv.inventory_levels.length) {
          for (const lvl of inv.inventory_levels) qty += lvl.available;
        }
        toInsert.push({
          variant_id: v.id,
          sku: v.sku,
          initial_qty: qty,
          season,
        });
      }
    }

    const insertPromises = toInsert.map((i) =>
      db.run(
        `REPLACE INTO initial_stock (variant_id, sku, initial_qty, season, snapshot_at)
         VALUES (?, ?, ?, ?, ?)`,
        [i.variant_id, i.sku, i.initial_qty, i.season, new Date().toISOString()]
      )
    );
    await Promise.all(insertPromises);

    res.json({ success: true, inserted: toInsert.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "snapshot failed" });
  }
});

// --- API : Import CSV simple (envoyé en JSON) ---
app.post("/api/initial_stock/import", async (req, res) => {
  try {
    const { season, items } = req.body;
    if (!season || !items)
      return res.status(400).json({ error: "season + items required" });

    const insertPromises = items.map((i) =>
      db.run(
        `REPLACE INTO initial_stock (variant_id, sku, initial_qty, season, snapshot_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          i.variant_id,
          i.sku || null,
          i.initial_qty || 0,
          season,
          new Date().toISOString(),
        ]
      )
    );
    await Promise.all(insertPromises);
    res.json({ success: true, inserted: items.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "import failed" });
  }
});

// --- Webhook: orders/create ---
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

// --- Webhook: inventory_levels/update ---
app.post("/webhooks/inventory_levels_update", async (req, res) => {
  try {
    const payload = req.body;
    await db.run(
      `INSERT INTO inventory_changes (inventory_item_id, location_id, available, recorded_at)
       VALUES (?, ?, ?, ?)`,
      [
        payload.inventory_item_id || null,
        payload.location_id || null,
        payload.available || 0,
        new Date().toISOString(),
      ]
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "inventory webhook failed" });
  }
});

// --- API pour calculer le sell-through ---
app.get("/api/sellthrough", async (req, res) => {
  try {
    const { season, groupBy } = req.query;
    if (!season) return res.status(400).json({ error: "season param required" });

    const initial = await db.all(
      `SELECT * FROM initial_stock WHERE season = ?`,
      [season]
    );
    const sales = await db.all(
      `SELECT variant_id, SUM(qty) as sold FROM sales GROUP BY variant_id`
    );
    const soldMap = new Map(sales.map((s) => [String(s.variant_id), s.sold]));

    const results = initial.map((i) => {
      const sold = soldMap.get(String(i.variant_id)) || 0;
      const rate = i.initial_qty ? (sold / i.initial_qty) * 100 : null;
      return {
        variant_id: i.variant_id,
        sku: i.sku,
        initial: i.initial_qty,
        sold,
        sell_through_pct: rate == null ? null : Number(rate.toFixed(1)),
        season: i.season,
      };
    });

    res.json(results);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "sellthrough failed" });
  }
});

// --- Démarrage ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`App TAUX DE SORTIE démarrée sur port ${PORT}`)
);
