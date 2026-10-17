// 赋形综合（严格 minimax）在不同口径下的耗时 / 是否撞 5 s 时限 —— 直接跑仓库 synth.buildShapedGrd（只读）
import { pathToFileURL } from 'node:url'
const REPO = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const { buildShapedGrd, shapedTheta3db, shapedApertureEff } = await import(pathToFileURL(REPO + '/src/viz/grd/synth.js').href)
// 中国大陆粗轮廓（12 点，经纬度）
const china = [[73.5, 39.5], [80, 45], [87, 49], [97, 42.5], [111, 43], [119.5, 50], [135, 48], [131, 42.5], [121.5, 31], [117, 23.5], [108, 21.5], [98, 24], [92, 27.5], [79, 30.5]]
for (const D of [2.4, 4.0, 6.0, 8.0]) {
  const f = 12.25, th = shapedTheta3db(f, D, -15)
  const t0 = Date.now()
  try {
    const r = buildShapedGrd({ satName: 'T', satLon: 110.5, satLat: 0, altKm: 35786, polysPts: [china], mode: 'physical', effPct: shapedApertureEff(-15).effPct, theta3: th, apDm: D, fSimGHz: f })
    const mm = r.mm || {}
    console.log(`D=${D} m θ3=${th.toFixed(3)}° beamlets=${r.nBeams} stations=${mm.nStations} 用时 ${Date.now() - t0} ms · minimax ${mm.iters} 轮 stoppedBy=${mm.stoppedBy} 最差余量 ${mm.marginDb?.toFixed(2)} dB · 峰值 ${r.peakDbi?.toFixed(2)} dBi · covMin ${r.covMin?.toFixed?.(2)} · ${r.warn || ''}`)
  } catch (e) { console.log(`D=${D}: 抛错 ${e.message}`) }
}
