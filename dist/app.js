import {makeAtlasRenderer} from './canvas-renderer.js';
import * as T from './vendor/three.js';
import {OrbitControls} from './vendor/orbit.js';
import {EffectComposer} from './vendor/fx/EffectComposer.js';
import {OutputPass} from './vendor/fx/OutputPass.js';
import {N8AOPass} from './vendor/fx/N8AO.js';
import {RoomEnvironment} from './vendor/fx/RoomEnvironment.js';
import {setupTissueVessels} from './tissue-vessels.js';
import {TISSUES, SYSTEM_SWATCH, FIBROUS, tissueFor, makeTissueLibrary, addFiberAxis} from './tissue-materials.js';
import {setupDetailStreaming} from './detail-loader.js';
import {setupNerves, DERM_COLORS} from './nerve-system.js';
import {setupStim, summarize} from './stim.js';
import {setupMarkup} from './markup.js';
import {imagingSection} from './imaging.js';
import {loadFacts, factsFor, orderedFields, QUICK} from './facts.js';
import {setupLabels} from './labels.js';

const $ = id => document.getElementById(id);
const cap = s => s[0].toUpperCase() + s.slice(1);
const palette = Object.fromEntries(Object.entries(SYSTEM_SWATCH).map(([s, k]) => [s, TISSUES[k].color]));
const eye = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 12Q12 -1 22 12Q12 25 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
const VIEW_DIRS = {Anterior: [0, 0, 1], Posterior: [0, 0, -1], 'Left lateral': [1, 0, 0], 'Right lateral': [-1, 0, 0]};
const MIN_DISTANCE = .006, MAX_DISTANCE = 12;

// Soft radial backdrop rendered as the scene background so post-processing
// (AO, tone mapping) composites over it rather than over transparency.
function backdrop() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d'), grad = g.createRadialGradient(266, 205, 0, 256, 256, 400);
  grad.addColorStop(0, '#2b3b40'); grad.addColorStop(.56, '#172328'); grad.addColorStop(1, '#0b1215');
  g.fillStyle = grad; g.fillRect(0, 0, 512, 512);
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace;
  return t;
}

