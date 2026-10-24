/**
 * ONE reviewable place for everything Jev sees and every threshold the policy uses.
 *
 * Jev (TypeSafe "System One") does not generate text. Each request carries the
 * current `state` (transcript + page snapshot) and a fan-out of typed questions
 * that are answered independently and in parallel. Code owns control flow.
 *
 * Rules applied here (from docs.typesafe.ai):
 *  - question ids are NOT sent to the model, so every `instructions` is a complete question
 *  - reference state with backticked paths (`transcript`, `page.site`, `elements`)
 *  - Choice options use the same contrastive shape {what, not_for, examples}
 *  - always include a `none` option; never ask Jev to count or generate
 */

// Alias for the newest Jev release. The thresholds below were tuned on jev-1.13.0 — re-check `T`
// when the alias moves to a new release.
export const MODEL = "jev-latest";

export const PRICE_PER_M_INPUT_TOKENS_USD = 0.042; // output tokens are free

// ---------------------------------------------------------------------------
// Perception limits (state size hurts accuracy + latency; keep it small)
// ---------------------------------------------------------------------------
export const MAX_ELEMENTS = 100; // hard cap on elements sent to Jev (255 is the Choice limit; latency grows with tokens)
export const MAX_ELEMENT_TEXT = 60; // chars per element label
export const MAX_STATE_CHARS = 24_000; // ~6k tokens; far below the 32k-token state limit
export const MAX_TRANSCRIPT_CHARS = 400;
// Conversation context sent with every request: the page before the last navigation and the
// last few executed actions (what was said, what was done, what happened). Lets Jev resolve
// "go back to the results", "the other one", "no, not that one", "open the documentation" (of the
// thing I just opened). Small on purpose — irrelevant state costs accuracy.
export const MAX_CONTEXT_ACTIONS = 3;

// ---------------------------------------------------------------------------
// Desktop mode (whole Mac instead of one browser window, see desktop.js)
// ---------------------------------------------------------------------------
export const HOTKEY = "ctrl+alt+w"; // global shortcut that switches the microphone on / off
export const MAX_APPS = 200; // installed applications offered to Jev as the `app` Choice (limit is 255)

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
export const DEBOUNCE_MS = 150; // wait this long after the last transcript update before asking Jev
export const MAX_INFLIGHT = 2; // overlapping Jev requests allowed; older ones are cancelled with AbortSignal
export const SILENCE_COMPLETE_MS = 700; // no new words for this long => treat command as complete
// Intents that carry free text (a query or text to type) cannot be acted on mid-sentence — "search
// for alan" is a complete-sounding command but the payload may still be growing. They wait for the
// recognizer's final result or this much silence.
export const PAYLOAD_SILENCE_MS = 600;
export const PAYLOAD_INTENTS = new Set(["search_web", "type_into_field", "select_option", "calculate"]);
export const HIGHLIGHT_MS = 600; // element flash on the controlled page
export const CANDIDATE_TTL_MS = 8000; // numbered overlays stay this long
export const PENDING_TTL_MS = 9000; // a spoken "confirm" only counts this long after the prompt (the toast is shown for 6 s)
// A key press with no repeat count in the words ("premi tab") waits this long for a possible "tre volte" before it acts;
// a request that finishes while the user is still talking never acts on the first half of "premi tab tre volte".
export const REPEAT_SILENCE_MS = 350;

// ---------------------------------------------------------------------------
// Execution policy thresholds (the "why did it act / wait" numbers shown in the UI)
// ---------------------------------------------------------------------------
export const T = {
  intentConfidence: 0.55, // `intent` Choice confidence needed to act at all
  complete: 0.6, // `complete` Noul: user has finished the command (bypassed after SILENCE_COMPLETE_MS)
  isCommand: 0.5, // `is_command` Noul: user is addressing the browser at all
  destructive: 0.5, // `destructive` Noul above this => needs confirmation ...
  destructiveKey: 0.8, // ... but a bare Enter key press (spoken the same way in both languages) is only held back above this
  destructiveIntentConfidence: 0.9, // ... unless intent confidence is this high AND the user already said "confirm"
  targetConfidence: 0.45, // `target` Choice below this => show numbered candidate overlays instead of clicking
  targetTopProb: 0.35, // and the winning element must have at least this probability
  noTargetProb: 0.3, // desktop dictation: `none` this likely (and no confident field) means "no field named" -> type at the keyboard focus
  spanConfidence: 0.35, // `text_span` / `url_span` picks below this fall back to the heuristic candidate
  appConfidence: 0.45, // `app` Choice (desktop mode) needed to open an application
  windowAppConfidence: 0.8, // ...and to aim a window command at a named app ("chiudi la calcolatrice"): a weak guess must not redirect it
  openRescueConfidence: 0.4, // "apri <app>" with a confident app: `open_app` / `navigate_url` intent needed (instead of intentConfidence)
  candidateCount: 3, // how many candidates to overlay when target is ambiguous
  controlConfidence: 0.5, // `control` Choice (key / shortcut / window / volume / language) needed to act
  controlOverride: 0.9, // a `control` this confident outranks a look-alike intent ("zoom indietro" is zoom_out, not go_back; "cancella" is a delete key, not cancel)
  correction: 0.6, // `is_correction` Noul: user is undoing / redirecting the previous action ("no, not that one")
};

/**
 * Controls that are harmless to run on a false alarm (copying, volume, switching language). Jev's
 * `is_command` is often low for short imperatives ("copy that" ~0.4), so these get a lower floor when
 * the intent and the control are both confident.
 */
export const HARMLESS_CONTROLS = new Set(["copy", "select_all", "find", "volume_up", "volume_down", "volume_mute", "volume_unmute", "language_it", "language_en"]);
export const HARMLESS_IS_COMMAND_FLOOR = 0.3;
export const HARMLESS_INTENT_CONFIDENCE = 0.8;
export const HARMLESS_CONTROL_CONFIDENCE = 0.6;

export const TARGET_INTENTS = new Set(["click_element", "type_into_field", "select_option"]);

// `tab_direction` answers that name a position instead of a direction: Cmd+<n> (Cmd+9 is always the LAST tab).
export const TAB_POSITIONS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, last: 9 };
// The `tab_direction` question is only worth its tokens when the words are about tabs at all.
export const TAB_WORDS_RE = /\b(?:tab|tabs|scheda|schede|linguetta|linguette)\b/i;


