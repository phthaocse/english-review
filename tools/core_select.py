#!/usr/bin/env python3
"""Pick the first study set from the Oxford 5000: 1,000 headwords by CEFR share.

One entry per headword, so "aim" the noun and "aim" the verb never both use a
slot. Words the question formats cannot test (articles, pronouns, numbers...)
are left out. The seed is fixed, so the same lists always give the same set.

    python3 tools/core_select.py [CSV_DIR]
    cd worker && wrangler d1 execute knowledge --remote --file ../tools/oxford/core-1000.sql
"""
import csv
import random
import sys
from pathlib import Path
from urllib.parse import urlparse

CSV_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / 'Documents/English/Oxford-word-lists')
OUT_DIR = Path(__file__).parent / 'oxford'
COLLECTION = 'core-1000'
SEED = 20261006

# The Oxford 5000 stops at C1, so the C2 share asked for (10%) is given to C1.
TARGET = {'a1': 50, 'a2': 100, 'b1': 300, 'b2': 300, 'c1': 250}

UNTESTABLE_POS = {
    'indefinite article', 'definite article', 'pronoun', 'determiner', 'number',
    'ordinal number', 'auxiliary verb', 'infinitive marker', 'linking verb', 'exclamation',
}


def sql(value):
    return 'NULL' if value is None else "'" + value.replace("'", "''") + "'"


def path_of(url):
    parts = urlparse(url)
    return parts.path + (f'#{parts.fragment}' if parts.fragment else '')


def interleave(chosen):
    """Deal order: at every point the levels are as close to their shares as they can be,
    so the first 20 words dealt already have the 5/10/30/30/25 mix, not 20 A1s."""
    queues = {lv: [r for r in chosen if r['level'] == lv] for lv in TARGET}
    total = sum(TARGET.values())
    order, dealt = [], {lv: 0 for lv in TARGET}
    for k in range(1, total + 1):
        lv = max((lv for lv in TARGET if queues[lv]),
                 key=lambda lv: TARGET[lv] / total * k - dealt[lv])
        order.append(queues[lv].pop(0))
        dealt[lv] += 1
    return order


def main():
    rows = [r for r in csv.DictReader(open(CSV_DIR / 'oxford_5000.csv', newline=''))
            if r['pos'] not in UNTESTABLE_POS]
    rng = random.Random(SEED)
    rng.shuffle(rows)

    chosen, used = [], set()
    for level, wanted in TARGET.items():
        picked = 0
        for r in rows:
            if picked == wanted:
                break
            if r['level'] != level or r['word'] in used:
                continue
            used.add(r['word'])
            chosen.append(r)
            picked += 1
        if picked < wanted:
            raise SystemExit(f'only {picked} {level} headwords available, wanted {wanted}')

    chosen = interleave(chosen)
    OUT_DIR.mkdir(exist_ok=True)
    with open(OUT_DIR / f'{COLLECTION}.csv', 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['word', 'pos', 'level', 'url'])
        w.writeheader()
        w.writerows({k: r[k] for k in ['word', 'pos', 'level', 'url']} for r in chosen)

    with open(OUT_DIR / f'{COLLECTION}.sql', 'w') as f:
        for position, r in enumerate(chosen):
            f.write(
                'INSERT OR IGNORE INTO study_word (entry_id, collection, position) '
                f"SELECT id, {sql(COLLECTION)}, {position} FROM oxford_entry "
                f"WHERE list = 'word' AND term = {sql(r['word'])} AND pos = {sql(r['pos'])} "
                f"AND path = {sql(path_of(r['url']))};\n")

    by_level = {lv: sum(1 for r in chosen if r['level'] == lv) for lv in TARGET}
    print(f'{len(chosen)} headwords {by_level} -> {OUT_DIR}/{COLLECTION}.csv and .sql')


if __name__ == '__main__':
    main()
