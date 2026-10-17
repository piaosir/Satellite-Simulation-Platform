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
// 名字按显示名比（自动名现拼）：内置表里等于自动名的 label 归一后是 ''，显示出来仍是 'QPSK 1/4'
const sig = (rows) => JSON.stringify(rows.map((r) => [M.labelOf(r), r.modulation, r.fec, r.rsCode, r.bandwidthFactor, r.noiseRatioMode, r.threshold]))

/* ---- ① 空改写层 = 内置表逐值相同 ---- */
const BUILTIN_SRC = {
  'DVB-S': C.DVBS_MODCOD_TABLE, 'DVB-S2': C.DVBS2_MODCOD_TABLE, 'DVB-RCS2': C.DVB_RCS2_MODCOD_TABLE,
  'DVB-S2X': C.DVBS2X_MODCOD_TABLE, 'DVB-S2X Short': C.DVBS2X_SHORT_MODCOD_TABLE,
  'DVB-S2X VL-SNR Medium': C.DVBS2X_MEDIUM_MODCOD_TABLE, '3GPP NR-NTN': C.NR_NTN_MODCOD_TABLE,
  '3GPP NR-NTN T2': C.NR_NTN_T2_MODCOD_TABLE, '3GPP NR-NTN T3': C.NR_NTN_T3_MODCOD_TABLE,
  '3GPP NR-NTN TP1': C.NR_NTN_TP1_MODCOD_TABLE, '3GPP NR-NTN TP2': C.NR_NTN_TP2_MODCOD_TABLE,
  '3GPP NB-IoT NTN': C.NB_IOT_NTN_MODCOD_TABLE,
  '3GPP NB-IoT NTN NPUSCH MT': C.NB_IOT_NTN_MT_MODCOD_TABLE,
  '3GPP NB-IoT NTN NPUSCH ST': C.NB_IOT_NTN_ST_MODCOD_TABLE
}
const base = M.listStandards(null)
// 2026-09-05：3GPP 由两张表扩到八张（NR 的 MCS 表 1/2/3 + PUSCH 变换预编码表 1/2，NB-IoT 的
// NPDSCH + NPUSCH 多音/单音），故 6 → 12。两个老 key 的字面仍不许动（老配置按它取表）。
// 2026-10-17：DVB-S2X 短帧（EN 302 307-2 表 20c）与 VL-SNR 中帧（表 20b）各成一张表，12 → 14。
ok('内置标准共 14 个且顺序与 DVB_STANDARD_OPTIONS 一致',
  base.length === 14 && base.every((s, i) => s.key === C.DVB_STANDARD_OPTIONS[i + 1].value),
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
ok('整行空白丢弃、有内容的行保留（名字留空 = 自动名）', (() => {
  const rows = M.normalizeRows([{}, { label: '', modulation: '', fec: '' }, { modulation: 'QPSK', fec: '3/4' }])
  return rows.length === 1 && rows[0].label === '' && M.labelOf(rows[0]) === 'QPSK 3/4'
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
  for (const bad of ['乱写', '6PSK', '4APSK', '2QAM', 'QPSK2']) {
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

/* ---- ④b 名称：自动名 vs 自定义名 ---- */
ok('★ 等于自动名的 label 收成空串（改调制/码率后名字跟着走），按归一化后的调制比', (() => {
  const a = M.normalizeRow({ label: 'QPSK 3/4', modulation: 'qpsk', fec: '3/4' })
  const b = M.normalizeRow({ label: '  16APSK 2/3 ', modulation: '16apsk', fec: '2/3' })
  return a.label === '' && b.label === '' && M.labelOf(a) === 'QPSK 3/4' && M.labelOf(b) === '16APSK 2/3'
})())
ok('自定义名原样保留', (() => {
  const r = M.normalizeRow({ label: '低速档 QPSK 1/2', modulation: 'QPSK', fec: '1/2' })
  return r.label === '低速档 QPSK 1/2' && M.labelOf(r) === '低速档 QPSK 1/2'
})())
ok('内置 DVB 六表的名字＝ETSI 规范名：与自动名相同的收成自动名，-L / BPSK-S 档是自定义名；3GPP 各表带序号故是自定义名', (() => {
  const dvb = base.filter((s) => s.key.indexOf('DVB') === 0)
  const g3 = base.filter((s) => s.key.indexOf('3GPP') === 0)
  const special = (r) => /-L$/.test(r.label) || /^BPSK-S /.test(r.label)
  return dvb.length === 6 && dvb.every((s) => s.rows.every((r) => (r.label === '') !== special(r))) &&
    base.find((s) => s.key === 'DVB-S2X').rows.filter((r) => /-L$/.test(r.label)).length === 13 &&
    g3.length === 8 && g3.every((s) => s.rows.every((r) => r.label !== ''))
})())
ok('modcodMap / basebandOptions 出给消费方的行名字已填好', (() => {
  const rows = M.modcodMap(null)['DVB-S2']
  const opt = core.basebandOptions().modcod['DVB-S2']
  return rows[0].label === 'QPSK 1/4' && opt[0].label === 'QPSK 1/4' && opt.every((r) => r.label)
})())
ok('改名成自动名再存 → 与内置表相同、不算改写', (() => {
  const r = JSON.parse(JSON.stringify(base))
  r.find((s) => s.key === 'DVB-S2').rows[0].label = 'QPSK 1/4'
  return Object.keys(M.storeFromList(r).overrides).length === 0
})())
ok('改成自定义名 → 算改写、往返保留', (() => {
  const r = JSON.parse(JSON.stringify(base))
  r.find((s) => s.key === 'DVB-S2').rows[0].label = '最低档'
  const l = M.listStandards(M.storeFromList(r))
  const s2 = l.find((s) => s.key === 'DVB-S2')
  return s2.modified && s2.rows[0].label === '最低档' && M.labelOf(s2.rows[0]) === '最低档' && s2.rows[1].label === ''
})())

/* ---- ④c 扩频增益：只随 Es/N₀ 行走 ---- */
ok('esno 行保留 m（字符串数字也认）、缺省 1、< 1 一律 1', (() => {
  const a = M.normalizeRow({ modulation: 'QPSK', fec: '1/5', noiseRatioMode: 'esno', threshold: -9.9, m: '2' })
  const b = M.normalizeRow({ modulation: 'QPSK', fec: '1/5', noiseRatioMode: 'esno', threshold: -2.85 })
  const c = M.normalizeRow({ modulation: 'QPSK', fec: '1/5', noiseRatioMode: 'esno', threshold: 0, m: 0.5 })
  return a.m === 2 && b.m === 1 && c.m === 1
})())
ok('★ ebno / snr 行的 m 强制为 1（门限与扩频无关，扩频是载波参数）', (() => {
  const a = M.normalizeRow({ modulation: 'QPSK', fec: '3/4', noiseRatioMode: 'ebno', threshold: 5.5, m: 4 })
  const b = M.normalizeRow({ modulation: 'QPSK', fec: '120/1024', noiseRatioMode: 'snr', threshold: -6, m: 4 })
  return a.m === 1 && b.m === 1
})())
ok('内置表各行 m 均为 1，只有 DVB-S2X 短帧的 BPSK-S 两档为 2（扩频因子 2，门限与之成对）',
  base.every((s) => s.rows.every((r) => r.m === (/^BPSK-S /.test(r.label) ? 2 : 1))) &&
  base.find((s) => s.key === 'DVB-S2X Short').rows.filter((r) => r.m === 2).length === 2)
ok('改 esno 行的 m 算改写、往返不漂', (() => {
  const r = JSON.parse(JSON.stringify(base))
  r.find((s) => s.key === 'DVB-S2X').rows[0].m = 2
  const st = M.storeFromList(r)
  const s2x = M.listStandards(st).find((s) => s.key === 'DVB-S2X')
  return Object.keys(st.overrides).join(',') === 'DVB-S2X' && s2x.modified && s2x.rows[0].m === 2 && s2x.rows[1].m === 1
})())
ok('给 ebno 行填 m 不算改写（归一后与内置表相同）', (() => {
  const r = JSON.parse(JSON.stringify(base))
  r.find((s) => s.key === 'DVB-S').rows[0].m = 8
  return Object.keys(M.storeFromList(r).overrides).length === 0
})())
ok('老存档（行里没有 m / 名字写满）读进来与新口径一致', (() => {
  const old = { version: 1, overrides: { 'DVB-S2': { rows: C.DVBS2_MODCOD_TABLE.map((x) => Object.assign({}, x)) } }, custom: [] }
  const l = M.listStandards(old)
  const s2 = l.find((s) => s.key === 'DVB-S2')
  return !s2.modified && s2.rows.every((r) => r.m === 1 && r.label === '')
})())

/* ---- ⑤ 自定义标准 ---- */
const withUser = M.storeFromList([...base, { key: '', label: '我的体制', rows: [{ label: 'A', modulation: 'QPSK', fec: '1/2', threshold: 3 }] }])
ok('自定义标准分到 usr: 前缀的 key', withUser.custom.length === 1 && M.isUserKey(withUser.custom[0].key), withUser.custom[0] && withUser.custom[0].key)
ok('自定义标准接在内置之后、builtin=false', (() => {
  const l = M.listStandards(withUser)
  return l.length === 15 && l[14].label === '我的体制' && l[14].builtin === false
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
    if (l.length !== 14 || sig(l[0].rows) !== sig(C.DVBS_MODCOD_TABLE)) return false
  }
  return true
})())

/* ---- ⑥ 存档 v1 → v2：DVB-S2 / S2X 改由 ETSI 原表生成后的三方合并（2026-10-17）---- */
// v1 改写层存的是整表：原样沿用的话，改过一格的用户永远吃不到门限订正与新增的 -L 档。
const v1Row = ([n, t]) => { const sp = n.indexOf(' '); return { label: n, modulation: n.slice(0, sp), fec: n.slice(sp + 1), rsCode: '0.9', bandwidthFactor: 1.05, noiseRatioMode: 'esno', threshold: t } }
const v1Table = (key) => M.LEGACY_V1[key].map(v1Row)
const lst = (store, key) => M.listStandards(store).find((s) => s.key === key)
const rowOf = (s, name) => s.rows.find((r) => M.labelOf(r) === name)
ok('v1 快照与 2026-10-17 前的内置表同形（S2 28 档 / S2X 60 档）',
  M.LEGACY_V1['DVB-S2'].length === 28 && M.LEGACY_V1['DVB-S2X'].length === 60)
ok('★ v1 里原样存着的整张 S2X（没动过一格）→ 迁成本版内置表、不算改写、再存即清空', (() => {
  const st = { version: 1, overrides: { 'DVB-S2X': { rows: v1Table('DVB-S2X') } }, custom: [] }
  const s = lst(st, 'DVB-S2X')
  return !s.modified && sig(s.rows) === sig(C.DVBS2X_MODCOD_TABLE) && Object.keys(M.storeFromList(M.listStandards(st)).overrides).length === 0
})())
{
  const rows = v1Table('DVB-S2X')
  rows.find((r) => r.label === 'QPSK 3/4').threshold = 4.5            // 用户实测改过的一格
  rows.find((r) => r.label === '64APSK 32/45').threshold = 14.2       // 丢了 -L 的那档也改过
  rows.splice(rows.findIndex((r) => r.label === 'QPSK 11/20'), 1)     // 用户删掉的一档
  rows.splice(5, 0, { label: '厂家 QPSK 1/2', modulation: 'QPSK', fec: '1/2', threshold: 0.8 })   // 插在真档前面的同调制同码率自建档
  const s = lst({ version: 1, overrides: { 'DVB-S2X': { rows } }, custom: [] }, 'DVB-S2X')
  ok('★ 改写不丢：用户改过的格保留用户值', rowOf(s, 'QPSK 3/4').threshold === 4.5)
  ok('★ 旧名认到新名：64APSK 32/45 → 64APSK 32/45-L，用户值 14.2 保留',
    !!rowOf(s, '64APSK 32/45-L') && rowOf(s, '64APSK 32/45-L').threshold === 14.2 && !s.rows.some((r) => M.labelOf(r) === '64APSK 32/45'))
  ok('★ 没动过的格吃到订正（QPSK 9/20 0.69 → 0.22、16APSK 3/5 8.38 → 7.80、32APSK 2/3 → 2/3-L 11.10）',
    rowOf(s, 'QPSK 9/20').threshold === 0.22 && rowOf(s, '16APSK 3/5').threshold === 7.8 && rowOf(s, '32APSK 2/3-L').threshold === 11.1)
  ok('本版新增的 7 个 -L 档补进来，硬限幅列随新版', ['8APSK 5/9-L', '8APSK 26/45-L', '16APSK 1/2-L', '16APSK 8/15-L', '16APSK 5/9-L', '16APSK 3/5-L', '16APSK 2/3-L']
    .every((n) => !!rowOf(s, n)) && rowOf(s, '16APSK 3/5').hl === 9.38)
  ok('用户删掉的档不复活', !rowOf(s, 'QPSK 11/20'))
  ok('同调制同码率的自建档与真档各认各的（真档按自动名先认底）',
    rowOf(s, '厂家 QPSK 1/2').threshold === 0.8 && rowOf(s, 'QPSK 1/2').threshold === 1.0 && s.rows.length === 67, String(s.rows.length))
  ok('没调过序 → 按本版次序排，自建档跟在原先的前一行后面', (() => {
    const i = s.rows.findIndex((r) => M.labelOf(r) === '厂家 QPSK 1/2')
    return M.labelOf(s.rows[i - 1]) === 'QPSK 2/5' && M.labelOf(s.rows[0]) === 'QPSK 2/9' && M.labelOf(s.rows[1]) === 'QPSK 1/4'
  })(), s.rows.slice(0, 8).map((r) => M.labelOf(r)).join(' | '))
  ok('迁移后算改写（有用户值）', s.modified)
}
ok('调过序的表保留用户次序，新增档插在本版里它前一档的后面', (() => {
  const rows = v1Table('DVB-S2X'); rows.unshift(rows.pop())   // 用户把 256APSK 3/4 挪到最前
  const s = lst({ version: 1, overrides: { 'DVB-S2X': { rows } } }, 'DVB-S2X')
  const i = s.rows.findIndex((r) => M.labelOf(r) === '8APSK 5/9-L')
  return M.labelOf(s.rows[0]) === '256APSK 3/4' && M.labelOf(s.rows[i - 1]) === 'QPSK 9/10' && s.rows.length === 67
})())
ok('DVB-S2：改过的滚降保留、没改的门限吃到订正（QPSK 1/4 −1.20 → −2.35）', (() => {
  const rows = v1Table('DVB-S2'); rows[0].bandwidthFactor = 1.2
  const s = lst({ version: 1, overrides: { 'DVB-S2': { rows } } }, 'DVB-S2')
  return s.rows[0].bandwidthFactor === 1.2 && s.rows[0].threshold === -2.35 && s.rows[1].threshold === -1.24 && s.rows[2].threshold === -0.3
})())
ok('存档版本号升到 2；v2 档不再迁移（同一份行原样读回）', (() => {
  const v1 = M.normalizeStore({ version: 1, overrides: { 'DVB-S2': { rows: v1Table('DVB-S2') } } })
  const v2 = M.normalizeStore({ version: 2, overrides: { 'DVB-S2': { rows: v1Table('DVB-S2') } } })
  return v1.version === 2 && v1.overrides['DVB-S2'].rows[0].threshold === -2.35 && v2.overrides['DVB-S2'].rows[0].threshold === -1.2 &&
    M.storeFromList(M.listStandards(null)).version === 2
})())
ok('迁移幂等：迁过的档再规整一遍不变', (() => {
  const rows = v1Table('DVB-S2X'); rows[3].threshold = -0.5
  const a = M.normalizeStore({ version: 1, overrides: { 'DVB-S2X': { rows } } })
  return JSON.stringify(M.normalizeStore(a)) === JSON.stringify(a)
})())
ok('其它内置表的 v1 改写不受迁移影响', (() => {
  const rows = M.builtinRows('DVB-RCS2'); rows[0] = Object.assign({}, rows[0], { threshold: -0.5 })
  return lst({ version: 1, overrides: { 'DVB-RCS2': { rows } } }, 'DVB-RCS2').rows[0].threshold === -0.5
})())

/* ---- ⑦ 载波配置里早先套用进来的门限（资源库就地迁移）---- */
const s2xIdx = (n) => M.listStandards(null).find((s) => s.key === 'DVB-S2X').rows.findIndex((r) => M.labelOf(r) === n)
const cf = (o) => Object.assign({ dvbStandard: 'DVB-S2X', modulation: 'QPSK', fec: '9/20', ebno: '0.69', noiseRatioMode: 'esno', m: '1', modcodLabel: 'QPSK 9/20', modcodIndex: 5 }, o)
ok('★ 套用 v1 表值、没手改过 → 门限换成原表值（行号本就对得上就不动）', (() => {
  const p = M.migrateCarrierForm(cf())
  return p && p.ebno === '0.22' && p.modcodIndex === undefined && s2xIdx('QPSK 9/20') === 5 && p.modcodLabel === undefined
})())
ok('行号随本版表挪了的档（16APSK 3/5：v1 第 26 行）→ 门限 8.38 → 7.80、行号对到本版', (() => {
  const p = M.migrateCarrierForm(cf({ modulation: '16APSK', fec: '3/5', ebno: '8.38', modcodLabel: '16APSK 3/5', modcodIndex: 25 }))
  return p && p.ebno === '7.80' && p.modcodIndex === s2xIdx('16APSK 3/5') && p.modcodIndex !== 25
})())
ok('丢了 -L 的档：门限本就对、只换规范名', (() => {
  const p = M.migrateCarrierForm(cf({ modulation: '64APSK', fec: '32/45', ebno: '13.98', modcodLabel: '64APSK 32/45', modcodIndex: 47 }))
  return p && p.ebno === undefined && p.modcodLabel === '64APSK 32/45-L' && p.modcodIndex === s2xIdx('64APSK 32/45-L')
})())
ok('★ 手改过的门限（与 v1 表值不同）一律不动', M.migrateCarrierForm(cf({ ebno: '0.80' })) === null)
ok('DVB-S2 QPSK 1/4：−1.20 → −2.35', (() => { const p = M.migrateCarrierForm(cf({ dvbStandard: 'DVB-S2', fec: '1/4', ebno: '-1.20', modcodLabel: '' })); return p && p.ebno === '-2.35' && p.modcodLabel === 'QPSK 1/4' })())
ok('别的标准 / Eb/N₀ 口径 / 扩频载波 / 迁过的载波都不碰',
  M.migrateCarrierForm(cf({ dvbStandard: 'DVB-S' })) === null && M.migrateCarrierForm(cf({ noiseRatioMode: 'ebno' })) === null &&
  M.migrateCarrierForm(cf({ m: '2' })) === null && M.migrateCarrierForm(Object.assign(cf(), M.migrateCarrierForm(cf()))) === null)
ok('用户起了别名的档：门限照订正，名字不碰', (() => {
  const p = M.migrateCarrierForm(cf({ modcodLabel: '低速档' }))
  return p && p.ebno === '0.22' && p.modcodLabel === undefined && p.modcodIndex === undefined
})())

/* ---- ⑦b 主进程读库 / 读端到端配置时就地迁移（electron/services/storage.js）---- */
{
  const fs = require('fs'), os = require('os'), path = require('path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'satsim-mc-'))
  process.env.SATSIM_DATA_DIR = dir
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({
    geo: { carrier: [{ id: 'bb1', form: cf({ dvbStandard: 'DVB-S2', fec: '1/4', ebno: '-1.20', modcodLabel: 'QPSK 1/4', modcodIndex: 0 }) },
      { id: 'bb2', form: cf({ ebno: '0.80' }) }] }
  }))
  fs.writeFileSync(path.join(dir, 'configs.e2e.json'), JSON.stringify([
    { id: 'e1', name: '链', state: { orbitType: 'E2E', chains: [{ nodes: [{ kind: 'es', carrier: cf() }, { kind: 'sat' }] }] } }
  ]))
  delete require.cache[require.resolve('../../../electron/services/storage.js')]
  const storage = require('../../../electron/services/storage.js')
  const lib = storage.getLibrary('geo')
  ok('读资源库：套用 v1 表值的载波门限订正（S2 QPSK 1/4 −1.20 → −2.35），手改过的不动',
    lib.carrier[0].form.ebno === '-2.35' && lib.carrier[1].form.ebno === '0.80')
  const e2e = storage.listConfigs('e2e')
  ok('读端到端配置：链节点上的载波同样订正（S2X QPSK 9/20 0.69 → 0.22）', e2e[0].state.chains[0].nodes[0].carrier.ebno === '0.22')
  ok('读不改盘（窗口存库 / 存场景时才落盘）',
    JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8')).geo.carrier[0].form.ebno === '-1.20')
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清不掉无妨 */ }
}

/* ---- ⑧ 出给消费方的 DVB 行附 ETSI 出处（SLA 丢包率按它取判据与帧长）---- */
{
  const mm = M.modcodMap(null)
  const r = (k, n) => mm[k].find((x) => x.label === n)
  ok('DVB-S2 行：表 13、PER 10⁻⁷、64800', r('DVB-S2', 'QPSK 1/4').qef === 'PER' && r('DVB-S2', 'QPSK 1/4').qefExp === 7 && r('DVB-S2', 'QPSK 1/4').frameBits === 64800 &&
    r('DVB-S2', 'QPSK 1/4').etsiTable === 'ETSI EN 302 307-1 V1.4.1 表 13')
  ok('DVB-S2X 行：S2X 档表 20a FER 10⁻⁵、S2 遗留档表 13 PER 10⁻⁷、QPSK 2/9 帧长 61560',
    r('DVB-S2X', '16APSK 2/3-L').qefExp === 5 && r('DVB-S2X', '16APSK 2/3').qefExp === 7 && r('DVB-S2X', 'QPSK 2/9').frameBits === 61560 &&
    r('DVB-S2X', '16APSK 2/3-L').etsiTable === 'ETSI EN 302 307-2 V1.4.1 表 20a')
  ok('短帧 / 中帧：FER 10⁻⁵，帧长 16200（BPSK-S 15390、BPSK 1/5 短帧 14976）/ 30780',
    r('DVB-S2X Short', 'QPSK 11/45').frameBits === 16200 && r('DVB-S2X Short', 'BPSK-S 1/5').frameBits === 15390 &&
    r('DVB-S2X Short', 'BPSK 1/5').frameBits === 14976 && r('DVB-S2X VL-SNR Medium', 'BPSK 1/5').frameBits === 30780 &&
    r('DVB-S2X VL-SNR Medium', 'BPSK 1/3').qefExp === 5)
  ok('非 S2/S2X 标准的行不附出处', mm['DVB-RCS2'].every((x) => x.qefExp === undefined) && mm['3GPP NR-NTN'].every((x) => x.qefExp === undefined))
}

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
