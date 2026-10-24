/**
 * Regression tests for the final review round: search-box detection, confirmation expiry, key / Enter gating, named sites
 * without a search template, new-tab and dropdown payloads, undo in desktop apps, tab positions, Italian thousands separators,
 * condition waits, and the controller's request economy (warm snapshot, no duplicate in-flight request).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy, reverseAction } from "../../src/policy.js";
import { buildDesktopSnapshot, executeDesktop, waitForApp } from "../../src/desktop.js";
import { findSearchBox } from "../../src/snapshot.js";
import { buildRequest } from "../../src/jev.js";
import { Controller } from "../../src/controller.js";
import { normalizeNumberGrouping, parseMathExpression } from "../../src/math.js";
import {
  endsOnContinuationWord,
  extractTextCandidates,
  parseCandidatePick,
  parseConfirmation,
  startsWithOpenVerb,
  wantsNewTab,
} from "../../src/spans.js";
import { DEBOUNCE_MS, PENDING_TTL_MS, REPEAT_SILENCE_MS, T } from "../../src/constants.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ch = (c, conf = 0.95, extra = {}) => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf, none: 1 - conf, ...extra } });
function answers(over = {}) {
  return {
    intent: ch("search_web"),
    target: ch("none"),
    site: ch("none"),
    control: ch("none", 0.9),
    app: ch("none", 0.9),
    complete: { noul: 0.9 },
    is_command: { noul: 0.95 },
    destructive: { noul: 0.05 },
    scroll_amount: { score: 1, confidence: 0.9, probabilities: {} },
    tab_direction: ch("none"),
    ...over,
  };
}
const el = (id, role, text, o = {}) => ({ id, role, type: "", text, placeholder: "", left: 100, top: 200, w: 120, h: 24, web: true, ...o });
const omnibox = (id = "e01") => el(id, "textbox", "Indirizzo e ricerca", { web: false, top: 70, left: 300, w: 600 });
const APPS = ["Calculator", "Safari", "Terminal"];
const desk = (raw) => buildDesktopSnapshot(raw, APPS);

const SIGNUP = desk({
  app: "Safari", bundle: "com.apple.Safari", title: "Registrati", url: "https://app.example.com/signup",
  elements: [omnibox(), el("e02", "textbox", "", { placeholder: "Email", top: 150 }), el("e03", "textbox", "", { placeholder: "Password", top: 190 })],
});
const CORRIERE = desk({
  app: "Safari", bundle: "com.apple.Safari", title: "Corriere", url: "https://www.corriere.it/",
  elements: [omnibox(), el("e04", "textbox", "", { placeholder: "Cerca nel sito", top: 150 }), el("e05", "link", "Cronaca", { top: 300 })],
});
const TEXTEDIT = desk({ app: "TextEdit", bundle: "com.apple.TextEdit", title: "Senza titolo", elements: [el("e01", "textbox", "", { web: false })] });
const FINDER = desk({ app: "Finder", bundle: "com.apple.finder", title: "Documenti", elements: [el("e01", "menu", "File", { web: false, top: 0 })] });

// ------------------------------------------------------------------------------------------------ search box detection

test("a field with no search signal is never the page's search box (Email / Password, TextEdit body)", () => {
  assert.equal(SIGNUP.searchBoxId, null);
  assert.equal(TEXTEDIT.searchBoxId, null);
  // every desktop element is "in the viewport": that alone must not qualify
  assert.equal(findSearchBox([{ id: "e01", role: "textbox", text: "", placeholder: "Email", inViewport: true, top: 1 }]), null);
  assert.equal(CORRIERE.searchBoxId, "e04", "a real Cerca field still is");
  for (const placeholder of ["Search by location", "Cerca indirizzo", "Enter address, city or ZIP search"]) {
    assert.equal(findSearchBox([{ id: "e01", role: "textbox", text: "", placeholder, web: true, inViewport: true, top: 1 }]), "e01", placeholder);
  }
  // the browser's own address bar wording, in both languages, is still screened out when nothing says where it lives
  for (const text of ["Address and search bar", "Barra degli indirizzi e di ricerca", "Indirizzo e ricerca", "Search or enter address", "Cerca o inserisci un indirizzo"]) {
    assert.equal(findSearchBox([{ id: "e01", role: "textbox", text, inViewport: true, top: 1 }]), null, text);
  }
});

test("'cerca gatti' / 'search for cats' on a sign-up page or in TextEdit goes to the default engine, never into a field", () => {
  for (const [snap, lang] of [[SIGNUP, "it"], [TEXTEDIT, "it"], [SIGNUP, "en"], [TEXTEDIT, "en"]]) {
    const r = evaluatePolicy({ answers: answers(), candidates: { text: ["gatti"], url: [] }, snapshot: snap, isFinal: true, lang });
    assert.equal(r.action.type, "navigate_url", `${snap.app} ${lang}`);
    assert.match(r.action.url, /^https:\/\/duckduckgo\.com\/\?q=gatti$/);
    assert.equal(r.action.newTab, false, "current tab");
  }
});

// ------------------------------------------------------------------------------------------------ named sites, new tab, dropdowns

test("a named site WITHOUT a search template is searched with site:, never in the current page's box", () => {
  const r = evaluatePolicy({ answers: answers({ site: ch("facebook") }), candidates: { text: ["mario rossi"], url: [] }, snapshot: CORRIERE, isFinal: true, lang: "it" });
  assert.equal(r.action.type, "navigate_url");
  assert.equal(r.action.url, "https://duckduckgo.com/?q=mario%20rossi%20site%3Afacebook.com");
  const ig = evaluatePolicy({ answers: answers({ site: ch("instagram") }), candidates: { text: ["gatti"], url: [] }, snapshot: SIGNUP, isFinal: true });
  assert.match(ig.action.url, /site%3Ainstagram\.com$/);
  // already on that site with a search field: the page's own box
  const onFb = desk({ app: "Safari", bundle: "com.apple.Safari", title: "Facebook", url: "https://www.facebook.com/", elements: [omnibox(), el("e04", "searchbox", "", { placeholder: "Cerca su Facebook" })] });
  const here = evaluatePolicy({ answers: answers({ site: ch("facebook") }), candidates: { text: ["mario rossi"], url: [] }, snapshot: onFb, isFinal: true });
  assert.equal(here.action.type, "type_into_field");
  assert.equal(here.action.targetId, "e04");
});

test("a new-tab phrase is not part of the query, and a new-tab search is a URL (never typed into the open page)", () => {
  assert.deepEqual(extractTextCandidates("cerca gatti in una nuova scheda").slice(0, 1), ["gatti"]);
  assert.deepEqual(extractTextCandidates("search cats in a new tab").slice(0, 1), ["cats"]);
  assert.deepEqual(extractTextCandidates("cerca gatti in un'altra scheda").slice(0, 1), ["gatti"]);
  assert.deepEqual(extractTextCandidates("cerca gatti in una scheda nuova").slice(0, 1), ["gatti"]);
  assert.ok(extractTextCandidates("search cats in a new tab").every((c) => !/new tab/.test(c)));
  for (const t of ["in una nuova scheda", "in una scheda nuova", "in un'altra scheda", "in a new tab", "in another tab", "nuovo tab"]) assert.equal(wantsNewTab(`apri youtube ${t}`), true, t);
  assert.equal(wantsNewTab("vai alla scheda successiva"), false);
  const r = evaluatePolicy({ answers: answers(), candidates: { text: ["gatti"], url: [], newTab: true }, snapshot: CORRIERE, isFinal: true, lang: "it" });
  assert.equal(r.action.type, "navigate_url");
  assert.equal(r.action.newTab, true);
  assert.equal(r.action.url, "https://duckduckgo.com/?q=gatti");
});

test("select_option: the option is the bare word, the 'from the menu' phrase is stripped (IT + EN)", () => {
  assert.equal(extractTextCandidates("seleziona Francia dal menu paese")[0], "Francia");
  assert.equal(extractTextCandidates("select english from the language dropdown")[0], "english");
  assert.equal(extractTextCandidates("scegli italiano dal menu a tendina")[0], "italiano");
  assert.equal(extractTextCandidates("choose the large size from the menu")[0], "the large size");
});

test("'rete neurale' / 'web design' / 'x ray' keep their first word; real site names are still stripped", () => {
  assert.equal(extractTextCandidates("cerca rete neurale")[0], "rete neurale");
  assert.equal(extractTextCandidates("cerca web design")[0], "web design");
  assert.equal(extractTextCandidates("search for x ray")[0], "x ray");
  assert.equal(extractTextCandidates("cerca su internet youtube")[0], "youtube");
  assert.equal(extractTextCandidates("cerca youtube macchine")[0], "macchine");
});

// ------------------------------------------------------------------------------------------------ keys, Enter, repeat counts

test("a bare Enter is gated the same way in both languages and through both intents (higher bar than a click)", () => {
  const run = (intent, control, destructive, extra = {}) =>
    evaluatePolicy({ answers: answers({ intent: ch(intent), control: ch(control), destructive: { noul: destructive } }), candidates: { text: [], url: [], repeat: 1 }, snapshot: TEXTEDIT, isFinal: true, ...extra });
  // "premi invio" in a plain document scored 0.5-0.7: it must not ask for a confirmation
  assert.equal(run("press_enter", "key_enter", 0.62).decision, "act");
  assert.equal(run("press_key", "key_enter", 0.62).decision, "act");
  assert.equal(run("press_enter", "key_enter", T.destructiveKey + 0.05).decision, "confirm");
  const pressKey = run("press_key", "key_enter", 0.95);
  assert.equal(pressKey.decision, "confirm", "press_key / Return is gated too");
  assert.equal(pressKey.action.type, "press_key");
  // other keys are never gated, a click still uses the lower bar
  assert.equal(run("press_key", "key_tab", 0.95).decision, "act");
  const click = evaluatePolicy({ answers: answers({ intent: ch("click_element"), target: ch("e01", 0.9), destructive: { noul: 0.6 } }), candidates: { text: [], url: [] }, snapshot: TEXTEDIT, isFinal: true });
  assert.equal(click.decision, "confirm");
  // dictation + "e invia" is NOT gated: sending is what was asked
  const send = evaluatePolicy({ answers: answers({ intent: ch("type_into_field"), destructive: { noul: 0.92 } }), candidates: { text: ["ciao"], url: [], submit: true }, snapshot: TEXTEDIT, isFinal: true });
  assert.equal(send.decision, "act");
  assert.equal(send.action.submit, true);
});

test("a key press with no repeat count waits for the short silence; a count in the words or a final result acts at once", () => {
  const base = { answers: answers({ intent: ch("press_key"), control: ch("key_tab") }), snapshot: TEXTEDIT };
  const bare = { text: [], url: [], repeat: 1 };
  const early = evaluatePolicy({ ...base, candidates: bare, silentMs: 0 });
  assert.equal(early.decision, "wait");
  assert.ok(early.retryInMs > 0 && early.retryInMs <= REPEAT_SILENCE_MS);
  assert.equal(evaluatePolicy({ ...base, candidates: bare, silentMs: REPEAT_SILENCE_MS }).decision, "act");
  assert.equal(evaluatePolicy({ ...base, candidates: bare, isFinal: true }).decision, "act");
  const counted = evaluatePolicy({ ...base, candidates: { ...bare, repeat: 3 }, silentMs: 0 });
  assert.equal(counted.decision, "act");
  assert.equal(counted.action.count, 3);
  // shortcuts and windows are not counted: no gate
  assert.equal(evaluatePolicy({ answers: answers({ intent: ch("system_command"), control: ch("copy") }), candidates: bare, snapshot: TEXTEDIT }).decision, "act");
});

// ------------------------------------------------------------------------------------------------ undo, delete, look-alikes, tabs

test("'annulla' with nothing pending: reversible action -> its inverse; nothing to reverse in a desktop app -> Cmd+Z", () => {
  const base = { answers: answers({ intent: ch("cancel"), control: ch("undo", 0.9) }), candidates: { text: [], url: [] }, snapshot: TEXTEDIT, isFinal: true, lang: "it" };
  const none = evaluatePolicy(base);
  assert.equal(none.decision, "act");
  assert.deepEqual({ type: none.action.type, id: none.action.id, char: none.action.char }, { type: "shortcut", id: "undo", char: "z" });
  const afterKey = evaluatePolicy({ ...base, context: { recentActions: [{ type: "press_key", key: "tab" }] } });
  assert.equal(afterKey.action.id, "undo");
  const afterScroll = evaluatePolicy({ ...base, context: { recentActions: [{ type: "scroll_down", amount: "page" }] } });
  assert.equal(afterScroll.action.type, "scroll_up", "a recorded reversible action still wins");
  // browser (Playwright) mode has no edit undo to fall back on
  const browser = { url: "https://example.com/", site: "example_com", elements: [] };
  assert.equal(evaluatePolicy({ ...base, snapshot: browser }).decision, "wait");
});

test("'cancella' is a delete key and 'cancella tutto' asks first; they never undo the last action", () => {
  const ctx = { recentActions: [{ type: "click_element", targetId: "e05", ok: true }] };
  const del = evaluatePolicy({ answers: answers({ intent: ch("cancel", 0.98), control: ch("key_backspace", 0.96) }), candidates: { text: [], url: [], repeat: 1 }, snapshot: TEXTEDIT, isFinal: true, context: ctx });
  assert.equal(del.action.type, "press_key");
  assert.equal(del.action.key, "delete");
  const all = evaluatePolicy({ answers: answers({ intent: ch("system_command", 0.8), control: ch("clear_all", 0.9) }), candidates: { text: [], url: [] }, snapshot: TEXTEDIT, isFinal: true, lang: "it" });
  assert.equal(all.decision, "confirm");
  assert.equal(all.action.type, "send_keys");
  assert.deepEqual(all.action.keys, ["cmd+a", "delete"]);
  const yes = evaluatePolicy({ answers: answers({ intent: ch("confirm", 0.9) }), candidates: { text: [], url: [] }, snapshot: TEXTEDIT, pending: all.action });
  assert.equal(yes.action.confirmed, true);
  // a weak control leaves "annulla" an undo
  const weak = evaluatePolicy({ answers: answers({ intent: ch("cancel", 0.98), control: ch("key_backspace", 0.5) }), candidates: { text: [], url: [] }, snapshot: TEXTEDIT, isFinal: true });
  assert.equal(weak.action.id, "undo");
});

test("'zoom indietro' is zoom out and 'torna all'app precedente' switches apps; a plain 'indietro' is still history", () => {
  const run = (control, conf) => evaluatePolicy({ answers: answers({ intent: ch("go_back", 0.94), control: ch(control, conf) }), candidates: { text: [], url: [] }, snapshot: TEXTEDIT, isFinal: true });
  assert.equal(run("zoom_out", 1).action.id, "zoom_out");
  assert.equal(run("previous_app", 0.95).action.type, "switch_app_back");
  assert.equal(run("zoom_out", 0.6).action.type, "go_back");
  assert.equal(run("none", 0.9).action.type, "go_back");
  assert.equal(reverseAction({ type: "switch_app_back" }).type, "switch_app_back");
});

test("switch_tab: first..eighth / last are positions (Cmd+1..9), 'none' waits instead of guessing 'next'", () => {
  const run = (dir) => evaluatePolicy({ answers: answers({ intent: ch("switch_tab"), tab_direction: ch(dir) }), candidates: { text: [], url: [] }, snapshot: TEXTEDIT, isFinal: true });
  assert.equal(run("third").action.position, 3);
  assert.equal(run("last").action.position, 9);
  assert.equal(run("first").action.position, 1);
  assert.equal(run("next").action.direction, "next");
  assert.equal(run("next").action.position, undefined);
  assert.equal(run("none").decision, "wait");
  assert.equal(reverseAction({ type: "switch_tab", direction: "third", position: 3 }), null);
  assert.equal(reverseAction({ type: "switch_tab", direction: "next" }).direction, "previous");
});

test("'apri terminale' with a confident app but a hair-under intent is rescued by the open verb", () => {
  const a = answers({ intent: ch("open_app", 0.45), app: ch("Terminal", 0.9), is_command: { noul: 0.4 } });
  const r = evaluatePolicy({ answers: a, candidates: { text: [], url: [], openVerb: true }, snapshot: FINDER, isFinal: true });
  assert.equal(r.action.type, "open_app");
  assert.equal(r.action.app, "Terminal");
  assert.equal(evaluatePolicy({ answers: a, candidates: { text: [], url: [], openVerb: false }, snapshot: FINDER, isFinal: true }).decision, "ignore");
  const weak = answers({ intent: ch("open_app", 0.2), app: ch("Terminal", 0.9) });
  assert.notEqual(evaluatePolicy({ answers: weak, candidates: { text: [], url: [], openVerb: true }, snapshot: FINDER, isFinal: true }).decision, "act");
  assert.equal(startsWithOpenVerb("Apri terminale"), true);
  assert.equal(startsWithOpenVerb("open the calculator"), true);
  assert.equal(startsWithOpenVerb("vai su youtube"), false);
});

// ------------------------------------------------------------------------------------------------ words and numbers

test("Italian and English thousands separators are read as thousands, decimals stay decimals", () => {
  assert.equal(normalizeNumberGrouping("fai 1.500 più 2"), "fai 1500 più 2");
  assert.equal(parseMathExpression("fai 1.500 più 2").resultText, "1502");
  assert.equal(parseMathExpression("fai 1,500 plus 2").resultText, "1502");
  assert.equal(parseMathExpression("calcola 1.500,50 più 1").resultText, "1501.5");
  assert.equal(parseMathExpression("1,500.75 + 1").resultText, "1501.75");
  assert.equal(parseMathExpression("fai 1.000.000 diviso 4").resultText, "250000");
  assert.equal(parseMathExpression("fai 2,5 per 3").resultText, "7.5");
  assert.equal(parseMathExpression("fai 3.5 più 2").resultText, "5.5");
  assert.equal(parseMathExpression("fai 0.500 più 2").resultText, "2.5", "a leading zero is a decimal");
  assert.deepEqual(parseMathExpression("fai 1.500 più 2").keys, ["kp1", "kp5", "kp0", "kp0", "kpplus", "kp2", "kpenter"]);
});

test("end of utterance: demonstratives, 'un po'' and 'di più' are finished phrases; connectors and operators still wait", () => {
  for (const t of ["copy that", "undo this", "no non quello", "scorri un po'", "ingrandisci di più", "abbassa di meno"]) assert.equal(endsOnContinuationWord(t), false, t);
  for (const t of ["fai 7 più", "cerca un video di", "scrivi l'", "search for the", "cerca serie a"]) assert.equal(endsOnContinuationWord(t), true, t);
});

test("candidate pick: only a number (or 'the second one'); 'scrivi due' / 'cerca tre' are commands", () => {
  assert.equal(parseCandidatePick("scrivi due"), null);
  assert.equal(parseCandidatePick("cerca tre"), null);
  assert.equal(parseCandidatePick("apri uno"), null);
  assert.equal(parseCandidatePick("il secondo"), 2);
  assert.equal(parseCandidatePick("the second one"), 2);
  assert.equal(parseCandidatePick("numero tre per favore"), 3);
});

test("the no-model-call confirm shortcut ignores casual agreement words; the rest of the list stays", () => {
  for (const t of ["ok", "okay", "certo", "va bene", "sure", "yeah"]) {
    assert.equal(parseConfirmation(t, { casual: false }), null, t);
    assert.equal(parseConfirmation(t), "confirm", `${t} (default keeps them)`);
  }
  for (const t of ["conferma", "sì fallo", "vai", "yes do it", "go ahead", "confirm"]) assert.equal(parseConfirmation(t, { casual: false }), "confirm", t);
  for (const t of ["annulla", "lascia stare", "never mind"]) assert.equal(parseConfirmation(t, { casual: false }), "cancel", t);
});

// ------------------------------------------------------------------------------------------------ Jev request size

test("the tab question is only asked when the words mention tabs; the control question keeps the examples that matter", () => {
  const snap = SIGNUP;
  assert.equal(buildRequest({ transcript: "scorri giù", snapshot: snap }).questions.tab_direction, undefined);
  for (const t of ["vai alla terza scheda", "go to the last tab", "next tab", "scheda precedente"]) {
    const q = buildRequest({ transcript: t, snapshot: snap }).questions;
    assert.ok(q.tab_direction, t);
    assert.ok("last" in q.tab_direction.criteria && "third" in q.tab_direction.criteria);
  }
  const { questions } = buildRequest({ transcript: "scorri giù", snapshot: snap });
  // plain keys are one-line strings; only the look-alikes Jev gets wrong without worked examples carry them (measured: "copy that", "mute")
  assert.equal(typeof questions.control.criteria.key_enter, "string");
  assert.ok(questions.control.criteria.copy.examples.includes("copy that"));
  assert.ok(questions.control.criteria.volume_mute.examples.includes("mute"));
  assert.ok("previous_app" in questions.control.criteria && "clear_all" in questions.control.criteria);
  assert.equal(buildRequest({ transcript: "apri terminale", snapshot: snap }).candidates.openVerb, true);
});

// ------------------------------------------------------------------------------------------------ desktop executor waits

/** DesktopManager stand-in: probe answers from a script (the last reply repeats), everything else is recorded. */
function fakeDesktop(replies = [{ app: "Safari", browser: true, title: "t", url: "https://x.example.com/" }]) {
  let i = 0;
  const d = {
    calls: [],
    opened: [],
    async call(cmd, args = {}) {
      this.calls.push([cmd, args]);
      if (cmd === "probe") return replies[Math.min(i++, replies.length - 1)];
      return {};
    },
    async overlay() {},
    async open(args) {
      this.opened.push(args);
    },
    async snapshot() {
      return SIGNUP;
    },
    async osascript() {
      return "";
    },
  };
  return d;
}
const probes = (d) => d.calls.filter(([c]) => c === "probe").length;
const timed = async (fn) => {
  const t0 = Date.now();
  await fn();
  return Date.now() - t0;
};