// ---------------------------------------------------------------------------
// Language, speed and desktop executor numbers (shared with the native helper via its `config` command)
// ---------------------------------------------------------------------------
// Commands, criteria and text spans are ALWAYS bilingual (Italian + English, mixable in one session).
// The locale only selects the speech recognizer (and the it/en URL variants and the toast language).
export const DEFAULT_LOCALE = "en-US"; // last resort when neither --lang, VB_LANG nor the system locale is known

// Smart end of utterance (native/helper.swift SpeechInput): after every new partial text the helper waits
// SILENCE_SHORT_MS when the phrase looks finished and SILENCE_LONG_MS when it ends with a word that expects
// a continuation. The lists below are sent at launch (`config`), so this file is the runtime source of truth.
export const SILENCE_SHORT_MS = 650;
export const SILENCE_LONG_MS = 1700;

const words = (s) => new Set(s.trim().split(/\s+/));
// "copy that", "undo this", "no non quello" are finished commands: demonstratives are deliberately NOT continuation words, and
// "di più" / "un po'" (see spans.endsOnContinuationWord and the helper) end a phrase too. Operators (più, plus, per...) still wait.
export const CONTINUATION_WORDS = words(`
  di a da in con su per tra fra il lo la i gli le un uno una del dello della dei degli delle al allo alla ai agli alle
  dal dallo dalla dai dagli dalle nel nello nella nei negli nelle sul sullo sulla sui sugli sulle e o ma che come se
  più meno diviso fratto moltiplicato mio mia miei mie tuo tua suo sua quel quanto
  the a an of to for in on with and or at from into by about as than plus minus times divided multiplied over
  my your his her their our these those what
  + - * / × ÷
`);

// A lone verb ("cerca", "open") is never a finished command: wait for the object.
export const VERB_ONLY_WORDS = words(`
  apri cerca vai scrivi digita clicca premi seleziona scegli fai calcola trova avvia lancia passa metti imposta chiudi esci
  open search go type write click press select choose calculate find launch start switch set look enter fill visit take
  close quit show google
`);

// Answer cache (controller): identical (transcript, snapshot, pending, history) is not asked to Jev twice.
export const ANSWER_CACHE_TTL_MS = 15_000;
export const ANSWER_CACHE_MAX = 16;
export const UNCLEAR_TOAST_MS = 1600; // "didn't get that" toast after a final utterance that was not understood
export const MAX_REPEAT = 20; // "press tab 30 times" is clamped to this
export const VOLUME_STEP = 10; // percent per "volume up / down"

// A browser in front (desktop mode) => navigate in the CURRENT tab through its address bar. Prefix match on bundle id
// (must stay identical to the list in native/helper.swift).
export const BROWSER_BUNDLE_PREFIXES = [
  "com.google.Chrome",
  "org.chromium.Chromium",
  "com.apple.Safari",
  "company.thebrowser.Browser", // Arc
  "com.microsoft.edgemac",
  "com.brave.Browser",
  "org.mozilla.firefox",
  "com.operasoftware.Opera",
  "com.vivaldi.Vivaldi",
];
export const BROWSER_APP_NAMES = ["google chrome", "chrome", "safari", "arc", "microsoft edge", "brave browser", "firefox", "opera", "vivaldi", "chromium"];
export const CALCULATOR_APP_NAMES = ["Calculator", "Calcolatrice"];

// Desktop executor condition waits (ms): poll the probe until the frontmost app / title / url changes, with a cap.
export const DESKTOP_WAIT = {
  pollMs: 80, // probe interval
  settleMs: 100, // extra wait after a change was seen (page still painting)
  navigateMs: 2000, // address-bar navigation / `open`: a changed title or url usually shows within a few hundred ms
  sameUrlMs: 300, // navigating to the page that is already open / reloading: nothing will change, do not wait for it
  historyMs: 1200, // back / forward
  submitMs: 2500, // typing + enter
  appMs: 3000, // application launch
  clickMs: 450,
  keyMs: 250, // keys that may navigate (Enter) and window buttons; plain keys and shortcuts do not wait at all
  tabMs: 800,
  scrollMs: 120,
  calcSettleMs: 250, // Calculator is frontmost but not yet ready for keystrokes
  fallbackMs: 400, // probe unavailable: fixed short sleep
};

// "\name" is DuckDuckGo's I'm-feeling-lucky: lands on the best match for a site named only by its name.
export const LUCKY_SEARCH = "https://duckduckgo.com/?q=%5C%s";

// Words the recognizer should expect (macOS contextualStrings, <=40 here; desktop.js appends installed app names).
export const RECOGNITION_HINTS = [
  "YouTube", "Wikipedia", "GitHub", "Google", "DuckDuckGo", "Amazon", "Reddit", "Hacker News", "Gmail", "LinkedIn",
  "Netflix", "Spotify", "Stack Overflow", "Google Maps", "Calcolatrice", "Calculator", "Safari", "Chrome", "Finder",
  "Impostazioni di Sistema", "System Settings", "Terminale", "Instagram", "Facebook", "WhatsApp", "Slack", "Zoom",
  "Notion", "ChatGPT", "email", "online", "social", "download", "browser", "desktop", "scrivania", "scheda", "tab",
];

// ---------------------------------------------------------------------------
// Sites (code owns URLs; Jev only picks the name)
// ---------------------------------------------------------------------------
export const SITE_HOME = {
  google: "https://www.google.com/",
  duckduckgo: "https://duckduckgo.com/",
  youtube: "https://www.youtube.com/",
  wikipedia: "https://en.wikipedia.org/wiki/Main_Page",
  github: "https://github.com/",
  amazon: "https://www.amazon.com/",
  reddit: "https://www.reddit.com/",
  twitter_x: "https://x.com/",
  hacker_news: "https://news.ycombinator.com/",
  example_com: "https://example.com/",
  google_maps: "https://www.google.com/maps",
  gmail: "https://mail.google.com/",
  linkedin: "https://www.linkedin.com/",
  netflix: "https://www.netflix.com/",
  spotify: "https://open.spotify.com/",
  stackoverflow: "https://stackoverflow.com/",
  facebook: "https://www.facebook.com/",
  instagram: "https://www.instagram.com/",
};

