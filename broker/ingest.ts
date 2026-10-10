// Write path: Linked Data in, ATProto records out. For testers' own generators: they post
// JSON-LD, and get back the records it becomes, and a SHACL report of what does not fit.
//   POST /validate  JSON-LD → report
//   POST /convert   JSON-LD → records (not written) + report        (?did= plans for that repo)
//   POST /records   JSON-LD → records written to the caller's repo + report
// /records takes Authorization: Bearer ‹accessJwt› (from com.atproto.server.createSession),
// passed through to the PDS: the broker never sees a password.
//
// The report is one sh:ValidationReport (JSON-LD) with the results of
//   - the MIRA shapes, on the input;
//   - the binding's closed shapes, on the input: what the conversion drops (sh:Info);
//   - the pinning shapes, on the Linked Data view of the converted records (sh:Warning);
//   - the lexicons, on the converted records (sh:Violation: a gap in the generated shapes);
//   - notes from the conversion itself (sh:Info).
// Only violations block a write.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import jsonld from "jsonld";
import { Parser as N3Parser } from "n3";
import rdf from "@zazuko/env";
import SHACLValidator from "rdf-validate-shacl";
import { Lexicons } from "@atproto/lexicon";
import { Parser as HtmlParser } from "htmlparser2";
import { normalize, RICHTEXT } from "../normalizer/src/index.ts";
import { config } from "./config.ts";
import { send, ContextCache, XSD, DCT_DESCRIPTION, DCT_FORMAT, SIOC_CONTENT, type Expanded, type Loaded, type Node } from "./base.ts";
import type { AtprotoBroker } from "./atproto.ts";

const SH = "http://www.w3.org/ns/shacl#";
const ATP = "https://linkedopendata.at/ns/atp#";
const DCT_CREATED = "http://purl.org/dc/terms/created";
const REF = "at.linkedopendata.defs#ref";
const PROPERTY_FEATURE = "at.linkedopendata.richtext#property";
const LINK_FEATURE = "app.bsky.richtext.facet#link";
const PLACEHOLDER_DID = "did:web:example.invalid"; // planned URIs for /convert without ?did=
const PLACEHOLDER_CID = "bafkqaaa"; // CID of empty content: the record is not written yet

// ---- binding: the authority context, read as a table of terms ---------------------------

type Term = { name: string; kind: "ref" | "iri" | "literal" | "union"; set: boolean; datatype?: string };
type Binding = { classes: Map<string, string>; terms: Map<string, Term>; scoped: Map<string, Map<string, Term>> };

function readBinding(ctx: Record<string, unknown>): Binding {
  const prefixes = Object.entries(ctx).filter(([, v]) => typeof v === "string" && /[#/]$/.test(v as string)) as [string, string][];
  const expand = (c: string) => {
    const hit = prefixes.find(([p]) => c.startsWith(p + ":"));
    return hit ? hit[1] + c.slice(hit[0].length + 1) : c;
  };
  const term = (name: string, v: unknown): [string, Term] | undefined => {
    if (typeof v === "string") return v.startsWith("@") ? undefined : [expand(v), { name, kind: "literal", set: false }];
    if (!v || typeof v !== "object") return undefined;
    const d = v as Record<string, unknown>;
    const scoped = (d["@context"] ?? {}) as Record<string, unknown>;
    const set = d["@container"] === "@set";
    const kind = RICHTEXT in scoped ? "union" : scoped.uri === "@id" ? "ref" : d["@type"] === "@id" ? "iri" : "literal";
    const datatype = kind === "literal" && typeof d["@type"] === "string" && !d["@type"].startsWith("@") ? expand(d["@type"]) : undefined;
    return [expand(String(d["@id"])), { name, kind, set, datatype }];
  };
  const b: Binding = { classes: new Map(), terms: new Map(), scoped: new Map() };
  for (const [k, v] of Object.entries(ctx)) {
    if (k.startsWith("@") || k === "$type") continue;
    const d = v as Record<string, unknown> | null;
    if (d && typeof d === "object" && (d["@context"] as Record<string, unknown> | undefined)?.["@propagate"]) {
      // A record type (NSID), with its type-scoped terms.
      const cls = expand(String(d["@id"]));
      b.classes.set(cls, k);
      const m = new Map<string, Term>();
      for (const [sk, sv] of Object.entries(d["@context"] as object)) {
        const t = term(sk, sv);
        if (t) m.set(...t);
      }
      b.scoped.set(cls, m);
      continue;
    }
    const t = term(k, v);
    if (t) b.terms.set(...t);
  }
  return b;
}

// ---- shapes and lexicons ------------------------------------------------------------------

const parseRdf = (text: string, format: string) => rdf.dataset(new N3Parser({ format }).parse(text) as any);
const read = (p: string) => readFileSync(p, "utf8");

function lexiconFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? lexiconFiles(p) : p.endsWith(".json") ? [p] : [];
  });
}

