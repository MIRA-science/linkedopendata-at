// §7: a Level 0 client (via ‹lod-base› and the broker) and a Level 2 client (straight
// from the PDS) get the same graph, apart from what the broker adds (§6.4 items 3–5).
// Needs the local PDS, seeded (npm run seed). Starts the broker itself.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import jsonld from "jsonld";
import { rdfaTriples } from "./rdf.ts";
import { normalize } from "../normalizer/src/index.ts";
// Own ports, so a broker started by hand (npm run broker) does not answer instead.
process.env.LOD_BASE = "http://127.0.0.1:18080";
process.env.BROKER = "http://127.0.0.1:18081";
const { config } = await import("./config.ts");

const { pds, did, lodBase } = config;
const records = [
  "science.mira.question/3miraq2222222",
  "science.mira.claim/3mirac2222222",
  "science.mira.claim/3mirac2222223",
  "science.mira.evidence/3mirae2222222",
];

let broker: ChildProcess;
before(async () => {
  broker = spawn(process.execPath, [new URL("../broker/server.ts", import.meta.url).pathname], { stdio: ["ignore", "ignore", "inherit"], env: process.env });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(config.endpoint + "/contexts/at.linkedopendata.jsonld");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("broker did not start");
});
after(() => broker.kill());

const documentLoader = async (url: string) => {
  const res = await fetch(url, { headers: { accept: "application/ld+json" } });
  return { contextUrl: null, documentUrl: res.url, document: await res.json() };
};

async function triples(doc: object): Promise<Set<string>> {
  const nq = (await jsonld.toRDF(doc, { format: "application/n-quads", documentLoader })) as string;
  return new Set(nq.trim().split("\n"));
}

/** Level 2: record and context from the PDS, normalized locally. */
async function level2(path: string) {
  const get = async (collection: string, rkey: string) => {
    const q = new URLSearchParams({ repo: did, collection, rkey });
    return (await fetch(`${pds}/xrpc/com.atproto.repo.getRecord?${q}`)).json();
  };
  const [collection, rkey] = path.split("/");
  const ctx = await get("at.linkedopendata.lexicon.context", "science.mira");
  const context = { "@version": 1.1, ...ctx.value.context };
  const communityContext = (await documentLoader(`${config.endpoint}/contexts/at.linkedopendata.jsonld`)).document;
  return triples(normalize(await get(collection, rkey), { lodBase, context, communityContext }));
}

/** Level 0: dereference the entity IRI, following the 303. */
async function level0(path: string, accept = "application/ld+json") {
  const res = await fetch(`${lodBase}/at/${did}/${path}`, { headers: { accept } });
  assert.equal(res.status, 200);
  assert.ok(res.redirected, "‹lod-base› redirects to the broker");
  return { url: res.url, body: await res.text() };
}

/** Removes the broker's additions: the document node and retrieval-time statements. */
const withoutBrokerAdditions = (t: Set<string>, docUrl: string) =>
  new Set([...t].filter((x) => !x.startsWith(`<${docUrl}>`) && !x.includes("sioc/ns#latest_version")));

for (const path of records) {
  test(`same graph for Level 0 and Level 2: ${path}`, async () => {
    const { url, body } = await level0(path);
    const broker = withoutBrokerAdditions(await triples(JSON.parse(body)), url);
    assert.deepEqual([...broker].sort(), [...(await level2(path))].sort());
  });
}

test("HTML embeds the same graph as the JSON-LD response (§6.4)", async () => {
  const path = records[2];
  const { url, body } = await level0(path, "text/html");
  const script = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(body);
  assert.ok(script, "embedded JSON-LD");
  const dropTime = (t: Set<string>) => new Set([...t].filter((x) => !x.includes("dc/terms/modified") || !x.startsWith(`<${url}>`)));
  const fromHtml = dropTime(await triples(JSON.parse(script[1])));
  const direct = dropTime(await triples(JSON.parse((await level0(path)).body)));
  assert.deepEqual([...fromHtml].sort(), [...direct].sort());
});


for (const path of records) {
  test(`RDFa in the full HTML view gives the same graph as JSON-LD: ${path}`, async () => {
    const { url: fullUrl, body } = await level0(`${path}?full=true`, "text/html");
    const url = fullUrl.replace(/\?.*$/, "");
    const dropTime = (t: Set<string>) => [...t].filter((x) => !(x.startsWith(`<${url}>`) && x.includes("dc/terms/modified"))).sort();
    const fromRdfa = dropTime(await rdfaTriples(body, url));
    const direct = dropTime(await triples(JSON.parse((await level0(path)).body)));
    assert.deepEqual(fromRdfa, direct);
  });
}

