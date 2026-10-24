/**
 * Integration test against the REAL Jev API: given a page snapshot fixture and a transcript,
 * does the (Jev answers -> policy) pipeline produce the expected intent / target / decision?
 *
 * Prints a pass-rate report and per-call latency. Requires TYPESAFE_API_KEY (or JEV_API_KEY);
 * skips otherwise. Cost of a full run: well under one cent.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide, hasApiKey } from "../../src/jev.js";
import { Controller } from "../../src/controller.js";
import { evaluatePolicy } from "../../src/policy.js";
import { buildDesktopSnapshot } from "../../src/desktop.js";
import { MODEL, UI_TEXT } from "../../src/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", `${name}.json`), "utf8"));

// A realistic search-results page (DuckDuckGo chrome captured live; result links written by hand
// because results render client-side and don't appear in headless captures).
const SEARCH_RESULTS = {
  url: "https://duckduckgo.com/?q=jev+typesafe",
  title: "jev typesafe at DuckDuckGo",
  site: "duckduckgo",
  searchBoxId: "e02",
  elements: [
    { id: "e01", role: "link", text: "DuckDuckGo home", href: "duckduckgo.com" },
    { id: "e02", role: "combobox", text: "jev typesafe", placeholder: "Search privately" },
    { id: "e03", role: "button", text: "Search" },
    { id: "e05", role: "link", text: "All", href: "duckduckgo.com" },
    { id: "e06", role: "link", text: "Images", href: "duckduckgo.com" },
    { id: "e07", role: "link", text: "Videos", href: "duckduckgo.com" },
    { id: "e08", role: "link", text: "News", href: "duckduckgo.com" },
    { id: "e12", role: "button", text: "Search Settings" },
    { id: "e20", role: "link", text: "TypeSafe — Jev, the System One model", href: "typesafe.ai" },
    { id: "e21", role: "link", text: "typesafe.ai", href: "typesafe.ai" },
    { id: "e22", role: "link", text: "Jev 1.13 | TypeSafe Documentation", href: "docs.typesafe.ai/models/jev" },
    { id: "e23", role: "link", text: "docs.typesafe.ai", href: "docs.typesafe.ai" },
    { id: "e24", role: "link", text: "GitHub - typesafe-ai/typesafe-sdk-js: TypeScript SDK", href: "github.com/typesafe-ai/typesafe-sdk-js" },
    { id: "e25", role: "link", text: "github.com", href: "github.com" },
    { id: "e26", role: "link", text: "TypeSafe (@typesafe_ai) / X", href: "x.com/typesafe_ai" },
    { id: "e27", role: "button", text: "More results" },
    { id: "e28", role: "link", text: "Settings", href: "duckduckgo.com/settings", below_fold: true },
    { id: "e29", role: "link", text: "Privacy Policy", href: "duckduckgo.com/privacy", below_fold: true },
  ],
};

const FORM_PAGE = {
  url: "https://shop.example.com/checkout",
  title: "Checkout — Example Shop",
  site: "generic",
  searchBoxId: null,
  elements: [
    { id: "e01", role: "link", text: "Example Shop" },
    { id: "e02", role: "textbox", text: "", placeholder: "Email address" },
    { id: "e03", role: "textbox", text: "", placeholder: "Card number" },
    { id: "e04", role: "select", text: "Country" },
    { id: "e05", role: "button", text: "Place order" },
    { id: "e06", role: "link", text: "Back to cart" },
    { id: "e07", role: "button", text: "Delete account" },
  ],
};

/**
 * Each case: transcript + snapshot + expectations on Jev's raw answers and/or the policy result.
 *   intent:   expected `intent.choice`
 *   target:   expected `target.choice` (optional)
 *   decision: expected policy decision (optional)
 *   text:     expected verbatim text_span (optional)
 *   final:    treat as a final utterance (default true so `complete` doesn't gate)
 */
const CASES = [
  { name: "scroll a bit", transcript: "scroll down a bit", snapshot: "wikipedia-article", intent: "scroll_down", decision: "act", amount: "little" },
  { name: "scroll to bottom", transcript: "scroll all the way to the bottom", snapshot: "wikipedia-article", intent: "scroll_down", decision: "act", amount: "end" },
  { name: "scroll up", transcript: "scroll up", snapshot: "hn", intent: "scroll_up", decision: "act" },
  { name: "go to wikipedia", transcript: "go to wikipedia", snapshot: "example", intent: "navigate_url", decision: "act", url: "wikipedia.org" },
  { name: "open youtube", transcript: "open youtube", snapshot: "hn", intent: "navigate_url", decision: "act", url: "youtube.com" },
  { name: "spoken domain", transcript: "go to example dot com", snapshot: "hn", intent: "navigate_url", decision: "act", url: "example.com" },
  { name: "search web", transcript: "search for jev typesafe", snapshot: "example", intent: "search_web", decision: "act", text: "jev typesafe", url: "duckduckgo.com" },
  { name: "search on site with box", transcript: "search for alan turing", snapshot: "wikipedia-main", intent: "search_web", decision: "act", text: "alan turing", target: "e02" },
  { name: "search named site", transcript: "search youtube for lofi beats", snapshot: "hn", intent: "search_web", decision: "act", text: "lofi beats", url: "youtube.com/results" },
  { name: "look up", transcript: "look up the weather in berlin", snapshot: "example", intent: "search_web", decision: "act", textIn: ["the weather in berlin", "weather in berlin"] },
  { name: "click first result", transcript: "click the first result", snapshot: SEARCH_RESULTS, intent: "click_element", target: "e20", decision: "act" },
  { name: "click github result", transcript: "click the github link", snapshot: SEARCH_RESULTS, intent: "click_element", target: "e24", decision: "act" },
  { name: "click by text", transcript: "click the more information link", snapshot: "example", intent: "click_element", target: "e01", decision: "act" },
  { name: "click hn new", transcript: "click new", snapshot: "hn", intent: "click_element", target: "e03", decision: "act" },
  { name: "click hn comments", transcript: "open the comments tab", snapshot: "hn", intent: "click_element", target: "e05", decision: "act" },
  { name: "go back", transcript: "go back", snapshot: "wikipedia-article", intent: "go_back", decision: "act" },
  { name: "type into box", transcript: "type hello world into the search box", snapshot: "wikipedia-main", intent: "type_into_field", target: "e02", text: "hello world", decision: "act" },
  { name: "reload", transcript: "refresh the page", snapshot: "hn", intent: "reload", decision: "act" },
  { name: "new tab", transcript: "open a new tab", snapshot: "hn", intent: "open_new_tab", decision: "act" },
  { name: "chit-chat ignored", transcript: "so anyway I think we should get lunch", snapshot: "hn", decision: "ignore" },
  { name: "filler ignored", transcript: "um okay so", snapshot: "hn", decisionIn: ["ignore", "wait"] },
  { name: "partial go to waits", transcript: "go to", snapshot: "hn", final: false, decision: "wait" },
  { name: "partial search waits", transcript: "search for", snapshot: "hn", final: false, decision: "wait" },
  { name: "destructive asks confirm", transcript: "click place order", snapshot: FORM_PAGE, intent: "click_element", target: "e05", decision: "confirm" },
  { name: "destructive delete", transcript: "press delete account", snapshot: FORM_PAGE, intent: "click_element", target: "e07", decision: "confirm" },
  { name: "type email", transcript: "type bob at example dot com in the email field", snapshot: FORM_PAGE, intent: "type_into_field", target: "e02", decision: "act" },
  { name: "missing element waits", transcript: "click sign in", snapshot: "example", intent: "click_element", decisionIn: ["wait", "disambiguate"] },
];

