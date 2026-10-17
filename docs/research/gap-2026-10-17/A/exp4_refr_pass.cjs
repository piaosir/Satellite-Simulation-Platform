// LEO 过顶弧段：P.834 折射使 AOS 提前 / LOS 推迟多少秒（球地球、圆轨道、过顶）
const RE = 6378.137, MU = 398600.4418, DEG = Math.PI / 180
const tau = (h, th) => 1 / (1.314 + 0.6437 * th + 0.02869 * th * th + h * (0.2305 + 0.09428 * th + 0.01096 * th * th) + 0.008583 * h * h)
for (const alt of [550, 1200]) {
  const r = RE + alt, n = Math.sqrt(MU / r ** 3)
  // 地心角 γ 与仰角 ε：tan ε = (cos γ − RE/r) / sin γ
  const elev = (g) => Math.atan2(Math.cos(g) - RE / r, Math.sin(g)) / DEG
  const gOf = (e) => { let lo = 0, hi = Math.acos(RE / r) + 0.1; for (let k = 0; k < 80; k++) { const m = (lo + hi) / 2; if (elev(m) > e) lo = m; else hi = m } return (lo + hi) / 2 }
  const row = []
  for (const mask of [0, 5, 10]) {
    // 视仰角 = 几何仰角 + τ(几何)；视仰角达到 mask 时的几何仰角 e_g：e_g + τ(e_g) = mask
    let lo = mask - 1.5, hi = mask; for (let k = 0; k < 80; k++) { const m = (lo + hi) / 2; if (m + tau(0, Math.max(m, -0.9)) > mask) hi = m; else lo = m }
    const eg = (lo + hi) / 2
    const dg = gOf(eg) - gOf(mask)            // 地心角差
    const dt = dg / n                         // 惯性系近似（地球自转对过顶弧影响小）
    row.push('掩码 ' + mask + '°：几何 ' + eg.toFixed(3) + '° 即可见，AOS 提前/LOS 推迟各 ' + dt.toFixed(1) + ' s')
  }
  console.log(alt + ' km：' + row.join('；'))
}
