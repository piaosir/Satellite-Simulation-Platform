import sat from 'file:///C:/Users/85256/WeChatProjects/卫星仿真平台/src/viz/constellation/satellite.js'
const l1 = '1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753'
const l2 = '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667'
const rec = sat.twoline2satrec(l1, l2)
const ref = { 0: [7022.46529266, -1400.08296755, 0.03995155, 1.893841015, 6.405893759, 4.534807250], 360: [-7154.03120202, -3783.17682504, -3536.19412294, 4.741887409, -4.151817765, -2.093935425] }
for (const t of [0, 360]) {
  const pv = sat.sgp4(rec, t)
  const r = pv.position, v = pv.velocity, R = ref[t]
  const dr = Math.hypot(r.x - R[0], r.y - R[1], r.z - R[2]) * 1e6, dv = Math.hypot(v.x - R[3], v.y - R[4], v.z - R[5]) * 1e6
  console.log('sgp4(tsince=' + t + ')：|Δr|=' + dr.toFixed(3) + ' mm  |Δv|=' + dv.toFixed(4) + ' mm/s')
}
// Date 路径的毫秒截断：历元小数日 → ms
const fracMs = (rec.jdsatepoch - Math.floor(rec.jdsatepoch - 0.5) - 0.5) * 86400e3
console.log('历元 jdsatepoch 对应 UTC 毫秒小数部分：' + (fracMs % 1).toFixed(4) + ' ms（Date 只到整毫秒）')
