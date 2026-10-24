import { test } from "node:test";
import assert from "node:assert/strict";
import { compactElements, detectSite, findSearchBox, approxTokens } from "../../src/snapshot.js";
import { buildRequest, encodeElement } from "../../src/jev.js";
import { MAX_ELEMENTS, MAX_STATE_CHARS } from "../../src/constants.js";

const raw = (i, over = {}) => ({
  id: `e${String(i).padStart(2, "0")}`,
  tag: "a",
  role: "link",
  text: `Link number ${i}`,
  placeholder: "",
  href: `example.com/${i}`,
  type: "",
  inputName: "",
  inViewport: i % 2 === 0,
  top: i * 20,
  left: 0,
  ...over,
});

test("compactElements: viewport-visible first, then by position", () => {
  const els = [raw(1, { inViewport: false, top: 10 }), raw(2, { inViewport: true, top: 500 }), raw(3, { inViewport: true, top: 100 })];
  const out = compactElements(els);
  assert.deepEqual(
    out.map((e) => e.id),
    ["e03", "e02", "e01"],
  );
  assert.equal(out[2].below_fold, true);
  assert.equal(out[0].below_fold, undefined);
});

test("compactElements: dedupes identical (role, text, href) and drops nameless non-inputs", () => {
  const els = [raw(1), raw(2, { text: "Link number 1", href: "example.com/1" }), raw(3, { text: "", href: "" }), raw(4, { role: "textbox", tag: "input", text: "", placeholder: "" })];
  const out = compactElements(els);
  assert.deepEqual(
    out.map((e) => e.id),
    ["e02", "e04"], // in-viewport (even ids) first, by position; e01 duplicates e02 (seen first); e03 nameless link removed
  );
});

test("compactElements: truncates long text and caps count", () => {
  const els = Array.from({ length: 400 }, (_, i) => raw(i + 1, { text: "x".repeat(300) + i }));
  const out = compactElements(els);
  assert.ok(out.length <= MAX_ELEMENTS);
  assert.ok(out.every((e) => e.text.length <= 60));
});

test("compactElements: state size guard keeps the serialized list under budget", () => {
  const els = Array.from({ length: 250 }, (_, i) => raw(i + 1, { text: `Unique headline ${i} ` + "lorem ipsum dolor ".repeat(3), href: `site${i}.example.com/path/${i}` }));
  const out = compactElements(els, { maxChars: 3000 });
  assert.ok(JSON.stringify(out).length <= 3000, "shrunk to fit");
  assert.ok(out.length >= 5);
});

test("buildRequest: full state stays far below the 32k-token limit even with the max element list", () => {
  const els = Array.from({ length: 400 }, (_, i) => raw(i + 1, { text: `Some fairly long link label number ${i} about a topic`, href: `news.example.com/story/${i}` }));
  const snapshot = { url: "https://news.example.com/", title: "News", site: "generic", elements: compactElements(els) };
  const { state, questions } = buildRequest({ transcript: "click the first story", snapshot });
  assert.ok(JSON.stringify(state).length <= MAX_STATE_CHARS);
  assert.ok(approxTokens(state) < 8000, `state ~${approxTokens(state)} tokens`);
  assert.ok(Object.keys(questions.target.criteria).length <= MAX_ELEMENTS + 1);
  assert.equal(questions.target.criteria.none !== undefined, true);
  assert.equal(state.elements.length, snapshot.elements.length);
  assert.ok(state.elements[0].startsWith("e02 link"), state.elements[0]);
});

test("buildRequest: text_span / url_span only present when there are candidates; options are verbatim", () => {
  const snapshot = { url: "about:blank", title: "", site: "blank", elements: [] };
  const a = buildRequest({ transcript: "scroll down", snapshot });
  assert.equal(a.questions.url_span, undefined);
  const b = buildRequest({ transcript: "type hello world into the search box", snapshot });
  assert.ok("hello world" in b.questions.text_span.criteria);
  assert.ok("none" in b.questions.text_span.criteria);
  const c = buildRequest({ transcript: "open example dot com", snapshot });
  assert.ok("example.com" in c.questions.url_span.criteria);
});

test("encodeElement: compact line with host only when it differs from the page", () => {
  assert.equal(encodeElement({ id: "e09", role: "link", text: "GitHub", href: "github.com/x" }, "duckduckgo.com"), 'e09 link "GitHub" → github.com');
  assert.equal(encodeElement({ id: "e03", role: "link", text: "new", href: "news.ycombinator.com/newest" }, "news.ycombinator.com"), 'e03 link "new"');
  assert.equal(encodeElement({ id: "e02", role: "textbox", text: "", placeholder: "Search Wikipedia" }), "e02 textbox (placeholder: Search Wikipedia)");
});

test("detectSite", () => {
  assert.equal(detectSite("https://en.wikipedia.org/wiki/Main_Page"), "wikipedia");
  assert.equal(detectSite("https://news.ycombinator.com/newest"), "hacker_news");
  assert.equal(detectSite("https://www.google.com/search?q=x"), "google");
  assert.equal(detectSite("https://example.com/"), "example_com");
  assert.equal(detectSite("https://foo.bar.baz/"), "generic");
  assert.equal(detectSite("about:blank"), "blank");
});

