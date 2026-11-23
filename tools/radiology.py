"""Prefetch published radiology figures for each structure from Open-i (NLM),
which indexes figures from open-access biomedical literature (PubMed Central).
The API does not send CORS headers, so the viewer reads this static file.

  python3 tools/radiology.py dist/radiology.json

Each entry keeps title, journal, year, caption, PMC/PubMed ids, the figure's
Creative Commons licence and image paths on openi.nlm.nih.gov. Images are
hot-linked, not copied.
"""
import json, re, sys, time, html, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from sources import atlas

SIDE = re.compile(r'\b(left|right)\b\s*', re.I)
def base(name):
    n = SIDE.sub('', name).replace(' of  ', ' of ').strip()
    n = re.sub(r'\bAllen\s+', '', n)
    n = re.sub(r'\s+(L|R)( [a-z])?$', '', n)
    n = re.sub(r'\s+', ' ', n).strip(' ,')
    return n[0].upper() + n[1:] if n else n

def simplify(n):
    n = re.sub(r'^(set of|.*? (part|head|branch|portion|segment|division) of)\s+', '', n, flags=re.I)
    return n

def query(q):
    url = 'https://openi.nlm.nih.gov/api/search?' + urllib.parse.urlencode({'query': q, 'it': 'c,m,x,u', 'm': 1, 'n': 6})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'anatomy-atlas-prefetch/1.0'}), timeout=40) as r:
                return json.load(r).get('list', [])
        except Exception:
            time.sleep(2 + attempt * 3)
    return []

def clean(s, n=320):
    s = html.unescape(re.sub(r'<[^>]+>', '', s or '')).strip()
    return s if len(s) <= n else s[:n].rsplit(' ', 1)[0] + '…'

def fetch(name):
    hits = query(name)
    q = name
    if not hits and simplify(name) != name:
        q = simplify(name); hits = query(q)
    out = []
    for e in hits:
        d = e.get('journal_date') or {}
        out.append(dict(t=clean(e.get('title'), 200), j=e.get('journal_title') or '', y=d.get('year') or '',
                        cap=clean((e.get('image') or {}).get('caption')), th=e.get('imgThumb'), lg=e.get('imgLarge'),
                        pmc=e.get('uid'), pmid=e.get('pmid'), lic=e.get('ccLicense') or '', url=e.get('detailedQueryURL'), a=clean(e.get('authors'), 80)))
    return name, {'query': q, 'figures': out}

if __name__ == '__main__':
    names = sorted({base(p['name']) for body in ('models', 'female') for p in atlas(body)['parts']} - {''})
    print(len(names), 'unique structure names', flush=True)
    result = {}
    with ThreadPoolExecutor(4) as pool:
        for k, (n, r) in enumerate(pool.map(fetch, names)):
            result[n] = r
            if k % 100 == 0: print(k, n, len(r['figures']), flush=True)
    json.dump({'source': 'Open-i, U.S. National Library of Medicine (openi.nlm.nih.gov); figures from open-access articles in PubMed Central',
               'base': 'https://openi.nlm.nih.gov', 'items': result}, open(sys.argv[1], 'w'), separators=(',', ':'))
    print('done', sum(1 for r in result.values() if r['figures']), 'names with figures')
