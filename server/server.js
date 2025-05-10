const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const Database = require("better-sqlite3");
const bcrypt = require("bcrypt");
const fs = require("fs");
const path = require("path");

// Configuration from .env
const PORT = process.env.PORT || 7777;
const dbPath = process.env.DB_PATH || "./db/securechat.db";
const dbKey = process.env.SECRET_KEY;
const publicDomain =
  process.env.PUBLIC_DOMAIN || "securechat-production-6fc4.up.railway.app";

// Validate environment variables
if (!dbPath || !dbKey) {
  console.error("Environment variables missing:", { dbPath, dbKey });
  throw new Error(
    "Missing database path or encryption key in environment variables"
  );
}

// Initialize database (this part mostly runs once if DB doesn't exist)
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  console.log(`Creating directory ${dbDir}`);
  fs.mkdirSync(dbDir, { recursive: true });
}

if (!fs.existsSync(dbPath)) {
  console.log(`Creating new database at ${dbPath}`);
  const tempDb = new Database(dbPath); // Use a temporary instance for init
  tempDb.pragma(`key = "${dbKey}"`);
  tempDb.exec(`
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
      password TEXT,
      key TEXT
    );
  `);
  tempDb.prepare(
    "INSERT OR IGNORE INTO rooms (name, isPublic, password, key) VALUES (?, ?, ?, ?)"
  ).run("general", 1, null, null);
  console.log('Database initialized with "general" room');
  tempDb.close();
}

// Initialize SQLite database for runtime use
let db;
try {
  db = new Database(dbPath);
  db.pragma(`key = "${dbKey}"`);
  console.log("Database opened successfully");
} catch (error) {
  console.error("Failed to open database:", error);
  throw error;
}

// Rate limiting configuration
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW = 60 * 1000;
const MESSAGE_LIMIT = 10;
const MESSAGE_WINDOW = 60 * 1000;

const loginAttempts = {};
const messageCounts = {};
const uploads = {}; // For tracking multi-part file uploads

// Create uploads and logs directories
const uploadsDir =
  process.env.NODE_ENV === "production"
    ? path.join("/tmp", "Uploads")
    : path.join(__dirname, "Uploads");
const logsDir = path.join(__dirname, "logs");

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });


// Set up Express and HTTP server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", port: PORT });
});
app.use("/Uploads", express.static(uploadsDir));
app.use(express.static(path.join(__dirname, "../client/build")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/build", "index.html"));
});

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
  }
  attempt.count += 1;
  return attempt.count <= limit;
}

function logMessage(room, sender, content, isFile = false, fileUrl = "") {
  const timestamp = new Date().toISOString();
  const logFile = path.join(logsDir, `${room}.log`);
  const logEntry = isFile
    ? `[${timestamp}] ${sender} uploaded file: ${content} (${fileUrl})\n`
    : `[${timestamp}] ${sender}: ${JSON.stringify(content)}\n`;
  fs.appendFile(logFile, logEntry, (err) => {
    if (err) console.error(`Failed to log to ${logFile}:`, err);
  });
}

const clients = new Map();

wss.on("error", (error) => console.error("WebSocket server error:", error));

