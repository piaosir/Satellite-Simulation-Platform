// 空间态势报告的 Word 出口（electron/services/reportSsaDocx.js）。运行：npm test
//
// ★ 这套测试盯的是「屏上与纸上是不是同一份报告」—— 两个渲染端各数各的表号 / 图号（模型里
//   刻意不存序号），一旦口径分岔，屏上「表 12」到了 Word 里就成了「表 13」，而两边各自看都对。
//   故所有断言都从【同一份真模型】出发：夹具 → ssaReport.buildSsaModel → buildSsaDocx → 解 zip 读
//   word/document.xml，再与屏上那套编号规则（SsaDoc.vue 的 numberOf）对账。
//   另外三条：主权口径（ROC 行印「中国台湾」）、英文版零汉字、通篇无文字判定词。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ★ 路径走 fileURLToPath：项目目录名是中文，import.meta.url 里是 percent-encoded 的
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..').split(path.sep).join('/')
const require = createRequire(ROOT + '/package.json')
const JSZip = require('jszip')
const { buildSsaDocx } = require(ROOT + '/electron/services/reportSsaDocx.js')
const S = await import('file:///' + ROOT + '/src/shared/ssaStats.js')
const RP = await import('file:///' + ROOT + '/src/shared/ssaReport.js')
const { parseOMMCsv } = await import('file:///' + ROOT + '/src/viz/constellation/tle.js')

let pass = 0
// SSA_SOFT=1：失败只记下不中断（补丁前逐条确认新断言是红的用）
const SOFT = !!process.env.SSA_SOFT
let fail = 0
const soft = (f, m) => { try { f(); pass++ } catch (e) { if (!SOFT) throw e; fail++; console.log('✗ ' + m) } }
const ok = (c, m) => soft(() => assert.ok(c, m), m)
const eq = (a, b, m) => soft(() => assert.deepEqual(a, b, m), m)

const read = (f) => fs.readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8')
const rows = S.parseSatcatCsv(read('satcat.sample.csv'))
const gp = parseOMMCsv(read('ssaGp.sample.csv'))
const asOf = '2026-09-16T00:00:00Z'

// 1×1 透明 PNG（正确编码，含 CRC —— 手写 base64 常常 CRC 就错，docx 侧会当坏图整块跳过）
const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const groups = [{ id: 'g1', name: '我的星座', sats: rows.filter((r) => r.type === 'PAY').slice(0, 8).map((r) => ({ id: r.norad, name: r.name })) }]

function model (lang, scope, withFigures) {
  const m = RP.buildSsaModel({
    satcat: rows,
    gp,
    groups: scope === 'groups' ? groups : [],
    scope,
    opts: {},
    lang,
    doc: {
      title: '', docNo: 'CS-SSA-2026-001', classification: '内部', org: '中国卫通集团有限公司',
      date: '2026-09-16', logo: null, fonts: null, appVersion: '1.4.10', generatedAt: asOf
    },
    dataMeta: {
      satcatAt: asOf, satcatSource: 'network', satcatRows: rows.length,
      gpAt: asOf, gpSource: 'bundled', gpRows: gp.length, gpGroups: 1, asOf
    }
  })
  if (withFigures) for (const k of Object.keys(m.figures)) m.figures[k].png = PNG1
  return m
}

