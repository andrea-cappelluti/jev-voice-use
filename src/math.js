/**
 * Spoken arithmetic (code, not Jev): "calcola 7 per 6", "fai sette più sei", "what is 5 times 3".
 * `parseMathExpression` extracts a canonical expression, the keypad keys that type it into Calculator and the
 * result computed by a small SAFE evaluator (recursive descent, no eval / Function).
 * Italian and English are understood together: operators, digits, decimals and number words 0..999999.
 */

// --- number words -----------------------------------------------------------
const UNITS = { zero: 0, uno: 1, un: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = { dieci: 10, undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { venti: 20, trenta: 30, quaranta: 40, cinquanta: 50, sessanta: 60, settanta: 70, ottanta: 80, novanta: 90,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const HUNDRED = new Set(["cento", "hundred"]);
const THOUSAND = new Set(["mille", "mila", "thousand"]);
const DIGIT_WORD = { zero: "0", uno: "1", una: "1", due: "2", tre: "3", quattro: "4", cinque: "5", sei: "6", sette: "7", otto: "8", nove: "9",
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
const IT_TENS_STEMS = Object.entries(TENS).filter(([w]) => /[ai]$/.test(w) && !/ty$/.test(w));
const IT_UNIT_WORDS = ["uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove"];

const has = (o, k) => Object.hasOwn(o, k);

/** Italian number below 100 written as ONE word ("ventuno", "trentatre", "quindici"); null if not one. */
function itUnder100(s) {
  if (has(UNITS, s) && s !== "un" && s !== "una") return UNITS[s];
  if (has(TEENS, s)) return TEENS[s];
  if (has(TENS, s)) return TENS[s];
  for (const [w, v] of IT_TENS_STEMS) {
    for (const stem of [w, w.slice(0, -1)]) {
      if (s.startsWith(stem) && s.length > stem.length) {
        const rest = s.slice(stem.length);
        if (IT_UNIT_WORDS.includes(rest) && rest !== "zero") return v + UNITS[rest];
      }
    }
  }
  return null;
}

/** Italian number below 1000 written as one word ("centocinque", "duecentoventi"). */
function itUnder1000(s) {
  if (!s) return 0;
  const u = itUnder100(s);
  if (u !== null) return u;
  const m = s.match(/^(due|tre|quattro|cinque|sei|sette|otto|nove)?cent(?:o)?(.*)$/);
  if (!m) return null;
  const rest = m[2] ? itUnder100(m[2]) : 0;
  if (rest === null) return null;
  return (m[1] ? UNITS[m[1]] : 1) * 100 + rest;
}

/** One Italian word that is a whole number up to 999999 ("duemilatrecento"), or null. Not for plain "mila"/"cento". */
function itGlued(s) {
  if (s === "mille" || s === "mila" || s === "cento") return null; // handled as separate multiplier words
  if (s.startsWith("mille")) {
    const r = itUnder1000(s.slice(5));
    return r === null ? null : 1000 + r;
  }
  const idx = s.indexOf("mila");
  if (idx > 0) {
    const l = itUnder1000(s.slice(0, idx));
    const r = itUnder1000(s.slice(idx + 4));
    return l === null || r === null || l < 2 ? null : l * 1000 + r;
  }
  const v = itUnder1000(s);
  return v;
}

/**
 * Value of a single number word: {v, kind} with kind unit|teen|ten|hundred|thousand|glued, or null.
 */
function wordValue(w) {
  if (has(UNITS, w)) return { v: UNITS[w], kind: "unit" };
  if (has(TEENS, w)) return { v: TEENS[w], kind: "teen" };
  if (has(TENS, w)) return { v: TENS[w], kind: "ten" };
  if (HUNDRED.has(w)) return { v: 100, kind: "hundred" };
  if (THOUSAND.has(w)) return { v: 1000, kind: "thousand" };
  const g = itGlued(w);
  return g === null ? null : { v: g, kind: "glued" };
}

/** Reads a (possibly multi-word) integer starting at tokens[i]; returns {value, next} or null. */
function readInteger(tokens, i) {
  let total = 0;
  let cur = 0;
  let j = i;
  let any = false;
  while (j < tokens.length) {
    let w = tokens[j];
    // "a hundred", "un cento" are only numbers in front of a multiplier
    if ((w === "a" || w === "an" || w === "un") && j + 1 < tokens.length && (HUNDRED.has(tokens[j + 1]) || THOUSAND.has(tokens[j + 1]))) {
      j++;
      continue;
    }
    // "a hundred and five"
    if (w === "and" && any && j + 1 < tokens.length && wordValue(tokens[j + 1])) {
      j++;
      continue;
    }
    const wv = wordValue(w);
    if (!wv) break;
    const acc = total + cur;
    if (wv.kind === "hundred") {
      if (cur === 0) cur = 100;
      else if (cur < 10) cur *= 100;
      else break;
    } else if (wv.kind === "thousand") {
      if (acc === 0 || cur > 0) {
        total += (cur || 1) * 1000;
        cur = 0;
      } else break;
    } else if (wv.kind === "glued" && wv.v >= 1000) {
      if (acc !== 0) break;
      total = wv.v - (wv.v % 1000);
      cur = wv.v % 1000;
    } else {
      const v = wv.v;
      const ok =
        cur === 0 ||
        (cur % 100 === 0 && v < 100) ||
        (cur % 10 === 0 && cur % 100 >= 20 && v < 10 && wv.kind === "unit");
      if (!ok) break;
      cur += v;
    }
    any = true;
    j++;
  }
  if (!any) return null;
  return { value: String(total + cur), next: j };
}

/** Reads a number (digits, decimals, number words, "virgola"/"point" fractions) at tokens[i]. */
function readNumber(tokens, i) {
  let value;
  let j = i;
  if (/^\d+(?:\.\d+)?$/.test(tokens[i] ?? "")) {
    value = tokens[i];
    j = i + 1;
  } else {
    const r = readInteger(tokens, i);
    if (!r) return null;
    value = r.value;
    j = r.next;
  }
  if ((tokens[j] === "virgola" || tokens[j] === "point") && !value.includes(".")) {
    let k = j + 1;
    let frac = "";
    while (k < tokens.length) {
      const t = tokens[k];
      if (/^\d+$/.test(t)) frac += t;
      else if (has(DIGIT_WORD, t)) frac += DIGIT_WORD[t];
      else break;
      k++;
    }
    if (frac) {
      value += "." + frac;
      j = k;
    }
  }
  return { value, next: j };
}

// --- text normalisation -----------------------------------------------------
const LEAD_FILLER = /^(?:per favore|per piacere|please|ok|okay|ehm|allora|dai|mi dici|dimmi|puoi dirmi|can you tell me|tell me|hey|ciao|il risultato di|the result of|la somma di|the sum of)\s+/;
const LEAD_VERB =
  /^(?:fai|fammi|calcola|calcolami|calcolare|risolvi|compute|calculate|solve|quanto fa|quanto fanno|quanto e|quanto viene|quanto vale|what is|what's|whats|what are|how much is|how much are)(?:\s+|$)/;
const U = (alts) => new RegExp(`(?<![\\p{L}\\d])(?:${alts})(?![\\p{L}\\d])`, "gu");
const OP_PHRASES = [
  [U("moltiplicato per|multiplied by"), " * "],
  [U("diviso per|diviso|divided by|fratto|over"), " / "],
  [U("times|volte|per"), " * "],
  [U("piu|plus"), " + "],
  [U("meno|minus"), " - "],
  [U("uguale a|uguale|equals|equal to|equal"), " "],
];

const OPS = new Set(["+", "-", "*", "/"]);
const KEY_OF = { "+": "kpplus", "-": "kpminus", "*": "kpmultiply", "/": "kpdivide", ".": "kpdecimal" };
const SHOW_OP = { "+": "+", "-": "-", "*": "×", "/": "÷" };

/**
 * Thousands separators written by the recognizer: Italian "1.500" / "1.500,75", English "1,500" / "1,500.75" -> plain digits
 * ("1500", "1500.75"). A group is exactly three digits after a 1-3 digit head that does not start with 0 ("0.500" is a
 * decimal); anything else keeps its meaning (the decimal comma / point is handled by the caller).
 */
export function normalizeNumberGrouping(t) {
  return String(t)
    .replace(/(?<![\d.,])([1-9]\d{0,2}(?:\.\d{3})+),(\d+)(?!\d)/g, (_, int, frac) => `${int.replace(/\./g, "")}.${frac}`) // 1.500,75
    .replace(/(?<![\d.,])([1-9]\d{0,2}(?:,\d{3})+)(\.\d+)(?!\d)/g, (_, int, frac) => `${int.replace(/,/g, "")}${frac}`) // 1,500.75
    .replace(/(?<![\d.,])([1-9]\d{0,2}(?:\.\d{3})+)(?![\d]|[.,]\d)/g, (m) => m.replace(/\./g, "")) // 1.500 / 1.500.000
    .replace(/(?<![\d.,])([1-9]\d{0,2}(?:,\d{3})+)(?![\d]|[.,]\d)/g, (m) => m.replace(/,/g, "")); // 1,500 / 1,500,000
}

/**
 * Parse a spoken / typed arithmetic request. Returns null when there is no complete expression (trailing operator,
 * fewer than two operands, or words that are neither numbers, operators, lead-ins nor fillers).
 */
export function parseMathExpression(transcript) {
  let t = String(transcript ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/×/g, " * ")
    .replace(/÷/g, " / ")
    .replace(/[?!]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .trim();
  if (!t) return null;

  // lead-ins
  let hasVerb = false;
  for (let guard = 0; guard < 6; guard++) {
    const f = t.match(LEAD_FILLER);
    if (f) {
      t = t.slice(f[0].length).trim();
      continue;
    }
    const v = t.match(LEAD_VERB);
    if (v) {
      hasVerb = true;
      t = t.slice(v[0].length).trim();
      continue;
    }
    break;
  }
  t = t.replace(/\s+(?:per favore|per piacere|please|grazie)$/, "");

  // operators and numbers
  t = normalizeNumberGrouping(t);
  t = t.replace(/(\d),(\d)/g, "$1.$2"); // Italian decimal comma, only between digits
  t = t.replace(/(\d)\s*x\s*(?=\d)/g, "$1 * "); // "7 x 6", "7x6"
  t = t.replace(/([a-z])-([a-z])/g, "$1 $2"); // "forty-five"
  for (const [re, to] of OP_PHRASES) t = t.replace(re, to);
  t = t.replace(/[+*/=]/g, " $& ").replace(/(\d|\s)-/g, "$1 -").replace(/-(?=\d)/g, "- ");
  const tokens = t.split(/\s+/).filter((x) => x && x !== "=" && x !== "fa" && x !== "e'" && x !== "is");

  const items = []; // {n: "7"} | {op: "+"}
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (OPS.has(tok)) {
      items.push({ op: tok });
      i++;
      continue;
    }
    const r = readNumber(tokens, i);
    if (!r) return null; // a content word that is not part of arithmetic
    items.push({ n: r.value });
    i = r.next;
  }

  // unary minus: at the start or right after another operator
  const seq = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const prev = seq[seq.length - 1];
    if (it.op === "-" && (!prev || prev.op) && items[k + 1]?.n !== undefined) {
      seq.push({ n: "-" + items[k + 1].n });
      k++;
    } else seq.push(it);
  }
  // must alternate number, operator, number ...
  for (let k = 0; k < seq.length; k++) {
    if (k % 2 === 0 ? seq[k].n === undefined : seq[k].op === undefined) return null;
  }
  if (seq.length < 3 || seq.length % 2 === 0) return null;

  const expr = seq.map((s) => s.n ?? s.op).join("");
  const display = seq.map((s) => (s.n !== undefined ? s.n : SHOW_OP[s.op])).join(" ").replace(/ - (?=\d)/g, " - ");
  const result = evaluateExpression(expr);
  const keys = [...expr].map((c) => (/\d/.test(c) ? `kp${c}` : KEY_OF[c]));
  keys.push("kpenter");
  const operators = seq.filter((s) => s.op).length;
  const operands = seq.length - operators;
  return {
    expr,
    display,
    result,
    resultText: formatResult(result),
    keys,
    hasVerb,
    strong: operators >= 1 && operands >= 2,
  };
}

// --- safe evaluator ---------------------------------------------------------
/**
 * Evaluates + - * / (with precedence, unary minus, decimals and parentheses) over a string of digits and operators.
 * No eval, no Function. Returns null for invalid input, division by zero or a non-finite result.
 */
export function evaluateExpression(expr) {
  const s = String(expr ?? "").replace(/\s+/g, "");
  if (!s || !/^[0-9.+\-*/()]+$/.test(s)) return null;
  let p = 0;
  const fail = Symbol("fail");

  const primary = () => {
    if (s[p] === "(") {
      p++;
      const v = sum();
      if (s[p] !== ")") throw fail;
      p++;
      return v;
    }
    const m = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(s.slice(p));
    if (!m) throw fail;
    p += m[0].length;
    return Number(m[0]);
  };
  const unary = () => {
    if (s[p] === "-") {
      p++;
      return -unary();
    }
    if (s[p] === "+") {
      p++;
      return unary();
    }
    return primary();
  };
  const product = () => {
    let v = unary();
    while (s[p] === "*" || s[p] === "/") {
      const op = s[p++];
      const r = unary();
      if (op === "*") v *= r;
      else {
        if (r === 0) throw fail;
        v /= r;
      }
    }
    return v;
  };
  const sum = () => {
    let v = product();
    while (s[p] === "+" || s[p] === "-") {
      const op = s[p++];
      const r = product();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };

  try {
    const v = sum();
    if (p !== s.length || !Number.isFinite(v)) return null;
    return v;
  } catch (e) {
    if (e === fail) return null;
    throw e;
  }
}

/** Dot decimal, at most 10 significant digits, no trailing zeros, integers without ".0"; "" for null. */
export function formatResult(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  const r = Number(n.toPrecision(10));
  if (Object.is(r, -0) || r === 0) return "0";
  const s = String(r);
  if (!/e/i.test(s)) return s;
  // exponent form (very large / very small): expand
  return r.toFixed(Math.abs(r) < 1 ? 10 : 0).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
