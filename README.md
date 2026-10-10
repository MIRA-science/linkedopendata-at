# linkedopendata-at

The proposal [_Linked Data for AT Protocol science records_](atproto-linked-data-proposal.md), and a proof of concept of it.

A companion, postponed proposal for MIRA and Discourse Graphs JSON-LD: [literal descriptions](description-text-proposal.md).

**Nothing here is adopted or deployed.** Placeholders: the `atp:` vocabulary IRI and the community context URL (Q1), and `‹lod-base›` (Q10).

| Directory     | What                                                                  | Proposal   |
| ------------- | --------------------------------------------------------------------- | ---------- |
| `generator/`  | LinkML → lexicons + JSON-LD context (Python)                          | §10        |
| `normalizer/` | ATProto record → Linked Data view, the Level 2 path (TypeScript)      | §6.5, §6.7 |
| `broker/`     | Serves the Linked Data view (JSON-LD; HTML with RDFa), and the ‹lod-base› redirector. `base.ts`: the common broker (content negotiation, HTML view); `atproto.ts`: ATProto records; `http.ts`: JSON-LD already on the Web | §6.2–6.4   |
| `demo/`       | Sample records on a local PDS, Level 0 ≡ Level 2 tests               | §7         |
| `lexicons/`   | Community lexicons: `at.linkedopendata.defs`, `.lexicon.context`      | §3, §4     |
| `contexts/`   | Community JSON-LD context (prefixes and IRI coercion for added terms) | §6.4       |

## Generator

An authority keeps a _binding_ file next to its schema (for MIRA: `schema/atproto/binding.yaml`), and runs:

```sh
uv run --project generator lod-at-gen path/to/binding.yaml OUTDIR
```

In `schema`: `make atproto`.

## Normalizer

```sh
cd normalizer && npm install && npm test   # Node ≥ 23 (runs TypeScript directly)
```

Tests read the MIRA context from `../schema/atproto/context.jsonld` (override with `MIRA_CONTEXT`). Not yet covered: blobs, `cid-link`, language tags.

## Demo

Needs a local PDS (millipds) with an account. Configuration is in `broker/config.ts`, from the environment.

Broker:

| Variable | Default | |
| --- | --- | --- |
| `PDS` | `http://127.0.0.1:8123` | Full URL of the PDS of every account served (e.g. `https://devpds.example.org`) |
| `HOST` | `127.0.0.1` | Hostname in the default `LOD_BASE` and `BROKER`, and in `LISTEN` |
| `LOD_BASE` | `http://‹HOST›:8080` | ‹lod-base›: the redirector, and the base of every IRI |
| `BROKER` | `http://‹HOST›:8081` | Canonical broker endpoint |
| `LISTEN` | `HOST` | Address both servers listen on (e.g. `0.0.0.0`) |
| `LINKS` | `absolute` | `relative`: behind one reverse-proxy origin (below) |
| `CONTEXT_DID` | `DEMO_DID` | Account holding the `science.mira` context record |
| `HTTP_HOSTS` | the Discourse Graphs `mira-collab` preview | Sources of the HTTP broker (below) |
| `CONTEXT_HOSTS` | `purl.org` | Hosts remote contexts of posted JSON-LD may come from (besides `HTTP_HOSTS`) |
| `MIRA_CONTEXT` | `../schema/atproto/context.jsonld` | The generated MIRA context |
| `MIRA_BINDING` | `../schema/atproto/` | The generated binding: lexicons, binding and pinning shapes |
| `MIRA_SHAPES`, `MIRA_ONTOLOGY` | `../schema/mira.shacl`, `../schema/mira.ttl` | For the write path |

Demo (seed and tests): `DEMO_DID` (default `did:web:mira-demo.local`) and `DEMO_PASSWORD` (default `mira`). The seed writes the lexicons (`com.atproto.lexicon.schema` records keyed by NSID, from `MIRA_BINDING`) and the context record to the demo account; the broker reads only the context record, and validates against the lexicon files.

```sh
npm install
npm run seed     # the science.mira lexicons and context record, sample MIRA records
npm run broker   # ‹lod-base› on :8080 (303 redirects), broker on :8081
npm test         # normalizer tests + equivalence tests (starts its own broker)
```

Try `curl -sL http://127.0.0.1:8080/at/did:web:mira-demo.local/science.mira.claim/3mirac2222223`, or open the broker URL in a browser for the HTML view. The seed updates one claim after another claim pinned it, so the pinned version IRI returns `303` to the record (with `Link: rel="original"`), whose HTML view then warns that the current version may differ (§6.7).

### JSON-LD from the Web

The same broker shows JSON-LD that is already published over HTTP, such as the Discourse Graphs API: `https://‹host›/‹path›` is served at `/http/‹host›/‹path›`, for the hosts in `HTTP_HOSTS` (comma-separated hosts, or origins such as `http://127.0.0.1:8090`; default: the Discourse Graphs `mira-collab` preview). It gets the same light and full HTML views, and the same RDFa. The source keeps its IRIs, and links to the same source go through the broker. A page of the source that is not JSON-LD (such as `/api/content/…`) gets a `303` to the source itself.

