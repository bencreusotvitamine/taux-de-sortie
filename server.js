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

const SHOP_NAME = process.env.SHOP_NAME; // ex: vitamine-clubfr.myshopify.com
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN;
const API_VERSION = process.env.API_VERSION || "2024-10";

if (!SHOP_NAME || !ADMIN_API_TOKEN) {
  console.warn("⚠️ SHOP_NAME ou ADMIN_API_TOKEN non définis dans Render/.env");
}

// ---------------------------------------------------------
// Utils
// ---------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeTag(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function parseNextPageUrl(linkHeader) {
  // Shopify REST pagination: Link: <...page_info=xxx>; rel="next", <...>; rel="previous"
  if (!linkHeader) return null;
  const parts = linkHeader.split(",");
  for (const p of parts) {
    const seg = p.trim();
    if (seg.includes('rel="next"')) {
      const m = seg.match(/<([^>]+)>/);
      if (m && m[1]) return m[1];
    }
  }
  return null;
}

// ---------------------------------------------------------
// Shopify caller with 429 retry
// ---------------------------------------------------------
async function shopifyGetAbsolute(url, params = {}) {
  while (true) {
    try {
      console.log(`➡️ Appel Shopify : ${url}`);
      const res = await axios.get(url, {
        headers: { "X-Shopify-Access-Token": ADMIN_API_TOKEN },
        params,
        validateStatus: (s) => s >= 200 && s < 500,
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers["retry-after"] || 2);
        console.warn(`⚠️ 429 Too Many Requests. Retry after ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        continue;
      }

      if (res.status >= 400) {
        throw new Error(
          `Shopify error ${res.status}: ${JSON.stringify(res.data)}`
        );
      }

      return { data: res.data, headers: res.headers };
    } catch (e) {
      // retry network errors a little
      const msg = String(e?.message || e);
      console.error("❌ Shopify call failed:", msg);
      throw e;
    }
  }
}

function shopifyUrl(pathUrl) {
  return `https://${SHOP_NAME}/admin/api/${API_VERSION}/${pathUrl}`;
}

// ---------------------------------------------------------
// Fetch all products by pagination
// ---------------------------------------------------------
async function fetchAllProducts() {
  // Important: fields limit what we download (faster)
  let url = shopifyUrl("products.json");
  const params = {
    limit: 250,
    fields: "id,title,handle,tags,image,images,variants",
  };

  const all = [];
  while (url) {
    const { data, headers } = await shopifyGetAbsolute(url, params);
    if (data?.products?.length) all.push(...data.products);

    const nextUrl = parseNextPageUrl(headers.link);
    url = nextUrl || null;

    // For next pages, Shopify wants NO params except what’s already in nextUrl
    // So we clear params after first call
    params.limit = undefined;
    params.fields = undefined;
  }
  return all;
}

// ---------------------------------------------------------
// Batch inventory levels for many inventory_item_ids
// ---------------------------------------------------------
async function fetchInventoryLevelsSum(inventoryItemIds) {
  // Shopify supports comma-separated inventory_item_ids
  // We'll batch by 50 to reduce calls
  const batches = chunk(inventoryItemIds, 50);
  const map = new Map(); // inventory_item_id -> total available (sum locations)

  for (const b of batches) {
    const url = shopifyUrl("inventory_levels.json");
    const { data } = await shopifyGetAbsolute(url, {
      inventory_item_ids: b.join(","),
      limit: 250,
    });

    const levels = data?.inventory_levels || [];
    for (const lvl of levels) {
      const id = String(lvl.inventory_item_id);
      const prev = map.get(id) || 0;
      map.set(id, prev + (Number(lvl.available) || 0));
    }

    // petite pause pour être safe
    await sleep(250);
  }

  return map;
}

// ---------------------------------------------------------
// API: snapshot (stock initial) by tag(s)
// ---------------------------------------------------------
app.post("/api/initial_stock/snapshot", async (req, res) => {
  try {
    const { tags } = req.body;
    // tags: string "adidas" ou "adidas,nike"
    const tagList = String(tags || "")
      .split(",")
      .map((t) => normalizeTag(t))
      .filter(Boolean);

    if (!tagList.length) {
      return res.status(400).json({ error: "tags required" });
    }

    // 1) Fetch all products
    const products = await fetchAllProducts();
    console.log(`✅ Shopify products fetched: ${products.length}`);

    // 2) Filter by tags (AND logic)
    const filtered = products.filter((p) => {
      const ptags = String(p.tags || "")
        .split(",")
        .map((t) => normalizeTag(t));

      return tagList.every((t) => ptags.includes(t));
    });

    console.log(
      `✅ Filter tags (${tagList.join(" + ")}): ${filtered.length} products`
    );

    // If 0, we stop early (so you SEE it)
    if (!filtered.length) {
      return res.json({ success: true, inserted: 0, products: 0 });
    }

    // 3) Collect all inventory_item_ids from variants
    const inventoryItemIds = [];
    for (const p of filtered) {
      for (const v of p.variants || []) {
        if (v.inventory_item_id) inventoryItemIds.push(String(v.inventory_item_id));
      }
    }

    // 4) Batch fetch inventory sums
    const invMap = await fetchInventoryLevelsSum(inventoryItemIds);

    // 5) Insert / replace initial stock PER VARIANT
    // (si toi tu agrèges par produit côté sellthrough, pas grave)
    const now = new Date().toISOString();

    let inserted = 0;
    for (const p of filtered) {
      const productId = p.id;
      const productTitle = p.title || "";
      const productImage =
        p.image?.src ||
        (Array.isArray(p.images) && p.images[0]?.src) ||
        null;

      for (const v of p.variants || []) {
        const variantId = v.id;
        const variantTitle = v.title || "";
        const sku = v.sku || null;
        const invItemId = String(v.inventory_item_id || "");
        const qty = invMap.get(invItemId) || 0;

        await db.run(
          `REPLACE INTO initial_stock
           (product_id, product_title, product_image, variant_id, variant_title, sku, initial_qty, tags, snapshot_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            productId,
            productTitle,
            productImage,
            variantId,
            variantTitle,
            sku,
            qty,
            tagList.join(","),
            now,
          ]
        );
        inserted++;
      }
    }

    console.log(`✅ snapshot inserted rows: ${inserted}`);
    res.json({ success: true, inserted });
  } catch (e) {
    console.error("❌ snapshot error", e);
    res.status(500).json({ error: "snapshot failed" });
  }
});

// ---------------------------------------------------------
// API: sellthrough (by tag selection)
// ---------------------------------------------------------
app.get("/api/sellthrough", async (req, res) => {
  try {
    const tags = String(req.query.tags || "")
      .split(",")
      .map((t) => normalizeTag(t))
      .filter(Boolean);

    if (!tags.length) return res.status(400).json({ error: "tags required" });

    // initial_stock rows for those tags (we stored tags in initial_stock.tags)
    const initial = await db.all(
      `SELECT * FROM initial_stock
       WHERE tags = ?
      `,
      [tags.join(",")]
    );

    // sales grouped by variant_id
    const sales = await db.all(
      `SELECT variant_id, SUM(qty) as sold
       FROM sales
       GROUP BY variant_id`
    );
    const soldMap = new Map(sales.map((s) => [String(s.variant_id), Number(s.sold) || 0]));

    // Aggregate by product
    const productMap = new Map();
    for (const row of initial) {
      const key = String(row.product_id);
      const sold = soldMap.get(String(row.variant_id)) || 0;

      if (!productMap.has(key)) {
        productMap.set(key, {
          product_id: row.product_id,
          product_title: row.product_title,
          product_image: row.product_image,
          variants_count: 0,
          initial_qty: 0,
          sold_qty: 0,
        });
      }
      const p = productMap.get(key);
      p.variants_count += 1;
      p.initial_qty += Number(row.initial_qty) || 0;
      p.sold_qty += sold;
    }

    const results = Array.from(productMap.values())
      .map((p) => {
        const rate =
          p.initial_qty > 0 ? (p.sold_qty / p.initial_qty) * 100 : 0;
        return {
          ...p,
          sell_through_pct: Number(rate.toFixed(1)),
        };
      })
      .sort((a, b) => a.product_title.localeCompare(b.product_title, "fr"));

    // Top 10 best/worst
    const top10Best = [...results].sort((a, b) => b.sell_through_pct - a.sell_through_pct).slice(0, 10);
    const top10Worst = [...results].sort((a, b) => a.sell_through_pct - b.sell_through_pct).slice(0, 10);

    // Global
    const totalInitial = results.reduce((s, x) => s + x.initial_qty, 0);
    const totalSold = results.reduce((s, x) => s + x.sold_qty, 0);
    const globalRate = totalInitial > 0 ? (totalSold / totalInitial) * 100 : 0;

    res.json({
      tags: tags.join(","),
      totals: {
        initial: totalInitial,
        sold: totalSold,
        sell_through_pct: Number(globalRate.toFixed(1)),
      },
      products: results,
      top10Best,
      top10Worst,
    });
  } catch (e) {
    console.error("❌ sellthrough error", e);
    res.status(500).json({ error: "sellthrough failed" });
  }
});

// ---------------------------------------------------------
// Webhooks (unchanged)
// ---------------------------------------------------------
app.post("/webhooks/orders_create", async (req, res) => {
  try {
    const order = req.body;
    if (!order?.line_items) return res.status(400).end();

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

// ---------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ App TAUX DE SORTIE démarrée sur port ${PORT}`)
);