wss.on("connection", (socket) => {
  console.log("Client connected from:", socket._socket.remoteAddress);
  socket.authenticated = false;
  socket.room = "general";

  socket.on("error", (error) => console.error("WebSocket client error:", error));

  socket.on("message", async (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
      if (socket.username && clients.has(socket.username)) {
        clients.get(socket.username).lastActive = Date.now();
      }
    } catch (e) {
      socket.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
      return;
    }

    const { type } = data;
    const ip = socket._socket.remoteAddress;

    if (type === "register" || type === "login") {
      if (!checkRateLimit(ip, LOGIN_LIMIT, LOGIN_WINDOW, loginAttempts)) {
        socket.send(JSON.stringify({ type: "error", message: "Too many attempts, please try again later" }));
        return;
      }
    }

    if (type === "register") {
      const { username, password } = data;
      try {
        const hash = bcrypt.hashSync(password, 10);
        db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run(username, hash);
        socket.send(JSON.stringify({ type: "status", message: "Registered successfully" }));
      } catch (e) {
        socket.send(JSON.stringify({ type: "error", message: "Username taken" }));
      }
    } else if (type === "login") {
      const { username, password } = data;
      const user = db.prepare("SELECT password FROM users WHERE username = ?").get(username);
      if (user && bcrypt.compareSync(password, user.password)) {
        socket.authenticated = true;
        socket.username = username;
        clients.set(username, { socket, room: socket.room, lastActive: Date.now(), idle: false });
        broadcastUserStatusUpdate();
        broadcastToAll({ type: "user_status", sender: username, status: "online" });
        socket.send(JSON.stringify({ type: "status", message: "Logged in successfully" }));
        sendRoomHistory(socket, "general");
      } else {
        socket.send(JSON.stringify({ type: "error", message: "Invalid credentials" }));
      }
    } else if (type === "create_room") {
      if (!socket.authenticated) {
        socket.send(JSON.stringify({ type: "error", message: "Please log in first" }));
        return;
      }
      const { roomName, isPublic, password: roomPassword, roomKeyJwk } = data; // roomPassword to avoid conflict
      if (!roomName) {
        socket.send(JSON.stringify({ type: "error", message: "Room name is required" }));
        return;
      }
      try {
        const hash = isPublic ? null : bcrypt.hashSync(roomPassword, 10);
        db.prepare("INSERT INTO rooms (name, isPublic, password, key) VALUES (?, ?, ?, ?)")
          .run(roomName, isPublic ? 1 : 0, hash, roomKeyJwk ? JSON.stringify(roomKeyJwk) : null);
        socket.send(JSON.stringify({ type: "status", message: `Room "${roomName}" created successfully` }));
        broadcastToAll({ type: "new_room", room: { name: roomName, isPublic }, roomKeyJwk });
      } catch (e) {
        socket.send(JSON.stringify({ type: "error", message: "Room name already exists or DB error." }));
      }
    } else if (type === "get_rooms") {
      if (!socket.authenticated) { // Corrected logic: must be authenticated
        socket.send(JSON.stringify({ type: "error", message: "Please log in first" }));
        return;
      }
      const rooms = db.prepare("SELECT name, isPublic FROM rooms").all();
      socket.send(JSON.stringify({ type: "room_list", rooms }));
    } else if (type === "get_users") {
      if (!socket.authenticated) {
        socket.send(JSON.stringify({ type: "error", message: "Please log in first" }));
        return;
      }
      const rows = db.prepare("SELECT username FROM users").all();
      const users = rows.map((r) => r.username);
      socket.send(JSON.stringify({ type: "user_list", users }));
    } else if (type === "join_room") {
      if (!socket.authenticated) {
        socket.send(JSON.stringify({ type: "error", message: "Please log in first" }));
        return;
      }
      const { room, password } = data;
      const roomData = db.prepare("SELECT isPublic, password, key FROM rooms WHERE name = ?").get(room);
      if (!roomData) {
        socket.send(JSON.stringify({ type: "error", message: "Room does not exist" }));
        return;
      }
      if (roomData.isPublic || (password && roomData.password && bcrypt.compareSync(password, roomData.password))) {
        socket.room = room;
        if (clients.has(socket.username)) clients.get(socket.username).room = room;
        socket.send(JSON.stringify({
          type: "status",
          message: `Joined room: ${room}`,
          roomKeyJwk: roomData.key ? JSON.parse(roomData.key) : null
        }));
        sendRoomHistory(socket, room);
      } else {
        socket.send(JSON.stringify({ type: "error", message: "Incorrect password" }));
      }
    } else if (type === "text") {
      if (socket.authenticated) {
        const { content } = data;
        if (!checkRateLimit(socket.username, MESSAGE_LIMIT, MESSAGE_WINDOW, messageCounts)) {
          socket.send(JSON.stringify({ type: "error", message: "Message rate limit exceeded, please wait" }));
          return;
        }
        const broadcastMsg = { type: "text", sender: socket.username, content };
        db.prepare("INSERT INTO messages (room, sender, content, timestamp) VALUES (?, ?, ?, ?)")
          .run(socket.room, socket.username, JSON.stringify(content), Date.now());
        logMessage(socket.room, socket.username, content);
        broadcast(socket.room, broadcastMsg, socket); // Pass socket to exclude sender if needed
      } else {
        socket.send(JSON.stringify({ type: "error", message: "Please log in first" }));
      }
    } else if (type === "file_start") {
      if (socket.authenticated) {
        const { uploadId, fileName, fileSize, totalChunks } = data;
        console.log("🟡 Received file_start (plaintext):", { uploadId, fileName, fileSize, totalChunks });
        uploads[uploadId] = {
          fileName,
          fileSize,
          totalChunks,
          receivedChunks: 0,
          chunks: new Array(totalChunks).fill(null),
        };
        socket.send(JSON.stringify({ type: "status", message: "File upload started" }));
      } else {
        socket.send(JSON.stringify({ type: "error", message: "Please log in first" }));
      }
    } else if (type === "file_chunk") {
      if (socket.authenticated) {
        try {
          const { uploadId, chunkIndex, data: chunkData } = data;
          const upload = uploads[uploadId];

          if (upload) {
            console.log(`Received chunk ${chunkIndex + 1}/${upload.totalChunks} for ${uploadId}`);
            upload.chunks[chunkIndex] = Buffer.from(chunkData);
            upload.receivedChunks++;

            if (upload.receivedChunks === upload.totalChunks) {
              console.log(`All chunks received for ${uploadId}. Assembling file.`);
              const fileBuffer = Buffer.concat(upload.chunks);

              if (fileBuffer.length !== upload.fileSize) {
                console.error(`File size mismatch for ${uploadId}: expected ${upload.fileSize}, got ${fileBuffer.length}. Upload aborted.`);
                socket.send(JSON.stringify({ type: "error", message: `File upload failed: size mismatch.` }));
                delete uploads[uploadId];
                return;
              }
              console.log(`File ${uploadId} assembled. Size: ${fileBuffer.length} bytes. Matches expected size.`);

              const uniqueFileName = `${uploadId}_${upload.fileName}`;
              const filePath = path.join(uploadsDir, uniqueFileName);
              
              console.log(`Writing file to ${filePath}`);
              fs.writeFileSync(filePath, fileBuffer);
              console.log(`File ${filePath} written successfully.`);

              const fileUrl = `/Uploads/${uniqueFileName}`;
              db.prepare("INSERT INTO files (room, sender, fileUrl, fileName, timestamp) VALUES (?, ?, ?, ?, ?)")
                .run(socket.room, socket.username, fileUrl, upload.fileName, Date.now());

              const broadcastMsg = {
                type: "file",
                sender: socket.username,
                fileUrl,
                fileName: upload.fileName,
              };
              logMessage(socket.room, socket.username, upload.fileName, true, fileUrl);
              broadcast(socket.room, broadcastMsg);
              delete uploads[uploadId];
            } else {
              // Optional: Send progress update if needed by client
              // socket.send(JSON.stringify({ type: "status", message: `Chunk ${chunkIndex + 1}/${upload.totalChunks} received` }));
            }
          } else {
            socket.send(JSON.stringify({ type: "error", message: "Invalid upload ID" }));
          }
        } catch (err) {
          console.error("File upload processing failed:", err);
          socket.send(JSON.stringify({ type: "error", message: "File upload processing failed" }));
        }
      } else {
        socket.send(JSON.stringify({ type: "error", message: "Please log in first" }));
      }
    } else if (type === "typing") {
      broadcast(socket.room, { type: "typing", sender: socket.username }, socket);
    } else if (type === "stop_typing") {
      broadcast(socket.room, { type: "stop_typing", sender: socket.username }, socket);
    } else if (type === "idle") {
      if (socket.username && clients.has(socket.username)) {
        clients.get(socket.username).idle = true;
        // lastActive will be updated by ping or next message
        console.log(`User ${socket.username} marked as idle`);
        broadcastToAll({ type: "user_status", sender: socket.username, status: "offline" });
      }
    } else if (type === "user_status") {
      if (data.status === "online" && socket.username && clients.has(socket.username)) {
        const clientData = clients.get(socket.username);
        if (clientData.idle) {
          clientData.idle = false;
          clientData.lastActive = Date.now();
          console.log(`User ${socket.username} is active again`);
          broadcastToAll({ type: "user_status", sender: socket.username, status: "online" });
        }
      }
    } else if (type === "ping") {
        // Client is active, no specific action needed other than lastActive update handled above
    }
  });

  socket.on("close", () => {
    console.log("Client disconnected:", socket.username || socket._socket.remoteAddress);
    if (socket.username && clients.has(socket.username)) {
      clients.delete(socket.username);
      broadcastToAll({ type: "user_status", sender: socket.username, status: "offline" });
      broadcastUserStatusUpdate();
    }
  });
});


