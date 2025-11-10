// instagram-dashboard/lib/login.js
import {
  launchContext,
  getPage,
  getBrowserCookies,
  setCurrentUser,
  getCurrentProxy,
} from "./browser.js";
import {
  loadSession,
  saveSession,
  randomDelay,
  typeLikeHuman,
} from "../utils/helpers.js";
import { log } from "../utils/log.js";

// ------------------------------
// Utility: Safe visibility check
// ------------------------------
async function isVisible(page, selector, timeout = 800) {
  try {
    await page.waitForSelector(selector, { visible: true, timeout });
    return true;
  } catch {
    return false;
  }
}

async function isVisibleXPath(page, xpath, timeout = 800) {
  try {
    await page.waitForXPath(xpath, { visible: true, timeout });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------
// Click login button (handles both layouts)
// ------------------------------
async function clickLoginButton(page, isNewVersion) {
  try {
    if (isNewVersion) {
      const spans = await page.$$('div[role="none"] span');
      for (const span of spans) {
        const text = await page.evaluate((el) => el.textContent, span);
        if (text.trim() === "Log in") {
          const parent = await page.evaluateHandle(
            (el) => el.closest('div[role="none"]'),
            span
          );
          if (parent) {
            await parent.click();
            log("[INFO] Clicked Login (new layout)");
            return true;
          }
        }
      }
      log("[WARN] Login button (new layout) not found!");
    } else {
      const button = await page.$('button[type="submit"]');
      if (button) {
        await button.click();
        log("[INFO] Clicked Login (old layout)");
        return true;
      }
      log("[WARN] Login button (old layout) not found!");
    }
  } catch (err) {
    log(`[ERROR] Failed to click login button: ${err.message}`);
  }
  return false;
}

// ------------------------------
// Auto-recovery wrapper
// ------------------------------
async function safeAction(action, retries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await action();
    } catch (err) {
      log(`[WARN] Attempt ${attempt}/${retries} failed: ${err.message}`);
      await randomDelay(delay, delay + 1000);
      if (attempt === retries) throw err;
    }
  }
}

// ------------------------------
// MAIN LOGIN FUNCTION (Real-time 2FA Supported)
// ------------------------------
export async function login(username, password, proxy = null) {
  log(`[BOOT] Starting login for ${username}...`);

  const existingSession = loadSession(username);

  // 1️⃣ Launch Puppeteer with context/session
  await safeAction(() => launchContext(username, existingSession, proxy));

  const page = getPage();
  const PROFILE_ICON_SELECTOR =
    'img[alt*="profile picture"], [data-testid="user-avatar"]';

  // 2️⃣ Check if already logged in
  const loggedIn = await isVisible(page, PROFILE_ICON_SELECTOR, 1500);
  if (loggedIn) {
    const cookies = await getBrowserCookies();
    saveSession(username, cookies);
    setCurrentUser(username);
    log(`[READY] Already logged in — session refreshed for ${username}`);
    return {
      success: true,
      message: "Session active",
      user: username,
      proxy: getCurrentProxy(),
    };
  }

  // 3️⃣ Begin login procedure
  log(`[INFO] Performing fresh login for ${username}`);
  await safeAction(async () => {
    await Promise.race([
      page.waitForSelector('input[name="email"]', { timeout: 8000 }),
      page.waitForSelector('input[name="username"]', { timeout: 8000 }),
    ]);
  });

  const isNewVersion = await isVisible(page, "form#login_form", 1000);
  if (isNewVersion) {
    log("[INFO] Using new Instagram login layout");
    await typeLikeHuman(page, 'input[name="email"]', username);
    await typeLikeHuman(page, 'input[name="pass"]', password);
  } else {
    log("[INFO] Using old Instagram login layout");
    await typeLikeHuman(page, 'input[name="username"]', username);
    await typeLikeHuman(page, 'input[name="password"]', password);
  }

  await randomDelay(600, 1200);
  await clickLoginButton(page, isNewVersion);

  log("[INFO] Waiting for login processing and checking for 2FA...");

  // 4️⃣ Detect either login success or 2FA request
  const twoFASelector = 'input[name="verificationCode"]';
  const loginSuccessSelector = PROFILE_ICON_SELECTOR;

  const pageEvent = await Promise.race([
    page.waitForSelector(twoFASelector, { timeout: 15000 }).then(() => "2FA"),
    page
      .waitForSelector(loginSuccessSelector, { timeout: 15000 })
      .then(() => "SUCCESS"),
  ]).catch(() => "TIMEOUT");

  // 5️⃣ Handle invalid credentials
  const wrongPassword = await isVisibleXPath(
    page,
    '//div[contains(text(), "password was incorrect")]'
  );
  const invalidUser = await isVisibleXPath(
    page,
    '//div[contains(text(), "doesn\'t belong to an account")]'
  );

  if (wrongPassword) return { success: false, message: "Invalid password" };
  if (invalidUser) return { success: false, message: "Username doesn't exist" };

  // 6️⃣ Handle 2FA if detected
  if (pageEvent === "2FA") {
    log("[ALERT] 2FA verification detected — notifying dashboard...");

    try {
      await fetch("http://localhost:3001/2fa-required", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
    } catch (err) {
      log(`[WARN] Failed to notify dashboard about 2FA: ${err.message}`);
    }

    log("🔐 Waiting for 2FA code submission from dashboard...");

    let code = null;
    for (let i = 0; i < 60; i++) {
      if (global._pending2FA && global._pending2FA.username === username) {
        code = global._pending2FA.code;
        delete global._pending2FA;
        break;
      }
      await randomDelay(2000, 2500);
    }

    if (!code) {
      log("[ERROR] 2FA code not received in time");
      return { success: false, message: "2FA timeout" };
    }

    log(`[INFO] Entering 2FA code ${code}...`);
    await page.type(twoFASelector, code, { delay: 100 });
    await page.click('button[type="button"]');
    await randomDelay(5000, 7000);
  }

  // 7️⃣ Verify login success after possible 2FA
  const loggedInNow = await isVisible(page, PROFILE_ICON_SELECTOR, 6000);
  if (!loggedInNow) {
    log("[ERROR] Login uncertain — no profile icon visible");
    return { success: false, message: "Login uncertain" };
  }

  // 8️⃣ Save session and mark success
  const cookies = await getBrowserCookies();
  saveSession(username, cookies);
  setCurrentUser(username);
  log(`[SUCCESS] Logged in successfully and session saved (${username})`);

  return {
    success: true,
    message: "Login successful",
    user: username,
    proxy: getCurrentProxy(),
  };
}

// ------------------------------
// WATCHDOG (manual-only monitor)
// ------------------------------
setInterval(async () => {
  try {
    const page = getPage();
    if (!page || page.isClosed()) {
      log("[WATCHDOG] Page closed. Waiting for next manual login call...");
    }
  } catch (err) {
    log(`[WATCHDOG ERROR] ${err.message}`);
  }
}, 1000 * 60 * 5); // every 5 min
