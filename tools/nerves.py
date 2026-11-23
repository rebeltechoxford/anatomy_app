"""Generate the modeled nervous-system wiring for the viewer.

BodyParts3D has the brain and a few orbital nerves but no spinal cord, spinal
roots or limb nerves; the HRA female model has cord segments but no peripheral
nerves. This script builds a teaching model of them from the male skeleton,
muscles and arteries:

  * spinal canal centreline (from each vertebra's foramen) and cord with
    segment levels C1..Co1 placed at their textbook vertebral levels
  * 31 pairs of dorsal/ventral roots exiting their intervertebral (or sacral)
    foramina, spinal nerves, dorsal rami
  * cervical, brachial, lumbar and sacral plexuses, intercostal nerves and the
    named peripheral nerves routed along real landmarks (bone surfaces, artery
    centrelines, muscle compartments)
  * a branch from each nerve into every muscle it innervates
  * selected cranial nerves (V, VI, VII, X, XI, XII, III/IV to orbit)

Routes are anatomically reasoned approximations for study, not traced from a
specific body. For the female body, the male model is carried over with the
warp from fit_female.py.

  python3 tools/nerves.py <male_smooth.npz> <out.json> [<female_warp.npz> <female out.json>]
"""
import sys, json, re
import numpy as np
from sources import atlas
from fit_female import meshes

MP = atlas('models')['parts']
NAME = {}
for i, p in enumerate(MP): NAME.setdefault(p['name'], []).append(i)
M = None
ANT, POST, UP, DOWN = np.array([0, 0, 1.]), np.array([0, 0, -1.]), np.array([0, 1., 0]), np.array([0, -1., 0])

def V(*names):
    out = [M[i][0] for n in names for i in NAME.get(n, [])]
    if not out: raise KeyError(names)
    return np.concatenate(out)
def has(n): return n in NAME
def cen(n): return V(n).mean(0)
def unit(v): v = np.asarray(v, float); return v / (np.linalg.norm(v) or 1)

def axis(n):
    v = V(n); c = v.mean(0)
    w, e = np.linalg.eigh(np.cov((v - c).T)); d = e[:, -1]
    if d[1] > 0: d = -d  # proximal (top) -> distal
    t = (v - c) @ d
    return v, c, d, t.min(), t.max()

def at(n, t, d=None, off=0.0, width=.04):
    """Point on bone/muscle n at fraction t (0 proximal..1 distal). With a
    direction, the extreme surface point that way, pushed `off` metres out."""
    v, c, ax, a, b = axis(n)
    s = ((v - c) @ ax - a) / (b - a)
    slab = v[np.abs(s - t) < width]
    if len(slab) < 3: slab = v[np.argsort(np.abs(s - t))[:20]]
    if d is None: return slab.mean(0)
    d = unit(d)
    return slab[(slab @ d).argmax()] + d * off

def extreme(n, d, off=0.0):
    v = V(n); d = unit(d); return v[(v @ d).argmax()] + d * off

def centerline(n, k=14):
    v, c, ax, a, b = axis(n)
    t = (v - c) @ ax
    edges = np.linspace(a, b, k + 1)
    pts = [v[(t >= edges[i]) & (t <= edges[i + 1])].mean(0) for i in range(k) if ((t >= edges[i]) & (t <= edges[i + 1])).sum() > 2]
    return np.array(pts)

def closest(n, p):
    v = V(n); return v[((v - p) ** 2).sum(1).argmin()]

def resample(pts, step=.006):
    """Catmull-Rom smooth a waypoint list and resample at ~step spacing."""
    p = np.array(pts, float)
    keep = [0] + [i for i in range(1, len(p)) if np.linalg.norm(p[i] - p[i - 1]) > 1e-4]
    p = p[keep]
    if len(p) < 2: return p
    ext = np.vstack([2 * p[0] - p[1], p, 2 * p[-1] - p[-2]])
    out = []
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1:i + 3]
        n = max(2, int(np.linalg.norm(p2 - p1) / step))
        for s in np.linspace(0, 1, n, endpoint=False):
            s2, s3 = s * s, s * s * s
            out.append(.5 * ((2 * p1) + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 + (-p0 + 3 * p1 - 3 * p2 + p3) * s3))
    out.append(p[-1])
    return np.array(out)

ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth']
VERTS = ['Atlas', 'Axis'] + [f'{ORD[k]} cervical vertebra'.capitalize() for k in range(2, 7)] + \
        [f'{ORD[k]} thoracic vertebra'.capitalize() for k in range(12)] + [f'{ORD[k]} lumbar vertebra'.capitalize() for k in range(5)]
VLABEL = [f'C{k}' for k in range(1, 8)] + [f'T{k}' for k in range(1, 13)] + [f'L{k}' for k in range(1, 6)]
LEVELS = [f'C{k}' for k in range(1, 9)] + [f'T{k}' for k in range(1, 13)] + [f'L{k}' for k in range(1, 6)] + [f'S{k}' for k in range(1, 6)] + ['Co1']
# Cord segment position as a vertebral index (C1 vertebra = 1 ... L5 = 24, sacrum top = 25)
SEGPOS = dict(zip(LEVELS, [1.0, 1.9, 2.7, 3.5, 4.3, 5.1, 5.9, 6.7, 7.5, 8.3, 9.1, 9.9, 10.7, 11.5, 12.3, 13.1, 13.9, 14.7, 15.5, 16.3,
                            17.0, 17.6, 18.1, 18.6, 19.0, 19.4, 19.7, 19.95, 20.15, 20.3, 20.45]))

# ---------------------------------------------------------------- level facts
DERM = {
 'C1': 'No consistent dermatome (C1 is usually motor only).', 'C2': 'Back of the scalp (occiput), angle of jaw region.',
 'C3': 'Upper neck, below the occiput and jaw.', 'C4': 'Lower neck and a cape over the top of the shoulders and clavicles.',
 'C5': 'Lateral (outer) upper arm over the deltoid; lateral elbow.', 'C6': 'Lateral forearm, thumb and radial side of index finger.',
 'C7': 'Middle finger and the middle strip of the back of the forearm/hand.', 'C8': 'Ring and little fingers, ulnar side of hand and lower medial forearm.',
 'T1': 'Medial forearm and medial elbow.', 'T2': 'Medial upper arm, axilla, upper chest below clavicle.', 'T3': 'Upper chest band.',
 'T4': 'Chest band at the nipple line.', 'T5': 'Chest band below the nipples.', 'T6': 'Band at the xiphoid process.', 'T7': 'Band at the lower costal margin.',
 'T8': 'Upper abdominal band.', 'T9': 'Abdominal band above the umbilicus.', 'T10': 'Band at the umbilicus.', 'T11': 'Lower abdominal band.',
 'T12': 'Band just above the inguinal ligament and pubis.', 'L1': 'Groin, inguinal region and upper anterior thigh.',
 'L2': 'Anterior and medial thigh, upper half.', 'L3': 'Lower anterior thigh and medial knee.', 'L4': 'Medial leg, medial ankle (malleolus) and medial foot/big toe edge.',
 'L5': 'Lateral leg, dorsum of foot and toes 1-3 (first web space).', 'S1': 'Lateral foot, little toe, heel and lateral sole; lower posterior calf.',
 'S2': 'Posterior thigh and popliteal fossa, upper posterior calf.', 'S3': 'Medial buttock and upper inner thigh (saddle).',
 'S4': 'Perineum (saddle area).', 'S5': 'Skin immediately around the anus.', 'Co1': 'Small area over the coccyx.'}