/** Dereferences a path under ‹lod-base›, following the 303. */
async function deref(path: string, accept = "application/ld+json") {
  const res = await fetch(`${lodBase}${path}`, { headers: { accept } });
  assert.equal(res.status, 200, path);
  assert.ok(res.redirected, "‹lod-base› redirects to the broker");
  return { url: res.url, body: await res.text() };
}

test("account document describes the DID itself (§6.1)", async () => {
  const t = await triples(JSON.parse((await deref(`/did/${did}`)).body));
  const SIOC = (x: string) => `<http://rdfs.org/sioc/ns#${x}>`;
  for (const e of [
    `<${did}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ${SIOC("UserAccount")} .`,
    `<${did}> <http://xmlns.com/foaf/0.1/accountName> "mira-demo.local" .`,
    `<${did}> ${SIOC("owner_of")} <${lodBase}/at/${did}#it> .`,
    `<${did}> <http://www.w3.org/2000/01/rdf-schema#seeAlso> <https://mira-demo.local/.well-known/did.json> .`,
  ]) {
    assert.ok(t.has(e), `missing: ${e}`);
  }
  const unknown = await fetch(`${lodBase}/did/did:plc:notserved`, { redirect: "manual" });
  assert.equal(unknown.status, 404, "accounts whose repo is not served");
});

for (const path of [`/did/${did}`, `/at/${did}`]) {
  test(`RDFa in the HTML view of non-record pages gives the same graph as JSON-LD: ${path}`, async () => {
    const { url, body } = await deref(path, "text/html");
    assert.ok(body.includes(`resource="${did}"`), "account links keep the DID as RDF object");
    const dropTime = (t: Set<string>) => [...t].filter((x) => !(x.startsWith(`<${url}>`) && x.includes("dc/terms/modified"))).sort();
    assert.deepEqual(dropTime(await rdfaTriples(body, url)), dropTime(await triples(JSON.parse((await deref(path)).body))));
  });
}

test("description renders as rich text, with RDFa only for restated statements (§3 rule 7)", async () => {
  const { body } = await level0("science.mira.evidence/3mirae2222222", "text/html");
  const div = /<div id="description"[^>]*>([\s\S]*?)<\/div>/.exec(body)?.[1];
  assert.ok(div, "rendered text with the fragment id of ‹record›#description");
  assert.match(div, /<a property="mira:supports" href="[^"]*science\.mira\.claim\/3mirac2222223#it">supports the binding claim<\/a>/);
  assert.match(div, /<a href="https:\/\/example\.org\/data\/figure2\.png">figure 2<\/a>/);
  assert.match(div, /class="unstated"[^>]*>oppose it</, "not restated by the record: no RDFa");
  assert.ok(!div.includes("mira:opposes\""), "no opposes statement in the RDFa");
});

test("a superseded version: 303 to the record, which warns in HTML (§6.7)", async () => {
  const base = `${lodBase}/at/${did}/science.mira.claim/3mirac2222222`;
  // The CID that the supporting claim pinned, before the base claim was updated.
  const pin = (await (await fetch(`${pds}/xrpc/com.atproto.repo.getRecord?${new URLSearchParams({ repo: did, collection: "science.mira.claim", rkey: "3mirac2222223" })}`)).json()).value.supports[0].cid;
  const viaBase = await fetch(`${base}/${pin}`, { redirect: "manual" });
  assert.equal(viaBase.status, 303, "‹lod-base› to the broker");
  const res = await fetch(viaBase.headers.get("location")!, { redirect: "manual" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), `${config.endpoint}/at/${did}/science.mira.claim/3mirac2222222?pinned=${pin}`);
  assert.match(res.headers.get("link") ?? "", /rel="original"/);
  const html = await (await fetch(res.headers.get("location")!, { headers: { accept: "text/html" } })).text();
  assert.match(html, /class="banner">You followed a reference to version/);
  const plain = await (await fetch(`${config.endpoint}/at/${did}/science.mira.claim/3mirac2222222`, { headers: { accept: "text/html" } })).text();
  assert.ok(!plain.includes('class="banner"'), "no warning without the parameter");
});

