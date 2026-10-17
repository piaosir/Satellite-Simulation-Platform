const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台/packages/core/utils/interference/';
const A = require(ROOT + 'ciAsi.js');
const st = { lon: 116.4074, lat: 39.9042, alt: 0 };
const base = (D) => A.downlinkCAsi({
  station: st, rx: { diameterM: D, efficiency: 0.65, freqGHz: 12.5 },
  wanted: { lonDeg: 110.5, eirpDbW: 50, bandwidthHz: 36e6, polarization: 'H' },
  interferers: [
    { id: 'a', name: '邻星A', lonDeg: 113, eirpDensityDbWPerHz: -45, polarization: 'H' },
    { id: 'b', name: '邻星B', lonDeg: 108, eirpDensityDbWPerHz: -45, polarization: 'H' }
  ]
});
for (const D of [4.5, 2.4, 1.8, 1.2, 0.75]) {
  const r = base(D);
  console.log(`D=${D} m  下行 C/ASI(聚合)=${r.ciDb.toFixed(2)} dB  ` + r.sources.map(s => `${s.name} θ=${s.thetaDeg.toFixed(2)}° G=${s.offAxisGainDbi.toFixed(1)} C/I=${s.ciDb.toFixed(1)}`).join(' | '));
}
