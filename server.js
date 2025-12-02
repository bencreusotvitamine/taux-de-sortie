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

/* -------------------------------------------------------------------------- */
/*                         NORMALISATION DU DOMAINE                           */
/* -------------------------------------------------------------------------- */

// SHOP_NAME peut être saisi sous plusieurs formes :
// - vitamine-clubfr
// - vitamine-clubfr.myshopify.com
// - https://vitamine-clubfr.myshopify.com
// - https://vitamine-clubfr.myshopify.com/admin

let RAW_SHOP_NAME = (process.env.SHOP_NAME || "").trim();
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const API_VERSION = process.env.API_VERSION || "2024-10";

// Nettoyage automatique
let SHOP_DOMAIN = RAW_SHOP_NAME
  .replace(/^https?:\/\//, "")     // supprime "http://"
  .replace(/\/admin.*$/i, "")      // supprime "/admin/xxxxx"
  .replace(/\/$/, "");             // supprime "/" final

// Si la personne n'a mis que le nom (ex: "vitamine-clubfr")
if (!SHOP_DOMAIN.includes(".")) {
  SHOP_DOMAIN = `${SHOP_DOMAIN}.myshopify.com`;
}

console.log("📦 SHOP_DOMAIN normalisé =", SHOP_DOMAIN);

/* -------------------------------------------------------------------------- */
/*                     FONCTION D'APPEL SHOPIFY ADMIN API                     */
/* -------------------------------------------------------------------------- */

async function shopifyGet(pathUrl, params = {}) {
  const url = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/${pathUrl}`;
  console.log("➡️ Appel Shopify :", url);

  const res = await axios.get(url, {
    headers: { "X-Shopify-Access-Token": ADMIN_API_TOKEN },
    params,
  });

  return res.data;
}

/* -------------------------------------------------------------------------- */
/*                         SNAPSHOT STOCK INITIAL                             */
/* -------------------------------------------------------------------------- */

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
        if (inv?.inventory_levels?.length) {
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

    // Sauvegarde en DB
    await Promise.all(
      toInsert.map((i) =>
        db.run(
          `REPLACE INTO initial_stock (variant_id, sku, initial_qty, season, snapshot_at)
           VALUES (?, ?, ?, ?, ?)`,
          [i.variant_id, i.sku, i.initial_qty, season, new Date().toISOString()]
        )
      )
    );

    res.json({ success: true, inserted: toInsert.length });
  } catch (err) {
    console.error("❌ snapshot error", err);
    res.status(500).json({ error: "snapshot failed" });
  }
});

/* -------------------------------------------------------------------------- */
/*                            IMPORT CSV / JSON                               */
/* -------------------------------------------------------------------------- */

app.post("/api/initial_stock/import", async (req, res) => {
  try {
    const { season, items } = req.body;
    if (!season || !items)
      return res.status(400).json({ error: "season + items required" });

    await Promise.all(
      items.map((i) =>
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
      )
    );

    res.json({ success: true, inserted: items.length });
  } catch (err) {
    console.error("❌ import error", err);
    res.status(500).json({ error: "import failed" });
  }
});

/* -------------------------------------------------------------------------- */
/*                                WEBHOOKS                                   */
/* -------------------------------------------------------------------------- */

// orders/create
app.post("/webhooks/orders_create", async (req, res) => {
  try {
    const order = req.body;
    if (!order?.line_items) return res.status(400).end();

    await Promise.all(
      order.line_items.map((line) =>
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
      )
    );

    res.json({ success: true });
  } catch (err) {
    console.error("❌ webhook order error", err);
    res.status(500).json({ error: "webhook failed" });
  }
});

// inventory_levels/update
app.post("/webhooks/inventory_levels_update", async (req, res) => {
  try {
    const p = req.body;

    await db.run(
      `INSERT INTO inventory_changes (inventory_item_id, location_id, available, recorded_at)
       VALUES (?, ?, ?, ?)`,
      [
        p.inventory_item_id || null,
        p.location_id || null,
        p.available || 0,
        new Date().toISOString(),
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("❌ inventory webhook error", err);
    res.status(500).json({ error: "inventory webhook failed" });
  }
});

/* -------------------------------------------------------------------------- */
/*                     CALCUL DU TAUX DE SORTIE / SELL-THROUGH               */
/* -------------------------------------------------------------------------- */

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
      const pct = i.initial_qty ? (sold / i.initial_qty) * 100 : null;

      return {
        variant_id: i.variant_id,
        sku: i.sku,
        initial: i.initial_qty,
        sold,
        sell_through_pct: pct == null ? null : Number(pct.toFixed(1)),
      };
    });

    res.json(results);
  } catch (err) {
    console.error("❌ sellthrough error", err);
    res.status(500).json({ error: "sellthrough failed" });
  }
});

/* -------------------------------------------------------------------------- */
/*                                START SERVER                               */
/* -------------------------------------------------------------------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 App TAUX DE SORTIE démarrée sur port ${PORT}`)
);
