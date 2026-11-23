"""Stage 1: load every source mesh, Taubin-smooth it and cache the result.

Taubin (lambda|mu) smoothing removes the stair-step and faceting noise left by
MRI segmentation without the shrinkage of plain Laplacian smoothing, so the
surfaces read as natural tissue while keeping their size and landmarks.

  python3 tools/smooth.py models <obj dir>  <cache.npz>
  python3 tools/smooth.py female <glb file> <cache.npz>
"""
import sys
import numpy as np
import scipy.sparse as sp
from sources import atlas, loader

LAMBDA, MU = 0.5, -0.53

def taubin(v, f, iterations):
    n = len(v)
    if n < 8 or iterations <= 0:
        return v
    i = np.concatenate([f[:, 0], f[:, 1], f[:, 2], f[:, 1], f[:, 2], f[:, 0]])
    j = np.concatenate([f[:, 1], f[:, 2], f[:, 0], f[:, 0], f[:, 1], f[:, 2]])
    a = sp.coo_matrix((np.ones(len(i)), (i, j)), shape=(n, n)).tocsr()
    a.data[:] = 1.0
    deg = np.asarray(a.sum(1)).ravel()
    deg[deg == 0] = 1
    w = sp.diags(1 / deg) @ a  # uniform umbrella operator
    # Boundary vertices (open meshes) stay fixed so edges don't curl in.
    e = np.sort(np.stack([np.concatenate([f[:, 0], f[:, 1], f[:, 2]]), np.concatenate([f[:, 1], f[:, 2], f[:, 0]])], 1), 1)
    _, inv, cnt = np.unique(e, axis=0, return_inverse=True, return_counts=True)
    boundary = np.zeros(n, bool)
    be = e[cnt[inv.ravel()] == 1]
    boundary[be.ravel()] = True
    keep = (~boundary)[:, None]
    for _ in range(iterations):
        for k in (LAMBDA, MU):
            v = v + k * (w @ v - v) * keep
    return v

def main(body, source, out):
    parts = atlas(body)['parts']
    load = loader(body, source)
    iters = 8 if body == 'models' else 4  # HRA meshes are already fairly smooth
    vs, fs = [], []
    for i in range(len(parts)):
        v, f = load(i)
        # drop unreferenced vertices
        used = np.unique(f)
        remap = np.full(len(v), -1); remap[used] = np.arange(len(used))
        v, f = v[used], remap[f]
        vs.append(taubin(v, f, iters).astype(np.float32)); fs.append(f.astype(np.uint32))
        if i % 200 == 0: print(body, i, len(parts), flush=True)
    np.savez(out, counts=np.array([[len(v), len(f)] for v, f in zip(vs, fs)]),
             v=np.concatenate(vs), f=np.concatenate(fs))
    print('saved', out, sum(len(f) for f in fs), 'triangles')

if __name__ == '__main__':
    main(*sys.argv[1:4])
