// Stage 3: encode smoothed (and, for the female body, fitted) meshes into the
// viewer's two geometry tiers and rewrite atlas.json.
//
//   node tools/build-tiers.mjs <body> <bundle> [<fitted bundle> <fitted.json>]
//
// A bundle is <name>.json ({counts:[[vertices, triangles], ...]}) plus
// <name>.v.bin (float32 xyz) and <name>.f.bin (uint32 triangles), written by
// tools/bundle.py from the smoothing / fitting stages.
//
// Base tier (dist/<body>/body-N.gz): meshopt simplification, 0.2% error bound,
// float32 positions, int16 normals, uint32 indices (format unchanged).
// Detail tier (dist/<body>/detail/): unsimplified, meshopt-encoded.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {MeshoptEncoder, MeshoptSimplifier} from 'meshoptimizer';

const [body, bundle, fittedBundle, fittedMeta] = process.argv.slice(2);
await MeshoptEncoder.ready; await MeshoptSimplifier.ready;
const dir = `dist/${body}`;
const atlas = JSON.parse(fs.readFileSync(`${dir}/atlas.json`, 'utf8'));
const near = JSON.parse(fs.readFileSync(`${dir}/near.json`, 'utf8'));

function readBundle(name) {
  const {counts} = JSON.parse(fs.readFileSync(name + '.json', 'utf8'));
  const v = new Float32Array(fs.readFileSync(name + '.v.bin').buffer.slice(0));
  const f = new Uint32Array(fs.readFileSync(name + '.f.bin').buffer.slice(0));
  const out = []; let vo = 0, fo = 0;
  for (const [nv, nf] of counts) { out.push({v: v.subarray(vo * 3, (vo + nv) * 3), f: f.subarray(fo * 3, (fo + nf) * 3)}); vo += nv; fo += nf; }
  return out;
}

const meshes = readBundle(bundle);
if (meshes.length !== atlas.parts.length) throw Error('bundle/atlas mismatch');
if (fittedBundle) {
  const meta = JSON.parse(fs.readFileSync(fittedMeta, 'utf8'));
  // Replace a previous fitted append, if any, so the script is re-runnable.
  const base = atlas.parts.findIndex(p => p.fitted);
  if (base >= 0) { atlas.parts.length = base; near.length = base; }
  readBundle(fittedBundle).forEach((m, k) => {
    meshes.push(m);
    atlas.parts.push({id: 'fit-' + meta[k].fittedFrom, name: meta[k].name, system: meta[k].system, conceptId: meta[k].conceptId, fitted: true});
  });
}