// 屏上那套编号规则，逐字复刻 src/ssa/SsaDoc.vue 的 view computed：
//   占表号的只有【非空的 table 块】—— kv 不占（屏上是定义列表、Word 里是标签值两列的排版件）、
//   空表不占（Word 端整块不印）；figure 另有一套图号。
//   （2026-09-17 起附录「口径与判据」也是正式 table，同样占号 —— 原先的 note 块型已删。）
//   这个函数是两端口径的裁判，改它必须同时改那两个渲染端。
//   ★ 2026-10-15 起【按章编】（样式规范 §D）：正文「3-2」、附录「A1」、卫星组章「G1-2」；关键指标页不出表号。
function screenNumbers (m) {
  const tables = [], figs = []
  for (const s of m.sections) {
    let t = 0, f = 0
    const no = (k) => (s.appendix ? s.no + k : s.no ? s.no + '-' + k : String(k))
    for (const b of s.blocks) {
      if (b.type === 'table' && (b.rows || []).length) tables.push(no(++t) + '　' + b.caption)
      else if (b.type === 'figure') figs.push(no(++f) + '　' + b.caption)
    }
  }
  return { tables, figs }
}
// 章标题：附录印「附录 A　…」；关键指标页（无章号）只印标题
const headText = (s) => (s.appendix ? '附录 ' + s.no + '　' + s.title : s.no ? s.no + '　' + s.title : s.title)
const headTextEn = (s) => (s.appendix ? 'Appendix ' + s.no + '  ' + s.title : s.no ? s.no + '  ' + s.title : s.title)
// 表题 / 图题段落：「表 3-2　…」「表 A1　…」；去掉末尾「（共 N 条）」再比
const TBL_RE = /^表 ((?:G?\d+-\d+)|(?:[A-Z]\d+))　/
const FIG_RE = /^图 ((?:G?\d+-\d+)|(?:[A-Z]\d+))　/
const capsT = (ps) => ps.filter((p) => TBL_RE.test(p)).map((p) => p.replace(/^表 /, '').replace(/（共 [\d\u2009,]+ 条）$/, ''))
const capsF = (ps) => ps.filter((p) => FIG_RE.test(p)).map((p) => p.replace(/^图 /, ''))

