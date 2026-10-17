const fs=require('fs'),path=require('path');
const REPO='C:/Users/85256/WeChatProjects/卫星仿真平台';
const core=require(path.join(REPO,'packages/core/index.js'));
const lc=require(path.join(REPO,'packages/core/utils/linkCalculator.js'));
const cloudGrid=require(path.join(REPO,'packages/core/data/cloudParamsGrid.js'));
const rd=(f)=>fs.readFileSync(path.join(REPO,'resources/itu',f));
core.loadFullPrecisionData({cloud:rd('p840_logn_v1.bin')});
const V=JSON.parse(fs.readFileSync(path.join(__dirname,'valex.json'),'utf8'));
console.log('lat lon p f el | ValEx_Lmap(L, Ac) | ValEx_logn(mL sL pL, Ac) | plat(m s P, Ac)');
for(const r of V['P.840-9 A_Clouds']){
  const pp=cloudGrid.getParams(r.C,r.D);
  const plat=lc.calculateCloudAttenuation(r.F,r.G,r.E,r.C,r.D);
  console.log([r.C,r.D,r.E,r.F,r.G].join(' '),'|',r.L.toFixed(4),r.M.toFixed(4),'|',[r.U,r.V,r.W].join(' '),(r.Z||0).toFixed(4),'|',pp.m.toFixed(3),pp.sigma.toFixed(3),pp.Pclw.toFixed(2),plat.toFixed(4));
}
const xp=V['P.618-14 XPD'];
const d=xp.filter(r=>r.I<=60).map(r=>Math.abs(lc.calculateRainXPD_P618_14(r.K,r.H,r.J,r.I,r.G)-r.T));
console.log('XPD θ≤60°: n=',d.length,' max|Δ|=',Math.max(...d).toExponential(3));
