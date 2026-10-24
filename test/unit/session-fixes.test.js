/**
 * Regression tests for the live-session review: WebSocket origin check, missing desktop commands, named-app window
 * operations, "scrivi a <name>", recognizer hints and action labels.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrustedOrigin } from "../../src/server.js";
import { evaluatePolicy, reverseAction, describe } from "../../src/policy.js";
import { buildDesktopSnapshot, executeDesktop, DesktopManager } from "../../src/desktop.js";
import { buildRequest } from "../../src/jev.js";
import { extractTextCandidates } from "../../src/spans.js";
import { CONTROL_OPTIONS, INTENT_CRITERIA, RECOGNITION_HINTS } from "../../src/constants.js";

const ch = (c, conf = 0.95) => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf, none: 1 - conf } });
function answers(over = {}) {
  return {
    intent: ch("system_command"),
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
const APPS = ["Calculator", "Google Chrome", "Safari", "Finder"];
const CHROME = buildDesktopSnapshot({ app: "Google Chrome", bundle: "com.google.Chrome", title: "WhatsApp", url: "https://web.whatsapp.com/", elements: [] }, APPS);
const candidates = { text: [], url: [] };
const control = (id, over = {}) => evaluatePolicy({ answers: answers({ control: ch(id, 0.9), ...over }), candidates, snapshot: CHROME, lang: "it", isFinal: true });

/** A DesktopManager stand-in: `replies` answers helper commands by name, `front` is the app `probe` reports. */
function fakeDesktop({ replies = {}, front = "Google Chrome" } = {}) {
  return {
    calls: [],
    opened: [],
    appAliases: { Calculator: "Calcolatrice" },
    async call(cmd, args = {}) {
      this.calls.push([cmd, args]);
      if (cmd === "probe") return { app: front, title: "", url: "" };
      if (cmd === "activate") front = args.name;
      return replies[cmd] ?? {};
    },
    async overlay() {},
    async open(args) {
      this.opened.push(args);
    },
    async snapshot() {
      return CHROME;
    },
  };
}
const sent = (d) => d.calls.filter(([cmd]) => cmd !== "probe").map(([cmd, args]) => [cmd, args]);

test("websocket: the control page itself may connect", () => {
  assert.equal(isTrustedOrigin("http://localhost:8787", "localhost:8787", "127.0.0.1"), true);
  assert.equal(isTrustedOrigin("http://127.0.0.1:8787", "127.0.0.1:8787", "127.0.0.1"), true);
});

test("websocket: a page from another site may not drive the Mac", () => {
  assert.equal(isTrustedOrigin("https://evil.example", "localhost:8787", "127.0.0.1"), false);
  assert.equal(isTrustedOrigin("null", "localhost:8787", "127.0.0.1"), false);
});

test("websocket: a foreign name rebound to loopback is refused", () => {
  assert.equal(isTrustedOrigin("http://evil.example:8787", "evil.example:8787", "127.0.0.1"), false);
});

test("websocket: LAN mode accepts the page served from the LAN address", () => {
  assert.equal(isTrustedOrigin("http://192.168.1.20:8787", "192.168.1.20:8787", "0.0.0.0"), true);
});

test("websocket: non-browser clients without an Origin header are allowed", () => {
  assert.equal(isTrustedOrigin(undefined, "localhost:8787", "127.0.0.1"), true);
});

// ------------------------------------------------------------------------------------------------ missing commands

test("'vai sul desktop' is a command: Show Desktop is F11", () => {
  assert.deepEqual(CONTROL_OPTIONS.show_desktop.keys, ["f11"]);
  const r = control("show_desktop");
  assert.equal(r.decision, "act");
  assert.deepEqual(r.action.keys, ["f11"]);
});

test("'cancella i calcoli' clears Calculator through the guarded calculate path", () => {
  const r = control("clear_calculator");
  assert.equal(r.decision, "act");
  assert.equal(r.action.type, "calculate");
  assert.deepEqual(r.action.keys, []);
});

test("'cancella il messaggio' clears the focused field without asking (it can be undone)", () => {
  const r = control("clear_field");
  assert.equal(r.decision, "act");
  assert.equal(r.action.type, "clear_field");
  assert.equal(reverseAction(r.action).id, "undo");
});