// --- Context-aware cases: the user just searched DuckDuckGo and clicked the first result. ---
const PRODUCT_PAGE = {
  url: "https://typesafe.ai/jev",
  title: "Jev — the System One model | TypeSafe",
  site: "generic",
  searchBoxId: null,
  elements: [
    { id: "e01", role: "link", text: "TypeSafe", href: "typesafe.ai" },
    { id: "e02", role: "link", text: "Product" },
    { id: "e03", role: "link", text: "Documentation", href: "docs.typesafe.ai" },
    { id: "e04", role: "link", text: "Pricing" },
    { id: "e05", role: "link", text: "Blog" },
    { id: "e06", role: "button", text: "Get an API key" },
    { id: "e07", role: "link", text: "Read the docs", href: "docs.typesafe.ai/introduction" },
    { id: "e08", role: "link", text: "Join Discord", href: "discord.com" },
  ],
};
const AFTER_CLICK_CONTEXT = {
  previousPage: { url: "https://duckduckgo.com/?q=jev+typesafe", title: "jev typesafe at DuckDuckGo", site: "duckduckgo" },
  recentActions: [
    { type: "navigate_url", url: "https://duckduckgo.com/?q=jev+typesafe", said: "search for jev typesafe", ok: true, outcome: "navigated to duckduckgo.com/?q=jev+typesafe", at: Date.now() - 25_000 },
    { type: "click_element", targetId: "e20", targetLabel: 'link "TypeSafe — Jev, the System One model"', said: "click the first result", ok: true, outcome: "navigated to typesafe.ai/jev", at: Date.now() - 6_000 },
  ],
};
const ON_RESULTS_AFTER_CLICK = {
  previousPage: { url: "https://duckduckgo.com/?q=jev+typesafe", title: "jev typesafe at DuckDuckGo", site: "duckduckgo" },
  recentActions: [
    { type: "click_element", targetId: "e20", targetLabel: 'link "TypeSafe — Jev, the System One model"', said: "click the first result", ok: true, outcome: "navigated to typesafe.ai/jev", at: Date.now() - 8_000 },
    { type: "go_back", said: "go back", ok: true, outcome: "navigated to duckduckgo.com/?q=jev+typesafe", at: Date.now() - 3_000 },
  ],
};

CASES.push(
  // "Documentation" and "Read the docs" are both the docs: Jev splits ~50/50 and asking "which one?" is legitimate.
  { name: "ctx: open the documentation", transcript: "open the documentation", snapshot: PRODUCT_PAGE, context: AFTER_CLICK_CONTEXT, intent: "click_element", targetIn: ["e03", "e07"], decisionIn: ["act", "disambiguate"] },
  { name: "ctx: back to the results", transcript: "go back to the search results", snapshot: PRODUCT_PAGE, context: AFTER_CLICK_CONTEXT, intent: "go_back", decision: "act" },
  { name: "ctx: correction reverses", transcript: "no not that one", snapshot: PRODUCT_PAGE, context: AFTER_CLICK_CONTEXT, correction: true, actionType: "go_back", decision: "act" },
  { name: "ctx: wrong link undo", transcript: "wrong link, undo that", snapshot: PRODUCT_PAGE, context: AFTER_CLICK_CONTEXT, correction: true, actionType: "go_back", decision: "act" },
  { name: "ctx: the other one", transcript: "no, the other one", snapshot: SEARCH_RESULTS, context: ON_RESULTS_AFTER_CLICK, correction: true, intent: "click_element", targetNot: "e20", decisionIn: ["act", "disambiguate"] },
  { name: "ctx: follow-up not a correction", transcript: "scroll down a bit", snapshot: PRODUCT_PAGE, context: AFTER_CLICK_CONTEXT, correction: false, intent: "scroll_down", decision: "act" },
  // The fixture lists each result's URL line as its own link right after the title (e20 title, e21 url,
  // e22 second title), so "second result" is genuinely ambiguous at the element level; both are accepted.
  { name: "ctx: second result after back", transcript: "click the second result", snapshot: SEARCH_RESULTS, context: ON_RESULTS_AFTER_CLICK, intent: "click_element", targetIn: ["e21", "e22"], decision: "act" },
);

// --- Bilingual (IT + EN), desktop mode, computer use. Snapshots are built like the real desktop mode does:
// raw helper elements (with the `web` flag: true only inside the page's AXWebArea) -> buildDesktopSnapshot. ---
const APPS = ["Calculator", "Safari", "Google Chrome", "System Settings", "Finder", "Notes", "Terminal"];
const ALIASES = { Calculator: "Calcolatrice", "System Settings": "Impostazioni di Sistema", Notes: "Note" };
const desktop = (raw) => buildDesktopSnapshot(raw, APPS, { appAliases: ALIASES });
/** Raw helper element: position only matters for visual order and the search-box tie-break. */
const el = (id, role, text, o = {}) => ({ id, role, type: "", text, placeholder: "", left: 100, top: 200, w: 120, h: 24, web: true, ...o });
const omnibox = (id = "e02") => el(id, "textbox", "Barra degli indirizzi e di ricerca", { left: 200, top: 80, w: 600, h: 28, web: false });
const CHROME = { app: "Google Chrome", bundle: "com.google.Chrome" };

