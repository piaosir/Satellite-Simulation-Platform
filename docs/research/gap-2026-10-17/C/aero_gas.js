const fs=require('fs'),path=require('path');
const REPO='C:/Users/85256/WeChatProjects/卫星仿真平台';
const core=require(path.join(REPO,'packages/core/index.js'));
const rd=(f)=>fs.readFileSync(path.join(REPO,'resources/itu',f));
core.loadFullPrecisionData({rain:rd('p837_r001_v2.bin'),elev:rd('topo_v1.bin'),vapor:rd('p836_rho_v1.bin'),cloud:rd('p840_logn_v1.bin')});
const {gamma0Exact,gammawExact}=require('./p676_compare.js');
const lc=require(path.join(REPO,'packages/core/utils/linkCalculator.js'));
function run(altM){
  const d=core.calculateLinkBudget({frequencyBand:'Ka',orbitPosition:110.5},{centerFrequency:30,rxCenterFrequency:20,uplinkAvailability:100,rxLatitude:23.13,rxLongitude:113.26,rxAltitude:altM,rxRainRate:83,rxDownlinkAvailability:99.5,rxAntennaDiameter:0.6,rxAntennaEfficiency:60,rxFeederLoss:0.3,rxReceiverNoiseTemp:75,rxAntennaNoiseTempMode:'自动',downlinkPolarization:'L'}).data;
  return d;
}
const g=run(0), a=run(10000);
console.log(`地面站：气体 ${g.downlinkAtmosphericAttenuationResult} 雨 ${g.downlinkRainAttenuationResult} 云 ${g.downlinkCloudAttenuation} dB`);
console.log(`10 km 机载：气体 ${a.downlinkAtmosphericAttenuationResult} 雨 ${a.downlinkRainAttenuationResult} 云 ${a.downlinkCloudAttenuation} dB`);
// 参照：P.676-13 Annex 1 逐层积分（P.835 标准大气，地面 ρ0=20 g/m³，标高 2 km）从 10 km 积到 100 km，仰角 62.7°
function std(h){ // P.835-6 平均年参考大气（简化：对流层/平流层两段）
  let T,P; if(h<=11){T=288.15-6.5*h;P=1013.25*Math.pow(288.15/T,-34.1632/6.5);} else if(h<=20){T=216.65;P=226.3226*Math.exp(-34.1632*(h-11)/216.65);} else if(h<=32){T=216.65+(h-20);P=54.74980*Math.pow(216.65/T,34.1632);} else {T=228.65+2.8*(h-32);P=8.680422*Math.pow(228.65/T,34.1632/2.8);}
  const rho=20*Math.exp(-h/2); return {T,P,rho:Math.max(rho,0)}; }
let A=0; const el=62.7*Math.PI/180;
for(let h=10;h<100;h+=0.05){ const s=std(h+0.025); const e=s.rho*s.T/216.7; const p=s.P-e; A+=(gamma0Exact(20,p,s.rho,s.T)+gammawExact(20,p,s.rho,s.T))*0.05/Math.sin(el); }
console.log(`参照（Annex 1 分层，10 km→100 km）：气体 ≈ ${A.toFixed(3)} dB`);
console.log(`自动天线噪温：地面 ${g.antennaNoiseTempResult} K / 10 km ${a.antennaNoiseTempResult} K；系统噪温 地面 ${g.systemNoiseTempKResult} / 10 km ${a.systemNoiseTempKResult} K；G/T ${g.gOverTeResult} / ${a.gOverTeResult}`);
// 10 km 处物理上的天空噪温（Annex 1 分层气体 0.008 dB、云 0）
const Tsky=275*(1-10**(-0.008/10))+2.7*10**(-0.008/10);
const L=10**(0.3/10); const TsysTrue=(Tsky+25)/L+290*(1-1/L)+75;
console.log(`10 km 物理口径：天空 ${Tsky.toFixed(1)} K → 系统噪温 ≈ ${TsysTrue.toFixed(1)} K；与平台差 ${(10*Math.log10(a.systemNoiseTempKResult/TsysTrue)).toFixed(2)} dB（G/T）`);
