/**
 * Desktop mode: the same Controller / Jev / policy pipeline, pointed at the whole Mac instead of
 * one Playwright page.
 *
 *  - `DesktopManager` has the surface the controller expects from BrowserManager (snapshot,
 *    overlay, tabInfo, currentUrl, onChange) and talks to the native helper (native/helper.swift)
 *    over JSON lines. The helper also owns the global hotkey and the microphone; its transcripts
 *    arrive here as "transcript" events.
 *  - `executeDesktop` is the desktop counterpart of executor.js.
 */
import { EventEmitter } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  HIGHLIGHT_MS,
  HOTKEY,
  MAX_APPS,
  CANDIDATE_TTL_MS,
  DEFAULT_LOCALE,
  DESKTOP_WAIT,
  VOLUME_STEP,
  MAX_REPEAT,
  CALCULATOR_APP_NAMES,
  CONTINUATION_WORDS,
  VERB_ONLY_WORDS,
  SILENCE_SHORT_MS,
  SILENCE_LONG_MS,
  RECOGNITION_HINTS,
  UI_TEXT,
} from "./constants.js";
import { compactElements, findSearchBox, detectSite, isBrowserApp } from "./snapshot.js";
import { uiLang } from "./locale.js";
import { describe } from "./policy.js";

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NATIVE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "native");
const HELPER_BIN = path.join(NATIVE_DIR, ".build", "vb-helper");

/** Compile the Swift helper when it is missing or older than its sources. */
export async function ensureHelper() {
  const sources = ["helper.swift", "Info.plist"].map((f) => path.join(NATIVE_DIR, f));
  const builtAt = fs.existsSync(HELPER_BIN) ? fs.statSync(HELPER_BIN).mtimeMs : 0;
  if (builtAt >= Math.max(...sources.map((f) => fs.statSync(f).mtimeMs))) return HELPER_BIN;
  console.log("building the native helper (first run only, a few seconds)…");
  fs.mkdirSync(path.dirname(HELPER_BIN), { recursive: true });
  try {
    // The Info.plist is embedded so macOS has the usage strings for the mic / speech prompts.
    await execFileP("swiftc", [
      "-O", "-swift-version", "5", sources[0], "-o", HELPER_BIN,
      "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", sources[1],
    ]);
  } catch (err) {
    throw new Error(`could not build the native helper — are the Xcode command line tools installed (xcode-select --install)?\n${err.stderr || err.message}`);
  }
  return HELPER_BIN;
}

const APP_DIRS = ["/Applications", "/System/Applications", path.join(os.homedir(), "Applications"), "/System/Applications/Utilities", "/Applications/Utilities"];

/** Names of the installed applications (the options of Jev's `app` question). */
export function listApps(dirs = APP_DIRS, max = MAX_APPS) {
  const names = dirs === APP_DIRS ? ["Finder"] : []; // lives in CoreServices, not in an Applications folder
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const name = entry.endsWith(".app") ? entry.slice(0, -4) : null;
      if (name && name !== "none" && !names.includes(name)) names.push(name);
    }
  }
  return names.slice(0, max);
}

/**
 * Helper snapshot -> the snapshot shape the controller, jev.js and policy.js work with.
 * `web` marks elements inside the page (AXWebArea): in a browser only those can be "the page's
 * search box", never the address bar or toolbar.
 */
export function buildDesktopSnapshot(raw, apps = [], { appAliases = {}, defaultBrowser = null } = {}) {
  const rawElements = (raw.elements || []).map((e) => ({ ...e, inViewport: true }));
  const onWeb = /^https?:/i.test(raw.url || "");
  const browser = raw.browser ?? isBrowserApp({ app: raw.app, bundle: raw.bundle });
  // In a browser, elements outside the page (address bar, tab strip, toolbar) are tagged so Jev can tell
  // "the search box" (the page's) from "the address bar" (the browser's).
  const toolbarIds = new Set(browser ? rawElements.filter((e) => e.web === false).map((e) => e.id) : []);
  const elements = compactElements(rawElements, { preferWeb: browser }).map((e) => (toolbarIds.has(e.id) ? { ...e, toolbar: true } : e));
  return {
    desktop: true,
    browser,
    app: raw.app || "",
    bundle: raw.bundle || "",
    title: raw.title || "",
    // Not a real URL outside a browser, but it identifies "where we are" the same way: the
    // controller compares it before / after an action to tell whether the action led somewhere.
    url: onWeb ? raw.url : `app://${raw.app || ""}/${raw.title || ""}`,
    site: onWeb ? detectSite(raw.url) : "generic",
    searchBoxId: findSearchBox(rawElements, { webOnly: browser }),
    elements,
    rawById: Object.fromEntries(rawElements.map((e) => [e.id, e])),
    apps,
    appAliases,
    defaultBrowser,
    tabs: [],
    ...(raw.error ? { error: raw.error } : {}),
  };
}

