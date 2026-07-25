// 扫描期出参精度（引擎小数位增量 FX）测试。运行：npm test
//
// 背景：三个引擎的出参一律是 `数.toFixed(n)` 的**字符串**，故场值全被钉在 10⁻ⁿ 的格子上。
// 单点计算与报表要的正是这个定位数，但地理场图要的是场：跨度只有 0.3 dB 的场（上行 C/N
// 常如此）被 0.01 dB 的取整压成台阶，等值线只能沿格边走，画出来是一片直角阶梯。故扫描期间
// 由 linkSweep 把三个引擎的小数位临时抬 4 位（见各引擎文件头的 FX 与 linkSweep._precise）。
//
// 关键不变式：
//   ① 默认 FX=0——单点计算、报表、链路表逐位与从前完全相同，这是本机制敢动引擎的前提；
//   ② 扫描回来的场里检不出 0.01 的量化步、台阶比归零（那些直角阶梯就是被它压出来的）；
//   ③ 抬精度只是「少取一次整」，不是换了个模型——逐键与未抬精度的引擎相差不超过半个取整步；
//   ④ 增量绝不漏出扫描：扫描内部抛异常时也必须复位，否则界面上的数会跟着变成 6 位小数；
//   ⑤ 落地后渲染端的去量化兜底（lbContour.dequantize）自然不再触发（保留它兜旧数据）。
//
// 被测的 detectQuantum / terraceFrac 是渲染端 ESM，故本测试自身也是 .mjs；
// 引擎与扫描器是 CommonJS，用 createRequire 取。
import { createRequire } from 'node:module'
import { detectQuantum, terraceFrac, dequantize } from '../../../src/shared/lbContour.js'

const require = createRequire(import.meta.url)
const { sweepLink2D } = require('../utils/linkSweep.js')
const modeSolver = require('../utils/modeSolver.js')
const geo = require('../utils/linkCalculator.js')
const ngso = require('../utils/linkCalculatorNGSO.js')
const regen = require('../utils/linkCalculatorRegen.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
// 引擎每算一次都打印一整份入参与结果；本测试要跑上千次，不静音会淹掉 PASS/FAIL
function quiet(fn) {
  const log = console.log, info = console.info, debug = console.debug
  const noop = () => {}
  console.log = noop; console.info = noop; console.debug = noop
  try { return fn() } finally { console.log = log; console.info = info; console.debug = debug }
}
// 字符串出参的小数位数（"12.99"→2、"35786"→0）
const decimals = (s) => { const i = String(s).indexOf('.'); return i < 0 ? 0 : String(s).length - i - 1 }

console.log('=== 扫描期出参精度（引擎小数位增量）测试 ===\n')

const SAT = { frequencyBand: 'Ku', satelliteName: 'DEMO' }
const N = 21

// ① 默认不抬精度：单点计算的位数与从前逐字相同
{
  const d = quiet(() => geo.calculateLinkBudget(SAT, {}).data)
  ok('默认 GEO 出参仍是 2 位小数', d.uplinkCN === '12.99' && d.downlinkCN === '12.84', `${d.uplinkCN} / ${d.downlinkCN}`)
  ok('默认 GEO 三位量仍是 3 位小数', decimals(d.PowerBWResult) === 3, d.PowerBWResult)
  ok('默认 GEO 可用度仍是 5 位小数', decimals(d.systemAvailabilityResult) === 5, d.systemAvailabilityResult)
  ok('三个引擎都给出了增量开关', [geo, ngso, regen].every((m) => typeof m.setOutputPrecisionBoost === 'function'))
}

// ② 扫描期间：密采样的场不再有量化台阶
//
// 这张就是把「引擎给未取整的数」立起来的那张场——站址地理平面（收发同站）+ 联动重取雨/海拔。
// 区间取 2°×2°：工作点恒定钉在当前链路上（见 linkSweep._pinnedOpt）之后，站址平面上的 C/N
// 随区间线性铺开——30°×30° 铺出 6.5 dB、格间距 0.3 dB，0.01 的取整根本压不出台阶（实测同值
// 率仅 2.4%）；缩到 2°×2° 才回到「跨度半 dB 上下、格间距远小于取整步」的密采样区间，同值率
// 47%，等值线一片直角阶梯——那正是这套增量要治的病，也正是用户放大看细节时面对的那张图。
const GEO_PLANE = {
  engine: 'geo', satParams: SAT, linkParams: {}, autoGeo: true,
  opt: { mode: 'margin' },
  x: { key: 'longitude', target: 'link', min: 110, max: 112, steps: N },
  y: { key: 'latitude', target: 'link', min: 30, max: 32, steps: N }
}
{
  const r = sweepLink2D(GEO_PLANE)
  ok('21×21 站址平面全算通', r.ok === N * N && r.fail === 0, `ok=${r.ok} fail=${r.fail}`)

  const z = r.series.uplinkCN
  const ext = (() => { let lo = Infinity, hi = -Infinity; for (const v of z) if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v } return hi - lo })()
  // 前提：这确实是一张对取整敏感的场——按老口径取整到 0.01 dB 就会压出大片台阶，否则本项
  // 测的就不是取整了。判据直接验「取整后台阶比」，不再拿「跨度不足半 dB」当代理：跨度多大
  // 取决于扫的区间，真正决定有没有阶梯的是格间距与取整步的比值。
  const rounded = Float64Array.from(z, (v) => (v === v ? Math.round(v * 100) / 100 : NaN))
  const tf0 = terraceFrac(rounded, r.nx, r.ny)
  ok('这张场按 0.01 取整会压出台阶（否则下面两项测不到东西）', tf0 > 0.2,
    `跨度 ${ext.toFixed(4)} dB，取整后台阶比 ${(tf0 * 100).toFixed(1)}%`)

  const det = detectQuantum(z)
  ok('检不出 0.01 的量化步', det === null || det.q <= 1e-6, det ? `q=${det.q.toExponential(0)}` : 'q=null')
  const tf = terraceFrac(z, r.nx, r.ny)
  ok('台阶比归零', tf < 1e-9, `${(tf * 100).toFixed(1)}%`)
  ok('渲染端去量化不再触发', !dequantize(z, r.nx, r.ny).applied)

  // 余量方式下上下行 C/N 都是这类小跨度场，一并验
  const zd = r.series.downlinkCN
  const detD = detectQuantum(zd)
  ok('下行 C/N 同样检不出 0.01 量化步', detD === null || detD.q <= 1e-6, detD ? `q=${detD.q.toExponential(0)}` : 'q=null')
  ok('下行 C/N 台阶比归零', terraceFrac(zd, r.nx, r.ny) < 1e-9)
}

