// 时区规则表自测（src/viz/geo/tzRules.js + tzPosix.js，数据 src/viz/geo/tz/tzRules.json = tzdb 2026e）。运行：npm test
// 任务书 docs/环境场时区显示任务书_2026-10-20.md §7.1。时刻一律 UTC 正午。
//
// 这一层回答「某时区在某时刻的偏移是多少」。会出错的地方：
//   ① TZif 解析 / 脚注展开 —— 显式跃迁只存到最后一次，之后按 POSIX 脚注现算（2090 年的柏林、南半球跨年的规则）；
//   ② rearguard 语义 —— 夏令时份额一律为正（爱尔兰全年标准时 0、摩洛哥 2018–2026 标准时 0），「标准时」档才对得上纸图；
//   ③ 区间缓存 —— offsetAt 按上次求得的恒定区间直接返回，乱序取值不许串；
//   ④ 近两年的改制 —— Electron 31 的 ICU 是 2024a、Node 22 是 2024b，规则表必须算对它们算错的那些。
// ICU 对拍：Node 自带 tzdb（process.versions.tz）不早于 2024b 时，逐区在 1970–2040 年每次跃迁前后与 Intl 比对；
//   不一致只许落在白名单的时间窗里，且每条都对得上 tzdb NEWS（2024b 之后的版本）。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setRules, zoneIndex, zoneOffset, offsetAt, zoneCount, zoneName, rulesVersion } from '../../../src/viz/geo/tzRules.js'
import { parsePosixTz, yearTransitions, posixAt } from '../../../src/viz/geo/tzPosix.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const RULES = JSON.parse(readFileSync(join(ROOT, 'src/viz/geo/tz/tzRules.json'), 'utf8'))

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const noon = (d) => Date.parse(d + 'T12:00:00Z')

setRules(RULES)

// ==================== ① 规则表本身 ====================
{
  ok('① 版本 2026e', rulesVersion() === '2026e', rulesVersion())
  ok('① 区数 ≥ 300', zoneCount() >= 300, String(zoneCount()))
  ok('① 区名不重复', new Set(RULES.zones).size === RULES.zones.length)
  ok('① 新疆不单列（Asia/Urumqi 已并入 Asia/Shanghai）', zoneIndex('Asia/Urumqi') < 0 && zoneIndex('Asia/Shanghai') >= 0)
  let shape = 0, mono = 0, range = 0, neg = 0, foot = 0, fsBad = 0
  RULES.data.forEach((a, i) => {
    if (a.length < 2 || (a.length - 2) % 3) { shape++; return }
    let t = 0, last = -Infinity
    for (let p = 0; p < a.length; p += 3) {
      if (p > 0) { if (!(a[p - 1] > 0 && t + a[p - 1] > last)) mono++; t += a[p - 1]; last = t }
      const off = p === 0 ? a[0] : a[p], dst = p === 0 ? a[1] : a[p + 1]
      if (!(off >= -720 && off <= 840)) range++
      if (!(dst >= 0)) neg++
    }
    const f = RULES.foot[i]
    if (f) { try { parsePosixTz(f) } catch { foot++ } }
    // 脚注生效时刻不早于最后一次显式跃迁（脚注只管它之后）
    if (a.length > 2 && !(RULES.fs[i] >= t)) fsBad++
  })
  ok('① 每区数据形如 [off0, dst0, (Δt, off, dst)…]', shape === 0, `坏 ${shape}`)
  ok('① 跃迁时刻严格递增', mono === 0, `坏 ${mono}`)
  ok('① 偏移落在 UTC−12 … UTC+14', range === 0, `坏 ${range}`)
  ok('① rearguard：夏令时份额一律 ≥ 0', neg === 0, `坏 ${neg}`)
  ok('① 脚注都能解析', foot === 0, `坏 ${foot}`)
  ok('① 脚注生效时刻不早于最后一次显式跃迁', fsBad === 0, `坏 ${fsBad}`)
}

