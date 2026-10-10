// Writes sample MIRA records and the science.mira context record to a local PDS.
// Idempotent: fixed record keys, putRecord. Usage: node demo/seed.ts
import { readFileSync } from "node:fs";
import { config } from "../broker/config.ts";

const { pds, did, password, contextPath } = config;

async function xrpc(method: string, body?: object, token?: string) {
  const res = await fetch(`${pds}/xrpc/${method}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method}: ${res.status} ${await res.text()}`);
  return res.json();
}

const { accessJwt } = await xrpc("com.atproto.server.createSession", { identifier: did, password });

async function put(collection: string, rkey: string, record: object): Promise<{ uri: string; cid: string }> {
  const r = await xrpc("com.atproto.repo.putRecord", { repo: did, collection, rkey, record: { $type: collection, ...record } }, accessJwt);
  console.log(`${r.uri}  ${r.cid}`);
  return r;
}

// The context record (§4.1). ATProto records cannot hold floats, so "@version": 1.1 is
// left out; JSON-LD 1.1 processors default to 1.1 mode anyway. Readers add it back.
const { "@version": _, ...context } = JSON.parse(readFileSync(contextPath, "utf8"))["@context"];
await put("at.linkedopendata.lexicon.context", "science.mira", { context, createdAt: new Date().toISOString() });

const now = "2026-10-09T12:00:00.000Z";
const MIRA = "http://purl.org/mira-science/mira#";

/** Inline rich text (at.linkedopendata.richtext#text) with facets on the given substrings. */
function richText(text: string, spans: [string, object][]) {
  const facets = spans.map(([part, feature]) => {
    const i = text.indexOf(part);
    if (i < 0) throw new Error(`not in text: ${part}`);
    const byteStart = Buffer.byteLength(text.slice(0, i));
    return { index: { byteStart, byteEnd: byteStart + Buffer.byteLength(part) }, features: [feature] };
  });
  return { $type: "at.linkedopendata.richtext#text", text, facets };
}
const restates = (property: string, ref?: object) => ({ $type: "at.linkedopendata.richtext#property", property, ...(ref ? { ref } : {}) });
const link = (uri: string) => ({ $type: "app.bsky.richtext.facet#link", uri });
const question = await put("science.mira.question", "3miraq2222222", {
  createdAt: now,
  title: "QUE - Does protein X inhibit Y?",
  // An external, shared text (§3: description is inline text or a reference).
  description: { $type: "at.linkedopendata.defs#ref", uri: "https://example.org/shared-texts/protein-x#question" },
});
const base0 = await put("science.mira.claim", "3mirac2222222", {
  createdAt: now,
  title: "CLM - Protein X inhibits Y in vitro",
  addresses: [{ uri: question.uri }],
});
// Pins the version of the base claim it read (§6.7).
const supporting = await put("science.mira.claim", "3mirac2222223", {
  createdAt: now,
  title: "CLM - X binds the active site of Y",
  supports: [{ uri: base0.uri, cid: base0.cid }],
  description: richText("Binding at the active site supports the claim that X inhibits Y.", [
    // Restates the pinned supports above (mirror rule).
    ["supports the claim that X inhibits Y", restates(MIRA + "supports", { uri: base0.uri, cid: base0.cid })],
  ]),
});
await put("science.mira.evidence", "3mirae2222222", {
  createdAt: now,
  title: "EVD - Binding assay, figure 2",
  observationStatement: { uri: supporting.uri },
  // Pinned off-PDS data: the CID of its bytes (raw, sha-256), as for blobs (§6.7).
  observationBase: { uri: "https://example.org/data/figure2.png", cid: "bafkreih63vqyyvo52nrxr3vnp7b4w2bckhzhld4irecu5m4amvqy7hivle" },
  supports: [{ uri: supporting.uri }],
  description: richText("The assay in figure 2 shows binding, which supports the binding claim; it does not oppose it.", [
    ["figure 2", link("https://example.org/data/figure2.png")],
    ["supports the binding claim", restates(MIRA + "supports", { uri: supporting.uri })],
    // Not stated by the record: rendered without RDFa.
    ["oppose it", restates(MIRA + "opposes", { uri: supporting.uri })],
  ]),
});
// Update the base claim in place: the pin above now names an older version.
await put("science.mira.claim", "3mirac2222222", {
  createdAt: now,
  updatedAt: "2026-10-09T13:00:00.000Z",
  title: "CLM - Protein X inhibits Y in vitro and in cells",
  addresses: [{ uri: question.uri }],
  previousVersionCid: base0.cid,
});