/** A SHACL result, as JSON-LD. */
type Result = Record<string, unknown>;
const note = (severity: "Info" | "Warning" | "Violation", component: string, message: string, focus?: string, path?: string, value?: unknown): Result => ({
  "@type": "sh:ValidationResult",
  "sh:resultSeverity": { "@id": `sh:${severity}` },
  "sh:sourceConstraintComponent": { "@id": `atp:${component}` },
  "sh:resultMessage": message,
  ...(focus ? { "sh:focusNode": { "@id": focus } } : {}),
  ...(path ? { "sh:resultPath": { "@id": path } } : {}),
  ...(value !== undefined ? { "sh:value": value } : {}),
});

function termJson(t: any): unknown {
  if (!t) return undefined;
  if (t.termType === "NamedNode") return { "@id": t.value };
  if (t.termType === "BlankNode") return { "@id": `_:${t.value}` };
  const dt = t.datatype?.value;
  return { "@value": t.value, ...(t.language ? { "@language": t.language } : dt && dt !== XSD + "string" ? { "@type": dt } : {}) };
}

/** SHACL results as JSON-LD; sequence paths as lists, read from the report graph. */
function reportJson(report: any): Result[] {
  const ds = report.dataset;
  const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
  const list = (head: any): unknown[] => {
    const out: unknown[] = [];
    for (let n = head; n && n.value !== RDF + "nil"; ) {
      const first = [...ds.match(n, rdf.namedNode(RDF + "first"))][0];
      out.push(termJson(first?.object));
      n = [...ds.match(n, rdf.namedNode(RDF + "rest"))][0]?.object;
    }
    return out;
  };
  return report.results.map((r: any) => {
    const path = r.path?.termType === "BlankNode" ? { "@list": list(r.path) } : termJson(r.path);
    return {
      "@type": "sh:ValidationResult",
      "sh:resultSeverity": termJson(r.severity),
      "sh:sourceConstraintComponent": termJson(r.sourceConstraintComponent),
      "sh:resultMessage": r.message.map((m: any) => m.value).join(" ") || undefined,
      "sh:focusNode": termJson(r.focusNode),
      ...(path ? { "sh:resultPath": path } : {}),
      ...(r.value ? { "sh:value": termJson(r.value) } : {}),
    };
  });
}

// ---- HTML descriptions → text + facets ------------------------------------------------------

const BLOCK = new Set(["p", "div", "section", "article", "blockquote", "pre", "ul", "ol", "li", "table", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "header", "footer"]);
const PLAIN = new Set(["a", "span", "p", "div", "br"]);
const SAFE = /^(https?:|at:|did:)/i;

type Span = { start: number; end: number; feature: object };
/**
 * Plain text and facets from HTML: links become link facets; an RDFa span becomes a
 * property facet when the record makes the statement it restates (the mirror rule, read
 * backwards), and stays a link (or nothing) otherwise. Other markup is dropped.
 */