```sh
open http://127.0.0.1:8081/http/discourse-graph-git-mira-collab-discourse-graphs.vercel.app/api/data/7478/31687
```

A description whose item has `dct:format "text/html"` is embedded as HTML, and the RDFa restates its literal in a `content` attribute, so that the RDFa matches the JSON-LD. This is a proof of concept: the HTML is not sanitized (§9), and the mirror rule is not applied to RDFa inside it.

### From JSON-LD to records

For testing MIRA generators: post their JSON-LD, get back the ATProto records it becomes, and a SHACL report.

| Endpoint          | Does                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| `POST /validate`  | report only                                                              |
| `POST /convert`   | records (not written) and report; `?did=` plans URIs in that repo         |
| `POST /records`   | writes the records to the caller's repo; `Authorization: Bearer ‹accessJwt›` |

```sh
TOKEN=$(curl -s -X POST -H 'content-type: application/json' -d '{"identifier":"did:web:mira-demo.local","password":"mira"}' \
  http://127.0.0.1:8123/xrpc/com.atproto.server.createSession | jq -r .accessJwt)
curl -s -X POST -H "authorization: Bearer $TOKEN" --data @sampleData.json http://127.0.0.1:8081/records
```

The token is passed through to the PDS: the broker never sees a password. Every node typed with a record class becomes a record. Its IRI goes into the record's `sameAs` (`owl:sameAs`), which is how the next post of the same node finds the record and updates it (with `previousVersionCid`). References to ATProto records, by ‹lod-base› IRI or `at://` URI, are pinned to their current version; references between records of the same post are not pinned. An HTML description becomes text and facets: links become link facets, and RDFa spans become `#property` facets when the record makes the statement they restate.

The report is one `sh:ValidationReport` (JSON-LD), with:

- the MIRA shapes, on the input (with the class hierarchy of `mira.ttl`);
- the binding's closed shapes (`binding.shacl.ttl`, generated), on the input: each triple the binding has no field for, as `sh:Info`;
- the pinning shapes, on the Linked Data view of the converted records (`sh:Warning`);
- the lexicons, on the converted records (`sh:Violation`: a gap in the generated shapes);
- notes from the conversion (`sh:Info`), e.g. typed nodes that become no record.

Only violations block a write (`blocking` counts them); `sh:conforms` is false as soon as there is any result. Remote contexts are fetched only from `CONTEXT_HOSTS` and `HTTP_HOSTS`. The broker serves every account of the PDS.

### Behind a reverse proxy

With `LINKS=relative`, links (HTML `href`, `Location` and `Link` headers) and the broker's own URLs (contexts, the response document's `@id`) are host-relative, so the pages work under whatever host the proxy serves. IRIs stay absolute under `LOD_BASE`: set it to the public origin. The proxy serves ‹lod-base› and the broker on that one origin, so the separate redirector is not started.

```nginx
server {
    server_name lod.example.org;
    location / {
        proxy_pass http://127.0.0.1:8081;
    }
}
```

```sh
LINKS=relative LOD_BASE=https://lod.example.org npm run broker
```

## Findings for the proposal

- RDFa: `property` + `resource` links a text item, but does not make it the subject of the content inside; only `typeof` does. An untyped item (as in the Discourse Graphs API) therefore needs `resource` again on the text element.
- Discourse Graphs API (`mira-collab` branch): HTML is in `sioc:content`, where §6.4 item 5 expects plain text and `content:encoded` for HTML; the description text still contains the frontmatter (`nodeTypeId`, `publishedToGroups`), part of it rendered as a heading; the text item is not typed `sioc:Item`.
- The MIRA shapes check the class of references (`sh:class`), so a reference to a node outside the submitted graph needs its type stated there. The converter adds the type of references to ATProto records (from their collection); for other IRIs, producers must type them.
- Converting the live Discourse Graphs node (`/api/data/7478/31687`) gives two MIRA violations: its container is not typed `sioc:Container`, and its description item is not typed `sioc:Item`. Everything `sampleData.json` says is kept except `dct:creator` (the signer, in ATProto) and the relation instance, for which the binding has no record type (`science.mira.relation`).
- ATProto records cannot hold floats, so the context record (§4.1) cannot carry `"@version": 1.1`. The PoC leaves it out and readers add it back.

## Simplifications in the PoC

- DID resolution and `_lexicon` DNS discovery are replaced by static configuration.
- The PDS is a local millipds, which keeps only current record versions.
- Deleted records return `404`, not `410`: the PDS does not distinguish them.
- SHACL validation of broker output covers only the generated pinning warnings (`schema/atproto/pinning.shacl.ttl`), not the MIRA shapes (Q11).