// ②' NGSO 与再生式走各自的引擎（再生式的功率链还来自 NGSO 引擎），三处增量必须都生效——
// 各扫一张场验一遍，免得日后只改了 GEO 一处、另两个体制的图仍是阶梯却没人发现。
//
// 这里不走站址平面：NGSO 的站星几何是前端解算后注入的，扫经纬度时只有雨/海拔在动，而这两个
// 都是**格点数据**（相邻格常查到同一个值），由此产生的同值是入参本来就相同，与取整无关。
// 改扫「口径 × 降雨率」——两根轴都连续地进上行功率链，场里若还剩同值就只可能是取整。
{
  const NGSO_LINK = {
    centerFrequency: '14.25', rxCenterFrequency: '12.5', uplinkPolarization: 'V',
    longitude: '113.26', latitude: '23.13', rxLongitude: '113.26', rxLatitude: '23.13',
    distanceMode: 'altitude', orbitAltitude: '1200', rxOrbitAltitude: '1200',
    minElevation: '25', rxMinElevation: '25',
    uplinkAvailability: '99.9', rxDownlinkAvailability: '99.9', margin: '3'
  }
  const AXES = {
    opt: { mode: 'power', powerW: 200 },   // 功放定死，上行 C/N 才随口径与雨强真正地变
    x: { key: 'antennaDiameter', target: 'link', min: 1.2, max: 9.2, steps: N },
    y: { key: 'rainRate', target: 'link', min: 10, max: 60, steps: N }
  }
  for (const [name, engine] of [['NGSO', 'ngso'], ['再生式上行', 'regen-up']]) {
    const r = sweepLink2D(Object.assign({ engine, satParams: { frequencyBand: 'Ku' }, linkParams: NGSO_LINK }, AXES))
    const z = r.series.uplinkCN
    if (!z) { ok(`${name} 扫得出上行 C/N 场`, false, r.message || '无此场'); continue }
    ok(`${name} 21×21 全算通`, r.ok === N * N && r.fail === 0, `ok=${r.ok} fail=${r.fail}${r.message ? ' ' + r.message : ''}`)
    let lo = Infinity, hi = -Infinity
    for (const v of z) if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v }
    ok(`${name} 上行 C/N 确实在变（否则下面两项测不到东西）`, hi - lo > 0.1, `跨度 ${(hi - lo).toFixed(3)} dB`)
    const det = detectQuantum(z)
    ok(`${name} 检不出 0.01 的量化步`, det === null || det.q <= 1e-6, det ? `q=${det.q.toExponential(0)}` : 'q=null')
    const tf = terraceFrac(z, r.nx, r.ny)
    ok(`${name} 台阶比归零`, tf < 1e-9, `${(tf * 100).toFixed(1)}%`)
  }
}

