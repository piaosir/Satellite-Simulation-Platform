// MODCOD 表「内置 + 用户改写」合并层自测。运行：npm test
//
// 锁定的是这个模块存在的理由：
//   ① 空改写层下，合并结果与六张内置表【逐值相同】——「可编辑」不许顺手改动出厂值；
//   ② 存档只留差异：没动过的标准不落库，于是软件升级时新版门限能直接生效（本模块头部说明的核心约定）；
//   ③ 一轮 编辑 → 存档 → 再读 的往返值不漂；改回原样后差异清空、modified 落回 false；
//   ④ Excel/手输进来的脏数据（门限口径的各种写法、空行、缺列）都能落成合法行，且绝不静默丢整表；
//   ⑤ 自定义标准的 key 与内置分家且互不撞车。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const C = require('../utils/constants.js')
const M = require('../utils/modcodTables.js')
const core = require('../index.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const sig = (rows) => JSON.stringify(rows.map((r) => [r.label, r.modulation, r.fec, r.rsCode, r.bandwidthFactor, r.noiseRatioMode, r.threshold]))

/* ---- ① 空改写层 = 内置表逐值相同 ---- */
const BUILTIN_SRC = {
  'DVB-S': C.DVBS_MODCOD_TABLE, 'DVB-S2': C.DVBS2_MODCOD_TABLE, 'DVB-RCS2': C.DVB_RCS2_MODCOD_TABLE,
  'DVB-S2X': C.DVBS2X_MODCOD_TABLE, '3GPP NR-NTN': C.NR_NTN_MODCOD_TABLE, '3GPP NB-IoT NTN': C.NB_IOT_NTN_MODCOD_TABLE
}
const base = M.listStandards(null)
ok('内置标准共 6 个且顺序与 DVB_STANDARD_OPTIONS 一致',
  base.length === 6 && base.every((s, i) => s.key === C.DVB_STANDARD_OPTIONS[i + 1].value),
  base.map((s) => s.key).join(','))
for (const [k, src] of Object.entries(BUILTIN_SRC)) {
  const got = base.find((s) => s.key === k)
  ok(`${k} 逐值等于内置表`, !!got && sig(got.rows) === sig(src), got ? `${got.rows.length}/${src.length} 条` : '缺失')
}
ok('空库下没有任何标准被标记为已改写', base.every((s) => !s.modified))

/* ---- ② 存档只留差异 ---- */
ok('原样存回 → 空存档', (() => {
  const st = M.storeFromList(base)
  return Object.keys(st.overrides).length === 0 && st.custom.length === 0
})())

const edited = JSON.parse(JSON.stringify(base))
edited.find((s) => s.key === 'DVB-S2').rows[0].threshold = -1.55
const st1 = M.storeFromList(edited)
ok('只改 DVB-S2 → 存档里只有 DVB-S2 一条差异', Object.keys(st1.overrides).join(',') === 'DVB-S2')
ok('未改的标准不入存档 → 升级后仍跟内置走', (() => {
  // 模拟内置表升级：直接比合并结果与当前内置表（未改的那五张恒取内置）
  const merged = M.listStandards(st1)
  return merged.filter((s) => s.key !== 'DVB-S2').every((s) => sig(s.rows) === sig(BUILTIN_SRC[s.key]))
})())

/* ---- ③ 往返不漂 / 改回原样后差异清空 ---- */
const back = M.listStandards(st1)
ok('往返后改动值不漂', back.find((s) => s.key === 'DVB-S2').rows[0].threshold === -1.55)
ok('DVB-S2 标记为已改写、其余为否', back.filter((s) => s.modified).map((s) => s.key).join(',') === 'DVB-S2')
ok('改回原值 → 差异清空、modified 落回 false', (() => {
  const r = JSON.parse(JSON.stringify(back))
  r.find((s) => s.key === 'DVB-S2').rows[0].threshold = C.DVBS2_MODCOD_TABLE[0].threshold
  const st = M.storeFromList(r)
  return Object.keys(st.overrides).length === 0 && M.listStandards(st).every((s) => !s.modified)
})())
ok('改名也算改写（内置标准可改名，key 不变）', (() => {
  const r = JSON.parse(JSON.stringify(base))
  const t = r.find((s) => s.key === 'DVB-S')
  t.label = '中星 DVB-S'
  const l = M.listStandards(M.storeFromList(r))
  const g = l.find((s) => s.key === 'DVB-S')
  return g.label === '中星 DVB-S' && g.modified && sig(g.rows) === sig(C.DVBS_MODCOD_TABLE)
})())

/* ---- ④ 脏数据归一 ---- */
ok('门限口径各种写法都认', ['Eb/N₀', 'eb/n0', 'EbNo', 'ebno'].every((v) => M.normMode(v) === 'ebno') &&
  ['Es/N₀', 'es/n0', 'EsNo', '', null, '随便写'].every((v) => M.normMode(v) === 'esno'))
ok('整行空白丢弃、有内容的行保留', (() => {
  const rows = M.normalizeRows([{}, { label: '', modulation: '', fec: '' }, { modulation: 'QPSK', fec: '3/4' }])
  return rows.length === 1 && rows[0].label === 'QPSK 3/4'
})())
ok('门限缺失不丢行（按 0 dB 落库）', (() => {
  const rows = M.normalizeRows([{ label: 'X', modulation: '8PSK', fec: '2/3' }])
  return rows.length === 1 && rows[0].threshold === 0 && rows[0].bandwidthFactor === 1.2 && rows[0].noiseRatioMode === 'esno'
})())
ok('调制方式规范化：大小写/空白都认，吐规范写法', (() => {
  const r = M.normalizeRow({ label: 'x', modulation: ' 16apsk ', fec: '3/4' })
  return r && r.modulation === '16APSK'
})())
ok('★ 调制方式认不出 → 整行丢弃（不落成默认 QPSK 让引擎按 2 bit/符号静默算）', (() => {
  for (const bad of ['乱写', '6PSK', '8APSK', '2QAM', 'QPSK2']) {
    if (M.normalizeRow({ label: 'x', modulation: bad, fec: '3/4' }) !== null) return false
  }
  return M.normalizeRows([{ label: 'a', modulation: 'QPSK', fec: '1/2' }, { label: 'b', modulation: '乱写', fec: '1/2' }]).length === 1
})())
ok('调制方式留空仍按 QPSK 兜底（先铺码率、调制待定是常见做法）',
  M.normalizeRow({ label: 'x', fec: '3/4' }).modulation === 'QPSK')
ok('自定义阶数（1024QAM）落得进来', (() => {
  const r = M.normalizeRow({ label: 'x', modulation: '1024QAM', fec: '5/6' })
  return r && r.modulation === '1024QAM'
})())
ok('字符串数字转数字（Excel 里被存成文本的那种）', (() => {
  const r = M.normalizeRow({ label: 'X', modulation: 'QPSK', fec: '1/2', bandwidthFactor: '1.05', threshold: ' -1.20 ' })
  return r.bandwidthFactor === 1.05 && r.threshold === -1.2
})())

/* ---- ⑤ 自定义标准 ---- */
const withUser = M.storeFromList([...base, { key: '', label: '我的体制', rows: [{ label: 'A', modulation: 'QPSK', fec: '1/2', threshold: 3 }] }])
ok('自定义标准分到 usr: 前缀的 key', withUser.custom.length === 1 && M.isUserKey(withUser.custom[0].key), withUser.custom[0] && withUser.custom[0].key)
ok('自定义标准接在内置之后、builtin=false', (() => {
  const l = M.listStandards(withUser)
  return l.length === 7 && l[6].label === '我的体制' && l[6].builtin === false
})())
ok('自定义 key 不与内置撞车、彼此不撞车', (() => {
  const st = M.storeFromList([...base,
    { key: 'DVB-S2', label: '假冒内置', rows: [] },   // 已被前面的真 DVB-S2 占了 key，只能另分
    { key: 'usr:1', label: 'A', rows: [{ label: 'a', modulation: 'QPSK', fec: '1/2' }] },
    { key: 'usr:1', label: 'B', rows: [{ label: 'b', modulation: 'QPSK', fec: '1/2' }] }])
  const keys = st.custom.map((c) => c.key)
  return new Set(keys).size === keys.length && keys.every((k) => M.isUserKey(k))
})())
ok('坏存档（半截/类型不对）按「没改过」处理，不抛', (() => {
  for (const bad of [undefined, null, 0, 'x', [], { overrides: 3 }, { overrides: { 'DVB-S2': {} }, custom: 'x' }]) {
    const l = M.listStandards(bad)
    if (l.length !== 6 || sig(l[0].rows) !== sig(C.DVBS_MODCOD_TABLE)) return false
  }
  return true
})())

/* ---- 面板出参 ---- */
const opt = core.basebandOptions(withUser)
ok('basebandOptions：下拉首项恒是「自定义」', opt.dvbStandards[0].value === 'custom')
ok('basebandOptions：下拉与 MODCOD 表键一一对应',
  opt.dvbStandards.slice(1).every((o) => Array.isArray(opt.modcod[o.value])) &&
  Object.keys(opt.modcod).length === opt.dvbStandards.length - 1)
ok('basebandOptions 不传存档 = 纯内置表（与改动前逐值相同）',
  sig(core.basebandOptions().modcod['DVB-S2X']) === sig(C.DVBS2X_MODCOD_TABLE))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
