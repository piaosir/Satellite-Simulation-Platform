// P.618-14 §2.2.4.1 式联合超越概率（两站各 p=0.1%），双变量正态尾概率数值积分
function Phi(x){return 0.5*(1+erf(x/Math.SQRT2));}
function erf(x){const t=1/(1+0.3275911*Math.abs(x));const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);return x>=0?y:-y;}
function invPhi(p){let lo=-10,hi=10;for(let i=0;i<200;i++){const m=(lo+hi)/2;if(Phi(m)<p)lo=m;else hi=m;}return (lo+hi)/2;}
// P(X>a, Y>b) for standard bivariate normal with corr r
function bvTail(a,b,r){ // integrate over x>a: phi(x) * P(Y>b | x)
  let s=0; const h=1e-3; for(let x=a;x<a+12;x+=h){const px=Math.exp(-x*x/2)/Math.sqrt(2*Math.PI); const c=1-Phi((b-r*x)/Math.sqrt(1-r*r)); s+=px*c*h;} return s; }
for (const d of [10,20,50,100,300,1000]) {
  const rr=0.7*Math.exp(-d/60)+0.3*Math.exp(-((d/700)**2)), ra=0.94*Math.exp(-d/30)+0.06*Math.exp(-((d/500)**2));
  const Prain=5, p=0.1; // %，各站降雨概率、各站中断概率
  const zr=invPhi(1-Prain/100), za=invPhi(1-p/Prain);
  const Pboth=bvTail(zr,zr,rr)*bvTail(za,za,ra)/((Prain/100)**2)*(Prain/100)**2; // 近似：两站同时下雨 × 条件联合超越（§2.2.4.1 结构）
  const Pjoint = bvTail(zr,zr,rr) * bvTail(za,za,ra)/ ( (1-Phi(za))**2 ) * ((p/Prain)**2);
  const union = 2*p/100 - Pjoint;
  console.log(`d=${d} km  ρr=${rr.toFixed(3)} ρa=${ra.toFixed(3)}  联合中断 ${(Pjoint*100).toFixed(4)}%  上下行任一中断 ${(union*100).toFixed(4)}% → 可用度 ${(100-union*100).toFixed(4)}%（连乘 99.8001%）`);
}
