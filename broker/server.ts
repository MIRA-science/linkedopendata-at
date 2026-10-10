// Minimal canonical broker (§6.2–6.4), plus the redirector behind ‹lod-base› (§6.3).
// Two brokers share one endpoint: ATProto records, and JSON-LD from the Web under /http/.
// Usage: node broker/server.ts   (configuration in demo/config.ts)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "../demo/config.ts";
import { send, type Links } from "./base.ts";
import { AtprotoBroker, authorityOf, pdsOf } from "./atproto.ts";
import { HttpBroker, HTTP_PREFIX } from "./http.ts";

const { lodBase, endpoint } = config;
const links: Links = { lodBase, endpoint, relative: config.links === "relative" };
const atproto = new AtprotoBroker(links);
const http = new HttpBroker(links, config.httpHosts);

async function broker(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", endpoint);
  try {
    await (url.pathname.startsWith(HTTP_PREFIX) ? http : atproto).handle(req, res, url);
  } catch (e) {
    console.error(e);
    send(res, 500, "text/plain", String(e));
  }
}

/** ‹lod-base›: 303 to the canonical broker of the subspace or account, 404 otherwise (§6.3). */
function redirector(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", lodBase);
  const path = url.pathname;
  const acct = /^\/did\/([^/]+)$/.exec(path);
  if (acct) {
    if (!pdsOf(decodeURIComponent(acct[1]))) return send(res, 404, "text/plain", "Not Found\n");
    res.writeHead(303, { location: atproto.brokerUrl(path) + url.search, "access-control-allow-origin": "*" });
    return res.end();
  }
  const m = /^\/at\/([^/]+)(?:\/([^/]+))?/.exec(path);
  const nsid = m?.[2] && decodeURIComponent(m[2]);
  if (!m || (nsid && !authorityOf(nsid))) return send(res, 404, "text/plain", "Not Found\n");
  res.writeHead(303, { location: atproto.brokerUrl(path) + url.search, "access-control-allow-origin": "*" });
  res.end();
}

const port = (u: string) => Number(new URL(u).port);
createServer(broker).listen(port(endpoint), config.listen, () => console.log(`broker      ${endpoint}`));
// In relative mode, ‹lod-base› and the broker share one origin (behind a proxy): the broker
// answers ‹lod-base› paths itself, and a separate redirector would only redirect to itself.
if (links.relative) console.log(`‹lod-base›  ${lodBase} (served by the broker, through the proxy)`);
else createServer(redirector).listen(port(lodBase), config.listen, () => console.log(`‹lod-base›  ${lodBase}`));
for (const h of config.httpHosts) console.log(`http source ${endpoint}${HTTP_PREFIX}${h}/…`);
