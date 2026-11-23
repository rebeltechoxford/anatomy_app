import * as T from './vendor/three.js';

export async function cellLayer(scene, controls, camera, render) {
  const response = await fetch('specimen-cells.bin');
  if (!response.ok) throw Error('Cell geometry unavailable');
  const data = new DataView(await response.arrayBuffer());
  const count = data.byteLength/16;
  if (count!==49364) throw Error('Incomplete cell-center data');
  const coords = new Float32Array(count*3);
  const sourceIds = new Uint32Array(count);
  const indexById = new Map();
  for(let i=0;i<count;i++){
    const at=i*16;
    const id=data.getUint32(at,true);
    sourceIds[i]=id;
    indexById.set(id,i);
    coords[3*i]=data.getUint16(at+8,true)*.002048/16;
    coords[3*i+1]=-data.getUint16(at+10,true)*.002048/16;
    coords[3*i+2]=data.getUint16(at+12,true)*.002112/16;
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position',new T.BufferAttribute(coords,3));
  const cloud=new T.Points(geometry,new T.PointsMaterial({color:'#71cfde',size:.0045}));
  cloud.visible=false;
  const markerGeom=new T.BufferGeometry();
  markerGeom.setAttribute('position',new T.BufferAttribute(new Float32Array([0,0,0]),3));
  const marker=new T.Points(markerGeom,new T.PointsMaterial({color:'#ffffff',size:.011,depthTest:false}));
  marker.renderOrder=2;
  marker.visible=false;
  scene.add(cloud,marker);
  const toggle=document.getElementById('showCells');
  const field=document.getElementById('cellId');
  const note=document.getElementById('cellInfo');
  function clear(){
    marker.visible=false;
    note.textContent='';
    render();
  }
  function locate(index){
    const point=new T.Vector3().fromArray(coords,index*3);
    const dir=camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(point).addScaledVector(dir,.14);
    controls.target.copy(point);
    controls.update();
    toggle.checked=cloud.visible=true;
    marker.position.copy(point);
    marker.visible=true;
    field.value=sourceIds[index];
    note.textContent='Selected cell '+sourceIds[index]+' · white center marker';
    render();
  }
  toggle.disabled=false;
  toggle.onchange=()=>{cloud.visible=toggle.checked;clear()};
  document.getElementById('locate').disabled=false;
  document.getElementById('cellForm').onsubmit=event=>{
    event.preventDefault();
    const index=indexById.get(Number(field.value));
    if(index===undefined){clear();note.textContent='No cell has that source ID at this resolution.';return}
    locate(index);
  };
  return {cloud,locate,clear};
}
