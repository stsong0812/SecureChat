// Loads environment variables from .env file
require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

// Establish server configuration from .env file
const PORT = process.env.PORT || 7777;
const dbPath = process.env.DB_PATH;
const dbKey = process.env.SECRET_KEY;

// Raise exception for missing environment variables
if (!dbPath || !dbKey) {
  throw new Error("Missing database path or encryption key in environment variables");
}
// Check if database file exists
if (!fs.existsSync(dbPath)) {
  throw new Error(`Database not found at ${dbPath}. Please run auth-db.js first.`);
}

// Establish connection to database
const db = new Database(dbPath);
// Apply database encryption key
db.pragma(`key = "${dbKey}"`);

// Rate limiting configuration
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW = 60 * 1000;
const MESSAGE_LIMIT = 10;
const MESSAGE_WINDOW = 60 * 1000;

const loginAttempts = {};
const messageCounts = {};
const uploads = {};

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Set up Express and HTTP server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files from uploads directory
app.use('/uploads', express.static(uploadsDir));

function checkRateLimit(key, limit, window, trackingObject) {
  const now = Date.now();
  if (!trackingObject[key]) {
    trackingObject[key] = { count: 1, timestamp: now };
    return true;
  }
  const attempt = trackingObject[key];
  if (now - attempt.timestamp > window) {
    attempt.count = 1;
    attempt.timestamp = now;
    return true;
  } else {
    attempt.count += 1;
    return attempt.count <= limit;
  }
}

// Stores authenticated clients
const clients = new Map();

wss.on('connection', (socket) => {
  console.log('Client connected');
  socket.authenticated = false;

  socket.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (e) {
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      return;
    }

    const { type } = data;
    const ip = socket._socket.remoteAddress;

    if (type === 'register' || type === 'login') {
      if (!checkRateLimit(ip, LOGIN_LIMIT, LOGIN_WINDOW, loginAttempts)) {
        socket.send(JSON.stringify({ type: 'error', message: 'Too many attempts, please try again later' }));
        return;
      }
    }

    if (type === 'register') {
      const { username, password } = data;
      try {
        const hash = bcrypt.hashSync(password, 10);
        db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hash);
        socket.send(JSON.stringify({ type: 'status', message: 'Registered successfully' }));
      } catch (e) {
        socket.send(JSON.stringify({ type: 'error', message: 'Username taken' }));
      }
    } else if (type === 'login') {
      const { username, password } = data;
      const user = db.prepare('SELECT password FROM users WHERE username = ?').get(username);
      if (user && bcrypt.compareSync(password, user.password)) {
        socket.authenticated = true;
        socket.username = username;
        clients.set(username, socket);
        socket.send(JSON.stringify({ type: 'status', message: 'Logged in successfully' }));
        const history = db.prepare('SELECT sender, content FROM messages ORDER BY timestamp ASC').all();
        history.forEach((m) => socket.send(JSON.stringify({ type: 'text', sender: m.sender, content: m.content })));
        // Send file history
        const fileHistory = db.prepare('SELECT sender, fileUrl, fileName FROM files ORDER BY timestamp ASC').all();
        fileHistory.forEach((f) => socket.send(JSON.stringify({ type: 'file', sender: f.sender, fileUrl: f.fileUrl, fileName: f.fileName })));
      } else {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid credentials' }));
      }
    } else if (type === 'text') {
      if (socket.authenticated) {
        const { content } = data;
        if (!checkRateLimit(socket.username, MESSAGE_LIMIT, MESSAGE_WINDOW, messageCounts)) {
          socket.send(JSON.stringify({ type: 'error', message: 'Message rate limit exceeded, please wait' }));
          return;
        }
        const broadcastMsg = { type: 'text', sender: socket.username, content };
        db.prepare('INSERT INTO messages (sender, content, timestamp) VALUES (?, ?, ?)').run(
          socket.username,
          content,
          Date.now()
        );
        wss.clients.forEach((client) => {
          if (client.authenticated) client.send(JSON.stringify(broadcastMsg));
        });
      } else {
        socket.send(JSON.stringify({ type: 'error', message: 'Please log in first' }));
      }
    } else if (type === 'file_start') {
      if (socket.authenticated) {
        const { uploadId, fileName, fileSize, totalChunks } = data;
        uploads[uploadId] = {
          fileName,
          fileSize,
          totalChunks,
          receivedChunks: 0,
          chunks: new Array(totalChunks).fill(null),
        };
        socket.send(JSON.stringify({ type: 'status', message: 'File upload started' }));
      } else {
        socket.send(JSON.stringify({ type: 'error', message: 'Please log in first' }));
      }
    } else if (type === 'file_chunk') {
      if (socket.authenticated) {
        const { uploadId, chunkIndex, data: chunkData } = data;
        const upload = uploads[uploadId];
        if (upload) {
          upload.chunks[chunkIndex] = Buffer.from(chunkData, 'base64');
          upload.receivedChunks++;
          if (upload.receivedChunks === upload.totalChunks) {
            const fileBuffer = Buffer.concat(upload.chunks);
            const uniqueFileName = `${uploadId}_${upload.fileName}`;
            const filePath = path.join(uploadsDir, uniqueFileName);
            fs.writeFileSync(filePath, fileBuffer);
            const fileUrl = `/uploads/${uniqueFileName}`;
    
            // Save file metadata to the database
            db.prepare('INSERT INTO files (sender, fileUrl, fileName, timestamp) VALUES (?, ?, ?, ?)').run(
              socket.username, // sender
              fileUrl, // fileUrl
              upload.fileName, // fileName
              Date.now() // timestamp
            );
    
            const broadcastMsg = {
              type: 'file',
              sender: socket.username,
              fileUrl,
              fileName: upload.fileName,
            };
            wss.clients.forEach((client) => {
              if (client.authenticated) client.send(JSON.stringify(broadcastMsg));
            });
            delete uploads[uploadId];
          } else {
            socket.send(JSON.stringify({ type: 'status', message: 'Chunk received' }));
          }
        } else {
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid upload ID' }));
        }
      } else {
        socket.send(JSON.stringify({ type: 'error', message: 'Please log in first' }));
      }
    }
  });

  socket.on('close', () => {
    for (let [username, client] of clients) {
      if (client === socket) clients.delete(username);
    }
    console.log('Client disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});