MYO = {
 'C1': 'Small suboccipital muscles; with C2 forms ansa cervicalis (infrahyoids).', 'C2': 'Neck flexion (longus capitis), ansa cervicalis.',
 'C3': 'Lateral neck flexion; diaphragm (phrenic C3-C5).', 'C4': 'Shoulder elevation (trapezius, levator scapulae); diaphragm.',
 'C5': 'Shoulder abduction (deltoid, supraspinatus), elbow flexion (biceps); diaphragm.', 'C6': 'Elbow flexion, wrist extension (extensor carpi radialis).',
 'C7': 'Elbow extension (triceps), wrist flexion, finger extension.', 'C8': 'Finger flexion (FDP, FDS), thumb extension.',
 'T1': 'Finger abduction/adduction (interossei), hand intrinsics.', 'T2': 'Intercostals T2; sympathetic outflow to head (T1-T2).',
 'T6': 'Intercostals; upper abdominal wall begins (T6-T12).', 'T10': 'Abdominal wall (rectus, obliques) around umbilicus.',
 'T12': 'Lower abdominal wall, quadratus lumborum.', 'L1': 'Hip flexion (iliopsoas), lowest abdominal muscles.',
 'L2': 'Hip flexion (iliopsoas), hip adduction.', 'L3': 'Knee extension (quadriceps), hip adduction.', 'L4': 'Ankle dorsiflexion (tibialis anterior), knee extension.',
 'L5': 'Big-toe extension (extensor hallucis longus), hip abduction (gluteus medius).', 'S1': 'Ankle plantarflexion (gastrocnemius/soleus), hip extension (gluteus maximus), foot eversion.',
 'S2': 'Toe flexion, plantar intrinsics; parasympathetic bladder (S2-S4).', 'S3': 'Pelvic floor; parasympathetic to bladder/rectum.',
 'S4': 'Pelvic floor and external anal sphincter (pudendal S2-S4).', 'S5': 'Coccygeus region.', 'Co1': 'Coccygeus.'}
for k in range(3, 12): MYO.setdefault(f'T{k}', f'Intercostal muscles of space {k}' + ('; abdominal wall' if k >= 7 else '') + '.')
REFLEX = {'C5': 'Biceps reflex (C5-C6)', 'C6': 'Brachioradialis reflex (C5-C6)', 'C7': 'Triceps reflex (C7-C8)',
          'L3': 'Patellar (knee-jerk) reflex (L3-L4)', 'L4': 'Patellar reflex (L3-L4)', 'S1': 'Achilles (ankle-jerk) reflex (S1-S2)',
          'T10': 'Abdominal reflexes (T8-T12)', 'S3': 'Bulbocavernosus / anal wink (S2-S4)', 'S4': 'Anal wink (S2-S4)'}
PLEX = {**{f'C{k}': 'Cervical plexus' for k in range(1, 5)}, **{f'C{k}': 'Brachial plexus' for k in range(5, 9)}, 'T1': 'Brachial plexus',
        **{f'T{k}': 'Intercostal (no plexus)' for k in range(2, 12)}, 'T12': 'Subcostal / lumbar plexus', **{f'L{k}': 'Lumbar plexus' for k in range(1, 4)},
        'L4': 'Lumbar and sacral plexus (lumbosacral trunk)', 'L5': 'Sacral plexus (lumbosacral trunk)', **{f'S{k}': 'Sacral plexus' for k in range(1, 5)},
        'S5': 'Coccygeal plexus', 'Co1': 'Coccygeal plexus'}

def cerv(L): return L[0] == 'C' and L != 'Co1'

def exit_text(L):
    if L == 'C1': return 'Exits between the occipital bone and the atlas (C1), above the C1 vertebra.'
    if L == 'C8': return 'Exits between the C7 and T1 vertebrae (there is no C8 vertebra).'
    if cerv(L): n = int(L[1:]); return f'Exits above the {L} vertebra, through the foramen between C{n-1} and {L}.'
    if L[0] in 'TL':
        nxt = {'T12': 'L1', 'L5': 'the sacrum (S1)'}.get(L, L[0] + str(int(L[1:]) + 1))
        return f'Exits below the {L} vertebra, through the intervertebral foramen between {L} and {nxt}.'
    if L in ('S1', 'S2', 'S3', 'S4'): return f'Ventral ramus exits the {L} anterior sacral foramen (dorsal ramus via the posterior foramen).'
    return 'Exits through the sacral hiatus below the sacrum.'

