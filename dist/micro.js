import * as T from './vendor/three.js';
import {OrbitControls} from './vendor/orbit.js';

const labels = ['Arteriole', 'Capillary', 'Venule'];
const colors = [0xeb725c, 0xd49d9e, 0x689ee0];
const columns = 40, rows = 32, layers = 16;
const $ = id => document.getElementById(id);

// The lattice uses shared nodes. Each edge is one separately selectable
// junction-to-junction connection, independent of the tube's triangle count.
function makeNetwork() {
  const nodes = [], edges = [[], [], []];
  let seed = 348013;
  const random = () => ((seed = (Math.imul(seed,1664525) + 1013904223) >>> 0) / 4294967296);
  function node(x,y,z) {
    nodes.push(new T.Vector3(x,y,z));
    return nodes.length - 1;
  }
  function connect(type,a,b,radius) {
    edges[type].push({a,b,radius});
  }
  const index = (x,y,z) => (x*rows+y)*layers+z;
  for (let x=0;x<columns;x++) for (let y=0;y<rows;y++) for (let z=0;z<layers;z++) {
    const jitter = () => (random()-.5)*.58;
    const i=node(x-(columns-1)/2+jitter(),(y-(rows-1)/2+jitter())*.82,(z-(layers-1)/2+jitter())*.84);
    if (x) connect(1,index(x-1,y,z),i,.054);
    if (y && random()<.87) connect(1,index(x,y-1,z),i,.048);
    if (z && random()<.78) connect(1,index(x,y,z-1),i,.045);
  }
  // Recursively merge adjacent terminal pairs up each side of the bed.
  // Every capillary row has both an inflow and a drainage connection.
  function tree(side,type,y0,y1,z0,z1,depth) {
    if(y1-y0===1 && z1-z0===1) return index(side<0?0:columns-1,y0,z0);
    let left,right;
    if(y1-y0>=z1-z0){
      const mid=(y0+y1)>>1;
      left=tree(side,type,y0,mid,z0,z1,depth+1); right=tree(side,type,mid,y1,z0,z1,depth+1);
    } else {
      const mid=(z0+z1)>>1;
      left=tree(side,type,y0,y1,z0,mid,depth+1); right=tree(side,type,y0,y1,mid,z1,depth+1);
    }
    const v=nodes[left].clone().lerp(nodes[right],.5);
    const i=node(side*((columns-1)/2+(9-depth)*1.18),v.y,v.z);
    const radius=.08*Math.cbrt((y1-y0)*(z1-z0)/2);
    connect(type,i,left,radius); connect(type,i,right,radius);
    return i;
  }
  for (const [side,type] of [[-1,0],[1,2]]) {
    const root=tree(side,type,0,rows,0,layers,0);
    const n=nodes[root];
    connect(type,node(n.x+side*4,n.y,n.z),root,.67);
  }
  return {nodes,edges};
}

