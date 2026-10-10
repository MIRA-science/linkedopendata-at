// What every broker shares (§6.4): content negotiation, and the HTML view of a JSON-LD
// document, as RDFa that restates (a subset of) its graph. Subclasses say where documents
// come from (resolve), how their contexts load, and how their IRIs are labelled and linked.
import type { IncomingMessage, ServerResponse } from "node:http";
import jsonld from "jsonld";
import type { Obj } from "../normalizer/src/richtext.ts";

export type Node = Record<string, unknown>;
export type Doc = { "@context": unknown; "@graph": Node[] };
/** Page heading for the HTML view; sub is HTML. */
export type Heading = { title: string; sub: string };
/**
 * A resolved document. main: the IRI of the thing the page is about, when the default
 * HTML view should show that node alone (record pages); otherwise every node is shown.
 */
export type Result = { status: number; doc?: Doc; headers?: Record<string, string>; heading?: Heading; main?: string };
export type Expanded = { "@id"?: string; "@value"?: unknown; "@type"?: string; "@language"?: string };
export type Loaded = { contextUrl: null; documentUrl: string; document: unknown };
/** What a text renderer may need: the document, the mirror rule, and CURIE abbreviation. */
export type TextContext = { doc: Doc; holds: (property: string, obj: Obj) => boolean; curie: (iri: string) => string };

export const XSD = "http://www.w3.org/2001/XMLSchema#";
export const FOAF_TOPIC = "http://xmlns.com/foaf/0.1/primaryTopic";
export const DCT_TITLE = "http://purl.org/dc/terms/title";
export const DCT_DESCRIPTION = "http://purl.org/dc/terms/description";
export const DCT_FORMAT = "http://purl.org/dc/terms/format";
export const SIOC_CONTENT = "http://rdfs.org/sioc/ns#content";

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Remote contexts, kept for ttl milliseconds: a source that corrects its context is read
 * again without a restart. A failed fetch is not kept.
 */
export class ContextCache {
  ttl: number;
  entries = new Map<string, { at: number; document: Promise<unknown> }>();

  constructor(ttl = 300_000) {
    this.ttl = ttl;
  }

  /** The caller checks that the host is allowed. */
  async load(url: string): Promise<Loaded> {
    let entry = this.entries.get(url);
    if (!entry || Date.now() - entry.at >= this.ttl) {
      const document = fetch(url, { headers: { accept: "application/ld+json, application/json" } }).then((r) => {
        if (!r.ok) throw new Error(`${r.status} for context ${url}`);
        return r.json();
      });
      entry = { at: Date.now(), document };
      this.entries.set(url, entry);
      document.catch(() => this.entries.get(url) === entry && this.entries.delete(url));
    }
    return { contextUrl: null, documentUrl: url, document: await entry.document };
  }
}

// Shown only in the full view: identity and structure, which the JSON-LD carries anyway.
const PLUMBING = new Set([
  "http://www.w3.org/2002/07/owl#sameAs",
  ...["id", "link", "has_space", "has_container", "latest_version"].map((n) => `http://rdfs.org/sioc/ns#${n}`),
]);

const STYLE = [
  "body{font-family:system-ui;max-width:60rem;margin:2rem auto;padding:0 1rem}",
  "th{text-align:left;padding-right:1rem;vertical-align:top;font-weight:normal;color:#555}",
  "td{font-family:monospace;word-break:break-all}",
  "table.values td{font-family:system-ui;word-break:normal}",
  "h2{font-size:1rem}section{border-top:1px solid #ddd;padding:.5rem 0}",
  ".text{font-family:system-ui;font-size:1.05rem;line-height:1.5;margin-top:1rem}",
  ".text [property]{background:#eef4ff}.text [content]{background:none}.unstated{text-decoration:underline dotted #b00}",
  "header p{color:#555}",
  "button.copy{font-size:.8rem;padding:0 .4rem;margin-left:.2rem;cursor:pointer}",
  ".banner{display:block;margin-top:.5rem;background:#fff4e0;border-left:4px solid #e0a000;padding:.5rem 1rem;color:#333}",
].join("");

export function send(res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": type, vary: "accept", "access-control-allow-origin": "*", ...headers });
  res.end(body);
}

