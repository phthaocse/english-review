#!/usr/bin/env python3
"""Turn the Oxford 5000 and Oxford Phrase List CSVs into SQL for D1.

The lists are Oxford's and this repo is public, so the CSVs and the SQL stay
on the Mac (tools/oxford/ is git-ignored); only this script is committed.

    python3 tools/oxford_seed.py [CSV_DIR]
    cd worker && wrangler d1 execute knowledge --remote --file ../tools/oxford/seed.sql
"""
import csv
import sys
from pathlib import Path
from urllib.parse import urlparse

CSV_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / 'Documents/English/Oxford-word-lists')
OUT = Path(__file__).parent / 'oxford' / 'seed.sql'
ROWS_PER_INSERT = 200


def sql(value):
    return 'NULL' if value is None else "'" + value.replace("'", "''") + "'"


def path_of(url):
    parts = urlparse(url)
    return parts.path + (f'#{parts.fragment}' if parts.fragment else '')


def rows():
    with open(CSV_DIR / 'oxford_5000.csv', newline='') as f:
        for r in csv.DictReader(f):
            yield ('word', r['word'], r['pos'] or None, r['level'], path_of(r['url']))
    with open(CSV_DIR / 'oxford_phrase_list.csv', newline='') as f:
        for r in csv.DictReader(f):
            yield ('phrase', r['phrase'], None, r['level'], path_of(r['url']))


def main():
    all_rows = list(rows())
    OUT.parent.mkdir(exist_ok=True)
    with open(OUT, 'w') as out:
        for i in range(0, len(all_rows), ROWS_PER_INSERT):
            values = ',\n'.join('(' + ', '.join(sql(v) for v in row) + ')'
                                for row in all_rows[i:i + ROWS_PER_INSERT])
            out.write(f'INSERT OR IGNORE INTO oxford_entry (list, term, pos, level, path) VALUES\n{values};\n')
    print(f'{len(all_rows)} entries -> {OUT}')


if __name__ == '__main__':
    main()