// Chrome in Italian on YouTube: the address bar is ABOVE the page search field. searchBoxId is computed, never hand-set.
const CHROME_YT_RAW = {
  ...CHROME, title: "YouTube", url: "https://www.youtube.com/",
  elements: [
    el("e01", "button", "Chiudi scheda", { left: 20, top: 40, web: false }),
    omnibox("e02"),
    el("e03", "link", "Home", { top: 200, href: "youtube.com" }),
    el("e05", "combobox", "", { placeholder: "Cerca", left: 300, top: 150, w: 500, h: 30 }),
    el("e06", "button", "Cerca", { left: 810, top: 150, w: 40, h: 30 }),
    el("e07", "link", "Shorts", { top: 240 }),
    el("e08", "link", "Iscrizioni", { top: 280 }),
  ],
};
const CHROME_YT = desktop(CHROME_YT_RAW);
const CHROME_YT_NOBOX = desktop({ ...CHROME_YT_RAW, elements: [CHROME_YT_RAW.elements[0], omnibox("e02"), CHROME_YT_RAW.elements[2]] });
const CHROME_NTP = desktop({
  ...CHROME, title: "Nuova scheda", url: "app://Google Chrome/Nuova scheda",
  elements: [omnibox("e01"), el("e02", "button", "Impostazioni", { top: 300 }), el("e03", "link", "Gmail", { top: 40, left: 900 })],
});
const CHROME_COOKIES = desktop({
  ...CHROME, title: "x - YouTube", url: "https://www.youtube.com/results?search_query=x",
  elements: [omnibox("e01"), el("e09", "button", "Accetta tutto", { top: 500 }), el("e10", "button", "Rifiuta tutto", { left: 260, top: 500 }), el("e11", "link", "Accedi", { top: 100, left: 900 })],
});
const CHROME_CHOOSE_ENGINE = desktop({
  ...CHROME, title: "Scegli il motore di ricerca", url: "https://choice.example.com/",
  elements: [
    omnibox("e01"),
    el("e03", "radio", "Google", { top: 300 }),
    el("e04", "radio", "DuckDuckGo", { top: 340 }),
    el("e05", "radio", "Bing", { top: 380 }),
    el("e06", "button", "Continua", { top: 440 }),
  ],
});
const CALC = desktop({
  app: "Calcolatrice", bundle: "com.apple.calculator", title: "Calcolatrice", url: "app://Calcolatrice/Calcolatrice",
  elements: [el("e01", "button", "7", { web: false }), el("e02", "button", "+", { web: false, left: 160 }), el("e03", "button", "=", { web: false, left: 220 })],
});
const TEXTEDIT = desktop({
  app: "TextEdit", bundle: "com.apple.TextEdit", title: "Senza titolo",
  elements: [el("e01", "menu", "File", { web: false, top: 0 }), el("e02", "textbox", "", { web: false, top: 120 })],
});
// Finder: the search field is a native control (web:false) and it still counts as the search box outside a browser.
const FINDER = desktop({
  app: "Finder", bundle: "com.apple.finder", title: "Documenti",
  elements: [
    el("e01", "menu", "File", { web: false, top: 0 }),
    el("e02", "searchbox", "", { placeholder: "Cerca", web: false, left: 900, top: 60 }),
    el("e03", "row", "Fatture", { web: false, top: 300 }),
  ],
});
const SAFARI_WIKI = desktop({
  app: "Safari", bundle: "com.apple.Safari", title: "Gatto - Wikipedia", url: "https://it.wikipedia.org/wiki/Gatto",
  elements: [
    el("e02", "textbox", "Indirizzo e ricerca", { web: false, top: 70, left: 300, w: 600 }),
    el("e04", "searchbox", "", { placeholder: "Cerca su Wikipedia", top: 130, left: 800 }),
    el("e05", "link", "Storia", { top: 400 }),
  ],
});
// A sign-up form (no search field at all), a news site with its own search field, and a form with a country pop-up.
const SIGNUP = desktop({
  app: "Safari", bundle: "com.apple.Safari", title: "Registrati", url: "https://app.example.com/signup",
  elements: [
    el("e02", "textbox", "Indirizzo e ricerca", { web: false, top: 70, left: 300, w: 600 }),
    el("e03", "textbox", "", { placeholder: "Email", top: 150 }),
    el("e04", "textbox", "", { placeholder: "Password", top: 190 }),
    el("e05", "button", "Crea account", { top: 260 }),
  ],
});
const CORRIERE = desktop({
  app: "Safari", bundle: "com.apple.Safari", title: "Corriere della Sera", url: "https://www.corriere.it/",
  elements: [
    el("e02", "textbox", "Indirizzo e ricerca", { web: false, top: 70, left: 300, w: 600 }),
    el("e04", "textbox", "", { placeholder: "Cerca nel sito", top: 130, left: 800 }),
    el("e05", "link", "Cronaca", { top: 300 }),
  ],
});
const COUNTRY_FORM = desktop({
  app: "Safari", bundle: "com.apple.Safari", title: "Spedizione", url: "https://shop.example.com/shipping",
  elements: [
    el("e02", "textbox", "Indirizzo e ricerca", { web: false, top: 70, left: 300, w: 600 }),
    el("e03", "popup", "Paese", { top: 200 }),
    el("e04", "button", "Continua", { top: 300 }),
  ],
});
const QUIT_PENDING = { type: "quit_app", app: "Safari", label: "esci da Safari" };
/** A scroll the user just did, for "annulla" with no pending confirmation. */
const AFTER_SCROLL = { previousPage: null, recentActions: [{ type: "scroll_down", amount: "page", said: "scorri giù", ok: true, outcome: "scrolled", at: Date.now() - 4_000 }] };

