require("dotenv").config();
const express = require("express");
const http = require("http"); // Changed from https
const WebSocket = require("ws");
const Database = require("better-sqlite3");
const bcrypt = require("bcrypt");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const util = require("util");
const pbkdf2 = util.promisify(crypto.pbkdf2);

// Derive a consistent AES key for the 'general' room
async function deriveGeneralRoomKey() {
  const roomName = "general";
  const password = roomName + "secret";
  const salt = "salt";
  const iterations = 100000;
  const keyLength = 32; // 256-bit AES key

  try {
    const derivedKey = await pbkdf2(
      password,
      salt,
      iterations,
      keyLength,
      "sha256"
    );
    return derivedKey;
  } catch (err) {
    console.error("Key derivation failed:", err);
    throw err;
  }
}

// Configuration from .env
const PORT = process.env.PORT || 7777;
const dbPath = process.env.DB_PATH || "/app/db/securechat.db";
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

// Initialize database
console.log(`Attempting to initialize database at ${dbPath}`);
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  console.log(`Creating directory ${dbDir}`);
  fs.mkdirSync(dbDir, { recursive: true });
}

if (!fs.existsSync(dbPath)) {
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

// Initialize SQLite database for runtime use
// Initialize SQLite database for runtime use
let db; // Declare db at the top

try {
  db = new Database(dbPath); // Then assign it here
  db.pragma(`key = "${dbKey}"`);
  console.log("Database opened successfully");
} catch (error) {
  console.error("Failed to open database:", error);
  throw error;
}

try {
  db.prepare("SELECT aesKey, iv, authTag FROM files LIMIT 1").get();
} catch (e) {
  console.warn("Adding missing encryption columns to 'files' table...");
  db.exec(`
    ALTER TABLE files ADD COLUMN aesKey TEXT;
    ALTER TABLE files ADD COLUMN iv TEXT;
    ALTER TABLE files ADD COLUMN authTag TEXT;
  `);
}

// Rate limiting configuration
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW = 60 * 1000; // 1 minute
const MESSAGE_LIMIT = 10;
const MESSAGE_WINDOW = 60 * 1000; // 1 minute

const loginAttempts = {};
const messageCounts = {};
const uploads = {};

// Create uploads and logs directories
const uploadsDir =
  process.env.NODE_ENV === "production"
    ? path.join("/tmp", "Uploads")
    : path.join(__dirname, "Uploads");

const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Set up Express and HTTP server
const app = express();
const server = http.createServer(app); // Changed from https
const wss = new WebSocket.Server({ server });

// Healthcheck endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", port: PORT });
});

// Serve static files for uploads
app.use("/Uploads", express.static(uploadsDir));

// Serve static files from the React app (optional)
app.use(express.static(path.join(__dirname, "../client/build")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/build", "index.html"));
});

// Rate limiting function
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

// Logging function for room messages
function logMessage(room, sender, content, isFile = false, fileUrl = "") {
  const timestamp = new Date().toISOString();
  const logFile = path.join(logsDir, `${room}.log`);
  let logEntry;
  if (isFile) {
    logEntry = `[${timestamp}] ${sender} uploaded encrypted file: ${content} (${fileUrl})\n`;
  } else {
    logEntry = `[${timestamp}] ${sender}: ${JSON.stringify(content)}\n`;
  }
  fs.appendFile(logFile, logEntry, (err) => {
    if (err) {
      console.error(`Failed to log to ${logFile}:`, err);
    }
  });
}

const clients = new Map();

// WebSocket connection handling
wss.on("error", (error) => {
  console.error("WebSocket server error:", error);
});

