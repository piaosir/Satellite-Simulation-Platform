// 标准台账（packages/core/data/standards.json）与两份报告的参考文献自测。运行：npm test
//
// 锁定（差距分析 C-06，2026-10-17）：
//   ① 台账字段齐全：编号、版本、实现条款、数据版本、ValEx 状态（达标 / 已知偏差 / 未实现 / null = ValEx 无此表），编号唯一；
//   ② 链路预算报告只列【本次计算实际用到的方法】：P.453-14 与 P.372-16 不再出现；§8 只在 NGSO / 再生式；
//      无线电规则组只在出落地 PFD 限值时；轨道组只在 NGSO / 再生式 / 端到端；体制组按各链路载波的标准取；
//      P.2041-1 只在有机载终端时；再生式只装星间 / 激光模块时整组传播不出；
//   ③ 版本串是实际依据的那一版（EN 302 307-1 / -2 V1.4.1、EN 301 545-2 V1.5.1），旧的 V1.3.1 / V1.2.1 不再出现；
//   ④ SLA 报告的引用标准同一份台账：不列 P.453-14，DVB 拆成 -1 / -2 两份，月口径才有 P.841-6，编号不重复；
//   ⑤ buildReportModel 端到端：链路载波键 → 方法学 ② 的体制组。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..').split(path.sep).join('/')
const require = createRequire(ROOT + '/package.json')
const J = require(ROOT + '/packages/core/data/standards.json')
const { reportRefGroups, slaRefList, lbConditions, useText, STANDARDS } = await import('file:///' + ROOT + '/src/shared/stdLedger.js')
const { buildReportModel, methodology, schemeOf, usedStandards } = await import('file:///' + ROOT + '/src/shared/lbReport.js')
const { slaRefs } = await import('file:///' + ROOT + '/src/shared/lbSlaReport.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const ids = (groups) => groups.flatMap((g) => g.items.map((i) => i.id))
const grp = (groups, zh) => groups.find((g) => g.group === zh)
const DVB_S2X = { dvbS2: true, dvbS2x: true, rcs2: false, nr: false, nbiot: false, airborne: false }

/* ---- ① 台账字段 ---- */
const VALEX = new Set(['达标', '已知偏差', '未实现', null])
const LB_WHEN = new Set(['ground', 'pfd', 'airborne', 'orbit', 'dvbS2', 'dvbS2x', 'rcs2', 'nr', 'nbiot'])
const SLA_WHEN = new Set(['always', 'monthly', 'dvb', 'ntn'])
ok('每条都有编号 / 版本 / 名称（中英）/ 实现条款 / 数据版本字段 / ValEx 状态，且取值合法',
  STANDARDS.every((s) => s.id && typeof s.version === 'string' && s.title && s.title.zh && s.title.en &&
    Array.isArray(s.clauses) && s.clauses.length && s.clauses.every((c) => c.zh && c.en && VALEX.has(c.valex === undefined ? null : c.valex)) &&
    'dataVersion' in s && VALEX.has(s.valex) && s.report && typeof s.report === 'object' &&
    (!s.report.lb || LB_WHEN.has(s.report.lb)) && (!s.report.sla || SLA_WHEN.has(s.report.sla))),
  STANDARDS.filter((s) => !(s.id && s.title && Array.isArray(s.clauses))).map((s) => s.id).join(','))
ok('编号唯一', new Set(STANDARDS.map((s) => s.id)).size === STANDARDS.length)
ok('P.453-14 / P.372-16 在台账里记为「未实现」、不进任何报告', ['ITU-R P.453-14', 'ITU-R P.372-16'].every((id) => {
  const s = STANDARDS.find((x) => x.id === id); return s && s.valex === '未实现' && !s.report.lb && !s.report.sla
}))
ok('ValEx 状态与差距分析一致：P.838-3 / P.839-4 / P.837-7 达标，P.618-14 / P.676-13 / P.836-6 / P.840-9 已知偏差',
  ['ITU-R P.838-3', 'ITU-R P.839-4', 'ITU-R P.837-7'].every((id) => STANDARDS.find((s) => s.id === id).valex === '达标') &&
  ['ITU-R P.618-14', 'ITU-R P.676-13', 'ITU-R P.836-6', 'ITU-R P.840-9'].every((id) => STANDARDS.find((s) => s.id === id).valex === '已知偏差'))

/* ---- ② 链路预算报告：只列实际用到的 ---- */
const geo = reportRefGroups({ orbitType: 'GEO', used: DVB_S2X }, 'zh')
// P.835 写 -7：itu/p835.js（C-01）实现的是 P.835-7 附件 1 参考大气（与 -6 同式），版本号对得上引擎那一版
ok('GSO：传播组 = P.618-14 / P.676-13 / P.837-7 / P.838-3 / P.839-4 / P.840-9 / P.836-6 / P.835-7（无 P.453、无 P.2041）',
  grp(geo, '传播与衰减').items.map((i) => i.id).join(',') === 'ITU-R P.618-14,ITU-R P.676-13,ITU-R P.837-7,ITU-R P.838-3,ITU-R P.839-4,ITU-R P.840-9,ITU-R P.836-6,ITU-R P.835-7',
  grp(geo, '传播与衰减').items.map((i) => i.id).join(','))
ok('「噪声与系统」组（P.372-16）整组撤掉', !geo.some((g) => g.group === '噪声与系统') && !ids(geo).some((x) => /P\.372|P\.453/.test(x)))
const p618 = (g) => grp(g, '传播与衰减').items.find((i) => i.id === 'ITU-R P.618-14').use
ok('GSO 的 P.618-14 用途：§2.2 雨衰、§2.4.1 闪烁（N_wet 常数）、§2.5、§3 式(69)(70)、§4.1 XPD，不含 §8',
  /§2\.2 雨衰/.test(p618(geo)) && /§2\.4\.1 对流层闪烁（N_wet 取常数，不用 P\.453 地图）/.test(p618(geo)) && /§2\.5/.test(p618(geo)) &&
  /§3 式\(69\)\(70\) 天空噪声温度/.test(p618(geo)) && /§4\.1 雨致去极化 XPD/.test(p618(geo)) && !/§8/.test(p618(geo)), p618(geo))
ok('P.676-13 用途 = 附件 1 逐线法比衰减 + 附件 2 斜路径与柱水汽法；P.836-6 = 多概率图；P.840-9 = 式(14) K_L + §3.3 统计', (() => {
  const u = (id) => grp(geo, '传播与衰减').items.find((i) => i.id === id).use
  return /附件 1 逐线法比衰减/.test(u('ITU-R P.676-13')) && /附件 2 斜路径气体衰减与柱水汽法/.test(u('ITU-R P.676-13')) &&
    /多概率数字图/.test(u('ITU-R P.836-6')) && /式\(14\)/.test(u('ITU-R P.840-9')) && /§3\.3/.test(u('ITU-R P.840-9'))
})())
ok('GSO 列无线电规则组（RR Art.21 Table 21-4（RR 2024）+ 区域划分），不列轨道组',
  ids(grp(geo, '无线电规则').items ? [grp(geo, '无线电规则')] : []).join(',') === 'RR Art.21 Table 21-4（RR 2024）,RR No.5.3–5.9（RR 2024）' && !grp(geo, '轨道与时空基准'))
ok('GSO + DVB-S2X 载波：体制组只列 EN 302 307-1 V1.4.1 与 -2 V1.4.1',
  grp(geo, '体制与通信标准').items.map((i) => i.id).join(',') === 'ETSI EN 302 307-1 V1.4.1 (2014-11),ETSI EN 302 307-2 V1.4.1 (2024-08)')
const ngso = reportRefGroups({ orbitType: 'NGSO', used: DVB_S2X }, 'zh')
ok('NGSO：P.618-14 用途带 §8，列轨道组与无线电规则组', /§8 非静止轨道链路的时间百分比统计/.test(p618(ngso)) && !!grp(ngso, '轨道与时空基准') && !!grp(ngso, '无线电规则'))
const e2e = reportRefGroups({ orbitType: 'E2E', used: DVB_S2X }, 'zh')
ok('端到端：有传播组但 P.618 不带 §8，不列无线电规则（级联台账不出 PFD 限值），列轨道组',
  !!grp(e2e, '传播与衰减') && !/§8/.test(p618(e2e)) && !grp(e2e, '无线电规则') && !!grp(e2e, '轨道与时空基准'))
ok('再生式只装星间 / 激光：传播组与无线电规则组都不出', (() => {
  const g = reportRefGroups({ orbitType: 'REGEN', regenModes: ['isl', 'laser'], used: DVB_S2X }, 'zh')
  return !grp(g, '传播与衰减') && !grp(g, '无线电规则') && !!grp(g, '轨道与时空基准')
})())
ok('再生式上行：有传播（带 §8）、无 PFD 限值；装了下行才列无线电规则', (() => {
  const up = reportRefGroups({ orbitType: 'REGEN', regenModes: ['uplink'], used: DVB_S2X }, 'zh')
  const dn = reportRefGroups({ orbitType: 'REGEN', regenModes: ['uplink', 'downlink'], used: DVB_S2X }, 'zh')
  return /§8/.test(p618(up)) && !grp(up, '无线电规则') && !!grp(dn, '无线电规则')
})())
ok('有机载终端才列 P.2041-1', (() => {
  const g = reportRefGroups({ orbitType: 'GEO', used: Object.assign({}, DVB_S2X, { airborne: true }) }, 'zh')
  return ids(g).includes('ITU-R P.2041-1') && !ids(geo).includes('ITU-R P.2041-1')
})())
ok('NB-IoT 载波：只列 36.xxx 那几份与 Kodheli；不列 DVB 与 NR', (() => {
  const g = reportRefGroups({ orbitType: 'NGSO', used: { nbiot: true } }, 'zh')
  const a = grp(g, '体制与通信标准').items.map((i) => i.id)
  return a.join(',') === '3GPP TS 36.213 / TR 36.763,3GPP TS 36.102,3GPP TS 36.211,Kodheli et al., AdHoc-Now 2019'
})())
ok('DVB-RCS2 载波：列 EN 301 545-2 V1.5.1（用途只说调制与码率档位）', (() => {
  const g = reportRefGroups({ orbitType: 'GEO', used: { rcs2: true } }, 'zh')
  const it = grp(g, '体制与通信标准').items
  return it.length === 1 && it[0].id === 'ETSI EN 301 545-2 V1.5.1 (2026-04)' && /调制与码率/.test(it[0].use)
})())
ok('载波未知（链路没带标准键）：按改前口径列 DVB-S2/S2X 与 3GPP 两族，不列 RCS2', (() => {
  const a = ids(reportRefGroups({ orbitType: 'GEO', used: null }, 'zh'))
  return a.includes('ETSI EN 302 307-2 V1.4.1 (2024-08)') && a.includes('3GPP TS 38.214') && a.includes('3GPP TS 36.211') && !a.some((x) => /301 545/.test(x))
})())
ok('英文版：组名 / 名称 / 用途换成英文，RR 编号用英文写法', (() => {
  const g = reportRefGroups({ orbitType: 'GEO', used: DVB_S2X }, 'en')
  const all = g.flatMap((x) => [x.group, ...x.items.flatMap((i) => [i.id, i.title, i.use])]).join(' ')
  return !/[一-鿿]/.test(all) && ids(g).includes('RR Art.21 Table 21-4 (RR 2024)') && g[0].group === 'Propagation and attenuation'
})())

/* ---- ③ 版本串 ---- */
const everyCombo = ['GEO', 'NGSO', 'REGEN', 'E2E'].flatMap((ot) => [null, DVB_S2X, { rcs2: true, nr: true, nbiot: true, airborne: true }]
  .flatMap((u) => ['zh', 'en'].map((lang) => reportRefGroups({ orbitType: ot, regenModes: ['uplink', 'downlink', 'isl'], used: u }, lang))))
ok('任何组合都不再印旧版本串（EN 302 307-2 V1.3.1、EN 301 545-2 V1.2.1）与笼统的「EN 302 307-1/-2」',
  everyCombo.every((g) => ids(g).every((x) => !/V1\.3\.1|V1\.2\.1|307-1\/-2/.test(x))))
ok('constants.js 的标准注释已改成实际依据的版本', (() => {
  const t = readFileSync(ROOT + '/packages/core/utils/constants.js', 'utf8')
  return !/V1\.3\.1/.test(t) && !/545-2 V1\.2\.1/.test(t) && /EN 302 307-2 V1\.4\.1/.test(t) && /EN 301 545-2 V1\.5\.1/.test(t) && /未核实/.test(t)
})())

/* ---- ④ SLA 报告 ---- */
const sla = (o, lang) => slaRefs(lang || 'zh', o).map((r) => r.id)
ok('SLA：传播那几项恒有，不列 P.453-14', (() => {
  const a = sla({})
  return ['ITU-R P.618-14', 'ITU-R P.676-13', 'ITU-R P.837-7', 'ITU-R P.838-3', 'ITU-R P.839-4', 'ITU-R P.840-9'].every((x) => a.includes(x)) && !a.some((x) => /P\.453/.test(x))
})(), sla({}).join(' | '))
ok('SLA：月口径才有 P.841-6；有 DVB 才有 EN 302 307-1 / -2 V1.4.1 两份；有 NTN 才有 3GPP', (() => {
  const a = sla({}), b = sla({ monthly: 1, hasDvb: true, hasNtn: true })
  return !a.includes('ITU-R P.841-6') && b.includes('ITU-R P.841-6') &&
    b.includes('ETSI EN 302 307-1 V1.4.1 (2014-11)') && b.includes('ETSI EN 302 307-2 V1.4.1 (2024-08)') && !a.some((x) => /302 307/.test(x)) &&
    b.includes('3GPP TS 38.211 / TS 38.214') && b.includes('3GPP TS 36.211') && new Set(b).size === b.length
})())
ok('SLA：S.579-6 / S.1062-4 恒在、排在末尾', (() => { const a = sla({ monthly: 1, hasDvb: true }); return a.slice(-2).join(',') === 'ITU-R S.579-6,ITU-R S.1062-4' })())
ok('SLA 引用表与改前同形 { id, title, use }，英文版无中文', slaRefs('en', { monthly: 1, hasDvb: true, hasNtn: true }).every((r) => r.id && r.title && r.use && !/[一-鿿]/.test(r.id + r.title + r.use)))

/* ---- ⑤ buildReportModel 端到端 ---- */
{
  const L = (keys) => ({ no: 1, rowId: 'r1', txName: 'T', rxName: 'R', ok: true, error: '', data: {}, carrier: { stds: keys, keys } })
  const m1 = buildReportModel({ lang: 'zh', orbitType: 'GEO', links: [L(['DVB-S2'])] })
  const air1 = grp(m1.method.refGroups, '体制与通信标准').items.map((i) => i.id)
  ok('GSO 报告 + DVB-S2 载波：体制组只有 EN 302 307-1 V1.4.1', air1.join(',') === 'ETSI EN 302 307-1 V1.4.1 (2014-11)', air1.join(','))
  const m2 = buildReportModel({ lang: 'zh', orbitType: 'GEO', links: [L(['DVB-S2X Short'])] })
  ok('DVB-S2X 短帧载波：只列 EN 302 307-2 V1.4.1（短帧表 20c 只在 -2）',
    grp(m2.method.refGroups, '体制与通信标准').items.map((i) => i.id).join(',') === 'ETSI EN 302 307-2 V1.4.1 (2024-08)')
  const m3 = buildReportModel({ lang: 'zh', orbitType: 'GEO', links: [L(['custom'])] })
  ok('未套标准（自定义载波）：体制组整组不出', !grp(m3.method.refGroups, '体制与通信标准'))
  ok('usedStandards：链路都没带键 → null；机载看离地高度回显（agl > 0）或 terminalTypeResult（端到端看 hops）', usedStandards([{ data: {} }]) === null &&
    usedStandards([{ data: { terminalTypeResult: 'airborne' }, carrier: { keys: ['DVB-S2X'] } }]).airborne === true &&
    usedStandards([{ data: { hops: [{ terminalTypeResult: 'Airborne' }] }, carrier: { keys: [] } }]).airborne === true &&
    usedStandards([{ data: { uplinkAglResult: '10.2' }, carrier: { keys: [] } }]).airborne === true &&
    usedStandards([{ data: { uplinkAglResult: '0', downlinkAglResult: '0.000' }, carrier: { keys: [] } }]).airborne === false)
  ok('methodology 不传 used 时与 buildReportModel 不带载波键同口径', JSON.stringify(methodology(schemeOf('GEO', 'uplink'), 'zh').refGroups) ===
    JSON.stringify(buildReportModel({ lang: 'zh', orbitType: 'GEO', links: [{ data: {} }] }).method.refGroups))
}
ok('lbConditions 的 pfd 与 lbReport 方法学「落地功率通量密度」那段同一判据（GSO / NGSO / 再生式装下行）',
  lbConditions({ orbitType: 'GEO' }).pfd && lbConditions({ orbitType: 'NGSO' }).pfd && !lbConditions({ orbitType: 'E2E' }).pfd &&
  !lbConditions({ orbitType: 'REGEN', regenModes: ['uplink'] }).pfd && lbConditions({ orbitType: 'REGEN', regenModes: ['downlink'] }).pfd)
ok('useText：条款上的 only 生效、英文首字母大写', /^§2\.2 rain attenuation; /.test(useText(STANDARDS[0], 'GEO', 'en')) && !/§8/.test(useText(STANDARDS[0], 'GEO', 'zh')))
ok('台账声明的更新日期', J.updated === '2026-10-17')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
