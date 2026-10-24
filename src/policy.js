/**
 * Execution policy: pure code that turns Jev's answers into ACT / WAIT / IGNORE / CONFIRM /
 * DISAMBIGUATE. Every gate is a number from constants.js so the UI can show WHY.
 */
import {
  T,
  TARGET_INTENTS,
  DEFAULT_SEARCH_ENGINE,
  SILENCE_COMPLETE_MS,
  REPEAT_SILENCE_MS,
  TAB_POSITIONS,
  PAYLOAD_SILENCE_MS,
  PAYLOAD_INTENTS,
  CONTROL_OPTIONS,
  BROWSER_CONTROL_IDS,
  LUCKY_SEARCH,
  UI_TEXT,
  HARMLESS_CONTROLS,
  HARMLESS_IS_COMMAND_FLOOR,
  HARMLESS_INTENT_CONFIDENCE,
  HARMLESS_CONTROL_CONFIDENCE,
} from "./constants.js";
import { toHttpUrl, endsOnContinuationWord, siteHomeUrl, siteSearchTemplate } from "./spans.js";

const r2 = (x) => Math.round(x * 100) / 100;

function check(reasons, name, value, threshold, pass, note) {
  reasons.push({ name, value: typeof value === "number" ? r2(value) : value, threshold, pass, note });
  return pass;
}

/** Top-N choice options by probability, excluding `none`. */
export function topChoices(choiceAnswer, n = 3) {
  if (!choiceAnswer?.probabilities) return [];
  return Object.entries(choiceAnswer.probabilities)
    .filter(([k]) => k !== "none")
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, p]) => ({ id, p: r2(p) }));
}

function pickSpan(answer, minConfidence, fallback) {
  if (!answer) return fallback ?? null;
  if (answer.choice === "none") return null;
  if (answer.confidence < minConfidence) return fallback ?? answer.choice;
  return answer.choice;
}

/** Desktop mode: the installed application Jev picked, or null. */
function pickApp(answers) {
  const a = answers.app;
  return a && a.choice !== "none" && a.confidence >= T.appConfidence ? a.choice : null;
}

function fillTemplate(tpl, q) {
  return tpl.replace("%s", encodeURIComponent(q));
}

/** Look-alike pairs: Jev answers `intent` and `control` independently, a confident control of this kind wins over the intent. */
const GO_BACK_LOOKALIKES = /^(?:zoom_|previous_app$)/;
const CANCEL_LOOKALIKES = new Set(["key_backspace", "clear_all"]);
const ENTER_KEYS = new Set(["return", "enter", "kpenter"]);
/** A bare Enter: the one key press that can submit a form, so it alone is held back when the `destructive` answer is high. */
const isEnterKey = (a) => a.type === "press_enter" || (a.type === "press_key" && ENTER_KEYS.has(a.key) && !a.mods?.length);

const text = (lang) => UI_TEXT[lang] || UI_TEXT.en;
const confirmPrompt = (action, lang) => text(lang).confirm.replace("{action}", describe(action, lang));

/**
 * @param {object} p
 * @param {object} p.answers   Jev answers (intent, target, site, complete, is_command, destructive, scroll_amount, text_span?, url_span?, tab_direction)
 * @param {object} p.candidates {text, url, math?, submit?, newTab?, repeat?} (the new fields may be absent)
 * @param {object} p.snapshot  current page snapshot (elements, searchBoxId, site, url)
 * @param {number} p.silentMs  ms since the transcript last changed
 * @param {boolean} p.isFinal  the speech recognizer marked this utterance final
 * @param {object|null} p.pending  a pending destructive action awaiting "confirm"
 * @param {"it"|"en"} p.lang      UI language of summaries / labels (commands are always bilingual)
 * @returns {{decision: string, action?: object, candidates?: Array, reasons: Array, summary: string,
 *            retryInMs?: number, dangling?: boolean}}
 *   `retryInMs` only accompanies waits that a passing clock can flip (silence gates); every other
 *   wait is resolved by new words or a new snapshot, so the controller must not poll for it.
 */
