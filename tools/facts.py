"""Prefetch quick facts for each structure from English Wikipedia anatomy
infoboxes (muscle: origin, insertion, artery, nerve, actions, antagonist;
nerve: from, to, innervates; artery/vein: source, branches, supplies, drains;
bone: articulations) plus a 2-3 sentence summary.

Text is from Wikipedia (CC BY-SA 4.0); each entry keeps its article URL for
attribution.

  python3 tools/facts.py <parts.json> [<parts.json> ...] dist/facts.json
"""
import json, re, sys, time, html, urllib.parse, urllib.request

API = 'https://en.wikipedia.org/w/api.php'
UA = {'User-Agent': 'anatomy-atlas-builder/1.0 (educational viewer)'}
FIELDS = {
    'origin': 'Origin', 'insertion': 'Insertion', 'actions': 'Action', 'action': 'Action', 'antagonist': 'Antagonist',
    'nerve': 'Innervation', 'innervates': 'Innervates', 'blood': 'Blood supply', 'artery': 'Blood supply',
    'branchfrom': 'Branch of', 'from': 'Branch of', 'branchto': 'Branches', 'to': 'Branches', 'branches': 'Branches',
    'source': 'Source', 'supplies': 'Supplies', 'drainsfrom': 'Drains', 'drainsto': 'Drains to', 'vein': 'Venous drainage',
    'lymph': 'Lymphatic drainage', 'articulations': 'Articulations', 'system': 'System', 'function': 'Function',
    'precursor': 'Develops from', 'location': 'Location', 'latin': 'Latin',
}
SIDE = re.compile(r'^(left|right)\s+', re.I)

def get(params):
    url = API + '?' + urllib.parse.urlencode({**params, 'format': 'json', 'formatversion': 2})
    for k in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r: return json.load(r)
        except Exception:
            time.sleep(2 + 3 * k)
    return {}

def clean(v):
    v = re.sub(r'<ref[^>]*/>|<ref[^>]*>.*?</ref>', '', v, flags=re.S)
    v = re.sub(r'<br\s*/?>', '; ', v)
    v = re.sub(r'\{\{(?:nowrap|nobr|small)\|([^{}]*)\}\}', r'\1', v)
    v = re.sub(r'\{\{[^{}]*\}\}', '', v)
    v = re.sub(r'\[\[(?:[^\]|]*\|)?([^\]]*)\]\]', r'\1', v)
    v = re.sub(r"'{2,}", '', v)
    v = re.sub(r'<[^>]+>', '', html.unescape(v))
    return re.sub(r'\s+', ' ', v).strip(' ;,')

def infobox(text):
    i = text.find('{{Infobox')
    if i < 0: return None, {}
    depth, j = 0, i
    while j < len(text) - 1:
        if text.startswith('{{', j): depth += 1; j += 2; continue
        if text.startswith('}}', j):
            depth -= 1; j += 2
            if depth == 0: break
            continue
        j += 1
    body = text[i + 2:j - 2]
    kind = body.split('|', 1)[0].replace('Infobox', '').strip().lower()
    out = {}
    # split on top-level pipes
    depth, cur, parts = 0, '', []
    k = 0
    while k < len(body):
        c2 = body[k:k + 2]
        if c2 in ('{{', '[['): depth += 1; cur += c2; k += 2; continue
        if c2 in ('}}', ']]'): depth -= 1; cur += c2; k += 2; continue
        if body[k] == '|' and depth == 0: parts.append(cur); cur = ''; k += 1; continue
        cur += body[k]; k += 1
    parts.append(cur)
    for p in parts[1:]:
        if '=' not in p: continue
        key, val = p.split('=', 1)
        key = re.sub(r'[\s_]', '', key).lower()
        if key in FIELDS:
            val = clean(val)
            if val and len(val) < 600: out.setdefault(FIELDS[key], val)
    return kind, out

def main(inputs, out):
    names = set()
    import os
    old = json.load(open(out))['items'] if os.path.exists(out) else {}
    for f in inputs:
        for p in json.load(open(f)):
            if p.get('kind') or p.get('system') == 'attachment': continue
            n = SIDE.sub('', p['name']).strip()
            n = re.sub(r'\bAllen\s+', '', n)
            if n and not re.search(r'\b(segment [a-z]|[LR] [a-z])$', n):
                names.add(n[0].upper() + n[1:])
                whole = re.sub(r'^.*? (part|head|belly|portion|fibres|fibers|layer|division) of (the )?', '', n, flags=re.I)
                if whole != n: names.add(whole[0].upper() + whole[1:])
    names = sorted(n for n in names if n not in old)
    print(len(names), 'names', flush=True)
    facts, titles = dict(old), {}
    for k in range(0, len(names), 50):
        batch = names[k:k + 50]
        d = get({'action': 'query', 'prop': 'revisions', 'rvprop': 'content', 'rvslots': 'main', 'redirects': 1, 'titles': '|'.join(batch)})
        q = d.get('query', {})
        norm = {x['from']: x['to'] for x in q.get('normalized', [])}
        red = {x['from']: x['to'] for x in q.get('redirects', [])}
        pages = {p['title']: p for p in q.get('pages', [])}
        for n in batch:
            t = norm.get(n, n); t = red.get(t, t)
            p = pages.get(t)
            if not p or p.get('missing') or 'revisions' not in p: continue
            text = p['revisions'][0]['slots']['main']['content']
            if re.match(r'(?i)#redirect', text) or '{{disambiguation' in text.lower() or '{{dis' in text.lower()[:200]: continue
            kind, fields = infobox(text)
            if not fields and not re.search(r'(?i)\b(muscle|bone|nerve|artery|vein|ligament|gland|organ|anatom|lobe|gyrus)', text[:3000]): continue
            facts[n] = {'title': t, 'url': 'https://en.wikipedia.org/wiki/' + urllib.parse.quote(t.replace(' ', '_')), 'kind': kind, 'fields': fields}
            titles.setdefault(t, []).append(n)
        print(k + 50, len(facts), flush=True)
        time.sleep(.5)
    tl = sorted(titles)
    for k in range(0, len(tl), 20):
        d = get({'action': 'query', 'prop': 'extracts', 'exintro': 1, 'explaintext': 1, 'exsentences': 3, 'exlimit': 20, 'titles': '|'.join(tl[k:k + 20])})
        for p in d.get('query', {}).get('pages', []):
            ex = (p.get('extract') or '').strip()
            for n in titles.get(p['title'], []):
                if ex: facts[n]['summary'] = re.sub(r'\s+', ' ', ex)[:700]
        time.sleep(.5)
    json.dump({'source': 'Wikipedia (CC BY-SA 4.0), article infoboxes and lead sections', 'items': facts}, open(out, 'w'), separators=(',', ':'))
    print('done', len(facts), 'structures with facts')

if __name__ == '__main__':
    main(sys.argv[1:-1], sys.argv[-1])
