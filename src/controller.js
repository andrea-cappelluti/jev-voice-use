/**
 * Orchestrator: transcript updates -> (debounce, cancel stale) -> one Jev request ->
 * policy -> Playwright action -> fresh snapshot. Emits events for the UI / demo / tests.
 */
import { EventEmitter } from "node:events";
import {
  DEBOUNCE_MS,
  CANDIDATE_TTL_MS,
  MAX_INFLIGHT,
  MAX_CONTEXT_ACTIONS,
  MODEL,
  T,
  DEFAULT_LOCALE,
  ANSWER_CACHE_TTL_MS,
  ANSWER_CACHE_MAX,
  PENDING_TTL_MS,
  UNCLEAR_TOAST_MS,
  UI_TEXT,
  VERB_ONLY_WORDS,
} from "./constants.js";
import { uiLang } from "./locale.js";
import { decide, isAbortError } from "./jev.js";
import { evaluatePolicy, describe } from "./policy.js";
import { execute } from "./executor.js";
import { parseCandidatePick, parseConfirmation, cleanTranscript } from "./spans.js";
import { approxTokens } from "./snapshot.js";

const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** Small string hash (FNV-1a) for the answer-cache key: what is ON screen, not only which element ids exist. */
function hashStrings(parts) {
  let h = 0x811c9dc5;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) h = Math.imul(h ^ p.charCodeAt(i), 0x01000193);
    h = Math.imul(h ^ 0x1f, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export class Controller extends EventEmitter {
  /**
   * @param {{browser: import('./browser.js').BrowserManager, decideFn?: Function, executeFn?: Function, lang?: string}} opts
   *   decideFn / executeFn are injectable for tests (default: real Jev + Playwright).
   *   lang is the recognizer locale; commands are always bilingual, the locale picks the toast language.
   */
  constructor({ browser, decideFn = decide, executeFn = execute, lang = DEFAULT_LOCALE }) {
    super();
    this.browser = browser;
    this.lang = lang;
    this.uiLang = uiLang(lang);
    this.browser.uiLang = this.uiLang; // executors localize their toasts from it
    this.answerCache = new Map(); // key -> {result, at}; insertion order = LRU order
    this._decide = decideFn;
    this._execute = executeFn;
    this.snapshot = null;
    this.snapshotAt = 0;
    this.utterance = null; // { id, physicalId, prefix, gen, text, final, startedAt, updatedAt, actedOn, actedText }
    this.consumed = null; // { id: physical utterance id, prefix: executed text (lowercase), gen }
    this.pending = null; // destructive action awaiting "confirm" (expires after PENDING_TTL_MS, see _pendingNow)
    this.pendingAt = 0;
    this.actionSeq = 0; // executed actions so far (answer-cache key: a cap on recentActions would stop it changing)
    this._warming = null; // in-flight opportunistic snapshot refresh (see _warmSnapshot)
    this.candidates = null; // { list: [{n,id,label}], intent: {type,text}, at }
    this.lastDecision = null;
    this.debounceTimer = null;
    this.silenceTimer = null;
    this.inflight = []; // [{ac, text, at}] requests currently awaiting Jev
    this.busy = false;
    this.log = [];
    this.stats = { calls: 0, inputTokens: 0, costUsd: 0, latencies: [], actions: 0, model: MODEL, commandToActionMs: [], decisionMs: [], cacheHits: 0, dedupedRequests: 0, unclear: 0 };
    this.history = [];
    // Conversation context sent to Jev with every request (see jev.encodeContext):
    // the page before the last navigation and the last few executed actions.
    this.context = { previousPage: null, recentActions: [] };
    browser.onChange(() => this.emit("tabs", browser.tabInfo()));
  }

  async start() {
    await this.refreshSnapshot();
    this._log("info", `ready — model ${MODEL}, ${this.snapshot.elements.length} elements on ${this.snapshot.url}`);
  }

  /** Toast text in the UI language. */
  _t() {
    return UI_TEXT[this.uiLang] || UI_TEXT.en;
  }

  _log(level, msg, extra = {}) {
    const entry = { t: Date.now(), level, msg, ...extra };
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
    this.emit("log", entry);
  }

  async refreshSnapshot() {
    this.snapshot = await this.browser.snapshot();
    this.snapshotAt = Date.now();
    this.emit("snapshot", this.snapshot);
    return this.snapshot;
  }

  /**
   * Start a snapshot refresh without waiting for it: called on the first words of a new utterance so the (slow, in desktop
   * mode) accessibility walk overlaps the debounce and the speech itself instead of sitting in front of the Jev request.
   */
  _warmSnapshot() {
    if (this._warming || this.busy || Date.now() - this.snapshotAt <= 1500) return;
    this._warming = this.refreshSnapshot()
      .catch(() => {})
      .finally(() => {
        this._warming = null;
      });
  }

  /** The pending confirmation, or null once it has expired: a stray "ok" a minute later must never quit an app. */
  _pendingNow() {
    if (this.pending && Date.now() - this.pendingAt > PENDING_TTL_MS) this._clearPending("expired");
    return this.pending;
  }

  _setPending(action) {
    this.pending = action;
    this.pendingAt = Date.now();
  }

  _clearPending(why = "") {
    if (!this.pending) return;
    this.pending = null;
    if (why) this._log("debug", `pending confirmation dropped (${why})`);
    this.emit("pending", null);
  }

  /** Typed command fallback: behaves like a final utterance. */
  handleCommand(text) {
    return this.handleTranscript({ text, final: true, utteranceId: `typed-${Date.now()}` });
  }

  /**
   * Called on every partial transcript from the mic (or the demo replay).
   * @param {{text: string, final?: boolean, utteranceId: string|number}} msg
   */
  handleTranscript({ text, final = false, utteranceId }) {
    let clean = cleanTranscript(text);
    const now = Date.now();

    // One action per utterance — but if the user keeps talking in the same breath
    // ("go to wikipedia ... search for alan turing"), the words after the already-executed
    // command become a fresh virtual utterance (id "<physical>+<n>"). Fewer than two new words
    // ("please") are ignored.
    const consumed = this.consumed;
    let virtualId = utteranceId;
    if (consumed && consumed.id === utteranceId) {
      if (!clean.toLowerCase().startsWith(consumed.prefix)) return; // recognizer revised the executed words; ignore
      clean = clean.slice(consumed.prefix.length).trim();
      if (clean.split(/\s+/).filter(Boolean).length < 2) return;
      virtualId = `${utteranceId}+${consumed.gen}`;
    }

    let newUtterance = false;
    if (!this.utterance || this.utterance.id !== virtualId) {
      newUtterance = true;
      this.utterance = {
        id: virtualId,
        physicalId: utteranceId,
        prefix: consumed && consumed.id === utteranceId ? consumed.prefix : "",
        gen: consumed && consumed.id === utteranceId ? consumed.gen : 0,
        text: clean,
        final,
        startedAt: now,
        updatedAt: now,
        actedOn: false,
        actedText: null,
      };
      if (virtualId !== utteranceId) this._log("debug", `continuing utterance → new command "${clean}"`);
    } else {
      if (clean === this.utterance.text && final === this.utterance.final) return;
      this.utterance.text = clean;
      this.utterance.final = final || this.utterance.final;
      this.utterance.updatedAt = now;
    }
    this.emit("transcript", { text: clean, final, utteranceId: virtualId, actedOn: this.utterance.actedOn });
    if (!clean || this.utterance.actedOn) return;
    if (newUtterance) this._warmSnapshot(); // first words of a new utterance

    // Deterministic shortcut: while a confirmation is open, a bare "conferma" / "annulla" needs no Jev. Only unambiguous
    // words count here ("ok", "sure" are what people say to each other; those go through Jev, which sees the pending prompt).
    // Runs before the lone-verb rule below: a partial "vai" is a complete confirmation.
    if (this._pendingNow()) {
      const verdict = parseConfirmation(clean, { casual: false });
      if (verdict) {
        clearTimeout(this.debounceTimer);
        clearTimeout(this.silenceTimer);
        this._consume(this.utterance, clean);
        const pending = this.pending;
        this._clearPending();
        this._log("info", `${verdict} by voice — no model call`);
        if (verdict === "confirm") this._runAction({ ...pending, confirmed: true }, { via: "confirm-fast-path" });
        else this.browser.overlay("toast", this._t().cancelled);
        return;
      }
    }

    // Deterministic shortcut: numbered candidate overlays + a spoken number => no Jev needed.
    if (this.candidates && now - this.candidates.at < CANDIDATE_TTL_MS) {
      const n = parseCandidatePick(clean, this.candidates.list.length);
      if (n) {
        const c = this.candidates.list[n - 1];
        this._consume(this.utterance, clean);
        this._log("info", `picked candidate ${n} (${c.label}) by number — no model call`);
        const action = { ...this.candidates.intent, targetId: c.id, label: c.label };
        this.candidates = null;
        this._clearPending("another command ran");
        this._runAction(action, { via: "candidate-pick" });
        return;
      }
    }

    // A lone verb ("chiudi", "apri", "close") is the start of a command, never a command: wait for
    // the object (or the final result) instead of spending a Jev call that could act on a guess.
    if (!final && VERB_ONLY_WORDS.has(clean.toLowerCase().replace(/[.,;:!?]+$/, ""))) {
      clearTimeout(this.debounceTimer);
      clearTimeout(this.silenceTimer);
      return;
    }

    clearTimeout(this.debounceTimer);
    clearTimeout(this.silenceTimer);
    this.debounceTimer = setTimeout(() => this.decideNow("debounce"), final ? 0 : DEBOUNCE_MS);
  }

  /** Mark `text` of this utterance as executed so later words in the same breath start a new command. */
  _consume(utt, text) {
    utt.actedOn = true;
    utt.actedText = text;
    this.consumed = {
      id: utt.physicalId,
      prefix: `${utt.prefix} ${text}`.trim().toLowerCase(),
      gen: (utt.gen || 0) + 1,
    };
  }

  /** Ask Jev about the current utterance. Cancels any in-flight request. */
  async decideNow(trigger = "manual") {
    const utt = this.utterance;
    if (!utt || !utt.text || utt.actedOn) return;
    if (this.busy) {
      // An action is executing; re-evaluate once it finishes.
      this.silenceTimer = setTimeout(() => this.decideNow("after-action"), 150);
      return;
    }
    // Allow up to MAX_INFLIGHT overlapping requests (a request for the previous partial may
    // still be useful — if the words already commit to an action we act on it). Anything older
    // is stale and gets cancelled via AbortSignal.
    while (this.inflight.length >= MAX_INFLIGHT) {
      const old = this.inflight.shift();
      old.ac.abort();
    }
    const ac = new AbortController();
    const req = { ac, text: utt.text, at: Date.now(), key: null };
    this.inflight.push(req);

    // The refresh normally started with the first words (see _warmSnapshot) and is nearly done by now.
    if (this._warming) await this._warming;
    else if (Date.now() - this.snapshotAt > 1500) await this.refreshSnapshot();

    const textAtRequest = utt.text;
    const cacheKey = this._cacheKey(textAtRequest);
    let result = this._cacheGet(cacheKey);
    let cached = Boolean(result);
    // The recognizer's final arrives ~650 ms after the last partial: if the request for those very words is still in flight,
    // do not send a second identical one. That request reads the utterance's state (final / silence) when it comes back.
    if (!cached && this.inflight.some((r) => r !== req && r.key === cacheKey && !r.ac.signal.aborted)) {
      this.inflight = this.inflight.filter((r) => r !== req);
      this.stats.dedupedRequests += 1;
      return;
    }
    req.key = cacheKey;
    if (cached) {
      // Same words, same screen: Jev would answer the same. Re-run only the pure policy below
      // (silence has grown since the last look).
      this.inflight = this.inflight.filter((r) => r !== req);
      this.stats.cacheHits += 1;
    } else {
      try {
        result = await this._decide(
          {
            transcript: textAtRequest,
            snapshot: this.snapshot,
            pendingConfirmation: this._pendingNow() ? describe(this.pending, "en") : null,
            tabs: this.browser.tabInfo(),
            context: this.context,
          },
          { signal: ac.signal },
        );
      } catch (err) {
        this.inflight = this.inflight.filter((r) => r !== req);
        if (isAbortError(err) || ac.signal.aborted) {
          this._log("debug", `cancelled stale request for "${textAtRequest}"`);
          return;
        }
        this._log("error", `Jev error: ${err.message || err}`);
        this.emit("error", err);
        return;
      }
      this.inflight = this.inflight.filter((r) => r !== req);
      if (ac.signal.aborted || this.utterance !== utt || utt.actedOn) return;
      this._cachePut(cacheKey, result);

      this.stats.calls += 1;
      this.stats.inputTokens += result.usage?.input_tokens ?? 0;
      this.stats.costUsd += result.costUsd;
      this.stats.latencies.push(result.latencyMs);
      if (this.stats.latencies.length > 200) this.stats.latencies.shift();
      if (result.model && result.model !== this.stats.model) this.stats.model = result.model;
    }
    if (this.utterance !== utt || utt.actedOn) return;

    // If more words arrived while this request was in flight, its transcript is a prefix of the
    // real one: it may still act on closed-set intents (the words already commit to "go back"),
    // but it must never be treated as final/silent — free-text payloads would be truncated.
    const stale = utt.text !== textAtRequest;
    const silentMs = stale ? 0 : Date.now() - utt.updatedAt;
    const policy = evaluatePolicy({
      answers: result.answers,
      candidates: result.candidates,
      snapshot: this.snapshot,
      silentMs,
      isFinal: utt.final && !stale,
      pending: this._pendingNow(),
      context: this.context,
      lang: this.uiLang,
    });

    const decision = {
      transcript: textAtRequest,
      trigger,
      decisionLagMs: Math.max(0, Date.now() - utt.updatedAt), // last spoken word -> decision available
      answers: result.answers,
      candidates: result.candidates,
      latencyMs: result.latencyMs,
      usage: result.usage,
      costUsd: result.costUsd,
      model: result.model,
      requestId: result.requestId,
      questionCount: result.questionCount,
      stateTokens: approxTokens(result.state),
      policy,
      silentMs,
      cached,
      thresholds: T,
      at: Date.now(),
    };
    this.lastDecision = decision;
    this.emit("decision", decision);
    this._log(
      policy.decision === "act" ? "act" : "info",
      `${cached ? "cache" : `${result.latencyMs}ms`} · "${textAtRequest}" → ${policy.decision}: ${policy.summary}`,
    );

    switch (policy.decision) {
      case "act":
        this._consume(utt, textAtRequest);
        // Any executed command closes an open confirmation: the user moved on, a later "ok" is not an answer to it.
        this._clearPending(policy.action.confirmed ? "" : "another command ran");
        this.candidates = null;
        await this._runAction(policy.action, { decision, utterance: utt });
        break;
      case "confirm":
        this._consume(utt, textAtRequest);
        this._setPending(policy.action);
        await this.browser.overlay("toast", this._t().confirm.replace("{action}", describe(policy.action, this.uiLang)), 6000);
        this.emit("pending", { action: policy.action, summary: policy.summary });
        break;
      case "cancel":
        this._consume(utt, textAtRequest);
        this._clearPending();
        await this.browser.overlay("toast", this._t().cancelled);
        break;
      case "disambiguate": {
        this._clearPending("another command ran");
        const list = policy.candidates.map((c, i) => ({ n: i + 1, id: c.id, label: c.label, p: c.p }));
        this.candidates = { list, intent: policy.pendingIntent, at: Date.now() };
        await this.browser.overlay("candidates", list, CANDIDATE_TTL_MS);
        await this.browser.overlay("toast", this._t().which, 3000);
        this.emit("candidates", list);
        break;
      }
      case "wait":
        // Poll again only for waits a passing clock can flip; every other wait needs new words.
        if (typeof policy.retryInMs === "number") this._scheduleSilenceRetry(utt, policy.retryInMs);
        else if (utt.final && !stale && !utt.unclearShown) await this._toastUnclear(utt, policy);
        break;
      default:
        break;
    }
  }

  /** Re-evaluate after `retryInMs` (the policy's own clock gate) so silence can unlock the command. */
  _scheduleSilenceRetry(utt, retryInMs) {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      if (this.utterance === utt && !utt.actedOn) this.decideNow("silence");
    }, Math.max(50, retryInMs));
  }

  /** A finished utterance that still means nothing: say so once instead of looping. */
  async _toastUnclear(utt, policy) {
    utt.unclearShown = true;
    this.stats.unclear += 1;
    const text = policy.dangling ? this._t().incomplete : this._t().unclear;
    this.emit("unclear", { text, transcript: utt.text, dangling: Boolean(policy.dangling) });
    await this.browser.overlay("toast", text, UNCLEAR_TOAST_MS);
  }

  /** What Jev is shown, reduced to what could change its answer. */
  _cacheKey(transcript) {
    const s = this.snapshot;
    // The element TEXTS are part of the key: a page that re-renders in place keeps its ids, url and title.
    const sig = s ? `${s.url}|${s.title}|${hashStrings((s.elements || []).map((e) => `${e.id}|${e.role}|${e.text ?? ""}`))}` : "";
    return [transcript, sig, this.pending ? describe(this.pending, "en") : "", this.actionSeq].join("\u0001");
  }

  _cacheGet(key) {
    const hit = this.answerCache.get(key);
    if (!hit) return null;
    this.answerCache.delete(key);
    if (Date.now() - hit.at > ANSWER_CACHE_TTL_MS) return null;
    this.answerCache.set(key, hit); // most recently used goes last
    return hit.result;
  }

  _cachePut(key, result) {
    this.answerCache.delete(key);
    this.answerCache.set(key, { result, at: Date.now() });
    while (this.answerCache.size > ANSWER_CACHE_MAX) this.answerCache.delete(this.answerCache.keys().next().value);
  }

  /** `set_language` never reaches an executor: it retargets the recognizer and the toasts. */
  async _setLanguage(action) {
    try {
      await this.browser.setLang?.(action.locale);
    } catch (err) {
      return { ok: false, detail: String(err.message || err) };
    }
    this.lang = action.locale;
    this.uiLang = uiLang(action.locale);
    this.browser.uiLang = this.uiLang;
    this.answerCache.clear();
    this.emit("lang", { lang: this.lang, uiLang: this.uiLang });
    await this.browser.overlay("toast", describe(action, this.uiLang));
    return { ok: true, detail: action.locale };
  }

  async _runAction(action, meta = {}) {
    this.busy = true;
    const t0 = Date.now();
    const utt = meta.utterance || this.utterance;
    const pageBefore = this.snapshot ? { url: this.snapshot.url, title: this.snapshot.title, site: this.snapshot.site } : null;
    try {
      const res = action.type === "set_language" ? await this._setLanguage(action) : await this._execute(action, this.browser);
      const took = Date.now() - t0;
      const sinceLastWord = utt ? Date.now() - utt.updatedAt : null;
      const sinceUtteranceStart = utt ? Date.now() - utt.startedAt : null;
      this.stats.actions += 1;
      if (sinceLastWord != null) this.stats.commandToActionMs.push(sinceLastWord);
      if (meta.decision?.decisionLagMs != null) this.stats.decisionMs.push(meta.decision.decisionLagMs);
      this.history.push({ action, at: Date.now(), url: res.detail });
      this._recordContext({ action, ok: res.ok, detail: res.detail, said: meta.decision?.transcript || utt?.actedText || "", pageBefore });
      const decisionMs = meta.decision?.decisionLagMs ?? null;
      const entry = {
        action,
        ok: res.ok,
        detail: res.detail,
        executeMs: took,
        decisionMs, // last word -> decision
        sinceLastWordMs: sinceLastWord, // last word -> action finished (includes page load)
        sinceUtteranceStartMs: sinceUtteranceStart,
        via: meta.via || "jev",
      };
      const decided = decisionMs == null ? "" : `decided ${decisionMs}ms after last word, `;
      this._log(res.ok ? "act" : "warn", `${res.ok ? "✓" : "✗"} ${describe(action, this.uiLang)} — ${decided}executed in ${took}ms ${res.detail || ""}`);
      this.emit("action", entry);
    } catch (err) {
      this._log("error", `action failed: ${describe(action, this.uiLang)} — ${err.message || err}`);
      this.emit("action", { action, ok: false, detail: String(err.message || err) });
    } finally {
      this.busy = false;
      await this.refreshSnapshot().catch(() => {});
    }
  }

  /**
   * Remember what was just done so the next Jev request can resolve "back to the results",
   * "the other one", "not that one". Called after every executed action; the page snapshot is
   * refreshed by the caller right after, so `outcome` is derived from the post-action URL.
   */
  _recordContext({ action, ok, detail, said, pageBefore }) {
    const after = this.browser.currentUrl?.() ?? null;
    const navigated = pageBefore && after && after !== pageBefore.url;
    if (navigated) this.context.previousPage = pageBefore;
    let outcome = ok ? "done" : "failed";
    if (ok && navigated) outcome = `navigated to ${after.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80)}`;
    else if (ok && typeof detail === "string" && detail && !detail.startsWith("http")) outcome = detail.slice(0, 80);
    this.actionSeq += 1;
    this.context.recentActions.push({
      type: action.type,
      targetId: action.targetId ?? null,
      targetLabel: action.label ?? null,
      text: action.text ?? null,
      url: action.url ?? null,
      said,
      ok,
      outcome,
      at: Date.now(),
    });
    if (this.context.recentActions.length > MAX_CONTEXT_ACTIONS) this.context.recentActions.shift();
  }

  /** "Undo" = go back in history. */
  async undo() {
    await this._runAction({ type: "go_back", label: "undo (back)" }, { via: "undo" });
  }

  uiState() {
    const lat = this.stats.latencies;
    const sorted = [...lat].sort((a, b) => a - b);
    const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    return {
      model: this.stats.model,
      lang: this.lang,
      thresholds: T,
      stats: {
        calls: this.stats.calls,
        actions: this.stats.actions,
        inputTokens: this.stats.inputTokens,
        costUsd: this.stats.costUsd,
        lastLatencyMs: lat[lat.length - 1] ?? null,
        p50LatencyMs: p50,
        avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
        avgCommandToActionMs: avg(this.stats.commandToActionMs),
        avgDecisionMs: avg(this.stats.decisionMs),
        cacheHits: this.stats.cacheHits,
        dedupedRequests: this.stats.dedupedRequests,
        unclear: this.stats.unclear,
      },
      snapshot: this.snapshot && {
        url: this.snapshot.url,
        title: this.snapshot.title,
        site: this.snapshot.site,
        searchBoxId: this.snapshot.searchBoxId,
        elements: this.snapshot.elements,
        tabs: this.snapshot.tabs,
      },
      lastDecision: this.lastDecision,
      context: this.context,
      pending: this._pendingNow() ? { summary: describe(this.pending, this.uiLang) } : null,
      candidates: this.candidates?.list ?? null,
      log: this.log.slice(-60),
    };
  }

  async close() {
    clearTimeout(this.debounceTimer);
    clearTimeout(this.silenceTimer);
    for (const r of this.inflight) r.ac.abort();
    this.inflight = [];
  }
}
