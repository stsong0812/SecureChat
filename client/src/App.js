import React, { useState, useEffect } from 'react';
import './App.css';

function App() {
  const [ws, setWs] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState([]);
  const [loggedIn, setLoggedIn] = useState(false);
  const [popupMessage, setPopupMessage] = useState('');
  const [showPopup, setShowPopup] = useState(false);
  const [popupType, setPopupType] = useState('success');

  useEffect(() => {
    const websocket = new WebSocket('ws://localhost:7777');
    websocket.onopen = () => {
      console.log('WebSocket connection established');
      setIsConnected(true);
    };
    websocket.onerror = (error) => {
      console.error('WebSocket error:', error);
      setIsConnected(false);
    };
    websocket.onclose = () => {
      console.log('WebSocket connection closed');
      setIsConnected(false);
    };
    websocket.onmessage = (e) => {
      const msg = e.data;
      console.log('Received message from server:', msg);
      handleServerMessage(msg);
    };

    setWs(websocket);
    return () => websocket.close();
  }, []);
// TODO - implement client side validation credentials
  const handleServerMessage = (msg) => {
    if (msg === 'Registered successfully') {
      showPopupMessage('Registration successful! Please log in.', 'success');
      setUsername('');
      setPassword('');
    } else if (msg === 'Logged in successfully') {
      setLoggedIn(true);
      setMessages([]);
      showPopupMessage('Login successful!', 'success');
    } else if (
      msg.startsWith('Error:') ||
      msg === 'Invalid credentials' ||
      msg === 'Too many attempts, please try again later' ||
      msg === 'Please log in first' ||
      msg === 'Message rate limit exceeded, please wait'
    ) {
      showPopupMessage(msg, 'error');
    } else {
      setMessages((prev) => [...prev, msg]);
    }
  };

  const showPopupMessage = (message, type = 'success') => {
    setPopupMessage(message);
    setShowPopup(true);
    setPopupType(type);
    setTimeout(() => setShowPopup(false), 3000);
  };

  const register = () => {
    if (ws && isConnected) {
      ws.send(`register:${username}:${password}`);
    } else {
      showPopupMessage('WebSocket connection not established');
    }
  };

  const login = () => {
    if (ws && isConnected) {
      ws.send(`login:${username}:${password}`);
    } else {
      showPopupMessage('WebSocket connection not established');
    }
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
      
      {showPopup && <div className={`popup ${popupType}`}>{popupMessage}</div>}

      {!loggedIn ? (
        <div className="login">
          <div className="prompt">
            username:{' '}
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="prompt">
            password:{' '}
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
            {messages.map((msg, i) => (
              <div key={i} className="message">
                {msg}
              </div>
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