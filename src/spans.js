/**
 * Candidate extraction (code, not Jev). Jev never generates text: we over-generate
 * candidate spans from the transcript here, and Jev only *picks* one of them.
 * The chosen option is copied verbatim into the browser.
 */

import { CONTINUATION_WORDS, DEFAULT_SEARCH_ENGINE, MAX_REPEAT, SITE_HOME, SITE_SEARCH, SITE_URLS_BY_LANG } from "./constants.js";

// Everything below is bilingual (Italian + English) and mixable inside one sentence.

const TLDS = "com|org|net|io|ai|dev|co|edu|gov|de|uk|us|app|xyz|info|me|tv|ch|at|fr|nl|es|it";

// Fillers that are safe to drop anywhere / only at the edges of a span ("ok", "allora", "adesso" can be real words).
const FILLER_RE = /(?<![\p{L}\d])(?:please|thanks|thank you|um|uh|ehm|mmm|per favore|per piacere|grazie)(?![\p{L}\d])/giu;
const EDGE_FILLER_RE = /^(?:(?:okay|ok|now|and then|then|allora|adesso|subito|poi|dai)\s+)+|(?:\s+(?:okay|ok|now|and then|then|allora|adesso|subito|poi))+$/giu;

// Site / destination names, spoken in either language.
const SITE_NAMES =
  "google maps|google|duckduckgo|wikipedia|youtube|github|amazon|reddit|twitter|x|hacker news|gmail|linkedin|netflix|spotify|stack ?overflow|facebook|instagram|maps|mappe";
const WEB_NAMES = "the web|internet|il web|web|rete|online";
// Words that are also ordinary topics ("rete neurale", "web design", "x ray"): only a destination when a preposition says so.
const AMBIGUOUS_SITE_NAMES = "x|maps|mappe|the web|internet|il web|web|rete|online";
const CLEAR_SITE_NAMES = SITE_NAMES.split("|").filter((n) => !AMBIGUOUS_SITE_NAMES.split("|").includes(n)).join("|");

// Verbs that introduce payload text. Order matters: longer/more specific first.
const TEXT_VERBS = [
  /\b(?:search|look)\s+(?:for|up)\s+/i,
  new RegExp(`\\bsearch\\s+(?:on\\s+)?(?:${SITE_NAMES}|the web)\\s+for\\s+`, "i"),
  /\bsearch\s+/i,
  /\bgoogle\s+/i,
  /\bfind\s+/i,
  /\btype\s+(?:in\s+)?/i,
  /\benter\s+/i,
  /\bwrite\s+/i,
  /\bput\s+/i,
  /\bfill\s+(?:in\s+)?/i,
  /\b(?:select|choose|pick)\s+/i,
  // Italian
  /\b(?:cerca|cercare|cerchi|cercami|cercarmi|ricerca|trova|trovami|trovare)\s+/i,
  /\b(?:scrivi|scrivimi|digita|inserisci|metti|compila)\s+/i,
  /\b(?:seleziona|selezionami|scegli|scegliere|imposta)\s+/i,
];

// Trailing destination phrases to strip from a payload: "... into the search box", "... nella barra di ricerca", "... su youtube".
const TRAILING_DEST_RE =
  /\s+(?:in|into|on|inside|to)\s+(?:the\s+)?(?:[\w-]+\s+){0,4}?(?:box|field|input|bar|form|textarea|search|wikipedia|youtube|google|duckduckgo|github|amazon|reddit|twitter|x|web)\b.*$/i;
// "... from the language dropdown", "... dal menu paese", "... dall'elenco a discesa": where an option is picked, never part of it.
const TRAILING_DROPDOWN_RE =
  /\s+(?:(?:dal|dalla|dallo|dai|dagli|dalle|nel|nella|nello)\s+(?:(?:il|la|lo)\s+)?|dall['’]\s*|from\s+(?:the\s+)?|in\s+the\s+|out\s+of\s+(?:the\s+)?)(?:[\p{L}'-]+\s+){0,3}?(?:menu|menù|dropdown|drop-down|tendina|elenco a discesa|picker|selettore|popup)(?![\p{L}]).*$/iu;
