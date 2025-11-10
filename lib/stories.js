// instagram-dashboard/lib/stories.js
import { getPage, getCurrentUser } from "./browser.js";
import { randomDelay } from "../utils/helpers.js";
import { log } from "../utils/log.js";

// === RANDOM DELAY CONSTANTS ===
const HOME_LOAD_MIN = 3000;
const HOME_LOAD_MAX = 5000;
const FIRST_STORY_RETRY_MIN = 3000;
const FIRST_STORY_RETRY_MAX = 5000;
const STORY_INITIAL_WAIT_MIN = 15000; // ↑ longer watch time
const STORY_INITIAL_WAIT_MAX = 25000;
const ARROW_CLICK_MIN = 2;
const ARROW_CLICK_MAX = 5;
const ARROW_DELAY_MIN = 7000; // ↑ slower transitions
const ARROW_DELAY_MAX = 15000;
const CROSS_CLICK_DELAY_MIN = 3000;
const CROSS_CLICK_DELAY_MAX = 6000;
const SCROLL_MIN = 3;
const SCROLL_MAX = 6;
const SCROLL_DELAY_MIN = 6000; // ↑ more human delays
const SCROLL_DELAY_MAX = 12000;
const MIN_LIKES_PER_CYCLE = 1;
const MAX_LIKES_PER_CYCLE = 2;
const LIKE_DELAY_MIN = 4000;
const LIKE_DELAY_MAX = 10000;

// === CONTROLS / LOCKS ===
let storyViewing = false;
let resilientRunning = false; // ensure only one resilient loop runs
let actionMutex = false; // serialize actions (scroll/like/view)
let navLock = false; // block if navigation in progress
let lastHomepageLog = 0;
const HOMEPAGE_LOG_DEBOUNCE_MS = 2000; // avoid spamming "Already on homepage"

// === HELPER FUNCTIONS ===
async function safeClick(elementHandle, tries = 2) {
  if (!elementHandle) return false;
  try {
    // ensure element is attached and visible
    const attached = await elementHandle.evaluate((el) => {
      return !!el && el.isConnected && typeof el.getBoundingClientRect === "function";
    }).catch(() => false);

    if (!attached) return false;

    // scroll into view
    await elementHandle.evaluate((el) => {
      if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
    });

    // small wait so element layout stabilizes
    await randomDelay(150, 350);

    // final click attempt
    await elementHandle.click({ delay: 150 + Math.random() * 200 });
    return true;
  } catch (e) {
    log(`[WARN] safeClick failed: ${e.message}`);
    if (tries > 1) {
      await randomDelay(300, 700);
      return safeClick(elementHandle, tries - 1);
    }
  }
  return false;
}

async function safeGoto(page, url, maxRetries = 3) {
  // prevent starting a new navigation if another is in progress
  while (navLock) {
    await randomDelay(200, 400);
  }
  navLock = true;

  try {
    let attempt = 0;
    let backoff = 500;
    while (attempt < maxRetries) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        navLock = false;
        return true;
      } catch (e) {
        // treat aborts and network glitches with retry/backoff
        log(`[WARN] Navigation error (attempt ${attempt + 1}): ${e.message}`);
        attempt++;
        await randomDelay(backoff, backoff + 300);
        backoff *= 2;
      }
    }
    // final attempt without throwing
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      navLock = false;
      return true;
    } catch (e) {
      log(`[ERROR] Final navigation attempt failed: ${e.message}`);
      navLock = false;
      return false;
    }
  } finally {
    navLock = false;
  }
}

async function navigateToHomepage(page) {
  const currentUrl = page.url();
  try {
    const urlObj = new URL(currentUrl);
    if (urlObj.hostname.includes("instagram.com") && urlObj.pathname === "/") {
      // debounce repeated logs
      const now = Date.now();
      if (now - lastHomepageLog > HOMEPAGE_LOG_DEBOUNCE_MS) {
        log("[INFO] Already on homepage.");
        lastHomepageLog = now;
      }
      return;
    }
  } catch {
    log("[WARN] Invalid current URL. Forcing navigation.");
  }
  log("[INFO] Navigating to Instagram homepage...");
  await safeGoto(page, "https://www.instagram.com");
  await randomDelay(HOME_LOAD_MIN, HOME_LOAD_MAX);
}

