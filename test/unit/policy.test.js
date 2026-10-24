import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy, topChoices, reverseAction, describe } from "../../src/policy.js";
import { T, SILENCE_COMPLETE_MS, PAYLOAD_SILENCE_MS } from "../../src/constants.js";

/** Build a mocked Jev answer set. */
function answers(over = {}) {
  const choice = (c, conf = 0.95, extra = {}) => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf, none: 1 - conf, ...extra } });
  const base = {
    intent: choice("scroll_down"),
    target: choice("none"),
    site: choice("none"),
    complete: { type: "noul", noul: 0.9 },
    is_command: { type: "noul", noul: 0.95 },
    destructive: { type: "noul", noul: 0.05 },
    scroll_amount: { type: "score", score: 1, confidence: 0.9, probabilities: { 0: 0.05, 1: 0.9, 2: 0.05 } },
    tab_direction: choice("none"),
  };
  return { ...base, ...over };
}
const snapshot = {
  url: "https://en.wikipedia.org/wiki/Main_Page",
  title: "Wikipedia",
  site: "wikipedia",
  searchBoxId: "e02",
  elements: [
    { id: "e01", role: "link", text: "Main page" },
    { id: "e02", role: "searchbox", text: "", placeholder: "Search Wikipedia" },
    { id: "e03", role: "link", text: "Alan Turing" },
    { id: "e04", role: "button", text: "Log in" },
  ],
};
const candidates = { text: [], url: [] };
const ch = (c, conf, extra) => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf, ...extra } });

test("acts on a confident, complete, non-destructive command", () => {
  const r = evaluatePolicy({ answers: answers(), candidates, snapshot });
  assert.equal(r.decision, "act");
  assert.equal(r.action.type, "scroll_down");
  assert.equal(r.action.amount, "page");
  assert.ok(r.reasons.every((x) => x.pass));
});

test("ignores when is_command is below threshold", () => {
  const r = evaluatePolicy({ answers: answers({ is_command: { noul: T.isCommand - 0.1 } }), candidates, snapshot });
  assert.equal(r.decision, "ignore");
  assert.equal(r.reasons.find((x) => x.name === "is_command").pass, false);
});

test("waits when intent confidence is low or intent is none", () => {
  assert.equal(evaluatePolicy({ answers: answers({ intent: ch("scroll_down", T.intentConfidence - 0.05) }), candidates, snapshot }).decision, "wait");
  assert.equal(evaluatePolicy({ answers: answers({ intent: ch("none", 0.99) }), candidates, snapshot }).decision, "wait");
});

test("waits for completeness on partial speech, but silence or a final result bypasses it", () => {
  const a = answers({ intent: ch("navigate_url", 0.9), complete: { noul: 0.2 }, site: ch("wikipedia", 0.9) });
  assert.equal(evaluatePolicy({ answers: a, candidates, snapshot }).decision, "wait");
  assert.equal(evaluatePolicy({ answers: a, candidates, snapshot, silentMs: SILENCE_COMPLETE_MS }).decision, "act");
  assert.equal(evaluatePolicy({ answers: a, candidates, snapshot, isFinal: true }).decision, "act");
});

test("the same completeness threshold applies to every intent (no early scroll on 'scroll to the')", () => {
  const a = answers({ intent: ch("scroll_down", 0.95), complete: { noul: T.complete - 0.05 } });
  assert.equal(evaluatePolicy({ answers: a, candidates, snapshot }).decision, "wait");
  const b = answers({ intent: ch("scroll_down", 0.95), complete: { noul: T.complete + 0.05 } });
  assert.equal(evaluatePolicy({ answers: b, candidates, snapshot }).decision, "act");
});

test("navigate: spoken domain beats site list; known site maps to its home URL; unknown waits", () => {
  const a = answers({ intent: ch("navigate_url", 0.95), url_span: ch("example.com", 0.9) });
  const r = evaluatePolicy({ answers: a, candidates: { text: [], url: ["example.com"] }, snapshot });
  assert.equal(r.action.url, "https://example.com");

  const b = answers({ intent: ch("navigate_url", 0.95), site: ch("youtube", 0.9) });
  assert.equal(evaluatePolicy({ answers: b, candidates, snapshot }).action.url, "https://www.youtube.com/");

  const c = answers({ intent: ch("navigate_url", 0.95), site: ch("none", 0.9) });
  assert.equal(evaluatePolicy({ answers: c, candidates, snapshot }).decision, "wait");
});