// Search URL templates; `%s` is replaced with the URL-encoded query.
export const SITE_SEARCH = {
  google: "https://www.google.com/search?q=%s",
  duckduckgo: "https://duckduckgo.com/?q=%s",
  the_web: "https://duckduckgo.com/?q=%s",
  youtube: "https://www.youtube.com/results?search_query=%s",
  wikipedia: "https://en.wikipedia.org/w/index.php?search=%s",
  github: "https://github.com/search?q=%s&type=repositories",
  amazon: "https://www.amazon.com/s?k=%s",
  reddit: "https://www.reddit.com/search/?q=%s",
  twitter_x: "https://x.com/search?q=%s",
  hacker_news: "https://hn.algolia.com/?q=%s",
  google_maps: "https://www.google.com/maps/search/%s",
  linkedin: "https://www.linkedin.com/search/results/all/?keywords=%s",
  netflix: "https://www.netflix.com/search?q=%s",
  spotify: "https://open.spotify.com/search/%s",
  stackoverflow: "https://stackoverflow.com/search?q=%s",
};

// Language variants of a few sites; applied on top of SITE_HOME / SITE_SEARCH (spans.js siteHomeUrl / siteSearchTemplate).
export const SITE_URLS_BY_LANG = {
  it: {
    home: { wikipedia: "https://it.wikipedia.org/wiki/Pagina_principale", amazon: "https://www.amazon.it/" },
    search: { wikipedia: "https://it.wikipedia.org/w/index.php?search=%s", amazon: "https://www.amazon.it/s?k=%s" },
  },
};

export const DEFAULT_SEARCH_ENGINE = "duckduckgo";

// ---------------------------------------------------------------------------
// Controls: a CLOSED set of keys / shortcuts / commands. Jev picks the id (`control` Choice), code owns the keys.
// Key names are the native helper's (src contract: return escape tab space delete forwarddelete left right up down
// home end pageup pagedown, a-z, 0-9, punctuation, kp0..kp9 kpdecimal kpmultiply kpplus kpminus kpdivide kpenter ...).
// ---------------------------------------------------------------------------
export const CONTROL_OPTIONS = {
  // kind "key": press_key action
  key_enter: { kind: "key", key: "return", label: { en: "Enter", it: "Invio" } },
  key_escape: { kind: "key", key: "escape", label: { en: "Escape", it: "Esc" } },
  key_tab: { kind: "key", key: "tab", label: { en: "Tab", it: "Tab" } },
  key_shift_tab: { kind: "key", key: "tab", mods: ["shift"], label: { en: "Shift+Tab", it: "Maiusc+Tab" } },
  key_space: { kind: "key", key: "space", label: { en: "Space", it: "Spazio" } },
  key_backspace: { kind: "key", key: "delete", label: { en: "Backspace", it: "Backspace" } },
  key_up: { kind: "key", key: "up", label: { en: "Arrow up", it: "Freccia su" } },
  key_down: { kind: "key", key: "down", label: { en: "Arrow down", it: "Freccia giù" } },
  key_left: { kind: "key", key: "left", label: { en: "Arrow left", it: "Freccia sinistra" } },
  key_right: { kind: "key", key: "right", label: { en: "Arrow right", it: "Freccia destra" } },
  key_home: { kind: "key", key: "home", label: { en: "Home", it: "Inizio" } },
  key_end: { kind: "key", key: "end", label: { en: "End", it: "Fine" } },
  key_page_up: { kind: "key", key: "pageup", label: { en: "Page up", it: "Pagina su" } },
  key_page_down: { kind: "key", key: "pagedown", label: { en: "Page down", it: "Pagina giù" } },
  // kind "shortcut": Cmd+<char> via the helper `shortcut` command (layout independent)
  copy: { kind: "shortcut", char: "c", label: { en: "Copy", it: "Copia" } },
  cut: { kind: "shortcut", char: "x", label: { en: "Cut", it: "Taglia" } },
  paste: { kind: "shortcut", char: "v", label: { en: "Paste", it: "Incolla" } },
  select_all: { kind: "shortcut", char: "a", label: { en: "Select all", it: "Seleziona tutto" } },
  undo: { kind: "shortcut", char: "z", label: { en: "Undo", it: "Annulla" } },
  redo: { kind: "shortcut", char: "z", shift: true, label: { en: "Redo", it: "Ripeti" } },
  save: { kind: "shortcut", char: "s", label: { en: "Save", it: "Salva" } },
  find: { kind: "shortcut", char: "f", label: { en: "Find", it: "Trova" } },
  new_window: { kind: "shortcut", char: "n", label: { en: "New window", it: "Nuova finestra" } },
  print: { kind: "shortcut", char: "p", label: { en: "Print", it: "Stampa" } },
  zoom_in: { kind: "shortcut", char: "+", fallback: "=", label: { en: "Zoom in", it: "Ingrandisci" } },
  zoom_out: { kind: "shortcut", char: "-", fallback: "-", label: { en: "Zoom out", it: "Riduci" } },
  zoom_reset: { kind: "shortcut", char: "0", label: { en: "Actual size", it: "Dimensione reale" } },
  // kind "window": accessibility button of the focused window
  close_window: { kind: "window", op: "close", label: { en: "Close window", it: "Chiudi finestra" } },
  minimize_window: { kind: "window", op: "minimize", label: { en: "Minimize window", it: "Riduci a icona" } },
  fullscreen: { kind: "window", op: "fullscreen", label: { en: "Full screen", it: "Schermo intero" } },
  maximize_window: { kind: "window", op: "zoom", label: { en: "Zoom window", it: "Ingrandisci finestra" } },
  // kind "volume": osascript
  volume_up: { kind: "volume", op: "up", label: { en: "Volume up", it: "Alza il volume" } },
  volume_down: { kind: "volume", op: "down", label: { en: "Volume down", it: "Abbassa il volume" } },
  volume_mute: { kind: "volume", op: "mute", label: { en: "Mute", it: "Muto" } },
  volume_unmute: { kind: "volume", op: "unmute", label: { en: "Unmute", it: "Riattiva audio" } },
  // kind "quit": always needs confirmation
  quit_app: { kind: "quit", confirm: true, label: { en: "Quit app", it: "Esci dall'app" } },
  // kind "app_back": the previously used application (Cmd+Tab)
  previous_app: { kind: "app_back", label: { en: "Previous app", it: "App precedente" } },
  // kind "keys": a chord sequence (`confirm`: asks for a spoken "confirm" first)
  screenshot: { kind: "keys", keys: ["cmd+shift+3"], label: { en: "Screenshot", it: "Screenshot" } },
  clear_all: { kind: "keys", keys: ["cmd+a", "delete"], confirm: true, label: { en: "Delete everything", it: "Cancella tutto" } },
  show_desktop: { kind: "keys", keys: ["f11"], label: { en: "Show desktop", it: "Mostra la scrivania" } },
  // kind "calculator": clear Calculator (brought forward first, like a calculation)
  clear_calculator: { kind: "calculator", label: { en: "Clear the calculator", it: "Azzera la calcolatrice" } },
  // kind "field": empty the focused text field only (no confirmation: refused outside a text field, undone with Cmd+Z)
  clear_field: { kind: "field", label: { en: "Clear the field", it: "Svuota il campo" } },
  // kind "language": switch the speech recognizer
  language_it: { kind: "language", locale: "it-IT", label: { en: "Speak Italian", it: "Parla italiano" } },
  language_en: { kind: "language", locale: "en-US", label: { en: "Speak English", it: "Parla inglese" } },
};

