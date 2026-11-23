"""Label the skin with dermatomes and store them as a coarse 3D lookup grid.

Rules follow the standard (Keegan & Garrett / ASIA key point) dermatome map,
placed with landmarks of this body: joints from the limb bones, trunk bands
from vertebral levels posteriorly and clavicle / xiphoid / umbilicus /
inguinal landmarks anteriorly, trigeminal divisions on the face. Borders
between neighbouring dermatomes overlap in real people; the map shows the
typical centre of each zone.

Grid: uint8 label per 8 mm cell for cells within 30 mm of the skin
(255 = none). Labels index LEVELS + ['V1', 'V2', 'V3'].

  python3 tools/dermatomes.py <male_smooth.npz> [<female_warp.npz>]
"""
import sys, json, gzip
import numpy as np
from scipy.spatial import cKDTree
from fit_female import meshes
import nerves as N

LABELS = N.LEVELS + ['V1', 'V2', 'V3']
CODE = {l: i for i, l in enumerate(LABELS)}

def label_male():
    V, cen, at, has = N.V, N.cen, N.at, N.has
    skin = V('Skin')
    lab = np.full(len(skin), CODE['T6'], np.uint8)
    model = json.load(open(N.__file__.replace('tools/nerves.py', 'dist/models/nerves.json')))
    lev = {l['id']: np.array(l['foramen']) for l in model['levels']}
    # bone groups for region assignment
    groups = {}
    def grp(name, *parts):
        groups[name] = np.concatenate([V(p)[::4] for p in parts if has(p)])
    grp('head', 'Frontal bone', 'Occipital bone', 'Mandible', 'Left parietal bone', 'Right parietal bone', 'Left temporal bone', 'Right temporal bone', 'Left maxilla', 'Right maxilla', 'Left zygomatic bone', 'Right zygomatic bone', 'Left nasal bone', 'Right nasal bone')
    grp('neck', 'Atlas', 'Axis', 'Third cervical vertebra', 'Fourth cervical vertebra', 'Fifth cervical vertebra', 'Sixth cervical vertebra', 'Hyoid bone', 'Thyroid cartilage')
    for S in ('Left', 'Right'):
        s = S.lower()
        grp(f'{s}:arm', f'{S} humerus')
        grp(f'{s}:fore', f'{S} radius', f'{S} ulna')
        for f in ('thumb', 'index finger', 'middle finger', 'ring finger', 'little finger'):
            grp(f'{s}:{f}', *[f'{p} phalanx of {s} {f}' for p in ('Proximal', 'Middle', 'Distal')])
        grp(f'{s}:hand', *[f'{S} {b}' for b in ('scaphoid', 'lunate', 'triquetral', 'pisiform', 'trapezium', 'trapezoid', 'capitate', 'hamate')],
            *[f'{S} {o} metacarpal bone' for o in ('first', 'second', 'third', 'fourth', 'fifth')])
        grp(f'{s}:thigh', f'{S} femur', f'{S} patella')
        grp(f'{s}:leg', f'{S} tibia', f'{S} fibula')
        grp(f'{s}:foot', *[n for n in N.NAME if (s in n.lower()) and any(k in n.lower() for k in ('toe', 'metatarsal', 'calcaneus', 'talus', 'cuboid', 'cuneiform', 'navicular'))])
    trunk_bones = [n for n in N.NAME if any(k in n.lower() for k in ('rib', 'sternum', 'manubrium', 'thoracic vertebra', 'lumbar vertebra', 'sacrum', 'hip bone', 'clavicle', 'scapula', 'seventh cervical'))]
    grp('trunk', *trunk_bones)
    names = list(groups)
    pts = np.concatenate([groups[n] for n in names]); gid = np.concatenate([np.full(len(groups[n]), i) for i, n in enumerate(names)])
    _, j = cKDTree(pts).query(skin)
    region = np.array(names)[gid[j]]

    up = np.array([0, 1., 0])
    for S, sx in (('Left', 1), ('Right', -1)):
        s = S.lower()
        hv = V(f'{S} humerus'); shoulder = hv[hv[:, 1] > hv[:, 1].max() - .03].mean(0); elbow = hv[hv[:, 1] < hv[:, 1].min() + .03].mean(0)
        rv, uv = V(f'{S} radius'), V(f'{S} ulna')
        wrist_r, wrist_u = rv[rv[:, 1] < rv[:, 1].min() + .02].mean(0), uv[uv[:, 1] < uv[:, 1].min() + .02].mean(0)
        radial = N.unit(wrist_r - wrist_u)
        # upper arm: lateral half C5, medial T1 (distal) / T2 (proximal)
        m = region == f'{s}:arm'
        ax = N.unit(elbow - shoulder); p = skin[m] - shoulder; t = (p @ ax) / np.linalg.norm(elbow - shoulder)
        lat = (p - np.outer(p @ ax, ax)) @ np.array([sx, 0, 0])
        lab[np.where(m)[0]] = np.where(lat > 0, CODE['C5'], np.where(t > .55, CODE['T1'], CODE['T2']))
        # forearm: radial C6, ulnar T1/C8, middle strip C7
        m = region == f'{s}:fore'
        wrist = (wrist_r + wrist_u) / 2; ax = N.unit(wrist - elbow); p = skin[m] - elbow; t = (p @ ax) / np.linalg.norm(wrist - elbow)
        perp = p - np.outer(p @ ax, ax); rd = N.unit(radial - ax * (radial @ ax))
        c = (perp @ rd) / (np.linalg.norm(perp, axis=1) + 1e-9)
        lab[np.where(m)[0]] = np.where(c > .35, CODE['C6'], np.where(c < -.35, np.where(t < .5, CODE['T1'], CODE['C8']), CODE['C7']))
        # fingers and hand
        for f, L in (('thumb', 'C6'), ('index finger', 'C6'), ('middle finger', 'C7'), ('ring finger', 'C8'), ('little finger', 'C8')):
            lab[region == f'{s}:{f}'] = CODE[L]
        m = region == f'{s}:hand'
        mc = (V(f'{S} second metacarpal bone').mean(0) + V(f'{S} fifth metacarpal bone').mean(0)) / 2
        c = (skin[m] - mc) @ rd
        lab[np.where(m)[0]] = np.where(c > .012, CODE['C6'], np.where(c < -.012, CODE['C8'], CODE['C7']))
        # thigh
        fv = V(f'{S} femur'); hipj = fv[fv[:, 1] > fv[:, 1].max() - .03].mean(0); knee = fv[fv[:, 1] < fv[:, 1].min() + .03].mean(0)
        m = region == f'{s}:thigh'
        ax = N.unit(knee - hipj); p = skin[m] - hipj; t = (p @ ax) / np.linalg.norm(knee - hipj)
        perp = p - np.outer(p @ ax, ax); n_ = np.linalg.norm(perp, axis=1) + 1e-9
        ant, med = perp[:, 2] / n_, (perp[:, 0] * -sx) / n_
        L = np.where(ant < -.35, CODE['S2'],                               # posterior thigh
            np.where(med > .45, np.where(t < .45, CODE['L2'], CODE['L3']),  # medial thigh (obturator territory)
            np.where(t < .12, CODE['L1'], np.where(t < .55, CODE['L2'], CODE['L3']))))
        lab[np.where(m)[0]] = L
        # leg
        tv = V(f'{S} tibia'); ktop = tv[tv[:, 1] > tv[:, 1].max() - .03].mean(0); ankle = tv[tv[:, 1] < tv[:, 1].min() + .02].mean(0)
        m = region == f'{s}:leg'
        ax = N.unit(ankle - ktop); p = skin[m] - ktop; t = (p @ ax) / np.linalg.norm(ankle - ktop)
        perp = p - np.outer(p @ ax, ax); n_ = np.linalg.norm(perp, axis=1) + 1e-9
        ant, med = perp[:, 2] / n_, (perp[:, 0] * -sx) / n_
        lab[np.where(m)[0]] = np.where(ant < -.5, np.where(t < .5, CODE['S2'], CODE['S1']),
                               np.where(med > .1, CODE['L4'], CODE['L5']))
        # foot: medial edge L4, dorsum/toes 1-3 L5, lateral/sole/heel S1
        m = region == f'{s}:foot'
        fp = skin[m]; m1 = V(f'{S} first metatarsal bone').mean(0); m5 = V(f'{S} fifth metatarsal bone').mean(0)
        across = N.unit(m5 - m1); c = ((fp - (m1 + m5) / 2) @ across) / (np.linalg.norm(m5 - m1) / 2)
        top = fp[:, 1] - (V(f'{S} talus').mean(0)[1] - .02)
        calc = V(f'{S} calcaneus').mean(0)
        heel = ((fp - calc) @ np.array([0, 0, -1.])) > 0
        lab[np.where(m)[0]] = np.where(heel | (c > .45), CODE['S1'], np.where(c < -.75, CODE['L4'], np.where(top > -.005, CODE['L5'], np.where(c > 0, CODE['S1'], CODE['L5']))))

    # head and neck
    m = region == 'head'
    hp = skin[m]
    orbit_y = (N.cen('Left zygomatic bone')[1] + N.cen('Right zygomatic bone')[1]) / 2 + .012
    mand = V('Mandible'); mouth_y = (V('Left maxilla')[:, 1].min() + V('Right maxilla')[:, 1].min()) / 2 - .003
    ear_z = (N.cen('Left temporal bone')[2] + N.cen('Right temporal bone')[2]) / 2 + .01
    crown_y = hp[:, 1].max()
    face = (hp[:, 2] > ear_z) & (hp[:, 1] < crown_y - .045)
    lab[np.where(m)[0]] = np.where(~face, CODE['C2'], np.where(hp[:, 1] > orbit_y, CODE['V1'], np.where(hp[:, 1] > mouth_y, CODE['V2'], CODE['V3'])))
    under_jaw = m & (skin[:, 1] < mand[:, 1].min() + .01) & (skin[:, 2] < mand[:, 2].max() - .03)
    lab[under_jaw] = CODE['C3']
    m = region == 'neck'
    hy = N.cen('Hyoid bone')[1]
    lab[np.where(m)[0]] = np.where(skin[m][:, 1] > hy - .015, CODE['C3'], CODE['C4'])

    # trunk bands
    m = region == 'trunk'
    tp = skin[m]
    axis_x, axis_z = 0.0, np.mean([lev[l][2] for l in ('T6', 'T10')]) + .06
    theta = np.arctan2(tp[:, 0] - axis_x, tp[:, 2] - axis_z)  # 0 = anterior midline
    w_ant = (1 + np.cos(theta)) / 2
    clav = (V('Left clavicle')[:, 1].max() + V('Right clavicle')[:, 1].max()) / 2
    xiph = V('Body of sternum')[:, 1].min()
    hipv = V('Left hip bone'); crest = hipv[:, 1].max(); pubis = hipv[(hipv @ np.array([0, -.3, 1.])).argmax()][1]
    umb = crest - .01
    nipple = (clav + xiph) / 2 + .01
    ant_y = [clav + .01, clav - .025, nipple, xiph, umb, (umb + pubis) / 2 + .015, pubis + .045, pubis]
    ant_l = [3, 9, 11, 13, 17, 19, 20, 21]          # level index into LEVELS (C4=3, T2=9, T4=11, T6=13, T10=17, T12=19, L1=20, L2=21)
    post_l = list(range(9, 25)); post_y = [lev[LABELS[i]][1] + .015 for i in post_l]
    post_l = [3] + post_l; post_y = [clav + .03] + post_y
    li_ant = np.interp(-tp[:, 1], -np.array(ant_y), ant_l)
    li_post = np.interp(-tp[:, 1], -np.array(post_y), post_l)
    li = np.round(w_ant * li_ant + (1 - w_ant) * li_post).astype(int)
    li = np.clip(li, 3, 24)
    # buttocks / perineum
    anus = N.cen('External anal sphincter')
    d_anus = np.linalg.norm(tp - anus, axis=1)
    sac_low = V('Sacrum')[:, 1].min()
    butt = (tp[:, 1] < crest - .03) & (w_ant < .35)
    li = np.where(butt, np.where(np.abs(tp[:, 0]) < .06, CODE['S3'], CODE['L2']), li)
    li = np.where(d_anus < .035, CODE['S5'], np.where(d_anus < .07, CODE['S4'], li))
    li = np.where((tp[:, 1] < sac_low + .02) & (np.abs(tp[:, 0]) < .025) & (w_ant < .3) & (d_anus >= .07), CODE['Co1'], li)
    lab[np.where(m)[0]] = li
    return skin, lab

