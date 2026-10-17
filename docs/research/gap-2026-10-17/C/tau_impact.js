const fs=require('fs'),path=require('path');
const REPO='C:/Users/85256/WeChatProjects/卫星仿真平台';
const core=require(path.join(REPO,'packages/core/index.js'));
const lc=require(path.join(REPO,'packages/core/utils/linkCalculator.js'));
const rr=require(path.join(REPO,'packages/core/utils/rainRate.js'));
core.loadFullPrecisionData({rain:fs.readFileSync(path.join(REPO,'resources/itu/p837_r001_v2.bin'))});
// 一般 τ 的 P.838 合成：把平台 H/V 两档系数取出来按式(4)(5)现算
function kAlpha(f, tauDeg, elDeg){
  const [kH,aH]=lc.getCoefficients(f,'H',0), [kV,aV]=lc.getCoefficients(f,'V',0); // θ=0 ⇒ cos²θ=1 ⇒ 取回纯 kH/αH、kV/αV
  const c=Math.cos(elDeg*Math.PI/180)**2*Math.cos(2*tauDeg*Math.PI/180);
  const k=(kH+kV+(kH-kV)*c)/2, a=(kH*aH+kV*aV+(kH*aH-kV*aV)*c)/(2*k); return [k,a];
}
const satLon=110.5;
const sites=[['喀什',39.47,75.99],['乌鲁木齐',43.83,87.62],['拉萨',29.65,91.13],['哈尔滨',45.75,126.65],['广州',23.13,113.26]];
for(const [n,la,lo] of sites){
  const g=lc.calculateSatelliteAngle(la,lo,satLon); const el=g.elevation;
  const skew=lc.calculatePolarizationAngle(lo,la,satLon);
  const R=rr.queryRainRate(la,lo).rainRate;
  const out=[n,`仰角${el.toFixed(1)}° 极化偏转${skew.toFixed(1)}° R001=${R.toFixed(1)}`];
  for(const f of [14.25,30]){
    // 平台：'H' → τ=0
    const A0=lc.scaleRainAttenP618_14(lc.calculateSinglePathRainAttenuation(R,f,'H',la,lo,null,0,el).A001,0.1,la,el);
    // 正确：τ = 偏转角，按 P.618 步骤 5～9 手算一遍（复用平台的路径几何：用 H 档系数反推 γ 不行，故整段重算）
    const h0=require(path.join(REPO,'packages/core/utils/isothermHeight.js')).getIsothermHeight(la,lo), hR=h0+0.36;
    const er=el*Math.PI/180, Ls=hR/Math.sin(er), LG=Ls*Math.cos(er);
    const [k,a]=kAlpha(f,skew,el), gam=k*R**a;
    const r001=1/(1+0.78*Math.sqrt(LG*gam/f)-0.38*(1-Math.exp(-2*LG)));
    const zeta=Math.atan(hR/(LG*r001)); const LR=zeta>er?LG*r001/Math.cos(er):hR/Math.sin(er);
    const chi=Math.abs(la)<36?36-Math.abs(la):0;
    const v=1/(1+Math.sqrt(Math.sin(er))*(31*(1-Math.exp(-el/(1+chi)))*Math.sqrt(LR*gam)/(f*f)-0.45));
    const A001=gam*LR*v; const At=lc.scaleRainAttenP618_14(A001,0.1,la,el);
    out.push(`${f}G H档 ${A0.toFixed(2)} → τ=偏转 ${At.toFixed(2)} dB (${((A0/At-1)*100).toFixed(1)}%)`);
  }
  console.log(out.join(' | '));
}
