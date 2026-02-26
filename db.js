// db.js
import sqlite3 from "sqlite3";
import { open } from "sqlite";

// Chemin du fichier SQLite (dans Render, il sera créé dans le dossier du projet)
const DB_FILE = process.env.DB_FILE || "./data.sqlite";

export let db;

/**
 * Ajoute une colonne si elle n'existe pas (migration "safe")
 */
async function ensureColumn(table, column, type) {
  const cols = await db.all(`PRAGMA table_info(${table})`);
  const exists = cols.some((c) => c.name === column);
  if (!exists) {
    console.log(`🛠️ Migration: ajout colonne ${table}.${column} (${type})`);
    await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/**
 * Crée tables + applique les migrations si besoin
 */
export async function initDb() {
  db = await open({
    filename: DB_FILE,
    driver: sqlite3.Database,
  });

  // Meilleure robustesse SQLite
  await db.run("PRAGMA journal_mode = WAL;");
  await db.run("PRAGMA foreign_keys = ON;");

  // -------------------------
  // TABLE: initial_stock
  // 1 ligne = 1 variante snapshotée (stock initial pour une saison/balise)
  // -------------------------
  await db.run(`
    CREATE TABLE IF NOT EXISTS initial_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season TEXT,
      variant_id INTEGER,
      sku TEXT,
      initial_qty INTEGER DEFAULT 0,
      snapshot_at TEXT
      -- colonnes ajoutées via migration (ci-dessous) si DB ancienne
    )
  `);

  // Index utiles
  await db.run(
    `CREATE INDEX IF NOT EXISTS idx_initial_stock_season ON initial_stock(season)`
  );
  await db.run(
    `CREATE INDEX IF NOT EXISTS idx_initial_stock_variant ON initial_stock(variant_id)`
  );

  // -------------------------
  // TABLE: sales
  // ventes (webhook orders/create)
  // -------------------------
  await db.run(`
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season TEXT,
      product_id INTEGER,
      variant_id INTEGER,
      sku TEXT,
      qty INTEGER DEFAULT 0,
      order_id TEXT,
      created_at TEXT
    )
  `);
  await db.run(
    `CREATE INDEX IF NOT EXISTS idx_sales_variant ON sales(variant_id)`
  );
  await db.run(
    `CREATE INDEX IF NOT EXISTS idx_sales_season ON sales(season)`
  );
  await db.run(
    `CREATE INDEX IF NOT EXISTS idx_sales_order ON sales(order_id)`
  );

  // -------------------------
  // TABLE: restocks
  // réassorts (si tu utilises cette logique)
  // -------------------------
  await db.run(`
    CREATE TABLE IF NOT EXISTS restocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season TEXT,
      product_id INTEGER,
      variant_id INTEGER,
      qty INTEGER DEFAULT 0,
      label TEXT,
      created_at TEXT
    )
  `);
  await db.run(
    `CREATE INDEX IF NOT EXISTS idx_restocks_variant ON restocks(variant_id)`
  );
  await db.run(
    `CREATE INDEX IF NOT EXISTS idx_restocks_season ON restocks(season)`
  );

  // -------------------------
  // TABLE: inventory_changes
  // (webhook inventory_levels/update si tu l'utilises)
  // -------------------------
  await db.run(`
    CREATE TABLE IF NOT EXISTS inventory_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_item_id INTEGER,
      location_id INTEGER,
      available INTEGER DEFAULT 0,
      recorded_at TEXT
    )
  `);

  // ---------------------------------------------------------
  // MIGRATIONS "SAFE" : ajout des colonnes manquantes
  // (corrige ton erreur: product_id manquant dans initial_stock)
  // ---------------------------------------------------------
  await ensureColumn("initial_stock", "product_id", "INTEGER");
  await ensureColumn("initial_stock", "product_title", "TEXT");
  await ensureColumn("initial_stock", "product_image", "TEXT");
  await ensureColumn("initial_stock", "variant_title", "TEXT");
  await ensureColumn("initial_stock", "tags", "TEXT");
  await ensureColumn("initial_stock", "handle", "TEXT");

  console.log(`✅ DB prête: ${DB_FILE}`);
}
