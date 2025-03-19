// Loads environment variables from .env file
require('dotenv').config();

const WebSocket = require('ws');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

// Establish server configuration from .env file
const PORT = process.env.PORT;
const dbPath = process.env.DB_PATH;
const dbKey = process.env.SECRET_KEY;

// Raise exception for properly set environment variables
if (!dbPath || !dbKey) {
  throw new Error("Missing database path or encryption key in environment variables");
}

// Establish connection to database
const db = new Database(dbPath);
// Apply database encryption key
db.pragma('key = "${dbKey}"');

// Rate limiting configuration
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW = 60 * 1000;
const MESSAGE_LIMIT = 10;
const MESSAGE_WINDOW = 60 * 1000;

const loginAttempts = {};
const messageCounts = {};

function checkRateLimit(key, limit, window, trackingObject) {
  const now = Date.now();
  if (!trackingObject[key]){
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

// Initialize WebSocket server on specified port
const server = new WebSocket.Server({ port: PORT });
// Stores authenticated clients
const clients = new Map();

server.on('connection', (socket) => {
  console.log('Client connected');
  socket.authenticated = false;

  socket.on('message', (message) => {
    const msg = message.toString();
    console.log('Received:', msg);

    // Get client IP address for unauth rate limiting
    const ip = socket._socket.remoteAddress;

    // Rate limiting user registration and login
    if (msg.startsWith('register:') || msg.startsWith('login:')) {
      if (!checkRateLimit(ip, LOGIN_LIMIT, LOGIN_WINDOW, loginAttempts)) {
        socket.send('Too many attempts, please try again later');
        return;
      }
    }

    // Handles user registration
    if (msg.startsWith('register:')) {
      const [, username, password] = msg.split(':');
      try {
        const hash = bcrypt.hashSync(password, 10); // Hash password using bcrypt
        db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hash);
        console.log('Attempting to send registration success');
        socket.send('Registered successfully');
        console.log('Sent registration success');
      } catch (e) {
        socket.send('Error: Username taken');   // Handles duplicate usernames
      }
    // Handles user login 
    } else if (msg.startsWith('login:')) {
      const [, username, password] = msg.split(':');
      const user = db.prepare('SELECT password FROM users WHERE username = ?').get(username);
      // Validate user credentials
      if (user && bcrypt.compareSync(password, user.password)) {
        socket.authenticated = true;
        socket.username = username;
        clients.set(username, socket);  // Store authenticated clients
        socket.send('Logged in successfully');
        // Send chat history
        const history = db.prepare('SELECT sender, content FROM messages ORDER BY timestamp ASC').all();
        history.forEach((m) => socket.send(`${m.sender}: ${m.content}`));
      } else {
        socket.send('Invalid credentials');     // Handles incorrect user:pass
      }
    // Handles authenticated message broadcasting
    } else if (socket.authenticated) {
      const sender = socket.username;
      if (!checkRateLimit(sender, MESSAGE_LIMIT, MESSAGE_WINDOW, messageCounts)) {
        socket.send('Message rate limit exceeded, please wait');
        return;
      } 
      else {
        const broadcastMsg = `${sender}: ${msg}`;
      // Store message in database
      db.prepare('INSERT INTO messages (sender, content, timestamp) VALUES (?, ?, ?)').run(
        sender,
        msg,
        Date.now()
      );
      // Broadcast to all authenticated clients
      server.clients.forEach((client) => {
        if (client.authenticated) client.send(broadcastMsg);
      });
    }
    // Handle unauthenticated messages
    } else {
      socket.send('Please log in first');
    }
  });

  // Handles client disconnections
  socket.on('close', () => {
    for (let [username, client] of clients) {
      if (client === socket) clients.delete(username);
    }
    console.log('Client disconnected');
  });
});

console.log(`Server running on ws://localhost:${PORT}`);