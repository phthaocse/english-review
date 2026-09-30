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
    index = {f.stem: alt_of(f) for f in sorted(WORDS.glob('*.svg'))}
    for f in sorted(WORDS.glob('*.jpg')) + sorted(WORDS.glob('*.png')):
        index.setdefault(f.stem, '')
    (WORDS / 'index.json').write_text(json.dumps(index, indent=1, ensure_ascii=False) + '\n')
    print(f'{len(index)} drawings')
    for k, v in index.items():
        print(f'  {k:14} {"(no aria-label)" if not v else v[:62]}')

if __name__ == '__main__':
    main()