const TRAILING_DEST_IT_RE = new RegExp(
  `\\s+(?:(?:nel|nella|nello|nei|dentro|sul|sulla|in)\\s+(?:(?:il|la|lo)\\s+)?|nell['’]\\s*)(?:[\\p{L}'-]+\\s+){0,3}?(?:barra|campo|casella|riquadro|box|form|ricerca|input|testo)(?![\\p{L}]).*$` +
    `|\\s+(?:su|sul|in|da|con|tramite|via)\\s+(?:${SITE_NAMES}|${WEB_NAMES})(?![\\p{L}\\d]).*$`,
  "iu",
);

// Leading site phrases: "wikipedia for cats" -> "cats", "su internet youtube" -> "youtube", "su google macchine" -> "macchine"
const PREP = "(?:on|in|su|sul|sulla|nel|nella|con|tramite|via)";
const LEADING_SITE_RE = new RegExp(
  // a clear site name needs no preposition ("youtube macchine"); an ambiguous one does ("su internet ...", "rete per ...")
  `^(?:${PREP}\\s+)?(?:${CLEAR_SITE_NAMES})\\s+(?:(?:for|per|di)\\s+)?(?=\\S)` +
    `|^${PREP}\\s+(?:${AMBIGUOUS_SITE_NAMES})\\s+(?:(?:for|per|di)\\s+)?(?=\\S)` +
    `|^(?:${AMBIGUOUS_SITE_NAMES})\\s+(?:for|per|di)\\s+(?=\\S)`,
  "i",
);

// Generic lead-ins that are not the topic itself ("un video di macchine" -> "macchine").
const LEAD_INS = [
  /^(?:un|uno|una|dei|delle|degli|alcuni|alcune|some|a)\s+(?:video|filmati?|foto|immagini|canzoni|canzone|brani|brano|articoli|articolo|libri|libro|ricette|ricetta|pagine|pagina|siti|sito|risultati|pictures?|photos?|images?|songs?|articles?)\s+(?:di|su|sul|sulla|del|della|dei|delle|about|of|on|for)\s+/i,
  /^(?:informazioni|info|notizie|news|dettagli|information|details)\s+(?:su|sul|sulla|sui|di|riguardo a|riguardo|about|on|of|for)\s+/i,
];
const LEADING_DET_RE = /^(?:un|uno|una|il|lo|la|an?|the)\s+(?=\S)/i;

// "... e invia", "and send it": the text is typed, then submitted. Never part of a candidate.
const SUBMIT_RE =
  /\s+(?:e|and)\s+(?:(?:poi|then)\s+)?(?:invia(?:lo|la)?|manda(?:lo|la)?|premi\s+(?:invio|enter)|dai\s+(?:invio|enter)|send(?:\s+it)?|submit(?:\s+it)?|press\s+enter|hit\s+enter)\s*[.!?]*$/i;

// "in una nuova scheda", "in una scheda nuova", "in un'altra scheda", "in a new tab", "in another tab", "su nuova scheda", "new tab"
const NEW_TAB_SRC =
  "(?:\\b(?:in|su|nel|on|into)\\s+)?(?:(?:una|un|a|an)\\s+)?(?:(?:nuova|nuovo|altra|altro|new|another|separate|separata)\\s+(?:scheda|tab)|(?:scheda|tab)\\s+(?:nuova|nuovo|separata|separato)|un['’]altra\\s+scheda)\\b";
const NEW_TAB_RE = new RegExp(NEW_TAB_SRC, "i");
const NEW_TAB_STRIP_RE = new RegExp(`\\s*${NEW_TAB_SRC}`, "gi");

