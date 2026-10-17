const fs=require('fs'),path=require('path');
const REPO='C:/Users/85256/WeChatProjects/卫星仿真平台';
const core=require(path.join(REPO,'packages/core/index.js'));
const lc=require(path.join(REPO,'packages/core/utils/linkCalculator.js'));
const rr=require(path.join(REPO,'packages/core/utils/rainRate.js'));
const rd=(f)=>fs.readFileSync(path.join(REPO,'resources/itu',f));
core.loadFullPrecisionData({rain:rd('p837_r001_v2.bin'),elev:rd('topo_v1.bin'),vapor:rd('p836_rho_v1.bin'),cloud:rd('p840_logn_v1.bin')});
const V=JSON.parse(fs.readFileSync(path.join(__dirname,'valex.json'),'utf8'));
const polOf=(t)=>Math.abs(t)<1e-9?'H':Math.abs(t-90)<1e-9?'V':'C';
let rows=[];
for(const r of V['P.618-14 Att_Tot']){
  const lat=r.C, lon=r.D, hs=r.E, f=r.G, el=r.H, D=r.I, eta=r.J, tau=r.K, p=r.L;
  const R=rr.queryRainRate(lat,lon).rainRate;
  const AR=lc.scaleRainAttenP618_14(lc.calculateSinglePathRainAttenuation(R,f,polOf(tau),lat,lon,null,hs,el).A001,p,lat,el);
  const AC=lc.calculateCloudAttenuation(f,el,p,lat,lon);
  const AS=lc.calculateScintillationFading(f,el,D,100-p,eta);
  // 平台 AG：雨天口径（ρ10）、Ts 纬度带、Ps 按海拔
  const Ps=1013.25*Math.pow(1-6.5*hs/288.15,5.2561), Ts=Math.max(200,(Math.abs(lat)<22?300.4:Math.abs(lat)<45?283.1:272.4)-6.5*hs);
  const rho=require(path.join(REPO,'packages/core/data/waterVaporGrid.js')).getRhoWs(lat,lon,true);
  const AG=lc.calculateAtmosphericAttenuation(f,el,Ps,Ts,rho);
  const AT=p<=5?AG+Math.sqrt((AR+AC)**2+AS**2):AG+Math.sqrt(AC**2+AS**2);
  rows.push({f,el,p,AG,AC,AR,AS,AT,vAG:r.O,vAC:r.P,vAR:r.Q,vAS:r.R,vAT:r.S});
}
const st=(k)=>{const d=rows.map(x=>x[k]-x['v'+k]);const a=d.map(Math.abs);return `max|Δ|=${Math.max(...a).toFixed(3)} 均值Δ=${(d.reduce((s,v)=>s+v,0)/d.length).toFixed(3)}`;};
console.log('n=',rows.length,' AG',st('AG'),' | AC',st('AC'),' | AR',st('AR'),' | AS',st('AS'),' | AT',st('AT'));
const worst=rows.map(x=>({...x,dAT:x.AT-x.vAT})).sort((a,b)=>Math.abs(b.dAT)-Math.abs(a.dAT)).slice(0,5);
for(const w of worst) console.log(`f=${w.f} el=${w.el.toFixed(1)} p=${w.p}: 平台 AT ${w.AT.toFixed(3)} (AG ${w.AG.toFixed(3)} AC ${w.AC.toFixed(3)} AR ${w.AR.toFixed(3)} AS ${w.AS.toFixed(3)}) vs ValEx ${w.vAT.toFixed(3)} (AG ${w.vAG.toFixed(3)} AC ${w.vAC.toFixed(3)} AR ${w.vAR.toFixed(3)} AS ${w.vAS.toFixed(3)})`);
