export const broadcastTyping = (ws, username, room) => {
  ws.send(JSON.stringify({ type: "typing", username, room }));
};

export const broadcastOnlineStatus = (ws, username, isOnline) => {
  ws.send(
    JSON.stringify({
      type: "status_update",
      username,
      status: isOnline ? "online" : "offline",
    })
  );
};
