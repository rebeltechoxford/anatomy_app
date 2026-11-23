import * as T from './vendor/three.js';
import {OrbitControls} from './vendor/orbit.js';
const $=id=>document.getElementById(id);
const palette={muscular:'#ac5749',skeletal:'#dfcdae',connective:'#d3bca7',integumentary:'#c7a08c',arterial:'#c44739',venous:'#597a98',nervous:'#dbb14d',respiratory:'#c39298',cardiac:'#a75255',digestive:'#bd8875',urinary:'#a36a58',reproductive:'#c39699',endocrine:'#ce975b',lymphatic:'#84a178',sensory:'#b59b88'};
const eye='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 12Q12 -1 22 12Q12 25 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
const cap=s=>s[0].toUpperCase()+s.slice(1);
async function start(){
 const atlas=await (await fetch('models/atlas.json')).json(), parts=atlas.parts;
 const renderer=new T.WebGLRenderer({antialias:true,alpha:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.7));$('viewport').append(renderer.domElement);
 const scene=new T.Scene(),camera=new T.PerspectiveCamera(30,1,.003,50),orbit=new OrbitControls(camera,renderer.domElement);
 orbit.minDistance=.025;orbit.maxDistance=12;orbit.enableDamping=false;
 scene.add(new T.HemisphereLight(0xfff9e9,0x8c9390,1.6));
 for(const [x,y,z,p] of [[-3,5,4,2],[3,2,-4,1.4]]){let l=new T.DirectionalLight(0xfff8ef,p);l.position.set(x,y,z);scene.add(l)}
 const materials=Object.fromEntries(Object.entries(palette).map(([s,color])=>[s,new T.MeshStandardMaterial({color,roughness:.83,side:T.DoubleSide})]));
 const active=new T.MeshStandardMaterial({color:'#4a9a80',side:T.DoubleSide});
 const meshes=[],sets=Object.fromEntries(Object.keys(palette).map(s=>[s,parts.map((p,i)=>p.system===s?i:-1).filter(i=>i>=0)]));
 const initial=parts.map(p=>p.system!=='integumentary'),history=[];let shown=initial.slice(),selected=null,expanded='',dissect=false,dirty=true;
 const invalidate=()=>{dirty=true};orbit.addEventListener('change',invalidate);
 const draw=()=>{if(dirty){renderer.render(scene,camera);dirty=false}requestAnimationFrame(draw)};draw();
 function sync(){meshes.forEach((m,i)=>{m.visible=shown[i];m.material=i===selected?active:materials[parts[i].system]});$('undo').disabled=!history.length;$('inspect').hidden=selected===null;if(selected!==null){$('part').textContent=parts[selected].name;$('system').textContent=parts[selected].system.toUpperCase()+' SYSTEM'}library();invalidate()}
 function save(){history.push([shown.slice(),selected]);if(history.length>60)history.shift()}
 function front(){const dirs={Anterior:[0,0,1],Posterior:[0,0,-1],'Left lateral':[1,0,0],'Right lateral':[-1,0,0]};orbit.target.set(0,.78,0);camera.position.copy(orbit.target).add(new T.Vector3(...dirs[$('view').value]).multiplyScalar(Math.max(3.9,1.7/camera.aspect)));orbit.update();invalidate()}
 function resize(){let v=$('viewport');renderer.setSize(v.clientWidth,v.clientHeight,false);camera.aspect=v.clientWidth/v.clientHeight;camera.updateProjectionMatrix();invalidate()}
 new ResizeObserver(resize).observe($('viewport'));resize();front();
 function focus(){if(selected===null)return;let b=parts[selected].bounds,box=new T.Box3(...b.map(v=>new T.Vector3(...v))),dir=camera.position.clone().sub(orbit.target).normalize();box.getCenter(orbit.target);camera.position.copy(orbit.target).addScaledVector(dir,Math.max(.05,box.getSize(new T.Vector3()).length()*2.5/Math.min(1,camera.aspect)));orbit.update();invalidate()}
 function pick(i){if(!shown[i]){save();shown[i]=true}selected=i;sync()}
 function remove(i){save();shown[i]=false;selected=null;sync()}
 function button(label,fn,cls){let b=document.createElement('button');b.textContent=label;b.className=cls||'';b.onclick=fn;return b}
 function library(){let q=$('search').value.trim().toLowerCase(),list=$('library');list.replaceChildren();$('listTitle').textContent=q?'Matching structures':'System layers';
 const entry=i=>list.append(button(parts[i].name,()=>{pick(i);focus()},'result'));
 if(q){let hits=parts.map((p,i)=>p.name.toLowerCase().includes(q)?i:-1).filter(i=>i>=0);$('count').textContent=hits.length;hits.forEach(entry);if(!hits.length)list.textContent='No matching structures.';return}
 $('count').textContent=Object.keys(sets).length;
 for(const [s,ids] of Object.entries(sets)){let row=document.createElement('div');row.className='row';let b=button('',()=>{expanded=expanded===s?'':s;library()});b.innerHTML='<span class="swatch"></span>'+cap(s);b.style.setProperty('--t',palette[s]);b.setAttribute('aria-expanded',expanded===s);let visible=ids.some(i=>shown[i]),toggle=button('',()=>{save();ids.forEach(i=>shown[i]=!visible);if(selected!==null&&!shown[selected])selected=null;sync()},'eye');toggle.innerHTML=eye;toggle.style.opacity=visible?1:.32;toggle.title=(visible?'Hide ':'Show ')+s+' system';toggle.setAttribute('aria-label',toggle.title);row.append(b,toggle);list.append(row);if(expanded===s)ids.forEach(entry)}}
 $('search').oninput=library;$('view').onchange=front;$('fit').onclick=front;$('focus').onclick=focus;
 for(const [id,m] of [['plus',.8],['minus',1.25]])$(id).onclick=()=>{let v=camera.position.clone().sub(orbit.target);v.setLength(T.MathUtils.clamp(v.length()*m,.025,12));camera.position.copy(orbit.target).add(v);orbit.update();invalidate()};
 $('hide').onclick=()=>remove(selected);$('solo').onclick=()=>{save();shown=shown.map((_,i)=>i===selected);focus();sync()};
 $('undo').onclick=()=>{if(history.length){[shown,selected]=history.pop();sync()}};
 function mode(on){dissect=on;$('inspectMode').setAttribute('aria-pressed',!on);$('peel').setAttribute('aria-pressed',on);$('hint').textContent=on?'Select a structure to remove it · Undo to restore':'Drag to rotate · Scroll to zoom · Select to inspect'}
 $('inspectMode').onclick=()=>mode(false);$('peel').onclick=()=>mode(true);$('reset').onclick=()=>{save();shown=initial.slice();selected=null;expanded='';$('search').value='';$('view').value='Anterior';mode(false);front();sync()};
 let down;const canvas=renderer.domElement;canvas.addEventListener('pointerdown',e=>down=[e.clientX,e.clientY]);canvas.addEventListener('pointerup',e=>{if(!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;let r=canvas.getBoundingClientRect(),ray=new T.Raycaster();ray.setFromCamera(new T.Vector2((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2),camera);let hit=ray.intersectObjects(meshes.filter(m=>m.visible),false)[0];if(hit){let i=hit.object.userData.index;dissect?remove(i):pick(i)}else{selected=null;sync()}});
 sync();let cursor=0,loaded=0;
 async function worker(){while(cursor<atlas.chunks.length){const n=cursor++,r=await fetch('models/body-'+n+'.gz');if(!r.ok)throw Error('Model download failed');let buffer=await r.arrayBuffer();if(new Uint8Array(buffer)[0]===31&&new Uint8Array(buffer)[1]===139)buffer=await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
 parts.forEach((p,i)=>{if(p.chunk!==n)return;const g=new T.BufferGeometry();g.setAttribute('position',new T.BufferAttribute(new Float32Array(buffer,p.positions,p.vertexCount*3),3));g.setAttribute('normal',new T.BufferAttribute(new Int16Array(buffer,p.normals,p.vertexCount*3),3,true));g.setIndex(new T.BufferAttribute(new Uint32Array(buffer,p.indices,p.indexCount),1));let mesh=new T.Mesh(g,i===selected?active:materials[p.system]);mesh.userData.index=i;mesh.visible=shown[i];scene.add(mesh);meshes[i]=mesh});invalidate();$('notice').textContent='Loading anatomy · '+Math.round(++loaded/atlas.chunks.length*100)+'%'}}
 await Promise.all([worker(),worker(),worker()]);$('notice').hidden=true;
}
start().catch(e=>{$('notice').textContent='Model unavailable. Enable WebGL and reload.';console.error(e)});
