const express = require("express");
const multer  = require("multer");
const path    = require("path");
const crypto  = require("crypto");
const XLSX    = require("xlsx");
const axios   = require("axios");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Auth config ───────────────────────────────────────────────────────────────
const LOGIN_USER     = process.env.LOGIN_USER     || "ixHello";
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || "lgleads";
const sessions = new Map(); // token → { user, createdAt }

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

// ── Auth middleware (protects all routes except /auth/* and /health) ──────────
app.use((req, res, next) => {
  const open = ["/auth/login", "/auth/logout", "/auth/status", "/health"];
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
async function uploadViaApi(leads) {
  const apiUrl = process.env.LG_API_URL;
  const token = process.env.LG_BEARER_TOKEN;
  if (!apiUrl) throw new Error("LG_API_URL env var is not set.");
  if (!token) throw new Error("LG_BEARER_TOKEN env var is not set.");

  const endpoint = `${apiUrl.replace(/\/$/, "")}/uploadLeads`;
  console.log(`  → POST ${endpoint} (${leads.length} lead(s))`);

  const response = await axios.post(
    endpoint,
    { leads },
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

// ── GET /health ───────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

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
    const apiResult = await uploadViaApi(leads);
    const scores = leads.map((l) => l.Score);
    const averageScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    return res.json({
      success: true,
      filename,
      recordCount: leads.length,
      averageScore: Number(averageScore.toFixed(2)),
      apiResult,
    });
  } catch (err) {
    console.error("✗ Upload failed:", err.response?.data || err.message);
    return res.status(502).json({
      success: false,
      error: err.response?.data?.error || err.message,
    });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nLG Leads Upload Server running at http://localhost:${PORT}`);
  console.log(`Open your browser and go to: http://localhost:${PORT}\n`);
});