test("search: named site template, else on-page search box, else default engine; query copied verbatim", () => {
  const cands = { text: ["alan turing", "for alan turing"], url: [] };
  const a = answers({ intent: ch("search_web", 0.95), site: ch("youtube", 0.9), text_span: ch("alan turing", 0.9) });
  assert.equal(evaluatePolicy({ answers: a, candidates: cands, snapshot, isFinal: true }).action.url, "https://www.youtube.com/results?search_query=alan%20turing");

  const b = answers({ intent: ch("search_web", 0.95), text_span: ch("alan turing", 0.9) });
  const rb = evaluatePolicy({ answers: b, candidates: cands, snapshot, isFinal: true });
  assert.equal(rb.action.type, "type_into_field");
  assert.equal(rb.action.targetId, "e02");
  assert.equal(rb.action.text, "alan turing");
  assert.equal(rb.action.submit, true);

  const rc = evaluatePolicy({ answers: b, candidates: cands, snapshot: { ...snapshot, searchBoxId: null, site: "generic" }, isFinal: true });
  assert.equal(rc.action.url, "https://duckduckgo.com/?q=alan%20turing");

  const d = answers({ intent: ch("search_web", 0.95), text_span: ch("none", 0.9) });
  assert.equal(evaluatePolicy({ answers: d, candidates: cands, snapshot, isFinal: true }).decision, "wait");
});

test("low-confidence text_span falls back to the heuristic top candidate (never invents text)", () => {
  const a = answers({ intent: ch("search_web", 0.95), text_span: ch("for alan turing", 0.2, { "alan turing": 0.3 }) });
  const r = evaluatePolicy({ answers: a, candidates: { text: ["alan turing", "for alan turing"], url: [] }, snapshot, isFinal: true });
  assert.equal(r.action.text, "alan turing");
});

test("click: confident target acts; ambiguous target disambiguates with top candidates", () => {
  const a = answers({ intent: ch("click_element", 0.95), target: ch("e03", 0.9, { e01: 0.05 }) });
  const r = evaluatePolicy({ answers: a, candidates, snapshot });
  assert.equal(r.decision, "act");
  assert.equal(r.action.targetId, "e03");

  const b = answers({ intent: ch("click_element", 0.95), target: ch("e03", 0.2, { e01: 0.3, e04: 0.25, none: 0.1 }) });
  const rb = evaluatePolicy({ answers: b, candidates, snapshot });
  assert.equal(rb.decision, "disambiguate");
  assert.deepEqual(
    rb.candidates.map((c) => c.id),
    ["e03", "e01", "e04"].sort((x, y) => b.target.probabilities[y] - b.target.probabilities[x]),
  );
  assert.equal(rb.pendingIntent.type, "click_element");
});

test("click with no plausible element waits", () => {
  const a = answers({ intent: ch("click_element", 0.95), target: ch("none", 0.99, { e01: 0.005 }) });
  assert.equal(evaluatePolicy({ answers: a, candidates, snapshot }).decision, "wait");
});

test("type: confident target or search-box fallback", () => {
  const cands = { text: ["hello world"], url: [] };
  const a = answers({ intent: ch("type_into_field", 0.95), target: ch("none", 0.9), text_span: ch("hello world", 0.9) });
  const r = evaluatePolicy({ answers: a, candidates: cands, snapshot, isFinal: true });
  assert.equal(r.decision, "act");
  assert.equal(r.action.targetId, "e02");
  assert.equal(r.action.text, "hello world");
});

test("destructive element actions require confirmation; confirm/cancel resolve the pending action", () => {
  const a = answers({ intent: ch("click_element", 0.95), target: ch("e04", 0.95), destructive: { noul: 0.9 } });
  const r = evaluatePolicy({ answers: a, candidates, snapshot });
  assert.equal(r.decision, "confirm");
  assert.equal(r.action.targetId, "e04");

  const yes = evaluatePolicy({ answers: answers({ intent: ch("confirm", 0.9) }), candidates, snapshot, pending: r.action });
  assert.equal(yes.decision, "act");
  assert.equal(yes.action.confirmed, true);
  const no = evaluatePolicy({ answers: answers({ intent: ch("cancel", 0.9) }), candidates, snapshot, pending: r.action });
  assert.equal(no.decision, "cancel");
});