function normals(v, f) {
  const n = new Float32Array(v.length);
  for (let i = 0; i < f.length; i += 3) {
    const a = f[i] * 3, b = f[i + 1] * 3, c = f[i + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    for (const k of [a, b, c]) { n[k] += nx; n[k + 1] += ny; n[k + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
  return n;
}

function compact(v, n, f) {
  const [remap, count] = MeshoptEncoder.reorderMesh(f, true, true);
  const v2 = new Float32Array(count * 3), n2 = new Float32Array(count * 3);
  for (let i = 0; i < remap.length; i++) {
    const r = remap[i]; if (r === 0xffffffff) continue;
    for (let k = 0; k < 3; k++) { v2[r * 3 + k] = v[i * 3 + k]; n2[r * 3 + k] = n[i * 3 + k]; }
  }
  return {v: v2, n: n2, f, count};
}

const pad4 = x => (4 - (x % 4)) % 4;
// ---------------- base tier ----------------
for (const file of fs.readdirSync(dir)) if (/^body-\d+\.gz$/.test(file)) fs.rmSync(path.join(dir, file));
let chunk = [], chunkBytes = 0, chunkIndex = 0, baseTris = 0;
const chunkSizes = [];
function flushBase() {
  if (!chunk.length) return;
  const buffers = []; let offset = 0;
  for (const {i, m} of chunk) {
    const p = atlas.parts[i];
    const pos = Buffer.from(m.v.buffer, m.v.byteOffset, m.v.byteLength);
    const nrm = new Int16Array(m.count * 3);
    for (let k = 0; k < nrm.length; k++) nrm[k] = Math.round(Math.max(-1, Math.min(1, m.n[k])) * 32767);
    const nb = Buffer.from(nrm.buffer), ib = Buffer.from(m.f.buffer, m.f.byteOffset, m.f.byteLength);
    p.chunk = chunkIndex;
    p.positions = offset; buffers.push(pos); offset += pos.length;
    p.normals = offset; buffers.push(nb); offset += nb.length;
    const pd = pad4(offset); if (pd) { buffers.push(Buffer.alloc(pd)); offset += pd; }
    p.indices = offset; buffers.push(ib); offset += ib.length;
    p.vertexCount = m.count; p.indexCount = m.f.length;
  }
  const raw = Buffer.concat(buffers);
  fs.writeFileSync(`${dir}/body-${chunkIndex}.gz`, zlib.gzipSync(raw, {level: 9}));
  chunkSizes.push(raw.length);
  chunk = []; chunkBytes = 0; chunkIndex++;
}
// ---------------- detail tier ----------------
const detailDir = `${dir}/detail`;
fs.rmSync(detailDir, {recursive: true, force: true}); fs.mkdirSync(detailDir, {recursive: true});
const detailParts = [];

meshes.forEach((mesh, i) => {
  const p = atlas.parts[i];
  const n = normals(mesh.v, mesh.f);
  // bounds
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < mesh.v.length; k++) { const a = k % 3; lo[a] = Math.min(lo[a], mesh.v[k]); hi[a] = Math.max(hi[a], mesh.v[k]); }
  p.bounds = [lo, hi];
  // base: simplify
  const [simple] = MeshoptSimplifier.simplify(new Uint32Array(mesh.f), mesh.v, 3, 0, 0.002, []);
  const base = compact(mesh.v, n, simple.length >= 3 ? simple : new Uint32Array(mesh.f));
  baseTris += base.f.length / 3;
  chunk.push({i, m: base}); chunkBytes += base.count * 18 + base.f.length * 4;
  if (chunkBytes > 4.5e6) flushBase();
  // detail
  const d = compact(mesh.v, n, new Uint32Array(mesh.f));
  const scale = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1e-6;
  const q = new Uint16Array(d.count * 4), nq = new Int8Array(d.count * 4);
  for (let v = 0; v < d.count; v++) for (let k = 0; k < 3; k++) {
    q[v * 4 + k] = Math.round((d.v[v * 3 + k] - lo[k]) / scale * 65535);
    nq[v * 4 + k] = Math.round(d.n[v * 3 + k] * 127);
  }
  detailParts.push({index: i, count: d.count, tris: d.f.length / 3, lo, scale, center: lo.map((x, k) => (x + hi[k]) / 2), bounds: [lo, hi],
    pos: MeshoptEncoder.encodeVertexBuffer(new Uint8Array(q.buffer), d.count, 8),
    nrm: MeshoptEncoder.encodeVertexBuffer(new Uint8Array(nq.buffer), d.count, 4),
    idx: MeshoptEncoder.encodeIndexBuffer(new Uint8Array(d.f.buffer), d.f.length, 4)});
  if (i % 300 === 0) console.log(body, i, '/', meshes.length);
});
flushBase();
atlas.chunks = chunkSizes;
atlas.triangles = baseTris;

// detail chunks grouped spatially (Morton order of part centres)
const box = detailParts.reduce((b, p) => { for (let k = 0; k < 3; k++) { b[0][k] = Math.min(b[0][k], p.lo[k]); b[1][k] = Math.max(b[1][k], p.bounds[1][k]); } return b; },
  [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]]);
const morton = c => {
  const g = [0, 1, 2].map(k => Math.min(1023, Math.max(0, Math.floor((c[k] - box[0][k]) / (box[1][k] - box[0][k]) * 1024))));
  let m = 0n;
  for (let b = 9; b >= 0; b--) for (const k of [1, 0, 2]) m = (m << 1n) | BigInt((g[k] >> b) & 1);
  return m;
};
detailParts.forEach(p => p.m = morton(p.center));
detailParts.sort((a, b) => a.m < b.m ? -1 : a.m > b.m ? 1 : 0);
const manifest = {version: 2, encoding: 'meshopt', smoothing: 'Taubin', chunks: [], parts: new Array(detailParts.length)};
let group = [], size = 0, total = 0, detailTris = 0;
function flushDetail() {
  if (!group.length) return;
  const n = manifest.chunks.length, buffers = [];
  let offset = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of group) {
    const entry = {c: n, v: p.count, i: p.tris * 3, lo: p.lo.map(x => +x.toFixed(7)), s: +p.scale.toFixed(7), o: []};
    for (const b of [p.pos, p.nrm, p.idx]) {
      const pd = pad4(offset); if (pd) { buffers.push(new Uint8Array(pd)); offset += pd; }
      entry.o.push(offset, b.length); buffers.push(b); offset += b.length;
    }
    manifest.parts[p.index] = entry;
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.lo[k]); hi[k] = Math.max(hi[k], p.bounds[1][k]); }
    detailTris += p.tris;
  }
  const gz = zlib.gzipSync(Buffer.concat(buffers), {level: 9});
  fs.writeFileSync(`${detailDir}/d-${n}.gz`, gz); total += gz.length;
  manifest.chunks.push({bytes: gz.length, bounds: [lo.map(x => +x.toFixed(4)), hi.map(x => +x.toFixed(4))]});
  group = []; size = 0;
}
for (const p of detailParts) { const b = p.pos.length + p.nrm.length + p.idx.length; if (size + b > 1.6e6) flushDetail(); group.push(p); size += b; }
flushDetail();
manifest.triangles = detailTris;
fs.writeFileSync(`${detailDir}/index.json`, JSON.stringify(manifest));

