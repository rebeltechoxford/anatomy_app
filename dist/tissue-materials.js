// Tissue materials: physically based shading with procedural, zoom-adaptive
// surface detail.
//
// The meshes have no UVs, so detail is a solid (3D) texture evaluated in world
// space. Octaves are added or faded by the on-screen size of one pixel, so
// more fine detail appears as the camera moves closer, without shimmering when
// it is far away. Bump amplitude is proportional to each octave's wavelength,
// which keeps surface slopes consistent at every zoom level.
//
// Pattern ids: 0 mottled organ, 1 fibrous (muscle/tendon/nerve), 2 bone,
// 3 skin, 4 lobular (fat, glands, lung, liver), 5 smooth wet (vessels, gut).

// Colours are sRGB references for fresh (embalming-free) tissue, tuned for
// legibility under the viewer's lighting rather than measured.
export const TISSUES = {
  bone:      {color:'#d9c7a2', alt:'#ad9467', pattern:2, scale:.014, bump:.45, vary:.16, roughness:.66, clearcoat:.05},
  enamel:    {color:'#f3efe2', alt:'#ddd3bb', pattern:0, scale:.004, bump:.08, vary:.04, roughness:.22, clearcoat:.65},
  gum:       {color:'#c96f70', alt:'#a9525a', pattern:0, scale:.004, bump:.2,  vary:.12, roughness:.45, clearcoat:.5},
  cartilage: {color:'#d6dcd6', alt:'#b9c6c4', pattern:0, scale:.010, bump:.12, vary:.07, roughness:.32, clearcoat:.55},
  tendon:    {color:'#e7dfcd', alt:'#c9bb9d', pattern:1, scale:.006, bump:.35, vary:.10, roughness:.38, clearcoat:.45, sheen:.4, sheenColor:'#fffaf0', fiber:.06},
  muscle:    {color:'#922a24', alt:'#5e1612', pattern:1, scale:.008, bump:.75, vary:.20, roughness:.52, clearcoat:.32, sheen:.6, sheenColor:'#ff9b8a', fiber:.07},
  heart:     {color:'#8f2b27', alt:'#5e1714', pattern:1, scale:.008, bump:.55, vary:.18, roughness:.45, clearcoat:.45, sheen:.5, sheenColor:'#ff9b8a', fiber:.12},
  artery:    {color:'#b8271f', alt:'#86140f', pattern:5, scale:.010, bump:.12, vary:.10, roughness:.30, clearcoat:.7},
  vein:      {color:'#3f4f8c', alt:'#2a3466', pattern:5, scale:.010, bump:.12, vary:.12, roughness:.30, clearcoat:.7},
  lymph:     {color:'#d8c98e', alt:'#b7a361', pattern:4, scale:.004, bump:.25, vary:.12, roughness:.40, clearcoat:.5},
  nerve:     {color:'#efdca4', alt:'#cdb06a', pattern:1, scale:.004, bump:.45, vary:.12, roughness:.42, clearcoat:.35, sheen:.4, sheenColor:'#fff3cc', fiber:.05},
  brain:     {color:'#dcb8ad', alt:'#b88b83', pattern:0, scale:.006, bump:.35, vary:.12, roughness:.42, clearcoat:.55},
  cord:      {color:'#ead6c5', alt:'#cfb29e', pattern:1, scale:.006, bump:.25, vary:.08, roughness:.40, clearcoat:.5, fiber:.15},
  lung:      {color:'#d79294', alt:'#a85c66', pattern:4, scale:.006, bump:.45, vary:.22, roughness:.55, clearcoat:.4},
  airway:    {color:'#e3bab1', alt:'#c69689', pattern:0, scale:.006, bump:.2,  vary:.10, roughness:.40, clearcoat:.5},
  liver:     {color:'#7c2c21', alt:'#561a12', pattern:4, scale:.004, bump:.25, vary:.14, roughness:.35, clearcoat:.65},
  gut:       {color:'#dc9d8c', alt:'#b46e66', pattern:5, scale:.008, bump:.3,  vary:.16, roughness:.36, clearcoat:.65},
  kidney:    {color:'#843226', alt:'#5c1e16', pattern:0, scale:.006, bump:.18, vary:.12, roughness:.36, clearcoat:.6},
  urinary:   {color:'#d9a092', alt:'#b97668', pattern:5, scale:.008, bump:.2,  vary:.12, roughness:.38, clearcoat:.55},
  repro:     {color:'#cc8c91', alt:'#a3646e', pattern:0, scale:.006, bump:.2,  vary:.14, roughness:.40, clearcoat:.55},
  gland:     {color:'#b9674f', alt:'#8b4434', pattern:4, scale:.003, bump:.3,  vary:.16, roughness:.42, clearcoat:.5},
  spleen:    {color:'#6e2b3c', alt:'#4b1928', pattern:0, scale:.004, bump:.15, vary:.14, roughness:.38, clearcoat:.6},
  fat:       {color:'#f1d077', alt:'#d4a94a', pattern:4, scale:.008, bump:.5,  vary:.14, roughness:.30, clearcoat:.55},
  skin:      {color:'#d6a487', alt:'#b47f68', pattern:3, scale:.010, bump:.35, vary:.10, roughness:.55, clearcoat:.08, sheen:.5, sheenColor:'#ffd7c2'},
  eye:       {color:'#efeae2', alt:'#d8cdbd', pattern:0, scale:.004, bump:.05, vary:.05, roughness:.18, clearcoat:.9},
  sensory:   {color:'#dcc6ae', alt:'#bea084', pattern:0, scale:.004, bump:.2,  vary:.10, roughness:.40, clearcoat:.45},
  pregnancy: {color:'#b98a9a', alt:'#916575', pattern:5, scale:.008, bump:.2,  vary:.12, roughness:.40, clearcoat:.55},
};

