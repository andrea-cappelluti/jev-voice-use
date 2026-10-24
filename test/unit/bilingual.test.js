/**
 * Bilingual / speed acceptance checks that need no helper and no network: the four scenarios from the
 * diagnosed session log (S1-S5), the end-of-utterance rule, the clock-gate numbers and the condition waits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDesktopSnapshot, executeDesktop, waitForChange } from "../../src/desktop.js";
import { findSearchBox } from "../../src/snapshot.js";
import { evaluatePolicy } from "../../src/policy.js";
import { endsOnContinuationWord, parseCandidatePick } from "../../src/spans.js";
import { Controller } from "../../src/controller.js";
import { DEBOUNCE_MS, DESKTOP_WAIT, PAYLOAD_SILENCE_MS, SILENCE_COMPLETE_MS, UI_TEXT } from "../../src/constants.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ch = (c, conf = 0.95, extra = {}) => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf, ...extra } });
const el = (id, role, text, o = {}) => ({ id, role, type: "", text, placeholder: "", left: 100, top: 200, w: 120, h: 24, web: true, ...o });

// ------------------------------------------------------------------ S2: the search box is never the omnibox

const OMNIBOX = el("e01", "textbox", "Barra degli indirizzi e di ricerca", { left: 200, top: 80, w: 600, h: 28, web: false });
const YT_BOX = el("e02", "combobox", "", { placeholder: "Cerca", left: 300, top: 150, w: 500, h: 30, web: true });
const CHROME = { app: "Google Chrome", bundle: "com.google.Chrome", title: "YouTube", url: "https://www.youtube.com/" };

test("S2: Chrome omnibox (top 80) vs YouTube combobox (top 150): the page box wins, with or without web flags", () => {
  assert.equal(buildDesktopSnapshot({ ...CHROME, elements: [OMNIBOX, YT_BOX] }).searchBoxId, "e02");
  // the helper predates the web flag: the address-bar pattern alone must exclude the omnibox
  const noFlags = [OMNIBOX, YT_BOX].map(({ web, ...rest }) => rest);
  assert.equal(findSearchBox(noFlags), "e02");
  assert.equal(buildDesktopSnapshot({ ...CHROME, elements: noFlags }).searchBoxId, "e02");
  // only the omnibox: no page box at all
  assert.equal(buildDesktopSnapshot({ ...CHROME, elements: [OMNIBOX] }).searchBoxId, null);
  // a native search field outside any browser is still the search box
  const finder = { app: "Finder", bundle: "com.apple.finder", title: "Docs", elements: [el("e01", "menu", "File", { web: false }), el("e02", "searchbox", "", { placeholder: "Cerca", web: false })] };
  assert.equal(buildDesktopSnapshot(finder).searchBoxId, "e02");
});

test("S2: browser toolbar elements are tagged for Jev, page elements are not", () => {
  const s = buildDesktopSnapshot({ ...CHROME, elements: [OMNIBOX, YT_BOX] });
  assert.equal(s.elements.find((e) => e.id === "e01").toolbar, true);
  assert.equal(s.elements.find((e) => e.id === "e02").toolbar, undefined);
  assert.equal(buildDesktopSnapshot({ app: "Finder", elements: [{ ...OMNIBOX, web: false }] }).elements[0].toolbar, undefined, "only in a browser");
});

// ------------------------------------------------------------------ fakes

/** Fake desktop whose probe answers from a script (the last reply repeats). */
function fakeDesktop(replies = [{}]) {
  let i = 0;
  return {
    calls: [],
    opened: [],
    async call(cmd, args = {}) {
      this.calls.push([cmd, args]);
      if (cmd === "probe") {
        const r = replies[Math.min(i++, replies.length - 1)];
        if (r instanceof Error) throw r;
        return r;
      }
      return {};
    },
    async overlay() {},
    async open(args) {
      this.opened.push(args);
    },
    async snapshot() {
      return buildDesktopSnapshot({ app: "Finder", elements: [] });
    },
  };
}
const order = (d) => d.calls.filter(([c]) => c !== "overlay").map(([c]) => c);

