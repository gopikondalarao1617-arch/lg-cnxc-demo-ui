const express       = require("express");
const multer        = require("multer");
const path          = require("path");
const fs            = require("fs");
const dns           = require("dns");
const crypto        = require("crypto");
const XLSX          = require("xlsx");
const axios         = require("axios");
const nodemailer    = require("nodemailer");
const SftpClient    = require("ssh2-sftp-client");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// Render's containers have no outbound IPv6 route. Hosts with both A and
// AAAA records (e.g. smtp.gmail.com) can otherwise resolve to an IPv6
// address first, failing instantly with ENETUNREACH instead of connecting
// over IPv4. This forces IPv4 first for every DNS lookup in the process.
dns.setDefaultResultOrder("ipv4first");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Chat widget config (used by /chat; defaults match the V2 bot embed) ──────
const CHAT_WIDGET_SRC     = process.env.CHAT_WIDGET_SRC     || "https://flow-designer.demo.vnext.ixhello.com/chat-widget/assets/chat-widget.js";
const CHAT_WIDGET_ORG_ID  = process.env.CHAT_WIDGET_ORG_ID  || "0343c5c3-fd2c-493c-a664-444a95c0f78a";
const CHAT_WIDGET_ID      = process.env.CHAT_WIDGET_ID      || "6d69ddd6-9f36-4f5d-9927-6777d239f2bb";
const CHAT_WIDGET_FLOW_ID = process.env.CHAT_WIDGET_FLOW_ID || "bf0a4773-1eec-4547-a954-3bcefa48c777";

// ── Auth config ───────────────────────────────────────────────────────────────
const LOGIN_USER     = process.env.LOGIN_USER     || "ixHello";
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || "lgleads";
const sessions = new Map(); // token → { user, createdAt }

// In-memory snapshot of the most recent SFTP push, so the "SFTP" tab in the
// portal has something to show (this is a single-instance demo app - no DB).
let lastSftpStatus = null;

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(c => {
    const [k, ...v] = c.trim().split("=");
    if (k) out[k.trim()] = v.join("=");
  });
  return out;
}

function isAuthenticated(req) {
  const token = parseCookies(req)["lg_session"];
  return token && sessions.has(token);
}

