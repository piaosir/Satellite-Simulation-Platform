const fs=require('fs'),path=require('path');
const REPO='C:/Users/85256/WeChatProjects/卫星仿真平台';
const core=require(path.join(REPO,'packages/core/index.js'));
const lc=require(path.join(REPO,'packages/core/utils/linkCalculator.js'));
const vap=require(path.join(REPO,'packages/core/data/waterVaporGrid.js'));
core.loadFullPrecisionData({vapor:fs.readFileSync(path.join(REPO,'resources/itu/p836_rho_v1.bin'))});
const {annex2Official}=require('./p676_compare.js');
// 站址：实际年均气温（气象常年值，约值）对比平台纬度带 Ts
const sites=[['广州',23.13,113.26,0.02,295.2],['北京',39.9,116.4,0.05,285.8],['拉萨',29.65,91.1,3.65,281.6],['乌鲁木齐',43.8,87.6,0.9,280.2],['三亚',18.25,109.5,0.01,299.0]];
for(const [n,la,lo,hkm,TsReal] of sites){
  const Ps=1013.25*Math.pow(Math.max(0.01,1-6.5*hkm/288.15),5.2561);
  const TsBand=Math.max(200,(Math.abs(la)<22?300.4:Math.abs(la)<45?283.1:272.4)-6.5*hkm);
  const rC=vap.getRhoWs(la,lo,false), rR=vap.getRhoWs(la,lo,true);
  const line=[n,`Ts带=${TsBand.toFixed(1)}K 实≈${TsReal}K`,`ρ90=${rC.toFixed(1)} ρ10=${rR.toFixed(1)}`];
  for(const f of [20,30,40,50]){
    const a1=lc.calculateAtmosphericAttenuation(f,40,Ps,TsBand,rR);
    const a2=lc.calculateAtmosphericAttenuation(f,40,Ps,TsReal,rR);
    const a3=annex2Official(f,40,Ps,TsReal,rR).A;
    line.push(`${f}G ${a1.toFixed(2)}→Ts实${a2.toFixed(2)}→+逐线${a3.toFixed(2)}`);
  }
  console.log(line.join(' | '));
}
