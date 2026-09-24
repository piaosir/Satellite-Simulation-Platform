// 链路预算报告第 5 章「卫星本体与天线布局」（二期契约 §4 / D14 / D15 / D16；摸底 lb-sunoutage-report.md §3.5）。运行：npm test
//   ① lbBodyLayout 的纯数据部分：绑定键顺序（lbsat:<ns>:<id> → norad → GRD 树 norad / grdsat）、哪些星进章、挂点读数
//      （视轴方位 / 俯仰走 mask.maskAzEl 的 D2 口径、滚转相对 D1 缺省上向量）、授权闸（redistributable=false 不出图）、
//      buildBodyLayout 整条流程（假 api + 注入 render，不碰 three）。
//   ② lbReport.buildReportModel：有布局才带 hasLayout / bodyLayout / layoutDoc；表只放数字（质量特性表的「来源」「置信度」两列
//      是 D14 的例外）；无布局时模型与改前一个键都不多。
//   ③ Word：第 5 章在 §4 之后、表号接全文连续号、图号全局连续（图 1、图 2…）且与详情章「图 n-i」不撞；多星逐星 5.n 小节；
//      redistributable=false 的星不出图；CC BY 图题带署名。
//   ④ 无布局时 docx 与改前逐字节一致：word/*.xml 等全部部件（docProps/core.xml 带生成时间，除外）的 sha256 与改前代码
//      在同一份模型上的产出对拍（GOLDEN 由改前代码算出，2026-09-24）。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

// ★ 路径走 fileURLToPath：项目目录名是中文，import.meta.url 里是 percent-encoded 的
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..').split(path.sep).join('/')
const require = createRequire(ROOT + '/package.json')
const JSZip = require('jszip')
const report = require(ROOT + '/electron/services/report.js')
const { buildReportDocx } = require(ROOT + '/electron/services/reportDocx.js')
const LR = await import('file:///' + ROOT + '/src/shared/lbReport.js')
const { buildReportModel, labelBundle } = LR

let N = 0
const ok = (c, m) => { assert.ok(c, m); N++ }
const eq = (a, b, m) => { assert.deepEqual(a, b, m); N++ }

// —— 极小 PNG（纯色，zlib 现编）：docx 的 figureParagraphs 只认 PNG（读 IHDR 宽高）——
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)) }
  return (~c) >>> 0
}
function pngDataUrl(w, h, rgb = [40, 90, 160]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2] }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  return 'data:image/png;base64,' + png.toString('base64')
}

