// Saleh TWTA（Saleh 1981 典型参数）多载波（高斯负载）下的 OBO 与 C/IM≈NPR，Bussgang 分解，蒙特卡洛 2e5 样本
const aa=2.1587, ba=1.1517, ap=4.0033, bp=9.1040;
// 单载波饱和点：A(r) 最大处 r_sat = 1/sqrt(ba)，A_sat = aa/(2 sqrt(ba))
const rSat=1/Math.sqrt(ba), Asat=aa/(2*Math.sqrt(ba)), PinSat=rSat*rSat, PoutSat=Asat*Asat;
function randn(){let u=0,v=0;while(u===0)u=Math.random();while(v===0)v=Math.random();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
const N=200000;
console.log('IBO_mc(dB)  OBO_mc(dB)  C/IM≈NPR(dB)');
for(const ibo of [0,2,4,6,8,10,12]){
  const Pin=PinSat*Math.pow(10,-ibo/10), s=Math.sqrt(Pin/2);
  let sxy_re=0, sxy_im=0, sxx=0, syy=0;
  const xs=new Float64Array(2*N), ys=new Float64Array(2*N);
  for(let i=0;i<N;i++){const xr=s*randn(), xi=s*randn(); const r=Math.hypot(xr,xi); const A=aa*r/(1+ba*r*r), ph=ap*r*r/(1+bp*r*r)+Math.atan2(xi,xr);
    const yr=A*Math.cos(ph), yi=A*Math.sin(ph); xs[2*i]=xr;xs[2*i+1]=xi;ys[2*i]=yr;ys[2*i+1]=yi;
    // E[y x*]
    sxy_re+=yr*xr+yi*xi; sxy_im+=yi*xr-yr*xi; sxx+=xr*xr+xi*xi; syy+=yr*yr+yi*yi;}
  const alpha_re=sxy_re/sxx, alpha_im=sxy_im/sxx; const lin=(alpha_re**2+alpha_im**2)*sxx/N; const tot=syy/N; const dist=tot-lin;
  console.log(`${String(ibo).padStart(5)}      ${(10*Math.log10(PoutSat/tot)).toFixed(2).padStart(6)}      ${(10*Math.log10(lin/dist)).toFixed(1).padStart(6)}`);
}