// Representative colour per display system for the sidebar swatches.
export const SYSTEM_SWATCH = {adipose:'fat', pregnancy:'pregnancy', muscular:'muscle', skeletal:'bone', connective:'tendon',
  integumentary:'skin', arterial:'artery', venous:'vein', nervous:'nerve', respiratory:'lung', cardiac:'heart', digestive:'gut',
  urinary:'urinary', reproductive:'repro', endocrine:'gland', lymphatic:'lymph', sensory:'sensory'};

const BRAIN = /\b(brain|cerebr|cortex|gyrus|sulcus|thalam|caudate|putamen|pallid|hippocamp|amygdal|cerebell|pons|medulla oblongata|midbrain|mesenceph|diencephal|nucleus|allen|vermis|insula|claustrum|fornix|corpus callosum|hypothal|tegment|colliculus|ventricle of brain|lateral ventricle|third ventricle|fourth ventricle|zona incerta|lobule|uncus|cuneus|precuneus|operculum)/;

// Classify one atlas part into a tissue key. First match wins.
export function tissueFor(part) {
  const n = part.name.toLowerCase(), s = part.system;
  if (s === 'pregnancy') return 'pregnancy';
  if (s === 'adipose' || /\bfat\b|adipose/.test(n)) return 'fat';
  if (/\b(tooth|teeth|incisor|canine|molar|premolar)\b/.test(n)) return 'enamel';
  if (/gingiva/.test(n)) return 'gum';
  if (/cartilage|menisc|intervertebral dis|articular dis|labrum|epiglottis/.test(n)) return 'cartilage';
  if (/tendon|ligament|aponeuros|fascia|retinacul|capsule of|tendinous|linea alba|membrane of|interosseous membrane/.test(n)) return 'tendon';
  switch (s) {
    case 'skeletal': return 'bone';
    case 'connective': return 'tendon';
    case 'muscular': return /tongue/.test(n) ? 'muscle' : 'muscle';
    case 'cardiac': return /valve|chorda|cusp|leaflet/.test(n) ? 'tendon' : 'heart';
    case 'arterial': return 'artery';
    case 'venous': return 'vein';
    case 'lymphatic': return /spleen|splenic/.test(n) ? 'spleen' : /thymus/.test(n) ? 'gland' : 'lymph';
    case 'nervous': return /spinal cord|cauda equina|segment/.test(n) && !BRAIN.test(n) ? 'cord' : BRAIN.test(n) ? 'brain' : 'nerve';
    case 'respiratory': return /lung|lobe|segment|pleura|alveol/.test(n) && !/bronch/.test(n) ? 'lung' : 'airway';
    case 'digestive':
      if (/liver|hepat|lobe of liver|caudate lobe|quadrate lobe/.test(n)) return 'liver';
      if (/pancrea|salivary|parotid|submandibular gland|sublingual gland/.test(n)) return 'gland';
      if (/spleen/.test(n)) return 'spleen';
      if (/tongue/.test(n)) return 'muscle';
      if (/gallbladder|gall bladder/.test(n)) return 'urinary';
      return 'gut';
    case 'urinary': return /kidney|renal|calyx|pyramid|cortex|medulla|nephr/.test(n) ? 'kidney' : 'urinary';
    case 'reproductive': return 'repro';
    case 'endocrine': return 'gland';
    case 'integumentary': return /mammary|breast|lobule|gland/.test(n) ? 'gland' : 'skin';
    case 'sensory': return /eyeball|sclera|cornea|lens|bulb of eye|retina|conjunctiva|eye\b/.test(n) ? 'eye' : 'sensory';
    default: return 'sensory';
  }
}

