// Teaching geometry. Each bed sits on a triangle of its named atlas muscle.
// Surface placement is taken from the reference; vessel paths are schematic.
export function setupTissueVessels({T,parts,meshes,scene,camera,orbit,invalidate,showOnly,button,currentSelection=()=>null,status}) {
  const muscles = parts.map((p,i)=>p.system==='muscular' && meshes[i] ? i : -1).filter(i=>i>=0);
  if (!muscles.length) return ()=>{};
  const a=new T.Vector3(), b=new T.Vector3(), c=new T.Vector3(), cross=new T.Vector3(), side=new T.Vector3();
  const forward=new T.Vector3(), normal=new T.Vector3();
  const colors=[new T.Color('#ff735c'),new T.Color('#ffccaf'),new T.Color('#78aafd')];
  const material=new T.LineBasicMaterial({vertexColors:true,toneMapped:false});
  const groups=[], ordered=[];
  let cursor=-1,active=false,total=0;
  const originalMinimum=orbit.minDistance, originalNear=camera.near;

  function reset(){
    active=false; cursor=-1;
    groups.forEach(g=>g.lines.visible=false);
    camera.near=originalNear; orbit.minDistance=originalMinimum; camera.updateProjectionMatrix();
    if(status)status.hidden=true;
    button.textContent='Explore modeled muscle microvessels';button.setAttribute('aria-pressed','false');
    invalidate();
  }

  // Keep the largest viable face in each spatial cell, then use the largest
  // cells to spread the sampled beds over the available muscle surface.
  function triangles(index,count){
    const geometry=meshes[index].geometry,p=geometry.attributes.position,ix=geometry.index;
    const [lo,hi]=parts[index].bounds, cells=new Map();
    const length=ix?ix.count:p.count;
    for(let j=0;j+2<length;j+=3){
      const ia=ix?ix.getX(j):j, ib=ix?ix.getX(j+1):j+1, ic=ix?ix.getX(j+2):j+2;
      a.fromBufferAttribute(p,ia);b.fromBufferAttribute(p,ib);c.fromBufferAttribute(p,ic);
      const area=cross.subVectors(b,a).cross(side.subVectors(c,a)).lengthSq();
      if(area<1e-32)continue;
      const center=forward.copy(a).add(b).add(c).multiplyScalar(1/3);
      const cellKey=['x','y','z'].reduce((key,axis,k)=>key*10+
        Math.min(9,Math.max(0,Math.floor(10*(center[axis]-lo[k])/(hi[k]-lo[k]||1)))),0);
      if(!cells.has(cellKey)||area>cells.get(cellKey).area)cells.set(cellKey,{ia,ib,ic,area});
    }
    return [...cells.values()].sort((u,v)=>v.area-u.area).slice(0,count);
  }

  function makeBed(g,face,bedIndex,positions,tints){
    const geom=meshes[g.index].geometry,pos=geom.attributes.position;
    a.fromBufferAttribute(pos,face.ia); b.fromBufferAttribute(pos,face.ib); c.fromBufferAttribute(pos,face.ic);
    const u=b.clone().sub(a),v=c.clone().sub(a);
    const out=u.clone().cross(v).normalize();
    if(geom.attributes.normal && normal.fromBufferAttribute(geom.attributes.normal,face.ia).dot(out)<0)out.negate();
    const span=Math.max(u.length(),v.length());
    // All barycentric coordinates stay inside the triangle. A small normal
    // offset prevents the teaching overlay flickering against its host; it also
    // covers the 0.2% simplification error, so the overlay stays above the
    // surface when the full-resolution mesh is streamed in.
    const [lo,hi]=parts[g.index].bounds;
    const extent=Math.hypot(hi[0]-lo[0],hi[1]-lo[1],hi[2]-lo[2]);
    const origin=a.clone().addScaledVector(out,Math.max(span*.003,extent*.0035));
    const bary=(x,y)=>origin.clone().addScaledVector(u,.08+.58*x).addScaledVector(v,.05+.27*y);
    let seed=4871+g.index*31+bedIndex*997;
    const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
    function connect(start,end,type){
      positions.push(start.x,start.y,start.z,end.x,end.y,end.z);
      const col=colors[type];
      tints.push(col.r,col.g,col.b,col.r,col.g,col.b);
      total++;
    }
    const grid=[];
    for(let x=0;x<10;x++){
      grid[x]=[];
      for(let y=0;y<8;y++){
        const pt=bary(.14+(x+(random()-.5)*.34)*.077,.07+(y+(random()-.5)*.42)*.12);
        grid[x].push(pt);
        if(x)connect(grid[x-1][y],pt,1);
        if(y && (x+y)%2===0)connect(grid[x][y-1],pt,1);
      }
    }
    for(const [column,type,direction] of [[0,0,-1],[9,2,1]]){
      let current=grid[column].slice();
      for(let level=1;current.length>1;level++){
        const next=[];
        for(let j=0;j<current.length;j+=2){
          const parent=current[j].clone().lerp(current[j+1],.5).addScaledVector(u,direction*.022);
          connect(parent,current[j],type); connect(parent,current[j+1],type);next.push(parent);
        }
        current=next;
      }
      connect(current[0],current[0].clone().addScaledVector(u,direction*.017),type);
    }
    g.beds.push({point:bary(.5,.5),out,span});
  }

  function build(){
    const target=Math.max(400,muscles.length);
    muscles.forEach((index,rank)=>{
      const count=Math.floor(target/muscles.length)+(rank<target%muscles.length?1:0);
      const group={index,beds:[]},positions=[],tints=[];
      triangles(index,count).forEach((face,i)=>makeBed(group,face,i,positions,tints));
      if(!group.beds.length)return;
      const geometry=new T.BufferGeometry();
      geometry.setAttribute('position',new T.Float32BufferAttribute(positions,3));
      geometry.setAttribute('color',new T.Float32BufferAttribute(tints,3));
      group.lines=new T.LineSegments(geometry,material);
      group.lines.name='Illustrative muscle microvasculature';
      meshes[index].add(group.lines); groups.push(group);
    });
    // Visit a different muscle on each advance, then repeat with other beds.
    for(let round=0;groups.some(g=>g.beds.length>round);round++)
      groups.forEach(g=>{if(g.beds[round])ordered.push({g,bed:g.beds[round]})});
  }

  button.disabled=false;
  button.title='Inspect schematic microvascular beds attached to the reference muscle surfaces';
  button.onclick=()=>{
    if(!groups.length)build();
    if(!ordered.length){button.disabled=true;return}
    let next=(cursor+1)%ordered.length;
    const picked=currentSelection();
    if(picked!==null && ordered[cursor]?.g.index!==picked){
      const target=ordered.findIndex(sample=>sample.g.index===picked);
      if(target>=0)next=target;
    }
    const {g,bed}=ordered[next];
    showOnly(g.index);
    // showOnly may call the caller's reset routine.
    if(!active)groups.forEach(group=>group.lines.visible=true);
    active=true;cursor=next;
    orbit.minDistance=Math.min(originalMinimum,bed.span*.025);
    camera.near=Math.min(originalNear,bed.span*.005);
    camera.updateProjectionMatrix();
    orbit.target.copy(bed.point);
    camera.position.copy(bed.point).addScaledVector(bed.out,bed.span*1.65/Math.min(1,camera.aspect));
    camera.up.set(0,1,0);orbit.update();
    button.setAttribute('aria-pressed','true');
    button.textContent='Next fine-vessel sample';
    button.title=parts[g.index].name+' · Sample '+(cursor+1)+' of '+ordered.length+' · '+total.toLocaleString()+' schematic segments in this model';
    if(status){status.textContent=button.title;status.hidden=false}
    invalidate();
  };
  return reset;
}
