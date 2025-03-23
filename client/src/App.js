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
  const [recipient, setRecipient] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    const websocket = new WebSocket("ws://localhost:7777");
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
    };
    websocket.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const { type, message, sender, content, fileUrl, fileName } = data;
        if (type === "status") {
          showPopupMessage(message, "success");
          if (message === "Logged in successfully") {
            setLoggedIn(true);
            setMessages([]);
          }
        } else if (type === "error") {
          showPopupMessage(message, "error");
        } else if (type === "text") {
          setMessages((prev) => [
            ...prev,
            { type: "text", content: `${sender}: ${content}` },
          ]);
        } else if (type === "file") {
          setMessages((prev) => [
            ...prev,
            { type: "file", sender, fileUrl, fileName },
          ]);
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

  const register = () => {
    if (ws && isConnected) {
      ws.send(JSON.stringify({ type: "register", username, password }));
    } else {
      showPopupMessage("WebSocket connection not established");
    }
  };

  const login = () => {
    if (ws && isConnected) {
      ws.send(JSON.stringify({ type: "login", username, password }));
    } else {
      showPopupMessage("WebSocket connection not established");
    }
  };

  const sendMessage = () => {
    if (ws && loggedIn) {
      if (!recipient) {
        // makes sure recipient is selected
        showPopupMessage("Please select a recipient", "error");
        return;
      }
      ws.send(
        JSON.stringify({
          type: "text",
          content: message,
          from: username,
          to: recipient,
        })
      );
      setMessage("");
    }
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

    // Send file start message
    ws.send(
      JSON.stringify({
        type: "file_start",
        uploadId,
        fileName: file.name,
        fileSize: file.size,
        totalChunks,
      })
    );

    // Send file chunks
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const chunk = file.slice(start, end);
      const reader = new FileReader();

      reader.onload = () => {
        const data = reader.result;
        const base64 = btoa(
          new Uint8Array(data).reduce(
            (data, byte) => data + String.fromCharCode(byte),
            ""
          )
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
            username:{" "}
            <input
              type="text"
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
                      <img
                        src={msg.fileUrl}
                        alt={msg.fileName}
                        style={{ maxWidth: "200px" }}
                      />
                    </div>
                  );
                } else {
                  return (
                    <div key={i} className="message">
                      <div>
                        <strong>{msg.sender}</strong>:
                      </div>
                      <a
                        href={msg.fileUrl}
                        download={msg.fileName}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {msg.fileName}
                      </a>
                    </div>
                  );
                }
              }
              return null;
            })}
          </div>
          // Select the chat recipient (hardcoded for now, will be dynamic
          later)
          <div className="prompt">
            chat with:{" "}
            <select
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            >
              <option value="">-- select user --</option>
              <option value="User1">User1</option>
              <option value="User2">User2</option>
            </select>
          </div>
          <div className="input">
            <span className="prompt">$ </span>
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && sendMessage()}
            />
            <button onClick={() => setShowEmojiPicker(!showEmojiPicker)}>
              😀
            </button>
            <input
              type="file"
              style={{ display: "none" }}
              ref={fileInputRef}
              onChange={handleFileSelect}
            />
            <button onClick={() => fileInputRef.current.click()}>📎</button>
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
