// 等值线方案与设置往返（src/viz/grd/useGrdCoverage.js）：
//   ① schemeOf → applyScheme 逐字段相等（SATSOFT Save / Load Contour Settings）
//   ② getState → restoreState 的全局显示选项逐字段相等，老快照缺的键落出厂值
//   ③ 老天线设置（没有 lineStyle / refDb / labelAbs / 每档样式）读进来不炸、落默认
// 运行：npm test
import assert from 'node:assert'
// 合帧重算走 rAF —— Node 里没有，补一个同步桩（重算本身在无场景时是空操作）
globalThis.requestAnimationFrame = (fn) => { fn(0); return 0 }
globalThis.cancelAnimationFrame = () => {}
const { useGrdCoverage } = await import('../../../src/viz/grd/useGrdCoverage.js')

let pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++ }
const mk = () => useGrdCoverage(() => null, () => null, () => false, {})

// ============ ① 方案往返 ============
{
  const a = mk(), s = a.s
  s.ctype = 'relInput'; s.refDb = 42.5; s.labelAbs = true
  s.pol = 'P1'; s.gainOffset = -3.5; s.pathLoss = 'relative'
  s.fill = true; s.line = true; s.lineWidth = 2.4; s.lineStyle = 'dashdot'; s.lineAlpha = 0.8; s.alpha = 0.55
  s.showVal = true; s.valSize = 18; s.valColor = '#ff0000'
  s.labelMode = 'interval'; s.labelGap = 22; s.labelWithName = true; s.fontBold = true
  s.showName = true; s.nameSize = 20; s.nameColor = '#00ff00'
  s.showPeak = true; s.peakSize = 7; s.peakColor = '#0000ff'
  s.levels = [
    { v: -1, name: 'EOC', labelT: 0.25, color: 'rgb(1,2,3)', lineColor: 'rgb(4,5,6)', locked: true, lineSet: true, dash: 'dash', width: 3.1, fillAlpha: 0.4 },
    { v: -3, name: '', labelT: null, color: 'rgb(7,8,9)', lineColor: 'rgb(7,8,9)', locked: false, lineSet: false, dash: null, width: null, fillAlpha: null }
  ]
  const scheme = JSON.parse(JSON.stringify(a.schemeOf()))   // 存盘一定过一次 JSON
  ok(scheme.kind === 'satsim.grd.contours' && scheme.v === 1, '方案带类型与版本号')

  const b = mk()
  ok(b.applyScheme(scheme) === true, '载入方案返回 true')
  const t = b.s
  for (const k of ['ctype', 'refDb', 'labelAbs', 'pol', 'gainOffset', 'pathLoss', 'fill', 'line', 'lineWidth', 'lineStyle', 'lineAlpha', 'alpha',
    'showVal', 'valSize', 'valColor', 'labelMode', 'labelGap', 'labelWithName', 'fontBold', 'showName', 'nameSize', 'nameColor', 'showPeak', 'peakSize', 'peakColor']) {
    ok(t[k] === s[k], `${k} 往返相等（${JSON.stringify(t[k])}）`)
  }
  ok(t.levels.length === 2, '电平表条数一致')
  for (let i = 0; i < 2; i++) {
    for (const k of ['v', 'name', 'labelT', 'color', 'lineColor', 'locked', 'lineSet', 'dash', 'width', 'fillAlpha']) {
      ok(t.levels[i][k] === s.levels[i][k], `第 ${i + 1} 档 ${k} 往返相等（${JSON.stringify(t.levels[i][k])}）`)
    }
  }
  // 指向与选波束不在方案里：载入后仍是出厂值
  ok(t.boreType === 'azel' && t.boreAz === 0 && JSON.stringify(t.beamsToPlot) === '[0]', '方案不带指向与选波束')

  // 缺字段的老方案：只覆盖给到的键，其余保持现状
  const c = mk()
  c.s.lineWidth = 5; c.s.labelGap = 9
  ok(c.applyScheme({ ctype: 'rel', levels: [{ v: -2 }] }) === true, '残缺方案也能载入')
  ok(c.s.ctype === 'rel' && c.s.lineWidth === 5 && c.s.labelGap === 9, '缺的键保持现状')
  ok(c.s.levels.length === 1 && c.s.levels[0].dash === null && c.s.levels[0].width === null, '缺样式的档落 null（跟全局）')
  ok(c.applyScheme(null) === false && c.applyScheme('x') === false, '非对象一律拒绝')
}

// ============ ② 全局显示选项往返（getState / restoreState）============
{
  const a = mk(), s = a.s
  const DISP = { showName: true, nameSize: 21, nameColor: '#123456', showBore: true, boreSize: 1.5, boreColor: '#654321',
    showRay: true, rayColor: '#abcdef', rayWidth: 2.2, rayOpacity: 0.33, showPeak: true, peakSize: 9, peakColor: '#0f0f0f',
    showVal: true, valSize: 17, valColor: '#fedcba', labelMode: 'interval', labelGap: 12, labelWithName: true, fontBold: true }
  for (const [k, v] of Object.entries(DISP)) s[k] = v
  const st = JSON.parse(JSON.stringify(a.getState()))
  for (const k of Object.keys(DISP)) ok(st.disp[k] === DISP[k], `快照 disp.${k} = ${JSON.stringify(DISP[k])}`)

  const b = mk()
  await b.restoreState(st)
  for (const k of Object.keys(DISP)) ok(b.s[k] === DISP[k], `恢复后 ${k} 相等`)

  // 老快照（disp 里没有这四个新键）：恢复后落出厂值，不变成 undefined
  const c = mk()
  const legacy = JSON.parse(JSON.stringify(st))
  for (const k of ['labelMode', 'labelGap', 'labelWithName', 'fontBold']) delete legacy.disp[k]
  await c.restoreState(legacy)
  ok(c.s.labelMode === 'single' && c.s.labelGap === 35 && c.s.labelWithName === false && c.s.fontBold === false, '老快照缺的四个键落出厂值')
  ok(c.s.valSize === DISP.valSize, '老快照里有的键照常恢复')
}

console.log(`grdContourScheme.test.mjs：${pass} 条断言全绿`)
