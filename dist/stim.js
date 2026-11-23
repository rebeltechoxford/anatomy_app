// Electrical stimulation simulator (educational approximation).
//
// Two electrodes (anode +, cathode -) inject a current pulse. The tissue is
// treated as a homogeneous volume conductor (sigma = 0.2 S/m): a surface
// electrode is a disk on a half-space, an implanted / intra-operative contact is
// a point source in full space. For each modeled nerve the extracellular
// potential is sampled at nodes of Ranvier (internode = 100 x fibre diameter)
// and the activating function (second spatial difference, McNeal/Rattay) is
// compared with a strength-duration threshold for each fibre class. Skin
// perception uses current density under surface electrodes; cortex uses the
// local electric-field magnitude (Penfield-style direct cortical stimulation).
//
// It answers "what would most likely fire first", with order-of-magnitude
// thresholds. It ignores tissue layering, anisotropy and individual anatomy, so
// it is not a dosing or safety tool.

const SIGMA = 0.2;          // S/m, bulk soft tissue
const SKULL_FACTOR = 0.012; // fraction of scalp current density reaching cortex
export const FIBRES = [
  {id: 'Aa', name: 'Aα motor', diam: 14, tau: .12, rh: .014, motor: true, effect: 'muscle twitch / contraction'},
  {id: 'Ab', name: 'Aβ touch', diam: 10, tau: .15, rh: .010, effect: 'tingling (paresthesia), touch, vibration'},
  {id: 'Ad', name: 'Aδ pain', diam: 3, tau: .3, rh: .003, effect: 'sharp, pricking pain; cold'},
  {id: 'C', name: 'C pain', diam: 1, tau: 1.5, rh: .016, node: .00025, effect: 'burning, aching pain; warmth'},
];
const CORTEX = [
  [/precentral|paracentral lobule/i, 'Primary motor cortex', p => `contralateral ${p} movement (clonic twitching with 50 Hz trains)`],
  [/postcentral/i, 'Primary somatosensory cortex', p => `contralateral ${p} tingling / numbness`],
  [/opercular|triangular|inferior frontal/i, "Inferior frontal gyrus (Broca's area if dominant, usually left)", () => 'speech arrest or hesitation during naming'],
  [/superior temporal|planum temporale|supramarginal|angular/i, 'Temporoparietal language/association cortex', n => /angular/i.test(n) ? 'language errors; angular gyrus stimulation has evoked out-of-body sensations' : 'comprehension or naming errors (Wernicke region if dominant)'],
  [/heschl|transverse temporal/i, 'Primary auditory cortex', () => 'buzzing or ringing sounds'],
  [/occipital|cuneus|lingual|calcarine|occipital pole/i, 'Visual cortex', () => 'phosphenes (flashes, spots of light) in the opposite visual field'],
  [/hippocamp|amygdal|parahippocampal|entorhinal/i, 'Mesial temporal lobe', () => 'déjà vu, fear, memory flashbacks, epigastric rising sensation'],
  [/insula|limen/i, 'Insula', () => 'visceral sensations, taste, warmth, nausea'],
  [/cingulate/i, 'Cingulate cortex', () => 'emotional or motivational feelings, urge to move'],
  [/superior frontal|supplementary/i, 'Superior frontal gyrus / supplementary motor area', () => 'complex postures, urge to move, speech arrest'],
  [/middle frontal/i, 'Middle frontal gyrus (frontal eye field area)', () => 'conjugate eye or head turning to the opposite side'],
  [/fusiform|inferior temporal/i, 'Ventral temporal cortex', () => 'face/object perception distortions, naming difficulty'],
  [/thalam/i, 'Thalamus (deep)', () => 'contralateral paresthesia (deep brain stimulation target region)'],
  [/caudate|putamen|pallid|subthalamic/i, 'Basal ganglia (deep)', () => 'motor effects; DBS target region (subthalamic nucleus, globus pallidus)'],
  [/cerebell|vermis/i, 'Cerebellum', () => 'usually little conscious effect; possible dizziness or eye movements'],
  [/medulla|pons|midbrain/i, 'Brainstem', () => 'DANGER zone: heart rate, breathing and blood pressure changes'],
];