CASES.push(
  // --- S1: current tab / search wins over the page box ---
  { name: "S1a it: cerca macchine -> page box, not omnibox", transcript: "cerca macchine", snapshot: CHROME_YT, lang: "it", intent: "search_web", actionType: "type_into_field", target: "e05", targetNot: "e02", text: "macchine", submit: true, decision: "act" },
  { name: "S1a en: search for cats -> page box", transcript: "search for cats", snapshot: CHROME_YT, actionType: "type_into_field", target: "e05", text: "cats", submit: true, decision: "act" },
  { name: "S1b it: cerca su google macchine -> google, same tab", transcript: "cerca su google macchine", snapshot: CHROME_YT, lang: "it", actionType: "navigate_url", url: "google.com/search?q=macchine", newTab: false, decision: "act" },
  { name: "S1c it: youtube in una nuova scheda (Safari)", transcript: "apri youtube in una nuova scheda", snapshot: SAFARI_WIKI, lang: "it", actionType: "navigate_url", url: "youtube.com", newTab: true, decision: "act" },
  { name: "S1c it: apri una nuova scheda", transcript: "apri una nuova scheda", snapshot: SAFARI_WIKI, lang: "it", actionType: "open_new_tab", decision: "act" },
  { name: "S1c en: open github in a new tab", transcript: "open github in a new tab", snapshot: SAFARI_WIKI, actionType: "navigate_url", url: "github.com", newTab: true, decision: "act" },
  { name: "S1d it: vai su github -> same tab", transcript: "vai su github", snapshot: CHROME_YT, lang: "it", actionType: "navigate_url", url: "github.com", newTab: false, decision: "act" },
  { name: "S1 it: cerca on Safari wikipedia uses the page box", transcript: "cerca gatto siamese", snapshot: SAFARI_WIKI, lang: "it", actionType: "type_into_field", target: "e04", text: "gatto siamese", submit: true, decision: "act" },
  { name: "S1 it: cerca with only an omnibox -> default engine", transcript: "cerca macchine", snapshot: CHROME_YT_NOBOX, lang: "it", actionType: "navigate_url", url: "duckduckgo.com", decision: "act" },
  // --- S3: wrong query text ---
  { name: "S3a it: cerca su internet youtube", transcript: "Cerca su Internet YouTube", snapshot: CHROME_NTP, lang: "it", actionIn: ["navigate_url", "type_into_field"], textInOrUrl: { text: ["YouTube", "youtube"], url: "youtube.com" }, cand0: "YouTube", decision: "act" },
  { name: "S3b it: cerca un video di macchine", transcript: "cerca un video di macchine", snapshot: CHROME_YT, lang: "it", actionType: "type_into_field", target: "e05", textIn: ["macchine", "video di macchine"], decision: "act" },
  { name: "S3c it: dangling", transcript: "cerca un video di", snapshot: CHROME_YT, lang: "it", decision: "wait", dangling: true },
  { name: "S3d en: dangling", transcript: "search for the", snapshot: CHROME_YT, decision: "wait", dangling: true },
  // --- S4: calculator ---
  { name: "S4a it: fai 7 + 6 (calc)", transcript: "Fai 7 + 6", snapshot: CALC, lang: "it", actionType: "calculate", expr: "7+6", calcResult: 13, keys: ["kp7", "kpplus", "kp6", "kpenter"], decision: "act" },
  { name: "S4a it: fai 7 + 6 (rescued)", transcript: "Fai 7 + 6", snapshot: CALC, lang: "it", degrade: true, actionType: "calculate", expr: "7+6", calcResult: 13, keys: ["kp7", "kpplus", "kp6", "kpenter"], decision: "act" },
  { name: "S4b it: calcola 7 per 6", transcript: "calcola 7 per 6", snapshot: CALC, lang: "it", actionType: "calculate", calcResult: 42, decision: "act" },
  { name: "S4b it: quanto fa 12 diviso 4", transcript: "quanto fa 12 diviso 4", snapshot: CALC, lang: "it", actionType: "calculate", calcResult: 3, decision: "act" },
  { name: "S4b it: fai sette più sei", transcript: "fai sette più sei", snapshot: CALC, lang: "it", actionType: "calculate", calcResult: 13, decision: "act" },
  { name: "S4b en: what is 5 times 3", transcript: "what is 5 times 3", snapshot: CALC, actionType: "calculate", calcResult: 15, decision: "act" },
  { name: "S4b en: calculate 9 minus 3", transcript: "calculate 9 minus 3", snapshot: CALC, actionType: "calculate", calcResult: 6, decision: "act" },
  { name: "S4b it: fai 7 più (partial) waits, no loop", transcript: "fai 7 più", snapshot: CALC, lang: "it", final: false, decision: "wait", noRetry: true },
  { name: "S4b it: 8 diviso 0 is invalid", transcript: "8 diviso 0", snapshot: CALC, lang: "it", decision: "wait" },
  { name: "S4c it: fai 7 + 6 from Finder", transcript: "Fai 7 + 6", snapshot: FINDER, lang: "it", actionType: "calculate", calcResult: 13, decision: "act" },
  { name: "S4c it: calcola 7 per 6 from Chrome", transcript: "calcola 7 per 6", snapshot: CHROME_YT, lang: "it", actionType: "calculate", calcResult: 42, decision: "act" },
  { name: "S4c en: what is 5 times 3 from Finder", transcript: "what is 5 times 3", snapshot: FINDER, actionType: "calculate", calcResult: 15, decision: "act" },
  { name: "S4c it: quanto fa 12 diviso 4 from TextEdit", transcript: "quanto fa 12 diviso 4", snapshot: TEXTEDIT, lang: "it", actionType: "calculate", calcResult: 3, decision: "act" },

  // --- Keys ---
  // The same key press must behave the same in both languages: a plain document is never asked to confirm
  { name: "it: premi invio", transcript: "premi invio", snapshot: TEXTEDIT, lang: "it", enter: true, decision: "act" },
  { name: "en: press enter", transcript: "press enter", snapshot: TEXTEDIT, enter: true, decision: "act" },
  { name: "it: premi invio (Calcolatrice)", transcript: "premi invio", snapshot: CALC, lang: "it", enter: true, decision: "act" },
  { name: "it: premi esc", transcript: "premi esc", snapshot: FINDER, lang: "it", actionType: "press_key", key: "escape", count: 1, decision: "act" },
  { name: "en: press escape", transcript: "press escape", snapshot: FINDER, actionType: "press_key", key: "escape", decision: "act" },
  { name: "it: premi tab", transcript: "premi tab", snapshot: TEXTEDIT, lang: "it", actionType: "press_key", key: "tab", decision: "act" },
  { name: "en: press tab", transcript: "press tab", snapshot: TEXTEDIT, actionType: "press_key", key: "tab", decision: "act" },
  { name: "it: premi spazio", transcript: "premi spazio", snapshot: TEXTEDIT, lang: "it", actionType: "press_key", key: "space", decision: "act" },
  { name: "en: hit space", transcript: "hit space", snapshot: TEXTEDIT, actionType: "press_key", key: "space", decision: "act" },
  { name: "it: premi freccia giù tre volte", transcript: "premi freccia giù tre volte", snapshot: FINDER, lang: "it", actionType: "press_key", key: "down", count: 3, decision: "act" },
  { name: "en: press arrow down 3 times", transcript: "press arrow down 3 times", snapshot: FINDER, actionType: "press_key", key: "down", count: 3, decision: "act" },

  // --- Named shortcuts (closed set, keys owned by code) ---
  { name: "it: copia", transcript: "copia", snapshot: TEXTEDIT, lang: "it", actionType: "shortcut", shortcutId: "copy", char: "c", decision: "act" },
  { name: "en: copy that", transcript: "copy that", snapshot: TEXTEDIT, actionType: "shortcut", shortcutId: "copy", char: "c", decision: "act" },
  { name: "it: incolla", transcript: "incolla", snapshot: TEXTEDIT, lang: "it", actionType: "shortcut", shortcutId: "paste", char: "v", decision: "act" },
  { name: "en: paste", transcript: "paste", snapshot: TEXTEDIT, actionType: "shortcut", shortcutId: "paste", char: "v", decision: "act" },
  { name: "it: taglia", transcript: "taglia", snapshot: TEXTEDIT, lang: "it", actionType: "shortcut", shortcutId: "cut", char: "x", decision: "act" },
  { name: "en: cut", transcript: "cut", snapshot: TEXTEDIT, actionType: "shortcut", shortcutId: "cut", char: "x", decision: "act" },
  { name: "it: seleziona tutto", transcript: "seleziona tutto", snapshot: TEXTEDIT, lang: "it", actionType: "shortcut", shortcutId: "select_all", char: "a", decision: "act" },
  { name: "en: select all", transcript: "select all", snapshot: TEXTEDIT, actionType: "shortcut", shortcutId: "select_all", char: "a", decision: "act" },
  { name: "it: ripeti", transcript: "ripeti", snapshot: TEXTEDIT, lang: "it", actionType: "shortcut", shortcutId: "redo", char: "z", shift: true, decision: "act" },
  { name: "en: redo", transcript: "redo", snapshot: TEXTEDIT, actionType: "shortcut", shortcutId: "redo", char: "z", shift: true, decision: "act" },
  { name: "it: salva", transcript: "salva", snapshot: TEXTEDIT, lang: "it", actionType: "shortcut", shortcutId: "save", char: "s", decision: "act" },
  { name: "en: save", transcript: "save", snapshot: TEXTEDIT, actionType: "shortcut", shortcutId: "save", char: "s", decision: "act" },
  { name: "it: trova nella pagina", transcript: "trova nella pagina", snapshot: CHROME_YT, lang: "it", actionType: "shortcut", shortcutId: "find", char: "f", decision: "act" },
  { name: "en: find on the page", transcript: "find on the page", snapshot: CHROME_YT, actionType: "shortcut", shortcutId: "find", char: "f", decision: "act" },
  { name: "it: nuova finestra", transcript: "nuova finestra", snapshot: FINDER, lang: "it", actionType: "shortcut", shortcutId: "new_window", char: "n", decision: "act" },
  { name: "en: new window", transcript: "new window", snapshot: FINDER, actionType: "shortcut", shortcutId: "new_window", char: "n", decision: "act" },

  // --- Window management ---
  { name: "it: chiudi finestra", transcript: "chiudi finestra", snapshot: FINDER, lang: "it", actionType: "window_op", op: "close", decision: "act" },
  { name: "en: close the window", transcript: "close the window", snapshot: FINDER, actionType: "window_op", op: "close", decision: "act" },
  { name: "it: riduci a icona", transcript: "riduci a icona", snapshot: FINDER, lang: "it", actionType: "window_op", op: "minimize", decision: "act" },
  { name: "en: minimize", transcript: "minimize", snapshot: FINDER, actionType: "window_op", op: "minimize", decision: "act" },
  { name: "it: schermo intero", transcript: "schermo intero", snapshot: FINDER, lang: "it", actionType: "window_op", op: "fullscreen", decision: "act" },
  { name: "en: full screen", transcript: "full screen", snapshot: FINDER, actionType: "window_op", op: "fullscreen", decision: "act" },

  // --- Quit / confirmation / undo ---
  { name: "it: esci da safari -> confirm", transcript: "esci da Safari", snapshot: FINDER, lang: "it", actionType: "quit_app", appName: "Safari", decision: "confirm" },
  { name: "en: quit safari -> confirm", transcript: "quit safari", snapshot: FINDER, actionType: "quit_app", appName: "Safari", decision: "confirm" },
  { name: "it: sì fallo with pending", transcript: "sì fallo", snapshot: FINDER, lang: "it", pending: QUIT_PENDING, decision: "act", confirmed: true },
  { name: "en: yes do it with pending", transcript: "yes do it", snapshot: FINDER, pending: QUIT_PENDING, decision: "act", confirmed: true },
  { name: "it: conferma with pending", transcript: "conferma", snapshot: FINDER, lang: "it", pending: QUIT_PENDING, decision: "act", confirmed: true },
  { name: "it: annulla with pending cancels", transcript: "annulla", snapshot: FINDER, lang: "it", pending: QUIT_PENDING, decision: "cancel" },
  { name: "en: never mind with pending cancels", transcript: "never mind", snapshot: FINDER, pending: QUIT_PENDING, decision: "cancel" },
  { name: "it: lascia stare with pending cancels", transcript: "lascia stare", snapshot: FINDER, lang: "it", pending: QUIT_PENDING, decision: "cancel" },
  { name: "it: annulla after a scroll undoes it", transcript: "annulla", snapshot: CHROME_YT, lang: "it", context: AFTER_SCROLL, actionType: "scroll_up", decision: "act" },
  // nothing recorded to reverse in a desktop app: the edit undo (Cmd+Z), in both languages
  { name: "it: annulla with no history -> Cmd+Z", transcript: "annulla", snapshot: TEXTEDIT, lang: "it", actionType: "shortcut", shortcutId: "undo", char: "z", decision: "act" },
  { name: "en: undo with no history -> Cmd+Z", transcript: "undo", snapshot: TEXTEDIT, actionType: "shortcut", shortcutId: "undo", char: "z", decision: "act" },

  // --- Volume / language ---
  { name: "it: alza il volume", transcript: "alza il volume", snapshot: FINDER, lang: "it", actionType: "volume", op: "up", decision: "act" },
  { name: "en: volume up", transcript: "volume up", snapshot: FINDER, actionType: "volume", op: "up", decision: "act" },
  { name: "it: abbassa il volume", transcript: "abbassa il volume", snapshot: FINDER, lang: "it", actionType: "volume", op: "down", decision: "act" },
  { name: "en: volume down", transcript: "volume down", snapshot: FINDER, actionType: "volume", op: "down", decision: "act" },
  { name: "it: muto", transcript: "muto", snapshot: FINDER, lang: "it", actionType: "volume", op: "mute", decision: "act" },
  { name: "en: mute", transcript: "mute", snapshot: FINDER, actionType: "volume", op: "mute", decision: "act" },
  { name: "it: parla inglese", transcript: "parla inglese", snapshot: FINDER, lang: "it", actionType: "set_language", locale: "en-US", decision: "act" },
  { name: "en: speak english", transcript: "speak english", snapshot: FINDER, actionType: "set_language", locale: "en-US", decision: "act" },
  { name: "it: passa all'italiano", transcript: "passa all'italiano", snapshot: FINDER, lang: "it", actionType: "set_language", locale: "it-IT", decision: "act" },
  { name: "en: switch to italian", transcript: "switch to italian", snapshot: FINDER, actionType: "set_language", locale: "it-IT", decision: "act" },

  // --- Dictation ---
  { name: "it: scrivi ciao a tutti", transcript: "scrivi ciao a tutti", snapshot: TEXTEDIT, lang: "it", actionType: "type_into_field", targetNull: true, text: "ciao a tutti", submit: false, decision: "act" },
  { name: "it: scrivi ... e invia", transcript: "scrivi ciao a tutti e invia", snapshot: TEXTEDIT, lang: "it", actionType: "type_into_field", text: "ciao a tutti", submit: true, decision: "act" },
  { name: "en: type hello world and send it", transcript: "type hello world and send it", snapshot: TEXTEDIT, actionType: "type_into_field", text: "hello world", submit: true, decision: "act" },
  { name: "it: scrivi ciao nella barra di ricerca", transcript: "scrivi ciao nella barra di ricerca", snapshot: CHROME_YT, lang: "it", actionType: "type_into_field", target: "e05", text: "ciao", decision: "act" },

  // --- Apps and sites ---
  { name: "it: apri la calcolatrice", transcript: "apri la calcolatrice", snapshot: FINDER, lang: "it", actionType: "open_app", appName: "Calculator", decision: "act" },
  { name: "en: open the calculator", transcript: "open the calculator", snapshot: FINDER, actionType: "open_app", appName: "Calculator", decision: "act" },
  { name: "it: apri impostazioni di sistema", transcript: "apri impostazioni di sistema", snapshot: FINDER, lang: "it", actionType: "open_app", appName: "System Settings", decision: "act" },
  { name: "it: apri safari", transcript: "apri safari", snapshot: FINDER, lang: "it", actionType: "open_app", appName: "Safari", decision: "act" },
  { name: "it: vai su wikipedia (it.wikipedia.org)", transcript: "vai su wikipedia", snapshot: CHROME_YT, lang: "it", actionType: "navigate_url", url: "it.wikipedia.org", newTab: false, decision: "act" },
  { name: "en: go to wikipedia", transcript: "go to wikipedia", snapshot: CHROME_YT, actionType: "navigate_url", url: "wikipedia.org", decision: "act" },

  // --- Clicking named elements ---
  { name: "it: clicca accetta tutto", transcript: "clicca accetta tutto", snapshot: CHROME_COOKIES, lang: "it", actionType: "click_element", target: "e09", decision: "act" },
  { name: "en: click accept all", transcript: "click accept all", snapshot: CHROME_COOKIES, actionType: "click_element", target: "e09", decision: "act" },
  { name: "it: scegli google", transcript: "scegli Google", snapshot: CHROME_CHOOSE_ENGINE, lang: "it", actionType: "click_element", target: "e03", decision: "act" },
  { name: "en: choose google", transcript: "choose google", snapshot: CHROME_CHOOSE_ENGINE, actionType: "click_element", target: "e03", decision: "act" },
  { name: "it: continua", transcript: "continua", snapshot: CHROME_CHOOSE_ENGINE, lang: "it", actionType: "click_element", target: "e06", decision: "act" },
  { name: "en: continue", transcript: "continue", snapshot: CHROME_CHOOSE_ENGINE, actionType: "click_element", target: "e06", decision: "act" },
  { name: "it: scegli google come motore di ricerca", transcript: "scegli Google come motore di ricerca", snapshot: CHROME_CHOOSE_ENGINE, lang: "it", actionType: "click_element", target: "e03", decision: "act" },

  // --- Scroll / tabs / history ---
  { name: "it: scorri giù di poco", transcript: "scorri giù di poco", snapshot: CHROME_YT, lang: "it", actionType: "scroll_down", amount: "little", decision: "act" },
  { name: "it: vai in fondo alla pagina", transcript: "vai in fondo alla pagina", snapshot: CHROME_YT, lang: "it", actionType: "scroll_down", amount: "end", decision: "act" },
  { name: "it: torna in cima", transcript: "torna in cima", snapshot: CHROME_YT, lang: "it", actionType: "scroll_up", amount: "end", decision: "act" },
  { name: "it: scorri su", transcript: "scorri su", snapshot: CHROME_YT, lang: "it", actionType: "scroll_up", decision: "act" },
  { name: "en: scroll up", transcript: "scroll up", snapshot: CHROME_YT, actionType: "scroll_up", decision: "act" },
  { name: "it: scheda successiva", transcript: "scheda successiva", snapshot: CHROME_YT, lang: "it", actionType: "switch_tab", direction: "next", decision: "act" },
  { name: "en: next tab", transcript: "next tab", snapshot: CHROME_YT, actionType: "switch_tab", direction: "next", decision: "act" },
  { name: "it: scheda precedente", transcript: "scheda precedente", snapshot: CHROME_YT, lang: "it", actionType: "switch_tab", direction: "previous", decision: "act" },
  { name: "it: chiudi scheda", transcript: "chiudi scheda", snapshot: CHROME_YT, lang: "it", actionType: "close_tab", decision: "act" },
  { name: "en: close tab", transcript: "close tab", snapshot: CHROME_YT, actionType: "close_tab", decision: "act" },
  { name: "it: ricarica la pagina", transcript: "ricarica la pagina", snapshot: CHROME_YT, lang: "it", actionType: "reload", decision: "act" },
  { name: "en: reload", transcript: "reload", snapshot: CHROME_YT, actionType: "reload", decision: "act" },
  { name: "it: indietro", transcript: "indietro", snapshot: CHROME_YT, lang: "it", actionType: "go_back", decision: "act" },
  { name: "en: go back (desktop)", transcript: "go back", snapshot: CHROME_YT, actionType: "go_back", decision: "act" },

  // --- Review round: look-alikes, tabs, searches that must not land in a form field, dropdowns, thousands, key counts ---
  { name: "it: cancella -> delete key, not undo", transcript: "cancella", snapshot: TEXTEDIT, lang: "it", actionType: "press_key", key: "delete", decision: "act" },
  { name: "en: delete -> delete key", transcript: "backspace", snapshot: TEXTEDIT, actionType: "press_key", key: "delete", decision: "act" },
  { name: "it: cancella tutto asks first", transcript: "cancella tutto", snapshot: TEXTEDIT, lang: "it", actionType: "send_keys", decision: "confirm" },
  { name: "it: zoom indietro is zoom out", transcript: "zoom indietro", snapshot: CHROME_YT, lang: "it", actionType: "shortcut", shortcutId: "zoom_out", decision: "act" },
  { name: "en: zoom out", transcript: "zoom out", snapshot: CHROME_YT, actionType: "shortcut", shortcutId: "zoom_out", decision: "act" },
  { name: "it: torna all'app precedente", transcript: "torna all'app precedente", snapshot: TEXTEDIT, lang: "it", actionType: "switch_app_back", decision: "act" },
  { name: "en: switch to the previous app", transcript: "switch to the previous app", snapshot: TEXTEDIT, actionType: "switch_app_back", decision: "act" },
  { name: "it: vai alla terza scheda", transcript: "vai alla terza scheda", snapshot: CHROME_YT, lang: "it", actionType: "switch_tab", position: 3, decision: "act" },
  { name: "en: go to the last tab", transcript: "go to the last tab", snapshot: CHROME_YT, actionType: "switch_tab", position: 9, decision: "act" },
  { name: "it: cerca gatti on a sign-up page -> default engine", transcript: "cerca gatti", snapshot: SIGNUP, lang: "it", actionType: "navigate_url", url: "duckduckgo.com/?q=gatti", newTab: false, decision: "act" },
  { name: "en: search for cats in TextEdit -> default engine", transcript: "search for cats", snapshot: TEXTEDIT, actionType: "navigate_url", url: "duckduckgo.com/?q=cats", decision: "act" },
  { name: "it: cerca su facebook (no template) keeps the site", transcript: "cerca su facebook mario rossi", snapshot: CORRIERE, lang: "it", actionType: "navigate_url", url: "site%3Afacebook.com", decision: "act" },
  { name: "it: cerca gatti in una nuova scheda", transcript: "cerca gatti in una nuova scheda", snapshot: CORRIERE, lang: "it", actionType: "navigate_url", newTab: true, textIn: ["gatti"], decision: "act" },
  { name: "en: search cats in a new tab", transcript: "search for cats in a new tab", snapshot: CORRIERE, actionType: "navigate_url", newTab: true, textIn: ["cats"], decision: "act" },
  { name: "it: cerca gatti on a site with a search field", transcript: "cerca gatti", snapshot: CORRIERE, lang: "it", actionType: "type_into_field", target: "e04", text: "gatti", submit: true, decision: "act" },
  { name: "it: seleziona Francia dal menu paese", transcript: "seleziona Francia dal menu paese", snapshot: COUNTRY_FORM, lang: "it", actionType: "select_option", target: "e03", text: "Francia", decision: "act" },
  { name: "en: select France from the country dropdown", transcript: "select France from the country dropdown", snapshot: COUNTRY_FORM, actionType: "select_option", target: "e03", text: "France", decision: "act" },
  { name: "it: fai 1.500 più 2 (thousands)", transcript: "fai 1.500 più 2", snapshot: CALC, lang: "it", actionType: "calculate", calcResult: 1502, decision: "act" },
  { name: "it: premi tab tre volte", transcript: "premi tab tre volte", snapshot: TEXTEDIT, lang: "it", actionType: "press_key", key: "tab", count: 3, decision: "act" },
  { name: "en: press tab three times", transcript: "press tab three times", snapshot: TEXTEDIT, actionType: "press_key", key: "tab", count: 3, decision: "act" },
  { name: "it: apri terminale", transcript: "apri terminale", snapshot: TEXTEDIT, lang: "it", actionType: "open_app", appName: "Terminal", decision: "act" },
  { name: "en: open terminal", transcript: "open terminal", snapshot: TEXTEDIT, actionType: "open_app", appName: "Terminal", decision: "act" },

  // --- Chit-chat is never a command ---
  { name: "it: chatter ignored", transcript: "allora secondo me dovremmo andare a pranzo", snapshot: CHROME_YT, lang: "it", decision: "ignore" },
  { name: "en: chatter ignored", transcript: "so anyway I think we should get lunch", snapshot: CHROME_YT, decision: "ignore" },
  { name: "it: filler ignored", transcript: "ehm ok allora", snapshot: CHROME_YT, lang: "it", decision: "ignore" },
);

