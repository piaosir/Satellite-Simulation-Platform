// 波束地图显示（src/viz/beammap/useBeamMapDisplay.js）自测：运行 npm test。
// 桌面 API 与两个渲染器都打桩：钉住索引合并（软隐藏 / 同名并入）、电平表（默认显示 / 降序 / 配色）、「自动」配色、
// 上图（只出可见档、按波束着色）、采集口径（导出 / 小程序 / 可编程导出共用）、存档往返与旧版「GXT/KML 显示」存档迁移。
const sq = (x0, y0, w, h) => [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]
const FILES = {
  'p/east.json': { lon: 110.5, bore: [[115, 30, 53]], contours: [{ g: 48, p: sq(110, 25, 10, 10) }, { g: 52, p: sq(113, 28, 4, 4) }] },
  'p/west.json': { lon: 110.5, bore: [], contours: [{ g: 44, p: sq(90, 25, 10, 10) }, { g: 48, p: sq(93, 28, 4, 4) }] },
  'p/hidden.json': { lon: 110.5, bore: [], contours: [{ g: 40, p: sq(0, 0, 1, 1) }] },
  'u1/b1.json': { lon: 134, bore: [], contours: [{ g: null, p: sq(100, 0, 10, 10) }] },
  'u1/b2.json': { lon: 134, bore: [], contours: [{ g: null, p: sq(120, 0, 10, 10) }] },
  'u2/x.json': { lon: 110.5, bore: [], contours: [{ g: 50, p: sq(80, 20, 5, 5) }] }
}
globalThis.window = {
  api: {
    coverage: {
      index: async () => ({ satellites: [{ folder: 'cs10r', displayName: '中星10R', satName: '中星10R', lon: 110.5, beams: [
        { band: 'Ku', beam: '东部', type: 'EIRP', gains: [48, 52], file: 'p/east.json', key: 'k-east' },
        { band: 'Ku', beam: '西部', type: 'EIRP', gains: [44, 48], file: 'p/west.json', key: 'k-west' },
        { band: 'Ku', beam: '藏起来', type: 'EIRP', gains: [40], file: 'p/hidden.json', key: 'k-hid' }] }] }),
      get: async (f) => structuredClone(FILES[f])
    },
    coverageGxt: {
      index: async () => ({
        hidden: { sats: [], beams: ['k-hid'] },
        satellites: [
          { id: 'u1', name: 'AP6DPTH', lon: 134.3, beams: [
            { id: 'a', name: '波束 1', type: 'EIRP', band: 'Ku', file: 'u1/b1.json', gains: [null], props: { '载波': ['DVB-S2 V 11591.4 MHz'] } },
            { id: 'b', name: '波束 2', type: 'EIRP', band: 'Ku', file: 'u1/b2.json', gains: [null] }] },
          { id: 'u2', name: '中星10R', lon: 110.5, beams: [{ id: 'c', name: '附加', type: 'EIRP', band: 'Ku', file: 'u2/x.json', gains: [50] }] }
        ]
      }),
      get: async (f) => structuredClone(FILES[f])
    }
  }
}
const { useBeamMapDisplay, beamColor, DISP_DEF } = await import('../../../src/viz/beammap/useBeamMapDisplay.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra != null && extra !== '' ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const calls = []
const mkView = (tag) => ({
  setBeamMapField: (layers, opts) => calls.push({ tag, layers, opts }),
  clearBeamMapField: () => calls.push({ tag, clear: true }),
  setCoverage: (spec) => calls.push({ tag, cov: spec })
})
const scene = mkView('3d'), flat = mkView('2d')
const errs = []
const bm = useBeamMapDisplay({ getScene: () => scene, getFlat: () => flat, apiOk: true, displaySatName: (n) => n, onError: (m) => errs.push(m) })
const last = (tag) => { for (let i = calls.length - 1; i >= 0; i--) if (calls[i].tag === tag && calls[i].layers) return calls[i]; return null }
const tick = () => new Promise((r) => setTimeout(r, 40))

await bm.ensureIndex()
const sats = bm.sats.value
ok('索引：内置 + 用户库，同名用户星并入内置星', sats.length === 2 && sats[0].folder === 'cs10r' && sats[0].beams.some((b) => b.beam === '附加' && b.user) && sats[1].folder === 'gxt:u1')
ok('索引：软隐藏的内置波束剔除、用户波束带 props', !sats[0].beams.some((b) => b.beam === '藏起来') && sats[1].beams[0].props['载波'].length === 1)

bm.addSat('cs10r')
const it = bm.items.value[0], ba = it.batches[0]
ok('添加卫星：缺省 EIRP / 全部频段 / 一个批次、配色「自动」', it.type === 'EIRP' && it.band === 'all' && it.batches.length === 1 && ba.scheme === 'auto')
bm.toggleBeam(it, ba, 'Ku|东部')
bm.toggleBeam(it, ba, 'Ku|西部')
await bm.redraw()
const rows = bm.levelRows(it, ba)
ok('电平表：已选波束出现过的档、高 → 低、缺省全部显示', rows.map((r) => r.text).join(',') === '52,48,44' && rows.every((r) => r.on))
ok('电平表：自动配色（有数值档 → jet，升序取色、线色跟填充）', rows[0].color !== rows[2].color && rows.every((r) => r.lineColor === r.color) && !bm.isBeamScheme(it, ba))
let L3 = last('3d'), L2 = last('2d')
ok('上图：3D 与 2D 同一份图层、id 稳定', L3 && L2 && L3.layers === L2.layers && L3.layers.length === 2 && L3.layers[0].id.startsWith('bm:'))
ok('上图：缺省只画线（填充关）、显示选项进 opts', L3.layers[0].fillBands === null && L3.layers[0].segGroups.length === 2 && L3.opts.showName === DISP_DEF.showName && Array.isArray(L3.opts.rays))
ok('上图：卫星名标签', calls.filter((c) => c.tag === '3d' && c.cov).pop().cov.sats[0].name === '中星10R')

bm.setLevelOn(ba, '48', false)
bm.setBatch(ba, { fill: true, fillAlpha: 0.5 })
await tick()
L3 = last('3d')
const east = L3.layers.find((l) => l.name === '东部'), west = L3.layers.find((l) => l.name === '西部')
ok('关掉 48 档：东部只剩 52 档、西部只剩 44 档（各一带一线）', east.segGroups.length === 1 && east.segGroups[0].txt === '52' && west.segGroups.length === 1 && west.segGroups[0].txt === '44')
ok('填充：分带出现、层透明度 = 批次填充不透明度', east.fillBands && east.fillBands.length === 1 && east.alpha === 0.5)
ok('电平表：关掉的档仍列出、标为不显示', bm.levelRows(it, ba).find((r) => r.key === '48').on === false)

bm.setLevelColor(ba, '52', '#123456')
await tick()
const r52 = bm.levelRows(it, ba).find((r) => r.key === '52')
ok('逐档改色：填充色落盘、线色跟随（没单独设过）', r52.color === '#123456' && r52.lineColor === '#123456' && r52.custom)
bm.resetLevelColors(ba)
ok('恢复方案配色：自定义色清掉、显示状态保留', !bm.levelRows(it, ba).find((r) => r.key === '52').custom && bm.levelRows(it, ba).find((r) => r.key === '48').on === false)

const col = bm.collect()
ok('采集：只收显示中的档、带屏上线色', col.length === 2 && col.find((b) => b.beam === '东部').contours.length === 1 && col.find((b) => b.beam === '东部').contours[0].g === 52 && /^#[0-9a-f]{6}$/.test(col[0].contours[0].color))

// 无数值的环：自动 → 按波束
bm.addSat('gxt:u1')
const it2 = bm.items.value[1], ba2 = it2.batches[0]
bm.allBeams(it2, ba2, true)
await bm.redraw()
ok('无数值档：电平表一行「—」', bm.levelRows(it2, ba2).length === 1 && bm.levelRows(it2, ba2)[0].text === '—')
ok('自动配色：全是无数值的环 → 按波束着色', bm.isBeamScheme(it2, ba2))
L3 = last('3d')
const u = L3.layers.filter((l) => l.id.startsWith(`bm:${it2.id}:`))
ok('按波束着色：两束两色、与波束行同一套取色', u.length === 2 && u[0].segGroups[0].color !== u[1].segGroups[0].color && u[0].segGroups[0].color === beamColor(0) && u[1].segGroups[0].color === beamColor(1))
ok('无波束中心的束：名字锚点在多边形内、十字不画', u[0].bore && u[0].bore.hit === false && u[0].bore.lon > 100 && u[0].bore.lon < 110)
ok('波束行悬停：props 成文本', bm.beamRowsOf(it2)[0].tip.includes('载波: DVB-S2'))
{
  // 发小程序的形态：无数值档写成 g = 0 + none（小程序按 none 不出电平标注）；导出 / 可编程导出那份照旧是 null
  const nb = (list) => list.filter((b) => b.satName === 'AP6DPTH').flatMap((b) => b.contours)
  const mini = nb(bm.collect({ mini: true })), plain = nb(bm.collect())
  ok('采集（小程序）：无数值档 g = 0 + none、带线色；有数值档原样', mini.length === 2 && mini.every((c) => c.g === 0 && c.none === true && /^#[0-9a-f]{6}$/.test(c.color) && c.p.length === 4) &&
    bm.collect({ mini: true }).filter((b) => b.satName !== 'AP6DPTH').flatMap((b) => b.contours).every((c) => c.none === undefined && typeof c.g === 'number'))
  ok('采集（导出）：无数值档仍是 g = null、不带 none', plain.length === 2 && plain.every((c) => c.g === null && c.none === undefined))
}

// 清除 / 存档往返
bm.clearDrawing()
ok('清除绘制：两路渲染器清空、采集为空', calls.slice(-3).some((c) => c.tag === '3d' && c.clear) && calls.slice(-3).some((c) => c.tag === '2d' && c.clear) && bm.collect().length === 0 && bm.cleared.value)
const snap = bm.serialize()
ok('存档：v2、电平表与显示选项', snap.v === 2 && snap.cleared === true && snap.items.length === 2 && snap.items[0].batches[0].levels['48'].on === false && snap.disp.showName === true)
const bm2 = useBeamMapDisplay({ getScene: () => scene, getFlat: () => flat, apiOk: true, displaySatName: (n) => n })
const need = await bm2.restore(JSON.parse(JSON.stringify(snap)))
ok('恢复：清除过的不复现、设置原样', need === false && bm2.cleared.value === true && bm2.items.value.length === 2 && bm2.items.value[0].batches[0].fill === true && bm2.items.value[0].batches[0].levels['48'].on === false)

// 旧版「GXT/KML 显示」存档迁移
const OLD = {
  items: [{ id: 'c3', folder: 'cs10r', type: 'EIRP', band: 'all', batches: [{ id: 'c4', name: '老批次', beams: [
    { id: 'Ku|东部', gains: [52], custom: '48', mode: 'perGain', solid: '#00ff00', gainColors: { 52: '#abcdef' }, width: 2.5 },
    { id: 'Ku|西部', gains: [52], custom: '48', mode: 'perGain', solid: '#00ff00', gainColors: { 52: '#abcdef' }, width: 2.5 }] }] }],
  cleared: false, beamLabels: false, beamFont: 20, beamBold: true, bore: true, boreSize: 6, contourLabels: true, contourSize: 9, contourBold: false
}
const bm3 = useBeamMapDisplay({ getScene: () => scene, getFlat: () => flat, apiOk: true, displaySatName: (n) => n })
const need3 = await bm3.restore(OLD)
const ob = bm3.items.value[0].batches[0]
ok('迁移：批次 / 波束 / 线宽 / 名称原样', need3 === true && ob.name === '老批次' && ob.beams.length === 2 && ob.width === 2.5 && ob.fill === false)
ok('迁移：选中档 = gains ∪ 自定义，其余档关掉', ob.levels['44'] && ob.levels['44'].on === false && !(ob.levels['52'] && ob.levels['52'].on === false) && !(ob.levels['48'] && ob.levels['48'].on === false))
ok('迁移：逐档色落成该档自定义色、渐变 → jet', ob.levels['52'].color === '#abcdef' && ob.scheme === 'jet')
ok('迁移：全局显示项（波束名 / 字号 / 粗体 / 中心 / 数值标签 / 视轴）', bm3.disp.showName === false && bm3.disp.nameSize === 20 && bm3.disp.fontBold === true && Math.abs(bm3.disp.boreSize - 0.6) < 1e-9 && bm3.disp.showVal === true && bm3.disp.valSize === 9 && bm3.disp.showRay === true && bm3.disp.rayOpacity === 0.3)
ok('迁移：id 游标续上（新批次不撞号）', (() => { bm3.addBatch(bm3.items.value[0]); const ids = bm3.items.value[0].batches.map((b) => b.id); return new Set(ids).size === ids.length && ids[1] !== 'c4' })())
ok('没有出错日志', !errs.length, errs.join(' | '))

console.log(`\nbeamMapDisplay: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