// === ACTION HELPERS ===
async function withActionLock(fn) {
  // if another action is running, wait briefly (prevents overlap)
  const start = Date.now();
  while (actionMutex) {
    if (!storyViewing) return; // bail if stopped while waiting
    await randomDelay(100, 250);
    // avoid deadlock: if waited too long, log and proceed
    if (Date.now() - start > 15000) {
      log("[WARN] action lock waited >15s, continuing.");
      break;
    }
  }

  actionMutex = true;
  try {
    await fn();
  } catch (e) {
    log(`[ERROR] Action failed: ${e.message}`);
  } finally {
    actionMutex = false;
  }
}

async function scrollFeed(page) {
  await withActionLock(async () => {
    const scrollTimes =
      Math.floor(Math.random() * (SCROLL_MAX - SCROLL_MIN + 1)) + SCROLL_MIN;
    log(`[INFO] 🧍 Human-like scrolling ${scrollTimes} times...`);

    for (let i = 0; i < scrollTimes; i++) {
      if (!storyViewing) return;

      // if navigation in progress, wait
      while (navLock) {
        await randomDelay(200, 500);
      }

      await page.evaluate(() => {
        const randomOffset = window.innerHeight * (0.7 + Math.random() * 0.6);
        window.scrollBy({ top: randomOffset, behavior: "smooth" });
      }).catch((e) => log(`[WARN] scroll eval failed: ${e.message}`));

      await randomDelay(SCROLL_DELAY_MIN, SCROLL_DELAY_MAX);
      if (Math.random() < 0.25) await randomDelay(2000, 4000); // micro pauses
    }
  });
}

async function likeRandomPosts(page) {
  await withActionLock(async () => {
    // find posts with multiple candidate class patterns (fallback)
    let posts = [];
    try {
      posts = await page.$$("div._aagu");
      if (!posts.length) posts = await page.$$("article"); // fallback
    } catch (e) {
      log(`[WARN] post selector search failed: ${e.message}`);
    }

    if (posts.length === 0) return log("[INFO] No posts found.");

    const numToLike =
      Math.min(posts.length, Math.floor(Math.random() * 2) + 1) ||
      MIN_LIKES_PER_CYCLE;

    log(`[INFO] ❤️ Liking ${numToLike} posts slowly...`);

    for (let i = 0; i < numToLike; i++) {
      if (!storyViewing) return;
      const randomPost = posts[Math.floor(Math.random() * posts.length)];

      try {
        // verify handle is ok
        const attached = await randomPost.evaluate((el) => el.isConnected).catch(() => false);
        if (!attached) continue;

        // simulate double tap via dispatched events on the post container
        await randomPost.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const evt1 = new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y });
          const evt2 = new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y });
          const evtDbl = new MouseEvent("dblclick", { bubbles: true, clientX: x, clientY: y });
          el.dispatchEvent(evt1);
          el.dispatchEvent(evt2);
          el.dispatchEvent(evtDbl);
        }).catch((e) => log(`[WARN] double-tap evaluate failed: ${e.message}`));

        await randomDelay(LIKE_DELAY_MIN, LIKE_DELAY_MAX);

        // if accidentally navigated, try to recover
        if (!page.url().includes("instagram.com")) {
          log("[WARN] ⚠️ Navigation detected while liking, returning...");
          try {
            await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 });
            await randomDelay(3000, 6000);
          } catch (e) {
            log(`[WARN] goBack failed: ${e.message}`);
            await safeGoto(page, "https://www.instagram.com");
          }
        }
      } catch (e) {
        log(`[WARN] Failed to like post: ${e.message}`);
      }
    }
  });
}