wss.on("connection", (socket) => {
  console.log("Client connected from:", socket._socket.remoteAddress);
  socket.authenticated = false;
  socket.room = "general";

  socket.on("error", (error) => {
    console.error("WebSocket client error:", error);
  });

  socket.on("message", async (message) => {
    console.log(
      "Received message from:",
      socket._socket.remoteAddress,
      message.toString()
    );
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (e) {
      socket.send(
        JSON.stringify({ type: "error", message: "Invalid message format" })
      );
      return;
    }

    const { type } = data;
    const ip = socket._socket.remoteAddress;

    if (type === "register" || type === "login") {
      if (!checkRateLimit(ip, LOGIN_LIMIT, LOGIN_WINDOW, loginAttempts)) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: "Too many attempts, please try again later",
          })
        );
        return;
      }
    }

    if (type === "register") {
      const { username, password } = data;
      try {
        const hash = bcrypt.hashSync(password, 10);
        db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run(
          username,
          hash
        );
        socket.send(
          JSON.stringify({ type: "status", message: "Registered successfully" })
        );
      } catch (e) {
        socket.send(
          JSON.stringify({ type: "error", message: "Username taken" })
        );
      }
    } else if (type === "login") {
      const { username, password } = data;
      const user = db
        .prepare("SELECT password FROM users WHERE username = ?")
        .get(username);
      if (user && bcrypt.compareSync(password, user.password)) {
        socket.authenticated = true;
        socket.username = username;
        clients.set(username, socket);
        socket.send(
          JSON.stringify({ type: "status", message: "Logged in successfully" })
        );
        sendRoomHistory(socket, "general");
      } else {
        socket.send(
          JSON.stringify({ type: "error", message: "Invalid credentials" })
        );
      }
    } else if (type === "create_room") {
      if (!socket.authenticated) {
        socket.send(
          JSON.stringify({ type: "error", message: "Please log in first" })
        );
        return;
      }
      const { roomName, isPublic, password, roomKeyJwk } = data;
      if (!roomName) {
        socket.send(
          JSON.stringify({ type: "error", message: "Room name is required" })
        );
        return;
      }
      try {
        const hash = isPublic ? null : bcrypt.hashSync(password, 10);
        db.prepare(
          "INSERT INTO rooms (name, isPublic, password, key) VALUES (?, ?, ?, ?)"
        ).run(roomName, isPublic ? 1 : 0, hash, JSON.stringify(roomKeyJwk));
        socket.send(
          JSON.stringify({
            type: "status",
            message: `Room "${roomName}" created successfully`,
          })
        );
        broadcastToAll({
          type: "new_room",
          room: { name: roomName, isPublic },
          roomKeyJwk,
        });
      } catch (e) {
        socket.send(
          JSON.stringify({ type: "error", message: "Room name already exists" })
        );
      }
    } else if (type === "get_rooms") {
      if (socket.authenticated) {
        const roomList = db.prepare("SELECT name, isPublic FROM rooms").all();
        socket.send(JSON.stringify({ type: "room_list", rooms: roomList }));
      } else {
        socket.send(
          JSON.stringify({ type: "error", message: "Please log in first" })
        );
      }
    } else if (type === "join") {
      if (!socket.authenticated) {
        socket.send(
          JSON.stringify({ type: "error", message: "Please log in first" })
        );
        return;
      }
      const { room, password } = data;
      const roomData = db
        .prepare("SELECT isPublic, password, key FROM rooms WHERE name = ?")
        .get(room);
      if (!roomData) {
        socket.send(
          JSON.stringify({ type: "error", message: "Room does not exist" })
        );
        return;
      }
      if (
        roomData.isPublic ||
        (password && bcrypt.compareSync(password, roomData.password))
      ) {
        socket.room = room;
        socket.send(
          JSON.stringify({
            type: "status",
            message: `Joined room: ${room}`,
            roomKeyJwk: roomData.key ? JSON.parse(roomData.key) : null,
          })
        );
        sendRoomHistory(socket, room);
      } else {
        socket.send(
          JSON.stringify({ type: "error", message: "Incorrect password" })
        );
      }
    } else if (type === "text") {
      if (socket.authenticated) {
        const { content } = data;
        if (
          !checkRateLimit(
            socket.username,
            MESSAGE_LIMIT,
            MESSAGE_WINDOW,
            messageCounts
          )
        ) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: "Message rate limit exceeded, please wait",
            })
          );
          return;
        }
        const broadcastMsg = { type: "text", sender: socket.username, content };
        db.prepare(
          "INSERT INTO messages (room, sender, content, timestamp) VALUES (?, ?, ?, ?)"
        ).run(
          socket.room,
          socket.username,
          JSON.stringify(content),
          Date.now()
        );
        logMessage(socket.room, socket.username, content);
        broadcast(socket.room, broadcastMsg);
      } else {
        socket.send(
          JSON.stringify({ type: "error", message: "Please log in first" })
        );
      }
    } else if (type === "file_start") {
      if (socket.authenticated) {
        const { uploadId, fileName, fileSize, totalChunks } = data;
        uploads[uploadId] = {
          fileName,
          fileSize,
          totalChunks,
          receivedChunks: 0,
          chunks: new Array(totalChunks).fill(null),
          iv: Array.from(iv),
          authTag: Array.from(authTag),
        };
        socket.send(
          JSON.stringify({ type: "status", message: "File upload started" })
        );
      } else {
        socket.send(
          JSON.stringify({ type: "error", message: "Please log in first" })
        );
      }
    } else if (type === "file_chunk") {
      if (socket.authenticated) {
        try {
          const { uploadId, chunkIndex, data: chunkData } = data;
          const upload = uploads[uploadId];

          if (upload) {
            const decodedChunk = JSON.parse(atob(chunkData));
            upload.chunks[chunkIndex] = Buffer.from(decodedChunk.data);
            upload.receivedChunks++;

            if (upload.receivedChunks === upload.totalChunks) {
              const fileBuffer = Buffer.concat(upload.chunks);
              const iv = Buffer.from(upload.iv);
              const authTag = Buffer.from(upload.authTag);

              const uniqueFileName = `${uploadId}_${upload.fileName}.enc`;
              const filePath = path.join(uploadsDir, uniqueFileName);
              fs.writeFileSync(filePath, fileBuffer); // Save raw ciphertext as-is

              const fileUrl = `/Uploads/${uniqueFileName}`;

              db.prepare(
                `INSERT INTO files 
  (room, sender, fileUrl, fileName, timestamp, aesKey, iv, authTag)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
              ).run(
                socket.room,
                socket.username,
                fileUrl,
                upload.fileName,
                Date.now(),
                "", // Skip key storage — optional for general room
                iv.toString("hex"),
                authTag.toString("hex")
              );

              const broadcastMsg = {
                type: "file",
                sender: socket.username,
                fileUrl,
                fileName: upload.fileName,
                iv: iv.toString("hex"),
                authTag: authTag.toString("hex"),
              };
              console.log("Sending file metadata to client:", broadcastMsg);
              logMessage(
                socket.room,
                socket.username,
                upload.fileName,
                true,
                fileUrl
              );
              broadcast(socket.room, broadcastMsg);
              delete uploads[uploadId];
            } else {
              socket.send(
                JSON.stringify({ type: "status", message: "Chunk received" })
              );
            }
          } else {
            socket.send(
              JSON.stringify({ type: "error", message: "Invalid upload ID" })
            );
          }
        } catch (err) {
          console.error("File upload failed:", err);
          socket.send(
            JSON.stringify({ type: "error", message: "File upload failed" })
          );
        }
      } else {
        socket.send(
          JSON.stringify({ type: "error", message: "Please log in first" })
        );
      }
    }
  });

  socket.on("close", () => {
    console.log("Client disconnected from:", socket._socket.remoteAddress);
    for (let [username, client] of clients) {
      if (client === socket) clients.delete(username);
    }
  });
});

// Send room history to a client
function sendRoomHistory(socket, room) {
  const textMessages = db
    .prepare(
      "SELECT sender, content, timestamp, 'text' AS type FROM messages WHERE room = ?"
    )
    .all(room)
    .map((m) => {
      let parsedContent;
      try {
        parsedContent = JSON.parse(m.content);
      } catch (e) {
        parsedContent = m.content;
      }
      return {
        type: m.type,
        sender: m.sender,
        content: parsedContent,
        timestamp: m.timestamp,
      };
    });

  const fileMessages = db
    .prepare(
      "SELECT sender, fileUrl, fileName, timestamp, 'file' AS type FROM files WHERE room = ?"
    )
    .all(room)
    .map((f) => ({
      type: f.type,
      sender: f.sender,
      fileUrl: f.fileUrl,
      fileName: f.fileName,
      timestamp: f.timestamp,
      iv: f.iv,
      authTag: f.authTag,
    }));

  const history = [...textMessages, ...fileMessages].sort(
    (a, b) => a.timestamp - b.timestamp
  );

  history.forEach((item) => {
    if (item.type === "text") {
      socket.send(
        JSON.stringify({
          type: "text",
          sender: item.sender,
          content: item.content,
        })
      );
    } else if (item.type === "file") {
      socket.send(
        JSON.stringify({
          type: "file",
          sender: item.sender,
          fileUrl: item.fileUrl,
          fileName: item.fileName,
        })
      );
    }
  });
}

// Broadcast message to all clients in a room
function broadcast(room, message) {
  wss.clients.forEach((client) => {
    if (client.authenticated && client.room === room) {
      client.send(JSON.stringify(message));
    }
  });
}

// Broadcast to all authenticated clients
function broadcastToAll(message) {
  wss.clients.forEach((client) => {
    if (client.authenticated) {
      client.send(JSON.stringify(message));
    }
  });
}

// Start the server
server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Server running on port ${PORT} (public: https://${publicDomain})`
  );
  console.log("WebSocket server initialized at wss://" + publicDomain);
});
// DEBUG: Show encrypted files in the database
const encryptedFiles = db
  .prepare(
    "SELECT id, fileName, aesKey, iv, authTag FROM files WHERE aesKey IS NOT NULL LIMIT 5"
  )
  .all();
console.log("Encrypted files found in DB:", encryptedFiles);
