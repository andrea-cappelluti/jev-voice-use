/**
 * Playwright executor without a browser: key-name translation and the actions that are
 * desktop-only or handled by a fake page.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toPlaywrightKey, execute } from "../../src/executor.js";

test("toPlaywrightKey: helper key names and modifiers -> Playwright key strings", () => {
  assert.equal(toPlaywrightKey("return"), "Enter");
  assert.equal(toPlaywrightKey("escape"), "Escape");
  assert.equal(toPlaywrightKey("tab", ["shift"]), "Shift+Tab");
  assert.equal(toPlaywrightKey("space"), "Space");
  assert.equal(toPlaywrightKey("delete"), "Backspace");
  assert.equal(toPlaywrightKey("down"), "ArrowDown");
  assert.equal(toPlaywrightKey("left"), "ArrowLeft");
  assert.equal(toPlaywrightKey("home"), "Home");
  assert.equal(toPlaywrightKey("pagedown"), "PageDown");
  assert.equal(toPlaywrightKey("z", ["cmd", "shift"]), "ControlOrMeta+Shift+z");
  assert.equal(toPlaywrightKey("a", ["alt", "ctrl"]), "Alt+Control+a");
});

function fakeBrowser() {
  const pressed = [];
  const typed = [];
  const toasts = [];
  const page = {
    keyboard: { press: async (k) => pressed.push(k), type: async (t) => typed.push(t) },
    url: () => "https://example.com/",
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
  };
  return {
    pressed,
    typed,
    toasts,
    page,
    ensurePage: async () => page,
    overlay: async (fn, ...a) => fn === "toast" && toasts.push(a[0]),
  };
}

test("execute: press_key repeats, shortcut subset works, the rest says why it cannot", async () => {
  const b = fakeBrowser();
  assert.equal((await execute({ type: "press_key", key: "down", mods: [], count: 3, label: "down" }, b)).ok, true);
  assert.deepEqual(b.pressed, ["ArrowDown", "ArrowDown", "ArrowDown"]);
  b.pressed.length = 0;
  await execute({ type: "shortcut", id: "redo", char: "z", shift: true }, b);
  await execute({ type: "shortcut", id: "copy", char: "c" }, b);
  assert.deepEqual(b.pressed, ["ControlOrMeta+Shift+z", "ControlOrMeta+c"]);
  assert.deepEqual(await execute({ type: "shortcut", id: "save", char: "s" }, b), { ok: false, detail: "not available in the browser window" });
  for (const type of ["window_op", "volume", "quit_app", "send_keys"]) {
    assert.deepEqual(await execute({ type }, b), { ok: false, detail: "desktop mode only" });
  }
});

test("execute: calculate shows the result, typing without a target uses the keyboard focus", async () => {
  const b = fakeBrowser();
  assert.equal((await execute({ type: "calculate", label: "7 + 6 = 13" }, b)).ok, true);
  assert.deepEqual(b.toasts, ["7 + 6 = 13"]);
  await execute({ type: "type_into_field", targetId: null, text: "ciao", submit: true, label: "the focused field" }, b);
  assert.deepEqual(b.typed, ["ciao"]);
  assert.deepEqual(b.pressed, ["Enter"]);
});
