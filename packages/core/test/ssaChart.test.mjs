// 空间态势报告的图表渲染（src/shared/ssaChartSvg.js）。
//
// 这份测试防四件事：
//   ① 出串的形状被改坏 —— 少了 <svg> 壳、或哪天有人顺手加了 viewBox。加 viewBox 会让
//      non-scaling-stroke 失效，导出的图里线细成发丝（memory「两张图出图分辨率与字体」）；
//   ② print 档掉字体 —— 导出的 SVG 离开页面后没有祖先可继承，逐条 <text> 不写死 font-family
//      就落到栅格化器的默认字体上，报告里一眼看得出不是一套字；
//   ③ 空入参把整份报告带崩 —— 空数组 / 全零必须画出空坐标系，不许抛；
//   ④ 渲染不确定 —— 同一份 spec 两次出串必须逐字节相同，否则报告没法复现（也就意味着
//      函数里混进了时间戳 / 随机数 / toLocaleString 这类跟环境走的东西）。
import assert from 'node:assert/strict'

const { chartSvg, svgSizeOf } = await import('../../../src/shared/ssaChartSvg.js')

let pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++ }
const eq = (a, b, m) => { assert.deepEqual(a, b, m); pass++ }

const count = (s, re) => (String(s).match(re) || []).length
const PATHS = /<path\b/g
const RECTS = /<rect\b/g
const CIRCLES = /<circle\b/g
const LINES = /<line\b/g
const POLYS = /<polyline\b/g
const EMPTY = '暂无数据。'