// —— 报告模型工厂（与 lbReportFonts / lbReportSections 同一套写法）——
const SEG = { no: '1', title: '上行链路 Uplink', role: 'cascade', cols: 3, rows: [
  { label: '地球站 EIRP', up: '62.30', total: '62.30', unit: 'dBW', kind: 'base', num: 62.3, numTotal: 62.3 },
  { label: '自由空间损耗 FSL', sign: '−', up: '207.12', down: '206.05', unit: 'dB', num: 207.12, numDown: 206.05 },
  { label: '小计 C/N', up: '18.42', down: '14.77', total: '12.99', unit: 'dB', kind: 'sub', num: 18.42, numDown: 14.77, numTotal: 12.99 },
  { label: '链路余量 Margin', total: '2.49', unit: 'dB', kind: 'margin', numTotal: 2.49 }
] }
const DATA = { allocBandwidthResult: '1200', spectralEfficiencyResult: '2.4', PowerBWResult: '900', linkmargin: '2.49', modulationResult: '8PSK', fecResult: '3/4' }
const SLA_ROWS = [
  { key: 'sysAvail', group: 'avail', groupLabel: '可用度', label: '系统可用度', sub: '', basis: '99.90 × 99.90 = 99.80', suggest: '99.80', adopt: '99.80', value: '99.80', unit: '%' },
  { key: 'mir', group: 'rate', groupLabel: '速率', label: 'MIR', sub: '', basis: '2048', suggest: '2048', adopt: '', value: '2048', unit: 'kbps' }
]
const FIG = pngDataUrl(8, 6)
function mkLink(no, o = {}) {
  return Object.assign({
    no, rowId: 'r' + no, txName: '北京', rxName: 'Beijing HQ ' + no, ok: true, error: '',
    data: DATA, carrier: { stds: ['DVB-S2X'] },
    inputs: [{ title: '载波与调制', rows: [{ label: '信息速率', value: '2048', unit: 'kbps' }, { label: '调制方式', value: '8PSK', unit: '' }] }],
    segments: [SEG], figures: [], sla: null
  }, o)
}
// kind：'geo'（中文 GSO，5 条链路：#1 有 SLA、#5 带两张图——专门撞「图 5-i」）/ 'ngso-en'（英文 NGSO）/ 'regen'（两节）
function makeModel(kind, extra = {}) {
  let o
  if (kind === 'ngso-en') {
    o = { lang: 'en', orbitType: 'NGSO', links: [mkLink(1), mkLink(2, { error: 'no geometry', ok: false, data: null, segments: [] })], satelliteName: 'O3b', frequencyBand: 'Ka' }
  } else if (kind === 'regen') {
    o = {
      lang: 'zh', orbitType: 'REGEN', regenMode: 'uplink',
      sections: [{ key: 'uplink', regenMode: 'uplink' }, { key: 'isl', regenMode: 'isl' }],
      links: [mkLink(1, { sec: 0 }), mkLink(2, { sec: 0 }), mkLink(3, { sec: 1, data: { linkmargin: '5.10', islRfDistResult: '4200.0' } })],
      satelliteName: 'GPS BIIR-5', frequencyBand: 'L'
    }
  } else {
    o = {
      lang: 'zh', orbitType: 'GEO',
      links: [mkLink(1, { sla: { rows: SLA_ROWS } }), mkLink(2), mkLink(3), mkLink(4),
        mkLink(5, { figures: [{ title: '地理场图 · 链路余量', dataUrl: FIG }, { title: '链路视图', dataUrl: FIG }] })],
      satelliteName: '中星 6D', frequencyBand: 'Ku', slaParams: [{ label: '考核周期', value: '年平均', unit: '' }]
    }
  }
  const model = buildReportModel(Object.assign({
    regenMode: 'uplink',
    doc: { docNo: 'T-1', classification: '内部', org: '测试单位', date: '2026-09-24' },
    appVersion: 'test', calc: { satelliteName: o.satelliteName, frequencyBand: o.frequencyBand, mode: '固定功率' }
  }, o, extra))
  model.t = labelBundle(model.lang)
  report.enrichReportModel(model)
  return model
}
async function docxParts(model) {
  const buf = await buildReportDocx(model)
  const zip = await JSZip.loadAsync(buf)
  const out = {}
  for (const name of Object.keys(zip.files).sort()) {
    if (zip.files[name].dir) continue
    out[name] = await zip.file(name).async('nodebuffer')
  }
  return out
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
async function docxDigest(model) {
  const parts = await docxParts(model)
  const d = {}
  for (const [k, v] of Object.entries(parts)) if (k !== 'docProps/core.xml') d[k] = sha(v)
  return d
}

// —— 改前代码的产出（2026-09-24，本文件的工厂 + HEAD 版 reportDocx/lbReport 算出）——
const combine = (d) => sha(Object.keys(d).sort().map((n) => n + ':' + d[n]).join('\n'))
const GOLDEN = {
  geo: '81ddf1ebbfd14a53e81f43010ed9c9d5677ac96bddf703bf8697728ce2cad273',
  'ngso-en': 'aa3c73a8b9fa97e5593ebc17d606b23fb818ccebb076aad8000c51e6a6033d40',
  regen: '7c0213036d3d0c627325bcb8d1682ae931510a5ea5d32b3f9cc6a706debededc'
}
const GOLDEN_DOC = {   // word/document.xml 单独一份：总摘要对不上时先看是不是正文变了
  geo: '2704919ae58d60d18b0b82498fc59cf9f9605bb0079c7ab355ccd3ae5c7003d1',
  'ngso-en': 'b4a4686697b271485c5736014fd3047eaebfc01b06f73a09b7a52becc1d2fe06',
  regen: 'd0d7bd90d715255d95690cf0f7f0162aeffb93aebf0009147d04efce31419962'
}

if (process.env.MRL_PRINT_GOLDEN) {
  const g = {}
  for (const k of ['geo', 'ngso-en', 'regen']) { const d = await docxDigest(makeModel(k)); g[k] = { all: combine(d), doc: d['word/document.xml'] } }
  console.log(JSON.stringify(g, null, 2))
  process.exit(0)
}

const BL = await import('file:///' + ROOT + '/src/shared/lbBodyLayout.js')
const { maskAzEl } = await import('file:///' + ROOT + '/packages/core/models/mask.mjs')
const { applyMountTemplate } = await import('file:///' + ROOT + '/packages/core/models/mountTemplates.mjs')
const S = await import('file:///' + ROOT + '/packages/core/models/schema.mjs')
const close = (a, b, tol, m) => { assert.ok(Math.abs(a - b) <= tol, `${m}：${a} vs ${b}`); N++ }

// ═════════════════════ ① lbBodyLayout：身份、进章判据、挂点读数、授权闸 ═════════════════════
{
  // 绑定键顺序：lbsat:<ns>:<id> → 条目自己的 NORAD → GRD 树同名星的 NORAD → grdsat:<folder>
  const tree = [{ folder: '中星6D', noradId: 41194 }, { folder: 'GEO-预置', noradId: null }]
  eq(BL.satKeysOf('geo', { id: 'sat3', form: { satelliteName: '中星 6D' }, grd: { satFolder: '中星6D' } }, tree),
    ['lbsat:geo:sat3', 'norad:41194', 'grdsat:中星6D'], 'GSO 条目：lbsat → 树里的 NORAD → grdsat')
  eq(BL.satKeysOf('ngso', { id: 'sat1', ngsoSat: { noradId: '25544', folder: 'GEO-预置' } }, tree),
    ['lbsat:ngso:sat1', 'norad:25544', 'grdsat:GEO-预置'], 'NGSO 条目：选过星的 NORAD 在前')
  eq(BL.satKeysOf('e2e', { id: 'sat2', ngsoSat: { orbit: { noradId: 900001 } } }, []), ['lbsat:e2e:sat2'], '合成号段（≥ 800000）不当身份')
  eq(BL.satKeysOf('geo', null, tree), [], '空条目')
  ok(BL.satKeysOf('regen', { id: 'c1' }).every(S.isValidSatKey), '构造出的键都过 schema.isValidSatKey')
  eq(BL.satNameOf({ id: 'sat1', name: '条目名', form: { satelliteName: ' 中星 6D ' } }), '中星 6D', '星名取表单卫星名')
  eq(BL.satNameOf({ id: 'sat1', name: '条目名', form: {} }), '条目名', '表单没填取条目名')
  // 卫星名称还是出厂占位符「Satellite」：改用条目名；取过星以所选星为准（与 NGSO / 再生式窗口的 satNameOf 同口径）
  eq(BL.satNameOf({ id: 'sat1', name: '中星6D-Ku', form: { satelliteName: 'Satellite' } }), '中星6D-Ku', '占位符不算星名：取条目名')
  eq(BL.satNameOf({ id: 'sat1', form: { satelliteName: 'Satellite' } }), 'Satellite', '条目名也没有：才用占位符')
  eq(BL.satNameOf({ id: 'sat1', name: 'x', form: { satelliteName: '手填名' }, ngsoSat: { mode: 'search', name: 'STARLINK-1007', orbit: { type: 'omm' } } }), 'STARLINK-1007', '取过星：所选星名优先')
  eq(BL.satNameOf({ id: 'sat1', name: 'x', form: { satelliteName: '手填名' }, ngsoSat: { mode: 'manual', name: '旧名', orbit: null } }), '手填名', '手动轨道：表单名')
  // 进章的星同名：按条目名区分；条目名也撞就编号（中英括号各随语言）
  const dupB = { 'lbsat:geo:a': { model: { id: 'param:default-sat' } }, 'lbsat:geo:b': { model: { id: 'param:default-sat' } }, 'lbsat:geo:c': { model: { id: 'param:default-sat' } }, 'lbsat:geo:d': { model: { id: 'param:default-sat' } } }
  const dupS = [{ id: 'a', name: '中星6D-Ku', form: { satelliteName: 'ABC' } }, { id: 'b', name: '亚太6D', form: { satelliteName: 'ABC' } }, { id: 'c', name: '卫星', form: { satelliteName: 'Satellite' } }, { id: 'd', name: '卫星', form: { satelliteName: 'Satellite' } }]
  eq(BL.resolveLayoutSats({ ns: 'geo', sats: dupS, bindings: dupB, lang: 'zh' }).map((x) => x.satName), ['ABC（中星6D-Ku）', 'ABC（亚太6D）', '卫星（1）', '卫星（2）'], '同名星：条目名区分，条目名也撞就编号')
  eq(BL.resolveLayoutSats({ ns: 'geo', sats: dupS.slice(0, 2), bindings: dupB, lang: 'en' }).map((x) => x.satName), ['ABC (中星6D-Ku)', 'ABC (亚太6D)'], '英文用半角括号')
  eq(BL.resolveLayoutSats({ ns: 'geo', sats: dupS.slice(0, 1).concat(dupS.slice(2, 3)), bindings: dupB }).map((x) => x.satName), ['ABC', '卫星'], '不撞名就原样')
  // 自动匹配的输入（与 3D 页 modelOf 同一颗星同一组量）：命中 norad:<号> 用这个号；名称取目录名 / 所选星名 / 树节点星名
  const tdrsTree = [{ folder: 'F-TDRS', satName: 'TDRS 5', noradId: 21639 }]
  const eG = { id: 'g1', name: '天链中继 · Ku', form: { satelliteName: '天链中继' }, grd: { satFolder: 'F-TDRS' } }
  eq(BL.matchInputOf(eG, 'norad:21639', tdrsTree), { noradId: 21639, name: 'TDRS 5' }, 'GSO 经 GRD 树命中 norad 键：号取键上的、名取树节点星名')
  eq(BL.matchInputOf(eG, 'lbsat:geo:g1', tdrsTree), { noradId: 21639, name: 'TDRS 5' }, '命中条目自己的键：号与名仍取所引树节点')
  eq(BL.matchInputOf({ id: 'n1', form: { satelliteName: '我的星' }, ngsoSat: { mode: 'tree', name: '我的星', noradId: 25544, folder: 'F-ISS', orbit: { type: 'omm', name: 'ISS (ZARYA)', noradId: 25544 } } }, 'lbsat:ngso:n1', []),
    { noradId: 25544, name: 'ISS (ZARYA)' }, 'NGSO 取过星：名取轨道里记的目录名（池记录名）')
  eq(BL.matchInputOf({ id: 'n2', form: { satelliteName: '手动星' } }, 'lbsat:ngso:n2', []), { noradId: null, name: '手动星' }, '手动轨道：报告星名、无号')

  // 进章判据：指定模型 / 有挂点 / 有质量覆盖，三者其一；「自动」「无」且别的都没有 → 不进
  eq([{ model: { id: 'auto' } }, { model: { id: null } }, { model: { id: 'param:default-sat' } }, { model: { id: 'auto' }, mounts: [{}] }, { model: { id: null }, massProps: { massKg: 1 } }, null, { mounts: [] }]
    .map(BL.hasLayoutData), [false, false, true, true, true, false, false], 'hasLayoutData')

  const bindings = {
    'lbsat:geo:sat1': { model: { id: 'auto' } },                                // 只有自动 → 不算，落到下一个键
    'norad:41194': { model: { id: 'param:default-sat' }, mounts: [] },
    'lbsat:geo:sat2': { model: { id: 'auto' }, mounts: [{ id: 'm1', posBody: [0, 0, 1] }] },
    'lbsat:geo:sat9': { model: { id: null } }
  }
  const e1 = { id: 'sat1', form: { satelliteName: '中星 6D' }, grd: { satFolder: '中星6D' } }
  const e2 = { id: 'sat2', form: { satelliteName: '亚太 6D' } }
  const e9 = { id: 'sat9', form: { satelliteName: '无模型' } }
  const got = BL.resolveLayoutSats({ ns: 'geo', sats: [e1, null, e2, e1, e9, { id: 'sat5' }], bindings, tree })
  eq(got.map((x) => [x.satKey, x.satName]), [['norad:41194', '中星 6D'], ['lbsat:geo:sat2', '亚太 6D']], '逐条目找第一份有布局的绑定、同星去重、无绑定 / 模型「无」的星不进')
}
{
  // 挂点读数：视轴方位 / 俯仰与 mask.maskAzEl 同一口径（D2：本体系，az 自 +X 向 +Y，el +90 = +Z 天底）
  const mk = (bore, up, extra) => BL.mountReadout(Object.assign({ id: 'a', name: '天线', posBody: [1, -0, 2], boresightBody: bore, upBody: up }, extra))
  const r0 = mk([0, 0, 1], [0, -1, 0])
  eq([r0.azDeg, r0.elDeg, r0.rollDeg, r0.pos], [0, 90, 0, [1, 0, 2]], '对地挂点：el = 90、滚转 0（D1 缺省上向量）、负零回正')
  eq([mk([0, 1, 0]).azDeg, mk([0, -1, 0]).azDeg, mk([-1, 0, 0]).azDeg, mk([0, 0, -1]).elDeg], [90, 270, 180, -90], '四个特征方向')
  close(mk([0, 0, 1], [1, 0, 0]).rollDeg, 90, 1e-9, '上向量从 −Y 转到 +X：绕 +Z 右手 +90°')
  close(mk([0, 0, 1], [-1, 0, 0]).rollDeg, -90, 1e-9, '转到 −X：−90°')
  close(mk([0, 0, 1], [0, 1, 0]).rollDeg, 180, 1e-9, '反向：180°（区间 (−180, 180]）')
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 * 2 - 1 }
  let worst = 0
  for (let i = 0; i < 200; i++) {
    const d = [rnd(), rnd(), rnd()]
    const r = mk(d)
    const ref = maskAzEl(d)
    worst = Math.max(worst, Math.abs(r.azDeg - ref.az), Math.abs(r.elDeg - ref.el))
  }
  close(worst, 0, 1e-9, '200 个随机视轴：方位 / 俯仰与 maskAzEl 逐个一致（最大差）')
  // 万向节：azel / xy 限位原样、角速率；none 不出限位
  const g1 = mk([0, 0, 1], null, { gimbal: { type: 'xy', limits: { a1Min: -31, a1Max: 31, a2Min: -22.5, a2Max: 22.5 }, rateDegS: 0.5 }, fovDeg: 1.2, sysTempK: 480 })
  eq([g1.gimbalType, g1.limits, g1.rateDegS, g1.fovDeg, g1.sysTempK], ['xy', { a1Min: -31, a1Max: 31, a2Min: -22.5, a2Max: 22.5 }, 0.5, 1.2, 480], 'xy 万向节')
  const g0 = mk([0, 0, 1], null, { gimbal: { type: 'none', limits: { a1Min: -5 } }, rateDegS: 3 })
  eq([g0.gimbalType, g0.limits, g0.rateDegS, g0.fovDeg], ['none', null, null, null], '无万向节：限位与角速率都不出')
  eq(BL.mountReadout({ id: 'x', boresightBody: [0, 0, 1] }), null, '缺 posBody 的挂点不出')
  // 模板套用的真实挂点（schema.normalizeMount 的产出）逐条可读
  const t = applyMountTemplate('tdrs')
  const rs = t.mounts.map(BL.mountReadout)
  ok(rs.every((r) => r && Number.isFinite(r.azDeg) && Number.isFinite(r.elDeg) && Number.isFinite(r.rollDeg)), 'TDRS 模板四个挂点都读得出')
  eq(rs.filter((r) => r.gimbalType === 'xy').length, 3, 'TDRS：两副单址 + 空地链路是 xy 万向节')
}
{
  // 授权闸（D16）与署名
  const png = pngDataUrl(4, 4)
  const views = { dataUrl: png, w: 4, h: 4 }
  const stk = { id: 'stk:0123456789ab', source: { kind: 'stk-local', license: 'AGI SLA', redistributable: false }, units: { sizeVerified: false } }
  const nasa = { id: 'nasa:hubble-space-telescope-a', title: 'Hubble', source: { kind: 'nasa', credit: 'NASA / DigitalSpace Corporation', license: S.NASA_LICENSE, redistributable: true }, units: { sizeVerified: true } }
  const cc = { id: 'user:0123456789ab', title: 'Sat X', source: { kind: 'community', credit: 'Jane Doe', license: 'CC BY 4.0 International', redistributable: true } }
  const param = { id: 'param:default-sat', source: { kind: 'param', credit: '卫星仿真平台参数化生成', license: 'param', redistributable: true }, units: { sizeVerified: true } }
  const blk = (meta, extra) => BL.layoutSatBlock(Object.assign({ satKey: 'norad:1', satName: 'S', binding: { mounts: [] }, meta, views, bboxBody: { min: [-1, -2, -3], max: [1, 2, 3] } }, extra))
  const b1 = blk(stk)
  eq([b1.views, b1.redistributable, b1.bbox, b1.credit], [null, false, [2, 4, 6], ''], 'STK 本机模型：图丢掉（即便调用方给了），包围盒照出')
  const b2 = blk(nasa)
  eq([!!b2.views, b2.credit, b2.license, b2.sizeVerified], [true, 'NASA / DigitalSpace Corporation', '', true], 'NASA：出图、带贡献者署名、不抄那段用途准则')
  eq([blk(cc).credit, blk(cc).license], ['Jane Doe', 'CC BY 4.0 International'], 'CC BY：署名 + 许可名')
  eq([blk(param).credit, !!blk(param).views], ['', true], '参数化模型：不署名')
  eq(blk(nasa, { views: { dataUrl: 'data:image/webp;base64,AAAA', w: 1, h: 1 } }).views, null, '只收 PNG（docx 读 IHDR）')
  // 质量特性：绑定覆盖优先；估算且无惯量只能是 low
  const mp = { massKg: 5100, comBody: [0.01, -0, 1.2], inertiaBody: [[1, 0, 0], [0, 2, 0], [0, 0, 3]], source: 'components', confidence: 'high' }
  eq(blk(Object.assign({}, param, { massProps: mp })).mass, { massKg: 5100, com: [0.01, 0, 1.2], inertia: [[1, 0, 0], [0, 2, 0], [0, 0, 3]], source: 'components', confidence: 'high', overridden: false }, '模型的质量特性')
  const ov = blk(Object.assign({}, param, { massProps: mp }), { binding: { massProps: { massKg: 3000, comBody: [0, 0, 1], inertiaBody: null, source: 'estimate', confidence: 'high' } } }).mass
  eq([ov.massKg, ov.source, ov.confidence, ov.inertia, ov.overridden], [3000, 'estimate', 'low', null, true], '绑定覆盖优先；估算无惯量 → low')
}
// —— buildBodyLayout 整条流程（假 api，render 注入）——
function fakeApi(bindings, over = {}) {
  const calls = { ensure: 0, manifest: 0 }
  return {
    calls,
    models: Object.assign({
      bindingsGet: async () => ({ schema: 1, prefs: { geoDefault: 'param:ssl1300', showModels: true }, bindings }),
      manifest: async () => { calls.manifest++; return { models: [{ id: 'nasa:landsat-8' }], prefs: {} } },
      getMeta: async () => null,
      ensure: async () => { calls.ensure++; return { state: 'missing' } }
    }, over)
  }
}
const DEF = applyMountTemplate('default-sat').mounts
{
  const bindings = {
    'lbsat:geo:sat1': { model: { id: 'param:default-sat' }, mounts: DEF },
    'lbsat:geo:sat2': { model: { id: 'stk:0123456789ab' }, massProps: { massKg: 2000, comBody: [0, 0, 0.5], inertiaBody: null, source: 'manual', confidence: 'high' }, mounts: [] },
    'lbsat:geo:sat3': { model: { id: 'auto' }, mounts: [DEF[0]] }
  }
  const png = pngDataUrl(6, 6, [200, 60, 60])
  const seen = []
  const render = async (o) => {
    seen.push({ id: o.modelId, aps: o.attachPoints.map((a) => a.name), lang: o.lang })
    if (o.modelId === 'stk:0123456789ab') return { meta: { id: o.modelId, source: { kind: 'stk-local', redistributable: false } }, bboxBody: { min: [0, 0, 0], max: [2, 3, 4] }, views: { dataUrl: png, w: 6, h: 6 } }
    return { meta: { id: o.modelId, title: o.modelId, source: { kind: 'param', redistributable: true }, units: { sizeVerified: true }, massProps: null }, bboxBody: { min: [-1, -1, -1], max: [1, 1, 1] }, views: { dataUrl: png, w: 6, h: 6 } }
  }
  const steps = []
  const api = fakeApi(bindings)
  const sats = () => [{ id: 'sat1', form: { satelliteName: '中星 6D' } }, { id: 'sat2', form: { satelliteName: 'STK 星' } }, { id: 'sat1' }, { id: 'sat3', form: { satelliteName: '亚太 6D' } }, { id: 'sat4' }, null]
  eq(await BL.probeBodyLayout({ api, ns: 'geo', sats }), 3, '对话框读数：3 颗星有布局数据')
  const out = await BL.buildBodyLayout({ api, ns: 'geo', sats, lang: 'zh', render, onStep: (t, d, n) => steps.push([t, d, n]) })
  eq(out.sats.map((s) => [s.satKey, s.modelId, !!s.views, s.mounts.length]),
    [['lbsat:geo:sat1', 'param:default-sat', true, 4], ['lbsat:geo:sat2', 'stk:0123456789ab', false, 0], ['lbsat:geo:sat3', 'param:ssl1300', true, 1]],
    '三颗星：参数化出图 / STK 不出图 / 自动匹配走 GEO 缺省（绑定表 prefs.geoDefault）')
  eq(seen.map((x) => x.aps.length), [4, 0, 1], '三视图上的挂点 = 本星 mounts（不是模型自带的 attach point）')
  eq(seen[0].aps, DEF.map((m) => m.name), '挂点名照抄')
  eq(api.calls.manifest, 1, '有「自动」的星才读一次模型库清单')
  eq(steps.map((s) => s[1]), [0, 1, 2, 3], '进度逐星推进，末了一步是总数')
  eq(out.sats[1].mass.massKg, 2000, 'STK 星的质量特性（绑定覆盖）照出')
  ok(JSON.parse(JSON.stringify(out)) && JSON.stringify(out) === JSON.stringify(JSON.parse(JSON.stringify(out))), '块是纯数据（过 IPC）')
  // 绑定表被门禁挡住 / 读不到 → 0 与 null
  const locked = { models: { bindingsGet: async () => ({ locked: true }) } }
  eq([await BL.probeBodyLayout({ api: locked, ns: 'geo', sats }), await BL.buildBodyLayout({ api: locked, ns: 'geo', sats, render })], [0, null], '绑定表读不到：不出这一章')
  eq(await BL.buildBodyLayout({ api: fakeApi({}), ns: 'geo', sats, render }), null, '没有一颗星有绑定：null')
  // render 抛错只丢那颗星的图（挂点表照出）
  const warn = console.warn; console.warn = () => {}
  const bad = await BL.buildBodyLayout({ api: fakeApi({ 'lbsat:geo:sat1': { model: { id: 'param:default-sat' }, mounts: DEF } }), ns: 'geo', sats, render: async () => { throw new Error('WebGL 丢了') } })
  console.warn = warn
  eq([bad.sats.length, bad.sats[0].views, bad.sats[0].bbox, bad.sats[0].mounts.length], [1, null, null, 4], '出图失败：数字表照出')
  // 旧模板 id（2026-09-24 撤下的 param:dfh4 / dfh4e / dfh5）：老绑定照样进章，出图与块里一律是现行 id（图题跟现行模板名）
  const seenOld = []
  const old = await BL.buildBodyLayout({
    api: fakeApi({ 'lbsat:geo:sat1': { model: { id: 'param:dfh4' }, mounts: DEF }, 'lbsat:geo:sat3': { model: { id: 'param:dfh5' } } }),
    ns: 'geo', sats, render: async (o) => { seenOld.push(o.modelId); return render(o) }
  })
  eq([seenOld, old.sats.map((s) => s.modelId)], [['param:default-sat', 'param:default-sat'], ['param:default-sat', 'param:default-sat']], '旧模板 id 别名到 param:default-sat')
  // prefs.geoDefault 是旧 id（老存档）时，自动匹配的 GEO 缺省同样换成现行 id
  const seenAuto = []
  await BL.buildBodyLayout({
    api: fakeApi({ 'lbsat:geo:sat3': { model: { id: 'auto' }, mounts: [DEF[0]] } }, { bindingsGet: async () => ({ schema: 1, prefs: { geoDefault: 'param:dfh4', showModels: true }, bindings: { 'lbsat:geo:sat3': { model: { id: 'auto' }, mounts: [DEF[0]] } } }) }),
    ns: 'geo', sats, render: async (o) => { seenAuto.push(o.modelId); return render(o) }
  })
  eq(seenAuto, ['param:default-sat'], '自动匹配落到旧 geoDefault：同样换成现行 id')

  // 自动匹配与 3D 页同一颗星同一个模型：3D 页给 norad:21639（TDRS）写了绑定（自动 + 挂点），GSO 条目的卫星名是「天链中继」、
  // 经 GRD 树（grd.satFolder → 树节点 NORAD 21639）落到这把键——按树节点星名 TDRS 5 匹配到 NASA TDRS，而不是 GEO 缺省
  const TDRS_D = 'nasa:tracking-and-data-relay-satellites-tdrs-d'
  const hadLS = 'localStorage' in globalThis
  globalThis.localStorage = { getItem: (k) => (k === 'globe3d/settings' ? JSON.stringify({ grd: { sats: [{ folder: 'F-TDRS', satName: 'TDRS 5', noradId: 21639 }] } }) : null) }
  try {
    const seenT = []
    const apiT = fakeApi({ 'norad:21639': { model: { id: 'auto' }, mounts: [DEF[0]] } }, { manifest: async () => ({ models: [{ id: TDRS_D }, { id: 'nasa:landsat-8' }], prefs: {} }) })
    const outT = await BL.buildBodyLayout({ api: apiT, ns: 'geo', sats: [{ id: 'g1', name: '天链中继 · Ku', form: { satelliteName: '天链中继' }, grd: { satFolder: 'F-TDRS' } }],
      render: async (o) => { seenT.push(o.modelId); return render(o) } })
    eq([seenT, outT.sats[0].satKey, outT.sats[0].norad, outT.sats[0].satName], [[TDRS_D], 'norad:21639', 21639, '天链中继'], '经 GRD 树命中 norad 键：按树节点星名 + 号匹配到 NASA TDRS（报告里仍叫表单名）')
  } finally { if (!hadLS) delete globalThis.localStorage }
}

