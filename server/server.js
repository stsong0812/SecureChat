const WebSocket = require('ws');

const server = new WebSocket.Server({ port: 7777 });
server.on('connection', (socket) => {
  console.log('Client connected');
  socket.on('message', (message) => {
    console.log('Received:', message.toString());
    socket.send('Echo: ' + message);
  });
  socket.on('close', () => console.log('Client disconnected'));
});
console.log('Server running on ws://localhost:7777');