// ③ 抬精度不改模型：逐键与「未抬精度的引擎」相差不超过半个取整步
//
// 走「目标余量」轴——本模块唯一不钉工作点的轴（forceMode='margin'，见 linkSweep）。这不是
// 图省事，是这项测试成立的前提：设置余量方式下 modeSolver 不回读任何出参，两边的唯一差别
// 才只剩「出参取不取整」这一件事，差值超过半步就说明改动动了计算。换成钉住的轴就不再纯净——
// 钉住把计算方式换成「设置功放功率」，而它要回读 paRecommendationdBResult 反推余量（见
// modeSolver.findMarginByPower），参照那次读到的是 3 位小数的取整值，扫描那次读到的是 7 位，
// ±0.0005 dB 的余量差经 10^(m/10) 放大后在 PowerBWResult 上就是几百个半步（实测最差 369）。
// 那是取整本身的误差，恰恰说明这套增量有用，拿它当「模型变没变」的判据只会误报。
// y 轴取口径（不联动雨/海拔），故每格入参可原样复现。
{
  const AX = { key: '_margin', min: 0, max: 6, steps: 9 }
  const AY = { key: 'rxAntennaDiameter', target: 'link', min: 1.2, max: 9.2, steps: 5 }
  const r = sweepLink2D({ engine: 'geo', satParams: SAT, linkParams: {}, opt: { mode: 'margin' }, x: AX, y: AY })
  ok('目标余量轴确实没钉工作点（本项的前提）', r.pin === null, `pin=${JSON.stringify(r.pin)}`)

  let worstRatio = 0, worstKey = '', checked = 0, missing = 0
  quiet(() => {
    for (let j = 0; j < r.ny; j++) {
      for (let i = 0; i < r.nx; i++) {
        // 未抬精度的同一格：直接走求解器（此时 FX=0，出参就是从前那份取整过的字符串）
        const ref = modeSolver.computeLinkMode(
          Object.assign({}, SAT),
          { margin: String(r.xs[i]), rxAntennaDiameter: String(r.ys[j]) },
          { mode: 'margin' }
        )
        if (!ref || !ref.success) { missing++; continue }
        for (const k of Object.keys(r.series)) {
          const s = r.series[k][j * r.nx + i]
          const raw = ref.data[k]
          if (s !== s || typeof raw !== 'string' || raw === '' || raw === '-') continue
          const ref0 = parseFloat(raw)
          if (!Number.isFinite(ref0)) continue
          const half = 0.5 * Math.pow(10, -decimals(raw))
          const ratio = Math.abs(s - ref0) / half
          checked++
          if (ratio > worstRatio) { worstRatio = ratio; worstKey = k }
        }
      }
    }
  })
  ok('参照点全部算通', missing === 0, `缺 ${missing} 格`)
  ok('比对覆盖到足够多的出参', checked > 2000, `${checked} 项`)
  // 1 + 1e-9：toFixed 的十进制串转回双精度会差几个 ulp，恰好压在半步上的值不该因此判负
  ok('逐键都在半个取整步以内（模型未变）', worstRatio <= 1 + 1e-9, `最差 ${worstRatio.toFixed(4)} 个半步 @ ${worstKey || '-'}`)
}

// ④ 增量绝不漏出扫描：内部抛异常也必须复位
//
// 造一个「取值即抛」的入参：linkSweep 逐格 Object.assign 复制卫星侧入参时触发，
// 这一步不在任何 try/catch 里，异常会一路穿过 _precise ——正是 try/finally 要挡的那种情形。
{
  const boom = { frequencyBand: 'Ku', get satelliteName() { throw new Error('构造的取值异常') } }
  let threw = false
  try {
    quiet(() => sweepLink2D({
      engine: 'geo', satParams: boom, linkParams: {}, opt: { mode: 'margin' },
      x: { key: 'antennaDiameter', target: 'link', min: 1.2, max: 9.2, steps: 3 },
      y: { key: 'rxAntennaDiameter', target: 'link', min: 1.2, max: 9.2, steps: 3 }
    }))
  } catch (e) { threw = true }
  ok('构造的异常确实穿出了扫描（否则本项测不到东西）', threw)

  const d = quiet(() => geo.calculateLinkBudget(SAT, {}).data)
  ok('异常之后 GEO 已复位到 2 位小数', d.uplinkCN === '12.99', d.uplinkCN)
  // setOutputPrecisionBoost 返回改动前的值：置 0 时回来的若不是 0，就说明增量漏在了外面
  const left = [geo, ngso, regen].map((m) => m.setOutputPrecisionBoost(0))
  ok('异常之后三个引擎的增量都已归零', left.every((v) => v === 0), `[${left.join(', ')}]`)
}

// ⑤ 正常扫描结束后同样复位（不是只有异常路径才管）
{
  quiet(() => sweepLink2D(GEO_PLANE))
  const d = quiet(() => geo.calculateLinkBudget(SAT, {}).data)
  ok('扫描结束后单点计算仍是 2 位小数', d.uplinkCN === '12.99' && d.linkmargin === '3.00', `${d.uplinkCN} / ${d.linkmargin}`)
  ok('扫描结束后瓦数仍是 3 位小数', decimals(d.paRecommendation) === 3, d.paRecommendation)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