test("reload and re-opening the page that is already open do not wait for a change that cannot come", async () => {
  const same = fakeDesktop();
  const reload = await timed(() => executeDesktop({ type: "reload" }, same));
  assert.ok(reload < 900, `reload took ${reload} ms`); // old cap: 2000 ms
  const again = fakeDesktop();
  const nav = await timed(() => executeDesktop({ type: "navigate_url", url: "https://x.example.com/#top" }, again));
  assert.ok(nav < 900, `same-url navigation took ${nav} ms`); // old cap: 4000 ms
  assert.deepEqual(again.calls.filter(([c]) => c === "open_url").map(([, a]) => a.url), ["https://x.example.com/#top"]);
});

test("plain keys and shortcuts act without polling for a change; Enter and window buttons still settle", async () => {
  for (const action of [
    { type: "press_key", key: "down", mods: [], count: 3 },
    { type: "press_key", key: "tab", mods: [], count: 1 },
    { type: "shortcut", id: "paste", char: "v" },
    { type: "shortcut", id: "undo", char: "z" },
    { type: "shortcut", id: "save", char: "s" },
  ]) {
    const d = fakeDesktop();
    const ms = await timed(() => executeDesktop(action, d));
    assert.equal(probes(d), 1, `${action.type}/${action.key ?? action.id}: one probe before the action, none polling after`);
    assert.ok(ms < 150, `${action.key ?? action.id} took ${ms} ms`);
  }
  const enter = fakeDesktop();
  await executeDesktop({ type: "press_key", key: "return", mods: [], count: 1 }, enter);
  assert.ok(probes(enter) > 1, "Enter polls for a change (a submit navigates)");
});

