# Deploying LG Lead Qualification Upload on Render

## Prerequisites
- A [Render](https://render.com) account (free tier works)
- The `LG-Render-Deploy` folder pushed to a **public** Git repository (GitHub,
  GitLab, or Bitbucket) — Render's Web Service setup does not support a raw
  zip/file upload; it only offers **Git Provider** (OAuth-connected account),
  **Public Git Repository** (just a URL, no account linking needed), or
  **Existing Image** (a prebuilt Docker image from a registry)
- The LG Leads API already deployed (`Demos/LG/cdk` → `cdk deploy`) so you have
  an `API_BASE_URL` and `BEARER_TOKEN` to use below

---

## Step 1 — Create a new Web Service

1. Log in to [dashboard.render.com](https://dashboard.render.com)
2. Click **New +** → **Web Service**
3. On the **Configure** step, pick a source:
   - **Git Provider** — if you have a GitHub/GitLab/Bitbucket account linked
     to Render with access to the repo
   - **Public Git Repository** — paste the HTTPS clone URL of any public repo
     containing `LG-Render-Deploy`'s contents at its root; no account linking
     or org permissions required (use this if your org's GitHub/Bitbucket
     access is restricted)
   - **Existing Image** — deploy a prebuilt Docker image from a registry
     (requires building/pushing an image yourself; not covered here)

---

## Step 2 — Push the code somewhere Render can read it

1. Push the contents of `LG-Render-Deploy/` to a Git repository (a small,
   dedicated **public** repo works well if org access is restricted)
2. In Render → select **Public Git Repository** and paste that repo's HTTPS
   clone URL — OR select **Git Provider** and pick the repo if it's connected
3. Render will auto-detect `render.yaml` — click **Apply**

---

## Step 3 — Configure the service

If not using `render.yaml`, set these manually:

| Setting | Value |
|---|---|
| **Name** | `lg-render-deploy` (or any name) |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| **Health Check Path** | `/health` |
| **Plan** | Free |

---

## Step 4 — Set Environment Variables

Go to your service → **Environment** tab → **Add Environment Variable**.

**Do not commit real values for these anywhere — set them only in Render's
Environment tab (or a local, git-ignored `.env` for testing).**

| Key | Where to get the value |
|---|---|
| `LOGIN_USER` | `Demos/LG/cdk/.env` → `LOGIN_USER` |
| `LOGIN_PASSWORD` | `Demos/LG/cdk/.env` → `LOGIN_PASSWORD` |
| `LG_API_URL` | `Demos/LG/cdk/.env` → `API_BASE_URL` (already ends in `/lg`) |
| `LG_BEARER_TOKEN` | `Demos/LG/cdk/.env` → `BEARER_TOKEN` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | Your SMTP provider (Gmail app password, SendGrid, SES SMTP, etc.) — leave unset to skip sending chat-bot invite emails |
| `SMTP_USER` / `SMTP_PASS` | SMTP credentials for the above |
| `EMAIL_FROM` / `EMAIL_FROM_NAME` | The "from" address/name leads see on the invite email |
| `PUBLIC_BASE_URL` | Your Render service URL, e.g. `https://lg-render-deploy.onrender.com` (used to build the `/chat` link in emails — auto-detected from the request if left blank) |
| `CHAT_WIDGET_SRC` / `CHAT_WIDGET_ORG_ID` / `CHAT_WIDGET_ID` / `CHAT_WIDGET_FLOW_ID` | Only needed if the V2 chat widget embed changes — defaults already match the current widget |
| `NODE_ENV` | `production` |

> ⚠️ Do NOT add `PORT` — Render sets it automatically.
> ⚠️ Never use a personal/SSO login for `LOGIN_USER`/`LOGIN_PASSWORD` — this is
> just the portal's own gate, so pick a dedicated username/password for it.

---

## Step 5 — Deploy

1. Click **Create Web Service**
2. Render will run `npm install` then `node server.js`
3. Watch the deploy log — look for:
   ```
   LG Leads Upload Server running at http://localhost:XXXXX
   ```
4. Once the status shows **Live**, your service URL will be:
   ```
   https://lg-render-deploy.onrender.com
   ```
   (or similar, based on the name you chose)

---

## Step 6 — Test the deployment

Open the service URL in your browser — sign in, then you should see the
**LG Lead Qualification** upload page.

Try uploading a sample `.xlsx` leads file and confirm:
- ✅ Each row gets a computed `Score` (0–1)
- ✅ The response shows the record count and average Score
- ✅ `GET <API_BASE_URL>/report` (or the LG Leads API) reflects the new leads
- ✅ Leads with `Score = 0` and a valid email receive a "chat with us" invite
  (check the **Email** step in the pipeline / the `emailSummary` in the response)
- ✅ `https://<your-service>.onrender.com/chat?contactId=<id>` loads the chat
  widget without needing to sign in
- ✅ The **Chat Bot** tab in the portal shows the same page in an iframe

---

## Re-deploying after changes

1. Update `server.js` or `frontend/index.html` locally
2. Push to GitHub (if connected) — Render auto-deploys
   — OR — re-zip the folder and use Render → **Manual Deploy**

---

## Local run (outside Render)

From the `LG-Render-Deploy/` folder:
```powershell
Copy-Item .env.example .env   # then fill in real values in .env (git-ignored)
npm install
npm start
```
This runs `node server.js` using the local `.env` and serves the UI at
`http://localhost:3000`.

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `Unauthorised` in the browser | Not logged in / session expired | Sign in again at `/auth/login` |
| `LG_API_URL env var is not set` | Missing env var | Add it in Render → Environment tab |
| `LG_BEARER_TOKEN env var is not set` | Missing env var | Add it in Render → Environment tab |
| Upload succeeds but LG API rejects it | Bearer token doesn't match the Lambda's `EXPECTED_BEARER_TOKEN` | Check `Demos/LG/cdk/.env` → `BEARER_TOKEN` matches what's set on Render |
| `Only .xlsx / .xls files are allowed` | Wrong file type selected | Upload a `.xlsx` or `.xls` file |
| App not loading | Build failed | Check Render deploy logs for npm errors |
| `Cannot GET /` | Frontend not found | Confirm `frontend/index.html` is in the deployed folder |