export function setupStim({T, parts, meshes, scene, nerves, invalidate, tissues, stimUniforms}) {
  const group = new T.Group(); group.name = 'Stimulus'; scene.add(group);
  const state = {mode: 'surface', current: 5, pw: 200, freq: 30, area: 4, depth: 3, electrodes: [null, null], next: 0, results: null};
  const mats = [new T.MeshBasicMaterial({color: '#ff4040', toneMapped: false, depthTest: false}), new T.MeshBasicMaterial({color: '#3d8bff', toneMapped: false, depthTest: false})];
  const markers = [0, 1].map(k => { const m = new T.Mesh(new T.SphereGeometry(1, 16, 12), mats[k]); m.visible = false; m.renderOrder = 12; group.add(m); return m; });
  const link = new T.Line(new T.BufferGeometry(), new T.LineDashedMaterial({color: '#ffffff', dashSize: .01, gapSize: .006, depthTest: false, transparent: true, opacity: .7}));
  link.renderOrder = 12; group.add(link);
  const heartIds = parts.map((p, i) => p.system === 'cardiac' ? i : -1).filter(i => i >= 0);
  const box = new T.Box3(), v = new T.Vector3(), w = new T.Vector3();
  const heart = heartIds.length ? (heartIds.forEach(i => parts[i].bounds.forEach(b => box.expandByPoint(v.set(...b)))), box.getCenter(new T.Vector3())) : null;

  // Threshold second-difference scales with fibre diameter (cable theory gives
  // current thresholds ~1/D). Calibrated so a needle 2 mm from a nerve fires
  // motor fibres at ~0.5 mA (100 µs) and a 4 cm² pad over a nerve 5-10 mm deep
  // at ~5-20 mA (200 µs), matching nerve-locator and nerve-conduction practice.
  const padRadius = () => Math.sqrt(state.area / Math.PI) / 100;
  // Implanted contacts: subdural disc (~3.5 mm) on brain, needle tip elsewhere.
  const onBrain = e => e && e.part != null && parts[e.part].system === 'nervous' && !/nerve|ganglion/i.test(parts[e.part].name);
  const contactRadius = () => state.electrodes.some(onBrain) ? .0018 : .0005;
  const electrodeRadius = () => state.mode === 'surface' ? .45 * padRadius() : contactRadius();
  const k = () => (state.current / 1000) / ((state.mode === 'surface' ? 2 : 4) * Math.PI * SIGMA);

  function place(hit, which = state.next) {
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new T.Vector3(0, 0, 1);
    const p = hit.point.clone();
    state.electrodes[which] = {surface: p.clone(), normal: n, part: hit.object.userData.index ?? null, partName: hit.object.userData.index != null ? parts[hit.object.userData.index].name : hit.object.name};
    state.next = which === 0 ? 1 : 0;
    update();
    return which;
  }
  function positions() {
    return state.electrodes.map(e => {
      if (!e) return null;
      if (state.mode === 'surface') return e.surface.clone();
      return e.surface.clone().addScaledVector(e.normal, -state.depth / 1000);
    });
  }
  function drawMarkers() {
    const pos = positions(), r = state.mode === 'surface' ? Math.max(.002, padRadius() * .8) : .0015;
    pos.forEach((p, i) => { markers[i].visible = !!p; if (p) { markers[i].position.copy(p); markers[i].scale.setScalar(r); } });
    if (pos[0] && pos[1]) { link.geometry.setFromPoints(pos); link.computeLineDistances(); link.visible = true; } else link.visible = false;
  }

  // ---------- physics
  function potentialAt(p, a, c, K, r0, factor = 1) {
    const ra = Math.sqrt(p.distanceToSquared(a) + r0 * r0), rc = Math.sqrt(p.distanceToSquared(c) + r0 * r0);
    return K * factor * (1 / ra - 1 / rc);
  }
  function fieldAt(p, a, c, K, r0, factor = 1) {
    const da = v.copy(p).sub(a), ra2 = da.lengthSq() + r0 * r0;
    const dc = w.copy(p).sub(c), rc2 = dc.lengthSq() + r0 * r0;
    const ea = da.multiplyScalar(1 / (ra2 * Math.sqrt(ra2))), ec = dc.multiplyScalar(1 / (rc2 * Math.sqrt(rc2)));
    return ea.sub(ec).length() * K * factor;
  }
  const thresholdV = f => f.rh * (1 + f.tau / (state.pw / 1000));

  function evaluate() {
    const [a, c] = positions();
    if (!a || !c) return null;
    const K = k(), r0 = electrodeRadius();
    const result = {nerves: [], muscles: new Map(), skin: [], cortex: [], warnings: [], voltage: 0, chargeDensity: 0};
    // nerve fibres
    const near = new T.Box3().setFromPoints([a, c]).expandByScalar(.25);
    for (const tube of nerves.tubes) {
      const n = tube.userData.nerve;
      if (!n.path || n.kind === 'cord') continue;
      tube.geometry.boundingBox || tube.geometry.computeBoundingBox();
      if (!near.intersectsBox(tube.geometry.boundingBox)) continue;
      const curve = tube.geometry.parameters.path, len = curve.getLength();
      const classes = FIBRES.filter(f => n.fibers === 'mixed' || (n.fibers === 'motor' ? f.motor : !f.motor));
      let best = null;
      for (const f of classes) {
        const L = f.node || f.diam * 100e-6;
        const count = Math.min(900, Math.max(3, Math.round(len / L)));
        const step = len / count;
        let prev2 = null, prev = null, max = 0, at = 0;
        for (let i = 0; i <= count; i++) {
          const V = potentialAt(curve.getPointAt(i / count), a, c, K, r0);
          if (prev2 !== null) { const d2 = (prev2 - 2 * prev + V) * (L / step) ** 2; if (d2 > max) { max = d2; at = (i - 1) / count; } }
          prev2 = prev; prev = V;
        }
        const ratio = max / thresholdV(f);
        if (!best || ratio > best.ratio) best = {ratio, fibre: f, at};
        if (ratio >= 1) result.nerves.push({nerve: n, fibre: f, ratio, at});
      }
      tube.userData.stimRatio = best ? best.ratio : 0;
    }
    // muscles driven through motor fibres (all muscles distal to the activation)
    for (const hit of result.nerves.filter(h => h.fibre.motor)) {
      const list = hit.nerve.kind === 'twig' ? hit.nerve.muscles : [...nerves.musclesOf(hit.nerve)];
      for (const m of list) if (!result.muscles.has(m) || result.muscles.get(m).ratio < hit.ratio) result.muscles.set(m, {ratio: hit.ratio, via: hit.nerve.name});
    }
    // skin under the electrodes
    const pwMs = state.pw / 1000;
    state.electrodes.forEach((e, idx) => {
      const derm = nerves.dermatomeAt(e.surface);
      const li = derm && nerves.levelInfo.get(derm);
      const where = derm ? `${derm} dermatome${li ? ' — ' + li.dermatome : derm.startsWith('V') ? ' (trigeminal ' + derm + ')' : ''}` : (e.partName || 'electrode site');
      let level = 0, label = 'nothing felt';
      if (state.mode === 'surface') {
        const J = state.current / state.area, Js = .08 * (1 + .35 / pwMs);
        level = J / Js;
      } else if (state.depth <= 8 && e.part != null && parts[e.part].system === 'integumentary') level = state.current / (.08 * (1 + .35 / pwMs));
      if (level >= 15) label = 'burning pain (C fibres) — intolerable';
      else if (level >= 6) label = 'sharp/pricking pain (Aδ)';
      else if (level >= 1) label = state.freq < 10 ? 'distinct taps/pulses (Aβ)' : 'tingling buzz (Aβ paresthesia)';
      if (level >= .5) result.skin.push({electrode: idx, where, label, ratio: level});
    });
    // cortex / deep brain
    const brainIdx = parts.map((p, i) => p.system === 'nervous' && meshes[i] && !/nerve|ganglion|cord|root|optic|dura|chiasm/i.test(p.name) ? i : -1).filter(i => i >= 0);
    const factor = state.mode === 'surface' ? SKULL_FACTOR : 1;
    const Eth = 40 * (1 + .15 / pwMs);
    for (const i of brainIdx) {
      const b = parts[i].bounds;
      box.set(v.set(...b[0]), w.set(...b[1]));
      const d = Math.min(box.distanceToPoint(a), box.distanceToPoint(c));
      if (d > (state.mode === 'surface' ? .12 : .04)) continue;
      const pos = meshes[i].geometry.attributes.position, step = Math.max(1, Math.floor(pos.count / 600));
      let max = 0, maxP = null; const tmp = new T.Vector3();
      for (let q = 0; q < pos.count; q += step) {
        tmp.fromBufferAttribute(pos, q);
        const E = fieldAt(tmp, a, c, K, r0, factor);
        if (E > max) { max = E; maxP = tmp.clone(); }
      }
      if (max >= Eth) {
        const name = parts[i].name, rule = CORTEX.find(([re]) => re.test(name));
        const side = maxP.x > 0 ? 'left' : 'right', region = nerves.regionAtCortex?.(maxP) || 'body';
        result.cortex.push({name, ratio: max / Eth, area: rule ? rule[1] : 'Brain tissue', effect: rule ? rule[2](region, name) : 'local neuronal firing; effect depends on function', side, E: max});
      }
    }
    result.cortex.sort((x, y) => y.ratio - x.ratio);
    // electrical summary + safety
    const Z = state.mode === 'surface' ? 300 + 4000 / state.area : 800;  // ohms incl. electrode-skin interface
    result.voltage = state.current / 1000 * Z;
    const areaCm2 = state.mode === 'surface' ? state.area : Math.PI * (contactRadius() * 100) ** 2;
    result.chargeDensity = state.current * state.pw / 1000 / areaCm2; // µC/cm² per phase
    const thorax = heart && segmentDistance(heart, a, c) < .09 && Math.abs(a.x - c.x) + Math.abs(a.z - c.z) > .12;
    if (thorax && state.current >= 10) result.warnings.push('Current path crosses the chest near the heart. Above ~10 mA, and especially with long pulses or 50-60 Hz, this can disturb heart rhythm; ~50-100 mA across the chest can cause ventricular fibrillation. Never place electrodes across the chest outside medical supervision.');
    else if (thorax) result.warnings.push('Electrode path crosses the chest. Even at low currents, transthoracic placement is avoided in practice (pacemakers, arrhythmia risk).');
    if (state.electrodes.some(e => /sternocleidomastoid|carotid|thyro|larynx|hyoid/i.test(e.partName || '')) || state.electrodes.some(e => { const d = nerves.dermatomeAt(e.surface); return d === 'C3'; }))
      result.warnings.push('Anterior neck placement: stimulation over the carotid sinus can drop heart rate and blood pressure, and laryngeal muscle spasm can block the airway.');
    if (state.mode === 'implanted' && result.chargeDensity > 30) result.warnings.push(`Charge density ≈ ${result.chargeDensity.toFixed(0)} µC/cm² per phase exceeds the ~30 µC/cm² limit commonly used for implanted electrodes (risk of tissue damage).`);
    if (result.cortex.length && state.mode === 'implanted') result.warnings.push('Direct cortical stimulation can trigger afterdischarges or seizures; intra-operatively it is done with EEG monitoring and the current is raised in small steps.');
    if (result.cortex.some(c => /Brainstem/.test(c.area))) result.warnings.push('Brainstem activation: vital autonomic centres. Not a target for direct stimulation.');
    if (state.mode === 'surface' && result.cortex.length) result.warnings.push('Transcranial: the skull blocks most current. Effects shown assume ~1% reaches cortex (tDCS/TES). Transcranial electrical stimulation strong enough to fire cortex is painful and is done only in the operating room.');
    result.nerves.sort((x, y) => y.ratio - x.ratio);
    return result;
  }
  function segmentDistance(p, a, b) {
    const ab = w.copy(b).sub(a), t = Math.max(0, Math.min(1, v.copy(p).sub(a).dot(ab) / ab.lengthSq()));
    return p.distanceTo(a.clone().addScaledVector(ab, t));
  }

  // ---------- visualisation
  const hot = new T.MeshBasicMaterial({color: '#ff5a1f', toneMapped: false});
  const warm = new T.MeshStandardMaterial({color: '#ffb347', emissive: '#7a3a00', emissiveIntensity: .6});
  let coloured = [];
  function paintNerves(on) {
    coloured.forEach(([m, mat]) => m.material = mat); coloured = [];
    if (!on) return;
    for (const m of nerves.tubes) {
      const r = m.userData.stimRatio || 0;
      if (r >= 1) { coloured.push([m, m.material]); m.material = hot; }
      else if (r >= .4) { coloured.push([m, m.material]); m.material = warm; }
    }
  }
  function setUniforms() {
    const [a, c] = positions(), on = !!(a && c);
    stimUniforms.tStimOn.value = on ? 1 : 0;
    if (on) {
      stimUniforms.tStimA.value.copy(a); stimUniforms.tStimC.value.copy(c);
      stimUniforms.tStimK.value = k(); stimUniforms.tStimR0.value = electrodeRadius();
      stimUniforms.tStimRef.value = 12 * (1 + .12 / (state.pw / 1000)); // ~field that fires large axons along their length
    }
  }

  let listeners = [];
  function update() {
    drawMarkers();
    setUniforms();
    state.results = evaluate();
    paintNerves(!!state.results);
    listeners.forEach(f => f(state.results));
    invalidate();
  }
  function clear() {
    state.electrodes = [null, null]; state.next = 0; state.results = null;
    nerves.tubes.forEach(t => t.userData.stimRatio = 0);
    paintNerves(false); drawMarkers(); stimUniforms.tStimOn.value = 0;
    listeners.forEach(f => f(null)); invalidate();
  }
  return {
    state, place, update, clear, positions,
    set(params) { Object.assign(state, params); update(); },
    onResult(f) { listeners.push(f); },
    setVisible(on) { group.visible = on; if (!on) { stimUniforms.tStimOn.value = 0; paintNerves(false); } else update(); invalidate(); },
    excitedMuscles() { return state.results ? [...state.results.muscles.keys()] : []; },
    snapshot() {
      return {mode: state.mode, pulseWidth_us: state.pw, frequency_Hz: state.freq, electrodeArea_cm2: state.area, depth_mm: state.depth,
        current_mA: +state.current.toPrecision(3), electrodes: state.electrodes.map((e, i) => e && {polarity: i ? 'cathode (-)' : 'anode (+)', point: e.surface.toArray().map(x => +x.toFixed(4)), structure: e.partName}),
        summary: summarize(state.results)};
    },
  };
}

export function summarize(r) {
  if (!r) return [];
  const out = [];
  r.skin.forEach(s => out.push(`Skin under ${s.electrode ? 'cathode' : 'anode'}: ${s.label} — ${s.where}`));
  r.nerves.slice(0, 12).forEach(n => out.push(`${n.nerve.name}: ${n.fibre.name} fibres fire (${n.ratio.toFixed(1)}× threshold) → ${n.fibre.effect}${n.fibre.motor ? '' : n.nerve.skin ? ' in: ' + n.nerve.skin : ''}`));
  [...r.muscles].slice(0, 20).forEach(([m, x]) => out.push(`Muscle: ${m} contracts (via ${x.via})`));
  r.cortex.slice(0, 8).forEach(c => out.push(`${c.area} (${c.name}): ${c.effect}`));
  return out;
}
