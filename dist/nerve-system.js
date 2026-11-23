// Modeled nervous-system wiring: spinal cord, 31 pairs of roots exiting their
// foramina, plexuses, peripheral and cranial nerves with branches into each
// innervated muscle (tools/nerves.py), plus a pathway tracer that follows a
// signal from a muscle / skin level / nerve through the spinal segment and
// the brainstem up to the somatotopic spot on the cortex.

const COLORS = {root: '#e8d690', spinal: '#efd88a', ramus: '#d9c27c', plexus: '#f2cf6c', peripheral: '#f0d27a', cutaneous: '#cfe3a8', twig: '#f0c46a', cranial: '#e9d38c'};
// Neighbouring levels get well-separated hues (golden-ratio walk) so bands read clearly.
export const DERM_COLORS = Array.from({length: 34}, (_, i) => {
  const h = (i * 0.618034 + .05) % 1, l = i % 2 ? 58 : 48;
  return `hsl(${Math.round(h * 360)}, 72%, ${l}%)`;
});
const REGION_S = {foot: .03, leg: .12, trunk: .3, arm: .42, hand: .55, face: .78, larynx: .9};
const CORD_OF = {musculocutaneous: ['lateral'], median: ['lateral', 'medial'], ulnar: ['medial'], radial: ['posterior'], axillary: ['posterior'],
  'lateral-pectoral': ['lateral'], 'medial-pectoral': ['medial'], subscapular: ['posterior'], thoracodorsal: ['posterior'], 'medial-antebrachial-cutaneous': ['medial']};

