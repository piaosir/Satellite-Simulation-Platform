const C=require('C:/Users/85256/WeChatProjects/卫星仿真平台/packages/core/utils/constants.js');
const keys=Object.keys(C).filter(k=>/MODCOD/i.test(k)); console.log('exports:',keys.join(','));
const ETSI_S2X={ 'QPSK 2/9':-2.85,'QPSK 13/45':-2.03,'QPSK 9/20':0.22,'QPSK 11/20':1.45,'8APSK 5/9-L':4.73,'8APSK 26/45-L':5.13,'8PSK 23/36':6.12,'8PSK 25/36':7.02,'8PSK 13/18':7.49,
'16APSK 1/2-L':5.97,'16APSK 8/15-L':6.55,'16APSK 5/9-L':6.84,'16APSK 26/45':7.51,'16APSK 3/5':7.80,'16APSK 3/5-L':7.41,'16APSK 28/45':8.10,'16APSK 23/36':8.38,'16APSK 2/3-L':8.43,'16APSK 25/36':9.27,'16APSK 13/18':9.71,'16APSK 7/9':10.65,'16APSK 77/90':11.99,
'32APSK 2/3-L':11.10,'32APSK 32/45':11.75,'32APSK 11/15':12.17,'32APSK 7/9':13.05,'64APSK 32/45-L':13.98,'64APSK 11/15':14.81,'64APSK 7/9':15.47,'64APSK 4/5':15.87,'64APSK 5/6':16.55,'128APSK 3/4':17.73,'128APSK 7/9':18.53,
'256APSK 29/45-L':16.98,'256APSK 2/3-L':17.24,'256APSK 31/45-L':18.10,'256APSK 32/45':18.59,'256APSK 11/15-L':18.84,'256APSK 3/4':19.57};
const ETSI_S2={'QPSK 1/4':-2.35,'QPSK 1/3':-1.24,'QPSK 2/5':-0.30,'QPSK 1/2':1.00,'QPSK 3/5':2.23,'QPSK 2/3':3.10,'QPSK 3/4':4.03,'QPSK 4/5':4.68,'QPSK 5/6':5.18,'QPSK 8/9':6.20,'QPSK 9/10':6.42,'8PSK 3/5':5.50,'8PSK 2/3':6.62,'8PSK 3/4':7.91,'8PSK 5/6':9.35,'8PSK 8/9':10.69,'8PSK 9/10':10.98,'16APSK 2/3':8.97,'16APSK 3/4':10.21,'16APSK 4/5':11.03,'16APSK 5/6':11.61,'16APSK 8/9':12.89,'16APSK 9/10':13.13,'32APSK 3/4':12.73,'32APSK 4/5':13.64,'32APSK 5/6':14.28,'32APSK 8/9':15.69,'32APSK 9/10':16.05};
function cmp(name, tab, ref, fallback){
  let n=0, bad=[], miss=[];
  for(const r of tab){ const lab=r.label; let ref1=ref[lab]; if(ref1===undefined && fallback) ref1=fallback[lab]; if(ref1===undefined){miss.push(lab);continue;} n++; const d=r.threshold-ref1; if(Math.abs(d)>0.005) bad.push(`${lab}: 平台 ${r.threshold} / ETSI ${ref1} (Δ${d>0?'+':''}${d.toFixed(2)})`); }
  console.log(`== ${name}: 共 ${tab.length} 行，可比 ${n}，偏离 ${bad.length}`); bad.forEach(s=>console.log('   '+s)); if(miss.length) console.log('   ETSI 表里无此名：',miss.join(', '));
  const missingEtsi=Object.keys(ref).filter(k=>!tab.some(r=>r.label===k)); if(missingEtsi.length) console.log('   平台缺 ETSI 档：',missingEtsi.join(', '));
}
const s2=C.DVBS2_MODCOD_TABLE||C.DVB_S2_MODCOD_TABLE, s2x=C.DVBS2X_MODCOD_TABLE||C.DVB_S2X_MODCOD_TABLE;
if(s2) cmp('DVB-S2 vs EN 302 307-1 V1.4.1 Table 13', s2, ETSI_S2);
if(s2x) cmp('DVB-S2X vs EN 302 307-2 V1.4.1 Table 20a（S2 遗留档按 Table 13）', s2x, ETSI_S2X, ETSI_S2);