# ---------------------------------------------------------------- build
def build():
    nerves = []
    def add(id, name, path, kind, segs, side=None, parent=None, r=.0018, targets=(), skin='', fibers='mixed', diam=12, step=.006):
        p = resample(path, step)
        if side:
            S_, s_ = side.capitalize(), side
            targets = [t.replace('{S}', S_).replace('{s}', s_) for t in targets]
        nerves.append(dict(id=id, name=name, side=side, kind=kind, segments=list(segs), parent=parent, r=r,
                           targets=list(targets), skin=skin, fibers=fibers, diameter=diam, path=np.round(p, 4).tolist()))
        return p

    # spinal canal
    centers = []
    for n in VERTS:
        v = V(n); c = v.mean(0)
        slab = v[np.abs(v[:, 1] - c[1]) < .006][:, [0, 2]]
        best, bz = -1, c[2]
        for z in np.linspace(v[:, 2].min(), v[:, 2].max(), 80):
            d = np.sqrt(((slab - [c[0], z]) ** 2).sum(1)).min()
            behind = (slab[:, 1] < z - .004).sum() > 5 and (slab[:, 1] > z + .004).sum() > 5
            if behind and d > best: best, bz = d, z
        centers.append(np.array([c[0], c[1], bz]))
    centers = np.array(centers)
    sac = V('Sacrum')
    sac_top = sac[sac[:, 1] > sac[:, 1].max() - .02]
    s1_center = np.array([sac_top[:, 0].mean(), sac_top[:, 1].mean() - .005, centers[-1][2] - .005])
    canal = np.vstack([centers, s1_center])
    med = V('Medulla oblongata'); top = med[med[:, 1] < med[:, 1].min() + .01].mean(0)

    def canal_at(index):
        """Canal point at vertebral index (1 = C1 ... 25 = sacrum top)."""
        k = np.clip(index - 1, 0, len(canal) - 1.001); i = int(k); f = k - i
        return canal[i] * (1 - f) + canal[min(i + 1, len(canal) - 1)] * f

    seg_pt = {L: canal_at(SEGPOS[L]) for L in LEVELS}
    cord_path = resample([top] + [seg_pt[L] for L in LEVELS[::3]] + [seg_pt['Co1'], canal_at(21.3)], .004)
    filum = resample([canal_at(21.3), canal_at(24), s1_center + DOWN * .04], .006)

    # foramina
    def vcenter(label):
        return centers[VLABEL.index(label)] if label in VLABEL else s1_center
    sx_of = {'left': 1, 'right': -1}
    foramen, sacral = {}, {}
    ant_sac = sac[sac[:, 2] > np.percentile(sac[:, 2], 70)]
    for i, L in enumerate(LEVELS):
        if L == 'C1': a, b = vcenter('C1') + UP * .014, vcenter('C1')
        elif L == 'C8': a, b = vcenter('C7'), vcenter('T1')
        elif cerv(L): n = int(L[1:]); a, b = vcenter(f'C{n-1}'), vcenter(L)
        elif L[0] in 'TL':
            a = vcenter(L); nxt = {'T12': 'L1', 'L5': 'S'}.get(L, L[0] + str(int(L[1:]) + 1)); b = vcenter(nxt)
        else:
            k = LEVELS.index(L) - LEVELS.index('S1')
            y = sac[:, 1].max() - .025 - k * .022
            band = ant_sac[np.abs(ant_sac[:, 1] - y) < .006]
            if not len(band): band = sac[np.argsort(np.abs(sac[:, 1] - y))[:30]]
            sacral[L] = (band[:, 1].mean(), band[:, 2].max())
            a = b = np.array([0, band[:, 1].mean(), band[:, 2].max() - .006])
        foramen[L] = (a + b) / 2
    width = lambda L: .016 if cerv(L) else .015 if L[0] == 'T' else .021 if L[0] == 'L' else .03 - .004 * min(4, LEVELS.index(L) - LEVELS.index('S1'))

    rami = {}
    for side, sx in sx_of.items():
        LAT = np.array([sx, 0, 0.])
        for L in LEVELS:
            F = foramen[L] + LAT * width(L) + ANT * (.004 if (cerv(L) or L[0] in 'TL') else 0)
            s = seg_pt[L]
            inner = foramen[L] + LAT * .006
            for kind, dz, nm, fib in (('ventral', .003, 'Ventral (motor) root', 'motor'), ('dorsal', -.003, 'Dorsal (sensory) root', 'sensory')):
                start = s + LAT * .004 + ANT * dz
                path = [start, start + LAT * .002 + DOWN * .004]
                if inner[1] < start[1] - .012:  # long descending roots (cauda equina below the conus)
                    path += [np.array([inner[0], start[1] - .015, s[2] + dz]), np.array([inner[0], inner[1] + .012, inner[2] + dz])]
                path += [inner + ANT * dz * .6, F]
                add(f'{side}-{L}-{kind}', f'{side.capitalize()} {L} {nm.lower()}' + (' (dorsal root ganglion near the foramen)' if kind == 'dorsal' else ''),
                    path, 'root', [L], side, r=.0009 if (L[0] == 'S' or cerv(L)) and L != 'C1' else .0008, fibers=fib, diam=12, step=.004)
            R = F + LAT * .012 + ANT * .004
            add(f'{side}-{L}-spinal', f'{side.capitalize()} {L} spinal nerve', [F, R], 'spinal', [L], side, r=.0015, step=.003)
            add(f'{side}-{L}-dorsal-ramus', f'{side.capitalize()} {L} dorsal ramus', [R, R + POST * .03 + LAT * .006 + DOWN * .006, R + POST * .045 + LAT * .02 + DOWN * .012],
                'ramus', [L], side, r=.0008, skin='Skin and deep muscles of the back near the midline at this level.', targets=[r'(erector|iliocostalis|longissimus|spinalis|multifidus|rotator|semispinalis|interspinal|levatores).*'] if (cerv(L) or L[0] in 'TL') else [])
            rami[(side, L)] = R

    def ramus(side, L): return rami[(side, L)]

    for side, sx in sx_of.items():
        S = side.capitalize(); s = side
        LAT, MED = np.array([sx, 0, 0.]), np.array([-sx, 0, 0.])
        def sided(n): return n.replace('{S}', S).replace('{s}', s)
        def A(n, *a, **k): return at(sided(n), *a, **k)
        def C(n): return cen(sided(n))
        def CL(n, rev=False):
            c = centerline(sided(n)); return c[::-1] if rev else c
        hand_palm = unit(cen(f'Flexor retinaculum of {s} wrist') - V(*[f'{S} {b}' for b in ('scaphoid', 'lunate', 'capitate', 'hamate')]).mean(0))
        DORS = -hand_palm

        # ---------------- cervical plexus
        scm = C('{S} sternocleidomastoid') if has(f'{S} sternocleidomastoid') else ramus(s, 'C3') + LAT * .04 + ANT * .03
        cp = (ramus(s, 'C2') + ramus(s, 'C3') + ramus(s, 'C4')) / 3 + LAT * .02 + POST * .005
        for L in ('C1', 'C2', 'C3', 'C4'):
            add(f'{s}-{L}-cervical-plexus', f'{S} {L} ventral ramus to cervical plexus', [ramus(s, L), cp], 'plexus', [L], s, r=.0012)
        temporal = V('{S} temporal bone'.replace('{S}', S))
        ear_low = temporal[(temporal @ np.array([0, -1, .3])).argmax()]
        occ = extreme('Occipital bone', POST + UP * .6 + LAT * .4, .008)
        add(f'{s}-lesser-occipital', f'{S} lesser occipital nerve', [cp, cp + POST * .01 + UP * .03, occ], 'cutaneous', ['C2'], s, r=.0008, fibers='sensory',
            skin='Scalp behind the ear.', diam=9)
        add(f'{s}-great-auricular', f'{S} great auricular nerve', [cp, scm + LAT * .012 + UP * .02, ear_low + LAT * .01 + DOWN * .01], 'cutaneous', ['C2', 'C3'], s,
            r=.0009, fibers='sensory', skin='Skin over the ear lobe, parotid and angle of the jaw.', diam=9)
        hy = cen('Hyoid bone')
        add(f'{s}-transverse-cervical', f'{S} transverse cervical nerve', [cp, scm + LAT * .01 + ANT * .01, hy + ANT * .02 + LAT * .02], 'cutaneous', ['C2', 'C3'], s,
            r=.0008, fibers='sensory', skin='Skin of the anterior neck.', diam=9)
        clav_mid = A('{S} clavicle', .5, UP, .01)
        add(f'{s}-supraclavicular', f'{S} supraclavicular nerves', [cp, cp + DOWN * .04 + LAT * .02, clav_mid], 'cutaneous', ['C3', 'C4'], s,
            r=.0009, fibers='sensory', skin='Skin over the clavicle and top of the shoulder (C4 cape).', diam=9)
        scal = C('{S} scalenus anterior') if has(f'{S} scalenus anterior') else cp + DOWN * .03
        diaph = V('Diaphragm'); dome = diaph[(diaph @ (UP + LAT * .6)).argmax()]
        heart_side = V(*[n for n in NAME if n.startswith('Cavity of')]); hs = heart_side[(heart_side @ LAT).argmax()]
        add(f'{s}-phrenic', f'{S} phrenic nerve', [(ramus(s, 'C3') + ramus(s, 'C5')) / 2 + LAT * .01, scal + ANT * .008, scal + ANT * .01 + DOWN * .03,
             hs + LAT * .012 + UP * .05, hs + LAT * .012, dome + UP * .004], 'peripheral', ['C3', 'C4', 'C5'], s, r=.0012,
            targets=['Diaphragm'], skin='Sensory to pericardium, mediastinal and diaphragmatic pleura (referred pain to C4 shoulder).', diam=12)

        # ---------------- brachial plexus
        ax_art = CL('{S} axillary artery')
        if np.linalg.norm(ax_art[0] - C('{S} humerus')) < np.linalg.norm(ax_art[-1] - C('{S} humerus')): ax_art = ax_art[::-1]
        ut = (ramus(s, 'C5') + ramus(s, 'C6')) / 2 + LAT * .03 + DOWN * .01
        mt = ramus(s, 'C7') + LAT * .032
        lt = (ramus(s, 'C8') + ramus(s, 'T1')) / 2 + LAT * .03 + UP * .006
        behind_clav = A('{S} clavicle', .45, POST + DOWN * .3, .012)
        for L, t in (('C5', ut), ('C6', ut), ('C7', mt), ('C8', lt), ('T1', lt)):
            add(f'{s}-{L}-brachial-root', f'{S} {L} root of brachial plexus', [ramus(s, L), t], 'plexus', [L], s, r=.0016)
        trunks = {'upper': (ut, ['C5', 'C6']), 'middle': (mt, ['C7']), 'lower': (lt, ['C8', 'T1'])}
        for nm, (p, segs) in trunks.items():
            add(f'{s}-{nm}-trunk', f'{S} {nm} trunk of brachial plexus', [p, (p + behind_clav) / 2 + UP * .005, behind_clav], 'plexus', segs, s, r=.002)
        a0, a1, a2 = ax_art[0], ax_art[len(ax_art) // 2], ax_art[-1]
        cords = {'lateral': (LAT * .007 + ANT * .005, ['C5', 'C6', 'C7']), 'posterior': (POST * .008, ['C5', 'C6', 'C7', 'C8', 'T1']), 'medial': (MED * .007 + ANT * .002, ['C8', 'T1'])}
        cord_end = {}
        for nm, (off, segs) in cords.items():
            add(f'{s}-{nm}-cord', f'{S} {nm} cord of brachial plexus', [behind_clav, a0 + off, a1 + off], 'plexus', segs, s, r=.002)
            cord_end[nm] = a1 + off
        brach = CL('{S} brachial artery')
        if np.linalg.norm(brach[0] - a2) > np.linalg.norm(brach[-1] - a2): brach = brach[::-1]
        ret = cen(f'Flexor retinaculum of {s} wrist')
        def tip(f): return cen(f'Distal phalanx of {s} {f}') + hand_palm * .004
        def dtip(f): return cen(f'Distal phalanx of {s} {f}') + DORS * .004
        # musculocutaneous
        add(f'{s}-musculocutaneous', f'{S} musculocutaneous nerve', [cord_end['lateral'], C('{S} coracobrachialis') + LAT * .004,
             A('{S} brachialis', .45, ANT, .004), A('{S} brachialis', .9, ANT + LAT, .004), A('{S} brachioradialis', .4, ANT + LAT, .003),
             A('{S} radius', .95, LAT + hand_palm * .5, .008)], 'peripheral', ['C5', 'C6', 'C7'], s, r=.0018,
            targets=[r'{S} coracobrachialis', r'(Long|Short) head of {s} biceps brachii', r'{S} brachialis'],
            skin='Lateral forearm (as the lateral antebrachial cutaneous nerve).')
        # median
        fds = C('{S} flexor digitorum superficialis')
        mp = [cord_end['lateral'] * .5 + cord_end['medial'] * .5, a2 + LAT * .004] + [b + LAT * .005 for b in brach[1::3]] + \
             [brach[-1] + ANT * .004, C('Humeral head of {s} pronator teres'.replace('{s}', s)) + POST * .004, fds - hand_palm * .006, A('{S} flexor digitorum superficialis', .9, -hand_palm, .002), ret]
        add(f'{s}-median', f'{S} median nerve', mp, 'peripheral', ['C5', 'C6', 'C7', 'C8', 'T1'], s, r=.0022,
            targets=[r'(Humeral|Ulnar) head of {s} pronator teres', r'{S} flexor carpi radialis', r'{S} palmaris longus', r'{S} flexor digitorum superficialis',
                     r'{S} flexor pollicis longus', r'{S} pronator quadratus', r'{S} abductor pollicis brevis', r'{S} opponens pollicis', r'Superficial head of {s} flexor pollicis brevis'],
            skin='Palm and palmar thumb, index, middle and radial half of ring finger (and their nail beds).', diam=14)
        palm = A('{S} third metacarpal bone', .3, hand_palm, .008)
        for f, segs in (('thumb', ['C6']), ('index finger', ['C6', 'C7']), ('middle finger', ['C7'])):
            add(f'{s}-median-digital-{f.split()[0]}', f'{S} median palmar digital nerve to {f}', [ret, palm if f != 'thumb' else ret + hand_palm * .01, tip(f)], 'cutaneous', segs, s,
                parent=f'{s}-median', r=.0008, fibers='sensory', skin=f'Palmar {f}.', diam=10)
        # ulnar
        med_epi = A('{S} humerus', .97, MED + POST * .3, .006)
        fcu = C('Ulnar head of {s} flexor carpi ulnaris'.replace('{s}', s))
        uart = CL('{S} ulnar artery')
        if uart[0][1] < uart[-1][1]: uart = uart[::-1]
        pis = cen(f'{S} pisiform')
        up = [cord_end['medial'], a2 + MED * .008] + [b + MED * .01 + POST * .004 for b in brach[1:len(brach) // 2:2]] + \
             [A('{S} humerus', .75, MED + POST, .008), med_epi, fcu - hand_palm * .004] + [u + MED * .004 for u in uart[len(uart) // 2::2]] + [pis + LAT * .006 + hand_palm * .004]
        add(f'{s}-ulnar', f'{S} ulnar nerve', up, 'peripheral', ['C8', 'T1'], s, r=.002,
            targets=[r'(Ulnar|Humeral) head of {s} flexor carpi ulnaris', r'{S} flexor digitorum profundus', r'(Abductor|Flexor) digiti minimi (brevis )?of {s} hand',
                     r'Opponens digiti minimi of {s} hand', r'Set of (dorsal|palmar) interossei of {s} hand', r'Set of lumbricals of {s} hand', r'(Oblique|Transverse) head of {s} adductor pollicis'],
            skin='Little finger, ulnar half of ring finger and ulnar side of the hand (palmar and dorsal).', diam=14)
        for f in ('little finger', 'ring finger'):
            add(f'{s}-ulnar-digital-{f.split()[0]}', f'{S} ulnar palmar digital nerve to {f}', [pis + hand_palm * .006, A('{S} fifth metacarpal bone', .4, hand_palm, .006), tip(f)],
                'cutaneous', ['C8'], s, parent=f'{s}-ulnar', r=.0008, fibers='sensory', skin=f'Palmar {f}.', diam=10)
        # radial
        lat_epi = A('{S} humerus', .93, LAT + ANT * .4, .008)
        rp = [cord_end['posterior'], a2 + POST * .01, A('{S} humerus', .3, POST + MED * .3, .008), A('{S} humerus', .5, POST + LAT, .008),
              A('{S} humerus', .7, LAT, .008), lat_epi]
        add(f'{s}-radial', f'{S} radial nerve', rp, 'peripheral', ['C5', 'C6', 'C7', 'C8', 'T1'], s, r=.0022,
            targets=[r'(Long|Lateral|Medial) head of {s} triceps brachii', r'{S} anconeus', r'{S} brachioradialis', r'{S} extensor carpi radialis (longus|brevis)'],
            skin='Posterior arm and forearm; dorsum of hand radial side via superficial branch.', diam=14)
        sup = C('{S} supinator')
        add(f'{s}-posterior-interosseous', f'{S} deep branch of radial nerve (posterior interosseous)', [lat_epi, sup + DORS * .004, C('{S} extensor digitorum') - hand_palm * .006,
             A('{S} extensor digitorum', .85, DORS, .002), A('{S} radius', .98, DORS, .006)], 'peripheral', ['C7', 'C8'], s, parent=f'{s}-radial', r=.0014,
            targets=[r'{S} supinator', r'{S} extensor digitorum', r'{S} extensor digiti minimi', r'{S} extensor carpi ulnaris', r'{S} abductor pollicis longus',
                     r'{S} extensor pollicis (brevis|longus)', r'{S} extensor indicis'], fibers='motor')
        add(f'{s}-superficial-radial', f'{S} superficial branch of radial nerve', [lat_epi, A('{S} brachioradialis', .5, -hand_palm + LAT, .002), A('{S} radius', .9, LAT, .008),
             A('{S} first metacarpal bone', .5, DORS, .005), dtip('thumb'), ], 'cutaneous', ['C6', 'C7'], s, parent=f'{s}-radial', r=.0009, fibers='sensory',
            skin='Dorsum of the hand over the thumb, first web space and radial 3.5 digits (proximal).', diam=10)
        # axillary
        add(f'{s}-axillary', f'{S} axillary nerve', [cord_end['posterior'], A('{S} humerus', .13, POST + MED * .4, .012), A('{S} humerus', .16, POST + LAT, .012),
             A('{S} humerus', .17, LAT + ANT * .3, .013)], 'peripheral', ['C5', 'C6'], s, r=.0016,
            targets=[r'(Acromial|Clavicular|Spinal) part of {s} deltoid', r'{S} teres minor'], skin='Skin over the lower deltoid ("regimental badge" area).')
        # other brachial branches
        serr = V(f'{S} serratus anterior')
        add(f'{s}-long-thoracic', f'{S} long thoracic nerve', [ramus(s, 'C6') + LAT * .015, behind_clav + POST * .01 + MED * .01] +
            [serr[np.abs(serr[:, 1] - y) < .01][(serr[np.abs(serr[:, 1] - y) < .01] @ (LAT + POST * .3)).argmax()] + LAT * .003 for y in np.linspace(serr[:, 1].max() - .03, serr[:, 1].min() + .03, 4)],
            'peripheral', ['C5', 'C6', 'C7'], s, r=.0011, targets=[r'{S} serratus anterior'], fibers='motor')
        add(f'{s}-suprascapular', f'{S} suprascapular nerve', [ut, extreme(f'{S} scapula', UP + ANT * .3, .006), C('{S} supraspinatus'), C('{S} infraspinatus muscle')],
            'peripheral', ['C5', 'C6'], s, r=.0013, targets=[r'{S} supraspinatus', r'{S} infraspinatus muscle'], fibers='motor')
        add(f'{s}-dorsal-scapular', f'{S} dorsal scapular nerve', [ramus(s, 'C5') + LAT * .01, C('{S} levator scapulae'), C('{S} rhomboid minor') + ANT * .006, C('{S} rhomboid major') + ANT * .006],
            'peripheral', ['C5'], s, r=.001, targets=[r'{S} levator scapulae', r'{S} rhomboid (major|minor)'], fibers='motor')
        add(f'{s}-lateral-pectoral', f'{S} lateral pectoral nerve', [cord_end['lateral'], C('Clavicular part of {s} pectoralis major'.replace('{s}', s)) + POST * .008],
            'peripheral', ['C5', 'C6', 'C7'], s, r=.001, targets=[r'(Clavicular|Sternocostal) part of {s} pectoralis major'], fibers='motor')
        add(f'{s}-medial-pectoral', f'{S} medial pectoral nerve', [cord_end['medial'], C('{S} pectoralis minor'), C('Sternocostal part of {s} pectoralis major'.replace('{s}', s)) + POST * .008],
            'peripheral', ['C8', 'T1'], s, r=.001, targets=[r'{S} pectoralis minor', r'(Sternocostal|Abdominal) part of {s} pectoralis major'], fibers='motor')
        add(f'{s}-subscapular', f'{S} subscapular nerves (upper & lower)', [cord_end['posterior'], C('{S} subscapularis') + ANT * .006, C('{S} teres major') + ANT * .004],
            'peripheral', ['C5', 'C6'], s, r=.001, targets=[r'{S} subscapularis', r'{S} teres major'], fibers='motor')
        add(f'{s}-thoracodorsal', f'{S} thoracodorsal nerve', [cord_end['posterior'], CL('{S} thoracodorsal artery')[-1] + POST * .004 if has(f'{S} thoracodorsal artery') else cord_end['posterior'] + DOWN * .08],
            'peripheral', ['C6', 'C7', 'C8'], s, r=.001, targets=[r'.*latissimus dorsi.*'], fibers='motor')
        add(f'{s}-medial-antebrachial-cutaneous', f'{S} medial antebrachial cutaneous nerve', [cord_end['medial'], A('{S} humerus', .6, MED, .02), med_epi + ANT * .01 + MED * .006,
             A('{S} ulna', .6, MED, .01)], 'cutaneous', ['C8', 'T1'], s, r=.0008, fibers='sensory', skin='Medial forearm (T1/C8).', diam=9)

        # ---------------- intercostal / subcostal
        for k in range(1, 13):
            rib = f'{S} {ORD[k-1]} rib'
            L = f'T{k}'
            if not has(rib): continue
            v = V(rib); c0 = canal[VLABEL.index(L)]
            ang = np.arctan2(v[:, 2] - c0[2], (v[:, 0] - c0[0]) * sx)
            order = np.argsort(ang)
            bins = np.array_split(order, 10)
            curve = [v[b].mean(0) + DOWN * .006 for b in bins if len(b)]
            curve = sorted(curve, key=lambda p: np.arctan2(p[2] - c0[2], (p[0] - c0[0]) * sx))
            path = [ramus(s, L)] + curve
            skin = f'{L} dermatome band: ' + DERM[L]
            if k >= 7:
                end = curve[-1]
                path += [end + ANT * .01 + DOWN * .03 + MED * .03, np.array([sx * .03, end[1] - .06 - (k - 7) * .012, end[2] + .02])]
            add(f'{s}-{L}-intercostal', f'{S} {"subcostal" if k == 12 else ORD[k-1] + " intercostal"} nerve ({L})', path, 'peripheral', [L], s, r=.0012,
                targets=[r'.*intercostal.*', r'{S} external oblique'] if k >= 7 else [r'.*intercostal.*'], skin=skin)

        # ---------------- lumbar plexus
        psoas = V(f'{S} psoas major')
        def psoas_at(y, d):
            band = psoas[np.abs(psoas[:, 1] - y) < .01]
            return band[(band @ unit(d)).argmax()] if len(band) else psoas.mean(0)
        hip = V(f'{S} hip bone')
        crest = hip[(hip @ (UP + LAT * .3)).argmax()]
        asis = hip[(hip @ (ANT + UP * .6 + LAT * .3)).argmax()]
        pubic = hip[(hip @ (ANT + MED + DOWN * .3)).argmax()]
        for L in ('L1', 'L2', 'L3', 'L4'):
            add(f'{s}-{L}-lumbar-plexus', f'{S} {L} ventral ramus to lumbar plexus', [ramus(s, L), psoas_at(ramus(s, L)[1] - .01, LAT * .2 + POST)], 'plexus', [L], s, r=.0014)
        add(f'{s}-iliohypogastric', f'{S} iliohypogastric nerve', [ramus(s, 'L1'), psoas_at(ramus(s, 'L1')[1] - .02, LAT), crest + UP * .015 + ANT * .02, asis + UP * .02 + MED * .03, pubic + UP * .05 + ANT * .005],
            'peripheral', ['T12', 'L1'], s, r=.001, targets=[r'{S} external oblique'], skin='Skin above the pubis and over the lateral buttock.')
        add(f'{s}-ilioinguinal', f'{S} ilioinguinal nerve', [ramus(s, 'L1'), psoas_at(ramus(s, 'L1')[1] - .035, LAT), crest + ANT * .03, asis + MED * .02 + DOWN * .01, pubic + ANT * .01 + DOWN * .01],
            'peripheral', ['L1'], s, r=.0009, skin='Upper medial thigh and anterior genital region (L1).', fibers='mixed')
        add(f'{s}-genitofemoral', f'{S} genitofemoral nerve', [ramus(s, 'L2'), psoas_at(ramus(s, 'L2')[1] - .04, ANT), psoas_at(asis[1] + .02, ANT) + ANT * .004, pubic + LAT * .03 + DOWN * .005],
            'peripheral', ['L1', 'L2'], s, r=.0009, skin='Small area of upper anterior thigh below the inguinal ligament; genital branch.')
        vl = V(f'{S} vastus lateralis')
        add(f'{s}-lateral-femoral-cutaneous', f'{S} lateral femoral cutaneous nerve', [ramus(s, 'L2'), psoas_at(ramus(s, 'L3')[1], LAT), (crest + asis) / 2 + ANT * .01 + MED * .01, asis + MED * .012 + DOWN * .01,
             at(f'{S} vastus lateralis', .3, LAT + ANT, .012), at(f'{S} vastus lateralis', .7, LAT, .012)], 'cutaneous', ['L2', 'L3'], s, r=.0009, fibers='sensory',
            skin='Anterolateral thigh (meralgia paresthetica territory).', diam=10)
        fem_a = CL('{S} femoral artery')
        if fem_a[0][1] < fem_a[-1][1]: fem_a = fem_a[::-1]
        groove = psoas_at(asis[1] + .03, LAT + ANT)
        fp = [ramus(s, 'L3'), psoas_at(ramus(s, 'L4')[1], LAT), groove, fem_a[0] + LAT * .014 + ANT * .002, fem_a[1] + LAT * .014 + ANT * .004]
        add(f'{s}-femoral', f'{S} femoral nerve', fp, 'peripheral', ['L2', 'L3', 'L4'], s, r=.0024,
            targets=[r'{S} rectus femoris', r'{S} vastus (lateralis|medialis|intermedius)', r'{S} sartorius', r'{S} pectineus', r'{S} iliacus'],
            skin='Anterior thigh (anterior cutaneous branches); medial leg via saphenous nerve.', diam=14)
        for m in ('rectus femoris', 'vastus lateralis', 'vastus medialis', 'sartorius'):
            if has(f'{S} {m}'): add(f'{s}-femoral-{m.replace(" ", "-")}', f'{S} femoral nerve branch to {m}', [fem_a[1] + LAT * .014, at(f'{S} {m}', .3)],
                                    'twig', ['L2', 'L3', 'L4'], s, parent=f'{s}-femoral', r=.0011, targets=[rf'{S} {m}'], fibers='motor')
        gsv = CL('{S} great saphenous vein')
        if gsv[0][1] < gsv[-1][1]: gsv = gsv[::-1]
        tib_med = at(f'{S} tibia', .99, MED, .006)
        add(f'{s}-saphenous', f'{S} saphenous nerve', [fem_a[1] + LAT * .01] + [f + ANT * .006 + LAT * .004 for f in fem_a[2::2]] + [at(f'{S} tibia', .05, MED, .012)] +
            [g for g in gsv if g[1] < at(f'{S} tibia', .1)[1] and g[1] > tib_med[1]] + [tib_med, at(f'{S} first metatarsal bone', .2, MED, .006)],
            'cutaneous', ['L3', 'L4'], s, parent=f'{s}-femoral', r=.0011, fibers='sensory', skin='Medial knee, medial leg, medial malleolus and medial foot (L4).', diam=11)
        obt = C('{S} obturator externus')
        add(f'{s}-obturator', f'{S} obturator nerve', [ramus(s, 'L3'), psoas_at(ramus(s, 'L4')[1] - .02, MED + POST), hip[(hip @ (MED + UP * .2)).argmax()] + LAT * .01, obt + UP * .01,
             at(f'{S} adductor brevis', .3, ANT, .003), at(f'{S} adductor longus', .7, POST, .003)], 'peripheral', ['L2', 'L3', 'L4'], s, r=.0018,
            targets=[r'{S} adductor (longus|brevis|magnus|minimus)', r'{S} gracilis', r'{S} obturator externus'], skin='Small patch of the medial thigh above the knee.')

        # ---------------- sacral plexus
        pir = V(f'{S} piriformis')
        pir_ant = pir[(pir @ (ANT + MED * .5)).argmax()]
        gsf = pir[(pir @ (DOWN + LAT * .5 + POST * .2)).argmax()] + DOWN * .008
        add(f'{s}-lumbosacral-trunk', f'{S} lumbosacral trunk (L4-L5)', [ramus(s, 'L4'), ramus(s, 'L5'), pir_ant + UP * .01 + ANT * .006], 'plexus', ['L4', 'L5'], s, r=.002)
        for L in ('S1', 'S2', 'S3', 'S4'):
            add(f'{s}-{L}-sacral-plexus', f'{S} {L} ventral ramus to sacral plexus', [ramus(s, L), pir_ant + ANT * .006 + DOWN * .006 * (LEVELS.index(L) - 25)], 'plexus', [L], s, r=.0016)
        plex = pir_ant + ANT * .008 + DOWN * .01
        gt = V(f'{S} femur'); gt = gt[(gt @ (UP * .4 + LAT)).argmax()]
        it = hip[(hip @ (DOWN + POST * .4)).argmax()]
        add(f'{s}-superior-gluteal', f'{S} superior gluteal nerve', [plex, pir[(pir @ UP).argmax()] + UP * .006, C('{S} gluteus minimus') + POST * .006, C('{S} gluteus medius') + DOWN * .02,
             C('{S} tensor fasciae latae')], 'peripheral', ['L4', 'L5', 'S1'], s, r=.0014,
            targets=[r'{S} gluteus (medius|minimus)', r'{S} tensor fasciae latae'], fibers='motor')
        add(f'{s}-inferior-gluteal', f'{S} inferior gluteal nerve', [plex, gsf + MED * .01, C('{S} gluteus maximus') + ANT * .015], 'peripheral', ['L5', 'S1', 'S2'], s, r=.0014,
            targets=[r'{S} gluteus maximus'], fibers='motor')
        sci_mid = (gt + it) / 2 + POST * .01
        am = f'{S} adductor magnus'
        pop = CL('{S} popliteal artery')
        if pop[0][1] < pop[-1][1]: pop = pop[::-1]
        apex = pop[0] + POST * .012 + LAT * .004
        sp = [plex, gsf, sci_mid, at(am, .35, POST, .008), at(am, .7, POST, .01), apex]
        add(f'{s}-sciatic', f'{S} sciatic nerve', sp, 'peripheral', ['L4', 'L5', 'S1', 'S2', 'S3'], s, r=.0045,
            targets=[r'{S} semitendinosus', r'{S} semimembranosus', r'(Long|Short) head of {s} biceps femoris', r'{S} adductor magnus'],
            skin='Via its branches: almost all of the leg below the knee except the medial strip (saphenous).', diam=16)
        for m in ('semitendinosus', 'semimembranosus'):
            add(f'{s}-sciatic-{m}', f'{S} sciatic (tibial division) branch to {m}', [at(am, .4, POST, .008), at(f'{S} {m}', .35)], 'twig', ['L5', 'S1', 'S2'], s, parent=f'{s}-sciatic',
                r=.0012, targets=[rf'{S} {m}'], fibers='motor')
        ptib = CL('{S} posterior tibial artery')
        if ptib[0][1] < ptib[-1][1]: ptib = ptib[::-1]
        mmal = at(f'{S} tibia', .995, POST + MED, .008)
        tp = [apex] + [p + POST * .008 for p in pop[1::2]] + [p + POST * .005 + LAT * .002 for p in ptib[::2]] + [mmal]
        add(f'{s}-tibial', f'{S} tibial nerve', tp, 'peripheral', ['L4', 'L5', 'S1', 'S2', 'S3'], s, parent=f'{s}-sciatic', r=.0032,
            targets=[r'(Lateral|Medial) head of {s} gastrocnemius', r'{S} soleus', r'{S} plantaris', r'{S} popliteus', r'{S} tibialis posterior',
                     r'{S} flexor digitorum longus', r'{S} flexor hallucis longus'], skin='Heel and sole (via calcaneal and plantar branches).', diam=15)
        calc = cen(f'{S} calcaneus')
        for nm, segs, tg, end in (('medial plantar', ['L4', 'L5'], [r'{S} abductor hallucis', r'{S} flexor digitorum brevis', r'(Lateral|Medial) head of {s} flexor hallucis brevis', r'First lumbrical of {s} foot'],
                                   at(f'{S} first metatarsal bone', .6, DOWN, .006)),
                                  ('lateral plantar', ['S1', 'S2'], [r'{S} flexor accessorius', r'Abductor digiti minimi of {s} foot', r'Flexor digiti minimi brevis of {s} foot', r'(Second|Third|Fourth) lumbrical of {s} foot',
                                   r'.*plantar interosseous of {s} foot', r'(Oblique|Transverse) head of {s} adductor hallucis'], at(f'{S} fifth metatarsal bone', .5, DOWN, .006))):
            add(f'{s}-{nm.replace(" ", "-")}', f'{S} {nm} nerve', [mmal, calc + DOWN * .015 + (MED if 'medial' in nm else LAT) * .01, end], 'peripheral', segs, s, parent=f'{s}-tibial', r=.0016,
                targets=[t.replace('{S}', S).replace('{s}', s) for t in tg], skin='Medial sole and medial 3.5 toes.' if 'medial' in nm else 'Lateral sole and lateral 1.5 toes.')
        fib_neck = at(f'{S} fibula', .08, LAT + POST * .3, .007)
        cfp = [apex, at(f'Long head of {s} biceps femoris'.replace('{s}', s), .92, MED + POST, .004) if has(f'Long head of {s} biceps femoris') else apex + LAT * .03, at(f'{S} fibula', .03, POST + LAT, .007), fib_neck]
        add(f'{s}-common-fibular', f'{S} common fibular (peroneal) nerve', cfp, 'peripheral', ['L4', 'L5', 'S1', 'S2'], s, parent=f'{s}-sciatic', r=.0026,
            targets=[r'Short head of {s} biceps femoris'], skin='Upper lateral leg (lateral sural cutaneous).', diam=15)
        add(f'{s}-superficial-fibular', f'{S} superficial fibular nerve', [fib_neck, at(f'{S} fibularis longus', .45, ANT, .003), at(f'{S} fibularis brevis', .75, ANT + MED * .3, .006),
             at(f'{S} tibia', .97, LAT + ANT, .02), at(f'{S} third metatarsal bone', .5, UP, .006), cen(f'Proximal phalanx of {s} third toe') + UP * .005], 'peripheral', ['L4', 'L5', 'S1'], s,
            parent=f'{s}-common-fibular', r=.0014, targets=[r'{S} fibularis (longus|brevis)'], skin='Lower lateral leg and most of the dorsum of the foot (L5).')
        atib = CL('{S} anterior tibial artery')
        if atib[0][1] < atib[-1][1]: atib = atib[::-1]
        dp = [fib_neck, fib_neck + ANT * .015 + MED * .01] + [p + LAT * .003 for p in atib[1::2]] + [at(f'{S} first metatarsal bone', .4, UP, .006),
             (cen(f'Proximal phalanx of {s} big toe') + cen(f'Proximal phalanx of {s} second toe')) / 2 + UP * .006]
        add(f'{s}-deep-fibular', f'{S} deep fibular (peroneal) nerve', dp, 'peripheral', ['L4', 'L5', 'S1'], s, parent=f'{s}-common-fibular', r=.0016,
            targets=[r'{S} tibialis anterior', r'{S} extensor digitorum longus', r'{S} extensor hallucis (longus|brevis)', r'{S} fibularis tertius'],
            skin='First web space between the big and second toes (L5).')
        ssv = CL('{S} small saphenous vein')
        if ssv[0][1] < ssv[-1][1]: ssv = ssv[::-1]
        add(f'{s}-sural', f'{S} sural nerve', [apex + DOWN * .02, (C('Lateral head of {s} gastrocnemius'.replace('{s}', s)) + C('Medial head of {s} gastrocnemius'.replace('{s}', s))) / 2 + POST * .02] +
            [p + LAT * .004 for p in ssv[len(ssv) // 3::2]] + [at(f'{S} fibula', .99, POST + LAT, .012), at(f'{S} fifth metatarsal bone', .5, LAT, .008)],
            'cutaneous', ['S1', 'S2'], s, parent=f'{s}-tibial', r=.0011, fibers='sensory', skin='Posterolateral lower leg, lateral ankle and lateral foot (S1).', diam=11)
        add(f'{s}-posterior-femoral-cutaneous', f'{S} posterior femoral cutaneous nerve', [plex, gsf + POST * .01, sci_mid + POST * .03, at(am, .5, POST, .03), apex + POST * .02],
            'cutaneous', ['S1', 'S2', 'S3'], s, r=.001, fibers='sensory', skin='Posterior thigh and popliteal fossa (S2), lower buttock.', diam=10)
        oi = C('{S} obturator internus')
        add(f'{s}-pudendal', f'{S} pudendal nerve', [ramus(s, 'S2') * .5 + ramus(s, 'S4') * .5, gsf + MED * .015, it + UP * .04 + MED * .01, oi + MED * .012 + DOWN * .02,
             cen('External anal sphincter') + LAT * .01], 'peripheral', ['S2', 'S3', 'S4'], s, r=.0013,
            targets=[r'External anal sphincter', r'{S} (puborectalis|pubococcygeus|iliococcygeus)'], skin='Perineum, anal region and external genitalia.')
        add(f'{s}-nerve-to-levator-ani', f'{S} nerve to levator ani & coccygeus (S3-S4)', [ramus(s, 'S4'), C('{S} coccygeus'), C('{S} iliococcygeus')], 'peripheral', ['S3', 'S4'], s,
            r=.0008, targets=[r'{S} coccygeus', r'{S} iliococcygeus', r'{S} pubococcygeus'], fibers='motor')
        add(f'{s}-nerve-to-hip-rotators', f'{S} nerves to piriformis, obturator internus & quadratus femoris', [plex, C('{S} piriformis'), C('{S} gemellus superior'), C('{S} quadratus femoris')],
            'peripheral', ['L4', 'L5', 'S1', 'S2'], s, r=.0008,
            targets=[r'{S} piriformis', r'{S} obturator internus', r'{S} gemellus (superior|inferior)', r'{S} quadratus femoris'], fibers='motor')

        # ---------------- cranial nerves
        pons, medulla = V('Pons'), V('Medulla oblongata')
        tb = V(f'{S} temporal bone')
        mand = V('Mandible')
        stylo = tb[(tb @ (DOWN + POST * .3 + LAT * .3)).argmax()] + MED * .004
        iam = tb[(tb @ (MED + UP * .2)).argmax()] + LAT * .01
        ramus_m = mand[(mand @ (LAT * .7 + POST + UP * .5)).argmax()]
        pons_lat = pons[(pons @ (LAT + DOWN * .3)).argmax()]
        zyg = cen(f'{S} zygomatic bone'); fb = V('Frontal bone')
        brow = fb[(fb @ (ANT + LAT * .5 + DOWN * .2)).argmax()]
        chin_side = mand[(mand @ (ANT + LAT * .5 + DOWN * .4)).argmax()]
        max_ = V(f'{S} maxilla'); infraorb = max_[(max_ @ (ANT + UP * .4 + LAT * .3)).argmax()]
        parotid = ramus_m + POST * .005 + LAT * .012 + DOWN * .02
        add(f'{s}-facial', f'{S} facial nerve (CN VII)', [pons_lat, iam, stylo, parotid], 'cranial', ['CN VII'], s, r=.0013,
            targets=[r'{S} platysma', r'{S} digastric', r'{S} stylohyoid'], skin='Motor to the muscles of facial expression; taste anterior 2/3 tongue (chorda tympani).')
        for nm, end in (('temporal', brow + ANT * .006 + UP * .015), ('zygomatic', zyg + ANT * .008 + LAT * .004), ('buccal', infraorb + DOWN * .025 + LAT * .02 + ANT * .01),
                        ('marginal mandibular', chin_side + LAT * .006), ('cervical', mand[(mand @ (DOWN + LAT)).argmax()] + DOWN * .025 + LAT * .01)):
            add(f'{s}-facial-{nm.split()[0]}', f'{S} facial nerve {nm} branch', [parotid, (parotid + end) / 2 + LAT * .01 + ANT * .01, end], 'cranial', ['CN VII'], s,
                parent=f'{s}-facial', r=.0007, fibers='motor', targets=[r'{S} platysma'] if nm == 'cervical' else [])
        gang = tb[(tb @ (MED + ANT + UP * .3)).argmax()] + UP * .005
        pons_mid = pons[(pons @ (LAT + ANT * .3)).argmax()]
        add(f'{s}-trigeminal', f'{S} trigeminal nerve root & ganglion (CN V)', [pons_mid, gang], 'cranial', ['CN V'], s, r=.002, skin='Sensation of the face, eye, nose, mouth and teeth.')
        orbit_top = fb[(fb @ (ANT + DOWN + LAT * .45)).argmax()]
        add(f'{s}-V1', f'{S} ophthalmic division V1 to forehead', [gang, orbit_top + POST * .03, orbit_top + DOWN * .004, brow + UP * .03 + MED * .01], 'cranial', ['CN V'], s,
            parent=f'{s}-trigeminal', r=.0009, fibers='sensory', skin='Forehead, upper eyelid, cornea, dorsum of nose (V1).')
        add(f'{s}-V2', f'{S} maxillary division V2 (to infraorbital nerve)', [gang, gang + ANT * .02 + DOWN * .01, infraorb + POST * .02 + DOWN * .006, infraorb + DOWN * .01 + ANT * .004],
            'cranial', ['CN V'], s, parent=f'{s}-trigeminal', r=.0011, fibers='sensory', skin='Cheek, lower eyelid, side of nose, upper lip, upper teeth (V2).')
        add(f'{s}-V3', f'{S} mandibular division V3 (inferior alveolar & mental)', [gang, gang + DOWN * .025, ramus_m + MED * .006 + DOWN * .02, mand[(mand @ (LAT * .3 + ANT + UP * .1)).argmax()] * 0 + chin_side + UP * .01 + POST * .015, chin_side + ANT * .004],
            'cranial', ['CN V'], s, parent=f'{s}-trigeminal', r=.0012, targets=[r'{S} mylohyoid', r'.*tensor veli palatini.*'],
            skin='Lower lip, chin, lower teeth, tongue (general sensation), skin in front of the ear (V3).')
        jug = tb[(tb @ (DOWN + MED + POST * .3)).argmax()] + DOWN * .004
        med_lat = medulla[(medulla @ (LAT + POST * .2)).argmax()]
        cca = CL('{S} common carotid artery')
        if cca[0][1] < cca[-1][1]: cca = cca[::-1]
        eso = V('Esophagus'); stom = cen('Stomach')
        trach = V('Trachea'); arch = V('Arch of aorta') if has('Arch of aorta') else trach
        loop = arch[(arch @ (DOWN + LAT * .3)).argmax()] if s == 'left' else V(f'{S} subclavian artery')[(V(f'{S} subclavian artery') @ DOWN).argmin()]
        vp = [med_lat, jug] + [c + POST * .008 + LAT * .004 for c in cca] + [loop + LAT * .005 + UP * .01, eso[np.abs(eso[:, 1] - (loop[1] - .08)) < .01].mean(0) + LAT * .008,
              eso[np.abs(eso[:, 1] - (stom[1] + .06)) < .01].mean(0), stom]
        add(f'{s}-vagus', f'{S} vagus nerve (CN X)', vp, 'cranial', ['CN X'], s, r=.0018,
            targets=[r'{S} cricothyroid'.replace('{S}', '.*'), r'(Oblique|Straight) part of {s} cricothyroid'], skin='Parasympathetic to heart, lungs and gut; sensation from larynx, pharynx and viscera.')
        lar = cen('Thyroid cartilage')
        add(f'{s}-recurrent-laryngeal', f'{S} recurrent laryngeal nerve', [loop + LAT * .005 + UP * .01, loop + DOWN * .012, loop + MED * .02 + POST * .01,
             trach[np.abs(trach[:, 1] - (lar[1] - .05)) < .01].mean(0) + POST * .01 + LAT * .012, lar + POST * .012 + LAT * .008],
            'cranial', ['CN X'], s, parent=f'{s}-vagus', r=.0008, fibers='motor',
            targets=[r'{S} posterior crico-arytenoid', r'{S} lateral crico-arytenoid', r'{S} thyro-arytenoid', r'{S} vocalis', r'{S} oblique arytenoid', r'.*transverse arytenoid.*'])
        add(f'{s}-accessory', f'{S} accessory nerve (CN XI)', [med_lat + DOWN * .01, jug, C('{S} sternocleidomastoid') + MED * .006, C('{S} sternocleidomastoid') + POST * .03 + DOWN * .02,
             C('Descending part of {s} trapezius'.replace('{s}', s)) + ANT * .008], 'cranial', ['CN XI', 'C3', 'C4'], s, r=.0011, fibers='motor',
            targets=[r'{S} sternocleidomastoid', r'(Descending|Transverse|Ascending) part of {s} trapezius'])
        med_ant = medulla[(medulla @ (ANT + LAT * .4)).argmax()]
        add(f'{s}-hypoglossal', f'{S} hypoglossal nerve (CN XII)', [med_ant, jug + MED * .005 + ANT * .005, cca[0] + ANT * .015 + DOWN * .005 if len(cca) else jug + DOWN * .03,
             C('{S} hyoglossus') + LAT * .004, C('{S} genioglossus')], 'cranial', ['CN XII'], s, r=.0011, fibers='motor',
            targets=[r'{S} genioglossus', r'{S} hyoglossus', r'{S} geniohyoid'])
        lr = C('{S} lateral rectus') if has(f'{S} lateral rectus') else orbit_top + DOWN * .02
        add(f'{s}-abducens', f'{S} abducens nerve (CN VI)', [pons[(pons @ (ANT + DOWN * .5 + LAT * .2)).argmax()], gang + MED * .01 + UP * .004, lr + POST * .01], 'cranial', ['CN VI'], s,
            r=.0007, fibers='motor', targets=[r'{S} lateral rectus'])
        mid = V('Midbrain')
        for nm, cn, tg in (('oculomotor', 'CN III', [r'{S} (superior|inferior|medial) rectus', r'{S} inferior oblique', r'{S} levator palpebrae superioris']),
                           ('trochlear', 'CN IV', [r'{S} superior oblique'])):
            m0 = mid[(mid @ (ANT + LAT * .3)).argmax()] if cn == 'CN III' else mid[(mid @ (POST + LAT * .4)).argmax()]
            add(f'{s}-{nm}-root', f'{S} {nm} nerve ({cn}) intracranial course', [m0, gang + UP * .01 + MED * .006, orbit_top + POST * .03 + DOWN * .012], 'cranial', [cn], s,
                r=.0008, fibers='motor', targets=tg)

    # muscle twigs: branch from the closest nerve point into each target muscle
    muscle_names = [p['name'] for p in MP if p['system'] in ('muscular', 'skeletal', 'connective')]
    twigs = []
    for nv in list(nerves):
        if nv['kind'] in ('root', 'twig', 'plexus', 'spinal'): continue
        path = np.array(nv['path'])
        matched = []
        for t in nv['targets']:
            r = re.compile(t, re.I)
            matched += [n for n in muscle_names if r.fullmatch(n)]
        nv['muscles'] = sorted(set(matched))
        for mn in nv['muscles']:
            v = V(mn)
            d = ((path[:, None, :] - v[::max(1, len(v) // 300)][None]) ** 2).sum(-1)
            i, j = np.unravel_index(d.argmin(), d.shape)
            p0 = path[i]; p1 = v[::max(1, len(v) // 300)][j]
            into = v.mean(0) - p1
            inside = p1 + into / (np.linalg.norm(into) or 1) * min(.012, .25 * np.linalg.norm(into))
            if np.linalg.norm(p0 - p1) > .12 or (nv['kind'] == 'peripheral' and 'intercostal' in mn.lower()): continue
            twigs.append(dict(id=f'{nv["id"]}>{mn}', name=f'Branch to {mn}', side=nv['side'], kind='twig', segments=nv['segments'], parent=nv['id'],
                              r=max(.0005, nv['r'] * .4), targets=[], muscles=[mn], skin='', fibers='motor', diameter=nv['diameter'],
                              path=np.round(resample([p0, (p0 + inside) / 2 + (p1 - p0) * .1, inside], .004), 4).tolist()))
    nerves += twigs

    levels = [dict(id=L, exit=exit_text(L), dermatome=DERM.get(L, ''), myotome=MYO.get(L, ''), reflex=REFLEX.get(L, ''), plexus=PLEX.get(L, ''),
                   cordAtVertebra=VERTS_NAME(SEGPOS[L]), cord=np.round(seg_pt[L], 4).tolist(),
                   foramen=np.round(foramen[L], 4).tolist()) for L in LEVELS]
    return dict(version=1, note='Modeled for study: routes follow real landmarks of this reference body but are not traced from a dissection.',
                levels=levels, nerves=nerves, cord=dict(path=np.round(cord_path, 4).tolist(), filum=np.round(filum, 4).tolist(), r=.0045),
                vertebrae=dict(zip(VLABEL, [VERTS[i] for i in range(len(VLABEL))])))

def VERTS_NAME(index):
    i = int(round(index)) - 1
    labels = VLABEL + ['S1']
    return labels[max(0, min(len(labels) - 1, i))] + ' vertebral level'

def warp_model(model, apply):
    pts, refs = [], []
    for nv in model['nerves']:
        refs.append(('n', nv, len(nv['path']))); pts += nv['path']
    for key in ('path', 'filum'):
        refs.append(('c', key, len(model['cord'][key]))); pts += model['cord'][key]
    for L in model['levels']:
        for key in ('cord', 'foramen'): refs.append(('l', (L, key), 1)); pts.append(L[key])
    out = np.round(apply(np.array(pts)), 4).tolist(); o = 0
    for kind, ref, n in refs:
        seg = out[o:o + n]; o += n
        if kind == 'n': ref['path'] = seg
        elif kind == 'c': model['cord'][ref] = seg
        else: ref[0][ref[1]] = seg[0]
    return model

if __name__ == '__main__':
    M = meshes(sys.argv[1])
    model = build()
    json.dump(model, open(sys.argv[2], 'w'), separators=(',', ':'))
    print('nerves', len(model['nerves']), 'twigs', sum(n['kind'] == 'twig' for n in model['nerves']))
    if len(sys.argv) > 4:
        from warp import load_warp
        fem = warp_model(json.loads(json.dumps(model)), load_warp(sys.argv[3]))
        fem['vertebrae'] = {**{f'C{k}': f'Cervical vertebra {k}' for k in range(1, 8)}, **{f'T{k}': f'Thoracic vertebra {k}' for k in range(1, 13)},
                            **{f'L{k}': f'Lumbar vertebra {k}' for k in range(1, 6)}}
        fem['note'] += ' Carried onto the female reference with the same warp as the fitted musculoskeletal anatomy.'
        json.dump(fem, open(sys.argv[4], 'w'), separators=(',', ':'))
        print('female nerve model written')