export async function setupNerves({T, folder, parts, meshes, scene, tissues, invalidate}) {
  const [model, dermMeta] = await Promise.all([fetch(folder + '/nerves.json').then(r => r.json()), fetch(folder + '/dermatomes.json').then(r => r.json())]);
  const dermGrid = new Uint8Array(await fetch(folder + '/dermatomes.bin').then(r => r.arrayBuffer()));
  const byId = new Map(model.nerves.map(n => [n.id, n]));
  const children = new Map();
  model.nerves.forEach(n => { if (n.parent) { if (!children.has(n.parent)) children.set(n.parent, []); children.get(n.parent).push(n); } });
  const nameIndex = new Map();
  parts.forEach((p, i) => { if (!nameIndex.has(p.name)) nameIndex.set(p.name, []); nameIndex.get(p.name).push(i); });
  const levelInfo = new Map(model.levels.map(l => [l.id, l]));
  const LEVELS = model.levels.map(l => l.id);

  // ---------------------------------------------------------------- geometry
  const group = new T.Group(); group.name = 'Modeled nerves'; group.visible = false; scene.add(group);
  const nerveMat = tissues.get('nerve'), rootMat = tissues.get('nerve'), cordMat = tissues.get('cord');
  const tubes = [];
  const v3 = a => new T.Vector3(a[0], a[1], a[2]);
  for (const n of model.nerves) {
    if (n.path.length < 2) continue;
    const curve = new T.CatmullRomCurve3(n.path.map(v3));
    const geo = new T.TubeGeometry(curve, Math.max(4, n.path.length * 2), n.r, n.r > .0015 ? 8 : 5, false);
    const mesh = new T.Mesh(geo, n.kind === 'root' ? rootMat : nerveMat);
    mesh.userData.nerve = n; mesh.name = n.name;
    group.add(mesh); tubes.push(mesh);
  }
  const hasCordMeshes = parts.some(p => /spinal cord/i.test(p.name));
  if (!hasCordMeshes) {
    const cord = new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(model.cord.path.map(v3)), 200, model.cord.r, 12, false), cordMat);
    cord.userData.nerve = {id: 'cord', name: 'Spinal cord (modeled)', kind: 'cord', segments: LEVELS, skin: '', targets: [], muscles: [], fibers: 'mixed'};
    const filum = new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(model.cord.filum.map(v3)), 40, .0008, 5, false), cordMat);
    filum.userData.nerve = {id: 'filum', name: 'Filum terminale', kind: 'cord', segments: [], skin: '', targets: [], muscles: []};
    group.add(cord, filum); tubes.push(cord, filum);
  }

  // ---------------------------------------------------------------- landmarks
  const tmp = new T.Vector3();
  function verts(name, side) {
    const out = [];
    for (const i of nameIndex.get(name) || []) {
      const p = meshes[i]?.geometry.attributes.position; if (!p) continue;
      const step = Math.max(1, Math.floor(p.count / 1500));
      for (let k = 0; k < p.count; k += step) {
        tmp.fromBufferAttribute(p, k);
        if (side && Math.sign(tmp.x) !== side) continue;
        out.push(tmp.clone());
      }
    }
    return out;
  }
  const mean = vs => vs.reduce((a, v) => a.add(v), new T.Vector3()).multiplyScalar(1 / Math.max(1, vs.length));
  const extreme = (vs, d) => vs.reduce((b, v) => (v.dot(d) > b.dot(d) ? v : b), vs[0]);
  const S = side => side > 0 ? 'Left' : 'Right';
  const female = folder === 'female';
  function brain(side) {
    const s = S(side), q = (n, sd = side) => { const v = verts(n, sd); return v.length ? v : null; };
    const L = female ? {
      pre: q(`${s} Allen precentral gyrus`), post: q(`${s} Allen postcentral gyrus`), thal: q(`${s} Allen thalamus`), put: q(`${s} Allen putamen`),
      vpl: q(`${s} Allen ventral posterior lateral nucleus`), vpm: q(`${s} Allen ventral posterior medial nucleus`), ped: q(`${s} Allen cerebral peduncle crus cerebri`),
      pons: q(`${s} Allen basilar part of pons`), pyr: q(`${s} Allen pyramidal part of medulla oblongata`), medteg: q(`${s} Allen tegmentum of medulla oblongata`),
      ponsteg: q(`${s} Allen pontine tegmentum`), midteg: q(`${s} Allen midbrain tegmentum`)}
    : {pre: q(`${s} precentral gyrus`, 0), post: q(`${s} postcentral gyrus`, 0), thal: q(`${s} thalamus`, 0), ic: q(`${s} internal capsule`, 0),
       ped: q('Peduncle of midbrain'), pons: q('Pons'), med: q('Medulla oblongata'), mid: q('Midbrain')};
    const c = p => p && mean(p);
    const ic = L.ic ? c(L.ic) : (L.thal && L.put ? c(L.thal).lerp(c(L.put), .5) : null);
    const thal = L.vpl ? c(L.vpl) : L.thal && extreme(L.thal, new T.Vector3(side * .5, -.3, -.6).normalize());
    const med = L.pyr || L.med, pons = L.pons, mid = L.ped || L.mid;
    return {pre: L.pre, post: L.post, ic, thal, vpm: L.vpm ? c(L.vpm) : thal,
      ped: mid && extreme(mid, new T.Vector3(side * .4, -.2, 1).normalize()),
      pons: pons && extreme(pons, new T.Vector3(side * .3, 0, 1).normalize()),
      pyr: med && extreme(med, new T.Vector3(side * .3, .2, 1).normalize()),
      medLow: med && extreme(med, new T.Vector3(0, -1, 0)),
      medDorsal: (L.medteg || med) && extreme(L.medteg || med, new T.Vector3(side * .2, -.2, -1).normalize()),
      lemniscus: [L.ponsteg || pons, L.midteg || mid].filter(Boolean).map(p => mean(p))};
  }
  const brains = {1: null, '-1': null};
  const brainOf = side => (brains[side] ||= brain(side));
  // somatotopic point on a gyrus: 0 = top/medial (foot) ... 1 = low lateral (face, larynx)
  function somatotopic(gyrus, side, s) {
    if (!gyrus?.length) return null;
    const c = mean(verts(female ? `${S(side)} Allen thalamus` : `${S(side)} thalamus`, female ? side : 0));
    const phi = gyrus.map(v => Math.atan2(Math.abs(v.x - c.x), v.y - c.y));
    const lo = Math.min(...phi), hi = Math.max(...phi);
    let best = gyrus[0], bestScore = Infinity;
    gyrus.forEach((v, k) => {
      const score = Math.abs((phi[k] - lo) / (hi - lo) - s) * 3 - v.distanceTo(c) * 8;
      if (score < bestScore) { bestScore = score; best = v; }
    });
    return best;
  }

  // ---------------------------------------------------------------- graph
  const sideOf = n => n.side === 'left' ? 1 : n.side === 'right' ? -1 : 0;
  const base = n => n.id.replace(/^(left|right)-/, '').split('>')[0];
  function chainToSpine(n, mode) {
    const out = [], seen = new Set();
    let cur = n;
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.push(cur); cur = cur.parent && byId.get(cur.parent); }
    const top = out[out.length - 1], side = top.side, segs = n.segments.filter(s => levelInfo.has(s));
    if (!side) return out;
    const b = base(top);
    const add = id => { const x = byId.get(id); if (x && !seen.has(id)) { seen.add(id); out.push(x); } };
    for (const L of segs) {
      if (/^C[1-4]$/.test(L) && !/^(phrenic|accessory)/.test(b)) add(`${side}-${L}-cervical-plexus`);
      if (/^(C[5-8]|T1)$/.test(L)) {
        add(`${side}-${L}-brachial-root`);
        add(`${side}-${['C5', 'C6'].includes(L) ? 'upper' : L === 'C7' ? 'middle' : 'lower'}-trunk`);
        (CORD_OF[b] || []).forEach(c => add(`${side}-${c}-cord`));
      }
      if (/^L[1-4]$/.test(L) && !/sciatic|tibial|fibular|gluteal|sural|plantar|pudendal|femoral-cutaneous|rotators/.test(b)) add(`${side}-${L}-lumbar-plexus`);
      if (/^(L4|L5)$/.test(L) && /sciatic|tibial|fibular|gluteal|sural|plantar|rotators/.test(b)) add(`${side}-lumbosacral-trunk`);
      if (/^S[1-4]$/.test(L)) add(`${side}-${L}-sacral-plexus`);
      add(`${side}-${L}-spinal`);
      if (mode !== 'sensory') add(`${side}-${L}-ventral`);
      if (mode !== 'motor') add(`${side}-${L}-dorsal`);
    }
    return out;
  }
  function musclesOf(n, acc = new Set()) {
    (n.muscles || []).forEach(m => acc.add(m));
    (children.get(n.id) || []).forEach(c => musclesOf(c, acc));
    return acc;
  }
  function nervesForMuscle(name) {
    return model.nerves.filter(n => n.kind === 'twig' ? n.muscles?.includes(name) : (n.muscles || []).includes(name));
  }
  function regionFor(name, n) {
    const t = (name + ' ' + (n?.name || '')).toLowerCase();
    if (/cranial|facial|trigeminal|hypoglossal|abducens|oculo|trochlear|platysma|tongue|glossus|digastric|stylohyoid|mylohyoid|v[123]\b/.test(t)) return /laryn|vocal|aryten|cricothyroid|recurrent/.test(t) ? 'larynx' : 'face';
    if (/finger|thumb|pollicis|digiti minimi of .* hand|interossei of .* hand|lumbricals of .* hand|palmar|median palmar|ulnar palmar/.test(t)) return 'hand';
    if (/toe|hallucis|plantar|of .* foot|sural|fibular|tibial|soleus|gastrocnemius|popliteus/.test(t)) return /toe|hallucis|plantar|of .* foot/.test(t) ? 'foot' : 'leg';
    if (/femoral|sciatic|obturator|gluteal|adductor|vastus|sartorius|gracilis|semi|biceps femoris|piriformis|pectineus|rectus femoris|saphenous|thigh/.test(t)) return 'leg';
    if (/brachial|radial|ulnar|median|musculocutaneous|axillary|deltoid|biceps brachii|triceps|brachialis|carpi|forearm|antebrachial|supinator|pronator|extensor digitorum|flexor digitorum|anconeus/.test(t)) return 'arm';
    return 'trunk';
  }
  function levelRegion(L) {
    if (/^C[2-4]$/.test(L)) return 'trunk';
    if (/^(C[5-8]|T1)$/.test(L)) return ['C6', 'C7', 'C8'].includes(L) ? 'hand' : 'arm';
    if (/^(L[4-5]|S1)$/.test(L)) return 'foot';
    if (/^(L[1-3])$/.test(L)) return 'leg';
    if (/^S[2-5]|Co1/.test(L)) return 'foot';
    return 'trunk';
  }

  // cord tract point: lateral / dorsal / anterolateral offset inside the cord
  const cordPts = (model.cord.path || []).map(v3);
  function cordAt(y) {
    let best = cordPts[0];
    for (const p of cordPts) if (Math.abs(p.y - y) < Math.abs(best.y - y)) best = p;
    return best.clone();
  }
  function tractPoints(fromY, toY, side, kind) {
    const off = kind === 'cst' ? new T.Vector3(side * .0028, 0, -.0008) : kind === 'dcml' ? new T.Vector3(side * .0012, 0, -.0034) : new T.Vector3(side * .003, 0, .0016);
    const pts = cordPts.filter(p => p.y <= Math.max(fromY, toY) && p.y >= Math.min(fromY, toY)).map(p => p.clone().add(off));
    return fromY < toY ? pts.reverse() : pts;
  }
  const levelPoint = L => v3(levelInfo.get(L).cord);

  // ---------------------------------------------------------------- tracing
  const traceGroup = new T.Group(); traceGroup.renderOrder = 10; scene.add(traceGroup);
  const glow = color => new T.MeshBasicMaterial({color, transparent: true, opacity: .9, depthTest: false, toneMapped: false});
  const pulseMat = new T.MeshBasicMaterial({color: '#ffffff', depthTest: false, toneMapped: false});
  let pulses = [], animating = false, highlighted = [];
  function clearTrace() {
    traceGroup.children.slice().forEach(c => { c.geometry?.dispose(); traceGroup.remove(c); });
    highlighted.forEach(m => m.material = m.userData.nerve.kind === 'root' ? rootMat : nerveMat);
    highlighted = []; pulses = []; animating = false; invalidate();
  }
  const traceBox = new T.Box3();
  let traceR = .0011;
  function drawPath(points, color, r = traceR) {
    const pts = points.filter(Boolean).map(p => p.isVector3 ? p : v3(p));
    const clean = pts.filter((p, i) => !i || p.distanceTo(pts[i - 1]) > 1e-4);
    clean.forEach(p => traceBox.expandByPoint(p));
    if (clean.length < 2) return;
    const curve = new T.CatmullRomCurve3(clean, false, 'centripetal');
    const mesh = new T.Mesh(new T.TubeGeometry(curve, Math.min(600, clean.length * 6), r, 6, false), glow(color));
    mesh.renderOrder = 10; traceGroup.add(mesh);
    const dot = new T.Mesh(new T.SphereGeometry(r * 2.6, 10, 8), pulseMat); dot.renderOrder = 11; traceGroup.add(dot);
    pulses.push({curve, dot, t: Math.random()});
  }
  function highlight(list) {
    const mat = new T.MeshBasicMaterial({color: '#ffcc33', toneMapped: false});
    for (const m of tubes) if (list.has(m.userData.nerve.id)) { m.material = mat; highlighted.push(m); }
  }
  // Signal pulses travel the traced path for a few seconds (throttled to
  // ~24 fps so the heavy scene isn't re-rendered at full rate), then park.
  let animStart = 0, lastFrame = 0;
  function animate(t = performance.now()) {
    if (!animating) return;
    if (!animStart) animStart = t;
    if (t - lastFrame > 42) {
      lastFrame = t;
      const now = t / 1000;
      for (const p of pulses) p.dot.position.copy(p.curve.getPointAt((now * .35 + p.t) % 1));
      invalidate();
    }
    if (t - animStart > 8000) { animating = false; animStart = 0; pulses.forEach(p => p.dot.visible = false); invalidate(); return; }
    requestAnimationFrame(animate);
  }
  const pathOf = n => n.path.map(v3);

  // Ordered polyline from a peripheral nerve up to its root (distal -> proximal)
  function peripheralPolyline(chain) {
    const pts = [];
    for (const n of chain) {
      const p = pathOf(n);
      if (!pts.length) { pts.push(...p.reverse()); continue; }
      const last = pts[pts.length - 1];
      const dStart = p[0].distanceTo(last), dEnd = p[p.length - 1].distanceTo(last);
      pts.push(...(dEnd < dStart ? p.reverse() : p));
    }
    return pts;
  }

  // CNS legs of each pathway
  function motorCNS(L, side, region) {
    const contra = -side, B = brainOf(contra), cortex = somatotopic(B.pre, contra, REGION_S[region] ?? .3);
    const cordPt = levelPoint(L);
    const deck = B.medLow || cordPts[0];
    return [cortex, cortex && B.ic && cortex.clone().lerp(B.ic, .5), B.ic, B.ped, B.pons, B.pyr, deck, ...tractPoints(deck.y, cordPt.y, side, 'cst'), cordPt.clone().add(new T.Vector3(side * .0035, 0, .002))];
  }
  function dcmlCNS(L, side, region) {
    const contra = -side, B = brainOf(contra), Bi = brainOf(side), cortex = somatotopic(B.post, contra, REGION_S[region] ?? .3);
    const cordPt = levelPoint(L), nucleus = Bi.medDorsal || cordPts[0];
    return [cordPt.clone().add(new T.Vector3(side * .003, 0, -.003)), ...tractPoints(cordPt.y, nucleus.y, side, 'dcml'), nucleus,
      B.medDorsal, ...B.lemniscus, B.thal, B.ic, cortex && B.ic && cortex.clone().lerp(B.ic, .5), cortex];
  }
  function stCNS(L, side, region) {
    const contra = -side, B = brainOf(contra), cortex = somatotopic(B.post, contra, REGION_S[region] ?? .3);
    const cordPt = levelPoint(L), cross = cordPt.clone().add(new T.Vector3(0, .012, .001));
    const top = B.medDorsal || cordPts[0];
    return [cordPt.clone().add(new T.Vector3(side * .003, 0, -.003)), cordPt.clone().add(new T.Vector3(side * .0015, .004, -.001)), cross,
      ...tractPoints(cross.y, top.y, contra, 'st'), B.medDorsal && B.medDorsal.clone().add(new T.Vector3(contra * .004, 0, .004)), ...B.lemniscus, B.thal, B.ic, cortex];
  }
  function cranialCNS(n, motor) {
    const side = sideOf(n), B = brainOf(-side), start = v3(n.path[0]);
    if (motor) {
      const cortex = somatotopic(B.pre, -side, n.id.includes('vagus') || n.id.includes('recurrent') ? REGION_S.larynx : REGION_S.face);
      return [cortex, B.ic, B.ped, start];
    }
    const cortex = somatotopic(B.post, -side, REGION_S.face);
    return [start, B.pons, B.vpm, B.ic, cortex];
  }

  const steps = [];
  function describe(kind, n, L, side, muscle) {
    const s = side > 0 ? 'left' : 'right', o = side > 0 ? 'right' : 'left';
    const segs = String(L).split('–').filter(x => levelInfo.has(x));
    const first = levelInfo.get(segs[0]), last = levelInfo.get(segs[segs.length - 1]);
    const where = x => (x.exit.match(/between (.+?) and (.+?)[ ,.(]/) || []).slice(1).join('/') || x.exit.replace(/^Exits |\.$/g, '');
    const li = segs.length > 1 ? {cordAtVertebra: `${first.cordAtVertebra.replace(' vertebral level', '')}–${last.cordAtVertebra}`,
      exit: `roots exit through ${segs.map(x => `${x} (${where(levelInfo.get(x))})`).join(', ')}.`, dermatome: segs.map(x => levelInfo.get(x).dermatome).join(' / ')} : first;
    L = segs.length > 1 ? `${segs[0]}–${segs[segs.length - 1]}` : segs[0] || L;
    if (kind === 'motor') return [
      `${cap(o)} precentral gyrus (primary motor cortex)${muscle || n ? ', ' + regionFor(muscle || '', n) + ' area' : ''} — upper motor neurons (Betz cells, layer V).`,
      'Corona radiata → posterior limb of the internal capsule.', 'Cerebral peduncle (crus cerebri) of the midbrain → basilar pons → medullary pyramid.',
      `Pyramidal decussation in the caudal medulla: ~85-90% of fibres cross to the ${s} side.`,
      `${cap(s)} lateral corticospinal tract descends in the cord's lateral funiculus to the ${L} segment (cord at the ${li?.cordAtVertebra}).`,
      `Synapse on lower motor neurons in the ${L} anterior (ventral) horn.`, `${L} ventral root → ${li?.exit}`,
      ...(n ? [`${n.name}${n.parent ? ' (branch of ' + (byId.get(n.parent)?.name || '') + ')' : ''}`] : []), muscle ? `Neuromuscular junction in ${muscle}.` : ''].filter(Boolean);
    if (kind === 'touch') return [
      n ? `Receptors in the skin (${n.skin || li?.dermatome}) → ${n.name}.` : `Receptors in the ${L} dermatome: ${li?.dermatome}`,
      `Cell body in the ${L} dorsal root ganglion; ${li?.exit}`, `Enters via the ${L} dorsal root and ascends ipsilaterally in the ${s} dorsal column (${/^(C|T[1-6]$)/.test(L) ? 'fasciculus cuneatus' : 'fasciculus gracilis'}).`,
      `Synapse in the ${s} ${/^(C|T[1-6]$)/.test(L) ? 'nucleus cuneatus' : 'nucleus gracilis'} (dorsal medulla).`, 'Internal arcuate fibres cross the midline → medial lemniscus through the medulla, pons and midbrain.',
      `${cap(o)} thalamus, ventral posterolateral (VPL) nucleus.`, `Posterior limb of internal capsule → ${o} postcentral gyrus (primary somatosensory cortex).`];
    if (kind === 'pain') return [
      n ? `Free nerve endings (Aδ, C fibres) in the skin → ${n.name}.` : `Pain/temperature receptors in the ${L} dermatome.`,
      `Cell body in the ${L} dorsal root ganglion; enters via the dorsal root (Lissauer's tract).`, `Synapse in the dorsal horn (substantia gelatinosa / lamina I) at ${L}.`,
      `Second-order fibres cross in the anterior white commissure within 1-2 segments to the ${o} side.`, `${cap(o)} spinothalamic tract (anterolateral system) ascends through the brainstem.`,
      `${cap(o)} thalamus (VPL) → internal capsule → ${o} postcentral gyrus.`];
    return [];
  }
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

  function runTrace({kind, nerve, level, side, muscle}) {
    clearTrace();
    traceBox.makeEmpty();
    traceR = .0022;
    animating = true;
    const out = {title: '', steps: [], ids: new Set()};
    if (nerve?.kind === 'cranial' || (nerve && /CN /.test(nerve.segments.join(' ')))) {
      const chain = []; let c = nerve; while (c) { chain.push(c); c = c.parent && byId.get(c.parent); }
      chain.forEach(x => out.ids.add(x.id));
      const motor = kind === 'motor';
      drawPath([...cranialCNS(chain[chain.length - 1], motor), ...peripheralPolyline(chain).reverse()], motor ? '#ff7b54' : '#5fd0ff');
      out.title = `${nerve.name}: ${motor ? 'motor (corticobulbar)' : 'sensory'} pathway`;
      out.steps = motor ? [`${cap(sideOf(nerve) > 0 ? 'right' : 'left')} precentral gyrus, face area (corticobulbar fibres; upper face receives bilateral input).`,
        'Genu of the internal capsule → cerebral peduncle.', `Brainstem motor nucleus of ${nerve.segments[0]}.`, `${nerve.name} → ${(nerve.muscles || []).join(', ') || 'targets'}.`]
        : [`Receptors → ${nerve.name}.`, `Brainstem sensory nucleus (${nerve.segments[0]}).`, 'Crosses → trigeminothalamic tract → contralateral thalamus (VPM).', 'Internal capsule → postcentral gyrus, face area.'];
    } else if (nerve) {
      const chain = chainToSpine(nerve, kind === 'motor' ? 'motor' : 'sensory');
      chain.forEach(x => out.ids.add(x.id));
      const sd = sideOf(nerve), segs = nerve.segments.filter(s => levelInfo.has(s));
      const region = regionFor(muscle || nerve.name, nerve);
      const periph = peripheralPolyline(chain.filter(x => !['root', 'spinal'].includes(x.kind) && x.kind !== 'plexus'));
      for (const L of segs) {
        const rootId = `${nerve.side}-${L}-${kind === 'motor' ? 'ventral' : 'dorsal'}`;
        const root = byId.get(rootId), spinal = byId.get(`${nerve.side}-${L}-spinal`);
        const central = kind === 'motor' ? motorCNS(L, sd, region) : kind === 'pain' ? stCNS(L, sd, region) : dcmlCNS(L, sd, region);
        const rootPts = root ? pathOf(root) : [];
        const spinalPts = spinal ? pathOf(spinal) : [];
        const plex = chain.filter(x => x.kind === 'plexus' && x.segments.includes(L)).map(pathOf);
        const toCord = [...periph, ...plex.flatMap(p => p.slice().reverse()), ...spinalPts.slice().reverse(), ...rootPts.slice().reverse()];
        const color = kind === 'motor' ? '#ff7b54' : kind === 'pain' ? '#ff4fa3' : '#5fd0ff';
        drawPath(kind === 'motor' ? [...central, ...toCord.slice().reverse()] : [...toCord, ...central], color, segs.length > 2 ? .0008 : .001);
      }
      out.title = `${nerve.name} — ${kind === 'motor' ? 'voluntary movement (corticospinal)' : kind === 'pain' ? 'pain & temperature (spinothalamic)' : 'touch & position (dorsal column–medial lemniscus)'}`;
      out.steps = describe(kind, nerve, segs.join('–'), sd, muscle);
      if (!segs.length) out.steps = [`${nerve.name}: ${nerve.skin || ''}`];
      out.segments = segs;
    } else if (level) {
      const li = levelInfo.get(level);
      const sides = side ? [side] : [1, -1];
      for (const sd of sides) {
        const s = sd > 0 ? 'left' : 'right';
        for (const n of model.nerves) if (n.side === s && n.segments.includes(level) && n.kind !== 'twig') out.ids.add(n.id);
        const region = levelRegion(level);
        const r = byId.get(`${s}-${level}-dorsal`), sp = byId.get(`${s}-${level}-spinal`);
        if (kind === 'motor') { const v = byId.get(`${s}-${level}-ventral`); drawPath([...motorCNS(level, sd, region), ...(v ? pathOf(v) : []), ...(sp ? pathOf(sp) : [])], '#ff7b54'); }
        else drawPath([...(sp ? pathOf(sp).reverse() : []), ...(r ? pathOf(r).reverse() : []), ...(kind === 'pain' ? stCNS : dcmlCNS)(level, sd, region)], kind === 'pain' ? '#ff4fa3' : '#5fd0ff');
      }
      out.title = `${level} spinal level`;
      out.steps = [li.exit, `Cord segment sits at the ${li.cordAtVertebra}.`, `Dermatome: ${li.dermatome}`, `Myotome: ${li.myotome}`, li.reflex && `Reflex: ${li.reflex}`, `Plexus: ${li.plexus}`,
        ...describe(kind === 'motor' ? 'motor' : kind, null, level, side || 1)].filter(Boolean);
      out.segments = [level];
    }
    highlight(out.ids);
    out.box = traceBox.clone();
    animStart = 0; requestAnimationFrame(animate);
    return out;
  }

  // ---------------------------------------------------------------- dermatomes
  const D = dermMeta;
  function dermatomeAt(p) {
    const x = Math.floor((p.x - D.origin[0]) / D.cell), y = Math.floor((p.y - D.origin[1]) / D.cell), z = Math.floor((p.z - D.origin[2]) / D.cell);
    if (x < 0 || y < 0 || z < 0 || x >= D.dims[0] || y >= D.dims[1] || z >= D.dims[2]) return null;
    const v = dermGrid[(z * D.dims[1] + y) * D.dims[0] + x];
    return v === 255 ? null : D.labels[v];
  }
  const skinIndex = parts.findIndex(p => p.name === 'Skin');
  let dermOn = false, dermFocus = null, dermMat = null;
  function paintSkin() {
    const mesh = meshes[skinIndex]; if (!mesh) return;
    const g = mesh.geometry, pos = g.attributes.position;
    if (!g.userData.derm) {
      const lab = new Uint8Array(pos.count);
      for (let i = 0; i < pos.count; i++) { tmp.fromBufferAttribute(pos, i); const l = dermatomeAt(tmp); lab[i] = l ? D.labels.indexOf(l) : 255; }
      g.userData.derm = lab;
    }
    const lab = g.userData.derm, col = new Float32Array(pos.count * 3), c = new T.Color(), grey = new T.Color('#d8c2b4');
    const focus = dermFocus ? D.labels.indexOf(dermFocus) : -1;
    for (let i = 0; i < pos.count; i++) {
      const l = lab[i];
      if (l === 255) c.copy(grey); else { c.set(DERM_COLORS[l % DERM_COLORS.length]); if (focus >= 0 && l !== focus) c.lerp(grey, .82); }
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    dermMat ||= new T.MeshStandardMaterial({vertexColors: true, roughness: .7, side: T.DoubleSide});
    mesh.material = dermMat;
    invalidate();
  }

  return {
    model, group, tubes, levels: model.levels, levelInfo, byId, children,
    setVisible(on) { group.visible = on; invalidate(); },
    get visible() { return group.visible; },
    regionAtCortex(p) {
      const side = p.x > 0 ? 1 : -1;
      const th = verts(female ? `${S(side)} Allen thalamus` : `${S(side)} thalamus`, female ? side : 0);
      if (!th.length) return 'body';
      const c = mean(th), phi = Math.atan2(Math.abs(p.x - c.x), p.y - c.y), s = Math.min(1, Math.max(0, (phi - .15) / 1.2));
      return Object.entries(REGION_S).reduce((b, e) => Math.abs(e[1] - s) < Math.abs(b[1] - s) ? e : b)[0];
    },
    trace: runTrace, clearTrace, musclesOf, nervesForMuscle, dermatomeAt, regionFor,
    dermatomes: {
      get on() { return dermOn; }, skinIndex, material: () => dermMat,
      set(on, focus = null) { dermOn = on; dermFocus = focus; if (on) paintSkin(); },
      refresh() { if (dermOn) paintSkin(); },
      colorOf: label => DERM_COLORS[D.labels.indexOf(label) % DERM_COLORS.length],
    },
    vertebraLevels(name) {
      // levels exiting at a vertebra (above it for C1-C7, below for T/L; C8 between C7-T1)
      const entry = Object.entries(model.vertebrae).find(([, n]) => n === name);
      if (!entry) return /sacrum/i.test(name) ? ['S1', 'S2', 'S3', 'S4', 'S5'] : [];
      const v = entry[0];
      return v[0] === 'C' ? [v, ...(v === 'C7' ? ['C8'] : [])] : [v];
    },
  };
}
