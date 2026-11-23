"""Stage Z2: compose the final male and female part lists.

Male   = every Z-Anatomy structure + BodyParts3D skin (Z-Anatomy has no skin).
Female = HRA female structures (organs, brain, cord, skin, spine, legs)
         + Z-Anatomy musculoskeletal, connective, peripheral/cranial nerves,
           vessels, lymph nodes, glands, ear, carried into her body with the
           male->female warp from fit_female.py (marked fitted).
Muscle origin/insertion patches are kept as 'attachment' parts (hidden until a
muscle is selected). Each part gets a Latin name when Z-Anatomy provides one
and a depth below the skin (median, mm) used for layer-by-layer dissection.

  python3 tools/compose.py <za prefix> <male_smooth.npz> <female_smooth.npz> <female_warp.npz> <Translations0.txt> <out dir>
writes <out>/models.{json,v.bin,f.bin,parts.json} and <out>/female.*
"""
import sys, json, re
import numpy as np
from scipy.spatial import cKDTree
from sources import atlas
from fit_female import meshes
from warp import load_warp

def load_bundle(prefix):
    d = json.load(open(prefix + '.json')); meta = json.load(open(prefix + '.meta.json'))
    v = np.fromfile(prefix + '.v.bin', np.float32).reshape(-1, 3); f = np.fromfile(prefix + '.f.bin', np.uint32).reshape(-1, 3)
    out, vo, fo = [], 0, 0
    for nv, nf in d['counts']:
        out.append((v[vo:vo + nv], f[fo:fo + nf])); vo += nv; fo += nf
    return meta, out

SIDE_END = re.compile(r'(nerve|bronchus|artery|arteries|vein|veins|muscle|muscles|segment|ligament|ligaments|gland|bone|node|nodes|\)|branch|branches|duct|plexus|nucleus|nuclei|tract)[lr]$', re.I)
def fix_name(it):
    raw = it['raw']
    if not it['side'] and SIDE_END.search(raw.replace('_', ' ')):
        side = {'l': 'left', 'r': 'right'}[raw[-1]]
        base = it['base'][:-1].rstrip()
        it['side'], it['base'] = side, base
        if it['kind'] == 'structure': it['name'] = side.capitalize() + ' ' + base[0].lower() + base[1:]
    n = it['name'].lower()
    if it['system'] == 'sensory' and re.search(r'nerve|nucle|tract|plexus', n): it['system'] = 'nervous'
    return it

def latin_table(path):
    t = {}
    for line in open(path, encoding='utf-8', errors='ignore'):
        cols = line.rstrip('\n').split(';')
        if len(cols) >= 2 and cols[0] and cols[1]: t[cols[0].strip().lower().replace('_', ' ')] = cols[1].strip()
    return t