const textOf = (xml) => xml.replace(/<w:tab\/>/g, ' ').replace(/<[^>]+>/g, '')
async function docXml (m) {
  const buf = await buildSsaDocx(m)
  const zip = await JSZip.loadAsync(buf)
  return { xml: await zip.file('word/document.xml').async('string'), zip, bytes: buf.length }
}
// 段落逐条取文本（题注/标题都是独立段落）
const paras = (xml) => [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((x) => textOf(x[0])).filter((s) => s.trim())

// ===================================================================================
// ① 全量 · 中文 · 含图
// ===================================================================================
{
  const m = model('zh', 'all', true)
  const before = JSON.stringify(m)
  const { xml, zip, bytes } = await docXml(m)
  ok(bytes > 8000, `① 出得来一份 docx（${bytes} B）`)
  eq(JSON.stringify(m), before, '① 模型没被写脏（构建器只读，contract §1 的 JSON 往返仍成立）')

  const ps = paras(xml)
  // 章标题：中文用全角空格
  for (const s of m.sections) {
    ok(ps.some((p) => p === headText(s)), `① 章标题在：${headText(s)}`)
  }
  // 表号 / 图号与屏上逐条对账
  const want = screenNumbers(m)
  const gotT = capsT(ps)
  const gotF = capsF(ps)
  eq(gotT, want.tables, '① 表号与题注逐条等于屏上那套')
  eq(gotF, want.figs, '① 图号与题注逐条等于屏上那套')

  // 附录「口径与判据」是正式三线表：占表号，且号码就是屏上数出来的那一个
  const crit = m.sections.flatMap((s) => s.blocks).find((b) => b.tableId === 't.appendix.criteria')
  ok(crit && crit.type === 'table', '① 「口径与判据」是 table 块')
  const critNo = want.tables.findIndex((x) => x.endsWith('　' + crit.caption)) + 1
  ok(ps.includes('表 A1　' + crit.caption), '① 口径与判据编成「表 A1」（附录按字母编）')
  void critNo
  ok(!m.sections.flatMap((s) => s.blocks).some((b) => b.type === 'note'), '① 模型里不再有 note 块')

  // 图：每张图一个 drawing，数量 = 有 png 的 figure 块数
  const figBlocks = m.sections.flatMap((s) => s.blocks).filter((b) => b.type === 'figure')
  eq((xml.match(/<w:drawing>/g) || []).length, figBlocks.length, `① 正文里的图 = ${figBlocks.length} 张`)
  const media = Object.keys(zip.files).filter((f) => /^word\/media\//.test(f))
  ok(media.length >= 1, '① 图片进了 word/media')

  // 表格数 = 非空的 table/kv 块数 + 关键指标页一张（每组一行组名 + 一行四格，同一张表）
  const allBlocks = m.sections.flatMap((s) => s.blocks)
  const tblBlocks = allBlocks.filter((b) => (b.type === 'table' || b.type === 'kv') && (b.rows || []).length)
  const kpiTables = allBlocks.filter((b) => b.type === 'kpi').length
  ok(kpiTables === 1, '① 关键指标页一张')
  eq((xml.match(/<w:tbl>/g) || []).length, tblBlocks.length + kpiTables, `① 表格数 = ${tblBlocks.length} + 关键指标 ${kpiTables}`)

  // 封面与目录
  ok(ps.some((p) => p.includes('空间态势报告')), '① 封面/页眉有报告标题')
  ok(ps.some((p) => p.includes('CS-SSA-2026-001')), '① 封面有文档编号')
  for (const s of m.sections) ok(ps.some((p) => p.includes(headText(s))), `① 目录/正文里有「${s.title}」`)

  // 主权口径：ROC 只要出现在任何一张表里，印的就必须是「中国台湾」
  if (xml.includes('中国台湾')) ok(!/台湾（中华民国）|中华民国/.test(xml), '① 没有「中华民国」字样')
  else ok(true, '① 本夹具的表里没有 ROC 行（跳过主权断言）')

  // 纯数字：通篇无文字判定词
  const VERDICT = ['达标', '不达标', '良好', '拥挤', '正常', '合格', '不合格', '受限', '健康', '风险', '优秀', '较差']
  const hit = VERDICT.filter((w) => xml.includes(w))
  eq(hit, [], '① 通篇没有文字判定词')
}

// ===================================================================================
// ② 全量 · 英文 · 含图 —— 零汉字
// ===================================================================================
{
  const m = model('en', 'all', true)
  // 封面的单位名与密级是用户填的中文，不该算进「英文版无汉字」的判据里
  m.doc.org = 'China Satcom'
  m.doc.classification = 'Internal'
  const { xml } = await docXml(m)
  const ps = paras(xml)
  for (const s of m.sections) ok(ps.some((p) => p === headTextEn(s)), `② 英文章标题「${headTextEn(s)}」（两个半角空格）`)
  ok(ps.some((p) => /^Table 2\.1 /.test(p)), '② 英文表号是 Table 2.1（按章编，点号）')
  ok(ps.some((p) => /^Figure 2\.1 /.test(p)), '② 英文图号是 Figure 2.1')
  const han = xml.match(/[一-龥]/g) || []
  eq([...new Set(han)], [], `② 英文版正文零汉字${han.length ? '（出现：' + [...new Set(han)].join('') + '）' : ''}`)
}

// ===================================================================================
// ③ 卫星组范围
// ===================================================================================
{
  const m = model('zh', 'groups', true)
  ok(m.sections.some((s) => s.key === 'g:g1'), '③ 模型里有卫星组章')
  const { xml } = await docXml(m)
  const ps = paras(xml)
  ok(ps.some((p) => p.includes('我的星座')), '③ Word 里有组名（自命名不翻）')
  const want = screenNumbers(m)
  eq(capsT(ps), want.tables, '③ 组报告的表号也与屏上逐条一致')
  for (const s of m.sections) ok(ps.some((p) => p === headText(s)), `③ 章标题在：${headText(s)}`)
  // 组报告的章号是 1 / G1 / G2 / …；附录按字母编（不拿数字号，拿了就会排成 1 / G1 / G2 / 2）
  ok(m.sections.filter((x) => x.appendix).every((x) => /^[A-Z]$/.test(x.no)), '③ 组报告的附录按字母编')
  ok(ps.some((p) => p === '附录 A　口径与判据'), '③ Word 里附录标题「附录 A　口径与判据」')
}

// ===================================================================================
// ③b 表号口径的硬碰硬：空表 + 带题注的 kv 块，两端仍须逐条一致
// ===================================================================================
{
  const m = model('zh', 'all', false)
  // 章内插一张空表（筛得太窄时真会出现）与一块带题注的 kv（第 1 章那种）
  m.sections[1].blocks.push({ type: 'table', tableId: 't.empty', caption: '一张空表', source: 'SATCAT', head: ['A', 'B'], rows: [] })
  m.sections[1].blocks.push({ type: 'kv', caption: '一块带题注的读数', rows: [['甲', '1'], ['乙', '2']] })
  m.sections[1].blocks.push({ type: 'table', tableId: 't.after', caption: '空表之后的表', source: 'SATCAT', head: ['A'], rows: [['1']] })
  const { xml } = await docXml(m)
  const ps = paras(xml)
  const gotT = capsT(ps)
  eq(gotT, screenNumbers(m).tables, '★③b 空表不占号、kv 不占号 —— 两端表号逐条一致')
  ok(!gotT.some((p) => /一张空表|一块带题注的读数/.test(p)), '③b 空表与 kv 都没被编成表号')
  ok(ps.includes('一块带题注的读数'), '③b kv 的题注照印，只是不带号')
}

// ===================================================================================
// ④ 不含图：figure 块整块跳过，图号一个不占，表号不受影响
// ===================================================================================
{
  const withFig = model('zh', 'all', true)
  const noFig = model('zh', 'all', false)
  const a = await docXml(withFig)
  const b = await docXml(noFig)
  eq((b.xml.match(/<w:drawing>/g) || []).length, 0, '④ 不含图时正文一张图都没有')
  ok(!paras(b.xml).some((p) => FIG_RE.test(p)), '④ 不含图时一个图号都不出')
  const capsOf = (x) => paras(x).filter((p) => TBL_RE.test(p))
  eq(capsOf(b.xml), capsOf(a.xml), '④ 含不含图，表号与表题注完全一样')
  ok(b.bytes < a.bytes, '④ 不含图的文件更小')
}

// ===================================================================================
// ⑤ 行数封顶：只有模型自己截过的表（b.capped，即成员表按「大表行数」截）才少印，
//    Word 端不再另设一道闸 —— 与屏上 SsaDoc 只认 b.capped 同一口径；全量模式该参数在检查器里是隐藏的。
// ===================================================================================
{
  const bigTable = () => {
    const b = { type: 'table', tableId: 't.big', caption: '超长表', source: 'SATCAT', head: ['A', 'B'], rows: [] }
    for (let i = 0; i < 812; i++) b.rows.push([String(i), String(i * 2)])
    return b
  }
  const rowsOfBig = (xml) => {
    const tbls = [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map((x) => (x[0].match(/<w:tr[ >]/g) || []).length)
    return tbls
  }
  // 没有 capped 的大表：屏上全印，Word 也全印，题注不带「共 N 条」
  const m = model('zh', 'all', false)
  eq(m.opts.rowCap, 500, '⑤ 出厂行数上限 500')
  m.sections[1].blocks.push(bigTable())
  const { xml } = await docXml(m)
  const cap = paras(xml).find((p) => p.includes('超长表'))
  ok(cap && !/（共 \d+ 条）/.test(cap), `⑤ 未截的表题注不带总数：${cap}`)
  ok(rowsOfBig(xml).includes(813), `⑤ 未截的表 812 行全印（+1 表头）；各表行数 ${rowsOfBig(xml).join(',')}`)

  // 全量模式改小「大表行数」也不截非成员表（复现：组模式改过行数再切回全量，所有者表「其余 N 家」与合计行被截）
  const m2 = RP.buildSsaModel({
    satcat: rows, gp, groups: [], scope: 'all', opts: { rowCap: 120 }, lang: 'zh', tz: 'utc',
    doc: { appVersion: '1.4.10' }, dataMeta: { asOf }
  })
  eq(m2.opts.rowCap, 120, '⑤ rowCap 进模型')
  m2.sections[1].blocks.push(bigTable())
  const x2 = (await docXml(m2)).xml
  ok(rowsOfBig(x2).includes(813), `⑤ rowCap=120 时非成员表照样全印；各表行数 ${rowsOfBig(x2).join(',')}`)
  ok(!rowsOfBig(x2).includes(121), '⑤ Word 端没有自己的一道 rowCap 闸')

  // 成员表：模型按 rowCap 截，capped.total 报全表条数；Word 照模型印，题注带总数
  const many = { id: 'gBig', name: '大组', sats: [] }
  for (let i = 0; i < 300; i++) many.sats.push({ id: String(90000 + i), name: 'S' + i })
  const m3 = RP.buildSsaModel({
    satcat: rows, gp, groups: [many], scope: 'groups', opts: { rowCap: 50 }, lang: 'zh', tz: 'utc',
    doc: {}, dataMeta: { asOf }
  })
  const mem = m3.sections.flatMap((x) => x.blocks).find((b) => b.type === 'table' && /成员表/.test(b.caption || ''))
  eq([mem.rows.length, mem.capped.shown, mem.capped.total], [50, 50, 300], '⑤ 成员表按 rowCap 截，capped 报全表条数')
  const x3 = (await docXml(m3)).xml
  ok(rowsOfBig(x3).includes(51), `⑤ Word 成员表 50 行（+1 表头）；各表行数 ${rowsOfBig(x3).join(',')}`)
  const memCap = paras(x3).find((p) => /成员表/.test(p) && /^表 /.test(p))
  ok(memCap && /（共 300 条）$/.test(memCap), `⑤ 成员表题注带总数：${memCap}`)

  // ★ 附录「口径与判据」不吃这道闸：它不是「全表的一截」而是定义，截掉几条 = 交付文档里少几条判据，
  //   而屏上的静态三线表根本不走 rowCap，两边当场对不上。rowCap 的合法下限是 10，判据表 15～21 行，
  //   调小是常规操作 —— 这条钉住 2026-09-17 由 note 升格成 table 时新引入的那个坑。
  const m4 = RP.buildSsaModel({
    satcat: rows, gp, groups: [], scope: 'all', opts: { rowCap: 10, regimes: ['GEO'], constellations: ['starlink'] },
    lang: 'zh', tz: 'utc', doc: { appVersion: '1.4.10' }, dataMeta: { asOf }
  })
  const crit = m4.sections.flatMap((x) => x.blocks).find((b) => b.tableId === 't.appendix.criteria')
  ok(crit.rows.length > 10, `⑤ 夹具里的判据表本来就超过 rowCap=10（${crit.rows.length} 行）`)
  const x4 = await docXml(m4)
  const ps4 = paras(x4.xml)
  const critCap = ps4.find((p) => /口径与判据/.test(p))
  ok(!/（共 \d+ 条）/.test(critCap), `⑤ 判据表题注不带「共 N 条」（它不是全表的一截）：${critCap}`)
  for (const r of crit.rows) ok(ps4.includes(r[1]), `⑤ 判据「${r[1]}」进了 Word（一条都不许被 rowCap 截掉）`)
}

// ===================================================================================
// ⑥b screenNumbers() 声称复刻 SsaDoc.vue —— 把那边的规则钉在这里
// 屏上那份是 .vue，Node 里跑不起来，故退一步盯源码：只允许有【一处】在数表号，且它的条件
// 就是「非空 table」。哪天改了 SsaDoc.vue 而忘了改这里，这条当场红，不会再出现「假绿」。
// ===================================================================================
{
  const src = fs.readFileSync(ROOT + '/src/ssa/SsaDoc.vue', 'utf8')
  ok(/const cap = rows\.length \? tableCap\(chapterNo\(s, \+\+tno/.test(src), '⑥b SsaDoc.vue：非空 table 才占表号（按章编）')
  eq((src.match(/\+\+tno/g) || []).length, 1, '⑥b 屏上只有这一处在数表号（kv 与 note 都不数）')
}

// ===================================================================================
// ⑥ 退化输入不抛：空 sections / 空 figures / 缺 doc
// ===================================================================================
{
  const buf = await buildSsaDocx({ kind: 'ssa', lang: 'zh' })
  ok(buf && buf.length > 2000, '⑥ 空模型也出得来一份 docx，不抛错')
  const m = model('zh', 'all', true)
  for (const k of Object.keys(m.figures)) m.figures[k].png = 'data:image/png;base64,!!!not-a-png'
  const { xml } = await docXml(m)
  eq((xml.match(/<w:drawing>/g) || []).length, 0, '⑥ dataUrl 坏了的图整块跳过，不炸文档')
}

// ===================================================================================
// ⑦ 屏上 ssaFormat.js 与 Word 端 reportSsaStyle.js 的格式化是手写双份 —— 逐条对拍（样式规范 §E.3）
// ===================================================================================
{
  const FS = await import('file:///' + ROOT + '/src/shared/ssaFormat.js')
  const WS = require(ROOT + '/electron/services/reportSsaStyle.js')
  const cases = [
    [[['A', 35026, 0.9], ['B', 2296, 12.25], ['C', -1500, null], ['D', 0, '']], 3, []],
    [[['x', 999, 1.5], ['y', 1000, -0.04]], 3, []],
    [[['', 'abc'], ['类别', '']], 2, [0, 1]],
    [[[12345678, '2026-001', 'GSAT0101']], 3, []]
  ]
  for (const [rows, n, blank] of cases) eq(FS.formatColumns(rows, n, blank), WS.formatColumns(rows, n, blank), '⑦ 两份 formatColumns 逐格一致：' + JSON.stringify(rows))
  eq(FS.formatColumns([['A', 35026], ['B', 2296]], 2)[1][1], '2 296', '⑦ 整表有 ≥ 10000 的数：≥ 1000 的一并细空分组')
  eq(FS.formatColumns([['A', -0.04]], 2)[0][1], '−0.04', '⑦ 负号 U+2212')
  for (const src of ['SATCAT', 'GP', 'SATCAT+GP', '']) for (const lg of ['zh', 'en']) eq(FS.sourceLine(src, lg), WS.sourceLine(src, lg), '⑦ 来源行两份一致 ' + src + ' ' + lg)
  const sec = { no: '3' }, apx = { no: 'A', appendix: true }
  eq([FS.chapterNo(sec, 2, 'zh'), FS.chapterNo(sec, 2, 'en'), FS.chapterNo(apx, 1, 'zh')], ['3-2', '3.2', 'A1'], '⑦ 章内编号')
  eq([WS.chapterNo(sec, 2, 'zh'), WS.chapterNo(sec, 2, 'en'), WS.chapterNo(apx, 1, 'zh')], ['3-2', '3.2', 'A1'], '⑦ Word 端章内编号同口径')
}

// ===================================================================================
// ⑧ 版式（样式规范 §B / §E）：三线表 1.0 / 0.5 pt、页码分段、宽表横向节、来源行、关键指标页、封面数据截至
// ===================================================================================
{
  const m = model('zh', 'all', false)
  const { xml } = await docXml(m)
  ok(/<w:top w:val="single"[^>]*w:sz="8"/.test(xml) && /<w:bottom w:val="single"[^>]*w:sz="4"/.test(xml), '⑧ 三线表线宽 1.0 pt（sz 8）/ 0.5 pt（sz 4）')
  ok(!/<w:(top|bottom) w:val="single"[^>]*w:sz="12"/.test(xml), '⑧ 不再出现模板的 1.5 pt 线（sz 12）')
  ok(/<w:pgNumType [^>]*w:fmt="lowerRoman"/.test(xml), '⑧ 前置节小写罗马页码')
  ok(/<w:pgNumType [^>]*w:fmt="decimal"/.test(xml), '⑧ 正文阿拉伯页码')
  const ps = paras(xml)
  ok(ps.some((p) => p === '数据来源：SATCAT（CelesTrak）。'), '⑧ 表下来源行')
  ok(ps.some((p) => p === '关键指标'), '⑧ 关键指标页标题')
  ok(ps.some((p) => /^数据截至　/.test(p)), '⑧ 封面「数据截至」一行')
  // 19 列成员表：8 pt 密排也放不下 → 横向节
  const g = model('zh', 'groups', false)
  const gx = (await docXml(g)).xml
  ok(/<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/.test(gx), '⑧ 成员表（19 列）切横向节，页面宽高真横过来（297 × 210 mm）')
  ok(!/w:orient="landscape"/.test(xml), '⑧ 全量报告没有要横排的表')
}

if (fail) { console.log('FAIL  ' + fail + ' 项'); process.exit(1) }
console.log(`ssaDocx: ${pass} 项断言全部通过`)

