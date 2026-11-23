"""Re-detect muscle origin/insertion patches in the Z-Anatomy skeletal export.
Patches are named <muscle><o|e><n>; many belong to muscles that the muscular
export only has in parts (e.g. deltoid), so match against muscle-name stems.
  python3 tools/fix_attachments.py <za prefix>"""
import json, re, sys
from za_align import pretty
p = sys.argv[1] + '.meta.json'
meta = json.load(open(p))
stems = set()
for m in meta:
    if m['file'] == 'MuscularSystem100':
        b = re.sub(r'\s+muscles?$', '', m['base'].lower())
        stems.add(b); stems.add(re.sub(r'^.*? (part|head|belly|portion|fibres|fibers) of ', '', b))
fixed = 0
for m in meta:
    if m['file'] != 'SkeletalSystem100' or m['kind'] != 'structure': continue
    raw = m['raw']
    core = raw[:-1] if m['side'] else raw
    mm = re.match(r'^(.+?)(o|e)(\d*)$', core)
    if not mm and not m['side'] and raw[-1] in 'lr':
        mm = re.match(r'^(.+?)(o|e)(\d*)$', raw[:-1])
        if mm: m['side'] = {'l': 'left', 'r': 'right'}[raw[-1]]
    if not mm: continue
    musc = pretty(mm.group(1)); key = re.sub(r'\s+muscles?$', '', musc.lower())
    if not (mm.group(1).lower().endswith(('_muscle', '_muscles')) or key in stems or any(s.endswith(key) for s in stems if len(key) > 6)): continue
    m['kind'] = 'origin' if mm.group(2) == 'o' else 'insertion'
    m['muscle'] = re.sub(r'\s+muscles?$', '', musc)
    m['system'] = 'attachment'
    m['name'] = f"{'Origin' if m['kind'] == 'origin' else 'Insertion'} of {(m['side'] + ' ') if m['side'] else ''}{m['muscle'][0].lower() + m['muscle'][1:]}"
    fixed += 1
json.dump(meta, open(p, 'w'))
print('reclassified', fixed, 'attachment patches;', sum(m['system'] == 'skeletal' for m in meta), 'skeletal structures remain')
