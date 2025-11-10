import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { login } from "./lib/login.js";
import { sendInstagramMessage } from "./lib/messaging.js";
import { toggleStoryViewing } from "./lib/stories.js";
import {
  getCurrentUser,
  getCurrentProxy,
  getPage,
  launchContext,
} from "./lib/browser.js";
import { log, registerClient } from "./utils/log.js";
import { ensureBrowserActive } from "./utils/helpers.js";
import {
  checkAndIncrementMessageCount,
  getMessageCount,
} from "./utils/rate_limiter.js";
import { pool } from "./db.js";
import { loadConfig } from "./config.js";

dotenv.config();

const { USERNAME, PORT, TABLE, WEBHOOK_LOGIN, WEBHOOK_DM } = await loadConfig();

// Now you can safely use:
console.log({ USERNAME, PORT, TABLE });

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ---------- EJS SETUP ----------
app.set("view engine", "ejs");
app.set("views", "./views");

// ---------- SSE LOG STREAM ----------
app.get("/logs", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  registerClient(res);
});

// ---------- GLOBAL FLAGS ----------
global.isLoopRunning = false;
global.isDMRunning = false;

// ---------- DM LOOP FUNCTION ----------
export async function runDmCycle() {
  try {
    const currentUser = getCurrentUser();
    const userId = USERNAME || currentUser;

    const { count, limit } = getMessageCount(userId);
    if (count >= limit) {
      log(
        `[RATE LIMIT] 🚫 ${userId} reached daily limit (${count}/${limit}). Loop stopped.`
      );
      global.isLoopRunning = false;
      return;
    }

    log(`[RATE LIMIT] ✅ ${userId}: ${count}/${limit} messages used today.`);

    let page = getPage();
    let browserHealthy = page && !page.isClosed();

    if (!browserHealthy) {
      log("[INFO] Browser context invalid — launching fresh one...");
      await launchContext(userId);
      page = getPage();
      browserHealthy = !!page;
    }

    if (!currentUser || !browserHealthy) {
      log("🟡 Triggering login webhook...");
      await fetch(WEBHOOK_LOGIN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: USERNAME }),
      });
      log("✅ Login webhook completed — waiting 10s...");
      await new Promise((r) => setTimeout(r, 10000));
    }

    log("🚀 Sending DM via Webhook 2...");
    const response = await fetch(WEBHOOK_DM, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: USERNAME }),
    });

    if (!response.ok) {
      log(`[ERROR] DM webhook failed: ${response.status}`);
    } else {
      const data = await response.json().catch(() => ({}));
      if (!data || Object.keys(data).length === 0) {
        log("⚠️ No leads found in webhook response — stopping loop.");
        global.isLoopRunning = false;
        return;
      }
      log(`✅ DM webhook done for ${USERNAME}`);
    }

    if (page) {
      try {
        const browser = page.browser();
        if (browser && browser.process()) {
          await browser.close().catch(() => {});
          log("🛑 Browser closed after DM cycle.");
        }
      } catch (err) {
        log(`[WARN] Error closing browser: ${err.message}`);
      }
    }

    const rate = getMessageCount(userId);
    if (rate.count >= rate.limit) {
      log(
        `[RATE LIMIT] ⚠️ ${userId} reached limit (${rate.count}/${rate.limit}). Loop stopped.`
      );
      global.isLoopRunning = false;
      return;
    }

    const waitTime = 2 * 60 * 1000;
    log(`⏳ Waiting ${waitTime / 60000} minutes before next cycle...`);
    await new Promise((r) => setTimeout(r, waitTime));

    if (global.isLoopRunning) await runDmCycle();
    else log("🛑 Loop stopped manually or by rate limit.");
  } catch (err) {
    log(`[FATAL] Error in DM loop: ${err.message}`);
    log("⚠️ Retrying in 5 minutes...");
    await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
    if (global.isLoopRunning) await runDmCycle();
  }
}

