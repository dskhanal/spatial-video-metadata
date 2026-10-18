/* Geometry shared by rendering, calibration, and the manual outline editor. */
const BillboardMath = (() => {
  const POINTS = 12;
  const radians = angle => angle * Math.PI / 180;
  function defaultPolygon() {
    return Array.from({ length: POINTS }, (_, i) => {
      const a = -Math.PI / 2 + i * 2 * Math.PI / POINTS;
      return [0.5 + Math.cos(a) * 0.13, 0.53 + Math.sin(a) * 0.31];
    });
  }
  function validPolygon(points) {
    if (!Array.isArray(points) || points.length !== POINTS || points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v) || v < 0 || v > 1))) return false;
    const cross = (a, b, c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    let area = 0;
    for (let i = 0; i < POINTS; i++) {
      const a = points[i], b = points[(i+1)%POINTS];
      if (Math.hypot(a[0]-b[0], a[1]-b[1]) < 0.001) return false;
      area += a[0]*b[1]-a[1]*b[0];
      for (let j = i+2; j < POINTS; j++) {
        if (i===0 && j===POINTS-1) continue;
        const c=points[j], d=points[(j+1)%POINTS];
        const abC=cross(a,b,c), abD=cross(a,b,d), cdA=cross(c,d,a), cdB=cross(c,d,b);
        if (abC*abD <= 0 && cdA*cdB <= 0 && Math.max(a[0],b[0])>=Math.min(c[0],d[0]) && Math.max(c[0],d[0])>=Math.min(a[0],b[0]) && Math.max(a[1],b[1])>=Math.min(c[1],d[1]) && Math.max(c[1],d[1])>=Math.min(a[1],b[1])) return false;
      }
    }
    return Math.abs(area) > 0.001;
  }
  function outlineAt(config, time) {
    const frames = config.cutoutKeyframes || [];
    if (!frames.length) return config.cutoutPoints.map(p=>[...p]);
    if (time <= frames[0].time) return frames[0].points.map(p=>[...p]);
    for (let i=1;i<frames.length;i++) {
      if (time <= frames[i].time) {
        const a=frames[i-1], b=frames[i], f=(time-a.time)/(b.time-a.time);
        const points=a.points.map((p,j)=>p.map((v,k)=>v+(b.points[j][k]-v)*f));
        return (validPolygon(points) ? points : (f<0.5?a.points:b.points)).map(p=>[...p]);
      }
    }
    return frames[frames.length-1].points.map(p=>[...p]);
  }
  function depthLimit(config) {
    const w=config.width/100, h=config.height/100;
    let limit=0.8;
    for (const angle of [config.leftAngle, config.rightAngle]) {
      if (angle<0) limit=Math.min(limit,w*0.4/-Math.tan(radians(angle)));
    }
    if (config.topAngle<0) limit=Math.min(limit,h*(1-config.floorLevel/100)*0.8/-Math.tan(radians(config.topAngle)));
    return limit*100;
  }
  function fitBounds(config) {
    const w=config.width/100,h=config.height/100,b=h*0.045,d=config.distance/100;
    const z=Math.min(Math.max(config.popout, config.cutoutEnabled?config.cutoutDepth:0)/100,d*0.6);
    let minX=-w/2-b,maxX=w/2+b,minY=-h/2-b,maxY=h/2+b;
    const scale=d/(d-z);
    // Reserve both ends of the optional head-movement preview, even when paused.
    for (const ex of [config.eyeX/100-w*0.12,config.eyeX/100+w*0.12]) {
      for (const x of [-w/2,w/2]) { const p=ex+(x-ex)*scale;minX=Math.min(minX,p);maxX=Math.max(maxX,p); }
    }
    const ey=config.eyeY/100;
    for (const y of [-h*0.528,h/2]) { const p=ey+(y-ey)*scale;minY=Math.min(minY,p);maxY=Math.max(maxY,p); }
    const margin=h*0.12;
    return [minX-margin,minY-margin,maxX-minX+2*margin,maxY-minY+2*margin];
  }
  function validBounds(b) { return Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[2]>0.01&&b[3]>0.01; }
  return { POINTS, radians, defaultPolygon, validPolygon, outlineAt, depthLimit, fitBounds, validBounds };
})();
if (typeof module !== 'undefined') module.exports = BillboardMath;
