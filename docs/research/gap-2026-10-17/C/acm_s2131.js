// S.2131-1 §2.4 式 ACM 统计吞吐（示意量级）：平台自己的雨衰/云衰函数 + 平台 S2X 表（与 ETSI 表各算一遍）
const fs=require('fs'),path=require('path');
const REPO='C:/Users/85256/WeChatProjects/卫星仿真平台';
const core=require(path.join(REPO,'packages/core/index.js'));
const lc=require(path.join(REPO,'packages/core/utils/linkCalculator.js'));
const C=require(path.join(REPO,'packages/core/utils/constants.js'));
const rr=require(path.join(REPO,'packages/core/utils/rainRate.js'));
const rd=(f)=>fs.readFileSync(path.join(REPO,'resources/itu',f));
core.loadFullPrecisionData({rain:rd('p837_r001_v2.bin'),cloud:rd('p840_logn_v1.bin')});
const lat=23.13, lon=113.26, f=20, satLon=110.5;
const el=lc.calculateSatelliteAngle(lat,lon,satLon).elevation;
const R=rr.queryRainRate(lat,lon).rainRate;
const {A001}=lc.calculateSinglePathRainAttenuation(R,f,'C',lat,lon,satLon,0);
const Tclear=150; // 晴空系统噪温 K（VSAT 量级）
const esnoClear=14.0, sym=36; // 晴空 Es/N0 dB、符号率 Msps
const rows=C.DVBS2X_MODCOD_TABLE.map(r=>{const [n,d]=r.fec.split('/').map(Number);return {lab:r.label,th:r.threshold,se:Math.log2({QPSK:4,'8PSK':8,'16APSK':16,'32APSK':32,'64APSK':64,'128APSK':128,'256APSK':256}[r.modulation]||4)*n/d};}).filter(r=>r.se>0);
function esnoAt(p){ const Ar=lc.scaleRainAttenP618_14(A001,p,lat,el); const Ac=lc.calculateCloudAttenuation(f,el,p,lat,lon); const A=Ar+Ac;
  const Train=275*(1-10**(-A/10)); const dnd=A+10*Math.log10((Tclear+Train)/Tclear); return esnoClear-dnd; }
function seAt(esno,margin){ let best=0; for(const r of rows) if(r.th+margin<=esno && r.se>best) best=r.se; return best; }
// p 网格（S.2131 Table 4 式，0.001%~5% 对数取点；>5% 视为晴空）
const P=[0.001,0.002,0.003,0.005,0.01,0.02,0.03,0.05,0.1,0.2,0.3,0.5,1,2,3,5];
const margin=0.5;
let acc=0, unavail=0; let prevP=0;
for(let i=0;i<P.length;i++){ const p=P[i], pNext=i+1<P.length?P[i+1]:100;
  // 前向差：区间 [p_i, p_{i+1}] 按更深一端（p_i 处）的 Es/N0 计（S.2131 §2.4 口径，见 reverted-modules 记忆）
  const se=seAt(esnoAt(p),margin); acc+=se*(pNext-p)/100; if(se===0) unavail=Math.max(unavail,pNext); }
acc+= (P[0]/100)*0; // p<0.001% 视为中断
const seClear=seAt(esnoClear,margin);
const seDesign=seAt(esnoAt(0.1),margin); // 99.9% 设计点固定 MODCOD（CCM）
console.log(`广州 20 GHz 仰角 ${el.toFixed(1)}° R0.01=${R.toFixed(1)} mm/h；晴空 Es/N0 ${esnoClear} dB，余量 ${margin} dB`);
console.log(`晴空峰值档（平台 MIR 口径）SE=${seClear.toFixed(3)} b/sym → ${(seClear*sym).toFixed(1)} Mbps`);
console.log(`99.9% 设计点固定 MODCOD（CCM）SE=${seDesign.toFixed(3)} → ${(seDesign*sym).toFixed(1)} Mbps`);
console.log(`ACM 年均（S.2131 §2.4 加权）SE=${acc.toFixed(3)} → ${(acc*sym).toFixed(1)} Mbps；ACM 中断起点 p≈${unavail}%`);
