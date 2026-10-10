import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import jsonld from "jsonld";
import { normalize, COMMUNITY_CONTEXT_URL, lodPath } from "../src/index.ts";

const root = new URL("../../", import.meta.url);
const MIRA_CONTEXT =
  process.env.MIRA_CONTEXT ??
  new URL("../schema/atproto/context.jsonld", root).pathname;
const readJson = (p: string | URL) => JSON.parse(readFileSync(p, "utf8"));
const miraContext = readJson(MIRA_CONTEXT)["@context"];
const communityContext = readJson(
  new URL("contexts/linkedopendata.context.jsonld", root),
);

// Offline loader: only the community context is fetched by URL.
const documentLoader = async (url: string) => {
  if (url === COMMUNITY_CONTEXT_URL)
    return { contextUrl: null, documentUrl: url, document: communityContext };
  throw new Error(`unexpected fetch: ${url}`);
};

export async function triples(doc: object): Promise<string[]> {
  const nq = (await jsonld.toRDF(doc, {
    format: "application/n-quads",
    documentLoader,
  })) as string;
  return nq.trim().split("\n").sort();
}

const BASE = "https://w3id.org/at-lod";
const B = (p: string) => `<${BASE}/at/${p}#it>`;
const MIRA = (t: string) => `<http://purl.org/mira-science/mira#${t}>`;

// Proposal §6.6.
const claim = {
  uri: "at://did:plc:abc/science.mira.claim/3k2x",
  cid: "bafyreiA",
  value: {
    $type: "science.mira.claim",
    createdAt: "2026-09-01T12:00:00Z",
    title: "CLM - Protein X inhibits Y in vitro",
    supports: [
      { uri: "at://did:plc:def/science.mira.claim/3j9q" },
      { uri: "at://did:plc:ghi/science.mira.claim/3h7r", cid: "bafyreiC1" },
    ],
    previousVersionCid: "bafyreiP0",
  },
};

test("lodPath maps repos, collections, records and versions (§6.3)", () => {
  assert.equal(lodPath("at://did:plc:abc"), "/at/did:plc:abc");
  assert.equal(
    lodPath("at://did:plc:abc/science.mira.claim"),
    "/at/did:plc:abc/science.mira.claim",
  );
  assert.equal(
    lodPath(claim.uri, "bafy"),
    "/at/did:plc:abc/science.mira.claim/3k2x/bafy",
  );
  assert.throws(() => lodPath("at://did:plc:abc", "bafy"));
});

test("normalized claim yields the §6.6 graph", async () => {
  const t = await triples(
    normalize(claim, { lodBase: BASE, context: miraContext }),
  );
  const R = B("did:plc:abc/science.mira.claim/3k2x");
  const pinned = B("did:plc:ghi/science.mira.claim/3h7r/bafyreiC1");
  const expected = [
    `${R} <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ${MIRA("Claim")} .`,
    `${R} <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://rdfs.org/sioc/ns#Item> .`,
    `${R} <http://purl.org/dc/terms/created> "2026-09-01T12:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .`,
    `${R} ${MIRA("supports")} ${B("did:plc:def/science.mira.claim/3j9q")} .`,
    `${R} ${MIRA("supports")} ${pinned} .`,
    `${R} <http://www.w3.org/2002/07/owl#sameAs> <at://did:plc:abc/science.mira.claim/3k2x> .`,
    `${R} <http://rdfs.org/sioc/ns#has_creator> <did:plc:abc> .`,
    `${R} <http://rdfs.org/sioc/ns#has_container> ${B("did:plc:abc/science.mira.claim")} .`,
    `${R} <http://rdfs.org/sioc/ns#has_space> ${B("did:plc:abc")} .`,
    `${R} <http://rdfs.org/sioc/ns#id> "3k2x" .`,
    `${pinned} <http://purl.org/dc/terms/isVersionOf> ${B("did:plc:ghi/science.mira.claim/3h7r")} .`,
    `${pinned} <https://linkedopendata.at/ns/atp#cid> "bafyreiC1" .`,
    `${B("did:plc:ghi/science.mira.claim/3h7r")} <http://www.w3.org/2002/07/owl#sameAs> <at://did:plc:ghi/science.mira.claim/3h7r> .`,
    `${B("did:plc:abc/science.mira.claim/3k2x/bafyreiA")} <http://rdfs.org/sioc/ns#previous_version> ${B("did:plc:abc/science.mira.claim/3k2x/bafyreiP0")} .`,
    `${B("did:plc:abc/science.mira.claim/3k2x/bafyreiP0")} <http://purl.org/dc/terms/isVersionOf> ${R} .`,
  ];
  for (const e of expected) assert.ok(t.includes(e), `missing: ${e}`);
  // The pin must not leak onto the record or its target (§3.1).
  assert.ok(!t.some((x) => x.includes('"bafyreiC1"') && !x.startsWith(pinned)));
  // No at:// IRI as a subject or object, except as the object of owl:sameAs.
  assert.ok(t.every((x) => !x.includes("<at://") || x.includes("owl#sameAs")));
});

