// Builds the on-demand high-detail mesh tier for the male BodyParts3D model.
//
// The base tier in dist/models/body-*.gz was simplified to ~34% of the source
// triangles. This script packs the *unsimplified* source OBJs, compressed with
// meshoptimizer's vertex/index codecs, into spatially grouped chunks that the
// viewer streams in when the camera moves close to a region.
//
// Usage:
//   node tools/build-detail.mjs models <dir with isa_BP3D_4.0_obj_99/*.obj>
//   node tools/build-detail.mjs female <3d-vh-f-united.glb>
// Requires `npm i meshoptimizer@0.21.0` somewhere on NODE_PATH.
//
// Coordinate transform (fitted exactly against the shipped atlas bounds):
//   male:   X = x/1000,  Y = z/1000 + 0.0781112,  Z = -y/1000 - 0.1   (mm Z-up -> m Y-up)
//   female: HRA v1.5 GLB meshes in file order, translated Y + 0.795 (already m Y-up).
//           Coincident vertices are welded and their normals averaged, as in the base tier.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {MeshoptEncoder} from 'meshoptimizer';

const [body, source] = process.argv.slice(2);
if (!['models', 'female'].includes(body) || !source) { console.error('usage: build-detail.mjs models|female <source>'); process.exit(1); }
const outDir = `dist/${body}/detail`;
const atlas = JSON.parse(fs.readFileSync(`dist/${body}/atlas.json`, 'utf8'));
const CHUNK_BYTES = 1.6e6;
await MeshoptEncoder.ready;

function readObj(file) {
  const text = fs.readFileSync(file, 'utf8');
  const v = [], n = [], f = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) { const [, x, y, z] = line.trim().split(/\s+/); v.push(+x / 1000, +z / 1000 + 0.0781112, -y / 1000 - 0.1); }
    else if (line.startsWith('vn ')) { const [, x, y, z] = line.trim().split(/\s+/); n.push(+x, +z, -y); }
    else if (line.startsWith('f ')) {
      const idx = line.trim().split(/\s+/).slice(1).map(t => parseInt(t, 10) - 1);
      for (let k = 1; k + 1 < idx.length; k++) f.push(idx[0], idx[k], idx[k + 1]);
    }
  }
  return {v: new Float32Array(v), n: n.length === v.length ? new Float32Array(n) : null, f: new Uint32Array(f)};
}

function glbReader(file) {
  const d = fs.readFileSync(file);
  const jsonLength = d.readUInt32LE(12);
  const json = JSON.parse(d.subarray(20, 20 + jsonLength).toString('utf8'));
  const bin = d.subarray(20 + jsonLength + 8);
  const read = (id, Type) => {
    const a = json.accessors[id], view = json.bufferViews[a.bufferView];
    const comps = {SCALAR: 1, VEC3: 3, VEC4: 4}[a.type];
    const Src = {5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array}[a.componentType];
    if (view.byteStride && view.byteStride !== comps * Src.BYTES_PER_ELEMENT) throw Error('interleaved accessor');
    const start = bin.byteOffset + (view.byteOffset || 0) + (a.byteOffset || 0);
    const raw = new Src(bin.buffer.slice(start, start + a.count * comps * Src.BYTES_PER_ELEMENT));
    return Type ? Type.from(raw) : raw;
  };
  return index => {
    const v = [], n = [], f = [];
    for (const prim of json.meshes[index].primitives) {
      const base = v.length / 3;
      const pos = read(prim.attributes.POSITION), nor = prim.attributes.NORMAL !== undefined ? read(prim.attributes.NORMAL) : null;
      const ind = prim.indices !== undefined ? read(prim.indices, Uint32Array) : Uint32Array.from({length: pos.length / 3}, (_, i) => i);
      for (let i = 0; i < pos.length; i += 3) { v.push(pos[i], pos[i + 1] + 0.795, pos[i + 2]); n.push(nor ? nor[i] : 0, nor ? nor[i + 1] : 0, nor ? nor[i + 2] : 0); }
      for (const i of ind) f.push(i + base);
    }
    // Weld coincident vertices, averaging their normals.
    const key = new Map(), remap = new Uint32Array(v.length / 3), wv = [], wn = [];
    const bits = new Uint32Array(new Float32Array(v).buffer);
    for (let i = 0; i < remap.length; i++) {
      const k = bits[i * 3] + ',' + bits[i * 3 + 1] + ',' + bits[i * 3 + 2];
      let r = key.get(k);
      if (r === undefined) { r = wv.length / 3; key.set(k, r); wv.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]); wn.push(0, 0, 0); }
      for (let c = 0; c < 3; c++) wn[r * 3 + c] += n[i * 3 + c];
      remap[i] = r;
    }
    const wf = [];
    for (let i = 0; i < f.length; i += 3) {
      const a = remap[f[i]], b = remap[f[i + 1]], c = remap[f[i + 2]];
      if (a !== b && b !== c && a !== c) wf.push(a, b, c);
    }
    const normals = new Float32Array(wn);
    const hasNormals = wn.some(x => x !== 0);
    return {v: new Float32Array(wv), n: hasNormals ? normals : null, f: new Uint32Array(wf)};
  };
}

