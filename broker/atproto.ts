// The ATProto broker (§6.2–6.4): records from their PDS, normalized (§3), under ‹lod-base›.
import { readFileSync } from "node:fs";
import { normalize, entityIri, lodPath, RICHTEXT, type AtRecord } from "../normalizer/src/index.ts";
import { renderRichText, type Facet } from "../normalizer/src/richtext.ts";
import { config } from "../demo/config.ts";
import { Broker, esc, SIOC_CONTENT, type Doc, type Links, type Loaded, type Node, type Result, type TextContext } from "./base.ts";

// NSID prefixes this broker serves, with the repo holding their context record (§4.1).
// Stands in for _lexicon.‹authority› DNS resolution.
const authorities: Record<string, { did: string }> = { "science.mira": { did: config.did } };
// Stands in for DID resolution.
export const pdsOf = (did: string) => (did === config.did ? config.pds : undefined);
export const authorityOf = (nsid: string) => Object.keys(authorities).find((p) => nsid.startsWith(p + "."));

const communityContext = JSON.parse(readFileSync(new URL("../contexts/linkedopendata.context.jsonld", import.meta.url), "utf8"));

async function xrpc(did: string, method: string, params: Record<string, string>) {
  const pds = pdsOf(did);
  if (!pds) return undefined;
  const res = await fetch(`${pds}/xrpc/${method}?${new URLSearchParams(params)}`);
  // A missing record makes millipds forward the call to an appview, so any failure is "not found".
  return res.ok ? res.json() : undefined;
}

const getRecord = (did: string, collection: string, rkey: string): Promise<AtRecord | undefined> =>
  xrpc(did, "com.atproto.repo.getRecord", { repo: did, collection, rkey });

/** The authority context, read from its context record (§4.1). */
async function authorityContext(prefix: string) {
  const rec = await getRecord(authorities[prefix].did, "at.linkedopendata.lexicon.context", prefix);
  if (!rec) throw new Error(`no context record for ${prefix}`);
  // "@version" cannot be stored in a record (no floats in the ATProto data model).
  return { uri: rec.uri, cid: rec.cid, context: { "@version": 1.1, ...(rec.value.context as object) } };
}

const shortCid = (cid: string) => cid.slice(0, 12) + "…";

/** URL of a DID's DID document, for rdfs:seeAlso. */
function didDocUrl(did: string): string | undefined {
  if (did.startsWith("did:plc:")) return `https://plc.directory/${did}`;
  const web = /^did:web:([^:]+)$/.exec(did);
  return web ? `https://${decodeURIComponent(web[1])}/.well-known/did.json` : undefined;
}

export class AtprotoBroker extends Broker {
  communityContextUrl: string;

  constructor(links: Links) {
    super(links);
    this.communityContextUrl = this.brokerUrl("/contexts/at.linkedopendata.jsonld");
  }

  async asset(path: string) {
    if (path === "/contexts/at.linkedopendata.jsonld") return communityContext;
    const cm = /^\/contexts\/([^/]+)\.jsonld$/.exec(path);
    if (cm && authorities[cm[1]]) return { "@context": (await authorityContext(cm[1])).context };
    return undefined;
  }

  /** Loads the contexts this broker serves without going through HTTP. */
  async documentLoader(url: string): Promise<Loaded> {
    if (url.endsWith("/contexts/at.linkedopendata.jsonld")) return { contextUrl: null, documentUrl: url, document: communityContext };
    const prefix = /\/contexts\/([^/]+)\.jsonld$/.exec(url)?.[1];
    if (prefix && authorities[prefix]) return { contextUrl: null, documentUrl: url, document: { "@context": (await authorityContext(prefix)).context } };
    throw new Error(`unexpected context: ${url}`);
  }

  accountPage(did: string) {
    return `${this.lodBase}/did/${did}`;
  }

  href(iri: string) {
    return iri.startsWith("did:") ? this.nav(this.accountPage(iri)) : this.nav(iri);
  }

