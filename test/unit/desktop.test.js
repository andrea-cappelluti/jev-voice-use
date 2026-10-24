/**
 * Desktop mode without the native helper: snapshot shaping, what Jev is asked, the open_app /
 * type-at-focus policy branches, and the helper commands each action turns into.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDesktopSnapshot, executeDesktop, listApps, waitForChange, waitForApp, probe } from "../../src/desktop.js";
import { buildRequest } from "../../src/jev.js";
import { evaluatePolicy, reverseAction, describe } from "../../src/policy.js";

const APPS = ["Google Chrome", "Safari", "System Settings"];
const RAW = {
  app: "Finder",
  title: "Documents",
  elements: [
    { id: "e03", role: "row", type: "", text: "Invoices", placeholder: "", left: 200, top: 300, w: 400, h: 20 },
    { id: "e01", role: "menu", type: "", text: "File", placeholder: "", left: 80, top: 0, w: 40, h: 24 },
    { id: "e02", role: "searchbox", type: "AXSearchField", text: "", placeholder: "Search", left: 900, top: 60, w: 160, h: 22 },
  ],
};

const ch = (c, conf = 0.95, extra = {}) => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf, ...extra } });
function answers(over = {}) {
  return {
    intent: ch("open_app"),
    target: ch("none"),
    site: ch("none"),
    app: ch("none"),
    complete: { type: "noul", noul: 0.9 },
    is_command: { type: "noul", noul: 0.95 },
    destructive: { type: "noul", noul: 0.05 },
    scroll_amount: { type: "score", score: 1, confidence: 0.9, probabilities: {} },
    tab_direction: ch("none"),
    ...over,
  };
}
const candidates = { text: [], url: [] };

// Chrome in Italian on YouTube: the omnibox sits ABOVE the page search field (top 80 vs 150).
const CHROME = {
  app: "Google Chrome",
  bundle: "com.google.Chrome",
  title: "YouTube",
  url: "https://www.youtube.com/",
  elements: [
    { id: "e01", role: "textbox", type: "", text: "Barra degli indirizzi e di ricerca", placeholder: "", left: 200, top: 80, w: 600, h: 28, web: false },
    { id: "e02", role: "combobox", type: "", text: "", placeholder: "Cerca", left: 300, top: 150, w: 500, h: 30, web: true },
  ],
};

test("desktop snapshot: elements in visual order, search box found, a stable pseudo-url outside the browser", () => {
  const s = buildDesktopSnapshot(RAW, APPS);
  assert.equal(s.desktop, true);
  assert.deepEqual(s.elements.map((e) => e.id), ["e01", "e02", "e03"]);
  assert.equal(s.searchBoxId, "e02");
  assert.equal(s.url, "app://Finder/Documents");
  assert.equal(s.site, "generic");
  const web = buildDesktopSnapshot({ ...RAW, app: "Safari", url: "https://en.wikipedia.org/wiki/Cat" }, APPS);
  assert.equal(web.url, "https://en.wikipedia.org/wiki/Cat");
  assert.equal(web.site, "wikipedia");
});

test("desktop request: page is the frontmost app, open_app is an intent, installed apps are the `app` options", () => {
  const { state, questions } = buildRequest({ transcript: "open chrome", snapshot: buildDesktopSnapshot(RAW, APPS) });
  assert.deepEqual(state.page, { app: "Finder", title: "Documents" });
  assert.ok("open_app" in questions.intent.criteria);
  assert.deepEqual(Object.keys(questions.app.criteria), [...APPS, "none"]);
  // browser mode is untouched
  const browser = buildRequest({ transcript: "open chrome", snapshot: { url: "https://example.com/", title: "x", site: "example_com", elements: [] } });
  assert.equal(browser.questions.app, undefined);
  assert.equal("open_app" in browser.questions.intent.criteria, false);
});

test("open_app: acts on a confident app, falls back to a named site, otherwise waits", () => {
  const snapshot = buildDesktopSnapshot(RAW, APPS);
  let r = evaluatePolicy({ answers: answers({ app: ch("Google Chrome") }), candidates, snapshot });
  assert.equal(r.decision, "act");
  assert.deepEqual(r.action, { type: "open_app", app: "Google Chrome", label: "Google Chrome" });
  assert.equal(describe(r.action), "open Google Chrome");

  r = evaluatePolicy({ answers: answers({ site: ch("youtube") }), candidates, snapshot });
  assert.equal(r.action.type, "navigate_url");
  assert.equal(r.action.url, "https://www.youtube.com/");

  r = evaluatePolicy({ answers: answers(), candidates, snapshot });
  assert.equal(r.decision, "wait");
});

test("navigate_url with no site but a confident app opens the app", () => {
  const r = evaluatePolicy({ answers: answers({ intent: ch("navigate_url"), app: ch("Safari") }), candidates, snapshot: buildDesktopSnapshot(RAW, APPS) });
  assert.equal(r.action.type, "open_app");
  assert.equal(r.action.app, "Safari");
});

test("typing with no field named goes to the keyboard focus (desktop only)", () => {
  const a = answers({ intent: ch("type_into_field") });
  const typed = { text: ["hello world"], url: [] };
  const r = evaluatePolicy({ answers: a, candidates: typed, snapshot: { ...buildDesktopSnapshot(RAW, APPS), searchBoxId: null }, isFinal: true });
  assert.equal(r.decision, "act");
  assert.equal(r.action.targetId, null);
  assert.equal(r.action.text, "hello world");
  const inBrowser = evaluatePolicy({ answers: a, candidates: typed, snapshot: { url: "https://example.com/", site: "example_com", elements: [] }, isFinal: true });
  assert.notEqual(inBrowser.decision, "act");
});

test("undoing an opened app switches back", () => {
  assert.equal(reverseAction({ type: "open_app", app: "Safari" }).type, "switch_app_back");
});

/** A DesktopManager stand-in that records what would be sent to the helper / `open`. */
function fakeDesktop(raw = RAW) {
  return {
    calls: [],
    opened: [],
    async call(cmd, args = {}) {
      this.calls.push([cmd, args]);
      return {};
    },
    async overlay() {},
    async open(args) {
      this.opened.push(args);
    },
    async snapshot() {
      return buildDesktopSnapshot(raw, APPS);
    },
  };
}
const sent = (d) => d.calls.filter(([cmd]) => cmd !== "overlay" && cmd !== "probe");

