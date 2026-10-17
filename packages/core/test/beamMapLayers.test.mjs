// 波束地图图层（src/viz/beammap/layers.js）自测：运行 npm test。
// 覆盖库多边形 → GRD 同构图层：奇偶分带三角化（档内坑成岛 / 同档嵌套成洞 / 重复环去重）、跨 ±180° 解缠、
// 加密、标签锚点、波束中心（有 / 无 / 多个）、无数值档。
const L = await import('../../../src/viz/beammap/layers.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra != null && extra !== '' ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e
const sq = (x0, y0, w, h) => [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]
function triArea(flat) {
  let s = 0
  for (let i = 0; i < flat.length; i += 6) s += Math.abs((flat[i + 2] - flat[i]) * (flat[i + 5] - flat[i + 1]) - (flat[i + 4] - flat[i]) * (flat[i + 3] - flat[i + 1])) / 2
  return s
}
const bandArea = (layer, i) => triArea(layer.fillBands[i].verts)

/* ---------- 档键 ---------- */
ok('档键：数值去浮点噪声、空值归 none', L.levelKey(52) === '52' && L.levelKey(52.0000001) === '52' && L.levelKey(-3.5) === '-3.5' && L.levelKey(null) === L.NONE && L.levelKey(NaN) === L.NONE)
ok('档值文本：不裁小数', L.fmtLevel(42.567) === '42.567' && L.fmtLevel(null) === '')
ok('levelsOf：升序、无数值垫底', JSON.stringify(L.levelsOf([{ g: 52, p: [] }, { g: null, p: [] }, { g: 48, p: [] }, { g: 52, p: [] }])) === '[null,48,52]')
ok('颜色互转', JSON.stringify(L.toRgb('#ff8000')) === '[255,128,0]' && JSON.stringify(L.toRgb('rgb(1, 2, 3)')) === '[1,2,3]' && L.rgbHex([255, 128, 0]) === '#ff8000' && L.rgbHex('#abc') === '#aabbcc')

/* ---------- 环预处理 ---------- */
{
  const r = L.prepRing([[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]], 0)
  ok('预处理：去闭合重复点 + 按 0.5° 加密（含闭合边）', r.pts.length === 16 && !r.polar, r.pts.length)
  const x = L.prepRing([[179, 0], [-179, 0], [-179, 1], [179, 1]], 180)
  ok('预处理：跨 ±180° 解缠到轨位附近', x.pts.every((q) => q[0] >= 179 && q[0] <= 181), x.pts.map((q) => q[0]).join(','))
  const pol = L.prepRing([[0, 80], [90, 80], [180, 80], [270, 80]], 0)
  ok('预处理：绕极环识别', pol.polar === true)
}

/* ---------- 奇偶三角化 ---------- */
ok('三角化：带洞', near(triArea(L.evenOddTriangles([sq(0, 0, 10, 10), sq(3, 3, 4, 4)])), 84))
ok('三角化：洞里的岛', near(triArea(L.evenOddTriangles([sq(0, 0, 10, 10), sq(2, 2, 6, 6), sq(4, 4, 2, 2)])), 100 - 36 + 4))
ok('三角化：两块分离区域', near(triArea(L.evenOddTriangles([sq(0, 0, 2, 2), sq(5, 5, 3, 3)])), 13))
ok('三角化：完全重合的环去重（不异或成空）', near(triArea(L.evenOddTriangles([sq(0, 0, 10, 10), sq(0, 0, 10, 10)])), 100))
ok('三角化：退化环剔除', L.evenOddTriangles([[[0, 0], [1, 1], [2, 2]]]).length === 0)

/* ---------- 图层：两档嵌套 ---------- */
const beam = { name: 'B1', satLon: 5, bore: [[5, 5, 53.2]], contours: [{ g: 48, p: sq(0, 0, 10, 10) }, { g: 52, p: sq(3, 3, 4, 4) }] }
const lv = (v, extra = {}) => ({ key: L.levelKey(v), v, color: '#0000ff', lineColor: '#ff0000', name: '', dash: null, width: null, fillAlpha: null, ...extra })
const st = { levels: [lv(48), lv(52, { color: '#00ff00', fillAlpha: 0.5 })], fill: true, fillAlpha: 0.6, line: true, lineAlpha: 0.9, lineWidth: 2, lineStyle: 'dash' }
{
  const out = L.buildBeamLayers(beam, st, { show: true, mode: 'single', size: 12 }, 'x')
  const a = out[0]
  ok('图层：一层、id / 名 / 层透明度', out.length === 1 && a.id === 'x' && a.name === 'B1' && a.alpha === 0.6)
  ok('图层：分带面积 = 外圈减内圈 / 内圈', a.fillBands.length === 2 && near(bandArea(a, 0), 84) && near(bandArea(a, 1), 16), [bandArea(a, 0), bandArea(a, 1)].join(' / '))
  ok('图层：填充色与逐档透明度', JSON.stringify(a.fillBands[1].color) === '[0,255,0]' && a.fillBands[1].alpha === 0.5 && a.fillBands[0].alpha === null)
  ok('图层：counts 全为 3', a.fillBands.every((b) => b.counts.length * 6 === b.verts.length && b.counts.every((c) => c === 3)))
  const g0 = a.segGroups[0]
  ok('图层：逐档线（色 / 透明度 / 线宽 / 线型 / 文本）', a.segGroups.length === 2 && g0.color === '#ff0000' && g0.opacity === 0.9 && g0.width === 2 && g0.dash === 'dash' && g0.txt === '48')
  ok('图层：线段首尾相接成闭合环（加密后 80 段）', g0.segs.length === 80 && g0._chains.length === 1 && g0._chains[0].length === 81, g0.segs.length)
  ok('图层：每档每环一个标签', g0.labels.length === 1 && a.segGroups[1].labels.length === 1)
  ok('图层：波束中心带电平', a.bore && a.bore.hit === true && a.bore.peak === 53.2 && a.bore.lon === 5 && a.bore.onEarth === true)
}
{
  const out = L.buildBeamLayers(beam, { ...st, levels: [lv(52)] }, null, 'y')
  ok('只开内档：只有一带、面积 16', out[0].fillBands.length === 1 && near(bandArea(out[0], 0), 16))
  const out2 = L.buildBeamLayers(beam, { ...st, levels: [lv(48)] }, null, 'y')
  ok('只开外档：不再扣内圈、面积 100', out2[0].fillBands.length === 1 && near(bandArea(out2[0], 0), 100))
  const out3 = L.buildBeamLayers(beam, { ...st, fill: false }, null, 'z')
  ok('关填充：fillBands 为空、线照画', out3[0].fillBands === null && out3[0].segGroups.length === 2)
  const out4 = L.buildBeamLayers(beam, { ...st, line: false }, { show: true }, 'z')
  ok('关线：无线组（与 GRD 同：数值标签随线）', out4[0].segGroups.length === 0)
}
{
  // 档内坑：48 档里有个同档小环（局部低于 48），关掉 52 时它是洞
  const dip = { name: 'D', satLon: 0, contours: [{ g: 48, p: sq(0, 0, 10, 10) }, { g: 48, p: sq(1, 1, 2, 2) }] }
  const out = L.buildBeamLayers(dip, { levels: [lv(48)], fill: true, line: true }, null, 'd')
  ok('同档嵌套环成洞', near(bandArea(out[0], 0), 96))
  ok('无波束中心：名字锚在环内、十字不画', out[0].bore && out[0].bore.hit === false && out[0].bore.onEarth === true && out[0].bore.lon > 0 && out[0].bore.lon < 10)
}
{
  // 坑在高档里：52 区域里有个 52 档小环（坑），坑应归 48 那一带
  const pit = { name: 'P', satLon: 0, contours: [{ g: 48, p: sq(0, 0, 10, 10) }, { g: 52, p: sq(2, 2, 6, 6) }, { g: 52, p: sq(4, 4, 2, 2) }] }
  const out = L.buildBeamLayers(pit, { levels: [lv(48), lv(52)], fill: true }, null, 'p')
  ok('高档坑归低档那一带', near(bandArea(out[0], 0), 100 - 36 + 4) && near(bandArea(out[0], 1), 36 - 4), [bandArea(out[0], 0), bandArea(out[0], 1)].join(' / '))
}
{
  const nb = { name: 'Beam 4', satLon: 134, contours: [{ g: null, p: [[100, 20], [120, 20], [120, 40], [100, 40]] }] }
  const out = L.buildBeamLayers(nb, { levels: [lv(null, { key: L.NONE, name: '' })], fill: true, line: true }, { show: true }, 'n')
  ok('无数值档：照常填充 / 画线、无数值标签', out[0].fillBands.length === 1 && near(bandArea(out[0], 0), 400) && out[0].segGroups[0].txt === null && out[0].segGroups[0].labels.length === 0)
  const out2 = L.buildBeamLayers(nb, { levels: [lv(null, { key: L.NONE, name: '边界' })], fill: false, line: true }, { show: true }, 'n')
  ok('无数值档起了名：标签印名称', out2[0].segGroups[0].txt === '边界' && out2[0].segGroups[0].labels.length === 1)
}
{
  const mb = { name: 'M', satLon: 0, bore: [[1, 1, 50], [2, 2], [3, 3, 49]], contours: [{ g: 48, p: sq(0, 0, 4, 4) }] }
  const out = L.buildBeamLayers(mb, { levels: [lv(48)], fill: false, line: true }, null, 'm')
  ok('多个波束中心：第 2 个起各补一层（只带十字、不带名）', out.length === 3 && out[1].id === 'm#b1' && out[1].name === '' && out[1].bore.hit && out[1].bore.peak === null && out[2].bore.peak === 49)
}
{
  // 跨 ±180°：轨位 180，环从 175 到 -175
  const am = { name: 'A', satLon: 180, contours: [{ g: 40, p: [[175, -5], [-175, -5], [-175, 5], [175, 5]] }] }
  const out = L.buildBeamLayers(am, { levels: [lv(40)], fill: true, line: true }, { show: true }, 'a')
  ok('跨 ±180°：面积不被横扫（10°×10°）', near(bandArea(out[0], 0), 100), bandArea(out[0], 0))
  ok('跨 ±180°：标签锚点折回 [-180,180)', out[0].segGroups[0].labels.every((q) => q[0] >= -180 && q[0] < 180))
}
{
  const out = L.buildBeamLayers(beam, st, { show: true, mode: 'interval', gap: 3, size: 12 }, 'i')
  ok('沿线间隔：一环多个标签', out[0].segGroups[0].labels.length > 1, out[0].segGroups[0].labels.length)
  const out2 = L.buildBeamLayers(beam, { ...st, levels: [lv(48, { name: '边缘' }), lv(52)] }, { show: true, withName: true }, 'w')
  ok('值 + 名称', out2[0].segGroups[0].txt === '48 边缘')
}
{
  const ray = L.beamRay(110.5, [112, 30], { color: '#ffb14a', width: 1.2, opacity: 0.75 })
  ok('视轴射线格式', ray.from.lon === 110.5 && ray.from.lat === 0 && ray.to.lon === 112 && ray.to.lat === 30 && ray.color === '#ffb14a')
}
{
  // 缓存：同一束同一组可见档第二次不重算（Float64Array 是同一块）
  const a = L.buildBeamLayers(beam, st, null, 'c')[0].fillBands[0].verts
  const b = L.buildBeamLayers(beam, { ...st, fillAlpha: 0.2 }, null, 'c')[0].fillBands[0].verts
  ok('分带三角化按可见档缓存', a === b)
}

console.log(`\nbeamMapLayers: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