// ── Auth middleware (protects all routes except /auth/*, /health, /chat) ──────
app.use((req, res, next) => {
  const open = ["/auth/login", "/auth/logout", "/auth/status", "/health", "/chat", "/chat-widget", "/submit-form"];
  if (open.includes(req.path) || req.path.startsWith("/auth/")) return next();
  if (isAuthenticated(req)) return next();
  if (req.headers.accept?.includes("text/html")) {
    return res.redirect("/auth/login");
  }
  return res.status(401).json({ error: "Unauthorised" });
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── GET /auth/login — login page ──────────────────────────────────────────────
app.get("/auth/login", (req, res) => {
  if (isAuthenticated(req)) return res.redirect("/");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Sign in — LG Lead Qualification</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      background:linear-gradient(150deg,#0a1628 0%,#0d2137 50%,#0a1f30 100%);
      min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#fff;border-radius:20px;padding:40px 44px;width:100%;max-width:400px;
      box-shadow:0 32px 80px rgba(0,0,0,0.4)}
    .brand{display:flex;align-items:center;gap:12px;margin-bottom:28px}
    .brand-icon{width:42px;height:42px;background:linear-gradient(135deg,#c8102e,#e63950);
      border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px}
    .brand-name{font-size:16px;font-weight:800;color:#0f172a}
    .brand-sub{font-size:12px;color:#94a3b8;font-weight:500}
    h2{font-size:22px;font-weight:800;color:#0f172a;margin-bottom:6px}
    .sub{font-size:13px;color:#64748b;margin-bottom:28px}
    label{display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:6px}
    input{width:100%;padding:11px 14px;font-size:14px;border:1.5px solid #e2e8f0;
      border-radius:10px;outline:none;transition:border-color 0.2s;margin-bottom:16px}
    input:focus{border-color:#c8102e}
    .error{background:#fef2f2;border:1px solid #f87171;border-radius:8px;
      padding:10px 14px;font-size:13px;color:#991b1b;margin-bottom:16px;display:none}
    .error.visible{display:block}
    button{width:100%;padding:13px;background:linear-gradient(135deg,#c8102e,#e63950);
      color:#fff;font-size:15px;font-weight:700;border:none;border-radius:12px;
      cursor:pointer;transition:all 0.2s;box-shadow:0 4px 14px rgba(200,16,46,0.4)}
    button:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(200,16,46,0.5)}
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <div class="brand-icon">🎯</div>
      <div><div class="brand-name">LG Lead Qualification</div><div class="brand-sub">Upload portal</div></div>
    </div>
    <h2>Sign in</h2>
    <p class="sub">Enter your credentials to access the upload portal.</p>
    <div class="error" id="err">Invalid username or password.</div>
    <form method="POST" action="/auth/login">
      <label>Username</label>
      <input type="text" name="username" autocomplete="username" required autofocus />
      <label>Password</label>
      <input type="password" name="password" autocomplete="current-password" required />
      <button type="submit">Sign in →</button>
    </form>
  </div>
  <script>
    const p = new URLSearchParams(location.search);
    if (p.get('error')) document.getElementById('err').classList.add('visible');
  </script>
</body>
</html>`);
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
app.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === LOGIN_USER && password === LOGIN_PASSWORD) {
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { user: username, createdAt: Date.now() });
    res.setHeader("Set-Cookie", `lg_session=${token}; HttpOnly; Path=/; SameSite=Lax`);
    return res.redirect("/");
  }
  res.redirect("/auth/login?error=1");
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
app.post("/auth/logout", (req, res) => {
  const token = parseCookies(req)["lg_session"];
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", "lg_session=; HttpOnly; Path=/; Max-Age=0");
  res.redirect("/auth/login");
});

// ── GET /auth/status ──────────────────────────────────────────────────────────
app.get("/auth/status", (req, res) => {
  const token = parseCookies(req)["lg_session"];
  const session = token && sessions.get(token);
  res.json({ authenticated: !!session, user: session?.user || null });
});

// ── Multer: store upload in memory, .xlsx/.xls only ──────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== ".xlsx" && ext !== ".xls") {
      return cb(new Error("Only .xlsx / .xls files are allowed."));
    }
    cb(null, true);
  },
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
});

// ── Score formula helpers ─────────────────────────────────────────────────────
//
// Mirrors the spreadsheet formula (row 2 shown, applies per row):
//   =IF(AND(OR(TRIM(C2)="",TRIM(C2)="-"),OR(TRIM(D2)="",TRIM(D2)="-")),0,
//      (IF(OR(TRIM(C2)="",TRIM(C2)="-"),0,1)
//      +IF(OR(TRIM(D2)="",TRIM(D2)="-"),0,1)
//      +IF(OR(TRIM(E2)="",TRIM(E2)="-"),0,1)
//      +IF(OR(TRIM(G2)="",TRIM(G2)="-",TRIM(G2)="--",UPPER(TRIM(G2))="N/A"),0,1)
//      )/4)
//
// i.e. if columns C AND D are both blank/"-", Score is 0. Otherwise Score is
// the fraction (0, 0.25, 0.5, 0.75, 1) of columns C, D, E, G that are filled
// in (column G also treats "--" and "N/A" as blank).
function isBlank(value) {
  const t = String(value ?? "").trim();
  return t === "" || t === "-";
}

function isBlankExternalUrl(value) {
  const t = String(value ?? "").trim();
  if (t === "" || t === "-" || t === "--") return true;
  return t.toUpperCase() === "N/A";
}

// `values` is the raw, positional array of cells for one spreadsheet row
// (0-indexed), so values[2] = column C, values[3] = D, values[4] = E,
// values[6] = G — matching the cell references in the formula above.
function computeScore(values) {
  const c = values[2];
  const d = values[3];
  const e = values[4];
  const g = values[6];

  if (isBlank(c) && isBlank(d)) return 0;

  let filled = 0;
  if (!isBlank(c)) filled += 1;
  if (!isBlank(d)) filled += 1;
  if (!isBlank(e)) filled += 1;
  if (!isBlankExternalUrl(g)) filled += 1;

  return filled / 4;
}

// ── SFTP push (scored file → IC Dial) ─────────────────────────────────────────
//
// After leads are scored and stored to S3, the same rows (Score column
// included — mandatory for the IC Dial campaign-calling logic) are rebuilt
// into a fresh .xlsx workbook and pushed via SFTP so the dial campaign can
// pick it up. All connection details come from env vars (filled in Render's
// Environment tab); if SFTP_HOST isn't set this is skipped without failing
// the upload (mirrors how email sending is optional/best-effort).
function isSftpConfigured() {
  return !!(process.env.SFTP_HOST && process.env.SFTP_USERNAME);
}

// Builds a fresh .xlsx workbook from the scored lead records. Uses
// json_to_sheet so column order follows each object's own key order — Score
// was appended last when the records were built in parseXlsx(), so it stays
// the last column here too, matching the IC Dial requirement.
function leadsToXlsxBuffer(leads) {
  const sheet = XLSX.utils.json_to_sheet(leads);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Leads");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

// Timestamps the outgoing filename so repeated campaign drops never collide
// on the SFTP server, while keeping the original name recognisable.
function buildSftpFileName(originalFilename) {
  const ext = path.extname(originalFilename) || ".xlsx";
  const base = path.basename(originalFilename, ext).replace(/[^A-Za-z0-9._-]/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${base}_Scored_${stamp}${ext}`;
}

// Pushes the scored workbook to the configured SFTP server. Never throws —
// returns a summary object instead, so a bad/unreachable SFTP target doesn't
// take down the rest of the /upload pipeline (S3 + email still complete).
async function pushScoredFileToSftp(buffer, filename) {
  if (!isSftpConfigured()) {
    return {
      success: false,
      skippedReason: "SFTP not configured (set SFTP_HOST / SFTP_USERNAME / SFTP_PASSWORD or SFTP_PRIVATE_KEY).",
    };
  }

  const remoteDir = (process.env.SFTP_REMOTE_DIR || "/").replace(/\/+$/, "") || "";
  const remotePath = `${remoteDir}/${filename}`;

  const connectOptions = {
    host: process.env.SFTP_HOST,
    port: Number(process.env.SFTP_PORT || 22),
    username: process.env.SFTP_USERNAME,
    readyTimeout: 15000,
    // The IC Dial SFTP server (CompleteFTP) times out mid-handshake when
    // ssh2 negotiates "diffie-hellman-group-exchange-sha256" (requires an
    // extra GEX group-request round trip the server never replies to,
    // surfacing as "getConnection: Timed out while waiting for handshake" or
    // an ECONNRESET). Forcing group14-sha256 instead — which the server also
    // advertises — skips that exchange entirely. Verified working against
    // 185.209.152.129 (see test-sftp.js).
    algorithms: { kex: ["diffie-hellman-group14-sha256"] },
  };
  if (process.env.SFTP_PRIVATE_KEY) {
    connectOptions.privateKey = process.env.SFTP_PRIVATE_KEY;
    if (process.env.SFTP_PASSPHRASE) connectOptions.passphrase = process.env.SFTP_PASSPHRASE;
  } else {
    connectOptions.password = process.env.SFTP_PASSWORD;
  }

  const client = new SftpClient();
  try {
    await client.connect(connectOptions);
    await client.put(buffer, remotePath);
    return { success: true, host: process.env.SFTP_HOST, remotePath };
  } catch (err) {
    console.error("  ✗ SFTP push failed:", err.message);
    return { success: false, host: process.env.SFTP_HOST, remotePath, error: err.message };
  } finally {
    try { await client.end(); } catch { /* already disconnected */ }
  }
}

// ── Email helpers ─────────────────────────────────────────────────────────────
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isValidEmail(value) {
  const v = String(value ?? "").trim();
  if (!v || v === "-") return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

// Builds the personalised chat-bot link the lead is asked to click. Falls
// back to the request's own host if PUBLIC_BASE_URL isn't set (e.g. local dev).
function buildChatLink(req, contactId) {
  const base = (process.env.PUBLIC_BASE_URL || (req.protocol + "://" + req.get("host"))).replace(/\/$/, "");
  return base + "/chat?contactId=" + encodeURIComponent(contactId);
}

function buildSubmitFormLink(req, contactId) {
  const base = (process.env.PUBLIC_BASE_URL || (req.protocol + "://" + req.get("host"))).replace(/\/$/, "");
  return base + "/submit-form?contactId=" + encodeURIComponent(contactId);
}

function buildWelcomeEmailHtml(name, contactId, chatLink, submitFormLink) {
  const safeName = escapeHtml(name || "there");
  const safeContactId = escapeHtml(contactId);
  const safeLink = escapeHtml(chatLink);
  const safeSubmitFormLink = escapeHtml(submitFormLink);
  return [
    '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">',
    '<div style="max-width:520px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.08);">',
    '<div style="background:linear-gradient(135deg,#c8102e,#e63950);padding:24px 28px;"><div style="font-size:18px;font-weight:800;color:#fff;">LG</div></div>',
    '<div style="padding:28px;">',
    '<p style="font-size:16px;color:#0f172a;margin:0 0 16px;">Hi ' + safeName + ',</p>',
    '<p style="font-size:14px;color:#334155;line-height:1.6;margin:0 0 16px;">We received your email contact from our leads file. You can chat with our bot now, or submit your phone number to request a call from our virtual agent.</p>',
    // Table-based "bulletproof" button: Outlook desktop (Word rendering engine)
    // strips unsupported CSS (linear-gradient, display:inline-block + padding
    // on <a>) which silently collapses the old anchor-only button to nothing
    // visible, even though the underlying <a href> link tracking still shows
    // up on hover. A solid bgcolor on a <table>/<td> renders reliably there.
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:24px auto;"><tr><td bgcolor="#c8102e" style="border-radius:10px;">',
    '<a href="' + safeLink + '" style="background-color:#c8102e;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 28px;border-radius:10px;display:inline-block;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">Chat with us Now</a>',
    '</td></tr></table>',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 24px;"><tr><td bgcolor="#0f172a" style="border-radius:10px;">',
    '<a href="' + safeSubmitFormLink + '" style="background-color:#0f172a;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 28px;border-radius:10px;display:inline-block;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">Submit Form</a>',
    '</td></tr></table>',
    // Plain-text fallback link so the URL is always visible/clickable even if
    // an email client strips all styling from the button above.
    '<p style="text-align:center;font-size:12px;margin:0 0 16px;"><a href="' + safeLink + '" style="color:#c8102e;word-break:break-all;">' + safeLink + '</a></p>',
    '<div style="background:#fff5f5;border:1px dashed #fecaca;border-radius:10px;padding:14px 18px;margin:0 0 16px;">',
    '<div style="font-size:11px;font-weight:700;color:#c8102e;text-transform:uppercase;letter-spacing:0.06em;">Your Contact ID</div>',
    '<div style="font-size:20px;font-weight:800;color:#0f172a;margin-top:4px;">' + safeContactId + '</div>',
    '</div>',
    '<p style="font-size:13px;color:#64748b;line-height:1.6;margin:0;">When the assistant asks for your Contact ID, please type or enter <strong>' + safeContactId + '</strong> so we can pull up your details.</p>',
    '</div>',
    '<div style="padding:16px 28px;background:#f8fafc;font-size:11px;color:#94a3b8;text-align:center;">IXHello &middot; LG Product Assistant</div>',
    '</div></body></html>',
  ].join("");
}

// ── Mail transporter (SMTP) — returns null if not configured ─────────────────
// When SMTP_HOST is SendGrid, we skip raw SMTP entirely and use SendGrid's
// HTTPS API instead (port 443) — some PaaS hosts (Render included) block or
// silently drop outbound port 587/465, which surfaces as a "Connection timeout"
// even though the credentials are valid (verified working over plain SMTP from
// a normal network). The HTTPS API avoids that class of problem altogether.
const IS_SENDGRID = /sendgrid/i.test(process.env.SMTP_HOST || "");

// Lazily-created, cached transporter - resolved on first use (async, see why
// below).
let mailTransporterPromise = null;

// Render's containers have no outbound IPv6 route. Hosts with both A and AAAA
// records (e.g. smtp.gmail.com) can still end up attempted over IPv6 even with
// dns.setDefaultResultOrder('ipv4first') and an explicit family:4 passed to
// nodemailer - Node's newer dual-stack "Happy Eyeballs" connection logic in
// net/tls can still race/attempt the IPv6 address regardless (confirmed via
// live testing: still got ENETUNREACH on an IPv6 address on both port 587 and
// 465 even with those in place). The only fully reliable fix is to resolve
// the hostname to a literal IPv4 address ourselves and hand nodemailer that IP
// directly - there's no hostname left for Node to re-resolve/race over IPv6.
// tls.servername is set separately so SNI + certificate hostname validation
// still works correctly against an IP-literal connection target.
async function createMailTransporter() {
  if (IS_SENDGRID) return null; // handled via HTTPS API instead, see sendOneEmail()

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;

  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === "true" || port === 465;

  const { address: ipv4Address } = await dns.promises.lookup(host, { family: 4 });
  console.log(`  → SMTP: resolved ${host} to IPv4 ${ipv4Address} (forcing IPv4-only connection)`);

  return nodemailer.createTransport({
    host: ipv4Address,
    port,
    secure,
    auth: { user, pass },
    tls: { servername: host }, // SNI + cert hostname validation against the real name, not the IP
    // Fail fast instead of hanging the /upload request for minutes if the
    // SMTP host is slow/unreachable/blocked (e.g. an outbound port issue).
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
  });
}

function getMailTransporter() {
  if (!mailTransporterPromise) mailTransporterPromise = createMailTransporter();
  return mailTransporterPromise;
}

function isMailConfigured() {
  if (IS_SENDGRID) return !!process.env.SMTP_PASS; // SendGrid API key doubles as SMTP_PASS
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

// Sends a single email via SendGrid's HTTPS API (v3 /mail/send).
async function sendOneEmailViaSendGridApi({ fromName, fromAddress, to, subject, html }) {
  await axios.post(
    "https://api.sendgrid.com/v3/mail/send",
    {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: fromAddress, name: fromName },
      subject,
      content: [{ type: "text/html", value: html }],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.SMTP_PASS}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    }
  );
}

// Sends a single email via a generic SMTP transporter (any non-SendGrid host).
async function sendOneEmailViaSmtp({ fromName, fromAddress, to, subject, html }) {
  const transporter = await getMailTransporter();
  await transporter.sendMail({
    from: `"${fromName}" <${fromAddress}>`,
    to,
    subject,
    html,
  });
}

// Sends the "chat with us" email to every lead in `targets` (Score === 0 with
// a valid, active email address). Uses Promise.allSettled so one bad address
// doesn't block the rest.
async function sendQualificationEmails(req, targets) {
  const summary = { attempted: targets.length, sent: 0, failed: 0, skippedReason: null, lastError: null };

  if (targets.length === 0) return summary;

  if (!isMailConfigured()) {
    summary.skippedReason = "SMTP not configured (set SMTP_HOST / SMTP_USER / SMTP_PASS).";
    console.warn(`  ⚠ Skipping ${targets.length} qualification email(s): ${summary.skippedReason}`);
    return summary;
  }

  const fromName    = process.env.EMAIL_FROM_NAME || "LG Lead Qualification";
  const fromAddress = process.env.EMAIL_FROM || process.env.SMTP_USER;
  const subject     = "LG — choose how you would like to connect";
  const sendOneEmail = IS_SENDGRID ? sendOneEmailViaSendGridApi : sendOneEmailViaSmtp;

  const results = await Promise.allSettled(
    targets.map((lead) => {
      const name      = lead.ContactName || "there";
      const contactId = String(lead.ContactID ?? "");
      const email     = String(lead.email || "").trim();
      const chatLink  = buildChatLink(req, contactId);
      const submitFormLink = buildSubmitFormLink(req, contactId);

      return sendOneEmail({
        fromName,
        fromAddress,
        to: email,
        subject,
        html: buildWelcomeEmailHtml(name, contactId, chatLink, submitFormLink),
      });
    })
  );

  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      summary.sent += 1;
    } else {
      summary.failed += 1;
      const message = r.reason?.response?.data?.errors?.[0]?.message || r.reason?.message || String(r.reason);
      summary.lastError = message;
      console.error(`  ✗ Email to ${targets[i].email} failed:`, message);
    }
  });

  console.log(`  → Emails: ${summary.sent} sent, ${summary.failed} failed (of ${summary.attempted})`);
  return summary;
}

// ── Parse xlsx/xls buffer → leads array (with Score appended) ────────────────
function parseXlsx(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  // Raw array-of-arrays so Score can be computed from actual column
  // positions (C, D, E, G), regardless of header names/order.
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (rows.length === 0) return [];

  const headers = rows[0].map((h, i) => (h === "" || h == null ? `Column${i + 1}` : String(h)));
  const scoreColIndex = headers.findIndex((h) => h.trim().toLowerCase() === "score");

  return rows
    .slice(1)
    .filter((row) => row.some((cell) => cell !== "" && cell != null))
    .map((row) => {
      const record = {};
      headers.forEach((header, i) => {
        if (i === scoreColIndex) return; // recomputed below, not copied as-is
        record[header] = row[i] ?? "";
      });
      record.Score = computeScore(row);
      return record;
    });
}

// ── Upload leads via the LG Leads API (→ S3, through the upload Lambda) ─────
// Optionally also forwards the original file's raw bytes (base64) + its
// filename so the Lambda can archive the unmodified source feed under
// s3://<bucket>/raw/ alongside the parsed/scored leads.json.
async function uploadViaApi(leads, rawFileBase64, rawFileName) {
  const apiUrl = process.env.LG_API_URL;
  const token = process.env.LG_BEARER_TOKEN;
  if (!apiUrl) throw new Error("LG_API_URL env var is not set.");
  if (!token) throw new Error("LG_BEARER_TOKEN env var is not set.");

  const endpoint = `${apiUrl.replace(/\/$/, "")}/uploadLeads`;
  console.log(`  → POST ${endpoint} (${leads.length} lead(s))`);

  const body = { leads };
  if (rawFileBase64) {
    body.rawFile = rawFileBase64;
    body.rawFileName = rawFileName;
  }

  const response = await axios.post(
    endpoint,
    body,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      timeout: 30000,
    }
  );
  return response.data;
}

// ── Fetch call reports via the LG Leads API (→ report Lambda, reads S3) ─────
// GET /lg/report returns { format: "xlsx-base64", filename, data } - the
// report workbook written by every sendFeedOutcome/log_disconnect_report
// call from the yflow. Parsed here into plain row objects for the portal's
// "Call Reports" tab, newest first.
async function fetchCallReports() {
  const apiUrl = process.env.LG_API_URL;
  const token = process.env.LG_BEARER_TOKEN;
  if (!apiUrl) throw new Error("LG_API_URL env var is not set.");
  if (!token) throw new Error("LG_BEARER_TOKEN env var is not set.");

  const endpoint = `${apiUrl.replace(/\/$/, "")}/report`;
  const response = await axios.get(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
  });

  const { data } = response.data || {};
  if (!data) return [];

  const buffer = Buffer.from(data, "base64");
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  // Newest first - Timestamp column may be a JS Date (exceljs date cell) or
  // an ISO string depending on how the row was written.
  return rows
    .map((row) => ({
      contactId: String(row["Contact ID"] ?? "").trim(),
      customerName: String(row["Customer Name"] ?? "").trim(),
      leadId: String(row["Lead ID"] ?? "").trim(),
      qualification: String(row["Lead Qualification"] ?? "").trim(),
      bantScore: String(row["BANT Score"] ?? "").trim(),
      callSummary: String(row["Call Summary"] ?? "").trim(),
      timestamp: row["Timestamp"] instanceof Date ? row["Timestamp"].toISOString() : String(row["Timestamp"] ?? ""),
    }))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

// ── Public lead form / IC Feed call request ─────────────────────────────────
// The browser never receives the LG API bearer token. The server loads the
// original lead by ContactID, displays the spreadsheet details as read-only,
// and reloads that same record when the form is submitted.
async function getLeadByContactId(contactId) {
  const apiUrl = process.env.LG_API_URL;
  const token = process.env.LG_BEARER_TOKEN;
  if (!apiUrl) throw new Error("LG_API_URL env var is not set.");
  if (!token) throw new Error("LG_BEARER_TOKEN env var is not set.");

  const endpoint = `${apiUrl.replace(/\/$/, "")}/getUserdataByContactID`;
  const response = await axios.get(endpoint, {
    params: { contactId },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
  return response.data?.lead;
}

function normalisePhone(raw) {
  const value = String(raw ?? "").trim().replace(/[\s()-]/g, "");
  if (value.startsWith("+")) return value;
  if (value.startsWith("00")) return `+${value.slice(2)}`;
  return `+${value}`;
}

function buildLeadDetailsHtml(lead) {
  const excluded = new Set(["DirectPhone", "MobilePhone", "phone_number", "Score"]);
  return Object.entries(lead)
    .filter(([key, value]) => !excluded.has(key) && value != null && String(value).trim() !== "")
    .map(([key, value]) => (
      '<div class="detail"><div class="label">' + escapeHtml(key) + '</div><div class="value">' + escapeHtml(value) + '</div></div>'
    ))
    .join("") || '<div class="detail"><div class="value">Your lead details are ready.</div></div>';
}

function isIcFeedConfigured() {
  return !!(process.env.ICFEED_USERNAME && process.env.ICFEED_PASSWORD && process.env.ICFEED_CAMPAIGN_ID);
}

async function submitVoiceCall(lead, phone) {
  const username = process.env.ICFEED_USERNAME;
  const password = process.env.ICFEED_PASSWORD;
  const campaignId = process.env.ICFEED_CAMPAIGN_ID;
  if (!username || !password || !campaignId) {
    throw new Error("IC Feed is not configured (set ICFEED_USERNAME, ICFEED_PASSWORD, and ICFEED_CAMPAIGN_ID).");
  }

  const excluded = new Set(["phone_number", "DirectPhone", "MobilePhone", "time_to_call", "TimeToCall"]);
  const leadData = Object.fromEntries(Object.entries(lead).filter(([key]) => !excluded.has(key)));
  const payload = {
    SName: process.env.SERVICE_NAME || "AMX",
    CampaignID: campaignId,
    Mobile: phone,
    ...leadData,
    TimeToCall: new Date().toISOString(),
  };
  const auth = Buffer.from(`${username}:${password}`).toString("base64");
  const response = await axios.post(process.env.ICFEED_API_URL || "https://icfeed.cvgapps.co.uk/api/leads", payload, {
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    timeout: 15000,
  });
  console.log(`  ✓ IC Feed call request accepted for ContactID ${lead.ContactID ?? "unknown"} — HTTP ${response.status}`);
}

// The voice yflow identifies an inbound call by looking up its number against
// DirectPhone/MobilePhone in the LG lead store. Score-0 email leads have no
// phone number until they submit this form, so persist the supplied number
// first. This lets the flow load the real ContactName rather than its fallback
// demo record when the dialler connects the call.
async function storeSubmittedPhoneForVoiceLookup(lead, phone) {
  const updatedLead = {
    ...lead,
    MobilePhone: phone,
    phone_number: phone,
  };
  await uploadViaApi([updatedLead]);
  console.log(`  ✓ Stored submitted phone for ContactID ${lead.ContactID ?? "unknown"}`);
  return updatedLead;
}

function sendFormPage(res, title, message, statusCode = 200) {
  res.status(statusCode).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${escapeHtml(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#0d2137;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}.card{max-width:520px;padding:32px;border-radius:18px;background:#fff;box-shadow:0 24px 70px rgba(0,0,0,.35)}h1{margin:0 0 12px;color:#0f172a;font-size:22px}p{margin:0;color:#475569;line-height:1.6}</style></head><body><main class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`);
}

function getSafeIcFeedErrorMessage(err) {
  if (err.response?.status) {
    return `The call service returned HTTP ${err.response.status}. Please contact the campaign administrator if the problem continues.`;
  }
  if (err.code === "ECONNABORTED") {
    return "The call service timed out. Please try again shortly.";
  }
  return "The call service could not be reached. Please try again later.";
}

// ── GET /health ───────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ── GET /sftp/status — last SFTP push result, for the portal's SFTP tab ─────
app.get("/sftp/status", (req, res) => {
  res.json({ configured: isSftpConfigured(), last: lastSftpStatus });
});

// ── GET /reports — call summaries from the report Lambda, for the portal's ──
// "Call Reports" tab.
app.get("/reports", async (req, res) => {
  try {
    const reports = await fetchCallReports();
    res.json({ success: true, reports });
  } catch (err) {
    console.error("✗ Failed to fetch call reports:", err.response?.data || err.message);
    res.status(502).json({
      success: false,
      error: err.response?.data?.error || err.message,
    });
  }
});

// ── GET /chat — public chat-bot landing page (no login required) ─────────────
// This is the link emailed to leads, and is also embedded (via iframe) in the
// authenticated portal's "Chat Bot" preview tab.
const chatTemplate = fs.readFileSync(path.join(__dirname, "frontend", "chat.template.html"), "utf8");
app.get("/chat", (req, res) => {
  const rawContactId = typeof req.query.contactId === "string" ? req.query.contactId : "";
  const contactId = escapeHtml(rawContactId.slice(0, 100));

  const html = chatTemplate
    .replace(/{{CONTACT_ID}}/g, contactId)
    .replace(/{{CONTACT_ID_URL}}/g, encodeURIComponent(rawContactId.slice(0, 100)))
    .replace(/{{WIDGET_SRC}}/g, escapeHtml(CHAT_WIDGET_SRC))
    .replace(/{{WIDGET_ORG_ID}}/g, escapeHtml(CHAT_WIDGET_ORG_ID))
    .replace(/{{WIDGET_ID}}/g, escapeHtml(CHAT_WIDGET_ID))
    .replace(/{{WIDGET_FLOW_ID}}/g, escapeHtml(CHAT_WIDGET_FLOW_ID));

  res.set("Content-Type", "text/html").send(html);
});

// ── GET /submit-form — public, pre-filled lead form ─────────────────────────
const submitFormTemplate = fs.readFileSync(path.join(__dirname, "frontend", "submit-form.template.html"), "utf8");
app.get("/submit-form", async (req, res) => {
  const contactId = typeof req.query.contactId === "string" ? req.query.contactId.trim().slice(0, 100) : "";
  if (!contactId) return sendFormPage(res, "Invalid link", "This form link does not include a Contact ID.", 400);

  try {
    const lead = await getLeadByContactId(contactId);
    if (!lead) return sendFormPage(res, "Lead not found", "We could not find the lead information for this link.", 404);
    const html = submitFormTemplate
      .replace(/{{CONTACT_ID}}/g, escapeHtml(contactId))
      .replace(/{{LEAD_DETAILS}}/g, buildLeadDetailsHtml(lead));
    res.set("Content-Type", "text/html").send(html);
  } catch (err) {
    console.error("✗ Failed to load lead form:", err.response?.data || err.message);
    sendFormPage(res, "Unable to load your details", "Please try again later.", 502);
  }
});

// ── POST /submit-form — submit the IC Feed call request server-side ──────────
app.post("/submit-form", async (req, res) => {
  const contactId = String(req.body?.contactId ?? "").trim().slice(0, 100);
  const phone = normalisePhone(req.body?.phone);
  if (!contactId || !/^\+\d{7,15}$/.test(phone)) {
    return sendFormPage(res, "Check your phone number", "Enter a valid international phone number, including the country code.", 400);
  }
  if (!isIcFeedConfigured()) {
    console.error("✗ IC Feed call request rejected: IC Feed environment variables are not configured.");
    return sendFormPage(res, "Call requests are unavailable", "Please use Chat with us Now or try again later.", 503);
  }

  try {
    const lead = await getLeadByContactId(contactId);
    if (!lead) return sendFormPage(res, "Lead not found", "We could not find the lead information for this link.", 404);

    const updatedLead = await storeSubmittedPhoneForVoiceLookup(lead, phone);
    // Wait for IC Feed to accept the lead before confirming success. A detached
    // promise can be interrupted when a Render request completes, and would
    // otherwise show a success page even if the call request later failed.
    await submitVoiceCall(updatedLead, phone);
    sendFormPage(res, "Your call request was submitted", "Thank you. Our virtual agent will call the number you provided shortly.");
  } catch (err) {
    console.error(`✗ IC Feed call request failed for ContactID ${contactId}:`, err.response?.data || err.message);
    sendFormPage(res, "Unable to submit your request", getSafeIcFeedErrorMessage(err), 502);
  }
});

// ── GET /chat-widget — bare widget-only page, embedded via iframe by ─────────
// chat.template.html so the widget's own floating bottom-right panel fills a
// small, fixed-size frame instead of floating in the corner of the leads'
// full browser window (matches how the portal's "Chat Bot Preview" tab looks).
//
// Also forwards ?contactId= (if present) into the widget as a
// "contactId:<id>" userEndpoint value — the yflow's checkPhone branch
// recognises that prefix and skips straight to a contact-ID lookup instead of
// verbally/textually asking the lead for it. Best-effort: if the widget
// doesn't support data-user-endpoint, the flow falls back to asking for the
// Contact ID as before (no regression either way).
const chatWidgetTemplate = fs.readFileSync(path.join(__dirname, "frontend", "chat-widget.template.html"), "utf8");
app.get("/chat-widget", (req, res) => {
  const rawContactId = typeof req.query.contactId === "string" ? req.query.contactId.slice(0, 100) : "";
  const userEndpoint = rawContactId ? `contactId:${rawContactId}` : "";

  const html = chatWidgetTemplate
    .replace(/{{WIDGET_SRC}}/g, escapeHtml(CHAT_WIDGET_SRC))
    .replace(/{{WIDGET_ORG_ID}}/g, escapeHtml(CHAT_WIDGET_ORG_ID))
    .replace(/{{WIDGET_ID}}/g, escapeHtml(CHAT_WIDGET_ID))
    .replace(/{{WIDGET_FLOW_ID}}/g, escapeHtml(CHAT_WIDGET_FLOW_ID))
    .replace(/{{USER_ENDPOINT}}/g, escapeHtml(userEndpoint));

  res.set("Content-Type", "text/html").send(html);
});

// ── Serve static UI ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "frontend")));

// ── POST /upload ──────────────────────────────────────────────────────────────
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: "No file uploaded." });
  }

  const filename = req.file.originalname;
  let leads;
  try {
    leads = parseXlsx(req.file.buffer);
    console.log(`\n── ${filename} — ${leads.length} record(s) ──`);
  } catch (err) {
    return res.status(400).json({ success: false, error: `Failed to parse file: ${err.message}` });
  }

  if (leads.length === 0) {
    return res.status(400).json({ success: false, error: "No data rows found in the file." });
  }

  try {
    // 1. Store the scored leads (JSON) + the raw original file bytes to S3,
    //    via the upload Lambda (single API call handles both).
    const rawFileBase64 = req.file.buffer.toString("base64");
    const apiResult = await uploadViaApi(leads, rawFileBase64, filename);
    const scores = leads.map((l) => l.Score);
    const averageScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    // 2. Rebuild the scored rows into a workbook and push it via SFTP so the
    //    IC Dial campaign-calling system can pick it up (Score column is
    //    mandatory there). Best-effort: failures don't fail the upload.
    const sftpFileName = buildSftpFileName(filename);
    const scoredBuffer = leadsToXlsxBuffer(leads);
    const sftpSummary = await pushScoredFileToSftp(scoredBuffer, sftpFileName);
    lastSftpStatus = {
      ...sftpSummary,
      filename: sftpFileName,
      recordCount: leads.length,
      uploadedAt: new Date().toISOString(),
    };

    // 3. Score === 0 means both DirectPhone and MobilePhone are blank —
    //    target those leads with an active (valid, non-blank) email for the
    //    chat-bot invite.
    const emailTargets = leads.filter((l) => l.Score === 0 && isValidEmail(l.email));
    const emailSummary = await sendQualificationEmails(req, emailTargets);

    return res.json({
      success: true,
      filename,
      recordCount: leads.length,
      averageScore: Number(averageScore.toFixed(2)),
      apiResult,
      sftpSummary: lastSftpStatus,
      emailSummary,
    });
  } catch (err) {
    console.error("✗ Upload failed:", err.response?.data || err.message);
    return res.status(502).json({
      success: false,
      error: err.response?.data?.error || err.message,
    });
  }
});

// ── Error handler for /upload — multer's fileFilter (unsupported file type)
// and file-size-limit rejections call next(err) instead of throwing inside
// the route handler above, so without this they'd fall through to Express's
// default HTML error page. The frontend's `await resp.json()` would then
// throw a cryptic "Unexpected token '<'" parse error instead of showing the
// actual "Only .xlsx / .xls files are allowed." message, and (since that
// throw happens before any further pipeline UI updates run) the upload
// pipeline strip would visually stay stuck on whichever step was active.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err) {
    return res.status(400).json({ success: false, error: err.message || "Upload failed." });
  }
  next(err);
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nLG Leads Upload Server running at http://localhost:${PORT}`);
  console.log(`Open your browser and go to: http://localhost:${PORT}\n`);
});