test("executeDesktop: apps and urls go through `open`, and only http(s) urls are accepted", async () => {
  const d = fakeDesktop();
  assert.deepEqual(await executeDesktop({ type: "open_app", app: "Safari" }, d), { ok: true, detail: "app://Finder/Documents" });
  await executeDesktop({ type: "navigate_url", url: "https://example.com/" }, d);
  assert.deepEqual(d.opened, [["-a", "Safari"], ["https://example.com/"]]);
  const bad = await executeDesktop({ type: "navigate_url", url: "file:///etc/passwd" }, d);
  assert.equal(bad.ok, false);
  assert.equal(d.opened.length, 2);
});

test("executeDesktop: actions map to helper commands", async () => {
  const d = fakeDesktop();
  await executeDesktop({ type: "click_element", targetId: "e03" }, d);
  await executeDesktop({ type: "type_into_field", targetId: "e02", text: "cats", submit: true }, d);
  await executeDesktop({ type: "type_into_field", targetId: null, text: "hello" }, d);
  await executeDesktop({ type: "scroll_up", amount: "little" }, d);
  await executeDesktop({ type: "go_back" }, d);
  await executeDesktop({ type: "switch_tab", direction: "previous" }, d);
  assert.deepEqual(sent(d), [
    ["click", { ref: "e03" }],
    ["type", { ref: "e02", text: "cats", submit: true }],
    ["type", { text: "hello", submit: false }],
    ["scroll", { down: false, amount: "little" }],
    ["shortcut", { char: "[", fallback: "left" }],
    ["key", { key: "tab", mods: ["ctrl", "shift"] }],
  ]);
});

test("executeDesktop: select_option opens the pop-up and clicks the matching menu item", async () => {
  const popupOpen = { ...RAW, elements: [...RAW.elements, { id: "e09", role: "menuitem", type: "", text: "Date Modified", placeholder: "", left: 300, top: 120, w: 120, h: 20 }] };
  const d = fakeDesktop(popupOpen);
  const ok = await executeDesktop({ type: "select_option", targetId: "e02", text: "date" }, d);
  assert.equal(ok.ok, true);
  assert.deepEqual(sent(d), [["click", { ref: "e02" }], ["click", { ref: "e09" }]]);
  const d2 = fakeDesktop();
  const miss = await executeDesktop({ type: "select_option", targetId: "e02", text: "date" }, d2);
  assert.deepEqual(miss, { ok: false, detail: "no matching option" });
  assert.deepEqual(sent(d2)[1], ["key", { key: "escape", mods: [] }]);
});