// ==================== ② 验收表：民用时（含夏令时） ====================
const CIVIL = [
  ['Asia/Shanghai', '2026-07-01', 480],
  ['Asia/Shanghai', '1988-07-01', 540, '北京夏令时'],
  ['Asia/Hong_Kong', '1988-07-01', 480],
  ['America/Vancouver', '2026-07-01', -420],
  ['America/Vancouver', '2026-12-01', -420, 'BC 永久 −7（tzdb 按 2026-11-01 建模）'],
  ['America/Edmonton', '2026-12-01', -360, '阿尔伯塔永久 −6'],
  ['America/Winnipeg', '2026-12-01', -300, '曼尼托巴永久 −5'],
  ['Africa/Casablanca', '2026-07-01', 60],
  ['Africa/Casablanca', '2026-10-01', 0, '摩洛哥 2026-09-20 回 +00'],
  ['America/Asuncion', '2025-07-01', -180, '巴拉圭永久 −3'],
  ['Asia/Almaty', '2023-07-01', 360],
  ['Asia/Almaty', '2025-01-01', 300, '哈萨克斯坦 2024-03 统一 +5'],
  ['America/Coyhaique', '2025-07-01', -180, '智利艾森 2025 新区'],
  ['Europe/Moscow', '2013-01-01', 240],
  ['Europe/Moscow', '2015-01-01', 180],
  ['Europe/Istanbul', '2017-01-01', 180],
  ['America/Caracas', '2015-01-01', -270],
  ['America/Caracas', '2017-01-01', -240],
  ['Australia/Lord_Howe', '2026-01-15', 660, '半小时夏令时'],
  ['Australia/Lord_Howe', '2026-07-15', 630],
  ['Antarctica/Troll', '2026-07-15', 120, '+00 → +02 的两小时夏令时'],
  ['Pacific/Kiritimati', '2026-07-15', 840],
  ['Pacific/Kiritimati', '2026-01-15', 840],
  ['Pacific/Chatham', '2026-07-15', 765],
  ['Asia/Kathmandu', '2026-07-15', 345],
  ['Asia/Kathmandu', '2026-01-15', 345],
  ['Europe/Berlin', '2090-07-01', 120, '脚注展开'],
  ['Europe/Berlin', '2090-01-15', 60, '脚注展开']
]
for (const [z, d, exp, why] of CIVIL) {
  const i = zoneIndex(z)
  const v = i >= 0 ? zoneOffset(i, noon(d), true) : NaN
  ok(`② 民用时 ${z} ${d} = ${exp}${why ? '（' + why + '）' : ''}`, v === exp, i < 0 ? '规则表里没有这个区' : String(v))
}

// ==================== ③ 验收表：标准时 ====================
const STD = [
  ['Europe/Dublin', '2026-01-15', 0], ['Europe/Dublin', '2026-07-15', 0, '爱尔兰：rearguard 下全年标准时 0'],
  ['America/Vancouver', '2026-07-01', -480], ['America/Vancouver', '2026-12-01', -420, '改制后标准时就是 −7'],
  ['Africa/Casablanca', '2026-07-01', 0, '2018–2026 的 +01 算夏令时'],
  ['Antarctica/Troll', '2026-07-15', 0],
  ['Australia/Lord_Howe', '2026-01-15', 630]
]
for (const [z, d, exp, why] of STD) {
  const i = zoneIndex(z)
  const v = i >= 0 ? zoneOffset(i, noon(d), false) : NaN
  ok(`③ 标准时 ${z} ${d} = ${exp}${why ? '（' + why + '）' : ''}`, v === exp, String(v))
}

// ==================== ④ 区间缓存：乱序取值与无缓存参照逐个相等 ====================
// 参照实现只看原始数据（二分 + 脚注），不碰 offsetAt 的缓存字段
{
  const parsed = RULES.data.map((a, i) => {
    const ts = [-Infinity], off = [a[0]], dst = [a[1]]
    let t = 0
    for (let p = 2; p < a.length; p += 3) { t += a[p]; ts.push(t); off.push(a[p + 1]); dst.push(a[p + 2]) }
    const f = RULES.foot[i] ? parsePosixTz(RULES.foot[i]) : null
    return { ts, off, dst, tz: f && f.dst ? f : null, fs: RULES.fs[i] }
  })
  const ref = (i, ms) => {
    const s = parsed[i], t = ms / 1000
    let lo = 0
    for (let k = 1; k < s.ts.length; k++) if (s.ts[k] <= t) lo = k
    if (lo === s.ts.length - 1 && s.tz && t >= s.fs) {
      const st = posixAt(s.tz, t, Math.max(s.ts[lo], s.fs))
      if (st) return st.utoff / 60
    }
    return s.off[lo]
  }
  let rng = 20261020
  const rnd = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const T0 = Date.UTC(1965, 0, 1), T1 = Date.UTC(2110, 0, 1)
  let bad = 0, first = ''
  for (let n = 0; n < 20000; n++) {
    const i = Math.floor(rnd() * RULES.zones.length) % RULES.zones.length
    const ms = T0 + rnd() * (T1 - T0)
    const a = offsetAt(i, ms).off, b = ref(i, ms)
    if (a !== b) { bad++; if (!first) first = `${RULES.zones[i]} ${new Date(ms).toISOString()} 缓存 ${a} / 参照 ${b}` }
  }
  ok('④ 20000 次乱序取值（1965–2110）与无缓存参照逐个相等', bad === 0, bad ? `${bad} 处，首例 ${first}` : '')
  // 同一区来回跳：先远后近、再跨脚注生效点
  const ber = zoneIndex('Europe/Berlin')
  const seq = ['2090-07-01', '1975-07-01', '2026-03-29T00:59:59Z', '2026-03-29T01:00:00Z', '2026-10-25T00:59:59Z', '2026-10-25T01:00:00Z']
  const got = seq.map((d) => zoneOffset(ber, d.includes('T') ? Date.parse(d) : noon(d), true))
  ok('④ 柏林来回跳（2090 → 1975 → 2026 两次跃迁的前后一秒）', JSON.stringify(got) === JSON.stringify([120, 60, 60, 120, 120, 60]), got.join(','))
}

