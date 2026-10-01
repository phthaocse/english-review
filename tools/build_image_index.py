#!/usr/bin/env python3
"""List the drawings in assets/words/ so the site knows which words have one.

A picture filed under the item's own id (`grain.svg` for `grain`) belongs to
that word — no frontmatter needed. The alt text comes from the drawing's own
aria-label, so the description lives with the thing it describes.

    python3 tools/build_image_index.py
"""
import json, pathlib, re

WORDS = pathlib.Path(__file__).resolve().parent.parent / 'assets' / 'words'

def alt_of(svg):
    m = re.search(r'aria-label="([^"]+)"', svg.read_text())
    return m.group(1) if m else ''

def main():
    credits_file = WORDS / 'credits.json'
    credits = json.loads(credits_file.read_text()) if credits_file.exists() else {}

    index = {}
    for f in sorted(WORDS.glob('*.svg')):
        index[f.stem] = {'src': f.name, 'alt': alt_of(f)}
    for f in sorted(WORDS.glob('*.jpg')) + sorted(WORDS.glob('*.png')):
        index.setdefault(f.stem, {'src': f.name, 'alt': ''})
    for term, credit in credits.items():
        if term in index:
            index[term]['credit'] = credit

    (WORDS / 'index.json').write_text(
        json.dumps(dict(sorted(index.items())), indent=1, ensure_ascii=False) + '\n')
    photos = sum(1 for v in index.values() if not v['src'].endswith('.svg'))
    print(f'{len(index)} pictures: {photos} photographs, {len(index) - photos} drawings')
    for k, v in sorted(index.items()):
        mark = 'photo' if 'credit' in v else '  svg'
        print(f'  {mark}  {k:12} {(v["alt"] or v.get("credit", {}).get("text", ""))[:58]}')

if __name__ == '__main__':
    main()
