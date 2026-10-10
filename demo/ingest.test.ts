// Write path: JSON-LD in, ATProto records out (broker/ingest.ts). Needs the local PDS,
// seeded (npm run seed); writes one claim to the demo account, the same one on every run.
// A local server stands in for purl.org, so that the sample data is read offline.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { config } from "./config.ts";

const CONTEXTS = "http://127.0.0.1:48090";
const BROKER = "http://127.0.0.1:48081";
const LOD_BASE = "http://127.0.0.1:48080";
const { did } = config;
const schema = new URL("../../schema/", import.meta.url);
const miraContext = readFileSync(new URL("mira.jsonld", schema), "utf8");
const sample = JSON.parse(readFileSync(new URL("sampleData.json", schema), "utf8"));
sample["@context"][0] = `${CONTEXTS}/mira.jsonld`;

let contexts: Server;
let broker: ChildProcess;
before(async () => {
  contexts = createServer((req, res) => {
    if (req.url !== "/mira.jsonld") return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/ld+json" }).end(miraContext);
  }).listen(48090, "127.0.0.1");
  const env = { ...process.env, BROKER, LOD_BASE, CONTEXT_HOSTS: "127.0.0.1:48090" };
  broker = spawn(process.execPath, [new URL("../broker/server.ts", import.meta.url).pathname], { stdio: ["ignore", "ignore", "inherit"], env });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BROKER}/contexts/at.linkedopendata.jsonld`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("broker did not start");
});
after(() => {
  broker.kill();
  contexts.close();
});

const post = async (path: string, doc: unknown, token?: string) => {
  const res = await fetch(BROKER + path, {
    method: "POST",
    headers: { "content-type": "application/ld+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(doc),
  });
  return { status: res.status, json: (await res.json()) as any };
};
type R = Record<string, any>;
const results = (report: R, severity: string, component?: string) =>
  (report["sh:result"] as R[]).filter((r) => r["sh:resultSeverity"]["@id"] === `sh:${severity}` && (!component || r["sh:sourceConstraintComponent"]["@id"].endsWith(component)));

test("validate: the sample data conforms to the MIRA shapes; the report says what the binding drops", async () => {
  const { status, json } = await post("/validate", sample);
  assert.equal(status, 200);
  assert.equal(json.blocking, 0, JSON.stringify(results(json.report, "Violation")));
  const dropped = results(json.report, "Info", "ClosedConstraintComponent");
  assert.ok(dropped.length > 0 && dropped.every((r) => r["sh:resultPath"]["@id"] === "http://purl.org/dc/terms/creator"), "only dct:creator is dropped");
  const notConverted = results(json.report, "Info", "ConversionNote").filter((r) => r["sh:resultMessage"].startsWith("Not converted"));
  assert.ok(notConverted.some((r) => r["sh:focusNode"]["@id"].endsWith("/261147")), "the relation instance has no record type");
});

test("validate: a violation of the MIRA shapes blocks", async () => {
  const broken = structuredClone(sample);
  broken["@graph"].find((n: R) => n["@type"] === "Evidence").observationStatement = "sdata:270001"; // a study, not a claim
  const { json } = await post("/validate", broken);
  assert.ok(json.blocking > 0);
  assert.ok(results(json.report, "Violation", "ClassConstraintComponent").length > 0);
});

test("convert: one record per node with a record type, references between them, sameAs", async () => {
  const { json } = await post(`/convert?did=${did}`, sample);
  assert.equal(json.blocking, 0);
  assert.deepEqual(json.records.map((r: R) => r.record.$type).sort(), ["science.mira.claim", "science.mira.claim", "science.mira.evidence", "science.mira.sourceDocument", "science.mira.study"]);
  assert.deepEqual(results(json.report, "Violation", "LexiconConstraintComponent"), [], "records are valid for their lexicons");
  const bySource = new Map(json.records.map((r: R) => [r.source.replace("https://example.com/api/data/1/", "sdata:"), r]));
  const ev = bySource.get("sdata:270010") as R;
  assert.equal(ev.record.observationStatement.uri, (bySource.get("sdata:261134") as R).uri, "batch reference: the planned at:// URI");
  assert.equal(ev.record.observationBase.uri, "https://example.com/data/binding-assay/figure2.csv", "other IRIs stay as they are");
  assert.deepEqual(ev.record.sameAs, ["https://example.com/api/data/1/270010"]);
  assert.ok(ev.uri.startsWith(`at://${did}/science.mira.evidence/`));
});

