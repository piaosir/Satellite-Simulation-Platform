const fs=require('fs'),path=require('path');
const REPO='C:/Users/85256/WeChatProjects/卫星仿真平台';
const core=require(path.join(REPO,'packages/core/index.js'));
const rd=(f)=>fs.readFileSync(path.join(REPO,'resources/itu',f));
core.loadFullPrecisionData({rain:rd('p837_r001_v2.bin'),elev:rd('topo_v1.bin'),vapor:rd('p836_rho_v1.bin'),cloud:rd('p840_logn_v1.bin')});
function run(av, f, lat, lon, mode){
  const r=core.calculateLinkBudget({frequencyBand:'Ka',satelliteName:'K',orbitPosition:110.5},{
    centerFrequency:30, rxCenterFrequency:f, latitude:39.9, longitude:116.4, rainRate:'', uplinkAvailability:100,
    rxLatitude:lat, rxLongitude:lon, rxRainRate:core.geoAutoFill(lat,lon).rainRate, rxDownlinkAvailability:av,
    rxAntennaDiameter:1.2, rxAntennaEfficiency:65, rxFeederLoss:0.3, rxReceiverNoiseTemp:75, rxAntennaNoiseTempMode:mode, rxAntennaNoiseTemp:35,
    downlinkPolarization:'L', uplinkPolarization:'R'});
  return r.data;
}
for (const [n,la,lo] of [['广州',23.13,113.26],['北京',39.9,116.4]]) for (const av of [99.9,99.5]) {
  const d=run(av,20,la,lo,'自动');
  const Ag=+d.downlinkAtmosphericAttenuationResult, Ac=+d.downlinkCloudAttenuation, Ar=+d.downlinkRainAttenuationResult;
  const L=10**(0.3/10);
  const sepSky=275*(1-10**(-Ag/10))+2.7*10**(-Ag/10)+275*(1-10**(-Ac/10))+275*(1-10**(-Ar/10));
  const aT=10**(-(Ag+Ac+Ar)/10), combSky=275*(1-aT)+2.7*aT;
  // 平台雨天系统噪温（参考点同平台：天线端各项 /L + 馈线热噪 + 接收机）
  const Tsep=(sepSky+25)/L+290*(1-1/L)+75, Tcomb=(combSky+25)/L+290*(1-1/L)+75;
  console.log(`${n} 20GHz 可用度${av}%: Ag=${Ag} Ac=${Ac} Ar=${Ar} dB | 天空噪温 分项相加 ${sepSky.toFixed(1)} K vs 式(69)合成 ${combSky.toFixed(1)} K | 雨天 T_sys ${Tsep.toFixed(1)} vs ${Tcomb.toFixed(1)} K → G/T 差 ${(10*Math.log10(Tsep/Tcomb)).toFixed(2)} dB | 平台 G/T劣化 ${d.gOverTdegradationResult} dB`);
}