test("context alone gives the unpinned reading (§3.1)", async () => {
  const doc = {
    "@context": [miraContext, COMMUNITY_CONTEXT_URL],
    "@id": "urn:x",
    ...claim.value,
  };
  const t = await triples(doc);
  assert.ok(
    t.includes(
      `<urn:x> ${MIRA("supports")} <at://did:plc:ghi/science.mira.claim/3h7r> .`,
    ),
  );
  assert.ok(
    !t.some((x) => x.includes("bafyrei")),
    "cid and previousVersionCid are unmapped",
  );
});

test("numbers stored as strings become typed literals (§3 rule 10)", async () => {
  // As generated from generator/tests/fixtures/measure.yaml.
  const context = {
    "@version": 1.1,
    ex: "https://example.org/measure#",
    xsd: "http://www.w3.org/2001/XMLSchema#",
    $type: "@type",
    value: { "@id": "ex:value", "@type": "xsd:decimal" },
    ratio: { "@id": "ex:ratio", "@type": "xsd:double", "@container": "@set" },
    count: { "@id": "ex:count" },
    "org.example.measurement": { "@id": "ex:Measurement", "@context": { "@propagate": true } },
  };
  const rec = {
    uri: "at://did:plc:abc/org.example.measurement/3k2x",
    cid: "bafyreiM",
    value: { $type: "org.example.measurement", value: "-0.42", ratio: ["1.5E3", "NaN"], count: 3 },
  };
  const t = await triples(normalize(rec, { lodBase: BASE, context }));
  const R = B("did:plc:abc/org.example.measurement/3k2x");
  const XSD = (t: string) => `<http://www.w3.org/2001/XMLSchema#${t}>`;
  for (const e of [
    `${R} <https://example.org/measure#value> "-0.42"^^${XSD("decimal")} .`,
    `${R} <https://example.org/measure#ratio> "1.5E3"^^${XSD("double")} .`,
    `${R} <https://example.org/measure#ratio> "NaN"^^${XSD("double")} .`,
    `${R} <https://example.org/measure#count> "3"^^${XSD("integer")} .`,
  ]) {
    assert.ok(t.includes(e), `missing: ${e}`);
  }
});