// ---------- MANUAL LOG ----------
app.post("/logthis", (req, res) => {
  const { message } = req.body;
  if (!message)
    return res.status(400).json({ success: false, error: "Missing message" });

  try {
    log(`🪵 Manual Log: ${message}`);
    res.json({ success: true, logged: message });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- ROUTES ----------

// Start DM loop
app.post("/start-dm-loop", async (req, res) => {
  try {
    if (global.isLoopRunning)
      return res.status(400).json({ error: "DM loop already running" });

    const { count, limit } = getMessageCount(USERNAME);
    if (count >= limit) {
      log(`[RATE LIMIT] 🚫 ${USERNAME} already hit daily limit.`);
      return res
        .status(429)
        .json({ success: false, error: "Rate limit reached" });
    }

    global.isLoopRunning = true;
    log("🔁 Starting continuous DM loop...");
    runDmCycle();
    res.json({ success: true, message: "DM loop started" });
  } catch (err) {
    log(`[FATAL] /start-dm-loop error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Dashboard UI
app.get("/", (req, res) => {
  res.render("index", { USERNAME });
});

// Login webhook
app.post("/webhook-proxy-1", async (req, res) => {
  try {
    if (!WEBHOOK_LOGIN) throw new Error("WEBHOOK_LOGIN not set");
    log(`📩 Login Webhook Triggered for ${USERNAME}`);
    const response = await fetch(WEBHOOK_LOGIN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: USERNAME }),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    log("[ERROR] Webhook 1: " + err.message);
    res.status(500).json({ error: err.message });
  }
});

// DM webhook
app.post("/webhook-proxy-2", async (req, res) => {
  try {
    if (global.isDMRunning)
      return res.status(429).json({ error: "DM already running" });
    global.isDMRunning = true;

    log(`🚀 DM Webhook Triggered for ${USERNAME}`);
    const response = await fetch(WEBHOOK_DM, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: USERNAME }),
    });

    if (!response.ok) throw new Error(`Status ${response.status}`);
    const data = await response.json();
    log("✅ DM process completed successfully.");
    res.json({ ok: true, data });
  } catch (err) {
    log("[ERROR] Webhook 2: " + err.message);
    res.status(500).json({ error: err.message });
  } finally {
    global.isDMRunning = false;
  }
});

// Direct login API
app.post("/login", async (req, res) => {
  const { username, password, proxy } = req.body;
  if (!username || !password)
    return res
      .status(400)
      .json({ success: false, error: "Missing credentials" });

  try {
    const result = await login(username, password, proxy);
    log(`✅ ${username} logged in successfully`);
    res.json(result);
  } catch (err) {
    log("[ERROR] /login " + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- SEND MESSAGE ----------
app.post("/instagram", ensureBrowserActive, async (req, res) => {
  const { to, message } = req.body;
  const userId = getCurrentUser();

  if (!to || !message)
    return res
      .status(400)
      .json({ success: false, error: "Missing 'to' or 'message'" });
  if (!userId)
    return res.status(400).json({ success: false, error: "No user logged in" });

  const limitInfo = getMessageCount(userId);
  if (limitInfo.count >= limitInfo.limit)
    return res.status(429).json({
      success: false,
      error: `Daily limit (${limitInfo.limit}) exceeded.`,
    });

  try {
    const result = await sendInstagramMessage(to, message);
    if (result.success) checkAndIncrementMessageCount(userId);

    const updated = getMessageCount(userId);
    res.json({
      ...result,
      from: userId,
      proxy: getCurrentProxy(),
      messageCount: updated.count,
      messagesRemaining: updated.limit - updated.count,
    });
  } catch (err) {
    log("[ERROR] /instagram", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- STORY VIEW ----------
app.post("/viewstory", ensureBrowserActive, async (req, res) => {
  const { status } = req.body;
  if (!status)
    return res.status(400).json({ success: false, error: "Missing status" });

  try {
    const result = await toggleStoryViewing(status);
    if (result.success) log(`📺 Story viewing ${status}`);
    res.json(result);
  } catch (err) {
    log("[ERROR] /viewstory", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- LEADS DASHBOARD ----------
app.get("/leads", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM ${TABLE} ORDER BY id DESC`);
    res.render("leads", { leads: result.rows });
  } catch (err) {
    res.status(500).send("Database error: " + err.message);
  }
});

// ---------- BULK CREATE ----------
app.post("/leads/add", async (req, res) => {
  try {
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: "Missing data field" });

    const entries = data.split("\n").map((line) => {
      const [username, message] = line.split(",");
      return { username: username.trim(), message: message?.trim() || "" };
    });

    for (const lead of entries) {
      if (!lead.username) continue;
      await pool.query(
        `INSERT INTO ${TABLE} (username, message, status, time_stamp) VALUES ($1,$2,$3,$4)`,
        [lead.username, lead.message, null, null]
      );
    }

    res.json({ success: true, added: entries.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- UPDATE LEAD ----------
app.post("/leads/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { username, message, status } = req.body;

    await pool.query(
      `UPDATE ${TABLE} SET username=$1, message=$2, status=$3 WHERE id=$4`,
      [username, message, status, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- DELETE SINGLE ----------
app.post("/leads/delete/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM ${TABLE} WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- DELETE BY FILTER ----------
app.post("/leads/delete-filter", async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query(`DELETE FROM ${TABLE} WHERE status=$1`, [status]);
    res.json({ success: true, deleted: status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/health", (req, res) => {
  const currentUser = getCurrentUser();
  const rate = currentUser ? getMessageCount(currentUser) : null;
  const dmRunning = global.isLoopRunning === true;
  res.json({
    ok: true,
    currentUser,
    proxy: getCurrentProxy(),
    rateLimit: rate
      ? { ...rate, messagesRemaining: rate.limit - rate.count }
      : {},
    isLoopRunning: dmRunning,
  });
});

// ---------- 2FA HANDLING ----------

// When Puppeteer detects 2FA
app.post("/2fa-required", (req, res) => {
  const { username } = req.body;
  const message = `🔐 2FA required for ${username}. Waiting for code input...`;
  log(message);
  res.json({ ok: true });
});

// When user submits 2FA code
app.post("/submit-2fa", async (req, res) => {
  const { code } = req.body;
  if (!code)
    return res
      .status(400)
      .json({ success: false, message: "No code received" });

  global._pending2FA = { code, username: process.env.LOGIN_USERNAME };
  log(`📩 2FA code ${code} received from dashboard.`);
  res.json({ success: true });
});

// ---------- FAILSAFE ----------
process.on("unhandledRejection", (err) =>
  log("[FATAL] Unhandled rejection: " + err)
);
process.on("uncaughtException", (err) =>
  log("[FATAL] Uncaught exception: " + err)
);

// ---------- START SERVER ----------
app.listen(PORT, "0.0.0.0", () => {
  log(`✅ Server running at http://localhost:${PORT} (Table: ${TABLE})`);
});
