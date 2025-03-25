const WebSocket = require("ws");
const ws = new WebSocket("wss://insecurechat.com");

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "login",
      username: "testuser",
      password: "testpass",
    })
  );
});

ws.on("message", (data) => {
  console.log("Received:", data.toString());
});
