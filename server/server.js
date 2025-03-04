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
db.pragma(`key = "${dbKey}"`);

// Initialize WebSocket server on specified port
const server = new WebSocket.Server({ port: PORT });
// Stores authenticated clients
const clients = new Map();

//
server.on('connection', (socket) => {
  console.log('Client connected');
  socket.authenticated = false;

  socket.on('message', (message) => {
    const msg = message.toString();
    console.log('Received:', msg);

    // Handles user registration
    if (msg.startsWith('register:')) {
      const [, username, password] = msg.split(':');
      try {
        const hash = bcrypt.hashSync(password, 10); // Hash password using bcrypt
        db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hash);
        socket.send('Registered successfully');
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
        clients.set(username, socket);  // Store authenticated clients
        socket.send('Logged in successfully');
      } else {
        socket.send('Invalid credentials');     // Handles incorrect user:pass
      }
    // Handles authenticated message broadcasting
    } else if (socket.authenticated) {
      const sender = [...clients.entries()].find(([_, client]) => client === socket)[0];
      const broadcastMsg = `${sender}: ${msg}`;
      for (let [_, client] of clients) {
        if (client.authenticated) client.send(broadcastMsg);
      }
    // Handles unauthenticated messages
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