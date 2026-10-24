/**
 * Execute a policy action on the controlled browser with Playwright.
 * Shows overlay feedback (highlight + toast) on the page.
 */
import { HIGHLIGHT_MS } from "./constants.js";
import { describe } from "./policy.js";

const NAV_TIMEOUT = 15000;

const KEY_NAMES = {
  return: "Enter", enter: "Enter", escape: "Escape", tab: "Tab", space: "Space", delete: "Backspace", backspace: "Backspace",
  forwarddelete: "Delete", left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
};
const MOD_NAMES = { cmd: "ControlOrMeta", command: "ControlOrMeta", shift: "Shift", alt: "Alt", option: "Alt", opt: "Alt", ctrl: "Control", control: "Control" };

/** Helper key name + modifiers -> Playwright's `keyboard.press` string ("ControlOrMeta+Shift+Tab"). */
export function toPlaywrightKey(key, mods = []) {
  const k = KEY_NAMES[String(key).toLowerCase()] ?? (String(key).length === 1 ? String(key) : key);
  return [...mods.map((m) => MOD_NAMES[String(m).toLowerCase()] ?? m), k].join("+");
}

/** The only shortcuts that mean the same thing inside a page. */
const PAGE_SHORTCUTS = new Set(["copy", "cut", "paste", "select_all", "undo", "redo"]);

function locatorFor(page, id) {
  return page.locator(`[data-vb-id="${id}"]`).first();
}