// print 档：每一条 <text> 都必须自带 font-family（<title> 子元素不算 <text>，正则按词边界卡住）
function textsAllHaveFont(svg) {
  const re = /<text\b[^>]*>/g
  let m, n = 0
  while ((m = re.exec(svg)) !== null) {
    n++
    if (!/\bfont-family="/.test(m[0])) return { okAll: false, n, bad: m[0] }
  }
  return { okAll: n > 0, n, bad: '' }
}
// 壳的四条硬规矩，八型都要过
function shell(svg, tag) {
  ok(svg.startsWith('<svg'), `${tag}：以 <svg 开头`)
  ok(svg.endsWith('</svg>'), `${tag}：以 </svg> 结尾`)
  ok(!/viewBox/.test(svg), `${tag}：不带 viewBox`)
  ok(/ width="\d+" height="\d+"/.test(svg), `${tag}：带 width / height 属性`)
}

const SCREEN = { theme: 'screen', width: 720, lang: 'zh' }
const PRINT = { theme: 'print', width: 1200, lang: 'zh' }

// —— 八型的夹具 ——
const SPECS = {
  bar: {
    type: 'bar',
    cats: ['2022', '2023', '2024', '2025'],
    series: [{ name: '发射', data: [120, 180, 240, 300] }, { name: '陨落', data: [80, 95, 110, 130] }],
    yLabel: '数量', xLabel: '年'
  },
  hbar: {
    type: 'hbar',
    items: [
      { label: 'US', value: 8800 }, { label: 'PRC', value: 1200, emphasis: true },
      { label: 'CIS', value: 1500 }, { label: 'ESA', value: 300 }, { label: 'JPN', value: 210 }
    ],
    xLabel: '在轨数量'
  },
  stack: {
    type: 'stack',
    segs: [{ label: 'DEB', value: 35888 }, { label: 'PAY', value: 27718 }, { label: 'R/B', value: 6895 }, { label: 'UNK', value: 166 }],
    total: 70667, unitLabel: '个'
  },
  line: {
    type: 'line',
    x: [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
    series: [
      { name: '在轨', data: [100, 140, 190, 260, 400, 700, 1100, 1600, 2100, 2600] },
      { name: '陨落', data: [30, 44, 52, 61, 70, 88, 96, 120, 140, 166] }
    ],
    xIsYear: true, yLabel: '数量'
  },
  hist: {
    type: 'hist',
    bins: [
      { x0: 0, x1: 200, n: 12 }, { x0: 200, x1: 400, n: 480 }, { x0: 400, x1: 600, n: 3200 },
      { x0: 600, x1: 800, n: 2100 }, { x0: 800, x1: 1000, n: 640 }, { x0: 1000, x1: 1200, n: 90 }
    ],
    xLabel: '近地点高度 / km', yLabel: '数量'
  },
  strip: {
    type: 'strip',
    bins: [{ lon: -120, n: 3 }, { lon: -30, n: 5 }, { lon: 0, n: 9 }, { lon: 75, n: 12 }, { lon: 160, n: 4 }],
    bands: [{ from: 60, to: 150, label: '重点弧段' }],
    marks: [{ lon: 110.5, n: 1, label: 'ChinaSat 6D' }],
    xLabel: '星下点经度 / °', yLabel: '数量'
  },
  heat: {
    type: 'heat',
    xBins: [{ x0: 0, x1: 30 }, { x0: 30, x1: 60 }, { x0: 60, x1: 90 }, { x0: 90, x1: 120 }],
    yBins: [{ y0: 200, y1: 600 }, { y0: 600, y1: 1000 }, { y0: 1000, y1: 1400 }],
    cells: [[12, 0, 340, 8], [0, 0, 1200, 60], [3, 0, 0, 0]],
    xLabel: '倾角 / °', yLabel: '高度 / km', legendLabel: '数量'
  },
  scatter: {
    type: 'scatter',
    pts: Array.from({ length: 20 }, (_, i) => ({ x: i * 17 % 360, y: 20 + (i * 7) % 80 })),
    xLabel: 'RAAN / °', yLabel: '倾角 / °', xRange: [0, 360], yRange: [0, 180],
    capped: { shown: 20, total: 27718 }
  }
}
const KINDS = Object.keys(SPECS)
eq(KINDS.length, 8, '① 八型齐全')

// ① 壳 + 两档的基本口径
for (const k of KINDS) {
  const s = chartSvg(SPECS[k], SCREEN)
  const p = chartSvg(SPECS[k], PRINT)
  shell(s, `${k}/screen`)
  shell(p, `${k}/print`)
  ok(/var\(--/.test(s), `② ${k}/screen：颜色与字体走 var(--…) token`)
  ok(!/var\(/.test(p), `② ${k}/print：不留任何 var() —— 导出的 SVG 没有祖先可解析`)
  const t = textsAllHaveFont(p)
  ok(t.okAll, `③ ${k}/print：${t.n} 条 <text> 全带 font-family（缺的那条：${t.bad}）`)
  ok(p.includes("'Times New Roman', '宋体'"), `③ ${k}/print：缺省字体落到 Times New Roman / 宋体`)
  ok(p.includes('<rect x="0" y="0"') && p.includes('#ffffff'), `③ ${k}/print：铺了浅色纸面`)
}

// ② 数据点数 —— 画出来的元素个数必须与 spec 里的数据个数对得上
{
  // 竖条：4 类 × 2 序列 = 8 根（圆角数据端，故是 <path> 不是 <rect>）
  const s = chartSvg(SPECS.bar, SCREEN)
  eq(count(s, PATHS), 8, '④ bar：4 类 × 2 序列 = 8 根条')
  eq(count(s, /fill="var\(--ssa-s1\)"/g), 5, '④ bar：序列①四根条 + 一个图例色块走色槽 1')
  eq(count(s, /fill="var\(--ssa-s2\)"/g), 5, '④ bar：序列②四根条 + 一个图例色块走色槽 2')
  ok(s.includes('>数量<') && s.includes('>年<'), '④ bar：轴名出得来')
}
{
  // 排名条：5 条；emphasis 的那条独走色槽 2，其余色槽 1（单一色相 + 强调）
  const s = chartSvg(SPECS.hbar, SCREEN)
  eq(count(s, PATHS), 5, '④ hbar：5 条')
  eq(count(s, /fill="var\(--ssa-s2\)"/g), 1, '④ hbar：只有 emphasis 那条用强调色')
  eq(count(s, /fill="var\(--ssa-s1\)"/g), 4, '④ hbar：其余四条同一色槽')
  ok(s.includes('>8,800<') && s.includes('>1,200<'), '④ hbar：条端直接标值且带千分位')
  // 条数多的图更高（高度随条数长，不是 16:9）
  const h5 = +/height="(\d+)"/.exec(s)[1]
  const h12 = +/height="(\d+)"/.exec(chartSvg({ type: 'hbar', items: SPECS.hbar.items.concat(SPECS.hbar.items).concat(SPECS.hbar.items.slice(0, 2)) }, SCREEN))[1]
  ok(h12 > h5, '④ hbar：高度随条数长')
  // 契约写死 ≤20 条：给 26 条也只画 20 条
  const many = Array.from({ length: 26 }, (_, i) => ({ label: 'X' + i, value: 26 - i }))
  eq(count(chartSvg({ type: 'hbar', items: many }, SCREEN), PATHS), 20, '④ hbar：超过 20 条只取前 20')
}
{
  // 堆叠：4 段色块 + 4 个图例色块 = 8 个 <rect>，四段走同一色相的四档明度
  const s = chartSvg(SPECS.stack, SCREEN)
  eq(count(s, RECTS), 8, '④ stack：4 段 + 4 个图例色块')
  for (let i = 1; i <= 4; i++) eq(count(s, new RegExp(`fill="var\\(--ssa-r${i}\\)"`, 'g')), 2, `④ stack：第 ${i} 档明度用在段与图例各一次`)
  ok(s.includes('>70,667 个<'), '④ stack：总数读数带千分位与单位')
  ok(s.includes('50.8%'), '④ stack：图例带各段占比（35888 / 70667）')
}
{
  // 折线：2 条无缺测的线 = 2 条 polyline，每条 10 个点
  const s = chartSvg(SPECS.line, SCREEN)
  eq(count(s, POLYS), 2, '④ line：两条线')
  const pts = /<polyline points="([^"]+)"/.exec(s)[1].split(' ')
  eq(pts.length, 10, '④ line：第一条线 10 个点')
  ok(/stroke-dasharray="7 4"/.test(s), '④ line：第二条线另带线型编码（三槽在红绿色盲下认不全）')
  ok(s.includes('>2016<') && s.includes('>2024<'), '④ line：xIsYear 档出年份整数刻度')
  ok(!s.includes('2,016'), '④ line：年份不加千分位')
  // null 断开不连：中间挖一个洞，那条线裂成两段
  const holed = { ...SPECS.line, series: [{ name: '在轨', data: [1, 2, null, 4, 5, 6, 7, 8, 9, 10] }] }
  eq(count(chartSvg(holed, SCREEN), POLYS), 2, '④ line：null 处断开，一条线裂成两段')
}
{
  // 直方：6 箱 = 6 根，且刻度落在箱边界上
  const s = chartSvg(SPECS.hist, SCREEN)
  eq(count(s, PATHS), 6, '④ hist：6 箱')
  ok(s.includes('>0<') && s.includes('>1,200<'), '④ hist：首尾箱边界都出得来')
}
{
  // 条带：5 个非空桶 = 5 个 <rect>，再加 1 块底纹；marks 出一根竖标
  const s = chartSvg(SPECS.strip, SCREEN)
  eq(count(s, RECTS), 6, '④ strip：5 个桶 + 1 块底纹')
  ok(s.includes('fill="var(--surface-2)"'), '④ strip：bands 画底纹')
  ok(/<line[^>]*stroke="var\(--ssa-s2\)"/.test(s), '④ strip：marks 画竖标')
  ok(s.includes('>-180<') && s.includes('>180<') && s.includes('>0<'), '④ strip：横轴恒为 −180…180')
  ok(s.includes('ChinaSat 6D') && s.includes('重点弧段'), '④ strip：竖标与弧段的名字画得出')
}
{
  // 密度格：12 格里非零的 6 格 + 色标条 7 档 + 绘图区框 + 色标框 = 15 个 <rect>
  // （零格不落色 —— 底色自己就是「这里没有」，铺一层最浅档只会让空与「有一颗」分不开）
  const s = chartSvg(SPECS.heat, SCREEN)
  eq(count(s, RECTS), 6 + 7 + 2, '④ heat：6 个非零格 + 7 档色标 + 两个框')
  ok(s.includes('fill="var(--ssa-q7)"'), '④ heat：最热的那格落在色阶顶档')
  ok(s.includes('>1,200<'), '④ heat：色标顶端标到实际最大计数')
  ok(s.includes('>数量<'), '④ heat：色标轴名出得来')
  // 对数色阶：12 与 1200 相差一百倍，线性色阶会把 12 压进最底一档
  ok(/fill="var\(--ssa-q[2-5]\)"/.test(s), '④ heat：小计数没有被压进最底一档（对数色阶）')
}
{
  // 散点：20 个点 = 20 个 <circle>
  const s = chartSvg(SPECS.scatter, SCREEN)
  eq(count(s, CIRCLES), 20, '④ scatter：20 个点')
  ok(s.includes('抽样 20 / 27,718'), '④ scatter：capped 出读数行')
  ok(chartSvg(SPECS.scatter, { ...SCREEN, lang: 'en' }).includes('Sampled 20 / 27,718'), '④ scatter：英文档读数行跟着走')
}

// ③ 文字防重叠：放不下的标签截断 + <title> 挂全名（口径说明只进 title，不占版面）
{
  const long = 'ITSO 国际通信卫星组织（Intelsat 的政府间前身，成员国六十余）'
  const s = chartSvg({ type: 'hbar', items: [{ label: long, value: 10 }, { label: 'US', value: 5 }] }, { theme: 'screen', width: 420 })
  ok(s.includes('…'), '⑨ hbar：过长的标签截断')
  ok(s.includes(`<title>${long}</title>`), '⑨ hbar：截断的标签把全名挂进 <title>')
  ok(/<text[^>]*>[^<]+…<title>/.test(s), '⑨ hbar：画出来的是截断串，全名只在 <title> 里')
  // 分类多到平排放不下就斜排；再挤就隔个显示
  const many = Array.from({ length: 24 }, (_, i) => '第' + (i + 1) + '类目标')
  const b = chartSvg({ type: 'bar', cats: many, series: [{ name: 'n', data: many.map((_, i) => i + 1) }] }, { theme: 'screen', width: 420 })
  ok(/transform="rotate\(-35 /.test(b), '⑨ bar：分类标签放不下改斜排')
  const shown = (b.match(/>第\d+类目标</g) || []).length
  ok(shown > 0 && shown < many.length, `⑨ bar：斜排仍挤就隔个显示（24 类画了 ${shown} 条）`)
}

// ④ 屏上档的色槽定义随图带走：本模块读不到 document，两套主题的值只能都写进内联 <style>
{
  const s = chartSvg(SPECS.bar, SCREEN)
  ok(s.includes('<style>svg.ssa-fig{'), '⑩ screen：色槽定义随图带走')
  ok(s.includes(':root[data-theme="dark"] svg.ssa-fig{'), '⑩ screen：带暗色覆写')
  ok(s.includes('--ssa-s1:#15619b') && s.includes('--ssa-s1:#4a8fc9'), '⑩ screen：亮暗两套色槽都在（复用 lbPlotTheme）')
  ok(!chartSvg(SPECS.bar, PRINT).includes('<style'), '⑩ print：不带 <style>，全部写死')
}

// ⑤ 空入参 / 全零：不许抛，且仍要出坐标系
const EMPTIES = {
  bar: { type: 'bar', cats: [], series: [] },
  hbar: { type: 'hbar', items: [] },
  stack: { type: 'stack', segs: [] },
  line: { type: 'line', x: [], series: [] },
  hist: { type: 'hist', bins: [] },
  strip: { type: 'strip', bins: [] },
  heat: { type: 'heat', xBins: [], yBins: [], cells: [] },
  scatter: { type: 'scatter', pts: [] }
}
for (const k of KINDS) {
  let s = ''
  assert.doesNotThrow(() => { s = chartSvg(EMPTIES[k], SCREEN) }, `⑤ ${k}：空数组不抛`)
  pass++
  shell(s, `${k}/空`)
  ok(s.includes(EMPTY), `⑤ ${k}：空态一句陈述句`)
  ok(count(s, LINES) + count(s, RECTS) >= 1, `⑤ ${k}：仍画出坐标系`)
  ok(chartSvg(EMPTIES[k], { ...SCREEN, lang: 'en' }).includes('No data.'), `⑤ ${k}：英文空态`)
}
// 全零：数据是有的，只是都为零 —— 这时不该出空态，该出一幅零高度的图
{
  const zero = chartSvg({ type: 'bar', cats: ['A', 'B', 'C'], series: [{ name: 'n', data: [0, 0, 0] }] }, SCREEN)
  shell(zero, 'bar/全零')
  ok(!zero.includes(EMPTY), '⑤ bar 全零：有数据就不算空态')
  eq(count(zero, PATHS), 0, '⑤ bar 全零：零高度的条不落笔')
  ok(count(zero, LINES) >= 3, '⑤ bar 全零：网格与基线仍在')
  const zs = chartSvg({ type: 'stack', segs: [{ label: 'A', value: 0 }, { label: 'B', value: 0 }] }, SCREEN)
  shell(zs, 'stack/全零')
  eq(count(zs, RECTS), 4, '⑤ stack 全零：两段均分整条 + 两个图例色块')
  const zh = chartSvg({ type: 'heat', xBins: [{ x0: 0, x1: 1 }], yBins: [{ y0: 0, y1: 1 }], cells: [[0]] }, SCREEN)
  shell(zh, 'heat/全零')
  ok(!zh.includes(EMPTY), '⑤ heat 全零：格子在就不是空态')
}
// 残缺到底：整个 spec 缺失 / type 写错 / o 不给，一律出空图不抛
for (const bad of [undefined, null, {}, { type: 'nope' }, { type: 'bar' }, { type: 'heat', cells: [[1]] }]) {
  let s = ''
  assert.doesNotThrow(() => { s = chartSvg(bad, SCREEN) }, '⑤ 残缺 spec 不抛')
  pass++
  shell(s, '残缺 spec')
}
{
  let s = ''
  assert.doesNotThrow(() => { s = chartSvg(SPECS.bar) }, '⑤ 不给 o 也不抛')
  pass++
  shell(s, '缺省 o')
  ok(/var\(--/.test(s), '⑤ 缺省 o：默认 screen 档')
}

// ④ 确定性：同一份 spec 两次出串必须逐字节相同
for (const k of KINDS) {
  eq(chartSvg(SPECS[k], PRINT), chartSvg(SPECS[k], PRINT), `⑥ ${k}：print 两次渲染字节相同`)
  eq(chartSvg(SPECS[k], SCREEN), chartSvg(SPECS[k], SCREEN), `⑥ ${k}：screen 两次渲染字节相同`)
}
ok(!/Math\.random|Date\.now/.test(await (await import('node:fs/promises')).readFile(new URL('../../../src/shared/ssaChartSvg.js', import.meta.url), 'utf8')),
  '⑥ 源码里没有随机数与当前时间')

// ⑤ 自定义报告字体：带空格的族名必须自己带引号，否则 Times New Roman 会被当成三个族名
{
  const s = chartSvg(SPECS.bar, { theme: 'print', width: 900, fonts: { latin: 'Cambria', cjkBody: 'Microsoft YaHei' } })
  ok(s.includes("font-family=\"Cambria, 'Microsoft YaHei'\""), '⑦ print：自定义字体照用，带空格的族名加引号')
  ok(!s.includes('Times New Roman'), '⑦ print：给了字体就不落缺省栈')
}

// ⑥ 宽度 → 字号：同一份 spec 换宽度，字号跟着走（报告 1200 px 那份不能是蚂蚁字）
{
  const small = chartSvg(SPECS.bar, { theme: 'print', width: 320 })
  const big = chartSvg(SPECS.bar, { theme: 'print', width: 1200 })
  const fsOf = (s) => +/font-size="([\d.]+)"/.exec(s)[1]
  ok(fsOf(big) > fsOf(small), '⑧ 字号随图宽走')
  ok(/ width="320"/.test(small) && / width="1200"/.test(big), '⑧ width 属性照给的值出')
  // height 显式给就照给的来
  ok(/ height="333"/.test(chartSvg(SPECS.bar, { theme: 'print', width: 800, height: 333 })), '⑧ height 给了就照用')
  // 导出那条路要按 2 倍栅格化，尺寸得读得回来
  eq(svgSizeOf(chartSvg(SPECS.bar, { theme: 'print', width: 800, height: 333 })), { width: 800, height: 333 }, '⑧ svgSizeOf 读回出串的尺寸')
  eq(svgSizeOf(''), { width: 0, height: 0 }, '⑧ svgSizeOf 对空串不抛')
  const hb = chartSvg(SPECS.hbar, PRINT)
  eq(svgSizeOf(hb).height, +/height="(\d+)"/.exec(hb)[1], '⑧ svgSizeOf 与属性一致')
}

// ===================================================================================
// 两处边界：跨 ±180° 接缝的重点弧段、跨度不足一个步长的年份轴
// ===================================================================================
{
  // 跨缝弧段画两截（150°E → −150° 是 60° 宽的太平洋弧，不是它 300° 宽的补集）
  const strip = (from, to) => chartSvg({ type: 'strip', bins: [{ lon: 0, n: 1 }], bands: [{ from, to, label: '弧' }] }, { theme: 'print', width: 720, lang: 'zh' })
  const rects = (svg) => [...svg.matchAll(/<rect[^>]*x="([-\d.]+)"[^>]*width="([-\d.]+)"/g)].map((m) => [+m[1], +m[2]])
  const wNormal = rects(strip(60, 150)).filter((r) => r[1] > 1)
  const wWrap = rects(strip(150, -150)).filter((r) => r[1] > 1)
  ok(wWrap.length >= wNormal.length + 1, '跨缝弧段比不跨缝的多画一截（左右各一段）')
  const sum = (a) => a.reduce((s2, r) => s2 + r[1], 0)
  // 60° 弧与 60° 跨缝弧覆盖的像素宽度应当相当（都是 60/360 的画幅），而不是补集的 300/360
  const ratio = sum(wWrap) / sum(wNormal)
  ok(ratio > 0.6 && ratio < 1.8, `跨缝弧段画的是那 60° 而不是补集（宽度比 ${ratio.toFixed(2)}）`)

  // 年份轴跨度不足一个步长：刻度必须落在数据域内，不能画到画幅外
  const line = chartSvg({ type: 'line', x: [2026.292, 2026.708], series: [{ name: 'a', data: [1, 2] }], xIsYear: true }, { theme: 'print', width: 700, lang: 'zh' })
  const xs = [...line.matchAll(/<text[^>]*x="([-\d.]+)"[^>]*>20\d\d</g)].map((m) => +m[1])
  ok(xs.length > 0, '半年跨度仍出得来刻度标签')
  ok(xs.every((x) => x >= -2 && x <= 702), `刻度都在画幅内（实得 ${xs.map((x) => x.toFixed(0)).join(',')}）`)
}

console.log(`ssaChart: ${pass} 项断言全过`)
