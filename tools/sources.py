"""Readers for the two source datasets, returning meshes in viewer coordinates
(metres, Y up, standing on the stage), matching dist/<body>/atlas.json order.

  male:   BodyParts3D 4.0 isa_BP3D_4.0_obj_99/<FJ id>.obj
  female: HRA united-female v1.5 GLB (meshes in file order)
"""
import json, os, struct
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def atlas(body):
    return json.load(open(os.path.join(ROOT, 'dist', body, 'atlas.json')))

def read_obj(path):
    v, n, f = [], [], []
    for line in open(path):
        if line.startswith('v '):
            x, y, z = map(float, line.split()[1:4]); v.append((x / 1000, z / 1000 + 0.0781112, -y / 1000 - 0.1))
        elif line.startswith('vn '):
            x, y, z = map(float, line.split()[1:4]); n.append((x, z, -y))
        elif line.startswith('f '):
            idx = [int(t.split('/')[0]) - 1 for t in line.split()[1:]]
            for k in range(1, len(idx) - 1): f.append((idx[0], idx[k], idx[k + 1]))
    return np.array(v, np.float64), np.array(f, np.int64)

class Glb:
    def __init__(self, path):
        d = open(path, 'rb').read()
        l = struct.unpack('<I', d[12:16])[0]
        self.j = json.loads(d[20:20 + l]); self.bin = memoryview(d)[20 + l + 8:]
    def acc(self, i):
        a = self.j['accessors'][i]; bv = self.j['bufferViews'][a['bufferView']]
        comps = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[a['type']]
        dt = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}[a['componentType']]
        off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        return np.frombuffer(self.bin[off: off + a['count'] * comps * np.dtype(dt).itemsize], dt).reshape(-1, comps) if comps > 1 else \
               np.frombuffer(self.bin[off: off + a['count'] * np.dtype(dt).itemsize], dt)
    def mesh(self, i):
        vs, fs, base = [], [], 0
        for prim in self.j['meshes'][i]['primitives']:
            p = self.acc(prim['attributes']['POSITION']).astype(np.float64)
            ind = self.acc(prim['indices']).astype(np.int64) if 'indices' in prim else np.arange(len(p))
            vs.append(p); fs.append(ind.reshape(-1, 3) + base); base += len(p)
        v = np.concatenate(vs); v[:, 1] += 0.795
        f = np.concatenate(fs)
        # weld coincident vertices
        u, inv = np.unique(v, axis=0, return_inverse=True)
        f = inv.reshape(-1)[f]
        f = f[(f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])]
        return u, f

def loader(body, source):
    parts = atlas(body)['parts']
    if body == 'models':
        return lambda i: read_obj(os.path.join(source, parts[i]['id'] + '.obj'))
    g = Glb(source)
    return g.mesh