// Mostly plain strings: this question rides along with EVERY request, so its size is latency. The look-alikes that Jev
// measurably gets wrong without worked examples ("copy that", "mute", the language switch, undo / close / quit) keep them.
export const CONTROL_CRITERIA = {
  key_enter: "Enter / Return key (invio)",
  key_escape: "Escape key (esc)",
  key_tab: "Tab key (tabulazione)",
  key_shift_tab: "Shift+Tab, previous field (tab indietro)",
  key_space: "Space bar (spazio)",
  key_backspace: "Backspace / delete the previous character (cancella, backspace)",
  key_up: "Arrow up (freccia su)",
  key_down: "Arrow down (freccia giù)",
  key_left: "Arrow left (freccia sinistra)",
  key_right: "Arrow right (freccia destra)",
  key_home: "Home key (tasto inizio)",
  key_end: "End key (tasto fine)",
  key_page_up: "Page Up key (pagina su)",
  key_page_down: "Page Down key (pagina giù)",
  copy: {
    what: "Copy the selection to the clipboard (copia, copy, copy that, copy this); here 'copy that' is the clipboard command, not 'understood'",
    examples: ["copia", "copy", "copy that", "copy this"],
  },
  cut: "Cut the selection (taglia, cut)",
  paste: "Paste from the clipboard (incolla, paste)",
  select_all: "Select all (seleziona tutto, select all)",
  undo: {
    what: "Undo the last edit in the app, the Cmd+Z shortcut (annulla l'ultima modifica, undo typing)",
    not_for: "Going back to the previous web page (that is go_back); cancelling a pending confirmation",
  },
  redo: "Redo the undone edit (ripeti, rifai, redo)",
  save: "Save the document (salva, save)",
  find: "Find in the page or document (trova nella pagina, find on page)",
  new_window: "Open a new window of the current app (nuova finestra, new window)",
  print: "Print (stampa, print)",
  zoom_in: "Zoom in, make the page bigger (ingrandisci, zoom avanti, zoom in)",
  zoom_out: "Zoom out, make the page smaller (rimpicciolisci, zoom indietro, zoom out); 'zoom indietro' is NOT history back",
  zoom_reset: "Reset zoom to normal size (dimensione reale, reset zoom)",
  close_window: {
    what: "Close the front window, or the window of the app that is named (chiudi finestra, chiudi la calcolatrice, close window)",
    not_for: "Closing a browser tab (that is close_tab); quitting the whole app (esci da, quit)",
    examples: ["chiudi finestra", "chiudi la finestra", "chiudi la calcolatrice", "close window", "close the calculator"],
  },
  minimize_window: "Minimize the front window (riduci a icona, minimizza, minimize)",
  fullscreen: "Toggle full screen (schermo intero, full screen)",
  maximize_window: "Zoom / maximize the front window (ingrandisci la finestra, maximize window)",
  volume_up: "System volume up (alza il volume, volume su, louder)",
  volume_down: "System volume down (abbassa il volume, volume giù, quieter)",
  volume_mute: {
    what: "Mute the system sound (muto, silenzio, togli l'audio, mute, mute the sound)",
    examples: ["muto", "silenzio", "mute", "mute the sound"],
  },
  volume_unmute: "Sound back on (riattiva l'audio, unmute)",
  quit_app: {
    what: "Quit an application entirely (esci da safari, termina safari, quit safari)",
    not_for: "Closing one window or one tab; 'chiudi <app>' alone, which closes its window; opening an app",
  },
  previous_app: "Switch back to the previously used application (torna all'app precedente, switch to the previous app)",
  screenshot: "Take a screenshot (screenshot, cattura lo schermo)",
  clear_all: "Delete all the text in the field or document (cancella tutto, elimina tutto, delete all, clear everything)",
  show_desktop: "Show the desktop, moving every window aside (vai sul desktop, mostra la scrivania, torna alla scrivania, show desktop)",
  clear_calculator: "Clear the Calculator display (azzera la calcolatrice, cancella i calcoli, clear the calculator)",
  clear_field: {
    what: "Empty only the input field or message box being written in (cancella il messaggio, cancella questo testo, svuota il campo, clear the field)",
    not_for: "Wiping a whole document (that is clear_all); deleting one character (that is key_backspace)",
  },
  language_it: {
    what: "Switch the voice recognition to Italian (parla italiano, passa all'italiano, speak italian, switch to italian)",
    examples: ["parla italiano", "passa all'italiano", "speak italian", "switch to italian"],
  },
  language_en: {
    what: "Switch the voice recognition to English (parla inglese, passa all'inglese, speak english, switch to english)",
    examples: ["parla inglese", "passa all'inglese", "speak english", "switch to english"],
  },
  none: "Neither a key nor a standard command",
};

// Browser (Playwright) mode only offers what a page can do without the OS: keys + clipboard-style shortcuts + language.
export const BROWSER_CONTROL_IDS = [
  ...Object.keys(CONTROL_OPTIONS).filter((id) => id.startsWith("key_")),
  "copy", "cut", "paste", "select_all", "undo", "redo", "language_it", "language_en",
];