/** SHACL validation of broker output against generated shapes (Q11). */
async function shaclResults(path: string, shapesFile: string) {
  const { default: rdf } = await import("@zazuko/env");
  const { default: SHACLValidator } = await import("rdf-validate-shacl");
  const { Parser } = await import("n3");
  const { readFileSync } = await import("node:fs");
  const parse = (text: string, format: string) => rdf.dataset(new Parser({ format }).parse(text) as any);
  const shapes = parse(readFileSync(shapesFile, "utf8"), "text/turtle");
  const nq = (await jsonld.toRDF(JSON.parse((await deref(path)).body), { format: "application/n-quads", documentLoader })) as string;
  const report = await new SHACLValidator(shapes, { factory: rdf }).validate(parse(nq, "application/n-quads"));
  return report.results.map((r: any) => ({ severity: r.severity?.value, focus: r.focusNode?.value, path: r.path }));
}

const PINNING = new URL("../../schema/atproto/pinning.shacl.ttl", import.meta.url).pathname;
const WARNING = "http://www.w3.org/ns/shacl#Warning";

test("unpinned references get SHACL warnings, pinned ones none (Q11)", async () => {
  // The evidence references the supporting claim without a cid, twice.
  const evidence = await shaclResults(`/at/${did}/science.mira.evidence/3mirae2222222`, PINNING);
  assert.equal(evidence.length, 2, JSON.stringify(evidence));
  assert.ok(evidence.every((r) => r.severity === WARNING && r.focus.endsWith("/science.mira.evidence/3mirae2222222#it")));
  // The supporting claim pins what it supports; its description is inline.
  assert.deepEqual(await shaclResults(`/at/${did}/science.mira.claim/3mirac2222223`, PINNING), []);
  // The question's description is an https reference: not an ATProto record, so no warning.
  assert.deepEqual(await shaclResults(`/at/${did}/science.mira.question/3miraq2222222`, PINNING), []);
});

const PLUMBING_PREDICATES = ["owl#sameAs", "sioc/ns#id>", "sioc/ns#link>", "sioc/ns#has_space>", "sioc/ns#has_container>", "sioc/ns#latest_version>"];

for (const path of records) {
  test(`light HTML view: the record's own statements, nothing else: ${path}`, async () => {
    const { url, body } = await level0(path, "text/html");
    assert.ok(body.includes("?full=true"), "link to the full view");
    assert.ok(!body.includes("<section"), "no section per node");
    assert.ok(!/property="(owl:sameAs|sioc:(id|link|has_space|has_container|latest_version))"/.test(body), "no structural rows");
    const light = await rdfaTriples(body, url);
    const all = await triples(JSON.parse((await level0(path)).body));
    const extra = [...light].filter((t) => !all.has(t));
    assert.deepEqual(extra, [], "RDFa adds nothing to the JSON-LD graph");
    const record = `<${lodBase}/at/${did}/${path}#it>`;
    const own = [...all].filter((t) => t.startsWith(record + " ") && !PLUMBING_PREDICATES.some((p) => t.includes(p)));
    assert.deepEqual(own.filter((t) => !light.has(t)), [], "every non-structural statement of the record is in the RDFa");
    // The inline description item, with its plain text.
    for (const t of all) if (t.startsWith(`<${lodBase}/at/${did}/${path}#description>`)) assert.ok(light.has(t), `missing: ${t}`);
  });
}

test("Memento: the record links its last memento, versions carry Memento-Datetime (RFC 7089)", async () => {
  const recPath = `/at/${did}/science.mira.claim/3mirac2222222`;
  const res = await fetch(`${config.endpoint}${recPath}`, { headers: { accept: "application/ld+json" } });
  const m = /<([^>]+)>; rel="last memento"; datetime="([^"]+)"/.exec(res.headers.get("link") ?? "");
  assert.ok(m, res.headers.get("link") ?? "no Link header");
  const current = (await (await fetch(`${pds}/xrpc/com.atproto.repo.getRecord?${new URLSearchParams({ repo: did, collection: "science.mira.claim", rkey: "3mirac2222222" })}`)).json()).cid;
  assert.equal(m[1], `${config.endpoint}${recPath}/${current}`);
  assert.equal(m[2], new Date("2026-10-09T13:00:00.000Z").toUTCString(), "the record's updatedAt");
  const version = await fetch(m[1], { headers: { accept: "application/ld+json" } });
  assert.equal(version.status, 200);
  assert.equal(version.headers.get("memento-datetime"), m[2]);
  assert.match(version.headers.get("link") ?? "", /rel="original"/);
  const html = await (await fetch(`${config.endpoint}${recPath}`, { headers: { accept: "text/html" } })).text();
  assert.ok(html.includes(`data-iri="${lodBase}${recPath}/${current}#it"`), "permalink with copy button");
});
