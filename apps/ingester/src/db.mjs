import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..", "..");

function defaultDbPath() {
  return path.resolve(repoRoot, "data", "dev.sqlite");
}

const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : defaultDbPath();

export function openDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  return db;
}
