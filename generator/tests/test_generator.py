from pathlib import Path

import pytest

from lod_at_gen import Binding

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def binding():
    return Binding(FIXTURES / "measure.binding.yaml")


def test_numbers_are_strings_in_the_lexicon(binding):
    props = binding.lexicon("Measurement")["defs"]["main"]["record"]["properties"]
    assert props["value"] == {"type": "ref", "ref": "at.linkedopendata.defs#decimal"}
    assert props["ratio"] == {"type": "array", "items": {"type": "ref", "ref": "at.linkedopendata.defs#double"}}
    assert props["count"] == {"type": "integer"}


def test_numbers_are_typed_in_the_context(binding):
    ctx = binding.context()["@context"]
    assert ctx["value"] == {"@id": "ex:value", "@type": "xsd:decimal"}
    assert ctx["ratio"] == {"@id": "ex:ratio", "@type": "xsd:double", "@container": "@set"}
    assert ctx["count"] == {"@id": "ex:count"}


def test_union_members_are_typed_by_the_range(binding):
    props = binding.lexicon("Measurement")["defs"]["main"]["record"]["properties"]
    assert props["notes"] == {
        "type": "union",
        "refs": ["at.linkedopendata.richtext#text", "at.linkedopendata.defs#ref"],
    }
    ctx = binding.context()["@context"]
    assert ctx["sioc"] == "http://rdfs.org/sioc/ns#"
    assert ctx["notes"] == {
        "@id": "ex:notes",
        "@context": {
            "at.linkedopendata.richtext#text": "sioc:Item",
            "at.linkedopendata.defs#ref": "sioc:Item",
            "text": "sioc:content",
            "facets": None,
            "uri": "@id",
            "cid": None,
        },
    }


def test_unknown_union_member_is_rejected(binding):
    binding.overrides["notes"] = {"union": ["org.example.other#thing"]}
    try:
        with pytest.raises(ValueError, match="unknown union members"):
            binding.lexicon("Measurement")
    finally:
        binding.overrides["notes"] = {"union": ["at.linkedopendata.richtext#text", "at.linkedopendata.defs#ref"]}


def test_pinning_shapes_warn_on_reference_fields_only(binding):
    ttl = binding.pinning_shapes()
    assert "sh:targetClass ex:Measurement" in ttl
    assert "sh:path ( ex:notes owl:sameAs )" in ttl  # union with at.linkedopendata.defs#ref
    assert "ex:value" not in ttl and "ex:title" not in ttl
    assert "sh:severity sh:Warning" in ttl and "sh:Violation" not in ttl
    from rdflib import Graph

    assert len(Graph().parse(data=ttl, format="turtle")) > 0


def _validate(shapes_ttl: str, data_ttl: str):
    from pyshacl import validate
    from rdflib import Graph

    conforms, report, _ = validate(Graph().parse(data=data_ttl, format="turtle"), shacl_graph=Graph().parse(data=shapes_ttl, format="turtle"))
    return conforms, report


PREFIXES = """@prefix ex: <https://example.org/measure#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
"""


def test_binding_shapes_report_exactly_what_the_binding_drops(binding):
    from rdflib import Namespace, URIRef

    SH = Namespace("http://www.w3.org/ns/shacl#")
    data = PREFIXES + """<https://example.org/m1> a ex:Measurement, ex:SomethingElse ;
        ex:title "t" ; ex:count 3 ; ex:unmapped "dropped" ."""
    conforms, report = _validate(binding.binding_shapes(), data)
    results = list(report.subjects(SH.resultSeverity, SH.Info))
    assert not conforms and len(results) == 1, "one triple dropped; rdf:type ignored"
    assert report.value(results[0], SH.resultPath) == URIRef("https://example.org/measure#unmapped")
    assert not list(report.subjects(SH.resultSeverity, SH.Violation))


def test_same_as_adds_a_field_and_a_term(tmp_path):
    conf = (FIXTURES / "measure.binding.yaml").read_text() + "same_as: true\n"
    (tmp_path / "b.yaml").write_text(conf.replace("schema: measure.yaml", f"schema: {FIXTURES / 'measure.yaml'}"))
    b = Binding(tmp_path / "b.yaml")
    props = b.lexicon("Measurement")["defs"]["main"]["record"]["properties"]
    assert props["sameAs"]["items"] == {"type": "string", "format": "uri"}
    ctx = b.context()["@context"]
    assert ctx["sameAs"] == {"@id": "owl:sameAs", "@type": "@id", "@container": "@set"}
    assert ctx["owl"] == "http://www.w3.org/2002/07/owl#"
    assert "sh:path owl:sameAs" in b.binding_shapes(), "sameAs is not dropped"


def test_pinning_warning_ignores_same_as_to_other_iris(binding):
    shapes = binding.pinning_shapes()
    # A target converted from elsewhere: owl:sameAs to its source IRI, not to an at:// URI.
    converted = PREFIXES + """<https://example.org/m1> a ex:Measurement ; ex:notes <https://lod.example/at/x#it> .
        <https://lod.example/at/x#it> owl:sameAs <https://dg.example/api/data/1> ."""
    assert _validate(shapes, converted)[0]
    unpinned = converted + "\n<https://lod.example/at/x#it> owl:sameAs <at://did:plc:x/org.example.measurement/1> ."
    assert not _validate(shapes, unpinned)[0]
