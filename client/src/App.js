import React, { useState, useEffect } from 'react';
import './App.css';

function App() {
  const [ws, setWs] = useState(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState([]);
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    const websocket = new WebSocket('ws://localhost:7777');
    websocket.onopen = () => console.log('Connected to server');
    websocket.onmessage = (e) => {
      const msg = e.data;
      if (msg === 'Registered successfully') {
        console.log(msg);
      } else if (msg === 'Logged in successfully') {
        setLoggedIn(true);
        setMessages([]);
      } else if (msg.startsWith('Error:') || msg === 'Invalid credentials') {
        alert(msg);
      } else {
        setMessages((prev) => [...prev, msg]);
      }
    };
    setWs(websocket);
    return () => websocket.close();
  }, []);

  const register = () => {
    if (ws) ws.send(`register:${username}:${password}`);
  };

  const login = () => {
    if (ws) ws.send(`login:${username}:${password}`);
  };

  const sendMessage = () => {
    if (ws && loggedIn) {
      ws.send(message);
      setMessage('');
    }
  };

  return (
    <div className="terminal">
      <div className="header">securechat@localhost:~$</div>
      {!loggedIn ? (
        <div className="login">
          <div className="prompt">username: <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          /></div>
          <div className="prompt">password: <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          /></div>
          <div className="commands">
            <span className="command" onClick={register}>register</span>
            <span className="command" onClick={login}>login</span>
          </div>
        </div>
      ) : (
        <div className="chat">
          <div className="messages">
            {messages.map((msg, i) => (
              <div key={i} className="message">{`> ${msg}`}</div>
            ))}
          </div>
          <div className="input">
            <span className="prompt">$ </span>
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default App;