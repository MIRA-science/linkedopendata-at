// CIDs as RFC 6920 Named Information IRIs: a pinned resource outside ATProto is named by
// the hash of its bytes (§6.7). Only what ATProto uses: CIDv1, base32, sha-256.

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(s: string): Uint8Array | undefined {
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const c of s) {
    const v = BASE32.indexOf(c);
    if (v < 0) return undefined;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function varint(b: Uint8Array, at: number): [number, number] | undefined {
  let n = 0;
  for (let i = at, shift = 0; i < b.length && shift < 28; i++, shift += 7) {
    n |= (b[i] & 0x7f) << shift;
    if (!(b[i] & 0x80)) return [n, i + 1];
  }
  return undefined;
}

/** ni:///sha-256;‹digest› for a CIDv1 with a sha-256 multihash; undefined otherwise. */
export function niFromCid(cid: string): string | undefined {
  if (!cid.startsWith("b")) return undefined; // multibase base32 only
  const b = base32(cid.slice(1));
  if (!b) return undefined;
  const version = varint(b, 0);
  if (!version || version[0] !== 1) return undefined;
  const codec = varint(b, version[1]);
  const hash = codec && varint(b, codec[1]);
  const len = hash && varint(b, hash[1]);
  if (!hash || !len || hash[0] !== 0x12 || len[0] !== 32 || b.length !== len[1] + 32) return undefined;
  const digest = Buffer.from(b.subarray(len[1])).toString("base64url");
  return `ni:///sha-256;${digest}`;
}