test("clear_field only wipes a text field, never a whole window", async () => {
  const field = fakeDesktop({ replies: { focus: { role: "AXTextArea" } } });
  assert.equal((await executeDesktop({ type: "clear_field", label: "x" }, field)).ok, true);
  assert.deepEqual(sent(field).at(-1), ["keys", { keys: ["cmd+a", "delete"] }]);

  const list = fakeDesktop({ replies: { focus: { role: "AXTable" } } });
  const res = await executeDesktop({ type: "clear_field", label: "x" }, list);
  assert.equal(res.ok, false);
  assert.ok(!sent(list).some(([cmd]) => cmd === "keys"), "no keys sent outside a text field");
});

test("'apri tab' and 'nuovo tab' are new-tab examples", () => {
  for (const s of ["apri tab", "nuovo tab", "open tab"]) assert.ok(INTENT_CRITERIA.open_new_tab.examples.includes(s), s);
});

// ------------------------------------------------------------------------------------------------ "apri il browser"

test("the default browser is offered to Jev as 'the browser'", () => {
  const snap = buildDesktopSnapshot({ app: "Finder", title: "", elements: [] }, APPS, { defaultBrowser: "Google Chrome" });
  const { questions } = buildRequest({ transcript: "apri il browser", snapshot: snap });
  const criteria = JSON.stringify(questions.app);
  assert.match(criteria, /default web browser/);
});

// ------------------------------------------------------------------------------------------------ named window operations

test("'chiudi la calcolatrice' carries the named app; 'chiudi finestra' does not", () => {
  const named = control("close_window", { app: ch("Calculator", 0.95) });
  assert.equal(named.action.app, "Calculator");
  const weak = control("close_window", { app: ch("Finder", 0.6) });
  assert.equal(weak.action.app, undefined, "a weak app guess must not redirect the close");
});

test("a window op on a named app brings that app forward first", async () => {
  const d = fakeDesktop({ replies: { activate: { activated: true } } });
  const res = await executeDesktop({ type: "window_op", op: "close", app: "Calculator", label: "x" }, d);
  assert.equal(res.ok, true);
  const cmds = sent(d).map(([cmd]) => cmd);
  assert.ok(cmds.indexOf("activate") < cmds.indexOf("window"), cmds.join(","));
});

test("a window op on a named app that is not running closes nothing", async () => {
  const d = fakeDesktop({ replies: { activate: { activated: false } } });
  const res = await executeDesktop({ type: "window_op", op: "close", app: "Calculator", label: "x" }, d);
  assert.equal(res.ok, false);
  assert.ok(!sent(d).some(([cmd]) => cmd === "window"));
});

// ------------------------------------------------------------------------------------------------ "scrivi a <name>"

test("'scrivi a Sofia' names a recipient, it is not text to type", () => {
  assert.deepEqual(extractTextCandidates("scrivi a Sofia"), []);
  assert.deepEqual(extractTextCandidates("write to John Smith"), []);
  assert.ok(extractTextCandidates("scrivi ciao a tutti").includes("ciao a tutti"));
});

// ------------------------------------------------------------------------------------------------ recognizer hints, labels

test("the recognizer expects 'desktop' and 'scrivania'", () => {
  for (const w of ["desktop", "scrivania", "scheda"]) assert.ok(RECOGNITION_HINTS.includes(w), w);
});

test("undoing typed text reads 'svuota il campo', not 'scrivi \"\" in clear null'", () => {
  const typed = { type: "type_into_field", targetId: null, targetLabel: null, text: "Sofia", submit: false };
  const undo = reverseAction(typed);
  assert.equal(describe(undo, "it"), "svuota il campo");
  assert.equal(describe(undo, "en"), "clear the field");
});

// ------------------------------------------------------------------------------------------------ snapshot errors

test("a failing snapshot is reported once, not swallowed", async () => {
  const d = new DesktopManager();
  d.call = async () => {
    throw new Error("helper timeout on snapshot");
  };
  const errors = [];
  d.on("snapshot_error", (m) => errors.push(m));
  await d.snapshot({ fresh: true });
  await d.snapshot({ fresh: true });
  assert.deepEqual(errors, ["helper timeout on snapshot"]);
});
