// LINKS=relative: the broker behind a reverse proxy that serves ‹lod-base› and the broker on
// one public origin. Links and broker URLs are host-relative; IRIs stay absolute.
// Needs the local PDS, seeded (npm run seed). Starts its own broker.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import jsonld from "jsonld";
import { rdfaTriples } from "./rdf.ts";

// As seen through the proxy: one origin. (Here the broker itself, on its own port.)
const ORIGIN = "http://127.0.0.1:28081";
const LOD_BASE = ORIGIN;
const did = "did:web:mira-demo.local";
const claim = `/at/${did}/science.mira.claim/3mirac2222223`;

let broker: ChildProcess;
before(async () => {
  const env = { ...process.env, LINKS: "relative", LOD_BASE, BROKER: ORIGIN };
  broker = spawn(process.execPath, [new URL("../broker/server.ts", import.meta.url).pathname], { stdio: ["ignore", "ignore", "inherit"], env });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${ORIGIN}/contexts/at.linkedopendata.jsonld`);
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
async function triples(doc: object, base: string): Promise<Set<string>> {
  const nq = (await jsonld.toRDF(doc, { format: "application/n-quads", documentLoader, base })) as string;
  return new Set(nq.trim().split("\n"));
}
const get = (path: string, accept: string) => fetch(ORIGIN + path, { headers: { accept }, redirect: "manual" });

test("HTML links to the broker's own resources are host-relative", async () => {
  for (const q of ["", "?full=true"]) {
    const body = await (await get(claim + q, "text/html")).text();
    const hrefs = [...body.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length >= 3, `links found: ${hrefs.length}`);
    assert.deepEqual(hrefs.filter((h) => h.startsWith(ORIGIN) || h.startsWith(LOD_BASE)), [], `absolute links in ${claim}${q}`);
    assert.ok(hrefs.some((h) => h.startsWith(`/at/${did}/`)));
  }
});

test("RDFa keeps absolute IRIs and gives the same graph as JSON-LD", async () => {
  const url = `${ORIGIN}${claim}?full=true`;
  const html = await (await get(claim + "?full=true", "text/html")).text();
  const json = await (await get(claim, "application/ld+json")).json();
  assert.deepEqual(json["@context"], ["/contexts/science.mira.jsonld", "/contexts/at.linkedopendata.jsonld"], "relative contexts");
  const drop = (t: Set<string>) => [...t].filter((x) => !x.includes("dc/terms/modified")).sort();
  const fromRdfa = drop(await rdfaTriples(html, url));
  const fromJson = drop(await triples(json, ORIGIN + claim));
  assert.deepEqual(fromRdfa, fromJson);
  assert.ok(fromJson.some((t) => t.startsWith(`<${LOD_BASE}${claim}#it> <http://purl.org/mira-science/mira#supports>`)), "absolute IRIs");
});

test("redirects and Link headers are host-relative", async () => {
  const pinned = (await (await get(claim, "application/ld+json")).json())["@graph"][0].supports[0].uri as string;
  const stale = new URL(pinned).pathname; // a superseded version of the base claim
  const res = await get(stale, "application/ld+json");
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location") ?? "", /^\/at\/.*\?pinned=/);
  assert.match(res.headers.get("link") ?? "", /^<\/at\/[^>]*>; rel="original"$/);
  const rec = await get(`/at/${did}/science.mira.claim/3mirac2222222`, "application/ld+json");
  assert.match(rec.headers.get("link") ?? "", /^<\/at\/[^>]*>; rel="last memento"/);
});