export function cleanTranscript(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFiller(s) {
  return s
    .replace(FILLER_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(EDGE_FILLER_RE, "")
    .replace(/\s+/g, " ")
    .replace(/[.,!?]+$/g, "")
    .trim();
}

function pushUnique(list, value) {
  const v = stripFiller(value);
  if (!v) return;
  if (v.length > 120) return;
  if (list.some((x) => x.toLowerCase() === v.toLowerCase())) return;
  list.push(v);
}

const stripDestination = (s) => s.replace(TRAILING_DROPDOWN_RE, "").replace(TRAILING_DEST_RE, "").replace(TRAILING_DEST_IT_RE, "");

/** Variants of the text after a verb, most specific (bare topic) first. */
function tailVariants(tail) {
  const lead = tail.replace(LEADING_SITE_RE, "");
  const base = stripDestination(lead);
  const out = [];
  for (const re of LEAD_INS) {
    const bare = base.replace(re, "");
    if (bare !== base) out.push(bare);
  }
  out.push(base);
  const det = base.replace(LEADING_DET_RE, "");
  if (det !== base) out.push(det);
  if (base !== lead) out.push(lead);
  if (lead !== tail) out.push(tail);
  return out;
}

// "scrivi a Sofia", "write to John Smith": a capitalised name after "a / to" is who to write to, not text to type.
const RECIPIENT_ONLY_RE = /^(?:scrivi|scrivere|write)\s+(?:a|ad|to)\s+\p{Lu}\p{L}*(?:\s+\p{Lu}\p{L}*)?$/u;

/** "scrivi ciao e invia" -> true; the submit suffix is never part of the text. */
export function wantsSubmit(transcript) {
  return SUBMIT_RE.test(cleanTranscript(transcript));
}

/** "in una nuova scheda", "new tab": open the destination in a NEW tab instead of the current one. */
export function wantsNewTab(transcript) {
  return NEW_TAB_RE.test(cleanTranscript(transcript));
}

/**
 * Candidate text payloads for type/search intents (Italian and English).
 * Returns [] when the transcript is empty. Order: most likely first; the submit suffix is stripped.
 */
export function extractTextCandidates(transcript) {
  // Neither the submit suffix nor "in una nuova scheda" is ever part of what is typed or searched.
  const t = cleanTranscript(transcript).replace(NEW_TAB_STRIP_RE, "").replace(SUBMIT_RE, "").replace(/\s+/g, " ").trim();
  if (!t || RECIPIENT_ONLY_RE.test(t)) return [];
  const out = [];

  // 1. quoted spans
  for (const m of t.matchAll(/["“”']([^"“”']{1,120})["“”']/g)) pushUnique(out, m[1]);

  // 2. text after a payload verb (earliest verb in the sentence first), destination phrase stripped
  const verbMatches = TEXT_VERBS.map((re) => re.exec(t))
    .filter(Boolean)
    .sort((a, b) => a.index - b.index || b[0].length - a[0].length);
  for (const m of verbMatches) {
    for (const v of tailVariants(t.slice(m.index + m[0].length))) pushUnique(out, v);
  }

  // 3. the tail after the first "for" / "per"
  const forIdx = t.toLowerCase().indexOf(" for ");
  if (forIdx >= 0) pushUnique(out, stripDestination(t.slice(forIdx + 5)));

  // 3b. a lead-in at the very start ("informazioni su alan turing")
  for (const re of LEAD_INS) {
    const bare = t.replace(re, "");
    if (bare !== t) pushUnique(out, bare);
  }

  // 4. tail after the first word (covers "type hello"); never outranks a verb match above
  const firstSpace = t.indexOf(" ");
  if (firstSpace > 0) {
    for (const v of tailVariants(t.slice(firstSpace + 1)).slice(0, 2)) pushUnique(out, v);
  }

  // 5. whole transcript as a last resort
  pushUnique(out, t);

  return out.slice(0, 8);
}

const DOMAIN_AHEAD = `(?=(?:${TLDS})(?![a-z0-9])|[a-z0-9-]+\\s+(?:punto|dot)\\s+)`;

/**
 * "example dot com" -> "example.com", "github punto com barra docs" -> "github.com/docs",
 * "mario chiocciola gmail punto com" -> "mario@gmail.com". "punto", "barra" and "chiocciola" are only rewritten
 * inside domain-looking spans, so "a questo punto" stays prose. Also lowercases and strips spaces around dots.
 */
export function normalizeSpokenUrl(text) {
  let t = String(text || "")
    .toLowerCase()
    .replace(/\s+dot\s+/g, ".")
    .replace(new RegExp(`\\s+punto\\s+${DOMAIN_AHEAD}`, "g"), ".")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s+slash\s+/g, "/")
    .replace(/\bwww\s+/g, "www.")
    .replace(/\bh\s*t\s*t\s*p\s*s?\s*:\s*\/\s*\//g, (m) => (m.includes("s") ? "https://" : "http://"));
  // "<domain> barra a barra b" -> "<domain>/a/b"
  t = t.replace(new RegExp(`((?:[a-z0-9-]+\\.)+(?:${TLDS}))((?:\\s+barra\\s+[a-z0-9._-]+)+)`, "g"), (_, d, path) =>
    d + path.replace(/\s+barra\s+/g, "/"),
  );
  t = t.replace(/\s+chiocciola\s+(?=[a-z0-9-]+\.)/g, "@");
  return t;
}

/** Domain-looking spans in the transcript (after spoken-url normalisation). */
export function extractUrlCandidates(transcript) {
  const t = normalizeSpokenUrl(cleanTranscript(transcript));
  if (!t) return [];
  const re = new RegExp(`(?:https?://)?(?:[a-z0-9._-]+@)?(?:[a-z0-9-]+\\.)+(?:${TLDS})(?![a-z0-9])(?:/[^\\s]*)?`, "gi");
  const out = [];
  for (const m of t.matchAll(re)) {
    const v = m[0].replace(/[.,!?]+$/, "");
    if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, 6);
}

export function toHttpUrl(domainish) {
  const v = String(domainish).trim();
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
}

const NUMBER_WORDS = {
  one: 1, first: 1, "1": 1, "1st": 1, uno: 1, una: 1, primo: 1, prima: 1, "1°": 1,
  two: 2, second: 2, "2": 2, "2nd": 2, due: 2, secondo: 2, seconda: 2, "2°": 2,
  three: 3, third: 3, "3": 3, "3rd": 3, tre: 3, terzo: 3, terza: 3, "3°": 3,
  four: 4, fourth: 4, "4": 4, "4th": 4, quattro: 4, quarto: 4, quarta: 4, "4°": 4,
  five: 5, fifth: 5, "5": 5, "5th": 5, cinque: 5, quinto: 5, quinta: 5, "5°": 5,
};
// Speech-recognizer homophones, only trusted when they are the whole utterance ("to" alone).
const NUMBER_HOMOPHONES = { won: 1, to: 2, too: 2, for: 4 };

/**
 * When numbered candidate overlays are on screen, a bare number ("two", "the second one", "il secondo",
 * "numero tre") is a deterministic pick — no need to ask Jev.
 * Returns 1-based index or null.
 */
const PICK_STOPWORDS = new Set([
  "the", "number", "option", "pick", "choose", "select", "click", "take", "that", "please", "link", "item", "result", "go", "with", "on", "yes", "this", "um", "uh",
  "il", "la", "lo", "numero", "opzione", "scegli", "seleziona", "clicca", "premi", "quello", "quella", "per", "favore", "prendi", "sì", "si", "risultato", "ehm",
]);

export function parseCandidatePick(transcript, max = 5) {
  const t = cleanTranscript(transcript).toLowerCase().replace(/[.,!?]/g, "");
  if (!t) return null;
  const meaningful = t.split(" ").filter((w) => !PICK_STOPWORDS.has(w));
  if (meaningful.length === 0 || meaningful.length > 2) return null;
  // One number word, or "the second one" (two number words). Any other word ("scrivi due", "cerca tre") is a command, not a pick.
  if (meaningful.length === 2 && !meaningful.every((w) => Object.hasOwn(NUMBER_WORDS, w))) return null;
  for (const w of meaningful) {
    const n = Object.hasOwn(NUMBER_WORDS, w) ? NUMBER_WORDS[w] : 0;
    if (n && n <= max) return n;
  }
  if (meaningful.length === 1) {
    const n = Object.hasOwn(NUMBER_HOMOPHONES, meaningful[0]) ? NUMBER_HOMOPHONES[meaningful[0]] : 0;
    if (n && n <= max) return n;
  }
  return null;
}

/**
 * True when the text ends on a word that expects a continuation (a preposition, article, conjunction, operator or an
 * elided article like "nell'"). Same rule as the helper's end-of-utterance logic; payloads ending like this are never typed.
 */
export function endsOnContinuationWord(text) {
  const t = String(text ?? "").toLowerCase().replace(/[\s.,;:!?]+$/g, "").trim();
  if (!t) return false;
  const tokens = t.split(/\s+/);
  const last = tokens[tokens.length - 1];
  // "scorri un po'", "ingrandisci di più" are finished phrases; the elision rule is for "dell'", "l'".
  if (/^po['’]$/.test(last)) return false;
  if ((last === "più" || last === "meno") && tokens[tokens.length - 2] === "di") return false;
  if (/['’]$/.test(last)) return true;
  return CONTINUATION_WORDS.has(last);
}

const OPEN_VERB_RE = /^(?:(?:please|per favore|ok|okay|ehm|allora|dai|ora|now)\s+)*(?:apri|aprimi|avvia|lancia|lanciami|open|launch|start|run)\b/i;
/** "apri terminale", "open the calculator": the words start with an open / launch verb (rescues a barely-unconfident open_app). */
export function startsWithOpenVerb(transcript) {
  return OPEN_VERB_RE.test(cleanTranscript(transcript));
}

const REPEAT_WORDS = {
  una: 1, uno: 1, one: 1, due: 2, two: 2, tre: 3, three: 3, quattro: 4, four: 4, cinque: 5, five: 5,
  sei: 6, six: 6, sette: 7, seven: 7, otto: 8, eight: 8, nove: 9, nine: 9, dieci: 10, ten: 10,
};

/** "tre volte", "3 times", "twice", "una volta" -> how many times to repeat a key press. 1..MAX_REPEAT, default 1. */
export function parseRepeatCount(transcript) {
  const t = cleanTranscript(transcript).toLowerCase();
  let n = 1;
  let m = t.match(/\b(\d{1,3})\s*(?:volte|volta|times|time|x)\b/);
  if (m) n = Number(m[1]);
  else if ((m = t.match(/\b([a-z]+)\s+(?:volte|volta|times|time)\b/)) && Object.hasOwn(REPEAT_WORDS, m[1])) n = REPEAT_WORDS[m[1]];
  else if (/\btwice\b/.test(t)) n = 2;
  else if (/\bthrice\b/.test(t)) n = 3;
  return Math.min(MAX_REPEAT, Math.max(1, n));
}

const CONFIRM_PHRASES = ["conferma", "confermo", "si", "fallo", "vai", "procedi", "yes", "confirm", "do it", "go ahead", "proceed"];
// Casual agreement words are also what people say to a colleague: the no-model-call confirm shortcut ignores them
// (`parseConfirmation(t, { casual: false })`); they still reach Jev, which sees `pending_confirmation`.
const CASUAL_CONFIRM_PHRASES = ["ok", "okay", "certo", "va bene", "yeah", "yep", "sure"];
const CANCEL_PHRASES = [
  "annulla", "no", "lascia stare", "lascia perdere", "ferma", "stop", "basta", "non farlo", "cancel", "never mind", "nevermind", "forget it", "dont", "don't",
];
const CONFIRM_FILLERS = ["per favore", "per piacere", "pure", "dai", "allora", "please", "then", "it"];

/**
 * A whole utterance that is just "yes" or "no" in either language -> "confirm" / "cancel"; anything else, or a mix,
 * -> null. Only meaningful while a confirmation is pending (the caller decides; "annulla" without a pending
 * confirmation is an undo).
 */
export function parseConfirmation(transcript, { casual = true } = {}) {
  let t = cleanTranscript(transcript)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.,!?;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  const phrases = [
    ...[...CONFIRM_PHRASES, ...(casual ? CASUAL_CONFIRM_PHRASES : [])].map((p) => [p, "confirm"]),
    ...CANCEL_PHRASES.map((p) => [p.replace(/[’']/g, ""), "cancel"]),
    ...CONFIRM_FILLERS.map((p) => [p, "filler"]),
  ].sort((a, b) => b[0].length - a[0].length);
  t = t.replace(/[’']/g, "");
  let kind = null;
  while (t) {
    const hit = phrases.find(([p]) => t === p || t.startsWith(p + " "));
    if (!hit) return null;
    if (hit[1] !== "filler") {
      if (kind && kind !== hit[1]) return null;
      kind = hit[1];
    }
    t = t.slice(hit[0].length).trim();
  }
  return kind;
}

/** Home URL of a site, with the per-language override (it.wikipedia.org, amazon.it). */
export function siteHomeUrl(site, lang = "en") {
  const over = SITE_URLS_BY_LANG[lang]?.home;
  if (over && Object.hasOwn(over, site)) return over[site];
  return Object.hasOwn(SITE_HOME, site) ? SITE_HOME[site] : null;
}

/** Search URL template of a site ("%s" = query); the_web is the default engine. */
export function siteSearchTemplate(site, lang = "en") {
  if (site === "the_web") return SITE_SEARCH[DEFAULT_SEARCH_ENGINE];
  const over = SITE_URLS_BY_LANG[lang]?.search;
  if (over && Object.hasOwn(over, site)) return over[site];
  return Object.hasOwn(SITE_SEARCH, site) ? SITE_SEARCH[site] : null;
}
