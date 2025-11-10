import { randomDelay } from "../utils/helpers.js";
import { log } from "../utils/log.js";

// ------------------------------------
// ✅ Utility: Wait for post grid
// ------------------------------------
async function waitForPosts(page, timeout = 10000) {
  try {
    await page.waitForSelector("div._aagu", { timeout });
    return true;
  } catch (err) {
    log("[WARN] Post grid not found within timeout.");
    return false;
  }
}

// ------------------------------------
// ------------------------------------
// ❤️ Like only the first post safely
// ------------------------------------
export async function likeLatestPosts(page) {
  try {
    log("[ACTION] Checking for posts grid...");
    const gridVisible = await waitForPosts(page);

    if (!gridVisible) {
      log("[WARN] ⚠️ No post grid found — maybe private or no posts.");
      return false;
    }

    const posts = await page.$$("div._aagu");
    const totalPosts = posts.length;

    if (totalPosts === 0) {
      log("[WARN] ⚠️ No posts available to like.");
      return false;
    }

    // ✅ Only like the first post
    const postsToLike = 1;
    log(`[INFO] Found ${totalPosts} posts. Will like only the first one.`);

    try {
      log(`[INFO] Opening post 1/${postsToLike}`);
      await posts[0].click();

      await page.waitForSelector(
        'svg[aria-label="Like"], svg[aria-label="Unlike"]',
        { visible: true, timeout: 10000 }
      );

      await randomDelay(1500, 2500);

      const liked = await page.evaluate(async () => {
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));

        for (let attempt = 0; attempt < 6; attempt++) {
          const likeSvg = document.querySelector('svg[aria-label="Like"]');
          const unlikeSvg = document.querySelector('svg[aria-label="Unlike"]');

          // Already liked?
          if (unlikeSvg) return "already";

          if (likeSvg) {
            const btn =
              likeSvg.closest("button") ||
              likeSvg.closest('div[role="button"]') ||
              likeSvg.parentElement;

            if (btn) {
              btn.click();
              await delay(500);
              if (document.querySelector('svg[aria-label="Unlike"]')) {
                return true; // confirmed liked
              }
            }
          }
          await delay(500);
        }
        return false;
      });

      if (liked === "already") {
        log(`[INFO] 👍 Post already liked.`);
      } else if (liked) {
        log(`[SUCCESS] ❤️ Liked the first post.`);
      } else {
        log(`[WARN] ⚠️ Could not like the post.`);
      }

      await randomDelay(1500, 2500);
      await page.keyboard.press("Escape").catch(() => {});
      await randomDelay(2000, 3000);
    } catch (innerErr) {
      log(`[ERROR] First post failed: ${innerErr.message}`);
      await page.keyboard.press("Escape").catch(() => {});
      await randomDelay(1500, 2500);
    }

    log("[DONE] ✅ Finished liking the first post.");
    return true;
  } catch (err) {
    log(`[FATAL] likeLatestPosts crashed: ${err.message}`);
    return false;
  }
}

// ------------------------------------
// ➕ Follow user (if not already)
// ------------------------------------
export async function followUser(page) {
  try {
    log("[ACTION] Checking follow button...");

    await page.waitForSelector("header button, header div[role='button']", {
      visible: true,
      timeout: 8000,
    });

    const buttonText = await page.evaluate(() => {
      const btns = Array.from(
        document.querySelectorAll("header button, header div[role='button']")
      );
      const followBtn = btns.find((b) =>
        /follow|following|requested/i.test(b.innerText)
      );
      return followBtn ? followBtn.innerText.trim().toLowerCase() : null;
    });

    if (!buttonText) {
      log("[WARN] ⚠️ Follow button not found.");
      return { success: false, state: "not_found" };
    }

    if (buttonText.includes("following")) {
      log("[INFO] Already following this user.");
      return { success: true, state: "following" };
    }

    if (buttonText.includes("requested")) {
      log("[INFO] Follow request already sent. Will use option flow ✅");
      return { success: true, state: "requested" }; // 🔥 important for next flow
    }

    if (buttonText.includes("follow")) {
      const success = await page.evaluate(() => {
        const btn = Array.from(
          document.querySelectorAll("header button, header div[role='button']")
        ).find((b) => /follow/i.test(b.innerText));
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });

      if (success) {
        log("[SUCCESS] ✅ Followed the user.");
        await randomDelay(1500, 2500);
        return { success: true, state: "followed" };
      } else {
        log("[WARN] ⚠️ Follow click failed.");
        return { success: false, state: "click_failed" };
      }
    }

    log("[WARN] ⚠️ Unknown follow state.");
    return { success: false, state: "unknown" };
  } catch (err) {
    log(`[ERROR] followUser failed: ${err.message}`);
    return { success: false, state: "error" };
  }
}