test("destructive flag does not block navigation or scrolling", () => {
  const a = answers({ intent: ch("navigate_url", 0.95), site: ch("github", 0.9), destructive: { noul: 0.9 } });
  assert.equal(evaluatePolicy({ answers: a, candidates, snapshot }).decision, "act");
});

test("scroll amount maps score levels to little / page / end", () => {
  const mk = (score) => answers({ scroll_amount: { score, confidence: 0.9, probabilities: {} } });
  assert.equal(evaluatePolicy({ answers: mk(0.2), candidates, snapshot }).action.amount, "little");
  assert.equal(evaluatePolicy({ answers: mk(1.1), candidates, snapshot }).action.amount, "page");
  assert.equal(evaluatePolicy({ answers: mk(1.8), candidates, snapshot }).action.amount, "end");
});

test("topChoices excludes none and sorts by probability", () => {
  assert.deepEqual(topChoices({ probabilities: { a: 0.2, none: 0.5, b: 0.3 } }, 2), [
    { id: "b", p: 0.3 },
    { id: "a", p: 0.2 },
  ]);
});

test("free-text intents wait for a final result or silence, even when `complete` is high", () => {
  const cands = { text: ["alan"], url: [] };
  const a = answers({ intent: ch("search_web", 0.99), complete: { noul: 0.95 }, text_span: ch("alan", 0.9) });
  const partial = evaluatePolicy({ answers: a, candidates: cands, snapshot, silentMs: 100 });
  assert.equal(partial.decision, "wait");
  assert.ok(partial.retryInMs > 0);
  assert.equal(partial.reasons.find((x) => x.name === "payload_final").pass, false);
  assert.equal(evaluatePolicy({ answers: a, candidates: cands, snapshot, silentMs: PAYLOAD_SILENCE_MS }).decision, "act");
  assert.equal(evaluatePolicy({ answers: a, candidates: cands, snapshot, isFinal: true }).decision, "act");
  // closed-set intents (navigation / click / scroll) do NOT have this gate
  const b = answers({ intent: ch("navigate_url", 0.99), complete: { noul: 0.95 }, site: ch("wikipedia", 0.9) });
  assert.equal(evaluatePolicy({ answers: b, candidates, snapshot, silentMs: 0 }).decision, "act");
});

// ---------------------------------------------------------------- bilingual / desktop / computer use

const ytSnapshot = { ...snapshot, url: "https://www.youtube.com/", site: "youtube", searchBoxId: "e02" };
const ctl = (id, conf = 0.9) => ({ control: ch(id, conf) });
const math = (expr, result, over = {}) => ({
  expr,
  display: expr.replace(/([+*/-])/g, " $1 "),
  result,
  resultText: result == null ? "" : String(result),
  keys: [...expr].map((c) => ({ "+": "kpplus", "-": "kpminus", "*": "kpmultiply", "/": "kpdivide" }[c] || `kp${c}`)).concat("kpenter"),
  hasVerb: true,
  strong: true,
  ...over,
});

test("search on the site it names -> the page's own search field in the same tab, not a URL", () => {
  const a = answers({ intent: ch("search_web", 0.95), site: ch("youtube", 0.9), text_span: ch("macchine", 0.9) });
  const r = evaluatePolicy({ answers: a, candidates: { text: ["macchine"], url: [] }, snapshot: ytSnapshot, isFinal: true });
  assert.equal(r.action.type, "type_into_field");
  assert.equal(r.action.targetId, "e02");
  assert.equal(r.action.submit, true);
});

