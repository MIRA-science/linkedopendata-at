// Minimal canonical broker (§6.2–6.4), plus the redirector behind ‹lod-base› (§6.3).
// Two brokers share one endpoint: ATProto records, and JSON-LD from the Web under /http/.
// Usage: node broker/server.ts   (configuration in broker/config.ts)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.ts";
import { send, type Links } from "./base.ts";
import { AtprotoBroker, authorityOf, hosted } from "./atproto.ts";
import { HttpBroker, HTTP_PREFIX } from "./http.ts";
import { Ingest } from "./ingest.ts";

const { lodBase, endpoint } = config;
const links: Links = { lodBase, endpoint, relative: config.links === "relative" };
const atproto = new AtprotoBroker(links);
const http = new HttpBroker(links, config.httpHosts);
const ingest = new Ingest(atproto);
const WRITE_PATHS = new Set(["/validate", "/convert", "/records"]);

async function broker(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", endpoint);
  try {
    if (req.method === "OPTIONS") {
      // CORS preflight: the write path takes JSON and an Authorization header.
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "authorization, content-type" });
      return res.end();
    }
    if (req.method === "POST") {
      if (!WRITE_PATHS.has(url.pathname)) return send(res, 405, "text/plain", "Method Not Allowed\n");
      return await ingest.handle(req, res, url);
    }
    await (url.pathname.startsWith(HTTP_PREFIX) ? http : atproto).handle(req, res, url);
  } catch (e) {
    console.error(e);
    send(res, 500, "text/plain", String(e));
  }
}

/** ‹lod-base›: 303 to the canonical broker of the subspace or account, 404 otherwise (§6.3). */
async function redirector(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", lodBase);
  const path = url.pathname;
  const acct = /^\/did\/([^/]+)$/.exec(path);
  if (acct) {
    if (!(await hosted(decodeURIComponent(acct[1])))) return send(res, 404, "text/plain", "Not Found\n");
    res.writeHead(303, { location: atproto.brokerUrl(path) + url.search, "access-control-allow-origin": "*" });
    return res.end();
  }
  const m = /^\/at\/([^/]+)(?:\/([^/]+))?/.exec(path);
  const nsid = m?.[2] && decodeURIComponent(m[2]);
  if (!m || (nsid && !authorityOf(nsid))) return send(res, 404, "text/plain", "Not Found\n");
  res.writeHead(303, { location: atproto.brokerUrl(path) + url.search, "access-control-allow-origin": "*" });
  res.end();
}

createServer(broker).listen(config.port, config.listen, () => console.log(`broker      ${endpoint} (port ${config.port})`));
// In relative mode, ‹lod-base› and the broker share one origin (behind a proxy): the broker
// answers ‹lod-base› paths itself, and a separate redirector would only redirect to itself.
if (links.relative) console.log(`‹lod-base›  ${lodBase} (served by the broker, through the proxy)`);
else createServer(redirector).listen(config.lodPort, config.listen, () => console.log(`‹lod-base›  ${lodBase} (port ${config.lodPort})`));
for (const h of config.httpHosts) console.log(`http source ${endpoint}${HTTP_PREFIX}${h}/…`);