test("calculate never types into another app: Calculator must be in front first", async () => {
  const action = { type: "calculate", expr: "7*6", display: "7 × 6", result: 42, resultText: "42", keys: ["kp7", "kpmultiply", "kp6", "kpenter"], label: "7 × 6 = 42" };
  const toasts = [];
  // Mail stays in front for the whole wait (Calculator never shows up)
  const d = fakeDesktop([{ app: "Mail" }]);
  d.overlay = async (fn, ...a) => fn === "toast" && toasts.push(a[0]);
  const t0 = Date.now();
  const r = await executeDesktop(action, d);
  assert.equal(r.ok, false);
  assert.match(r.detail, /Calculator not in front/);
  assert.equal(d.calls.some(([c]) => c === "keys"), false, "no synthetic key reached Mail");
  assert.deepEqual(toasts, ["7 × 6 = 42"], "the result is still shown");
  assert.ok(Date.now() - t0 < 5000);
  // the helper cannot probe at all: also no blind typing
  const blind = fakeDesktop([{}]);
  assert.equal((await executeDesktop(action, blind)).ok, false);
  assert.equal(blind.calls.some(([c]) => c === "keys"), false);
});

test("waitForApp matches the bundle folder name too (Visual Studio Code is 'Code' on screen)", async () => {
  const d = fakeDesktop([{ app: "Code", bundleName: "Visual Studio Code" }]);
  const ms = await timed(async () => assert.equal(await waitForApp(d, ["Visual Studio Code"], 3000), true));
  assert.ok(ms < 300, `took ${ms} ms`);
});

