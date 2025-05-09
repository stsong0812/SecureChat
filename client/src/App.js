import React, { useState, useEffect, useRef } from "react";
import "./App.css";
import EmojiPicker from "emoji-picker-react";

// Encryption utilities (only used for "general" room messages)
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
  const roomKeysRef = useRef({}); // Only used for "general" room messages
  const pendingMessagesRef = useRef({}); // Map of roomName to pending messages
  const fileInputRef = useRef(null);
  const [typingUser, setTypingUser] = useState(null);
  const [userStatuses, setUserStatuses] = useState({});
  const [allUsers, setAllUsers] = useState([]); // List of all registered usernames
  const idleTimerRef = useRef(null);
  const lastActivityTimeRef = useRef(Date.now());

  const currentRoomRef = useRef(currentRoom);

  const getTerminalPrompt = () => {
	return `<span style="color:#00ff00">${username}@localhost:~$</span>`;
  };
  useEffect(() => {
	currentRoomRef.current = currentRoom;
  }, [currentRoom]);

  useEffect(() => {
	const initializeKeysAndWebSocket = async () => {
  	const generalKey = await deriveRoomKey("general");
  	roomKeysRef.current = { general: generalKey };
  	console.log("Derived general room key for messages:", generalKey);

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
      	const actualCurrentRoom = currentRoomRef.current; // Use the ref for current room

      	if (type === "status") {
        	showPopupMessage(message, "success");
        	if (message.startsWith("Joined room:")) {
          	const roomName = message.split(":")[1].trim();
          	setCurrentRoom(roomName); // This will trigger the useEffect to update currentRoomRef
          	setMessages([]);
          	console.log(
            	`Switched to room '${roomName}', current keys:`,
            	roomKeysRef.current
          	);
          	if (
            	roomKeysRef.current[roomName] && // Check if key for general room messages is ready
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
          	websocket.send(JSON.stringify({ type: "get_users" }));
          	setCurrentRoom("general"); // This will update currentRoomRef via useEffect
        	}
      	} else if (type === "error") {
        	showPopupMessage(message, "error");
      	} else if (type === "text") {
        	if (
          	actualCurrentRoom === "general" && // Text message encryption for "general" room
          	!roomKeysRef.current[actualCurrentRoom]
        	) {
          	console.log(
            	`Key not ready for '${actualCurrentRoom}' text messages, queuing message`
          	);
          	if (!pendingMessagesRef.current[actualCurrentRoom]) {
            	pendingMessagesRef.current[actualCurrentRoom] = [];
          	}
          	pendingMessagesRef.current[actualCurrentRoom].push({
            	sender,
            	content,
          	});
        	} else {
          	await processTextMessage(sender, content, actualCurrentRoom);
        	}
      	} else if (type === "user_list") {
        	const users = data.users || data; // support both formats
        	setAllUsers(users);

        	// Update statuses only if missing
        	setUserStatuses((prevStatuses) => {
          	const merged = { ...prevStatuses };
          	users.forEach((user) => {
            	if (!(user in merged)) {
              	merged[user] = "offline";
            	}
          	});
          	return merged;
        	});
      	} else if (type === "file") {
        	console.log("Received file WebSocket message:", data);
        	setMessages((prev) => [
          	...prev,
          	{
            	type: "file",
            	sender,
            	fileUrl,
            	fileName,
          	},
        	]);
      	} else if (type === "room_list") {
        	setRooms(rooms);
      	} else if (type === "new_room") {
        	setRooms((prevRooms) => {
          	const newRooms = [...prevRooms, room];
          	return newRooms;
        	});
      	} else if (type === "user_status") {
        	setUserStatuses((prev) => ({
          	...prev,
          	[sender]: data.status, // "online" or "offline"
        	}));
      	} else if (type === "typing") {
        	if (sender !== username) setTypingUser(sender);
      	} else if (type === "stop_typing") {
        	if (sender !== username) setTypingUser(null);
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

  useEffect(() => {
	const handleUserActivity = () => {
  	lastActivityTimeRef.current = Date.now();
  	if (ws && ws.readyState === WebSocket.OPEN && loggedIn) {
    	ws.send(JSON.stringify({ type: "ping" }));
    	// If they were marked idle, mark them online again
    	ws.send(JSON.stringify({ type: "user_status", status: "online" }));
  	}
	};

	const handleVisibilityChange = () => {
  	if (!document.hidden) {
    	// Came back to tab
    	handleUserActivity();
  	}
	};

	const checkIdle = () => {
  	const now = Date.now();
  	const inactiveTime = now - lastActivityTimeRef.current;
  	if (inactiveTime > 3 * 60 * 1000) {
    	if (ws && ws.readyState === WebSocket.OPEN && loggedIn) {
      	ws.send(JSON.stringify({ type: "idle" }));
    	}
  	}
	};

	const activityEvents = ["mousemove", "keydown", "click"];
	activityEvents.forEach((event) =>
  	window.addEventListener(event, handleUserActivity)
	);
	document.addEventListener("visibilitychange", handleVisibilityChange);

	idleTimerRef.current = setInterval(checkIdle, 60 * 1000); // check every 1 min

	return () => {
  	activityEvents.forEach((event) =>
    	window.removeEventListener(event, handleUserActivity)
  	);
  	document.removeEventListener("visibilitychange", handleVisibilityChange);
  	clearInterval(idleTimerRef.current);
	};
  }, [ws, loggedIn]);

  const decryptMessage = async (encrypted, key) => {
	try {
  	const decoder = new TextDecoder();
  	// Ensure 'encrypted' is an object with 'iv' and 'data' properties
  	if (typeof encrypted !== "object" || !encrypted.iv || !encrypted.data) {
    	console.error("Invalid encrypted object structure:", encrypted);
    	return "[Decryption Error: Invalid structure]";
  	}
  	const iv = new Uint8Array(encrypted.iv);
  	const data = new Uint8Array(encrypted.data);

  	const decrypted = await crypto.subtle.decrypt(
    	{ name: "AES-GCM", iv },
    	key,
    	data
  	);

  	return decoder.decode(decrypted);
	} catch (error) {
  	console.error("Message decryption failed:", error);
  	return "[Decryption Error]";
	}
  };

  const processTextMessage = async (sender, content, room) => {
	console.log("Processing text message for room:", room, { sender, content });
	let decryptedText;
	if (room === "general") { // Only "general" room messages are encrypted
  	if (!roomKeysRef.current[room]) {
    	console.error(`No decryption key available for room: ${room}`);
    	decryptedText = "[Decryption Error: Missing key]";
  	} else {
    	console.log(
      	"Using decryption key for",
      	room,
      	":",
      	roomKeysRef.current[room]
    	);
    	decryptedText = await decryptMessage(
      	content,
      	roomKeysRef.current[room]
    	);
  	}
	} else {
  	console.log(`No encryption for '${room}', processing as plain text`);
  	decryptedText =
    	typeof content === "string" ? content : "[Invalid message format]";
	}
	console.log("Decrypted/Processed message text:", decryptedText);
	const formatted = parseFormattedText(decryptedText);
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
  	ws.close(); // This will trigger onclose, setting isConnected and loggedIn to false
	}
  };

  const sendMessage = async () => {
	if (!ws || !loggedIn) {
  	showPopupMessage("Not logged in or WebSocket not connected", "error");
  	return;
	}
	if (message.trim() === "/help") {
  	const helpOutput = `
    	${getTerminalPrompt()} help<br>
    	*bold* → bold<br>
    	_italic_ → italic<br>
    	[text](url) → clickable link<br>
    	/create roomName [public|private] [password] → create a chat room<br>
    	/users → list all users with status
  	`.trim();

  	setMessages((prev) => [...prev, { type: "text", content: helpOutput }]);

  	setMessage("");
  	return;
	}

	if (message.trim() === "/users") {
  	const users = allUsers || [];
  	const onlineUsers = users.filter(
    	(user) => userStatuses[user] === "online"
  	);
  	const offlineUsers = users.filter(
    	(user) => userStatuses[user] !== "online"
  	);

  	setMessages((prev) => [
    	...prev,
    	{ type: "text", content: `${getTerminalPrompt()} /users` },
    	{ type: "text", content: "===== Online =====" },
    	...onlineUsers.map((u) => ({
      	type: "element",
      	content: (
        	<div>
          	<span
            	className="status-circle"
            	style={{ backgroundColor: "limegreen" }}
          	/>
          	{u}
        	</div>
      	),
    	})),
    	{ type: "text", content: "" },
    	{ type: "text", content: "===== Offline =====" },
    	...offlineUsers.map((u) => ({
      	type: "element",
      	content: (
        	<div>
          	<span
            	className="status-circle"
            	style={{ backgroundColor: "gray" }}
          	/>
          	{u}
        	</div>
      	),
    	})),
  	]);

  	setMessage("");
  	return;
	}

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
  	const roomPassword = parts[3] || ""; // Renamed from password to avoid conflict
  	const isPublic = visibility === "public";
  	ws.send(
    	JSON.stringify({
      	type: "create_room",
      	roomName,
      	isPublic,
      	password: roomPassword,
    	})
  	);
  	// Server should handle joining the room and sending confirmation
  	// Client updates currentRoom upon receiving "Joined room:" status
	} else {
  	const actualCurrentRoom = currentRoomRef.current;
  	console.log("Sending message:", message, "in room:", actualCurrentRoom);
  	if (actualCurrentRoom === "general") { // Text message encryption for "general" room
    	if (!roomKeysRef.current[actualCurrentRoom]) {
      	showPopupMessage(
        	`No key for room '${actualCurrentRoom}' text messages, please rejoin`,
        	"error"
      	);
      	return;
    	}
    	console.log(
      	"Using encryption key for",
      	actualCurrentRoom,
      	":",
      	roomKeysRef.current[actualCurrentRoom]
    	);
    	const encrypted = await encryptMessage(
      	message,
      	roomKeysRef.current[actualCurrentRoom]
    	);
    	console.log("Encrypted message sent:", encrypted);
    	ws.send(JSON.stringify({ type: "text", content: encrypted }));
  	} else {
    	console.log(`Sending plain text for '${actualCurrentRoom}'`);
    	ws.send(JSON.stringify({ type: "text", content: message }));
  	}
	}
	setMessage("");
  };

  const handleRoomChange = (e) => {
	const roomName = e.target.value;
	if (!roomName) return;
	const roomData = rooms.find((r) => r.name === roomName);
	if (roomData.isPublic) {
  	console.log("Switching to room:", roomName);
  	ws.send(JSON.stringify({ type: "join_room", room: roomName }));
  	// setCurrentRoom will be updated by the server's "Joined room:" response
	} else {
  	setSelectedRoom(roomName);
  	setShowPasswordInput(true);
	}
  };

  const typingTimeoutRef = useRef(null);
  const hasSentTypingRef = useRef(false);

  const handleTyping = () => {
	if (!ws || ws.readyState !== WebSocket.OPEN || !loggedIn) return;
	const actualCurrentRoom = currentRoomRef.current;

	// Only send typing once per typing session
	if (!hasSentTypingRef.current) {
  	ws.send(JSON.stringify({ type: "typing", room: actualCurrentRoom }));
  	hasSentTypingRef.current = true;
	}

	// Reset the timeout to send stop_typing after 3s of inactivity
	if (typingTimeoutRef.current) {
  	clearTimeout(typingTimeoutRef.current);
	}

	typingTimeoutRef.current = setTimeout(() => {
  	ws.send(JSON.stringify({ type: "stop_typing", room: actualCurrentRoom }));
  	hasSentTypingRef.current = false;
	}, 3000);
  };

  const handleJoinPrivateRoom = () => {
	if (!passwordInput) {
  	showPopupMessage("Password required for private room", "error");
  	return;
	}
	console.log("Joining private room:", selectedRoom);
	ws.send(
  	JSON.stringify({
    	type: "join_room",
    	room: selectedRoom,
    	password: passwordInput,
  	})
	);
	// setCurrentRoom will be updated by the server's "Joined room:" response
	setShowPasswordInput(false);
	setPasswordInput("");
  };

  const uploadFile = async (file) => {
	if (!ws || ws.readyState !== WebSocket.OPEN) {
  	showPopupMessage("WebSocket not connected", "error");
  	return;
	}

	const chunkSize = 64 * 1024; // 64KB
	const uploadId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

	const fileBuffer = await file.arrayBuffer();

	const totalChunksPlain = Math.ceil(file.size / chunkSize);
	ws.send(
  	JSON.stringify({
    	type: "file_start",
    	uploadId,
    	fileName: file.name,
    	fileSize: file.size,
    	totalChunks: totalChunksPlain,
  	})
	);

	for (let i = 0; i < totalChunksPlain; i++) {
  	const start = i * chunkSize;
  	const end = Math.min(start + chunkSize, file.size);
  	const chunk = new Uint8Array(fileBuffer.slice(start, end));
  	ws.send(
    	JSON.stringify({
      	type: "file_chunk",
      	uploadId,
      	chunkIndex: i,
      	data: Array.from(chunk),
    	})
  	);
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
      console.log("Downloading file:", fileUrl, "Name:", fileName);

      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.statusText} (${response.status})`);
      }
      const fileDataBuffer = await response.arrayBuffer();

      const blob = new Blob([fileDataBuffer]);
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link); // Required for Firefox
      link.click();
      document.body.removeChild(link); // Clean up
      window.URL.revokeObjectURL(url);
      console.log("Downloaded plaintext file.");
    } catch (error) {
      console.error("File download failed:", error);
      showPopupMessage(`Failed to download file: ${error.message}`, "error");
    }
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
            	const hasPrefix = msg.content.includes(": ");
            	let senderName = null;
            	let bodyHtml = msg.content;

            	if (hasPrefix) {
              	senderName = msg.content.substring(
                	0,
                	msg.content.indexOf(": ")
              	);
              	bodyHtml = msg.content.substring(
                	msg.content.indexOf(": ") + 2
              	);
            	}

            	return (
              	<div key={i} className="message">
                	{senderName ? (
                  	<>
                    	<strong>
                      	<span
                        	className="status-circle"
                        	style={{
                          	backgroundColor:
                            	userStatuses[senderName] === "online"
                              	? "limegreen"
                              	: "gray",
                        	}}
                      	/>
                      	{senderName}:
                    	</strong>{" "}
                    	<span dangerouslySetInnerHTML={{ __html: bodyHtml }} />
                  	</>
                	) : (
                  	<span dangerouslySetInnerHTML={{ __html: msg.content }} />
                	)}
              	</div>
            	);
          	}

          	if (msg.type === "file") {
            	const isOnline = userStatuses[msg.sender] === "online";
            	return (
              	<div key={i} className="message">
                	<strong>
                  	<span
                    	className="status-circle"
                    	style={{
                      	backgroundColor: isOnline ? "limegreen" : "gray",
                    	}}
                  	/>
                  	{msg.sender}:
                	</strong>{" "}
                	<button
                  	className="file-link"
                  	onClick={() =>
                    	decryptAndDownloadFile(
                      	msg.fileUrl,
                      	msg.fileName
                    	)
                  	}
                	>
                  	{msg.fileName}
                	</button>
              	</div>
            	);
          	}
          	if (msg.type === "element") {
            	return (
              	<div key={i} className="message">
                	{msg.content}
              	</div>
            	);
          	}

          	return null;
        	})}

        	{typingUser && (
          	<div className="typing-indicator">
            	<span>{typingUser} is typing</span>
            	<span className="typing-dots">
              	<span>.</span>
              	<span>.</span>
              	<span>.</span>
            	</span>
          	</div>
        	)}
      	</div>

      	<div className="input">
        	<span className="prompt">$ </span>
        	<input
          	type="text"
          	value={message}
          	onChange={(e) => {
            	setMessage(e.target.value);
            	handleTyping();
          	}}
          	onKeyPress={(e) => e.key === "Enter" && sendMessage()}
          	placeholder="Type a message..."
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