import { test } from "node:test";
import assert from "node:assert/strict";
import {
  endsOnContinuationWord,
  extractTextCandidates,
  extractUrlCandidates,
  normalizeSpokenUrl,
  parseCandidatePick,
  parseConfirmation,
  parseRepeatCount,
  siteHomeUrl,
  siteSearchTemplate,
  toHttpUrl,
  wantsNewTab,
  wantsSubmit,
} from "../../src/spans.js";

test("text candidates: 'type X into the search box' offers the bare payload first", () => {
  const c = extractTextCandidates("type hello world into the search box");
  assert.equal(c[0], "hello world");
  assert.ok(c.includes("hello world into the search box"));
  assert.ok(c.includes("type hello world into the search box"), "whole transcript is always a fallback");
});

test("text candidates: 'search for X' and 'look up X'", () => {
  assert.equal(extractTextCandidates("search for jev typesafe")[0], "jev typesafe");
  assert.equal(extractTextCandidates("look up alan turing please")[0], "alan turing");
  assert.equal(extractTextCandidates("search wikipedia for cats")[0], "cats");
  assert.equal(extractTextCandidates("google cheap flights to lisbon")[0], "cheap flights to lisbon");
});

test("text candidates: quoted spans win", () => {
  assert.equal(extractTextCandidates('type "good morning" in the comment box')[0], "good morning");
});

test("text candidates: empty / no verbs", () => {
  assert.deepEqual(extractTextCandidates(""), []);
  const c = extractTextCandidates("scroll down");
  assert.ok(c.includes("scroll down"));
  assert.ok(c.length <= 8);
});

test("text candidates are unique and capped", () => {
  const c = extractTextCandidates("search for search for search for a b c d e f g h i j");
  assert.equal(new Set(c.map((s) => s.toLowerCase())).size, c.length);
  assert.ok(c.length <= 8);
});

test("spoken URLs: 'example dot com' -> example.com", () => {
  assert.equal(normalizeSpokenUrl("go to example dot com"), "go to example.com");
  assert.deepEqual(extractUrlCandidates("go to example dot com"), ["example.com"]);
  assert.deepEqual(extractUrlCandidates("open news dot ycombinator dot com please"), ["news.ycombinator.com"]);
  assert.deepEqual(extractUrlCandidates("visit https://docs.typesafe.ai/models"), ["https://docs.typesafe.ai/models"]);
  assert.deepEqual(extractUrlCandidates("scroll down a bit"), []);
});

test("toHttpUrl adds https", () => {
  assert.equal(toHttpUrl("example.com"), "https://example.com");
  assert.equal(toHttpUrl("http://a.b"), "http://a.b");
});

test("candidate pick parsing", () => {
  assert.equal(parseCandidatePick("two"), 2);
  assert.equal(parseCandidatePick("the second one"), 2);
  assert.equal(parseCandidatePick("number 3"), 3);
  assert.equal(parseCandidatePick("click the first one"), 1);
  assert.equal(parseCandidatePick("one"), 1);
  assert.equal(parseCandidatePick("four", 3), null, "out of range");
  assert.equal(parseCandidatePick("go to wikipedia"), null);
  assert.equal(parseCandidatePick(""), null);
});

test("text candidates (it): destinations and lead-ins are stripped, diagnosed transcripts", () => {
  assert.equal(extractTextCandidates("Cerca su Internet YouTube")[0], "YouTube");
  const c = extractTextCandidates("cerca un video di macchine");
  assert.equal(c[0], "macchine");
  assert.ok(c.includes("video di macchine"));
  assert.equal(extractTextCandidates("cerca su youtube video di macchine")[0], "video di macchine");
  assert.equal(extractTextCandidates("cerca un video di macchine su youtube")[0], "macchine");
  assert.equal(extractTextCandidates("cerca su google macchine")[0], "macchine");
  assert.equal(extractTextCandidates("scrivi ciao nella barra di ricerca")[0], "ciao");
  assert.equal(extractTextCandidates("cerca ristoranti a milano per favore")[0], "ristoranti a milano");
  assert.equal(extractTextCandidates("cerca gatti")[0], "gatti");
  assert.equal(extractTextCandidates("trovami una ricetta")[0], "una ricetta");
  assert.equal(extractTextCandidates("informazioni su alan turing")[0], "alan turing");
});

test("text candidates: the submit suffix is never part of a candidate", () => {
  const it = extractTextCandidates("scrivi ciao a tutti e invia");
  assert.equal(it[0], "ciao a tutti");
  assert.ok(it.every((x) => !/invia/.test(x)));
  assert.equal(wantsSubmit("scrivi ciao a tutti e invia"), true);
  const en = extractTextCandidates("type hello world and send it");
  assert.equal(en[0], "hello world");
  assert.ok(en.every((x) => !/send/.test(x)));
  assert.equal(wantsSubmit("type hello world and send it"), true);
  assert.equal(wantsSubmit("type hello and press enter"), true);
  assert.equal(wantsSubmit("scrivi ciao e premi invio"), true);
  assert.equal(wantsSubmit("scrivi ciao a tutti"), false);
  assert.equal(wantsSubmit("cerca rock and roll"), false);
});

