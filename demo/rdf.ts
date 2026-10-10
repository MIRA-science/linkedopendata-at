// RDF helpers shared by the demo tests.
import { RdfaParser } from "rdfa-streaming-parser";

/** N-Triples lines from RDFa, in the same form as jsonld.toRDF output. */
export function rdfaTriples(html: string, baseIRI: string): Promise<Set<string>> {
  const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
  const lit = (s: string) => s.replace(/[\\"\n\r\t]/g, (c) => ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" })[c]!);
  const term = (t: any) =>
    t.termType === "NamedNode" ? `<${t.value}>`
    : t.termType === "BlankNode" ? `_:${t.value}`
    : `"${lit(t.value)}"` + (t.language ? `@${t.language}` : t.datatype.value === XSD_STRING ? "" : `^^<${t.datatype.value}>`);
  return new Promise((resolve, reject) => {
    const out = new Set<string>();
    const parser = new RdfaParser({ baseIRI, contentType: "text/html" });
    parser.on("data", (q: any) => out.add(`${term(q.subject)} ${term(q.predicate)} ${term(q.object)} .`));
    parser.on("error", reject);
    parser.on("end", () => resolve(out));
    parser.write(html);
    parser.end();
  });
}
