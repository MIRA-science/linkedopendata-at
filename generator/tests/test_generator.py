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
