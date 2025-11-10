import { getPage, getCurrentUser } from "./browser.js";
import { randomDelay, typeLikeHuman } from "../utils/helpers.js";
import { log } from "../utils/log.js";
import { likeLatestPosts, followUser } from "./action.js";

// ------------------------------------
// Utility: Check if selector is visible
// ------------------------------------
async function isVisible(page, selector, timeout = 5000) {
  try {
    await page.waitForSelector(selector, { visible: true, timeout });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------
// Utility: Safe Click with Retries
// ------------------------------------
async function safeClick(page, selector, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.waitForSelector(selector, { visible: true, timeout: 5000 });
      const el = await page.$(selector);
      if (el) {
        await el.click({ delay: 100 });
        await randomDelay(1000, 2000);
        return true;
      }
    } catch (e) {
      log(`[WARN] Retry ${i + 1}/${retries} for ${selector}: ${e.message}`);
      await randomDelay(1000, 2000);
    }
  }
  return false;
}

// ------------------------------------
// Selectors
// ------------------------------------
const SELECTORS = {
  PUBLIC_MESSAGE_BTN: "div[role='button'][tabindex='0']",
  OPTIONS_BTN: "svg[aria-label='Options']",
  MESSAGE_INPUT:
    "div[role='textbox'][aria-placeholder='Message...'][contenteditable='true']",
};

// ------------------------------------
// Step 1️⃣: Detect if user exists
// 🧠 Function: Detect if Instagram user/profile is unavailable
async function isUserNotFound(page) {
  try {
    // ⏳ Manual small delay for DOM to load (safe for all Puppeteer versions)
    await new Promise((res) => setTimeout(res, 1500));

    // ✅ Check both text content and visible elements
    const userNotFound = await page.evaluate(() => {
      const bodyText = document.body?.innerText || "";

      // Case 1️⃣: Old unavailable page
      if (bodyText.includes("Sorry, this page isn't available")) return true;

      // Case 2️⃣: New-style error box
      const spans = Array.from(document.querySelectorAll("span"));
      return spans.some((el) => {
        const txt = el.innerText.trim();
        return (
          txt === "Profile isn't available" ||
          txt.includes(
            "The link may be broken, or the profile may have been removed."
          )
        );
      });
    });

    if (userNotFound) {
      log("[WARN] ⚠️ Profile not available — may be deleted or private.");
      return true; // stops flow
    }

    return false;
  } catch (err) {
    log("[WARN] ⚠️ Failed to check if user exists:", err.message);
    return false;
  }
}

// ------------------------------------
async function tryPublicMessageFlow(page) {
  try {
    log("[FLOW: PUBLIC] Looking for 'Message' button...");
    await page.waitForSelector("main", { visible: true, timeout: 15000 });
    await randomDelay(2000, 3000);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const buttons = await page.$$("div[role='button']");
      for (const btn of buttons) {
        try {
          const text = await page.evaluate(
            (el) => el.innerText?.trim().toLowerCase() || "",
            btn
          );
          if (text.includes("message")) {
            await btn.click({ delay: 100 });
            log(
              `[DEBUG] ✅ Clicked Public Message button (attempt ${attempt}).`
            );
            await randomDelay(3000, 5000);
            return true;
          }
        } catch {}
      }
      log(`[WARN] Retry ${attempt}/3 — 'Message' button not found yet.`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await randomDelay(3000, 4000);
    }
  } catch (err) {
    log(`[ERROR] Public message flow failed: ${err.message}`);
  }

  log("[WARN] 'Message' button not found — trying Options flow...");
  return false;
}

// ------------------------------------
// Step 3️⃣: Try Options → Send Message flow
// ------------------------------------
async function tryOptionsFlow(page) {
  try {
    log("[FLOW: OPTIONS] Searching for Options button...");

    if (!(await safeClick(page, SELECTORS.OPTIONS_BTN, 2))) {
      log("[WARN] Options button not found.");
      return false;
    }

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const clicked = await page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll("button, div[role='button'], a")
        );
        const target = candidates.find((el) => {
          const txt = el.innerText?.trim().toLowerCase();
          return txt === "send message" || txt.includes("send message");
        });
        if (target) {
          target.click();
          return true;
        }
        return false;
      });

      if (clicked) {
        log(`[DEBUG] ✅ Clicked 'Send Message' option (attempt ${attempt}).`);
        await randomDelay(2500, 4000);
        return true;
      }

      log(`[WARN] Retry finding 'Send message' (attempt ${attempt})...`);
      await randomDelay(800, 1500);
    }
  } catch (err) {
    log(`[ERROR] Options flow failed: ${err.message}`);
  }

  log("[WARN] ⚠️ 'Send message' not found after trying Options.");
  return false;
}

