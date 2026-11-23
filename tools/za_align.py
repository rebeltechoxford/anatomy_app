"""Stage Z1: name, classify and align Z-Anatomy meshes to the BodyParts3D frame.

Z-Anatomy (CC BY-SA 4.0) extends BodyParts3D with modeled peripheral nerves,
facial muscles, ligaments, fasciae, bursae, lymph nodes, and muscle
origin/insertion patches on bones. Its export is in centimetres with a small
offset/scale from BodyParts3D; a similarity transform fitted on paired bones
(Procrustes) puts it in the frame used by every other derived model here
(female warp, nerve wiring, dermatome grid), so those stay valid.

Output bundle (+ .meta.json): structures and attachment patches, Taubin-smoothed.
  python3 tools/za_align.py <za_raw prefix> <male_smooth.npz> <out prefix>
"""
import sys, json, re
import numpy as np
from sources import atlas
from fit_female import meshes, procrustes
from smooth import taubin

TRANS = {}

def load_bundle(prefix):
    d = json.load(open(prefix + '.json'))
    v = np.fromfile(prefix + '.v.bin', np.float32).reshape(-1, 3)
    f = np.fromfile(prefix + '.f.bin', np.uint32).reshape(-1, 3)
    out, vo, fo = [], 0, 0
    for nv, nf in d['counts']:
        out.append((v[vo:vo + nv].astype(np.float64), f[fo:fo + nf].astype(np.int64))); vo += nv; fo += nf
    return d['meta'], out

def pretty(s):
    s = s.replace('_', ' ').replace('*', '').strip()
    s = re.sub(r'\s*\.\d+$', '', s)
    s = re.sub(r'^\((.*)\)$', r'\1', s)
    return s[0].upper() + s[1:] if s else s

VEIN = re.compile(r'\bvein|venous|sinus\b|sinuses|vena\b|venae|plexus of veins', re.I)
def system_of(file, name):
    n = name.lower()
    if file == 'SkeletalSystem100':
        return 'connective' if re.search(r'cartilage|ligament|disc\b|meniscus|labrum', n) and 'costal cartilage' not in n else 'skeletal'
    if file == 'Joints100': return 'connective'
    if file == 'MuscularSystem100':
        return 'connective' if re.search(r'fascia|bursa|sheath|aponeurosis|retinaculum|septum|tendon|ligament|tract\b', n) and not re.search(r'muscle', n) else 'muscular'
    if file == 'NervousSystem100':
        if re.search(r'eyeball|lens|retina|cornea|iris|sclera|choroid|vitreous|lacrimal|tympan|cochlea|vestib|semicircular|ossicle|auricle|ear\b|malleus|incus|stapes|conjunctiv|eyelid|tarsal plate', n): return 'sensory'
        return 'nervous'
    if file == 'CardioVascular41':
        if re.search(r'heart|ventricle|atrium|auricle of|valve|leaflet|cusp|papillary|chorda|myocard|pericard|septum', n) and not re.search(r'artery|vein|branch', n): return 'cardiac'
        return 'venous' if VEIN.search(n) else 'arterial'
    if file == 'LymphoidOrgans100':
        return 'lymphatic'
    if file == 'VisceralSystem100':
        if re.search(r'lung|bronch|trache|larynx|pleura|nasal|epiglott|glottis|vocal|nasopharynx|alveol|segment of (right|left) lung|lobe of (right|left) lung', n): return 'respiratory'
        if re.search(r'kidney|renal|ureter|bladder|urethra|calyx', n): return 'urinary'
        if re.search(r'testis|epididym|ductus deferens|seminal|prostat|penis|corpus (spongiosum|cavernosum)|ejaculatory|scrotum|bulbourethral|ovary|uter|vagin', n): return 'reproductive'
        if re.search(r'thyroid|parathyroid|suprarenal|adrenal|hypophysis|pituitary|pineal|thymus', n): return 'endocrine'
        if re.search(r'spleen', n): return 'lymphatic'
        if re.search(r'skin|breast|mammary', n): return 'integumentary'
        return 'digestive'
    return 'connective'

ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth']

