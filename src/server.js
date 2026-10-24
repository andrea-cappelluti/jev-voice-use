/**
 * Node server: serves the control page, bridges WebSocket <-> Controller, owns the API key.
 *
 *   node src/server.js [--port 8787] [--host 127.0.0.1] [--lang it-IT]
 *                      [--browser [--headless] [--cdp ws://127.0.0.1:9222/devtools/browser/...] [--start-url https://...]]
 *
 * On macOS the default is desktop mode: the whole Mac is controlled, and the microphone is switched
 * on / off with a global hotkey. `--browser` (implied by --headless / --cdp, and the only mode on
 * other platforms) controls one Playwright Chromium window and takes speech from the control page.
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { BrowserManager } from "./browser.js";
import { DesktopManager, executeDesktop } from "./desktop.js";
import { Controller } from "./controller.js";
import { hasApiKey } from "./jev.js";
import { MODEL, QUESTIONS, DESKTOP_QUESTIONS, HOTKEY, T } from "./constants.js";
import { normalizeLocale, detectSystemLocale } from "./locale.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const out = {
    port: Number(process.env.PORT) || 8787,
    // Bind to loopback only by default: anyone who can reach this port can drive the browser
    // and spend your API credits. Use --host 0.0.0.0 deliberately if you need LAN access.
    host: process.env.HOST || "127.0.0.1",
    browser: false,
    headless: false,
    cdp: null,
    startUrl: "https://example.com/",
    lang: null, // resolved later (resolveLang): --lang, then VB_LANG, then the macOS system locale
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--browser") out.browser = true;
    else if (a === "--headless") out.headless = true;
    else if (a === "--cdp") out.cdp = argv[++i];
    else if (a === "--start-url") out.startUrl = argv[++i];
    else if (a === "--lang") out.lang = argv[++i];
  }
  return out;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Browsers send Origin on every WebSocket handshake, so only the control page itself may connect: any other
 * site you visit could otherwise drive the Mac. Clients without an Origin (scripts, tests) are not browsers.
 */
export function isTrustedOrigin(origin, host, bindHost) {
  if (!origin) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.host !== host) return false;
  // Bound to loopback, a foreign name can only reach us through DNS rebinding.
  return !LOOPBACK.has(bindHost) || LOOPBACK.has(url.hostname);
}

/** Recognizer locale: --lang, else $VB_LANG, else the system locale. Commands are bilingual either way. */
export function resolveLang(arg, env = process.env) {
  return normalizeLocale(arg || env.VB_LANG || detectSystemLocale());
}

const hotkeyLabel = HOTKEY.split("+")
  .map((k) => ({ ctrl: "Ctrl", alt: "Option", cmd: "Cmd", shift: "Shift" })[k] || k.toUpperCase())
  .join("+");

/** Desktop mode: start the native helper and feed its microphone transcripts to the controller. */
async function startDesktop(opts, lang) {
  const desktop = new DesktopManager();
  const ready = await desktop.launch({ lang });
  const controller = new Controller({ browser: desktop, executeFn: executeDesktop, lang });

  desktop.on("transcript", (m) => controller.handleTranscript({ text: m.text, final: Boolean(m.final), utteranceId: m.utteranceId }));
  desktop.on("mic", (m) => controller._log(m.error ? "error" : "info", m.error ? `microphone off — ${m.error}` : `microphone ${m.on ? "on" : "off"}`));
  desktop.on("speech_error", (m) => controller._log("error", `speech recognition: ${m.error}`));
  desktop.on("snapshot_error", (e) => controller._log("error", `reading the screen failed: ${e}`));
  desktop.on("ax", (m) => controller._log("info", `accessibility permission ${m.trusted ? "granted" : "revoked"}`));
  desktop.on("exit", (code) => {
    console.error(`native helper exited (code ${code})`);
    process.exit(1);
  });
  // There is no page to look at in this mode, so the terminal doubles as the action log.
  controller.on("log", (e) => e.level !== "debug" && console.log(`${new Date(e.t).toLocaleTimeString([], { hour12: false })} ${e.msg}`));
  return { browser: desktop, controller, ready };
}