const SOURCE = "https://example.com/ingest-test/claim-1";
const base = `${LOD_BASE}/at/${did}/science.mira.claim/3mirac2222222#it`;
const claim = {
  "@context": [`${CONTEXTS}/mira.jsonld`],
  "@id": SOURCE,
  "@type": "Claim",
  created: "2026-10-10T08:00:00.000Z",
  title: "CLM - Converted from JSON-LD",
  supports: base,
  description: {
    "@id": "https://example.com/ingest-test/claim-1/content",
    "@type": "Item",
    format: "text/html",
    content:
      `<p>See <a href="https://example.org/fig">the figure</a>: it <span property="mira:supports" resource="${base}">supports the base claim</span>` +
      ` and does not <span property="mira:opposes" resource="https://example.org/other">oppose</span> it.</p>`,
  },
};

test("convert: references to records are pinned; HTML descriptions become text and facets (mirror rule)", async () => {
  const { json } = await post(`/convert?did=${did}`, claim);
  const rec = json.records[0].record;
  assert.match(rec.supports[0].cid ?? "", /^bafy/, "pinned to the current version");
  assert.equal(rec.supports[0].uri, `at://${did}/science.mira.claim/3mirac2222222`);
  assert.equal(rec.description.text, "See the figure: it supports the base claim and does not oppose it.");
  const features = rec.description.facets.map((f: R) => f.features[0]);
  assert.deepEqual(features.map((f: R) => f.$type), ["app.bsky.richtext.facet#link", "at.linkedopendata.richtext#property"], "no facet for a statement the record does not make");
  assert.equal(features[1].ref.cid, rec.supports[0].cid);
  const text = Buffer.from(rec.description.text);
  const span = rec.description.facets[1].index;
  assert.equal(text.subarray(span.byteStart, span.byteEnd).toString(), "supports the base claim");
  assert.ok(results(json.report, "Info", "ConversionNote").some((r) => r["sh:resultMessage"].startsWith("Inline description used")));
});

test("records: needs a token; writes, and the same source updates the same record", async () => {
  assert.equal((await post("/records", claim)).status, 401);
  const session = await (
    await fetch(`${config.pds}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: did, password: config.password }),
    })
  ).json();
  const first = await post("/records", claim, session.accessJwt);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const second = await post("/records", { ...claim, title: "CLM - Converted from JSON-LD, again" }, session.accessJwt);
  assert.equal(second.json.records[0].uri, first.json.records[0].uri, "found again by its sameAs");
  assert.equal(second.json.records[0].action, "update");
  // The broker serves it, with the source as owl:sameAs and the previous version.
  const page = await fetch(second.json.records[0].page, { headers: { accept: "application/ld+json" } });
  const doc = (await page.json()) as R;
  const node = doc["@graph"][0];
  assert.equal(node.title, "CLM - Converted from JSON-LD, again");
  assert.ok(node.sameAs.includes(SOURCE));
  const version = doc["@graph"].find((n: R) => n["sioc:previous_version"]);
  assert.ok(String(version["sioc:previous_version"]).endsWith(`/${first.json.records[0].cid}#it`), "previousVersionCid set by the broker");
});

test("contexts from hosts that are not allowed are refused", async () => {
  const { status, json } = await post("/validate", { ...claim, "@context": "https://example.org/context.jsonld" });
  assert.equal(status, 400);
  assert.match(json.error, /not allowed/);
});
