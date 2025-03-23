const fs = require('fs');
const Database = require('better-sqlite3');
require('dotenv').config();

const dbPath = process.env.DB_PATH;
const dbKey = process.env.SECRET_KEY;

if (!dbPath || !dbKey) {
  throw new Error("Missing database path or encryption key in environment variables");
}

if (fs.existsSync(dbPath)) {
  console.log(`Database exists at ${dbPath}. Skipping creation.`);
} else {
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
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      isPublic BOOLEAN,
      password TEXT
    );
  `);

  // Insert only the "general" room
  db.prepare("INSERT OR IGNORE INTO rooms (name, isPublic, password) VALUES (?, ?, ?)")
    .run("general", 1, null); // Public room, no password

  console.log('Database initialized with "general" room');
}