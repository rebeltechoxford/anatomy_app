// Leader-line labels: names (with Latin where known) for the most prominent
// visible structures, stacked in left/right columns with lines to an anchor
// point on each structure. Occluded anchors are skipped. Recomputed after the
// camera settles.
export function setupLabels({T, parts, meshes, camera, viewport, renderer, onPick, extraHidden = () => false}) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const layer = document.createElement('div'); layer.className = 'labels'; layer.hidden = true;
  const svg = document.createElementNS(svgNS, 'svg'); layer.append(svg);
  viewport.append(layer);
  const ray = new T.Raycaster(), v = new T.Vector3(), box = new T.Box3(), sphere = new T.Sphere();
  const anchors = new Map();
  let on = false, timer = 0, selected = null;

  function anchorOf(i) {
    const g = meshes[i].geometry;
    if (anchors.get(i)?.g === g) return anchors.get(i).p;
    g.boundingBox || g.computeBoundingBox();
    const c = g.boundingBox.getCenter(new T.Vector3()), pos = g.attributes.position;
    let best = null, bd = Infinity;
    const step = Math.max(1, Math.floor(pos.count / 1500));
    // prefer a surface point near the centre that faces the front of the body
    for (let k = 0; k < pos.count; k += step) {
      v.fromBufferAttribute(pos, k);
      const d = v.distanceToSquared(c) - v.z * .002;
      if (d < bd) { bd = d; best = v.clone(); }
    }
    anchors.set(i, {g, p: best});
    return best;
  }

  function update() {
    if (!on) return;
    const w = viewport.clientWidth, h = viewport.clientHeight;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.setAttribute('width', w); svg.setAttribute('height', h);
    svg.replaceChildren(); layer.querySelectorAll('.label').forEach(n => n.remove());
    const frustum = new T.Frustum().setFromProjectionMatrix(new T.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const cand = [];
    meshes.forEach((m, i) => {
      if (!m?.visible || extraHidden(i)) return;
      const g = m.geometry; g.boundingSphere || g.computeBoundingSphere();
      sphere.copy(g.boundingSphere);
      if (!frustum.intersectsSphere(sphere)) return;
      const p = anchorOf(i); if (!p) return;
      const s = p.clone().project(camera);
      if (s.z > 1 || Math.abs(s.x) > .95 || Math.abs(s.y) > .95) return;
      // apparent size in pixels
      const dist = camera.position.distanceTo(sphere.center);
      const px = sphere.radius / (dist * Math.tan(camera.fov * Math.PI / 360)) * h / 2;
      if (px < 10 && i !== selected) return;
      cand.push({i, p, x: (s.x + 1) / 2 * w, y: (1 - s.y) / 2 * h, score: (i === selected ? 1e6 : 0) + px - Math.hypot(s.x, s.y) * 40});
    });
    cand.sort((a, b) => b.score - a.score);
    const visibleMeshes = meshes.filter(m => m?.visible);
    const chosen = [];
    for (const c of cand) {
      if (chosen.length >= 14) break;
      ray.set(camera.position, c.p.clone().sub(camera.position).normalize());
      ray.far = camera.position.distanceTo(c.p) + .002;
      const hit = ray.intersectObjects(visibleMeshes, false)[0];
      if (hit && hit.object !== meshes[c.i] && hit.distance < ray.far - .004) continue;
      chosen.push(c);
    }
    // columns
    const left = chosen.filter(c => c.x < w / 2).sort((a, b) => a.y - b.y), right = chosen.filter(c => c.x >= w / 2).sort((a, b) => a.y - b.y);
    const place = (list, side) => {
      const gap = 38, top = Math.max(70, h / 2 - list.length * gap / 2);
      list.forEach((c, k) => {
        const y = Math.min(h - 30, top + k * gap), x = side === 'l' ? 12 : w - 12;
        const el = document.createElement('button'); el.className = 'label ' + side;
        const p = parts[c.i];
        el.innerHTML = '';
        const nm = document.createElement('b'); nm.textContent = p.name; el.append(nm);
        if (p.latin) { const la = document.createElement('i'); la.textContent = p.latin; el.append(la); }
        el.style.top = (y - 14) + 'px'; el.style[side === 'l' ? 'left' : 'right'] = '12px';
        if (c.i === selected) el.classList.add('sel');
        el.onclick = () => onPick(c.i);
        layer.append(el);
        const ex = side === 'l' ? Math.min(w * .32, x + el.offsetWidth + 4) : Math.max(w * .68, x - el.offsetWidth - 4);
        const line = document.createElementNS(svgNS, 'polyline');
        line.setAttribute('points', `${side === 'l' ? x + el.offsetWidth : x - el.offsetWidth},${y} ${ex},${y} ${c.x},${c.y}`);
        line.setAttribute('class', c.i === selected ? 'sel' : '');
        const dot = document.createElementNS(svgNS, 'circle'); dot.setAttribute('cx', c.x); dot.setAttribute('cy', c.y); dot.setAttribute('r', 2.6);
        svg.append(line, dot);
      });
    };
    place(left, 'l'); place(right, 'r');
  }
  return {
    get on() { return on; },
    set(v) { on = v; layer.hidden = !v; if (v) update(); },
    select(i) { selected = i; if (on) schedule(); },
    schedule,
  };
  function schedule() { if (!on) return; layer.classList.add('moving'); clearTimeout(timer); timer = setTimeout(() => { layer.classList.remove('moving'); update(); }, 260); }
}
