// Demo configuration. Stands in for DID resolution and _lexicon discovery (§4.1, §6.2).
const root = new URL("../", import.meta.url);

// Hostname in the default URLs of ‹lod-base› and the broker; PDS_HOST for the PDS.
// LOD_BASE, BROKER and PDS override the whole URL.
const host = process.env.HOST ?? "127.0.0.1";
const pdsHost = process.env.PDS_HOST ?? "127.0.0.1";

export const config = {
  pds: process.env.PDS ?? `http://${pdsHost}:8123`,
  did: process.env.DEMO_DID ?? "did:web:mira-demo.local",
  password: process.env.DEMO_PASSWORD ?? "mira",
  contextPath: process.env.MIRA_CONTEXT ?? new URL("../schema/atproto/context.jsonld", root).pathname,
  // Write path (broker/ingest.ts): the MIRA shapes and ontology, and the directory of the
  // generated binding (lexicons, binding and pinning shapes).
  shapesPath: process.env.MIRA_SHAPES ?? new URL("../schema/mira.shacl", root).pathname,
  ontologyPath: process.env.MIRA_ONTOLOGY ?? new URL("../schema/mira.ttl", root).pathname,
  bindingDir: process.env.MIRA_BINDING ?? new URL("../schema/atproto/", root).pathname,
  // Hosts remote contexts of submitted JSON-LD may come from (besides HTTP_HOSTS).
  contextHosts: (process.env.CONTEXT_HOSTS ?? "purl.org").split(",").filter(Boolean),
  // ‹lod-base› (the redirector) and the canonical broker endpoint.
  lodBase: process.env.LOD_BASE ?? `http://${host}:8080`,
  endpoint: process.env.BROKER ?? `http://${host}:8081`,
  // Address the servers listen on (e.g. 0.0.0.0 for all interfaces).
  listen: process.env.LISTEN ?? host,
  // "relative": links and broker URLs without scheme and host, for a reverse proxy that
  // serves ‹lod-base› and the broker on one public origin. IRIs stay absolute.
  links: process.env.LINKS === "relative" ? "relative" : "absolute",
  // Sources whose JSON-LD the HTTP broker shows under /http/‹host›/…: comma-separated
  // hosts (https) or origins.
  httpHosts: (process.env.HTTP_HOSTS ?? "discourse-graph-git-mira-collab-discourse-graphs.vercel.app").split(",").filter(Boolean),
};