async function viewStories(page) {
  await withActionLock(async () => {
    log("[INFO] 👁️ Viewing stories slowly...");

    // ✅ always reload homepage to ensure stories visible at top
    await navigateToHomepage(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await randomDelay(2000, 4000); // small wait for feed load

    // try a few robust selectors and wait for one to appear
    const selectors = [
      "ul li._acaz",
      'li[role="listitem"] a[href*="/stories/"]',
      'div[role="presentation"]',
      'section div a[href*="/stories/"]'
    ];

    let stories = [];
    for (const sel of selectors) {
      try {
        await page.waitForSelector(sel, { timeout: 1200 }).catch(() => null);
        const found = await page.$$(sel);
        if (found && found.length) {
          stories = found;
          break;
        }
      } catch (e) {}
    }

    if (!stories.length) return log("[WARN] No stories found.");

    const firstStory = stories[Math.floor(Math.random() * stories.length)];
    if (!(await safeClick(firstStory))) {
      log("[WARN] safeClick on story failed.");
      return;
    }

    const waitTime =
      Math.floor(
        Math.random() * (STORY_INITIAL_WAIT_MAX - STORY_INITIAL_WAIT_MIN + 1)
      ) + STORY_INITIAL_WAIT_MIN;

    log(`[INFO] Watching first story for ${(waitTime / 1000).toFixed(1)}s...`);
    await randomDelay(waitTime, waitTime + 3000);

    const nextClicks =
      Math.floor(Math.random() * (ARROW_CLICK_MAX - ARROW_CLICK_MIN + 1)) +
      ARROW_CLICK_MIN;

    for (let i = 0; i < nextClicks; i++) {
      if (!storyViewing) return;
      const nextBtn = await page.$('svg[aria-label="Next"]');
      if (!(await safeClick(nextBtn))) break;
      await randomDelay(ARROW_DELAY_MIN, ARROW_DELAY_MAX);
    }

    const closeSelectors = ['svg[aria-label="Close"]', 'button[aria-label="Close"]', 'button._a9--'];
    let closed = false;
    for (const cs of closeSelectors) {
      const btn = await page.$(cs);
      if (btn && (await safeClick(btn))) {
        await randomDelay(CROSS_CLICK_DELAY_MIN, CROSS_CLICK_DELAY_MAX);
        closed = true;
        log("[INFO] Closed story smoothly.");
        break;
      }
    }
    if (!closed) log("[WARN] Close button not found.");
  });
}


// === STABLE STORY LOOP ===
async function storyLoop() {
  const page = getPage();
  if (!page) {
    log("[ERROR] No browser/page found.");
    storyViewing = false;
    return;
  }

  while (storyViewing) {
    try {
      await navigateToHomepage(page);

      const actions = [
        () => scrollFeed(page),
        () => likeRandomPosts(page),
        () => viewStories(page),
      ];

      // shuffle actions
      actions.sort(() => Math.random() - 0.5);

      for (const action of actions) {
        if (!storyViewing) return;
        // ensure navLock is clear before starting an action
        while (navLock) await randomDelay(100, 300);
        await action();
      }

      // break between full cycles (human-like)
      await randomDelay(10000, 20000);
    } catch (err) {
      log(`[ERROR] Story loop crashed: ${err.message}`);
      // try to recover to homepage with a backoff
      try {
        await safeGoto(page, "https://www.instagram.com");
      } catch {}
      await randomDelay(FIRST_STORY_RETRY_MIN, FIRST_STORY_RETRY_MAX);
    }
  }

  try {
    const page = getPage();
    if (page) await safeGoto(page, "https://www.instagram.com");
  } catch {}
  log("[INFO] Story loop stopped.");
}

// === RESILIENT LOOP (single instance) ===
async function resilientLoop() {
  if (resilientRunning) {
    // already running (shouldn't happen but keep safe)
    return;
  }
  resilientRunning = true;

  try {
    // keep running as long as storyViewing is true
    while (storyViewing) {
      try {
        await storyLoop();
      } catch (e) {
        log(`[CRASH] Story loop failed: ${e.message}. Restarting...`);
      }
      // small adaptive delay to avoid busy spin
      await randomDelay(4000, 6000);
    }
  } finally {
    resilientRunning = false;
  }
}

// === CONTROL API ===
export async function toggleStoryViewing(status) {
  if (!getCurrentUser()) {
    return { success: false, error: "No user logged in." };
  }

  if (status === "start") {
    if (storyViewing) return { success: false, message: "Already running." };
    storyViewing = true;
    log("[INFO] Story viewing started (resilient loop active).");
    // only start resilient loop once and non-blocking
    resilientLoop().catch((e) => log(`[ERROR] resilientLoop top-level: ${e.message}`));
    return { success: true, message: "Story viewing started safely." };
  }

  if (status === "stop") {
    storyViewing = false;
    log("[INFO] Story viewing stopped.");
    return { success: true, message: "Stopped automation." };
  }

  return { success: false, error: "Invalid command." };
}