const NOISE_GLSL = /* glsl */`
uniform int tPattern;
uniform float tScale, tBump, tVary, tFiber, tRim;
uniform vec3 tAlt;
varying vec3 vTPos;
varying vec3 vTFiber;
float tHeight, tPit, tMottle;
vec3 tGrad; // world-space gradient of the height field (analytic, alias-free)

vec3 tHash(vec3 p){
  p = vec3(dot(p,vec3(127.1,311.7,74.7)), dot(p,vec3(269.5,183.3,246.1)), dot(p,vec3(113.5,271.9,124.6)));
  return -1.0 + 2.0*fract(sin(p)*43758.5453123);
}
// Gradient noise with analytic derivatives: vec4(value, d/dx, d/dy, d/dz).
vec4 tNoiseD(vec3 x){
  vec3 i = floor(x), f = fract(x);
  vec3 u = f*f*(3.0-2.0*f), du = 6.0*f*(1.0-f);
  vec3 ga=tHash(i), gb=tHash(i+vec3(1,0,0)), gc=tHash(i+vec3(0,1,0)), gd=tHash(i+vec3(1,1,0));
  vec3 ge=tHash(i+vec3(0,0,1)), gf=tHash(i+vec3(1,0,1)), gg=tHash(i+vec3(0,1,1)), gh=tHash(i+vec3(1,1,1));
  float va=dot(ga,f), vb=dot(gb,f-vec3(1,0,0)), vc=dot(gc,f-vec3(0,1,0)), vd=dot(gd,f-vec3(1,1,0));
  float ve=dot(ge,f-vec3(0,0,1)), vf=dot(gf,f-vec3(1,0,1)), vg=dot(gg,f-vec3(0,1,1)), vh=dot(gh,f-vec3(1,1,1));
  float v = va + u.x*(vb-va) + u.y*(vc-va) + u.z*(ve-va) + u.x*u.y*(va-vb-vc+vd) + u.y*u.z*(va-vc-ve+vg)
          + u.z*u.x*(va-vb-ve+vf) + u.x*u.y*u.z*(-va+vb+vc-vd+ve-vf-vg+vh);
  vec3 d = ga + u.x*(gb-ga) + u.y*(gc-ga) + u.z*(ge-ga) + u.x*u.y*(ga-gb-gc+gd) + u.y*u.z*(ga-gc-ge+gg)
         + u.z*u.x*(ga-gb-ge+gf) + u.x*u.y*u.z*(-ga+gb+gc-gd+ge-gf-gg+gh)
         + du*(vec3(vb-va,vc-va,ve-va) + u.yzx*vec3(va-vb-vc+vd,va-vc-ve+vg,va-vb-ve+vf)
         + u.zxy*vec3(va-vb-ve+vf,va-vb-vc+vd,va-vc-ve+vg) + u.yzx*u.zxy*(-va+vb+vc-vd+ve-vf-vg+vh));
  return vec4(v, d) * 1.6;
}
// Distance to the nearest cell centre (Worley) and its gradient.
vec4 tCellsD(vec3 p){
  vec3 i = floor(p), f = fract(p), best = vec3(1);
  float d = 8.0;
  for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) for(int z=-1;z<=1;z++){
    vec3 g = vec3(x,y,z), r = g + .5 + .45*tHash(i+g) - f;
    float e = dot(r,r);
    if (e < d) { d = e; best = r; }
  }
  float l = sqrt(d);
  return vec4(l, -best/max(l,1e-5));
}
// Smoothstep with derivative: vec2(value, d/dx).
vec2 tStep(float a, float b, float x){
  float t = clamp((x-a)/(b-a), 0.0, 1.0);
  return vec2(t*t*(3.0-2.0*t), (x>a && x<b) ? 6.0*t*(1.0-t)/(b-a) : 0.0);
}

void tissueDetail(){
  // Stretch space along the fibre axis so features become streaks: p' = M p.
  vec3 t = vec3(0); float squash = 0.0;
  float fl = length(vTFiber);
  if (fl > .5 && tFiber > 0.0) { t = vTFiber/fl; squash = 1.0 - tFiber; }
  vec3 p = vTPos - t*dot(vTPos,t)*squash;
  // World size of one pixel at this fragment.
  float px = max(length(fwidth(vTPos)), 1e-7);
  float h = 0.0, wave = tScale, amp = 1.0;
  vec3 g = vec3(0);
  tPit = 0.0;
  for (int i = 0; i < 10; i++) {
    // Fade an octave in once its wavelength spans a few pixels.
    float w = smoothstep(3.0*px, 9.0*px, wave);
    if (w <= 0.0) break;
    vec3 q = p/wave + float(i)*17.31;
    vec4 n;
    if (tPattern == 1) {                                   // rounded fibre bundles with grooves
      vec4 a = tNoiseD(q); float s = sqrt(a.x*a.x + .03);
      n = vec4(.6 - 2.0*s, -2.0*a.x/s*a.yzw);
    } else if (tPattern == 2) {                            // compact bone with pores
      n = tNoiseD(q);
      if (i > 1) { vec4 c = tCellsD(q*1.7); vec2 st = tStep(.03,.16,c.x); float pit = (1.0-st.x)*(.55+.45*n.x);
        n.x -= pit*.8; n.yzw += st.y*1.7*c.yzw*.8; tPit = max(tPit, pit*w*.6); }
    } else if (tPattern == 3) {                            // skin: fine relief and pores
      n = tNoiseD(q)*.6;
      if (i > 1) { vec4 c = tCellsD(q*1.6); vec2 st = tStep(.05,.22,c.x); float pore = 1.0-st.x;
        n.x -= pore*1.5; n.yzw += st.y*1.6*c.yzw*1.5; tPit = max(tPit, pore*w); }
    } else if (tPattern == 4) {                            // lobules
      vec4 c = tCellsD(q), b = tNoiseD(q*2.0);
      n = vec4((c.x-.45)*2.4 + b.x*.3, c.yzw*2.4 + b.yzw*.6);
      if (i == 0) tPit = smoothstep(.35,.75,c.x);
    } else if (tPattern == 5) n = tNoiseD(q)*.45;          // smooth wet surface
    else n = tNoiseD(q);                                   // mottled organ
    h += w*amp*wave*n.x;
    g += w*amp*n.yzw;   // d(wave*n(p/wave))/dp = dn/dq
    wave *= .5; amp *= .62;
  }
  tHeight = h;
  tGrad = g - t*dot(g,t)*squash; // chain rule through M (symmetric)
  tMottle = tNoiseD(vTPos/(tScale*3.1) + 5.0).x*.5 + tNoiseD(vTPos/(tScale*.9) + 9.0).x*.25;
}
`;

