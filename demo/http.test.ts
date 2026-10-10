// The HTTP broker: JSON-LD from the Web through the same HTML view. A local server stands in
// for the Discourse Graphs API (data document, context, and an HTML content page).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import jsonld from "jsonld";
import { rdfaTriples } from "./rdf.ts";

const SOURCE = "http://127.0.0.1:28090";
const BROKER = "http://127.0.0.1:28181";
const data = `${SOURCE}/api/data/7478/31687`;
const page = (p: string) => `${BROKER}/http/127.0.0.1:28090${p}`;

const context = {
  "@context": {
    dct: "http://purl.org/dc/terms/",
    sioc: "http://rdfs.org/sioc/ns#",
    mira: "http://purl.org/mira-science/mira#",
    title: "dct:title",
    format: "dct:format",
    content: "sioc:content",
    description: { "@id": "dct:description", "@type": "@id" },
    created: { "@id": "dct:created", "@type": "http://www.w3.org/2001/XMLSchema#dateTime" },
    has_container: { "@id": "sioc:has_container", "@type": "@id" },
  },
};
const doc = {
  "@context": [`${SOURCE}/schema/context.jsonld`, { sdata: `${SOURCE}/api/data/7478/`, page: `${SOURCE}/api/content/7478/31687#` }],
  "@id": "sdata:31687",
  "@type": ["mira:Claim"],
  has_container: `${SOURCE}/api/data/7478`,
  created: "2026-08-29T16:50:24.013Z",
  title: "Plugins are intuitive",
  description: { "@id": "page:content", format: "text/html", content: "<p>As is the <em>MIRA</em> schema</p>" },
};

let source: Server;
let broker: ChildProcess;
before(async () => {
  source = createServer((req, res) => {
    const body = req.url === "/schema/context.jsonld" ? context : req.url === "/api/data/7478/31687" ? doc : undefined;
    if (req.url === "/api/content/7478/31687") return res.writeHead(200, { "content-type": "text/html" }).end("<p>content</p>");
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/ld+json" }).end(JSON.stringify(body));
  }).listen(28090, "127.0.0.1");
  const env = { ...process.env, BROKER, LOD_BASE: "http://127.0.0.1:28180", HTTP_HOSTS: SOURCE };
  broker = spawn(process.execPath, [new URL("../broker/server.ts", import.meta.url).pathname], { stdio: ["ignore", "ignore", "inherit"], env });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BROKER}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("broker did not start");
});
after(() => {
  broker.kill();
  source.close();
});

const documentLoader = async (url: string) => {
  const res = await fetch(url, { headers: { accept: "application/ld+json" } });
  return { contextUrl: null, documentUrl: res.url, document: await res.json() };
};
async function jsonTriples(url: string): Promise<Set<string>> {
  const json = await (await fetch(url, { headers: { accept: "application/ld+json" } })).json();
  const nq = (await jsonld.toRDF(json, { format: "application/n-quads", documentLoader, base: url })) as string;
  return new Set(nq.trim().split("\n"));
}
const html = async (url: string) => (await fetch(url, { headers: { accept: "text/html" } })).text();
const dropTime = (t: Set<string>, url: string) => [...t].filter((x) => !(x.startsWith(`<${url}>`) && x.includes("dc/terms/modified"))).sort();

test("full HTML view: RDFa gives the same graph as the JSON-LD", async () => {
  const url = page("/api/data/7478/31687");
  const fromJson = dropTime(await jsonTriples(url), url);
  assert.deepEqual(dropTime(await rdfaTriples(await html(url + "?full=true"), url), url), fromJson);
  assert.ok(fromJson.some((t) => t.startsWith(`<${data}> <http://purl.org/dc/terms/title>`)), "the source keeps its IRIs");
  assert.ok(fromJson.some((t) => t.startsWith(`<${url}> <http://www.w3.org/ns/prov#wasDerivedFrom> <${data}>`)), "provenance");
});

test("light HTML view: the description's HTML is embedded, and its RDFa is about the text item", async () => {
  const url = page("/api/data/7478/31687");
  const body = await html(url);
  assert.ok(body.includes("<p>As is the <em>MIRA</em> schema</p>"), "HTML embedded as is");
  assert.ok(!body.includes("<section"), "no section per node");
  const all = await jsonTriples(url);
  const light = await rdfaTriples(body, url);
  for (const t of light) assert.ok(all.has(t), `not in the JSON-LD: ${t}`);
  const item = `${SOURCE}/api/content/7478/31687#content`;
  assert.ok(light.has(`<${data}> <http://purl.org/dc/terms/description> <${item}> .`));
  assert.ok([...light].some((t) => t.startsWith(`<${item}> <http://rdfs.org/sioc/ns#content>`)), "content of the item, not of the claim");
});

test("links to the source go through the broker; other pages go to the source", async () => {
  const body = await html(page("/api/data/7478/31687") + "?full=true");
  assert.ok(body.includes(`href="${page("/api/data/7478")}"`), "container through the broker");
  assert.ok(body.includes(`resource="${SOURCE}/api/data/7478"`), "RDF object stays the source IRI");
  const content = await fetch(page("/api/content/7478/31687"), { redirect: "manual" });
  assert.equal(content.status, 303, "not JSON-LD: see the source");
  assert.equal(content.headers.get("location"), `${SOURCE}/api/content/7478/31687`);
  assert.equal((await fetch(`${BROKER}/http/example.org/x`)).status, 404, "host not allowed");
});