function htmlToRichText(html: string, expand: (c: string) => string, states: (p: string, obj: { iri?: string; literal?: string }) => boolean, ref: (iri: string) => object) {
  let text = "";
  const spans: Span[] = [];
  const open: { name: string; start: number; href?: string; property?: string; resource?: string; content?: string }[] = [];
  let dropped = false;
  let skip = 0;
  const brk = (s: string) => {
    text = text.replace(/ +$/, "");
    if (text && !text.endsWith(s)) text = text.replace(/\n*$/, "") + s;
  };
  const parser = new HtmlParser(
    {
      onopentag(name, attrs) {
        if (name === "script" || name === "style") skip++;
        if (!PLAIN.has(name)) dropped = true;
        if (name === "br") return brk("\n");
        if (BLOCK.has(name)) brk("\n\n");
        open.push({ name, start: text.length, href: attrs.href, property: attrs.property, resource: attrs.resource, content: attrs.content });
      },
      ontext(t) {
        if (skip) return;
        const s = t.replace(/\s+/g, " ");
        text += /[ \n]$/.test(text) || !text ? s.replace(/^ /, "") : s;
      },
      onclosetag(name) {
        if (name === "script" || name === "style") skip--;
        if (name === "br") return;
        const el = open.pop();
        if (el && el.name === name) {
          const end = text.replace(/ +$/, "").length;
          const obj = el.resource ?? el.href;
          const property = el.property && expand(el.property.split(/\s+/)[0]);
          if (end > el.start) {
            if (property && states(property, obj ? { iri: obj } : { literal: el.content ?? text.slice(el.start, end) })) {
              spans.push({ start: el.start, end, feature: { $type: PROPERTY_FEATURE, property, ...(obj ? { ref: ref(obj) } : {}) } });
            } else if (el.href && SAFE.test(el.href)) {
              spans.push({ start: el.start, end, feature: { $type: LINK_FEATURE, uri: el.href } });
            }
          }
        }
        if (BLOCK.has(name)) brk("\n\n");
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  text = text.trim(); // never starts with a space: only trailing whitespace goes
  const bytes = (i: number) => Buffer.byteLength(text.slice(0, Math.min(i, text.length)));
  const facets = spans
    .filter((s) => s.start < text.length)
    .map((s) => ({ index: { byteStart: bytes(s.start), byteEnd: bytes(s.end) }, features: [s.feature] }));
  return { text, facets, dropped };
}

// ---- record keys ------------------------------------------------------------------------------

const S32 = "234567abcdefghijklmnopqrstuvwxyz";
let lastUs = 0;
/** A TID record key (timestamp in microseconds, random clock id). */
function tid(): string {
  let us = Date.now() * 1000;
  if (us <= lastUs) us = lastUs + 1;
  lastUs = us;
  let n = (BigInt(us) << 10n) | BigInt(Math.floor(Math.random() * 1024));
  let s = "";
  for (let i = 0; i < 13; i++, n >>= 5n) s = S32[Number(n & 31n)] + s;
  return s;
}

// ---- the converter ------------------------------------------------------------------------------

type Planned = { source: string; node: Node; nsid: string; uri: string; existing?: { cid: string } };
type Converted = Planned & { record: Record<string, unknown> };

export class Ingest {
  atproto: AtprotoBroker;
  context: Record<string, unknown>;
  binding: Binding;
  shapes: { mira: any; binding: any; pinning: any };
  ontology: any;
  lexicons: Lexicons;
  remote = new ContextCache(config.contextTtl);
  allowedHosts: string[];

  constructor(atproto: AtprotoBroker) {
    this.atproto = atproto;
    this.context = JSON.parse(read(config.contextPath))["@context"];
    this.binding = readBinding(this.context);
    this.shapes = {
      mira: parseRdf(read(config.shapesPath), "text/turtle"),
      binding: parseRdf(read(join(config.bindingDir, "binding.shacl.ttl")), "text/turtle"),
      pinning: parseRdf(read(join(config.bindingDir, "pinning.shacl.ttl")), "text/turtle"),
    };
    // Only the class hierarchy: what sh:class needs for instances of subclasses. (Merging the
    // whole ontology would also validate its own property declarations.)
    const SUBCLASS = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
    this.ontology = [...parseRdf(read(config.ontologyPath), "text/turtle")].filter((q: any) => q.predicate.value === SUBCLASS);
    const dirs = [join(config.bindingDir, "lexicons"), new URL("../lexicons", import.meta.url).pathname];
    this.lexicons = new Lexicons(dirs.flatMap(lexiconFiles).map((f) => JSON.parse(read(f))));
    this.allowedHosts = [...config.contextHosts, ...config.httpHosts.map((h) => new URL(h.includes("://") ? h : `https://${h}`).host)];
  }

  /** Contexts of submitted JSON-LD: the broker's own, or from allowed hosts (no open fetching). */
  async documentLoader(url: string): Promise<Loaded> {
    try {
      return await this.atproto.documentLoader(url);
    } catch {
      const host = URL.parse(url)?.host;
      if (!host || !this.allowedHosts.includes(host)) throw new Error(`context from a host that is not allowed: ${url}`);
      return this.remote.load(url);
    }
  }

  async xrpc(method: string, params: Record<string, string>, token?: string, body?: object) {
    const url = `${config.pds}/xrpc/${method}${body ? "" : `?${new URLSearchParams(params)}`}`;
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body && JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  }

  /** Records of the repo, by the IRIs in their sameAs: what was converted before. */
  async sameAsIndex(did: string): Promise<Map<string, { uri: string; cid: string }>> {
    const index = new Map<string, { uri: string; cid: string }>();
    for (const nsid of this.binding.classes.values()) {
      let cursor: string | undefined;
      do {
        const r = await this.xrpc("com.atproto.repo.listRecords", { repo: did, collection: nsid, limit: "100", ...(cursor ? { cursor } : {}) });
        if (!r.ok) break;
        for (const rec of r.json.records ?? []) for (const iri of rec.value.sameAs ?? []) index.set(iri, { uri: rec.uri, cid: rec.cid });
        cursor = r.json.cursor;
      } while (cursor);
    }
    return index;
  }

  async convert(input: unknown, did: string, index: Map<string, { uri: string; cid: string }>) {
    const notes: Result[] = [];
    const loader = (url: string) => this.documentLoader(url);
    const flat = (await jsonld.flatten(input as object, null, { documentLoader: loader })) as Node[];
    const byId = new Map(flat.map((n) => [String(n["@id"]), n]));

    // Plan: one record per node typed with a record class, at a known or a new URI.
    const planned: Planned[] = [];
    for (const node of flat) {
      const cls = ((node["@type"] as string[] | undefined) ?? []).find((t) => this.binding.classes.has(t));
      if (!cls) continue;
      const nsid = this.binding.classes.get(cls)!;
      const source = String(node["@id"]);
      const known = source.startsWith("_:") ? undefined : index.get(source);
      if (source.startsWith("_:")) notes.push(note("Info", "ConversionNote", "Node without an IRI: posting it again creates another record.", source));
      planned.push({ source, node, nsid, uri: known?.uri ?? `at://${did}/${nsid}/${tid()}`, existing: known && { cid: known.cid } });
    }
    // Typed nodes that become no record (and are not a record's inline text).
    const inline = new Set(flat.flatMap((n) => ((n[DCT_DESCRIPTION] as Expanded[] | undefined) ?? []).map((v) => v["@id"])));
    for (const node of flat) {
      const types = (node["@type"] as string[] | undefined) ?? [];
      if (types.length && !types.some((t) => this.binding.classes.has(t)) && !inline.has(String(node["@id"]))) {
        notes.push(note("Info", "ConversionNote", `Not converted: no ATProto record type for ${types.join(", ")}.`, String(node["@id"])));
      }
    }
    if (!planned.length) notes.push(note("Violation", "ConversionNote", `No node has a record type (${[...this.binding.classes.keys()].join(", ")}).`));
    const inBatch = new Map(planned.map((p) => [p.source, p]));

    // References: to records (pinned to their current version), or to IRIs as they are.
    const lodBase = this.atproto.lodBase;
    const current = new Map<string, string | undefined>();
    const currentCid = async (uri: string) => {
      if (!current.has(uri)) {
        const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
        const r = m && (await this.xrpc("com.atproto.repo.getRecord", { repo: m[1], collection: m[2], rkey: m[3] }));
        current.set(uri, r && r.ok ? r.json.cid : undefined);
      }
      return current.get(uri);
    };
    // Types known from where references lead: an at:// record's collection gives its class.
    // Added to the graph that is validated, as the shapes check the class of references.
    const known = new Map<string, string>();
    const classOf = new Map([...this.binding.classes].map(([c, n]) => [n, c]));
    const typed = (iri: string, uri: string) => {
      const cls = classOf.get(uri.split("/")[3]);
      if (cls) known.set(iri, cls);
    };
    const resolveRef = async (iri: string, focus: string): Promise<object> => {
      const lod = iri.startsWith(lodBase + "/at/") ? /^\/at\/([^/]+)\/([^/]+)\/([^/#]+)(?:\/([^/#]+))?#it$/.exec(iri.slice(lodBase.length)) : null;
      if (lod) {
        const uri = `at://${decodeURIComponent(lod[1])}/${lod[2]}/${lod[3]}`;
        typed(iri, uri);
        const cid = lod[4] ?? (await currentCid(uri));
        return cid ? { uri, cid } : { uri };
      }
      if (iri.startsWith("at://")) {
        typed(iri, iri);
        const cid = await currentCid(iri);
        return cid ? { uri: iri, cid } : { uri: iri };
      }
      const batch = inBatch.get(iri);
      if (batch) {
        notes.push(note("Info", "ConversionNote", "Reference to a record written in the same request: not pinned.", focus, undefined, { "@id": iri }));
        return { uri: batch.uri };
      }
      const prior = index.get(iri);
      if (prior) {
        typed(iri, prior.uri);
        return { uri: prior.uri, cid: prior.cid };
      }
      return { uri: iri };
    };

    const converted: Converted[] = [];
    for (const p of planned) {
      const node = p.node;
      const cls = ((node["@type"] as string[]) ?? []).find((t) => this.binding.classes.has(t))!;
      const scoped = this.binding.scoped.get(cls)!;
      const record: Record<string, unknown> = { $type: p.nsid };
      for (const [prop, vs] of Object.entries(node)) {
        if (prop.startsWith("@") || prop === DCT_DESCRIPTION) continue;
        const term = scoped.get(prop) ?? this.binding.terms.get(prop);
        if (!term) continue; // reported by the binding shapes
        const values: unknown[] = [];
        for (const v of vs as Expanded[]) {
          if (term.kind === "ref") {
            if (v["@id"]) values.push(await resolveRef(v["@id"], p.source));
            else notes.push(note("Info", "ConversionNote", `${term.name}: a literal where a reference is expected; dropped.`, p.source, prop, v));
          } else if (term.kind === "iri") {
            if (v["@id"] && !v["@id"].startsWith("_:")) values.push(v["@id"]);
          } else if (v["@value"] !== undefined) {
            // Numbers that are not integers are stored as strings (§3 rule 10).
            values.push(typeof v["@value"] === "number" && !Number.isInteger(v["@value"]) ? String(v["@value"]) : v["@value"]);
          }
        }
        if (!values.length) continue;
        if (!term.set && values.length > 1) notes.push(note("Info", "ConversionNote", `${term.name} holds one value: the others are dropped.`, p.source, prop));
        record[term.name] = term.set ? values : values[0];
      }
      // The node it was converted from (owl:sameAs): also how the next post finds it.
      if (!p.source.startsWith("_:")) record.sameAs = [...new Set([...((record.sameAs as string[]) ?? []), p.source])];
      if (!record.createdAt) {
        record.createdAt = new Date().toISOString();
        notes.push(note("Info", "ConversionNote", "No dct:created: createdAt is the time of conversion.", p.source, DCT_CREATED));
      }
      const description = await this.description(p, byId, resolveRef, notes);
      if (description) record.description = description;
      if (p.existing) record.previousVersionCid = p.existing.cid;
      converted.push({ ...p, record });
    }
    return { flat, converted, notes, known };
  }

  /** dct:description: inline text (preferred) or a reference (§3 rule 7). */
  async description(p: Planned, byId: Map<string, Node>, resolveRef: (iri: string, focus: string) => Promise<object>, notes: Result[]) {
    const vs = (p.node[DCT_DESCRIPTION] as Expanded[] | undefined) ?? [];
    if (vs.length > 1) notes.push(note("Info", "ConversionNote", "description holds one value: the others are dropped.", p.source, DCT_DESCRIPTION));
    const v = vs[0];
    if (!v) return undefined;
    if (v["@value"] !== undefined) return { $type: RICHTEXT, text: String(v["@value"]) };
    const id = v["@id"]!;
    const item = byId.get(id);
    const content = (item?.[SIOC_CONTENT] as Expanded[] | undefined)?.[0]?.["@value"];
    if (typeof content !== "string") return { $type: REF, ...(await resolveRef(id, p.source)) };
    // Inline text, even when the item also has an IRI: the IRI itself is not kept.
    if (!id.startsWith("_:")) notes.push(note("Info", "ConversionNote", "Inline description used; the text's own IRI is not kept.", p.source, DCT_DESCRIPTION, { "@id": id }));
    const html = ((item![DCT_FORMAT] as Expanded[] | undefined) ?? []).some((f) => f["@value"] === "text/html");
    if (!html) return { $type: RICHTEXT, text: content };
    const prefixes = Object.entries(this.context).filter(([, x]) => typeof x === "string" && /[#/]$/.test(x as string)) as [string, string][];
    const expand = (c: string) => {
      const hit = prefixes.find(([k]) => c.startsWith(k + ":"));
      return hit ? hit[1] + c.slice(hit[0].length + 1) : c;
    };
    const states = (prop: string, obj: { iri?: string; literal?: string }) =>
      ((p.node[prop] as Expanded[] | undefined) ?? []).some((x) => (obj.iri ? x["@id"] === obj.iri : x["@value"] === obj.literal));
    const refs: Promise<object>[] = [];
    const placeholders: Record<string, unknown>[] = [];
    const rich = htmlToRichText(content, expand, states, (iri) => {
      const ph: Record<string, unknown> = {};
      placeholders.push(ph);
      refs.push(resolveRef(iri, p.source).then((r) => Object.assign(ph, r)));
      return ph;
    });
    await Promise.all(refs);
    if (rich.dropped) notes.push(note("Info", "ConversionNote", "HTML description: formatting is not kept (text, links and restated statements are).", p.source, DCT_DESCRIPTION));
    return { $type: RICHTEXT, text: rich.text, ...(rich.facets.length ? { facets: rich.facets } : {}) };
  }

  /** Everything checked about an input and its conversion, as one report. */
  async report(input: unknown, converted: Converted[], notes: Result[], known: Map<string, string>) {
    const loader = (url: string) => this.documentLoader(url);
    const nq = (await jsonld.toRDF(input as object, { format: "application/n-quads", documentLoader: loader })) as string;
    const data = parseRdf(nq, "application/n-quads");
    for (const [iri, cls] of known) {
      data.add(rdf.quad(rdf.namedNode(iri), rdf.namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"), rdf.namedNode(cls)));
    }
    // The class hierarchy, for subclass reasoning (as pyshacl -e).
    const withOntology = rdf.dataset([...data, ...this.ontology]);
    const results: Result[] = [];
    results.push(...reportJson(await new SHACLValidator(this.shapes.mira, { factory: rdf }).validate(withOntology)));
    results.push(...reportJson(await new SHACLValidator(this.shapes.binding, { factory: rdf }).validate(data)));
    for (const c of converted) {
      try {
        this.lexicons.assertValidRecord(c.nsid, c.record);
      } catch (e) {
        results.push(note("Violation", "LexiconConstraintComponent", `${c.nsid}: ${(e as Error).message}`, c.source));
      }
      // Pinning: on the Linked Data view of the record, as a broker would serve it.
      const view = normalize({ uri: c.uri, cid: PLACEHOLDER_CID, value: c.record as never }, {
        lodBase: this.atproto.lodBase,
        context: { "@version": 1.1, ...this.context } as never,
        communityContext: this.atproto.communityContextUrl,
      });
      const vq = (await jsonld.toRDF(view, { format: "application/n-quads", documentLoader: loader, base: this.atproto.endpoint })) as string;
      results.push(...reportJson(await new SHACLValidator(this.shapes.pinning, { factory: rdf }).validate(parseRdf(vq, "application/n-quads"))));
    }
    results.push(...notes);
    const severity = (r: Result) => String((r["sh:resultSeverity"] as { "@id": string })["@id"]).replace(SH, "sh:");
    const blocking = results.filter((r) => severity(r) === "sh:Violation").length;
    return {
      blocking,
      report: {
        "@context": { sh: SH, atp: ATP },
        "@type": "sh:ValidationReport",
        "sh:conforms": results.length === 0,
        "sh:result": results.map((r) => ({ ...r, "sh:resultSeverity": { "@id": severity(r) } })),
      },
    };
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    let input: unknown;
    try {
      input = JSON.parse(await body(req));
    } catch {
      return send(res, 400, "text/plain", "Expected a JSON-LD document.\n");
    }
    const json = (status: number, o: object) => send(res, status, "application/json", JSON.stringify(o, null, 2));
    const path = url.pathname;
    let did = url.searchParams.get("did") ?? PLACEHOLDER_DID;
    let token: string | undefined;
    if (path === "/records") {
      token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      const session = token ? await this.xrpc("com.atproto.server.getSession", {}, token) : undefined;
      if (!session?.ok) return json(401, { error: "Authorization: Bearer ‹accessJwt› required (com.atproto.server.createSession)." });
      did = session.json.did;
    }
    try {
      const index = did === PLACEHOLDER_DID ? new Map() : await this.sameAsIndex(did);
      const { converted, notes, known } = await this.convert(input, did, index);
      const { blocking, report } = await this.report(input, converted, notes, known);
      if (path === "/validate") return json(200, { blocking, report });
      const records = converted.map((c) => ({ source: c.source, uri: c.uri, action: c.existing ? "update" : "create", record: c.record }));
      if (path === "/convert") return json(200, { blocking, records, report });
      if (blocking) return json(422, { blocking, records, report });
      const written = [];
      for (const c of converted) {
        const [, , collection, rkey] = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(c.uri)!;
        const r = await this.xrpc("com.atproto.repo.putRecord", {}, token, { repo: did, collection, rkey, record: c.record, validate: false });
        if (!r.ok) return json(502, { error: `putRecord ${c.uri}: ${r.status} ${JSON.stringify(r.json)}`, written, report });
        written.push({ source: c.source, uri: r.json.uri, cid: r.json.cid, action: c.existing ? "update" : "create", page: this.atproto.endpoint + `/at/${did}/${collection}/${rkey}` });
      }
      return json(200, { blocking, records: written, report });
    } catch (e) {
      // jsonld.js wraps loader errors: report the innermost one.
      let err: any = e;
      while (err?.details?.cause ?? err?.cause) err = err.details?.cause ?? err.cause;
      return json(400, { error: (err as Error).message });
    }
  }
}

async function body(req: IncomingMessage, limit = 2_000_000): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("request too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export { readBinding, htmlToRichText, tid };
