import {makeAtlasRenderer} from './canvas-renderer.js';
import * as T from './vendor/three.js';
import {OrbitControls} from './vendor/orbit.js';

import {cellLayer} from './specimen-cells.js';

const byId = id => document.getElementById(id);
if (new URLSearchParams(location.search).get('body') === 'female') {
  byId('back').href = './?body=female';
}

async function start() {
  const response = await fetch('./specimen-h01.bin');
  if (!response.ok) throw Error('Geometry unavailable');
  const data = new Uint16Array(await response.arrayBuffer());
  if (data.length !== 110484 * 4) throw Error('Incomplete specimen');
  const groups = new Map();
  for (let offset = 0; offset < data.length; offset += 4) {
    const id = data[offset + 3];
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(offset);
  }
  const stage = byId('stage');
  const renderer = makeAtlasRenderer(T);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  stage.prepend(renderer.domElement);
  const camera = new T.PerspectiveCamera(32,1,.001,40);
  const controls = new OrbitControls(camera,renderer.domElement);
  controls.maxDistance = 16;
  controls.minDistance = .012;
  const scene = new T.Scene();
  const geometry = new T.BufferGeometry();
  const material = new T.PointsMaterial({size:.008, vertexColors:true});
  const points = new T.Points(geometry,material);
  scene.add(points);
  const cells = await cellLayer(scene, controls, camera, render);
  const select = byId('segment');
  for (const id of [...groups.keys()].sort((a,b)=>a-b)) {
    select.add(new Option('Segment '+id,id));
  }
  function render(){renderer.render(scene,camera)}
  function resize(){
    renderer.setSize(stage.clientWidth,stage.clientHeight,false);
    camera.aspect = stage.clientWidth/stage.clientHeight;
    camera.updateProjectionMatrix();
    render();
  }
  function fit(){
    const sphere = geometry.boundingSphere;
    const distance = Math.max(.025,sphere.radius) / Math.sin(T.MathUtils.degToRad(16)) / Math.min(1,camera.aspect);
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(new T.Vector3(.02,-.20,1).normalize(),distance*1.06);
    controls.update();
    render();
  }
  let visibleIds;
  function show(id) {
    const n = id ? groups.get(id).length : data.length/4;
    const coords = new Float32Array(n*3), colors = new Float32Array(n*3);
    visibleIds = new Uint16Array(n);
    const color = new T.Color();
    for(let i=0;i<n;i++){
      const offset=id?groups.get(id)[i]:i*4;
      const label=data[offset+3];
      visibleIds[i]=label;
      coords[i*3]=(data[offset]+.5)*.004096;
      coords[i*3+1]=-(data[offset+1]+.5)*.004096;
      coords[i*3+2]=(data[offset+2]+.5)*.004224;
      color.setHSL(.025+.065*((label*137)%257)/257,.65,.53+.22*((label*41)%223)/223);
      color.toArray(colors,i*3);
    }
    geometry.dispose();
    geometry.setAttribute('position',new T.BufferAttribute(coords,3));
    geometry.setAttribute('color',new T.BufferAttribute(colors,3));
    geometry.computeBoundingSphere();
    byId('measure').textContent=id?'Segment '+id+' · '+n.toLocaleString()+' sampled voxels':'';
    fit();
  }
  const ray = new T.Raycaster();
  ray.params.Points.threshold=.008;
  let down;
  renderer.domElement.addEventListener('pointerdown',event=>{down=[event.clientX,event.clientY]});
  renderer.domElement.addEventListener('pointerup',event=>{
    if(!down || Math.hypot(event.clientX-down[0],event.clientY-down[1])>4 || select.value)return;
    const rect=renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new T.Vector2((event.clientX-rect.left)*2/rect.width-1,1-(event.clientY-rect.top)*2/rect.height),camera);
    const hit=ray.intersectObjects(cells.cloud.visible ? [points,cells.cloud] : [points],false)[0];
    if(hit?.object===cells.cloud){cells.locate(hit.index);return}
    if(hit){const id=visibleIds[hit.index];select.value=String(id);show(id)}
  });
  resize();
  show(0);
  controls.addEventListener('change',render);
  new ResizeObserver(resize).observe(stage);
  byId('fit').onclick=fit;
  byId('fit').disabled=false;
  select.onchange=()=>{cells.clear();show(Number(select.value))};
  select.disabled=false;
  byId('status').textContent='Drag to rotate · Pinch or scroll to zoom · Select a vessel to isolate';
}
start().catch(()=>{byId('status').textContent='3D view unavailable. Open the source vessel meshes using the link below.'});
