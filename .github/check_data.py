"""Fail the deploy rather than publish a site with no words in it."""

import json
import pathlib
import sys

path = pathlib.Path("data/vocab.json")
if not path.is_file():
    sys.exit("data/vocab.json is missing - run build_site.py before pushing")

data = json.loads(path.read_text(encoding="utf-8"))
items = data.get("items") or []
if not items:
    sys.exit("data/vocab.json contains no items")

missing = [i["id"] for i in items if not i.get("term")]
if missing:
    sys.exit(f"{len(missing)} item(s) have no term, e.g. {missing[:3]}")

print(f"{len(items)} items, generated {data.get('generated')}")
