const Database = require('better-sqlite3');
const db = new Database('server/securechat.db');
db.pragma('key = "a4bcac6e2eb183c6c91a333b5b54df1acd8a0260d3b9ada1f0f7255ac87a70e0"'); // Secure key
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
  )
`);
console.log('Database initialized');