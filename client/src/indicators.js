export const broadcastTyping = (ws, username, room) => {
  ws.send(JSON.stringify({ type: "typing", username, room }));
};

export const broadcastOnlineStatus = (ws, username, isOnline) => {
  ws.send(
    JSON.stringify({
      type: "user_status", // name change
      username,
      status: isOnline ? "online" : "offline",
    })
  );
};