test("switch_tab by position presses Cmd+<n>; next / previous stay Ctrl(+Shift)+Tab", async () => {
  const third = fakeDesktop();
  await executeDesktop({ type: "switch_tab", direction: "third", position: 3 }, third);
  assert.deepEqual(third.calls.filter(([c]) => c === "shortcut"), [["shortcut", { char: "3" }]]);
  const last = fakeDesktop();
  await executeDesktop({ type: "switch_tab", direction: "last", position: 9 }, last);
  assert.deepEqual(last.calls.filter(([c]) => c === "shortcut"), [["shortcut", { char: "9" }]]);
  const prev = fakeDesktop();
  await executeDesktop({ type: "switch_tab", direction: "previous" }, prev);
  assert.deepEqual(prev.calls.filter(([c]) => c === "key"), [["key", { key: "tab", mods: ["ctrl", "shift"] }]]);
});

// ------------------------------------------------------------------------------------------------ controller

function fakeBrowser({ snapshotMs = 0 } = {}) {
  const browser = {
    snapshots: 0,
    overlayCalls: [],
    onChange: () => () => {},
    tabInfo: () => [],
    async snapshot() {
      this.snapshots += 1;
      if (snapshotMs) await sleep(snapshotMs);
      return { url: "https://example.com/", title: "Example", site: "example_com", searchBoxId: null, elements: [{ id: "e01", role: "link", text: this.linkText ?? "More information" }], tabs: [] };
    },
    async overlay(fn, ...args) {
      this.overlayCalls.push([fn, ...args]);
    },
  };
  return browser;
}