function sendRoomHistory(socket, room) {
  const textMessages = db
    .prepare("SELECT sender, content, timestamp, 'text' AS type FROM messages WHERE room = ? ORDER BY timestamp ASC")
    .all(room)
    .map((m) => {
      let parsedContent;
      try { parsedContent = JSON.parse(m.content); }
      catch (e) { parsedContent = m.content; }
      return { type: m.type, sender: m.sender, content: parsedContent, timestamp: m.timestamp };
    });

  const fileMessages = db
    .prepare("SELECT sender, fileUrl, fileName, timestamp, 'file' AS type FROM files WHERE room = ? ORDER BY timestamp ASC")
    .all(room)
    .map((f) => ({ type: f.type, sender: f.sender, fileUrl: f.fileUrl, fileName: f.fileName, timestamp: f.timestamp }));

  const history = [...textMessages, ...fileMessages].sort((a, b) => a.timestamp - b.timestamp);

  history.forEach((item) => {
    if (item.type === "text") {
      socket.send(JSON.stringify({ type: "text", sender: item.sender, content: item.content }));
    } else if (item.type === "file") {
      socket.send(JSON.stringify({ type: "file", sender: item.sender, fileUrl: item.fileUrl, fileName: item.fileName }));
    }
  });
}

function broadcast(room, message, excludeSocket = null) {
  clients.forEach((clientData) => {
    if (clientData.socket !== excludeSocket && clientData.room === room && clientData.socket.readyState === WebSocket.OPEN) {
      clientData.socket.send(JSON.stringify(message));
    }
  });
}

function broadcastToAll(message, excludeSocket = null) {
  clients.forEach((clientData) => {
    if (clientData.socket !== excludeSocket && clientData.socket.readyState === WebSocket.OPEN) {
      clientData.socket.send(JSON.stringify(message));
    }
  });
}

function broadcastUserStatusUpdate() {
  const users = Array.from(clients.keys());
  broadcastToAll({ type: "user_list", users });
}

setInterval(() => {
  const now = Date.now();
  clients.forEach((clientData, username) => {
    if (now - clientData.lastActive > 5 * 60 * 1000 && !clientData.idle) { // Check if not already marked idle
      console.log(`User ${username} is now idle/offline due to inactivity`);
      clientData.idle = true; // Mark as idle
      broadcastToAll({ type: "user_status", sender: username, status: "offline" });
      // No need to remove from clients map here, just mark status
    }
  });
}, 60 * 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT} (public: https://${publicDomain})`);
  console.log("WebSocket server initialized at wss://" + publicDomain);
});