// nearby-anatomy lists for appended (fitted) parts
if (near.length < atlas.parts.length) {
  const mapped = atlas.parts.map((p, i) => ['arterial', 'venous', 'nervous', 'lymphatic'].includes(p.system) ? i : -1).filter(i => i >= 0);
  const samples = meshes.map(m => { const c = m.v.length / 3, step = Math.max(1, Math.floor(c / 96)), s = []; for (let k = 0; k < c; k += step) s.push(m.v[k * 3], m.v[k * 3 + 1], m.v[k * 3 + 2]); return s; });
  const boxDist = (a, b) => Math.hypot(...[0, 1, 2].map(k => Math.max(0, a[0][k] - b[1][k], b[0][k] - a[1][k])));
  for (let i = near.length; i < atlas.parts.length; i++) {
    const cand = mapped.filter(j => j !== i).map(j => [boxDist(atlas.parts[i].bounds, atlas.parts[j].bounds), j]).sort((a, b) => a[0] - b[0]).slice(0, 25);
    const res = cand.map(([, j]) => {
      let best = Infinity; const A = samples[i], B = samples[j];
      for (let a = 0; a < A.length; a += 3) for (let b = 0; b < B.length; b += 3) {
        const d = (A[a] - B[b]) ** 2 + (A[a + 1] - B[b + 1]) ** 2 + (A[a + 2] - B[b + 2]) ** 2; if (d < best) best = d;
      }
      return [j, +(Math.sqrt(best) * 1000).toFixed(1)];
    }).sort((a, b) => a[1] - b[1]).slice(0, 3);
    near.push(res);
  }
  fs.writeFileSync(`${dir}/near.json`, JSON.stringify(near));
}
atlas.smoothing = {method: 'Taubin', lambda: 0.5, mu: -0.53};
fs.writeFileSync(`${dir}/atlas.json`, JSON.stringify(atlas));
console.log(`${body}: base ${chunkSizes.length} chunks ${baseTris.toLocaleString()} tris; detail ${manifest.chunks.length} chunks ${(total / 1e6).toFixed(1)} MB ${detailTris.toLocaleString()} tris; ${atlas.parts.length} parts`);