export function evaluatePolicy({ answers, candidates = {}, snapshot, silentMs = 0, isFinal = false, pending = null, context = null, lang = "en" }) {
  const reasons = [];
  const intent = answers.intent;
  let intentName = intent?.choice ?? "none";
  const math = candidates?.math ?? null;
  const lastAction = context?.recentActions?.length ? context.recentActions[context.recentActions.length - 1] : null;
  const correction = answers.is_correction?.noul ?? 0;
  // A correction only counts once the phrase is finished (or the user has gone quiet): a one-word
  // partial like "go" right after a scroll must not be read as "undo the scroll".
  const finishedPhrase = (answers.complete?.noul ?? 0) >= T.complete || silentMs >= SILENCE_COMPLETE_MS || isFinal;
  const isCorrection = Boolean(lastAction) && correction >= T.correction && finishedPhrase;
  const nothingToUndo = () => ({ decision: "wait", reasons, summary: text(lang).nothingToUndo });

  // 0. Confirm / cancel handling for a pending destructive action. "go back" counts as cancel too:
  // while a confirmation is open, "annulla" / "indietro" means "never mind", not "undo".
  if (pending) {
    if (intentName === "confirm" && intent.confidence >= T.intentConfidence) {
      check(reasons, "intent", `confirm (${r2(intent.confidence)})`, T.intentConfidence, true, "pending action confirmed");
      return { decision: "act", action: { ...pending, confirmed: true }, reasons, summary: `confirmed: ${describe(pending, lang)}` };
    }
    if ((intentName === "cancel" || intentName === "go_back") && intent.confidence >= T.intentConfidence) {
      check(reasons, "intent", `${intentName} (${r2(intent.confidence)})`, T.intentConfidence, true, "pending action cancelled");
      return { decision: "cancel", reasons, summary: "cancelled pending action" };
    }
  }

  // 1. Correction of the previous action ("no, not that one", "wrong link, undo"). A bare "no"
  // is a reaction to the browser, not a fresh imperative, so this runs before the is_command gate.
  // When the user rejects what just happened and names no new target, reverse it; when they do
  // name a new target ("no, the other one") fall through and exclude the previous target below.
  if (isCorrection) {
    check(reasons, "is_correction", correction, T.correction, true, `rejects previous action: ${describe(lastAction, lang)}`);
    const confidentIntent = intentName !== "none" && (intent?.confidence ?? 0) >= T.intentConfidence;
    // "the other one" names a new element; "not that one" alone does not (target comes back `none`
    // or the element just acted on) — the latter is a plain reversal.
    const namesNewTarget =
      TARGET_INTENTS.has(intentName) && topChoices(answers.target, 2).some((c) => c.id !== lastAction.targetId && c.p >= T.targetTopProb);
    // A confident closed-set command ("go back", "scroll down", "open youtube") said after a scroll
    // or click is what it says, not a request to reverse the last action: fall through to normal
    // handling. Only an unconfident / target-less correction is treated as "undo that".
    // "Wrong link, undo that" comes back as the keyboard command "undo" (Cmd+Z) too: after a rejection
    // it means "reverse what you just did" (back, clear, scroll back), not a literal Cmd+Z.
    const saysUndo = intentName === "system_command" && answers.control?.choice === "undo";
    const reverse = lastAction.type !== "go_back" && (!confidentIntent || saysUndo || (TARGET_INTENTS.has(intentName) && !namesNewTarget));
    if (reverse) {
      const reversal = reverseAction(lastAction);
      if (!reversal) return nothingToUndo();
      return { decision: "act", action: reversal, reasons, summary: `correction → ${describe(reversal, lang)}` };
    }
  }

  // 1b. Is the user talking to the computer at all? Skipped for an unmistakable arithmetic request
  // ("fai 7 + 6"): numbers and operators are never background chatter.
  const isCmd = answers.is_command?.noul ?? 0;
  const mathStrong = Boolean(math?.strong);
  // "apri terminale" with a confident application but an intent a hair under the bar: the words start with an open verb and
  // an installed app was picked, so code accepts open_app at a lower intent confidence (opening an app is harmless).
  const openRescue =
    Boolean(candidates?.openVerb) &&
    Boolean(pickApp(answers)) &&
    (intentName === "open_app" || intentName === "navigate_url") &&
    (intent?.confidence ?? 0) >= T.openRescueConfidence;
  const harmless =
    (intentName === "system_command" || intentName === "press_key") &&
    intent.confidence >= HARMLESS_INTENT_CONFIDENCE &&
    HARMLESS_CONTROLS.has(answers.control?.choice) &&
    (answers.control?.confidence ?? 0) >= HARMLESS_CONTROL_CONFIDENCE &&
    isCmd >= HARMLESS_IS_COMMAND_FLOOR;
  const addressed = isCmd >= T.isCommand || mathStrong || harmless || openRescue;
  if (!check(reasons, "is_command", isCmd, T.isCommand, addressed, mathStrong ? "arithmetic request" : openRescue ? "open verb + installed application" : harmless ? "short, harmless control command" : "user is addressing the computer")) {
    return { decision: "ignore", reasons, summary: "not a command" };
  }

  // 2. Is there a confident intent? Code can rescue an arithmetic request Jev has no intent for.
  const conf = intent?.confidence ?? 0;
  let intentOk = intentName !== "none" && conf >= T.intentConfidence;
  check(reasons, "intent", `${intentName} (${r2(conf)})`, T.intentConfidence, intentOk, "confident, non-none intent");
  let rescued = false;
  if (!intentOk && mathStrong) {
    intentName = "calculate";
    intentOk = rescued = true;
    check(reasons, "math_rescue", math.display, "-", true, "arithmetic expression recognised in code");
  }
  if (!intentOk && openRescue) {
    intentName = "open_app";
    intentOk = true;
    check(reasons, "open_rescue", `${pickApp(answers)} (${r2(answers.app.confidence)})`, T.openRescueConfidence, true, "open verb + confident application");
  }
  if (!intentOk) return { decision: "wait", reasons, summary: intentName === "none" ? "no recognizable command yet" : "intent not confident yet" };

  // 2b. Without a pending confirmation: "cancel" is undo, a bare "confirm" has nothing to confirm.
  if (intentName === "cancel") {
    const ctl = answers.control;
    if (snapshot?.desktop && CANCEL_LOOKALIKES.has(ctl?.choice) && (ctl.confidence ?? 0) >= T.controlOverride) {
      // "cancella" / "cancella tutto" say cancel but mean delete.
      intentName = "system_command";
      check(reasons, "control_override", `${ctl.choice} (${r2(ctl.confidence)})`, T.controlOverride, true, "a delete key, not a cancel");
    } else {
      let reversal = lastAction ? reverseAction(lastAction) : null;
      // Nothing recorded can be reversed (a copy, a key, a first command): in a desktop app "annulla" / "undo" is the edit undo.
      if (!reversal && snapshot?.desktop) reversal = controlAction({ id: "undo", opt: CONTROL_OPTIONS.undo }, { answers, candidates, lang });
      if (!reversal) return nothingToUndo();
      return { decision: "act", action: reversal, reasons, summary: `undo → ${describe(reversal, lang)}` };
    }
  }
  if (intentName === "go_back" && snapshot?.desktop) {
    const ctl = answers.control;
    if (GO_BACK_LOOKALIKES.test(ctl?.choice ?? "") && (ctl.confidence ?? 0) >= T.controlOverride) {
      intentName = "system_command";
      check(reasons, "control_override", `${ctl.choice} (${r2(ctl.confidence)})`, T.controlOverride, true, "zoom / previous application, not history back");
    }
  }
  if (intentName === "confirm") return { decision: "wait", reasons, summary: "nothing pending to confirm" };

  // 3. Has the user finished the command? (silence or a final result also counts)
  const complete = answers.complete?.noul ?? 0;
  const silent = silentMs >= SILENCE_COMPLETE_MS || isFinal;
  const completeOk = rescued || complete >= T.complete || silent;
  check(
    reasons,
    "complete",
    complete,
    T.complete,
    completeOk,
    rescued ? "arithmetic is self-contained" : silent ? (isFinal ? "recognizer marked utterance final" : `silent for ${silentMs}ms`) : "command has verb + object",
  );
  if (!completeOk) {
    // "fai 7 più": no amount of silence turns half an expression into a valid one, so no retry either.
    const clockCanFlip = !(intentName === "calculate" && math?.result == null);
    return { decision: "wait", reasons, summary: "waiting for the rest of the command", ...(clockCanFlip && { retryInMs: Math.max(50, SILENCE_COMPLETE_MS - silentMs) }) };
  }

  // 3b. Free-text payloads must be finished before they are copied verbatim.
  if (PAYLOAD_INTENTS.has(intentName)) {
    const payloadOk = isFinal || silentMs >= PAYLOAD_SILENCE_MS;
    check(
      reasons,
      "payload_final",
      isFinal ? "final" : `${silentMs}ms silence`,
      `final or ${PAYLOAD_SILENCE_MS}ms`,
      payloadOk,
      "free text (query / typed text) must be finished before it is copied",
    );
    if (!payloadOk) {
      // Silence only helps when there is a payload to wait for: no text candidate (or no valid expression) means new words must arrive.
      const hasPayload = intentName === "calculate" ? math?.result != null : (candidates?.text?.length ?? 0) > 0;
      return { decision: "wait", reasons, summary: "waiting for the end of the phrase (free text)", ...(hasPayload && { retryInMs: Math.max(50, PAYLOAD_SILENCE_MS - silentMs) }) };
    }
  }

  // 4. Build the concrete action (code owns URLs, keys, templates and text; Jev only picked options).
  // On a correction that names a new target, the previous target is not an option ("the other one").
  const excludeTargetId = isCorrection && TARGET_INTENTS.has(intentName) ? lastAction.targetId ?? null : null;
  const built = buildAction({ intentName, answers, candidates, snapshot, reasons, excludeTargetId, lang, silentMs, isFinal });
  if (built.decision !== "act") return { ...built, reasons };
  const action = built.action;

  // 5. Quitting an application (and wiping a document) always needs a spoken confirmation (unless it came back through
  // the pending flow, which re-enters with `confirmed`).
  if ((action.type === "quit_app" || action.needsConfirm) && !action.confirmed) {
    check(reasons, "destructive", action.type === "quit_app" ? "quit" : "delete", "-", false, "needs spoken confirmation");
    return { decision: "confirm", action, reasons, summary: confirmPrompt(action, lang) };
  }

  // 6. Destructive? Only side-effecting element actions can be. A bare Enter is held to the same bar in every language and
  // whichever intent carried it (press_enter or press_key), but at a higher one: "premi invio" in a plain document scores
  // ~0.5-0.7 on `destructive` while a checkout page scores higher. Dictation + "e invia" is not gated: sending IS the request.
  const destructive = answers.destructive?.noul ?? 0;
  const enter = isEnterKey(action);
  const canBeDestructive = enter || ["click_element", "select_option"].includes(action.type);
  if (canBeDestructive) {
    const bar = enter ? T.destructiveKey : T.destructive;
    const safe = destructive < bar;
    check(reasons, "destructive", destructive, bar, safe, safe ? "reversible action" : "needs spoken confirmation");
    if (!safe) {
      return { decision: "confirm", action, reasons, summary: confirmPrompt(action, lang) };
    }
  }

  return { decision: "act", action, reasons, summary: describe(action, lang) };
}

