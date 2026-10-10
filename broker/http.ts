// The HTTP broker: JSON-LD already published on the Web (e.g. the Discourse Graphs API),
// shown through the same HTML view. https://‹host›/‹path› is served at /http/‹host›/‹path›,
// for allowlisted hosts only (the broker is not an open proxy). The source keeps its IRIs.
import jsonld from "jsonld";
import { Broker, esc, DCT_TITLE, XSD, type Expanded, type Links, type Loaded, type Node, type Result } from "./base.ts";

export const HTTP_PREFIX = "/http/";

export class HttpBroker extends Broker {
  /** Origins whose documents (and contexts) this broker fetches, by host. */
  origins: Map<string, string>;
  contexts = new Map<string, Promise<unknown>>();

  /** sources: hosts (https) or origins, e.g. http://127.0.0.1:8090 for a local test. */
  constructor(links: Links, sources: string[]) {
    super(links);
    this.origins = new Map(sources.map((s) => new URL(s.includes("://") ? s : `https://${s}`)).map((u) => [u.host, u.origin]));
  }

  allowed(u: URL | null): u is URL {
    return !!u && this.origins.get(u.host) === u.origin;
  }

  /** The source URL behind a path of this broker, if its host is allowed. */
  source(path: string): string | undefined {
    const m = /^\/http\/([^/]+)(\/.*)?$/.exec(path);
    const origin = m && this.origins.get(m[1]);
    return origin ? `${origin}${m[2] ?? "/"}` : undefined;
  }

  /** Links to allowed hosts go through this broker; the RDF object stays the source IRI. */
  href(iri: string): string {
    const u = URL.parse(iri);
    if (this.allowed(u)) return this.brokerUrl(`${HTTP_PREFIX}${u.host}${u.pathname}${u.search}${u.hash}`);
    return super.href(iri);
  }

  async documentLoader(url: string): Promise<Loaded> {
    if (!this.allowed(URL.parse(url))) throw new Error(`context from a host that is not allowed: ${url}`);
    if (!this.contexts.has(url)) {
      this.contexts.set(
        url,
        fetch(url, { headers: { accept: "application/ld+json, application/json" } }).then((r) => {
          if (!r.ok) throw new Error(`${r.status} for context ${url}`);
          return r.json();
        }),
      );
    }
    return { contextUrl: null, documentUrl: url, document: await this.contexts.get(url) };
  }

  async resolve(path: string): Promise<Result> {
    const src = this.source(path);
    if (!src) return { status: 404 };
    const res = await fetch(src, { headers: { accept: "application/ld+json" } });
    if (res.status === 404 || res.status === 410) return { status: res.status };
    // Not Linked Data (an HTML page, an error): send the reader to the source itself.
    if (!res.ok || !/json/.test(res.headers.get("content-type") ?? "")) return { status: 303, headers: { location: src } };
    const body = (await res.json()) as Node;
    const { "@context": context, ...rest } = body;
    const nodes = (rest["@graph"] as Node[] | undefined) ?? [rest];
    const documentLoader = (url: string) => this.documentLoader(url);
    // The main node: the first top-level node of the source document.
    const expanded = (await jsonld.expand({ "@context": context, ...nodes[0] }, { documentLoader, base: src })) as Node[];
    const main = expanded[0]?.["@id"] as string | undefined;
    const titles = (expanded[0]?.[DCT_TITLE] as Expanded[] | undefined) ?? [];
    const title = typeof titles[0]?.["@value"] === "string" ? (titles[0]["@value"] as string) : src;
    // Document node with provenance (§6.4 item 3), in full IRIs: the source context may not
    // declare these prefixes.
    const docNode = {
      "@id": this.brokerUrl(path),
      "http://xmlns.com/foaf/0.1/primaryTopic": { "@id": main },
      "http://www.w3.org/ns/prov#wasDerivedFrom": { "@id": src },
      "http://purl.org/dc/terms/modified": { "@value": new Date().toISOString(), "@type": XSD + "dateTime" },
    };
    const host = new URL(src).host;
    const heading = { title, sub: `Linked Data from ${esc(host)} · <a href="${esc(src)}">source</a> · <code>${esc(src)}</code>` };
    return { status: 200, doc: { "@context": context, "@graph": [...nodes, docNode] }, heading, main };
  }
}
