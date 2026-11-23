// Reduced-detail projection for browsers without a WebGL2 context. The scene
// and camera stay in Three.js so orbit, slicing and ray selection share one
// coordinate system with the hardware renderer.
export function makeAtlasRenderer(T) {
  const probe = document.createElement('canvas');
  const options = {antialias:true, alpha:true};
  let gl;
  try { gl = probe.getContext('webgl2', options); } catch {}
  if (gl) {
    try { return new T.WebGLRenderer({...options, canvas:probe, context:gl}); } catch {}
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw Error('Canvas rendering is unavailable');
  canvas.dataset.renderer = 'canvas2d';
  let width=1, height=1, ratio=1;
  const viewProjection = new T.Matrix4(), frustum = new T.Frustum();
  const world = new T.Vector3(), tint = new T.Color();
  const vertices = Array.from({length:3}, () => ({x:0,y:0,z:0,w:1}));
  const shadeCache = new Map();
  const lineColors = new Map();

  function surfaceColor(material, shade) {
    const key = material.color.getHex() * 16 + shade;
    let color = shadeCache.get(key);
    if (!color) {
      color = material.color.clone().multiplyScalar(.48 + shade / 13).getStyle();
      shadeCache.set(key,color);
    }
    return color;
  }
  function sampleColor(colors,index,material) {
    if (!colors || !material.vertexColors) return material.color.getStyle();
    tint.fromBufferAttribute(colors,index);
    const key = tint.getHex();
    if (!lineColors.has(key)) lineColors.set(key,'#'+key.toString(16).padStart(6,'0'));
    return lineColors.get(key);
  }

  function render(scene,camera) {
    ctx.setTransform(ratio,0,0,ratio,0,0);
    ctx.clearRect(0,0,width,height);
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    viewProjection.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
    const items = [], draws = [];
    let total = 0;
    scene.traverseVisible(obj => {
      const geo = obj.geometry;
      const positions = geo?.attributes.position;
      if (!positions?.count || !obj.material?.visible || !(obj.isMesh || obj.isLineSegments || obj.isPoints)) return;
      if (!frustum.intersectsObject(obj)) return;
      const step = obj.isPoints ? 1 : obj.isLineSegments ? 2 : 3;
      const count = Math.floor((geo.index?.count ?? positions.count) / step);
      // Sublinear weighting preserves small structures when a large mesh shares the view.
      const weight = Math.pow(count,.72);
      items.push({obj,geo,positions,count,weight,step});
      total += weight;
    });
    const budget = Math.min(42000,Math.max(16000,Math.round(width*height/16)));
    for (const {obj,geo,positions,count,weight,step} of items) {
      const stride = Math.max(1,Math.ceil(count / Math.max(1,budget*weight/total)));
      const planes = obj.material.clippingPlanes || [];
      const matrix = viewProjection.elements;
      const indexAt = i => geo.index ? geo.index.getX(i) : i;
      const p = vertices;
      for (let n=0;n<count;n+=stride) {
        let visible=true;
        for (let j=0;j<step;j++) {
          world.fromBufferAttribute(positions,indexAt(n*step+j)).applyMatrix4(obj.matrixWorld);
          if (planes.some(plane => plane.distanceToPoint(world)<0)) { visible=false; break; }
          const {x,y,z} = world;
          const w=matrix[3]*x+matrix[7]*y+matrix[11]*z+matrix[15];
          if(w<=camera.near || w>=camera.far) { visible=false; break; }
          p[j].x=(1+(matrix[0]*x+matrix[4]*y+matrix[8]*z+matrix[12])/w)*width/2;
          p[j].y=(1-(matrix[1]*x+matrix[5]*y+matrix[9]*z+matrix[13])/w)*height/2;
          p[j].w=w;
        }
        if (!visible) continue;
        const a=p[0], b=p[1], c=p[2];
        if(step===1) {
          if(a.x < -8 || a.x > width+8 || a.y < -8 || a.y > height+8)continue;
          const size=Math.max(1,Math.min(12,obj.material.size*height*camera.projectionMatrix.elements[5]/(2*a.w)));
          draws.push({kind:1,z:a.w,x:a.x,y:a.y,size,color:sampleColor(geo.attributes.color,indexAt(n),obj.material)});
          continue;
        }
        const x3=step===2?b.x:c.x, y3=step===2?b.y:c.y;
        if(Math.max(a.x,b.x,x3)<0 || Math.min(a.x,b.x,x3)>width ||
           Math.max(a.y,b.y,y3)<0 || Math.min(a.y,b.y,y3)>height)continue;
        if(step===2){
          draws.push({kind:2,z:(a.w+b.w)/2,x:a.x,y:a.y,x2:b.x,y2:b.y,color:sampleColor(geo.attributes.color,indexAt(n*2),obj.material)});
          continue;
        }
        const area=Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))/2;
        const shade = Math.min(12,Math.round(4+8*Math.min(1,Math.sqrt(area)/(1+Math.max(Math.hypot(b.x-a.x,b.y-a.y),Math.hypot(c.x-a.x,c.y-a.y))*.5))));
        const color=surfaceColor(obj.material,shade), z=(a.w+b.w+c.w)/3;
        if(stride>2 && area<16) {
          // Project tiny sampled faces as surfels to keep fine anatomy visible.
          draws.push({kind:1,z,x:(a.x+b.x+c.x)/3,y:(a.y+b.y+c.y)/3,size:Math.max(1,Math.min(5,Math.sqrt(area*stride))),color});
        } else {
          draws.push({kind:3,z,x:a.x,y:a.y,x2:b.x,y2:b.y,x3:c.x,y3:c.y,color});
        }
      }
    }
    draws.sort((a,b)=>b.z-a.z);
    for(const d of draws){
      if(d.kind===1){
        ctx.fillStyle=d.color;ctx.fillRect(d.x-d.size/2,d.y-d.size/2,d.size,d.size);
      } else {
        ctx.beginPath();ctx.moveTo(d.x,d.y);ctx.lineTo(d.x2,d.y2);
        if(d.kind===2){ctx.strokeStyle=d.color;ctx.lineWidth=1.3;ctx.stroke()}
        else{ctx.lineTo(d.x3,d.y3);ctx.closePath();ctx.fillStyle=d.color;ctx.fill()}
      }
    }
  }
  return {
    domElement:canvas,
    setPixelRatio(value){ratio=Math.max(1,Math.min(2,value))},
    setSize(w,h,updateStyle=true){
      width=Math.max(1,w);height=Math.max(1,h);
      canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);
      if(updateStyle){canvas.style.width=width+'px';canvas.style.height=height+'px'}
    },
    render
  };
}
