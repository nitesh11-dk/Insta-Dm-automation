import path from "path";
import fs from "fs";
import { getPage } from "../lib/browser.js";
import { log as logFunction } from "./log.js";
// ---------- CONFIG & SETUP ----------
const profilesDir = path.join(process.cwd(), "profiles");

// Ensure the profiles directory always exists
try {
  if (!fs.existsSync(profilesDir)) {
    fs.mkdirSync(profilesDir, { recursive: true });
    console.log(`[INIT] Created profiles directory → ${profilesDir}`);
  }
} catch (err) {
  console.error(
    `[FATAL] Failed to initialize profiles directory: ${err.message}`
  );
}

// ---------- LOGGING ----------
export function log(...args) {
  const timestamp = new Date().toISOString();
  const msg = args.map(String).join(" ");
  console.log(`[${timestamp}] ${msg}`);
}

// ---------- DELAY / RANDOMNESS ----------
export function randomDelay(min = 500, max = 2000) {
  return new Promise((res) =>
    setTimeout(res, min + Math.random() * (max - min))
  );
}

// ---------- SESSION PATHS ----------
export function getProfilePath(username) {
  return path.join(profilesDir, username);
}

function getSessionFile(username) {
  return path.join(getProfilePath(username), "session.json");
}

// ---------- SESSION I/O ----------
export function loadSession(username) {
  const file = getSessionFile(username);
  if (!fs.existsSync(file)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return data.cookies || data;
  } catch (err) {
    log(`[WARN] Failed to parse session for ${username}: ${err.message}`);
    return null;
  }
}

export function saveSession(username, session) {
  try {
    const profilePath = getProfilePath(username);
    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true });
      log(`[INFO] Created profile folder for ${username}`);
    }

    const sessionFile = getSessionFile(username);
    const dataToSave = {
      cookies: session,
      savedAt: new Date().toISOString(),
    };

    fs.writeFileSync(sessionFile, JSON.stringify(dataToSave, null, 2));
    log(`[INFO] Saved session for ${username} → ${sessionFile}`);
  } catch (err) {
    log(`[ERROR] Failed to save session for ${username}: ${err.message}`);
  }
}

// ---------- MIDDLEWARE: ENSURE BROWSER ACTIVE ----------
export function ensureBrowserActive(req, res, next) {
  try {
    const page = getPage();
    const valid = page && !page.isClosed();
    if (!valid) {
      logFunction(
        "[BLOCKED] ❌ Request rejected — browser context not active."
      );
      return res.status(503).json({
        success: false,
        error: "Browser context inactive. Please relogin first.",
      });
    }
    next();
  } catch (err) {
    logFunction(`[ERROR] ensureBrowserActive failed: ${err.message}`);
    return res.status(503).json({
      success: false,
      error: "Browser not available. Please relogin.",
    });
  }
}

// ---------- HUMAN-LIKE TYPING (ULTRA STABLE) ----------
/**
 * Types text into an element by simulating real human-like keystrokes.
 * Fixes scrambled text issues during high load or multiple Puppeteer sessions.
 * @param {import('puppeteer').Page} page Puppeteer Page object
 * @param {string} selector CSS selector of input element
 * @param {string} text Text to type
 */
export async function typeLikeHuman(page, selector, text) {
  try {
    // ✅ Ensure element is visible and stable
    await page.waitForSelector(selector, { visible: true, timeout: 15000 });

    // Focus properly (guaranteed)
    await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (el) {
        el.focus();
        el.innerText = "";
        const event = new InputEvent("input", { bubbles: true });
        el.dispatchEvent(event);
      }
    }, selector);

    // 🧠 Type safely character by character
    for (const ch of text) {
      await page.keyboard.type(ch, { delay: 120 + Math.random() * 80 });
      await randomDelay(10, 30); // micro delay between chars
    }

    // Small buffer delay after typing
    await randomDelay(500, 1000);
  } catch (err) {
    logFunction(`[WARN] typeLikeHuman failed on ${selector}: ${err.message}`);
  }
}
