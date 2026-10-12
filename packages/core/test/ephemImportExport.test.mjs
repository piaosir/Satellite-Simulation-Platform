// 星历导入（预览 → 对应已有卫星 → 提交）与导出（任意卫星 → 任一格式）的主进程通路回归网：
//   electron/services/ephemImport.js + ephemExport.js + customSats.js（叠加星历）+ core orbitPos（叠加取位）。
// 走 SATSIM_DATA_DIR / SATSIM_OMM_BUNDLE_DIR 绕开 Electron，纯 Node 可跑。编目用随包快照（resources/omm）。
// 夹具：用快照里 ZHONGXING-6C（44067）的 SGP4 现采一份地固系 .eph（卫通版式、GBK），中间插一次「机动」。

import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const DATA = path.join(os.tmpdir(), 'satsim-ephem-io-test')
fs.rmSync(DATA, { recursive: true, force: true })
process.env.SATSIM_DATA_DIR = DATA
process.env.SATSIM_OMM_BUNDLE_DIR = path.join(ROOT, 'resources/omm')

const core = require('../index.js')
const getCore = () => core
const omm = require('../../../electron/services/omm.js')(getCore)
const customSats = require('../../../electron/services/customSats.js')(getCore)
const imp = require('../../../electron/services/ephemImport.js')({ customSats, omm, getCore })
const exp = require('../../../electron/services/ephemExport.js')({ customSats, omm, getCore })
const OP = require('../utils/orbitPos.js')
const EF = require('../utils/ephemFormats.js')
const EI = require('../utils/ephemInterp.js')
const OMM = require('../utils/ommFormats.js')
const TC = require('../utils/textCodec.js')
const CS = require('../utils/csEph.js')
const FR = require('../utils/frames.js')
const T = require('../utils/timeSystems.js')
const NG = require('../utils/ngsoGeometry.js')
const sat = core.sgp4

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '\n      ' + extra : '')) } }
const section = (t) => console.log('\n— ' + t)

// 随包快照里的 GEO 组（不联网：只读内置快照）
const geoCsv = omm.readCsvRaw('geo').text
const geoRecs = OMM.parseEphemeris(geoCsv, 'omm-csv').records
const R6C = geoRecs.find((r) => r.noradId === '44067')
const satrec6c = sat.omm2satrec(R6C)
const EP = Date.parse(R6C.epoch + 'Z')
const T0 = Math.floor(EP / 60000) * 60000 - 6 * 3600000          // 历元前 6 h 起
const TEND = T0 + 2 * 86400000                                     // 两天
const MAN0 = T0 + 30 * 3600000 + 18000, MAN1 = MAN0 + 600000       // 「机动」窗口 600 s（数据仍取 SGP4，只为造版式）
function ecefAt(ms) {
  const pv = sat.propagate(satrec6c, new Date(ms))
  const g = sat.gstime(new Date(ms)), cT = T.julianCenturiesTT(ms)
  const p = FR.temeToEcef(pv.position, g), v = FR.velFromTeme(pv.velocity, pv.position, 'FIXED', cT, g)
  return { p: [p.x, p.y, p.z], v: [v.x, v.y, v.z] }
}
const ts = []
for (let ms = T0; ms <= MAN0; ms += 60000) ts.push(ms)
if (ts[ts.length - 1] !== MAN0) ts.push(MAN0)
for (let ms = MAN1; ms < TEND; ms += 60000) ts.push(ms)
ts.push(TEND)
const n = ts.length
const tArr = new Float64Array(n), pArr = new Float64Array(3 * n), vArr = new Float64Array(3 * n)
ts.forEach((ms, i) => { const e = ecefAt(ms); tArr[i] = ms; pArr.set(e.p, 3 * i); vArr.set(e.v, 3 * i) })
// 机动结束处按卫通惯例重印一行：拆两段、写出时同刻两行
const k1 = ts.indexOf(MAN1)
const fixSat = { name: '6C-TEST', frame: 'FIXED', t: tArr, p: pArr, v: vArr, spans: [[T0, MAN1], [MAN1 + 1, TEND]], interp: { method: 'hermite', samples: 2 } }
// spans 要和「顺延 1 ms 的段界点」配套：把 MAN1 那点复制一份到 MAN1+1
{
  const t2 = new Float64Array(n + 1), p2 = new Float64Array(3 * (n + 1)), v2 = new Float64Array(3 * (n + 1))
  for (let i = 0, j = 0; i < n; i++, j++) {
    t2[j] = tArr[i]; p2.set(pArr.subarray(3 * i, 3 * i + 3), 3 * j); v2.set(vArr.subarray(3 * i, 3 * i + 3), 3 * j)
    if (i === k1) { j++; t2[j] = tArr[i] + 1; p2.set(pArr.subarray(3 * i, 3 * i + 3), 3 * j); v2.set(vArr.subarray(3 * i, 3 * i + 3), 3 * j) }
  }
  fixSat.t = t2; fixSat.p = p2; fixSat.v = v2
}
const FIX_TEXT = CS.serializeCsEph(fixSat, { title: '%'.repeat(14), createdMs: T0 + 3600000 })
const FIX_BYTES = Buffer.from(TC.encodeGbk(FIX_TEXT).bytes)