// ---------------------------------------------------------------------------
// Toasts and action descriptions per UI language (describe() in policy.js fills the {placeholders}).
// EN keeps today's strings. `type_into_field_submit` is the variant used when the text is also submitted.
// ---------------------------------------------------------------------------
export const UI_TEXT = {
  en: {
    unclear: "Didn't get that",
    incomplete: "Sentence unfinished",
    confirm: 'Say "confirm" to {action}',
    cancelled: "Cancelled",
    which: "Which one? Say the number.",
    nothingToUndo: "Nothing to undo",
    listening: "Listening…",
    micOff: "Mic off",
    actions: {
      navigate_url: "open {label}",
      open_app: "open {app}",
      switch_app_back: "{label}",
      type_into_field: 'type "{text}" into {label}',
      type_into_field_submit: 'type "{text}" into {label} + enter',
      type_into_field_clear: "clear the field",
      clear_field: "{label}",
      click_element: "click {label}",
      select_option: 'select "{text}" in {label}',
      press_enter: "{label}",
      press_key: "press {key}",
      shortcut: "{label}",
      window_op: "{label}",
      volume: "{label}",
      quit_app: "{label}",
      send_keys: "{label}",
      calculate: "{label}",
      set_language: "{label}",
      scroll_down: "{label}",
      scroll_up: "{label}",
      go_back: "{label}",
      go_forward: "{label}",
      reload: "{label}",
      open_new_tab: "{label}",
      close_tab: "{label}",
      switch_tab: "{label}",
    },
  },
  it: {
    unclear: "Non ho capito",
    incomplete: "Frase incompleta",
    confirm: "Di' «conferma» per {action}",
    cancelled: "Annullato",
    which: "Quale? Di' il numero.",
    nothingToUndo: "Niente da annullare",
    listening: "In ascolto…",
    micOff: "Microfono spento",
    actions: {
      navigate_url: "apri {label}",
      open_app: "apri {app}",
      switch_app_back: "torna all'app precedente",
      type_into_field: 'scrivi "{text}" in {label}',
      type_into_field_submit: 'scrivi "{text}" in {label} + invio',
      type_into_field_clear: "svuota il campo",
      clear_field: "{label}",
      click_element: "clicca {label}",
      select_option: 'seleziona "{text}" in {label}',
      press_enter: "premi invio",
      press_key: "premi {key}",
      shortcut: "{label}",
      window_op: "{label}",
      volume: "{label}",
      quit_app: "{label}",
      send_keys: "{label}",
      calculate: "{label}",
      set_language: "{label}",
      scroll_down: "scorri giù",
      scroll_up: "scorri su",
      go_back: "indietro",
      go_forward: "avanti",
      reload: "ricarica la pagina",
      open_new_tab: "nuova scheda",
      close_tab: "chiudi la scheda",
      switch_tab: "cambia scheda",
    },
  },
};

// ---------------------------------------------------------------------------
// Questions. All are asked in ONE request per transcript update (speculative fan-out).
// ---------------------------------------------------------------------------
// Every question knows that the user may speak Italian, English or both in the same sentence.
const LANG_NOTE = "`transcript` may be Italian, English or a mix of both; judge the meaning, not the language.";

