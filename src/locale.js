/**
 * Recognizer locale helpers. The locale (BCP-47, "it-IT") only selects the speech recognizer, the it/en URL
 * variants and the toast language; commands themselves are always understood in both languages.
 */
import { execFileSync } from "node:child_process";
import { DEFAULT_LOCALE } from "./constants.js";

/** "it_IT" -> "it-IT", "it" -> "it-IT", "en" -> "en-US", "en_GB" -> "en-GB", ""/null -> DEFAULT_LOCALE. */
export function normalizeLocale(s) {
  const raw = String(s ?? "").trim().replace(/_/g, "-").split(/[.@]/)[0];
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(raw)) return DEFAULT_LOCALE;
  const [lang, ...rest] = raw.split("-");
  const l = lang.toLowerCase();
  if (rest.length === 0) {
    const defaults = { en: "en-US", it: "it-IT", fr: "fr-FR", de: "de-DE", es: "es-ES", pt: "pt-PT", nl: "nl-NL", ja: "ja-JP", zh: "zh-CN", ko: "ko-KR" };
    return defaults[l] || `${l}-${l.toUpperCase()}`;
  }
  // keep a region (2 letters or 3 digits) and drop script / extension subtags ("zh-Hans-CN" -> "zh-CN")
  const region = rest.find((p) => /^([a-z]{2}|\d{3})$/i.test(p));
  return region ? `${l}-${region.toUpperCase()}` : normalizeLocale(l);
}

/** "it" | "en": the toast language for a locale (anything that is not Italian shows English). */
export function uiLang(locale) {
  return /^it([-_]|$)/i.test(String(locale ?? "")) ? "it" : "en";
}

const defaultRun = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });

/**
 * The macOS system locale: first entry of `defaults read -g AppleLanguages`, else AppleLocale, else Intl, else the
 * default. `run(cmd, args) => string` is injectable for tests. Never throws; spawns nothing off macOS.
 */
export function detectSystemLocale({ platform = process.platform, run = defaultRun } = {}) {
  if (platform === "darwin") {
    try {
      const out = String(run("defaults", ["read", "-g", "AppleLanguages"]));
      // plist array: ( "it-IT", "en-IT" ) -> first quoted or bare entry
      const m = out.match(/["']?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)["']?\s*[,)]/);
      if (m) return normalizeLocale(m[1]);
    } catch {}
    try {
      const out = String(run("defaults", ["read", "-g", "AppleLocale"])).trim();
      if (out) return normalizeLocale(out);
    } catch {}
  }
  try {
    const l = Intl.DateTimeFormat().resolvedOptions().locale;
    if (l) return normalizeLocale(l);
  } catch {}
  return DEFAULT_LOCALE;
}
