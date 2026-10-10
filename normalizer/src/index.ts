// Linked Data view of an ATProto record (proposal §6.1, §6.5, §6.7).
// Pure function of the record and the LOD base: no network access.
// Not yet covered: blobs and cid-links, language tags (§6.5).

import { niFromCid } from "./cid.ts";

export const RICHTEXT = "at.linkedopendata.richtext#text";

export const COMMUNITY_CONTEXT_URL = "https://linkedopendata.at/context.jsonld"; // placeholder (Q1)

export interface AtRecord {
  uri: string; // at://did/nsid/rkey
  cid: string; // CID of the current version
  value: Record<string, unknown>;
}

export interface AtUri {
  did: string;
  nsid?: string;
  rkey?: string;
}

export interface Options {
  lodBase: string; // e.g. https://w3id.org/at-lod, no trailing slash
  context: string | object; // the authority context, by URL or inline
  communityContext?: string | object; // defaults to COMMUNITY_CONTEXT_URL
}

type Node = Record<string, unknown> & { "@id": string };

export function parseAtUri(uri: string): AtUri {
  const m = /^at:\/\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(uri);
  if (!m) throw new Error(`not an at:// URI: ${uri}`);
  return { did: m[1], nsid: m[2], rkey: m[3] };
}

/** Path of an at:// URI, or of one version of it, under ‹lod-base› (§6.3). */
export function lodPath(uri: string, cid?: string): string {
  const { did, nsid, rkey } = parseAtUri(uri);
  const parts = ["at", did, nsid, rkey, cid].filter((p) => p !== undefined);
  if (cid && !rkey) throw new Error(`only records have versions: ${uri}`);
  return "/" + parts.join("/");
}

export const entityIri = (base: string, uri: string, cid?: string) => `${base}${lodPath(uri, cid)}#it`;

/** Collects the nodes the rewrite adds next to the record (§6.4 item 2). */
class Graph {
  nodes = new Map<string, Node>();
  readonly base: string;
  constructor(base: string) {
    this.base = base;
  }

  node(id: string): Node {
    let n = this.nodes.get(id);
    if (!n) this.nodes.set(id, (n = { "@id": id }));
    return n;
  }

  /** IRI of an at:// resource, recording its owl:sameAs. */
  resource(uri: string): string {
    const id = entityIri(this.base, uri);
    this.node(id)["owl:sameAs"] = uri;
    return id;
  }

  /** IRI of a version of an at:// record, with dct:isVersionOf and atp:cid (§6.7). */
  version(uri: string, cid: string): string {
    const id = entityIri(this.base, uri, cid);
    Object.assign(this.node(id), { "dct:isVersionOf": this.resource(uri), "atp:cid": cid });
    return id;
  }

  /**
   * A pinned version of a resource outside ATProto (§6.7): the bytes with that CID, named
   * by their hash (ni:), or a blank node when the CID has no ni: form.
   */
  content(uri: string, cid: string): string {
    const id = niFromCid(cid) ?? `_:pin${++this.pins}`;
    Object.assign(this.node(id), { "dct:isVersionOf": uri, "atp:cid": cid });
    return id;
  }
  private pins = 0;

  /** Rewrites at:// IRIs in a record value, recursively. */
  rewrite(v: unknown): unknown {
    if (typeof v === "string") return v.startsWith("at://") ? this.resource(v) : v;
    if (Array.isArray(v)) return v.map((x) => this.rewrite(x));
    if (v === null || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    if (typeof o.uri === "string" && o.uri.startsWith("at://")) {
      // Reference object (§3 rule 3). The context maps uri to @id, cid to null.
      const { uri, cid, ...rest } = o;
      const target = typeof cid === "string" ? this.version(uri as string, cid) : this.resource(uri as string);
      return { ...this.rewriteObject(rest), uri: target };
    }
    if (typeof o.uri === "string" && typeof o.cid === "string") {
      const { uri, cid, ...rest } = o;
      return { ...this.rewriteObject(rest), uri: this.content(uri, cid) };
    }
    return this.rewriteObject(o);
  }

  private rewriteObject(o: Record<string, unknown>) {
    // Facets are presentation only (no triples): kept as written, for renderers.
    const keep = (k: string) => k === "$type" || (k === "facets" && o.$type === RICHTEXT);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, keep(k) ? x : this.rewrite(x)]));
  }
}

/**
 * The Linked Data view of a record: what a Level 2 client computes (§7).
 * A broker adds its document node and derived data to this graph.
 */
export function normalize(rec: AtRecord, opts: Options): { "@context": unknown[]; "@graph": Node[] } {
  const { did, nsid, rkey } = parseAtUri(rec.uri);
  if (!nsid || !rkey) throw new Error(`not a record URI: ${rec.uri}`);
  const g = new Graph(opts.lodBase);
  const { previousVersionCid, ...value } = rec.value;
  const id = entityIri(opts.lodBase, rec.uri);
  const collection = `at://${did}/${nsid}`;
  const fields = g.rewrite(value) as Record<string, unknown>;
  // Inline text items are named ‹record›#‹field› (or #‹field›-‹i› in arrays), so the
  // broker's HTML view can give the rendered text that fragment id.
  for (const [k, v] of Object.entries(fields)) {
    const name = (x: unknown, frag: string) => {
      if (x && typeof x === "object" && (x as Record<string, unknown>).$type === RICHTEXT) {
        (x as Record<string, unknown>)["@id"] = `${opts.lodBase}${lodPath(rec.uri)}#${frag}`;
      }
    };
    if (Array.isArray(v)) v.forEach((x, i) => name(x, `${k}-${i}`));
    else name(v, k);
  }
  const record: Node = {
    ...fields,
    "@id": id,
    "$type": [value.$type ?? nsid, "sioc:Item"],
    "owl:sameAs": rec.uri,
    "sioc:has_creator": did,
    "sioc:has_container": g.resource(collection),
    "sioc:has_space": g.resource(`at://${did}`),
    "sioc:id": rkey,
    "sioc:link": opts.lodBase + lodPath(rec.uri),
  };
  const current = g.version(rec.uri, rec.cid);
  if (typeof previousVersionCid === "string") {
    g.node(current)["sioc:previous_version"] = g.version(rec.uri, previousVersionCid);
  }
  g.nodes.delete(id); // the record itself is the first node, not a referenced one
  return {
    "@context": [opts.context, opts.communityContext ?? COMMUNITY_CONTEXT_URL],
    "@graph": [record, ...g.nodes.values()],
  };
}