/** `script(transcript, ch)` -> partial answers; every call is recorded with a timestamp. */
function harness(script, { latency = 5, snapshotMs = 0, lang = "it-IT" } = {}) {
  const browser = fakeBrowser({ snapshotMs });
  const executed = [];
  const calls = [];
  const decideFn = async ({ transcript, pendingConfirmation }) => {
    calls.push({ transcript, pendingConfirmation, at: Date.now() });
    await sleep(latency);
    const s = script(transcript.toLowerCase(), ch) || {};
    return {
      answers: {
        intent: s.intent || ch("none", 0.9),
        target: ch("none", 0.9),
        site: ch("none"),
        control: s.control || ch("none", 0.9),
        complete: { noul: 0.9 },
        is_command: { noul: s.is_command ?? 0.95 },
        destructive: { noul: 0.02 },
        scroll_amount: { score: 1, confidence: 0.9, probabilities: {} },
        tab_direction: ch("none"),
      },
      latencyMs: latency,
      usage: { input_tokens: 1000, output_tokens: 10 },
      costUsd: 0.00004,
      model: "jev-test",
      requestId: "r",
      candidates: { text: [], url: [] },
      state: {},
      questionCount: 9,
    };
  };
  const c = new Controller({ browser, decideFn, executeFn: async (a) => (executed.push(a), { ok: true, detail: "ok" }), lang });
  return { c, browser, executed, calls };
}
const QUIT = { type: "quit_app", app: "Safari", label: "esci da Safari" };