// —— 远端模型取档（models.ensure）：本机有别的档立刻用、不等；本机一档都没有才等，边等边报字节，卡住就放弃 ——
{
  const seqApi = (script) => {
    const calls = []
    return { calls, models: { ensure: async (o) => { calls.push(o.lod); const f = script(o, calls.length); return typeof f === 'function' ? f() : f } } }
  }
  const TM = { stall: 60, max: 2000, poll: 5 }
  let a = seqApi(() => ({ state: 'ready', url: 'models://x/lod1.glb', lod: 'lod1' }))
  eq([await BL.modelUrl(a, 'nasa:x', null, TM), a.calls], ['models://x/lod1.glb', ['lod1']], 'lod1 在本机：直接用')
  a = seqApi(() => ({ state: 'downloading', received: 10, total: 100, lod: 'lod1', fallback: { lod: 'lod2', url: 'models://x/lod2.glb' } }))
  eq([await BL.modelUrl(a, 'nasa:x', null, TM), a.calls], ['models://x/lod2.glb', ['lod1']], 'lod1 在下、本机有 lod2：立刻用 lod2，不等')
  a = seqApi(() => ({ state: 'error', message: 'net', fallback: { lod: 'lod2', url: 'models://x/lod2.glb' } }))
  eq(await BL.modelUrl(a, 'nasa:x', null, TM), 'models://x/lod2.glb', 'lod1 下载失败但本机有低档：用低档')
  const prog = []
  a = seqApi((o, n) => (o.lod === 'lod1' ? { state: 'downloading', received: 0, total: 9e6, lod: 'lod1' }
    : n < 5 ? { state: 'downloading', received: n * 1048576, total: 4 * 1048576, lod: 'lod2' } : { state: 'ready', url: 'models://x/lod2.glb', lod: 'lod2' }))
  eq([await BL.modelUrl(a, 'nasa:x', (g, t) => prog.push([g, t]), TM), a.calls], ['models://x/lod2.glb', ['lod1', 'lod2', 'lod2', 'lod2', 'lod2']], '本机一档都没有：改要 lod2 等它下完')
  eq(prog, [[2097152, 4194304], [3145728, 4194304], [4194304, 4194304]], '等的时候逐次报字节进度')
  a = seqApi((o) => (o.lod === 'lod1' ? { state: 'error', message: 'x' } : { state: 'ready', url: 'models://x/lod2.glb', lod: 'lod2' }))
  eq(await BL.modelUrl(a, 'nasa:x', null, TM), 'models://x/lod2.glb', 'lod1 失败且本机无档：改要 lod2')
  const t0 = Date.now()
  a = seqApi(() => ({ state: 'downloading', received: 123, total: 999, lod: 'lod2' }))
  eq(await BL.modelUrl(a, 'nasa:x', null, TM), null, '字节不动（断网 / 卡住）：超过停滞时限就放弃')
  ok(Date.now() - t0 < 1500, '停滞放弃不等总上限')
  a = seqApi(() => ({ state: 'missing' }))
  eq(await BL.modelUrl(a, 'nasa:x', null, TM), null, 'missing：不出图')
  // 进度文字随语言（运行时读数，不是说明文字）
  const stepsW = []
  await BL.buildBodyLayout({
    api: fakeApi({ 'lbsat:geo:sat1': { model: { id: 'param:default-sat' }, mounts: DEF } }), ns: 'geo', lang: 'en', sats: [{ id: 'sat1', form: { satelliteName: 'CS-6D' } }],
    onStep: (t) => stepsW.push(t),
    render: async (o) => { o.onWait(1572864, 3145728); return null }
  })
  ok(stepsW.includes('CS-6D · downloading model 1.5 / 3.0 MB'), '下载进度写进进度行：' + stepsW.join(' | '))
}