/**
 * The action that undoes `action` as far as a computer can; `null` when nothing sensible exists
 * (a copy, a volume key... — callers then answer "nothing to undo" instead of guessing).
 */
export function reverseAction(action) {
  switch (action?.type) {
    case "type_into_field":
      return { type: "type_into_field", targetId: action.targetId, text: "", submit: false, label: action.targetLabel || action.label || "" };
    case "clear_field":
      return { type: "shortcut", id: "undo", char: "z", label: "undo" };
    case "open_app":
      return { type: "switch_app_back", label: "back to the previous application" };
    case "open_new_tab":
      return { type: "close_tab", label: "close the new tab" };
    case "navigate_url":
      return action.newTab ? { type: "close_tab", label: "close the new tab" } : { type: "go_back", label: `undo ${describe(action)}` };
    case "close_tab":
      return { type: "go_back", label: "back (tab already closed)" };
    case "switch_tab":
      if (action.direction !== "previous" && action.direction !== "next") return null; // "the third tab": no way back to where we were
      return { type: "switch_tab", direction: action.direction === "previous" ? "next" : "previous", label: "switch back" };
    case "switch_app_back":
      return { type: "switch_app_back", label: "back to the previous application" };
    case "scroll_down":
      return { type: "scroll_up", amount: action.amount || "page", label: "scroll back up" };
    case "scroll_up":
      return { type: "scroll_down", amount: action.amount || "page", label: "scroll back down" };
    case "shortcut":
      if (action.id === "paste" || action.id === "cut") return { type: "shortcut", id: "undo", char: "z", label: "undo" };
      if (action.id === "undo") return { type: "shortcut", id: "redo", char: "z", shift: true, label: "redo" };
      if (action.id === "redo") return { type: "shortcut", id: "undo", char: "z", label: "undo" };
      return null;
    case "volume": {
      const inverse = { up: "down", down: "up", mute: "unmute", unmute: "mute" }[action.op];
      return inverse ? { type: "volume", op: inverse, label: `volume ${inverse}` } : null;
    }
    case "window_op":
    case "quit_app":
    case "send_keys":
    case "calculate":
    case "set_language":
    case "press_key":
      return null;
    default:
      return { type: "go_back", label: `undo ${describe(action)}` };
  }
}