test("S1d: with a non-browser in front (Terminal) a URL goes through `open`; with a browser, never", async () => {
  const term = fakeDesktop([{ app: "Terminal", browser: false }, { app: "Safari" }]);
  await executeDesktop({ type: "navigate_url", url: "https://github.com/" }, term);
  assert.deepEqual(term.opened, [["https://github.com/"]]);
  assert.ok(!order(term).includes("open_url"));
  const chrome = fakeDesktop([{ app: "Google Chrome", browser: true, title: "a", url: "u1" }, { app: "Google Chrome", browser: true, title: "b", url: "u2" }]);
  await executeDesktop({ type: "navigate_url", url: "https://www.google.com/search?q=macchine", newTab: false }, chrome);
  assert.deepEqual(chrome.opened, []);
  assert.deepEqual(chrome.calls.find(([c]) => c === "open_url")[1], { url: "https://www.google.com/search?q=macchine", newTab: false });
});

// ------------------------------------------------------------------ S4c: Calculator is brought to the front first

test("S4c: not in Calculator -> activate, wait for the app, then clear + keypad keys, in that order", async () => {
  const action = { type: "calculate", expr: "7+6", display: "7 + 6", result: 13, resultText: "13", keys: ["kp7", "kpplus", "kp6", "kpenter"], label: "7 + 6 = 13" };
  const d = fakeDesktop([{ app: "Finder" }, { app: "Finder" }, { app: "Calcolatrice" }, { app: "Calcolatrice" }]);
  const r = await executeDesktop(action, d);
  assert.equal(r.ok, true);
  const seq = order(d);
  assert.ok(seq.indexOf("activate") < seq.lastIndexOf("probe"), "activate before polling for the app");
  assert.ok(seq.lastIndexOf("probe") < seq.indexOf("keys"), "keys only once Calculator is in front");
  assert.deepEqual(d.calls.find(([c]) => c === "keys")[1], { keys: ["escape", "escape", "kp7", "kpplus", "kp6", "kpenter"] });
});

// ------------------------------------------------------------------ S4 policy: from any app, with the Italian / English phrases

test("S4: arithmetic phrases yield the calculate action from Finder and Calculator, rescued when Jev loses the intent", () => {
  const snap = buildDesktopSnapshot({ app: "Finder", bundle: "com.apple.finder", title: "x", elements: [] });
  const base = { intent: ch("none", 0.2), site: ch("none"), target: ch("none"), is_command: { noul: 0.1 }, complete: { noul: 0.1 }, destructive: { noul: 0.02 } };
  const cases = [["Fai 7 + 6", "7+6", 13], ["calcola 7 per 6", "7*6", 42], ["quanto fa 12 diviso 4", "12/4", 3], ["fai sette più sei", "7+6", 13], ["what is 5 times 3", "5*3", 15], ["calculate 9 minus 3", "9-3", 6]];
  return import("../../src/math.js").then(({ parseMathExpression }) => {
    for (const [said, expr, result] of cases) {
      const math = parseMathExpression(said);
      const r = evaluatePolicy({ answers: base, candidates: { text: [], url: [], math }, snapshot: snap, isFinal: true, lang: "it" });
      assert.equal(r.decision, "act", said);
      assert.equal(r.action.type, "calculate");
      assert.equal(r.action.expr, expr);
      assert.equal(r.action.result, result);
    }
    const partial = evaluatePolicy({ answers: { ...base, intent: ch("calculate") , is_command: { noul: 0.9 } }, candidates: { text: [], url: [], math: parseMathExpression("fai 7 più") }, snapshot: snap, isFinal: false, silentMs: 3000 });
    assert.equal(partial.decision, "wait");
    assert.equal(partial.retryInMs, undefined);
    const zero = evaluatePolicy({ answers: { ...base, intent: ch("calculate"), is_command: { noul: 0.9 }, complete: { noul: 0.9 } }, candidates: { text: [], url: [], math: parseMathExpression("8 diviso 0") }, snapshot: snap, isFinal: true });
    assert.equal(zero.decision, "wait");
  });
});

