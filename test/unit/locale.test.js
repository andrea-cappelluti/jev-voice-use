import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSystemLocale, normalizeLocale, uiLang } from "../../src/locale.js";
import { DEFAULT_LOCALE } from "../../src/constants.js";

test("normalizeLocale", () => {
  assert.equal(normalizeLocale("it_IT"), "it-IT");
  assert.equal(normalizeLocale("it"), "it-IT");
  assert.equal(normalizeLocale("en"), "en-US");
  assert.equal(normalizeLocale("en_GB"), "en-GB");
  assert.equal(normalizeLocale("it_IT.UTF-8"), "it-IT");
  assert.equal(normalizeLocale(""), DEFAULT_LOCALE);
  assert.equal(normalizeLocale(null), DEFAULT_LOCALE);
  assert.equal(normalizeLocale(undefined), DEFAULT_LOCALE);
  assert.equal(normalizeLocale("not a locale!"), DEFAULT_LOCALE);
});

test("uiLang: Italian or English", () => {
  assert.equal(uiLang("it-IT"), "it");
  assert.equal(uiLang("it"), "it");
  assert.equal(uiLang("en-US"), "en");
  assert.equal(uiLang("fr-FR"), "en");
  assert.equal(uiLang(undefined), "en");
});

test("detectSystemLocale: AppleLanguages first, then AppleLocale", () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    return '(\n    "it-IT",\n    "en-IT"\n)';
  };
  assert.equal(detectSystemLocale({ platform: "darwin", run }), "it-IT");
  assert.deepEqual(calls, ["defaults read -g AppleLanguages"]);

  const second = (cmd, args) => {
    if (args.includes("AppleLanguages")) throw new Error("no key");
    return "en_GB\n";
  };
  assert.equal(detectSystemLocale({ platform: "darwin", run: second }), "en-GB");
});

test("detectSystemLocale never throws and spawns nothing off macOS", () => {
  let spawned = 0;
  const run = () => {
    spawned++;
    throw new Error("boom");
  };
  const l = detectSystemLocale({ platform: "linux", run });
  assert.equal(spawned, 0);
  assert.match(l, /^[a-z]{2,3}-/i);
  assert.match(detectSystemLocale({ platform: "darwin", run }), /^[a-z]{2,3}-/i);
});