test("a pending confirmation expires: a late 'fallo' is not a confirmation any more", async () => {
  const { c, executed, calls } = harness(() => ({}));
  await c.start();
  c._setPending(QUIT);
  c.pendingAt = Date.now() - PENDING_TTL_MS - 100;
  c.handleTranscript({ text: "fallo", final: true, utteranceId: "t1" });
  await sleep(120);
  assert.deepEqual(executed, [], "Safari was not quit");
  assert.equal(c.pending, null, "expired and dropped");
  assert.equal(calls[0].pendingConfirmation, null, "Jev is not told about a stale prompt");
  await c.close();
});

test("casual 'ok' / 'sure' do not confirm without Jev; 'vai' does, even as a non-final partial", async () => {
  const { c, executed, calls } = harness(() => ({}));
  await c.start();
  c._setPending(QUIT);
  c.handleTranscript({ text: "ok", final: true, utteranceId: "k1" });
  await sleep(120);
  assert.deepEqual(executed, []);
  assert.equal(calls.length, 1, "went to Jev (which sees the pending prompt)");
  assert.ok(calls[0].pendingConfirmation);
  assert.ok(c.pending, "still pending");
  c.handleTranscript({ text: "vai", final: false, utteranceId: "k2" });
  await sleep(40);
  assert.deepEqual(executed, [{ ...QUIT, confirmed: true }]);
  assert.equal(calls.length, 1, "no model call for it");
  await c.close();
});