test("description: inline text is an Item named ‹record›#description; facets give no triples", async () => {
  const rec = {
    uri: "at://did:plc:abc/science.mira.claim/3k2x",
    cid: "bafyreiA",
    value: {
      $type: "science.mira.claim",
      createdAt: "2026-09-01T12:00:00Z",
      description: {
        $type: "at.linkedopendata.richtext#text",
        text: "Supports the base claim.",
        facets: [{ index: { byteStart: 0, byteEnd: 8 }, features: [{ $type: "at.linkedopendata.richtext#property", property: "http://purl.org/mira-science/mira#supports", ref: { uri: "at://did:plc:ghi/science.mira.claim/3h7r" } }] }],
      },
    },
  };
  const t = await triples(normalize(rec, { lodBase: BASE, context: miraContext }));
  const R = B("did:plc:abc/science.mira.claim/3k2x");
  const D = `<${BASE}/at/did:plc:abc/science.mira.claim/3k2x#description>`;
  for (const e of [
    `${R} <http://purl.org/dc/terms/description> ${D} .`,
    `${D} <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://rdfs.org/sioc/ns#Item> .`,
    `${D} <http://rdfs.org/sioc/ns#content> "Supports the base claim." .`,
  ]) {
    assert.ok(t.includes(e), `missing: ${e}`);
  }
  assert.ok(!t.some((x) => x.includes("3h7r")), "nothing from the facets");
  assert.ok(!t.some((x) => x.startsWith("_:")), "no blank nodes");
});

test("description: an external text is a reference typed sioc:Item", async () => {
  const rec = {
    uri: "at://did:plc:abc/science.mira.claim/3k2y",
    cid: "bafyreiB",
    value: {
      $type: "science.mira.claim",
      createdAt: "2026-09-01T12:00:00Z",
      description: { $type: "at.linkedopendata.defs#ref", uri: "at://did:plc:def/org.example.text/3t1", cid: "bafyreiT" },
    },
  };
  const t = await triples(normalize(rec, { lodBase: BASE, context: miraContext }));
  const V = B("did:plc:def/org.example.text/3t1/bafyreiT");
  assert.ok(t.includes(`${B("did:plc:abc/science.mira.claim/3k2y")} <http://purl.org/dc/terms/description> ${V} .`), "pinned shared text");
  assert.ok(t.includes(`${V} <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://rdfs.org/sioc/ns#Item> .`));
});

test("a pinned resource outside ATProto is named by the hash of its bytes (ni:), §6.7", async () => {
  // CID (raw, sha-256) and digest of the bytes "figure 2", computed independently.
  const cid = "bafkreih63vqyyvo52nrxr3vnp7b4w2bckhzhld4irecu5m4amvqy7hivle";
  const NI = "<ni:///sha-256;_t1hjFXd02N47q1_w8toIlHydY-IiQVOs4BlYY-dFVk>";
  const ev = (observationBase: object) => ({
    uri: "at://did:plc:abc/science.mira.evidence/3e1",
    cid: "bafyreiE",
    value: { $type: "science.mira.evidence", createdAt: "2026-09-01T12:00:00Z", observationBase },
  });
  const E = B("did:plc:abc/science.mira.evidence/3e1");
  const P = MIRA("observationBase");
  const data = "<https://example.org/data/figure2.png>";
  const pinned = await triples(normalize(ev({ uri: "https://example.org/data/figure2.png", cid }), { lodBase: BASE, context: miraContext }));
  for (const e of [`${E} ${P} ${NI} .`, `${NI} <http://purl.org/dc/terms/isVersionOf> ${data} .`, `${NI} <https://linkedopendata.at/ns/atp#cid> "${cid}" .`]) {
    assert.ok(pinned.includes(e), `missing: ${e}`);
  }
  const unpinned = await triples(normalize(ev({ uri: "https://example.org/data/figure2.png" }), { lodBase: BASE, context: miraContext }));
  assert.ok(unpinned.includes(`${E} ${P} ${data} .`), "unpinned: the URI itself");
  // A CID without an ni: form (here CIDv0): the version is a blank node.
  const v0 = await triples(normalize(ev({ uri: "https://example.org/data/figure2.png", cid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" }), { lodBase: BASE, context: miraContext }));
  assert.ok(v0.some((t) => t.startsWith(`${E} ${P} _:`)), "blank node");
  assert.ok(v0.some((t) => t.startsWith("_:") && t.includes(`isVersionOf> ${data}`)));
});
