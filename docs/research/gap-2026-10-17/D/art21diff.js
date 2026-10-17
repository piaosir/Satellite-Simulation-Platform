// 平台 linkCalculator.js:975-1115 的 Art.21 if 链（照抄其公式）vs RR 2024 Vol.1 Table 21-4（pp.287-291，本轮从官方 PDF 抽取）
const L = Math.log10;
// 平台（GSO/NGSO 两引擎同一份）——单位：1 MHz 段返回 dB(W/m²·MHz)，4 kHz 段返回 dB(W/m²·4kHz)
function plat(fGHz, d) {
  const s = (a, b) => (d <= 5 ? a : d <= 25 ? a + 0.5 * (d - 5) : b);
  if (fGHz >= 17.7 && fGHz <= 19.7) return { v: s(-115, -105), bw: '1MHz' };
  if (fGHz >= 19.7 && fGHz <= 21.2) return { v: s(-115, -105), bw: '1MHz' };
  if (fGHz >= 37.5 && fGHz <= 40.5) return { v: s(-115, -105), bw: '1MHz' };
  if (fGHz >= 40.5 && fGHz <= 42.5) return { v: s(-115, -105), bw: '1MHz' };
  if (fGHz >= 11.7 && fGHz <= 12.2) return { v: s(-150, -140), bw: '4kHz' };
  return null;
}
// RR 2024 Table 21-4
function X(N, Nv) { if (N <= 50) return 0; if (N <= 288) return (5 / 119) * (N - 50); if (N <= 999) return (1 / 69) * (N + 402); if (N <= 6000) return Math.max(20.3, 10 * L(Nv)); return 10 * L(Nv) + 1; }
const rrNgsoKa = (d, N, Nv) => { const x = X(N, Nv); return d <= 5 ? -115 - x : d <= 25 ? -115 - x + ((10 + x) / 20) * (d - 5) : -105; };
const rrGsoQ = (d) => d <= 5 ? -127 : d <= 20 ? -127 + (4 / 3) * (d - 5) : d <= 25 ? -107 + 0.4 * (d - 20) : -105;      // 37.5-40 GSO
const rrGso405 = (d) => d <= 5 ? -120 : d <= 15 ? -120 + (d - 5) : d <= 25 ? -110 + 0.5 * (d - 15) : -105;           // 40.5-42 GSO
const rrGso42 = (d) => d <= 5 ? -127 : d <= 20 ? -127 + (4 / 3) * (d - 5) : d <= 25 ? -107 + 0.4 * (d - 20) : -105;    // 42-42.5 GSO
for (const d of [3, 10, 15, 20, 25, 40]) {
  const p = plat(18.5, d).v;
  console.log(`δ=${d}°  18.5GHz NGSO(N=1000,Nv=40): RR ${rrNgsoKa(d, 1000, 40).toFixed(1)} 平台 ${p.toFixed(1)} 差 ${(p - rrNgsoKa(d, 1000, 40)).toFixed(1)} dB | N>6000,Nv=60: RR ${rrNgsoKa(d, 7000, 60).toFixed(1)} 差 ${(p - rrNgsoKa(d, 7000, 60)).toFixed(1)} | 38GHz GSO: RR ${rrGsoQ(d).toFixed(1)} 平台 ${plat(38, d).v.toFixed(1)} 差 ${(plat(38, d).v - rrGsoQ(d)).toFixed(1)} | 41GHz GSO 差 ${(plat(41, d).v - rrGso405(d)).toFixed(1)} | 42.2GHz GSO 差 ${(plat(42.2, d).v - rrGso42(d)).toFixed(1)}`);
}
console.log('19.7-21.2 GHz：RR 2024 Table 21-4 无此行（平台给出 −115…−105 dB(W/m²·MHz)）；11.7-12.2 GHz：RR 2024 无 GSO FSS 行（平台给出 −150…−140 dB(W/m²·4kHz)）');
