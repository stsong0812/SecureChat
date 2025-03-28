require("dotenv").config();
const express = require("express");
const https = require("https");
const WebSocket = require("ws");
const Database = require("better-sqlite3");
const bcrypt = require("bcrypt");
const fs = require("fs");
const path = require("path");

// Configuration from .env
const PORT = process.env.PORT || 7777;
const dbPath = process.env.DB_PATH;
const dbKey = process.env.SECRET_KEY;

// Validate environment variables
if (!dbPath || !dbKey) {
  throw new Error(
    "Missing database path or encryption key in environment variables"
  );
}

if (!fs.existsSync(dbPath)) {
  throw new Error(
    `Database not found at ${dbPath}. Please run auth-db.js first.`
  );
}

// Initialize SQLite database
const db = new Database(dbPath);
db.pragma(`key = "${dbKey}"`);

// Rate limiting configuration
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW = 60 * 1000; // 1 minute
const MESSAGE_LIMIT = 10;
const MESSAGE_WINDOW = 60 * 1000; // 1 minute

const loginAttempts = {};
const messageCounts = {};
const uploads = {};

// Create uploads and logs directories if they don't exist
const uploadsDir = path.join(__dirname, "uploads");
const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Load SSL/TLS certificates
const isProduction = process.env.NODE_ENV === "production";

const options = isProduction
  ? {
      key: fs.readFileSync(
        "/etc/letsencrypt/live/insecurechat.com-0001/privkey.pem"
      ),
      cert: fs.readFileSync(
        "/etc/letsencrypt/live/insecurechat.com-0001/fullchain.pem"
      ),
    }
  : {
      key: fs.readFileSync(path.join(__dirname, "key.pem")),
      cert: fs.readFileSync(path.join(__dirname, "cert.pem")),
    };

// Set up Express and HTTPS server
const app = express();
const server = https.createServer(options, app);
const wss = new WebSocket.Server({ server });

// Serve static files from the React app
app.use(express.static(path.join(__dirname, "../client/build")));

// Handle React routing, return all requests to React app
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/build", "index.html"));
});

app.use("/uploads", express.static(uploadsDir));

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

// Logging function for room messages (logs encrypted data)
function logMessage(room, sender, content, isFile = false, fileUrl = "") {
  const timestamp = new Date().toISOString();
  const logFile = path.join(logsDir, `${room}.log`);
  let logEntry;
  if (isFile) {
    logEntry = `[${timestamp}] ${sender} uploaded encrypted file: ${content} (${fileUrl})\n`;
  } else {
    logEntry = `[${timestamp}] ${sender}: ${JSON.stringify(content)}\n`; // Log encrypted content
  }
  fs.appendFile(logFile, logEntry, (err) => {
    if (err) {
      console.error(`Failed to log to ${logFile}:`, err);
    }
  });
}

const clients = new Map();

// WebSocket connection handling
wss.on("connection", (socket) => {
  console.log("Client connected");
  socket.authenticated = false;
  socket.room = "general"; // Default room

  socket.on("message", (message) => {
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
        ).run(roomName, isPublic ? 1 : 0, hash, JSON.stringify(roomKeyJwk)); // Store JWK as JSON string
        socket.send(
          JSON.stringify({
            type: "status",
            message: `Room "${roomName}" created successfully`,
          })
        );
        broadcastToAll({
          type: "new_room",
          room: { name: roomName, isPublic },
          roomKeyJwk, // Broadcast for real-time updates
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
            roomKeyJwk: roomData.key ? JSON.parse(roomData.key) : null, // Send stored JWK
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
        const { content } = data; // Encrypted content
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
        const { uploadId, chunkIndex, data: chunkData } = data;
        const upload = uploads[uploadId];
        if (upload) {
          const decodedChunk = JSON.parse(atob(chunkData));
          upload.chunks[chunkIndex] = Buffer.from(decodedChunk.data);
          upload.receivedChunks++;
          if (upload.receivedChunks === upload.totalChunks) {
            const fileBuffer = Buffer.concat(upload.chunks);
            const uniqueFileName = `${uploadId}_${upload.fileName}`;
            const filePath = path.join(uploadsDir, uniqueFileName);
            fs.writeFileSync(filePath, fileBuffer);
            const fileUrl = `/uploads/${uniqueFileName}`;

            db.prepare(
              "INSERT INTO files (room, sender, fileUrl, fileName, timestamp) VALUES (?, ?, ?, ?, ?)"
            ).run(
              socket.room,
              socket.username,
              fileUrl,
              upload.fileName,
              Date.now()
            );

            const broadcastMsg = {
              type: "file",
              sender: socket.username,
              fileUrl,
              fileName: upload.fileName,
            };
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
      } else {
        socket.send(
          JSON.stringify({ type: "error", message: "Please log in first" })
        );
      }
    }
  });

  socket.on("close", () => {
    for (let [username, client] of clients) {
      if (client === socket) clients.delete(username);
    }
    console.log("Client disconnected");
  });
});

// Send room history to a client, merging text and files by timestamp
function sendRoomHistory(socket, room) {
  const textMessages = db
    .prepare(
      "SELECT sender, content, timestamp, 'text' AS type FROM messages WHERE room = ?"
    )
    .all(room)
    .map((m) => {
      let parsedContent;
      try {
        parsedContent = JSON.parse(m.content); // Try parsing as JSON (encrypted)
      } catch (e) {
        parsedContent = m.content; // Fall back to plain text if not JSON
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
server.listen(PORT, () => {
  console.log(`Secure server running on https://localhost:${PORT}`);
});
