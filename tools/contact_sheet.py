#!/usr/bin/env python3
"""Lay every candidate out on one page, so a whole session can be judged at once.

    python3 tools/contact_sheet.py            all staged terms
    python3 tools/contact_sheet.py grain cork just these

Each row is one word: the term and its meaning on the left, its candidates
numbered across. Pick by number; 0 means none of them fit and the word needs a
generated illustration instead.
"""
import json, pathlib, sys
from PIL import Image, ImageDraw, ImageFont

STAGE = pathlib.Path(__file__).resolve().parent / 'candidates'
OUT = pathlib.Path(__file__).resolve().parent / 'sheet'
THUMB, LABEL, PAD, ROWS = 200, 320, 10, 6

def font(size):
    for p in ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc']:
        if pathlib.Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def wrap(draw, text, f, width):
    words, lines, line = str(text or '').split(), [], ''
    for w in words:
        trial = f'{line} {w}'.strip()
        if draw.textlength(trial, font=f) <= width:
            line = trial
        else:
            lines.append(line); line = w
    if line: lines.append(line)
    return lines[:4]

def build(folders, out):
    big, small = font(21), font(14)
    width = LABEL + (THUMB + PAD) * 4 + PAD
    sheet = Image.new('RGB', (width, (THUMB + PAD) * len(folders) + PAD), 'white')
    draw = ImageDraw.Draw(sheet)
    for row, folder in enumerate(folders):
        meta = json.loads((folder / 'candidates.json').read_text())
        y = PAD + row * (THUMB + PAD)
        draw.text((PAD, y + 4), meta['term'], font=big, fill='black')
        for i, line in enumerate(wrap(draw, meta.get('meaning'), small, LABEL - PAD * 2)):
            draw.text((PAD, y + 34 + i * 17), line, font=small, fill='#555')
        for col, cand in enumerate(meta['candidates'][:4]):
            x = LABEL + col * (THUMB + PAD)
            try:
                img = Image.open(folder / cand['file']).convert('RGB')
            except Exception:
                continue
            img.thumbnail((THUMB, THUMB - 20))
            sheet.paste(img, (x, y + 18))
            draw.text((x, y), f'{col + 1}', font=big, fill='#c00')
        draw.line([(0, y + THUMB + PAD // 2), (width, y + THUMB + PAD // 2)], fill='#ddd')
    sheet.save(out)
    return out

def main():
    want = [a.lower() for a in sys.argv[1:]]
    folders = sorted(f for f in STAGE.iterdir()
                     if f.is_dir() and (f / 'candidates.json').exists()
                     and (not want or f.name in want))
    folders = [f for f in folders if json.loads((f / 'candidates.json').read_text())['candidates']]
    OUT.mkdir(exist_ok=True)
    for n in range(0, len(folders), ROWS):
        print(build(folders[n:n + ROWS], OUT / f'sheet-{n // ROWS + 1}.png'))

if __name__ == '__main__':
    main()