// ==================== ⑤ 脚注：南半球跨年、负 / 超 24 h 的规则时刻 ====================
{
  const at = (z, iso) => zoneOffset(zoneIndex(z), Date.parse(iso), true)
  ok('⑤ 悉尼 2090-01-15 夏令时 +11', at('Australia/Sydney', '2090-01-15T12:00:00Z') === 660)
  ok('⑤ 悉尼 2090-07-15 标准时 +10', at('Australia/Sydney', '2090-07-15T12:00:00Z') === 600)
  ok('⑤ 圣地亚哥 2090-01-15 夏令时 −3', at('America/Santiago', '2090-01-15T12:00:00Z') === -180)
  ok('⑤ 耶路撒冷 2090-07-15（M3.4.4/26 超 24 h 的规则时刻）+3', at('Asia/Jerusalem', '2090-07-15T12:00:00Z') === 180)
  ok('⑤ 努克 2090-07-15（M3.5.0/-1 负规则时刻）−1', at('America/Nuuk', '2090-07-15T12:00:00Z') === -60)
  // 年内两次跃迁的时刻：柏林 2026 = 03-29 01:00Z / 10-25 01:00Z
  const tz = parsePosixTz('CET-1CEST,M3.5.0,M10.5.0/3')
  const tr = yearTransitions(tz, 2026).map((x) => new Date(x.t * 1000).toISOString())
  ok('⑤ yearTransitions 柏林 2026', tr[0] === '2026-03-29T01:00:00.000Z' && tr[1] === '2026-10-25T01:00:00.000Z', tr.join(' / '))
}