// ═════════════════════ ② buildReportModel：hasLayout / bodyLayout / layoutDoc ═════════════════════
const PNG_A = pngDataUrl(12, 12, [30, 120, 60]), PNG_B = pngDataUrl(10, 10, [220, 30, 30])
function layoutFixture() {
  // 7 个挂点 → 挂点表切成 5 + 2 两张续表；第 5 个改成方位-俯仰万向节（TDRS / 默认卫星模板里只有 xy 与无）
  const mounts = applyMountTemplate('tdrs').mounts.concat(DEF.slice(0, 3)).map((m, i) => (i === 4 ? Object.assign({}, m, { gimbal: { type: 'azel', limits: { a1Min: -170, a1Max: 170, a2Min: 0, a2Max: 88 }, rateDegS: 2 } }) : m))
  const a = BL.layoutSatBlock({
    satKey: 'lbsat:geo:sat1', satName: '天链 A', binding: { mounts },
    meta: { id: 'nasa:tracking-and-data-relay-satellites-tdrs-d', title: 'TDRS', source: { kind: 'nasa', credit: 'NASA', license: S.NASA_LICENSE, redistributable: true }, units: { sizeVerified: false },
      massProps: { massKg: 3180.5, comBody: [0.012, -0.003, 0.41], inertiaBody: [[12450.2, -12.5, 30.1], [-12.5, 9870.7, 4.4], [30.1, 4.4, 15020.9]], source: 'manual', confidence: 'high' } },
    bboxBody: { min: [-1.2, -10.4, -2.1], max: [1.3, 10.6, 3.3] }, views: { dataUrl: PNG_A, w: 12, h: 12 }
  })
  const b = BL.layoutSatBlock({
    satKey: 'lbsat:geo:sat2', satName: 'STK 星', binding: { mounts: [DEF[3]], massProps: { massKg: 1.33, comBody: [0, 0, 0.001], inertiaBody: null, source: 'estimate', confidence: 'high' } },
    meta: { id: 'stk:0123456789ab', source: { kind: 'stk-local', redistributable: false } },
    bboxBody: { min: [-0.05, -0.05, -0.17], max: [0.05, 0.05, 0.17] }, views: { dataUrl: PNG_B, w: 10, h: 10 }
  })
  // 调用方把 STK 星的图硬塞回来：模型层（normBodyLayout）与两个渲染器都要再挡一道
  b.views = { dataUrl: PNG_B, w: 10, h: 10 }
  return { sats: [a, b] }
}
const NUM_RE = /^(-?\d+(\.\d+)?|—)$/
{
  const m0 = makeModel('geo')
  ok(!('hasLayout' in m0) && !('bodyLayout' in m0) && !('layoutDoc' in m0), '无布局：模型一个键都不多')
  const mNull = makeModel('geo', { bodyLayout: { sats: [{ satKey: 'x', mounts: [] }] } })
  ok(!('hasLayout' in mNull), '块里的星一格都给不出：同无布局')
  const m = makeModel('geo', { bodyLayout: layoutFixture() })
  eq([m.hasLayout, m.bodyLayout.sats.length, m.layoutDoc.length], [true, 2, 2], '有布局：hasLayout + 两颗星')
  eq(m.bodyLayout.sats[1].views, null, 'normBodyLayout：redistributable=false 的图丢掉')
  eq(m.t.layout, '卫星本体与天线布局', '章名进标签包')
  const [da, db] = m.layoutDoc
  eq([da.sat, da.title, !!da.figure, db.figure], [0, '天链 A', true, null], '排版计划：B 没有图')
  eq(da.figure.caption, '天链 A　本体三视图与透视（模型：TDRS，NASA）', '图题带模型名与 NASA 署名、不带编号')
  eq(da.mass.head, ['参数', '数值', '单位', '来源', '置信度'], '质量特性表头（D14：来源 / 置信度两列）')
  eq(da.mass.title, '质量特性　·　天链 A', '多星时表题带星名')
  const valueCells = (tb) => tb.rows.filter((r, i) => !tb.keyRows[i]).map((r) => r[1])
  ok(valueCells(da.mass).every((v) => NUM_RE.test(v)), '质量特性表数值列只有数')
  eq(da.mass.rows.filter((r, i) => !da.mass.keyRows[i]).map((r) => r[0]),
    ['包围盒尺寸 X', '包围盒尺寸 Y', '包围盒尺寸 Z', '质量', '质心 X', '质心 Y', '质心 Z', 'Ixx', 'Iyy', 'Izz', 'Ixy', 'Ixz', 'Iyz'], '质量特性行')
  eq(valueCells(da.mass).slice(0, 7), ['2.500', '21.000', '5.400', '3181', '0.012', '-0.003', '0.410'], '尺寸 / 质量 / 质心的格式（质量 4 位有效、长度到 mm）')
  eq(valueCells(da.mass).slice(7), ['12450', '9871', '15021', '-13', '30', '4'], '惯量一组共用小数位（按组内最大值取 4 位有效）')
  eq([...new Set(da.mass.rows.filter((r, i) => !da.mass.keyRows[i]).map((r) => r[3] + '/' + r[4]))], ['模型几何/低', '手填/高'], '来源 / 置信度：几何按「尺寸已核定」、质量按 massProps')
  eq(db.mass.rows.filter((r, i) => !db.mass.keyRows[i]).map((r) => r[0] + '=' + r[1] + ' ' + r[3] + '/' + r[4]),
    ['包围盒尺寸 X=0.100 模型几何/低', '包围盒尺寸 Y=0.100 模型几何/低', '包围盒尺寸 Z=0.340 模型几何/低', '质量=1.330 估算/低', '质心 X=0.000 估算/低', '质心 Y=0.000 估算/低', '质心 Z=0.001 估算/低'],
    '估算无惯量：惯量一组不出，置信度 low')
  // 挂点表：参数做行、挂点做列，5 + 2 两张续表；格里只有数或「—」
  eq(da.mount.chunks.map((c) => c.head.length), [7, 4], '7 个挂点 → 5 + 2（参数列 + 单位列）')
  eq(da.mount.chunks.map((c) => c.widthPct), [100, 64], '挂点少时表收窄（参数 30 + 每挂点 13 + 单位 8，版心百分比）')
  for (const c of da.mount.chunks) {
    ok(c.rows.every((r, i) => c.keyRows[i] || r.slice(1, -1).every((v) => NUM_RE.test(v))), '挂点表格里只有数')
    eq(c.widths.reduce((a, b) => a + b, 0), 100, '列宽加起来 100')
  }
  const labels = da.mount.chunks[0].rows.map((r) => r[0])
  ok(['位置 X', '视轴方位', '视轴俯仰', '滚转', '方位下限', '绕 X 下限', '绕 Y 上限', '星上系统噪温'].every((l) => labels.includes(l)), '挂点表行：位置 / 视轴 / 万向节两种限位 / T_sys')
  const rowOf = (c, l) => c.rows.find((r) => r[0] === l)
  eq(rowOf(da.mount.chunks[0], '绕 X 下限').slice(1, 6), ['-31.00', '-31.00', '—', '-9.00', '—'], '限位只在对应万向节类型的挂点上有数')
  eq(rowOf(da.mount.chunks[0], '视轴俯仰').slice(-1)[0], '°', '单位列')
  // 英文
  const me = makeModel('ngso-en', { bodyLayout: layoutFixture() })
  eq([me.t.layout, me.layoutDoc[0].figure.caption, me.layoutDoc[0].mass.head[3], me.layoutDoc[1].mass.rows[5][3]],
    ['Spacecraft Body and Antenna Layout', '天链 A — body three-view and perspective (model: TDRS, NASA)', 'Source', 'Estimated'], '英文标签')
}

