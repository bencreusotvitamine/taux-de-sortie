import sqlite3 from "sqlite3";
import { open } from "sqlite";

export let db;
export async function initDb() {
  db = await open({ filename: "./database.sqlite", driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS initial_stock (
      variant_id TEXT PRIMARY KEY,
      sku TEXT,
      initial_qty INTEGER,
      season TEXT,
      snapshot_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      variant_id TEXT,
      sku TEXT,
      qty INTEGER,
      order_id TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS inventory_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_item_id TEXT,
      location_id TEXT,
      available INTEGER,
      recorded_at TEXT
    );
  `);
}
