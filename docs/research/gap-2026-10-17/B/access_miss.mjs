// B 路验证 1：可见性「时段过境」accessWindows 的固定粗扫步长（生产 90 s）对短过境的漏检量级。
// 真值 = 同一函数 coarseSec=1（1 s 粗扫 + 同样的二分精炼），只比较步长这一个变量。
import { pathToFileURL } from 'node:url'
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sat = (await import(pathToFileURL(ROOT + '/src/viz/constellation/satellite.js').href)).default
const V = await import(pathToFileURL(ROOT + '/src/viz/vis/visibility.js').href)

const MU = 398600.4418, RE = 6378.137
const epoch = new Date(Date.UTC(2026, 9, 17, 0, 0, 0))
function walker({ altKm, incl, P, S, F = 1, raan0 = 0 }) {
  const a = RE + altKm, n = 86400 * Math.sqrt(MU / a ** 3) / (2 * Math.PI)
  const out = []
  for (let p = 0; p < P; p++) for (let s = 0; s < S; s++) {
    const raan = raan0 + 360 * p / P, ma = (360 * s / S + 360 * F * p / (P * S)) % 360
    const rec = sat.omm2satrec({ noradId: 900000 + p * 100 + s, epoch: epoch.toISOString(), meanMotion: n, ecc: 0.0001, incl, raan, argp: 0, ma, bstar: 0, mdot: 0, mddot: 0 })
    out.push({ rec, name: `W${p}-${s}`, noradId: 900000 + p * 100 + s, group: 'w', _cc: false })
  }
  return out
}

const cases = [
  { tag: 'LEO550/53° 6面×22 · 北京', c: { altKm: 550, incl: 53, P: 6, S: 22 }, tgt: { lat: 39.9042, lon: 116.4074 } },
  { tag: 'LEO1200/87.9° 6面×20 · 北京（OneWeb 类）', c: { altKm: 1200, incl: 87.9, P: 6, S: 20 }, tgt: { lat: 39.9042, lon: 116.4074 } },
  { tag: 'LEO550/97.6° SSO 4面×10 · 海口', c: { altKm: 550, incl: 97.6, P: 4, S: 10 }, tgt: { lat: 20.04, lon: 110.32 } },
]
const H = 72 * 3600
const times = { now: epoch, ccNow: epoch }
for (const cs of cases) {
  const ents = walker(cs.c)
  for (const thr of [5, 25, 40]) {
    const t0 = performance.now()
    const prod = V.accessWindows(ents, [cs.tgt], times, H, thr, { coarseSec: 90 })
    const t1 = performance.now()
    const truth = V.accessWindows(ents, [cs.tgt], times, H, thr, { coarseSec: 1 })
    const t2 = performance.now()
    const key = (s, w) => s.noradId + '@' + Math.round(w.peakMs / 30000)   // 同一过境（峰值时刻 30 s 桶）
    const prodSet = new Set(); for (const s of prod) for (const w of s.windows) prodSet.add(key(s, w))
    let nT = 0, nMiss = 0, missDur = 0, missMaxDur = 0, missPeakMax = -99, short90 = 0, totDur = 0
    for (const s of truth) for (const w of s.windows) {
      nT++; totDur += w.durMin * 60
      const durS = w.durMin * 60
      if (durS < 90) short90++
      if (!prodSet.has(key(s, w)) && !prodSet.has(s.noradId + '@' + (Math.round(w.peakMs / 30000) - 1)) && !prodSet.has(s.noradId + '@' + (Math.round(w.peakMs / 30000) + 1))) {
        nMiss++; missDur += durS; if (durS > missMaxDur) missMaxDur = durS; if (w.peakEl > missPeakMax) missPeakMax = w.peakEl
      }
    }
    let nP = 0; for (const s of prod) nP += s.windows.length
    const tcP = V.timeCoverage(prod, H / 60), tcT = V.timeCoverage(truth, H / 60)
    console.log(`${cs.tag} | 门限 ${thr}° | 真值过境 ${nT}（<90 s 的 ${short90}） 生产 ${nP} | 漏检 ${nMiss}（${(100 * nMiss / Math.max(1, nT)).toFixed(2)}%，漏掉时长合计 ${missDur.toFixed(0)} s，单次最长 ${missMaxDur.toFixed(0)} s，漏检峰值仰角最高 ${missPeakMax.toFixed(2)}°）`
      + ` | 时间覆盖 生产 ${tcP.pct.toFixed(3)}% 真值 ${tcT.pct.toFixed(3)}% | 最长中断 生产 ${tcP.maxGapMin.toFixed(2)} 真值 ${tcT.maxGapMin.toFixed(2)} min | 中断段数 生产 ${tcP.gapCount} 真值 ${tcT.gapCount} | 耗时 生产 ${(t1 - t0).toFixed(0)} ms / 真值 ${(t2 - t1).toFixed(0)} ms`)
  }
}
