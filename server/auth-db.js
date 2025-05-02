const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
require("dotenv").config();

const dbPath = process.env.DB_PATH || "/app/db/securechat.db";
const dbKey = process.env.SECRET_KEY;

if (!dbPath || !dbKey) {
  console.error("Missing DB_PATH or SECRET_KEY in environment variables");
  process.exit(1);
}

console.log(`Attempting to initialize database at ${dbPath}`);

// Ensure the parent directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  console.log(`Creating directory ${dbDir}`);
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch (error) {
    console.error(`Failed to create directory ${dbDir}: ${error.message}`);
    process.exit(1);
  }
}

try {
  if (fs.existsSync(dbPath)) {
    console.log(`Database exists at ${dbPath}. Skipping creation.`);
  } else {
    console.log(`Creating new database at ${dbPath}`);
    const db = new Database(dbPath);
    db.pragma(`key = "${dbKey}"`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT,
        sender TEXT,
        content TEXT,
        timestamp INTEGER
      );
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT,
        sender TEXT,
        fileUrl TEXT,
        fileName TEXT,
        timestamp INTEGER
        aesKey TEXT,
        iv TEXT
        authKey TEXT
      );
      CREATE TABLE IF NOT EXISTS rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        isPublic BOOLEAN,
        password TEXT,
        key TEXT
      );
    `);

    db.prepare(
      "INSERT OR IGNORE INTO rooms (name, isPublic, password, key) VALUES (?, ?, ?, ?)"
    ).run("general", 1, null, null);

    console.log('Database initialized with "general" room');
    db.close();
  }
} catch (error) {
  console.error(`Failed to initialize database: ${error.message}`);
  process.exit(1);
}
