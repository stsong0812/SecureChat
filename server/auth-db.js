const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
require("dotenv").config();

const dbPath = process.env.DB_PATH || "./db/securechat.db";
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
  const dbExists = fs.existsSync(dbPath);
  const db = new Database(dbPath);
  db.pragma(`key = "${dbKey}"`);

  if (!dbExists) {
    console.log(`Creating new database at ${dbPath}`);
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
        timestamp INTEGER,
        aesKey TEXT,
        iv TEXT,
        authTag TEXT
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
  } else {
    console.log(`Database exists at ${dbPath}. Checking for migrations...`);

    // Migrate 'files' table to add iv/authTag columns if missing
    const columns = db.prepare("PRAGMA table_info(files)").all();

    const hasIV = columns.some((col) => col.name === "iv");
    const hasAuthTag = columns.some((col) => col.name === "authTag");

    if (!hasIV) {
      db.prepare("ALTER TABLE files ADD COLUMN iv TEXT").run();
      console.log("✅ Added missing 'iv' column to files table.");
    }
    if (!hasAuthTag) {
      db.prepare("ALTER TABLE files ADD COLUMN authTag TEXT").run();
      console.log("✅ Added missing 'authTag' column to files table.");
    }
  }

  db.close();
} catch (error) {
  console.error(`Failed to initialize database: ${error.message}`);
  process.exit(1);
}
