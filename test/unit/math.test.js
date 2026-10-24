import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateExpression, formatResult, parseMathExpression } from "../../src/math.js";

const check = (text, expr, result) => {
  const m = parseMathExpression(text);
  assert.ok(m, `parsed: ${text}`);
  assert.equal(m.expr, expr, text);
  assert.equal(m.result, result, text);
  return m;
};

test("pinned phrases (it + en)", () => {
  const m = check("Fai 7 + 6", "7+6", 13);
  assert.equal(m.strong, true);
  assert.equal(m.hasVerb, true);
  assert.deepEqual(m.keys, ["kp7", "kpplus", "kp6", "kpenter"]);
  assert.equal(m.display, "7 + 6");
  assert.equal(m.resultText, "13");
  check("calcola 7 per 6", "7*6", 42);
  assert.equal(parseMathExpression("calcola 7 per 6").display, "7 × 6");
  check("quanto fa 12 diviso 4", "12/4", 3);
  assert.equal(parseMathExpression("quanto fa 12 diviso 4").display, "12 ÷ 4");
  check("what is 5 times 3", "5*3", 15);
  check("fai sette più sei", "7+6", 13);
  check("what's 2.5 plus 2.5", "2.5+2.5", 5);
  check("how much is 8 plus 8", "8+8", 16);
  check("calculate 9 minus 3", "9-3", 6);
});

test("incomplete or non-math input is null", () => {
  assert.equal(parseMathExpression("fai 7"), null);
  assert.equal(parseMathExpression("fai 7 più"), null);
  assert.equal(parseMathExpression("calculate 7 plus"), null);
  assert.equal(parseMathExpression("scrivi 2 per 3"), null);
  assert.equal(parseMathExpression("apri la calcolatrice"), null);
  assert.equal(parseMathExpression("333 444"), null, "two numbers without an operator");
  assert.equal(parseMathExpression(""), null);
  assert.equal(parseMathExpression(null), null);
});

test("division by zero keeps the expression but has no result", () => {
  const m = parseMathExpression("8 diviso 0");
  assert.equal(m.expr, "8/0");
  assert.equal(m.result, null);
  assert.equal(m.resultText, "");
});

test("bare expressions are strong, with or without '=' / 'fa'", () => {
  for (const t of ["7 + 6", "7 più 6", "12 ÷ 4 =", "sette per sei fa", "7x6", "7 x 6"]) {
    const m = parseMathExpression(t);
    assert.ok(m?.strong, t);
    assert.equal(m.hasVerb, false, t);
  }
});

test("number words: Italian, English, compounds, decimals", () => {
  check("ventuno per trentatré", "21*33", 693);
  check("centocinque più uno", "105+1", 106);
  check("duemilatrecento meno cento", "2300-100", 2200);
  check("tre mila più due", "3000+2", 3002);
  check("twenty one plus a hundred and five", "21+105", 126);
  check("forty-five minus five", "45-5", 40);
  check("two hundred thirty four thousand five hundred plus one", "234500+1", 234501);
  check("fai tre virgola cinque più due", "3.5+2", 5.5);
  check("two point five times two", "2.5*2", 5);
  check("fai 7,5 per 2", "7.5*2", 15);
});

test("precedence, unary minus and spoken operator variants", () => {
  check("fai due più tre per quattro", "2+3*4", 14);
  check("6 moltiplicato per 7", "6*7", 42);
  check("20 diviso per 5", "20/5", 4);
  check("9 fratto 3", "9/3", 3);
  check("12 divided by 4", "12/4", 3);
  check("3 multiplied by 4", "3*4", 12);
  check("-3 + 4", "-3+4", 1);
  check("5 meno -2", "5--2", 7);
});

test("keypad keys: digits, decimal, operators, always ends with kpenter", () => {
  assert.deepEqual(parseMathExpression("2.5 per 2").keys, ["kp2", "kpdecimal", "kp5", "kpmultiply", "kp2", "kpenter"]);
  assert.deepEqual(parseMathExpression("9 diviso 3").keys, ["kp9", "kpdivide", "kp3", "kpenter"]);
  assert.deepEqual(parseMathExpression("9 meno 3").keys, ["kp9", "kpminus", "kp3", "kpenter"]);
});

test("evaluateExpression is a safe parser: no eval, no code", () => {
  assert.equal(evaluateExpression("2+3*4"), 14);
  assert.equal(evaluateExpression("(1+2)*3"), 9);
  assert.equal(evaluateExpression("-2*-3"), 6);
  assert.equal(evaluateExpression("10/4"), 2.5);
  assert.equal(evaluateExpression("1/0"), null);
  assert.equal(evaluateExpression("2*"), null);
  assert.equal(evaluateExpression(""), null);
  assert.equal(evaluateExpression("process.exit()"), null);
  assert.equal(evaluateExpression("1;globalThis.x=1"), null);
  assert.equal(globalThis.x, undefined);
  assert.equal(evaluateExpression("2**3"), null);
});

test("formatResult: dot decimal, <=10 significant digits, no trailing zeros", () => {
  assert.equal(formatResult(13), "13");
  assert.equal(formatResult(2.5), "2.5");
  assert.equal(formatResult(1 / 3), "0.3333333333");
  assert.equal(formatResult(0.1 + 0.2), "0.3");
  assert.equal(formatResult(-5), "-5");
  assert.equal(formatResult(-0), "0");
  assert.equal(formatResult(null), "");
  assert.equal(formatResult(NaN), "");
});
