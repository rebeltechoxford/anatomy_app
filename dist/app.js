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
  let clearTissue = () => {}, detail = null;
  const query = new URLSearchParams(location.search);
  const notes = new URLSearchParams(location.hash.slice(1));
  const folder = query.get('body') === 'female' ? 'female' : 'models';
  for (const id of ['vesselsLink', 'microLink', 'specimenLink']) $(id).search = '?body=' + folder;
  $('body').value = folder;
  $('body').onchange = () => location.search = '?body=' + $('body').value;
  if (folder === 'female') $('sourceName').textContent = 'Adult female / Human Reference Atlas';

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
    return tissues.get(tissueKeys[i], i === selected);
  }

  // ---- View state ----------------------------------------------------------------
  const meshes = [];
  const sets = Object.fromEntries(Object.keys(palette).map(s => [s, parts.map((p, i) => p.system === s ? i : -1).filter(i => i >= 0)]));
  const initial = parts.map(p => !['integumentary', 'pregnancy'].includes(p.system)), history = [];
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
    for (const m of [...tissues.all(), ovaryColor, bladderColor, selectedOvaryColor, selectedBladderColor]) {
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
    meshes.forEach((m, i) => { m.visible = shown[i]; m.material = materialFor(i); });
    cut(); // after material assignment so newly created materials get the plane
    $('undo').disabled = !history.length;
    $('inspect').hidden = selected === null;
    if (selected !== null) {
      $('part').textContent = parts[selected].name;
      $('system').textContent = parts[selected].system.toUpperCase() + ' SYSTEM';
      detail?.want(selected);
    }
    library();
    detail?.schedule();
    invalidate();
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

  function pick(i) { if (!shown[i]) { save(); shown[i] = true; } selected = i; sync(); }
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

  $('lookup').onclick = () => {
    const p = parts[selected], d = $('detailText');
    d.replaceChildren();
    const add = (tag, txt) => { const node = document.createElement(tag); node.textContent = txt; d.append(node); return node; };
    add('small', cap(p.system) + ' system');
    add('h2', p.name);
    add('p', (folder === 'female' ? 'Human Reference Atlas · Female v1.5' : 'BodyParts3D · Male v4.0') + (p.conceptId ? ' · ' + p.conceptId : ''));
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
    $('hint').textContent = on ? 'Select a structure to remove it · Undo to restore' : 'Drag to rotate · Scroll to dive in · Right-drag to pan · Select to inspect';
  }
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
  canvas.addEventListener('pointerdown', e => down = [e.clientX, e.clientY]);
  canvas.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const r = canvas.getBoundingClientRect(), ray = new T.Raycaster();
    ray.setFromCamera(new T.Vector2((e.clientX - r.left) / r.width * 2 - 1, 1 - (e.clientY - r.top) / r.height * 2), camera);
    const hit = ray.intersectObjects(meshes.filter(m => m.visible), false)
      .find(h => !h.object.material.clippingPlanes?.length || plane.distanceToPoint(h.point) >= 0);
    if (hit) { const i = hit.object.userData.index; dissect ? remove(i) : pick(i); }
    else { selected = null; sync(); }
  });

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

  // ---- Full-resolution streaming ---------------------------------------------------
  if (gpu) {
    const badge = $('detailStatus');
    detail = await setupDetailStreaming({
      T, folder, parts, meshes, camera, orbit, shown: () => shown,
      onGeometry(i, g) { prepare(i, g); invalidate(); },
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