// 🧠 Function: checkIfMessageAlreadySent
async function checkIfMessageAlreadySent(page, message) {
  try {
    // wait briefly for messages to settle
    await new Promise((res) => setTimeout(res, 700));

    // extract visible message texts, but only last 40 to keep it fast
    const messages = await page.$$eval('div[role="none"] span', (spans) => {
      const arr = spans.map((s) => s.innerText?.trim()).filter(Boolean);
      return arr.slice(-40); // last 40 messages
    });

    const normalizedTarget = message.trim().toLowerCase().replace(/\s+/g, " ");
    const already = messages.some((m) => {
      const norm = m.trim().toLowerCase().replace(/\s+/g, " ");
      return norm === normalizedTarget;
    });

    return already;
  } catch (err) {
    console.log("⚠️ Error checking previous message:", err.message);
    return false;
  }
}

async function handleNotificationPopup(page) {
  try {
    // brief pause for popup to appear if it will
    await new Promise((res) => setTimeout(res, 600));

    const popupDetected = await page.evaluate(() => {
      // look for headings/text that indicate the "Turn on Notifications" modal
      const heading = Array.from(
        document.querySelectorAll("h2, h3, h4, span, div")
      )
        .map((el) => el.innerText?.trim())
        .find(
          (txt) => txt && txt.toLowerCase().includes("turn on notifications")
        );
      return !!heading;
    });

    if (!popupDetected) {
      // fallback: sometimes the modal uses slightly different text
      const alt = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("span, div, button"))
          .map((el) => el.innerText?.trim()?.toLowerCase())
          .some(
            (txt) =>
              txt &&
              (txt.includes("turn on notifications") ||
                txt.includes("notifications"))
          );
      });
      if (!alt) {
        // no popup found
        // console.log("✅ No notification popup found — continuing...");
        return;
      }
    }

    // Click a button whose text equals "Not Now" (case-insensitive) or contains "not now"
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('button, div[role="button"], a')
      );
      const target = buttons.find((b) => {
        const txt = b.innerText?.trim()?.toLowerCase() || "";
        return txt === "not now" || txt.includes("not now");
      });
      if (target) {
        target.click();
        return true;
      }
      return false;
    });

    if (clicked) {
      // small DOM stabilization pause
      await new Promise((res) => setTimeout(res, 700));
      // console.log("📩 Notification popup detected — clicked Not Now.");
    } else {
      // If not found by button text, optionally try the class fallback (last resort)
      const fallback = await page.$("button._a9--._ap36._a9_1").then(Boolean);
      if (fallback) {
        await page.click("button._a9--._ap36._a9_1").catch(() => {});
        await new Promise((res) => setTimeout(res, 700));
      }
    }
  } catch (err) {
    console.log("⚠️ Error while handling notification popup:", err.message);
  }
}

