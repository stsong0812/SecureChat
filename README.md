## SecureChat link

insecurechat.com

## Railway Deployment Guide

This guide explains how to deploy the SecureChat application (both client and server) to [Railway.app](https://railway.app/).

### Prerequisites

- A Railway account.
- Git installed on your local machine.
- The project code pushed to a GitHub repository.

### Deployment Steps

You will deploy this application as two separate services on Railway: one for the backend (server) and one for the frontend (client).

#### 1. Create a New Project on Railway

- Go to your Railway dashboard and create a new project.
- Choose "Deploy from GitHub repo" and select your repository.

#### 2. Backend Service (Node.js Server)

Railway will likely detect the `server/package.json` and suggest a Node.js service. If not, you'll need to configure it manually or adjust the root directory.

- **Service Configuration:**
  - **Root Directory:** Set to `/server` (if Railway doesn't auto-detect and tries to build from the root).
  - **Build Command:** Railway's Nixpacks builder will typically run `npm install` or `yarn install` automatically. If you need custom build steps, you can configure them. The `server/package.json` doesn't specify a build script, so `npm install` should suffice.
  - **Start Command:** `npm start` (This is defined in `server/package.json` as `node server.js`).
- **Environment Variables:**
  Navigate to your backend service settings in Railway, go to the "Variables" tab, and add the following:
  - `PORT`: Railway will set this automatically. The server (`server/server.js`) is configured to use `process.env.PORT`.
  - `DB_PATH`: Path for the SQLite database file. To ensure data persistence across deployments, you **must** use a Railway Volume.
    - Create a Volume in your Railway project (e.g., name it `chatdb-volume`).
    - Mount this volume to your backend service at a path like `/data`.
    - Set `DB_PATH` to `/data/securechat.db` (or `/data/db/securechat.db` if you prefer an extra subdirectory). The server will create the `db` subfolder if necessary.
  - `SECRET_KEY`: A strong, random secret key used for encrypting the SQLite database with SQLCipher. **This key is critical for security and data recovery. Keep it secret and store it safely.** You can generate a strong key using a password manager or a command like `openssl rand -hex 32`.
  - `PUBLIC_DOMAIN`: The public domain name assigned to your **backend service** by Railway (e.g., `your-backend-app.up.railway.app`). This is primarily used for logging purposes in the current server setup.
  - `NODE_ENV`: Set to `production`.
- **Networking:**
  - Railway will automatically expose your service on the `PORT` it provides and assign a public domain. Note this domain for the client configuration.

#### 3. Frontend Service (React Client)

- **Add a new service** to your Railway project, again deploying from your GitHub repository.
- **Service Configuration (using `client/railway.json`):**
  The `client/railway.json` file provides Nixpacks with build and deploy instructions.
  ```json
  {
    "$schema": "https://railway.app/railway.schema.json",
    "build": {
      "builder": "NIXPACKS",
      "buildCommand": "npm install && npm run build",
      "rootDirectory": "/client" // Ensure Nixpacks builds from the client directory
    },
    "deploy": {
      "startCommand": "npx serve -s build -l tcp://0.0.0.0:${PORT}", // Uses Railway's PORT
      "port": 3000, // Informational, actual port is from $PORT
      "restartPolicy": {
        "type": "always"
      }
    }
  }
  ```
  - If Railway does not automatically pick up `client/railway.json` or you need to configure manually:
    - **Root Directory:** Set to `/client`.
    - **Build Command:** `npm install && npm run build`
    - **Start Command:** `npx serve -s build -l tcp://0.0.0.0:${PORT}` (This ensures `serve` listens on the port provided by Railway).
- **Environment Variables:**
  Navigate to your frontend service settings in Railway, go to the "Variables" tab, and add:
  - `REACT_APP_WS_URL`: The WebSocket URL for your **backend service**. This will be `wss://<your-backend-railway-domain>`. For example, if your backend is at `my-chat-backend.up.railway.app`, then set this to `wss://my-chat-backend.up.railway.app`.
- **Client `package.json` `homepage`:**
  The `client/package.json` has a `homepage` field:
  ```json
  "homepage": "https://securechat-production-0040.up.railway.app",
  ```
  Ensure this URL matches the public domain Railway assigns to **your frontend service**. You might need to update this value in your code and redeploy, or if Railway provides a build-time environment variable for the public URL, you could use that (e.g., by setting `PUBLIC_URL` if `create-react-app` respects it for the homepage). For simplicity, manually updating it to your frontend's Railway domain is the most straightforward approach.
- **Networking:**
  - Railway will automatically expose your service and assign a public domain. This domain is what users will visit.

#### 4. Database Initialization

- The server (`server/server.js`) is designed to create the necessary database tables if the database file specified by `DB_PATH` does not exist on its first run.
- Ensure your `DB_PATH` points to a path within a **mounted Railway Volume** for persistence.
- The `init-db` script (`npm run init-db` in the `server` directory) can be used locally for setup or potentially as a one-off command in Railway if needed, but the server's auto-creation should handle it.

#### 5. Final Checks

- After deploying both services, check the deployment logs in Railway for any errors.
- Access the public URL of your frontend service.
- Test registration, login, sending messages, creating rooms, and file uploads.

### How the Database Works on Railway

- The application uses `better-sqlite3` with SQLCipher for an encrypted SQLite database.
- The `SECRET_KEY` environment variable on the server is used to encrypt and decrypt the database. **Losing this key means losing access to your data.**
- Railway's default filesystem is ephemeral. To persist your SQLite database (`securechat.db`):
  1.  In Railway, go to your project -> Add New -> Volume.
  2.  Configure the volume (e.g., size).
  3.  In your **backend service** settings -> Volumes, mount the created volume. For example, mount it at `/data`.
  4.  Set the `DB_PATH` environment variable for your backend service to `/data/securechat.db` (or `/data/db/securechat.db` if you prefer).

### Client-Server Communication

- The React client connects to the Node.js backend via WebSockets.
- The `REACT_APP_WS_URL` environment variable in the client's Railway service configuration tells the client where the backend WebSocket server is located.
- The backend server serves the static client files. When a user navigates to the frontend's URL, they get the React app, which then establishes a WebSocket connection to the backend URL specified by `REACT_APP_WS_URL`.

## Local Development

### Server

1.  Navigate to the `server` directory: `cd server`
2.  Create a `.env` file in the `server` directory with the following content (replace with your own values):
    ```env
    PORT=7777
    DB_PATH=./db/securechat.db
    SECRET_KEY=your_very_strong_and_secret_key_here
    # For local dev, PUBLIC_DOMAIN is not strictly necessary but can be set
    PUBLIC_DOMAIN=localhost:3000
    ```
3.  Initialize the database (first time or if you want to reset): `npm run init-db`
4.  Install dependencies: `npm install`
5.  Start the server: `npm run dev` (runs init-db then start) or `npm start` (just starts). For detailed logs during development, you might prefer `npm run local-start`.

### Client

1.  Navigate to the `client` directory: `cd client`
2.  Create a `.env` file in the `client` directory (optional, defaults to `wss://localhost:7777`):
    ```env
    REACT_APP_WS_URL=wss://localhost:7777
    ```
3.  Install dependencies: `npm install`
4.  Start the client development server: `npm start`
    This will usually open the app in your browser at `http://localhost:3000`.

## Notes

- **SSL/TLS for WebSockets (`wss://`):** Railway typically handles SSL termination for your services. Ensure your `REACT_APP_WS_URL` uses `wss://` with the Railway-provided domain for the backend.
- **File Uploads:** Uploaded files are stored on the server's filesystem. In a Railway production environment, these will be stored in the path configured by `uploadsDir` in `server.js`. If this path is not part of a persistent volume, uploads will be lost on redeployments or restarts. For persistent file uploads, you would typically use a dedicated file storage service (like S3, Cloudinary, or Railway's upcoming object storage if available) rather than the service's local filesystem. The current setup stores them in `/tmp/Uploads` in production, which is ephemeral.
- **Logging:** Room messages are logged into `.log` files within the `server/logs` directory. This directory will also be ephemeral on Railway unless mapped to a volume. For production logging, consider integrating a dedicated logging service.