/** The control option Jev picked for press_key / system_command, if it clears the bar and is allowed here. */
function pickControl(answers, snapshot, reasons) {
  const ctl = answers.control;
  const id = ctl?.choice;
  const known = id && id !== "none" && CONTROL_OPTIONS[id];
  const allowed = known && (snapshot?.desktop || BROWSER_CONTROL_IDS.includes(id));
  const ok = Boolean(allowed) && (ctl.confidence ?? 0) >= T.controlConfidence;
  check(reasons, "control", `${id ?? "none"} (${r2(ctl?.confidence ?? 0)})`, T.controlConfidence, ok, allowed || !known ? "key or standard command" : "not available in the browser window");
  return ok ? { id, opt: CONTROL_OPTIONS[id] } : null;
}

/** A CONTROL_OPTIONS entry -> the executor action its `kind` stands for. */
function controlAction({ id, opt }, { answers, candidates, lang }) {
  const label = opt.label?.[lang] ?? opt.label?.en ?? id;
  switch (opt.kind) {
    case "key":
      return { type: "press_key", key: opt.key, mods: [...(opt.mods || [])], count: Math.max(1, candidates?.repeat || 1), label };
    case "shortcut": {
      const { char, shift, alt, ctrl, fallback } = opt;
      return { type: "shortcut", id, char, ...(shift && { shift: true }), ...(alt && { alt: true }), ...(ctrl && { ctrl: true }), ...(fallback && { fallback }), label };
    }
    case "window": {
      // "chiudi la calcolatrice": a confidently named app is brought forward first; a weak guess must not redirect the close.
      const app = (answers.app?.confidence ?? 0) >= T.windowAppConfidence ? pickApp(answers) : null;
      return { type: "window_op", op: opt.op, label, ...(app && { app }) };
    }
    case "calculator":
      return { type: "calculate", keys: [], label };
    case "field":
      return { type: "clear_field", label };
    case "volume":
      return { type: "volume", op: opt.op, label };
    case "quit":
      return { type: "quit_app", app: pickApp(answers), label };
    case "keys":
      return { type: "send_keys", keys: [...opt.keys], label, ...(opt.confirm && { needsConfirm: true }) };
    case "app_back":
      return { type: "switch_app_back", label };
    case "language":
      return { type: "set_language", locale: opt.locale, label };
    default:
      return null;
  }
}

