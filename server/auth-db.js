// Loads environment variables from .env file
require('dotenv').config();
const Database = require('better-sqlite3');

// Establish database path and key from .env file
const dbPath = process.env.DB_PATH;
const dbKey = process.env.SECRET_KEY;

// Raise exception for properly set environment variables
if (!dbPath || !dbKey) {
  throw new Error("Missing database path or encryption key in environment variables");
}

// Establish connection to database
const db = new Database(dbPath);
// Set database encryption key
db.pragma(`key = "${dbKey}"`);

// Creates user, message, and file tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT,
    content TEXT,
    timestamp INTEGER
  );
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT,
    fileUrl TEXT,
    fileName TEXT,
    timestamp INTEGER
  );
`);

console.log('Database initialized');