// ------------------------------------
// Step 4️⃣: Type and send the message safely (Ultra Stable 24/7)
// ------------------------------------
async function sendMessage(page, message, sender, receiver) {
  log("[INFO] Checking if messaging is allowed...");
  await randomDelay(2000, 3500);

  try {
    // 🧩 Handle “Turn on Notifications” popup safely
    await handleNotificationPopup(page);

    // 🔒 Privacy check
    const restricted = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll("span"));
      return spans.some(
        (el) =>
          el.innerText.trim() === "Not everyone can message this account." ||
          el.innerText.trim().includes("You can’t message this account.")
      );
    });

    if (restricted) {
      log(`[WARN] ⚠️ ${receiver} cannot be messaged (privacy restrictions).`);
      return { success: false, error: "User does not allow messages." };
    }

    // ✉️ Locate message box
    let input = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const found = await isVisible(page, SELECTORS.MESSAGE_INPUT, 8000);
      if (found) {
        input = await page.$(SELECTORS.MESSAGE_INPUT);
        if (input) break;
      }
      log(`[WARN] Message box not found (attempt ${attempt}) — retrying...`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await randomDelay(2000, 3000);
    }

    if (!input) {
      log("[ERROR] ❌ Message input not found.");
      return { success: false, error: "Message input not found." };
    }

    // 🧠 Optional: skip if same message already exists
    const alreadySent = await checkIfMessageAlreadySent(page, message);
    if (alreadySent) {
      log(`[INFO] ⚠️ Message already sent to ${receiver} — skipping.`);
      return { success: false, error: "Message already exists — skipped." };
    }

    // 💬 Type and send message
    await input.click({ delay: 100 });
    await typeLikeHuman(page, SELECTORS.MESSAGE_INPUT, message);
    await randomDelay(800, 1500);
    await page.keyboard.press("Enter");

    // 🕒 Small delay just to make sure DOM updates
    await randomDelay(2000, 3000);

    // ✅ Log and move forward — no confirmation spam
    log(`[SUCCESS] ✅ Message sent from ${sender} ➜ ${receiver}`);
    return { success: true };
  } catch (err) {
    if (
      err.message.includes("detached frame") ||
      err.message.includes("Execution context")
    ) {
      log("[WARN] ⚠️ Frame detached — recovering...");
      await randomDelay(3000, 5000);
      await page.reload({ waitUntil: "domcontentloaded" });
      return { success: false, error: "Frame detached — recovered." };
    }

    log(`[ERROR] sendMessage() failed for ${receiver}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ------------------------------------
// Main Function — Stable 24/7 Runner
// ------------------------------------
// ------------------------------------
export async function sendInstagramMessage(username, message) {
  const page = getPage();
  const currentUser = getCurrentUser();

  if (!page) {
    log("[ERROR] ❌ Browser not initialized.");
    return { success: false, error: "Browser not initialized." };
  }

  try {
    log(`[INFO] Navigating to profile: ${username}`);
    await page.goto(`https://www.instagram.com/${username}/`, {
      waitUntil: "networkidle2", // 🚀 Wait for full load
      timeout: 60000,
    });

    await page.waitForSelector("body", { timeout: 10000 });
    await randomDelay(3000, 5000);

    // 🚫 Check if user not found
    if (await isUserNotFound(page)) {
      log(`[WARN] ⚠️ User "${username}" not found or removed.`);
      return { success: false, error: "User not found or removed." };
    }

    // ❤️ Like recent posts
    await likeLatestPosts(page, 3);
    await randomDelay(2000, 4000);

    // ➕ Follow user and get current follow state
    const followResult = await followUser(page);
    await randomDelay(2000, 4000);

    // 🧭 Message flow logic based on follow state
    let dmOpened = false;

    if (followResult?.state === "requested") {
      // ✅ Private account with follow request sent → use options menu flow
      log("[FLOW] 📩 Requested state → using Options Message Flow...");
      dmOpened = await tryOptionsFlow(page);
    } else if (
      followResult?.state === "following" ||
      followResult?.state === "followed"
    ) {
      // ✅ Already following or just followed → try public message button
      log("[FLOW] 💬 Following user → trying Public Message Flow...");
      dmOpened = await tryPublicMessageFlow(page);

      // 🔁 Fallback to options if not found
      if (!dmOpened) {
        log("[FLOW] 🔁 Public message failed → trying Options Flow...");
        dmOpened = await tryOptionsFlow(page);
      }
    } else {
      // ❔ Unknown or not-followed state → fallback smartly
      log("[FLOW] ⚙️ Unknown follow state → trying both message flows...");
      dmOpened =
        (await tryPublicMessageFlow(page)) || (await tryOptionsFlow(page));
    }

    // ❌ DM could not open
    if (!dmOpened) {
      log("[WARN] ⚠️ Could not open DM interface.");
      return { success: false, error: "No valid DM button found." };
    }

    // ✉️ Send message
    const result = await sendMessage(page, message, currentUser, username);
    return result;
  } catch (err) {
    log(`[ERROR] Main sendInstagramMessage failed: ${err.message}`);
    await randomDelay(5000, 10000); // ⏳ Recovery delay
    return { success: false, error: err.message };
  }
}
