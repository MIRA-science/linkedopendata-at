# Linked Data for AT Protocol science records: lexicon contexts, identity, and brokers

- **Status:** DRAFT proposal for discussion in the ATScience community. Nothing here is adopted, published, or deployed.
- **Author:** Marc-Antoine Parent (Discourse Graphs, MIRA consortium and Conversence)
- **Date:** 2026-10-01 (revision 2: record versions and pinned references, §6.7; persistent IRI base, §6.3)
- **First intended adopter:** MIRA (`science.mira.*`), see `atproto/` on the `atproto-lexicon-draft` branch of the MIRA schema repository.

## Abstract

Scientific communities are starting to publish structured records (claims, evidence, datasets, reviews, annotations) over AT Protocol. Some of them already describe these records with RDF ontologies, and want them to be part of the Linked Open Data (LOD) web. The same communities often use, or are considering, other transports as well (Fediverse, IPLD, KOI, Web3, plain HTTP).

This proposal defines four small conventions that together make ATProto records first-class Linked Data, without asking ordinary LOD clients to embed an ATProto client:

1. **Lexicon/JSON-LD conventions:** a way of writing lexicons so that every record maps to RDF through a JSON-LD 1.1 context, with no change to the record format.
2. **Context association:** a way to find the JSON-LD context for any NSID, reusing ATProto's existing lexicon-resolution chain.
3. **Versioning rules:** keeping ontology terms, lexicons and contexts in step over time.
4. **Identity and brokers:** inside ATProto, records keep their `at://` URIs. In the Linked Data view, every `at://` IRI is replaced by an HTTPS IRI under a persistent base (e.g. on w3id.org), linked back to it with `owl:sameAs`. That base redirects to the _canonical broker_ for each namespace, which serves the records as JSON-LD and HTML. Specific versions of a record, as pinned by strong references, get their own IRIs under the same base.

The pattern is transport-neutral: each other transport can get its own profile with the same shape (native identifier, canonical broker, `sameAs`).

## 1. Motivation

- **Shared semantics.** Lexicons define structure, not meaning. Two communities that both have a `createdAt` or `supports` field cannot tell whether they mean the same thing. RDF term IRIs can.
- **Reach beyond the Atmosphere.** Knowledge graphs, SPARQL endpoints, library and repository systems, search engines (via schema.org JSON-LD), and FAIR tooling all speak RDF, not XRPC.
- **Transport pluralism.** Scientific consortia rarely agree on one transport. If the _data model_ is RDF and the transports are bindings of it, clients can consume records without caring where they were published.
- **Low client burden.** Requiring every consumer to resolve DIDs, talk to PDSes and verify repo commits is a barrier for most LOD tools. A broker per namespace removes it, while native clients keep a fully decentralized path.

## 2. Terminology

- **Authority**: the domain that controls an NSID namespace (e.g. `mira.science` for `science.mira.*`).
- **Subspace**: a (transport, authority) pair, e.g. ATProto records whose collection is under `science.mira.*`.
- **Context**: a JSON-LD 1.1 context document that maps a lexicon's fields and types to RDF IRIs.
- **Broker**: an HTTP service that dereferences the records of one or more subspaces and returns them as JSON-LD and HTML.
- **Canonical broker**: the broker that the authority designates for its subspace (§6.2).
- **`at.linkedopendata`**: the community-owned NSID namespace for the shared definitions in this proposal, controlled through the domain `linkedopendata.at` (Q1).
- **`‹lod-base›`**: a persistent HTTPS base (e.g. `https://w3id.org/‹…›`) under which the HTTPS IRIs of this proposal are minted. It redirects to canonical brokers (§6.3, open question Q10).
- **Version**: one state of a record, identified by the pair (`at://` URI, CID) (§6.7).
- **`atp:`**: prefix for a small vocabulary of ATProto-specific terms (`atp:cid`, `atp:Blob`, …). Its IRI is still to be chosen (Q1).

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 3. Lexicon conventions for RDF mapping

These rules are about how lexicons are _written_. Records written against a conforming lexicon need no extra fields: in particular, records do **not** carry `@context`.