// ═════════════════════ ③ Word：章号 / 表号 / 图号，D16，署名 ═════════════════════
function paras(xml) {
  // 段落 → { style, text }（只取 w:t 文本；表格单元格里的段落也在里面，style 为 RptTd / RptTh 等）
  const out = []
  const re = /<w:p[ >][\s\S]*?<\/w:p>/g
  let m
  while ((m = re.exec(xml))) {
    const p = m[0]
    const st = /<w:pStyle w:val="([^"]+)"/.exec(p)
    const text = [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((x) => x[1]).join('')
    out.push({ style: st ? st[1] : '', text, pageBreak: /<w:pageBreakBefore\/>/.test(p) })
  }
  return out
}
{
  const model = makeModel('geo', { bodyLayout: layoutFixture() })
  const parts = await docxParts(model)
  const P = paras(parts['word/document.xml'].toString('utf8'))
  const iDetail = P.findIndex((p) => p.style === 'RptH1' && p.text === '链路详情')
  const master = P.slice(0, iDetail), detail = P.slice(iDetail)
  const h2 = master.filter((p) => p.style === 'RptH2').map((p) => p.text)
  eq(h2, ['1　逐参数对照', '2　容量与统计', '3　计算模型与参考', '4　服务等级指标（SLA）', '5　卫星本体与天线布局'], '章号：第 5 章接在 §4 之后')
  ok(master.find((p) => p.text === '5　卫星本体与天线布局').pageBreak, '第 5 章另起一页')
  eq(master.filter((p) => p.style === 'RptH3' && /^5\./.test(p.text)).map((p) => [p.text, p.pageBreak]), [['5.1　天链 A', false], ['5.2　STK 星', true]], '多星逐星 5.n，第二颗起另起一页')
  const tcap = master.filter((p) => p.style === 'RptCaption' && /^表 /.test(p.text)).map((p) => p.text)
  const tno = tcap.map((t) => /^表 (\d+)/.exec(t)[1] | 0)
  ok(tno.every((n, i) => i === 0 ? n === 1 : (n === tno[i - 1] || n === tno[i - 1] + 1)), '总报告表号连续：' + tno.join(','))
  eq(tcap.slice(-5), ['表 6　质量特性　·　天链 A', '表 7-1　挂点布局　·　天链 A', '表 7-2　挂点布局　·　天链 A（续）', '表 8　质量特性　·　STK 星', '表 9　挂点布局　·　STK 星'], '第 5 章表号接 SLA（表 5）之后，续表共用表号')
  ok(tcap.includes('表 5　服务等级指标（SLA）'), 'SLA 仍是表 5')
  const fcapM = master.filter((p) => p.style === 'RptCaptionFig').map((p) => p.text)
  eq(fcapM, ['图 1　天链 A　本体三视图与透视（模型：TDRS，NASA）'], '总报告部分的图：全局号「图 1」，只一张（STK 星不出图）、NASA 署名')
  const fcapD = detail.filter((p) => p.style === 'RptCaptionFig').map((p) => p.text)
  eq(fcapD, ['图 5-1　地理场图 · 链路余量', '图 5-2　链路视图'], '#5 链路的图仍是「图 5-i」——与第 5 章的「图 1」不撞')
  // 图件：天链 A 的 PNG 进了包，STK 星的没进（模型层、渲染器两道闸）
  const media = Object.entries(parts).filter(([k]) => k.startsWith('word/media/')).map(([, v]) => sha(v))
  const pngSha = (u) => sha(Buffer.from(u.split(',').pop(), 'base64'))
  ok(media.includes(pngSha(PNG_A)), '三视图 PNG 进了 docx')
  ok(!media.includes(pngSha(PNG_B)), 'redistributable=false 的图不进 docx')
  // 渲染器自己那道闸：绕过 normBodyLayout 直接塞 views（redistributable=false）也不出
  const m2 = makeModel('geo', { bodyLayout: layoutFixture() })
  m2.bodyLayout.sats[1].views = { dataUrl: PNG_B, w: 10, h: 10 }; m2.layoutDoc[1].figure = { caption: 'X' }
  const media2 = Object.entries(await docxParts(m2)).filter(([k]) => k.startsWith('word/media/')).map(([, v]) => sha(v))
  ok(!media2.includes(pngSha(PNG_B)), 'reportDocx 再挡一道（redistributable=false 不出图）')
  // 挂点表的数字格：三线表单元格里的文本全是数 / —（第 5 章的表体）
  const i5 = master.findIndex((p) => p.text === '5　卫星本体与天线布局')
  const tds = master.slice(i5).filter((p) => p.style === 'RptTd').map((p) => p.text)
  ok(tds.length > 40, '第 5 章表体有内容')
  const xml = parts['word/document.xml'].toString('utf8')
  const i5x = xml.indexOf('5　卫星本体与天线布局'), iDx = xml.indexOf('>链路详情<')
  ok(xml.slice(i5x, iDx).includes('<w:keepNext/>') && !xml.slice(0, i5x).includes('<w:keepNext/>'), '挂点表整张不跨页、分组行跟住下一行（keepNext 只出现在第 5 章）')
  // 分组行（「惯量张量（对质心，本体系）」一类）整行并成一格，gridSpan = 该表列数（同 PDF 的 colspan）；别的表一格都不并
  const spans = [...xml.slice(i5x, iDx).matchAll(/<w:gridSpan w:val="(\d+)"\/>/g)].map((x) => x[1] | 0)
  eq([...new Set(spans)].sort(), [3, 4, 5, 7], '第 5 章分组行跨整行：质量特性 5 列、天链 A 挂点表 7 列 / 续表 4 列、STK 星（1 个挂点）3 列')
  ok(!/<w:gridSpan /.test(xml.slice(0, i5x)) && !/<w:gridSpan /.test(xml.slice(iDx)), '第 5 章以外没有合并格')
  const grpRow = /<w:tr>(?:(?!<\/w:tr>)[\s\S])*?惯量张量（对质心，本体系）(?:(?!<\/w:tr>)[\s\S])*?<\/w:tr>/.exec(xml)
  ok(grpRow && (grpRow[0].match(/<w:tc>/g) || []).length === 1 && /<w:gridSpan w:val="5"\/>/.test(grpRow[0]), '「惯量张量」分组行只有一格、跨 5 列')
  // 同一份模型再渲染一次：表号 / 图号从头数（计数器挂在模型上，buildReportDocx 开头清零）
  const again = paras((await docxParts(model))['word/document.xml'].toString('utf8')).filter((p) => p.style === 'RptCaptionFig').map((p) => p.text)
  ok(again.includes('图 1　天链 A　本体三视图与透视（模型：TDRS，NASA）'), '反复渲染图号不累加')
  // 没有 SLA 时：第 5 章紧跟 §3（章号仍是 5，允许跳号），表号仍连续
  const noSla = makeModel('geo', { bodyLayout: layoutFixture() })
  noSla.hasSla = false
  const P3 = paras((await docxParts(noSla))['word/document.xml'].toString('utf8'))
  eq(P3.filter((p) => p.style === 'RptH2' && /^\d　/.test(p.text)).map((p) => p.text).slice(-2), ['3　计算模型与参考', '5　卫星本体与天线布局'], '无 SLA：3 之后直接 5')
  eq(P3.filter((p) => p.style === 'RptCaption' && /^表 \d+　质量特性/.test(p.text)).map((p) => p.text)[0], '表 5　质量特性　·　天链 A', '无 SLA：表号顺延（不留空号）')
  // 英文
  const Pen = paras((await docxParts(makeModel('ngso-en', { bodyLayout: layoutFixture() })))['word/document.xml'].toString('utf8'))
  ok(Pen.some((p) => p.style === 'RptH2' && p.text === '5　Spacecraft Body and Antenna Layout'), '英文章名')
  ok(Pen.some((p) => p.style === 'RptCaptionFig' && p.text === 'Figure 1  天链 A — body three-view and perspective (model: TDRS, NASA)'), '英文图题')
  ok(Pen.some((p) => p.style === 'RptCaption' && /^Table \d+  Mass Properties · 天链 A$/.test(p.text.replace('　·　', ' · '))), '英文表题')
}

