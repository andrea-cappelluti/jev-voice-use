import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_CONTROL_IDS,
  CONTINUATION_WORDS,
  CONTROL_CRITERIA,
  CONTROL_OPTIONS,
  DESKTOP_INTENT_CRITERIA,
  DESKTOP_QUESTIONS,
  INTENT_CRITERIA,
  PAYLOAD_INTENTS,
  QUESTIONS,
  RECOGNITION_HINTS,
  SITE_CRITERIA,
  SITE_HOME,
  SITE_SEARCH,
  T,
  UI_TEXT,
  VERB_ONLY_WORDS,
} from "../../src/constants.js";

// helper key names (contract section 1)
const LEGAL_KEYS = new Set([
  "return", "escape", "tab", "space", "delete", "forwarddelete", "left", "right", "up", "down", "home", "end", "pageup", "pagedown",
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
  "=", "-", ",", ".", "/", ";", "'", "\\", "`", "[", "]",
  ...Array.from({ length: 10 }, (_, i) => `kp${i}`),
  "kpdecimal", "kpmultiply", "kpplus", "kpminus", "kpdivide", "kpenter", "kpclear", "kpequals", "f11",
]);
const LEGAL_MODS = new Set(["cmd", "shift", "alt", "ctrl"]);
const chordOk = (c) => {
  const parts = c.split("+");
  const key = parts.pop() || "+";
  return LEGAL_KEYS.has(key) && parts.every((m) => LEGAL_MODS.has(m));
};

test("every CONTROL_OPTIONS entry uses legal helper key names and has en/it labels", () => {
  for (const [id, o] of Object.entries(CONTROL_OPTIONS)) {
    assert.ok(o.label?.en && o.label?.it, `${id} label`);
    if (o.kind === "key") {
      assert.ok(LEGAL_KEYS.has(o.key), `${id}: ${o.key}`);
      for (const m of o.mods ?? []) assert.ok(LEGAL_MODS.has(m), `${id} mod ${m}`);
    } else if (o.kind === "shortcut") {
      assert.ok(typeof o.char === "string" && o.char.length === 1, id);
    } else if (o.kind === "keys") {
      assert.ok(o.keys.length > 0 && o.keys.every(chordOk), id);
    } else if (o.kind === "window") assert.ok(["close", "minimize", "fullscreen", "zoom"].includes(o.op), id);
    else if (o.kind === "volume") assert.ok(["up", "down", "mute", "unmute"].includes(o.op), id);
    else if (o.kind === "language") assert.match(o.locale, /^[a-z]{2}-[A-Z]{2}$/, id);
    else if (o.kind === "app_back") assert.equal(id, "previous_app");
    else if (o.kind === "calculator") assert.equal(id, "clear_calculator");
    else if (o.kind === "field") assert.equal(id, "clear_field");
    else assert.equal(o.kind, "quit", id);
  }
  assert.equal(CONTROL_OPTIONS.quit_app.confirm, true);
  assert.equal(CONTROL_OPTIONS.clear_all.confirm, true, "wiping everything asks first");
  assert.deepEqual(CONTROL_OPTIONS.clear_all.keys, ["cmd+a", "delete"]);
  assert.deepEqual(CONTROL_OPTIONS.key_shift_tab.mods, ["shift"]);
  assert.equal(CONTROL_OPTIONS.redo.shift, true);
});

test("CONTROL_CRITERIA keys are the options plus none; browser subset", () => {
  assert.deepEqual(new Set(Object.keys(CONTROL_CRITERIA)), new Set([...Object.keys(CONTROL_OPTIONS), "none"]));
  for (const id of BROWSER_CONTROL_IDS) assert.ok(id in CONTROL_OPTIONS, id);
  for (const id of ["copy", "cut", "paste", "select_all", "undo", "redo", "language_it", "language_en", "key_enter", "key_page_down"]) {
    assert.ok(BROWSER_CONTROL_IDS.includes(id), id);
  }
  for (const id of ["quit_app", "close_window", "volume_up", "save", "screenshot"]) assert.ok(!BROWSER_CONTROL_IDS.includes(id), id);
  assert.deepEqual(new Set(Object.keys(QUESTIONS.control.criteria)), new Set([...BROWSER_CONTROL_IDS, "none"]));
  assert.deepEqual(DESKTOP_QUESTIONS.control.criteria, CONTROL_CRITERIA);
  assert.ok(QUESTIONS.control.instructions.question && QUESTIONS.control.instructions.focus);
});

test("continuation / verb-only word lists and numbers", () => {
  for (const w of ["di", "of", "il", "the", "+", "per", "con"]) assert.ok(CONTINUATION_WORDS.has(w), w);
  assert.ok(!CONTINUATION_WORDS.has("macchine"));
  // "copy that", "no non quello": a demonstrative ends a command, it does not wait for a complement
  for (const w of ["that", "this", "questo", "quello", "quella"]) assert.ok(!CONTINUATION_WORDS.has(w), w);
  for (const w of ["cerca", "apri", "search", "open", "google"]) assert.ok(VERB_ONLY_WORDS.has(w), w);
  assert.equal(T.controlConfidence, 0.5);
  assert.ok(PAYLOAD_INTENTS.has("calculate"));
  assert.ok(RECOGNITION_HINTS.length <= 40 && RECOGNITION_HINTS.includes("Calcolatrice"));
});

