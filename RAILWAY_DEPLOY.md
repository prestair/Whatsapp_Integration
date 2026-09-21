# Railway Deployment Guide

This app is a **long-running WhatsApp bot** (Baileys + Socket.IO). It needs a
persistent process and a persistent disk. Railway supports both. Follow these
steps exactly — the **Volume step is not optional**, without it you will have to
re-scan the WhatsApp QR after every restart/redeploy.

## 1. Push code to GitHub
Already done — repo: https://github.com/prestair/Whatsapp_Integration

## 2. Create the project on Railway
1. Go to https://railway.app and sign in with GitHub.
2. **New Project → Deploy from GitHub repo → select `Whatsapp_Integration`**.
3. Railway auto-detects Node (Nixpacks) and runs `node server.js` (from `railway.json`).

## 3. Add a Persistent Volume (CRITICAL)
The WhatsApp session, message history and uploads must survive restarts.
1. Open your service → **Variables / Settings → Volumes → New Volume**.
2. Set **Mount path** to: `/data`
3. Save. Railway will mount a persistent disk at `/data`.

## 4. Set Environment Variables
In the service **Variables** tab add:

| Variable   | Value   | Why |
|------------|---------|-----|
| `DATA_DIR` | `/data` | Tells the app to store `profiles/`, `uploads/`, `message_history.json`, `sheet_config.json` on the persistent volume instead of the ephemeral container disk. |

> `PORT` is provided automatically by Railway — do **not** set it yourself.

## 5. Deploy & open
1. Railway builds and starts the service.
2. Under **Settings → Networking → Generate Domain** to get a public URL.
3. Open the URL → the dashboard loads → scan the WhatsApp **QR code** once.
4. Because of the `/data` volume, the login is remembered across future deploys.

## 6. Re-upload your image (one time)
The old `sheet_config.json` referenced a Windows path (`uploads\image_...jpeg`).
After deploying, re-upload the image from the dashboard and re-save the sheet
config so the path points inside `/data/uploads`.

## Notes
- Free/trial Railway plans may sleep or limit usage; a WhatsApp bot needs to stay
  awake to keep the connection alive. Use a plan that keeps the service running.
- Logs: view them in the Railway **Deployments → Logs** tab. Look for
  `Server running on ...` and `WhatsApp connected!`.