export async function startServer(opts = {}) {
  if (!hasApiKey()) {
    console.error("Missing TYPESAFE_API_KEY (or JEV_API_KEY). Use ./run.sh or export it first.");
    process.exit(1);
  }
  const lang = resolveLang(opts.lang);
  const desktopMode = process.platform === "darwin" && !opts.browser && !opts.headless && !opts.cdp;
  let browser, controller, ready;
  if (desktopMode) {
    ({ browser, controller, ready } = await startDesktop(opts, lang));
  } else {
    browser = new BrowserManager();
    await browser.launch({ headless: opts.headless, cdp: opts.cdp, startUrl: opts.startUrl });
    controller = new Controller({ browser, lang });
  }
  await controller.start();

  const app = express();
  app.use(express.static(path.join(__dirname, "public")));
  app.get("/api/state", (_req, res) => res.json(controller.uiState()));
  app.get("/api/questions", (_req, res) => res.json({ model: MODEL, thresholds: T, questions: desktopMode ? DESKTOP_QUESTIONS : QUESTIONS }));

  const host = opts.host || "127.0.0.1";
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, verifyClient: ({ origin, req }) => isTrustedOrigin(origin, req.headers.host, host) });

  const broadcast = (type, payload) => {
    const msg = JSON.stringify({ type, payload });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  };

  controller.on("transcript", (p) => broadcast("transcript", p));
  controller.on("decision", (p) => broadcast("decision", p));
  controller.on("action", (p) => broadcast("action", { ...p, ui: controller.uiState() }));
  controller.on("snapshot", () => broadcast("snapshot", controller.uiState().snapshot));
  controller.on("log", (p) => broadcast("log", p));
  controller.on("candidates", (p) => broadcast("candidates", p));
  controller.on("pending", (p) => broadcast("pending", p));
  controller.on("tabs", (p) => broadcast("tabs", p));
  controller.on("lang", (p) => broadcast("lang", p));
  controller.on("unclear", (p) => broadcast("unclear", p));

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "hello", payload: controller.uiState() }));
    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case "transcript":
          controller.handleTranscript({ text: msg.text, final: Boolean(msg.final), utteranceId: msg.utteranceId });
          break;
        case "command":
          controller.handleCommand(msg.text);
          break;
        case "undo":
          controller.undo();
          break;
        case "snapshot":
          controller.refreshSnapshot();
          break;
        case "state":
          ws.send(JSON.stringify({ type: "hello", payload: controller.uiState() }));
          break;
        default:
          break;
      }
    });
  });

  await new Promise((resolve) => server.listen(opts.port, host, resolve));
  const url = `http://localhost:${opts.port}`;
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.warn(`WARNING: listening on ${host} — anyone who can reach this port can control the browser and spend API credits.`);
  }
  if (desktopMode) {
    console.log(`\nvoice-browser ready — controlling this Mac · model ${MODEL} · language ${lang}`);
    console.log(
      ready.hotkey
        ? `press ${hotkeyLabel} anywhere to switch the microphone on / off, then speak (${lang})`
        : `WARNING: could not register ${hotkeyLabel} (taken by another app?) — type commands in the dashboard instead`,
    );
    if (!ready.axTrusted) {
      console.log("\nWARNING: Accessibility permission is missing, so clicking, typing and scrolling will not work yet.");
      console.log("Enable your terminal app in System Settings → Privacy & Security → Accessibility (no restart needed).");
    }
    console.log(`dashboard (optional): ${url}\n`);
  } else {
    console.log(`\nvoice-browser ready → open ${url} in Chrome (mic needs Chrome/Edge)`);
    console.log(`model ${MODEL} · language ${lang} (Italian + English commands) · controlled window: ${opts.cdp ? "attached via CDP" : opts.headless ? "headless" : "headed Chromium"}\n`);
  }

  const shutdown = async () => {
    await controller.close();
    await browser.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { app, server, controller, browser, url };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