test("wantsNewTab / parseRepeatCount", () => {
  assert.equal(wantsNewTab("apri youtube in una nuova scheda"), true);
  assert.equal(wantsNewTab("open github in a new tab"), true);
  assert.equal(wantsNewTab("new tab"), true);
  assert.equal(wantsNewTab("apri youtube"), false);
  assert.equal(parseRepeatCount("premi tab tre volte"), 3);
  assert.equal(parseRepeatCount("press tab 4 times"), 4);
  assert.equal(parseRepeatCount("press down twice"), 2);
  assert.equal(parseRepeatCount("premi invio una volta"), 1);
  assert.equal(parseRepeatCount("premi invio"), 1);
  assert.equal(parseRepeatCount("premi tab 500 volte"), 20, "clamped to MAX_REPEAT");
});

test("endsOnContinuationWord: helper rule, IT + EN", () => {
  for (const t of ["cerca un video di", "fai 7 più", "cerca nell'", "search for the", "go to", "vai su", "scrivi ciao e", "scrivi l’"]) {
    assert.equal(endsOnContinuationWord(t), true, t);
  }
  for (const t of ["cerca macchine", "vai su wikipedia", "scorri giù", "", "   "]) assert.equal(endsOnContinuationWord(t), false, t);
  assert.equal(endsOnContinuationWord("cerca un video di."), true, "trailing punctuation ignored");
});

test("parseConfirmation: whole utterance only, IT + EN", () => {
  for (const t of ["conferma", "sì", "si fallo", "vai", "per favore conferma", "yes do it", "go ahead", "ok", "va bene", "certo", "Confirm."]) {
    assert.equal(parseConfirmation(t), "confirm", t);
  }
  for (const t of ["annulla", "no", "lascia stare", "lascia perdere", "ferma", "basta", "non farlo", "cancel", "never mind", "don't", "stop"]) {
    assert.equal(parseCandidatePick(t) === null && parseConfirmation(t), "cancel", t);
  }
  for (const t of ["vai su wikipedia", "sì annulla", "scorri giù", "", "go to youtube"]) assert.equal(parseConfirmation(t), null, t);
});

test("spoken URLs (it): punto / barra / chiocciola only inside domain-looking spans", () => {
  assert.deepEqual(extractUrlCandidates("portami su github punto com"), ["github.com"]);
  assert.deepEqual(extractUrlCandidates("vai su news punto ycombinator punto com"), ["news.ycombinator.com"]);
  assert.deepEqual(extractUrlCandidates("apri github punto com barra docs"), ["github.com/docs"]);
  assert.deepEqual(extractUrlCandidates("scrivi a mario chiocciola gmail punto com"), ["mario@gmail.com"]);
  assert.deepEqual(extractUrlCandidates("a questo punto di vista"), []);
  assert.equal(normalizeSpokenUrl("a questo punto"), "a questo punto");
});

test("candidate pick (it)", () => {
  assert.equal(parseCandidatePick("il secondo"), 2);
  assert.equal(parseCandidatePick("uno"), 1);
  assert.equal(parseCandidatePick("prima"), 1);
  assert.equal(parseCandidatePick("numero tre"), 3);
  assert.equal(parseCandidatePick("scegli il quarto"), 4);
  assert.equal(parseCandidatePick("la quinta per favore"), 5);
  assert.equal(parseCandidatePick("vai su wikipedia"), null);
  assert.equal(parseCandidatePick("sei"), null, "only 1..5 are picks");
});

test("siteHomeUrl / siteSearchTemplate: language overrides and the_web", () => {
  assert.equal(siteHomeUrl("wikipedia", "it"), "https://it.wikipedia.org/wiki/Pagina_principale");
  assert.equal(siteHomeUrl("wikipedia"), "https://en.wikipedia.org/wiki/Main_Page");
  assert.equal(siteHomeUrl("youtube", "it"), "https://www.youtube.com/");
  assert.equal(siteHomeUrl("gmail"), "https://mail.google.com/");
  assert.equal(siteHomeUrl("nope"), null);
  assert.equal(siteSearchTemplate("amazon", "it"), "https://www.amazon.it/s?k=%s");
  assert.equal(siteSearchTemplate("the_web"), "https://duckduckgo.com/?q=%s");
  assert.equal(siteSearchTemplate("gmail"), null, "gmail has no search template");
  assert.equal(siteSearchTemplate("google_maps"), "https://www.google.com/maps/search/%s");
});
