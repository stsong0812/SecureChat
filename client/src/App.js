import React, { useState, useEffect, useRef } from "react";
import "./App.css";
import EmojiPicker from "emoji-picker-react";

// Encryption utilities
const deriveRoomKey = async (roomName) => {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(roomName + "secret"), // Simple derivation; use a proper secret in production
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("salt"),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
};

const encryptMessage = async (text, key) => {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(text)
  );
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(encrypted)) };
};

const decryptMessage = async (encrypted, key) => {
  if (typeof encrypted === "string") return encrypted; // Handle old plain text
  try {
    const decoder = new TextDecoder();
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(encrypted.iv) },
      key,
      new Uint8Array(encrypted.data)
    );
    return decoder.decode(decrypted);
  } catch (error) {
    console.error("Decryption failed:", error, "Encrypted content:", encrypted);
    return "[Decryption Error]";
  }
};

const encryptFileChunk = async (chunk, key) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    chunk
  );
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(encrypted)) };
};

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
  const roomKeysRef = useRef({});
  const fileInputRef = useRef(null);

  useEffect(() => {
    const initializeWebSocket = async () => {
      const websocket = new WebSocket("wss://localhost:7777");
      websocket.onopen = async () => {
        console.log("WebSocket connection established");
        setIsConnected(true);
        const generalKey = await deriveRoomKey("general");
        roomKeysRef.current["general"] = generalKey;
        console.log("Initial room key set for 'general':", generalKey);
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
      websocket.onmessage = async (e) => {
        try {
          console.log("Raw WebSocket message received:", e.data);
          const data = JSON.parse(e.data);
          const { type, message, sender, content, rooms, fileUrl, fileName, room } = data;

          console.log("Parsed message:", data);

          if (type === "status") {
            showPopupMessage(message, "success");
            if (message.startsWith("Joined room:")) {
              const roomName = message.split(":")[1].trim();
              setCurrentRoom(roomName);
              setMessages([]);
              if (!roomKeysRef.current[roomName]) {
                const key = await deriveRoomKey(roomName);
                roomKeysRef.current[roomName] = key;
                console.log(`Room key set for '${roomName}':`, key);
              }
            } else if (message === "Logged in successfully") {
              setLoggedIn(true);
              websocket.send(JSON.stringify({ type: "get_rooms" }));
              setCurrentRoom("general");
            }
          } else if (type === "error") {
            showPopupMessage(message, "error");
          } else if (type === "text") {
            console.log("Processing text message:", { sender, content });
            console.log("Current room:", currentRoom, "Decryption key:", roomKeysRef.current[currentRoom]);
            const decrypted = await decryptMessage(content, roomKeysRef.current[currentRoom]);
            console.log("Decrypted message:", decrypted);
            setMessages((prev) => {
              const newMessages = [...prev, { type: "text", content: `${sender}: ${decrypted}` }];
              console.log("Updated messages state:", newMessages);
              return newMessages;
            });
          } else if (type === "file") {
            setMessages((prev) => [...prev, { type: "file", sender, fileUrl, fileName }]);
          } else if (type === "room_list") {
            setRooms(rooms);
          } else if (type === "new_room") {
            setRooms((prevRooms) => [...prevRooms, room]);
          }
        } catch (error) {
          console.error("Invalid message format or processing error:", error, "Raw data:", e.data);
        }
      };

      setWs(websocket);
      return () => websocket.close();
    };

    initializeWebSocket();
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
      ws.close();
      setLoggedIn(false);
      setUsername("");
      setPassword("");
      setMessages([]);
      setCurrentRoom("general");
      setRooms([{ name: "general", isPublic: true }]);
      roomKeysRef.current = {};
    }
  };

  const sendMessage = async () => {
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
        console.log("Sending message:", message);
        console.log("Using encryption key for", currentRoom, ":", roomKeysRef.current[currentRoom]);
        const encrypted = await encryptMessage(message, roomKeysRef.current[currentRoom]);
        console.log("Encrypted message sent:", encrypted);
        ws.send(JSON.stringify({ type: "text", content: encrypted }));
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

  const uploadFile = async (file) => {
    const chunkSize = 64 * 1024; // 64KB
    const totalChunks = Math.ceil(file.size / chunkSize);
    const uploadId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const key = roomKeysRef.current[currentRoom];

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

      reader.onload = async () => {
        const data = reader.result;
        const encryptedChunk = await encryptFileChunk(new Uint8Array(data), key);
        const base64 = btoa(JSON.stringify(encryptedChunk));
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

  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    if (file) {
      uploadFile(file);
    }
  };

  const decryptAndDownloadFile = async (fileUrl, fileName) => {
    try {
      const response = await fetch(fileUrl);
      const encryptedData = await response.arrayBuffer();
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(12) },
        roomKeysRef.current[currentRoom],
        encryptedData
      );
      const blob = new Blob([decrypted]);
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error("File decryption failed:", error);
      showPopupMessage("Failed to decrypt file", "error");
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
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          decryptAndDownloadFile(msg.fileUrl, msg.fileName);
                        }}
                      >
                        {msg.fileName} (encrypted)
                      </a>
                    </div>
                  );
                } else {
                  return (
                    <div key={i} className="message">
                      <div>
                        <strong>{msg.sender}</strong>:
                      </div>
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          decryptAndDownloadFile(msg.fileUrl, msg.fileName);
                        }}
                      >
                        {msg.fileName} (encrypted)
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