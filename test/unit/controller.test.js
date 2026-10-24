/**
 * Controller flow with a mocked Jev and a fake browser: debounce, one action per utterance,
 * stale-request handling, candidate picking by number, chaining commands in one breath.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../../src/controller.js";
import { DEBOUNCE_MS } from "../../src/constants.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeBrowser() {
  return {
    url: "https://example.com/",
    onChange() {
      return () => {};
    },
    tabInfo() {
      return [{ index: 0, url: this.url, active: true }];
    },
    async snapshot() {
      return {
        url: this.url,
        title: "Example",
        site: "example_com",
        searchBoxId: null,
        elements: [
          { id: "e01", role: "link", text: "More information" },
          { id: "e02", role: "link", text: "Other link" },
        ],
        tabs: this.tabInfo(),
      };
    },
    overlayCalls: [],
    async overlay(fn, ...args) {
      this.overlayCalls.push([fn, ...args]);
    },
  };
}

/** Mock Jev: keyword-driven answers, with configurable latency. */
function mockDecide({ latency = 20, complete = (t) => (t.split(" ").length >= 2 ? 0.9 : 0.1) } = {}) {
  const calls = [];
  const fn = async ({ transcript }, { signal } = {}) => {
    calls.push(transcript);
    await sleep(latency);
    if (signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    const t = transcript.toLowerCase();
    const ch = (c, conf = 0.95, extra = {}) => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf, ...extra } });
    let intent = ch("none", 0.9);
    let target = ch("none", 0.9);
    if (t.startsWith("go back")) intent = ch("go_back");
    else if (t.startsWith("scroll")) intent = ch("scroll_down");
    else if (t.startsWith("click ambiguous")) {
      intent = ch("click_element");
      target = ch("e01", 0.2, { e02: 0.4, none: 0.2 });
    } else if (t.startsWith("click")) {
      intent = ch("click_element");
      target = ch("e01", 0.95);
    }
    return {
      answers: {
        intent,
        target,
        site: ch("none"),
        complete: { noul: complete(t) },
        is_command: { noul: intent.choice === "none" ? 0.1 : 0.95 },
        destructive: { noul: 0.02 },
        scroll_amount: { score: 1, confidence: 0.9, probabilities: {} },
        tab_direction: ch("none"),
      },
      latencyMs: latency,
      usage: { input_tokens: 1000, output_tokens: 10 },
      costUsd: 0.000042,
      model: "jev-1.13.0",
      requestId: "req",
      candidates: { text: [], url: [] },
      state: {},
      questionCount: 8,
    };
  };
  fn.calls = calls;
  return fn;
}

function setup(opts = {}) {
  const browser = fakeBrowser();
  const executed = [];
  const decideFn = mockDecide(opts);
  const executeFn = async (action) => {
    executed.push(action);
    await sleep(opts.execMs ?? 10);
    return { ok: true, detail: "ok" };
  };
  const c = new Controller({ browser, decideFn, executeFn });
  return { c, browser, executed, decideFn };
}

test("debounces partials into one request and acts once per utterance", async () => {
  const { c, executed, decideFn } = setup();
  await c.start();
  c.handleTranscript({ text: "go", final: false, utteranceId: "u1" });
  await sleep(50);
  c.handleTranscript({ text: "go back", final: false, utteranceId: "u1" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, "go_back");
  assert.equal(decideFn.calls.length, 1, "first partial was debounced away");
  // the rest of the same utterance is ignored
  c.handleTranscript({ text: "go back please", final: true, utteranceId: "u1" });
  await sleep(DEBOUNCE_MS + 100);
  assert.equal(executed.length, 1);
  assert.equal(c.uiState().stats.calls, 1);
  assert.ok(c.uiState().stats.costUsd > 0);
  await c.close();
});

test("waits on an incomplete partial, then acts when the recognizer marks it final", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleTranscript({ text: "scroll", final: false, utteranceId: "u2" });
  await sleep(DEBOUNCE_MS + 100);
  assert.equal(executed.length, 0);
  assert.equal(c.lastDecision.policy.decision, "wait");
  c.handleTranscript({ text: "scroll", final: true, utteranceId: "u2" });
  await sleep(150);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, "scroll_down");
  await c.close();
});