// ------------------------------------------------------------------ speed: end of utterance and clock gates

test("endsOnContinuationWord: the phrase is unfinished (IT + EN, elisions), the commands are finished", () => {
  for (const t of ["cerca un video di", "fai 7 più", "scrivi ciao a", "cerca nell'", "search for the", "Cerca su.", "type hello and"]) assert.equal(endsOnContinuationWord(t), true, t);
  for (const t of ["cerca macchine", "apri safari", "go back", "", "premi invio", "scorri giù"]) assert.equal(endsOnContinuationWord(t), false, t);
});

test("policy never acts on a free-text payload ending on a connector, partial or final, even after long silence", () => {
  const snap = { desktop: true, browser: true, app: "Google Chrome", url: "https://www.youtube.com/", site: "youtube", searchBoxId: "e05", elements: [] };
  for (const text of ["un video di", "video di macchine e", "the"]) {
    for (const isFinal of [false, true]) {
      const r = evaluatePolicy({ answers: { intent: ch("search_web"), site: ch("none"), target: ch("none"), text_span: ch(text, 0.9), is_command: { noul: 0.9 }, complete: { noul: 0.9 }, destructive: { noul: 0.01 } }, candidates: { text: [text], url: [] }, snapshot: snap, isFinal, silentMs: 5000 });
      assert.equal(r.decision, "wait", text);
      assert.equal(r.dangling, true);
      assert.equal(r.action, undefined);
    }
  }
});

test("clock gates: complete retries after SILENCE_COMPLETE_MS, payload after PAYLOAD_SILENCE_MS (floor 50), nothing else retries", () => {
  assert.equal(SILENCE_COMPLETE_MS, 700);
  assert.equal(PAYLOAD_SILENCE_MS, 600);
  const snap = { desktop: true, browser: true, app: "Google Chrome", url: "https://www.youtube.com/", site: "youtube", searchBoxId: "e05", elements: [] };
  const a = (over) => ({ intent: ch("scroll_down"), site: ch("none"), target: ch("none"), is_command: { noul: 0.9 }, complete: { noul: 0.1 }, destructive: { noul: 0.01 }, scroll_amount: { score: 1, confidence: 0.9, probabilities: {} }, ...over });
  const run = (answers, silentMs, cand = {}) => evaluatePolicy({ answers, candidates: { text: [], url: [], ...cand }, snapshot: snap, silentMs });
  assert.equal(run(a(), 100).retryInMs, 600);
  assert.equal(run(a(), 690).retryInMs, 50);
  const search = a({ intent: ch("search_web"), text_span: ch("macchine", 0.9), complete: { noul: 0.9 } });
  assert.equal(run(search, 100, { text: ["macchine"] }).retryInMs, 500);
  assert.equal(run(search, 590, { text: ["macchine"] }).retryInMs, 50);
  assert.equal(run(search, 600, { text: ["macchine"] }).decision, "act");
  // waits that no passing clock can flip carry no retry
  assert.equal(run(a({ intent: ch("none", 0.9) }), 100).retryInMs, undefined);
  assert.equal(run(a({ intent: ch("click_element"), complete: { noul: 0.9 }, target: ch("none", 0.9) }), 100).retryInMs, undefined);
  assert.equal(run(search, 100, { text: [] }).retryInMs, undefined, "no text candidate at all");
});

// ------------------------------------------------------------------ speed: condition waits

test("waitForChange: instant on a probe that says nothing, resolves on the first poll that differs, caps otherwise", async () => {
  let t = Date.now();
  assert.equal(await waitForChange(fakeDesktop([{}]), {}, 4000), false);
  assert.ok(Date.now() - t < 60, "no probe support: no waiting");
  const before = { app: "Chrome", title: "A", url: "u" };
  t = Date.now();
  assert.equal(await waitForChange(fakeDesktop([before, before, { ...before, title: "B" }]), before, 4000), true);
  const took = Date.now() - t;
  assert.ok(took < DESKTOP_WAIT.pollMs * 2 + DESKTOP_WAIT.settleMs + 200, `resolved on the third poll, not the 4 s cap (${took} ms)`);
  t = Date.now();
  assert.equal(await waitForChange(fakeDesktop([before]), before, 250), false);
  assert.ok(Date.now() - t < 450);
});