export class DesktopManager extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.apps = [];
    this.last = null; // most recent snapshot
    this.lastAt = 0;
    this.appAliases = {}; // bundle-dir name -> localized display name ("Calculator" -> "Calcolatrice")
    this.lang = DEFAULT_LOCALE;
    this.uiLang = "en";
    this.pending = new Map(); // request id -> {resolve, reject, timer}
    this.nextId = 1;
  }

  async launch({ hotkey = HOTKEY, lang = DEFAULT_LOCALE } = {}) {
    const bin = await ensureHelper();
    this.lang = lang;
    this.uiLang = uiLang(lang);
    this.apps = listApps();
    this.proc = spawn(bin, ["--hotkey", hotkey, "--lang", lang], { stdio: ["pipe", "pipe", "inherit"] });
    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => this._onLine(line));
    this.proc.on("exit", (code) => {
      for (const p of this.pending.values()) p.reject(new Error("native helper exited"));
      this.pending.clear();
      if (!this.closing) this.emit("exit", code);
    });
    let startTimer;
    const ready = await new Promise((resolve, reject) => {
      this.once("ready", resolve);
      this.proc.once("error", reject);
      startTimer = setTimeout(() => reject(new Error("native helper did not start")), 8000);
    }).finally(() => clearTimeout(startTimer));
    await this._configure();
    return ready;
  }

  /**
   * Post-start setup, all non-fatal (an older helper just keeps its defaults): the end-of-utterance
   * tuning and mic strings, the localized app names, and the recognizer hints (site / app names
   * are rare words for a speech recognizer).
   */
  async _configure() {
    const ui = UI_TEXT[this.uiLang] || UI_TEXT.en;
    const [apps] = await Promise.all([
      this.call("apps", { dirs: APP_DIRS }).catch(() => null),
      this.call("config", {
        continuationWords: [...CONTINUATION_WORDS],
        verbOnlyWords: [...VERB_ONLY_WORDS],
        silenceShortMs: SILENCE_SHORT_MS,
        silenceLongMs: SILENCE_LONG_MS,
        listening: ui.listening,
        micOff: ui.micOff,
      }).catch(() => {}),
    ]);
    for (const a of apps?.apps || []) if (a.display && a.display !== a.name) this.appAliases[a.name] = a.display;
    this.defaultBrowser = apps?.defaultBrowser || null;
    const words = [...new Set([...RECOGNITION_HINTS, ...Object.values(this.appAliases), ...this.apps])];
    await this.call("hints", { words: words.slice(0, 100) }).catch(() => {});
  }

  /** Switch the recognizer language live (the helper keeps its old one when the new one is unavailable). */
  async setLang(locale) {
    await this.call("lang", { locale });
    this.lang = locale;
    this.uiLang = uiLang(locale);
    const ui = UI_TEXT[this.uiLang] || UI_TEXT.en;
    await this.call("config", { listening: ui.listening, micOff: ui.micOff }).catch(() => {});
  }

  /** Frontmost app / window title / url, cheap (no tree walk). */
  probe() {
    return probe(this);
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.event) {
      this.emit(msg.event, msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result || {});
    else p.reject(new Error(msg.error || "helper error"));
  }

  /** Send one command to the helper and wait for its reply. */
  call(cmd, args = {}, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.exitCode !== null) return reject(new Error("native helper is not running"));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`helper timeout on ${cmd}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }

  onChange() {
    return () => {};
  }

  tabInfo() {
    return [];
  }

  currentUrl() {
    return this.last?.url ?? null;
  }

  /** Snapshot the frontmost window. `fresh` bypasses the short cache (used right after an action). */
  async snapshot({ fresh = false } = {}) {
    if (!fresh && this.last && Date.now() - this.lastAt < 400) return this.last;
    let raw;
    try {
      raw = await this.call("snapshot");
    } catch (err) {
      // e.g. Accessibility permission missing: no elements, but "open <app>" / "go to <site>" still work.
      raw = { app: this.last?.app || "", title: "", elements: [], error: String(err.message || err) };
    }
    // Each new failure is reported once: an empty snapshot still opens apps and sites, but nothing on screen can be clicked.
    if (raw.error && raw.error !== this.lastError) this.emit("snapshot_error", raw.error);
    this.lastError = raw.error;
    this.last = buildDesktopSnapshot(raw, this.apps, { appAliases: this.appAliases, defaultBrowser: this.defaultBrowser });
    this.lastAt = Date.now();
    return this.last;
  }

  /** Same calls the controller / executor make on the in-page overlay. */
  async overlay(fn, ...args) {
    let msg = { fn };
    if (fn === "toast") msg = { fn, text: String(args[0] ?? ""), ms: args[1] ?? 1800 };
    else if (fn === "highlight") msg = { fn, ref: args[0], ms: args[1] ?? HIGHLIGHT_MS };
    else if (fn === "candidates") msg = { fn, items: (args[0] || []).map((c) => ({ n: c.n, ref: c.id })), ms: args[1] ?? CANDIDATE_TTL_MS };
    await this.call("overlay", msg).catch(() => {});
  }

  /** macOS `open`: a URL in the default browser, or `-a <application>`. */
  async open(args) {
    await execFileP("open", args);
  }

  /** Run one AppleScript line (system volume). Returns its trimmed output. */
  async osascript(script) {
    const { stdout } = await execFileP("osascript", ["-e", script]);
    return stdout.trim();
  }

  async close() {
    this.closing = true;
    this.proc?.kill();
  }
}

/** Cheap "where am I": {app, bundle, browser, title, url?}; `{}` when the helper cannot say. */
export function probe(desktop) {
  return Promise.resolve(desktop.call("probe")).catch(() => ({}));
}

/**
 * Wait until the frontmost app / window title / url differs from `before`, then let it settle;
 * give up at `maxMs`. Replaces fixed sleeps: an action that lands fast costs ~one probe. A helper
 * that cannot probe (no `app` in the reply) means there is nothing to poll, so it returns at once.
 */
export async function waitForChange(desktop, before, maxMs) {
  const t0 = Date.now();
  for (;;) {
    const now = await probe(desktop);
    if (typeof now.app !== "string") {
      if (typeof before?.app === "string") await sleep(DESKTOP_WAIT.fallbackMs); // probe broke mid-action: fall back to a short fixed wait
      return false;
    }
    if (now.app !== before?.app || now.title !== before?.title || now.url !== before?.url) {
      await sleep(DESKTOP_WAIT.settleMs);
      return true;
    }
    if (Date.now() - t0 >= maxMs) return false;
    await sleep(DESKTOP_WAIT.pollMs);
  }
}

/** The names an app can show up under in the front-app probe: bundle name, localized name, Calculator's two names. */
function appNames(desktop, app) {
  return [app, desktop.appAliases?.[app], ...(app === "Calculator" ? CALCULATOR_APP_NAMES : [])];
}

const TEXT_ROLES = new Set(["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]);

/**
 * Wait until the frontmost application is one of `names` (case-insensitive). The helper reports both the display name and the
 * bundle folder name ("Code" / "Visual Studio Code"): either one matches.
 */
export async function waitForApp(desktop, names, maxMs) {
  const wanted = names.filter(Boolean).map((n) => n.toLowerCase());
  const t0 = Date.now();
  for (;;) {
    const now = await probe(desktop);
    if (typeof now.app !== "string") return false;
    if ([now.app, now.bundleName].some((n) => typeof n === "string" && wanted.includes(n.toLowerCase()))) return true;
    if (Date.now() - t0 >= maxMs) return false;
    await sleep(DESKTOP_WAIT.pollMs);
  }
}

/**
 * Only these can change the window / title / url: everything else (copy, paste, undo, save, find, zoom, arrow keys, Tab...)
 * changes nothing a probe can see, so polling for a change would only delay the next command. The snapshot taken right
 * after the action shows the result.
 */
const CHANGING_SHORTCUTS = new Set(["new_window"]);
const MAY_NAVIGATE_KEYS = new Set(["return", "enter", "kpenter"]);

/** Same page, ignoring a trailing slash, a fragment and the case of the host ("https://x.com" == "https://x.com/#top"). */
function samePage(a, b) {
  const norm = (u) => String(u ?? "").trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
  return Boolean(a) && Boolean(b) && norm(a) === norm(b);
}

/** Helper chord string: modifiers joined by "+" then the key ("cmd+shift+tab"). */
const chord = (key, mods = []) => [...mods, key].join("+");

/**
 * @param {object} action  from policy.evaluatePolicy
 * @param {DesktopManager} desktop
 * @returns {Promise<{ok: boolean, detail?: string}>}
 */
export async function executeDesktop(action, desktop) {
  const label = describe(action, desktop.uiLang || "en");
  const key = (name, mods = []) => desktop.call("key", { key: name, mods });
  // Cmd+<char> through the menu item that owns it (independent of the keyboard layout). `fallback`
  // names the key to press with Cmd when the app has no such menu item.
  const shortcut = (char, fallback) => desktop.call("shortcut", { char, ...(fallback ? { fallback } : {}) });
  /** Wait for the screen to react to what was just sent (see waitForChange). */
  const settle = async (before, ms) => waitForChange(desktop, before, ms);
  let failure = null;

  switch (action.type) {
    case "navigate_url": {
      if (!/^https?:\/\//i.test(action.url)) return { ok: false, detail: "not a web address" };
      await desktop.overlay("toast", `→ ${label}`);
      const front = await probe(desktop);
      // A browser in front: use its address bar so the CURRENT tab navigates (a new tab only on
      // request). Anything else: the default browser, via `open`.
      let done = false;
      if (front.browser) {
        done = await desktop.call("open_url", { url: action.url, newTab: Boolean(action.newTab) }).then(() => true, () => false);
      }
      if (!done) await desktop.open([action.url]);
      // Re-opening the page that is already open changes no title or url: do not wait for a change that cannot come.
      await settle(front, samePage(front.url, action.url) ? DESKTOP_WAIT.sameUrlMs : DESKTOP_WAIT.navigateMs);
      break;
    }

    case "open_app": {
      await desktop.overlay("toast", label);
      // A running app is just brought to the front; `open -a` launches it (or reopens its window).
      const running = await desktop.call("activate", { name: action.app }).catch(() => ({}));
      if (!running.activated) await desktop.open(["-a", action.app]);
      await waitForApp(desktop, appNames(desktop, action.app), DESKTOP_WAIT.appMs);
      break;
    }

    case "switch_app_back": {
      const before = await probe(desktop);
      await key("tab", ["cmd"]);
      await settle(before, DESKTOP_WAIT.appMs);
      break;
    }

    case "click_element": {
      const before = await probe(desktop);
      await desktop.overlay("clearCandidates");
      await desktop.overlay("highlight", action.targetId, HIGHLIGHT_MS);
      await desktop.overlay("toast", label);
      await desktop.call("click", { ref: action.targetId });
      await settle(before, DESKTOP_WAIT.clickMs);
      break;
    }

    case "type_into_field": {
      const before = await probe(desktop);
      await desktop.overlay("clearCandidates");
      if (action.targetId) await desktop.overlay("highlight", action.targetId, HIGHLIGHT_MS + 400);
      await desktop.overlay("toast", label);
      await desktop.call("type", { ...(action.targetId ? { ref: action.targetId } : {}), text: action.text, submit: Boolean(action.submit) });
      await settle(before, action.submit ? DESKTOP_WAIT.submitMs : DESKTOP_WAIT.scrollMs);
      break;
    }

    case "select_option": {
      // Open the pop-up, then pick the menu item whose label matches (substring, in code).
      await desktop.overlay("highlight", action.targetId, HIGHLIGHT_MS);
      await desktop.overlay("toast", label);
      await desktop.call("click", { ref: action.targetId });
      // The pop-up has no title / url change to poll: look for its menu items until they show up.
      const t0 = Date.now();
      let open;
      let items = [];
      do {
        open = await desktop.snapshot({ fresh: true });
        items = Object.values(open.rawById).filter((e) => e.role === "menuitem");
        if (items.length || Date.now() - t0 >= DESKTOP_WAIT.clickMs) break;
        await sleep(DESKTOP_WAIT.pollMs);
      } while (true); // eslint-disable-line no-constant-condition
      const wanted = action.text.toLowerCase();
      const hit = items.find((e) => e.text.toLowerCase() === wanted) || items.find((e) => e.text.toLowerCase().includes(wanted));
      if (hit) await desktop.call("click", { ref: hit.id });
      else {
        await key("escape");
        failure = "no matching option";
      }
      await sleep(DESKTOP_WAIT.settleMs);
      break;
    }

    case "press_enter": {
      const before = await probe(desktop);
      await desktop.overlay("toast", "⏎ enter");
      await key("return");
      await settle(before, DESKTOP_WAIT.keyMs);
      break;
    }

    case "press_key": {
      const before = await probe(desktop);
      await desktop.overlay("toast", label);
      const n = Math.min(MAX_REPEAT, Math.max(1, action.count || 1));
      await desktop.call("keys", { keys: Array(n).fill(chord(action.key, action.mods)) });
      // Enter (or a Cmd chord) can submit / navigate; an arrow, Tab or Space cannot, so nothing to wait for.
      if (MAY_NAVIGATE_KEYS.has(action.key) || action.mods?.includes("cmd")) await settle(before, DESKTOP_WAIT.keyMs);
      break;
    }

    case "shortcut": {
      const before = await probe(desktop);
      await desktop.overlay("toast", label);
      const { char, shift, alt, ctrl, fallback } = action;
      await desktop.call("shortcut", { char, ...(shift && { shift: true }), ...(alt && { alt: true }), ...(ctrl && { ctrl: true }), ...(fallback && { fallback }) });
      if (CHANGING_SHORTCUTS.has(action.id)) await settle(before, DESKTOP_WAIT.keyMs);
      break;
    }

    case "window_op": {
      // A named app ("chiudi la calcolatrice") is brought forward first; never fall back to whatever window is in front.
      if (action.app) {
        const running = await desktop.call("activate", { name: action.app }).catch(() => ({}));
        if (!running.activated || !(await waitForApp(desktop, appNames(desktop, action.app), DESKTOP_WAIT.appMs))) {
          return { ok: false, detail: `${action.app} has no open window` };
        }
      }
      const before = await probe(desktop);
      await desktop.overlay("toast", label);
      await desktop.call("window", { op: action.op });
      await settle(before, DESKTOP_WAIT.keyMs);
      break;
    }

    case "clear_field": {
      // Cmd+A + Delete empties whatever has the focus: only ever inside a text field, never a file list or a mailbox.
      const focus = await desktop.call("focus").catch(() => ({}));
      if (!TEXT_ROLES.has(focus.role)) return { ok: false, detail: "no text field has the keyboard focus" };
      await desktop.overlay("toast", label);
      await desktop.call("keys", { keys: ["cmd+a", "delete"] });
      await sleep(DESKTOP_WAIT.settleMs);
      break;
    }

    case "send_keys":
      await desktop.overlay("toast", label);
      await desktop.call("keys", { keys: action.keys });
      await sleep(DESKTOP_WAIT.settleMs);
      break;

    case "volume": {
      let level = null;
      try {
        if (action.op === "mute" || action.op === "unmute") {
          await desktop.osascript(`set volume output muted ${action.op === "mute"}`);
        } else {
          // One osascript process for read + clamp + set (each launch costs ~50-100 ms); it answers with the new level.
          const delta = action.op === "up" ? VOLUME_STEP : -VOLUME_STEP;
          const out = await desktop.osascript(
            [
              "set v to output volume of (get volume settings)",
              "if v is missing value then set v to 50",
              `set v to v + (${delta})`,
              "if v > 100 then set v to 100",
              "if v < 0 then set v to 0",
              "set volume output volume v",
              "return v",
            ].join("\n"),
          );
          const parsed = Number.parseInt(out, 10);
          level = Number.isFinite(parsed) ? parsed : null;
        }
      } catch (err) {
        return { ok: false, detail: `volume: ${String(err.message || err).slice(0, 80)}` };
      }
      await desktop.overlay("toast", level == null ? label : `${label} · ${level}%`);
      return { ok: true, detail: level == null ? action.op : `volume=${level}` };
    }

    case "quit_app": {
      // Closing an application can lose work: only ever after an explicit spoken confirmation.
      if (action.confirmed !== true) return { ok: false, detail: "needs confirmation" };
      const before = await probe(desktop);
      await desktop.overlay("toast", label);
      const res = await desktop.call("quit", action.app ? { name: action.app } : {});
      if (res.quit === false) return { ok: false, detail: `could not quit ${res.app || action.app || "the app"}` };
      await settle(before, DESKTOP_WAIT.tabMs);
      break;
    }

    case "calculate": {
      await desktop.overlay("toast", label, 4000);
      // Calculator in front (launched if needed), cleared with Esc Esc, then the keypad keys of
      // the expression ending with Enter. The result in the toast comes from math.js, not read back.
      const front = await probe(desktop);
      let inCalc = CALCULATOR_APP_NAMES.some((n) => n.toLowerCase() === String(front.app || "").toLowerCase());
      if (!inCalc) {
        const running = await desktop.call("activate", { name: "Calculator" }).catch(() => ({}));
        if (!running.activated) await desktop.open(["-a", "Calculator"]);
        inCalc = await waitForApp(desktop, CALCULATOR_APP_NAMES, DESKTOP_WAIT.appMs);
        if (inCalc) await sleep(DESKTOP_WAIT.calcSettleMs);
      }
      // Never type blind: Esc, digits and Enter would land in whatever else is in front (a form, a chat). The result is
      // already on screen in the toast either way.
      if (!inCalc) return { ok: false, detail: "Calculator not in front" };
      await desktop.call("keys", { keys: ["escape", "escape", ...action.keys] });
      return { ok: true, detail: label };
    }

    case "scroll_down":
    case "scroll_up": {
      const before = await probe(desktop);
      await desktop.overlay("toast", label);
      await desktop.call("scroll", { down: action.type === "scroll_down", amount: action.amount || "page" });
      await settle(before, DESKTOP_WAIT.scrollMs);
      break;
    }

    case "go_back":
    case "go_forward":
    case "reload": {
      const before = await probe(desktop);
      await desktop.overlay("toast", { go_back: "← back", go_forward: "→ forward", reload: "↻ reload" }[action.type]);
      if (action.type === "go_back") await shortcut("[", "left"); // Cmd+← is "back" in every browser, wherever "[" sits on the keyboard
      else if (action.type === "go_forward") await shortcut("]", "right");
      else await shortcut("r");
      // A reload keeps the same app, title and url: there is no change to wait for, only a short settle.
      await settle(before, action.type === "reload" ? DESKTOP_WAIT.sameUrlMs : DESKTOP_WAIT.historyMs);
      break;
    }

    case "open_new_tab": {
      const before = await probe(desktop);
      await shortcut("t");
      await desktop.overlay("toast", "new tab");
      await settle(before, DESKTOP_WAIT.tabMs);
      break;
    }

    case "close_tab": {
      const before = await probe(desktop);
      await shortcut("w");
      await settle(before, DESKTOP_WAIT.tabMs);
      break;
    }

    case "switch_tab": {
      const before = await probe(desktop);
      // Cmd+<n> picks tab n (Cmd+9 is always the last one); next / previous are Ctrl(+Shift)+Tab.
      const position = action.position ?? (action.direction === "first" ? 1 : null);
      if (position) await shortcut(String(position));
      else await key("tab", action.direction === "previous" ? ["ctrl", "shift"] : ["ctrl"]);
      await desktop.overlay("toast", "switched tab");
      await settle(before, DESKTOP_WAIT.tabMs);
      break;
    }

    default:
      return { ok: false, detail: `unknown action ${action.type}` };
  }

  // Look at the result now, so the controller records where the action led.
  const after = await desktop.snapshot({ fresh: true });
  return failure ? { ok: false, detail: failure } : { ok: true, detail: after.url };
}
