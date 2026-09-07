// 报告字体（导出报告对话框「字体」三档 → 模型 doc.fonts）在三个出口的落点：
//   xlsx  写格时的 HEI / SONG / FNT 只是意图标记，写盘前 applyBookFont 按 doc.fonts 换成实际字体名（主题字体同换）；
//   docx  样式表（docDefaults / 段落样式 / 关键行字符样式 RptKey）按 doc.fonts 现造；
//   PDF   打印页从 doc.fonts.cssBody / cssHead 取 CSS 栈，主进程 reportStyle.fontsOf 给缺省。
// 没带 fonts 时三处都是模板口径（Times New Roman / 宋体 / 黑体）——没改过的用户产出逐字节不变。
// ★ 报告标题例外：固定 Arial + 黑体、20pt、加粗（TPL.title），无论选了什么字体都不变（用户 2026-09-07 定）。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ★ 路径走 fileURLToPath：项目目录名是中文，import.meta.url 里是 percent-encoded 的
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..').split(path.sep).join('/')
const require = createRequire(ROOT + '/package.json')
const ExcelJS = require('exceljs')
const JSZip = require('jszip')
const report = require(ROOT + '/electron/services/report.js')
const { buildReportDocx } = require(ROOT + '/electron/services/reportDocx.js')
const { fontsOf, TPL } = require(ROOT + '/electron/services/reportStyle.js')
const { normFonts, FNT, SONG, HEI } = require(ROOT + '/electron/services/xlsxFont.js')
const { buildReportModel, labelBundle } = await import('file:///' + ROOT + '/src/shared/lbReport.js')

// 自定义三档刻意不用 Arial：标题固定用 Arial，选别的西文才验得出「标题不跟着走」
const CUSTOM = {
  latin: 'Verdana', cjkBody: '微软雅黑', cjkHeading: '等线',
  cssBody: 'Verdana, "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  cssHead: 'Verdana, DengXian, "等线", sans-serif'
}
assert.deepEqual(TPL.title, { latin: 'Arial', cjk: '黑体', size: 20, bold: true })

function makeModel(fonts) {
  const seg = { no: '1', title: '上行链路 Uplink', role: 'cascade', cols: 3, rows: [
    { label: '地球站 EIRP', up: '62.30', total: '62.30', unit: 'dBW', kind: 'base', num: 62.3, numTotal: 62.3 },
    { label: '自由空间损耗 FSL', sign: '−', up: '207.12', down: '206.05', unit: 'dB', num: 207.12, numDown: 206.05 },
    { label: '小计 C/N', up: '18.42', down: '14.77', total: '12.99', unit: 'dB', kind: 'sub', num: 18.42, numDown: 14.77, numTotal: 12.99 },
    { label: '链路余量 Margin', total: '2.49', unit: 'dB', kind: 'margin', numTotal: 2.49 }
  ] }
  const link = {
    no: 1, rowId: 'r1', txName: '北京', rxName: 'Beijing HQ', ok: true, error: '',
    data: { allocBandwidthResult: '1200', spectralEfficiencyResult: '2.4', PowerBWResult: '900', linkmargin: '2.49', modulationResult: '8PSK', fecResult: '3/4' },
    carrier: { stds: ['DVB-S2X'] },
    inputs: [{ title: '载波与调制', rows: [{ label: '信息速率', value: '2048', unit: 'kbps' }, { label: '调制方式', value: '8PSK', unit: '' }] }],
    segments: [seg], figures: [], sla: null
  }
  const model = buildReportModel({
    lang: 'zh', orbitType: 'GEO', regenMode: 'uplink',
    doc: Object.assign({ docNo: 'T-1', classification: '内部', org: '测试单位', date: '2026-09-07' }, fonts ? { fonts } : {}),
    appVersion: 'test', satelliteName: '中星 6D', frequencyBand: 'Ku',
    calc: { satelliteName: '中星 6D', frequencyBand: 'Ku', mode: '固定功率' }, links: [link]
  })
  model.t = labelBundle('zh')
  report.enrichReportModel(model)
  return model
}

// —— fontsOf / normFonts：缺省与缺项都回模板口径 ——
assert.deepEqual(fontsOf(null), {
  latin: 'Times New Roman', cjkBody: '宋体', cjkHeading: '黑体',
  cssBody: '"Times New Roman", SimSun, "宋体", serif', cssHead: '"Times New Roman", SimHei, "黑体", serif'
})
assert.equal(fontsOf({ fonts: { latin: 'Arial' } }).cjkBody, '宋体')
assert.equal(fontsOf({ fonts: { latin: 'Arial' } }).cssBody, '"Arial", SimSun, "宋体", serif')
assert.equal(fontsOf({ fonts: CUSTOM }).cssHead, CUSTOM.cssHead)
assert.deepEqual(normFonts(null), { latin: FNT, cjkBody: SONG, cjkHeading: HEI })
assert.equal(normFonts({ cjkHeading: '等线' }).cjkHeading, '等线')
assert.equal(normFonts({ cjkHeading: '等线' }).latin, FNT)