def grid(points, labels, cell=.008, reach=.03):
    lo = points.min(0) - reach; hi = points.max(0) + reach
    dims = np.ceil((hi - lo) / cell).astype(int)
    g = np.stack(np.meshgrid(*[lo[k] + (np.arange(dims[k]) + .5) * cell for k in range(3)], indexing='ij'), -1).reshape(-1, 3)
    d, j = cKDTree(points).query(g, distance_upper_bound=reach)
    out = np.full(len(g), 255, np.uint8)
    ok = np.isfinite(d)
    out[ok] = labels[j[ok]]
    return dict(origin=np.round(lo, 5).tolist(), cell=cell, dims=dims.tolist(), labels=LABELS), out.reshape(dims).transpose(2, 1, 0).copy()  # z-major

def save(meta, data, folder):
    meta['order'] = 'z,y,x (x fastest)'
    json.dump(meta, open(f'{folder}/dermatomes.json', 'w'))
    open(f'{folder}/dermatomes.bin', 'wb').write(data.tobytes())

if __name__ == '__main__':
    N.M = meshes(sys.argv[1])
    skin, lab = label_male()
    root = N.__file__.replace('tools/nerves.py', 'dist')
    save(*grid(skin, lab), root + '/models')
    print('male dermatome grid written', np.bincount(lab, minlength=len(LABELS)))
    if len(sys.argv) > 2:
        from warp import load_warp
        fs = load_warp(sys.argv[2])(skin)
        save(*grid(fs, lab), root + '/female')
        print('female dermatome grid written')
