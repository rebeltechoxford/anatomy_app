// Family "patient" profiles with 3D markup: pins and freehand strokes drawn on
// any structure, each with notes. Everything is plain JSON kept in this
// browser's localStorage and exportable/importable as a raw .json file.
// Not encrypted or access-controlled by design (personal/family use).

const KEY = 'forma.patients.v1';
const PALETTE = ['#ff5d5d', '#ffb02e', '#ffe14d', '#4cd97b', '#3fb6ff', '#b07cff', '#ffffff'];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const now = () => new Date().toISOString();

export function setupMarkup({T, scene, parts, folder, invalidate, onFocus}) {
  let db = load();
  const group = new T.Group(); group.name = 'Patient markup'; scene.add(group);
  let tool = 'none', color = PALETTE[0], stroke = null, listeners = [];

  function load() {
    try { const d = JSON.parse(localStorage.getItem(KEY)); if (d && Array.isArray(d.patients)) return d; } catch {}
    return {format: 'forma-patients', version: 1, patients: [], activeId: null};
  }
  function save() {
    db.savedAt = now();
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { console.warn('Could not save to browser storage', e); }
    listeners.forEach(f => f());
  }
  const active = () => db.patients.find(p => p.id === db.activeId) || null;

  // ---------- rendering
  function render() {
    group.children.slice().forEach(c => { c.geometry?.dispose(); group.remove(c); });
    const p = active();
    if (!p) { invalidate(); return; }
    p.annotations.filter(a => a.body === folder).forEach((a, n) => {
      const mat = new T.MeshBasicMaterial({color: a.color, toneMapped: false});
      if (a.type === 'pin') {
        const pt = new T.Vector3(...a.points[0]), nrm = new T.Vector3(...(a.normal || [0, 0, 1]));
        const head = new T.Mesh(new T.SphereGeometry(.0035, 14, 10), mat); head.position.copy(pt).addScaledVector(nrm, .012);
        const stem = new T.Mesh(new T.CylinderGeometry(.0006, .0006, .012, 6), mat);
        stem.position.copy(pt).addScaledVector(nrm, .006); stem.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), nrm);
        head.userData.annotation = stem.userData.annotation = a.id;
        group.add(head, stem);
      } else if (a.type === 'stroke' && a.points.length > 1) {
        const curve = new T.CatmullRomCurve3(a.points.map(q => new T.Vector3(...q)));
        const tube = new T.Mesh(new T.TubeGeometry(curve, Math.min(800, a.points.length * 3), .0009, 5, false), mat);
        tube.userData.annotation = a.id; group.add(tube);
      } else if (a.type === 'stim') {
        a.stim?.electrodes?.forEach((e, i) => { if (!e) return; const s = new T.Mesh(new T.SphereGeometry(.004, 12, 8), new T.MeshBasicMaterial({color: i ? '#3d8bff' : '#ff4040', toneMapped: false}));
          s.position.set(...e.point); s.userData.annotation = a.id; group.add(s); });
      }
    });
    invalidate();
  }

  // ---------- pointer interaction (called by the app with raycast hits)
  function pointerDown(hit) {
    const p = active(); if (!p || !hit || tool === 'none') return false;
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new T.Vector3(0, 0, 1);
    const part = hit.object.userData.index ?? null;
    if (tool === 'pin') {
      const a = {id: uid(), type: 'pin', body: folder, part, partName: part != null ? parts[part].name : (hit.object.userData.nerve?.name || ''), points: [hit.point.toArray().map(r4)],
        normal: n.toArray().map(r4), color, note: '', createdAt: now()};
      p.annotations.push(a); p.updatedAt = now(); save(); render();
      listeners.forEach(f => f(a.id));
      return true;
    }
    if (tool === 'draw') {
      stroke = {id: uid(), type: 'stroke', body: folder, part, partName: part != null ? parts[part].name : '', points: [lift(hit, n)], color, note: '', createdAt: now()};
      return true;
    }
    return false;
  }
  function pointerMove(hit) {
    if (!stroke || !hit) return;
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new T.Vector3(0, 0, 1);
    const q = lift(hit, n), last = stroke.points[stroke.points.length - 1];
    if (Math.hypot(q[0] - last[0], q[1] - last[1], q[2] - last[2]) < .0015) return;
    stroke.points.push(q);
    if (stroke.points.length % 4 === 0) { preview(); }
  }
  let previewMesh = null;
  function preview() {
    if (previewMesh) { previewMesh.geometry.dispose(); group.remove(previewMesh); previewMesh = null; }
    if (!stroke || stroke.points.length < 2) return;
    previewMesh = new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(stroke.points.map(q => new T.Vector3(...q))), stroke.points.length * 2, .0009, 5, false),
      new T.MeshBasicMaterial({color: stroke.color, toneMapped: false}));
    group.add(previewMesh); invalidate();
  }
  function pointerUp() {
    if (!stroke) return false;
    const p = active();
    if (p && stroke.points.length > 1) { p.annotations.push(stroke); p.updatedAt = now(); save(); listeners.forEach(f => f(stroke.id)); }
    stroke = null; previewMesh = null; render();
    return true;
  }
  const r4 = x => +x.toFixed(5);
  const lift = (hit, n) => hit.point.clone().addScaledVector(n, .0008).toArray().map(r4);

  // ---------- data operations
  function addPatient(fields = {}) {
    const p = {id: uid(), name: fields.name || 'New person', relation: fields.relation || '', dob: fields.dob || '', body: fields.body || folder,
      notes: fields.notes || '', createdAt: now(), updatedAt: now(), annotations: []};
    db.patients.push(p); db.activeId = p.id; save(); render(); return p;
  }
  function exportJSON(all = true) {
    const data = all ? db : {format: 'forma-patients', version: 1, patients: [active()].filter(Boolean)};
    const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const p = active();
    a.download = all ? `forma-patients-${new Date().toISOString().slice(0, 10)}.json` : `${(p?.name || 'patient').replace(/[^\w-]+/g, '_')}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function importJSON(text) {
    const data = JSON.parse(text);
    const incoming = Array.isArray(data) ? data : data.patients || (data.annotations ? [data] : []);
    let added = 0, updated = 0;
    for (const p of incoming) {
      if (!p || typeof p !== 'object') continue;
      p.id = String(p.id || uid()); p.annotations = Array.isArray(p.annotations) ? p.annotations.filter(a => a && Array.isArray(a.points)) : [];
      // imported files are untrusted: keep colours to plain hex values
      p.annotations.forEach(a => { if (!/^#[0-9a-f]{3,8}$/i.test(a.color || '')) a.color = PALETTE[0]; a.id = String(a.id || uid()); });
      const i = db.patients.findIndex(x => x.id === p.id);
      if (i >= 0) { db.patients[i] = p; updated++; } else { db.patients.push(p); added++; }
    }
    if (!db.activeId && db.patients.length) db.activeId = db.patients[0].id;
    save(); render();
    return {added, updated};
  }

  return {
    get db() { return db; }, active, render, save, addPatient, exportJSON, importJSON, PALETTE,
    get tool() { return tool; }, setTool(t) { tool = t; listeners.forEach(f => f()); },
    get color() { return color; }, setColor(c) { color = c; },
    get drawing() { return !!stroke; },
    pointerDown, pointerMove, pointerUp,
    select(id) { db.activeId = id; save(); render(); },
    update(fields) { const p = active(); if (!p) return; Object.assign(p, fields, {updatedAt: now()}); save(); },
    remove() { db.patients = db.patients.filter(p => p.id !== db.activeId); db.activeId = db.patients[0]?.id || null; save(); render(); },
    annotate(id, fields) { const p = active(); const a = p?.annotations.find(x => x.id === id); if (a) { Object.assign(a, fields); p.updatedAt = now(); save(); render(); } },
    removeAnnotation(id) { const p = active(); if (!p) return; p.annotations = p.annotations.filter(a => a.id !== id); p.updatedAt = now(); save(); render(); },
    addStim(snapshot) {
      const p = active(); if (!p) return null;
      const a = {id: uid(), type: 'stim', body: folder, partName: snapshot.electrodes.map(e => e?.structure).filter(Boolean).join(' ↔ '), points: snapshot.electrodes.filter(Boolean).map(e => e.point),
        color: '#ff4040', note: '', stim: snapshot, createdAt: now()};
      p.annotations.push(a); p.updatedAt = now(); save(); render(); return a;
    },
    focus(id) { const a = active()?.annotations.find(x => x.id === id); if (a) onFocus?.(a); },
    onChange(f) { listeners.push(f); },
    setVisible(on) { group.visible = on; invalidate(); },
  };
}