test("running another command closes the open confirmation", async () => {
  const { c, executed } = harness((t, k) => (t.startsWith("scorri") ? { intent: k("scroll_down") } : {}));
  await c.start();
  c._setPending(QUIT);
  c.handleTranscript({ text: "scorri giù", final: true, utteranceId: "o1" });
  await sleep(150);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, "scroll_down");
  assert.equal(c.pending, null, "the quit prompt did not survive another command");
  c.handleTranscript({ text: "fallo", final: true, utteranceId: "o2" });
  await sleep(120);
  assert.equal(executed.length, 1, "a later 'fallo' quits nothing");
  await c.close();
});

test("the snapshot refresh overlaps the debounce: Jev is asked as soon as the debounce ends, not after a serial walk", async () => {
  const { c, calls, browser } = harness(() => ({}), { snapshotMs: 260 });
  await c.start();
  const startedWith = browser.snapshots;
  c.snapshotAt = 0; // stale
  const t0 = Date.now();
  c.handleTranscript({ text: "apri la calcolatrice", final: false, utteranceId: "w1" });
  await sleep(DEBOUNCE_MS + 350);
  assert.equal(browser.snapshots, startedWith + 1, "one refresh, shared");
  assert.equal(calls.length, 1);
  const lag = calls[0].at - t0;
  // parallel: ~max(150, 260); serial would be 150 + 260 = 410
  assert.ok(lag < 360, `Jev was asked after ${lag} ms`);
  await c.close();
});

