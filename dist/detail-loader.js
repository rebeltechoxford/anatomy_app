// Streams the unsimplified source meshes (built by tools/build-detail.mjs)
// for regions the camera is close to, replacing the simplified base geometry
// in place. Loaded detail stays resident; a full body is ~6.7M triangles.
import {MeshoptDecoder} from './vendor/meshopt_decoder.module.js';

export async function setupDetailStreaming({T, folder, parts, meshes, camera, orbit, shown, onGeometry, onProgress}) {
  let index;
  try {
    const r = await fetch(folder + '/detail/index.json');
    if (!r.ok) return null;
    index = await r.json();
    await MeshoptDecoder.ready;
  } catch { return null; }

  const state = index.chunks.map(() => 'idle');
  const boxes = index.chunks.map(c => new T.Box3(new T.Vector3(...c.bounds[0]), new T.Vector3(...c.bounds[1])));
  const members = index.chunks.map(() => []);
  index.parts.forEach((p, i) => members[p.c].push(i));
  const frustum = new T.Frustum(), matrix = new T.Matrix4();
  const queue = new Set();
  let active = 0, timer = 0, enabled = true;

  async function load(n) {
    state[n] = 'loading'; active++; report();
    try {
      const r = await fetch(`${folder}/detail/d-${n}.gz`);
      if (!r.ok) throw Error('detail ' + n + ' ' + r.status);
      let buffer = await r.arrayBuffer();
      const head = new Uint8Array(buffer, 0, 2);
      if (head[0] === 31 && head[1] === 139)
        buffer = await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const bytes = new Uint8Array(buffer);
      for (const i of members[n]) {
        const p = index.parts[i], mesh = meshes[i];
        if (!mesh) continue;
        const q = new Uint16Array(p.v * 4);
        MeshoptDecoder.decodeVertexBuffer(new Uint8Array(q.buffer), p.v, 8, bytes.subarray(p.o[0], p.o[0] + p.o[1]));
        const nq = new Int8Array(p.v * 4);
        MeshoptDecoder.decodeVertexBuffer(new Uint8Array(nq.buffer), p.v, 4, bytes.subarray(p.o[2], p.o[2] + p.o[3]));
        const ix = new Uint32Array(p.i);
        MeshoptDecoder.decodeIndexBuffer(new Uint8Array(ix.buffer), p.i, 4, bytes.subarray(p.o[4], p.o[4] + p.o[5]));
        const pos = new Float32Array(p.v * 3), k = p.s / 65535;
        for (let v = 0; v < p.v; v++) {
          pos[v * 3] = p.lo[0] + q[v * 4] * k;
          pos[v * 3 + 1] = p.lo[1] + q[v * 4 + 1] * k;
          pos[v * 3 + 2] = p.lo[2] + q[v * 4 + 2] * k;
        }
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(pos, 3));
        g.setAttribute('normal', new T.InterleavedBufferAttribute(new T.InterleavedBuffer(nq, 4), 3, 0, true));
        g.setIndex(new T.BufferAttribute(ix, 1));
        g.computeBoundingSphere();
        onGeometry(i, g);
        const old = mesh.geometry;
        mesh.geometry = g;
        old.dispose();
      }
      state[n] = 'ready';
    } catch (e) {
      console.warn('High-detail region unavailable', e);
      state[n] = 'failed';
    }
    active--; report(); pump();
  }

  function report() {
    const ready = state.filter(s => s === 'ready').length;
    onProgress?.({ready, total: state.length, loading: active + queue.size});
  }

  function pump() {
    while (active < 2 && queue.size) {
      const n = queue.values().next().value;
      queue.delete(n);
      if (state[n] === 'idle') load(n);
    }
  }

  // Queue regions that are on screen, near the camera and hold a visible part.
  function update() {
    if (!enabled) return;
    const shownNow = shown();
    const distance = camera.position.distanceTo(orbit.target);
    if (distance > 1.3) return; // full-body framing: base tier is plenty
    matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(matrix);
    const reach = Math.max(.25, distance * .9);
    const wanted = [];
    boxes.forEach((box, n) => {
      if (state[n] !== 'idle' || queue.has(n)) return;
      if (!frustum.intersectsBox(box)) return;
      const d = box.distanceToPoint(camera.position);
      if (d > reach) return;
      if (!members[n].some(i => shownNow[i])) return;
      wanted.push([box.distanceToPoint(orbit.target), n]);
    });
    wanted.sort((a, b) => a[0] - b[0]).forEach(([, n]) => queue.add(n));
    report(); pump();
  }

  return {
    // Debounced so orbiting doesn't queue regions the camera merely passes.
    schedule() { clearTimeout(timer); timer = setTimeout(update, 220); },
    // Fetch the region holding a structure immediately (select / focus).
    want(i) { const n = index.parts[i]?.c; if (n !== undefined && state[n] === 'idle') { queue.delete(n); load(n); } },
    setEnabled(on) { enabled = on; if (on) update(); },
    triangles: index.triangles,
  };
}
