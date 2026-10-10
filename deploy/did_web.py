"""did:web documents for the accounts of a millipds, served by host.

nginx sends /.well-known/did.json and /.well-known/atproto-did for the account hosts here,
with the Host header; the answer comes from the millipds database, read-only: the account
whose DID is did:web:‹host› (did.json), or whose handle is ‹host› (atproto-did). The
document names the account's signing key (public half) and the PDS (pds_pfx in the
millipds config, or --pds).

Run with the Python of millipds (for its key encoding), from the millipds directory:
  .venv/bin/python path/to/did_web.py [--db data/millipds.sqlite3] [--port 8124] [--pds URL]
"""

import argparse
import json
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from millipds import crypto

parser = argparse.ArgumentParser()
parser.add_argument("--db", default="data/millipds.sqlite3")
parser.add_argument("--listen", default="127.0.0.1")
parser.add_argument("--port", type=int, default=8124)
parser.add_argument("--pds", help="PDS URL in the documents (default: pds_pfx of the millipds config)")
args = parser.parse_args()


def query(sql: str, *params):
    # A connection per request: read-only, and sees accounts created since.
    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    try:
        return con.execute(sql, params).fetchone()
    finally:
        con.close()


def did_doc(host: str):
    did = f"did:web:{host}"
    row = query("SELECT handle, signing_key FROM user WHERE did = ?", did)
    if not row:
        return None
    handle, pem = row
    pds = args.pds or query("SELECT pds_pfx FROM config")[0]
    # did:key:z… → the multibase key; the private key never leaves this function.
    key = crypto.encode_pubkey_as_did_key(crypto.privkey_from_pem(pem).public_key()).removeprefix("did:key:")
    return {
        "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
        "id": did,
        "alsoKnownAs": [f"at://{handle}"],
        "verificationMethod": [{"id": f"{did}#atproto", "type": "Multikey", "controller": did, "publicKeyMultibase": key}],
        "service": [{"id": "#atproto_pds", "type": "AtprotoPersonalDataServer", "serviceEndpoint": pds}],
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        host = (self.headers.get("host") or "").split(":")[0].lower()
        if self.path == "/.well-known/did.json":
            doc = did_doc(host)
            body, ctype = (json.dumps(doc, indent=2), "application/json") if doc else (None, None)
        elif self.path == "/.well-known/atproto-did":
            row = query("SELECT did FROM user WHERE handle = ?", host)
            body, ctype = (row[0], "text/plain") if row else (None, None)
        else:
            body = ctype = None
        if body is None:
            self.send_error(404)
            return
        data = body.encode()
        self.send_response(200)
        self.send_header("content-type", f"{ctype}; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.send_header("access-control-allow-origin", "*")
        self.end_headers()
        self.wfile.write(data)


print(f"did:web documents on {args.listen}:{args.port}, from {args.db}")
ThreadingHTTPServer((args.listen, args.port), Handler).serve_forever()