export const INTENT_CRITERIA = {
  navigate_url: {
    what: "Open a specific website or URL by name (go to / open / visit <site>; vai su / apri / portami su <sito>)",
    not_for: "Searching for a topic; clicking something already on the page; opening a desktop application",
    examples: ["go to wikipedia", "open youtube", "visit example dot com", "vai su wikipedia", "apri youtube", "apri youtube in una nuova scheda"],
  },
  search_web: {
    what: "Search for a topic or phrase, on the web or on a named site (search for / look up / google <query>; cerca / trova <query>)",
    not_for: "Typing into a named field without searching; opening a site's homepage; choosing an option by name on the page",
    examples: ["search for alan turing", "look up typesafe jev", "search wikipedia for cats", "cerca gatti", "cerca su google macchine", "cerca su internet youtube"],
  },
  click_element: {
    what: "Click / press / open / select / choose a link, button, tab, result, option or item on the current page or screen (clicca / premi / apri / scegli / seleziona)",
    not_for: "Opening a website by name; typing text; running a search. Choosing a search engine or an option BY NAME on the page is a click, not typing",
    examples: ["click the first result", "click sign in", "choose google", "click accept all", "scegli google", "clicca accetta tutto", "continua", "clicca sul secondo risultato"],
  },
  type_into_field: {
    what: "Type or enter specific text into an input box, search box, text field or the focused field (scrivi / digita / inserisci), optionally followed by sending it",
    not_for: "Running a search on a search engine (that is search_web); pressing a key alone; clicking a named option",
    examples: ["type hello world into the search box", "type hello and send", "scrivi ciao a tutti", "scrivi ciao e invia", "scrivi buongiorno nel campo"],
  },
  select_option: {
    what: "Choose an option from a dropdown / select menu (scegli / seleziona dal menu a tendina)",
    not_for: "Clicking a link or button; choosing a search engine",
    examples: ["select english from the language dropdown", "seleziona italiano dal menu lingua", "scegli Francia dal menu a tendina"],
  },
  press_enter: {
    what: "Press the Enter / Return key, or submit what was typed (premi invio, invia)",
    not_for: "Typing text; clicking a named button; any other key",
    examples: ["press enter", "submit", "premi invio", "invia"],
  },
  press_key: {
    what: "Press one named key: Escape, Tab, Space, Backspace / delete, an arrow, Home, End, Page up / down, optionally several times (premi <tasto>)",
    not_for: "Typing words or sentences; scrolling by words (scroll down); clicking something",
    examples: ["premi esc", "premi spazio", "freccia giù", "cancella", "press escape", "arrow down", "press tab three times", "premi tab tre volte"],
  },
  system_command: {
    what: "A standard command of the computer or the current app, often one bare word: copy / cut / paste, select all, undo / redo, delete everything, save, find in the page, zoom, new / close / minimize / full-screen window, quit an app, previous app, system volume, screenshot, switch speech language",
    not_for: "Opening an app or website; clicking something on the page; going back in browser history; typing text",
    examples: [
      "copia", "incolla", "seleziona tutto", "salva", "trova nella pagina", "nuova finestra", "chiudi finestra", "riduci a icona", "schermo intero",
      "esci da safari", "alza il volume", "muto", "parla inglese", "passa all'italiano", "taglia", "ripeti", "zoom indietro", "torna all'app precedente", "cancella tutto",
      "vai sul desktop", "mostra la scrivania", "cancella i calcoli", "cancella il messaggio", "svuota il campo",
      "copy that", "paste", "cut", "redo", "save", "select all", "minimize the window", "full screen", "quit safari", "volume down", "mute", "speak italian",
      "mute the sound", "zoom out", "switch to the previous app",
    ],
  },
  calculate: {
    what: "Do arithmetic: add, subtract, multiply or divide numbers said aloud (calcola / fai / quanto fa <numbers and operators>)",
    not_for: "Typing numbers as text (scrivi 2 per 3); searching; a phone number or a date said alone",
    examples: ["calcola 7 per 6", "fai 7 più 6", "quanto fa 12 diviso 4", "7 + 6", "calculate 9 minus 3", "what is 5 times 3"],
  },
  scroll_down: {
    what: "Scroll / move down the page (scorri giù, vai in fondo, pagina giù)",
    not_for: "Scrolling up; navigating; pressing the Page Down key by name",
    examples: ["scroll down", "scroll down a bit", "go to the bottom", "scorri giù", "vai in fondo", "scorri un po'"],
  },
  scroll_up: {
    what: "Scroll / move up the page (scorri su, torna in cima)",
    not_for: "Scrolling down",
    examples: ["scroll up", "back to the top", "scorri su", "torna in cima", "pagina su"],
  },
  go_back: {
    what: "Go back to the previous page in history (back / go back / previous page; indietro / torna indietro / pagina precedente)",
    not_for: "Scrolling up; closing a tab; undoing an edit or cancelling a pending action; zoom out (zoom indietro); switching back to the previous application (torna all'app precedente)",
    examples: ["go back", "back", "previous page", "indietro", "torna indietro", "pagina precedente"],
  },
  go_forward: {
    what: "Go forward in history (avanti, vai avanti)",
    not_for: "Scrolling down",
    examples: ["go forward", "forward", "avanti", "vai avanti"],
  },
  reload: {
    what: "Reload / refresh the current page (ricarica, aggiorna la pagina)",
    not_for: "Navigating elsewhere",
    examples: ["reload", "refresh the page", "ricarica la pagina", "aggiorna"],
  },
  open_new_tab: {
    what: "Open a new EMPTY tab with no destination named (nuova scheda, apri una nuova scheda)",
    not_for: "Opening a named website or a search in a tab (that is navigate_url / search_web, 'in una nuova scheda' only adds where)",
    examples: ["open a new tab", "new tab", "nuova scheda", "apri una nuova scheda", "apri tab", "nuovo tab", "open tab"],
  },
  close_tab: {
    what: "Close the current browser tab (chiudi la scheda)",
    not_for: "Going back; closing a whole window or quitting an app (that is system_command)",
    examples: ["close this tab", "close tab", "chiudi questa scheda", "chiudi la scheda"],
  },
  switch_tab: {
    what: "Switch to another / the next / the previous / the first / the last / the Nth tab (scheda successiva / precedente / prima / ultima / terza)",
    not_for: "Opening or closing tabs; switching application",
    examples: ["next tab", "switch tab", "go to the last tab", "go to the third tab", "scheda successiva", "scheda precedente", "vai alla terza scheda", "ultima scheda"],
  },
  confirm: {
    what: "Approve a pending action that was asked to confirm: only when `pending_confirmation` exists (yes / confirm / do it / go ahead; sì / conferma / fallo / vai)",
    not_for: "New commands; 'vai' or 'go' followed by a destination",
    examples: ["confirm", "yes do it", "go ahead", "conferma", "sì fallo", "sì", "vai"],
  },
  cancel: {
    what: "Cancel / never mind / stop: drops the pending action when `pending_confirmation` exists, otherwise undoes the last action (annulla, lascia stare, lascia perdere, ferma)",
    not_for: "Going back in history; deleting text (cancella = delete is a key press, not a cancel); an edit-level undo of typed text",
    examples: ["cancel", "never mind", "stop", "annulla", "lascia stare", "lascia perdere"],
  },
  none: {
    what: "Not a command, or nothing recognizable yet (fragment, chit-chat, silence, filler)",
    not_for: "Anything that clearly matches another option",
    examples: ["um", "okay so", "what do you think", "the weather is nice", "ehm", "allora", "che bella giornata", "boh"],
  },
};

export const SITE_CRITERIA = {
  google: "Google (google, google it)",
  duckduckgo: "DuckDuckGo",
  the_web:
    "A general web search with no site named (search the web, look it up online; cerca su internet, cerca in rete, cerca online)",
  youtube: "YouTube (videos, video)",
  wikipedia: "Wikipedia (the encyclopedia, enciclopedia)",
  github: "GitHub (code, repositories, codice)",
  amazon: "Amazon (shopping, acquisti)",
  reddit: "Reddit",
  twitter_x: "Twitter / X",
  hacker_news: "Hacker News (news.ycombinator.com, hn)",
  example_com: "example.com / example dot com",
  google_maps: "Google Maps (maps, mappe, navigatore, indicazioni stradali)",
  gmail: "Gmail (email, posta elettronica, la mia posta)",
  linkedin: "LinkedIn",
  netflix: "Netflix (film, serie TV)",
  spotify: "Spotify (music, musica)",
  stackoverflow: "Stack Overflow (programming questions, domande di programmazione)",
  facebook: "Facebook",
  instagram: "Instagram",
  other_named_site: "Some other website named explicitly in `transcript` (a domain or brand not listed above)",
  none: "No website or search engine is mentioned in `transcript`",
};

