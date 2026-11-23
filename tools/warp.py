"""Rebuild the male->female warp saved by fit_female.py so other models (the
generated nerve system, dermatome labels) can be carried onto the female body."""
import numpy as np
from scipy.spatial import cKDTree

NAMES = ['torso', 'left:upper', 'left:fore', 'right:upper', 'right:fore']

def _procrustes(a, b):
    ca, cb = a.mean(0), b.mean(0)
    A, B = a - ca, b - cb
    u, s, vt = np.linalg.svd(A.T @ B)
    d = np.sign(np.linalg.det(u @ vt)); D = np.diag([1, 1, d]); R = (u @ D @ vt).T
    scale = (s * np.diag(D)).sum() / (A ** 2).sum()
    return lambda x: (x - ca) @ R.T * scale + cb

def _gauss(x, c, sig):
    x = x.astype(np.float32); c = c.astype(np.float32)
    d2 = (x * x).sum(1)[:, None] + (c * c).sum(1)[None] - 2 * x @ c.T
    return np.exp(-np.maximum(d2, 0) / np.float32(2 * sig * sig))

def load_warp(path):
    d = np.load(path, allow_pickle=True)
    sim = _procrustes(d['sim_src'], d['sim_dst'])
    tree, lab = cKDTree(d['bone_pts']), d['bone_lab']
    tf = [(t[:9].reshape(3, 3), t[9:]) for t in d['transforms']]
    def lbs(x, sigma=.018):
        dist, j = tree.query(x, k=24)
        w = np.zeros((len(x), len(NAMES)))
        for g in range(len(NAMES)):
            w[:, g] = np.exp(-(np.where(lab[j] == g, dist, np.inf).min(1) ** 2) / (2 * sigma ** 2))
        w[w.sum(1) == 0, 0] = 1
        w /= w.sum(1, keepdims=True)
        return sum(w[:, g:g + 1] * (x @ R.T + t) for g, (R, t) in enumerate(tf))
    fields = list(zip(d['field_c'], d['field_w'], d['field_s']))
    def apply(x):
        x = lbs(sim(np.asarray(x, np.float64)))
        for c, W, s in fields:
            out = x.copy()
            for k in range(0, len(x), 50000):
                out[k:k + 50000] += _gauss(x[k:k + 50000], c, s) @ W.astype(np.float32)
            x = out
        return x
    return apply
