# jev-voice-use — talk to your Mac or a real browser, it acts before you finish the sentence

A Node app that controls **the whole Mac** (desktop mode, the default on macOS) or a **headed
Chromium window** (browser mode, Playwright) by voice, in Italian and English. Speech is streamed
word by word to a small Node server; on every partial transcript the server asks **Jev** (TypeSafe's
System One model, `jev-1.13.0`) one request with a dozen typed questions — intent, target element,
site, "is the command complete?", "is this even addressed to me?", "is it destructive?" — gets typed
probabilities back in ~250–350 ms, and code decides whether to act, wait, ask, or ignore.

Jev never generates text. Search queries, typed text and URLs are extracted as candidate spans by
code and Jev only *picks* one, which is copied verbatim.

Based on [moritzkremb/jev-voice-browser](https://github.com/moritzkremb/jev-voice-browser) (MIT),
extended with desktop mode, bilingual commands and spoken arithmetic.

Browser mode pipeline (desktop mode is the same, with the native helper in place of Chrome and Playwright):

```
 mic (Chrome, Web Speech API)          Node server (owns the API key)             controlled window
 ───────────────────────────    ws     ───────────────────────────────────         ──────────────────
 partial transcripts  ───────────────▶ debounce 200 ms                            headed Chromium via
 "go to"  "go to wiki"                 snapshot page (≤100 elements, e01..eNN) ◀── Playwright, persistent
 "go to wikipedia" (final)             ONE Jev request: 9–11 questions             profile, overlay
                                       policy (thresholds in constants.js)  ───▶  highlight / toast /
 control page ◀─────────────────────── decision + bars + latency + cost            numbered candidates
```

## Run it

Requirements: Node ≥ 20 (tested on 22 and 24), npm, a TypeSafe API key. Desktop mode needs macOS
with the Xcode command line tools (`xcode-select --install`); browser mode needs Chrome or Edge for
the microphone (the Web Speech API is not available in Firefox/Safari). Real API calls cost
~$0.0002 each.

```bash
git clone https://github.com/andrea-cappelluti/jev-voice-use.git
cd jev-voice-use
npm install
npx playwright install chromium
cp .env.example .env          # paste your TypeSafe API key (https://console.typesafe.ai/keys)
./run.sh                      # macOS: voice control of the whole Mac · elsewhere: browser mode
```

### Desktop mode (macOS, the default)

On a Mac, `./run.sh` controls **the whole computer**, not just one browser window. Press
**Ctrl+Option+W** anywhere to switch the microphone on or off (a pill at the top of the screen shows
what is being heard), then speak. Everything in "What you can say" works on whatever application is
in front, plus:

| Say | What happens |
| --- | --- |
| "open safari" / "launch the calculator" / "switch to finder" | opens or brings forward the application (Jev picks it from the installed ones) |
| "click save" / "open the file menu" / "click the downloads tab" | clicks a button, link, menu, tab or list row of the front window |
| "type hello world" | types at the keyboard focus when no field is named |
| "go to wikipedia" / "vai su wikipedia" | a browser in front (Chrome, Safari, Arc, Edge, Brave, Firefox, Opera, Vivaldi): navigates the **current tab** through its address bar; no browser in front: opens in the default browser |
| "apri youtube in una nuova scheda" / "open youtube in a new tab" | a new tab only when you ask for one |
| "cerca macchine" / "search for cats" | on the site you are on (or none named): types into the **page's** search field + Enter, never the browser's address bar; another site named ("cerca gatti su wikipedia"): that site's search in the current tab; otherwise DuckDuckGo |
| "premi invio" / "premi esc" / "freccia giù tre volte" / "press escape" | key presses (closed set, repeat count: a key with no count waits ~0.35 s for a possible "tre volte"). A bare Enter asks for "conferma" only when the page looks like a form / checkout (`destructive` ≥ 0.8), the same way in both languages |
| "cancella" / "backspace" / "cancella tutto" | the delete key; "cancella tutto" (select all + delete) asks for "conferma" first |
| "vai alla terza scheda" / "go to the last tab" / "scheda successiva" | tab by position (Cmd+1…8, Cmd+9 = last) or next / previous |
| "zoom indietro" / "zoom in" / "torna all'app precedente" / "switch to the previous app" | zoom (not history back) / back to the app you came from |
| "annulla" / "undo" | cancels a pending confirmation; otherwise undoes the last action, or sends Cmd+Z when there is nothing recorded to reverse |
| "copia" / "incolla" / "seleziona tutto" / "salva" / "trova nella pagina" / "nuova finestra" / "undo" / "redo" | named shortcuts: Jev picks the name, code owns the keys |
| "chiudi finestra" / "riduci a icona" / "schermo intero" | window buttons through the Accessibility API |
| "alza il volume" / "abbassa il volume" / "muto" / "volume down" | system volume (osascript) |
| "esci da safari" / "quit safari" | quits the app **after you say "conferma"** |
| "calcola 7 per 6" / "fai 7 + 6" / "quanto fa 12 diviso 4" / "what is 5 times 3" | code parses the arithmetic (spoken operators, digits, number words), brings Calculator forward (opens it if needed), clears it, types the keys and shows the result in a toast |
| "scrivi ciao a tutti" / "scrivi ciao e invia" / "type hello and send" | dictation at the keyboard focus; "e invia" / "and send" presses Enter |
| "parla inglese" / "speak italian" | switches the recognizer language live |

A small native helper (`native/helper.swift`, compiled by `swiftc` on the first run — needs the
Xcode command line tools) provides the hotkey, on-device speech recognition, the screen contents
(read through the macOS Accessibility API), the synthetic clicks / keys and the on-screen overlay.
The first run asks for three permissions, all attributed to **your terminal app**: Accessibility
(System Settings → Privacy & Security → Accessibility), Microphone and Speech Recognition.

**Italian and English, mixed in one session.** Commands, spans, site names, numbers ("il secondo",
"two"), confirmations ("conferma", "sì, fallo", "annulla", "lascia stare") are bilingual everywhere.
The recognizer locale defaults to the macOS system locale; override it with `--lang it-IT`, or
`VB_LANG=en-US`, or say "parla inglese" / "speak italian". The locale only picks the speech
recognizer, the it/en URL variants and the language of the toasts. Italian "annulla" cancels a pending
confirmation, and otherwise undoes the last action.
`VB_DEBUG=1 ./run.sh` prints microphone levels.
The hotkey is `HOTKEY` in `src/constants.js`. http://localhost:8787 still shows the live dashboard
and accepts typed commands.

Things to know: the microphone only listens while it is switched on, but then **any** recognised
command acts on the front application — switch it off when you are done. Element labels of the front
window (not the contents of text fields) are sent to Jev with each request. Destructive clicks still
ask for a spoken "confirm".

### Browser mode (`./run.sh --browser`, and the default on other platforms)

Open **http://localhost:8787 in your normal Chrome**, click **Start mic**, allow the
microphone, and speak. A separate Chromium window (the *controlled* browser) is opened by the server;
that is the one that acts. Keep the control page visible on a second screen / half the screen for
the live probability bars.

Options: `./run.sh --port 9000`, `--host 0.0.0.0` (LAN, see Security), `--start-url https://…`, `--headless` (CI), or attach to a Chrome
you already have running instead of launching one:

```bash
# start your Chrome with a debugging port, then:
./run.sh --cdp http://127.0.0.1:9222
```

Set the key yourself instead of `.env`: `export TYPESAFE_API_KEY=…` (legacy `JEV_API_KEY` is
also accepted) and `npm start`. The key is only ever read by the Node process; the control page
never sees it.

**Security:** the server listens on `127.0.0.1` only. Anyone who can reach the control port can
drive the browser and spend your API credits, so only use `--host 0.0.0.0` on a network you trust.
The controlled Chromium uses a persistent profile in `.browser-profile/` (gitignored) — don't log
into accounts there that you wouldn't want a mis-heard "click place order" to touch; destructive
clicks require a spoken "confirm", but treat that as a convenience, not a guarantee.

No microphone? Type a command into the text box on the control page and press Enter.

## What you can say

Italian and English, mixable in the same session; the sentences below are examples, not a fixed grammar.

| Say | What happens |
| --- | --- |
| "go to wikipedia" / "vai su wikipedia" / "open youtube" / "go to example dot com" | navigates (site list or spoken domain, code owns the URLs; Italian users get it.wikipedia.org, amazon.it) |
| "search for alan turing" / "cerca alan turing" | the page's own search box if the page has one (Wikipedia, YouTube...), else DuckDuckGo |
| "search youtube for lofi beats" / "cerca su youtube musica lofi" / "cerca su internet youtube" | site-specific search URL template (a site with no template of its own, e.g. "cerca su facebook mario rossi", gets a `site:` search, never the current page's box) |
| "cerca gatti in una nuova scheda" / "search cats in a new tab" | the new-tab words are not part of the query; a new-tab search is always a URL |
| "click the first result" / "clicca sul primo risultato" / "scegli Google" / "clicca accetta tutto" | clicks the element Jev picked from the snapshot; ambiguous: numbered overlays, say "two" / "il secondo" |
| "type hello world into the search box" / "scrivi ciao nella barra di ricerca" | types verbatim (Jev picked the span, code copies it); "e invia" / "and send it" also presses Enter |
| "scroll down a bit" / "scorri giù di poco" / "vai in fondo alla pagina" / "torna in cima" | scroll with the amount from a 3-level Score |
| "go back" / "indietro" / "reload" / "ricarica la pagina" | history |
| "open a new tab" / "nuova scheda" / "close this tab" / "chiudi scheda" / "next tab" / "scheda precedente" | tabs |
| "press escape" / "premi esc" / "premi freccia giù tre volte" / "premi tab" | key presses from a closed set, with a repeat count |
| "copy" / "copia" / "incolla" / "seleziona tutto" / "salva" / "trova nella pagina" | named shortcuts (desktop mode; copy, paste, cut, select all, undo, redo are also available in browser mode) |
| "calcola 7 per 6" / "fai 7 + 6" / "what is 5 times 3" | arithmetic in Calculator (desktop mode), result in the toast |
| "click place order" / "esci da safari" | destructive: toast asks you to say **"confirm" / "conferma"** (or "cancel" / "annulla", "lascia stare") |
| "so anyway I think we should get lunch" / "allora secondo me andiamo a pranzo" | ignored (`is_command` ~ 0.02) |

Unclear speech gets a short toast ("Non ho capito" / "Didn't get that", or "Frase incompleta" when the
sentence ends on a connector like "cerca un video di"); the app never loops on an unclear phrase.

Two commands in one breath work too: "go to example dot com and click the more information link".

## Speed and safety details

- **Smart end of utterance** (native helper): a phrase that looks finished is closed after about 0.65 s of
  silence; one that ends on a connector (it: di a da in con su per il la un...; en: the a of to for with...)
  or on a bare verb ("cerca", "open") waits up to 1.7 s. Lists and timings live in `src/constants.js` and
  are sent to the helper at launch. The policy also never acts on free text ending on such a word.
- **Answer cache**: the same transcript on the same screen (ids, texts, url, title) is not sent to Jev twice;
  only the pure policy re-runs as silence grows. The recognizer's final does not send a second request while
  the one for the same words is still in flight. The controller polls again only for waits a clock can unlock.
- **Snapshot overlap**: the (slow) accessibility walk starts with the first words of an utterance, in parallel
  with the debounce, instead of sitting in front of the Jev request.
- **Condition waits**: after navigating or clicking the desktop executor polls a cheap `probe` (app / title /
  url) until something changes instead of sleeping. Nothing is waited for when no change can come: reload and
  re-opening the page that is already open (0.3 s), plain keys, arrows and shortcuts (not at all).
- **Address bar**: navigation in a browser sends Cmd+L as a plain key press, checks through the accessibility
  tree that the focus really left the page, types at ~1.5 ms per character and only then presses Return. If the
  focus is still in the page it reports an error and the URL goes through `open` instead.
- A pending confirmation answers "conferma" / "annulla" / "yes" / "cancel" without a model call (unambiguous words only,
  within 9 s of the prompt).

## How a decision is made

Every transcript update produces exactly one Jev request (`src/jev.js`). State:

```json
{ "transcript": "open the documentation",
  "page": { "url": "https://typesafe.ai/jev", "title": "Jev", "site": "generic" },
  "elements": ["e03 link \"Documentation\" → docs.typesafe.ai", "e07 link \"Read the docs\" → docs.typesafe.ai", "..."],
  "context": {
    "previous_page": { "url": "https://duckduckgo.com/?q=jev+typesafe", "title": "jev typesafe at DuckDuckGo" },
    "recent_actions": [
      { "said": "click the first result", "action": "click_element", "target": "link \"TypeSafe — Jev\"", "outcome": "navigated to typesafe.ai/jev", "seconds_ago": 6 },
      { "said": "search for jev typesafe", "action": "navigate_url", "outcome": "navigated to duckduckgo.com/?q=jev+typesafe", "seconds_ago": 25 } ] } }
```

`context` is the conversation so far: the page you came from and the last three executed actions
(what you said, what was done, what happened). It is what makes "go back to the results", "no, not
that one", "the other one" and "open its documentation" resolvable — Jev has no memory between
requests, so the memory lives in the state.

Questions (all in `src/constants.js`, asked together, answered in parallel):

| id | type | answers |
| --- | --- | --- |
| `intent` | Choice | navigate_url · search_web · click_element · type_into_field · select_option · press_enter · press_key · system_command · calculate · scroll_down/up · go_back/forward · reload · open/close/switch tab · confirm · cancel · none (+ open_app on the desktop) — each option has `{what, not_for, examples}` |
| `control` | Choice | the closed set of keys / shortcuts / commands whose keys code owns: key_enter … key_page_down · copy · paste · undo · save · find · zoom · close / minimize / fullscreen · volume · quit_app · previous_app · clear_all · language (browser mode: keys, clipboard, undo/redo, language) |
| `target` | Choice | the element ids on the page + `none` |
| `site` | Choice | google · duckduckgo · the_web · youtube · wikipedia · github · amazon · reddit · twitter_x · hacker_news · example_com · other_named_site · none |
| `complete` | Noul | has the user finished the command? (lets us act on partial speech) |
| `is_command` | Noul | is the user addressing the browser at all? |
| `destructive` | Noul | would it submit / buy / delete / send? |
| `scroll_amount` | Score | a little · one page · to the end |
| `text_span` | Choice | verbatim candidate spans extracted by regex (+ `none`) — only when the transcript has any |
| `url_span` | Choice | domain-looking spans (+ `none`) — only when present |
| `tab_direction` | Choice | next · previous · first … eighth · last · none — only asked when the words mention a tab |
| `is_correction` | Noul | is the user rejecting / redirecting the most recent action in `context.recent_actions`? — only asked when there is history |

Policy (`src/policy.js`, thresholds `T` in `constants.js`), shown live in the UI as a gate table:

0. `is_correction ≥ 0.6` on a finished phrase: with no confident new command ("no, not that one",
   "undo that") → reverse the last action (click/navigate → back, typing → clear, scroll → opposite);
   with a new target ("no, the other one") → the previously clicked element is excluded from the
   candidates. A confident closed-set command ("go back" after a scroll) is never treated as a correction.
1. `is_command ≥ 0.5` else **ignore**
2. `intent.confidence ≥ 0.55` and not `none` else **wait**
3. `complete ≥ 0.6`, or 900 ms of silence, or the recognizer's final result — else **wait**
4. free-text intents (search / type) additionally wait for the final result or 600 ms silence, so a
   query is never truncated ("search for alan" vs "search for alan turing")
5. build the action in code: URL templates, search-box fallback, verbatim span copy
6. click/type targets need `target.confidence ≥ 0.45` and top probability ≥ 0.35, else the top 2–3
   candidates get numbered overlays in the page and a spoken number picks one (no model call)
7. `destructive ≥ 0.5` on a click / select → **confirm** (say "confirm" / "cancel"); a bare Enter key needs `≥ 0.8`;
   quitting an app and "cancella tutto" always confirm. A confirmation expires after 9 s and any other command
   closes it; the no-model-call shortcut only takes unambiguous words (conferma, sì, fallo, vai, yes, confirm…),
   casual "ok" / "sure" go through Jev, which sees the pending prompt

Requests overlap: up to 2 in flight; older ones are cancelled with `AbortSignal`. A response for a
partial transcript may still act if the words already commit to a closed-set action ("go back"),
but is never treated as final for free text.

## Project layout

```
src/constants.js   MODEL pin, thresholds, every question text — the one file to review on camera
src/jev.js         builds state + questions, calls @typesafe-ai/sdk, returns answers/latency/usage/cost
src/spans.js       candidate extraction (text payloads, spoken URLs, number words) — code, not Jev
src/snapshot.js    in-page element collector (tags data-vb-id), compaction + size guard, site detection
src/policy.js      answers → act / wait / ignore / confirm / disambiguate, with reasons
src/executor.js    Playwright actions + overlay feedback
src/browser.js     launch headed Chromium (persistent profile) or attach via CDP; tabs
src/overlay.js     injected highlight / toast / numbered badges
src/controller.js  debounce, in-flight management, one action per utterance, chaining, stats
src/server.js      Express + ws, serves src/public/index.html (control page)
src/desktop.js     desktop mode: DesktopManager (talks to the native helper) + executeDesktop
src/locale.js      recognizer locale (it-IT / en-US): system default, --lang, VB_LANG
src/math.js        spoken arithmetic parser + safe evaluator for the Calculator command
native/helper.swift macOS helper: hotkey, speech recognition, Accessibility snapshot, clicks / keys, overlay
scripts/demo.js    word-by-word replay against real sites = end-to-end test
scripts/capture-fixture.js  snapshot a page into test/fixtures/<name>.json
test/unit/         spans, snapshot compaction, policy (mocked Jev), controller (mocked Jev + browser), context encoding + corrections
test/integration/  170 real-API cases (IT 84 · EN 86: browser fixtures, context / corrections, desktop keys, shortcuts, windows, calculator, searches, dropdowns), prints pass rate + latency
```

## Tests and demo

```bash
npm test                 # unit tests (no network)
npm run test:integration # real Jev calls on fixtures; prints pass rate (expects ≥ 90%)
npm run demo             # headed replay of 24 spoken commands (EN + IT) against real sites, asserts URLs
npm run demo:ci          # same, headless; exit code 1 on failure
node scripts/demo.js --headless --only 1,2,3 --word-ms 250
```

Latest measured (Oct 2026, from this machine): integration 170/170 (IT 84/84 · EN 86/86), Jev latency avg ≈ 330 ms
(p50 ≈ 310–325 ms, p95 ≈ 420–430 ms, ~7.6k input tokens per desktop request; the first request of a process is ~700 ms for the
TLS handshake), last-word→decision ≈ 300 ms including the 200 ms debounce, whole demo ≈ $0.03.

## Notes and limitations

- Web Speech API only in Chrome/Edge; it sends audio to Google. Interim results arrive in bursts, so
  "acting before you finish" is most visible on longer sentences.
- One action per utterance; extra words after an executed command are treated as a new command
  only if there are at least two of them.
- Element snapshot is capped at 100 items (viewport first) and 60 chars of text each — deep pages
  need a scroll before "click …" finds below-fold items. Elements inside iframes are not seen.
- Sites with heavy bot protection (Google consent, some search engines in headless mode) may not
  render results; the demo uses Wikipedia, example.com, Hacker News and DuckDuckGo.
- `select_option` matches the option label in code by substring ("seleziona Francia dal menu paese" -> "Francia");
  `switch_tab` goes next / previous or to a position (Cmd+1…9). A page field only counts as "the search box" with a
  real search signal (a search role, a search-like name, a search / cerca / trova label).
- Confidence gates are calibrated on `jev-1.13.0`; re-check `T` if you move the model alias.
