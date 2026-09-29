/**
 * test-sftp.js — standalone SFTP connectivity diagnostic.
 *
 * Run locally (same machine you tested with FileZilla) to reproduce the
 * "getConnection: write ECONNRESET" error with full SSH-level debug output,
 * so we can tell whether it's a network-level block (e.g. a PaaS host
 * silently dropping outbound port 22, or the SFTP server IP-allowlisting
 * only known/office IPs) vs. an algorithm/config mismatch in our code.
 *
 * Usage:
 *   node test-sftp.js
 *
 * Reads SFTP_HOST / SFTP_PORT / SFTP_USERNAME / SFTP_PASSWORD (or
 * SFTP_PRIVATE_KEY / SFTP_PASSPHRASE) / SFTP_REMOTE_DIR from .env — never
 * prints the password/key itself.
 */

const path = require("path");
const SftpClient = require("ssh2-sftp-client");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

async function main() {
  const host = process.env.SFTP_HOST;
  const username = process.env.SFTP_USERNAME;
  if (!host || !username) {
    console.error("✗ SFTP_HOST / SFTP_USERNAME not set in .env — nothing to test.");
    process.exit(1);
  }

  const connectOptions = {
    host,
    port: Number(process.env.SFTP_PORT || 22),
    username,
    readyTimeout: 15000,
    // CompleteFTP (this server's software) times out mid-handshake when
    // ssh2 negotiates "diffie-hellman-group-exchange-sha256" (needs an extra
    // GEX group-request round trip). Forcing group14-sha256 instead — which
    // the server also advertises — skips that exchange entirely.
    algorithms: { kex: ["diffie-hellman-group14-sha256"] },
    // Verbose SSH protocol debug — logs handshake/negotiation steps so we can
    // see exactly which stage fails (TCP connect vs. SSH banner vs. key
    // exchange vs. auth) instead of just the generic ECONNRESET.
    debug: (msg) => console.log("[ssh2 debug]", msg),
  };
  if (process.env.SFTP_PRIVATE_KEY) {
    connectOptions.privateKey = process.env.SFTP_PRIVATE_KEY;
    if (process.env.SFTP_PASSPHRASE) connectOptions.passphrase = process.env.SFTP_PASSPHRASE;
  } else {
    connectOptions.password = process.env.SFTP_PASSWORD;
  }

  console.log(`Connecting to ${host}:${connectOptions.port} as ${username}…`);

  const client = new SftpClient();
  try {
    await client.connect(connectOptions);
    console.log("✓ Connected.");

    const remoteDir = (process.env.SFTP_REMOTE_DIR || "/").replace(/\/+$/, "") || "/";
    console.log(`Listing ${remoteDir} …`);
    const list = await client.list(remoteDir);
    console.log(`✓ Listing OK — ${list.length} entr${list.length === 1 ? "y" : "ies"}.`);

    const testPath = `${remoteDir === "/" ? "" : remoteDir}/_connectivity_test_${Date.now()}.txt`;
    console.log(`Uploading a small test file to ${testPath} …`);
    await client.put(Buffer.from("SFTP connectivity test\n"), testPath);
    console.log("✓ Upload OK — write access confirmed.");

    await client.delete(testPath);
    console.log("✓ Cleanup OK — test file removed.");
  } catch (err) {
    console.error("✗ FAILED:", err.message);
    console.error("  code:", err.code, "| level:", err.level);
  } finally {
    try { await client.end(); } catch { /* already disconnected */ }
  }
}

main();
