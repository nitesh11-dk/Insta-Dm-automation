import puppeteer from "puppeteer";
import { getProfilePath, randomDelay } from "../utils/helpers.js";
import { log } from "../utils/log.js";

// ---------- GLOBAL STATE ----------
let browser = null;
let page = null;
let currentUser = null;
let currentProxy = null;
let relaunching = false;
let isLaunching = false;

// ---------- GETTERS / SETTERS ----------
export const getPage = () => page;
export const getCurrentUser = () => currentUser;
export const getCurrentProxy = () => currentProxy;
export const setPage = (newPage) => (page = newPage);
export const setCurrentUser = (username) => (currentUser = username);
export const setCurrentProxy = (proxy) => (currentProxy = proxy);

// ---------- CORE LAUNCH FUNCTION ----------
export async function launchContext(username, session = null, proxyStr = null) {
  if (isLaunching) {
    log("[BLOCK] Launch attempt ignored — another launch already running.");
    return;
  }
  isLaunching = true;

  try {
    // Close any existing browser
    if (browser) {
      log("[INFO] Closing existing browser before relaunch...");
      await browser.close().catch(() => {});
      browser = null;
      page = null;
    }

    const userDataPath = getProfilePath(username);

    let launchOptions = {
      headless: false, // run headless for Docker
      defaultViewport: null,
      userDataDir: userDataPath,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, // important for Docker
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-infobars",
        "--disable-blink-features=AutomationControlled",
        "--disable-web-security",
        "--ignore-certificate-errors",
        "--ignore-certificate-errors-spki-list",
        "--window-size=1920,1080",
        "--start-maximized",
      ],
    };

    // --- Handle Proxy ---
    currentProxy = null;
    let usernameProxy, passwordProxy;
    if (proxyStr) {
      const parts = proxyStr.split(":");
      const [server, port] = parts;
      usernameProxy = parts[2];
      passwordProxy = parts[3];
      launchOptions.args.push(`--proxy-server=${server}:${port}`);
      log(`[INFO] Using proxy ${server}:${port} for ${username}`);
      currentProxy = proxyStr;
    }

    log(
      `[INFO] Launching browser for ${username} (persistent: ${userDataPath})`
    );
    browser = await puppeteer.launch(launchOptions);

    const pages = await browser.pages();
    page = pages.length > 0 ? pages[0] : await browser.newPage();

    // --- Proxy Authentication ---
    if (proxyStr && usernameProxy && passwordProxy) {
      try {
        await page.authenticate({
          username: usernameProxy,
          password: passwordProxy,
        });
        log("[INFO] Proxy authentication applied successfully.");
      } catch (err) {
        log(`[WARN] Proxy authentication failed: ${err.message}`);
      }
    }

    // --- Load Session ---
    if (session?.length) {
      try {
        log("[INFO] Applying saved session cookies...");
        await page.setCookie(...session);
      } catch (err) {
        log(`[WARN] Failed to apply cookies: ${err.message}`);
      }
    }

    // --- Navigate & Validate ---
    await page.goto("https://www.instagram.com", {
      waitUntil: "domcontentloaded",
      timeout: 45000, // ⏳ increased to 45 seconds
    });

    // 👇 Adaptive proxy handling
    const delayTime = proxyStr ? 4000 : 1000; // slow proxies get extra delay
    log(`[INFO] Waiting ${delayTime}ms to stabilize proxy network...`);
    await new Promise((r) => setTimeout(r, delayTime));

    // --- Verify login page loaded ---
    try {
      await page.waitForSelector(
        'input[name="username"], input[name="email"]',
        {
          timeout: 20000, // was 8s → now 20s
        }
      );
      log("[INFO] Instagram login fields detected successfully.");
    } catch (err) {
      log("[WARN] Login input not found yet — retrying once...");
      await page.waitForTimeout(5000);
      try {
        await page.waitForSelector(
          'input[name="username"], input[name="email"]',
          {
            timeout: 15000,
          }
        );
        log("[INFO] Fields appeared after retry ✅");
      } catch (err2) {
        log(
          "[ERROR] Login inputs still not found after retry. Proxy might be too slow."
        );
      }
    }

    // Frame safety check
    if (page.mainFrame().isDetached()) {
      log("[ERROR] Frame detached immediately after navigation!");
      throw new Error("Main frame detached");
    }

    setCurrentUser(username);
    log(`[READY] Browser launched successfully for ${username}`);

    // --- Handle unexpected disconnections ---
    browser.on("disconnected", async () => {
      if (!relaunching && !isLaunching) {
        log("[ALERT] Browser disconnected — restarting...");
        await restartBrowser(username, session, proxyStr);
      }
    });
  } catch (err) {
    log(`[ERROR] Failed to launch browser for ${username}: ${err.message}`);
    await restartBrowser(username, session, proxyStr);
  } finally {
    isLaunching = false;
  }
}

// ---------- COOKIE HANDLER ----------
export async function getBrowserCookies() {
  try {
    if (!page || page.isClosed()) {
      log("[WARN] getBrowserCookies: page unavailable.");
      return [];
    }
    if (page.mainFrame().isDetached()) {
      log("[WARN] getBrowserCookies: frame detached, skipping.");
      return [];
    }
    return await page.cookies();
  } catch (err) {
    log(`[ERROR] Failed to get cookies: ${err.message}`);
    return [];
  }
}

// ---------- AUTO-RECOVERY / RESTART ----------
async function restartBrowser(username, session, proxyStr) {
  if (isLaunching || relaunching) {
    log("[BLOCK] Restart ignored — another relaunch in progress.");
    return;
  }

  relaunching = true;
  try {
    log("[RECOVERY] Attempting to restart browser...");
    await randomDelay(2000, 4000);
    await launchContext(username, session, proxyStr);
    log("[RECOVERY] Browser restarted successfully.");
  } catch (err) {
    log(`[FATAL] Restart failed: ${err.message}. Retrying in 10s...`);
    setTimeout(() => restartBrowser(username, session, proxyStr), 10000);
  } finally {
    relaunching = false;
  }
}

// ---------- HEALTH CHECK / WATCHDOG ----------
// setInterval(async () => {
//   try {
//     if (!browser || !page || page.isClosed()) {
//       log("[WATCHDOG] Browser/page inactive — attempting recovery...");
//       if (currentUser) {
//         await restartBrowser(currentUser, null, currentProxy);
//       } else {
//         log("[WATCHDOG] No active user context — skipping recovery.");
//       }
//     } else if (page.mainFrame().isDetached()) {
//       log("[WATCHDOG] Frame detached — restarting...");
//       await restartBrowser(currentUser, null, currentProxy);
//     } else {
//       log("[WATCHDOG] Browser healthy ✅");
//       log("✅ Puppeteer heartbeat alive");
//     }
//   } catch (err) {
//     log(`[WATCHDOG ERROR] ${err.message}`);
//   }
// }, 1000 * 60 * 5); // every 5 minutes

// ---------- GRACEFUL SHUTDOWN ----------
process.on("SIGINT", async () => {
  log("[SYSTEM] Graceful shutdown signal received. Closing browser...");
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
