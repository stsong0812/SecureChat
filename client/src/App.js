import React, { useState, useEffect, useRef } from "react";
import "./App.css";
import EmojiPicker from "emoji-picker-react";

function App() {
  const [ws, setWs] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);
  const [loggedIn, setLoggedIn] = useState(false);
  const [popupMessage, setPopupMessage] = useState("");
  const [showPopup, setShowPopup] = useState(false);
  const [popupType, setPopupType] = useState("success");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [currentRoom, setCurrentRoom] = useState("general");
  const [rooms, setRooms] = useState([{ name: "general", isPublic: true }]);
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [showPasswordInput, setShowPasswordInput] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const fileInputRef = useRef(null);

  useEffect(() => {
    const websocket = new WebSocket("wss://localhost:7777");
    websocket.onopen = () => {
      console.log("WebSocket connection established");
      setIsConnected(true);
    };
    websocket.onerror = (error) => {
      console.error("WebSocket error:", error);
      setIsConnected(false);
    };
    websocket.onclose = () => {
      console.log("WebSocket connection closed");
      setIsConnected(false);
      setLoggedIn(false);
    };
    websocket.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const { type, message, sender, content, rooms, fileUrl, fileName, room } = data;

        if (type === "status") {
          showPopupMessage(message, "success");
          if (message.startsWith("Joined room:")) {
            const roomName = message.split(":")[1].trim();
            setCurrentRoom(roomName);
            setMessages([]); // Clear messages for new room
          } else if (message === "Logged in successfully") {
            setLoggedIn(true);
            websocket.send(JSON.stringify({ type: "get_rooms" }));
            setCurrentRoom("general");
          } else if (message === "Room created successfully") {
            // Optional: Auto-join the newly created room
          }
        } else if (type === "error") {
          showPopupMessage(message, "error");
        } else if (type === "text") {
          setMessages((prev) => [...prev, { type: "text", content: `${sender}: ${content}` }]);
        } else if (type === "file") {
          setMessages((prev) => [...prev, { type: "file", sender, fileUrl, fileName }]);
        } else if (type === "room_list") {
          setRooms(rooms);
        } else if (type === "new_room") {
          setRooms((prevRooms) => [...prevRooms, room]);
        }
      } catch (error) {
        console.error("Invalid message format:", e.data);
      }
    };

    setWs(websocket);
    return () => websocket.close();
  }, []);

  const showPopupMessage = (message, type = "success") => {
    setPopupMessage(message);
    setShowPopup(true);
    setPopupType(type);
    setTimeout(() => setShowPopup(false), 3000);
  };

  const validateInputs = () => {
    if (!username || username.length < 3 || username.length > 20 || !/^[a-zA-Z0-9_]+$/.test(username)) {
      showPopupMessage("Username must be 3-20 alphanumeric characters", "error");
      return false;
    }
    if (!password || password.length < 6) {
      showPopupMessage("Password must be at least 6 characters", "error");
      return false;
    }
    return true;
  };

  const register = () => {
    if (!validateInputs()) return;
    if (ws && isConnected) {
      ws.send(JSON.stringify({ type: "register", username, password }));
    } else {
      showPopupMessage("WebSocket connection not established", "error");
    }
  };

  const login = () => {
    if (!validateInputs()) return;
    if (ws && isConnected) {
      ws.send(JSON.stringify({ type: "login", username, password }));
    } else {
      showPopupMessage("WebSocket connection not established", "error");
    }
  };

  const logout = () => {
    if (ws && isConnected) {
      ws.close(); // Simply close the connection; server will handle cleanup
      setLoggedIn(false);
      setUsername("");
      setPassword("");
      setMessages([]);
      setCurrentRoom("general");
      setRooms([{ name: "general", isPublic: true }]);
    }
  };

  const sendMessage = () => {
    if (!ws || !loggedIn) {
      showPopupMessage("Not logged in or WebSocket not connected", "error");
      return;
    }
    if (message.trim()) {
      if (message.startsWith("/create ")) {
        const parts = message.split(" ");
        if (parts.length < 2) {
          showPopupMessage("Usage: /create roomName [public|private] [password]", "error");
          return;
        }
        const roomName = parts[1];
        const visibility = parts[2] || "public";
        const password = parts[3] || "";
        const isPublic = visibility === "public";
        ws.send(JSON.stringify({ type: "create_room", roomName, isPublic, password }));
      } else {
        ws.send(JSON.stringify({ type: "text", content: message }));
      }
      setMessage("");
    }
  };

  const handleRoomChange = (e) => {
    const roomName = e.target.value;
    if (!roomName) return;
    const room = rooms.find((r) => r.name === roomName);
    if (room.isPublic) {
      ws.send(JSON.stringify({ type: "join", room: roomName }));
    } else {
      setSelectedRoom(roomName);
      setShowPasswordInput(true);
    }
  };

  const handleJoinPrivateRoom = () => {
    if (!passwordInput) {
      showPopupMessage("Password required for private room", "error");
      return;
    }
    ws.send(JSON.stringify({ type: "join", room: selectedRoom, password: passwordInput }));
    setShowPasswordInput(false);
    setPasswordInput("");
  };

  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    if (file) {
      uploadFile(file);
    }
  };

  const uploadFile = (file) => {
    const chunkSize = 64 * 1024; // 64KB
    const totalChunks = Math.ceil(file.size / chunkSize);
    const uploadId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    ws.send(
      JSON.stringify({
        type: "file_start",
        uploadId,
        fileName: file.name,
        fileSize: file.size,
        totalChunks,
      })
    );

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const chunk = file.slice(start, end);
      const reader = new FileReader();

      reader.onload = () => {
        const data = reader.result;
        const base64 = btoa(
          new Uint8Array(data).reduce((data, byte) => data + String.fromCharCode(byte), "")
        );
        ws.send(
          JSON.stringify({
            type: "file_chunk",
            uploadId,
            chunkIndex: i,
            data: base64,
          })
        );
      };
      reader.readAsArrayBuffer(chunk);
    }
  };

  const isImage = (fileName) => {
    const ext = fileName.split(".").pop().toLowerCase();
    return ["jpg", "jpeg", "png", "gif"].includes(ext);
  };

  return (
    <div className="terminal">
      <div className="header">securechat@localhost:~$</div>
      {showPopup && <div className={`popup ${popupType}`}>{popupMessage}</div>}
      {!loggedIn ? (
        <div className="login">
          <div className="prompt">
            username: <input value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="prompt">
            password: <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="commands">
            <span className="command" onClick={register}>register</span>
            <span className="command" onClick={login}>login</span>
          </div>
        </div>
      ) : (
        <div className="chat">
          <div className="room-controls">
            <span>Current room: {currentRoom}</span>
            <select value={currentRoom} onChange={handleRoomChange}>
              {rooms.map((room) => (
                <option key={room.name} value={room.name}>
                  {room.name} {room.isPublic ? "(public)" : "(private)"}
                </option>
              ))}
            </select>
            <button onClick={logout}>Logout</button>
          </div>
          {showPasswordInput && (
            <div className="password-prompt">
              <input
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder={`Password for ${selectedRoom}`}
              />
              <button onClick={handleJoinPrivateRoom}>Join</button>
            </div>
          )}
          <div className="messages">
            {messages.map((msg, i) => {
              if (msg.type === "text") {
                return (
                  <div key={i} className="message">
                    {msg.content}
                  </div>
                );
              } else if (msg.type === "file") {
                if (isImage(msg.fileName)) {
                  return (
                    <div key={i} className="message">
                      <div>
                        <strong>{msg.sender}</strong>:
                      </div>
                      <img src={msg.fileUrl} alt={msg.fileName} style={{ maxWidth: "200px" }} />
                    </div>
                  );
                } else {
                  return (
                    <div key={i} className="message">
                      <div>
                        <strong>{msg.sender}</strong>:
                      </div>
                      <a href={msg.fileUrl} download={msg.fileName} target="_blank" rel="noopener noreferrer">
                        {msg.fileName}
                      </a>
                    </div>
                  );
                }
              }
              return null;
            })}
          </div>
          <div className="input">
            <span className="prompt">$ </span>
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && sendMessage()}
              placeholder="Type a message or /create roomName [public|private] [password]"
            />
            <button onClick={() => setShowEmojiPicker(!showEmojiPicker)}>🤫</button>
            <input type="file" style={{ display: "none" }} ref={fileInputRef} onChange={handleFileSelect} />
            <button onClick={() => fileInputRef.current.click()}>📁</button>
            {showEmojiPicker && (
              <div className="emoji-picker">
                <EmojiPicker
                  onEmojiClick={(emojiObject) => {
                    setMessage((prev) => prev + emojiObject.emoji);
                    setShowEmojiPicker(false);
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;