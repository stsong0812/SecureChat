# SecureChat

CPSC-455 Web Application Security: Web-based realtime chatting application implemented using Websockets.

# SecureChat Setup Guide

## Prerequisites

Make sure the following tools are installed on your system:

| Tool    | Purpose                             | Download Link                                   |
| ------- | ----------------------------------- | ----------------------------------------------- |
| Node.js | Runs JavaScript outside the browser | https://nodejs.org                              |
| VS Code | Code editor                         | https://code.visualstudio.com                   |
| Git     | To download project from GitHub     | https://git-scm.com                             |
| OpenSSL | Generate SSL certificates           | https://slproweb.com/products/Win32OpenSSL.html |

---

## Step 1: Open the Project in VS Code

1. Clone the project (or download it manually):

   ```bash
   git clone https://github.com/stsong0812/SecureChat.git
   ```

2. Open VS Code.

3. Click `File > Open Folder...`.

4. Select the `securechat` project folder.

---

## Step 2: Install Project Dependencies

These are the packages needed to run SecureChat.

1. Open the terminal in VS Code.  
   Press `Ctrl + `` (backtick key under Esc).

2. Navigate into the `server` folder and install dependencies:

   ```bash
   cd server
   npm install
   ```

3. Navigate to the `client` folder and install dependencies:
   ```bash
   cd ../client
   npm install
   ```

---

## Step 3: Create the `.env` File

1. Navigate into the `server` folder and initialize the SQLite database

   ```bash
   cd ../server
   npm run init-db
   ```

2. In the `server` folder, create a file called `.env` and paste the following:

   ```env
   PORT=7777
   DB_PATH=./securechat.db
   SECRET_KEY=your_own_special_key
   JWT_SECRET=your_own_jwtSECRET
   ```

**Important:** Replace `your_own_special_key` and `your_own_jwtSECRET` with your own randomly generated string. Keep these keys private and never share them or upload it to GitHub.

---

## Step 4: Set Up HTTPS Certificates

1. Open Git Bash (or another terminal that supports OpenSSL).

2. Navigate into the `server` folder:

   ```bash
   cd server
   ```

3. Run the following command to generate your SSL certificate and key:
   ```bash
   openssl req -x509 -newkey rsa:4096 -nodes -keyout key.pem -out cert.pem -days 365
   ```

This generates a self-signed certificate that will be used for secure WebSocket communication.

---

## Step 5: Build and Run SecureChat

1. Build the client (production build):

   ```bash
   cd ../client
   npm run build
   ```

2. Copy the link output in the terminal (usually something like `file://.../index.html`) and open it in your browser.

3. Start the server:
   ```bash
   cd ../server
   npm start
   ```

---

## Finished

You should now be able to access SecureChat at:

```
https://localhost:7777
```

Now just register yourself and login!