function initProjectedView(network, stage) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable');
  stage.prepend(canvas);
  stage.setAttribute('aria-label', 'Interactive projected microvascular network');
  $('help').textContent = 'Drag to pan · Pinch or scroll to zoom · Tap to inspect';
  $('status').textContent = 'Projected tissue view';
  const points = network.nodes.map(({x,y,z}) => [x + z * .26, -y + z * .36]);
  const strokes = ['#eb725c', '#d49d9e', '#689ee0'];
  const controls = Array.from(document.querySelectorAll('[data-type]'));
  let visible = [], paths = [], selected, scale = 1, cx = 0, cy = 0;
  let width = 1, height = 1;

  function draw() {
    const dpr = Math.min(devicePixelRatio, 1.5);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(width / 2, height / 2);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
    for (const {path,type,radius} of paths) {
      ctx.lineWidth = Math.max(.55 / scale, 2 * radius);
      ctx.strokeStyle = strokes[type];
      ctx.globalAlpha = type === 1 ? .45 : .9;
      ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
    if (selected) {
      ctx.beginPath();
      ctx.moveTo(...points[selected.edge.a]);
      ctx.lineTo(...points[selected.edge.b]);
      ctx.lineWidth = Math.max(3 / scale, selected.edge.radius * 3);
      ctx.strokeStyle = '#ffe18d';
      ctx.stroke();
    }
  }
  function filter() {
    const groups = new Map();
    visible = [];
    for (const type of [1,0,2]) {
      if (!controls[type].checked) continue;
      network.edges[type].forEach((edge,id) => {
        if ($('section').checked && Math.abs((network.nodes[edge.a].z + network.nodes[edge.b].z) / 2) >= 1.8) return;
        const key = type + '/' + edge.radius;
        if (!groups.has(key)) groups.set(key, {path:new Path2D(),type,radius:edge.radius});
        const path = groups.get(key).path;
        path.moveTo(...points[edge.a]);
        path.lineTo(...points[edge.b]);
        visible.push({type,id,edge});
      });
    }
    paths = Array.from(groups.values());
    selected = null;
    $('closer').disabled = true;
    $('selection').textContent = 'Select a vessel segment to inspect it.';
    $('count').textContent = visible.length.toLocaleString() + ' visible vessel segments';
    draw();
  }
  function fit() {
    cx = cy = 0;
    scale = Math.min(width / 76, height / 38);
    draw();
  }
  function resize() {
    width = Math.max(1, stage.clientWidth);
    height = Math.max(1, stage.clientHeight);
    const dpr = Math.min(devicePixelRatio,1.5);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    draw();
  }
  function zoomAt(x,y,factor) {
    const next = Math.max(.1, Math.min(1500, scale * factor));
    cx += (x - width / 2) * (1 / scale - 1 / next);
    cy += (y - height / 2) * (1 / scale - 1 / next);
    scale = next;
    draw();
  }
  function inspect(x,y) {
    const wx = (x-width/2)/scale+cx, wy = (y-height/2)/scale+cy;
    let closest = (7/scale)**2, hit = null;
    for (const item of visible) {
      const [ax,ay] = points[item.edge.a], [bx,by] = points[item.edge.b];
      const dx = bx-ax, dy = by-ay;
      const t = Math.max(0, Math.min(1, ((wx-ax)*dx+(wy-ay)*dy)/(dx*dx+dy*dy || 1)));
      const distance = (wx-ax-t*dx)**2+(wy-ay-t*dy)**2;
      if (distance <= closest) {closest = distance; hit = item;}
    }
    if (!hit) return;
    selected = hit;
    $('selection').textContent = labels[hit.type]+' segment '+(hit.id+1).toLocaleString()+' · Junction '+(hit.edge.a+1).toLocaleString()+' to '+(hit.edge.b+1).toLocaleString();
    $('closer').disabled = false;
    draw();
  }
  const pointers = new Map();
  let tap, pinch = 0;
  canvas.onpointerdown = e => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId,[e.offsetX,e.offsetY]);
    tap = pointers.size === 1 ? [e.offsetX,e.offsetY] : null;
    pinch = 0;
  };
  canvas.onpointermove = e => {
    const prior = pointers.get(e.pointerId);
    if (!prior) return;
    pointers.set(e.pointerId,[e.offsetX,e.offsetY]);
    if (pointers.size === 2) {
      const [[x,y],[u,v]] = [...pointers.values()];
      const dist = Math.hypot(x-u,y-v);
      if (pinch && dist) zoomAt((x+u)/2,(y+v)/2,dist/pinch);
      pinch = dist;
    } else {
      if (tap && Math.hypot(e.offsetX-tap[0],e.offsetY-tap[1]) <= 4) return;
      tap = null;
      cx -= (e.offsetX-prior[0])/scale;
      cy -= (e.offsetY-prior[1])/scale;
      draw();
    }
  };
  canvas.onpointerup = e => {
    if (tap && Math.hypot(e.offsetX-tap[0],e.offsetY-tap[1]) <= 4) inspect(e.offsetX,e.offsetY);
    tap = null;
    pointers.delete(e.pointerId);
  };
  canvas.onpointercancel = e => {tap = null; pointers.delete(e.pointerId);};
  canvas.addEventListener('wheel',e => {
    e.preventDefault();
    zoomAt(e.offsetX,e.offsetY,Math.exp(-e.deltaY*.0015));
  },{passive:false});
  $('closer').onclick = () => {
    if (!selected) return;
    const a = points[selected.edge.a], b = points[selected.edge.b];
    cx = (a[0]+b[0])/2; cy = (a[1]+b[1])/2;
    scale = Math.min(1500, Math.min(width,height)/(8*Math.max(1,Math.hypot(a[0]-b[0],a[1]-b[1]))));
    draw();
  };
  $('fit').onclick = fit;
  document.querySelectorAll('input').forEach(el => el.addEventListener('change',filter));
  new ResizeObserver(resize).observe(stage);
  resize(); fit(); filter();
}