def main(raw, male_npz, out):
    meta, mesh = load_bundle(raw)
    raws = {m['raw'] for m in meta}
    # side suffix only when both l/r variants exist
    def split_side(r):
        if len(r) > 2 and r[-1] in 'lr' and (r[:-1] + 'l') in raws and (r[:-1] + 'r') in raws:
            return r[:-1], {'l': 'left', 'r': 'right'}[r[-1]]
        if r.endswith('j'): return r[:-1], None
        return r, None
    muscle_bases = set()
    for m in meta:
        if m['file'] == 'MuscularSystem100':
            b, _ = split_side(m['raw'])
            muscle_bases.add(re.sub(r'_muscles?$', '', b).lower())
    items = []
    for m, (v, f) in zip(meta, mesh):
        base, side = split_side(m['raw'])
        kind, muscle = 'structure', None
        if m['file'] == 'SkeletalSystem100':
            mm = re.match(r'^(.+?)(o|e)(\d*)$', base)
            if mm and re.sub(r'_muscles?$', '', mm.group(1)).lower() in muscle_bases:
                kind = 'origin' if mm.group(2) == 'o' else 'insertion'
                muscle = pretty(re.sub(r'_muscles?$', '', mm.group(1)))
                base = mm.group(1)
        name = pretty(base)
        full = (side.capitalize() + ' ' + name[0].lower() + name[1:]) if side else name
        if kind != 'structure': full = f"{'Origin' if kind == 'origin' else 'Insertion'} of {(side + ' ') if side else ''}{muscle[0].lower() + muscle[1:]}"
        items.append(dict(raw=m['raw'], file=m['file'], base=name, side=side, name=full, kind=kind, muscle=muscle,
                          system='attachment' if kind != 'structure' else system_of(m['file'], name)))

    # Procrustes on paired bones against BodyParts3D
    MP = atlas('models')['parts']
    M = meshes(male_npz)
    bp = {p['name'].lower(): i for i, p in enumerate(MP)}
    def bp_name(it):
        b = it['base'].lower()
        vm = re.match(r'vertebra ([ctl])(\d+)$', b)
        if vm:
            reg = {'c': 'cervical', 't': 'thoracic', 'l': 'lumbar'}[vm.group(1)]; k = int(vm.group(2))
            return {1: 'atlas', 2: 'axis'}.get(k) if reg == 'cervical' and k < 3 else f'{ORD[k-1]} {reg} vertebra'
        return (it['side'] + ' ' + b) if it['side'] else b
    src, dst, who = [], [], []
    for it, (v, f) in zip(items, mesh):
        if it['system'] != 'skeletal' or it['kind'] != 'structure': continue
        j = bp.get(bp_name(it))
        if j is None: continue
        bv = M[j][0]
        if abs(len(v) - len(bv)) > .7 * max(len(v), len(bv)) and len(v) < 50: continue
        # bounding-box centres: robust to remodelled shapes and differing tessellation
        src.append((v.min(0) + v.max(0)) / 2); dst.append((bv.min(0) + bv.max(0)) / 2); who.append(it['name'])
    src, dst, who = np.array(src), np.array(dst), np.array(who)
    keepm = np.ones(len(src), bool)
    for it_ in range(5):  # trimmed Procrustes: drop mismatched / remodelled bones
        sim = procrustes(src[keepm], dst[keepm])
        err = np.linalg.norm(sim(src) - dst, axis=1)
        keepm = err < max(.012, np.percentile(err[keepm], 80) * 1.5)
        print('iteration', it_, 'kept', keepm.sum(), 'median residual mm', round(np.median(err[keepm]) * 1000, 2))
    bad = {}
    for w_, e_ in zip(who, err): bad[w_] = max(bad.get(w_, 0), e_)
    print('worst bones:', sorted(bad.items(), key=lambda x: -x[1])[:8])
    # smooth non-rigid correction on bone-centre pairs (Gaussian RBF, sigma 12 cm)
    a, b = sim(src[keepm]), dst[keepm]
    sig = .12
    G = np.exp(-((a[:, None] - a[None]) ** 2).sum(-1) / (2 * sig * sig))
    W = np.linalg.solve(G + .05 * np.eye(len(a)), b - a)
    def warp(x):
        out = x.copy()
        for k in range(0, len(x), 100000):
            g = np.exp(-((x[k:k + 100000, None] - a[None]) ** 2).sum(-1) / (2 * sig * sig))
            out[k:k + 100000] += g @ W
        return out
    print('after RBF median residual mm', round(np.median(np.linalg.norm(warp(sim(src)) - dst, axis=1)) * 1000, 2))
    vs, fs, keep = [], [], []
    for it, (v, f) in zip(items, mesh):
        w = warp(sim(v))
        # FBX import is un-indexed: weld coincident vertices so surfaces share
        # vertices (smooth normals, smoothing, ~3x less data).
        key = np.round(w / 2e-6).astype(np.int64)
        _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
        w, f = w[first], inv.reshape(-1)[f]
        f = f[(f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])]
        used = np.unique(f); remap = np.full(len(w), -1); remap[used] = np.arange(len(used)); w, f = w[used], remap[f]
        if it['kind'] == 'structure': w = taubin(w, f, 3)
        vs.append(w.astype(np.float32)); fs.append(f.astype(np.uint32)); keep.append(it)
    json.dump({'counts': [[len(v), len(f)] for v, f in zip(vs, fs)]}, open(out + '.json', 'w'))
    json.dump(keep, open(out + '.meta.json', 'w'))
    np.concatenate(vs).tofile(out + '.v.bin'); np.concatenate(fs).tofile(out + '.f.bin')
    from collections import Counter
    print(Counter(i['system'] for i in keep))
    np.savez(out + '_npz.npz', counts=np.array([[len(v), len(f)] for v, f in zip(vs, fs)]), v=np.concatenate(vs), f=np.concatenate(fs))

if __name__ == '__main__':
    main(*sys.argv[1:4])