// ═════════════════════ ④ 无布局：docx 与改前逐字节一致 ═════════════════════
for (const k of ['geo', 'ngso-en', 'regen']) {
  const d = await docxDigest(makeModel(k))
  eq(d['word/document.xml'], GOLDEN_DOC[k], k + '：word/document.xml 与改前一致')
  eq(combine(d), GOLDEN[k], k + '：全部部件（除 docProps/core.xml 的时间戳）与改前一致')
  // 宿主给了 bodyLayout 但没有一颗星有东西可出：同样一字不差
  eq(combine(await docxDigest(makeModel(k, { bodyLayout: { sats: [] } }))), GOLDEN[k], k + '：空块同无布局')
}

// ═════════════════════ ⑤ 按需加载：四个窗口启动时不背模型那一串 ═════════════════════
{
  const fs = await import('node:fs')
  const src = (p) => fs.readFileSync(ROOT + '/' + p, 'utf8')
  const staticImp = (s) => /^\s*import\s[^;\n]*from\s+['"][^'"]*lbBodyLayout\.js['"]/m.test(s)
  ok(!staticImp(src('src/shared/useLbReport.js')) && /import\(['"]\.\/lbBodyLayout\.js['"]\)/.test(src('src/shared/useLbReport.js')), 'useLbReport 动态 import lbBodyLayout')
  ok(!staticImp(src('src/components/LbReportDialog.vue')), '对话框不静态引 lbBodyLayout（注入键取自 lbReport）')
  ok(LR.LB_REPORT_LAYOUT_KEY === BL.LB_REPORT_LAYOUT_KEY && typeof LR.LB_REPORT_LAYOUT_KEY === 'symbol', '注入键同一个 Symbol（lbBodyLayout 原样转出）')
}

console.log(`modelReportLayout: ${N} 项通过`)
