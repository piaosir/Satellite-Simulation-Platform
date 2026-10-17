// SGP4-VER 抽查：00005（Vanguard 1）t=0 / 360 min，对照值凭记忆（Vallado tcppver.out），未联网核实
const path = require('path')
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sat = require(path.join(ROOT, 'packages/core/vendor/satellite.js'))
const l1 = '1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753'
const l2 = '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667'
const rec = sat.twoline2satrec(l1, l2)
const ref = { 0: [7022.46529266, -1400.08296755, 0.03995155, 1.893841015, 6.405893759, 4.534807250], 360: [-7154.03120202, -3783.17682504, -3536.19412294, 4.741887409, -4.151817765, -2.093935425] }
for (const t of [0, 360]) {
  const jd = rec.jdsatepoch + t / 1440
  const d = new Date((jd - 2440587.5) * 86400e3)
  // 用 tsince 直算避免 Date 毫秒截断：satellite.js 的 propagate 走 jday(Date)，这里另走内部 sgp4 不可达，故比较 Date 路径
  const pv = sat.propagate(rec, d)
  const r = pv.position, v = pv.velocity, R = ref[t]
  const dr = Math.hypot(r.x - R[0], r.y - R[1], r.z - R[2]) * 1e6, dv = Math.hypot(v.x - R[3], v.y - R[4], v.z - R[5]) * 1e6
  console.log('t=' + t + ' min：r=(' + [r.x, r.y, r.z].map((x) => x.toFixed(8)).join(', ') + ')  |Δr|=' + dr.toFixed(2) + ' mm  |Δv|=' + dv.toFixed(3) + ' mm/s')
}
