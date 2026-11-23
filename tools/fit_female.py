"""Stage 2: fit the male BodyParts3D musculoskeletal anatomy into the female
Human Reference Atlas body, which has organs, spine, pelvis and legs but no
arm/hand/foot/skull bones and almost no muscles.

The warp is:
  1. Procrustes similarity from paired bones (vertebrae, sacrum, pelvis, femur,
     tibia, fibula, patella).
  2. Articulated arms: upper arm rotated about the shoulder, forearm+hand about
     the elbow, angles found by chamfer search against the female skin (her
     arms are abducted ~35 deg, his hang at his sides). Blended per vertex
     with soft nearest-bone weights (linear blend skinning).
  3. Non-rigid refinement: iterative closest-point correspondences from male
     skin->female skin and paired bones->bones, regularised with a Gaussian
     RBF displacement field at decreasing radius.

The fitted structures are approximate: male anatomy reshaped to a female
envelope, not female-specific data. Output: warp parameters (reused for the
nerve model) and the fitted meshes.

  python3 tools/fit_female.py <male_smooth.npz> <female_smooth.npz> <out dir>
"""
import re, sys, json
import numpy as np
from scipy.spatial import cKDTree
from sources import atlas

def meshes(npz):
    d = np.load(npz)
    out, vo, fo = [], 0, 0
    for nv, nf in d['counts']:
        out.append((d['v'][vo:vo + nv].astype(np.float64), d['f'][fo:fo + nf].astype(np.int64)))
        vo += nv; fo += nf
    return out

MP, FP = atlas('models')['parts'], atlas('female')['parts']

def find(parts, pattern):
    r = re.compile(pattern, re.I)
    return [i for i, p in enumerate(parts) if r.fullmatch(p['name'])]

ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth']
def bone_pairs():
    pairs = [(find(MP, 'Atlas'), find(FP, 'Cervical vertebra 1')), (find(MP, 'Axis'), find(FP, 'Cervical vertebra 2'))]
    for k in range(3, 8): pairs.append((find(MP, ORD[k - 1] + ' cervical vertebra'), find(FP, f'Cervical vertebra {k}')))
    for k in range(1, 13): pairs.append((find(MP, ORD[k - 1] + ' thoracic vertebra'), find(FP, f'Thoracic vertebra {k}')))
    for k in range(1, 6): pairs.append((find(MP, ORD[k - 1] + ' lumbar vertebra'), find(FP, f'Lumbar vertebra {k}')))
    pairs.append((find(MP, 'Sacrum'), find(FP, 'Sacrum')))
    for side in ('Left', 'Right'):
        pairs.append((find(MP, side + ' hip bone'), find(FP, side + ' (ilium|ischium|pubis) compact bone')))
        for b in ('femur', 'tibia', 'fibula', 'patella'):
            pairs.append((find(MP, side + ' ' + b), find(FP, side + ' ' + b)))
    return [(a, b) for a, b in pairs if a and b]

def sample(ms, ids, n, rng):
    v = np.concatenate([ms[i][0] for i in ids])
    return v[rng.choice(len(v), min(n, len(v)), replace=False)]

def procrustes(a, b):
    ca, cb = a.mean(0), b.mean(0)
    A, B = a - ca, b - cb
    u, s, vt = np.linalg.svd(A.T @ B)
    d = np.sign(np.linalg.det(u @ vt))
    D = np.diag([1, 1, d]); R = (u @ D @ vt).T
    scale = (s * np.diag(D)).sum() / (A ** 2).sum()
    return lambda x: (x - ca) @ R.T * scale + cb

def rot(axis, ang):
    axis = axis / np.linalg.norm(axis); k = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(ang) * k + (1 - np.cos(ang)) * k @ k

class Warp:
    """Composable warp; apply() on any (n,3) array of male coordinates."""
    def __init__(self): self.steps = []
    def apply(self, x):
        for s in self.steps: x = s(x)
        return x