test("listApps: .app bundle names, de-duplicated across directories, capped", () => {
  const apps = listApps(["/System/Applications", "/System/Applications", "/definitely/not/here"], 5);
  assert.equal(apps.length, 5);
  assert.equal(new Set(apps).size, 5);
  assert.ok(apps.every((a) => !a.endsWith(".app")));
});

test("browser frontmost: the page search field wins over the address bar (web flag), also in Italian", () => {
  const s = buildDesktopSnapshot(CHROME, APPS);
  assert.equal(s.browser, true);
  assert.equal(s.bundle, "com.google.Chrome");
  assert.equal(s.searchBoxId, "e02");
  assert.equal(s.site, "youtube");
  // only the browser chrome has an input: no page box at all
  const bare = buildDesktopSnapshot({ ...CHROME, elements: [CHROME.elements[0]] }, APPS);
  assert.equal(bare.searchBoxId, null);
  assert.equal(s.rawById.e01.web, false);
  assert.deepEqual(buildDesktopSnapshot(RAW, APPS, { appAliases: { Calculator: "Calcolatrice" } }).appAliases, { Calculator: "Calcolatrice" });
  assert.equal(buildDesktopSnapshot(RAW, APPS).browser, false);
});

test("Italian 'cerca X' on YouTube in Chrome types into the PAGE box, never the omnibox", () => {
  const snapshot = buildDesktopSnapshot(CHROME, APPS);
  const a = answers({ intent: ch("search_web"), site: ch("youtube"), text_span: ch("macchine") });
  const r = evaluatePolicy({ answers: a, candidates: { text: ["macchine"], url: [] }, snapshot, isFinal: true, lang: "it" });
  assert.equal(r.action.type, "type_into_field");
  assert.equal(r.action.targetId, "e02");
});

