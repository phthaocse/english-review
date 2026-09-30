#!/usr/bin/env python3
"""Find a picture for each vocabulary item.

Stage one of the illustration pipeline: search Openverse (CC-licensed, no API
key) and stage candidates for review. Nothing is committed here — a picture that
does not carry the meaning is worse than no picture, so a human picks.

    python3 tools/find_images.py --session "2026-09-29 Whisky distilling"
    python3 tools/find_images.py --terms grain,cork,wort

Writes candidates to tools/candidates/<term>/N.jpg and a manifest carrying the
licence and creator, which the note needs in order to credit the photographer.
"""
import argparse, json, pathlib, re, sys, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
STAGE = ROOT / 'tools' / 'candidates'
API = 'https://api.openverse.org/v1/images/'
UA = {'User-Agent': 'english-review/1.0 (personal vocabulary site)'}
CANDIDATES = 4

# Words that carry no visual information; a query built from them returns noise.
STOP = set('a an the of to in on for with and or is are be being been that this '
           'somebody something sth sb esp especially used usually often when who '
           'which what from into at by as it its your their his her not no more '
           'very own same such can may must will would'.split())


def keywords(meaning, limit=3):
    words = re.findall(r"[a-z]+", (meaning or '').lower())
    return [w for w in words if w not in STOP and len(w) > 2][:limit]


def search(query, page_size=CANDIDATES):
    url = f'{API}?{urllib.parse.urlencode({"q": query, "license_type": "commercial", "page_size": page_size})}'
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
            return json.load(r).get('results') or []
    except Exception as e:
        print(f'    search failed: {type(e).__name__}', file=sys.stderr)
        return []


def queries_for(item):
    """Narrow first, then wider — the bare term alone collides with proper nouns."""
    term, kw = item['term'], keywords(item.get('meaning'))
    out = [f'{term} {" ".join(kw[:2])}'.strip(), term]
    if kw:
        out.append(' '.join(kw))
    return [q for i, q in enumerate(out) if q and q not in out[:i]]


def fetch(url, to):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
        to.write_bytes(r.read())


def collect(item):
    folder = STAGE / re.sub(r'[^a-z0-9]+', '-', item['term'].lower()).strip('-')
    folder.mkdir(parents=True, exist_ok=True)
    seen, kept = set(), []
    for query in queries_for(item):
        for hit in search(query):
            if hit['id'] in seen or len(kept) >= CANDIDATES:
                continue
            seen.add(hit['id'])
            path = folder / f'{len(kept) + 1}.jpg'
            try:
                fetch(hit['url'], path)
            except Exception:
                continue
            kept.append({'file': path.name, 'query': query, 'title': hit.get('title'),
                         'creator': hit.get('creator'), 'license': hit.get('license'),
                         'license_version': hit.get('license_version'),
                         'source': hit.get('source'), 'page': hit.get('foreign_landing_url')})
        if len(kept) >= CANDIDATES:
            break
    (folder / 'candidates.json').write_text(json.dumps(
        {'term': item['term'], 'meaning': item.get('meaning'), 'vi': item.get('vi'),
         'candidates': kept}, indent=1, ensure_ascii=False))
    return kept


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--session')
    ap.add_argument('--terms', help='comma-separated')
    ap.add_argument('--types', default='word,collocation,idiom,phrasal-verb')
    args = ap.parse_args()

    data = json.loads((ROOT / 'data' / 'vocab.json').read_text())
    items = data['items'] if isinstance(data, dict) else data
    types = set(args.types.split(','))
    if args.terms:
        wanted = {t.strip().lower() for t in args.terms.split(',')}
        items = [i for i in items if i['term'].lower() in wanted]
    else:
        items = [i for i in items if i.get('type') in types]
        if args.session:
            items = [i for i in items if i.get('session') == args.session]

    print(f'{len(items)} items\n')
    for item in items:
        got = collect(item)
        print(f'  {item["term"][:28]:30} {len(got)} candidate(s)'
              + (f'  [{got[0]["query"]}]' if got else '  — nothing found'))


if __name__ == '__main__':
    main()
