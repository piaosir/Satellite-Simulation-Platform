// ITU-R P.676-13 气体吸收（itu/p676.js + itu/gasSite.js）测试。运行：npm test
//
// 外部金标准：ITU-R SG3 验证算例 ValEx Rev 8.3.0 的 P.676-13 全部六张表（fixtures/itu-valex-8.3.0/p676-13.json）：
//   SpAtt 350 个频点（Annex 1 逐线 γo / γw）、A_Gas_A1_2.2.1a/b 三例（分层射线）、A2_INST 10 例、
//   A2_STAT 年 77 + 月 77 例、A2_Weib 15 例。A2_STAT / Weib 的气象输入取表内给定值（P.2145），故验的是公式本身。
// 关键不变式：
//   ① 六张表全部逐例达标（相对差 ≤ 1e-9）。
//   ② 引擎取值口径（gasSite）：p = 100 − 可用度；p < 5% 取 A_G(5%)（P.618-14 式 68），晴空取 50%；
//      θ ≥ 5° 走 Annex 2 统计法，θ < 5° 走 Annex 1 分层射线；P.836 v2 缺失时退回瞬时法 1。
//   ③ 旧闭式（P.676-9/10 式 22/23）已不在任何路径上：SpAtt 12 GHz 的 γw 与旧口径相差 > 10%。
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const p676 = require('../utils/itu/p676.js')
const gs = require('../utils/itu/gasSite.js')
const wv = require('../data/waterVaporGrid.js')
const lc = require('../utils/linkCalculator.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300)
const V = JSON.parse(readFileSync(join(HERE, 'fixtures', 'itu-valex-8.3.0', 'p676-13.json'), 'utf8')).sheets

console.log('=== ITU-R P.676-13（ValEx Rev 8.3.0）===\n')

// ① ValEx 六张表
{
  let mo = 0, mw = 0
  for (const [f, go, gw] of V.spAtt.rows) {
    mo = Math.max(mo, rel(p676.gammaOxygen(f, 1013.25, 9.97288878634, 288.15), go))
    mw = Math.max(mw, rel(p676.gammaWaterVapour(f, 1013.25, 9.97288878634, 288.15), gw))
  }
  ok(`SpAtt ${V.spAtt.rows.length} 频点 γo（Annex 1 式 1~9）`, mo < 1e-9, `max rel ${mo.toExponential(2)}`)
  ok(`SpAtt ${V.spAtt.rows.length} 频点 γw`, mw < 1e-9, `max rel ${mw.toExponential(2)}`)

  const tags = ['A1 2.2.1a 0→100 km', 'A1 2.2.1b 1.3→8 km', 'A1 2.2.1b 1.3→100 km']
  V.annex1.rows.forEach(([f, h1, h2, el, A], i) => {
    const r = p676.slantPathLayered(f, el, h1, h2)
    ok(`${tags[i]}（分层射线式 13~19）`, rel(r.A, A) < 1e-9, `${r.A.toFixed(9)} vs ${A}`)
  })

  let mi = 0
  for (const [P, T, f, rho, el, A] of V.a2Inst.rows) mi = Math.max(mi, rel(p676.slantPathInstant(f, el, P, T, rho).A, A))
  ok(`A2_INST ${V.a2Inst.rows.length} 例（§1.1 + §2.1）`, mi < 1e-9, `max rel ${mi.toExponential(2)}`)

  for (const key of ['a2StatAnnual', 'a2StatMonthly']) {
    let ms = 0
    for (const [f, el, P, T, rho, Pp, Tp, rhop, Vp, A] of V[key].rows) {
      ms = Math.max(ms, rel(p676.slantPathStatistical({ f, el, P, T, rho, Pp, Tp, rhop, V: Vp }).A, A))
    }
    ok(`${key} ${V[key].rows.length} 例（§1.2 + §2.3）`, ms < 1e-9, `max rel ${ms.toExponential(2)}`)
  }

  let mwb = 0
  for (const [f, P, T, rho, p, lam, k, Az] of V.a2Weibull.rows) mwb = Math.max(mwb, rel(p676.weibullWaterVapour(f, 90, P, T, rho, p, lam, k), Az))
  ok(`A2_Weib ${V.a2Weibull.rows.length} 例（§2.4 式 42/43）`, mwb < 1e-9, `max rel ${mwb.toExponential(2)}`)
}

// ③ 旧闭式已出局：12 GHz γw 逐线 vs 旧式(23) 相差 > 10%
{
  // 旧 P.676-9/10 式 (23)，仅作对照
  const rp = 1023.22288878634 / 1013.25, rt = 288.15 / 288.15, rho = 7.5, f = 12
  const eta1 = 0.955 * rp * Math.pow(rt, 0.68) + 0.006 * rho
  const g = (fi) => 1 + ((f - fi) / (f + fi)) ** 2
  const old = (3.98 * eta1 / ((f - 22.235) ** 2 + 9.42 * eta1 * eta1) * g(22) + 11.96 * eta1 / ((f - 183.31) ** 2 + 11.14 * eta1 * eta1)
    + 0.081 * eta1 / ((f - 321.226) ** 2 + 6.29 * eta1 * eta1) + 3.66 * eta1 / ((f - 325.153) ** 2 + 9.22 * eta1 * eta1)
    + 25.37 * eta1 / (f - 380) ** 2 + 17.4 * eta1 / (f - 448) ** 2 + 844.6 * eta1 / (f - 557) ** 2 * g(557)
    + 290 * eta1 / (f - 752) ** 2 * g(752) + 8.3328e4 * (0.735 * rp + 0.0353 * rho) / (f - 1780) ** 2 * g(1780)) * f * f * rho * 1e-4
  const now = p676.gammaWaterVapour(12, 1013.25, 9.97288878634, 288.15)
  ok('旧闭式 γw(12 GHz) 比逐线偏高 > 10%（已弃用）', old / now - 1 > 0.10, `${(100 * (old / now - 1)).toFixed(1)}%`)
}

// 瞬时口径包装（实时气象分支用）
{
  const z = lc.calculateAtmosphericAttenuation(20, undefined, 1005, 293, 12)
  ok('不给仰角 = 天顶（Annex 2 §1.1 + §2.1）', rel(z, p676.slantPathInstant(20, 90, 1005, 293, 12).A) < 1e-12, z.toFixed(4))
  ok('θ = 30° = Annex 2 瞬时法', rel(lc.calculateAtmosphericAttenuation(20, 30, 1005, 293, 12), p676.slantPathInstant(20, 30, 1005, 293, 12).A) < 1e-12)
  // 瞬时包装不知道柱水汽，分层廓线水汽标高取 P.835 的 2 km，与 Annex 2 方法 1 的 h_w 不是同一个假设，
  // 5° 两侧差得比引擎路径（廓线按 V(p)/ρ(p) 定标高，±5% 内）大；外加平地 1/sinθ 与球面路径之差。
  const a499 = lc.calculateAtmosphericAttenuation(20, 4.99, 1005, 293, 12), a5 = lc.calculateAtmosphericAttenuation(20, 5, 1005, 293, 12)
  ok('5° 两侧（分层射线 vs Annex 2）相差 < 15%', Math.abs(a499 / a5 - 1) < 0.15, `${a499.toFixed(3)} / ${a5.toFixed(3)} dB`)
  const a0 = lc.calculateAtmosphericAttenuation(20, 0, 1005, 293, 12), a2 = lc.calculateAtmosphericAttenuation(20, 2, 1005, 293, 12)
  ok('低仰角单调：0° > 2° > 4.99°', a0 > a2 && a2 > a499, `${a0.toFixed(2)} / ${a2.toFixed(2)} / ${a499.toFixed(2)} dB`)
}

// ② 引擎取值口径
{
  ok('p 档：晴空 0 → 50%，0.1 → 5%，4.99 → 5%，10 → 10%，100 → 99%',
    gs.gasProbability(0) === 50 && gs.gasProbability(0.1) === 5 && gs.gasProbability(4.99) === 5 && gs.gasProbability(10) === 10 && gs.gasProbability(100) === 99)

  // v2 未注入：瞬时法 1 兜底
  const fb = gs.gaseousAttenuationSite({ f: 20, el: 40, lat: 23.13, lon: 113.26, hsKm: 0.02, pPct: 0.1 })
  ok('P.836 v2 未注入 → 瞬时法 1 兜底', fb.method === 'annex2-inst' && fb.A > 0, `${fb.A.toFixed(3)} dB`)

  const BIN = join(ROOT, 'resources/itu/p836_v2.bin')
  if (existsSync(BIN)) {
    const b = readFileSync(BIN)
    wv.setDataV2(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
    const site = { f: 20, el: 40, lat: 23.13, lon: 113.26, hsKm: 0.02 }
    const at = (pPct, el) => gs.gaseousAttenuationSite(Object.assign({}, site, { pPct }, el === undefined ? {} : { el }))
    const r01 = at(0.1), r5 = at(5), r10 = at(10), r50 = at(50), rc = at(0)
    ok('θ ≥ 5° 走 Annex 2 统计法', r5.method === 'annex2-stat')
    ok('p < 5% 取 A_G(5%)（P.618-14 式 68）', r01.A === r5.A)
    ok('晴空（可用度 100%）取 50% 中值', rc.A === r50.A && rc.pGas === 50)
    ok('A_G 随 p 增大而减小（5% > 10% > 50%）', r5.A > r10.A && r10.A > r50.A, `${r5.A.toFixed(3)} / ${r10.A.toFixed(3)} / ${r50.A.toFixed(3)} dB`)
    ok('水汽项 = K_w·V(p)/sinθ', rel(r5.Aw, p676.waterVapourMassAbsorption(20, r5.P, r5.T, r5.rhoMean) * r5.V / Math.sin(40 * Math.PI / 180)) < 1e-12)
    const low = at(5, 3)
    ok('θ < 5° 走 Annex 1 分层射线', low.method === 'annex1-layered' && low.A > r5.A, `${low.A.toFixed(2)} dB @3°`)
    // 引擎路径的分层廓线按 V(p)/ρ(p) 定水汽标高，5° 两侧只剩平地 1/sinθ 与球面路径之差
    for (const p of [0, 5]) {
      const a = at(p, 4.999).A, b = at(p, 5).A
      ok(`引擎路径 5° 两侧相差 < 7%（p=${p}）`, Math.abs(a / b - 1) < 0.07, `${a.toFixed(3)} / ${b.toFixed(3)} dB`)
    }
    // 广州 Ka 20 GHz 晴空：旧口径（ρ90 干端）只有 ~0.41 dB @ 62.7°；新口径用 V(50%) 中值
    const geo = gs.gaseousAttenuationSite({ f: 20, el: 62.74, lat: 23.13, lon: 113.26, hsKm: 0.02, pPct: 0 })
    ok('广州 20 GHz 晴空气体衰减落在 0.6~1.2 dB（旧 ρ90 口径 0.41 dB 偏干）', geo.A > 0.6 && geo.A < 1.2, `${geo.A.toFixed(3)} dB`)
  } else {
    ok('p836_v2.bin 缺失（跳过统计法断言）', true)
  }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
