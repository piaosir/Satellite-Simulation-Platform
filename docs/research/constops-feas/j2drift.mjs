// J2 节点进动差：泊轨高度 vs 工作壳，每天拉开多少度、错开一个面间距要几天
const MU = 398600.4418, RE = 6378.137, J2 = 1.08262668e-3, D = 180 / Math.PI
const rate = (h, i) => { const a = RE + h, n = Math.sqrt(MU / a ** 3); return -1.5 * n * J2 * (RE / a) ** 2 * Math.cos(i / D) * 86400 * D }
const cases = [[43, 483, 3.63], [53.16, 463, 2.99], [70, 475, 26.43], [97.28, 466, 3.90], [53.05, 550, 5.0]]
for (const [i, hOp, sp] of cases) {
  const rows = [300, 350, 400].map(hp => { const d = rate(hp, i) - rate(hOp, i); return `${hp}km: ${d.toFixed(3)}°/d, 一个面间距 ${(Math.abs(sp / d)).toFixed(1)} d` })
  console.log(`i=${i}° 壳 ${hOp} km（Ω̇=${rate(hOp, i).toFixed(3)}°/d，面距 ${sp}°）  ←  ${rows.join(' | ')}`)
}
// Edelbaum 共面圆轨道低推力升轨 Δv = |v1 − v2|
const v = h => Math.sqrt(MU / (RE + h)) * 1000
for (const [a, b] of [[300, 480], [350, 480], [280, 550], [550, 480]]) console.log(`Δv ${a}→${b} km = ${Math.abs(v(a) - v(b)).toFixed(1)} m/s`)
