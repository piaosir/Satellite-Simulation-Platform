const fs=require('fs'),path=require('path');
const REPO='C:/Users/85256/WeChatProjects/卫星仿真平台';
const core=require(path.join(REPO,'packages/core/index.js'));
const lc=require(path.join(REPO,'packages/core/utils/linkCalculator.js'));
core.loadFullPrecisionData({rain:fs.readFileSync(path.join(REPO,'resources/itu/p837_r001_v2.bin'))});
const PY='C:/Users/85256/AppData/Local/Programs/Python/Python313/python.exe';
const {execFileSync}=require('child_process');
const rows=JSON.parse(execFileSync(PY,['-I','-c',`
import openpyxl,json,sys
wb=openpyxl.load_workbook(sys.argv[1],read_only=True,data_only=True)
ws=wb['P.618-14 A_Rain (non-GSO)']
out=[]
for row in ws.iter_rows(min_row=30,max_row=114,values_only=True):
    out.append(dict(N=row[13],P=row[15],Q=row[16],M=row[12]))
print(json.dumps(out))`, path.join(__dirname,'dl_itu/valex_official/ValEx-Rev8.3.0.xlsx')]).toString());
const lat=33.94, lon=18.43, f=29.6, R001=27.1349664;
// q(el, margin) = 使 A_p(el) = margin 的 p（式(8) 反解，0.001~5% 有效域外钳端点）
function qOf(el, a){
  const {A001}=lc.calculateSinglePathRainAttenuation(R001,f,'C',lat,lon,null,0,el);
  const A=(p)=>lc.scaleRainAttenP618_14(A001,p,lat,el);
  if (a>=A(0.001)) return 0.001; if (a<=A(5)) return 5;
  let lo=Math.log(0.001), hi=Math.log(5);
  for(let k=0;k<80;k++){const m=(lo+hi)/2; if (A(Math.exp(m))>a) lo=m; else hi=m;}
  return Math.exp((lo+hi)/2);
}
let sum=0, maxd=0, rel=[];
for(const r of rows){ const q=qOf(r.N,r.P); sum+=r.M*q/100; maxd=Math.max(maxd,Math.abs(q-r.Q)); rel.push(Math.abs(q/r.Q-1)); }
console.log('§8 ValEx 逐箱 q_i 平台式(8)反解：max|Δq|=',maxd.toExponential(3),'%  max|rel|=',(Math.max(...rel)*100).toFixed(2),'%');
console.log('轨道平均超越概率：平台积木=',sum.toFixed(5),'%   ValEx=0.37942 %   可用度 平台积木',(100-sum).toFixed(4),' ValEx 99.6206');
// 平台口径（FSL 钉在最差几何 → 余量处处取最低仰角那一箱的值）对比 ValEx（余量随斜距变）
const mWorst=rows[0].P;
let sumW=0; for(const r of rows){ sumW+=r.M*qOf(r.N,mWorst)/100; }
console.log('余量钉在最差几何(',mWorst.toFixed(2),'dB)：可见期超越',sumW.toFixed(4),'% vs 随仰角变余量',sum.toFixed(4),'%  → 不可用度高估 ×',(sumW/sum).toFixed(2));