export const QUESTIONS = {
  intent: {
    instructions: {
      question: "Which browser action does the user ask for in `transcript`?",
      focus: `${LANG_NOTE} Judge the words said so far. If the sentence is unfinished, pick the action the words already commit to; if no action is recognizable pick none. \`page\` and \`elements\` describe what is currently on screen. \`context.previous_page\` and \`context.recent_actions\` (most recent first) say where the user just came from and what was just done: 'back to the results' after clicking a search result is go_back; 'the other one' or 'not that one' after a click is click_element on a different element. If \`pending_confirmation\` exists, 'sì / conferma / vai / yes' is confirm and 'annulla / lascia stare / never mind' is cancel. Choosing something by its name on the page ('scegli google', 'choose google') is click_element, not search_web or typing.`,
    },
    criteria: INTENT_CRITERIA,
  },

  target: {
    instructions: {
      question:
        "Which element in `elements` is the one the user refers to in `transcript` (the thing to click, type into or select)? Each line of `elements` starts with the element id (e.g. e07), then its role and visible text; the options are those ids.",
      focus: `${LANG_NOTE} The transcript may be in a different language than the element text ('impostazioni' matches 'Settings', 'accedi' matches 'Sign in'). Match by the element's visible text, role and position words like first/second/top / primo/secondo/in alto (lines are in visual order, top of page first). Use \`context.recent_actions\` for relative references: 'the other one' / 'l'altro' / 'not that one' mean an element other than the target of the most recent action; 'open its documentation' means the docs of the page or item just opened. Elements marked [browser toolbar] belong to the browser window (address bar, tab strip, toolbar buttons), not to the page: 'search box / campo di ricerca / barra di ricerca' means the page's own search field unless the user says 'address bar / barra degli indirizzi'. Dictation with no field named ('scrivi ciao a tutti', 'type hello world') has no target: pick none, the text goes to the keyboard focus. Pick none if the command does not refer to any element on this page, or if the referenced element is not in the list.`,
    },
    // criteria are built per request from the element list + none
  },

  site: {
    instructions: {
      question: "Which website or search engine does the user name in `transcript`?",
      focus: `${LANG_NOTE} Only what is explicitly said ('su youtube', 'on wikipedia', 'cerca su internet' is the_web). Pick none if no site is named.`,
    },
    criteria: SITE_CRITERIA,
  },

  complete: {
    instructions: {
      question:
        "Has the user finished saying the command in `transcript`, so it can be executed now without waiting for more words?",
      focus: `${LANG_NOTE} Speech arrives word by word. A command is complete when its verb and any required object are present (a site for go to, a query for search for, an element for click, text for type). A sentence that ends on a connector or preposition (di, a, su, con, the, of, for) is not complete.`,
    },
    criteria: {
      true: {
        what: "Complete, actionable command",
        examples: [
          "scroll down", "go back", "go to wikipedia", "search for alan turing", "click the first result",
          "scorri giù", "vai su wikipedia", "cerca gatti", "premi invio", "clicca sul primo risultato", "fai 7 più 6",
          "paste", "save", "mute", "redo", "salva", "muto", "ripeti", "scheda precedente",
        ],
      },
      false: {
        what: "Cut off before the required object; more words are clearly coming",
        examples: ["go to", "search for", "click the", "type", "open the", "scroll", "vai su", "cerca", "apri la", "clicca sul", "scrivi", "cerca un video di", "premi", "fai 7 più"],
      },
    },
  },

  is_command: {
    instructions: {
      question:
        "Is `transcript` an instruction addressed to a web browser (navigate, search, click, type, scroll, tabs, keys, confirm/cancel)?",
      focus: `${LANG_NOTE} Chit-chat, narration, talking to another person, or a stray fragment is not a command. A reaction to what the browser just did in \`context.recent_actions\` ('no, not that one', 'undo that', 'wrong link', 'yes confirm', 'no non quello', 'annulla') IS addressed to the browser. A bare one- or two-word command with no object is still a command: 'paste', 'save', 'mute', 'redo', 'copy that', 'reload', 'salva', 'muto', 'ripeti', 'incolla', 'taglia', 'scheda precedente'.`,
    },
    criteria: {
      true: {
        what: "An imperative aimed at the browser, or a correction / confirmation of its last action",
        examples: [
          "scroll down", "go to youtube", "click sign in", "no not that one", "undo that", "confirm",
          "scorri giù", "vai su youtube", "clicca accedi", "no non quello", "conferma", "premi invio",
          "paste", "save", "mute", "copy that", "redo", "incolla", "salva", "muto", "ripeti", "scheda precedente",
        ],
      },
      false: {
        what: "Not directed at the browser",
        examples: ["I think we should get lunch", "um so yeah", "this is the demo", "what did you say", "andiamo a pranzo", "ehm allora", "questa è la demo", "cosa hai detto"],
      },
    },
  },

  destructive: {
    instructions: {
      question:
        "Would carrying out the action in `transcript` on this `page` submit a form, place an order, pay, delete, send a message, post publicly, log out, or otherwise do something hard to undo?",
      focus: `${LANG_NOTE} Navigating, scrolling, reading, clicking links and typing into a box are NOT destructive.`,
    },
    criteria: {
      true: {
        what: "Irreversible side effect",
        examples: [
          "click buy now", "delete this repository", "send the message", "post the comment", "click checkout",
          "clicca acquista ora", "elimina l'account", "invia il messaggio", "paga",
        ],
      },
      false: {
        what: "Reversible / read-only",
        examples: ["scroll down", "go to wikipedia", "click the first result", "type hello in the search box", "scorri giù", "vai su wikipedia", "clicca il primo risultato", "scrivi ciao nella ricerca"],
      },
    },
  },

  scroll_amount: {
    instructions: {
      question: "How far does the user want to scroll according to `transcript`?",
      focus: `${LANG_NOTE} Only relevant when scrolling; default is one screen when nothing is specified.`,
    },
    criteria: [
      { what: "A little: a few lines (a bit, slightly, a little; un po', leggermente)" },
      { what: "One screen / one page, or no amount specified" },
      { what: "All the way to the end: the very top or the very bottom (in cima, in fondo)" },
    ],
  },

  text_span: {
    instructions: {
      question:
        "Which option is exactly the text the user wants typed or searched, as spoken in `transcript`? Options are verbatim candidate spans.",
      focus: `${LANG_NOTE} Choose the shortest span that contains the topic or text itself, without command words (type, search for, cerca, scrivi), destination words (su youtube, nella barra di ricerca, into the search box) or connectors. Pick none if nothing should be typed.`,
    },
  },

  url_span: {
    instructions: {
      question: "Which option is the web address (domain) the user wants to open, as spoken in `transcript`?",
      focus: "Pick none if no address is mentioned ('punto' and 'dot' both mean the dot).",
    },
  },

  // Only asked when `context.recent_actions` is non-empty.
  is_correction: {
    instructions: {
      question:
        "Is the user in `transcript` saying that the most recent action in `context.recent_actions` was wrong and should be reversed or redirected?",
      focus: `${LANG_NOTE} A correction reacts to what just happened ('no', 'not that one', 'wrong link', 'undo that', 'the other one', 'I meant the second one', 'sbagliato', 'l'altro'). A fresh command that merely follows the previous action is not a correction.`,
    },
    criteria: {
      true: {
        what: "Rejects or redirects the previous action",
        examples: [
          "no not that one", "wrong one, go back", "undo that", "I meant the other link", "not that, the second one",
          "no non quello", "sbagliato", "annulla", "l'altro", "no, quella accanto",
        ],
      },
      false: {
        what: "A new command or a continuation, satisfied with the previous action",
        examples: ["scroll down", "now click the comments", "open the documentation", "search for cats", "scorri giù", "ora clicca i commenti", "apri la documentazione", "cerca gatti"],
      },
    },
  },

  tab_direction: {
    instructions: {
      question: "When switching tabs, which tab does `transcript` refer to?",
      focus: LANG_NOTE,
    },
    criteria: {
      next: "The next tab / the other tab / switch tab with no direction (scheda successiva, prossima scheda)",
      previous: "The previous tab / the tab before (scheda precedente)",
      first: "The first tab (prima scheda)",
      second: "The second tab (seconda scheda)",
      third: "The third tab (terza scheda)",
      fourth: "The fourth tab (quarta scheda)",
      fifth: "The fifth tab (quinta scheda)",
      sixth: "The sixth tab (sesta scheda)",
      seventh: "The seventh tab (settima scheda)",
      eighth: "The eighth tab (ottava scheda)",
      last: "The last / rightmost tab (ultima scheda, last tab)",
      none: "Not about switching tabs",
    },
  },

  // Closed set of keys / shortcuts / commands; code owns the keys. In browser mode only BROWSER_CONTROL_IDS are offered.
  control: {
    instructions: {
      question: "Which keyboard key or standard command does the user ask for in `transcript`?",
      focus: `${LANG_NOTE} Only what is explicitly asked: a named key (invio, esc, tab, spazio, frecce) or a standard command (copia, incolla, seleziona tutto, salva, trova nella pagina, nuova finestra, chiudi finestra, riduci a icona, schermo intero, esci da <app>, volume, parla inglese). Pick none if the user asks for anything else.`,
    },
    criteria: {
      ...Object.fromEntries(Object.entries(CONTROL_CRITERIA).filter(([id]) => BROWSER_CONTROL_IDS.includes(id) || id === "none")),
    },
  },
};