export type Links = { lodBase: string; endpoint: string; relative: boolean };

export abstract class Broker {
  lodBase: string;
  endpoint: string;
  /** Links and broker URLs without scheme and host, for a reverse proxy (IRIs stay absolute). */
  relative: boolean;

  constructor(links: Links) {
    this.lodBase = links.lodBase;
    this.endpoint = links.endpoint;
    this.relative = links.relative;
  }

  /** The document at a path of this broker. */
  abstract resolve(path: string, query: URLSearchParams): Promise<Result>;
  /** Loads the contexts of the documents this broker serves. */
  abstract documentLoader(url: string): Promise<Loaded>;
  /** Static JSON-LD this broker serves at path (contexts), if any. */
  async asset(_path: string): Promise<object | undefined> {
    return undefined;
  }
  /** Short label for an IRI on a page; undefined to show its CURIE. */
  label(_iri: string, _path: string): string | undefined {
    return undefined;
  }
  /** Navigation target (href) for an IRI. The RDF object stays the IRI itself. */
  href(iri: string): string {
    return this.nav(iri);
  }
  /**
   * The content of a text item, as an element whose RDFa states its sioc:content, or
   * undefined. By default: HTML content (dct:format text/html) is embedded as is, and the
   * literal is restated in a content attribute, so that the RDFa matches the JSON-LD.
   * Proof of concept: neither sanitized (§9) nor checked against the mirror rule.
   */
  contentHtml(_id: string, node: Node, cx: TextContext): string | undefined {
    const content = (node[SIOC_CONTENT] as Expanded[] | undefined)?.[0]?.["@value"];
    const html = ((node[DCT_FORMAT] as Expanded[] | undefined) ?? []).some((f) => f["@value"] === "text/html");
    if (typeof content !== "string" || !html) return undefined;
    return `<div property="${esc(cx.curie(SIOC_CONTENT))}" content="${esc(content)}">${content}</div>`;
  }

  /** URL of a broker resource, in documents and headers: host-relative in relative mode. */
  brokerUrl(path: string): string {
    return this.relative ? path : this.endpoint + path;
  }
  /** IRIs of ours, host-relative in relative mode. */
  nav(iri: string): string {
    if (this.relative) for (const origin of [this.lodBase, this.endpoint]) if (iri.startsWith(origin + "/")) return iri.slice(origin.length);
    return iri;
  }
  link(href: string, text: string): string {
    return `<a href="${esc(this.href(href))}">${esc(text)}</a>`;
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname;
    const asset = await this.asset(path);
    if (asset) return send(res, 200, "application/ld+json", JSON.stringify(asset));
    const r = await this.resolve(path, url.searchParams);
    const accept = req.headers.accept ?? "";
    const wantsHtml = /text\/html/.test(accept) && !/application\/ld\+json/.test(accept);
    if (!r.doc) return send(res, r.status, "text/plain", r.status === 303 ? "See Other\n" : "Not Found\n", r.headers);
    if (wantsHtml) {
      const full = url.searchParams.get("full") === "true";
      return send(res, r.status, "text/html; charset=utf-8", await this.html(path, r, full), r.headers);
    }
    return send(res, r.status, "application/ld+json", JSON.stringify(r.doc, null, 2), r.headers);
  }

