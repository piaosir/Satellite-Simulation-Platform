// RR Art.21 Table 21-4（RR 2024，Rev.WRC-23）查表与两引擎接线自测。运行：node packages/core/test/art21Table.test.mjs
//
// 数据 packages/core/utils/itu/art21Table214.json 从 RR 2024 Vol.1 官方 PDF 逐行抽取（来源与 SHA-256 见其 meta），
// 抽完逐格对过两份独立抽取（pdfplumber 线框单元格、pypdf 文本）。本测试是第三道：
//   ① 表结构：分段首尾相接、0°–90° 全覆盖、参考带宽只有 4 kHz / 1 MHz / 1.5 MHz 三种、相邻段连续（9.9-10.4 GHz 原表即不连续，除外）；
//   ② 每段的结构化系数 ⇔ 同一段的原文抄录（cells）逐点相等——两种写法互证，防结构化时抄错系数；
//   ③ 每行的 δ 分段端点：期望值由本文件按 RR 原文另行手算（第三次转录，不读 JSON）；
//   ④ X（No.21.16.6，WRC-23）/ Y（No.21.16.15）各分支与缺参；
//   ⑤ RR 无限值的频段返回 null（含旧 if 链编造的 11.7-12.2 / 19.7-21.2 GHz）；区域 / 国家限定；
//   ⑥ 引擎集成：Ku 10.7-11.7 GSO、C 3.4-4.2 GSO 与 NGSO、Ka 17.7-19.3 NGSO、19.7-20.2 无限值、Q 37.5-40 GSO；
//      外部参照为 D 路脚本 art21diff.js（RR 2024 Table 21-4 的 X / Ka NGSO / Q·V GSO 公式），见 ⑦。
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const A = require('../utils/itu/art21.js')
const R = require('../utils/itu/ituRegion.js')
const core = require('../index.js')
const wf = require('../utils/waterfallBuilder.js')
const regen = require('../utils/linkCalculatorRegen.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, tol = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol
const lg = Math.log10
const T = A.TABLE

// —— ① 表结构 ——
{
  const ids = T.rows.map((r) => r.id)
  ok('行号唯一', new Set(ids).size === ids.length, ids.length + ' 行')
  ok('39 个条目（38 印刷行，17.7-19.3 GHz 两个备选拆成 20a / 20b）', T.rows.length === 39)
  const SVC = new Set(['FSS', 'MSS', 'BSS', 'RDSS', 'ISS', 'MetSat', 'EESS', 'EESS-active', 'SR', 'SO'])
  const BW = new Set([4000, 1000000, 1500000])
  const bad = []
  for (const r of T.rows) {
    if (!r.bands.length || r.bands.some((b) => !(b.lowMHz < b.highMHz))) bad.push(r.id + ' 频段')
    if (r.services.some((s) => !SVC.has(s))) bad.push(r.id + ' 业务')
    if (!(r.orbit === null || r.orbit === 'GSO' || r.orbit === 'NGSO')) bad.push(r.id + ' 轨道')
    for (const L of r.limits) {
      if (!BW.has(L.refBwHz)) bad.push(r.id + ' 参考带宽')
      const s = L.segments
      if (s[0].from !== 0 || s[s.length - 1].to !== 90) bad.push(r.id + ' 未覆盖 0–90°')
      for (let i = 1; i < s.length; i++) if (s[i].from !== s[i - 1].to) bad.push(r.id + ' 段不相接 @' + s[i].from)
      if (L.cells.length !== s.length) bad.push(r.id + ' cells 与段数不符')
      for (const sg of s) for (const n of sg.notes || []) if (!T.footnotes[n]) bad.push(r.id + ' 未知脚注 ' + n)
    }
    for (const n of r.footnotes || []) if (!T.footnotes[n]) bad.push(r.id + ' 未知脚注 ' + n)
  }
  ok('频段 / 业务 / 轨道 / 参考带宽 / 分段 / 脚注引用全部合法', bad.length === 0, bad.join('; '))
  // 相邻段连续（含 X、Y 取若干值）
  const disc = []
  for (const r of T.rows) for (const L of r.limits) {
    for (let i = 1; i < L.segments.length; i++) {
      const d = L.segments[i].from
      for (const F of [0, 3, 10, 20.3, 25]) {
        const a = A.evalSegment(L.segments[i - 1], d, F), b = A.evalSegment(L.segments[i], d, F)
        if (Math.abs(a - b) > 0.05) disc.push(`${r.id}@${d}°(F=${F}) ${a.toFixed(3)}→${b.toFixed(3)}`)
      }
    }
  }
  const allowed = disc.filter((s) => !s.startsWith('T21-4.13'))
  ok('相邻段连续（≤0.05 dB；9 900-10 400 MHz 原表 5.7° 与 53° 两处本不连续）', allowed.length === 0, allowed.join('; '))
  ok('9 900-10 400 MHz 的不连续如原表：53° 处 −66.97 → −66.6', disc.some((s) => s.startsWith('T21-4.13@53')))
}

// —— ② 结构化系数 ⇔ 原文抄录 ——
{
  // 原文记法 → JS：δ→d、log→lg、隐式乘号补齐（0.5(δ − 5)、(8/9)(δ − 3)、0.4δ、20 log δ、(12 + Y)(δ − 5)/20）
  const toFn = (cell) => {
    let s = cell.replace(/\(value based.*\)$/, '').replace(/−/g, '-').replace(/δ/g, 'd')
      .replace(/log\s*\(/g, 'L(').replace(/log\s+d/g, 'L(d)')
    s = s.replace(/(\d|\))\s*(\(|d|X|Y|L)/g, '$1*$2')
    return new Function('d', 'X', 'Y', 'L', 'return ' + s)
  }
  const bad = []
  for (const r of T.rows) for (const L of r.limits) L.segments.forEach((sg, k) => {
    const f = toFn(L.cells[k])
    for (const t of [0.001, 0.25, 0.5, 0.75, 1]) {
      const d = sg.from + (sg.to - sg.from) * t
      for (const F of [0, 7.3, 20.3]) {
        const want = f(d, F, F, lg), got = A.evalSegment(sg, d, F)
        if (!near(got, want, 1e-9)) bad.push(`${r.id} ${L.cells[k]} @${d.toFixed(2)} F=${F}: ${got} ≠ ${want}`)
      }
    }
  })
  ok('每段结构化系数与原文抄录逐点一致', bad.length === 0, bad.slice(0, 4).join('; '))
}

// —— ③ 每行 δ 分段端点（期望值按 RR 原文手算）——
{
  const BJ = { latDeg: 39.9, lonDeg: 116.4 }, PARIS = { latDeg: 48.85, lonDeg: 2.35 }, CAIRO = { latDeg: 30.04, lonDeg: 31.24 }, NY = { latDeg: 40.7, lonDeg: -74 }
  const LEO = { orbit: 'NGSO', apogeeKm: 550, inclinationDeg: 53 }, HIO = { orbit: 'NGSO', apogeeKm: 39000, inclinationDeg: 63.4 }
  // [行, f GHz, ctx, 参考带宽 Hz, [[δ, 限值]…], limits 下标]
  const CASES = [
    ['T21-4.01', 1.68, { service: 'MetSat' }, 1500000, [[0, -133], [45, -133], [90, -133]]],
    ['T21-4.02', 1.52, { service: 'MSS', region: 2, country: 'USA', lonDeg: -100 }, 4000,
      [[0, -181], [4, -181], [10, -173], [20, -193 + 20 * lg(20)], [40, -213.3 + 35.6 * lg(40)], [60, -213.3 + 35.6 * lg(60)], [61, -150], [90, -150]]],
    ['T21-4.03', 1.52, { service: 'MSS', region: 2, country: 'USA', lonDeg: -150 }, 4000,
      [[0, -155], [43.4, -155], [50, -213.3 + 35.6 * lg(50)], [60, -213.3 + 35.6 * lg(60)], [90, -150]]],
    ['T21-4.04', 2.05, { service: 'SR' }, 4000, [[0, -154], [5, -154], [15, -149], [25, -144], [90, -144]]],
    ['T21-4.05', 2.6, { orbit: 'GSO' }, 1000000, [[0, -136], [5, -136], [15, -130.5], [25, -125], [90, -125]]],
    ['T21-4.06', 3.95, { orbit: 'GSO', ...BJ }, 4000, [[0, -152], [5, -152], [15, -147], [25, -142], [90, -142]]],
    ['T21-4.07', 3.95, { ...LEO, NN: 1, NS: 2 }, 1000000, [[0, -138], [5, -138], [15, -132], [25, -126], [90, -126]]],
    ['T21-4.07', 3.95, { ...LEO, NN: 10, NS: 4 }, 1000000, [[0, -143], [5, -143], [15, -134.5], [25, -126]]],
    ['T21-4.08', 4.6, { orbit: 'GSO' }, 4000, [[0, -152], [15, -147], [25, -142]]],
    ['T21-4.08', 7.5, { orbit: 'GSO' }, 4000, [[0, -152], [15, -147], [25, -142]]],
    ['T21-4.09', 5.2, { orbit: 'GSO' }, 4000, [[0, -164], [45, -164], [90, -164]]],
    ['T21-4.10', 6.75, { orbit: 'GSO' }, 1000000, [[0, -137], [15, -132], [25, -127], [90, -127]]],
    ['T21-4.11', 6.9, { orbit: 'GSO' }, 4000, [[0, -154], [15, -149], [25, -144]], 0],
    ['T21-4.11', 6.9, { orbit: 'GSO' }, 1000000, [[0, -134], [15, -129], [25, -124]], 1],
    ['T21-4.12', 8.2, { service: 'EESS' }, 4000, [[0, -150], [15, -145], [25, -140]]],
    ['T21-4.13', 10.0, { service: 'EESS-active' }, 1000000,
      [[0, -113], [5.7, -113], [6, -109], [10, -109 + 25 * lg(5)], [53, -109 + 25 * lg(48)], [60, -66.6], [90, -66.6]]],
    ['T21-4.14', 11.2, { orbit: 'GSO', ...BJ }, 4000, [[0, -150], [5, -150], [15, -145], [25, -140], [90, -140]]],
    ['T21-4.15', 11.2, { ...LEO, ...BJ }, 1000000, [[0, -126], [15, -121], [25, -116]]],
    ['T21-4.16', 11.2, { ...HIO, ...BJ }, 1000000, [[0, -129], [15, -121.5], [25, -114], [90, -114]]],
    ['T21-4.16', 12.6, { ...HIO, ...NY }, 1000000, [[0, -129]]],
    ['T21-4.16', 12.72, { ...HIO, ...BJ }, 1000000, [[0, -129]]],
    ['T21-4.17', 12.2, { ...LEO, ...PARIS }, 1000000, [[0, -124], [15, -119], [25, -114]]],
    ['T21-4.17', 12.6, { ...LEO, ...CAIRO }, 1000000, [[0, -124]]],
    ['T21-4.17', 12.6, { ...LEO, ...NY }, 1000000, [[0, -124]]],
    ['T21-4.17', 12.72, { ...LEO, ...BJ }, 1000000, [[0, -124]]],
    ['T21-4.18', 12.5, { orbit: 'GSO', ...BJ }, 4000, [[0, -148], [5, -148], [15, -143], [25, -138], [90, -138]]],
    ['T21-4.18', 12.6, { orbit: 'GSO', ...CAIRO }, 4000, [[10, -145.5]]],
    ['T21-4.19', 13.5, { orbit: 'GSO', ...PARIS }, 4000,
      [[0, -159], [10, -155], [25, -149], [50, -149], [80, -149], [82, -150], [84, -151], [90, -151]]],
    ['T21-4.20a', 18.5, { orbit: 'GSO', ...BJ }, 1000000, [[0, -115], [5, -115], [15, -110], [25, -105], [90, -105]]],
    ['T21-4.20a', 18.0, { service: 'MetSat' }, 1000000, [[0, -115], [25, -105]]],
    ['T21-4.20a', 19.0, { ...LEO, pre1995: true }, 1000000, [[0, -115], [15, -110]]],
    ['T21-4.20a', 18.0, { ...HIO, res147: true }, 1000000, [[0, -115], [15, -110]]],
    ['T21-4.20b', 18.5, { ...LEO, N: 1000, Nv: 40 }, 1000000, [[0, -135.3], [5, -135.3], [15, -120.15], [25, -105], [90, -105]]],
    ['T21-4.20b', 18.5, { ...LEO, N: 10 }, 1000000, [[0, -115], [15, -110], [25, -105]]],
    ['T21-4.20b', 18.5, { ...LEO, N: 7000, Nv: 60 }, 1000000, [[0, -115 - (10 * lg(60) + 1)]]],
    ['T21-4.20b', 19.0, { ...LEO, N: 10 }, 1000000, [[0, -115]]],
    ['T21-4.21', 18.5, { ...HIO }, 1000000, [[0, -120], [3, -120], [7.5, -116], [12, -112], [18.5, -108.5], [25, -105], [90, -105]]],
    ['T21-4.22', 19.5, { ...HIO }, 1000000, [[0, -120], [7.5, -116], [12, -112], [25, -105]]],
    ['T21-4.23', 19.5, { orbit: 'GSO', ...BJ }, 1000000, [[0, -115], [15, -110], [25, -105]]],
    ['T21-4.23', 19.5, { ...LEO, ...BJ }, 1000000, [[0, -115]]],
    ['T21-4.23', 19.5, { ...HIO, res147: true }, 1000000, [[0, -115]]],
    ['T21-4.23', 21.7, { service: 'BSS', orbit: 'GSO', ...BJ }, 1000000, [[0, -115], [25, -105]]],
    ['T21-4.24', 27.5005, { orbit: 'GSO' }, 1000000, [[0, -115], [15, -110], [25, -105]]],
    ['T21-4.25', 28.0, { service: 'ISS', orbit: 'NGSO' }, 1000000, [[0, -120], [15, -115], [25, -110]]],
    ['T21-4.26', 31.1, { service: 'SR' }, 1000000, [[0, -115], [15, -110], [25, -105]]],
    ['T21-4.26', 35.0, { service: 'SR', country: 'EGY' }, 1000000, [[0, -115]]],
    ['T21-4.27', 32.0, { service: 'SR' }, 1000000, [[0, -120], [15, -112.5], [25, -105]]],
    ['T21-4.28', 32.5, { service: 'ISS' }, 1000000, [[0, -135], [15, -125], [25, -115]]],
    ['T21-4.29', 37.3, { service: 'SR', orbit: 'NGSO' }, 1000000, [[0, -120], [15, -112.5], [25, -105]]],
    ['T21-4.30', 37.3, { service: 'SR', orbit: 'GSO' }, 1000000, [[0, -125], [15, -115], [25, -105]]],
    ['T21-4.31', 38.5, { ...LEO, N: 50 }, 1000000, [[0, -120], [15, -112.5], [25, -105]]],
    ['T21-4.31', 38.5, { ...LEO, N: 99 }, 1000000, [[0, -120]]],
    ['T21-4.32', 38.5, { orbit: 'GSO', ...BJ }, 1000000,
      [[0, -127], [5, -127], [12.5, -117], [20, -107], [22.5, -106], [25, -105], [90, -105]]],
    ['T21-4.33', 40.2, { orbit: 'GSO' }, 1000000, [[0, -115], [15, -110], [25, -105]]],
    ['T21-4.33', 40.2, { ...LEO }, 1000000, [[0, -115]]],
    ['T21-4.34', 41.0, { ...LEO, N: 10 }, 1000000, [[0, -115], [15, -110], [25, -105]]],
    ['T21-4.35', 41.0, { orbit: 'GSO', ...BJ }, 1000000,
      [[0, -120], [5, -120], [10, -115], [15, -110], [20, -107.5], [25, -105], [90, -105]]],
    ['T21-4.36', 42.2, { ...LEO, N: 10 }, 1000000, [[0, -120], [15, -112.5], [25, -105]]],
    ['T21-4.37', 42.2, { orbit: 'GSO', ...BJ }, 1000000,
      [[0, -127], [5, -127], [12.5, -117], [20, -107], [22.5, -106], [25, -105], [90, -105]]],
    ['T21-4.38', 47.7, { orbit: 'GSO', ...PARIS }, 1000000, [[0, -115], [15, -110], [25, -105]]],
    ['T21-4.38', 48.3, { orbit: 'GSO', ...PARIS }, 1000000, [[0, -115]]],
    ['T21-4.38', 49.8, { orbit: 'GSO', ...PARIS }, 1000000, [[0, -115]]]
  ]
  const covered = new Set()
  for (const [id, f, ctx, bw, pts, li] of CASES) {
    const bad = []
    for (const [d, want] of pts) {
      const r = A.limitAt(f, d, ctx)
      const L = r && (li !== undefined ? r.limits[li] : r)
      const got = L && L.limit
      if (!r || r.missing.length || !L || L.rowId !== id && r.rowId !== id || L.refBwHz !== bw || !near(got, want, 1e-6)) {
        bad.push(`δ=${d}: ${r ? `${r.rowId}/${L && L.refBwHz}/${got}/miss=${r.missing}` : 'null'} ≠ ${id}/${bw}/${want}`)
      }
    }
    covered.add(id)
    ok(`${id} ${f} GHz ${JSON.stringify(ctx).slice(0, 60)}：分段端点`, bad.length === 0, bad.slice(0, 3).join('; '))
  }
  const all = T.rows.map((r) => r.id).filter((id) => !covered.has(id))
  ok('Table 21-4 每一行都有端点用例', all.length === 0, all.join(' '))
}

// —— ④ X / Y 各分支 ——
{
  const X = (N, Nv) => A.X(N, Nv)
  ok('X: N ≤ 50 → 0', X(0).value === 0 && X(50).value === 0)
  ok('X: 50 < N ≤ 288 → (5/119)(N−50)', near(X(51).value, 5 / 119) && near(X(288).value, 10))
  ok('X: 288 < N ≤ 999 → (1/69)(N+402)', near(X(289).value, 691 / 69) && near(X(999).value, 1401 / 69))
  ok('X: 1000 ≤ N ≤ 6000 → max{20.3; 10lg Nv}', near(X(1000, 40).value, 20.3) && near(X(6000, 200).value, 10 * lg(200)))
  ok('X: N > 6000 → 10lg Nv + 1', near(X(6001, 100).value, 21) && near(X(30000, 60).value, 10 * lg(60) + 1))
  ok('X: 缺 N → missing N', X(undefined).value === null && X('').missing[0] === 'N')
  ok('X: N ≥ 1000 缺 Nv → missing Nv（N ≤ 999 不需要 Nv）', X(1000).missing[0] === 'Nv' && X(999).value !== null)
  ok('X 与 D 路 art21diff.js 的 X 逐点一致', [[10, 3], [100, 8], [288, 10], [600, 20], [1000, 40], [3000, 150], [7000, 60]].every(([N, Nv]) => {
    const ref = N <= 50 ? 0 : N <= 288 ? (5 / 119) * (N - 50) : N <= 999 ? (1 / 69) * (N + 402) : N <= 6000 ? Math.max(20.3, 10 * lg(Nv)) : 10 * lg(Nv) + 1
    return near(X(N, Nv).value, ref)
  }))
  ok('Y: max(NN,NS) ≤ 2 → 0', A.Y(0, 0).value === 0 && A.Y(2, 1).value === 0)
  ok('Y: > 2 → 5 lg max', near(A.Y(3, 1).value, 5 * lg(3)) && near(A.Y(4, 10).value, 5))
  ok('Y: NcoMax 直接给', near(A.Y(undefined, undefined, 100).value, 10))
  ok('Y: 缺 NN / NS → missing', A.Y(3).missing.join() === 'NS' && A.Y().missing.join() === 'NN,NS')
}

// —— ⑤ RR 无限值 → null；区域 / 国家 / 缺参语义 ——
{
  const BJ = { latDeg: 39.9, lonDeg: 116.4 }
  const nul = (f, d, ctx) => A.limitAt(f, d, ctx) === null
  ok('19.7-20.2 GHz GSO FSS（中星 16/19/26 Ka 用户下行）：RR 无限值 → null', nul(19.8, 30, { orbit: 'GSO', ...BJ }) && nul(20.0, 10, { orbit: 'GSO', ...BJ }) && nul(20.19, 45, { orbit: 'GSO', ...BJ }))
  ok('20.2-21.2 GHz：null（旧 if 链编造的 19.7-21.2 行）', nul(20.7, 30, { orbit: 'GSO', ...BJ }) && nul(20.7, 30, { orbit: 'NGSO', apogeeKm: 550, ...BJ }))
  ok('11.7-12.2 GHz GSO（Region 3 北京）：null（旧 if 链编造的行）', nul(12.0, 30, { orbit: 'GSO', ...BJ }))
  ok('12.2-12.7 GHz GSO Region 2（纽约）：null', nul(12.3, 30, { orbit: 'GSO', latDeg: 40.7, lonDeg: -74 }))
  ok('12.5-12.75 GHz GSO Region 1 未列入 5.494/5.496（巴黎）：null', nul(12.6, 30, { orbit: 'GSO', latDeg: 48.85, lonDeg: 2.35 }))
  ok('12.2-12.5 GHz GSO Region 1 已列入国家（开罗）：null（列入国家只在 12.5-12.75）', nul(12.3, 30, { orbit: 'GSO', latDeg: 30.04, lonDeg: 31.24 }))
  ok('13.4-13.65 GHz GSO Region 3：null（只 Region 1）', nul(13.5, 30, { orbit: 'GSO', ...BJ }))
  ok('表外频段（14.25 / 30 / 13 / 1.2 GHz）：null，不再按量级外推', [14.25, 30, 13.0, 1.2].every((f) => nul(f, 30, { orbit: 'GSO', ...BJ })))
  ok('Q/V 频段 NGSO N ≥ 100：No.21.16.4 只管 ≤ 99 颗 → null', nul(38.5, 10, { orbit: 'NGSO', apogeeKm: 1200, N: 100 }) && nul(42.2, 10, { orbit: 'NGSO', apogeeKm: 1200, N: 3000 }))
  ok('47.9-48.2 GHz（Region 1 三段之间的缝）：null', nul(48.0, 30, { orbit: 'GSO', latDeg: 48.85, lonDeg: 2.35 }))
  ok('27.5-30 GHz 只有 NGSO 星间行：GSO FSS 上行频段 null', nul(28.5, 30, { orbit: 'GSO', ...BJ }))
  const m1 = A.limitAt(18.5, 10, { orbit: 'NGSO', apogeeKm: 550 })
  ok('Ka NGSO 缺 N：limit = null、missing = [N]、仍给出所在行与参考带宽', m1 && m1.limit === null && m1.missing.join() === 'N' && m1.rowId === 'T21-4.20b' && m1.refBwHz === 1e6)
  const m2 = A.limitAt(18.5, 10, { orbit: 'NGSO', apogeeKm: 550, N: 2000 })
  ok('Ka NGSO N ≥ 1000 缺 Nv：missing = [Nv]', m2 && m2.limit === null && m2.missing.join() === 'Nv')
  const m3 = A.limitAt(11.2, 10, { orbit: 'NGSO' })
  ok('Ku NGSO 缺轨道（判不了高倾角）：missing = [hio]', m3 && m3.limit === null && m3.missing.includes('hio'))
  const m4 = A.limitAt(12.5, 10, { orbit: 'GSO' })
  ok('12.5 GHz GSO 无经纬度：missing = [region]', m4 && m4.limit === null && m4.missing.join() === 'region')
  ok('C 频段 NGSO 缺 NN/NS：missing', A.limitAt(3.9, 10, { orbit: 'NGSO', apogeeKm: 550 }).missing.join() === 'NN,NS')
  ok('高倾角判定：远地点 ≤ 18 000 km 一律非高倾角（不需要倾角）', A.limitAt(11.2, 10, { orbit: 'NGSO', apogeeKm: 18000 }).rowId === 'T21-4.15')
  ok('高倾角判定：远地点 > 18 000 km 且倾角 35°–145°', A.limitAt(11.2, 10, { orbit: 'NGSO', apogeeKm: 20000, inclinationDeg: 145 }).rowId === 'T21-4.16'
    && A.limitAt(11.2, 10, { orbit: 'NGSO', apogeeKm: 20000, inclinationDeg: 30 }).rowId === 'T21-4.15')
  const add = A.limitAt(18.7, 30, { orbit: 'GSO', ...BJ })
  ok('18.6-18.8 GHz 附带 No.21.16.2 的 200 MHz 附加限值', add.additional.length === 1 && add.additional[0].limit === -95 && add.additional[0].refBwHz === 2e8)
  ok('6 825-7 075 MHz 两组限值同时返回（4 kHz 与 1 MHz）', A.limitAt(6.9, 10, { orbit: 'GSO' }).limits.map((l) => l.refBwHz).join() === '4000,1000000')
  ok('频段分界恰在两行上：两行都算（11.7 GHz NGSO 北京 = 10.7-11.7 与 11.7-12.75 R3）', A.limitAt(11.7, 10, { orbit: 'NGSO', apogeeKm: 550, ...BJ }).limits.map((l) => l.rowId).join() === 'T21-4.15,T21-4.17')
  ok('脚注：10.7-11.7 GHz NGSO 带 21.16.18；高倾角行带 21.16.17 与 21.16.16', A.limitAt(11.2, 10, { orbit: 'NGSO', apogeeKm: 550 }).footnotes.includes('21.16.18')
    && ['21.16.17', '21.16.16'].every((n) => A.limitAt(11.2, 10, { orbit: 'NGSO', apogeeKm: 30000, inclinationDeg: 63 }).footnotes.includes(n)))
}

// —— ITU 区域（RR No.5.3–5.9）——
{
  const pts = [['北京', 39.9, 116.4, 3], ['乌兰巴托（No.5.3 点名）', 47.92, 106.92, 1], ['莫斯科', 55.76, 37.62, 1], ['新西伯利亚', 55.03, 82.92, 1],
    ['巴黎', 48.85, 2.35, 1], ['纽约', 40.7, -74, 2], ['德黑兰', 35.69, 51.39, 3], ['布什尔（伊朗在线 A 以西）', 28.97, 50.84, 3],
    ['科威特城', 29.37, 47.98, 1], ['埃尔祖鲁姆（土耳其在线 A 以东）', 39.9, 41.27, 1], ['阿拉木图', 43.24, 76.89, 1], ['喀布尔', 34.53, 69.17, 3],
    ['绥芬河（中俄边境）', 44.3964, 131.1631, 3], ['波格拉尼奇内（俄）', 44.40, 131.38, 1], ['阿拉山口（中哈边境）', 45.167, 82.567, 3],
    ['符拉迪沃斯托克', 43.12, 131.89, 1], ['阿纳德尔（岸边）', 64.73, 177.5, 1], ['札幌', 43.06, 141.35, 3], ['檀香山', 21.31, -157.86, 2],
    ['雷克雅未克', 64.15, -21.94, 1], ['努克', 64.18, -51.72, 2], ['悉尼', -33.87, 151.21, 3], ['基里巴斯圣诞岛', 1.87, -157.4, 3],
    ['复活节岛', -27.1, -109.35, 2], ['马斯喀特', 23.59, 58.38, 1], ['卡拉奇', 24.86, 67.0, 3]]
  const bad = pts.filter(([, la, lo, r]) => R.ituRegionOf(la, lo) !== r).map(([n, la, lo, r]) => `${n} 得 ${R.ituRegionOf(la, lo)} 应 ${r}`)
  ok(`ITU 区域判定 ${pts.length} 个代表站点`, bad.length === 0, bad.join('; '))
  ok('线 A / B / C 端点按 No.5.7–5.9', R.lineA(45) === 40 && R.lineA(10) === 60 && R.lineB(80) === -10 && R.lineB(-30) === -20
    && near(R.lineC(5), 240) && near(R.lineC(70), 360 - (168 + 58 / 60 + 37 / 3600)) && near(R.lineA(40 - 1e-9), 40, 1e-6) && near(R.lineC(50), 165, 1e-6))
}

// —— assessPfd：自由空间口径 ——
{
  const fsTot = (eirp, dKm) => eirp - 10 * lg(4 * Math.PI * Math.pow(dKm * 1000, 2))
  const a = A.assessPfd({ fGHz: 11.2, deltaDeg: 30, ctx: { orbit: 'GSO', latDeg: 39.9, lonDeg: 116.4 }, eirpDbw: 50, slantRangeKm: 38000, occBwHz: 36e6 })
  ok('宽载波：PFD_ref = EIRP − 10lg(4πd²) − 10lg(B_occ/B_ref)', near(a.pfdTotal, fsTot(50, 38000)) && near(a.pfdRef, fsTot(50, 38000) - 10 * lg(36e6 / 4000)), a.pfdRef)
  ok('余量 = 限值 − PFD_ref；限值折算到载波带宽 = 限值 + 10lg(B_occ/B_ref)', near(a.margin, -140 - a.pfdRef) && near(a.limitCarrierBw, -140 + 10 * lg(36e6 / 4000)))
  const n = A.assessPfd({ fGHz: 18.5, deltaDeg: 30, ctx: { orbit: 'GSO', latDeg: 39.9, lonDeg: 116.4 }, eirpDbw: 30, slantRangeKm: 38000, occBwHz: 1e5 })
  ok('窄载波（100 kHz < 1 MHz）：整个载波落在一个参考带宽内，PFD_ref = 整载波 PFD（不再多扣 10 dB）', near(n.pfdRef, fsTot(30, 38000)) && near(n.limitCarrierBw, -105))
  const w = A.assessPfd({ fGHz: 6.9, deltaDeg: 30, ctx: { orbit: 'GSO' }, eirpDbw: 40, slantRangeKm: 38000, occBwHz: 36e6 })
  const nn = A.assessPfd({ fGHz: 6.9, deltaDeg: 30, ctx: { orbit: 'GSO' }, eirpDbw: 20, slantRangeKm: 38000, occBwHz: 1e5 })
  ok('6 825-7 075 MHz 双限值取余量最小者：宽载波由 1 MHz 那组约束、100 kHz 载波由 4 kHz 那组约束',
    w.refBwHz === 1e6 && near(w.margin, -124 - (fsTot(40, 38000) - 10 * lg(36))) && nn.refBwHz === 4000 && near(nn.margin, -144 - (fsTot(20, 38000) - 10 * lg(25))))
  const z = A.assessPfd({ fGHz: 20.0, deltaDeg: 30, ctx: { orbit: 'GSO', latDeg: 39.9, lonDeg: 116.4 }, eirpDbw: 60, slantRangeKm: 38000, occBwHz: 36e6 })
  ok('RR 无限值：限值 / 余量 / 参考带宽内 PFD 全为 null，整载波自由空间 PFD 照出', z.limit === null && z.margin === null && z.pfdRef === null && z.rowId === null && near(z.pfdTotal, fsTot(60, 38000)))
  const mm = A.assessPfd({ fGHz: 18.5, deltaDeg: 10, ctx: { orbit: 'NGSO', apogeeKm: 550 }, eirpDbw: 30, slantRangeKm: 1000, occBwHz: 2e6 })
  ok('缺参：限值 / 余量 null，参考带宽内 PFD 仍按该行参考带宽给出', mm.limit === null && mm.margin === null && mm.missing.join() === 'N' && near(mm.pfdRef, fsTot(30, 1000) - 10 * lg(2)))
  const m25 = A.assessPfd({ fGHz: 18.5, deltaDeg: 30, ctx: { orbit: 'NGSO', apogeeKm: 550 }, eirpDbw: 30, slantRangeKm: 1000, occBwHz: 2e6 })
  ok('δ > 25° 段是常数 −105，不需要 X：不缺参', m25.limit === -105 && m25.missing.length === 0)
}

// —— ⑥ 引擎集成 ——
const SAT = { frequencyBand: 'Ku', satelliteName: 'T', orbitPosition: '110.5' }
const geo = (lp) => core.calculateLinkBudget(SAT, lp).data
const ngso = (lp, sp) => core.calculateLinkBudgetNGSO(Object.assign({ frequencyBand: 'Ku', satelliteName: 'N', orbitInclination: '53' }, sp || {}),
  Object.assign({ orbitAltitude: 1145, rxOrbitAltitude: 1145, rxMinElevation: '15' }, lp)).data
const num = (v) => (v === null || v === undefined || v === '') ? null : Number(v)
// 由引擎自身出参复算自由空间口径（与 art21.js 独立的一份）：PFD_ref = EIRP − 10lg(4πd²) + 10lg(min(B_ref,B_occ)/B_occ)
function recompute(d, eirpKey) {
  const eirp = num(d[eirpKey || 'transponderOutputEIRP']), dKm = num(d.rxSlantRangeResult)
  const bOcc = (num(d.noiseBwResult) || num(d.allocBandwidthResult)) * 1000, bRef = num(d.ituPfdRefBandwidth) * 1000
  return eirp - 10 * lg(4 * Math.PI * Math.pow(dKm * 1000, 2)) + 10 * lg(Math.min(bRef, bOcc) / bOcc)
}
{
  // Ku 10.7-11.7 GHz GSO（北京收）
  const d = geo({ rxCenterFrequency: '11.2', centerFrequency: '14.25' })
  const el = num(d.rxElevationResult)
  const want = el <= 5 ? -150 : el <= 25 ? -150 + 0.5 * (el - 5) : -140
  ok('Ku 11.2 GHz GSO：查到 T21-4.14、4 kHz、限值按收信站仰角', d.ituPfdRowResult === 'T21-4.14' && d.ituPfdRefBandwidth === '4' && near(num(d.ituPfdLimitResult), want, 0.006), `${d.ituPfdLimitResult} @δ=${el}`)
  ok('Ku GSO：自由空间到达 PFD（4 kHz）与出参复算一致', near(num(d.pfdFreeSpaceRefBwResult), recompute(d), 0.02), `${d.pfdFreeSpaceRefBwResult} vs ${recompute(d).toFixed(3)}`)
  ok('Ku GSO：余量 = 限值 − 自由空间 PFD', near(num(d.ituPfdMarginResult), num(d.ituPfdLimitResult) - num(d.pfdFreeSpaceRefBwResult), 0.011))
  // 实际到达 PFD（整载波、含衰减）＝ 自由空间整载波 PFD − 下行大气 − 云 − 其他损耗（晴空，下行雨衰不计）
  const bOcc = (num(d.noiseBwResult) || num(d.allocBandwidthResult)) * 1000
  const fsTotal = num(d.pfdFreeSpaceRefBwResult) - 10 * lg(4000 / bOcc)
  const losses = num(d.downlinkAtmosphericAttenuationResult) + num(d.downlinkCloudAttenuation) + num(d.downlinkMiscLossResult)
  ok('Ku GSO：「实际到达 PFD（含衰减）」照出、与自由空间口径差 = 下行衰减', near(fsTotal - num(d.arrivalPFDAtGroundResult), losses, 0.03), `${(fsTotal - num(d.arrivalPFDAtGroundResult)).toFixed(3)} vs ${losses.toFixed(3)}`)
  ok('Ku GSO：限值折算到载波带宽 = 限值 + 10lg(B_occ/4 kHz)', near(num(d.ituPfdLimitPerM2), num(d.ituPfdLimitResult) + 10 * lg(bOcc / 4000), 0.011))
  ok('旧出参 ituPfdLimit4kHz 已删（它把 1 MHz 限值折成 4 kHz，不是 RR 里的量）', !('ituPfdLimit4kHz' in d))
}
{
  // C 3.4-4.2 GHz：GSO 与 NGSO
  const g = geo({ rxCenterFrequency: '3.95', centerFrequency: '6.175' })
  const el = num(g.rxElevationResult)
  ok('C 3.95 GHz GSO：T21-4.06（4 kHz，−152 起）', g.ituPfdRowResult === 'T21-4.06' && near(num(g.ituPfdLimitResult), el <= 5 ? -152 : el <= 25 ? -152 + 0.5 * (el - 5) : -142, 0.006), g.ituPfdLimitResult)
  const n0 = ngso({ rxCenterFrequency: '3.95', centerFrequency: '6.175' })
  ok('C 3.95 GHz NGSO 缺 NN/NS：查 T21-4.07、限值与余量 null、缺参列出', n0.ituPfdRowResult === 'T21-4.07' && n0.ituPfdLimitResult === null && n0.ituPfdMarginResult === null && n0.ituPfdMissingResult === 'NN, NS')
  ok('C NGSO 缺参时自由空间 PFD（1 MHz）照出', near(num(n0.pfdFreeSpaceRefBwResult), recompute(n0), 0.02))
  const n1 = ngso({ rxCenterFrequency: '3.95', centerFrequency: '6.175', art21NN: 4, art21NS: 4 })
  const Y = 5 * lg(4), d15 = 15
  ok('C NGSO NN=NS=4：−138 − Y + (12 + Y)(δ − 5)/20，δ = 15°', near(num(n1.ituPfdLimitResult), -138 - Y + (12 + Y) * (d15 - 5) / 20, 0.006), n1.ituPfdLimitResult)
  ok('C NGSO 不再套 GSO 行（旧链给 −152 系 4 kHz）', n1.ituPfdRefBandwidth === '1000')
}
// ⑦ 外部参照：D 路 art21diff.js 的 RR 公式
const Xr = (N, Nv) => { if (N <= 50) return 0; if (N <= 288) return (5 / 119) * (N - 50); if (N <= 999) return (1 / 69) * (N + 402); if (N <= 6000) return Math.max(20.3, 10 * lg(Nv)); return 10 * lg(Nv) + 1 }
const rrNgsoKa = (d, N, Nv) => { const x = Xr(N, Nv); return d <= 5 ? -115 - x : d <= 25 ? -115 - x + ((10 + x) / 20) * (d - 5) : -105 }
const rrGsoQ = (d) => d <= 5 ? -127 : d <= 20 ? -127 + (4 / 3) * (d - 5) : d <= 25 ? -107 + 0.4 * (d - 20) : -105
const rrGso405 = (d) => d <= 5 ? -120 : d <= 15 ? -120 + (d - 5) : d <= 25 ? -110 + 0.5 * (d - 15) : -105
{
  const bad = []
  for (const d of [3, 10, 15, 20, 25, 40]) {
    for (const [N, Nv] of [[1000, 40], [7000, 60]]) {
      const r = A.limitAt(18.5, d, { orbit: 'NGSO', apogeeKm: 550, N, Nv })
      if (!near(r.limit, rrNgsoKa(d, N, Nv))) bad.push(`Ka NGSO δ=${d} N=${N}`)
    }
    if (!near(A.limitAt(38, d, { orbit: 'GSO', latDeg: 39.9, lonDeg: 116.4 }).limit, rrGsoQ(d))) bad.push('Q δ=' + d)
    if (!near(A.limitAt(41, d, { orbit: 'GSO' }).limit, rrGso405(d))) bad.push('V40.5 δ=' + d)
    if (!near(A.limitAt(42.2, d, { orbit: 'GSO' }).limit, rrGsoQ(d))) bad.push('V42 δ=' + d)
  }
  ok('与 art21diff.js 的 RR 公式逐点一致（Ka NGSO 两组 N/Nv、37.5-40 / 40.5-42 / 42-42.5 GHz GSO，δ = 3/10/15/20/25/40°）', bad.length === 0, bad.join(' '))
}
{
  // Ka 17.7-19.3 GHz NGSO
  const k0 = ngso({ rxCenterFrequency: '18.5', centerFrequency: '28.5' }, { frequencyBand: 'Ka' })
  ok('Ka 18.5 GHz NGSO 缺 N：T21-4.20b、限值 null、缺 N', k0.ituPfdRowResult === 'T21-4.20b' && k0.ituPfdLimitResult === null && k0.ituPfdMissingResult === 'N')
  const k1 = ngso({ rxCenterFrequency: '18.5', centerFrequency: '28.5', art21N: 1000, art21Nv: 40 }, { frequencyBand: 'Ka' })
  const el = num(k1.rxElevationResult)
  ok('Ka 18.5 GHz NGSO N=1000、Nv=40：−115 − X + ((10 + X)/20)(δ − 5)，X = 20.3', near(num(k1.ituPfdLimitResult), rrNgsoKa(el, 1000, 40), 0.006), `${k1.ituPfdLimitResult} @δ=${el}`)
  ok('Ka NGSO：比旧链（−115 + 0.5(δ − 5)）严', num(k1.ituPfdLimitResult) < -115 + 0.5 * (el - 5) - 10)
  // Ka 19.7-20.2 GHz：RR 无限值
  const z = geo({ rxCenterFrequency: '19.95', centerFrequency: '29.75' })
  ok('Ka 19.95 GHz GSO（中星 Ka 用户下行）：限值 / 余量 / 参考带宽 / 自由空间 PFD 全为 null', z.ituPfdLimitResult === null && z.ituPfdMarginResult === null && z.ituPfdRefBandwidth === null && z.pfdFreeSpaceRefBwResult === null && z.ituPfdRowResult === '')
  ok('Ka 19.95 GHz GSO：「实际到达 PFD（含衰减）」照出', Number.isFinite(num(z.arrivalPFDAtGroundResult)))
  const segs = wf.buildWaterfallSegments({ results: z, lang: 'zh', orbitType: 'GEO' })
  const psd = segs.find((s) => s.id === 'psd')
  ok('Ka 19.95 GHz 瀑布：不再出 Art.21 限值 / 余量行', psd && !psd.rows.some((r) => /^(ituPfd|pfdFreeSpace)/.test(r.id)) && psd.rows.some((r) => r.id === 'arrivalPFDAtSatelliteResult'))
  const nz = ngso({ rxCenterFrequency: '20.0', centerFrequency: '30.0' }, { frequencyBand: 'Ka' })
  ok('Ka 20.0 GHz NGSO：同样 null', nz.ituPfdLimitResult === null && nz.ituPfdRowResult === '')
  // Q 37.5-40 GHz GSO
  const q = geo({ rxCenterFrequency: '38.5', centerFrequency: '48.5' })
  const eq = num(q.rxElevationResult)
  ok('Q 38.5 GHz GSO：T21-4.32（−127 起，旧链 −115 起）', q.ituPfdRowResult === 'T21-4.32' && near(num(q.ituPfdLimitResult), rrGsoQ(eq), 0.006), `${q.ituPfdLimitResult} @δ=${eq}`)
}
{
  // 瀑布四行与英文
  const d = geo({ rxCenterFrequency: '12.5', centerFrequency: '14.25' })
  const zh = wf.buildWaterfallSegments({ results: d, lang: 'zh', orbitType: 'GEO' }).find((s) => s.id === 'psd')
  const ids = zh.rows.map((r) => r.id)
  ok('GEO 12.5 GHz 瀑布：参考带宽 / 自由空间 PFD / 限值 / 余量四行齐（下行列）',
    ['ituPfdRefBandwidth', 'pfdFreeSpaceRefBwResult', 'ituPfdLimitResult', 'ituPfdMarginResult'].every((k) => ids.includes(k)) && !ids.includes('ituPfdLimitPerM2'))
  const en = wf.buildWaterfallSegments({ results: d, lang: 'en', orbitType: 'GEO' }).find((s) => s.id === 'psd')
  ok('瀑布英文标签', en.rows.some((r) => r.label === 'ITU PFD Margin') && en.rows.some((r) => r.label === 'Free-Space PFD (Ref. Bandwidth)'))
  // 2026-10-17 前保存的记录（参考带宽是 '4kHz' 文本、没有新三项）：不冒出孤零零的「4kHz kHz」行
  const old = Object.assign({}, d, { ituPfdRefBandwidth: '4kHz', ituPfdLimit4kHz: '-138.00' })
  for (const k of ['pfdFreeSpaceRefBwResult', 'ituPfdLimitResult', 'ituPfdMarginResult']) delete old[k]
  const op = wf.buildWaterfallSegments({ results: old, lang: 'zh', orbitType: 'GEO' }).find((s) => s.id === 'psd')
  ok('旧记录：瀑布不出 Art.21 行（旧文本参考带宽不冒充新口径）', !op.rows.some((r) => /ituPfd|pfdFreeSpace/.test(r.id)))
  const n = ngso({ rxCenterFrequency: '18.5', centerFrequency: '28.5' }, { frequencyBand: 'Ka' })
  const np = wf.buildWaterfallSegments({ results: n, lang: 'zh', orbitType: 'NGSO' }).find((s) => s.id === 'psd')
  ok('NGSO 缺参：瀑布有自由空间 PFD 行、无限值 / 余量行', np.rows.some((r) => r.id === 'pfdFreeSpaceRefBwResult') && !np.rows.some((r) => r.id === 'ituPfdLimitResult' || r.id === 'ituPfdMarginResult'))
}
{
  // NGSO 窗里的 GEO 星：按 GSO 查（轨道高度 35 786 km、倾角 0°）
  const g = ngso({ rxCenterFrequency: '12.5', centerFrequency: '14.25', orbitAltitude: 35786, rxOrbitAltitude: 35786 }, { orbitInclination: '0' })
  ok('NGSO 引擎里 GEO 高度 + 0° 倾角：按 GSO 查 T21-4.18', g.ituPfdOrbitResult === 'GSO' && g.ituPfdRowResult === 'T21-4.18')
  // 再生式：下行按卫星 EIRP 直发平移；上行 / 星间清空
  const P = { orbitAltitude: 1145, rxOrbitAltitude: 1145, rxCenterFrequency: '12.5' }
  const dn = regen.computeRegenDownlinkMode({ frequencyBand: 'Ku' }, P).data
  ok('再生下行：自由空间 PFD 按卫星下行 EIRP 直发复算', near(num(dn.pfdFreeSpaceRefBwResult), recompute(dn, 'EIRPsResult'), 0.03), `${dn.pfdFreeSpaceRefBwResult} vs ${recompute(dn, 'EIRPsResult').toFixed(3)}`)
  ok('再生下行：余量 = 限值 − 自由空间 PFD', near(num(dn.ituPfdMarginResult), num(dn.ituPfdLimitResult) - num(dn.pfdFreeSpaceRefBwResult), 0.011))
  const up = regen.computeRegenUplinkMode({ frequencyBand: 'Ku' }, P).data
  ok('再生上行：没有星地下行，Art.21 一组清空', up.ituPfdLimitResult === null && up.pfdFreeSpaceRefBwResult === null && up.ituPfdMarginResult === null && up.ituPfdRowResult === '')
}

console.log(`
=== ${pass} passed, ${fail} failed ===`)
if (fail) process.exit(1)
