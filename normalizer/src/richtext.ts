// Renders at.linkedopendata.richtext#text (plain text + facets) as HTML with RDFa
// (proposal §3 rule 7, §6.4 item 5). Mirror rule: a #property span becomes RDFa only
// when the record makes that statement, so the RDFa never adds triples.
import { entityIri } from "./index.ts";

export const PROPERTY_FEATURE = "at.linkedopendata.richtext#property";
const LINK = "app.bsky.richtext.facet#link";
const MENTION = "app.bsky.richtext.facet#mention";

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<Record<string, unknown>>;
}

/** Object of a statement: an IRI, or a literal (the span's text). */
export type Obj = { iri: string } | { literal: string };

export interface RenderOptions {
  lodBase: string;
  /** IRI of the record: the subject of the restated statements. */
  subject: string;
  /** Whether the record states (subject, property, object). */
  holds: (property: string, object: Obj) => boolean;
  /** Display form of property IRIs in RDFa attributes (e.g. CURIEs); default: as is. */
  curie?: (iri: string) => string;
  /** Link target for a DID. */
  accountHref?: (did: string) => string;
  /** Link target for an IRI (e.g. host-relative); the RDF object stays the IRI. Default: the IRI. */
  href?: (iri: string) => string;
}

/** Link targets allowed in rendered HTML (§9): no javascript:, data:, etc. */
const safeHref = (uri: string) => /^(https?:|at:|did:)/i.test(uri);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** IRI of a reference in the Linked Data view (§6.3, §6.7). */
function refIri(lodBase: string, ref: { uri?: unknown; cid?: unknown }): string | undefined {
  if (typeof ref.uri !== "string") return undefined;
  if (!ref.uri.startsWith("at://")) return ref.uri;
  return entityIri(lodBase, ref.uri, typeof ref.cid === "string" ? ref.cid : undefined);
}

function wrap(inner: string, spanText: string, features: Facet["features"], o: RenderOptions): string {
  let html = inner;
  for (const f of features) {
    if (f.$type === PROPERTY_FEATURE && typeof f.property === "string") {
      const ref = f.ref as { uri?: unknown; cid?: unknown } | undefined;
      const iri = ref ? refIri(o.lodBase, ref) : undefined;
      if (iri && !safeHref(iri)) continue;
      const obj: Obj = iri ? { iri } : { literal: spanText };
      const prop = esc((o.curie ?? ((x) => x))(f.property));
      if (!o.holds(f.property, obj)) {
        html = `<span class="unstated" title="${esc(`not stated by the record: ${f.property}`)}">${html}</span>`;
      } else if (iri) {
        const href = o.href?.(iri) ?? iri;
        html =
          href === iri
            ? `<a property="${prop}" href="${esc(iri)}">${html}</a>`
            : `<a property="${prop}" resource="${esc(iri)}" href="${esc(href)}">${html}</a>`;
      } else {
        html = `<span property="${prop}">${html}</span>`;
      }
    } else if (f.$type === LINK && typeof f.uri === "string" && safeHref(f.uri)) {
      html = `<a href="${esc(f.uri)}">${html}</a>`;
    } else if (f.$type === MENTION && typeof f.did === "string") {
      html = `<a href="${esc(o.accountHref?.(f.did) ?? f.did)}">${html}</a>`;
    }
  }
  return html;
}

/**
 * Inner HTML for a text item. Its text content equals `text`, so an enclosing
 * <span property="sioc:content"> yields the plain text; the restated statements sit
 * in a <span resource="‹subject›">, which makes the record their subject.
 */
export function renderRichText(text: string, facets: Facet[] | undefined, o: RenderOptions): string {
  const bytes = Buffer.from(text, "utf8");
  const decode = (a: number, b: number) => bytes.subarray(a, b).toString("utf8");
  const sorted = [...(facets ?? [])]
    .filter((f) => f.index && f.index.byteStart >= 0 && f.index.byteEnd <= bytes.length && f.index.byteStart < f.index.byteEnd)
    .sort((a, b) => a.index.byteStart - b.index.byteStart);
  let out = "";
  let pos = 0;
  for (const f of sorted) {
    if (f.index.byteStart < pos) continue; // overlapping facets: keep the first
    out += esc(decode(pos, f.index.byteStart));
    const spanText = decode(f.index.byteStart, f.index.byteEnd);
    out += wrap(esc(spanText), spanText, f.features ?? [], o);
    pos = f.index.byteEnd;
  }
  out += esc(decode(pos, bytes.length));
  return `<span resource="${esc(o.subject)}">${out}</span>`;
}