  /** Prefixes declared by the document's contexts, for the RDFa prefix attribute and for display. */
  async prefixes(doc: Doc, base: string): Promise<[string, string][]> {
    const map = new Map<string, string>();
    const add = async (c: unknown): Promise<void> => {
      if (typeof c === "string") return add(((await this.documentLoader(new URL(c, base).href)).document as Node)["@context"]);
      if (Array.isArray(c)) for (const x of c) await add(x);
      else if (c && typeof c === "object") {
        for (const [k, v] of Object.entries(c)) if (typeof v === "string" && /^[A-Za-z_][\w.-]*$/.test(k) && /[#/]$/.test(v)) map.set(k, v);
      }
    };
    await add(doc["@context"]);
    return [...map].sort((a, b) => b[1].length - a[1].length); // longest namespace first
  }

  /**
   * HTML view (§6.4). Default, for pages with a main node: its title, its own values, and its
   * rendered description, like the Discourse Graphs content pages. With ?full=true (and for
   * other pages): every node of the graph. Both embed the complete JSON-LD.
   */
  async html(path: string, r: Result, full: boolean): Promise<string> {
    const doc = r.doc!;
    const heading = r.heading!;
    const json = JSON.stringify(doc, null, 2).replace(/</g, "\\u003c");
    const base = this.endpoint + path;
    const pfx = await this.prefixes(doc, base);
    const curie = (iri: string) => {
      const hit = pfx.find(([, ns]) => iri.startsWith(ns) && /^[\w.-]*$/.test(iri.slice(ns.length)));
      return hit ? `${hit[0]}:${iri.slice(hit[1].length)}` : iri;
    };
    // Relative URLs in the document (contexts, the document's own @id) resolve against the page.
    const loader = (url: string) => this.documentLoader(url);
    const flat = (await jsonld.flatten(doc, null, { documentLoader: loader, base })) as Node[];
    /** IRI as written in RDFa: the page's own document URLs stay host-relative in relative mode. */
    const name = (id: string) => (this.relative && id.startsWith(this.endpoint + "/") ? id.slice(this.endpoint.length) : id);
    const value = (p: string, v: Expanded) => {
      const prop = esc(curie(p));
      if (v["@id"] !== undefined) {
        const id = v["@id"];
        const text = esc(this.label(id, path) ?? curie(id));
        // Values are user data: only safe schemes become links (§9); the triple stays.
        if (!/^(https?:|at:|did:)/i.test(id)) return `<span property="${prop}" resource="${esc(name(id))}">${text}</span>`;
        const href = this.href(id);
        if (href !== id) return `<a property="${prop}" resource="${esc(name(id))}" href="${esc(href)}" title="${esc(id)}">${text}</a>`;
        return `<a property="${prop}" href="${esc(id)}" title="${esc(id)}">${text}</a>`;
      }
      const text = esc(String(v["@value"]));
      const lang = v["@language"] ? ` lang="${esc(v["@language"])}"` : "";
      // HTML+RDFa infers xsd:dateTime from <time>, but parsers differ on fractional
      // seconds, which ATProto timestamps usually have: so the datatype is explicit too.
      if (v["@type"] === XSD + "dateTime") return `<time property="${prop}" datetime="${text}" datatype="${esc(curie(v["@type"]))}">${text}</time>`;
      if (v["@type"]) return `<span property="${prop}" datatype="${esc(curie(v["@type"]))}">${text}</span>`;
      return `<span property="${prop}"${lang}>${text}</span>`;
    };
    const typesOf = (n: Node) => ((n["@type"] as string[] | undefined) ?? []).map(curie);
    const typeofAttr = (n: Node) => (typesOf(n).length ? ` typeof="${esc(typesOf(n).join(" "))}"` : "");
    // The primary topic first, then the main node, the document itself last.
    const docNode = flat.find((n) => FOAF_TOPIC in n);
    const topic = (docNode?.[FOAF_TOPIC] as Expanded[] | undefined)?.[0]?.["@id"];
    const rank = (n: Node) => (n["@id"] === topic ? 0 : n["@id"] === r.main ? 1 : n === docNode ? 3 : 2);
    flat.sort((a, b) => rank(a) - rank(b));
    const mainFlat = flat.find((n) => n["@id"] === r.main) ?? {};
    // Mirror rule: does the main node state (main, property, object)?
    const holds = (property: string, obj: Obj) =>
      ((mainFlat[property] as Expanded[] | undefined) ?? []).some((v) =>
        "iri" in obj ? v["@id"] === obj.iri : v["@id"] === undefined && v["@value"] === obj.literal,
      );
    const cx: TextContext = { doc, holds, curie };
    /** The rendered text of a text item; asSubject: the element itself names the item. */
    const textOf = (id: string, asSubject = false) => {
      const node = flat.find((n) => n["@id"] === id);
      const inner = node && this.contentHtml(id, node, cx);
      if (!inner) return undefined;
      const frag = id.includes("#") ? ` id="${esc(id.slice(id.indexOf("#") + 1))}"` : "";
      const about = asSubject ? ` resource="${esc(name(id))}"` : "";
      return { node: node!, html: `<div${frag}${about} class="text">${inner}</div>` };
    };
    const prefixAttr = pfx.map(([k, v]) => `${k}: ${v}`).join(" ");
    const page = (body: string) => `<!doctype html>
<html prefix="${esc(prefixAttr)}"><head><meta charset="utf-8"><title>${esc(heading.title)}</title>
<style>${STYLE}</style>
<script type="application/ld+json">
${json}
</script></head><body>
${body}
</body></html>`;

    if (r.main && !full) {
      // Light view: the main node only. Its RDFa is a subset of the JSON-LD graph.
      const titles = (mainFlat[DCT_TITLE] as Expanded[] | undefined) ?? [];
      const titleIsH1 = titles.length === 1 && titles[0]["@value"] === heading.title;
      const h1 = titleIsH1 ? `<h1 property="${esc(curie(DCT_TITLE))}">${esc(heading.title)}</h1>` : `<h1>${esc(heading.title)}</h1>`;
      const descriptions = (mainFlat[DCT_DESCRIPTION] as Expanded[] | undefined) ?? [];
      const localName = (p: string) => curie(p).replace(/^[^:]*:/, "");
      const rows = Object.entries(mainFlat)
        .filter(([p]) => !p.startsWith("@") && !PLUMBING.has(p) && p !== DCT_DESCRIPTION && !(p === DCT_TITLE && titleIsH1))
        .map(([p, vs]) => `<tr><th title="${esc(p)}">${esc(localName(p))}</th><td>${(vs as Expanded[]).map((v) => value(p, v)).join("<br>")}</td></tr>`);
      const blocks: string[] = [];
      for (const d of descriptions) {
        const id = d["@id"];
        const typed = !!id && typesOf(flat.find((n) => n["@id"] === id) ?? {}).length > 0;
        const text = id ? textOf(id, !typed) : undefined;
        if (text && id) {
          // Inline text: a node of its own. property + resource states the link, but only
          // typeof makes the item the subject of the content; an untyped item needs a
          // resource of its own on the text element.
          blocks.push(`<div property="${esc(curie(DCT_DESCRIPTION))}" resource="${esc(name(id))}"${typeofAttr(text.node)}>${text.html}</div>`);
        } else if (d["@id"]) {
          rows.push(`<tr><th title="${esc(DCT_DESCRIPTION)}">description</th><td>${value(DCT_DESCRIPTION, d)}</td></tr>`);
        } else {
          blocks.push(`<p class="text">${value(DCT_DESCRIPTION, d)}</p>`);
        }
      }
      return page(`<article resource="${esc(name(r.main))}"${typeofAttr(mainFlat)}>
<header>${h1}<p>${heading.sub} · <a href="${esc(path)}?full=true">all data</a></p></header>
<table class="values">
${rows.join("\n")}
</table>
${blocks.join("\n")}
</article>`);
    }

    const sections = flat.map((n) => {
      const id = String(n["@id"]);
      const types = typesOf(n);
      const text = textOf(id);
      const rows = Object.entries(n)
        .filter(([k]) => !k.startsWith("@"))
        .map(([p, vs]) =>
          text && p === SIOC_CONTENT
            ? `<tr><th>${esc(curie(p))}</th><td>${text.html}</td></tr>`
            : `<tr><th>${esc(curie(p))}</th><td>${(vs as Expanded[]).map((v) => value(p, v)).join("<br>")}</td></tr>`,
        )
        .join("\n");
      const typeRow = types.length ? `<tr><th>rdf:type</th><td>${esc(types.join(", "))}</td></tr>\n` : "";
      const title = n === docNode ? "this document" : (this.label(id, path) ?? curie(id));
      return `<section resource="${esc(name(id))}"${typeofAttr(n)}>\n<h2><a href="${esc(this.href(id))}" title="${esc(id)}">${esc(title)}</a></h2>\n<table>\n${typeRow}${rows}\n</table>\n</section>`;
    });
    const summary = r.main ? ` · <a href="${esc(path)}">summary</a>` : "";
    return page(`<header><h1>${esc(heading.title)}</h1><p>${heading.sub}${summary}</p></header>
${sections.join("\n")}`);
  }
}