test("cancels stale in-flight requests beyond MAX_INFLIGHT", async () => {
  const { c, executed, decideFn } = setup({ latency: 400 });
  await c.start();
  c.handleTranscript({ text: "go ba", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  c.handleTranscript({ text: "go bac", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  c.handleTranscript({ text: "go back", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  assert.equal(c.inflight.length, 2, "oldest request aborted, two in flight");
  await sleep(600);
  assert.equal(executed.length, 1);
  assert.equal(decideFn.calls.length, 3);
  await c.close();
});

test("ambiguous target shows numbered candidates; a spoken number picks without a model call", async () => {
  const { c, executed, browser, decideFn } = setup();
  await c.start();
  c.handleTranscript({ text: "click ambiguous thing", final: true, utteranceId: "u4" });
  await sleep(150);
  assert.equal(executed.length, 0);
  assert.ok(c.candidates, "candidates pending");
  assert.deepEqual(
    c.candidates.list.map((x) => x.id),
    ["e02", "e01"],
  );
  assert.ok(browser.overlayCalls.some(([fn]) => fn === "candidates"));
  const callsBefore = decideFn.calls.length;
  c.handleTranscript({ text: "the second one", final: true, utteranceId: "u5" });
  await sleep(100);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].targetId, "e01");
  assert.equal(decideFn.calls.length, callsBefore, "no Jev call for the number");
  await c.close();
});

test("commands spoken in one breath: words after an executed command become a new command", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleTranscript({ text: "go back", final: false, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 1);
  c.handleTranscript({ text: "go back scroll down", final: false, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 2);
  assert.equal(executed[1].type, "scroll_down");
  // one trailing word is ignored
  c.handleTranscript({ text: "go back scroll down please", final: true, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 2);
  await c.close();
});

test("typed command is treated as a final utterance", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleCommand("go back");
  await sleep(150);
  assert.equal(executed.length, 1);
  await c.close();
});

// ---------------------------------------------------------------- cache, retries, unclear toast, confirmation, language

const toasts = (browser) => browser.overlayCalls.filter(([fn]) => fn === "toast").map(([, text]) => text);

/** Mock Jev with full control over answers/candidates per transcript. */
function scriptedDecide(script) {
  const calls = [];
  const ch = (c, conf = 0.95, extra = {}) => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf, ...extra } });
  const fn = async ({ transcript }) => {
    calls.push(transcript);
    const s = script(transcript.toLowerCase(), ch) || {};
    return {
      answers: {
        intent: s.intent || ch("none", 0.9),
        target: ch("none", 0.9),
        site: ch("none"),
        control: s.control || ch("none", 0.9),
        text_span: s.text_span,
        complete: { noul: s.complete ?? 0.9 },
        is_command: { noul: s.is_command ?? 0.95 },
        destructive: { noul: 0.02 },
        scroll_amount: { score: 1, confidence: 0.9, probabilities: {} },
        tab_direction: ch("none"),
      },
      latencyMs: 5,
      usage: { input_tokens: 1000, output_tokens: 10 },
      costUsd: 0.000042,
      model: "jev-1.13.0",
      requestId: "req",
      candidates: { text: [], url: [], ...(s.candidates || {}) },
      state: {},
      questionCount: 9,
    };
  };
  fn.calls = calls;
  return fn;
}

function setupScripted(script, opts = {}) {
  const browser = fakeBrowser();
  browser.setLangCalls = [];
  browser.setLang = async (l) => browser.setLangCalls.push(l);
  const executed = [];
  const decideFn = scriptedDecide(script);
  const c = new Controller({ browser, decideFn, executeFn: async (a) => (executed.push(a), { ok: true, detail: "ok" }), ...opts });
  return { c, browser, executed, decideFn };
}

test("an identical transcript is not sent to Jev twice while nothing changed (answer cache)", async () => {
  const { c, decideFn } = setupScripted(() => ({}));
  await c.start();
  c.handleTranscript({ text: "fai sette", final: false, utteranceId: "a1" });
  await sleep(DEBOUNCE_MS + 80);
  c.handleTranscript({ text: "fai sette", final: false, utteranceId: "a2" }); // new utterance, same words
  await sleep(DEBOUNCE_MS + 80);
  c.handleTranscript({ text: "fai sette", final: true, utteranceId: "a2" }); // same words, now final
  await sleep(80);
  assert.equal(decideFn.calls.length, 1, "one Jev call for one distinct transcript");
  assert.ok(c.uiState().stats.cacheHits >= 2);
  assert.equal(c.lastDecision.cached, true);
  assert.equal(c.uiState().stats.calls, 1);
  c.handleTranscript({ text: "fai otto", final: true, utteranceId: "a3" });
  await sleep(80);
  assert.equal(decideFn.calls.length, 2);
  await c.close();
});

test("waits without a clock gate are not polled (no 10x identical-transcript loop)", async () => {
  const { c, decideFn } = setupScripted(() => ({}));
  await c.start();
  c.handleTranscript({ text: "scegli google", final: false, utteranceId: "b1" });
  await sleep(DEBOUNCE_MS + 1200);
  assert.equal(decideFn.calls.length, 1);
  assert.equal(c.lastDecision.policy.decision, "wait");
  await c.close();
});

test("a final utterance that is still not understood gets exactly one 'didn't get that' toast", async () => {
  const { c, browser } = setupScripted(() => ({}));
  const events = [];
  c.on("unclear", (e) => events.push(e));
  await c.start();
  c.handleTranscript({ text: "blah blah", final: false, utteranceId: "c1" });
  await sleep(DEBOUNCE_MS + 80);
  assert.deepEqual(toasts(browser), [], "partials never toast");
  c.handleTranscript({ text: "blah blah", final: true, utteranceId: "c1" });
  await sleep(120);
  assert.deepEqual(toasts(browser), ["Didn't get that"]);
  assert.equal(events.length, 1);
  assert.equal(c.uiState().stats.unclear, 1);
  await c.close();
});

test("the toast is Italian when the recognizer language is Italian; ignore never toasts", async () => {
  const { c, browser } = setupScripted((t) => (t === "chiacchiere" ? { is_command: 0.05 } : {}), { lang: "it-IT" });
  await c.start();
  assert.equal(c.uiState().lang, "it-IT");
  c.handleTranscript({ text: "chiacchiere", final: true, utteranceId: "d1" });
  await sleep(120);
  assert.deepEqual(toasts(browser), []);
  c.handleTranscript({ text: "boh mah", final: true, utteranceId: "d2" });
  await sleep(120);
  assert.deepEqual(toasts(browser), ["Non ho capito"]);
  await c.close();
});

test("a final phrase ending on a connector word toasts 'sentence unfinished' and never acts", async () => {
  const { c, browser, executed } = setupScripted(
    (t, ch) => ({ intent: ch("search_web"), text_span: ch("un video di", 0.9), candidates: { text: ["un video di"] } }),
  );
  await c.start();
  c.handleTranscript({ text: "cerca un video di", final: true, utteranceId: "e1" });
  await sleep(150);
  assert.equal(executed.length, 0);
  assert.deepEqual(toasts(browser), ["Sentence unfinished"]);
  await c.close();
});

test("clock-gated waits are retried by the controller (free text acts after the payload silence)", async () => {
  const { c, executed, decideFn } = setupScripted(
    (t, ch) => ({ intent: ch("search_web"), text_span: ch("macchine", 0.9), candidates: { text: ["macchine"] } }),
  );
  await c.start();
  c.handleTranscript({ text: "cerca macchine", final: false, utteranceId: "f1" });
  await sleep(DEBOUNCE_MS + 900);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, "navigate_url");
  assert.equal(decideFn.calls.length, 1, "the retry used the cached answer");
  await c.close();
});

test("with a confirmation pending, 'conferma' / 'annulla' are resolved without a Jev call", async () => {
  const { c, executed, decideFn, browser } = setupScripted(() => ({}), { lang: "it-IT" });
  await c.start();
  const pending = { type: "quit_app", app: "Safari", label: "esci da Safari" };
  c._setPending(pending);
  c.handleTranscript({ text: "fallo", final: true, utteranceId: "g1" });
  await sleep(60);
  assert.deepEqual(executed, [{ ...pending, confirmed: true }]);
  assert.equal(c.pending, null);
  c._setPending(pending);
  c.handleTranscript({ text: "annulla", final: true, utteranceId: "g3" });
  await sleep(60);
  assert.equal(executed.length, 1);
  assert.equal(c.pending, null);
  assert.ok(toasts(browser).includes("Annullato"));
  assert.equal(decideFn.calls.length, 0);
  await c.close();
});

test("set_language retargets the recognizer and the toast language without reaching an executor", async () => {
  const { c, browser, executed } = setupScripted((t, ch) => ({ intent: ch("system_command"), control: ch("language_it", 0.95) }));
  const langs = [];
  c.on("lang", (e) => langs.push(e));
  await c.start();
  assert.equal(c.uiLang, "en");
  c.handleTranscript({ text: "parla italiano", final: true, utteranceId: "h1" });
  await sleep(150);
  assert.equal(executed.length, 0);
  assert.deepEqual(browser.setLangCalls, ["it-IT"]);
  assert.equal(c.lang, "it-IT");
  assert.equal(c.uiLang, "it");
  assert.equal(langs.length, 1);
  assert.equal(c.uiState().lang, "it-IT");
  await c.close();
});