  /** Short label for an IRI under ‹lod-base›, from its path depth (§6.3). */
  label(iri: string, path: string): string | undefined {
    if (iri.startsWith("did:")) return `account ${iri}`;
    const prefix = `${this.lodBase}/at/`;
    if (!iri.startsWith(prefix)) return undefined;
    const pageDid = /^\/(?:at|did)\/([^/]+)/.exec(path)?.[1];
    const [did, nsid, rkey, cid] = iri.slice(prefix.length).replace(/#it$/, "").split("/").map(decodeURIComponent);
    const where = (s: string) => (did === pageDid ? s : `${s} in ${did}`);
    if (cid) return where(`version ${shortCid(cid)} of ${nsid}/${rkey}`);
    if (rkey) return where(`record ${nsid}/${rkey}`);
    if (nsid) return where(`collection ${nsid}`);
    return `repository of ${did}`;
  }

  /** Inline text items of the record (§3 rule 7): text plus facets, which the graph leaves out. */
  contentHtml(id: string, node: Node, cx: TextContext): string | undefined {
    const recordNode = cx.doc["@graph"][0];
    for (const v of Object.values(recordNode).flat()) {
      const o = v as { $type?: string; "@id"?: string; text: string; facets?: Facet[] } | null;
      if (o && typeof o === "object" && o.$type === RICHTEXT && o["@id"] === id) {
        const inner = renderRichText(o.text, o.facets, {
          lodBase: this.lodBase,
          subject: String(recordNode["@id"]),
          holds: cx.holds,
          curie: cx.curie,
          accountHref: (d) => this.nav(this.accountPage(d)),
          href: (i) => this.nav(i),
        });
        return `<span property="${esc(cx.curie(SIOC_CONTENT))}">${inner}</span>`;
      }
    }
    return super.contentHtml(id, node, cx);
  }

  /** Link to the current version, with a button to copy its IRI: pinning stays the reader's choice. */
  permalink(versionIri: string) {
    return (
      ` · ${this.link(versionIri, "permalink to this version")} <button type="button" class="copy" data-iri="${esc(versionIri)}" ` +
      `onclick="navigator.clipboard.writeText(this.dataset.iri).then(()=>{this.textContent='copied'})">copy</button>`
    );
  }

  /** Document node with provenance (§6.4 item 3). */
  docNode(docUrl: string, topic: string, derivedFrom: string | undefined, ctx?: { uri: string; cid: string }) {
    return {
      "@id": docUrl,
      "foaf:primaryTopic": topic,
      ...(derivedFrom ? { "prov:wasDerivedFrom": derivedFrom } : {}),
      ...(ctx ? { "atp:appliedContext": entityIri(this.lodBase, ctx.uri, ctx.cid) } : {}),
      "dct:modified": new Date().toISOString(),
    };
  }

  doc(graph: Node[]): Doc {
    return { "@context": this.communityContextUrl, "@graph": graph };
  }

  /** Account document (§6.1, §6.3): about the DID itself, which stays the account's IRI. */
  async resolveAccount(path: string, did: string): Promise<Result> {
    if (!pdsOf(did)) return { status: 404 }; // only accounts whose repo this broker serves
    const info = await xrpc(did, "com.atproto.repo.describeRepo", { repo: did });
    // Handles change and need DNS verification: shown only when verified.
    const handle = info?.handleIsCorrect ? (info.handle as string) : undefined;
    const repo = entityIri(this.lodBase, `at://${did}`);
    const seeAlso = didDocUrl(did);
    const account = {
      "@id": did,
      "@type": "sioc:UserAccount",
      ...(handle ? { "foaf:accountName": handle } : {}),
      "sioc:owner_of": repo,
      ...(seeAlso ? { "rdfs:seeAlso": seeAlso } : {}),
    };
    const graph = [account, { "@id": repo, "owl:sameAs": `at://${did}` }, this.docNode(this.brokerUrl(path), did, undefined)];
    const heading = { title: handle ?? did, sub: `Account · <code>${esc(did)}</code>${handle ? "" : " · no verified handle"}` };
    return { status: 200, doc: this.doc(graph), heading };
  }

  async resolve(path: string, query: URLSearchParams): Promise<Result> {
    const lodBase = this.lodBase;
    const acct = /^\/did\/([^/]+)$/.exec(path);
    if (acct) return this.resolveAccount(path, decodeURIComponent(acct[1]));
    const m = /^\/at\/([^/]+)(?:\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?)?$/.exec(path);
    if (!m) return { status: 404 };
    const [, did, nsid, rkey, cid] = m.map((x) => x && decodeURIComponent(x));
    const docUrl = this.brokerUrl(path);
    if (!pdsOf(did)) return { status: 404 };

    if (!nsid) {
      // Repo (§6.1).
      const repo = `at://${did}`;
      const id = entityIri(lodBase, repo);
      const graph = [{ "@id": id, "@type": "sioc:Space", "owl:sameAs": repo, "sioc:has_owner": did }, this.docNode(docUrl, id, undefined)];
      return { status: 200, doc: this.doc(graph), heading: { title: `Repository of ${did}`, sub: `Repository · <code>${esc(repo)}</code>` } };
    }
    const prefix = authorityOf(nsid);
    if (!prefix) return { status: 404 }; // not a subspace this broker serves

    if (!rkey) {
      // Collection, with its items.
      const coll = `at://${did}/${nsid}`;
      const id = entityIri(lodBase, coll);
      const list = await xrpc(did, "com.atproto.repo.listRecords", { repo: did, collection: nsid, limit: "100" });
      const items = (list?.records ?? []).map((r: AtRecord) => entityIri(lodBase, r.uri));
      const graph = [
        { "@id": id, "@type": "sioc:Container", "owl:sameAs": coll, "sioc:has_space": entityIri(lodBase, `at://${did}`), "sioc:container_of": items.map((i: string) => ({ "@id": i })) },
        this.docNode(docUrl, id, undefined),
      ];
      const heading = {
        title: `${nsid} records`,
        sub: `Collection of ${items.length} records · in the ${this.link(entityIri(lodBase, `at://${did}`), `repository of ${did}`)}`,
      };
      return { status: 200, doc: this.doc(graph), heading };
    }

    const uri = `at://${did}/${nsid}/${rkey}`;
    const original = { link: `<${this.brokerUrl(lodPath(uri))}>; rel="original"` };
    const rec = await getRecord(did, nsid, rkey);
    // Deleted records should get 410 (§6.3); the PDS does not tell deleted from never existed.
    if (!rec) return { status: 404, headers: cid ? original : undefined };
    const record = entityIri(lodBase, uri);
    const current = entityIri(lodBase, uri, rec.cid);
    if (cid && cid !== rec.cid) {
      // No history server (§6.7): see the record instead. The query parameter lets its HTML
      // view warn that the current version may differ from the one that was pinned. Without
      // history, a superseded CID cannot be told from a wrong one.
      const location = `${this.brokerUrl(lodPath(uri))}?pinned=${encodeURIComponent(cid)}`;
      return { status: 303, headers: { ...original, location } };
    }

    const ctx = await authorityContext(prefix);
    const view = normalize(rec, { lodBase, context: this.brokerUrl(`/contexts/${prefix}.jsonld`), communityContext: this.communityContextUrl });
    view["@graph"].push(
      this.docNode(docUrl, cid ? current : record, current, ctx),
      // True only at retrieval time, hence stated with the response (§6.7).
      { "@id": record, "sioc:latest_version": current },
    );
    const title = typeof rec.value.title === "string" ? rec.value.title : `${nsid}/${rkey}`;
    const pinned = query.get("pinned");
    const warning =
      pinned && !cid && pinned !== rec.cid
        ? `<span class="banner">You followed a reference to version <code>${esc(shortCid(pinned))}</code> of this record. It is not the current version, and this broker keeps no history: the current version below may differ from the one that was referenced.</span>`
        : "";
    const heading = cid
      ? { title: `Version ${shortCid(cid)} of “${title}”`, sub: `Current version of ${this.link(record, "the record")} · <code>${esc(uri)}</code>` }
      : { title, sub: `Record · ${esc(String(rec.value.$type ?? nsid))} · <code>${esc(uri)}</code>${this.permalink(current)}${warning}` };
    // Memento (RFC 7089): the record is the Original Resource, its versions are Mementos.
    // Datetime of a version: when it was written. The PDS does not say (that is the commit
    // time), so this uses what the record claims, updatedAt or else createdAt.
    const written = [rec.value.updatedAt, rec.value.createdAt].find((d) => typeof d === "string" && !isNaN(Date.parse(d)));
    const httpDate = written ? new Date(written as string).toUTCString() : undefined;
    const versionDoc = this.brokerUrl(lodPath(uri, rec.cid));
    const headers: Record<string, string> = cid
      ? { ...original, ...(httpDate ? { "memento-datetime": httpDate } : {}) }
      : httpDate
        ? { link: `<${versionDoc}>; rel="last memento"; datetime="${httpDate}"` }
        : {};
    // The light view shows the record node (also on version pages, whose topic is the version).
    return { status: 200, doc: view, headers, heading, main: String(view["@graph"][0]["@id"]) };
  }
}