function init() {
  const stage=$('stage'), network=makeNetwork();
  let renderer;
  try { renderer=new T.WebGLRenderer({alpha:true,antialias:true}); }
  catch { initProjectedView(network,stage); return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
  stage.prepend(renderer.domElement);
  const scene=new T.Scene(), camera=new T.PerspectiveCamera(33,1,.02,500);
  const controls=new OrbitControls(camera,renderer.domElement);
  controls.minDistance=.6; controls.maxDistance=350;
  scene.add(new T.HemisphereLight(0xfffaf2,0x96adb8,1.9));
  const light=new T.DirectionalLight(0xffffff,1.8);
  light.position.set(-15,40,36); scene.add(light);
  const axis=new T.Vector3(0,1,0), tube=new T.CylinderGeometry(1,1,1,6,1,true);
  const transform=new T.Object3D(), dir=new T.Vector3();
  function place(edge,scale=1) {
    const a=network.nodes[edge.a], b=network.nodes[edge.b];
    dir.subVectors(b,a);
    transform.position.copy(a).lerp(b,.5);
    transform.scale.set(edge.radius*scale,dir.length(),edge.radius*scale);
    transform.quaternion.setFromUnitVectors(axis,dir.normalize());
    transform.updateMatrix();
    return transform.matrix;
  }
  // Spatial batches keep rendering and touch picking local when zoomed in.
  const batches=[], partitions=new Map();
  network.edges.forEach((list,type)=>list.forEach((edge,id)=>{
    const v=network.nodes[edge.a], w=network.nodes[edge.b];
    const middle=v.clone().lerp(w,.5);
    const section=Math.abs(middle.z)<1.8;
    const key=[type,section,Math.floor(middle.x/5),Math.floor(middle.y/6),Math.floor(middle.z/6)].join('/');
    if(!partitions.has(key)) partitions.set(key,{type,section,ids:[]});
    partitions.get(key).ids.push(id);
  }));
  const materials=colors.map(color=>new T.MeshStandardMaterial({color,roughness:.8}));
  for(const group of partitions.values()){
    const mesh=new T.InstancedMesh(tube,materials[group.type],group.ids.length);
    group.ids.forEach((id,i)=>mesh.setMatrixAt(i,place(network.edges[group.type][id])));
    mesh.userData=group;
    mesh.computeBoundingSphere(); scene.add(mesh); batches.push(mesh);
  }
  const marker=new T.Mesh(tube,new T.MeshBasicMaterial({color:0xffe18d}));
  marker.matrixAutoUpdate=false; marker.visible=false; scene.add(marker);
  let selected=null;
  const draw=()=>renderer.render(scene,camera);
  controls.addEventListener('change',draw);
  const showSelection=(type,id)=>{
    selected=network.edges[type][id]; marker.matrix.copy(place(selected,2.5));
    marker.matrixWorldNeedsUpdate=true; marker.visible=true;
    $('selection').textContent=labels[type]+' segment '+(id+1).toLocaleString()+' · Junction '+(selected.a+1).toLocaleString()+' to '+(selected.b+1).toLocaleString();
    $('closer').disabled=false; draw();
  };
  function filter(){
    const types=Array.from(document.querySelectorAll('[data-type]'),el=>el.checked);
    let visible=0;
    for(const b of batches){
      b.visible=types[b.userData.type]&&(!$('section').checked||b.userData.section);
      if(b.visible)visible+=b.count;
    }
    selected=null;marker.visible=false;$('closer').disabled=true;
    $('selection').textContent='Select a vessel segment to inspect it.';
    $('count').textContent=visible.toLocaleString()+' visible vessel segments';
    draw();
  }
  document.querySelectorAll('input').forEach(el=>el.addEventListener('change',filter));
  function fit(){
    controls.target.set(0,0,0); camera.position.set(8,23,78).multiplyScalar(Math.max(1,1.6/camera.aspect));
    controls.update(); draw();
  }
  $('fit').onclick=fit;
  $('closer').onclick=()=>{
    if(!selected)return;
    const orientation=camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(network.nodes[selected.a]).lerp(network.nodes[selected.b],.5);
    camera.position.copy(controls.target).addScaledVector(orientation,Math.max(4,network.nodes[selected.a].distanceTo(network.nodes[selected.b])*4));
    controls.update(); draw();
  };
  const ray=new T.Raycaster(), mouse=new T.Vector2();let down;
  renderer.domElement.onpointerdown=e=>{down=[e.clientX,e.clientY]};
  renderer.domElement.onpointerup=e=>{
    if(!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;
    const rect=renderer.domElement.getBoundingClientRect();
    mouse.set(2*(e.clientX-rect.left)/rect.width-1,1-2*(e.clientY-rect.top)/rect.height);
    ray.setFromCamera(mouse,camera);
    const hit=ray.intersectObjects(batches.filter(b=>b.visible),false)[0];
    if(hit)showSelection(hit.object.userData.type,hit.object.userData.ids[hit.instanceId]);
  };
  function resize(){
    camera.aspect=stage.clientWidth/stage.clientHeight;
    camera.updateProjectionMatrix();renderer.setSize(stage.clientWidth,stage.clientHeight,false);draw();
  }
  new ResizeObserver(resize).observe(stage); resize();fit();filter();
}
const body=new URLSearchParams(location.search).get('body')==='female'?'female':'models';
$('return').href='./?body='+body;
try{init()}catch(error){$('count').textContent='3D view unavailable';$('status').textContent='The 3D tissue viewer requires WebGL. Enable hardware acceleration and reload.';console.error(error)}
