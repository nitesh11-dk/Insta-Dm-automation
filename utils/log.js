import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log as baseLog } from "./helpers.js";

// --- File setup for persistent logging ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = path.resolve(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "app.log");

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// --- Active SSE clients ---
let clients = new Set();

/**
 * Register a new SSE client
 * Called once from /logs route in server.js
 */
export function registerClient(res) {
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

/**
 * Safely JSON-stringify messages
 */
function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return `"${String(obj)}"`;
  }
}

/**
 * Broadcast log messages to all connected SSE clients
 */
export function broadcast(message) {
  const payload = `data: ${safeStringify(message)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (err) {
      console.warn("[SSE] Failed to write to client:", err.message);
      clients.delete(res);
    }
  }
}

/**
 * Main log function (single source of truth)
 * Logs to:
 *   ✅ Terminal
 *   ✅ Log file (./logs/app.log)
 *   ✅ SSE dashboard (frontend)
 */
export function log(...args) {
  const timestamp = new Date().toISOString();
  const msg = args.map(String).join(" ");
  const entry = `[${timestamp}] ${msg}`;

  // --- 1️⃣ Console output (fallback-safe) ---
  try {
    baseLog(entry);
  } catch {
    console.log(entry);
  }

  // --- 2️⃣ Write to persistent file ---
  try {
    fs.appendFileSync(LOG_FILE, entry + "\n");
  } catch (err) {
    console.warn("[FILE-LOG] Failed to write log:", err.message);
  }

  // --- 3️⃣ Broadcast to frontend dashboard ---
  broadcast(entry);

  return entry;
}

/**
 * Expose file path for external use (optional utility)
 */
export function getLogFilePath() {
  return LOG_FILE;
}
