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
COMMONS = 'https://commons.wikimedia.org/w/api.php'
UA = {'User-Agent': 'english-review/1.0 (personal vocabulary site)'}
CANDIDATES = 8

# Words that carry no visual information; a query built from them returns noise.
STOP = set('a an the of to in on for with and or is are be being been that this '
           'somebody something sth sb esp especially used usually often when who '
           'which what from into at by as it its your their his her not no more '
           'very own same such can may must will would'.split())


def keywords(meaning, limit=3):
    words = re.findall(r"[a-z]+", (meaning or '').lower())
    return [w for w in words if w not in STOP and len(w) > 2][:limit]


QUERIES = {
    'grain':    ['barley grains close up', 'cereal grain pile', 'wheat grains macro'],
    'capsule':  ['wine bottle foil capsule', 'bottle neck foil seal', 'champagne bottle foil'],
    'prong':    ['fork tines close up', 'fork prongs macro', 'table fork detail'],
    'rake':     ['hay rake farm tool', 'rastrillo jardin', 'rake leaves autumn garden'],
    'suture':   ['sutured incision skin', 'stitches closing wound', 'surgical stitches scar'],
    'yeast':    ['dried yeast granules', 'fresh yeast block baking', 'yeast sachet baking'],
    'barley':   ['barley ear close up', 'barley spike field', 'hordeum vulgare ear'],
    'wort':     ['wort running off mash tun', 'homebrew wort bucket', 'sweet wort brewing liquid'],
    'mash':     ['mash tun brewing', 'brewery mash grain water', 'mashing in brewery'],
    'bacteria': ['bacteria electron micrograph', 'bacterial cells microscope'],
    'malt':     ['malted barley grains', 'malt grain close up'],
    'cork':     ['wine corks pile', 'cork stopper bottle'],
    'sprout':   ['seed germinating root shoot', 'sprouting seedling soil'],
    'washback': ['washback distillery fermentation', 'wooden washback whisky'],
    'congestion':   ['traffic jam city street', 'rush hour congestion road'],
    'congested':    ['traffic jam gridlock', 'congested highway cars'],
    'trial':        ['courtroom trial judge bench', 'court room interior'],
    'witness':      ['witness stand courtroom', 'courtroom witness box'],
    'surveillance': ['cctv surveillance camera wall', 'security camera street'],
    'vandalize':    ['vandalised bus shelter broken glass', 'graffiti vandalism wall'],
    'vandal':       ['graffiti vandalism wall spray', 'vandalised phone box'],
    'fine':         ['parking ticket windscreen', 'parking fine notice car'],
    'amenity':      ['public swimming pool leisure centre', 'playground park amenity'],
    'frontier':     ['border fence frontier post', 'national border crossing'],
    'blocked':      ['road blocked fallen tree', 'blocked road barrier'],
    'primitive':    ['stone age hand axe tool', 'prehistoric stone tool'],
    'soak':         ['grain soaking in water', 'steeping barley water tank'],
    'steep':        ['steeping grain water vessel', 'soaking barley steep tank'],
    'germinate':    ['germinating seed root shoot', 'seed germination soil'],
    'regulator':    ['regulatory authority office sign', 'inspector clipboard regulation'],
    'resign':       ['resignation letter desk', 'empty office desk chair'],
    'levy':         ['tax collection coins hand', 'customs duty stamp'],
}


def _strip(html_text):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', html_text or '')).strip()


def search_commons(query, page_size=CANDIDATES):
    """Wikimedia Commons, normalised to the Openverse result shape."""
    q = urllib.parse.urlencode({
        'action': 'query', 'generator': 'search', 'gsrsearch': query,
        'gsrnamespace': 6, 'gsrlimit': page_size, 'prop': 'imageinfo',
        'iiprop': 'url|extmetadata|size', 'iiurlwidth': 800, 'format': 'json'})
    try:
        with urllib.request.urlopen(urllib.request.Request(f'{COMMONS}?{q}', headers=UA), timeout=30) as r:
            pages = (json.load(r).get('query') or {}).get('pages') or {}
    except Exception as e:
        print(f'    commons failed: {type(e).__name__}', file=sys.stderr)
        return []
    out = []
    for page in pages.values():
        info = (page.get('imageinfo') or [{}])[0]
        meta = info.get('extmetadata') or {}
        thumb = info.get('thumburl')
        if not thumb or not re.search(r'\.(jpg|jpeg|png)$', thumb, re.I):
            continue
        out.append({'id': 'commons:' + page['title'], 'url': thumb,
                    'title': page['title'][5:],
                    'creator': _strip(meta.get('Artist', {}).get('value')),
                    'license': _strip(meta.get('LicenseShortName', {}).get('value')),
                    'license_version': '', 'source': 'wikimedia commons',
                    'foreign_landing_url': info.get('descriptionurl')})
    return out


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
    if term in QUERIES:
        return QUERIES[term]
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
        for hit in search(query) + search_commons(query, 4):
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