function buildAction({ intentName, answers, candidates, snapshot, reasons, excludeTargetId = null, lang = "en", silentMs = 0, isFinal = false }) {
  const site = answers.site?.choice ?? "none";
  const elements = snapshot?.elements ?? [];
  const newTab = Boolean(candidates?.newTab);
  const submit = Boolean(candidates?.submit);

  // "open X" is an application or a website depending on what X is, and Jev answers `intent`,
  // `app` and `site` independently — so each of the two intents falls back to the other's object.
  const app = pickApp(answers);
  const openApp = () => {
    check(reasons, "app", `${app} (${r2(answers.app.confidence)})`, T.appConfidence, true, "installed application");
    return { decision: "act", action: { type: "open_app", app, label: app } };
  };
  const dangling = (t) => {
    if (!endsOnContinuationWord(t)) return null;
    check(reasons, "dangling", t, "no trailing connector", false, "text ends with a connector word: the rest is still coming");
    return { decision: "wait", dangling: true, summary: "phrase ends with a connector word - waiting for the rest" };
  };
  /** URL for "go to / open <destination>": a spoken domain, a known site, or a lucky search. */
  const destination = (allowLucky) => {
    const urlPick = pickSpan(answers.url_span, T.spanConfidence, candidates.url?.[0]);
    if (urlPick) {
      check(reasons, "url_span", urlPick, T.spanConfidence, true, "domain spoken verbatim");
      return { type: "navigate_url", url: toHttpUrl(urlPick), label: urlPick, newTab };
    }
    const home = siteHomeUrl(site, lang);
    if (home) {
      check(reasons, "site", `${site} (${r2(answers.site.confidence)})`, "-", true, "known site");
      return { type: "navigate_url", url: home, label: site, newTab };
    }
    if (allowLucky && site === "other_named_site" && !app) {
      const named = pickSpan(answers.text_span, T.spanConfidence, candidates.text?.[0]);
      if (named && !endsOnContinuationWord(named)) {
        check(reasons, "site", "other_named_site", "-", true, "unknown site name -> I'm-feeling-lucky search");
        return { type: "navigate_url", url: fillTemplate(LUCKY_SEARCH, named), label: named, query: named, newTab };
      }
    }
    return null;
  };

  switch (intentName) {
    case "open_app":
    case "navigate_url":
    case "open_new_tab": {
      if (intentName === "open_app" && app) return openApp();
      const dest = destination(intentName !== "open_app");
      if (dest) return { decision: "act", action: intentName === "open_new_tab" ? { ...dest, newTab: true } : dest };
      if (intentName === "open_new_tab") return { decision: "act", action: { type: "open_new_tab", label: "open new tab" } };
      if (app) return openApp();
      if (intentName === "open_app") {
        check(reasons, "app", answers.app?.choice ?? "none", T.appConfidence, false, "no application recognised yet");
        return { decision: "wait", summary: "open what? (no application or site recognised)" };
      }
      check(reasons, "site", site, "known site or spoken domain", false, "no destination yet");
      return { decision: "wait", summary: "where to? (no site or domain recognised)" };
    }

    case "search_web": {
      const query = pickSpan(answers.text_span, T.spanConfidence, candidates.text?.[0]);
      if (!query) {
        // Jev rightly says "no text" for "cerca un video di": tell an unfinished phrase from a missing one.
        const cut = candidates.text?.length > 0 && candidates.text.every((t) => endsOnContinuationWord(t));
        check(reasons, "text_span", "none", T.spanConfidence, false, cut ? "phrase is unfinished" : "no query text yet");
        // "cerca su youtube" with nothing to look for: just go to the site (unless already there).
        const home = !cut && site !== "the_web" && site !== snapshot?.site ? siteHomeUrl(site, lang) : null;
        if (home) return { decision: "act", action: { type: "navigate_url", url: home, label: site, newTab } };
        return cut ? { decision: "wait", dangling: true, summary: "phrase ends with a connector word - waiting for the rest" } : { decision: "wait", summary: "search for what?" };
      }
      const hanging = dangling(query);
      if (hanging) return hanging;
      check(reasons, "text_span", query, T.spanConfidence, true, "query copied verbatim");
      const template = siteSearchTemplate(site, lang);
      // A named site other than the current one is searched by URL in the same tab; on that site (or with none named) the
      // page's own search field is used; the URL template is the fallback. A site with no search template of its own
      // (facebook, instagram, gmail) is still a named site: it gets a `site:` search, never the current page's box.
      const knownSite = site !== "the_web" && site !== "none" && site !== "other_named_site" && Boolean(template || siteHomeUrl(site, lang));
      const named = knownSite ? site : null;
      const onSite = Boolean(named) && named === snapshot?.site;
      // "in una nuova scheda" can only be honoured by a URL, never by typing into the page that is open.
      const pageBox = snapshot?.searchBoxId && snapshot.site !== "blank" && site !== "the_web" && !newTab;
      // "search youtube" while on another page: the user means the site itself, not a search for its name.
      const squash = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
      if (named && !onSite && squash(query) === squash(named) && siteHomeUrl(site, lang)) {
        return { decision: "act", action: { type: "navigate_url", url: siteHomeUrl(site, lang), label: site, newTab } };
      }
      const viaUrl = (tpl, label) => ({ decision: "act", action: { type: "navigate_url", url: fillTemplate(tpl, query), label, query, newTab } });
      const viaSite = () => {
        if (template) return viaUrl(template, `${site}: ${query}`);
        const host = new URL(siteHomeUrl(site, lang)).hostname.replace(/^www\./, "");
        return { decision: "act", action: { type: "navigate_url", url: fillTemplate(siteSearchTemplate(DEFAULT_SEARCH_ENGINE, lang), `${query} site:${host}`), label: `${site}: ${query}`, query, newTab } };
      };
      if (named && !onSite) return viaSite();
      if (pageBox) {
        return { decision: "act", action: { type: "type_into_field", targetId: snapshot.searchBoxId, text: query, submit: true, label: "search box" } };
      }
      if (named) return viaSite();
      if (site === "other_named_site" && !app) return viaUrl(LUCKY_SEARCH, query);
      return viaUrl(siteSearchTemplate(DEFAULT_SEARCH_ENGINE, lang), `search: ${query}`);
    }

    case "click_element":
    case "select_option":
    case "type_into_field": {
      const target = answers.target;
      let top = topChoices(target, T.candidateCount + 1);
      let chosen = target?.choice;
      let chosenP = target?.probabilities?.[chosen] ?? 0;
      if (excludeTargetId && chosen === excludeTargetId) {
        // "no, the other one": the element just acted on is ruled out; take the runner-up.
        top = top.filter((c) => c.id !== excludeTargetId);
        chosen = top[0]?.id ?? "none";
        chosenP = top[0]?.p ?? 0;
        check(reasons, "exclude_target", excludeTargetId, "-", true, `previous target excluded → ${chosen}`);
      }
      top = top.slice(0, T.candidateCount);
      const targetOk =
        chosen && chosen !== "none" && target.confidence >= T.targetConfidence && chosenP >= T.targetTopProb;
      const typed = intentName === "click_element" ? null : pickSpan(answers.text_span, T.spanConfidence, candidates.text?.[0]);

      if (intentName !== "click_element" && !typed) {
        check(reasons, "text_span", "none", T.spanConfidence, false, "no text to type yet");
        return { decision: "wait", summary: "type what?" };
      }
      if (typed) {
        const hanging = dangling(typed);
        if (hanging) return hanging;
      }

      if (targetOk) {
        check(reasons, "target", `${chosen} (${r2(target.confidence)})`, T.targetConfidence, true, elementLabel(elements, chosen));
        const act = { type: intentName, targetId: chosen, text: typed, label: elementLabel(elements, chosen) };
        if (intentName === "type_into_field") act.submit = submit;
        return { decision: "act", action: act };
      }

      // Desktop mode, no field named ("type hello world"): type wherever the keyboard focus is. A near tie between `none` and
      // the only field on screen counts as "no field named" too: guessing a field means clicking it, the focus is already right.
      const nonePlausible = (target?.probabilities?.none ?? 0) >= T.noTargetProb;
      if (intentName === "type_into_field" && snapshot?.desktop && ((chosen ?? "none") === "none" || nonePlausible)) {
        check(reasons, "target", "none", T.targetConfidence, true, "no field named → keyboard focus");
        return { decision: "act", action: { type: intentName, targetId: null, text: typed, submit, label: "the focused field" } };
      }

      // Typing with no confident target: fall back to the page's search box.
      if (intentName === "type_into_field" && snapshot?.searchBoxId) {
        check(reasons, "target", `${chosen} (${r2(target?.confidence ?? 0)})`, T.targetConfidence, false, "falling back to search box");
        return { decision: "act", action: { type: intentName, targetId: snapshot.searchBoxId, text: typed, submit, label: "search box" } };
      }

      check(reasons, "target", `${chosen ?? "none"} (${r2(target?.confidence ?? 0)})`, T.targetConfidence, false, "ambiguous target");
      // Show the plausible candidates (at least two when anything is plausible at all).
      let viable = top.filter((c) => c.p >= 0.08);
      if (viable.length === 1) viable = top.filter((c) => c.p >= 0.02).slice(0, 2);
      if (viable.length === 0) return { decision: "wait", summary: "no matching element on this page" };
      return {
        decision: "disambiguate",
        candidates: viable.map((c) => ({ ...c, label: elementLabel(elements, c.id) })),
        pendingIntent: { type: intentName, text: typed, ...(intentName === "type_into_field" ? { submit } : {}) },
        summary: `which one? ${viable.map((c, i) => `${i + 1}: ${elementLabel(elements, c.id)}`).join(" | ")}`,
      };
    }

    case "press_key":
    case "system_command": {
      const picked = pickControl(answers, snapshot, reasons);
      if (!picked) return { decision: "wait", summary: "which key / command?" };
      const action = controlAction(picked, { answers, candidates, lang });
      if (!action) return { decision: "wait", summary: "which key / command?" };
      // "premi tab" may be the first half of "premi tab tre volte": a key press with no count in the words waits for a short
      // silence (or the final result) before acting, otherwise the count is lost and the key is pressed once.
      if (action.type === "press_key" && (candidates?.repeat ?? 1) <= 1) {
        const settled = isFinal || silentMs >= REPEAT_SILENCE_MS;
        check(reasons, "repeat_window", isFinal ? "final" : `${silentMs}ms silence`, `final or ${REPEAT_SILENCE_MS}ms`, settled, "a repeat count (\"tre volte\") may still follow");
        if (!settled) return { decision: "wait", summary: "waiting for a possible repeat count", retryInMs: Math.max(50, REPEAT_SILENCE_MS - silentMs) };
      }
      return { decision: "act", action };
    }

    case "calculate": {
      const m = candidates?.math;
      if (!m) return { decision: "wait", summary: "calculate what?" };
      if (m.result == null) {
        check(reasons, "math", m.display, "valid expression", false, "invalid or division by zero");
        return { decision: "wait", summary: `cannot compute ${m.display}` };
      }
      check(reasons, "math", `${m.display} = ${m.resultText}`, "-", true, "computed by the safe parser in code");
      return {
        decision: "act",
        action: { type: "calculate", expr: m.expr, display: m.display, result: m.result, resultText: m.resultText, keys: m.keys, label: `${m.display} = ${m.resultText}` },
      };
    }

    case "scroll_down":
    case "scroll_up": {
      const lvl = Math.round(answers.scroll_amount?.score ?? 1);
      const amount = ["little", "page", "end"][Math.min(2, Math.max(0, lvl))];
      check(reasons, "scroll_amount", answers.scroll_amount?.score ?? 1, "round", true, amount);
      return { decision: "act", action: { type: intentName, amount, label: `${intentName.replace("_", " ")} (${amount})` } };
    }

    case "switch_tab": {
      const dir = answers.tab_direction?.choice;
      // `none` (or no answer at all) is "not about tabs": no silent guess of "next".
      if (!dir || dir === "none") return { decision: "wait", summary: "which tab?" };
      const position = TAB_POSITIONS[dir];
      return { decision: "act", action: { type: "switch_tab", direction: dir, ...(position && { position }), label: `switch tab (${dir})` } };
    }

    case "confirm":
    case "cancel":
      return { decision: "wait", summary: `nothing pending to ${intentName}` };

    default:
      return { decision: "act", action: { type: intentName, label: intentName.replace(/_/g, " ") } };
  }
}

export function elementLabel(elements, id) {
  const el = elements.find((e) => e.id === id);
  return el ? `${el.role} "${el.text || el.placeholder || ""}"` : id;
}

/** Human-readable action in the UI language: the UI_TEXT template for its type, `{k}` filled from the action. */
export function describe(action, lang = "en") {
  if (!action) return "";
  const acts = UI_TEXT[lang]?.actions;
  const typing = action.type === "type_into_field";
  const tpl = (typing && action.text === "" && acts?.type_into_field_clear) || (typing && action.submit && acts?.type_into_field_submit) || acts?.[action.type];
  const fallback = action.label || action.type.replace(/_/g, " ");
  if (!tpl) return fallback;
  const vars = {
    label: action.label || action.targetId || action.url || "",
    app: action.app || (action.type === "quit_app" ? (lang === "it" ? "l'app in primo piano" : "the frontmost app") : ""),
    text: action.text ?? "",
    url: action.url || "",
    key: action.type === "press_key" ? [...(action.mods || []), action.key].join("+") : action.key || "",
    count: action.count ?? 1,
  };
  let out = tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
  if (action.type === "press_key" && action.count > 1) out += ` ×${action.count}`;
  return out || fallback;
}

export { TARGET_INTENTS };