/** Fake whose probe answers from a script, so waits can be observed. */
function probingDesktop(replies, front = {}) {
  const d = fakeDesktop();
  let i = 0;
  const base = d.call.bind(d);
  d.call = async (cmd, args = {}) => {
    if (cmd === "probe") {
      d.calls.push([cmd, args]);
      const r = replies[Math.min(i++, replies.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    }
    return base(cmd, args);
  };
  return d;
}

test("navigate_url: browser in front -> helper open_url in the CURRENT tab; new tab only on request; else `open`", async () => {
  const front = { app: "Google Chrome", browser: true, title: "YouTube", url: "https://www.youtube.com/" };
  const d = probingDesktop([front, { ...front, url: "https://it.wikipedia.org/" }]);
  await executeDesktop({ type: "navigate_url", url: "https://it.wikipedia.org/" }, d);
  assert.deepEqual(sent(d), [["open_url", { url: "https://it.wikipedia.org/", newTab: false }]]);
  assert.deepEqual(d.opened, []);
  const d2 = probingDesktop([front, { ...front, title: "x" }]);
  await executeDesktop({ type: "navigate_url", url: "https://it.wikipedia.org/", newTab: true }, d2);
  assert.deepEqual(sent(d2)[0], ["open_url", { url: "https://it.wikipedia.org/", newTab: true }]);
  // not a browser: default browser through `open`
  const d3 = probingDesktop([{ app: "Finder", browser: false }, { app: "Safari" }]);
  await executeDesktop({ type: "navigate_url", url: "https://example.com/" }, d3);
  assert.deepEqual(sent(d3), []);
  assert.deepEqual(d3.opened, [["https://example.com/"]]);
  // helper without open_url (or refusing): fall back to `open`
  const d4 = probingDesktop([front, { ...front, title: "x" }]);
  const call = d4.call;
  d4.call = async (cmd, args) => {
    if (cmd === "open_url") throw new Error("not a browser");
    return call(cmd, args);
  };
  await executeDesktop({ type: "navigate_url", url: "https://example.com/" }, d4);
  assert.deepEqual(d4.opened, [["https://example.com/"]]);
});

test("waitForChange: returns on change, at the cap, and instantly when the helper cannot probe", async () => {
  const same = { app: "A", title: "t", url: "u" };
  const t0 = Date.now();
  assert.equal(await waitForChange(probingDesktop([same, same, { ...same, title: "u2" }]), same, 2000), true);
  assert.equal(await waitForChange(probingDesktop([same]), same, 200), false);
  assert.ok(Date.now() - t0 < 1500);
  const t1 = Date.now();
  assert.equal(await waitForChange(probingDesktop([{}]), {}, 4000), false);
  assert.ok(Date.now() - t1 < 100);
  assert.deepEqual(await probe(probingDesktop([new Error("x")])), {});
  assert.equal(await waitForApp(probingDesktop([{ app: "Finder" }, { app: "Calcolatrice" }]), ["Calculator", "Calcolatrice"], 1000), true);
  assert.equal(await waitForApp(probingDesktop([{}]), ["Calculator"], 1000), false);
});

test("executeDesktop: keys, shortcuts, window ops, key sequences map to helper commands", async () => {
  const d = fakeDesktop();
  await executeDesktop({ type: "press_key", key: "down", mods: [], count: 3, label: "arrow down" }, d);
  await executeDesktop({ type: "press_key", key: "tab", mods: ["shift"], count: 1 }, d);
  await executeDesktop({ type: "shortcut", id: "redo", char: "z", shift: true }, d);
  await executeDesktop({ type: "shortcut", id: "zoom_in", char: "+", fallback: "=" }, d);
  await executeDesktop({ type: "window_op", op: "minimize" }, d);
  await executeDesktop({ type: "send_keys", keys: ["cmd+shift+3"] }, d);
  assert.deepEqual(sent(d), [
    ["keys", { keys: ["down", "down", "down"] }],
    ["keys", { keys: ["shift+tab"] }],
    ["shortcut", { char: "z", shift: true }],
    ["shortcut", { char: "+", fallback: "=" }],
    ["window", { op: "minimize" }],
    ["keys", { keys: ["cmd+shift+3"] }],
  ]);
});

test("executeDesktop: quit needs a confirmed action", async () => {
  const d = fakeDesktop();
  assert.deepEqual(await executeDesktop({ type: "quit_app", app: "Safari" }, d), { ok: false, detail: "needs confirmation" });
  assert.deepEqual(sent(d), []);
  await executeDesktop({ type: "quit_app", app: "Safari", confirmed: true }, d);
  await executeDesktop({ type: "quit_app", app: null, confirmed: true }, d);
  assert.deepEqual(sent(d), [["quit", { name: "Safari" }], ["quit", {}]]);
});

test("executeDesktop: volume runs osascript, clamped to 0..100 in VOLUME_STEP steps", async () => {
  const d = fakeDesktop();
  const scripts = [];
  let level = "100"; // what the one-shot script answers: the new, already clamped level
  d.osascript = async (script) => {
    scripts.push(script);
    return script.startsWith("set volume output muted") ? "" : level;
  };
  const up = await executeDesktop({ type: "volume", op: "up" }, d);
  assert.deepEqual(up, { ok: true, detail: "volume=100" });
  level = "0";
  const down = await executeDesktop({ type: "volume", op: "down" }, d);
  assert.equal(down.detail, "volume=0");
  await executeDesktop({ type: "volume", op: "mute" }, d);
  await executeDesktop({ type: "volume", op: "unmute" }, d);
  // read + clamp + set in ONE osascript process per up / down
  assert.equal(scripts.length, 4);
  assert.match(scripts[0], /output volume of \(get volume settings\)[\s\S]*v \+ \(10\)[\s\S]*if v > 100 then set v to 100[\s\S]*set volume output volume v[\s\S]*return v/);
  assert.match(scripts[1], /v \+ \(-10\)[\s\S]*if v < 0 then set v to 0/);
  assert.deepEqual(scripts.slice(2), ["set volume output muted true", "set volume output muted false"]);
  assert.deepEqual(sent(d), []);
});

test("executeDesktop: calculate brings Calculator to the front, clears it and types the keypad keys", async () => {
  const action = { type: "calculate", expr: "7+6", display: "7 + 6", result: 13, resultText: "13", keys: ["kp7", "kpplus", "kp6", "kpenter"], label: "7 + 6 = 13" };
  const d = probingDesktop([{ app: "Mail" }, { app: "Mail" }, { app: "Calculator" }]); // not running: comes to the front after a launch
  const toasts = [];
  d.overlay = async (fn, ...a) => fn === "toast" && toasts.push(a[0]);
  const r = await executeDesktop(action, d);
  assert.equal(r.ok, true);
  assert.deepEqual(sent(d), [["activate", { name: "Calculator" }], ["keys", { keys: ["escape", "escape", "kp7", "kpplus", "kp6", "kpenter"] }]]);
  assert.deepEqual(d.opened, [["-a", "Calculator"]], "not running: launched with open -a");
  assert.deepEqual(toasts, ["7 + 6 = 13"]);
  // already in front (Italian name): straight to the keys
  const d2 = probingDesktop([{ app: "Calcolatrice" }]);
  await executeDesktop(action, d2);
  assert.deepEqual(sent(d2).map(([c]) => c), ["keys"]);
});
