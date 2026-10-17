const fs=require('fs'),path=require('path');
const REPO='C:/Users/85256/WeChatProjects/卫星仿真平台';
const core=require(path.join(REPO,'packages/core/index.js'));
const lc=require(path.join(REPO,'packages/core/utils/linkCalculator.js'));
const cg=require(path.join(REPO,'packages/core/data/cloudParamsGrid.js'));
core.loadFullPrecisionData({cloud:fs.readFileSync(path.join(REPO,'resources/itu/p840_logn_v1.bin'))});
const corr=(f)=>0.1522*Math.exp(-((f+23.9589)**2)/3.2991e3)+11.51*Math.exp(-((f-219.2096)**2)/2.7595e6)-10.4912;
const KL9=(f)=>lc.cloudSpecificAttenuation(f,273.75)*corr(f);
const sites=[['北京',39.9,116.4],['上海',31.2,121.5],['广州',23.13,113.26],['成都',30.66,104.06],['三亚',18.25,109.5]];
const el=45, p=0.1;
for(const [n,la,lo] of sites){
  const pp=cg.getParams(la,lo);
  const row=[n];
  for(const f of [20,30,40]){
    const now=lc.calculateCloudAttenuation(f,el,p,la,lo);                       // 平台：KL(273.15)×L(max(p,1))
    const at5=KL9(f)*lc.cloudLWCFromLognormal(5,pp)/Math.sin(el*Math.PI/180);    // P.618-14 §2.5 式(67)：AC(5%)，KL 按 P.840-9
    const atp=KL9(f)*lc.cloudLWCFromLognormal(p,pp)/Math.sin(el*Math.PI/180);    // P.840-9 单看云衰统计：AC(p)，无封顶
    row.push(`${f}G 现${now.toFixed(2)}/§2.5应${at5.toFixed(2)}/P.840@p ${atp.toFixed(2)}`);
  }
  console.log(row.join('  '));
}
