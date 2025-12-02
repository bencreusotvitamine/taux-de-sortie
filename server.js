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
  .replace(/^https?:\/\//, "") // supprime "http(s)://"
  .replace(/\/admin.*$/i, "")  // supprime "/admin/xxxxx"
  .replace(/\/$/, "");         // supprime "/" final

// Si tu as mis juste "vitamine-clubfr"
if (!SHOP_DOMAIN.includes(".")) {
  SHOP_DOMAIN = `${SHOP_DOMAIN}.myshopify.com`;
}

console.log("📦 SHOP_DOMAIN normalisé =", SHOP_DOMAIN);

/* -------------------------------------------------------------------------- */
/*                FONCTION D'APPEL SHOPIFY AVEC GESTION 429                   */
/* -------------------------------------------------------------------------- */

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Appel Shopify avec retry automatique en cas de 429 (rate limit)
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
      // On a dépassé la limite → attendre puis réessayer
      const retryAfterHeader = err.response.headers["retry-after"];
      const retryAfterSec = retryAfterHeader
        ? Number(retryAfterHeader)
        : 2; // par défaut 2 secondes

      console.warn(
        `⚠️ Rate limit (429). Pause ${retryAfterSec}s avant retry (tentative ${
          retry + 1
        }/5)`
      );

      await sleep(retryAfterSec * 1000 + 200);
      return shopifyGet(pathUrl, params, retry + 1);
    }

    console.error("❌ Shopify error", status, err.response?.data || err.message);
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*                                 UTILITAIRE                                 */
/* -------------------------------------------------------------------------- */

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/* -------------------------------------------------------------------------- */
/*                 SNAPSHOT STOCK INITIAL – FILTRÉ PAR BALISE                 */
/* -------------------------------------------------------------------------- */
/*
  Dans l'interface :
  - Tu saisis par exemple "FW25" dans le champ "Saison"
  - Ici, on considère que "FW25" est une BALISE Shopify
  - On récupère seulement les produits qui ont cette balise
*/

app.post("/api/initial_stock/snapshot", async (req, res) => {
  try {
    const { season } = req.body;
    if (!season) return res.status(400).json({ error: "season required" });

    // On utilise la saison comme NOM DE BALISE Shopify
    const tag = season.trim();
    const tagLower = tag.toLowerCase();

    // 1) Récupérer jusqu'à 250 produits (on peut élargir plus tard avec la pagination)
    const productsData = await shopifyGet("products.json", { limit: 250 });
    const allProducts = productsData.products || [];

    // 2) Garder seulement ceux qui ont la balise saisie (FW25, SS25, etc.)
    const taggedProducts = allProducts.filter((p) => {
      if (!p.tags) return false;
      return p.tags
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .includes(tagLower);
    });

    console.log(
      `📦 ${allProducts.length} produits au total, ${taggedProducts.length} produits avec la balise '${tag}'`
    );

    // 3) Récupérer les variantes + inventory_item_ids pour ces produits filtrés
    const variants = [];
    const inventoryItemIdsSet = new Set();

    for (const p of taggedProducts) {
      if (!p.variants) continue;
      for (const v of p.variants) {
        variants.push(v);
        if (v.inventory_item_id) {
          inventoryItemIdsSet.add(v.inventory_item_id);
        }
      }
    }

    const inventoryItemIds = Array.from(inventoryItemIdsSet);
    console.log(
      `🧮 ${variants.length} variantes, ${inventoryItemIds.length} inventory_item_ids uniques pour la balise '${tag}'`
    );

    // 4) Appeler inventory_levels en paquets pour respecter la limite API
    const chunkSize = 40;
    const idChunks = chunkArray(inventoryItemIds, chunkSize);
    const inventoryMap = new Map(); // inventory_item_id -> quantité totale

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

      // Petite pause entre les paquets pour être encore plus safe
      if (index + 1 < idChunks.length) {
        await sleep(600); // 0,6 s
      }
    }

    console.log(
      `📊 Inventaire récupéré pour ${inventoryMap.size} inventory_item_ids`
    );

    // 5) Construire les lignes à insérer
    const toInsert = variants.map((v) => {
      const qty = inventoryMap.get(v.inventory_item_id) || 0;
      return {
        variant_id: v.id,
        sku: v.sku,
        initial_qty: qty,
        season, // on garde "FW25" comme saison pour tes filtres
      };
    });

    // 6) Sauvegarder en DB
    await Promise.all(
      toInsert.map((i) =>
        db.run(
          `REPLACE INTO initial_stock (variant_id, sku, initial_qty, season, snapshot_at)
           VALUES (?, ?, ?, ?, ?)`,
          [i.variant_id, i.sku, i.initial_qty, season, new Date().toISOString()]
        )
      )
    );

    console.log(`✅ Snapshot terminé. Lignes insérées : ${toInsert.length}`);
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
