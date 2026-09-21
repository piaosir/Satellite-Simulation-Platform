// 日凌窗口的纯逻辑层（src/suntool/sunParams.js）自测：字段字典 / 留空回退 / 引擎入参 / 状态规范化 / 别名检索。
// 这一层不碰 DOM，故可在 Node 里直接跑。运行：npm test
import { createRequire } from 'node:module'
import {
  BAND_DEFAULTS, BAND_KEYS, SEASONS, normSeasons, sunFields, GRID_GROUPS,
  RESULT_KEYS, RESULT_DIGITS, INPUT_KEYS, defaultRow, effectiveRow, buildSpec,
  normSatName, tightName, expandQuery, matchSat, blankState, normState, ORBIT_TYPE
} from '../../../src/suntool/sunParams.js'

const require = createRequire(import.meta.url)
const { BAND_PARAMS, calculateSunOutageSeasons } = require('../utils/sunOutageCalculator.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

// ── ① BAND_DEFAULTS 是引擎 BAND_PARAMS 的镜像（防漂移）──
{
  let same = true, bad = ''
  for (const k of BAND_KEYS) {
    const a = BAND_DEFAULTS[k], b = BAND_PARAMS[k]
    if (!b) { same = false; bad ||= k + ' 引擎表里没有'; continue }
    if (a.freq !== b.freq) { same = false; bad ||= `${k}.freq ${a.freq} vs ${b.freq}` }
    if (a.sysTemp !== b.sysTemp) { same = false; bad ||= `${k}.sysTemp ${a.sysTemp} vs ${b.sysTemp}` }
  }
  ok('① 频段默认逐键等于引擎 BAND_PARAMS', same, bad)
  ok('① ExtKu 只在引擎表里（表里刻意不列）', !BAND_DEFAULTS.ExtKu && !!BAND_PARAMS.ExtKu)
}

// ── ② 分点归一：顺序固定、非法剔除、空数组被拒 ──
{
  ok('② 顺序恒为 春分→秋分', normSeasons(['autumnal', 'vernal']).join() === 'vernal,autumnal')
  ok('② 非法值剔除', normSeasons(['vernal', 'summer']).join() === 'vernal')
  ok('② 空数组被拒（回落两季）', normSeasons([]).join() === SEASONS.join())
  ok('② 非数组被拒', normSeasons(null).join() === SEASONS.join() && normSeasons('vernal').join() === SEASONS.join())
  ok('② 全非法也回落两季', normSeasons(['x', 'y']).join() === SEASONS.join())
}

// ── ③ 字段集随分点变；结果列全是 ro ──
{
  const two = sunFields(SEASONS).map((f) => f.key)
  const one = sunFields(['vernal']).map((f) => f.key)
  ok('③ 两季 14 列 / 单季 12 列（7 输入 + 3 通用结果 + 每季 2）', two.length === 14 && one.length === 12, `${two.length} / ${one.length}`)
  ok('③ 单季不出另一季的列', !one.includes('aDays') && !one.includes('aMax') && one.includes('vDays'))
  ok('③ 输入列七项', INPUT_KEYS.join() === 'stationName,longitude,latitude,band,frequency,diameter,sysTemp', INPUT_KEYS.join())
  ok('③ 结果列全 ro 且都归 res 组', sunFields(SEASONS).filter((f) => f.ro).every((f) => f.group === 'res' && f.result))
  ok('③ 每个字段的 group 都在 GRID_GROUPS 里', sunFields(SEASONS).every((f) => GRID_GROUPS.some((g) => g.key === f.group)))
  ok('③ 结果列小数位', RESULT_DIGITS.thresholdAngle === 3 && RESULT_DIGITS.vDays === 0 && RESULT_DIGITS.vMax === 1)
  ok('③ 结果列键不与输入列重名', RESULT_KEYS.every((k) => !INPUT_KEYS.includes(k)))
}

// ── ④ 留空回退：普通列按 def，频率 / T_sys 按该行频段 ──
{
  const e = effectiveRow({ stationName: '', longitude: '', latitude: '', band: 'C', frequency: '', diameter: '', sysTemp: '' })
  ok('④ 站名 / 经纬度 / 口径按列默认', e.stationName === '北京' && e.longitude === '116.4074' && e.latitude === '39.9042' && e.diameter === '2.4')
  ok('④ C 频段留空 → 3.95 GHz / 65 K', e.frequency === '3.95' && e.sysTemp === '65', `${e.frequency} / ${e.sysTemp}`)
  const k = effectiveRow({ band: 'Ka' })
  ok('④ Ka 频段留空 → 19.45 GHz / 270 K', k.frequency === '19.45' && k.sysTemp === '270')
  const m = effectiveRow({ band: 'Ku', frequency: '11.7', sysTemp: '120' })
  ok('④ 填了就不回退', m.frequency === '11.7' && m.sysTemp === '120')
  ok('④ 频段留空 → Ku', effectiveRow({ band: '' }).band === 'Ku')
  ok('④ defaultRow 只有输入列', Object.keys(defaultRow()).join() === INPUT_KEYS.join())
}

// ── ⑤ buildSpec：纯数据、structuredClone 不抛、两档取星互斥 ──
{
  const G = { satSource: 'slot', slotLon: '130.5', orbit: null, year: '2026', seasons: SEASONS, criterion: { mode: 'degradation', degDb: '1' } }
  const s = buildSpec(defaultRow(), G)
  let cloneOk = true
  try { structuredClone(s) } catch { cloneOk = false }
  ok('⑤ 定轨档 spec 过 structuredClone', cloneOk)
  ok('⑤ 定轨档给 satLon 不给 orbit', s.satLon === 130.5 && s.orbit === undefined)
  ok('⑤ 数值全是 number', typeof s.lat === 'number' && typeof s.diameter === 'number' && typeof s.customFreq === 'number' && typeof s.year === 'number')
  // 太阳亮温已不是入参（引擎按 F10.7 自己算，F10.7 又由主进程按分点日取），spec 里不许有这个键
  ok('⑤ 不产 solarTemp 键', !('solarTemp' in s))
  ok('⑤ JSON 往返无损', JSON.stringify(JSON.parse(JSON.stringify(s))) === JSON.stringify(s))

  const orbit = { type: 'omm', noradId: '44067', epoch: '2026-09-16T07:28:42Z', meanMotion: 1.00269682, ecc: 0.0001, incl: 0.0493, raan: 80, argp: 120, ma: 200, bstar: 0, mdot: 0, mddot: 0 }
  const e = buildSpec(defaultRow(), { ...G, satSource: 'ephemeris', orbit })
  ok('⑤ 星历档给 orbit 不给 satLon', !!e.orbit && e.satLon === undefined)
  ok('⑤ orbit 是深拷（改原件不影响 spec）', (orbit.incl = 9) && e.orbit.incl === 0.0493)
  const noOrb = buildSpec(defaultRow(), { ...G, satSource: 'ephemeris', orbit: null })
  ok('⑤ 选了星历却没有根数 → 回定轨', noOrb.satLon === 130.5 && !noOrb.orbit)

  const g2 = buildSpec(defaultRow(), { ...G, criterion: { mode: 'geometric', degDb: '', solarTemp: '9000' } })
  ok('⑤ 纯几何档；老 criterion 里残留的 solarTemp 也不带出去', g2.criterion === 'geometric' && g2.degThreshold === 1 && !('solarTemp' in g2))
  ok('⑤ seasons 空数组不会送到引擎', buildSpec(defaultRow(), { ...G, seasons: [] }).seasons.join() === SEASONS.join())
  // 负号 / 全角：西经站址不能被吞成东经
  const w = buildSpec({ ...defaultRow(), longitude: '－61.5' }, G)
  ok('⑤ 全角负号归一（西经不变东经）', w.lon === -61.5, String(w.lon))
}

// ── ⑥ buildSpec 出来的东西引擎真吃得下 ──
{
  const G = { satSource: 'slot', slotLon: '130.5', year: '2026', seasons: ['autumnal'], criterion: { mode: 'degradation', degDb: '1' } }
  const r = calculateSunOutageSeasons(buildSpec(defaultRow(), G))
  ok('⑥ 引擎按 spec 算出秋分、春分为 null', !!r.autumnal && r.autumnal.error === false && r.vernal === null, r.autumnal && r.autumnal.totalDays + ' 天')
  const g = calculateSunOutageSeasons(buildSpec(defaultRow(), { ...G, criterion: { mode: 'geometric' } }))
  ok('⑥ 纯几何档门限角 = 波束宽', g.autumnal.thresholdAngle === g.autumnal.beamWidth)
}

// ── ⑦ 状态规范化：幂等，serialize → apply → serialize 指纹相等 ──
{
  const a = normState(blankState())
  const b = normState(a)
  ok('⑦ normState 幂等', JSON.stringify(a) === JSON.stringify(b))
  ok('⑦ orbitType 恒为 SUN', a.orbitType === ORBIT_TYPE)
  const messy = {
    sat: { name: 'ZHONGXING-6C', noradId: 44067, source: 'ephemeris', slotLon: 130.5, orbit: { type: 'omm', incl: 0.05 }, epoch: null, inclDeg: '0.05' },
    year: 2027, seasons: ['autumnal', 'vernal', 'bogus'],
    criterion: { mode: 'geometric', degDb: 3, solarTemp: '9000' },
    stations: [{ stationName: '喀什', longitude: 75.99, latitude: 39.47, band: 'C', frequency: 3.7, diameter: 4.5, sysTemp: 65, 阴影列: 'x', vDays: 5 }]
  }
  const m = normState(messy)
  ok('⑦ 杂 state 规范化后幂等', JSON.stringify(m) === JSON.stringify(normState(m)))
  ok('⑦ 数字全转成串', m.year === '2027' && m.sat.slotLon === '130.5' && m.criterion.degDb === '3' && m.stations[0].longitude === '75.99')
  // 老存档带 solarTemp：载入后直接丢掉，于是「序列化 → 载入 → 再序列化」的指纹里不含它
  ok('⑦ 老存档里的 criterion.solarTemp 被丢掉（指纹不含）', !('solarTemp' in m.criterion) && !JSON.stringify(m).includes('solarTemp'), JSON.stringify(m.criterion))
  ok('⑦ 行里只剩输入列（结果列与野列被剥）', Object.keys(m.stations[0]).join() === INPUT_KEYS.join(), Object.keys(m.stations[0]).join())
  ok('⑦ 分点重排成固定顺序', m.seasons.join() === 'vernal,autumnal')
  ok('⑦ 有根数才认星历档', m.sat.source === 'ephemeris')
  ok('⑦ 没根数的星历档退回定轨', normState({ sat: { source: 'ephemeris', orbit: null } }).sat.source === 'slot')
  ok('⑦ orbit 引用形状原样保留（不解析）', JSON.stringify(normState({ sat: { source: 'ephemeris', orbit: { type: 'ephem', ref: { groupId: 'g1', satId: 's1' } } } }).sat.orbit) === '{"type":"ephem","ref":{"groupId":"g1","satId":"s1"}}')
  ok('⑦ 空站表补一行', normState({ stations: [] }).stations.length === 1)
  let cloneOk = true
  try { structuredClone(m) } catch { cloneOk = false }
  ok('⑦ state 过 structuredClone', cloneOk)
}

// ── ⑧ 卫星别名：中星 / CHINASAT / ZHONGXING 互通 ──
{
  ok('⑧ ZHONGXING-6C 与 CHINASAT 6C 规范化同名', normSatName('ZHONGXING-6C') === normSatName('CHINASAT 6C'), normSatName('ZHONGXING-6C'))
  ok('⑧ 括注被去掉', normSatName('CHINASAT 16 (SJ-13)') === 'CHINASAT 16', normSatName('CHINASAT 16 (SJ-13)'))
  ok('⑧ 紧凑名', tightName('ZHONGXING-10R') === 'CHINASAT10R', tightName('ZHONGXING-10R'))
  ok('⑧ 查询扩展', expandQuery('中星 6C').some((x) => x.includes('CHINASAT')) && expandQuery('中星 6C').some((x) => x.includes('ZHONGXING')))

  const rec = { name: 'ZHONGXING-6C', noradId: '44067', groupLabel: 'GEO', presetName: 'CHINASAT 6C' }
  for (const q of ['中星 6C', '中星6C', 'CHINASAT 6C', 'chinasat6c', 'ZHONGXING-6C', 'zhongxing 6c', '44067']) {
    ok(`⑧ 搜「${q}」命中 ZHONGXING-6C`, matchSat(rec, q))
  }
  ok('⑧ 不相干的词不命中', !matchSat(rec, 'APSTAR'))
  ok('⑧ 亚太 ↔ APSTAR', matchSat({ name: 'APSTAR 6C', noradId: '43823' }, '亚太 6C'))
  ok('⑧ 亚洲卫星 ↔ ASIASAT', matchSat({ name: 'ASIASAT 9', noradId: '42942' }, '亚洲卫星9'))
  ok('⑧ 空查询不命中任何条', !matchSat(rec, '') && !matchSat(rec, '   '))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