test("the recognizer's final does not send a second identical request while the first is still in flight", async () => {
  const { c, calls, executed } = harness((t, k) => (t.startsWith("scorri") ? { intent: k("scroll_down") } : {}), { latency: 400 });
  await c.start();
  c.handleTranscript({ text: "scorri giù", final: false, utteranceId: "x1" });
  await sleep(DEBOUNCE_MS + 150); // the request for the partial is in flight (started ~150 ms, back at ~550 ms)
  c.handleTranscript({ text: "scorri giù", final: true, utteranceId: "x1" });
  await sleep(700);
  assert.equal(calls.length, 1, "one request for one distinct transcript");
  assert.equal(c.uiState().stats.dedupedRequests, 1);
  assert.equal(executed.length, 1, "and it still acted once");
  assert.equal(executed[0].type, "scroll_down");
  await c.close();
});

test("the answer cache sees what is on screen: same ids and url but different text asks Jev again", async () => {
  const { c, calls, browser } = harness(() => ({}));
  await c.start();
  c.handleTranscript({ text: "clicca il primo", final: true, utteranceId: "y1" });
  await sleep(80);
  assert.equal(calls.length, 1);
  browser.linkText = "A different headline"; // re-rendered in place: same id, url and title
  await c.refreshSnapshot();
  c.handleTranscript({ text: "clicca il primo", final: true, utteranceId: "y2" });
  await sleep(80);
  assert.equal(calls.length, 2, "stale answer not reused");
  await c.close();
});