test("search on another named site -> that site's URL (current tab unless a new one is asked)", () => {
  const a = answers({ intent: ch("search_web", 0.95), site: ch("wikipedia", 0.9), text_span: ch("gatti", 0.9) });
  const r = evaluatePolicy({ answers: a, candidates: { text: ["gatti"], url: [] }, snapshot: ytSnapshot, isFinal: true, lang: "it" });
  assert.equal(r.action.type, "navigate_url");
  assert.match(r.action.url, /^https:\/\/(it|en)\.wikipedia\.org\//);
  assert.equal(r.action.newTab, false);
  const nt = evaluatePolicy({ answers: a, candidates: { text: ["gatti"], url: [], newTab: true }, snapshot: ytSnapshot, isFinal: true });
  assert.equal(nt.action.newTab, true);
});

test("search with no box (omnibox-only snapshot) falls back to the default engine; 'the web' ignores the page box", () => {
  const a = answers({ intent: ch("search_web", 0.95), text_span: ch("gatti", 0.9) });
  const none = evaluatePolicy({ answers: a, candidates: { text: ["gatti"], url: [] }, snapshot: { ...ytSnapshot, searchBoxId: null }, isFinal: true });
  assert.equal(none.action.url, "https://duckduckgo.com/?q=gatti");
  const web = answers({ intent: ch("search_web", 0.95), site: ch("the_web", 0.9), text_span: ch("gatti", 0.9) });
  const r = evaluatePolicy({ answers: web, candidates: { text: ["gatti"], url: [] }, snapshot: ytSnapshot, isFinal: true });
  assert.equal(r.action.type, "navigate_url");
});

test("a payload ending on a connector word never acts, even final; no retryInMs", () => {
  const a = answers({ intent: ch("search_web", 0.95), text_span: ch("un video di", 0.9) });
  const r = evaluatePolicy({ answers: a, candidates: { text: ["un video di"], url: [] }, snapshot: ytSnapshot, isFinal: true, silentMs: 5000 });
  assert.equal(r.decision, "wait");
  assert.equal(r.dangling, true);
  assert.equal(r.retryInMs, undefined);
  const typed = answers({ intent: ch("type_into_field", 0.95), text_span: ch("hello and", 0.9) });
  assert.equal(evaluatePolicy({ answers: typed, candidates: { text: ["hello and"], url: [] }, snapshot: ytSnapshot, isFinal: true }).dangling, true);
});

test("retryInMs only accompanies clock-gated waits", () => {
  const unsure = evaluatePolicy({ answers: answers({ intent: ch("scroll_down", 0.2) }), candidates, snapshot });
  assert.equal(unsure.decision, "wait");
  assert.equal(unsure.retryInMs, undefined);
  const early = evaluatePolicy({ answers: answers({ complete: { noul: 0.1 } }), candidates, snapshot, silentMs: 100 });
  assert.equal(early.retryInMs, Math.max(50, SILENCE_COMPLETE_MS - 100));
  const noSpan = evaluatePolicy({ answers: answers({ intent: ch("search_web", 0.95), text_span: ch("none", 0.9) }), candidates, snapshot, isFinal: true });
  assert.equal(noSpan.retryInMs, undefined);
});

test("navigate / open_new_tab: same tab by default, newTab on request, lucky search for unknown names", () => {
  const a = answers({ intent: ch("navigate_url", 0.95), site: ch("github", 0.9) });
  assert.equal(evaluatePolicy({ answers: a, candidates, snapshot }).action.newTab, false);
  assert.equal(evaluatePolicy({ answers: a, candidates: { text: [], url: [], newTab: true }, snapshot }).action.newTab, true);
  const t = answers({ intent: ch("open_new_tab", 0.95), site: ch("youtube", 0.9) });
  const r = evaluatePolicy({ answers: t, candidates, snapshot });
  assert.equal(r.action.type, "navigate_url");
  assert.equal(r.action.newTab, true);
  assert.equal(evaluatePolicy({ answers: answers({ intent: ch("open_new_tab", 0.95) }), candidates, snapshot }).action.type, "open_new_tab");
  const lucky = answers({ intent: ch("navigate_url", 0.95), site: ch("other_named_site", 0.9), text_span: ch("la repubblica", 0.9) });
  const rl = evaluatePolicy({ answers: lucky, candidates: { text: ["la repubblica"], url: [] }, snapshot, isFinal: true });
  assert.equal(rl.action.url, "https://duckduckgo.com/?q=%5Cla%20repubblica");
});

test("type_into_field: submit comes from candidates.submit", () => {
  const a = answers({ intent: ch("type_into_field", 0.95), target: ch("e02", 0.95), text_span: ch("ciao a tutti", 0.9) });
  const r = evaluatePolicy({ answers: a, candidates: { text: ["ciao a tutti"], url: [], submit: true }, snapshot, isFinal: true });
  assert.equal(r.action.submit, true);
  assert.equal(describe(r.action, "it"), 'scrivi "ciao a tutti" in searchbox "Search Wikipedia" + invio');
});

test("calculate: acts on the parsed expression; invalid waits; strong arithmetic rescues a lost intent", () => {
  const m = math("7+6", 13);
  const a = answers({ intent: ch("calculate", 0.95) });
  const r = evaluatePolicy({ answers: a, candidates: { text: [], url: [], math: m }, snapshot, isFinal: true });
  assert.equal(r.decision, "act");
  assert.deepEqual(r.action, { type: "calculate", expr: "7+6", display: "7 + 6", result: 13, resultText: "13", keys: m.keys, label: "7 + 6 = 13" });
  assert.equal(evaluatePolicy({ answers: a, candidates: { text: [], url: [], math: math("8/0", null) }, snapshot, isFinal: true }).decision, "wait");
  assert.equal(evaluatePolicy({ answers: a, candidates, snapshot, isFinal: true }).decision, "wait");

  // Jev has no confident intent and thinks it is background chatter; the code knows better.
  const lost = answers({ intent: ch("none", 0.9), is_command: { noul: 0.1 }, complete: { noul: 0.1 } });
  const cands = { text: [], url: [], math: m };
  const early = evaluatePolicy({ answers: lost, candidates: cands, snapshot, silentMs: 0 });
  assert.equal(early.decision, "wait", "payload gate still applies");
  assert.ok(early.retryInMs > 0);
  const done = evaluatePolicy({ answers: lost, candidates: cands, snapshot, isFinal: true });
  assert.equal(done.decision, "act");
  assert.equal(done.action.type, "calculate");
  assert.ok(done.reasons.some((x) => x.name === "math_rescue"));
  // a weak match is not rescued
  assert.equal(evaluatePolicy({ answers: lost, candidates: { ...cands, math: math("7+6", 13, { strong: false }) }, snapshot, isFinal: true }).decision, "ignore");
});

test("press_key / system_command resolve through the control question", () => {
  const key = evaluatePolicy({ answers: answers({ intent: ch("press_key", 0.95), ...ctl("key_down") }), candidates: { text: [], url: [], repeat: 3 }, snapshot: ytSnapshot });
  assert.deepEqual(key.action, { type: "press_key", key: "down", mods: [], count: 3, label: key.action.label });
  const tab = evaluatePolicy({ answers: answers({ intent: ch("press_key", 0.95), ...ctl("key_shift_tab") }), candidates, snapshot: ytSnapshot, isFinal: true });
  assert.deepEqual(tab.action.mods, ["shift"]);
  const copy = evaluatePolicy({ answers: answers({ intent: ch("system_command", 0.95), ...ctl("copy") }), candidates, snapshot: ytSnapshot, lang: "it" });
  assert.equal(copy.action.type, "shortcut");
  assert.equal(copy.action.char, "c");
  assert.equal(copy.action.id, "copy");
  const none = evaluatePolicy({ answers: answers({ intent: ch("system_command", 0.95), ...ctl("none", 0.9) }), candidates, snapshot: ytSnapshot });
  assert.equal(none.decision, "wait");
  assert.equal(none.retryInMs, undefined);
  const weak = evaluatePolicy({ answers: answers({ intent: ch("system_command", 0.95), ...ctl("copy", 0.1) }), candidates, snapshot: ytSnapshot });
  assert.equal(weak.decision, "wait");
});

test("desktop-only commands: window, volume, keys, language; blocked in browser mode", () => {
  const desk = { ...ytSnapshot, desktop: true };
  const run = (id, snap = desk) => evaluatePolicy({ answers: answers({ intent: ch("system_command", 0.95), ...ctl(id) }), candidates, snapshot: snap });
  assert.deepEqual(run("close_window").action, { type: "window_op", op: "close", label: run("close_window").action.label });
  assert.equal(run("volume_up").action.op, "up");
  assert.equal(run("screenshot").action.type, "send_keys");
  assert.deepEqual(run("language_it").action, { type: "set_language", locale: "it-IT", label: run("language_it").action.label });
  assert.equal(run("volume_up", ytSnapshot).decision, "wait");
  assert.equal(run("copy", ytSnapshot).decision, "act");
});

test("quit_app always asks for confirmation, then runs confirmed", () => {
  const desk = { ...ytSnapshot, desktop: true };
  const a = answers({ intent: ch("system_command", 0.95), ...ctl("quit_app"), app: ch("Safari", 0.9) });
  const r = evaluatePolicy({ answers: a, candidates, snapshot: desk, lang: "it" });
  assert.equal(r.decision, "confirm");
  assert.equal(r.action.type, "quit_app");
  assert.equal(r.action.app, "Safari");
  assert.match(r.summary, /conferma/);
  const yes = evaluatePolicy({ answers: answers({ intent: ch("confirm", 0.9) }), candidates, snapshot: desk, pending: r.action });
  assert.equal(yes.decision, "act");
  assert.equal(yes.action.confirmed, true);
  // frontmost app when none is named
  assert.equal(evaluatePolicy({ answers: answers({ intent: ch("system_command", 0.95), ...ctl("quit_app") }), candidates, snapshot: desk }).action.app, null);
});

test("cancel: pending -> cancel; no pending -> undo (or 'nothing to undo')", () => {
  const pending = { type: "click_element", targetId: "e04", label: "x" };
  assert.equal(evaluatePolicy({ answers: answers({ intent: ch("cancel", 0.9) }), candidates, snapshot, pending }).decision, "cancel");
  assert.equal(evaluatePolicy({ answers: answers({ intent: ch("go_back", 0.9) }), candidates, snapshot, pending }).decision, "cancel");
  const none = evaluatePolicy({ answers: answers({ intent: ch("cancel", 0.9) }), candidates, snapshot, lang: "it" });
  assert.equal(none.decision, "wait");
  assert.equal(none.summary, "Niente da annullare");
  const context = { recentActions: [{ type: "scroll_down", amount: "page" }] };
  const undo = evaluatePolicy({ answers: answers({ intent: ch("cancel", 0.9) }), candidates, snapshot, context });
  assert.equal(undo.action.type, "scroll_up");
  assert.equal(evaluatePolicy({ answers: answers({ intent: ch("confirm", 0.9) }), candidates, snapshot }).decision, "wait");
});

test("a correction after an irreversible action has nothing to undo", () => {
  const context = { recentActions: [{ type: "shortcut", id: "copy" }] };
  const r = evaluatePolicy({ answers: answers({ intent: ch("none", 0.5), is_correction: { noul: 0.9 } }), candidates, snapshot, context });
  assert.equal(r.decision, "wait");
});

test("reverseAction: new mappings and null cases", () => {
  assert.equal(reverseAction({ type: "navigate_url", url: "https://a", newTab: true }).type, "close_tab");
  assert.equal(reverseAction({ type: "navigate_url", url: "https://a" }).type, "go_back");
  assert.equal(reverseAction({ type: "shortcut", id: "paste" }).char, "z");
  assert.deepEqual(reverseAction({ type: "shortcut", id: "undo" }), { type: "shortcut", id: "redo", char: "z", shift: true, label: "redo" });
  assert.equal(reverseAction({ type: "shortcut", id: "redo" }).id, "undo");
  assert.equal(reverseAction({ type: "volume", op: "up" }).op, "down");
  assert.equal(reverseAction({ type: "volume", op: "mute" }).op, "unmute");
  for (const type of ["window_op", "quit_app", "send_keys", "calculate", "set_language", "press_key"]) assert.equal(reverseAction({ type }), null, type);
  assert.equal(reverseAction({ type: "shortcut", id: "copy" }), null);
  assert.equal(reverseAction({ type: "shortcut", id: "save" }), null);
});

test("describe: English strings unchanged, Italian templates", () => {
  assert.equal(describe({ type: "open_app", app: "Safari" }), "open Safari");
  assert.equal(describe({ type: "open_app", app: "Safari" }, "it"), "apri Safari");
  assert.equal(describe({ type: "navigate_url", label: "youtube", url: "u" }), "open youtube");
  assert.equal(describe({ type: "click_element", targetId: "e1", label: 'link "A"' }, "it"), 'clicca link "A"');
  assert.equal(describe({ type: "select_option", targetId: "e1", text: "date", label: "menu" }), 'select "date" in menu');
  assert.equal(describe({ type: "type_into_field", targetId: "e1", text: "hi", submit: true, label: "box" }), 'type "hi" into box + enter');
  assert.equal(describe({ type: "press_key", key: "down", mods: [], count: 3 }, "en"), "press down ×3");
  assert.equal(describe({ type: "scroll_down", label: "scroll down (page)" }), "scroll down (page)");
});
