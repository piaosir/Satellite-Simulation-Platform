// 官方星历六格式（OMM 的 CSV/JSON/KVN/XML 与 TLE/3LE）解析与序列化的回归网。
// 核心断言是两条“与官方一致”的判据：
//   ① 字节级——内置官方快照 resources/omm/csv_active.csv 解析后再序列化，与原文逐字节相同；
//   ② 规范级——同一批星在六格式间互转，omm2satrec 出来的 satrec 逐位相同（TLE 那条按截断容差）。
// 快照随包分发（见 scripts/fetch-omm-snapshot.mjs），故本测试不联网。

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import zlib from 'node:zlib'

const require = createRequire(import.meta.url)
const F = require('../utils/ommFormats.js')
const sat = require('../vendor/satellite.js')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
let pass = 0, fail = 0
const ok = (cond, msg, extra) => {
  if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) }
}
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}（差 ${Math.abs(a - b)}，容差 ${tol}）`)
const section = (t) => console.log('\n— ' + t)

const readSnapshot = (key) => {
  const gz = path.join(root, 'resources/omm', `csv_${key}.csv.gz`)
  if (fs.existsSync(gz)) return zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8')
  const plain = path.join(root, 'resources/omm', `csv_${key}.csv`)
  return fs.existsSync(plain) ? fs.readFileSync(plain, 'utf8') : null
}
// satrec 的十项特征（含历元），用于逐位比对
const SATKEY = ['no', 'ecco', 'inclo', 'nodeo', 'argpo', 'mo', 'bstar', 'ndot', 'nddot', 'jdsatepoch']
const satKey = (s) => SATKEY.map((k) => s[k]).join('|')

/* ===== ① 数值体例：实测自官方样本的规则 ===== */
section('官方数值体例')
ok(F.sciOfficial(0.00039713338) === '.39713338E-3', 'BSTAR 正数科学体例', F.sciOfficial(0.00039713338))
ok(F.sciOfficial(-0.000002080145) === '-.2080145E-5', 'BSTAR 负数科学体例', F.sciOfficial(-0.000002080145))
ok(F.sciOfficial(0.000004) === '.4E-5', '单位数尾数', F.sciOfficial(0.000004))
ok(F.sciOfficial(0) === '0', '零写作 0', F.sciOfficial(0))
ok(F.sciOfficial(1) === '.1E+1', '尾数进位到 1 时借位', F.sciOfficial(1))
ok(F.officialValue('ECCENTRICITY', 0.00278136) === '.00278136', '偏心率去前导 0', F.officialValue('ECCENTRICITY', 0.00278136))
ok(F.officialValue('INCLINATION', 90.23) === '90.2300', '角度 4 位保尾零', F.officialValue('INCLINATION', 90.23))
ok(F.officialValue('MEAN_MOTION', 13.7667980) === '13.76679809' || F.officialValue('MEAN_MOTION', 13.76679809) === '13.76679809', '平均运动 8 位')
ok(F.officialValue('ECCENTRICITY', '.00278136') === '.00278136', '源串原样搬运（字节级一致的根）')
ok(F.officialEpoch('2026-08-18T00:55:00.137856') === '2026-08-18T00:55:00.137856', '历元已是官方体例则原样')
ok(F.officialEpoch('2026-08-18T00:55:00Z') === '2026-08-18T00:55:00.000000', '历元补 6 位微秒去 Z')

/* ===== ② 字节级：官方快照解析 → 序列化 → 逐字节比对 ===== */
section('官方 CSV 快照字节级回环')
const snap = readSnapshot('active') || readSnapshot('geo') || readSnapshot('stations')
if (!snap) {
  console.error('  ! 缺内置 OMM 快照，跳过字节级回环（跑 npm run omm:snapshot 生成）')
} else {
  const p = F.parseEphemeris(snap)
  ok(p.format === 'omm-csv', '嗅探为 omm-csv', p.format)
  ok(p.records.length > 100, `解析出 ${p.records.length} 颗`)
  ok(p.errors.length === 0, '无解析错误', p.errors[0])
  const out = F.serializeEphemeris(p.records, 'omm-csv')
  ok(out === snap, `${p.records.length} 颗逐字节回环`,
    out === snap ? '' : `长度 ${snap.length} vs ${out.length}`)
}

/* ===== ③ 规范级：六格式互转后 SGP4 逐位一致 ===== */
section('六格式互转')
const geo = readSnapshot('geo') || snap
const base = geo ? F.parseEphemeris(geo).records.slice(0, 300) : []
if (!base.length) {
  console.error('  ! 无样本，跳过互转')
} else {
  const ref = base.map((r) => satKey(sat.omm2satrec(r)))
  for (const fmt of ['omm-csv', 'omm-json', 'omm-kvn', 'omm-xml']) {
    const txt = F.serializeEphemeris(base, fmt)
    const back = F.parseEphemeris(txt)
    ok(back.format === fmt, `${fmt}：自产文本能被自己嗅探回来`, back.format)
    ok(back.records.length === base.length, `${fmt}：条数守恒`, `${back.records.length} vs ${base.length}`)
    let bit = 0
    for (let i = 0; i < Math.min(base.length, back.records.length); i++) {
      if (satKey(sat.omm2satrec(back.records[i])) === ref[i]) bit++
    }
    ok(bit === base.length, `${fmt}：SGP4 逐位一致 ${bit}/${base.length}`)
  }
  // JSON 的数值必须是 JSON number（官方体例），不是字符串
  const j = JSON.parse(F.serializeEphemeris(base.slice(0, 1), 'omm-json'))
  ok(typeof j[0].MEAN_MOTION === 'number' && typeof j[0].NORAD_CAT_ID === 'number', 'JSON 数值字段为 number')
  ok(typeof j[0].OBJECT_NAME === 'string' && typeof j[0].CLASSIFICATION_TYPE === 'string', 'JSON 文本字段为 string')
  // XML/KVN 必须带 CCSDS 规范要求的头与元数据
  const x = F.serializeEphemeris(base.slice(0, 1), 'omm-xml')
  for (const t of ['<ndm', '<omm id="CCSDS_OMM_VERS"', '<header>', '<metadata>', '<meanElements>', '<tleParameters>',
    'REF_FRAME>TEME<', 'TIME_SYSTEM>UTC<', 'MEAN_ELEMENT_THEORY>SGP4<', 'CENTER_NAME>EARTH<']) {
    ok(x.includes(t), `XML 含 ${t}`)
  }
  const k = F.serializeEphemeris(base.slice(0, 1), 'omm-kvn')
  for (const t of ['CCSDS_OMM_VERS =', 'CREATION_DATE =', 'ORIGINATOR =', 'REF_FRAME = TEME',
    'TIME_SYSTEM = UTC', 'MEAN_ELEMENT_THEORY = SGP4', 'CENTER_NAME = EARTH']) {
    ok(k.includes(t), `KVN 含 ${t}`)
  }
}

/* ===== ④ TLE / 3LE ===== */
section('TLE / 3LE')
const TLE3 = '0 ISS (ZARYA)\n' +
  '1 25544U 98067A   26230.54791667  .00016717  00000-0  10270-3 0  9004\n' +
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391 56354\n'
const t3 = F.parseEphemeris(TLE3)
ok(t3.format === '3le', '三行嗅探为 3le', t3.format)
ok(t3.records.length === 1 && t3.errors.length === 0, '解析出 1 颗且无错')
const iss = t3.records[0]
ok(iss.name === 'ISS (ZARYA)', '名称行', iss.name)
ok(iss.noradId === '25544', 'NORAD 编号', iss.noradId)
ok(iss.objectId === '1998-067A', 'COSPAR 转换', iss.objectId)
ok(iss.f.ELEMENT_SET_NO === '900', '取到 ELEMENT_SET_NO', iss.f.ELEMENT_SET_NO)
ok(iss.f.REV_AT_EPOCH === '5635', '取到 REV_AT_EPOCH', iss.f.REV_AT_EPOCH)
ok(iss.f.ECCENTRICITY === '.0006703', '偏心率补前导小数点', iss.f.ECCENTRICITY)
ok(F.serializeEphemeris(t3.records, '3le') === TLE3, '3le 原文逐字节回环')
const TLE2 = TLE3.split('\n').slice(1).join('\n')
const t2 = F.parseEphemeris(TLE2)
ok(t2.format === 'tle', '两行嗅探为 tle', t2.format)
ok(F.serializeEphemeris(t2.records, 'tle') === TLE2, 'tle 原文逐字节回环')
// 校验和错只告警不拒收
const bad = TLE3.replace('0  9004', '0  9009')
const tb = F.parseEphemeris(bad)
ok(tb.records.length === 1, '校验位不符仍收下')
ok(tb.warnings.some((w) => /校验和/.test(w)), '校验位不符发告警')
// 孤行 / 断行
ok(F.parseEphemeris('1 25544U 98067A   26230.54791667  .00016717  00000-0  10270-3 0  9004\n').records.length === 0, '缺第 2 行不产出记录')
// Alpha-5 往返
ok(F.decodeSatnum('T1234') === '271234', 'Alpha-5 解码', F.decodeSatnum('T1234'))
ok(F.encodeSatnum('271234') === 'T1234', 'Alpha-5 编码', F.encodeSatnum('271234'))
ok(F.encodeSatnum('25544') === '25544', '五位编号不动', F.encodeSatnum('25544'))

/* ===== ⑤ OMM → TLE 重建：列宽 / 校验位 / 精度 ===== */
section('OMM → TLE 重建')
if (base.length) {
  const txt = F.serializeEphemeris(base, '3le')
  const L = txt.split('\n')
  let widthBad = 0, chkBad = 0, cmp = 0, worst = 0
  for (let i = 0; i + 2 < L.length; i += 3) {
    const l1 = L[i + 1], l2 = L[i + 2]
    if (!l2) break
    if (l1.length !== 69 || l2.length !== 69) widthBad++
    if (F.tleChecksum(l1) !== Number(l1[68]) || F.tleChecksum(l2) !== Number(l2[68])) chkBad++
    const rec = base[i / 3]
    const a = sat.twoline2satrec(l1, l2), b = sat.omm2satrec(rec)
    if (!a || a.error) continue
    const d = new Date(rec.epoch + 'Z')
    const pa = sat.propagate(a, d), pb = sat.propagate(b, d)
    if (!pa || !pa.position || !pb || !pb.position) continue
    const e = Math.hypot(pa.position.x - pb.position.x, pa.position.y - pb.position.y, pa.position.z - pb.position.z) * 1000
    cmp++; if (e > worst) worst = e
  }
  ok(widthBad === 0, `全部 69 列（越界 ${widthBad}）`)
  ok(chkBad === 0, `校验位全对（错 ${chkBad}）`)
  ok(cmp > 0, `与 twoline2satrec 比对了 ${cmp} 颗`)
  // 定长栏位截断的固有误差：GEO 上远小于百米量级
  ok(worst < 300, `重建 TLE 历元处位置差 ${worst.toFixed(2)} m < 300 m`)
}

/* ===== ⑤b TLE 定长栏位装不下时：宁可按 0 写，也不能静默写出错量级的假值 ===== */
section('TLE 栏位溢出')
const tleBase = () => ({
  name: 'T', noradId: '99999', objectId: '2020-001A', epoch: '2026-08-18T00:00:00.000000',
  meanMotion: '1.00270000', ecc: '.0001', incl: '0.0100', raan: '100.0000', argp: '0.0000',
  ma: '0.0000', bstar: '0', mdot: '0', mddot: '0'
})
const withF = (patch) => { const r = tleBase(); r.f = Object.assign({}, F.fieldsFromRecord(r), patch); return r }
const readBackBstar = (r) => Number(F.parseEphemeris(F.recordToTleLines(r).join('\n') + '\n').records[0].bstar)
// TLE 指数栏只有 1 位：|exp|<=9 照常表示，超出按 0 写（夹到 9 会差几个量级）
// TLE 尾数只有 5 位，.39713338E-3 打包后是 39713-3 —— 相对误差 ~1e-5 是格式的固有截断，不是 bug
ok(Math.abs(readBackBstar(withF({ BSTAR: '.39713338E-3' })) - 0.00039713338) <= 0.00039713338 * 1e-4,
  'BSTAR 常规值可表示（量级正确，尾数按 TLE 的 5 位截断）', String(readBackBstar(withF({ BSTAR: '.39713338E-3' }))))
ok(readBackBstar(withF({ BSTAR: '.3E-9' })) === 3e-10, 'BSTAR 指数 -9（边界内）仍精确表示')
for (const b of ['.1E-11', '.5E-10', '-.4E-12']) {
  ok(readBackBstar(withF({ BSTAR: b })) === 0, `BSTAR ${b} 超出栏位 → 按 0 写，不产生错量级假值`)
}
// elset 栏 4 位：超了取低 4 位（不是前 4 位），0 是合法值不该被顶成 999
const elsetOf = (v) => F.parseEphemeris(F.recordToTleLines(withF({ ELEMENT_SET_NO: v })).join('\n') + '\n').records[0].f.ELEMENT_SET_NO
ok(elsetOf('999') === '999', 'ELEMENT_SET_NO 常规值')
ok(elsetOf('12345') === '2345', 'ELEMENT_SET_NO 超 4 位取低位', elsetOf('12345'))
ok(elsetOf('0') === '0', 'ELEMENT_SET_NO 为 0 不被顶成 999', elsetOf('0'))
ok(elsetOf('') === '999', 'ELEMENT_SET_NO 缺失回落 999', elsetOf(''))
// rev 栏 5 位：循环计数取模
const revOf = (v) => F.parseEphemeris(F.recordToTleLines(withF({ REV_AT_EPOCH: v })).join('\n') + '\n').records[0].f.REV_AT_EPOCH
ok(revOf('123456') === '23456', 'REV_AT_EPOCH 超 5 位取模', revOf('123456'))
// 带 UTF-8 BOM 的 CSV（Space-Track 导出常见）：首列名不能被 BOM 带偏
const bomCsv = '\ufeffOBJECT_NAME,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,' +
  'ARG_OF_PERICENTER,MEAN_ANOMALY,NORAD_CAT_ID,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT\r\n' +
  'ISS,2026-08-18T13:09:00.137856,15.72125391,.0006703,51.6416,247.4627,130.5360,325.0288,25544,.1027E-3,.16717E-3,0\r\n'
ok(F.parseEphemeris(bomCsv).records[0]?.name === 'ISS', 'CSV 带 BOM 时首列 OBJECT_NAME 仍可用')

/* ===== ⑥ KVN / XML 解析边界 ===== */
section('KVN / XML 解析边界')
const KVN = `CCSDS_OMM_VERS = 2.0
COMMENT 第一条注释
COMMENT 第二条
CREATION_DATE = 2026-08-18T00:00:00
ORIGINATOR = 18 SPCS
OBJECT_NAME = TEST SAT
OBJECT_ID = 2020-001A
CENTER_NAME = EARTH
REF_FRAME = TEME
TIME_SYSTEM = UTC
MEAN_ELEMENT_THEORY = SGP4
EPOCH = 2026-08-18T00:55:00.137856
MEAN_MOTION = 13.76679809 [rev/day]
ECCENTRICITY = .00278136
INCLINATION = 90.2179 [deg]
RA_OF_ASC_NODE = 73.2093 [deg]
ARG_OF_PERICENTER = 103.4323 [deg]
MEAN_ANOMALY = 44.8474 [deg]
NORAD_CAT_ID = 900
ELEMENT_SET_NO = 999
REV_AT_EPOCH = 7993
BSTAR = .39713338E-3
MEAN_MOTION_DOT = .4E-5
MEAN_MOTION_DDOT = 0
USER_DEFINED_OPERATOR = CHINASAT
`
const kp = F.parseEphemeris(KVN)
ok(kp.format === 'omm-kvn', 'KVN 嗅探', kp.format)
ok(kp.records.length === 1, 'KVN 单段解析')
ok(kp.records[0].f.MEAN_MOTION === '13.76679809', 'KVN 剥掉 [单位]', kp.records[0].f.MEAN_MOTION)
ok((kp.records[0].comments || []).length === 2, 'KVN 多条 COMMENT 累积')
ok((kp.records[0].userDefined || {}).OPERATOR === 'CHINASAT', 'KVN USER_DEFINED')
ok(F.parseEphemeris(KVN + KVN).records.length === 2, 'KVN 多段拼接 = 多星')
const XML = F.serializeEphemeris(kp.records, 'omm-xml')
const xp = F.parseEphemeris(XML)
ok(xp.format === 'omm-xml', 'XML 嗅探', xp.format)
ok(xp.records.length === 1 && xp.records[0].f.BSTAR === '.39713338E-3', 'XML 往返保值', xp.records[0]?.f?.BSTAR)
ok((xp.records[0].comments || []).length === 2, 'XML COMMENT 往返')
ok((xp.records[0].userDefined || {}).OPERATOR === 'CHINASAT', 'XML USER_DEFINED 往返')
// XML 实体与名称中的 & <
const amp = F.serializeEphemeris([Object.assign({}, kp.records[0], { f: Object.assign({}, kp.records[0].f, { OBJECT_NAME: 'A & B <test>' }) })], 'omm-xml')
ok(F.parseEphemeris(amp).records[0].name === 'A & B <test>', 'XML 实体转义往返', F.parseEphemeris(amp).records[0].name)

/* ===== ⑦ 兼容与健壮性 ===== */
section('兼容与健壮性')
// Space-Track 式扩展列（列多、列序不同、大小写不同）——表头驱动应照吃不误
const ST = 'CCSDS_OMM_VERS,COMMENT,CREATION_DATE,ORIGINATOR,OBJECT_NAME,OBJECT_ID,CENTER_NAME,REF_FRAME,' +
  'TIME_SYSTEM,MEAN_ELEMENT_THEORY,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,' +
  'MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,' +
  'MEAN_MOTION_DDOT,SEMIMAJOR_AXIS,PERIOD,APOAPSIS,PERIAPSIS,OBJECT_TYPE,RCS_SIZE,COUNTRY_CODE,LAUNCH_DATE,SITE,' +
  'DECAY_DATE,FILE,GP_ID,TLE_LINE0,TLE_LINE1,TLE_LINE2\r\n' +
  '2.0,GENERATED VIA SPACE-TRACK.ORG API,2026-08-18T00:00:00,18 SPCS,ISS (ZARYA),1998-067A,EARTH,TEME,' +
  'UTC,SGP4,2026-08-18T13:09:00.137856,15.72125391,.0006703,51.6416,247.4627,130.5360,' +
  '325.0288,0,U,25544,900,56354,.1027E-3,.16717E-3,' +
  '0,6795.5,92.9,425.2,409.5,PAYLOAD,LARGE,ISS,1998-11-20,TTMTR,,4321,GP_ID,0 ISS (ZARYA),1 25544U,2 25544\r\n'
const st = F.parseEphemeris(ST)
ok(st.format === 'omm-csv', 'Space-Track 扩展列 CSV 仍判为 omm-csv', st.format)
ok(st.records.length === 1, 'Space-Track 行解析成功')
ok(st.records[0].noradId === '25544' && st.records[0].f.BSTAR === '.1027E-3', '扩展列不干扰取值')
ok(st.records[0].f.TLE_LINE1 === undefined, '非 OMM 字段被忽略')
// 名称含逗号、引号 → CSV 转义往返
const q = [Object.assign({}, iss, { f: Object.assign({}, iss.f, { OBJECT_NAME: 'SAT, "A"' }) })]
ok(F.parseEphemeris(F.serializeEphemeris(q, 'omm-csv')).records[0].name === 'SAT, "A"', 'CSV 引号逗号转义往返')
// 坏输入不炸
for (const [label, txt] of [['空串', ''], ['空白', '   \n\n'], ['乱码', '@@@@\n####'],
  ['坏 JSON', '{not json'], ['空 CSV 表头', 'A,B,C\n1,2,3'], ['半截 XML', '<ndm><omm>']]) {
  let r
  try { r = F.parseEphemeris(txt) } catch (e) { r = null }
  ok(r !== null && Array.isArray(r.records) && r.records.length === 0, `${label} 不抛异常且产出 0 条`)
}
ok(F.parseEphemeris(null).records.length === 0, 'null 不炸')
let threw = false
try { F.serializeEphemeris([], 'no-such-format') } catch { threw = true }
ok(threw, '未知导出格式抛错')
ok(F.serializeEphemeris([], 'omm-csv').trim() === F.CSV_COLS.join(','), '空记录导出只有表头')

/* ===== ⑧ 无 f{} 的老记录（自建 Walker 星座）也能按官方体例导出 ===== */
section('自建星座记录（无 f）')
const walker = [{
  name: 'WALKER-01', noradId: '990001', objectId: '', epoch: '2026-08-18T00:00:00.000Z',
  meanMotion: '14.8', ecc: '0.0012', incl: '53', raan: '120', argp: '0', ma: '45',
  bstar: '0.0001', mdot: '0', mddot: '0'
}]
const wcsv = F.serializeEphemeris(walker, 'omm-csv')
const wrec = F.parseEphemeris(wcsv).records[0]
ok(wrec && wrec.noradId === '990001', '无 f 的记录可导出并读回')
ok(wrec.f.INCLINATION === '53.0000', '角度补足 4 位', wrec.f.INCLINATION)
ok(wrec.f.MEAN_MOTION === '14.80000000', '平均运动补足 8 位', wrec.f.MEAN_MOTION)
ok(wrec.f.ECCENTRICITY === '.0012', '偏心率去前导 0', wrec.f.ECCENTRICITY)
ok(wrec.f.BSTAR === '.1E-3', 'BSTAR 转官方科学体例', wrec.f.BSTAR)
ok(wrec.f.EPOCH === '2026-08-18T00:00:00.000000', '历元转官方体例', wrec.f.EPOCH)
// CSV 的官方 17 列本就不含元数据段，故元数据要在带元数据的格式（KVN/XML）上验
const wkvn = F.serializeEphemeris(walker, 'omm-kvn')
ok(/REF_FRAME = TEME/.test(wkvn) && /TIME_SYSTEM = UTC/.test(wkvn) && /MEAN_ELEMENT_THEORY = SGP4/.test(wkvn),
  'KVN 为无 f 的记录补齐 CCSDS 元数据')
ok(F.fieldsFromRecord(walker[0]).REF_FRAME === 'TEME', 'fieldsFromRecord 直接补齐元数据')
const wsat = sat.omm2satrec(wrec)
ok(wsat && !wsat.error, '导出再读回可构 satrec')
near(Number(wrec.meanMotion), 14.8, 1e-9, '平均运动值不变')
// 六格式都能吞下无 f 的记录（编号取 Alpha-5 表示得了的号段；本平台自建星座的 900000 号段见下一节）
const walkerOk = [Object.assign({}, walker[0], { noradId: '270001' })]
for (const fmt of F.FORMATS) {
  let r = null
  try { r = F.parseEphemeris(F.serializeEphemeris(walkerOk, fmt)) } catch (e) { /* r=null */ }
  ok(r && r.records.length === 1, `${fmt}：无 f 记录往返`)
}
ok(F.parseEphemeris(F.serializeEphemeris(walkerOk, 'tle')).records[0].noradId === '270001',
  'Alpha-5 号段（27xxxx）经 TLE 往返编号不变')

/* ===== ⑨ NORAD 编号超出 TLE 五位栏位：拒写，绝不静默改写身份 ===== */
// 自建星座的号段基址是 900000（useCustomConstellations.js），远超 Alpha-5 上限 Z9999=339999。
// 曾经按 String(n).slice(-5) 截尾：900000→"00000"（回读判成 0，整颗丢掉）、900001→"00001"
// （撞上真实目录里的 1 号）。四种 OMM 格式无此限制，照常导出。
section('NORAD 编号超出 TLE 栏位')
ok(F.encodeSatnum('339999') === 'Z9999', 'Alpha-5 上界 339999 仍可表示', F.encodeSatnum('339999'))
ok(F.encodeSatnum('340000') === '', '340000 起不可表示，返回空串', JSON.stringify(F.encodeSatnum('340000')))
ok(F.encodeSatnum('900000') === '', '自建星座号段 900000 不可表示', JSON.stringify(F.encodeSatnum('900000')))
ok(F.recordToTleLines(walker[0]) === null, '不可表示的编号 → recordToTleLines 返回 null')
for (const fmt of ['tle', '3le']) {
  let msg = ''
  try { F.serializeEphemeris(walker, fmt) } catch (e) { msg = e.message || '' }
  ok(/超出五位栏位上限/.test(msg), `${fmt}：整组写不出时抛错而非吐半份文件`, msg.slice(0, 60))
}
for (const fmt of ['omm-csv', 'omm-json', 'omm-kvn', 'omm-xml']) {
  const back = F.parseEphemeris(F.serializeEphemeris(walker, fmt))
  ok(back.records.length === 1 && back.records[0].noradId === '990001', `${fmt}：大编号照常无损往返`)
}

/* ===== ⑩ UTF-8 BOM：六种格式一律免疫 ===== */
// JSON.parse 见了 BOM 当场抛；TLE 的首列判断会被顶偏一格（第 1 行成了名称行）。
// PowerShell 的 Set-Content -Encoding utf8、记事本的「UTF-8 with BOM」写出来就带它。
section('UTF-8 BOM')
const BOM = '\uFEFF'
for (const fmt of F.FORMATS) {
  const txt = F.serializeEphemeris(t3.records, fmt)
  const b = F.parseEphemeris(BOM + txt)
  ok(b.format === fmt && b.records.length === 1, `${fmt}：带 BOM 仍按 ${fmt} 解出 1 条`,
    `${b.format || '(未识别)'} / ${b.records.length} 条 / ${b.errors[0] || ''}`)
}
ok(F.detectFormat(BOM + TLE2) === 'tle', 'detectFormat 也要剥 BOM', F.detectFormat(BOM + TLE2))

/* ===== ⑪ 带命名空间前缀的 CCSDS NDM/XML ===== */
// CelesTrak / Space-Track 不带前缀，但 505.0-B 允许 <ndm:omm>…<ndm:EPOCH>。
section('XML 命名空间前缀')
const nsXml = F.serializeEphemeris(t3.records, 'omm-xml')
  .replace(/<(\/?)(omm|header|body|segment|metadata|data|meanElements|tleParameters|[A-Z][A-Z0-9_]*)/g, '<$1ndm:$2')
const nsp = F.parseEphemeris(nsXml)
ok(nsp.format === 'omm-xml', '带前缀仍嗅探为 omm-xml', nsp.format)
ok(nsp.records.length === 1 && nsp.records[0].noradId === '25544', '带前缀取值不变', String(nsp.records.length))
ok(nsp.records[0].f.ECCENTRICITY === '.0006703', '带前缀叶子值不变', nsp.records[0]?.f?.ECCENTRICITY)

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