1. **One record type per NSID.** The `main` def is the record. Its `$type` maps to one RDF class.
2. **Every field is mapped.** Each property of each def MUST have a term definition in the context, or be explicitly declared unmapped. JSON-LD silently drops unmapped keys, so a linter MUST check coverage (§5.3).
3. **References are objects with `uri` and optional `cid`.** A reference to another record uses an object def with a required `uri` and an optional `cid`, compatible with `com.atproto.repo.strongRef` when both are present. For references that may cross transports, `uri` SHOULD use `format: uri` rather than `format: at-uri`, so that a record can point at a Ceramic stream, a KOI RID or a DOI. A shared def for this is proposed as `at.linkedopendata.defs#ref`. A reference with a `cid` is a _pinned_ reference: it refers to that version of the target, not to the record in general (§6.7). For a target outside ATProto, `cid` is the CID of the target's bytes (raw codec, sha-256), as ATProto computes it for blobs: it pins the exact content, which readers can check. Producers SHOULD pin references to ATProto records: the author knows which version they read, and the client usually fetched it (with its CID) to show it. Pins are not required, and lexicons SHOULD NOT require them by using `com.atproto.repo.strongRef`, which would also restrict the target to ATProto. Validators flag unpinned references as warnings (Q11).
4. **No stored inverses.** Only one direction of a relation is stored (e.g. `supports`, not `supportedBy`). Inverses are derived by indexers, as ATProto already does for follows. The ontology declares them with `owl:inverseOf`.
5. **Field names are permanent; meaning lives in the context.** Lexicon field names follow ATProto style (`createdAt`, camelCase). The context maps them to established vocabularies (`dct:created`, …).
6. **Enumerations use `knownValues` tokens mapped in the context** with `"@type": "@vocab"`, so that each token becomes an IRI.
7. **Rich text** is plain text plus facets, following ATProto convention (`app.bsky.richtext.facet`). A field whose value is a text (a description, say) rather than a short string is a union of two members: an inline text item, `at.linkedopendata.richtext#text` (`text` plus `facets`), or a reference, `at.linkedopendata.defs#ref`, to an external or shared text. The context maps both members to the field's range class (e.g. `sioc:Item`) and `text` to `sioc:content`, and leaves `facets` unmapped: facets are presentation only. The community facet feature `at.linkedopendata.richtext#property` marks a span as restating a statement that the record already makes (_mirror rule_). Clients need not understand it. Brokers render it as RDFa, but only when the record does make that statement, so the HTML view never adds triples (§6.4).
8. **No field names starting with `@`,** and no reliance on JSON-LD keywords inside records.
9. **Version history uses `previousVersionCid`.** A record that tracks its own history MAY have an optional `previousVersionCid` field (`format: cid`), set on each update to the CID of the version it replaces. It is explicitly unmapped in the context, and turned into `sioc:previous_version` by the rewrite (§6.7). Predecessors with a different URI are handled as replacements, not versions (§6.7).
10. **Non-integer numbers are strings.** The ATProto data model has no floating-point numbers. A field holding a decimal or floating-point value is a string with the lexical form of its XSD datatype, referring (`"type": "ref"`) to the shared string defs `at.linkedopendata.defs#decimal` (`xsd:decimal`) or `#double` (`xsd:double`). The context gives the datatype (`"@type": "xsd:decimal"`), so the value becomes a typed literal. Lexicons cannot constrain the lexical form; SHACL shapes do (`sh:datatype` rejects ill-formed literals). Integers use the lexicon `integer` type.

### 3.1 Mapping ATProto idioms with JSON-LD 1.1

JSON-LD 1.1 can express the ATProto idioms directly:

| ATProto idiom                                                    | JSON-LD mechanism                                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `$type`                                                          | keyword alias: `"$type": "@type"`                                                                                                            |
| NSID type values (`science.mira.claim`, `science.mira.defs#ref`) | term definitions mapping each NSID to a class IRI                                                                                            |
| fields whose meaning depends on the record type                  | type-scoped context on the NSID's term, with `"@propagate": true`                                                                            |
| `{uri, cid}` reference objects                                   | property-scoped context in which `uri` aliases `@id` and `cid` is mapped to `null`; pinned references are rewritten into version IRIs (§6.7) |
| `datetime` strings                                               | `"@type": "xsd:dateTime"`                                                                                                                    |
| decimal and floating-point strings (§3 rule 10)                  | `"@type": "xsd:decimal"` or `"@type": "xsd:double"`                                                                                          |
| arrays                                                           | `"@container": "@set"`, or `@list` when order matters                                                                                        |
| `knownValues`                                                    | `"@type": "@vocab"` plus term definitions for the tokens                                                                                     |
| blobs, `cid-link`, `bytes`                                       | rewritten by the broker (§6.5), since bare CIDs are not IRIs                                                                                 |

Each authority publishes **one context** for all its NSIDs (§4.1). Terms shared by all its record types sit at the top level. Terms whose meaning depends on the record type (a `subject` or `text` field, say) sit in a **type-scoped context** attached to the NSID's term, which applies whenever a record's `$type` names it. Type-scoped contexts do not apply to nested objects by default, so they set `"@propagate": true`.

A context belongs to one serialization. The same ontology may also be serialized in other ways, for instance an application's own JSON-LD with other field names, IRI strings as references, or a literal where a lexicon has a text item. Those contexts differ from the lexicon's, but data in any of them MUST yield the same RDF for the same statements.

Example (abridged) context for the authority `science.mira`:

```json
{
   "@context": {
      "@version": 1.1,
      "mira": "http://purl.org/mira-science/mira#",
      "dct": "http://purl.org/dc/terms/",
      "sioc": "http://rdfs.org/sioc/ns#",
      "xsd": "http://www.w3.org/2001/XMLSchema#",
      "atp": "‹atp-vocabulary-iri›#",
      "$type": "@type",
      "createdAt": { "@id": "dct:created", "@type": "xsd:dateTime" },
      "updatedAt": { "@id": "dct:modified", "@type": "xsd:dateTime" },
      "science.mira.claim": {
         "@id": "mira:Claim",
         "@context": {
            "@propagate": true,
            "title": "dct:title",
            "description": {
               "@id": "dct:description",
               "@context": {
                  "at.linkedopendata.richtext#text": "sioc:Item",
                  "at.linkedopendata.defs#ref": "sioc:Item",
                  "text": "sioc:content",
                  "facets": null,
                  "uri": "@id",
                  "cid": null
               }
            },
            "supports": {
               "@id": "mira:supports",
               "@container": "@set",
               "@context": { "uri": "@id", "cid": null }
            }
         }
      },
      "science.mira.evidence": {
         "@id": "mira:Evidence",
         "@context": { "@propagate": true }
      }
   }
}
```

Applied on its own, this context turns a pinned reference into a reference to the record in general. The resulting graph is less precise, but not wrong; doing so is still not a conforming way to read records (§7). Mapping `cid` to a property such as `atp:cid` _would_ be wrong: the CID would become a property of the _target_ node, so if two records pin different versions of the same target, nothing would say which pin belongs to which edge. Version identity therefore needs a rewrite step, which a context cannot express (§6.7).

## 4. Associating a context with a lexicon

### 4.1 For lexicons you publish

ATProto already resolves lexicons like this: the NSID authority (e.g. `mira.science`) has a DNS TXT record at `_lexicon.mira.science` of the form `did=did:plc:…`, and that DID's repo holds the lexicon as a `com.atproto.lexicon.schema` record whose record key is the NSID.

