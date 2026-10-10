"""Generate ATProto lexicons and a JSON-LD context from a LinkML schema.

Proof of concept for §10 of the proposal. Input: a binding file that names the
LinkML schema, the NSID prefix, the record classes and per-slot overrides.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from linkml_runtime import SchemaView
from linkml_runtime.linkml_model import SlotDefinition

XSD = "http://www.w3.org/2001/XMLSchema#"

# LinkML type -> (lexicon property, JSON-LD @type)
TYPE_MAP: dict[str, tuple[dict[str, Any], str | None]] = {
    "string": ({"type": "string"}, None),
    "datetime": ({"type": "string", "format": "datetime"}, "xsd:dateTime"),
    "date": ({"type": "string", "format": "datetime"}, "xsd:dateTime"),
    "uri": ({"type": "string", "format": "uri"}, "@id"),
    "uriorcurie": ({"type": "string", "format": "uri"}, "@id"),
    "integer": ({"type": "integer"}, None),
    "boolean": ({"type": "boolean"}, None),
}

# Non-integer numbers: strings, marked by a shared def (proposal §3 rule 10).
# LinkML type -> (name of the def next to ref_def, JSON-LD @type)
NUMBER_MAP: dict[str, tuple[str, str]] = {
    "decimal": ("decimal", "xsd:decimal"),
    "float": ("double", "xsd:double"),
    "double": ("double", "xsd:double"),
}


# Community defs that can be members of a union, with the terms their fields need.
UNION_MEMBERS: dict[str, dict[str, Any]] = {
    "at.linkedopendata.defs#ref": {"uri": "@id", "cid": None},
    # Facets are presentation only: they restate the record (proposal §3 rule 7).
    "at.linkedopendata.richtext#text": {"text": "sioc:content", "facets": None},
}
COMMUNITY_PREFIXES = {"sioc": "http://rdfs.org/sioc/ns#", "owl": "http://www.w3.org/2002/07/owl#"}

# Optional sameAs field (binding: same_as: true): the IRIs of the same resource elsewhere,
# e.g. the node a record was converted from.
SAME_AS_LEXICON = {
    "type": "array",
    "items": {"type": "string", "format": "uri"},
    "description": "IRIs of the same resource elsewhere, e.g. the Linked Data node this record was converted from (owl:sameAs).",
}
SAME_AS_TERM = {"@id": "owl:sameAs", "@type": "@id", "@container": "@set"}


def lower_camel(name: str) -> str:
    parts = re.split(r"[_\s]+", name)
    head = parts[0][:1].lower() + parts[0][1:]
    return head + "".join(p[:1].upper() + p[1:] for p in parts[1:])


@dataclass
class Field:
    name: str  # lexicon field name
    slot: SlotDefinition
    iri: str  # CURIE of the property
    lexicon: dict[str, Any]  # lexicon property definition
    term: dict[str, Any] | str  # JSON-LD term definition
    required: bool


class Binding:
    def __init__(self, path: Path):
        self.path = path
        self.conf = yaml.safe_load(path.read_text())
        self.sv = SchemaView(str((path.parent / self.conf["schema"]).resolve()))
        self.prefix: str = self.conf["nsid_prefix"]
        self.ref_def: str = self.conf["ref_def"]
        self.records: list[str] = self.conf["records"]
        self.omit: set[str] = set(self.conf.get("omit", []))
        self.overrides: dict[str, dict] = self.conf.get("fields", {})

    def nsid(self, cls: str) -> str:
        return f"{self.prefix}.{lower_camel(cls)}"

    def curie(self, element) -> str:
        return self.sv.get_uri(element, expand=False)

    def field(self, slot: SlotDefinition) -> Field:
        ov = self.overrides.get(slot.name, {})
        name = ov.get("name", lower_camel(slot.name))
        rng = ov.get("range", slot.range or self.sv.schema.default_range or "string")
        iri = self.curie(slot)
        desc = slot.description or slot.title
        if "union" in ov:
            # Each member's $type maps to the range class, so the value is typed by
            # what the slot expects, whichever member is used.
            members = ov["union"]
            unknown = [m for m in members if m not in UNION_MEMBERS]
            if unknown:
                raise ValueError(f"slot {slot.name}: unknown union members {unknown}")
            cls = self.curie(self.sv.get_class(rng))
            prop = {"type": "union", "refs": list(members)}
            scoped: dict[str, Any] = {m: cls for m in members}
            for m in members:
                scoped.update(UNION_MEMBERS[m])
            term = {"@id": iri, "@context": scoped}
        elif rng in TYPE_MAP:
            prop, ld_type = TYPE_MAP[rng]
            prop = dict(prop)
            if "maxLength" in ov:
                prop["maxLength"] = ov["maxLength"]
            term: dict[str, Any] = {"@id": iri}
            if ld_type:
                term["@type"] = ld_type
        elif rng in NUMBER_MAP:
            def_name, ld_type = NUMBER_MAP[rng]
            defs_nsid = self.ref_def.split("#", 1)[0]
            prop = {"type": "ref", "ref": f"{defs_nsid}#{def_name}"}
            term = {"@id": iri, "@type": ld_type}
        elif rng in self.sv.all_enums():
            enum = self.sv.get_enum(rng)
            prop = {"type": "string", "knownValues": list(enum.permissible_values)}
            term = {"@id": iri, "@type": "@vocab"}
        elif rng in self.sv.all_classes():
            # References to other resources: {uri, cid} objects (§3 rule 3).
            prop = {"type": "ref", "ref": self.ref_def}
            term = {"@id": iri, "@context": {"uri": "@id", "cid": None}}
        else:
            raise ValueError(f"slot {slot.name}: unsupported range {rng}")
        if slot.multivalued:
            prop = {"type": "array", "items": prop}
            term["@container"] = "@set"
        if desc:
            prop = {**prop, "description": desc}
        required = bool(ov.get("required", slot.required))
        return Field(name, slot, iri, prop, term, required)

    def fields(self, cls: str) -> list[Field]:
        slots = [s for s in self.sv.class_induced_slots(cls) if s.name not in self.omit]
        fields = [self.field(s) for s in slots]
        # Stable order: required fields first, then as induced.
        return sorted(fields, key=lambda f: not f.required)

    # ---- lexicons -------------------------------------------------------

    def lexicon(self, cls: str) -> dict[str, Any]:
        c = self.sv.get_class(cls)
        fields = self.fields(cls)
        props = {f.name: f.lexicon for f in fields}
        if self.conf.get("same_as"):
            props["sameAs"] = SAME_AS_LEXICON
        if self.conf.get("track_versions"):
            props["previousVersionCid"] = {
                "type": "string",
                "format": "cid",
                "description": "CID of the version this one replaces (proposal §3 rule 9).",
            }
        record: dict[str, Any] = {"type": "object", "properties": props}
        required = [f.name for f in fields if f.required]
        if required:
            record = {"type": "object", "required": required, "properties": props}
        return {
            "lexicon": 1,
            "id": self.nsid(cls),
            "description": f"Generated from {self.curie(c)} by lod-at-gen. DRAFT.",
            "defs": {
                "main": {
                    "type": "record",
                    "description": c.description or c.title or cls,
                    "key": self.conf.get("record_key", "tid"),
                    "record": record,
                }
            },
        }

    # ---- context --------------------------------------------------------

    def context(self) -> dict[str, Any]:
        terms: dict[str, Any] = {}
        scoped: dict[str, dict[str, Any]] = {}
        for cls in self.records:
            scoped[cls] = {}
            for f in self.fields(cls):
                prev = terms.get(f.name)
                if prev is None or prev == f.term:
                    terms[f.name] = f.term
                else:
                    scoped[cls][f.name] = f.term
        # A field mapped differently by some record types goes into every
        # type-scoped context that uses it, rather than at the top level.
        clashes = {n for s in scoped.values() for n in s}
        for cls in self.records:
            for f in self.fields(cls):
                if f.name in clashes:
                    scoped[cls][f.name] = f.term
        for n in clashes:
            terms.pop(n, None)

        if self.conf.get("same_as"):
            terms["sameAs"] = SAME_AS_TERM
        used = {t.split(":", 1)[0] for t in self._iris(terms, scoped) if ":" in t}
        ns = self.sv.namespaces()
        ctx: dict[str, Any] = {"@version": 1.1}
        for p in sorted(used):
            if p in ns:
                ctx[p] = str(ns[p])
            elif p in COMMUNITY_PREFIXES:
                ctx[p] = COMMUNITY_PREFIXES[p]
        ctx["xsd"] = XSD
        ctx["$type"] = "@type"
        if self.conf.get("track_versions"):
            ctx["previousVersionCid"] = None  # rewritten by brokers (§6.7)
        ctx.update(dict(sorted(terms.items())))
        for cls in self.records:
            ctx[self.nsid(cls)] = {
                "@id": self.curie(self.sv.get_class(cls)),
                "@context": {"@propagate": True, **dict(sorted(scoped[cls].items()))},
            }
        return {"@context": ctx}

    # ---- shapes ---------------------------------------------------------

    def pinning_shapes(self) -> str:
        """SHACL warnings for unpinned references to ATProto records (proposal Q11).

        In the Linked Data view, only an unpinned at:// target has an owl:sameAs to an
        at:// URI: a pinned one is a version node, and other targets have none. (A record
        converted from elsewhere also has owl:sameAs to its source IRI, hence the pattern.)
        So (P owl:sameAs) has no at:// value exactly when every value of P is pinned or
        not an ATProto record.
        """
        ns = self.sv.namespaces()
        lines: list[str] = []
        used: set[str] = set()
        for cls in self.records:
            props = sorted(
                {f.iri for f in self.fields(cls) if isinstance(f.term, dict) and f.term.get("@context", {}).get("uri") == "@id"}
            )
            if not props:
                continue
            target = self.curie(self.sv.get_class(cls))
            used |= {target.split(":")[0], *(p.split(":")[0] for p in props)}
            lines.append(f"[] a sh:NodeShape ;\n  sh:targetClass {target} ;")
            shapes = [
                f'  sh:property [ sh:path ( {p} owl:sameAs ) ; sh:qualifiedValueShape [ sh:pattern "^at://" ] ; sh:qualifiedMaxCount 0 ;\n'
                f"    sh:severity sh:Warning ;\n"
                f'    sh:message "Unpinned reference: include the cid of the version referred to (proposal §3 rule 3)." ]'
                for p in props
            ]
            lines.append(" ;\n".join(shapes) + " .\n")
        header = [f"@prefix {p}: <{ns[p] if p in ns else COMMUNITY_PREFIXES[p]}> ." for p in sorted(used)]
        header += ["@prefix owl: <http://www.w3.org/2002/07/owl#> .", "@prefix sh: <http://www.w3.org/ns/shacl#> .", ""]
        return "# Generated by lod-at-gen. Warnings only: unpinned references are allowed.\n" + "\n".join(header + lines)

    def binding_shapes(self) -> str:
        """What the ATProto binding can represent: one closed shape per record class.

        Applied to Linked Data about to be converted into records, each triple the
        binding has no field for is a sh:ClosedConstraintComponent result: the report of
        what the conversion drops. Info only: dropping is not an error in the input.
        """
        ns = self.sv.namespaces()
        lines: list[str] = []
        used: set[str] = set()
        for cls in self.records:
            props = sorted({f.iri for f in self.fields(cls)} | ({"owl:sameAs"} if self.conf.get("same_as") else set()))
            target = self.curie(self.sv.get_class(cls))
            used |= {target.split(":")[0], *(p.split(":")[0] for p in props)}
            lines.append(
                f"[] a sh:NodeShape ;\n  sh:targetClass {target} ;\n  sh:closed true ;\n  sh:ignoredProperties ( rdf:type ) ;\n"
                f"  sh:severity sh:Info ;\n"
                f'  sh:message "Not in the ATProto binding of {self.nsid(cls)}: dropped by the conversion." ;'
            )
            lines.append(" ;\n".join(f"  sh:property [ sh:path {p} ]" for p in props) + " .\n")
        prefixes = {p: (ns[p] if p in ns else COMMUNITY_PREFIXES[p]) for p in used}
        prefixes |= {"rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#", "sh": "http://www.w3.org/ns/shacl#"}
        header = [f"@prefix {p}: <{iri}> ." for p, iri in sorted(prefixes.items())] + [""]
        return "# Generated by lod-at-gen. Info only: what a conversion into records would drop.\n" + "\n".join(header + lines)

    def _iris(self, terms, scoped):
        def walk(t):
            if isinstance(t, str):
                yield t
            elif isinstance(t, dict):
                for k, v in t.items():
                    if k in ("@id", "@type", "@context") or not k.startswith("@"):
                        yield from walk(v)

        for t in terms.values():
            yield from walk(t)
        for s in scoped.values():
            for t in s.values():
                yield from walk(t)
        for cls in self.records:
            yield self.curie(self.sv.get_class(cls))