async function settle(page, ms = 2500) {
  await Promise.race([page.waitForLoadState("domcontentloaded").catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
  await page.waitForTimeout(120);
}

/** Wait for a possible new tab after a click (target=_blank). */
async function maybeNewTab(browser, before) {
  await new Promise((r) => setTimeout(r, 400));
  const fresh = browser.pages.find((p) => !before.includes(p));
  if (fresh) await browser.setActive(fresh);
}

/**
 * @param {object} action  from policy.evaluatePolicy
 * @param {import('./browser.js').BrowserManager} browser
 * @returns {Promise<{ok: boolean, detail?: string}>}
 */
export async function execute(action, browser) {
  let page = await browser.ensurePage();
  const label = describe(action, browser.uiLang || "en");

  switch (action.type) {
    case "navigate_url": {
      await browser.overlay("toast", `→ ${label}`);
      if (action.newTab) {
        // Only when the user asked for it ("in una nuova scheda"): otherwise the current tab navigates.
        page = await browser.context.newPage();
        await browser.setActive(page);
      }
      const host = new URL(action.url).hostname.replace(/^www\./, "");
      try {
        await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      } catch (e) {
        // Transient network error or a site that never fires load: retry once, then accept if the
        // URL at least moved to the right host.
        await new Promise((r) => setTimeout(r, 500));
        await page.goto(action.url, { waitUntil: "commit", timeout: NAV_TIMEOUT }).catch(() => {});
        if (!page.url().includes(host)) throw e;
      }
      await settle(page, 800);
      return { ok: true, detail: page.url() };
    }

    case "click_element": {
      const before = [...browser.pages];
      await browser.overlay("clearCandidates");
      await browser.overlay("highlight", action.targetId, HIGHLIGHT_MS);
      await browser.overlay("toast", label);
      const loc = locatorFor(page, action.targetId);
      await new Promise((r) => setTimeout(r, 180)); // let the human see the highlight
      try {
        await loc.click({ timeout: 4000 });
      } catch {
        await loc.evaluate((el) => el.click());
      }
      await settle(page);
      await maybeNewTab(browser, before);
      return { ok: true, detail: browser.page.url() };
    }

    case "type_into_field": {
      await browser.overlay("clearCandidates");
      if (action.targetId) await browser.overlay("highlight", action.targetId, HIGHLIGHT_MS + 400);
      await browser.overlay("toast", label);
      if (!action.targetId) {
        // No field named: type wherever the keyboard focus is.
        await page.keyboard.type(action.text, { delay: 18 });
        if (action.submit) {
          await page.keyboard.press("Enter");
          await settle(page);
        }
        return { ok: true, detail: page.url() };
      }
      const loc = locatorFor(page, action.targetId);
      await loc.click({ timeout: 4000 }).catch(() => loc.focus());
      await loc.fill("").catch(() => {});
      await loc.pressSequentially(action.text, { delay: 18 }).catch(async () => loc.fill(action.text));
      if (action.submit) {
        await page.keyboard.press("Enter");
        await settle(page);
      }
      return { ok: true, detail: page.url() };
    }

    case "select_option": {
      await browser.overlay("highlight", action.targetId, HIGHLIGHT_MS);
      await browser.overlay("toast", label);
      const loc = locatorFor(page, action.targetId);
      // Match option by (case-insensitive, substring) label in code.
      const picked = await loc.evaluate((sel, wanted) => {
        const w = wanted.toLowerCase();
        const opts = Array.from(sel.options || []);
        const hit = opts.find((o) => o.label.toLowerCase() === w) || opts.find((o) => o.label.toLowerCase().includes(w));
        if (!hit) return null;
        sel.value = hit.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return hit.label;
      }, action.text);
      return { ok: Boolean(picked), detail: picked || "no matching option" };
    }

    case "press_enter":
      await browser.overlay("toast", "⏎ enter");
      await page.keyboard.press("Enter");
      await settle(page);
      return { ok: true, detail: page.url() };

    case "press_key": {
      await browser.overlay("toast", label);
      const combo = toPlaywrightKey(action.key, action.mods);
      for (let i = 0; i < Math.min(20, Math.max(1, action.count || 1)); i++) await page.keyboard.press(combo);
      await page.waitForTimeout(120);
      return { ok: true, detail: page.url() };
    }

    case "shortcut": {
      if (!PAGE_SHORTCUTS.has(action.id)) return { ok: false, detail: "not available in the browser window" };
      await browser.overlay("toast", label);
      await page.keyboard.press(`ControlOrMeta+${action.shift ? "Shift+" : ""}${action.char}`);
      return { ok: true, detail: page.url() };
    }

    case "calculate":
      // The result is computed in code (math.js): showing it is the whole job in a browser window.
      await browser.overlay("toast", action.label, 4000);
      return { ok: true, detail: action.label };

    case "window_op":
    case "clear_field":
    case "volume":
    case "quit_app":
    case "send_keys":
      return { ok: false, detail: "desktop mode only" };

    case "scroll_down":
    case "scroll_up": {
      const dir = action.type === "scroll_down" ? 1 : -1;
      await browser.overlay("toast", label);
      await page.evaluate(
        ([dir, amount]) => {
          const vh = window.innerHeight;
          if (amount === "end") {
            window.scrollTo({ top: dir > 0 ? document.documentElement.scrollHeight : 0, behavior: "smooth" });
          } else {
            const px = amount === "little" ? vh * 0.35 : vh * 0.85;
            window.scrollBy({ top: dir * px, behavior: "smooth" });
          }
        },
        [dir, action.amount || "page"],
      );
      await page.waitForTimeout(350);
      return { ok: true, detail: `scrollY=${await page.evaluate(() => Math.round(window.scrollY))}` };
    }

    case "go_back":
      await browser.overlay("toast", "← back");
      await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
      await settle(page, 800);
      return { ok: true, detail: page.url() };

    case "go_forward":
      await browser.overlay("toast", "→ forward");
      await page.goForward({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
      await settle(page, 800);
      return { ok: true, detail: page.url() };

    case "reload":
      await browser.overlay("toast", "↻ reload");
      await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
      return { ok: true, detail: page.url() };

    case "open_new_tab": {
      const p = await browser.context.newPage();
      await browser.setActive(p);
      await browser.overlay("toast", "new tab");
      return { ok: true, detail: `tabs=${browser.pages.length}` };
    }

    case "close_tab": {
      await page.close();
      if (browser.pages.length === 0) await browser.context.newPage();
      await browser.setActive(browser.page);
      return { ok: true, detail: `tabs=${browser.pages.length}` };
    }

    case "switch_tab": {
      const pages = browser.pages;
      if (pages.length < 2) return { ok: false, detail: "only one tab" };
      const i = pages.indexOf(browser.page);
      let next;
      // `position` is Cmd+<n> semantics: 1..8 is that tab, 9 is always the last one.
      const position = action.position ?? (action.direction === "first" ? 1 : null);
      if (position) {
        next = position === 9 ? pages[pages.length - 1] : pages[position - 1];
        if (!next) return { ok: false, detail: `no tab ${position}` };
      } else if (action.direction === "previous") next = pages[(i - 1 + pages.length) % pages.length];
      else next = pages[(i + 1) % pages.length];
      await browser.setActive(next);
      await browser.overlay("toast", "switched tab");
      return { ok: true, detail: next.url() };
    }

    default:
      return { ok: false, detail: `unknown action ${action.type}` };
  }
}