;(async () => {
  /* ===== ① 预览 + 候选 ===== */
  section('预览与候选')
  const pv = imp.preview([{ name: '6C-TEST.eph', bytes: FIX_BYTES }])
  const p0 = pv[0]
  ok(p0 && p0.ok && p0.kind === 'ephem' && p0.format === 'cs-eph', '识别为卫通 .eph 点序列', JSON.stringify(p0 && { ok: p0.ok, kind: p0.kind, f: p0.format, e: p0.errors }))
  ok(p0.encoding === 'gb18030', '编码认出 GBK', p0.encoding)
  const s0 = p0.sats[0]
  ok(s0.frame === 'FIXED' && s0.hasVel && s0.stepS === 60, '读数：地固 / 带速度 / 60 s', JSON.stringify({ f: s0.frame, v: s0.hasVel, s: s0.stepS }))
  ok(Math.abs(s0.lonDeg - 130.5) < 1, 'GEO 星下点经度读数 ~130.5°E', s0.lonDeg)
  ok(s0.candidates.length > 0 && s0.candidates[0].noradId === '44067', '最近候选 = ZHONGXING-6C', JSON.stringify(s0.candidates.slice(0, 3).map((c) => [c.name, c.distKm.toFixed(3)])))
  ok(s0.candidates[0].distKm < 0.01, '候选距离 ≈ 0（夹具就是它的 SGP4）', s0.candidates[0].distKm)
  ok(s0.suggest === '44067' && s0.candidates[0].nameHit, '建议项 = 44067，名字也对得上（6C）')
  ok(s0.gaps.length === 1 && s0.gaps[0].dtS === 600, '机动窗口读数', JSON.stringify(s0.gaps))

  /* ===== ② 提交：对应已有卫星 ===== */
  section('对应已有卫星')
  const cr = imp.commit(p0.token, { name: '中星6C精密星历', binds: [{ noradId: '44067', name: 'ZHONGXING-6C' }] })
  ok(cr.ok && cr.group.bound === 1 && cr.source === true, '提交成功、对应 1 颗、留了原文', JSON.stringify(cr))
  const B = customSats.bindings()
  ok(B.length === 1 && B[0].noradId === '44067' && B[0].name === 'ZHONGXING-6C', 'bindings 列出对应关系', JSON.stringify(B))
  const g = customSats.list().groups.find((x) => x.id === cr.group.id)
  ok(g.bound === 1 && g.hasSource && g.encoding === 'gb18030' && g.sats[0].bind.noradId === '44067', '组清单带对应 / 原文 / 编码', JSON.stringify({ b: g.bound, s: g.hasSource, e: g.encoding }))
  // 引擎取位：buildSatrec 出来的 44067 在星历时段内走叠加表，时段外回落 SDP4
  const rec = NG.buildSatrec({ type: 'omm', noradId: R6C.noradId, epoch: R6C.epoch, meanMotion: R6C.meanMotion, ecc: R6C.ecc, incl: R6C.incl, raan: R6C.raan, argp: R6C.argp, ma: R6C.ma, bstar: R6C.bstar, mdot: R6C.mdot, mddot: R6C.mddot })
  const tab = customSats.overlayTables('44067')[0]
  const inMs = T0 + 3 * 3600000 + 12345
  const a = OP.positionAt(rec, inMs), e = EI.evalTable(tab, inMs)
  ok(a && e && a.position.x === e.x && a.position.z === e.z, '时段内：positionAt = 叠加表插值（逐位）')
  ok(OP.propagatorLabel(rec, inMs) === '星历点序列' && OP.propagatorLabel(rec, T0 - 86400000) === 'SDP4', '传播器读数随时刻切换')
  const outMs = TEND + 86400000, so = sat.propagate(rec, new Date(outMs)), ao = OP.positionAt(rec, outMs)
  ok(ao.position.x === so.position.x, '时段外：回落 SDP4（逐位）')
  ok(OP.normId('A0001') === '100001' && OP.normId('00005') === '5', 'NORAD 归一（Alpha-5 / 前导零）')

  /* ===== ③ 导出：逐字节原文 / 原值子集 ===== */
  section('导出 · 点序列星')
  const out = path.join(DATA, 'out'); fs.mkdirSync(out, { recursive: true })
  const items = g.sats.map((s) => ({ t: 'ephem', groupId: g.id, key: s.key, name: s.name, noradId: s.noradId }))
  const pl = exp.plan({ items, format: 'cs-eph' })
  ok(pl.exact === true && pl.ephemSpan && pl.ephemSpan.t0 === T0, 'plan：可逐字节吐原文、时段读数', JSON.stringify(pl))
  let r = await exp.run({ items, format: 'cs-eph' }, { file: path.join(out, 'a.eph') })
  ok(r.ok && r.exact && Buffer.compare(fs.readFileSync(path.join(out, 'a.eph')), FIX_BYTES) === 0, '整组同格式：原文逐字节')
  r = await exp.run({ items, format: 'cs-eph', fromMs: T0 + 3600000, toMs: MAN1 + 3600000 }, { file: path.join(out, 'b.eph') })
  const subL = fs.readFileSync(path.join(out, 'b.eph')).toString('latin1').split('\r\n'), allL = new Set(FIX_BYTES.toString('latin1').split('\r\n'))
  ok(r.ok && !r.exact && subL.length > 100 && subL.every((l) => !l || allL.has(l)), '时段子集：每一行都是原文的行（原表头、原值、重印行）', subL.filter((l) => l && !allL.has(l)).slice(0, 2).join(' | '))
  r = await exp.run({ items, format: 'ccsds-oem-xml', frame: 'J2000' }, { file: path.join(out, 'c.xml') })
  const cx = EF.parseEphemeris(fs.readFileSync(path.join(out, 'c.xml'), 'utf8'))
  ok(r.ok && cx.format === 'ccsds-oem-xml' && cx.sats[0].frame === 'J2000' && cx.sats[0].spans && cx.sats[0].spans.length === 2, '换帧导 OEM/XML：J2000、机动段界保留', JSON.stringify({ f: cx.format, fr: cx.sats[0] && cx.sats[0].frame, sp: cx.sats[0] && cx.sats[0].spans }))
  {
    const t2 = EI.buildTable(cx.sats[0]), t1 = customSats.ephemLookup(g.id, g.sats[0].key)
    let worst = 0
    for (let ms = T0 + 1000; ms < TEND; ms += 3600 * 1000 + 17) { const x = EI.evalTable(t2, ms), y = EI.evalTable(t1, ms); if (x && y) worst = Math.max(worst, Math.hypot(x.x - y.x, x.y - y.y, x.z - y.z)) }
    ok(worst < 1e-3, 'OEM/XML 回读取位与库内一致（< 1 m）', worst)
  }

  /* ===== ④ 导出：编目星（带叠加）→ OEM，时段跨出星历 ===== */
  section('导出 · 编目星 + 叠加星历')
  const gp = { t: 'gp', rec: { name: R6C.name, noradId: R6C.noradId, objectId: R6C.objectId, epoch: R6C.epoch, meanMotion: R6C.meanMotion, ecc: R6C.ecc, incl: R6C.incl, raan: R6C.raan, argp: R6C.argp, ma: R6C.ma, bstar: R6C.bstar, mdot: R6C.mdot, mddot: R6C.mddot }, src: 'geo', name: R6C.name, noradId: R6C.noradId }
  r = await exp.run({ items: [gp], format: 'ccsds-oem-kvn', fromMs: T0 - 86400000, toMs: TEND + 86400000, stepS: 300, frame: 'TEME' }, { file: path.join(out, 'd.oem') })
  const dt = fs.readFileSync(path.join(out, 'd.oem'), 'utf8')
  const dp = EF.parseEphemeris(dt)
  ok(r.ok && (dt.match(/META_START/g) || []).length === 4, 'SGP4 段 / 星历两段 / SGP4 段 = 4 段', (dt.match(/META_START/g) || []).length)
  ok(/START_TIME = .*\n/.test(dt) && dt.includes(T.formatCcsds(T0)) && dt.includes(T.formatCcsds(TEND)), '段界落在星历起止时刻')
  ok(/ORIGINATOR = SATSIM/.test(dt) && /OBJECT_NAME = ZHONGXING-6C/.test(dt) && /OBJECT_ID = 2019-012A/.test(dt), 'KVN 头 / 元数据为 ASCII')
  {
    // 星历起止（T0 / TEND）都是整分、网格也是整分：源切换恰在网格点上。切换处是「同一时刻两个状态」——
    // 前一段止于旧源在该刻的状态、后一段起于新源在该刻的状态（读回时后者顺延 1 ms），这两点单独核；其余逐点等于平台取位
    const st = dp.sats[0]
    const isSwitch = (ms) => ms === T0 || ms === T0 + 1 || ms === TEND || ms === TEND + 1
    let worst = 0
    for (let k = 0; k < st.t.length; k++) {
      const ms = st.t[k]
      if (isSwitch(ms)) continue
      const q = OP.positionAt(rec, ms)
      if (!q) continue
      worst = Math.max(worst, Math.hypot(st.p[3 * k] - q.position.x, st.p[3 * k + 1] - q.position.y, st.p[3 * k + 2] - q.position.z))
    }
    ok(worst < 2e-9, '每个导出点 = 平台此刻取位（9 位小数的打印分辨率；切换处的两点另核）', worst)
    const at = (ms) => { const k = Array.from(st.t).indexOf(ms); return k < 0 ? null : [st.p[3 * k], st.p[3 * k + 1], st.p[3 * k + 2]] }
    const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity)
    const sg = (ms) => { const pv = sat.propagate(rec, new Date(ms)); return [pv.position.x, pv.position.y, pv.position.z] }
    const ov = (ms) => { const e = EI.evalTable(tab, ms); return [e.x, e.y, e.z] }
    ok(dist(at(T0), sg(T0)) < 2e-9 && dist(at(T0 + 1), ov(T0)) < 2e-9, '进叠加（T0 恰在网格点）：SGP4 段止于 T0 的 SGP4 状态、星历段起于星历首点', [dist(at(T0), sg(T0)), dist(at(T0 + 1), ov(T0))].join(' / '))
    ok(dist(at(TEND), ov(TEND)) < 2e-9 && dist(at(TEND + 1), sg(TEND)) < 2e-9, '出叠加（TEND 恰在网格点）：星历段止于星历末点、SGP4 段起于 TEND 的 SGP4 状态', [dist(at(TEND), ov(TEND)), dist(at(TEND + 1), sg(TEND))].join(' / '))
    // 切换处不留空洞：平台此刻有位置的时刻，导出文件读回也取得到（旧实现在网格点上的切换处空一个步长）
    const tb = EI.buildTable(st)
    let holes = 0, firstHole = null
    for (let ms = T0 - 86400000; ms <= TEND + 86400000; ms += 5000) {
      if (OP.positionAt(rec, ms) && !EI.evalTable(tb, ms)) { holes++; if (firstHole == null) firstHole = new Date(ms).toISOString() }
    }
    ok(holes === 0, '源切换处没有空洞（5 s 逐点：平台有位置的时刻导出文件都取得到）', holes + ' 处，首个 ' + firstHole)
    const se = dt.split('\n').filter((l) => /^(START|STOP)_TIME/.test(l)).map((l) => l.split('= ')[1])
    ok(se[1] === T.formatCcsds(T0) && se[2] === T.formatCcsds(T0) && se[se.length - 3] === T.formatCcsds(TEND) && se[se.length - 2] === T.formatCcsds(TEND), '段界：SGP4 段 STOP = 星历段 START = T0；星历段 STOP = SGP4 段 START = TEND', JSON.stringify(se))
  }

  /* ===== ⑤ 导出：平均根数 ===== */
  section('导出 · 平均根数')
  const cc = { t: 'gp', rec: Object.assign({}, gp.rec, { noradId: '900001', name: 'CC-1', objectId: '' }), src: 'cc_test', name: 'CC-1', noradId: '900001' }
  r = await exp.run({ items: [gp, cc, items[0]], format: 'omm-csv' }, { file: path.join(out, 'e.csv') })
  const csvL = fs.readFileSync(path.join(out, 'e.csv'), 'utf8').split(/\r?\n/)
  const orig6c = geoCsv.split(/\r?\n/).find((l) => l.split(',')[11] === '44067')
  ok(r.ok && r.written === 2 && r.skipped.length === 1 && /平均根数/.test(r.skipped[0].reason), '点序列星跳过并点名', JSON.stringify(r.skipped))
  ok(csvL[1] === orig6c, '编目星：整行等于源 CSV（ELEMENT_SET_NO / REV_AT_EPOCH 等契约外字段都在）', csvL[1] + ' | ' + orig6c)
  r = await exp.run({ items: [gp, cc], format: 'tle' }, { file: path.join(out, 'f.tle') })
  const tl = fs.readFileSync(path.join(out, 'f.tle'), 'utf8').trim().split(/\r?\n/)
  ok(r.ok && r.written === 1 && tl.length === 2 && OMM.tleChecksum(tl[0]) === Number(tl[0].slice(-1)) && r.skipped.some((s) => /339999/.test(s.reason)), 'TLE：校验位正确；900001 超 Alpha-5 跳过', JSON.stringify(r.skipped))
  r = await exp.run({ items: [gp], format: 'omm-csv', group: { kind: 'builtin', key: 'geo', hidden: [] } }, { file: path.join(out, 'g.csv') })
  ok(r.ok && r.exact && fs.readFileSync(path.join(out, 'g.csv'), 'utf8') === geoCsv, '整个内置组 CSV：吐缓存原文')

  /* ===== ⑥ 一星一个文件 / 定点星 / 取消 ===== */
  section('多文件 / 定点 / 取消')
  const dir = path.join(out, 'stk'); fs.mkdirSync(dir, { recursive: true })
  const fix = { t: 'fix', name: 'TREE-GEO', id: '1700001', r: [-27426.1, 32030.5, 0] }
  r = await exp.run({ items: [gp, fix], format: 'stk-e', fromMs: MAN0 - 3600000, toMs: MAN1 + 3600000, stepS: 120, frame: 'FIXED' }, { dir })
  ok(r.ok && r.files.length === 2 && r.files.every((f) => /\.e$/.test(f.path)), 'STK .e 一星一个文件', JSON.stringify(r.files.map((f) => path.basename(f.path))))
  const e1 = EF.parseEphemeris(fs.readFileSync(r.files[0].path, 'utf8'))
  ok(e1.sats[0].spans && e1.sats[0].spans.length === 2, 'STK：星历内的机动段界经 SegmentBoundaryTimes 往返', JSON.stringify(e1.sats[0] && e1.sats[0].spans))
  const e2 = EF.parseEphemeris(fs.readFileSync(r.files[1].path, 'utf8'))
  ok(e2.sats[0].frame === 'FIXED' && Math.abs(e2.sats[0].p[0] + 27426.1) < 1e-9 && Math.abs(e2.sats[0].v[1]) < 1e-12, '定点星：地固位置恒定、速度 0')
  let calls = 0
  fs.mkdirSync(path.join(out, 'cx'), { recursive: true })
  r = await exp.run({ items: Array.from({ length: 40 }, () => gp), format: 'ccsds-oem-kvn', fromMs: T0, toMs: T0 + 86400000, stepS: 60, perFile: true }, { dir: path.join(out, 'cx') }, () => {}, () => ++calls > 3)
  ok(r.canceled === true, '中途取消', JSON.stringify(r).slice(0, 80))

  /* ===== ⑦ 改对应 / 删组 ===== */
  section('改对应 / 删组')
  const rb = customSats.rebind(g.id, g.sats[0].key, null)
  ok(rb.ok && customSats.bindings().length === 0 && OP.propagatorLabel(rec, inMs) === 'SDP4', '取消对应：叠加立即失效')
  ok(customSats.rebind(g.id, g.sats[0].key, { noradId: g.sats[0].noradId }).ok === false, '不能对应到自身')
  ok(customSats.rebind(g.id, g.sats[0].key, { noradId: '44067', name: 'ZHONGXING-6C' }).ok && OP.propagatorLabel(rec, inMs) === '星历点序列', '重新对应：叠加恢复')
  const rp = imp.rebindPreview(g.id)
  ok(rp.ok && rp.sats[0].bind && rp.sats[0].bind.noradId === '44067' && rp.sats[0].candidates[0].noradId === '44067', '改对应预览：带现有对应 + 候选')
  customSats.removeGroup(g.id)
  ok(customSats.bindings().length === 0 && !fs.existsSync(path.join(DATA, 'ephem', g.id + '.src')) && OP.propagatorLabel(rec, inMs) === 'SDP4', '删组：原文 / 采样一并删、叠加失效')

  /* ===== ⑧ 同名重导入：将被替换的旧副本不当候选；提交时不许对应到自己 ===== */
  section('同名重导入')
  {
    const p1 = imp.preview([{ name: '6C-SELF.eph', bytes: FIX_BYTES }])[0]
    const c1 = imp.commit(p1.token, { name: p1.name, binds: [null] })
    const g1 = customSats.list().groups.find((x) => x.id === c1.group.id)
    const oldNorad = g1.sats[0].noradId
    const p2 = imp.preview([{ name: '6C-SELF.eph', bytes: FIX_BYTES }])[0]
    const s2 = p2.sats[0]
    ok(!s2.candidates.some((c) => c.src === 'i:' + g1.id || c.noradId === oldNorad) && s2.suggest === '44067', '同名重导入：旧副本（提交时被替换）不在候选里，建议项仍是 44067', JSON.stringify({ sug: s2.suggest, c: s2.candidates.slice(0, 3).map((c) => [c.noradId, c.distKm]) }))
    // 用户经「其它卫星…」硬选旧副本：新星沿用旧星号，那就是对应到自己 —— 不存对应、按新建落库并告警
    const c2 = imp.commit(p2.token, { name: p2.name, binds: [{ noradId: oldNorad, name: g1.sats[0].name }] })
    const g2 = customSats.list().groups.find((x) => x.id === c2.group.id)
    ok(c2.ok && c2.replaced && g2.id === g1.id && g2.sats[0].noradId === oldNorad && !g2.sats[0].bind && c2.group.bound === 0, '提交时对应到自身：不存对应（与 rebind 同口径）', JSON.stringify({ ok: c2.ok, b: g2 && g2.sats[0].bind, bound: c2.group && c2.group.bound }))
    ok(c2.warnings.some((w) => /对应目标是它自己/.test(w)) && customSats.bindings().length === 0, '并告警、对应表里没有自绑定', JSON.stringify(c2.warnings))
    customSats.removeGroup(g2.id)
  }

  /* ===== ⑨ .eph 子集导出：原表头是北京时 / km 时不复用，按 UTC / m 重写表头 ===== */
  section('.eph 表头口径')
  {
    const H = FIX_TEXT.split('\r\n').slice(0, 4)
    const BJT = 8 * 3600000
    const bjtSat = Object.assign({}, fixSat, { t: fixSat.t.map((x) => x + BJT), spans: fixSat.spans.map(([a, b]) => [a + BJT, b + BJT]) })
    const BJT_BYTES = Buffer.from(TC.encodeGbk(CS.serializeCsEph(bjtSat, { header: { lines: [H[0], H[1], H[2], H[3].replace('Time(UTC)', 'Time(BJT)')] } })).bytes)
    const kmCol = H[3].replace('_X_', '_X(km)_').replace('_Y_', '_Y(km)_').replace('_Z_', '_Z(km)_').replace('_dX_', '_dX(km/s)_').replace('_dY_', '_dY(km/s)_').replace('_dZ_', '_dZ(km/s)_')
    const kmData = FIX_TEXT.split('\r\n').slice(4).filter(Boolean).map((l) => { const q = CS.lexDataLine(l); return CS.timeField(q.ms) + q.nums.map((x) => CS.delphiExp(x / 1000)).join('  ') + '  ' })
    const KM_BYTES = Buffer.from(TC.encodeGbk([H[0], H[1], H[2], kmCol].concat(kmData).join('\r\n') + '\r\n').bytes)
    const idxOf = new Map(Array.from(fixSat.t).map((x, i) => [x, i]))
    for (const [label, bytes, unit] of [['北京时表头', BJT_BYTES, 'm'], ['km 表头', KM_BYTES, 'km']]) {
      const pv = imp.preview([{ name: '6C-' + label + '.eph', bytes }])[0]
      ok(pv.ok && pv.sats[0].timeScale === (label === '北京时表头' ? 'BJT' : 'UTC') && pv.sats[0].unitPos === unit, label + '：夹具解析口径', JSON.stringify({ ok: pv.ok, ts: pv.sats[0] && pv.sats[0].timeScale, u: pv.sats[0] && pv.sats[0].unitPos }))
      const cm = imp.commit(pv.token, { name: '6C-' + label, binds: [null] })
      const gg = customSats.list().groups.find((x) => x.id === cm.group.id)
      ok(gg.t0 === T0 && gg.t1 === TEND, label + '：入库时段按 UTC', JSON.stringify([gg.t0 - T0, gg.t1 - TEND]))
      const items1 = [{ t: 'ephem', groupId: gg.id, key: gg.sats[0].key, name: gg.sats[0].name, noradId: gg.sats[0].noradId }]
      const from = T0 + 3600000, to = MAN1 + 3600000
      const f = path.join(out, 'hdr-' + unit + '-' + gg.id + '.eph')
      const rr = await exp.run({ items: items1, format: 'cs-eph', sampling: 'native', fromMs: from, toMs: to, frame: 'FIXED' }, { file: f })
      const txt = TC.decodeText(fs.readFileSync(f)).text
      const L = txt.split('\r\n')
      ok(rr.ok && !rr.exact && L[3] === CS.COL_HEADER && L[0] === H[0], label + '：子集导出重写表头（Time(UTC)、标准六列、原标题）', JSON.stringify([L[0].slice(45, 70), L[3].slice(0, 30)]))
      const back = EF.parseEphemeris(txt)
      const b = back.sats[0]
      ok(b && !back.warnings.length && b.t[0] === from && b.t[b.t.length - 1] === to, label + '：读回时刻与所选时段一致（UTC）', b && JSON.stringify([b.t[0] - from, b.t[b.t.length - 1] - to, back.warnings]))
      let worstP = 0, worstV = 0, miss = 0
      for (let k = 0; b && k < b.t.length; k++) {
        const i = idxOf.get(b.t[k])
        if (i == null) { miss++; continue }
        for (let c = 0; c < 3; c++) { worstP = Math.max(worstP, Math.abs(b.p[3 * k + c] - fixSat.p[3 * i + c])); worstV = Math.max(worstV, Math.abs(b.v[3 * k + c] - fixSat.v[3 * i + c])) }
      }
      ok(b && !miss && worstP < 1e-9 && worstV < 1e-12, label + '：读回数值逐点等于源（地固 km / km·s⁻¹）', JSON.stringify({ miss, worstP, worstV }))
      customSats.removeGroup(gg.id)
    }
  }

  /* ===== ⑩ 多星 OEM 组：勾「每颗卫星一个文件」不走原文单文件 ===== */
  section('多星 OEM：每颗卫星一个文件')
  {
    const mkTeme = (name, objectId, dz) => {
      const n = 121, t = new Float64Array(n), p = new Float64Array(3 * n), v = new Float64Array(3 * n)
      for (let i = 0; i < n; i++) { const ms = T0 + i * 60000, pv = sat.propagate(satrec6c, new Date(ms)); t[i] = ms; p.set([pv.position.x, pv.position.y, pv.position.z + dz], 3 * i); v.set([pv.velocity.x, pv.velocity.y, pv.velocity.z], 3 * i) }
      return { name, objectId, frame: 'TEME', t, p, v, interp: { method: 'lagrange', samples: 8 } }
    }
    const OEM2 = EF.serializeEphemeris([mkTeme('OEM-A', '2026-901A', 0), mkTeme('OEM-B', '2026-902A', 50)], 'ccsds-oem-kvn', { createdMs: T0 })
    const pv = imp.preview([{ name: 'two-sats.oem', bytes: Buffer.from(OEM2, 'utf8') }])[0]
    const cm = imp.commit(pv.token, { name: pv.name, binds: [null, null] })
    const gg = customSats.list().groups.find((x) => x.id === cm.group.id)
    const items2 = gg.sats.map((s) => ({ t: 'ephem', groupId: gg.id, key: s.key, name: s.name, noradId: s.noradId }))
    const base = { items: items2, format: 'ccsds-oem-kvn', sampling: 'native', fromMs: gg.t0, toMs: gg.t1, frame: 'TEME', interp: { method: 'lagrange', samples: 8 } }
    ok(exp.plan(base).exact === true && exp.plan(Object.assign({}, base, { perFile: true })).exact === false, 'plan：单文件可吐原文；勾「每颗卫星一个文件」就不是原文')
    const d2 = path.join(out, 'perfile'); fs.mkdirSync(d2, { recursive: true })
    const r1 = await exp.run(Object.assign({}, base, { perFile: true }), { dir: d2 })
    const each = r1.files.map((f) => EF.parseEphemeris(fs.readFileSync(f.path, 'utf8')).sats)
    ok(r1.ok && !r1.exact && r1.files.length === 2 && each.every((x) => x.length === 1 && x[0].t.length === 121), '勾选后：两颗星两个文件、各 121 点', JSON.stringify({ ok: r1.ok, exact: r1.exact, files: r1.files.map((f) => path.basename(f.path)) }))
    const r2 = await exp.run(base, { file: path.join(out, 'two-whole.oem') })
    ok(r2.ok && r2.exact && Buffer.compare(fs.readFileSync(path.join(out, 'two-whole.oem')), Buffer.from(OEM2, 'utf8')) === 0, '不勾：整组原文逐字节')
    customSats.removeGroup(gg.id)
  }

  /* ===== ⑪ 自建星座（无国际编号）多星导一个 OEM：读回仍是各自一颗 ===== */
  section('自建星座 → 单文件 OEM')
  {
    const ccItems = [0, 1, 2].map((k) => ({ t: 'gp', rec: Object.assign({}, gp.rec, { noradId: String(900011 + k), name: 'CC-' + (k + 1), objectId: '', ma: String((Number(R6C.ma) + 30 * k) % 360) }), src: 'cc_test', name: 'CC-' + (k + 1), noradId: String(900011 + k) }))
    for (const fmt of ['ccsds-oem-kvn', 'ccsds-oem-xml']) {
      const f = path.join(out, 'cc3.' + (fmt === 'ccsds-oem-kvn' ? 'oem' : 'xml'))
      const rc = await exp.run({ items: ccItems, format: fmt, fromMs: T0, toMs: T0 + 3600000, stepS: 60, frame: 'TEME', interp: { method: 'lagrange', samples: 8 } }, { file: f })
      const back = EF.parseEphemeris(fs.readFileSync(f, 'utf8'))
      ok(rc.ok && rc.written === 3 && back.sats.length === 3 && back.sats.every((s, k) => s.t.length === 61 && s.name === 'CC-' + (k + 1) && s.objectId === 'SATSIM-' + (900011 + k)), fmt + '：3 颗无国际编号的星读回 3 颗、各 61 点、OBJECT_ID 各不相同', JSON.stringify(back.sats.map((s) => [s.name, s.objectId, s.t.length])))
    }
  }

  console.log('\nephemImportExport: 通过 ' + pass + '，失败 ' + fail)
  process.exit(fail ? 1 : 0)
})().catch((err) => { console.error(err); process.exit(1) })