This proposal adds a **companion record in the same repo**:

- collection: `at.linkedopendata.lexicon.context`
- record key: the NSID prefix that the authority controls (e.g. `science.mira` for `mira.science`)
- content: the authority's JSON-LD context (as a JSON object, without `@version`), covering all its NSIDs, plus the revision of each lexicon it was generated from

ATProto records cannot hold the number `1.1`, so the stored context omits `"@version": 1.1`, and readers add it back before use. Since `@version` is the only number a context contains, no other encoding is needed.

A nested NSID group with its own authority (e.g. `science.mira.ext.*`, resolved through `_lexicon.ext.mira.science`) has its own context.

Because it sits in the same repo as the lexicon, the context inherits the same authority check and the same signatures. No new DNS convention is needed.

Fallbacks:

- The authority MAY also serve contexts over HTTPS at `https://‹authority›/.well-known/lexicon-context.jsonld`.
- Brokers MUST serve the normalized JSON-LD of §6.4 by default, including to clients that ask for `application/json`. They MAY serve the raw record, but only on explicit request (mechanism to be defined, see Q4).
- A raw record MUST NOT be served with the JSON-LD context header (`rel="http://www.w3.org/ns/json-ld#context"`), because generic JSON-LD processors apply that context automatically, without the normalization of §6.5 (see §7). Brokers SHOULD instead point to the context with a link relation of this proposal (`Link: <‹context-url›>; rel="‹lexicon-context-rel›"`, an IRI to be defined under `linkedopendata.at`), which only conforming clients act on.

### 4.2 For lexicons you do not control

Anyone MAY publish an **overlay context** for someone else's NSIDs, as an `at.linkedopendata.lexicon.context` record in their own repo, keyed by the NSID prefix it covers. Overlays are not authoritative. A broker or client that uses one SHOULD record which overlay it used (§6.4). An authority context, when it exists, takes precedence.

## 5. Versioning

Versioning is where lexicons and ontologies differ most, so the rules separate **meaning** from **structure**.

### 5.1 Terms (meaning)

- Term IRIs (`mira:Claim`, `mira:supports`) are stable and not versioned.
- If the meaning of a term changes, a new term is minted. The old one gets `owl:deprecated true` and `dct:isReplacedBy`.
- The ontology as a whole carries `owl:versionInfo`, and MAY carry `owl:versionIRI`.

### 5.2 Structures (lexicons, contexts, shapes)

- ATProto already requires that a lexicon under a given NSID evolves only by compatible changes. Breaking changes need a new NSID.
- Records do not say which revision of a lexicon they were written against. Therefore **an authority's context MUST evolve append-only as well**: each revision is a superset of all previous ones. One current context per authority is then always safe to apply to any record under it.
- A breaking change means a new NSID _and_ a new type-scoped entry in the authority's context. Both may map to the same stable term IRIs where the meaning is unchanged.
- Each published context records, for each NSID it covers, the lexicon `revision` it corresponds to. Previous revisions stay available (e.g. as earlier versions of the companion record, or by content hash).

### 5.3 Enforcement

Authorities SHOULD check in CI that:

- revision N+1 of each lexicon is backward-compatible with revision N;
- revision N+1 of each context is a superset of revision N, and no existing term, top-level or type-scoped, changes its IRI;
- every lexicon field is covered by the context (§3, rule 2).

## 6. Identity, dereferencing and brokers

### 6.1 Canonical identity

- **Inside ATProto**, a record is identified by its **`at://` URI**, and records refer to each other with `at://` URIs. The protocol stays the source of truth.
- **In the Linked Data view** (broker output, and the output of Level 2 clients, §7), every `at://` IRI is replaced by its HTTPS IRI under `‹lod-base›` (§6.3), and that node carries `owl:sameAs` → the `at://` IRI. Q9 explains why this hybrid was chosen over the alternatives.
- DIDs (accounts) are valid IRIs and are used as they are.
- Versions are not part of a record's identity. A version is identified by the pair (`at://` URI, CID) and gets its own IRI (§6.7). A CID alone is not enough: it hashes the record's content, which does not include the record's own URI, so identical records in different places share a CID.
- Accounts, repos and collections are also resources, described with SIOC:

In the table, resources are given in their AT form; in the Linked Data view, each is named by its `‹lod-base›` IRI.

| AT form                                 | RDF class                         | Links                                                                                                                                                                              |
| --------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `did:plc:…` (account)                   | `sioc:UserAccount`                | `sioc:owner_of` → the repo; `foaf:accountName` → the handle, only when verified; `rdfs:seeAlso` → the DID document; `sioc:account_of` → the person (e.g. an ORCID IRI), when known |
| `at://did:plc:…` (repo)                 | `sioc:Space`                      | `sioc:has_owner` → the account                                                                                                                                                     |
| `at://did:plc:…/‹nsid›` (collection)    | `sioc:Container`                  | `sioc:has_space` → the repo                                                                                                                                                        |
| `at://did:plc:…/‹nsid›/‹rkey›` (record) | `sioc:Item` + the lexicon's class | `sioc:has_container` → the collection; `sioc:has_space` → the repo; `sioc:has_creator` → the account; `sioc:id` → the record key; `sioc:link` → the broker document (§6.4)         |