def main(male_npz, female_npz, out_dir):
    rng = np.random.default_rng(7)
    M, F = meshes(male_npz), meshes(female_npz)
    warp = Warp()
    pairs = bone_pairs()
    print('paired bones', len(pairs))

    # 1. similarity from per-bone centroids and principal extremes
    src, dst = [], []
    for a, b in pairs:
        va = np.concatenate([M[i][0] for i in a]); vb = np.concatenate([F[i][0] for i in b])
        src.append(va.mean(0)); dst.append(vb.mean(0))
        for k in range(3):
            src.append(va[va[:, k].argmin()]); dst.append(vb[vb[:, k].argmin()])
            src.append(va[va[:, k].argmax()]); dst.append(vb[vb[:, k].argmax()])
    sim = procrustes(np.array(src), np.array(dst))
    warp.steps.append(sim)

    skin_m = sim(M[find(MP, 'Skin')[0]][0]); skin_f = F[find(FP, 'Skin')[0]][0]
    tree_f = cKDTree(skin_f)

    # 2. articulated arms
    groups = {}
    for side, sx in (('left', 1), ('right', -1)):
        S = side.capitalize()
        hum = find(MP, S + ' humerus')
        fore = find(MP, f'{S} (radius|ulna|scaphoid|lunate|triquetral|pisiform|trapezium|trapezoid|capitate|hamate|\\w+ metacarpal bone)') + \
               find(MP, f'(proximal|middle|distal) phalanx of {side} (thumb|index finger|middle finger|ring finger|little finger)')
        hv = sim(np.concatenate([M[i][0] for i in hum]))
        fv = sim(np.concatenate([M[i][0] for i in fore]))
        axis_h = hv[hv[:, 1].argsort()]
        shoulder = axis_h[-len(hv) // 12:].mean(0)  # humeral head
        elbow = axis_h[:len(hv) // 15].mean(0)      # distal humerus
        groups[side] = dict(hum=hum, fore=fore, shoulder=shoulder, elbow=elbow, hv=hv, fv=fv, sx=sx)

    # soft nearest-bone weights: torso / upper arm / forearm per side
    bone_ids = [i for i, p in enumerate(MP) if p['system'] == 'skeletal']
    label = {}
    for side, g in groups.items():
        for i in g['hum']: label[i] = side + ':upper'
        for i in g['fore']: label[i] = side + ':fore'
    pts, lab = [], []
    names = ['torso', 'left:upper', 'left:fore', 'right:upper', 'right:fore']
    for i in bone_ids:
        v = sim(M[i][0]); k = max(1, len(v) // 40)
        pts.append(v[::k]); lab.append(np.full(len(v[::k]), names.index(label.get(i, 'torso'))))
    bone_pts, bone_lab = np.concatenate(pts), np.concatenate(lab)
    bone_tree = cKDTree(bone_pts)

    def weights(x, sigma=.018):
        d, j = bone_tree.query(x, k=24)
        w = np.zeros((len(x), len(names)))
        for g in range(len(names)):
            dg = np.where(bone_lab[j] == g, d, np.inf).min(1)
            w[:, g] = np.exp(-(dg ** 2) / (2 * sigma ** 2))
        w[w.sum(1) == 0, 0] = 1
        return w / w.sum(1, keepdims=True)

    # chamfer search of arm angles
    wskin = weights(skin_m)
    transforms = {n: (np.eye(3), np.zeros(3)) for n in names}
    def arm_points(side):
        a = (wskin[:, names.index(side + ':upper')] + wskin[:, names.index(side + ':fore')]) > .6
        return skin_m[a]
    def cost(p): return tree_f.query(p)[0].mean()
    for side, g in groups.items():
        arm = arm_points(side)
        wa = weights(arm)
        upper_w, fore_w = wa[:, names.index(side + ':upper')], wa[:, names.index(side + ':fore')]
        sh, el = g['shoulder'], g['elbow']
        best = (1e9, None)
        # abduction (about z) and flexion (about x) at the shoulder
        for ab in np.radians(np.arange(0, 61, 3)):
            for fl in np.radians(np.arange(-15, 16, 5)):
                R = rot(np.array([0, 0, g['sx']]), ab) @ rot(np.array([1, 0, 0]), fl)
                moved = (arm - sh) @ R.T + sh
                c = cost(moved)
                if c < best[0]: best = (c, R)
        Ru = best[1]
        el2 = (el - sh) @ Ru.T + sh
        best2 = (1e9, np.eye(3))
        for ab in np.radians(np.arange(-20, 21, 4)):
            for fl in np.radians(np.arange(-20, 21, 5)):
                R2 = rot(np.array([0, 0, g['sx']]), ab) @ rot(np.array([1, 0, 0]), fl)
                Rf = R2 @ Ru
                up = (arm - sh) @ Ru.T + sh
                fo = (arm - el) @ Rf.T + el2
                moved = up * (1 - fore_w[:, None]) + fo * fore_w[:, None]
                c = cost(moved[fore_w > .5])
                if c < best2[0]: best2 = (c, R2)
        Rf = best2[1] @ Ru
        transforms[side + ':upper'] = (Ru, sh - sh @ Ru.T)
        transforms[side + ':fore'] = (Rf, el2 - el @ Rf.T)
        print(side, 'arm chamfer', round(best[0] * 1000, 1), 'mm ->', round(best2[0] * 1000, 1), 'mm')

    def lbs(x):
        w = weights(x)
        out = np.zeros_like(x)
        for g, n in enumerate(names):
            R, t = transforms[n]
            out += w[:, g:g + 1] * (x @ R.T + t)
        return out
    warp.steps.append(lbs)

    # 3. non-rigid ICP with Gaussian RBF displacement fields
    skin_s = skin_m[rng.choice(len(skin_m), 6000, replace=False)]
    skin_fs = skin_f[rng.choice(len(skin_f), 9000, replace=False)]
    bone_src = [(sample(M, a, 600, rng), sample(F, b, 1500, rng)) for a, b in pairs]
    src0 = lbs(np.concatenate([skin_s] + [sim(s) for s, _ in bone_src]))
    n_skin = len(skin_s)
    bounds = np.cumsum([n_skin] + [len(s) for s, _ in bone_src])
    fields = []
    def gauss(x, c, sig):
        x = x.astype(np.float32); c = c.astype(np.float32)
        d2 = (x * x).sum(1)[:, None] + (c * c).sum(1)[None] - 2 * x @ c.T
        return np.exp(-np.maximum(d2, 0) / np.float32(2 * sig * sig))
    def field_apply(x, fl):
        c, W, sig = fl
        out = x.copy()
        for k in range(0, len(x), 50000):
            out[k:k + 50000] += gauss(x[k:k + 50000], c, sig) @ W.astype(np.float32)
        return out
    cur = src0.copy()
    tree_skin_f = cKDTree(skin_fs)
    for sigma, lam in ((.12, 1.0), (.07, .5), (.045, .3), (.03, .2)):
        for it in range(2):
            tgt = np.empty_like(cur)
            tgt[:n_skin] = skin_fs[tree_skin_f.query(cur[:n_skin])[1]]
            # reverse correspondences: female skin points pull nearest male point
            rev = cKDTree(cur[:n_skin]).query(skin_fs)[1]
            pull = np.zeros((n_skin, 3)); cnt = np.zeros(n_skin)
            np.add.at(pull, rev, skin_fs - cur[rev]); np.add.at(cnt, rev, 1)
            disp_skin = .5 * (tgt[:n_skin] - cur[:n_skin]) + .5 * np.where(cnt[:, None] > 0, pull / np.maximum(cnt, 1)[:, None], tgt[:n_skin] - cur[:n_skin])
            disp = np.empty_like(cur); disp[:n_skin] = disp_skin
            for k, (_, fb) in enumerate(bone_src):
                a, b = bounds[k], bounds[k + 1]
                disp[a:b] = fb[cKDTree(fb).query(cur[a:b])[1]] - cur[a:b]
            # bones are trusted more than skin (weight via duplication-free scaling)
            wts = np.ones(len(cur)); wts[n_skin:] = 3.0
            ctr_idx = rng.choice(len(cur), 2500, replace=False)
            c = cur[ctr_idx]
            G = gauss(cur, c, sigma).astype(np.float64)
            A = (G * wts[:, None]).T @ G + lam * np.eye(len(c)) * len(cur) / len(c) * .02
            W = np.linalg.solve(A, (G * wts[:, None]).T @ disp)
            fl = (c, W, sigma)
            fields.append(fl)
            cur = field_apply(cur, fl)
            print('sigma', sigma, 'skin err', round(tree_skin_f.query(cur[:n_skin])[0].mean() * 1000, 2), 'mm',
                  'bone err', round(np.mean([cKDTree(fb).query(cur[bounds[k]:bounds[k + 1]])[0].mean() for k, (_, fb) in enumerate(bone_src)]) * 1000, 2), 'mm', flush=True)
    for fl in fields:
        warp.steps.append(lambda x, fl=fl: field_apply(x, fl))

    # save warp parameters for reuse (nerve model)
    np.savez(out_dir + '/female_warp.npz', sim_src=np.array(src), sim_dst=np.array(dst),
             bone_pts=bone_pts, bone_lab=bone_lab,
             transforms=np.array([np.concatenate([transforms[n][0].ravel(), transforms[n][1]]) for n in names]),
             field_c=np.array([f[0] for f in fields], dtype=object), field_w=np.array([f[1] for f in fields], dtype=object),
             field_s=np.array([f[2] for f in fields]), allow_pickle=True)

    # 4. choose and warp male structures that the female model lacks
    fnames = {p['name'].lower() for p in FP}
    eye = re.compile(r'cornea|iris|lens|sclera|choroid|retina|vitreous|anterior chamber|corona ciliaris|optic|eyeball|ciliary', re.I)
    skip_bone = re.compile(r'vertebra|atlas$|axis$|sacrum|coccyx|hip bone|femur|tibia\b|fibula\b|patella|menisc|cruciate|collateral ligament|patellar ligament|intervertebral|^skin$', re.I)
    chosen = []
    for i, p in enumerate(MP):
        n, s = p['name'], p['system']
        if s in ('reproductive', 'urinary', 'digestive', 'respiratory', 'cardiac', 'lymphatic', 'integumentary'): continue
        if s == 'nervous' and not re.search('nerve|ganglion', n, re.I): continue
        if s == 'nervous' and re.search('optic', n, re.I): continue
        if s == 'sensory' and (eye.search(n) or 'plexus' in n.lower()): continue
        if s == 'skeletal' and skip_bone.search(n) and 'disk' not in n.lower(): continue
        if s == 'muscular' and re.search('rectus femoris|extraocular|cremaster|(superior|inferior|medial|lateral) rectus|(superior|inferior) oblique$', n, re.I): continue
        if s in ('arterial', 'venous') and (n.lower() in fnames or re.search('testic|spermatic|pampiniform', n, re.I)): continue
        if n.lower() in fnames: continue
        chosen.append(i)
    print('transferring', len(chosen), 'male structures')
    vs, fs, meta = [], [], []
    allv = np.concatenate([M[i][0] for i in chosen])
    allw = warp.apply(allv)
    o = 0
    for i in chosen:
        nv = len(M[i][0])
        vs.append(allw[o:o + nv].astype(np.float32)); fs.append(M[i][1].astype(np.uint32)); o += nv
        p = MP[i]
        meta.append({'name': p['name'], 'system': p['system'], 'conceptId': p.get('conceptId'), 'fittedFrom': p['id']})
    np.savez(out_dir + '/female_fitted.npz', counts=np.array([[len(v), len(f)] for v, f in zip(vs, fs)]), v=np.concatenate(vs), f=np.concatenate(fs))
    json.dump(meta, open(out_dir + '/female_fitted.json', 'w'))
    # preview
    import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
    fig, ax = plt.subplots(1, 2, figsize=(12, 9))
    sk = skin_f[::9]
    bones = np.concatenate([v for v, m in zip(vs, meta) if m['system'] == 'skeletal'])[::5]
    for a, (i, j) in zip(ax, ((0, 1), (2, 1))):
        a.scatter(sk[:, i], sk[:, j], s=.05, c='#d9a'); a.scatter(bones[:, i], bones[:, j], s=.05, c='k'); a.set_aspect('equal')
    plt.savefig(out_dir + '/female_fit.png', dpi=70)

if __name__ == '__main__':
    main(*sys.argv[1:4])