// —— xlsx：意图标记 → 实际字体名；主题字体也换；标题固定 ——
async function xlsxFonts(model) {
  const buf = await report.buildReportWorkbook(model)
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf)
  const ws = wb.worksheets[0]
  const runs = (v) => (v && typeof v === 'object' && Array.isArray(v.richText)) ? v.richText : null
  const textOf = (v) => { const r = runs(v); return r ? r.map((t) => t.text).join('') : String(v == null ? '' : v) }
  const cellOf = (pred) => { let hit = null; ws.eachRow((row) => row.eachCell((c) => { if (!hit && pred(textOf(c.value))) hit = c })); return hit }
  const title = cellOf((t) => t.indexOf('链路预算报告') > -1)   // 报告标题：固定 Arial + 黑体 20pt 加粗
  const head = cellOf((t) => t === '1　逐参数对照')               // 章节标题：黑体意图 → 中文标题字体
  const std = cellOf((t) => t === '标准')                          // 表内中文正文：宋体意图 → 中文正文字体
  const val = cellOf((t) => t === 'DVB-S2X')                      // 纯西文格 → 西文字体
  assert.ok(title && head && std && val, '四个探针格都要找得到')
  const zip = await JSZip.loadAsync(buf)
  const theme = await zip.file('xl/theme/theme1.xml').async('string')
  const tr = runs(title.value) || []
  return {
    title: { cjk: title.font.name, latin: (tr.find((r) => /[A-Za-z0-9]/.test(r.text)) || { font: {} }).font.name, size: title.font.size, bold: !!title.font.bold },
    head: head.font.name, std: std.font.name, val: val.font.name, theme
  }
}
{
  const d = await xlsxFonts(makeModel(null))
  assert.deepEqual(d.title, { cjk: '黑体', latin: 'Arial', size: 20, bold: true }, '缺省：标题固定')
  assert.equal(d.head, '黑体'); assert.equal(d.std, '宋体'); assert.equal(d.val, 'Times New Roman')
  // 主题字体只看 <a:latin> / <a:ea> 两个主字面：exceljs 自带的主题里另有按文种列的字体表（script="…"），
  // 那里面本来就有 Times New Roman 一类的名字，与我们换的主字面无关
  assert.ok(d.theme.indexOf('<a:latin typeface="Times New Roman"/>') > -1 && d.theme.indexOf('<a:ea typeface="宋体"/>') > -1, '缺省主题字体 = 模板口径')
  const c = await xlsxFonts(makeModel(CUSTOM))
  assert.deepEqual(c.title, { cjk: '黑体', latin: 'Arial', size: 20, bold: true }, '自定义三档后标题仍固定')
  assert.equal(c.head, '等线'); assert.equal(c.std, '微软雅黑'); assert.equal(c.val, 'Verdana')
  assert.ok(c.theme.indexOf('<a:latin typeface="Verdana"/>') > -1 && c.theme.indexOf('<a:ea typeface="微软雅黑"/>') > -1, '自定义主题字体')
  assert.ok(c.theme.indexOf('<a:latin typeface="Times New Roman"/>') < 0, '自定义后主字面不再是模板西文字体')
}

// —— docx：docDefaults / 标题样式 / 关键行字符样式 / 封面主标题固定 ——
async function docxParts(model) {
  const buf = await buildReportDocx(model)
  const zip = await JSZip.loadAsync(buf)
  return { styles: await zip.file('word/styles.xml').async('string'), doc: await zip.file('word/document.xml').async('string') }
}
const styleBlock = (xml, id) => { const m = new RegExp(`<w:style [^>]*w:styleId="${id}"[^>]*>[\\s\\S]*?<\\/w:style>`).exec(xml); return m ? m[0] : '' }
const docDefaults = (xml) => { const m = /<w:docDefaults>[\s\S]*?<\/w:docDefaults>/.exec(xml); return m ? m[0] : '' }
const isBold = (s) => /<w:b\/>|<w:b w:val="(1|true|on)"\/>/.test(s)
{
  const d = await docxParts(makeModel(null))
  assert.ok(/w:ascii="Times New Roman"/.test(docDefaults(d.styles)) && /w:eastAsia="宋体"/.test(docDefaults(d.styles)), '缺省 docDefaults = 模板口径')
  assert.ok(/w:eastAsia="黑体"/.test(styleBlock(d.styles, 'RptH1')), '缺省标题 1 = 黑体')
  assert.ok(/w:styleId="RptKey"/.test(d.styles), '关键行字符样式在样式表里')
  assert.ok(/<w:rStyle w:val="RptKey"\/>/.test(d.doc), '级联表关键行（小计 / 余量）引用了 RptKey')
  const cv = styleBlock(d.styles, 'CvTitle')
  assert.ok(/w:ascii="Arial"/.test(cv) && /w:eastAsia="黑体"/.test(cv) && /<w:sz w:val="40"\/>/.test(cv) && isBold(cv), '封面主标题 = Arial + 黑体 20pt 加粗')
  assert.ok(!isBold(styleBlock(d.styles, 'CvSub')) && !isBold(styleBlock(d.styles, 'CvOrg')), '单位 / 日期两行不加粗')
  const c = await docxParts(makeModel(CUSTOM))
  assert.ok(/w:ascii="Verdana"/.test(docDefaults(c.styles)) && /w:eastAsia="微软雅黑"/.test(docDefaults(c.styles)), '自定义 docDefaults')
  const h1 = styleBlock(c.styles, 'RptH1')
  assert.ok(/w:ascii="Verdana"/.test(h1) && /w:eastAsia="等线"/.test(h1), '自定义标题 1')
  assert.ok(h1.indexOf('Times New Roman') < 0 && h1.indexOf('黑体') < 0, '自定义后标题 1 里不再有模板字体')
  const key = styleBlock(c.styles, 'RptKey')
  assert.ok(/w:ascii="Verdana"/.test(key) && /w:eastAsia="等线"/.test(key), 'RptKey = 西文 + 中文标题那一档')
  const cvc = styleBlock(c.styles, 'CvTitle')
  assert.ok(/w:ascii="Arial"/.test(cvc) && /w:eastAsia="黑体"/.test(cvc) && /<w:sz w:val="40"\/>/.test(cvc) && isBold(cvc), '自定义三档后封面主标题仍固定')
}
console.log('lbReportFonts: all passed')