function inject(material, spec) {
  const uniforms = {
    tPattern: {value: spec.pattern}, tScale: {value: spec.scale}, tBump: {value: spec.bump},
    tVary: {value: spec.vary}, tFiber: {value: spec.fiber || 0}, tAlt: {value: spec.altColor}, tRim: {value: spec.rim || 0},
  };
  material.userData.tissue = uniforms;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 fiber;\nvarying vec3 vTPos;\nvarying vec3 vTFiber;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTPos = (modelMatrix*vec4(transformed,1.0)).xyz;\nvTFiber = fiber;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + NOISE_GLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>
        tissueDetail();
        // Normalised height for tinting (pixel-independent).
        float tH = clamp(tHeight/(tScale*.9), -1.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, tAlt, clamp(tMottle*1.2*tVary*4.0 + .5*tVary - tH*tVary*1.6, 0.0, 1.0));
        diffuseColor.rgb *= 1.0 - tPit*.35;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + tPit*.25 + tMottle*.08, .04, 1.0);')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        // Perturb by the height field's tangential gradient (view space).
        vec3 tG = (viewMatrix * vec4(tGrad, 0.0)).xyz;
        normal = normalize(normal - faceDirection*tBump*.45*(tG - normal*dot(normal, tG)));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        // Selection: teal Fresnel rim that leaves the tissue colour readable.
        float tF = pow(1.0 - abs(dot(normalize(vViewPosition), normalize(nonPerturbedNormal))), 2.5);
        totalEmissiveRadiance += vec3(.18,.85,.68) * tRim * (.12 + tF);`);
  };
  material.customProgramCacheKey = () => 'tissue-v2';
}

// Builds tissue materials on demand. highlight=true returns the selection
// variant (same surface plus a soft emissive glow).
export function makeTissueLibrary(T) {
  const cache = new Map();
  function get(key, highlight = false) {
    const id = key + (highlight ? ':hi' : '');
    if (cache.has(id)) return cache.get(id);
    const spec = TISSUES[key] || TISSUES.sensory;
    const m = new T.MeshPhysicalMaterial({
      color: spec.color, roughness: spec.roughness, metalness: 0, side: T.DoubleSide,
      clearcoat: spec.clearcoat || 0, clearcoatRoughness: .28,
      sheen: spec.sheen || 0, sheenColor: new T.Color(spec.sheenColor || '#ffffff'), sheenRoughness: .5,
      specularIntensity: .6, envMapIntensity: .75,
    });
    inject(m, {...spec, altColor: new T.Color(spec.alt), rim: highlight ? 1 : 0});
    m.name = id;
    cache.set(id, m);
    return m;
  }
  return {get, all: () => [...cache.values()]};
}

// Muscle, tendon and nerve streaks follow the structure's principal axis.
// Adds a constant per-vertex `fiber` attribute holding that axis.
export function addFiberAxis(T, geometry) {
  const p = geometry.attributes.position, n = p.count;
  if (!n) return;
  const step = Math.max(1, Math.floor(n / 3000));
  let cx = 0, cy = 0, cz = 0, k = 0;
  for (let i = 0; i < n; i += step) { cx += p.getX(i); cy += p.getY(i); cz += p.getZ(i); k++; }
  cx /= k; cy /= k; cz /= k;
  const c = [0, 0, 0, 0, 0, 0]; // xx xy xz yy yz zz
  for (let i = 0; i < n; i += step) {
    const x = p.getX(i) - cx, y = p.getY(i) - cy, z = p.getZ(i) - cz;
    c[0] += x * x; c[1] += x * y; c[2] += x * z; c[3] += y * y; c[4] += y * z; c[5] += z * z;
  }
  // Power iteration for the dominant eigenvector.
  let v = [.3, 1, .2];
  for (let it = 0; it < 24; it++) {
    const w = [c[0] * v[0] + c[1] * v[1] + c[2] * v[2], c[1] * v[0] + c[3] * v[1] + c[4] * v[2], c[2] * v[0] + c[4] * v[1] + c[5] * v[2]];
    const l = Math.hypot(...w) || 1; v = w.map(x => x / l);
  }
  const data = new Int8Array(n * 3);
  const q = v.map(x => Math.round(x * 127));
  for (let i = 0; i < n; i++) { data[i * 3] = q[0]; data[i * 3 + 1] = q[1]; data[i * 3 + 2] = q[2]; }
  geometry.setAttribute('fiber', new T.BufferAttribute(data, 3, true));
}

export const FIBROUS = new Set(['muscle', 'heart', 'tendon', 'nerve', 'cord']);