// ==================== ⑥ 与 ICU 对拍（1970–2040，跃迁前后） ====================
// 白名单：2024b 之后 tzdb 改过的时间窗（来源：tzdb NEWS）。只豁免窗内的不一致；窗外照样必须相等。
//   任务书列的「巴拉圭、智利艾森、BC / 阿尔伯塔 / 西北地区 / 曼尼托巴、摩洛哥、西撒、摩尔多瓦」是前八条；
//   实测另有四处历史更正落在 1970 年以后（后四条），一并列出。America/Coyhaique 是 2025b 新区，ICU 2024b 不认识，自然跳过。
const Y = (s) => Date.parse(s + 'T00:00:00Z')
const WL = [
  ['America/Asuncion', Y('2024-10-01'), Infinity, '2025a 巴拉圭永久 −03'],
  ['America/Vancouver', Y('2026-11-01'), Infinity, '2026b BC 永久 −07'],
  ['America/Edmonton', Y('2026-11-01'), Infinity, '2026c 阿尔伯塔永久 −06'],
  ['America/Inuvik', Y('2026-11-01'), Infinity, '2026d 西北地区永久 −06'],
  ['America/Winnipeg', Y('2026-11-01'), Infinity, '2026e 曼尼托巴永久 −05'],
  ['Africa/Casablanca', Y('2026-09-20'), Infinity, '2026c 摩洛哥 2026-09-20 回 +00'],
  ['Africa/El_Aaiun', Y('2026-09-20'), Infinity, '2026c 西撒随摩洛哥'],
  ['Europe/Chisinau', Y('2022-01-01'), Infinity, '2026a 摩尔多瓦 2022 起按欧盟跃迁时刻（03:00 / 04:00）'],
  ['America/Bogota', Y('1992-05-01'), Y('1992-05-04'), '2026e 哥伦比亚 1992-05-02 的跃迁在 00:00 而非 24:00'],
  ['Asia/Tehran', Y('1978-11-01'), Y('1979-06-01'), '2025b 伊朗 1978-11-10 改 +0330；2026e 1979-05-26 跃迁在 00:00'],
  ['America/Tijuana', Y('1961-01-01'), Y('1976-01-01'), '2025c 下加州 1961–1975 随加州夏令时'],
  ['Asia/Manila', Y('1937-01-01'), Y('1991-01-01'), '2025a 菲律宾 1937–1990 史料更正']
]
const icuTz = String(process.versions.tz || '')
if (!icuTz || icuTz < '2024b') {
  console.log(`SKIP  ⑥ ICU 对拍（本机 Node 自带 tzdb ${icuTz || '未知'}，早于 2024b，白名单口径不适用）`)
} else {
  const fmt = new Map()
  const icuOff = (z, ms) => {
    let f = fmt.get(z)
    if (f === undefined) {
      try { f = new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'longOffset', year: 'numeric' }) } catch { f = null }
      fmt.set(z, f)
    }
    if (!f) return null
    const s = f.formatToParts(new Date(ms)).find((x) => x.type === 'timeZoneName').value
    if (s === 'GMT') return 0
    const m = /^GMT([+\-−])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/.exec(s)
    if (!m) return NaN
    return (m[1] === '+' ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3] || 0) + Number(m[4] || 0) / 60)
  }
  const T0 = Date.UTC(1970, 0, 1) / 1000, T1 = Date.UTC(2041, 0, 1) / 1000
  let checked = 0, skipped = 0, waived = 0
  const bad = new Map(), waivedBy = new Map()
  RULES.zones.forEach((z, i) => {
    if (icuOff(z, 0) == null) { skipped++; return }
    // 跃迁：显式段 + 脚注现算的（脚注生效之后到 2040）
    const a = RULES.data[i], ts = []
    let t = 0
    for (let p = 2; p < a.length; p += 3) { t += a[p]; ts.push(t) }
    const f = RULES.foot[i] ? parsePosixTz(RULES.foot[i]) : null
    if (f && f.dst) {
      for (let y = new Date(RULES.fs[i] * 1000).getUTCFullYear(); y <= 2040; y++) for (const x of yearTransitions(f, y)) if (x.t > RULES.fs[i]) ts.push(x.t)
    }
    const probe = []
    for (const x of ts) if (x >= T0 && x < T1) probe.push(x - 3600, x - 1, x, x + 3600)
    for (let y = 1970; y <= 2040; y++) for (let mo = 0; mo < 12; mo += 2) probe.push(Date.UTC(y, mo, 15, 12) / 1000)
    for (const x of probe) {
      checked++
      const ms = x * 1000
      const mine = zoneOffset(i, ms, true), icu = icuOff(z, ms)
      if (mine === icu) continue
      const w = WL.find(([wz, a0, a1]) => wz === z && ms >= a0 && ms < a1)
      if (w) { waived++; waivedBy.set(z, (waivedBy.get(z) || 0) + 1); continue }
      const L = bad.get(z) || []
      L.push(`${new Date(ms).toISOString().slice(0, 16)}Z 本表 ${mine} / ICU ${icu}`)
      bad.set(z, L)
    }
  })
  const lines = [...bad].map(([z, L]) => `${z} ${L.length} 处，首例 ${L[0]}`)
  ok(`⑥ ICU（tzdb ${icuTz}）对拍：${checked} 个时刻，窗外全部相等`, bad.size === 0, lines.slice(0, 6).join('；'))
  console.log(`      （跳过 ICU 不认识的区 ${skipped} 个；白名单窗内豁免 ${waived} 处：${[...waivedBy].map(([z, n]) => z + ' ' + n).join('、')}）`)
}

// ==================== ⑦ 源码：时区图层不许回头用 ICU 取时区偏移 ====================
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
  const FILES = ['src/viz/geo/tzRules.js', 'src/viz/geo/tzPosix.js', 'src/viz/geo/tzLayer.js', 'src/viz/geo/tzStyle.js', 'src/viz/env/useTzLayer.js']
  const hits = []
  for (const f of FILES) {
    const src = strip(readFileSync(join(ROOT, f), 'utf8'))
    if (/Intl\s*\.\s*DateTimeFormat\s*\([^)]*timeZone/.test(src) || /toLocale(?:Date|Time)?String\s*\([^)]*timeZone/.test(src) || /\btimeZone\s*:/.test(src)) hits.push(f)
  }
  ok('⑦ 时区图层源码里没有 Intl / toLocaleString 的 timeZone 取值', hits.length === 0, hits.join(', '))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