async function start() {
  let clearTissue = () => {}, detail = null, nerveSys = null, stim = null, markup = null, selectedNerve = null, labels = null;
  const stimMuscles = new Set();
  const query = new URLSearchParams(location.search);
  const notes = new URLSearchParams(location.hash.slice(1));
  const folder = query.get('body') === 'female' ? 'female' : 'models';
  for (const id of ['vesselsLink', 'microLink', 'specimenLink']) $(id).search = '?body=' + folder;
  $('body').value = folder;
  $('body').onchange = () => location.search = '?body=' + $('body').value;
  $('sourceName').textContent = folder === 'female' ? 'Adult female / Human Reference Atlas + Z-Anatomy (fitted)' : 'Adult male / Z-Anatomy · BodyParts3D';

  const [atlas, near] = await Promise.all(['atlas', 'near'].map(n => fetch(folder + '/' + n + '.json').then(r => r.json())));
  const parts = atlas.parts;
  for (const key of Object.keys(palette)) if (!parts.some(p => p.system === key)) delete palette[key];

  // ---- Renderer, lighting and post-processing --------------------------------
  const renderer = makeAtlasRenderer(T);
  const gpu = !!renderer.isWebGLRenderer;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  $('viewport').append(renderer.domElement);
  const scene = new T.Scene(), camera = new T.PerspectiveCamera(30, 1, .003, 50);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.minDistance = MIN_DISTANCE; orbit.maxDistance = MAX_DISTANCE; orbit.enableDamping = false;
  orbit.zoomToCursor = true; // dive toward what's under the pointer
  orbit.screenSpacePanning = true;

  scene.add(new T.HemisphereLight(0xfff4e6, 0x48545a, gpu ? .55 : 1.6));
  // Key (warm, upper left), fill (cool, right) and rim (behind) lights.
  for (const [x, y, z, power, color] of [[-3, 5, 4, 2.0, 0xfff1e0], [4, 1.5, 2, .7, 0xdfe9ff], [1, 3, -5, 1.5, 0xffffff]]) {
    const light = new T.DirectionalLight(color, gpu ? power : power * .8);
    light.position.set(x, y, z);
    scene.add(light);
  }

  let composer = null, ao = null;
  if (gpu) {
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    const pmrem = new T.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), .04).texture;
    scene.background = backdrop();
    try {
      composer = new EffectComposer(renderer);
      ao = new N8AOPass(scene, camera, 1, 1);
      Object.assign(ao.configuration, {gammaCorrection: false, aoSamples: 16, denoiseSamples: 8, denoiseRadius: 10, intensity: 2.4, distanceFalloff: 1.2});
      ao.beautyRenderTarget.samples = 4; // MSAA for the beauty pass
      composer.addPass(ao);
      composer.addPass(new OutputPass());
    } catch (e) {
      console.warn('Ambient occlusion unavailable', e);
      composer = null;
    }
  }

  // ---- Materials ---------------------------------------------------------------
  const tissues = makeTissueLibrary(T);
  const tissueKeys = parts.map(tissueFor);
  new Set(tissueKeys).forEach(k => tissues.get(k));
  const ovary = parts.findIndex(p => p.name === 'Left ovary');
  const bladder = parts.map((p, i) => /urinary bladder/i.test(p.name) ? i : -1).filter(i => i >= 0);
  const canReview = folder === 'female' && ovary >= 0 && bladder.length > 0;
  const ovaryColor = new T.MeshStandardMaterial({color: '#d68628', emissive: '#663200', emissiveIntensity: .32, side: T.DoubleSide});
  const bladderColor = new T.MeshStandardMaterial({color: '#268eab', emissive: '#06485d', emissiveIntensity: .23, side: T.DoubleSide});
  const reviewMaterials = new Map([[ovary, ovaryColor], ...bladder.map(i => [i, bladderColor])]);
  const selectedOvaryColor = ovaryColor.clone(), selectedBladderColor = bladderColor.clone();
  const reviewContext = new Set(['Right ovary', 'Body of uterus', 'Fundus of uterus', 'Cervix', 'Left ampulla of uterine tube', 'Right ampulla of uterine tube', 'Left isthmus of fallopian tube', 'Right isthmus of fallopian tube']);
  let reviewing = false;

  function materialFor(i) {
    if (reviewing && reviewMaterials.has(i)) {
      if (i === selected) return i === ovary ? selectedOvaryColor : selectedBladderColor;
      return reviewMaterials.get(i);
    }
    if (parts[i].system === 'attachment') return attachMat[parts[i].kind] || attachMat.origin;
    if (nerveSys?.dermatomes.on && i === nerveSys.dermatomes.skinIndex && nerveSys.dermatomes.material()) return nerveSys.dermatomes.material();
    return tissues.get(tissueKeys[i], i === selected || stimMuscles.has(parts[i].name) || traceParts.has(i));
  }

  // ---- View state ----------------------------------------------------------------
  const meshes = [];
  const sets = Object.fromEntries(Object.keys(palette).map(s => [s, parts.map((p, i) => p.system === s ? i : -1).filter(i => i >= 0)]));
  // Sheets that envelop everything (fascia, aponeuroses, serous membranes) start hidden, as in a dissection.
  const SHEET = /fascia|aponeuros|bursa|sheath|septum|retinacul|pleura|peritone|omentum|mesocolon|meso-|capsule|membrane|dura|arachnoid|falx|tentorium|tela /i;
  const initial = parts.map(p => !['integumentary', 'pregnancy', 'attachment'].includes(p.system) && !SHEET.test(p.name)), history = [];
  // Muscle origin/insertion patches (Z-Anatomy): shown only for the selected muscle.
  const attachKey = (side, muscle) => (side || '') + '|' + muscle.toLowerCase().replace(/\s+muscles?$/, '').replace(/^(left|right)\s+/, '');
  const attachments = new Map();
  parts.forEach((p, i) => { if (p.system === 'attachment') { const k = attachKey(p.side, p.muscle); if (!attachments.has(k)) attachments.set(k, []); attachments.get(k).push(i); } });
  const attachMat = {origin: new T.MeshStandardMaterial({color: '#e2483c', emissive: '#5a0e08', roughness: .5, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, side: T.DoubleSide}),
    insertion: new T.MeshStandardMaterial({color: '#3c7ee2', emissive: '#08245a', roughness: .5, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, side: T.DoubleSide})};
  let activeAttach = new Set(), peel = 0;
  const traceParts = new Set();
  function attachmentsFor(i) {
    const p = parts[i]; if (!p || p.system !== 'muscular') return [];
    const side = /^left /i.test(p.name) ? 'left' : /^right /i.test(p.name) ? 'right' : null;
    return attachments.get(attachKey(side, p.name)) || [];
  }
  const STAY = new Set(['skeletal', 'attachment', 'cardiac', 'nervous', 'digestive', 'respiratory', 'urinary', 'reproductive', 'endocrine']);
  function isShown(i) {
    const p = parts[i];
    if (p.system === 'attachment') return activeAttach.has(i);
    if (!shown[i]) return false;
    if (peel > 0 && (p.system === 'integumentary' || (!STAY.has(p.system) && (p.depth ?? 99) < peel))) return false;
    return true;
  }
  let shown = initial.slice(), selected = null, expanded = '', dissect = false, dirty = true;
  const fullBox = new T.Box3();
  parts.forEach(p => p.bounds.forEach(v => fullBox.expandByPoint(new T.Vector3(...v))));
  const boxOf = i => new T.Box3(...parts[i].bounds.map(v => new T.Vector3(...v)));

  // ---- Cutaway -------------------------------------------------------------------
  const plane = new T.Plane();
  let slicing = false, sign = -1;
  renderer.localClippingEnabled = true;
  function cut() {
    const single = $('scope').value === 'Selected structure', p = parts[selected], ax = $('axis').value;
    const b = single && p ? boxOf(selected) : fullBox;
    plane.normal.set(0, 0, 0); plane.normal[ax] = sign;
    plane.constant = -sign * T.MathUtils.lerp(b.min[ax], b.max[ax], Number($('depth').value) / 100);
    const selectedMaterial = selected === null ? null : materialFor(selected);
    for (const m of [...tissues.all(), ovaryColor, bladderColor, selectedOvaryColor, selectedBladderColor, nerveSys?.dermatomes.material()].filter(Boolean)) {
      const planes = slicing && (!single || (p && m === selectedMaterial)) ? [plane] : [];
      if (m.clippingPlanes?.length !== planes.length) m.needsUpdate = true;
      m.clippingPlanes = planes;
    }
    dirty = true;
  }
  $('sliceButton').onclick = () => { slicing = !slicing; $('slicePanel').hidden = !slicing; $('sliceButton').setAttribute('aria-pressed', slicing); cut(); };
  $('axis').onchange = $('scope').onchange = $('depth').oninput = cut;
  $('flip').onclick = () => { sign *= -1; cut(); };

  // ---- Render loop (on demand) ---------------------------------------------------
  const invalidate = () => { dirty = true; };
  orbit.addEventListener('change', () => {
    // Keep depth precision proportional to how close we are.
    const d = camera.position.distanceTo(orbit.target);
    const nearPlane = T.MathUtils.clamp(d * .01, .0002, .02);
    if (Math.abs(camera.near - nearPlane) > nearPlane * .1) { camera.near = nearPlane; camera.updateProjectionMatrix(); }
    if (ao) ao.configuration.aoRadius = T.MathUtils.clamp(d * .035, .002, .09);
    detail?.schedule();
    labels?.schedule();
    invalidate();
  });
  const draw = () => {
    if (dirty) { composer ? composer.render() : renderer.render(scene, camera); dirty = false; }
    requestAnimationFrame(draw);
  };
  draw();

  function sync() {
    $('pelvicReview').setAttribute('aria-expanded', reviewing);
    $('pelvicFindings').hidden = !reviewing;
    $('scope').options[1].disabled = selected === null;
    if (selected === null && $('scope').selectedIndex) $('scope').selectedIndex = 0;
    activeAttach = new Set(selected !== null ? attachmentsFor(selected) : []);
    meshes.forEach((m, i) => { m.visible = isShown(i); m.material = materialFor(i); });
    labels?.select(selected);
    cut(); // after material assignment so newly created materials get the plane
    $('undo').disabled = !history.length;
    $('inspect').hidden = selected === null && !selectedNerve;
    for (const id of ['hide', 'solo', 'focus', 'lookup']) $(id).hidden = !!selectedNerve;
    if (selectedNerve) {
      $('part').textContent = selectedNerve.name;
      $('system').textContent = 'MODELED NERVE · ' + (selectedNerve.segments || []).join(' ');
    } else if (selected !== null) {
      $('part').textContent = parts[selected].name;
      $('system').textContent = parts[selected].system.toUpperCase() + ' SYSTEM' + (parts[selected].fitted ? ' · FITTED' : '');
      detail?.want(selected);
    }
    showQuick();
    library();
    detail?.schedule();
    invalidate();
  }
  function showQuick() {
    const p = selected !== null && !selectedNerve ? parts[selected] : null;
    $('latin').hidden = !p?.latin; if (p?.latin) $('latin').textContent = p.latin;
    const dl = $('quick'); dl.replaceChildren(); dl.hidden = true;
    if (!p) return;
    loadFacts().then(() => {
      if (parts[selected] !== p) return;
      const f = factsFor(p.name);
      const rows = f ? orderedFields(f).filter(([k]) => QUICK.includes(k)).slice(0, 5) : [];
      const att = attachmentsFor(selected);
      if (att.length) rows.push(['Attachments', `${att.filter(i => parts[i].kind === 'origin').length ? 'origin in red' : ''}${att.length > 1 ? ', ' : ''}${att.filter(i => parts[i].kind === 'insertion').length ? 'insertion in blue' : ''}`]);
      for (const [k, v] of rows) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v.length > 140 ? v.slice(0, 140) + '…' : v; dl.append(dt, dd); }
      dl.hidden = !rows.length;
    });
  }
  function save() { history.push([shown.slice(), selected, reviewing]); if (history.length > 60) history.shift(); }
  function front() {
    orbit.target.set(0, .78, 0);
    camera.position.copy(orbit.target).add(new T.Vector3(...VIEW_DIRS[$('view').value]).multiplyScalar(Math.max(3.9, 1.7 / camera.aspect)));
    camera.up.set(0, 1, 0);
    orbit.update(); invalidate();
  }
  function resize() {
    const v = $('viewport'), w = v.clientWidth, h = v.clientHeight;
    renderer.setSize(w, h, false);
    if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); }
    camera.aspect = w / h; camera.updateProjectionMatrix(); invalidate();
  }
  new ResizeObserver(resize).observe($('viewport'));
  resize(); front();

  function focus() {
    if (selected === null) return;
    const box = boxOf(selected), dir = camera.position.clone().sub(orbit.target).normalize();
    box.getCenter(orbit.target);
    camera.position.copy(orbit.target).addScaledVector(dir, Math.max(.05, box.getSize(new T.Vector3()).length() * 2.5 / Math.min(1, camera.aspect)));
    orbit.update(); invalidate();
  }
  function frameReview(ids) {
    const box = new T.Box3();
    ids.forEach(i => parts[i].bounds.forEach(point => box.expandByPoint(new T.Vector3(...point))));
    box.getCenter(orbit.target);
    const distance = Math.max(.11, box.getSize(new T.Vector3()).length() * 2.4 / Math.min(1, camera.aspect));
    camera.position.copy(orbit.target).addScaledVector(new T.Vector3(0, .4, 1).normalize(), distance);
    $('view').value = 'Anterior';
    orbit.update(); invalidate();
  }
  function showReview(ids = [ovary, ...bladder]) {
    clearTissue();
    reviewing = true;
    shown = parts.map((p, i) => reviewMaterials.has(i) || reviewContext.has(p.name));
    selected = null;
    mode(false);
    if (slicing) $('sliceButton').click();
    frameReview(ids);
    sync();
  }
  function toggleReview() {
    if (reviewing) { $('reset').click(); return; }
    save(); showReview();
  }
  $('pelvicReview').hidden = !canReview;
  $('pelvicReview').onclick = toggleReview;
  $('pelvicOverview').onclick = () => showReview();
  $('reviewOvary').onclick = () => showReview([ovary]);
  $('reviewBladder').onclick = () => showReview(bladder);
  for (const [id, key] of [['ovaryNote', 'ovary'], ['urineNote', 'urine'], ['labNote', 'labs']]) {
    const note = notes.get(key)?.trim();
    if (note) { $(id).textContent = note; $(id).hidden = false; }
  }

  function pick(i) { if (!shown[i]) { save(); shown[i] = true; } selected = i; selectedNerve = null; sync(); }
  function remove(i) { save(); shown[i] = false; selected = null; sync(); }
  function button(label, fn, cls) { const b = document.createElement('button'); b.textContent = label; b.className = cls || ''; b.onclick = fn; return b; }

  // ---- Sidebar -------------------------------------------------------------------
  function library() {
    const q = $('search').value.trim().toLowerCase(), list = $('library');
    list.replaceChildren();
    $('listTitle').textContent = q ? 'Matching structures' : 'System layers';
    const entry = i => list.append(button(parts[i].name, () => { pick(i); focus(); }, 'result'));
    if (q) {
      const hits = parts.map((p, i) => p.name.toLowerCase().includes(q) ? i : -1).filter(i => i >= 0);
      $('count').textContent = hits.length;
      hits.forEach(entry);
      if (!hits.length) list.textContent = 'No matching structures.';
      return;
    }
    $('count').textContent = Object.keys(sets).length;
    for (const [s, ids] of Object.entries(sets)) {
      const row = document.createElement('div');
      row.className = 'row';
      const b = button('', () => { expanded = expanded === s ? '' : s; library(); });
      b.innerHTML = '<span class="swatch"></span>' + cap(s);
      b.style.setProperty('--t', palette[s]);
      b.setAttribute('aria-expanded', expanded === s);
      const visible = ids.some(i => shown[i]);
      const toggle = button('', () => { save(); ids.forEach(i => shown[i] = !visible); if (selected !== null && !shown[selected]) selected = null; sync(); }, 'eye');
      toggle.innerHTML = eye;
      toggle.style.opacity = visible ? 1 : .32;
      toggle.title = (visible ? 'Hide ' : 'Show ') + s + ' system';
      toggle.setAttribute('aria-label', toggle.title);
      row.append(b, toggle);
      list.append(row);
      if (expanded === s) ids.forEach(entry);
    }
  }

  $('lookup').onclick = async () => {
    await loadFacts();
    const p = parts[selected], d = $('detailText');
    d.replaceChildren();
    const add = (tag, txt) => { const node = document.createElement(tag); node.textContent = txt; d.append(node); return node; };
    add('small', cap(p.system) + ' system');
    add('h2', p.name);
    add('p', ({'Z-Anatomy': 'Z-Anatomy (CC BY-SA 4.0)', HRA: 'Human Reference Atlas · Female v1.5', BodyParts3D: 'BodyParts3D 4.0'}[p.source] || (folder === 'female' ? 'Human Reference Atlas · Female v1.5' : 'BodyParts3D 4.0')) + (p.conceptId ? ' · ' + p.conceptId : ''));
    if (p.latin) { const la = add('p', p.latin); la.className = 'latin'; }
    const f = factsFor(p.name);
    if (f) {
      if (f.summary) add('p', f.summary);
      const dl = document.createElement('dl'); dl.className = 'quick full';
      for (const [k, v] of orderedFields(f)) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); }
      d.append(dl);
      const src = add('a', 'Source: Wikipedia — ' + f.title + ' (CC BY-SA 4.0) ↗'); src.href = f.url; src.target = '_blank'; src.className = 'fine';
    }
    if (p.fitted) add('p', 'Fitted structure: male BodyParts3D anatomy reshaped to this female body (skin and skeleton registration). Approximate shape and position; the female source data does not include it.');
    add('p', 'Model extent (width × height × depth): ' + p.bounds[1].map((v, j) => Math.round((v - p.bounds[0][j]) * 1000)).join(' × ') + ' mm.');
    const link = add('a', 'Look up ' + p.name + ' in NCBI Bookshelf ↗');
    link.href = 'https://www.ncbi.nlm.nih.gov/books/?term=' + encodeURIComponent(p.name); link.target = '_blank';
    add('h3', 'Nearby anatomy');
    add('p', 'Closest sampled vertices in other mapped vessel and nerve systems. Distances are approximate and do not establish innervation or drainage.');
    for (const [i, dist] of near[selected]) d.append(button(parts[i].name + ' · ≈ ' + dist + ' mm', () => { $('details').close(); pick(i); focus(); }, 'near'));
    add('h3', 'Brain to great toe');
    add('p', 'For voluntary great-toe extension, signals descend from the contralateral leg area of motor cortex through the internal capsule and brainstem. Most fibers cross in the caudal medulla and descend in the lateral corticospinal tract. Spinal motor neurons send axons via the lumbosacral plexus, sciatic nerve, common fibular nerve and deep fibular nerve to extensor hallucis longus (primarily L5).');
    add('p', 'This pathway is a study guide. The reference meshes cover only some of its segments. Individual axons and synapses are beyond their resolution.');
    const ref = add('a', 'Read about the corticospinal tract and foot innervation ↗');
    ref.href = 'https://www.ncbi.nlm.nih.gov/books/?term=corticospinal+tract+OR+deep+peroneal+nerve'; ref.target = '_blank';
    imagingSection(p.name, d);
    $('details').showModal();
  };

  // ---- Controls ------------------------------------------------------------------
  $('search').oninput = library;
  $('view').onchange = front;
  $('fit').onclick = front;
  $('focus').onclick = focus;
  for (const [id, m] of [['plus', .8], ['minus', 1.25]]) $(id).onclick = () => {
    const v = camera.position.clone().sub(orbit.target);
    v.setLength(T.MathUtils.clamp(v.length() * m, MIN_DISTANCE, MAX_DISTANCE));
    camera.position.copy(orbit.target).add(v);
    orbit.update(); invalidate();
  };
  $('hide').onclick = () => remove(selected);
  $('solo').onclick = () => { save(); shown = shown.map((_, i) => i === selected); focus(); sync(); };
  $('undo').onclick = () => {
    if (!history.length) return;
    clearTissue();
    const wasReviewing = reviewing;
    [shown, selected, reviewing] = history.pop();
    if (reviewing !== wasReviewing) { if (reviewing) frameReview([ovary, ...bladder]); else front(); }
    sync();
  };
  function mode(on) {
    dissect = on;
    $('inspectMode').setAttribute('aria-pressed', !on);
    $('peel').setAttribute('aria-pressed', on);
    const touch = matchMedia('(pointer: coarse)').matches;
    $('hint').textContent = on ? (touch ? 'Tap to remove · Peel strips layers · Undo restores' : 'Select a structure to remove it · Peel to strip layers from the skin inward · Undo to restore')
      : (touch ? 'Drag to rotate · Pinch to zoom · Two fingers to pan · Tap to inspect' : 'Drag to rotate · Scroll to dive in · Right-drag to pan · Select to inspect');
    $('peelWrap').hidden = !on;
    if (!on && peel) { peel = 0; $('peelDepth').value = 0; $('peelOut').textContent = '0 mm'; sync(); }
  }
  $('peelDepth').oninput = () => { peel = +$('peelDepth').value; $('peelOut').textContent = peel + ' mm'; sync(); };
  $('inspectMode').onclick = () => mode(false);
  $('peel').onclick = () => mode(true);
  $('reset').onclick = () => {
    clearTissue(); save();
    shown = initial.slice(); selected = null; reviewing = false; expanded = '';
    $('search').value = ''; $('view').value = 'Anterior';
    mode(false);
    if (slicing) $('sliceButton').click();
    front(); sync();
  };
  mode(false);

  let down;
  const canvas = renderer.domElement;
  const ray = new T.Raycaster();
  function hitAt(e) {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new T.Vector2((e.clientX - r.left) / r.width * 2 - 1, 1 - (e.clientY - r.top) / r.height * 2), camera);
    const targets = meshes.filter(m => m?.visible);
    if (nerveSys?.visible) targets.push(...nerveSys.tubes);
    return ray.intersectObjects(targets, false).find(h => !h.object.material.clippingPlanes?.length || plane.distanceToPoint(h.point) >= 0);
  }
  canvas.addEventListener('pointerdown', e => {
    down = [e.clientX, e.clientY];
    if (markup && markup.tool !== 'none' && e.button === 0) {
      const hit = hitAt(e);
      if (hit && markup.pointerDown(hit)) { orbit.enabled = false; canvas.setPointerCapture(e.pointerId); e.preventDefault(); }
    }
  });
  canvas.addEventListener('pointermove', e => { if (markup?.drawing) markup.pointerMove(hitAt(e)); });
  canvas.addEventListener('pointerup', e => {
    if (markup?.drawing || !orbit.enabled) { markup?.pointerUp(); orbit.enabled = true; down = null; return; }
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    if (markup && markup.tool !== 'none') return;
    const hit = hitAt(e);
    if (stimArm !== null && hit) { stim.place(hit, stimArm); setStimArm(null); return; }
    if (hit?.object.userData.nerve) { selectNerve(hit.object.userData.nerve); return; }
    if (hit) {
      const i = hit.object.userData.index;
      if (nerveSys?.dermatomes.on && i === nerveSys.dermatomes.skinIndex) showDermatome(hit.point);
      dissect ? remove(i) : pick(i);
    } else { selected = null; selectedNerve = null; sync(); }
  });
  let stimArm = null;
  function setStimArm(k) {
    stimArm = k;
    $('placeA').setAttribute('aria-pressed', k === 0); $('placeC').setAttribute('aria-pressed', k === 1);
    $('hint').textContent = k === null ? 'Drag to rotate · Scroll to dive in · Right-drag to pan · Select to inspect' : `Click a structure to place the ${k ? 'cathode (−)' : 'anode (+)'}`;
  }
  function selectNerve(n) { selected = null; selectedNerve = n; sync(); }
  function showDermatome(p) {
    const L = nerveSys.dermatomeAt(p);
    if (!L) return;
    openTab('nerves');
    runTrace({level: L.startsWith('V') ? null : L, side: p.x > 0 ? 1 : -1, kind: $('pathKind').value === 'motor' ? 'touch' : $('pathKind').value, label: L});
  }

  const requestedStructure = query.get('structure');
  if (canReview && query.get('view') === 'pelvic-review') showReview();
  else if (/^\d+$/.test(requestedStructure) && Number(requestedStructure) < parts.length) {
    selected = Number(requestedStructure);
    shown = parts.map((_, i) => i === selected);
    focus(); sync();
  } else sync();

  // ---- Base geometry -------------------------------------------------------------
  function prepare(i, geometry) {
    if (FIBROUS.has(tissueKeys[i])) addFiberAxis(T, geometry);
  }
  let cursor = 0, loaded = 0;
  async function worker() {
    while (cursor < atlas.chunks.length) {
      const n = cursor++, r = await fetch(folder + '/body-' + n + '.gz');
      if (!r.ok) throw Error('Model download failed');
      let buffer = await r.arrayBuffer();
      const head = new Uint8Array(buffer, 0, 2);
      if (head[0] === 31 && head[1] === 139) buffer = await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      parts.forEach((p, i) => {
        if (p.chunk !== n) return;
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(new Float32Array(buffer, p.positions, p.vertexCount * 3), 3));
        g.setAttribute('normal', new T.BufferAttribute(new Int16Array(buffer, p.normals, p.vertexCount * 3), 3, true));
        g.setIndex(new T.BufferAttribute(new Uint32Array(buffer, p.indices, p.indexCount), 1));
        prepare(i, g);
        const mesh = new T.Mesh(g, materialFor(i));
        mesh.userData.index = i;
        mesh.visible = shown[i];
        scene.add(mesh);
        meshes[i] = mesh;
      });
      invalidate();
      $('notice').textContent = 'Loading anatomy · ' + Math.round(++loaded / atlas.chunks.length * 100) + '%';
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  $('notice').hidden = true;

  clearTissue = setupTissueVessels({T, parts, meshes, scene, camera, orbit, invalidate, button: $('tissueVessels'), status: $('tissueStatus'), currentSelection: () => selected, showOnly(i) {
    save();
    reviewing = false;
    selected = i;
    shown = parts.map((_, j) => i === j);
    if (slicing) $('sliceButton').click();
    mode(false);
    sync();
  }});

  labels = setupLabels({T, parts, meshes, camera, viewport: $('viewport'), renderer, onPick: i => { pick(i); }, extraHidden: i => parts[i].system === 'attachment',
    avoid: () => ['inspect', 'slicePanel', 'view', 'detailStatus'].map(id => $(id)).filter(e => e && !e.hidden && e.offsetParent).map(e => e.getBoundingClientRect()).concat([document.querySelector('.tools').getBoundingClientRect(), document.querySelector('.zoom').getBoundingClientRect()])});
  $('labelsBtn').onclick = () => { labels.set(!labels.on); $('labelsBtn').setAttribute('aria-pressed', labels.on); $('stage').classList.toggle('labelling', labels.on); labels.select(selected); };

  // ---- Tabs ----------------------------------------------------------------------
  function openTab(name) {
    for (const t of ['layers', 'nerves', 'stim', 'patients']) {
      $('tab-' + t).setAttribute('aria-selected', t === name);
      $('panel-' + t).hidden = t !== name;
    }
    if (name !== 'stim') setStimArm(null);
    if (name !== 'patients' && markup) { markup.setTool('none'); }
  }
  for (const t of ['layers', 'nerves', 'stim', 'patients']) $('tab-' + t).onclick = () => openTab(t);

  // ---- Nerves & pathways ----------------------------------------------------------
  try {
    nerveSys = await setupNerves({T, folder, parts, meshes, scene, tissues, invalidate});
  } catch (e) { console.warn('Nerve model unavailable', e); }
  function runTrace(opts) {
    if (!nerveSys) return;
    if (!nerveSys.visible) { $('nervesOn').checked = true; nerveSys.setVisible(true); }
    const out = nerveSys.trace(opts), box = $('traceOut');
    traceParts.clear();
    const realNames = new Set([...out.ids].map(id => nerveSys.byId.get(id)?.name?.toLowerCase()).filter(Boolean));
    parts.forEach((p, i) => { if (p.system === 'nervous' && realNames.has(p.name.toLowerCase())) { traceParts.add(i); shown[i] = true; } });
    sync();
    if (out.box && !out.box.isEmpty()) {
      const c = out.box.getCenter(new T.Vector3()), size = out.box.getSize(new T.Vector3()).length();
      orbit.target.copy(c);
      const dir = camera.position.clone().sub(c).normalize();
      camera.position.copy(c).addScaledVector(dir, Math.max(.25, size * 1.5 / Math.min(1, camera.aspect)));
      orbit.update(); invalidate();
    }
    box.replaceChildren();
    const h = document.createElement('h5'); h.textContent = out.title + (opts.label?.startsWith('V') ? ` (trigeminal ${opts.label} dermatome)` : ''); box.append(h);
    const ol = document.createElement('ol');
    out.steps.forEach(t => { const li = document.createElement('li'); li.textContent = t; ol.append(li); });
    box.append(ol);
    const muscles = opts.nerve ? [...nerveSys.musclesOf(opts.nerve)] : opts.level ? [...new Set(nerveSys.model.nerves.filter(n => n.segments.includes(opts.level) && (!opts.side || n.side === (opts.side > 0 ? 'left' : 'right'))).flatMap(n => n.muscles || []))] : [];
    if (muscles.length) {
      const t = document.createElement('p'); t.className = 'fine'; t.textContent = 'Muscles supplied (modeled):'; box.append(t);
      const chips = document.createElement('div'); chips.className = 'chips';
      muscles.slice(0, 40).forEach(m => { const i = parts.findIndex(p => p.name === m); if (i >= 0) chips.append(button(m, () => { pick(i); focus(); }, '')); });
      box.append(chips);
    }
    if (nerveSys.dermatomes.on && out.segments?.length === 1) nerveSys.dermatomes.set(true, out.segments[0]);
    document.querySelectorAll('#levelGrid button').forEach(b => b.setAttribute('aria-pressed', b.textContent === opts.level));
  }
  if (nerveSys) {
    const grid = $('levelGrid');
    nerveSys.levels.forEach(l => {
      const b = button(l.id, () => runTrace({level: l.id, side: Number($('pathSide').value), kind: $('pathKind').value}), '');
      b.style.setProperty('--c', nerveSys.dermatomes.colorOf(l.id)); b.title = l.exit + '\n' + l.dermatome; b.setAttribute('aria-pressed', 'false');
      grid.append(b);
    });
    $('nervesOn').onchange = () => { nerveSys.setVisible($('nervesOn').checked); if (!$('nervesOn').checked) nerveSys.clearTrace(); };
    $('dermOn').onchange = () => {
      const on = $('dermOn').checked, skin = nerveSys.dermatomes.skinIndex;
      if (on && skin >= 0 && !shown[skin]) { save(); shown[skin] = true; }
      nerveSys.dermatomes.set(on);
      sync();
    };
    $('traceClear').onclick = () => { traceParts.clear(); sync(); nerveSys.clearTrace(); $('traceOut').replaceChildren(); if (nerveSys.dermatomes.on) nerveSys.dermatomes.set(true); };
    const traceCurrent = () => {
      openTab('nerves');
      const kind = $('pathKind').value;
      if (selectedNerve) return runTrace({nerve: selectedNerve, kind});
      if (selected === null) { $('traceOut').textContent = 'Select a muscle, vertebra, nerve or skin first (or pick a spinal level below).'; return; }
      const p = parts[selected];
      const levels = nerveSys.vertebraLevels(p.name);
      if (levels.length) return runTrace({level: levels[0], side: Number($('pathSide').value), kind});
      const ns = nerveSys.nervesForMuscle(p.name).filter(n => n.kind !== 'twig');
      if (ns.length) return runTrace({nerve: ns[0], muscle: p.name, kind: kind === 'motor' ? 'motor' : kind});
      if (p.name === 'Skin') { $('traceOut').textContent = 'Turn on the dermatome map and click the skin to trace that spot.'; return; }
      $('traceOut').textContent = `No modeled nerve supply for “${p.name}”. Try a skeletal muscle, a vertebra, or a spinal level.`;
    };
    $('traceSelected').onclick = traceCurrent;
    $('trace').onclick = traceCurrent;
  } else { $('tab-nerves').disabled = true; }

  // ---- Stimulation ------------------------------------------------------------------
  if (nerveSys) {
    stim = setupStim({T, parts, meshes, scene, nerves: nerveSys, invalidate, tissues, stimUniforms: tissues.stim});
    const toCurrent = x => 0.001 * Math.pow(10, x / 1000 * 5); // slider 0..1000 -> 1 µA .. 100 mA
    const fromCurrent = mA => Math.round(Math.log10(mA / .001) / 5 * 1000);
    const fmt = mA => mA < .01 ? (mA * 1000).toFixed(1) + ' µA' : mA < 1 ? (mA * 1000).toFixed(0) + ' µA' : mA.toFixed(mA < 10 ? 2 : 1) + ' mA';
    const read = () => {
      stim.set({mode: $('stimMode').value, current: toCurrent(+$('stimI').value), pw: +$('stimPW').value || 200, freq: +$('stimF').value || 30, area: +$('stimArea').value || 4, depth: +$('stimDepth').value || 0});
      $('stimIOut').textContent = fmt(stim.state.current);
      $('stimAreaField').hidden = stim.state.mode !== 'surface'; $('stimDepthField').hidden = stim.state.mode === 'surface';
    };
    for (const id of ['stimMode', 'stimI', 'stimPW', 'stimF', 'stimArea', 'stimDepth']) $(id).oninput = () => { $('stimPreset').value = ''; read(); };
    $('stimPreset').onchange = () => {
      const P = {tens: ['surface', 15, 200, 30, 25], motor: ['surface', 30, 300, 35, 25], block: ['implanted', .5, 100, 2, null, 3], penfield: ['implanted', 4, 300, 50, null, 1], micro: ['implanted', .1, 100, 10, null, 1]}[$('stimPreset').value];
      if (!P) return;
      $('stimMode').value = P[0]; $('stimI').value = fromCurrent(P[1]); $('stimPW').value = P[2]; $('stimF').value = P[3];
      if (P[4]) $('stimArea').value = P[4]; if (P[5] != null) $('stimDepth').value = P[5];
      read();
    };
    $('placeA').onclick = () => setStimArm(stimArm === 0 ? null : 0);
    $('placeC').onclick = () => setStimArm(stimArm === 1 ? null : 1);
    $('stimClear').onclick = () => { stim.clear(); stimMuscles.clear(); sync(); };
    $('stimSave').onclick = () => {
      if (!markup?.active()) { openTab('patients'); $('noPatient').textContent = 'Create or pick a person first, then save the stimulation again.'; return; }
      const a = markup.addStim(stim.snapshot()); if (a) { openTab('patients'); }
    };
    stim.onResult(r => {
      const out = $('stimOut'); out.replaceChildren();
      stimMuscles.clear();
      if (!r) { sync(); return; }
      const sec = (t) => { const h = document.createElement('h5'); h.textContent = t; out.append(h); };
      const line = (t, cls = 'hit', onClick) => { const d = document.createElement('div'); d.className = cls; d.textContent = t; if (onClick) { d.style.cursor = 'pointer'; d.onclick = onClick; } out.append(d); };
      const m = document.createElement('div'); m.className = 'meter';
      m.textContent = `≈ ${r.voltage < 1 ? (r.voltage * 1000).toFixed(0) + ' mV' : r.voltage.toFixed(1) + ' V'} across the electrodes · ${r.chargeDensity.toFixed(2)} µC/cm² per phase`;
      out.append(m);
      r.warnings.forEach(w => line('⚠ ' + w, 'warn'));
      if (!r.skin.length && !r.nerves.length && !r.cortex.length) line('Nothing reaches threshold. Increase current or pulse width, or move the electrodes closer to a nerve.', 'hit sub');
      if (r.skin.length) { sec('Skin'); r.skin.forEach(x => line(`${x.electrode ? 'Cathode' : 'Anode'}: ${x.label} — ${x.where}`, x.ratio >= 1 ? 'hit' : 'hit sub')); }
      if (r.nerves.length) {
        sec('Nerve fibres excited');
        const seen = new Set();
        r.nerves.forEach(x => { const key = x.nerve.id + x.fibre.id; if (seen.has(key) || seen.size > 24) return; seen.add(key);
          line(`${x.nerve.name} · ${x.fibre.name} (${x.ratio.toFixed(1)}×) → ${x.fibre.effect}${!x.fibre.motor && x.nerve.skin ? ' — felt in: ' + x.nerve.skin : ''}`, 'hit', () => selectNerve(x.nerve)); });
      }
      if (r.muscles.size) {
        sec(stim.state.freq >= 20 ? 'Muscles contracting (fused at ≥20 Hz)' : 'Muscles twitching');
        for (const [name, x] of r.muscles) { stimMuscles.add(name); const i = parts.findIndex(p => p.name === name); line(`${name} — via ${x.via}`, 'hit', i >= 0 ? () => { pick(i); focus(); } : null); }
      }
      if (r.cortex.length) { sec('Brain'); r.cortex.forEach(c => line(`${c.area} — ${c.name} (${c.side}): ${c.effect} [${c.ratio.toFixed(1)}×]`)); }
      sync();
    });
    read();
  } else { $('tab-stim').disabled = true; }

  // ---- Patients & markup ------------------------------------------------------------
  markup = setupMarkup({T, scene, parts, folder, invalidate, onFocus(a) {
    const box = new T.Box3(); a.points.forEach(q => box.expandByPoint(new T.Vector3(...q)));
    box.getCenter(orbit.target);
    const dir = camera.position.clone().sub(orbit.target).normalize();
    camera.position.copy(orbit.target).addScaledVector(dir, Math.max(.12, box.getSize(new T.Vector3()).length() * 3));
    orbit.update(); invalidate();
  }});
  function renderPatients(focusId) {
    const db = markup.db, p = markup.active();
    $('patientSel').replaceChildren(...db.patients.map(x => { const o = document.createElement('option'); o.value = x.id; o.textContent = x.name + (x.relation ? ` (${x.relation})` : ''); o.selected = x.id === db.activeId; return o; }));
    $('patientForm').hidden = !p; $('noPatient').hidden = !!p;
    if (!p) return;
    if (document.activeElement?.closest?.('#patientForm') == null || focusId === 'all') {
      $('pName').value = p.name || ''; $('pRel').value = p.relation || ''; $('pDob').value = p.dob || ''; $('pBody').value = p.body || folder; $('pNotes').value = p.notes || '';
    }
    for (const [id, t] of [['toolNone', 'none'], ['toolPin', 'pin'], ['toolDraw', 'draw']]) $(id).setAttribute('aria-pressed', markup.tool === t);
    const list = $('annotations'); list.replaceChildren();
    const mine = p.annotations.filter(a => a.body === folder), other = p.annotations.length - mine.length;
    mine.forEach((a, n) => {
      const card = document.createElement('div'); card.className = 'annotation'; card.style.setProperty('--c', a.color);
      const head = document.createElement('header');
      const label = document.createElement('span'); label.textContent = `${n + 1}. ${a.type === 'pin' ? '📍' : a.type === 'stim' ? '⚡' : '✎'} ${a.partName || a.type}`;
      head.append(label, button('Go', () => markup.focus(a.id), ''), button('✕', () => { if (confirm('Delete this note?')) markup.removeAnnotation(a.id); }, ''));
      const ta = document.createElement('textarea'); ta.rows = 2; ta.placeholder = 'Note…'; ta.value = a.note || '';
      ta.onchange = () => markup.annotate(a.id, {note: ta.value});
      card.append(head);
      if (a.type === 'stim' && a.stim) { const d = document.createElement('div'); d.className = 'fine'; d.textContent = `${a.stim.mode}, ${a.stim.current_mA} mA, ${a.stim.pulseWidth_us} µs, ${a.stim.frequency_Hz} Hz — ${(a.stim.summary || []).slice(0, 3).join(' · ')}`; card.append(d); }
      card.append(ta);
      list.append(card);
      if (a.id === focusId) setTimeout(() => ta.focus(), 50);
    });
    if (other) { const d = document.createElement('p'); d.className = 'fine'; d.textContent = `${other} more note(s) on the other reference body.`; list.append(d); }
    if ($('rawBox').hidden === false && document.activeElement !== $('rawJson')) $('rawJson').value = JSON.stringify(p, null, 2);
  }
  markup.onChange(id => renderPatients(id));
  $('swatches').replaceChildren(...markup.PALETTE.map(c => { const b = button('', () => { markup.setColor(c); [...$('swatches').children].forEach(x => x.setAttribute('aria-pressed', x === b)); }, ''); b.style.setProperty('--c', c); b.setAttribute('aria-label', 'Colour ' + c); b.setAttribute('aria-pressed', c === markup.color); return b; }));
  $('patientNew').onclick = () => { const name = prompt('Name for the new person?', ''); if (name !== null) { markup.addPatient({name: name.trim() || 'New person', body: folder}); renderPatients('all'); } };
  $('patientSel').onchange = () => { markup.select($('patientSel').value); renderPatients('all'); };
  for (const [id, key] of [['pName', 'name'], ['pRel', 'relation'], ['pDob', 'dob'], ['pBody', 'body'], ['pNotes', 'notes']]) $(id).onchange = () => markup.update({[key]: $(id).value});
  for (const [id, t] of [['toolNone', 'none'], ['toolPin', 'pin'], ['toolDraw', 'draw']]) $(id).onclick = () => { markup.setTool(t); setStimArm(null); $('hint').textContent = t === 'none' ? 'Drag to rotate · Scroll to dive in · Right-drag to pan · Select to inspect' : t === 'pin' ? 'Click a structure to pin a note' : 'Drag on a surface to draw · release to save'; };
  $('exportAll').onclick = () => markup.exportJSON(true);
  $('exportOne').onclick = () => markup.exportJSON(false);
  $('importFile').onchange = async () => {
    const f = $('importFile').files[0]; if (!f) return;
    try { const r = markup.importJSON(await f.text()); alert(`Imported: ${r.added} new, ${r.updated} updated.`); renderPatients('all'); }
    catch (e) { alert('That file is not valid JSON: ' + e.message); }
    $('importFile').value = '';
  };
  $('rawToggle').onclick = () => { $('rawBox').hidden = !$('rawBox').hidden; if (!$('rawBox').hidden) $('rawJson').value = JSON.stringify(markup.active(), null, 2); };
  $('rawApply').onclick = () => {
    try { const obj = JSON.parse($('rawJson').value); obj.id = markup.active().id; markup.importJSON(JSON.stringify({patients: [obj]})); renderPatients('all'); }
    catch (e) { alert('Invalid JSON: ' + e.message); }
  };
  $('patientDelete').onclick = () => { const p = markup.active(); if (p && confirm(`Delete ${p.name} and all their notes from this browser? Export first if you want a copy.`)) { markup.remove(); renderPatients('all'); } };
  renderPatients('all'); markup.render();

  // ---- Full-resolution streaming ---------------------------------------------------
  if (gpu) {
    const badge = $('detailStatus');
    detail = await setupDetailStreaming({
      T, folder, parts, meshes, camera, orbit, shown: () => shown,
      onGeometry(i, g) { prepare(i, g); if (i === nerveSys?.dermatomes.skinIndex) queueMicrotask(() => nerveSys.dermatomes.refresh()); invalidate(); },
      onProgress({ready, total, loading}) {
        badge.hidden = !ready && !loading;
        badge.classList.toggle('busy', loading > 0);
        badge.textContent = loading ? `Streaming full resolution · ${ready}/${total}` : `Full resolution · ${ready}/${total} regions`;
        badge.title = 'Regions near the camera switch from the simplified model to the unsimplified source meshes.';
      },
    });
    if (selected !== null) detail?.want(selected);
    detail?.schedule();
  }
}

start().catch(e => { $('notice').textContent = 'Model unavailable. Enable WebGL and reload.'; console.error(e); });