function computeNormals(v, f) {
  const n = new Float32Array(v.length);
  for (let i = 0; i < f.length; i += 3) {
    const a = f[i] * 3, b = f[i + 1] * 3, c = f[i + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    for (const k of [a, b, c]) { n[k] += nx; n[k + 1] += ny; n[k + 2] += nz; }
  }
  return n;
}

const load = body === 'models' ? p => readObj(path.join(source, p.id + '.obj')) : ((read) => (p, i) => read(i))(glbReader(source));
const parts = [];
atlas.parts.forEach((p, index) => {
  const mesh = load(p, index);
  let normals = mesh.n || computeNormals(mesh.v, mesh.f);
  // Cache/fetch-order the mesh (in place on the indices): renders faster and
  // compresses better. Unreferenced vertices are dropped by the remap.
  const [remap, count] = MeshoptEncoder.reorderMesh(mesh.f, true, true);
  const v = new Float32Array(count * 3), nn = new Float32Array(count * 3);
  for (let i = 0; i < remap.length; i++) {
    const r = remap[i];
    if (r === 0xffffffff) continue;
    for (let k = 0; k < 3; k++) { v[r * 3 + k] = mesh.v[i * 3 + k]; nn[r * 3 + k] = normals[i * 3 + k]; }
  }
  mesh.v = v; normals = nn;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.v.length; i++) { const k = i % 3; lo[k] = Math.min(lo[k], mesh.v[i]); hi[k] = Math.max(hi[k], mesh.v[i]); }
  const scale = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1e-6;
  // Positions: uint16 x4 quantised on the part's largest extent (skin: 28 µm steps).
  const q = new Uint16Array(count * 4);
  for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) q[i * 4 + k] = Math.round((mesh.v[i * 3 + k] - lo[k]) / scale * 65535);
  // Normals: int8 x4 (snorm), normalised first.
  const nq = new Int8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const x = normals[i * 3], y = normals[i * 3 + 1], z = normals[i * 3 + 2], l = Math.hypot(x, y, z) || 1;
    nq[i * 4] = Math.round(x / l * 127); nq[i * 4 + 1] = Math.round(y / l * 127); nq[i * 4 + 2] = Math.round(z / l * 127);
  }
  const pos = MeshoptEncoder.encodeVertexBuffer(new Uint8Array(q.buffer), count, 8);
  const nrm = MeshoptEncoder.encodeVertexBuffer(new Uint8Array(nq.buffer), count, 4);
  const idx = MeshoptEncoder.encodeIndexBuffer(new Uint8Array(mesh.f.buffer), mesh.f.length, 4);
  const center = [0, 1, 2].map(k => (lo[k] + hi[k]) / 2);
  parts.push({index, count, tris: mesh.f.length / 3, lo, scale, pos, nrm, idx, center, bytes: pos.length + nrm.length + idx.length,
    bounds: [lo, hi], baseTris: p.indexCount / 3});
});

// Spatial ordering (Morton code of the part centre) so a chunk covers a compact region.
const box = atlas.parts.reduce((b, p) => { for (let k = 0; k < 3; k++) { b[0][k] = Math.min(b[0][k], p.bounds[0][k]); b[1][k] = Math.max(b[1][k], p.bounds[1][k]); } return b; },
  [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]]);
const morton = c => {
  const g = [0, 1, 2].map(k => Math.min(1023, Math.max(0, Math.floor((c[k] - box[0][k]) / (box[1][k] - box[0][k]) * 1024))));
  let m = 0n;
  for (let b = 9; b >= 0; b--) for (const k of [1, 0, 2]) m = (m << 1n) | BigInt((g[k] >> b) & 1);
  return m;
};
const ordered = parts.slice().sort((a, b) => { const d = morton(a.center) - morton(b.center); return d < 0n ? -1 : d > 0n ? 1 : 0; });

fs.rmSync(outDir, {recursive: true, force: true});
fs.mkdirSync(outDir, {recursive: true});
const manifest = {version: 1, source: body === 'models' ? 'BodyParts3D 4.0 isa_BP3D_4.0_obj_99 (unsimplified)' : 'HRA united-female v1.5 GLB (unsimplified, welded)', encoding: 'meshopt', chunks: [], parts: new Array(parts.length)};
let group = [], size = 0, total = 0, triangles = 0;
function flush() {
  if (!group.length) return;
  const n = manifest.chunks.length, buffers = [];
  let offset = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of group) {
    const entry = {c: n, v: p.count, i: p.tris * 3, lo: p.lo.map(x => +x.toFixed(7)), s: +p.scale.toFixed(7), o: []};
    for (const b of [p.pos, p.nrm, p.idx]) {
      const pad = (4 - (offset % 4)) % 4;
      if (pad) { buffers.push(new Uint8Array(pad)); offset += pad; }
      entry.o.push(offset, b.length); buffers.push(b); offset += b.length;
    }
    manifest.parts[p.index] = entry;
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.bounds[0][k]); hi[k] = Math.max(hi[k], p.bounds[1][k]); }
    triangles += p.tris;
  }
  const gz = zlib.gzipSync(Buffer.concat(buffers), {level: 9});
  fs.writeFileSync(path.join(outDir, `d-${n}.gz`), gz);
  total += gz.length;
  manifest.chunks.push({bytes: gz.length, bounds: [lo.map(x => +x.toFixed(4)), hi.map(x => +x.toFixed(4))]});
  group = []; size = 0;
}
for (const p of ordered) { if (size + p.bytes > CHUNK_BYTES) flush(); group.push(p); size += p.bytes; }
flush();
manifest.triangles = triangles;
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(manifest));
console.log(`${manifest.chunks.length} chunks, ${(total / 1e6).toFixed(1)} MB, ${triangles.toLocaleString()} triangles`);