test("findSearchBox prefers role=searchbox / search-ish names", () => {
  const els = [
    raw(1, { role: "textbox", tag: "input", inputName: "username", text: "", placeholder: "Username" }),
    raw(2, { role: "textbox", tag: "input", inputName: "search", text: "", placeholder: "Search Wikipedia" }),
    raw(3, { role: "link" }),
  ];
  assert.equal(findSearchBox(els), "e02");
  assert.equal(findSearchBox([raw(3)]), null);
});

// --- desktop / browser-window additions --------------------------------------------------------
import { isBrowserApp } from "../../src/snapshot.js";

test("findSearchBox: the browser omnibox is never the page search box (diagnosed Chrome in Italian)", () => {
  const els = [
    raw(1, { role: "textbox", tag: "input", text: "Barra degli indirizzi e di ricerca", placeholder: "", inputName: "", top: 80, inViewport: true, web: false }),
    raw(2, { role: "combobox", tag: "input", text: "", placeholder: "Cerca", inputName: "", top: 150, inViewport: true, web: true }),
  ];
  assert.equal(findSearchBox(els), "e02");
  assert.equal(findSearchBox(els, { webOnly: true }), "e02");
  // even without any web flags the address bar is excluded
  const noFlags = els.map(({ web, ...e }) => e);
  assert.equal(findSearchBox(noFlags), "e02");
  assert.equal(findSearchBox(noFlags.slice(0, 1)), null);
});

test("findSearchBox: webOnly ignores toolbar inputs, but a Finder-like searchbox is found without it", () => {
  const toolbar = raw(1, { role: "searchbox", tag: "input", text: "Search", web: false, inViewport: true });
  assert.equal(findSearchBox([toolbar], { webOnly: true }), null);
  assert.equal(findSearchBox([toolbar], { webOnly: false }), "e01");
  assert.equal(findSearchBox([toolbar]), "e01");
});

test("findSearchBox: bilingual detection", () => {
  for (const placeholder of ["Cerca", "Cerca su Wikipedia", "Ricerca", "Trova", "Search", "Find", "Query"]) {
    const els = [raw(1, { role: "textbox", tag: "input", text: "", placeholder, web: true })];
    assert.equal(findSearchBox(els, { webOnly: true }), "e01", placeholder);
  }
  assert.equal(findSearchBox([raw(1, { role: "textbox", tag: "input", text: "", placeholder: "Nome", web: true })]), null);
  assert.equal(findSearchBox([raw(1, { role: "textbox", tag: "input", text: "", placeholder: "Search or enter URL", web: false })]), null, "URL bar wording");
});

test("detectSite: new sites and Google properties", () => {
  assert.equal(detectSite("https://www.google.it/search?q=x"), "google");
  assert.equal(detectSite("https://www.google.com/maps/place/Roma"), "google_maps");
  assert.equal(detectSite("https://maps.google.com/"), "google_maps");
  assert.equal(detectSite("https://mail.google.com/mail/u/0/"), "gmail");
  assert.equal(detectSite("https://www.amazon.it/s?k=x"), "amazon");
  assert.equal(detectSite("https://it.wikipedia.org/wiki/Roma"), "wikipedia");
  assert.equal(detectSite("https://www.linkedin.com/feed/"), "linkedin");
  assert.equal(detectSite("https://www.netflix.com/browse"), "netflix");
  assert.equal(detectSite("https://open.spotify.com/"), "spotify");
  assert.equal(detectSite("https://stackoverflow.com/questions"), "stackoverflow");
  assert.equal(detectSite("https://www.facebook.com/"), "facebook");
  assert.equal(detectSite("https://www.instagram.com/"), "instagram");
});

test("isBrowserApp: bundle prefix or app name", () => {
  assert.equal(isBrowserApp({ app: "Google Chrome", bundle: "com.google.Chrome" }), true);
  assert.equal(isBrowserApp({ app: "Whatever", bundle: "com.google.Chrome.canary" }), true);
  assert.equal(isBrowserApp({ app: "Safari", bundle: "" }), true);
  assert.equal(isBrowserApp({ app: "Arc" }), true);
  assert.equal(isBrowserApp({ app: "Brave Browser", bundle: "com.brave.Browser" }), true);
  assert.equal(isBrowserApp({ app: "Finder", bundle: "com.apple.finder" }), false);
  assert.equal(isBrowserApp({}), false);
  assert.equal(isBrowserApp(), false);
});

test("compactElements preferWeb: web elements survive the cap, output stays in visual order, no web field", () => {
  const els = [
    ...Array.from({ length: 6 }, (_, i) => raw(i + 1, { text: `Toolbar ${i}`, href: "", top: i * 10, inViewport: true, web: false })),
    ...Array.from({ length: 4 }, (_, i) => raw(i + 11, { text: `Page ${i}`, href: `x.com/${i}`, top: 100 + i * 10, inViewport: true, web: true })),
  ];
  const plain = compactElements(els, { maxElements: 5 });
  assert.ok(plain.every((e) => e.text.startsWith("Toolbar") || e.text.startsWith("Page")));
  assert.equal(plain.filter((e) => e.text.startsWith("Page")).length, 0, "without preferWeb the top of the window wins");
  const out = compactElements(els, { maxElements: 5, preferWeb: true });
  assert.equal(out.length, 5);
  assert.equal(out.filter((e) => e.text.startsWith("Page")).length, 4);
  const tops = out.map((e) => els.find((r) => r.id === e.id).top);
  assert.deepEqual(tops, [...tops].sort((a, b) => a - b), "visual order");
  assert.ok(out.every((e) => !("web" in e)));
});
