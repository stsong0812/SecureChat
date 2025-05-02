import React, { useState, useEffect, useRef } from "react";
import "./App.css";
import EmojiPicker from "emoji-picker-react";

// Encryption utilities (only used for "general" room)
const deriveRoomKey = async (roomName) => {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(roomName + "secret"),
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

// eslint-disable-next-line no-unused-vars
const exportKey = async (key) => {
  return await crypto.subtle.exportKey("jwk", key);
};

// eslint-disable-next-line no-unused-vars
const importKey = async (jwk) => {
  return await crypto.subtle.importKey("jwk", jwk, { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
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
  if (typeof encrypted === "string") return encrypted; // Handle plain text
  try {
    const decoder = new TextDecoder();
    const iv = new Uint8Array(
      messages
        .find((m) => m.fileUrl === fileUrl)
        ?.iv?.match(/.{1,2}/g)
        .map((byte) => parseInt(byte, 16)) || []
    );
    const tag = new Uint8Array(
      messages
        .find((m) => m.fileUrl === fileUrl)
        ?.authTag?.match(/.{1,2}/g)
        .map((byte) => parseInt(byte, 16)) || []
    );

    // Merge ciphertext + authTag as required by SubtleCrypto
    const fullData = new Uint8Array([...new Uint8Array(encryptedData), ...tag]);

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      roomKeysRef.current[currentRoom],
      fullData
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

// Parse markdown-like syntax to HTML
const parseFormattedText = (text) => {
  let formatted = text
    .replace(/\*(.*?)\*/g, "<b>$1</b>")
    .replace(/_(.*?)_/g, "<i>$1</i>")
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
  console.log("Formatted text:", formatted);
  return formatted;
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
  const roomKeysRef = useRef({}); // Only used for "general"
  const pendingMessagesRef = useRef({}); // Map of roomName to pending messages
  const fileInputRef = useRef(null);

  useEffect(() => {
    const initializeKeysAndWebSocket = async () => {
      const generalKey = await deriveRoomKey("general");
      roomKeysRef.current = { general: generalKey };
      console.log("Initial room key set for 'general':", generalKey);

      const wsUrl = process.env.REACT_APP_WS_URL || "wss://localhost:7777";
      console.log("Connecting to WebSocket URL:", wsUrl); // Debug log
      const websocket = new WebSocket(wsUrl);
      websocket.onopen = () => {
        console.log("WebSocket connected");
        setIsConnected(true); // Set connection status
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
          const {
            type,
            message,
            sender,
            content,
            rooms,
            fileUrl,
            fileName,
            room,
          } = data;

          console.log("Parsed message:", data);

          if (type === "status") {
            showPopupMessage(message, "success");
            if (message.startsWith("Joined room:")) {
              const roomName = message.split(":")[1].trim();
              setCurrentRoom(roomName);
              setMessages([]);
              console.log(
                `Switched to room '${roomName}', current keys:`,
                roomKeysRef.current
              );
              if (
                roomKeysRef.current[roomName] &&
                pendingMessagesRef.current[roomName]
              ) {
                const pending = pendingMessagesRef.current[roomName];
                delete pendingMessagesRef.current[roomName];
                for (const msg of pending) {
                  await processTextMessage(msg.sender, msg.content, roomName);
                }
              }
            } else if (message === "Logged in successfully") {
              setLoggedIn(true);
              websocket.send(JSON.stringify({ type: "get_rooms" }));
              setCurrentRoom("general");
            }
          } else if (type === "error") {
            showPopupMessage(message, "error");
          } else if (type === "text") {
            if (
              currentRoom === "general" &&
              !roomKeysRef.current[currentRoom]
            ) {
              console.log(
                `Key not ready for '${currentRoom}', queuing message`
              );
              if (!pendingMessagesRef.current[currentRoom]) {
                pendingMessagesRef.current[currentRoom] = [];
              }
              pendingMessagesRef.current[currentRoom].push({ sender, content });
            } else {
              await processTextMessage(sender, content, currentRoom);
            }
          } else if (type === "file") {
            console.log("Received file:", data); // using for debug
            setMessages((prev) => [
              ...prev,
              {
                type: "file",
                sender,
                fileUrl,
                fileName,
                iv: data.iv,
                authTag: data.authTag,
              },
            ]);
          } else if (type === "room_list") {
            setRooms(rooms);
          } else if (type === "new_room") {
            setRooms((prevRooms) => {
              const newRooms = [...prevRooms, room];
              return newRooms;
            });
          }
        } catch (error) {
          console.error(
            "Invalid message format or processing error:",
            error,
            "Raw data:",
            e.data
          );
        }
      };

      setWs(websocket);
      return () => websocket.close();
    };

    initializeKeysAndWebSocket();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const processTextMessage = async (sender, content, room) => {
    console.log("Processing text message:", { sender, content });
    let decrypted;
    if (room === "general") {
      console.log(
        "Using decryption key for",
        room,
        ":",
        roomKeysRef.current[room]
      );
      decrypted = await decryptMessage(content, roomKeysRef.current[room]);
    } else {
      console.log(`No encryption for '${room}', processing as plain text`);
      decrypted =
        typeof content === "string" ? content : "[Invalid message format]";
    }
    console.log("Decrypted message:", decrypted);
    const formatted = parseFormattedText(decrypted);
    setMessages((prev) => {
      const newMessages = [
        ...prev,
        { type: "text", content: `${sender}: ${formatted}` },
      ];
      console.log("Updated messages state:", newMessages);
      return newMessages;
    });
  };

  const showPopupMessage = (message, type = "success") => {
    setPopupMessage(message);
    setShowPopup(true);
    setPopupType(type);
    setTimeout(() => setShowPopup(false), 3000);
  };

  const validateInputs = () => {
    if (
      !username ||
      username.length < 3 ||
      username.length > 20 ||
      !/^[a-zA-Z0-9_]+$/.test(username)
    ) {
      showPopupMessage(
        "Username must be 3-20 alphanumeric characters",
        "error"
      );
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
      roomKeysRef.current = { general: roomKeysRef.current.general }; // Retain only general key
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
          showPopupMessage(
            "Usage: /create roomName [public|private] [password]",
            "error"
          );
          return;
        }
        const roomName = parts[1];
        const visibility = parts[2] || "public";
        const password = parts[3] || "";
        const isPublic = visibility === "public";
        ws.send(
          JSON.stringify({ type: "create_room", roomName, isPublic, password })
        );
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "join", room: roomName }));
          setCurrentRoom(roomName);
          console.log(`Auto-joined room '${roomName}'`);
        }, 500);
      } else {
        console.log("Sending message:", message, "in room:", currentRoom);
        if (currentRoom === "general") {
          if (!roomKeysRef.current[currentRoom]) {
            showPopupMessage(
              `No key for room '${currentRoom}', please rejoin`,
              "error"
            );
            return;
          }
          console.log(
            "Using encryption key for",
            currentRoom,
            ":",
            roomKeysRef.current[currentRoom]
          );
          const encrypted = await encryptMessage(
            message,
            roomKeysRef.current[currentRoom]
          );
          console.log("Encrypted message sent:", encrypted);
          ws.send(JSON.stringify({ type: "text", content: encrypted }));
        } else {
          console.log(`Sending plain text for '${currentRoom}'`);
          ws.send(JSON.stringify({ type: "text", content: message }));
        }
        setMessage("");
      }
    }
  };

  const handleRoomChange = (e) => {
    const roomName = e.target.value;
    if (!roomName) return;
    const room = rooms.find((r) => r.name === roomName);
    if (room.isPublic) {
      console.log("Switching to room:", roomName);
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
    console.log("Joining private room:", selectedRoom);
    ws.send(
      JSON.stringify({
        type: "join",
        room: selectedRoom,
        password: passwordInput,
      })
    );
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
        if (currentRoom === "general") {
          const encryptedChunk = await encryptFileChunk(
            new Uint8Array(data),
            key
          );
          const base64 = btoa(JSON.stringify(encryptedChunk));
          ws.send(
            JSON.stringify({
              type: "file_chunk",
              uploadId,
              chunkIndex: i,
              data: base64,
            })
          );
        } else {
          const base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
          ws.send(
            JSON.stringify({
              type: "file_chunk",
              uploadId,
              chunkIndex: i,
              data: base64,
            })
          );
        }
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

  const decryptAndDownloadFile = async (
    fileUrl,
    fileName,
    ivHex,
    authTagHex
  ) => {
    try {
      const response = await fetch(fileUrl);
      const encryptedBuffer = await response.arrayBuffer();

      if (currentRoom === "general") {
        const key = roomKeysRef.current[currentRoom];
        const iv = Uint8Array.from(Buffer.from(ivHex, "hex"));
        const authTag = Uint8Array.from(Buffer.from(authTagHex, "hex"));

        const fullData = new Uint8Array(
          encryptedBuffer.byteLength + authTag.byteLength
        );
        fullData.set(new Uint8Array(encryptedBuffer), 0);
        fullData.set(authTag, encryptedBuffer.byteLength);

        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv },
          key,
          fullData
        );

        const blob = new Blob([decrypted]);
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        link.click();
        window.URL.revokeObjectURL(url);
      } else {
        const blob = new Blob([encryptedBuffer]);
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        link.click();
        window.URL.revokeObjectURL(url);
      }
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
            username:{" "}
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="prompt">
            password:{" "}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="commands">
            <span className="command" onClick={register}>
              register
            </span>
            <span className="command" onClick={login}>
              login
            </span>
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
                  <div
                    key={i}
                    className="message"
                    dangerouslySetInnerHTML={{ __html: msg.content }}
                  />
                );
              } else if (msg.type === "file") {
                if (isImage(msg.fileName)) {
                  return (
                    <div key={i} className="message">
                      <div>
                        <strong>{msg.sender}</strong>:
                      </div>
                      <button
                        className="file-link"
                        onClick={() =>
                          decryptAndDownloadFile(msg.fileUrl, msg.fileName)
                        }
                      >
                        {msg.fileName}{" "}
                        {currentRoom === "general" ? "(encrypted)" : ""}
                      </button>
                    </div>
                  );
                } else {
                  return (
                    <div key={i} className="message">
                      <div>
                        <strong>{msg.sender}</strong>:
                      </div>
                      <button
                        className="file-link"
                        onClick={() =>
                          decryptAndDownloadFile(
                            msg.fileUrl,
                            msg.fileName,
                            msg.iv,
                            msg.authTag
                          )
                        }
                      >
                        {msg.fileName}{" "}
                        {currentRoom === "general" ? "(encrypted)" : ""}
                      </button>
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
              placeholder="Type a message (*bold*, _italic_, [link](url)) or /create roomName [public|private] [password]"
            />
            <button onClick={() => setShowEmojiPicker(!showEmojiPicker)}>
              🤫
            </button>
            <input
              type="file"
              style={{ display: "none" }}
              ref={fileInputRef}
              onChange={handleFileSelect}
            />
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