// ---------------------------------------------------------------------------
// Desktop mode: the same questions, reworded where "a web browser" would be wrong, plus the
// `open_app` intent and the `app` Choice (criteria built per request from the installed apps).
// ---------------------------------------------------------------------------
const { navigate_url, ...OTHER_INTENTS } = INTENT_CRITERIA;
export const DESKTOP_INTENT_CRITERIA = {
  navigate_url,
  open_app: {
    what: "Open, launch, start, bring up or switch to a desktop application installed on this computer, by its name (apri / avvia / lancia / passa a <app>)",
    not_for: "Opening a website (that is navigate_url); clicking a button or link already on screen; quitting an app",
    examples: [
      "open safari", "launch spotify", "switch to finder", "open system settings", "start the calculator",
      "apri la calcolatrice", "avvia spotify", "passa a finder", "apri impostazioni di sistema",
    ],
  },
  ...OTHER_INTENTS,
};

export const DESKTOP_QUESTIONS = {
  ...QUESTIONS,
  intent: {
    instructions: {
      question: "Which action on the computer does the user ask for in `transcript`?",
      focus: `${QUESTIONS.intent.instructions.focus} \`page.app\` is the application in front; \`elements\` lists what is on screen in its window, including its menu bar.`,
    },
    criteria: DESKTOP_INTENT_CRITERIA,
  },
  complete: {
    instructions: {
      question: QUESTIONS.complete.instructions.question,
      focus: `${LANG_NOTE} Speech arrives word by word. A command is complete when its verb and any required object are present (an application for open, a site for go to, a query for search for, an element for click, text for type, numbers and an operator for calculate). A sentence that ends on a connector or preposition (di, a, su, con, the, of, for) is not complete.`,
    },
    criteria: {
      true: { ...QUESTIONS.complete.criteria.true, examples: [...QUESTIONS.complete.criteria.true.examples, "open safari", "apri safari", "calcola 7 per 6"] },
      false: QUESTIONS.complete.criteria.false,
    },
  },
  is_command: {
    instructions: {
      question:
        "Is `transcript` an instruction addressed to the computer (open an application, navigate, search, click, type, press keys, calculate, volume, windows, tabs, confirm/cancel)?",
      focus: QUESTIONS.is_command.instructions.focus.replaceAll("the browser", "the computer"),
    },
    criteria: {
      true: {
        what: "An imperative aimed at the computer, or a correction / confirmation of its last action",
        examples: [...QUESTIONS.is_command.criteria.true.examples, "open safari", "apri safari", "alza il volume", "parla inglese", "vai sul desktop"],
      },
      false: { ...QUESTIONS.is_command.criteria.false, what: "Not directed at the computer" },
    },
  },
  app: {
    instructions: {
      question:
        "Which installed application does the user name in `transcript`? The options are the applications on this computer.",
      focus: `${LANG_NOTE} Match the spoken name to the closest application, in either language (chrome is Google Chrome, settings / impostazioni di sistema is System Settings, vs code is Visual Studio Code, calcolatrice is Calculator, posta is Mail, messaggi is Messages, note is Notes, terminale is Terminal, orologio is Clock, calendario is Calendar, mappe is Maps, foto is Photos, musica is Music). Pick none if no application is named, or if the name is a website rather than an application.`,
    },
    // criteria are built per request from the installed applications + none
  },
  control: {
    instructions: QUESTIONS.control.instructions,
    criteria: CONTROL_CRITERIA,
  },
};