const results = [];

before(() => {
  if (!hasApiKey()) console.log("SKIP: no TYPESAFE_API_KEY / JEV_API_KEY set");
});

for (const c of CASES) {
  test(`jev: ${c.name} — "${c.transcript}"`, { skip: !hasApiKey() }, async () => {
    const snapshot = typeof c.snapshot === "string" ? fixture(c.snapshot) : c.snapshot;
    const r = await decide({ transcript: c.transcript, snapshot, context: c.context ?? null, pendingConfirmation: c.pending ? "quit Safari" : null });
    // `degrade`: pretend Jev lost the plot (no intent, not a command) to prove the arithmetic rescue is code-side.
    if (c.degrade) {
      r.answers.intent = { type: "choice", choice: "none", confidence: 0.2, probabilities: { none: 0.2 } };
      r.answers.is_command = { type: "noul", noul: 0.1 };
      r.answers.complete = { type: "noul", noul: 0.1 };
    }
    const policy = evaluatePolicy({ answers: r.answers, candidates: r.candidates, snapshot, isFinal: c.final !== false, silentMs: c.silentMs ?? 0, context: c.context ?? null, pending: c.pending ?? null, lang: c.lang ?? "en" });
    const a = r.answers;
    const failures = [];
    if (c.intent && a.intent.choice !== c.intent) failures.push(`intent ${a.intent.choice} != ${c.intent} (conf ${a.intent.confidence.toFixed(2)})`);
    if (c.target && a.target.choice !== c.target && policy.action?.targetId !== c.target) failures.push(`target ${a.target.choice} != ${c.target} (conf ${a.target.confidence.toFixed(2)})`);
    if (c.targetIn && !c.targetIn.includes(policy.action?.targetId ?? a.target.choice)) failures.push(`target ${policy.action?.targetId ?? a.target.choice} not in ${c.targetIn}`);
    if (c.targetNot && policy.action?.targetId === c.targetNot) failures.push(`target ${policy.action.targetId} should not be ${c.targetNot}`);
    if (c.correction === true && (a.is_correction?.noul ?? 0) < 0.6) failures.push(`is_correction ${(a.is_correction?.noul ?? 0).toFixed(2)} < 0.6`);
    if (c.correction === false && (a.is_correction?.noul ?? 0) >= 0.6) failures.push(`is_correction ${(a.is_correction?.noul ?? 0).toFixed(2)} >= 0.6`);
    if (c.actionType && policy.action?.type !== c.actionType) failures.push(`action ${policy.action?.type} != ${c.actionType}`);
    if (c.decision && policy.decision !== c.decision) failures.push(`decision ${policy.decision} != ${c.decision} (${policy.summary})`);
    if (c.decisionIn && !c.decisionIn.includes(policy.decision)) failures.push(`decision ${policy.decision} not in ${c.decisionIn} (${policy.summary})`);
    const sameText = (x) => (c.textCI ? String(x).toLowerCase() === c.text : x === c.text);
    if (c.textIn && !c.textIn.some((t) => t === policy.action?.text || t === policy.action?.query)) failures.push(`text ${JSON.stringify(policy.action?.text ?? policy.action?.query)} not in ${JSON.stringify(c.textIn)}`);
    if (c.text && !sameText(policy.action?.text) && !sameText(policy.action?.query)) failures.push(`text ${JSON.stringify(policy.action?.text ?? policy.action?.query)} != ${JSON.stringify(c.text)}`);
    if (c.url && !(policy.action?.url || "").includes(c.url)) failures.push(`url ${policy.action?.url} !~ ${c.url}`);
    if (c.actionIn && !c.actionIn.includes(policy.action?.type)) failures.push(`action ${policy.action?.type} not in ${c.actionIn}`);
    if (c.newTab !== undefined && Boolean(policy.action?.newTab) !== c.newTab) failures.push(`newTab ${policy.action?.newTab} != ${c.newTab}`);
    if (c.submit !== undefined && Boolean(policy.action?.submit) !== c.submit) failures.push(`submit ${policy.action?.submit} != ${c.submit}`);
    if (c.key && policy.action?.key !== c.key) failures.push(`key ${policy.action?.key} != ${c.key}`);
    if (c.count && policy.action?.count !== c.count) failures.push(`count ${policy.action?.count} != ${c.count}`);
    if (c.shortcutId && policy.action?.id !== c.shortcutId) failures.push(`shortcut ${policy.action?.id} != ${c.shortcutId}`);
    if (c.expr && policy.action?.expr !== c.expr) failures.push(`expr ${policy.action?.expr} != ${c.expr}`);
    if (c.appName && policy.action?.app !== c.appName) failures.push(`app ${policy.action?.app} != ${c.appName}`);
    if (c.dangling && !policy.dangling) failures.push(`expected a dangling wait (${policy.summary})`);
    if (c.confirmed && !policy.action?.confirmed) failures.push("pending action not confirmed");
    if (c.enter && !(policy.action?.type === "press_enter" || (policy.action?.type === "press_key" && policy.action.key === "return" && policy.action.count === 1))) failures.push(`action ${policy.action?.type}/${policy.action?.key} is not enter`);
    if (c.char && policy.action?.char !== c.char) failures.push(`char ${policy.action?.char} != ${c.char}`);
    if (c.shift !== undefined && Boolean(policy.action?.shift) !== c.shift) failures.push(`shift ${policy.action?.shift} != ${c.shift}`);
    if (c.op && policy.action?.op !== c.op) failures.push(`op ${policy.action?.op} != ${c.op}`);
    if (c.locale && policy.action?.locale !== c.locale) failures.push(`locale ${policy.action?.locale} != ${c.locale}`);
    if (c.direction && policy.action?.direction !== c.direction) failures.push(`direction ${policy.action?.direction} != ${c.direction}`);
    if (c.targetNull && policy.action?.targetId != null) failures.push(`targetId ${policy.action?.targetId} should be null`);
    if (c.calcResult !== undefined && policy.action?.result !== c.calcResult) failures.push(`result ${policy.action?.result} != ${c.calcResult}`);
    if (c.keys && JSON.stringify(policy.action?.keys) !== JSON.stringify(c.keys)) failures.push(`keys ${JSON.stringify(policy.action?.keys)} != ${JSON.stringify(c.keys)}`);
    if (c.cand0 && r.candidates.text[0] !== c.cand0) failures.push(`candidates.text[0] ${JSON.stringify(r.candidates.text[0])} != ${JSON.stringify(c.cand0)}`);
    if (c.noRetry && policy.retryInMs !== undefined) failures.push(`retryInMs ${policy.retryInMs} set on a wait that no clock can flip`);
    if (c.summaryIs && policy.summary !== c.summaryIs) failures.push(`summary ${JSON.stringify(policy.summary)} != ${JSON.stringify(c.summaryIs)}`);
    if (c.textInOrUrl) {
      const a2 = policy.action;
      const okText = a2?.type === "type_into_field" && c.textInOrUrl.text.includes(a2.text);
      const okUrl = a2?.type === "navigate_url" && (a2.url || "").includes(c.textInOrUrl.url);
      if (!okText && !okUrl) failures.push(`neither a search for ${JSON.stringify(c.textInOrUrl.text)} nor a visit to ${c.textInOrUrl.url}: ${JSON.stringify(a2)}`);
    }
    if (c.position && policy.action?.position !== c.position) failures.push(`position ${policy.action?.position} != ${c.position}`);
    if (c.amount && policy.action?.amount !== c.amount) failures.push(`amount ${policy.action?.amount} != ${c.amount}`);

    results.push({ name: c.name, lang: c.lang ?? (/[àèéìòù]|\b(il|la|di|su|cerca|apri|vai)\b/i.test(c.transcript) ? "it" : "en"), ok: failures.length === 0, latency: r.latencyMs, tokens: r.usage.input_tokens, failures });
    console.log(
      `  ${failures.length ? "✗" : "✓"} ${c.name.padEnd(26)} ${String(r.latencyMs).padStart(4)}ms ${String(r.usage.input_tokens).padStart(5)}tok  intent=${a.intent.choice}(${a.intent.confidence.toFixed(2)}) ctl=${a.control?.choice ?? "-"} target=${a.target.choice}(${a.target.confidence.toFixed(2)}) complete=${a.complete.noul.toFixed(2)} cmd=${a.is_command.noul.toFixed(2)} destr=${a.destructive.noul.toFixed(2)} → ${policy.decision}${failures.length ? "\n      " + failures.join("; ") : ""}`,
    );
    assert.deepEqual(failures, [], failures.join("; "));
  });
}

