#!/usr/bin/env python3
"""Adopt one staged candidate as a word's picture, carrying its licence with it.

    python3 tools/adopt_image.py grain=2 cork=1 prong=2

Copies tools/candidates/<term>/<n>.jpg to assets/words/<term>.jpg and records the
photographer and licence in assets/words/credits.json. A CC BY or CC BY-SA photo
may only be published with that credit shown, so the two move together and the
site renders the credit under the picture.
"""
import json, pathlib, shutil, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
STAGE, WORDS = ROOT / 'tools' / 'candidates', ROOT / 'assets' / 'words'
CREDITS = WORDS / 'credits.json'

# How each licence is written out. BY and BY-SA are fine here; BY-ND is avoided
# at pick time, because scaling and cropping a picture for a card is exactly the
# derivative that licence forbids.
LICENCE_NAME = {'by': 'CC BY', 'by-sa': 'CC BY-SA', 'by-nd': 'CC BY-ND',
                'by-nc': 'CC BY-NC', 'cc0': 'CC0', 'pdm': 'Public Domain Mark'}


def credit_line(c):
    """What the licence requires on the page: the work, the author, the licence."""
    lic = (c.get('license') or '').strip().lower()
    ver = (c.get('license_version') or '').strip()
    name = LICENCE_NAME.get(lic, lic.upper() or 'see source')
    label = f'{name} {ver}'.strip() if lic in ('by', 'by-sa', 'by-nd', 'by-nc') else name
    title = (c.get('title') or '').strip()
    who = (c.get('creator') or '').strip()
    return f'{title}{" by " + who if who else ""} ({label})'.strip()


def main(args):
    credits = json.loads(CREDITS.read_text()) if CREDITS.exists() else {}
    for arg in args:
        term, _, pick = arg.partition('=')
        folder = STAGE / term
        manifest = json.loads((folder / 'candidates.json').read_text())
        chosen = manifest['candidates'][int(pick) - 1]
        src = folder / chosen['file']
        shutil.copy(src, WORDS / f'{term}.jpg')
        for stale in WORDS.glob(f'{term}.svg'):
            stale.unlink()
        credits[term] = {'text': credit_line(chosen), 'url': chosen.get('page') or ''}
        print(f"{term:10} <- {chosen['file']}  {credits[term]['text'][:70]}")
    CREDITS.write_text(json.dumps(dict(sorted(credits.items())), indent=1, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    main(sys.argv[1:])
