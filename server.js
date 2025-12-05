// server.js – TAUX DE SORTIE (version complète avec Top 10 best + worst)

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
  console.warn("⚠️ SHOP_NAME ou ADMIN_API_TOKEN non définis dans l'environnement.");
}

// ----------------------------
// Utilitaire Shopify REST
// ----------------------------
async function shopifyGet(pathUrl, params = {}) {
  const url = `https://${SHOP_NAME}/admin/api/${API_VERSION}/${pathUrl}`;
  console.log("➡️ Appel Shopify :", url);
  const res = await axios.get(url, {
    headers: {
      "X-Shopify-Access-Token": ADMIN_API_TOKEN,
      "Content-Type": "application/json",
    },
    params,
  });
  return res.data;
}

// ----------------------------
// PAGE FRONT (Dashboard)
// ----------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ----------------------------
// 1) Snapshot du stock de départ
// ----------------------------
//
// On prend un "instantané" des stocks actuels par variante
// et on les enregistre dans la table initial_stock pour une saison donnée.
//
app.post("/api/initial_stock/snapshot", async (req, res) => {
  try {
    const { season } = req.body;
    if (!season) {
      return res.status(400).json({ error: "season required" });
    }

    // 1. Récupérer les produits (limite 250 pour rester simple)
    const productsData = await shopifyGet("products.json", { limit: 250 });
    const products = productsData.products || productsData || [];

    const rowsToInsert = [];

    // 2. Pour chaque variante, on récupère son stock via inventory_levels
    for (const p of products) {
      for (const v of p.variants) {
        const invData = await shopifyGet("inventory_levels.json", {
          inventory_item_ids: v.inventory_item_id,
        });

        let qty = 0;
        if (
          invData &&
          invData.inventory_levels &&
          Array.isArray(invData.inventory_levels)
        ) {
          for (const lvl of invData.inventory_levels) {
            qty += lvl.available || 0;
          }
        }

        rowsToInsert.push({
          variant_id: v.id,
          sku: v.sku || null,
          initial_qty: qty,
          season,
          product_id: p.id,
          product_title: p.title,
          product_handle: p.handle,
          product_type: p.product_type || null,
          product_tags: p.tags || "",
          image_src: p.image?.src || null,
          variant_title: v.title || null,
        });
      }
    }

    // 3. Enregistrer dans SQLite
    const insertPromises = rowsToInsert.map((r) =>
      db.run(
        `
        REPLACE INTO initial_stock (
          variant_id,
          sku,
          initial_qty,
          season,
          snapshot_at,
          product_id,
          product_title,
          product_handle,
          product_type,
          product_tags,
          image_src,
          variant_title
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          r.variant_id,
          r.sku,
          r.initial_qty,
          r.season,
          new Date().toISOString(),
          r.product_id,
          r.product_title,
          r.product_handle,
          r.product_type,
          r.product_tags,
          r.image_src,
          r.variant_title,
        ]
      )
    );

    await Promise.all(insertPromises);

    res.json({
      success: true,
      inserted: rowsToInsert.length,
    });
  } catch (err) {
    console.error("❌ snapshot error", err);
    res.status(500).json({ error: "snapshot failed" });
  }
});

// ----------------------------
// 2) Webhook Orders (ventes)
// ----------------------------
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
  } catch (err) {
    console.error("❌ order webhook error", err);
    res.status(500).json({ error: "webhook failed" });
  }
});

// ----------------------------
// 3) Sell-through (taux de sortie)
// ----------------------------
//
// Retourne :
//  - products : tableau des produits agrégés (regroupe toutes les variantes)
//  - topBest10 : top 10 meilleures sorties
//  - topWorst10 : top 10 pires sorties
//
app.get("/api/sellthrough", async (req, res) => {
  try {
    const { season, tags } = req.query;

    if (!season) {
      return res.status(400).json({ error: "season param required" });
    }

    // Liste des balises à filtrer (séparées par virgule)
    const tagList =
      tags
        ?.split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean) || [];

    // 1. Récupérer le stock de départ pour la saison
    const initialRows = await db.all(
      `SELECT * FROM initial_stock WHERE season = ?`,
      [season]
    );

    if (!initialRows.length) {
      return res.json({
        products: [],
        topBest10: [],
        topWorst10: [],
      });
    }

    // 2. Récupérer les ventes agrégées par variante
    const salesRows = await db.all(
      `SELECT variant_id, SUM(qty) AS sold FROM sales GROUP BY variant_id`
    );
    const soldMap = new Map(
      salesRows.map((s) => [String(s.variant_id), s.sold || 0])
    );

    // 3. Récupérer les infos produits depuis Shopify
    const productsData = await shopifyGet("products.json", { limit: 250 });
    const products = productsData.products || productsData || [];

    const variantToProduct = new Map();

    for (const p of products) {
      const productTags = (p.tags || "")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);

      // Filtre par balises : le produit doit contenir TOUTES les balises demandées
      const matchTags =
        !tagList.length ||
        tagList.every((wanted) => productTags.includes(wanted));

      if (!matchTags) continue;

      for (const v of p.variants) {
        variantToProduct.set(String(v.id), {
          product_id: p.id,
          product_title: p.title,
          product_handle: p.handle,
          product_type: p.product_type || null,
          product_tags: p.tags || "",
          image_src: p.image?.src || null,
          variant_title: v.title || null,
          sku: v.sku || null,
        });
      }
    }

    // 4. Agrégation par produit
    const productMap = new Map();

    for (const row of initialRows) {
      const meta = variantToProduct.get(String(row.variant_id));
      if (!meta) continue; // variante non présente ou filtrée par balise

      const sold = soldMap.get(String(row.variant_id)) || 0;
      const productKey = meta.product_id;

      if (!productMap.has(productKey)) {
        productMap.set(productKey, {
          product_id: meta.product_id,
          title: meta.product_title,
          handle: meta.product_handle,
          product_type: meta.product_type,
          tags: meta.product_tags,
          image_src: meta.image_src,
          initial: 0,
          sold: 0,
          variants: [],
        });
      }

      const agg = productMap.get(productKey);

      agg.initial += row.initial_qty || 0;
      agg.sold += sold;

      const variantInitial = row.initial_qty || 0;
      const variantSold = sold;
      const variantRate =
        variantInitial > 0
          ? Number(((variantSold / variantInitial) * 100).toFixed(1))
          : null;

      agg.variants.push({
        variant_id: row.variant_id,
        sku: row.sku,
        title: meta.variant_title,
        initial: variantInitial,
        sold: variantSold,
        sell_through_pct: variantRate,
      });
    }

    // 5. Finaliser les produits (taux de sortie global par produit)
    let aggregated = Array.from(productMap.values()).map((p) => {
      const rate =
        p.initial > 0
          ? Number(((p.sold / p.initial) * 100).toFixed(1))
          : null;
      return {
        ...p,
        sell_through_pct: rate,
      };
    });

    // 6. Top 10 meilleures sorties (plus haut taux de sortie)
    const topBest10 = [...aggregated]
      .filter((p) => p.sell_through_pct !== null)
      .sort(
        (a, b) =>
          (b.sell_through_pct ?? 0) - (a.sell_through_pct ?? 0)
      )
      .slice(0, 10);

    // 7. Top 10 pires sorties (taux le plus FAIBLE)
    const topWorst10 = [...aggregated]
      .filter((p) => p.sell_through_pct !== null)
      .sort(
        (a, b) =>
          (a.sell_through_pct ?? 0) - (b.sell_through_pct ?? 0)
      )
      .slice(0, 10);

    res.json({
      products: aggregated,
      topBest10,
      topWorst10,
    });
  } catch (err) {
    console.error("❌ sellthrough error", err);
    res.status(500).json({ error: "sellthrough failed" });
  }
});

// ----------------------------
// Lancement du serveur
// ----------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 App TAUX DE SORTIE démarrée sur port ${PORT}`);
});