// --- Controller + real Jev: whole utterances through debounce, cache, policy and executor (mock executor). ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function liveController(snapshot, lang) {
  const toasts = [];
  const executed = [];
  const browser = {
    onChange: () => () => {},
    tabInfo: () => [],
    snapshot: async () => ({ ...snapshot }),
    overlay: async (fn, ...args) => {
      if (fn === "toast") toasts.push(args[0]);
    },
  };
  const c = new Controller({ browser, executeFn: async (a) => (executed.push(a), { ok: true, detail: "ok" }), lang });
  return { c, toasts, executed };
}

/** Say one finished utterance and wait until the controller has settled on it. */
async function say(c, text, id, settleMs = 1800) {
  c.handleTranscript({ text, final: true, utteranceId: id });
  await sleep(settleMs);
}

test("mixed-language session: open youtube, cerca macchine, press escape, chiudi scheda", { skip: !hasApiKey() }, async () => {
  const { c, executed } = liveController(CHROME_YT, "it-IT");
  await c.start();
  await say(c, "open youtube", "m1");
  await say(c, "cerca macchine", "m2");
  await say(c, "press escape", "m3");
  await say(c, "chiudi scheda", "m4");
  await c.close();
  const kinds = executed.map((a) => a.type);
  assert.deepEqual(kinds, ["navigate_url", "type_into_field", "press_key", "close_tab"], JSON.stringify(executed));
  assert.match(executed[0].url, /youtube\.com/);
  assert.equal(executed[1].targetId, "e05");
  assert.equal(executed[1].text, "macchine");
  assert.equal(executed[2].key, "escape");
});

