"""lod-at-gen BINDING OUTDIR: write lexicons/ and context.jsonld under OUTDIR."""

import argparse
import json
from pathlib import Path

from . import Binding


def write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("binding", type=Path)
    ap.add_argument("outdir", type=Path)
    args = ap.parse_args()
    b = Binding(args.binding)
    for cls in b.records:
        nsid = b.nsid(cls)
        write(args.outdir / "lexicons" / Path(*nsid.split(".")).with_suffix(".json"), b.lexicon(cls))
    write(args.outdir / "context.jsonld", b.context())
    (args.outdir / "pinning.shacl.ttl").write_text(b.pinning_shapes())


if __name__ == "__main__":
    main()