test("UI_TEXT: it and en have identical key sets; EN keeps today's strings", () => {
  assert.deepEqual(Object.keys(UI_TEXT.it).sort(), Object.keys(UI_TEXT.en).sort());
  assert.deepEqual(Object.keys(UI_TEXT.it.actions).sort(), Object.keys(UI_TEXT.en.actions).sort());
  for (const t of ["navigate_url", "open_app", "type_into_field", "click_element", "select_option", "press_enter", "press_key", "shortcut", "window_op", "volume", "quit_app", "send_keys", "calculate", "set_language", "scroll_down", "scroll_up", "go_back", "go_forward", "reload", "open_new_tab", "close_tab", "switch_tab", "switch_app_back"]) {
    assert.ok(UI_TEXT.en.actions[t] && UI_TEXT.it.actions[t], t);
  }
  assert.equal(UI_TEXT.en.actions.open_app, "open {app}");
  assert.equal(UI_TEXT.en.actions.navigate_url, "open {label}");
  assert.equal(UI_TEXT.en.actions.click_element, "click {label}");
  assert.equal(UI_TEXT.en.actions.type_into_field, 'type "{text}" into {label}');
  assert.equal(UI_TEXT.en.actions.select_option, 'select "{text}" in {label}');
  assert.equal(UI_TEXT.it.unclear, "Non ho capito");
  assert.ok(UI_TEXT.en.confirm.includes("{action}") && UI_TEXT.it.confirm.includes("{action}"));
});

const hasItalian = (examples) => examples.some((e) => /[àèéìòù]|\b(?:il|la|lo|di|su|un|una|per|vai|apri|cerca|scrivi|premi|clicca|scorri|indietro|avanti|ricarica|aggiorna|chiudi|nuova|nuovo|scheda|conferma|annulla|ferma|copia|incolla|fai|calcola|quanto|invia|scegli|seleziona|portami|trovami|alza|muto|ehm|allora|boh|tab|continua|salta|prossima|sì|salva|dai)\b/i.test(e));

test("every intent has what, not_for and >=2 examples with Italian among them", () => {
  for (const [name, c] of Object.entries({ ...INTENT_CRITERIA, ...DESKTOP_INTENT_CRITERIA })) {
    assert.ok(c.what && c.not_for, `${name} what/not_for`);
    assert.ok(c.examples.length >= 2, `${name} examples`);
    assert.ok(hasItalian(c.examples), `${name} needs an Italian example: ${c.examples}`);
  }
  for (const id of ["press_key", "system_command", "calculate", "press_enter"]) assert.ok(id in INTENT_CRITERIA, id);
  assert.ok("open_app" in DESKTOP_INTENT_CRITERIA && !("open_app" in INTENT_CRITERIA));
});

test("the specifics of the bilingual criteria", () => {
  const ex = (o) => o.examples.join("|");
  assert.match(ex(INTENT_CRITERIA.click_element), /scegli google/);
  assert.match(INTENT_CRITERIA.click_element.not_for, /search engine/);
  assert.doesNotMatch(ex(INTENT_CRITERIA.go_back), /^undo$|\|undo\||annulla/);
  assert.match(ex(INTENT_CRITERIA.cancel), /annulla/);
  assert.match(INTENT_CRITERIA.cancel.what, /pending_confirmation/);
  assert.match(ex(QUESTIONS.complete.criteria.false), /cerca un video di/);
  assert.match(ex(QUESTIONS.complete.criteria.false), /go to/);
  assert.match(ex(QUESTIONS.is_correction.criteria.true), /no non quello/);
  assert.match(ex(QUESTIONS.destructive.criteria.true), /acquista ora/);
  assert.match(DESKTOP_QUESTIONS.app.instructions.focus, /calcolatrice/);
  assert.ok(Object.keys(QUESTIONS.intent.criteria).every((k) => k in INTENT_CRITERIA));
  for (const q of ["intent", "target", "site", "complete", "is_command", "destructive", "is_correction", "text_span", "control"]) {
    assert.match(QUESTIONS[q].instructions.focus, /Italian/, q);
  }
});

test("sites: every searchable / home site has a criteria entry", () => {
  for (const id of new Set([...Object.keys(SITE_HOME), ...Object.keys(SITE_SEARCH)])) assert.ok(id in SITE_CRITERIA, id);
  for (const id of ["google_maps", "gmail", "linkedin", "netflix", "spotify", "stackoverflow", "facebook", "instagram"]) assert.ok(SITE_HOME[id], id);
  assert.equal(SITE_SEARCH.gmail, undefined);
  assert.equal(SITE_SEARCH.facebook, undefined);
  for (const t of Object.values(SITE_SEARCH)) assert.ok(t.includes("%s"));
});
