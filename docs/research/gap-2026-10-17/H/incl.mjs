// 倾斜 GEO 的站心视向日摆幅与固定天线指向损失（12(Δθ/θ3dB)^2，θ3dB = 70λ/D）
const R = 6378.137, A = 42164.17, DEG = Math.PI / 180
function stationEcef(latD, lonD) { const la = latD * DEG, lo = lonD * DEG; return [R * Math.cos(la) * Math.cos(lo), R * Math.cos(la) * Math.sin(lo), R * Math.sin(la)] }
function satEcef(slotD, iD, u) { // 圆轨道，升交点在 slot 经度（ECEF 下近似：节点随地球同步，忽略 2e 天平动）
  const i = iD * DEG, lo = slotD * DEG
  // 轨道面内位置：沿迹角 u 相对升交点；在随地球转的系里，卫星经度 ≈ slot + Δλ(u)，纬度 = asin(sin i sin u)
  const lat = Math.asin(Math.sin(i) * Math.sin(u))
  const dl = Math.atan2(Math.cos(i) * Math.sin(u), Math.cos(u)) - u   // 赤经差 − 地球自转（同步）
  const lon = lo + dl
  return [A * Math.cos(lat) * Math.cos(lon), A * Math.cos(lat) * Math.sin(lon), A * Math.sin(lat)]
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], nrm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l) }
const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / DEG
function maxExcursion(st, slot, iD) {
  const s = stationEcef(st[0], st[1]); const nominal = nrm(sub(satEcef(slot, 0, 0), s))
  let mx = 0; for (let k = 0; k < 1440; k++) { const u = 2 * Math.PI * k / 1440; const d = nrm(sub(satEcef(slot, iD, u), s)); mx = Math.max(mx, ang(d, nominal)) } return mx
}
const sites = { 北京: [39.9, 116.4], 乌鲁木齐: [43.8, 87.6], 三亚: [18.25, 109.5], 拉萨: [29.65, 91.1] }
const ants = [['C 4 GHz 3.7 m', 4, 3.7], ['C 4 GHz 2.4 m', 4, 2.4], ['Ku 12 GHz 2.4 m', 12, 2.4], ['Ku 12 GHz 1.2 m', 12, 1.2], ['Ka 20 GHz 0.75 m', 20, 0.75]]
const slot = 115.5
for (const [nm, ll] of Object.entries(sites)) {
  const row = [0.1, 0.5, 1, 2, 3].map((i) => maxExcursion(ll, slot, i))
  console.log(nm, '摆幅(°) i=0.1/0.5/1/2/3:', row.map((x) => x.toFixed(3)).join(' / '))
}
const ex = (i) => maxExcursion(sites['北京'], slot, i)
for (const [nm, f, D] of ants) {
  const th = 70 * (0.299792458 / f) / D
  const loss = [0.1, 0.5, 1, 2, 3].map((i) => 12 * (ex(i) / th) ** 2)
  // 固定天线 ≤0.5 dB / ≤1 dB 指向损失允许的最大倾角（北京）
  let lim05 = 0, lim1 = 0
  for (let i = 0.005; i < 5; i += 0.005) { const L = 12 * (ex(i) / th) ** 2; if (L <= 0.5) lim05 = i; if (L <= 1) lim1 = i }
  console.log(nm, 'θ3dB=' + th.toFixed(3) + '°', '损失 dB i=0.1/0.5/1/2/3:', loss.map((x) => x.toFixed(2)).join(' / '), '| ≤0.5dB 允许 i≈' + lim05.toFixed(3) + '° ≤1dB 允许 i≈' + lim1.toFixed(3) + '°')
}
