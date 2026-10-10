import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRichText, PROPERTY_FEATURE, type Obj } from "../src/richtext.ts";
import { RICHTEXT } from "../src/index.ts";

const BASE = "https://w3id.org/at-lod";
const SUBJECT = `${BASE}/at/did:plc:abc/science.mira.claim/3k2x#it`;
const SUPPORTS = "http://purl.org/mira-science/mira#supports";
const TITLE = "http://purl.org/dc/terms/title";
const target = { uri: "at://did:plc:ghi/science.mira.claim/3h7r", cid: "bafyreiC1" };
const pinned = `${BASE}/at/did:plc:ghi/science.mira.claim/3h7r/bafyreiC1#it`;

const span = (text: string, part: string) => {
  const start = Buffer.from(text.slice(0, text.indexOf(part))).length;
  return { byteStart: start, byteEnd: start + Buffer.from(part).length };
};
const textContent = (html: string) =>
  html.replace(/<[^>]*>/g, "").replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));

const text = "Ça soutient la claim de base, voir figure 2.";
const facets = [
  { index: span(text, "soutient la claim de base"), features: [{ $type: PROPERTY_FEATURE, property: SUPPORTS, ref: target }] },
  { index: span(text, "figure 2"), features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.org/fig2" }] },
];

test("a facet that restates the record becomes RDFa; text content is the plain text", () => {
  const holds = (p: string, o: Obj) => p === SUPPORTS && "iri" in o && o.iri === pinned;
  const html = renderRichText(text, facets, { lodBase: BASE, subject: SUBJECT, holds });
  assert.ok(html.includes(`<a property="${SUPPORTS}" href="${pinned}">soutient la claim de base</a>`), html);
  assert.ok(html.includes(`<a href="https://example.org/fig2">figure 2</a>`));
  assert.ok(html.startsWith(`<span resource="${SUBJECT}">`));
  assert.equal(textContent(html), text, "non-ASCII byte offsets are handled");
});

test("a facet the record does not state is rendered without RDFa (mirror rule)", () => {
  const html = renderRichText(text, facets, { lodBase: BASE, subject: SUBJECT, holds: () => false });
  assert.ok(!html.includes("property="), html);
  assert.ok(html.includes('class="unstated"'));
  assert.equal(textContent(html), text);
});

test("a literal facet restates a literal value", () => {
  const t = "Title: CLM - X";
  const f = [{ index: span(t, "CLM - X"), features: [{ $type: PROPERTY_FEATURE, property: TITLE }] }];
  const holds = (p: string, o: Obj) => p === TITLE && "literal" in o && o.literal === "CLM - X";
  const html = renderRichText(t, f, { lodBase: BASE, subject: SUBJECT, holds });
  assert.ok(html.includes(`<span property="${TITLE}">CLM - X</span>`), html);
});

test("RICHTEXT is the lexicon def name", () => {
  assert.equal(RICHTEXT, "at.linkedopendata.richtext#text");
});

test("unsafe link schemes are not rendered as links (§9)", () => {
  const t = "click here";
  const f = [{ index: { byteStart: 0, byteEnd: 10 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "javascript:alert(1)" }] }];
  const html = renderRichText(t, f, { lodBase: BASE, subject: SUBJECT, holds: () => true });
  assert.ok(!html.includes("href"), html);
  const tricky = renderRichText('<b onclick="x">', [], { lodBase: BASE, subject: SUBJECT, holds: () => true });
  assert.ok(!tricky.includes("<b"), "text is escaped");
});
