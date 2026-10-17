// 链路预算四窗的「结果口径」自测（2026-10-16 体检 #13 / #14）。运行：npm test -- lbWorkbenchResults
//
//   ① 详细预算整表复制（shared/lbWaterfallTsv.js，四窗一份）：多列段列头取段自带的 heads（工况对照「晴空 / 降雨」、
//      端到端逐段汇总「C/(N+I) / 段余量」），缺省才是「上行 / 下行 / 合计」；空格保位（端到端那份曾把空串格滤掉，
//      符号列空着或某侧没值时整行左移、与列头错位）；四窗都走这一份。
//   ② 再生式报告「输入参数」清单（regen/regenModeScope.js 的 regenDigestParams）：按模块只交参与计算的字段——
//      上行不印镜像的「收信站群」、带上「功放功率预设」；下行不印上行占位；星间不印「发 / 收」两座假站。
//      用真 buildInputDigest 验整条链。
//   ③ 换配置清结果（结构守门）：四窗 applyState 清掉上一份的结果态并复位「输入已变」；详细预算取数回包时
//      核对还是不是那一条（换配置 / 换链路期间回来的旧瀑布不往上贴）。这几处在 SFC 里，照源码结构查。
//   ④ NGSO / 再生式留空格按灰字入算（第二档 #14a）：withFieldDefaults 补出的值 = 表内灰字（StationGrid ghost）；
//      留空跑一遍 ≡ 把灰字照填一遍跑（引擎出参逐位相同）；对照早先口径（几何仰角 0°、卫星 G/T 回退 2 / 下行 EIRP 回退 46）。
//   ⑤ 格内读数与结果列同源（第二档 #14b）：算过的行读数写成引擎出参、预览按入参指纹让位；再生式不再用窗口闭式算式。
//   ⑥ 星历点序列星（第二档 #16b）：取星走 satSearchPool.orbitSpecOf；主进程换成采样表后 NGSO 自动最差 / 再生式单站
//      几何照算、与同一颗星的 SGP4 吻合；点序列星的轨道高度 / 倾角按采样表回显。分享包轨道来源（#16a）的接线也在这里钉。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const { waterfallTsv, waterfallHeads } = await import('../../../src/shared/lbWaterfallTsv.js')
const { lbDocT } = await import('../../../src/shared/lbDocI18n.js')
const RP = await import('../../../src/regen/regenParams.js')
const { regenDigestParams, regenDigestKeys } = await import('../../../src/regen/regenModeScope.js')
const { buildInputDigest } = await import('../../../src/shared/lbReport.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined && extra !== '' ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

// —— ① TSV ——
const row = (o) => ({ sign: '', label: '', up: '', down: '', total: '', unit: '', ...o })
const SEGS = [
  { no: 1, title: '卫星与转发器', cols: 1, rows: [row({ label: '卫星饱和 EIRP', up: '46.00', unit: 'dBW' })] },
  { no: 2, title: '链路级联', cols: 3, rows: [row({ sign: '+', label: '自由空间损耗', up: '207.10', down: '205.60', total: '', unit: 'dB' })] },
  { no: 3, title: '工况对照', cols: 2, heads: ['晴空', '降雨'], rows: [row({ label: 'C/(N+I)', up: '18.20', down: '12.10', unit: 'dB' }), row({ label: '雨衰', down: '6.10', unit: 'dB' })] },
  { no: 4, title: '逐段汇总', cols: 2, heads: ['C/(N+I)', 'Segment Margin'], rows: [row({ label: '段 1　A → B', up: '15.00', down: '3.20', unit: 'dB' })] },
  { no: 5, title: '列头条数不对', cols: 2, heads: ['只有一个'], rows: [row({ label: 'x', up: '1', down: null, unit: undefined })] }
]
const lines = waterfallTsv(SEGS, (s) => s).split('\n')
const at = (title) => lines.findIndex((l) => l.endsWith(title))
ok('段标题带章节号（与屏幕 / Excel 同号）', lines[0] === '§1  卫星与转发器', lines[0])
ok('单列段不出列头，行直接跟在段标题后', lines[1] === '\t卫星饱和 EIRP\t46.00\tdBW', JSON.stringify(lines[1]))
ok('三列段缺省列头：上行 / 下行 / 合计', lines[at('链路级联') + 1] === '\t\t上行\t下行\t合计\t', JSON.stringify(lines[at('链路级联') + 1]))
ok('★ 工况对照段列头取 heads（晴空 / 降雨，不是上行 / 下行）', lines[at('工况对照') + 1] === '\t\t晴空\t降雨\t', JSON.stringify(lines[at('工况对照') + 1]))
ok('★ 空格保位：只有降雨列有值的代价行不左移', lines[at('工况对照') + 3] === '\t雨衰\t\t6.10\tdB', JSON.stringify(lines[at('工况对照') + 3]))
ok('★ 端到端逐段汇总列头取 heads', lines[at('逐段汇总') + 1] === '\t\tC/(N+I)\tSegment Margin\t', JSON.stringify(lines[at('逐段汇总') + 1]))
ok('heads 条数与列数对不上 → 退回缺省（同 WaterfallTable.headsOf）', lines[at('列头条数不对') + 1] === '\t\t上行\t下行\t', JSON.stringify(lines[at('列头条数不对') + 1]))
ok('null / undefined 记空串（不印 null / undefined）', lines[at('列头条数不对') + 2] === '\tx\t1\t\t', JSON.stringify(lines[at('列头条数不对') + 2]))
ok('每一行的格数 = 列头格数（多列段逐行对齐）', SEGS.every((s, i) => {
  const from = at(s.title), n = s.cols >= 2 ? 3 + s.cols : 4
  return lines.slice(from + 1, from + 1 + (s.cols >= 2 ? 1 : 0) + s.rows.length).every((l) => l.split('\t').length === n)
}))
const en = waterfallTsv([SEGS[1]], lbDocT('en')).split('\n')
ok('英文：缺省列头按报表语言翻（Uplink / Downlink / Total）', en[1] === '\t\tUplink\tDownlink\tTotal\t', JSON.stringify(en[1]))
ok('格内制表符 / 换行压成空格（不在 Excel 里裂格）', waterfallTsv([{ title: 't', cols: 1, rows: [row({ label: 'a\tb\nc', up: '1' })] }]).split('\n')[1] === '\ta b c\t1\t')
ok('waterfallHeads：单列段没有缺省列头', waterfallHeads({ cols: 1 }).length === 0)
ok('单列段即使带 heads 也不出列头行', waterfallTsv([{ title: 't', cols: 1, heads: ['x'], rows: [row({ label: 'a', up: '1' })] }]).split('\n')[1] === '\ta\t1\t')
for (const win of ['src/linkbudget/LinkBudgetApp.vue', 'src/ngso/NgsoLinkBudgetApp.vue', 'src/regen/RegenLinkBudgetApp.vue', 'src/e2e/E2eLinkBudgetApp.vue']) {
  const src = read(win)
  const fn = (src.match(/\nasync function copyWaterfallTsv\(\) \{\n[\s\S]*?\n\}\n/) || [''])[0]
  ok(`${win.split('/').pop()}：TSV 复制走 shared/lbWaterfallTsv.js`, /waterfallTsv\(segments\.value, lbDocT\(reportLang\.value\)\)/.test(fn) && /await navigator\.clipboard\.writeText/.test(fn), fn.slice(0, 50))
}

// —— ② 再生式报告输入清单按模块取字段 ——
const sat = RP.defaultsFor(RP.SAT_FIELDS), bb = RP.defaultsFor(RP.CARRIER_FIELDS), es = RP.defaultsFor(RP.ES_FIELDS)
const blockKeys = (d) => d.map((b) => b.key).join(',')
const rowsOf = (d, key) => ((d.find((b) => b.key === key) || {}).rows || [])
const has = (d, key, label) => rowsOf(d, key).some((r) => r.label === label)
const valOf = (d, key, label) => (rowsOf(d, key).find((r) => r.label === label) || {}).value
{
  const tx = { ...RP.defaultsFor(RP.TX_FIELDS), earthStationLocation: '喀什', longitude: '75.99', latitude: '39.47', slantRange: '9876.5' }
  const p = RP.buildRegenParams(sat, bb, tx, es)
  Object.assign(p.linkParams, { distanceMode: 'slantRange', slantRange: 9876.5, rxDistanceMode: 'slantRange', rxSlantRange: 9876.5 })
  const params = { ...p, opt: { mode: 'power', powerW: 0.2 } }
  const full = buildInputDigest(RP.FIELD_GROUPS, params, 'zh')
  ok('（对照）全量入参交出去会多印一整块「收信站群」', full.some((b) => b.key === 'downlink'), blockKeys(full))
  const d = buildInputDigest(RP.FIELD_GROUPS, regenDigestParams('uplink', params), 'zh')
  ok('★ 上行：不印「收信站群」，载波 / 卫星群 / 发信站群照出', blockKeys(d) === 'carrier,sat,uplink', blockKeys(d))
  ok('上行：卫星群只留上行那一侧（无下行频率 / 下行 C/ACI）', has(d, 'sat', '上行频率') && !has(d, 'sat', '下行频率') && !has(d, 'sat', '下行C/ACI'))
  ok('上行：发信站群带发射链（天线口径 / 馈线损耗）与站址', has(d, 'uplink', '天线口径') && has(d, 'uplink', '馈线损耗') && valOf(d, 'uplink', '地球站位置') === '喀什')
  ok('上行：「功放功率预设」取 opt.powerW（投影原样交 opt）', regenDigestParams('uplink', params).opt.powerW === 0.2)
  ok('★ 上行：清单里印出「功放功率预设」0.2 W', valOf(d, 'uplink', '功放功率预设') === '0.2', valOf(d, 'uplink', '功放功率预设'))
  ok('上行：投影后的入参不含收侧占位（rxAntennaDiameter / rxEIRP）', !('rxAntennaDiameter' in regenDigestParams('uplink', params).linkParams) && !('rxEIRP' in regenDigestParams('uplink', params).linkParams))
}
{
  const rx = { ...RP.defaultsFor(RP.RX_FIELDS), rxEarthStationLocation: '三亚', rxLongitude: '109.5', rxLatitude: '18.25', rxEIRP: '25', rxSlantRange: '9000' }
  const p = RP.buildRegenDownlinkParams(sat, bb, rx, es)
  const d = buildInputDigest(RP.FIELD_GROUPS, regenDigestParams('downlink', { ...p, opt: { mode: 'power' } }), 'zh')
  ok('★ 下行：不印上行占位（发信站群），收信站群照出', blockKeys(d) === 'carrier,sat,downlink', blockKeys(d))
  ok('下行：天线口径取收侧（本站 2.4 m，不是上行占位 6.2 m）', valOf(d, 'downlink', '天线口径') === String(es.antennaDiameter), valOf(d, 'downlink', '天线口径'))
  ok('下行：卫星群只留下行那一侧', has(d, 'sat', '下行频率') && !has(d, 'sat', '上行频率') && !has(d, 'sat', 'HPA C/IM'))
}
{
  const isl = { ...RP.defaultsFor(RP.ISL_FIELDS), islRangeKm: '4200' }
  const p = RP.buildRegenIslParams(null, bb, isl)
  p.satParams.islHopDistance = 4200
  const params = { ...p, opt: { visibilityPct: null } }
  const full = buildInputDigest(RP.FIELD_GROUPS, params, 'zh')
  ok('（对照）全量入参交出去会印出「发 / 收」两座假站', full.some((b) => b.key === 'uplink') && full.some((b) => b.key === 'downlink'), blockKeys(full))
  const d = buildInputDigest(RP.FIELD_GROUPS, regenDigestParams('isl', params), 'zh')
  ok('★ 星间：只出载波与星间链路群，不印两座假站', blockKeys(d) === 'carrier,isl', blockKeys(d))
  ok('星间：发射 EIRP / 接收 G/T 照出', has(d, 'isl', '发射EIRP') && has(d, 'isl', '接收G/T'))
  ok('星间：卫星身份与上下行占位频率不当输入印', !d.some((b) => b.rows.some((r) => r.label === '上行频率' || r.label === '地球站位置')))
}
ok('无留底入参（激光不走扫描通道）→ 不出清单', regenDigestParams('laser', null) === null)
ok('未知模块按上行口径取字段', regenDigestKeys('nope').has('opPowerW') && !regenDigestKeys('nope').has('rxEIRP'))

// —— ③ 换配置清结果（结构守门）——
// 顶层函数体：从声明行切到第一处行首的「}」（四窗 <script setup> 都是两格缩进的写法）
const fnBody = (src, sig) => { const i = src.indexOf('\n' + sig); if (i < 0) return ''; const j = src.indexOf('\n}\n', i + 1); return j < 0 ? '' : src.slice(i, j + 3) }
for (const win of ['src/linkbudget/LinkBudgetApp.vue', 'src/ngso/NgsoLinkBudgetApp.vue']) {
  const src = read(win)
  const nm = win.split('/').pop()
  const apply = fnBody(src, 'function applyState(st) {')
  const clear = fnBody(src, 'function clearResults() {')
  ok(`${nm}：applyState 先清上一份的结果（clearResults）`, /\n\s+clearResults\(\)\n/.test(apply))
  const need = ['links.value = []', 'segments.value = []', 'sweepParamsByRow.value = {}', 'computedVals.value = {}', 'resColUnits.value = {}', "focusRowId.value = ''", 'selected.value = 0', 'resultsStale.value = false', 'invalidateSlaScan()']
  const miss = need.filter((s) => !clear.includes(s))
  ok(`${nm}：clearResults 清全结果态并复位「输入已变」`, !!clear && !miss.length, miss.join(' · '))
  ok(`${nm}：详细预算回包核对仍是那一条才贴`, /if \(sel\.value === l\) segments\.value = segs/.test(fnBody(src, 'async function loadWaterfall() {')))
}
{
  const src = read('src/regen/RegenLinkBudgetApp.vue')
  const apply = fnBody(src, 'function applyState(st) {')
  ok('RegenLinkBudgetApp.vue：applyState 清四个模块的结果并补清详细预算 / 聚焦行',
    /for \(const k of MODE_KEYS\) clearModuleResults\(k\)/.test(apply) && apply.includes('segments.value = []') && apply.includes("focusRowId.value = ''"))
  ok('RegenLinkBudgetApp.vue：详细预算回包核对仍是那一条才贴', /if \(sel\.value === l\) segments\.value = segs/.test(fnBody(src, 'async function loadWaterfall() {')))
  ok('RegenLinkBudgetApp.vue：报告输入清单走 regenDigestParams', /paramsFor: \(l\) => regenDigestParams\(/.test(src))
  const ground = fnBody(src, 'async function computeGround(mode) {')
  ok('RegenLinkBudgetApp.vue：上 / 下行取结果处都改写成本跳时延（regenHopDelay ×2、regenHopGeometry ×2）',
    (ground.match(/regenHopDelay\(d, side\)/g) || []).length === 2 && (ground.match(/regenHopGeometry\(geo, side\)/g) || []).length === 2)
}
{
  const src = read('src/e2e/E2eLinkBudgetApp.vue')
  const apply = fnBody(src, 'function applyState(st) {')
  const need = ['delete results[k]', 'delete errors[k]', 'delete geoSolved[k]', 'segments.value = []', 'resultsStale.value = false', 'invalidateSlaScan()']
  const miss = need.filter((s) => !apply.includes(s))
  ok('E2eLinkBudgetApp.vue：applyState 清结果 / 报错 / 解出的几何 / 详细预算并复位「输入已变」', !!apply && !miss.length, miss.join(' · '))
  ok('E2eLinkBudgetApp.vue：详细预算回包核对仍是那一条才贴', /if \(curResult\.value === d\) segments\.value = segs/.test(fnBody(src, 'async function refreshDoc() {')))
}

// —— ④⑤⑥ 共用：真引擎 + 默认站址取值 ——
const { createRequire } = await import('node:module')
const coreReq = createRequire(import.meta.url)
const core = coreReq('../index.js')
const NP = await import('../../../src/ngso/ngsoParams.js')
const { withDefaultSite, defaultSiteValue, TX_SITE, RX_SITE } = await import('../../../src/shared/lbDefaultSite.js')
const DSG = (() => { const g = core.defaultSiteGeo(); return { lat: g.lat, lon: g.lon, rainRate: Number(g.rainRate), altitude: g.altitude == null ? null : Number(g.altitude) } })()
const blankOf = (fields) => { const r = {}; for (const f of fields) r[f.key] = ''; return r }
const NGSO_SRC = read('src/ngso/NgsoLinkBudgetApp.vue'), REGEN_SRC = read('src/regen/RegenLinkBudgetApp.vue')

// —— ④ 留空格按灰字入算（第二档 #14a）——
{
  const W = NP.withFieldDefaults
  const f0 = [{ key: 'a', type: 'num', def: '10', target: 'link' }, { key: 'b', type: 'num', def: '', target: 'link' }, { key: 'c', type: 'text', def: '北京', target: 'link' }, { key: 'd', type: 'num', def: '1', target: 'meta' }, { key: 'e', type: 'num', def: '7', target: 'op' }]
  const o0 = { a: '', b: '', c: '', d: '', e: '  ', z: 'keep' }
  const w0 = W(o0, f0)
  ok('withFieldDefaults：留空数值格补 f.def（含 target:op 的功放预设）', w0.a === '10' && w0.e === '7')
  ok('withFieldDefaults：缺省为空的格（斜距 / 星间 C/I）、文本、内部引用不补', w0.b === '' && w0.c === '' && w0.d === '')
  ok('withFieldDefaults：原对象不改、其余键照带', o0.a === '' && w0.z === 'keep')
  const o1 = { a: '0', b: '', c: '', d: '', e: '3' }
  ok('withFieldDefaults：手填 0 照用；无可补 → 原样返回同一对象', W(o1, f0) === o1)
  ok('再生式 regenParams 转出同一个 withFieldDefaults', RP.withFieldDefaults === W)

  // StationGrid 的灰字：ghostOf（站址留空时默认站址的 R0.01% / 海拔）优先，否则 f.def
  const ghost = (r, f) => { const g = defaultSiteValue(r, f.key, DSG); return g != null && g !== '' ? g : f.def }
  const LINK = [...NP.TX_FIELDS, ...NP.RX_FIELDS]
  const effN = (r) => W(withDefaultSite(r, DSG), LINK)
  for (const [nm, r] of [['全留空行', blankOf(LINK)], ['只落了发信站', { ...blankOf(LINK), earthStationLocation: '上海', longitude: '121.4737', latitude: '31.2304' }]]) {
    const e = effN(r)
    const bad = LINK.filter((f) => f.type === 'num' && f.target !== 'meta' && f.def !== '' && String(r[f.key]).trim() === '' && String(e[f.key]) !== String(ghost(r, f)))
    ok(`NGSO ${nm}：每个留空数值格的入算值 = 表内灰字`, !bad.length, bad.map((f) => f.key).join(','))
  }
  // 引擎：LEO 550 km 北京→上海，自动最差未选星（闭式圆轨道），只填了两侧站址、其余留空
  const satF = { ...NP.defaultsFor(NP.SAT_FIELDS), orbitAltitude: '550', orbitInclination: '53' }
  const bbF = NP.defaultsFor(NP.CARRIER_FIELDS)
  const txEsF = { ...NP.defaultsFor(NP.ES_COMMON_FIELDS), ...NP.defaultsFor(NP.ES_TX_FIELDS) }
  const rxEsF = { ...NP.defaultsFor(NP.ES_COMMON_FIELDS), ...NP.defaultsFor(NP.ES_RX_FIELDS), antennaDiameter: '3.7' }
  const runN = (site) => {
    const { satParams, linkParams } = NP.buildParams(satF, bbF, site, site, txEsF, rxEsF)
    const g = core.solveNgsoMutualWorstCase({
      orbit: { type: 'circular', altKm: 550, inclDeg: 53 },
      tx: { latDeg: parseFloat(site.latitude), minElevDeg: parseFloat(site.minElevation) || 0, freqGHz: 14.25 },   // 窗口原写法
      rx: { latDeg: parseFloat(site.rxLatitude), minElevDeg: parseFloat(site.rxMinElevation) || 0, freqGHz: 12.5 }
    })
    if (!g.feasible) return { err: g.reason }
    const lp = { ...linkParams, distanceMode: 'slantRange', slantRange: g.worst.up.slantKm, minElevation: g.worst.up.elevDeg, rxDistanceMode: 'slantRange', rxSlantRange: g.worst.dn.slantKm, rxMinElevation: g.worst.dn.elevDeg }
    const r = core.computeLinkModeNGSO(satParams, lp, { mode: 'margin' })
    return r && r.success ? r.data : { err: (r && r.message) || '失败' }
  }
  const rowBS = { ...blankOf(LINK), earthStationLocation: '北京', longitude: '116.4074', latitude: '39.9042', rxEarthStationLocation: '上海', rxLongitude: '121.4737', rxLatitude: '31.2304' }
  const filled = { ...rowBS }
  for (const f of LINK) if (f.type === 'num' && f.target !== 'meta' && f.def !== '' && String(filled[f.key]).trim() === '') filled[f.key] = f.def
  const dNew = runN(effN(rowBS)), dFill = runN(effN(filled))
  ok('★ NGSO：留空跑 ≡ 把灰字照填一遍跑（引擎出参逐位相同）', !dNew.err && JSON.stringify(dNew) === JSON.stringify(dFill), dNew.err || '')
  ok('NGSO：入算后卫星 G/T = 灰字 10 dB/K、最差仰角 = 灰字门限 10°', Number(dNew.satelliteGTResult) === 10 && Number(dNew.elevationResult) === 10, `${dNew.satelliteGTResult} / ${dNew.elevationResult}`)
  const dOld = runN(withDefaultSite(rowBS, DSG))   // 早先：留空格原样下去
  const gap = 10 * Math.log10(parseFloat(dOld.paRecommendation) / parseFloat(dNew.paRecommendation))
  ok('（对照）早先口径：几何仰角 0°、卫星 G/T 回退 2 dB/K，功放建议差 > 10 dB', !dOld.err && Number(dOld.elevationResult) === 0 && Number(dOld.satelliteGTResult) === 2 && gap > 10, `${dOld.paRecommendation} W vs ${dNew.paRecommendation} W，${gap.toFixed(1)} dB`)
  // 只落了发信站：收端站址留空 → 按默认站址（灰字「北京」那组经纬度）解几何，不再是 NaN
  const half = { ...blankOf(LINK), earthStationLocation: '上海', longitude: '121.4737', latitude: '31.2304' }
  const eh = effN(half)
  ok('只落了发信站：收端经纬度补成默认站址（= 灰字）', Number(eh.rxLongitude) === core.DEFAULT_SITE.lon && Number(eh.rxLatitude) === core.DEFAULT_SITE.lat)
  const omm = { type: 'omm', noradId: '25544', epoch: '2026-10-16T00:00:00.000Z', meanMotion: 15.5, ecc: 0.0005, incl: 51.6, raan: 120, argp: 90, ma: 10, bstar: 0.0001 }
  const stOf = (r) => ({   // NgsoLinkBudgetApp.geomStations 的取数（一行同时是发端与收端）
    tx: { lonDeg: parseFloat(r.longitude), latDeg: parseFloat(r.latitude), altKm: (parseFloat(r.altitude) || 0) / 1000, minElevDeg: parseFloat(r.minElevation) || 0, freqGHz: 14.25 },
    rx: { lonDeg: parseFloat(r.rxLongitude), latDeg: parseFloat(r.rxLatitude), altKm: (parseFloat(r.rxAltitude) || 0) / 1000, minElevDeg: parseFloat(r.rxMinElevation) || 0, freqGHz: 12.5 }
  })
  const q = { orbit: omm, t0ISO: '2026-10-16T06:00:00.000Z', horizonHours: 12 }
  const gOld = core.solveNgsoMutualWorstCase({ ...q, ...stOf(withDefaultSite(half, DSG)) })
  const gNew = core.solveNgsoMutualWorstCase({ ...q, ...stOf(eh) })
  ok('（对照）早先：收端站址 NaN，自动最差报两站不互视', !gOld.feasible, gOld.reason || '')
  ok('★ 补齐后：上海 → 北京互视最差可解、两站仰角 ≥ 灰字 10°', gNew.feasible && gNew.worst.up.elevDeg >= 10 - 1e-6 && gNew.worst.dn.elevDeg >= 10 - 1e-6, gNew.reason || '')

  // 再生式：下行 EIRP 留空 = 灰字 25 dBW（引擎弯管回退 46）；上行卫星 G/T 留空 = 灰字 10 dB/K（引擎回退 2）；站型口径 / 功放预设留空 = 灰字
  const rsat = RP.defaultsFor(RP.SAT_FIELDS), rbb = RP.defaultsFor(RP.CARRIER_FIELDS)
  const res = RP.withFieldDefaults({ ...RP.defaultsFor(RP.ES_FIELDS), antennaDiameter: '', opPowerW: '' }, RP.ES_FIELDS)
  ok('再生式地球站库：口径 / 功放预设留空 = 灰字 2.4 m / 0.2 W', res.antennaDiameter === '2.4' && res.opPowerW === '0.2')
  const rxE = RP.withFieldDefaults(withDefaultSite({ ...blankOf(RP.RX_FIELDS), rxEarthStationLocation: '三亚', rxLongitude: '109.5', rxLatitude: '18.25' }, DSG, [RX_SITE]), RP.RX_FIELDS)
  const pd = RP.buildRegenDownlinkParams(rsat, rbb, rxE, res)
  const rd = core.computeRegenDownlinkMode(pd.satParams, { ...pd.linkParams, distanceMode: 'slantRange', slantRange: 9000, rxDistanceMode: 'slantRange', rxSlantRange: 9000 }, { mode: 'power' })
  ok('★ 再生式下行：「再生下行 EIRP」留空按灰字 25 dBW 入算（不再是引擎回退 46）', rd.success && Number(rd.data.EIRPsResult) === 25, rd.success ? rd.data.EIRPsResult : rd.message)
  const txE = RP.withFieldDefaults(withDefaultSite({ ...blankOf(RP.TX_FIELDS), earthStationLocation: '喀什', longitude: '75.99', latitude: '39.47' }, DSG, [TX_SITE]), RP.TX_FIELDS)
  const pu = RP.buildRegenParams(rsat, rbb, txE, res)
  const ru = core.computeRegenUplinkMode(pu.satParams, { ...pu.linkParams, distanceMode: 'slantRange', slantRange: 9876.5, rxDistanceMode: 'slantRange', rxSlantRange: 9876.5 }, { mode: 'power', powerW: parseFloat(res.opPowerW) })
  ok('★ 再生式上行：卫星 G/T 留空按灰字 10 dB/K、最低仰角按灰字 10° 入算', ru.success && Number(ru.data.satelliteGTResult) === 10 && Number(txE.minElevation) === 10, ru.success ? ru.data.satelliteGTResult : ru.message)

  // 接线（SFC 结构）：组参 / 几何 / 实时列 / 斜距 / 报告几何页 / 发小程序都取入算行
  const N = NGSO_SRC, R = REGEN_SRC
  ok('NGSO：入算行 = withFieldDefaults(withDefaultSite(…))，地球站条目同口径', N.includes('const effRow = (row) => withFieldDefaults(withDefaultSite(row, defSite.value), LINK_FIELDS)') && N.includes('const effEs = (form) => withFieldDefaults(form, ES_FIELDS)'))
  const rei = fnBody(N, 'function rowEngineInputs(row) {')
  ok('NGSO：rowEngineInputs 按入算行组参（发 / 收站型也补齐）', rei.includes('const site = effRow(row)') && rei.includes('effEs(resolveEs(row.stationId).form)') && rei.includes('effEs(resolveEs(row.rxStationId).form)'))
  const cmpN = fnBody(N, 'async function compute() {')
  ok('NGSO：「计算」与实时列同一份入参，几何 / 手动斜距取入算行', cmpN.includes('const inp = rowEngineInputs(row)') && cmpN.includes('const tx = inp.site, rx = inp.site') && cmpN.includes('worstLp = manualLp(linkParams, tx)') && !cmpN.includes('withDefaultSite('))
  ok('NGSO：几何站址取入算行（geomStations 内 effRow）', fnBody(N, 'function geomStations(sat, tx, rx) {').includes('const t = effRow(tx)'))
  ok('NGSO：斜距推算 / 地理图门限 / 报告几何页 / 发小程序取入算值',
    /const rowSlant = \(row, side, altKm\) => \{ const r = effRow\(row\)/.test(N) && N.includes('const row = found ? effRow(found) : null') && N.includes('const e = effRow(row)') &&
    N.includes('txStation: site, rxStation: site, txEs: effEs(txEs.form), rxEs: effEs(rxEs.form)'))
  ok('再生式：入算行（发 / 收两表各补各侧）与地球站条目', R.includes('const effTx = (row) => withFieldDefaults(withDefaultSite(row, defSite.value, [TX_SITE]), TX_FIELDS)') &&
    R.includes('const effRx = (row) => withFieldDefaults(withDefaultSite(row, defSite.value, [RX_SITE]), RX_FIELDS)') && R.includes('const effEs = (form) => withFieldDefaults(form, ES_FIELDS)'))
  const gin = fnBody(R, 'function groundInputs(mode, st) {')
  ok('再生式：groundInputs 按入算行组参、功放预设取补齐后的站型', gin.includes('const site = effRx(st)') && gin.includes('const site = effTx(st)') && gin.includes('const es = effEs(resolveEs(st.stationId).form)'))
  const grd = fnBody(R, 'async function computeGround(mode) {')
  ok('再生式：上 / 下行计算取 groundInputs，几何 / 手动斜距 / §8 门限都按入算行',
    grd.includes('const inp = groundInputs(mode, st)') && !grd.includes('withDefaultSite(') && !/parseFloat\(st\./.test(grd) &&
    grd.includes('s8LinkParams(geo, { minElevDn: site.rxMinElevation })') && grd.includes('s8LinkParams(geo, { minElevUp: site.minElevation })'))
  ok('再生式：斜距推算 / 报告几何页取入算值', R.includes('const rowSlant = (row, side, altKm) => { const r = effSide(row, side)') && R.includes('const st = effRx(rxStations[l.ti] || {})') && R.includes('const st = effTx(txStations[l.ti] || {})'))
}

// —— ⑤ 格内读数与结果列同源（第二档 #14b）——
{
  const N = NGSO_SRC, R = REGEN_SRC
  const cmpN = fnBody(N, 'async function compute() {')
  ok('NGSO：算完把格内读数写成引擎出参（writeTagVals 紧跟 writeResultVals）', /writeResultVals\(out\)\n\s+writeTagVals\(out, tagFp\)/.test(cmpN) && cmpN.includes('tagFp[row._id] = stableStringify(previewSpecOf(inp))'))
  const wtv = fnBody(N, 'function writeTagVals(out, fpByRow) {')
  ok('NGSO：读数取 stationEIRPResult / gOverTeResult / paRecommendation，算失败的行清空',
    wtv.includes('fix2(d.stationEIRPResult)') && wtv.includes('fix2(d.gOverTeResult)') && wtv.includes('_paW: d.paRecommendation') && wtv.includes("{ _eirp: '', _gt: '', _paW: '' }"))
  ok('NGSO：实时预览遇到「输入正是算过的那一份」让位（build 不发、回包不写）', N.includes('if (_resFp[row._id] === fp) { restoreTags(row._id); return null }') && N.includes('if (_resFp[id] != null && _resFp[id] === _pvFp[id]) continue'))
  ok('NGSO：手动几何的实时列入参即「计算」那一份（manualLp），几何模式变了重排预览',
    fnBody(N, 'function previewSpecOf(inp) {').includes('geoManual.value ? manualLp(inp.linkParams, inp.site) : inp.linkParams') && /watch\(\[satConfigs, basebandConfigs, esConfigs, linkRows, satId, satScope, geoMode\], \(\) => preview\.schedule\(\)/.test(N))
  ok('NGSO：换配置清掉读数登记', fnBody(N, 'function clearResults() {').includes('resetTagCache()'))
  ok('再生式：格内读数不再用窗口闭式算式（rxGtFromNoise / powerWToEirp）', !/rxGtFromNoise\(|powerWToEirp\(/.test(R))
  ok('再生式：EIRP / G·T 读 computedVals（引擎出参）', fnBody(R, 'const txCellSub = (f, row) => {').includes('m && m._eirp') && fnBody(R, 'const rxCellSub = (f, row) => {').includes('m && m._gt'))
  const grd = fnBody(R, 'async function computeGround(mode) {')
  ok('再生式：算完写格内读数（writeTagVals），入参指纹按实时列口径记', /await finishCompute\(mode, out, sweepStore\)\n\s+writeTagVals\(mode, out, tagFp\)/.test(grd) && grd.includes('tagFp[st._id] = stableStringify(groundPreviewSpec(mode, inp))'))
  ok('再生式：结果列回填不再顺带写 _paW（切单位档时不拿旧结果顶掉实时值）', !fnBody(R, 'function writeResultVals(out, mode) {').includes('patch._paW'))
  ok('再生式：实时预览按指纹让位、「计算」期间挂起、卸载即停',
    R.includes('if (_resFp[st._id] === fp) { restoreTags(st._id); return null }') && R.includes('watch(computing, (v) => { if (v) groundPreview.pause(); else groundPreview.resume() }') && R.includes('onBeforeUnmount(() => groundPreview.dispose())'))
  ok('再生式：移除模块 / 换配置清读数登记', fnBody(R, 'function clearModuleResults(key) {').includes('dropTagCache(ids)'))
  // 对照：出厂「天线噪温 = 自动」下，窗口闭式 G/T（rxGtFromNoise 按手填 35 K）比引擎 G/T 高（早先格内读数偏高的那半个 dB）
  const rsat = RP.defaultsFor(RP.SAT_FIELDS), rbb = RP.defaultsFor(RP.CARRIER_FIELDS), res = RP.defaultsFor(RP.ES_FIELDS)
  const rxE = RP.withFieldDefaults(withDefaultSite({ ...blankOf(RP.RX_FIELDS), rxLongitude: '116.4074', rxLatitude: '39.9042' }, DSG, [RX_SITE]), RP.RX_FIELDS)
  const p = RP.buildRegenDownlinkParams(rsat, rbb, rxE, res)
  const d = core.computeRegenDownlinkMode(p.satParams, { ...p.linkParams, distanceMode: 'slantRange', slantRange: 10000, minElevation: 10, rxDistanceMode: 'slantRange', rxSlantRange: 10000, rxMinElevation: 10 }, { mode: 'power' })
  const closed = RP.rxGtFromNoise(res, rsat)
  ok('（对照）出厂天线噪温＝自动、10° 仰角：窗口闭式 G/T 比引擎高 ≥ 0.3 dB', d.success && closed - Number(d.data.gOverTeResult) >= 0.3, d.success ? `${closed.toFixed(2)} vs ${d.data.gOverTeResult}` : d.message)
}

// —— ⑥ 星历点序列星（第二档 #16b）+ 分享包轨道来源接线（#16a）——
{
  if (!globalThis.localStorage) {
    const ls = new Map()
    globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => { ls.set(k, String(v)) }, removeItem: (k) => { ls.delete(k) } }
  }
  const { orbitSpecOf, ephemEchoFromTable } = await import('../../../src/ngso/satSearchPool.js')
  const { tableFrom } = await import('../../../src/viz/constellation/ephemTable.js')
  const geomMod = coreReq('../utils/ngsoGeometry.js'), orbitPos = coreReq('../utils/orbitPos.js')
  // 同一颗 LEO 星：SGP4 采样成 60 s 一点的点序列（TEME），主进程 RE_ 换完表之后的 spec 形状
  const omm = { type: 'omm', noradId: '25544', epoch: '2026-10-16T00:00:00.000Z', meanMotion: 15.5, ecc: 0.0005, incl: 51.6, raan: 120, argp: 90, ma: 10, bstar: 0.0001, mdot: 0, mddot: 0 }
  const satrec = geomMod.buildSatrec(omm)
  const t0 = Date.parse(omm.epoch), t = [], pp = [], vv = []
  for (let i = 0; i <= 24 * 60; i++) {
    const ms = t0 + i * 60000, pv = orbitPos.positionAt(satrec, new Date(ms))
    t.push(ms); pp.push(pv.position.x, pv.position.y, pv.position.z); vv.push(pv.velocity.x, pv.velocity.y, pv.velocity.z)
  }
  const rec = { name: 'EPH-LEO', noradId: '800001', orbitType: 'ephem', incl: null, meanMotion: null, ecc: null, ref: { groupId: 'g1', key: 'k1' }, summary: { t0, t1: t[t.length - 1] } }
  // 早先 NGSO 的手拼：非 elements 一律拼 OMM → 全空根数
  const handOmm = { type: 'omm', name: rec.name, noradId: rec.noradId, epoch: rec.epoch, meanMotion: rec.meanMotion, ecc: rec.ecc, incl: rec.incl, raan: rec.raan, argp: rec.argp, ma: rec.ma, bstar: rec.bstar, mdot: rec.mdot, mddot: rec.mddot }
  const pair = { tx: { lonDeg: 116.4074, latDeg: 39.9042, altKm: 0.044, minElevDeg: 10, freqGHz: 14.25 }, rx: { lonDeg: 121.4737, latDeg: 31.2304, altKm: 0.004, minElevDeg: 10, freqGHz: 12.5 } }
  const q = { t0ISO: '2026-10-16T06:00:00.000Z', horizonHours: 6 }
  const gHand = core.solveNgsoMutualWorstCase({ orbit: handOmm, ...pair, ...q })
  ok('（对照）早先手拼的空 OMM：SGP4 初始化失败', !gHand.feasible && /SGP4 初始化失败/.test(gHand.reason || ''), gHand.reason || '')
  const spec = orbitSpecOf(rec)
  ok('orbitSpecOf(点序列记录)：只带引用，不拼根数', spec.type === 'ephem' && spec.ref.groupId === 'g1' && !('meanMotion' in spec))
  const resolved = { ...spec, samples: { t, p: pp, v: vv, frame: 'TEME', spans: null, interp: { method: 'lagrange', samples: 8 } } }
  const gE = core.solveNgsoMutualWorstCaseBatch({ orbit: resolved, pairs: [pair], ...q })[0]
  const gS = core.solveNgsoMutualWorstCaseBatch({ orbit: omm, pairs: [pair], ...q })[0]
  ok('★ NGSO 自动最差（批量入口）吃点序列 spec：可解，最差斜距与同一颗星的 SGP4 相差 < 1 km',
    gE.feasible && gS.feasible && Math.abs(gE.worst.up.slantKm - gS.worst.up.slantKm) < 1 && Math.abs(gE.worst.dn.slantKm - gS.worst.dn.slantKm) < 1,
    gE.feasible && gS.feasible ? `${gE.worst.up.slantKm.toFixed(2)} / ${gS.worst.up.slantKm.toFixed(2)} km` : (gE.reason || gS.reason))
  const gR = core.solveNgsoMutualWorstCase({ orbit: resolved, tx: pair.tx, rx: pair.tx, ...q })
  const acc = core.solveAccessWindows({ orbit: resolved, station: pair.tx, ...q })
  ok('★ 再生式单站几何 + 访问窗口吃点序列 spec', gR.feasible && acc.feasible && acc.totalWindows > 0, gR.reason || acc.reason || '')
  ok('只给引用不给表：点名报错，不静默退成 SGP4', !core.solveNgsoMutualWorstCase({ orbit: spec, ...pair, ...q }).feasible)
  // 表单回显：轨道高度 / 倾角按采样表（口径同 3D 页带星进计算窗）
  const echo = ephemEchoFromTable(tableFrom({ t: Float64Array.from(t), p: Float64Array.from(pp), v: Float64Array.from(vv), method: 'lagrange', samples: 8 }))
  const meanAlt = Math.cbrt(398600.4418 / Math.pow(omm.meanMotion * 2 * Math.PI / 86400, 2)) - 6378.137
  ok('点序列星回显：轨道高度 ≈ 平均高度（±5 km）、倾角 ≈ 51.6°（±0.1°）', !!echo && Math.abs(echo.altKm - meanAlt) < 5 && Math.abs(echo.inclDeg - 51.6) < 0.1, echo ? `${echo.altKm.toFixed(1)} km / ${echo.inclDeg.toFixed(2)}°` : 'null')
  ok('非表 → null', ephemEchoFromTable(null) === null)
  // 接线
  const N = NGSO_SRC, R = REGEN_SRC
  ok('NGSO：星历搜索 / 卫星树关联星都走 orbitSpecOf，窗口里不再手拼 OMM',
    fnBody(N, 'function pickSearchSatFor(cfg, rec) {').includes('orbit = orbitSpecOf(rec)') && fnBody(N, 'async function treeNodeOrbit(node) {').includes('return orbitSpecOf(rec)') && !N.includes("type: 'omm', name: rec.name"))
  ok('NGSO：点序列星选中 / 树关联 / 刷新后按采样表回显高度倾角', (N.match(/echoEphemOrbit\(/g) || []).length >= 4 && fnBody(N, 'async function echoEphemOrbit(cfg, spec) {').includes('await ephemOrbitEcho(spec)'))
  ok('再生式：地图带星按 NORAD 取池记录也走 orbitSpecOf（不手拼）', fnBody(R, 'async function satEntryForCtx(s) {').includes('orbit = poolOrbitSpecOf(rec)') && !fnBody(R, 'async function satEntryForCtx(s) {').includes("type: 'omm', name: rec.name"))
  ok('★ 分享包：NGSO / 再生式卫星条目净化走 shareNgsoSat（树取的星改标 search，不降 manual）',
    N.includes('sanitize: (e) => ({ ...e, ngsoSat: shareNgsoSat(e.ngsoSat || blankNgsoSat()) })') && R.includes('sanitize: (e) => ({ ...e, ngsoSat: shareNgsoSat(normNgsoSat(e.ngsoSat)) })'))
  // 再生式 / 端到端两份卫星面板：树关联 / 星历搜索的点序列星走 orbitSpecOf；orbitToForm 经 echoEphemToForm 按采样表回显、换星作废在途回显
  {
    const { echoEphemToForm } = await import('../../../src/ngso/satSearchPool.js')
    const sat = { key: 'k1', t: Float64Array.from(t), p: Float64Array.from(pp), v: Float64Array.from(vv), method: 'lagrange', samples: 8 }
    const hadWin = 'window' in globalThis, prevWin = globalThis.window
    globalThis.window = { api: { omm: { ephemTable: async (gid) => (gid === 'g1' ? { sats: [sat] } : null) } } }
    try {
      const f1 = { orbitAltitude: '1200', orbitInclination: '53' }
      await echoEphemToForm(f1, spec)
      ok('echoEphemToForm：点序列星按采样表回显高度 / 倾角', Math.abs(Number(f1.orbitAltitude) - meanAlt) < 5 && Math.abs(Number(f1.orbitInclination) - 51.6) < 0.1, `${f1.orbitAltitude} / ${f1.orbitInclination}`)
      const f2 = { orbitAltitude: '1200', orbitInclination: '53' }
      const pend = echoEphemToForm(f2, spec)
      echoEphemToForm(f2, { type: 'omm', meanMotion: 15 })   // 回显在途时换成目录星：晚到的那次不写
      await pend
      ok('echoEphemToForm：换星后晚到的回显作废（表单不被旧星覆盖）', f2.orbitAltitude === '1200' && f2.orbitInclination === '53', `${f2.orbitAltitude} / ${f2.orbitInclination}`)
    } finally { if (hadWin) globalThis.window = prevWin; else delete globalThis.window }
    for (const [nm, src] of [['再生式面板', read('src/regen/RegenSatPanel.vue')], ['端到端面板', read('src/e2e/E2eSatPanel.vue')]]) {
      ok(`${nm}：树关联 / 星历搜索的点序列星走 orbitSpecOf（不拼空 OMM）`,
        fnBody(src, "export async function treeNodeOrbit(node) {").includes("rec.orbitType === 'ephem'") && fnBody(src, 'function pickSearch(rec) {').includes('orbit = orbitSpecOf(rec)'))
      ok(`${nm}：orbitToForm 接 echoEphemToForm（点序列星回显高度 / 倾角）`, fnBody(src, 'export function orbitToForm(form, orbit) {').includes('echoEphemToForm(form, orbit)'))
    }
  }
}

console.log(`lbWorkbenchResults：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