The account (DID) is kept separate from the repo (`at://did`): a DID can move its repo between PDSes and remain the same account, and SIOC declares `sioc:Space` and `sioc:UserAccount` disjoint. `sioc:has_creator` records who signed the record. When the scientific author differs (e.g. a curator importing someone else's claim), the lexicon's own attribution field maps to `dct:creator`.

### 6.2 Canonical brokers

- Each authority MAY designate **one canonical broker** for its subspace, by adding a service entry to the DID document of the DID found through `_lexicon.‹authority›` (§4.1):

   ```json
   {
      "id": "#lod_broker",
      "type": "LinkedDataBroker",
      "serviceEndpoint": "https://broker.mira.science"
   }
   ```

  (Service `id` and `type` names are placeholders; see Q4.)
- The authority also registers its subspace with the redirect service behind `‹lod-base›`, so that IRIs under `‹lod-base›/at/…` for its NSIDs resolve to its canonical broker (§6.3). Moving to another broker means updating that redirect, not changing any IRI.
- A broker is scoped to the subspaces it serves. It is not a universal `at://` resolver.
- Other brokers (mirrors, caches, aggregators) MAY serve the same records. They MUST use the `‹lod-base›` IRIs as `@id`, never IRIs of their own, and MAY point to themselves with `rdfs:seeAlso`.

### 6.3 Broker IRIs and paths

HTTPS IRIs are minted under `‹lod-base›`, not under the broker's own endpoint. A broker endpoint can disappear or move, but IRIs copied into other datasets cannot be recalled. All brokers MUST use this path convention, so that any broker can replace another:

| Resource       | Entity IRI                                   | Document URL on the broker                |
| -------------- | -------------------------------------------- | ----------------------------------------- |
| account        | `‹did›` (unchanged, §6.1)                    | `‹endpoint›/did/‹did›`                    |
| repo           | `‹lod-base›/at/‹did›#it`                     | `‹endpoint›/at/‹did›`                     |
| collection     | `‹lod-base›/at/‹did›/‹nsid›#it`              | `‹endpoint›/at/‹did›/‹nsid›`              |
| record         | `‹lod-base›/at/‹did›/‹nsid›/‹rkey›#it`       | `‹endpoint›/at/‹did›/‹nsid›/‹rkey›`       |
| version (§6.7) | `‹lod-base›/at/‹did›/‹nsid›/‹rkey›/‹cid›#it` | `‹endpoint›/at/‹did›/‹nsid›/‹rkey›/‹cid›` |

- The entity IRI is a hash IRI, so the document and the thing it describes never share a name.
- Dereferencing an entity IRI without its fragment redirects (`303 See Other`) to the matching document URL on the canonical broker.
- Because `‹lod-base›` is a fixed string, the mapping from `at://X` to `‹lod-base›/at/X#it` is a pure function. Any client can compute it without network access (but see Q10).
- The mapping applies to **every** `at://` IRI, whether or not its subspace has a canonical broker. Names therefore never change over time: an IRI stays the same when an authority designates a broker later. Only dereferencing is scoped: IRIs of subspaces without a canonical broker return `404 Not Found`, so no broker becomes a universal `at://` resolver.
- Deleted records return `410 Gone`.
- Accounts keep their DID as IRI, which HTTP cannot dereference. Their _document_ is `‹lod-base›/did/‹did›`, with `foaf:primaryTopic` → the DID; it redirects like the other paths, to a broker that serves the account's repo (and returns `404` otherwise). The segment is `did`, not under `at`, because DIDs are not specific to ATProto (Q10). HTML views link to this document wherever a DID appears, keeping the DID as the RDF object (e.g. RDFa `resource` for the IRI, `href` for the document).

### 6.4 Representations

The document URL supports content negotiation:

- `application/ld+json` (REQUIRED)
- `text/html` (REQUIRED). The HTML page MUST embed, in a `<script type="application/ld+json">` element, exactly the JSON-LD returned for `application/ld+json`. Both representations then carry the same graph by construction. Brokers SHOULD test this in CI, by extracting the embedded JSON-LD and checking that its graph is isomorphic to the direct response. The page of a record SHOULD show a link to its current version (a permalink), so that readers can choose to cite that version (§6.7).
- `text/turtle` and other RDF formats (OPTIONAL).

The JSON-LD response contains:

1. **The entity**, with `@id` = its `‹lod-base›` entity IRI, the mapped record content (with references rewritten, §6.5), the SIOC links of §6.1, `owl:sameAs` → its `at://` IRI, and `sioc:link` → its document URL under `‹lod-base›`.
2. **A node for every referenced resource**, with `owl:sameAs` → its `at://` IRI, and a node for every version IRI produced by §6.7. Clients that know nothing about ATProto follow the HTTPS IRIs directly; clients that also hold raw ATProto data use `sameAs` to join the two.
3. **The document**, as a separate node (the document URL), with `foaf:primaryTopic` → the entity and provenance: `prov:wasDerivedFrom` → the version IRI of the record state served (a version node, which carries its `atp:cid`), retrieval time, and which context (authority or overlay) was applied. Statements about the response never use the entity's IRI.
4. **Optionally, derived data** such as inverse edges and backlinks from the broker's index. Because these are not authored by the record's owner, they SHOULD be placed in a separate named graph.
5. **Optionally, rendered HTML** for inline text items (§3 rule 7). In the HTML view, the broker renders the text and its facets in an element whose `id` is the item's fragment (§6.5), so that the item's IRI dereferences to its rendered text; `#property` facets become RDFa only where the record makes the restated statement. In the JSON-LD view, the HTML MAY be added as `content:encoded` (RSS 1.0 content module, which SIOC recommends in place of the deprecated `sioc:content_encoded`), typed `rdf:HTML`. The plain text stays in `sioc:content`. The HTML MUST be sanitized (§9).

### 6.5 Normalization performed by the broker

- Replace every `at://` IRI by its `‹lod-base›` IRI, and add `owl:sameAs` → the `at://` IRI (§6.1, §6.3).
- Inject `@id`, the SIOC links and `sioc:has_creator`, which are implicit in ATProto (from the repo path and signing DID).
- Rewrite pinned references and `previousVersionCid` into version IRIs (§6.7).
- Rewrite blobs and `cid-link` values into dereferenceable IRIs (e.g. the PDS `com.atproto.sync.getBlob` URL), with `atp:cid`, media type and size as properties.
- Apply language tags where the lexicon has a language field (JSON-LD cannot take a language from a sibling field).
- Name each inline text item (§3 rule 7) by the record's document and the field name: `‹lod-base›/at/‹did›/‹nsid›/‹rkey›#‹field›` (`#‹field›-‹i›` in arrays), instead of the blank node that the context alone gives it.

### 6.6 Example

A raw record at `at://did:plc:abc/science.mira.claim/3k2x`:

```json
{
   "$type": "science.mira.claim",
   "createdAt": "2026-09-01T12:00:00Z",
   "title": "CLM - Protein X inhibits Y in vitro",
   "supports": [
      { "uri": "at://did:plc:def/science.mira.claim/3j9q" },
      { "uri": "at://did:plc:ghi/science.mira.claim/3h7r", "cid": "bafyreiC1…" }
   ]
}
```

The first reference is unpinned; the second pins version `bafyreiC1…` of its target. As served by the broker (abridged, context shown by reference, with `‹lod-base›` = `https://w3id.org/at-lod` as a placeholder):

```json
{
   "@context": ["‹science.mira context›", "‹broker context›"],
   "@graph": [
      {
         "@id": "https://w3id.org/at-lod/at/did:plc:abc/science.mira.claim/3k2x#it",
         "$type": ["science.mira.claim", "sioc:Item"],
         "owl:sameAs": { "@id": "at://did:plc:abc/science.mira.claim/3k2x" },
         "createdAt": "2026-09-01T12:00:00Z",
         "title": "CLM - Protein X inhibits Y in vitro",
         "supports": [
            {
               "uri": "https://w3id.org/at-lod/at/did:plc:def/science.mira.claim/3j9q#it"
            },
            {
               "uri": "https://w3id.org/at-lod/at/did:plc:ghi/science.mira.claim/3h7r/bafyreiC1…#it"
            }
         ],
         "sioc:has_creator": { "@id": "did:plc:abc" },
         "sioc:has_container": {
            "@id": "https://w3id.org/at-lod/at/did:plc:abc/science.mira.claim#it"
         },
         "sioc:has_space": {
            "@id": "https://w3id.org/at-lod/at/did:plc:abc#it"
         },
         "sioc:id": "3k2x",
         "sioc:link": {
            "@id": "https://w3id.org/at-lod/at/did:plc:abc/science.mira.claim/3k2x"
         }
      },
      {
         "@id": "https://w3id.org/at-lod/at/did:plc:def/science.mira.claim/3j9q#it",
         "owl:sameAs": { "@id": "at://did:plc:def/science.mira.claim/3j9q" }
      },
      {
         "@id": "https://w3id.org/at-lod/at/did:plc:ghi/science.mira.claim/3h7r/bafyreiC1…#it",
         "dct:isVersionOf": {
            "@id": "https://w3id.org/at-lod/at/did:plc:ghi/science.mira.claim/3h7r#it"
         },
         "atp:cid": "bafyreiC1…"
      },
      {
         "@id": "https://w3id.org/at-lod/at/did:plc:ghi/science.mira.claim/3h7r#it",
         "owl:sameAs": { "@id": "at://did:plc:ghi/science.mira.claim/3h7r" }
      },
      {
         "@id": "https://w3id.org/at-lod/at/did:plc:abc/science.mira.claim/3k2x/bafyreiA…#it",
         "dct:isVersionOf": {
            "@id": "https://w3id.org/at-lod/at/did:plc:abc/science.mira.claim/3k2x#it"
         },
         "atp:cid": "bafyreiA…"
      },
      {
         "@id": "https://broker.mira.science/at/did:plc:abc/science.mira.claim/3k2x",
         "foaf:primaryTopic": {
            "@id": "https://w3id.org/at-lod/at/did:plc:abc/science.mira.claim/3k2x#it"
         },
         "prov:wasDerivedFrom": {
            "@id": "https://w3id.org/at-lod/at/did:plc:abc/science.mira.claim/3k2x/bafyreiA…#it"
         },
         "dct:modified": "2026-09-26T10:00:00Z"
      }
   ]
}
```

### 6.7 Record versions and pinned references

A strong reference (`{uri, cid}`) says something about one version of its target: "A supports C as it read when A was written". The RDF view keeps that by pointing the edge at the **version**, not at the record.

**Version IRIs.** The version of record `at://‹did›/‹nsid›/‹rkey›` with CID `‹cid›` has the IRI `‹lod-base›/at/‹did›/‹nsid›/‹rkey›/‹cid›#it`. The version is a child of the record in the same hierarchy as repo → collection → record (§6.3). Since AT paths have a fixed depth and none of their parts contains `/`, a fourth segment is always a CID. ATProto has no `at://` syntax for a version, so version IRIs exist only in HTTPS form (Q12).

**Rewrite.** Brokers and Level 2 clients (§7) MUST apply this rewrite to every reference object that has both `uri` (an `at://` URI) and `cid`:

- the reference is replaced by a reference to the version IRI V;
- the output gains `V dct:isVersionOf ‹record IRI›` (the record's `‹lod-base›` IRI) and `V atp:cid ‹cid›`.

**Pins outside ATProto.** A reference object with a `cid` whose `uri` is not an `at://` URI (an HTTPS resource, a blob's `getBlob` URL) pins content, not a record version. Brokers and Level 2 clients MUST rewrite it too:

- the object becomes `V = ni:///sha-256;‹digest›`, the RFC 6920 Named Information IRI of the bytes, where `‹digest›` is the sha-256 digest from the CID, in base64url;
- the output gains `V dct:isVersionOf ‹uri›` and `V atp:cid ‹cid›`;
- if the CID has no `ni:` form (a hash other than sha-256, or a CIDv0), V is a blank node instead.

Stating `‹uri› atp:cid ‹cid›` directly would be simpler, but it is only true while the resource does not change: two records that pinned it at different times would leave two CIDs on one node (as in Q3). The `ni:` IRI names exactly the bytes that were pinned, and is the same for every record that pinned them, so graphs merge cleanly. It is not dereferenceable; a broker could later serve the bytes it can find. The version has the same shape as the version of a record, so one query (`?v dct:isVersionOf ?target ; atp:cid ?cid`) finds both kinds of pins.

References without `cid` are unchanged. This rewrite depends only on the record and `‹lod-base›`, so it needs no broker and no network access. A context cannot express it, because it builds one IRI from two fields. A client that applies the context without the rewrite gets the unpinned reading (§3.1): less precise, but not wrong. That is not a conforming client level (§7).

**Consequences.**

- A pinned and an unpinned reference use the same property. Only the granularity of the target differs, so lexicons and ontologies need no extra "version" properties.
- The `dct:isVersionOf` triple is needed even though V's IRI contains the record URI, because RDF treats IRIs as opaque. Queries that should match any version use an optional path, e.g. `?a mira:supports/dct:isVersionOf? ?c` in SPARQL.
- Through `rdfs:range`, a version is inferred to be of the target's class (a frozen claim is still a claim). Aggregates that count records MUST therefore count distinct records, grouping versions by `dct:isVersionOf`.
- The version IRI names exactly the (`uri`, `cid`) pair that an endorsement or a signature over a record covers, so pinning, endorsement and attestation share one notion of version.

**Version history.** If a record has a `previousVersionCid` (§3 rule 9), brokers and Level 2 clients MUST emit `V_current sioc:previous_version V_previous`, where `V_current` is the version IRI of the record's current state and `V_previous` the version IRI built from the record's URI and `previousVersionCid`. Both are versions of the same record, so both also get `dct:isVersionOf` and `atp:cid`. The subject is the current _version_, not the record: `sioc:previous_version` is not transitive, so a statement about the record would become false at its next update. Any client that fetched the record has the current CID (e.g. from `com.atproto.repo.getRecord`), so this rule needs no broker either.

Brokers SHOULD also emit `‹record› sioc:latest_version V_current`. That statement is only true at retrieval time, so it goes with the provenance of the response (§6.4 item 3) or in the derived-data graph (§6.4 item 4).

**Archived versions.** When a broker serves a version that is not the current one (from an archive), the subject of that version's content MUST be its version IRI, not the record's IRI. Otherwise old content would make stale statements about the current record.

**Dereferencing.** The version document URL behaves like a Memento (RFC 7089), with the record as its original resource:

- If the CID is the current version, or the broker has archived it: `200`, with that version, `Link: <‹record document URL›>; rel="original"`, and a `Memento-Datetime` header.
- Otherwise: `303 See Other` to the record's document, with the same `rel="original"` link. The broker SHOULD add the requested CID to the target URL (e.g. `?pinned=‹cid›`), so that its HTML view can warn that the current version may differ from the one referenced. Without history, a broker cannot tell a superseded CID from a wrong one; both are redirected.
- If the record was deleted: `410 Gone`.

The record document, in turn, SHOULD point to its current version with `Link: <‹version document URL›>; rel="last memento"; datetime="…"`, the HTTP counterpart of `sioc:latest_version`. It is not redirected to it: an unpinned reference means the record in general, and readers who copy a URL should get a pinned one only by choice. The HTML view offers that choice instead, as a visible link to the current version (§6.4).

The datetime of a version is when it was written, i.e. the time of the repo commit that wrote it. A broker that indexes the firehose knows it; one that reads records from the PDS only has what the record claims (e.g. `updatedAt`, or else `createdAt`), and SHOULD use it only as a fallback.

Going from a version to its record is therefore always possible. Any client can drop the last path segment (or, in ATProto, the CID), Memento-aware clients follow `rel="original"`, and RDF clients follow `dct:isVersionOf`. Retrieving the _content_ of a past version requires an archive ("history server"), since a PDS only keeps current versions. An archive is OPTIONAL and can be added later behind the same interface.

**Fallback.** When a pinned version cannot be retrieved, a client MAY show the current version of the record instead (the `303` above leads there). It MUST NOT present that version as the one the referencing record pinned, because the relation may no longer hold. A broker that does this in its output MUST put it in the derived-data graph (§6.4 item 4), linking the pinned version to the version actually shown (term to be defined in the `atp:` vocabulary, Q1).

**Successor records.** An in-place update keeps the record's URI, so the fallback above reaches the latest version. A _successor record_ has a different URI: a new NSID after a breaking change, a migration, or a fork. Reaching a successor needs an explicit link written by the successor, always pointing at a pinned version of the earlier record. Per §3 rule 4, the forward direction comes from an index, not from the earlier record. The strength of the link depends on who wrote it:

| Situation                                                         | Property                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| derivation, no claim of revision                                  | `prov:wasDerivedFrom`                                                                                  |
| revision, no claim of supersession                                | `prov:wasRevisionOf` (a subproperty of `prov:wasDerivedFrom`)                                          |
| proposed replacement, by another DID                              | `proposedReplacementOf`, a subproperty of `prov:wasRevisionOf` (term and namespace to be defined, Q13) |
| accepted replacement: written by the same repo (same signing DID) | `dct:replaces`                                                                                         |

`dct:replaces` is the cross-record counterpart of `sioc:previous_version`: both point from the newer resource to the older one. Acceptance is decided by the signing DID, not by the PDS, which only hosts the repo and is shared by unrelated accounts.

## 7. Client conformance levels

All three levels MUST obtain the same graph for a record, with the same IRIs, apart from what the broker adds (§6.4 items 3–5). This equivalence is the main interoperability test for implementations.

- **Level 0: plain LOD client.** Dereferences `https` IRIs and understands JSON-LD. The triples it gets back are about the IRIs it followed, so it needs no `owl:sameAs` reasoning. This proposal places no requirement on generic LOD clients.
- **Level 1: convention-aware client.** Given a bare `at://` IRI, computes its `‹lod-base›` IRI (§6.3) and dereferences it, with no lookup. It MAY instead find the canonical broker directly from the NSID: DNS TXT `_lexicon.‹authority›` → DID document → `#lod_broker` service (§6.2).
- **Level 2: native ATProto client.** Resolves the record's DID, fetches the record from its PDS, fetches the context (§4), and applies it itself, together with the normalization of §6.5, including the version rewrite of §6.7. It can verify the record using `com.atproto.sync.getRecord`, which returns the record with its repo proof. This path needs no broker at all.

Applying an authority context to a raw record _without_ the normalization of §6.5 is not a conforming level. The result lacks the pinned versions (§6.7), the SIOC links and dereferenceable blob IRIs. This is why brokers do not advertise contexts on raw records in a way that generic JSON-LD processors act on (§4.1).

## 8. Other transports

The same pattern applies to every transport. Each one needs a profile that defines:

- its native identifier (e.g. a Ceramic stream ID, a KOI RID), used inside the transport, and its HTTPS form under `‹lod-base›` (e.g. `‹lod-base›/ceramic/…`), used in the Linked Data view;
- how to find the context for a record type;
- how an authority designates a canonical broker for its subspace, and the broker path prefix (e.g. `‹endpoint›/ceramic/…`);
- how references to records on _other_ transports are written (which is why rule 3 in §3 recommends `format: uri`).

This document is the ATProto profile. Other profiles are left to the communities that use those transports. A single broker MAY serve several transports for the same authority.

## 9. Security and trust

- **Brokers are trusted intermediaries.** A broker cannot forge an ATProto signature, but it can misrepresent a record in its JSON-LD output. Clients that need assurance use Level 2, or check the `atp:cid` against the repo proof.
- **Rendered HTML** comes from user-written text and MUST be sanitized before it is served or embedded. When the broker renders it from plain text and facets, escaping the text and restricting link targets to safe schemes (e.g. `https`, `at`, `did`) is enough. Other IRIs from records that the HTML view shows as links need the same restriction.
- **Discovery** relies on DNS. Authorities SHOULD use DNSSEC.
- **Deletions.** Brokers MUST honor record deletions (`410 Gone`) and SHOULD propagate them to caches and indexes. `owl:sameAs` triples that were already copied elsewhere cannot be recalled, so broker domains SHOULD be long-lived and never repurposed.
- **Scope.** Only public records are covered. Permissioned data in ATProto is out of scope until it stabilizes.

## 10. Generating lexicons and contexts from schemas

The conventions do not require any particular tooling; hand-written lexicons and contexts conform if they follow §3–5. However, the safest way to keep a lexicon, its context and an ontology in step is to **generate all three from one source**.

The reference approach uses **LinkML**, generating directly (not through JSON-Schema, which loses the distinction between inlined objects and references):

- the lexicon JSON (records, defs, refs from LinkML `inlined: false`);
- the JSON-LD context (from `slot_uri` / `class_uri`);
- the ontology and SHACL shapes (existing LinkML generators). SHACL shapes can then validate broker output directly.

LinkML annotations would carry what only the lexicon needs: which classes are records, record-key type, `maxLength`, ATProto field names (`created` → `createdAt`), and which slots are derived inverses and are left out of the lexicon.

## 11. Open questions

- **Q1. Community namespace.** Partly resolved in revision 2: the NSID namespace is `at.linkedopendata`, through the domain `linkedopendata.at`. Each NSID group needs its own `_lexicon` DNS record: `at.linkedopendata.defs` resolves through `_lexicon.linkedopendata.at`, but `at.linkedopendata.lexicon.context` through `_lexicon.lexicon.linkedopendata.at`. Still open: the IRIs of the `atp:` vocabulary and of the link relation of §4.1 (presumably under `https://linkedopendata.at/`).
- **Q2. Fallback vocabulary.** Should contexts include a `@vocab` fallback so that unmapped fields are not silently lost? If so, what IRI (e.g. derived from the lexicon's `at://` schema record)?
- **Q3. Strong-reference pinning.** Resolved in revision 2 (§6.7): pinned references point at version IRIs. Alternatives considered: putting `atp:cid` on the target (ambiguous when two edges pin different versions), a blank version node created by the context alone (no stable identity, and the edge no longer reaches a record), and RDF 1.2 triple terms (not expressible in JSON-LD 1.1).
- **Q4. Service naming.** Names for the DID service entry, and whether to propose it upstream as a general ATProto convention.
- **Q5. Context granularity.** Resolved in revision 2: one context per authority, with type-scoped contexts for the terms of each record type (§3.1, §4.1).
- **Q6. Plain-text property.** Resolved in part: inline text items carry their plain text in `sioc:content` (§3 rule 7). Still open: when a record's text is a reference to an external text, should brokers also emit a plain-text value for generic consumers, and under which property?
- **Q7. Governance of canonical brokers.** Expectations on uptime and continuity, and what happens when an authority's broker disappears.
- **Q8. Containers.** How ATProto collections as `sioc:Container` coexist with application-level containers (e.g. MIRA's `has_container`, which is also `sioc:has_container`).
- **Q9. Identity in the Linked Data view.** Resolved in revision 2: the hybrid of §6.1. ATProto records use `at://` URIs; the Linked Data view uses HTTPS IRIs under `‹lod-base›`, with `owl:sameAs` back to `at://`. Alternatives rejected:
  - _`at://` as the RDF IRI everywhere, with `owl:sameAs` to HTTPS (revision 1)._ `at://` URIs with a DID authority (`at://did:plc:…`) are not valid RFC 3986 URIs: a strict parser reads `did` as the host and `plc:…` as an invalid port, so some URI and RDF libraries reject them. Every plain LOD client would also have to follow `sameAs` to dereference anything, and every reference would need its own `sameAs` statement.
  - _HTTPS IRIs everywhere, including inside ATProto records._ The records would depend on the LOD base rather than the protocol, which would stop being the source of truth. ATProto tooling (strongRef, `at-uri` fields, backlink indexes) expects `at://` URIs. And each other transport has its own native references, so the approach would not generalize (§8).

    The main cost of the hybrid, depending on HTTPS names staying alive, is handled by the persistent base (§6.3, Q10). Raw protocol data and the Linked Data view name the same resources differently; `owl:sameAs` and the deterministic rewrite of §6.5 bridge them.
- **Q10. Persistent base.** Which base, and who runs its redirects? Two choices are involved:
  - _Community-wide or per authority._ Only a community-wide base (per transport) keeps the mapping from native identifiers to HTTPS a pure function; per-authority bases would need a lookup (cacheable, once per authority).
  - _Transport-neutral or per transport._ A transport-neutral base, e.g. on w3id.org, holds every transport under its own path segment (`‹lod-base›/at/…`, `‹lod-base›/ceramic/…`, §8), with redirects maintained through w3id.org pull requests. Alternatively, each transport has its own base: `https://linkedopendata.at/` is designated for ATProto, so it fits ATProto, but would not extend to other transports. The rewrite stays a pure function either way, since a native identifier says which transport it belongs to. With per-transport bases, the `/at/` path segment becomes redundant for ATProto.
    - A community-controlled domain avoids the w3id.org pull-request process, but its permanence then depends on keeping that domain.
- **Q11. Validating broker output.** Broker output should be validated against the shapes; how is still to be decided. Validators could remove the broker's additions before applying the closed shapes, or the shapes could allow them (e.g. through `sh:ignoredProperties`). Version nodes carry only `dct:isVersionOf`, `atp:cid` and possibly `sioc:previous_version`, so shapes must not require record content on them. Current leaning: `sh:ignoredProperties` for `atp:cid`; whether and how version nodes are typed is still open. Validation is also where the lexical form of numbers stored as strings is checked (§3 rule 10), since lexicons cannot express it. Unpinned references are reported as warnings (`sh:severity sh:Warning`), not violations. In the Linked Data view, only an unpinned `at://` target carries `owl:sameAs` (a pinned one is a version node, and other targets have none), so for each reference property P a shape `[ sh:path ( P owl:sameAs ) ; sh:maxCount 0 ; sh:severity sh:Warning ]` flags exactly the unpinned references to ATProto records. These shapes can be generated with the lexicon (§10). Note that a SHACL report with only warnings still has `sh:conforms false`, so tools have to filter results by severity.
- **Q12. Version syntax upstream.** Should the community propose an `at://` syntax for a record version, so that version IRIs need not be HTTPS-only?
- **Q13. Replacement proposals.** Where `proposedReplacementOf` lives (Discourse Graphs base vocabulary, MIRA, or the community vocabulary of Q1), and whether a proposal can become accepted when the owner of the replaced record acknowledges it, e.g. with `dct:isReplacedBy`.

## 12. Adoption path and effort

MIRA intends to be the first adopter, with `science.mira.*`. Rough effort, in person-weeks, for someone familiar with LinkML and ATProto:

| Deliverable                                                                        | Scope                     | Effort   |
| ---------------------------------------------------------------------------------- | ------------------------- | -------- |
| Lexicon/JSON-LD conventions and shared defs (§3, Q1)                               | community                 | 1–2      |
| Context association: companion records, resolver library (§4)                      | community                 | 1.5–2    |
| Versioning rules and CI compatibility checker (§5)                                 | community                 | 1–2      |
| LinkML → lexicon + context generator with round-trip tests (§10)                   | community, MIRA first     | 3–4      |
| Broker for one subspace: JSON-LD/HTML, content negotiation, equivalence tests (§6) | per authority, MIRA first | 2–3      |
| Broker index for backlinks and derived edges                                       | per authority             | 3–6      |
| Version archive ("history server") behind the version URLs (§6.7), optional        | per authority or shared   | 2–4      |
| Profile and broker support for another transport (§8)                              | per transport             | 2–4 each |

The first four rows are shared by all adopters. A minimal MIRA deployment (rows 1–5, plus basic backlinks) is roughly 12–19 person-weeks. Calendar time will likely depend more on reaching agreement on §3–6 than on the code.

## 13. References

- AT Protocol specifications: Lexicon, NSID, AT URI, Repository, DID, and lexicon resolution (<https://atproto.com/specs>)
- JSON-LD 1.1 (<https://www.w3.org/TR/json-ld11/>)
- SIOC Core Ontology (<http://rdfs.org/sioc/spec/>)
- Cool URIs for the Semantic Web, hash IRIs (<https://www.w3.org/TR/cooluris/>)
- W3C Decentralized Identifiers, service endpoints (<https://www.w3.org/TR/did-core/>)
- LinkML (<https://linkml.io/>)
- HTTP Framework for Time-Based Access to Resource States — Memento, RFC 7089 (<https://www.rfc-editor.org/rfc/rfc7089>)
- w3id.org permanent identifiers (<https://w3id.org/>)
- IPFS HTTP gateway path conventions, as a precedent for per-protocol brokers (<https://specs.ipfs.tech/http-gateways/>)
