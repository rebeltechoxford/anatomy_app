// Convert Z-Anatomy FBX exports (CC BY-SA 4.0) into a raw mesh bundle:
//   <out>.json {counts, meta:[{name, side, file, system}]}, <out>.v.bin, <out>.f.bin
// Coordinates: FBX world space (cm, Y up) -> metres; alignment to the
// BodyParts3D frame is applied later (tools/za_align.py).
//   node tools/zanatomy.mjs <fbx dir> <out prefix>
import fs from 'node:fs';
import path from 'node:path';
globalThis.self = globalThis; globalThis.window = globalThis;
globalThis.document = {createElementNS: () => ({style: {}}), createElement: () => ({style: {}, getContext: () => null})};
const T = await import('three');
const {FBXLoader} = await import('three/examples/jsm/loaders/FBXLoader.js');
const [dir, out] = process.argv.slice(2);
const FILES = ['SkeletalSystem100', 'Joints100', 'MuscularSystem100', 'NervousSystem100', 'CardioVascular41', 'VisceralSystem100', 'LymphoidOrgans100'];
const counts = [], meta = [], vs = [], fs_ = [];
let vtotal = 0, ftotal = 0;
for (const f of FILES) {
  const buf = fs.readFileSync(path.join(dir, f + '.fbx'));
  const warn = console.warn; console.warn = () => {};
  const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  console.warn = warn;
  root.updateMatrixWorld(true);
  let n = 0;
  root.traverse(o => {
    if (!o.isMesh) return;
    const g = o.geometry, pos = g.attributes.position;
    const index = g.index ? g.index.array : Uint32Array.from({length: pos.count}, (_, i) => i);
    if (index.length / 3 <= 12 || /^Cross_Section/.test(o.name)) return; // group placeholders / helpers
    const v = new Float32Array(pos.count * 3), p = new T.Vector3();
    for (let i = 0; i < pos.count; i++) { p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); v[i * 3] = p.x / 100; v[i * 3 + 1] = p.y / 100; v[i * 3 + 2] = p.z / 100; }
    vs.push(v); fs_.push(Uint32Array.from(index));
    counts.push([pos.count, index.length / 3]);
    meta.push({raw: o.name, file: f});
    n++;
  });
  console.log(f, n, 'meshes');
}
fs.writeFileSync(out + '.json', JSON.stringify({counts, meta}));
const vb = fs.openSync(out + '.v.bin', 'w'); for (const v of vs) fs.writeSync(vb, Buffer.from(v.buffer)); fs.closeSync(vb);
const fb = fs.openSync(out + '.f.bin', 'w'); for (const f of fs_) fs.writeSync(fb, Buffer.from(f.buffer)); fs.closeSync(fb);
console.log('total meshes', counts.length, 'triangles', counts.reduce((a, c) => a + c[1], 0));