def depth_mm(parts_v, skin_v):
    tree = cKDTree(skin_v[::3])
    out = []
    for v in parts_v:
        s = v[::max(1, len(v) // 200)]
        out.append(round(float(np.median(tree.query(s)[0])) * 1000, 1))
    return out

def write(prefix, parts, vs, fs):
    json.dump({'counts': [[len(v), len(f)] for v, f in zip(vs, fs)]}, open(prefix + '.json', 'w'))
    json.dump(parts, open(prefix + '.parts.json', 'w'))
    np.concatenate(vs).astype(np.float32).tofile(prefix + '.v.bin'); np.concatenate(fs).astype(np.uint32).tofile(prefix + '.f.bin')
    print(prefix, len(parts), 'parts', sum(len(f) for f in fs), 'triangles')

def main(za, male_npz, female_npz, warp_npz, trans, out):
    meta, za_mesh = load_bundle(za)
    meta = [fix_name(m) for m in meta]
    LAT = latin_table(trans)
    def latin(m):
        return LAT.get(m['base'].lower()) or LAT.get(re.sub(r' muscles?$', '', m['base'].lower())) or None
    def part_of(m, fitted=False):
        p = {'id': 'za:' + m['raw'], 'name': m['name'], 'system': m['system'], 'source': 'Z-Anatomy'}
        if m['kind'] != 'structure': p.update(kind=m['kind'], muscle=m['muscle'], side=m['side'])
        la = latin(m)
        if la and la.lower() != m['base'].lower(): p['latin'] = la
        if fitted: p['fitted'] = True
        return p

    # ---------------- male
    MP = atlas('models')['parts']
    if ONLY != 'female':
      M = meshes(male_npz)
      skin_i = [i for i, p in enumerate(MP) if p['name'] == 'Skin'][0]
      parts = [{'id': MP[skin_i]['id'], 'name': 'Skin', 'system': 'integumentary', 'conceptId': MP[skin_i].get('conceptId'), 'source': 'BodyParts3D'}]
      vs, fs = [M[skin_i][0]], [M[skin_i][1]]
      for m, (v, f) in zip(meta, za_mesh):
          parts.append(part_of(m)); vs.append(v); fs.append(f)
      for p, d in zip(parts, depth_mm(vs, M[skin_i][0])): p['depth'] = d
      write(out + '/models', parts, vs, fs)
      del M

    # ---------------- female
    FP = atlas('female')['parts']
    base_n = next(i for i, p in enumerate(FP) if p.get('fitted')) if any(p.get('fitted') for p in FP) else len(FP)
    F = meshes(female_npz)
    fparts = [dict({k: v for k, v in p.items() if k in ('id', 'name', 'system', 'conceptId')}, source='HRA') for p in FP[:base_n]]
    fvs, ffs = [F[i][0] for i in range(base_n)], [F[i][1] for i in range(base_n)]
    fnames = {p['name'].lower() for p in fparts}
    take = []
    for m, (v, f) in zip(meta, za_mesh):
        s, n = m['system'], m['name'].lower()
        if s in ('digestive', 'respiratory', 'urinary', 'reproductive', 'cardiac'): continue
        if s == 'endocrine' and re.search(r'hypophysis|pineal', n): continue
        if s == 'nervous' and not re.search(r'nerve|ganglion|plexus|ramus|rami|branch|trunk|cord of|ansa|root of', n): continue  # keep her brain & cord
        if s == 'nervous' and re.search(r'optic|olfactory', n): continue
        if s == 'sensory' and re.search(r'eyeball|cornea|iris|lens|retina|sclera|vitreous|choroid|chamber', n): continue
        if s == 'skeletal' and re.search(r'vertebra|sacrum|coccyx|femur|tibia|fibula|patella|hip bone|ilium|ischium|pubis', n) and 'disc' not in n: continue
        if s == 'connective' and re.search(r'menisc|cruciate|collateral ligament of knee|patellar ligament', n): continue
        if s == 'muscular' and re.search(r'rectus femoris|extraocular|(superior|inferior|medial|lateral) rectus|(superior|inferior) oblique$|cremaster', n): continue
        if s in ('arterial', 'venous') and (n in fnames or re.search(r'testic|spermatic|pampiniform|penis|scrot|prostat', n)): continue
        if s == 'attachment' and re.search(r'cremaster', n): continue
        if n in fnames: continue
        take.append((m, v, f))
    print('female: fitting', len(take), 'Z-Anatomy structures')
    W = load_warp(warp_npz)
    allv = np.concatenate([v for _, v, _ in take]).astype(np.float64)
    wv = np.concatenate([W(allv[k:k + 250000]) for k in range(0, len(allv), 250000)]); o = 0
    for m, v, f in take:
        fparts.append(part_of(m, fitted=True)); fvs.append(wv[o:o + len(v)].astype(np.float32)); ffs.append(f); o += len(v)
    fskin = next(i for i, p in enumerate(fparts) if p['name'] == 'Skin')
    for p, d in zip(fparts, depth_mm(fvs, fvs[fskin])): p['depth'] = d
    write(out + '/female', fparts, fvs, ffs)

ONLY = None
if __name__ == '__main__':
    ONLY = sys.argv[7] if len(sys.argv) > 7 else None
    main(*sys.argv[1:7])