// ------------------------------------------------------------------ numbered picks

test("numbered picks, IT + EN, need no Jev call", () => {
  const picks = [["uno", 1], ["il secondo", 2], ["terza", 3], ["numero due", 2], ["the third one", 3], ["number two", 2], ["il primo", 1], ["first", 1]];
  for (const [said, n] of picks) assert.equal(parseCandidatePick(said, 5), n, said);
  assert.equal(parseCandidatePick("apri youtube", 5), null);
});

// ------------------------------------------------------------------ S5: no wasted Jev calls (controller + mock Jev)

function controllerWith(script, lang = "it-IT") {
  const toasts = [];
  const executed = [];
  const calls = [];
  const browser = {
    onChange: () => () => {},
    tabInfo: () => [],
    snapshot: async () => ({ url: "app://Finder/x", title: "x", site: "generic", searchBoxId: null, elements: [{ id: "e01", role: "button", text: "Google" }, { id: "e02", role: "button", text: "Bing" }], tabs: [] }),
    overlay: async (fn, ...a) => fn === "toast" && toasts.push(a[0]),
  };
  const decideFn = async ({ transcript }) => {
    calls.push(transcript);
    const s = script(transcript.toLowerCase()) || {};
    return {
      answers: { intent: s.intent || ch("none", 0.9), target: s.target || ch("none", 0.9), site: ch("none"), control: ch("none", 0.9), complete: { noul: s.complete ?? 0.9 }, is_command: { noul: s.is_command ?? 0.9 }, destructive: { noul: 0.02 }, scroll_amount: { score: 1, confidence: 0.9, probabilities: {} }, tab_direction: ch("none") },
      latencyMs: 5, usage: { input_tokens: 1000, output_tokens: 10 }, costUsd: 0.00004, model: "m", requestId: "r",
      candidates: { text: [], url: [], ...(s.candidates || {}) }, state: {}, questionCount: 9,
    };
  };
  const c = new Controller({ browser, decideFn, executeFn: async (a) => (executed.push(a), { ok: true, detail: "ok" }), lang });
  return { c, toasts, executed, calls };
}

test("S5: 'Fai 7 + 6' that Jev does not understand: one call across 3 s of silence, none on the final, one 'Non ho capito'", async () => {
  // a Jev that finds no intent in it, with an expression the code cannot evaluate either
  const { c, calls, toasts } = controllerWith(() => ({ candidates: { math: { expr: "7+", display: "7 +", result: null, resultText: "", keys: [], hasVerb: true, strong: false } } }));
  await c.start();
  c.handleTranscript({ text: "Fai 7 + 6", final: false, utteranceId: "s1" });
  await sleep(DEBOUNCE_MS + 3000);
  assert.equal(calls.length, 1, "silence alone never re-asks Jev");
  c.handleTranscript({ text: "Fai 7 + 6", final: true, utteranceId: "s1" });
  await sleep(150);
  assert.equal(calls.length, 1, "the final of an unchanged transcript is a cache hit");
  assert.deepEqual(toasts, [UI_TEXT.it.unclear]);
  await c.close();
});

test("S5: 'Scegli Google' fed 10 times as identical partials costs one call", async () => {
  const { c, calls } = controllerWith((t) => (t.startsWith("scegli") ? { intent: ch("click_element"), target: ch("e01", 0.2, { e02: 0.3, none: 0.3 }), complete: 0.9 } : {}));
  await c.start();
  for (let i = 0; i < 10; i++) {
    c.handleTranscript({ text: "Scegli Google", final: false, utteranceId: "g1" });
    await sleep(60);
  }
  await sleep(DEBOUNCE_MS + 400);
  assert.equal(calls.length, 1);
  await c.close();
});