test("chit-chat never toasts 'didn't get that' and never acts (IT + EN)", { skip: !hasApiKey() }, async () => {
  const { c, executed, toasts } = liveController(CHROME_YT, "it-IT");
  await c.start();
  await say(c, "allora secondo me dovremmo andare a pranzo", "c1");
  await say(c, "so anyway I think we should get lunch", "c2");
  await say(c, "ehm ok allora", "c3");
  await c.close();
  assert.deepEqual(executed, []);
  assert.deepEqual(toasts, [], `unexpected toasts: ${JSON.stringify(toasts)}`);
});

test("a finished 'cerca un video di' gives exactly one 'Frase incompleta' toast and no navigation", { skip: !hasApiKey() }, async () => {
  const { c, executed, toasts } = liveController(CHROME_YT, "it-IT");
  await c.start();
  await say(c, "cerca un video di", "d1");
  await c.close();
  assert.deepEqual(executed, []);
  assert.deepEqual(toasts, [UI_TEXT.it.incomplete]);
});

test("integration pass-rate report", { skip: !hasApiKey() }, () => {
  const passed = results.filter((r) => r.ok).length;
  const lat = results.map((r) => r.latency).sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length / 2)];
  const p95 = lat[Math.min(lat.length - 1, Math.ceil(lat.length * 0.95) - 1)];
  const it = results.filter((r) => r.lang === "it");
  const en = results.filter((r) => r.lang !== "it");
  const frac = (xs) => `${xs.filter((x) => x.ok).length}/${xs.length}`;
  console.log(`  by language: IT ${frac(it)} · EN ${frac(en)}`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED: ${r.name}: ${r.failures.join("; ")}`);
  const avg = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length);
  const tokens = results.reduce((a, r) => a + r.tokens, 0);
  const rate = passed / results.length;
  console.log(`\n  ${MODEL}: ${passed}/${results.length} cases passed (${(rate * 100).toFixed(1)}%) · latency avg ${avg} ms, p50 ${p50} ms, p95 ${p95} ms, max ${lat[lat.length - 1]} ms · ${tokens} input tokens ($${((tokens / 1e6) * 0.042).toFixed(5)})\n`);
  assert.ok(rate >= 0.9, `pass rate ${(rate * 100).toFixed(1)}% is below 90%`);
});
