import sqlite3 from "sqlite3";
import { open } from "sqlite";

export let db;

/**
 * Initialise la DB SQLite et crée / met à jour les tables
 */
export async function initDb() {
  db = await open({
    filename: "./data.sqlite",
    driver: sqlite3.Database,
  });

  // --- Tables principales ---
  await db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS initial_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- Identité produit + variante (Shopify)
      product_id INTEGER,
      product_title TEXT,
      product_image TEXT,

      variant_id INTEGER UNIQUE,
      variant_title TEXT,
      sku TEXT,

      -- Stock initial pour la sélection (tags)
      initial_qty INTEGER DEFAULT 0,

      -- Tags utilisés lors du snapshot (ex: "adidas" ou "adidas,nike")
      tags TEXT,

      snapshot_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      variant_id INTEGER,
      sku TEXT,
      qty INTEGER DEFAULT 0,
      order_id INTEGER,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS inventory_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_item_id INTEGER,
      location_id INTEGER,
      available INTEGER DEFAULT 0,
      recorded_at TEXT
    );
  `);

  // --- Migrations: si ta table existe déjà, ajoute les colonnes manquantes ---
  await ensureColumns("initial_stock", [
    ["product_id", "INTEGER"],
    ["product_title", "TEXT"],
    ["product_image", "TEXT"],
    ["variant_id", "INTEGER"],
    ["variant_title", "TEXT"],
    ["sku", "TEXT"],
    ["initial_qty", "INTEGER DEFAULT 0"],
    ["tags", "TEXT"],
    ["snapshot_at", "TEXT"],
  ]);

  await ensureColumns("sales", [
    ["variant_id", "INTEGER"],
    ["sku", "TEXT"],
    ["qty", "INTEGER DEFAULT 0"],
    ["order_id", "INTEGER"],
    ["created_at", "TEXT"],
  ]);

  await ensureColumns("inventory_changes", [
    ["inventory_item_id", "INTEGER"],
    ["location_id", "INTEGER"],
    ["available", "INTEGER DEFAULT 0"],
    ["recorded_at", "TEXT"],
  ]);

  // --- Index utiles (perf) ---
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_initial_stock_tags ON initial_stock(tags);
    CREATE INDEX IF NOT EXISTS idx_initial_stock_product_id ON initial_stock(product_id);
    CREATE INDEX IF NOT EXISTS idx_sales_variant_id ON sales(variant_id);
  `);

  console.log("✅ SQLite DB ready");
}

/**
 * Vérifie si une colonne existe, sinon l'ajoute (migration douce)
 */
async function ensureColumns(tableName, columns) {
  const existing = await db.all(`PRAGMA table_info(${tableName});`);
  const existingNames = new Set(existing.map((c) => c.name));

  for (const [name, type] of columns) {
    if (!existingNames.has(name)) {
      console.log(`➕ Migration: add column ${tableName}.${name}`);
      await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${type};`);
    }
  }

  // Cas spécial : variant_id doit être UNIQUE (pour REPLACE)
  // Si l'ancien schéma n'avait pas UNIQUE, SQLite ne permet pas ALTER facilement.
  // On ne force pas ici, mais notre CREATE TABLE initial le met déjà en UNIQUE.
}
