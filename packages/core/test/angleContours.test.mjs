import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextTick } from 'vue'
import { A, elevationDeg, geodeticToEcef, geocentricToEcef, isoElevationContourAt } from '../../../src/viz/wgs84.js'
import { antennaBasisAzEl } from '../../../src/viz/grd/coverage.js'
import { shellGeom, losBlocked } from '../../../src/viz/grd/shellProj.js'
import { angleLayer, beamContour, elevationContour, newAngleLine } from '../../../src/viz/grd/angleContours.js'
import { useGrdCoverage } from '../../../src/viz/grd/useGrdCoverage.js'
import { useShellCoverage } from '../../../src/viz/grd/useShellCoverage.js'
import { buildRecord } from '../../../src/viz/grd/gaussStk.js'
import { startAngleLabelDrag } from '../../../src/viz/grd/angleLabelDrag.js'
import { numericLabelGroup } from '../../../src/viz/grd/contourLabels.js'

const dot = (a, b) => a.reduce((sum, v, i) => sum + v*b[i], 0)
const unit = a => a.map(v => v / Math.hypot(...a))
const diff = (a, b) => a.map((v, i) => v-b[i])
const deg = 180 / Math.PI
const basis = antennaBasisAzEl(175, 55, 750, 23, -9)
const geo = antennaBasisAzEl(0, 0, 35786, 0, 0)
const low = shellGeom(geo, A+550)

function saveAt(anchor, point) {
  const i = anchor.path.points.findIndex(p => p[0] === point[0] && p[1] === point[1])
  assert.ok(i >= 0)
  anchor.group.save(anchor.path.fractions[i] - anchor.base)
}

test('large single label drags along its contour, commits on release and restores on cancel', () => {
  const points = [[10,10],[20,30],[60,40]]
  const line = { ...newAngleLine([], 'elevation'), labelMode: 'single', labelSize: 80 }
  const segs = points.map((p,i) => [p,points[(i+1) % points.length]])
  let captured = false
  const stage = Object.assign(new EventTarget(), {
    setPointerCapture() { captured = true },
    hasPointerCapture() { return captured },
    releasePointerCapture() { captured = false }
  })
  function drag(end) {
    const group = angleLayer('s',line,segs).segGroups[0], anchor = group.anchors[0]
    const index = points.indexOf(anchor.point)
    const [x,y] = anchor.point, next = (index+1) % points.length
    const target = { anchor, width: 120, height: 80, project: ([x,y]) => ({x,y}), preview: p => { group.labels[0] = p } }
    const down = { clientX: x+50, clientY: y, pointerId: 1, currentTarget: stage, stopPropagation() {}, preventDefault() {} }
    startAngleLabelDrag({...down, clientX:x+90}, [target])
    assert.equal(captured,false)
    let clicks = 0
    const focusTarget = () => { clicks++ }
    startAngleLabelDrag(down, [target], focusTarget)
    stage.dispatchEvent(Object.assign(new Event('pointerup'), { pointerId:1, clientX:x+51, clientY:y }))
    assert.equal(clicks,1, '单击重叠的卫星时聚焦目标，允许轻微手抖')
    assert.deepEqual(group.labels[0],points[index])
    startAngleLabelDrag(down, [target], focusTarget)
    assert.equal(captured,true)
    const pointer = type => Object.assign(new Event(type), { pointerId:1, clientX:points[next][0]+50, clientY:points[next][1] })
    stage.dispatchEvent(pointer('pointermove'))
    assert.deepEqual(group.labels[0],points[next])
    stage.dispatchEvent(pointer(end))
    assert.equal(clicks,1, '拖动标注不会同时聚焦卫星')
    assert.equal(captured,false)
    const expected = end === 'pointerup' ? next : index
    assert.deepEqual(angleLayer('s',line,segs).segGroups[0].labels,[points[expected]])
    if (end === 'pointercancel') assert.deepEqual(group.labels[0], points[expected])
  }
  drag('pointerup')
  drag('pointercancel')
})

test('angle styles and cardinal, single and hidden labels across the date line', () => {
  const points = [[179,10], [-176,5], [-171,0], [-176,-5], [179,-10], [174,-5], [169,0], [174,5]]
  const segs = points.map((p,i) => [p, points[(i+1) % points.length]])
  for (const kind of ['beam', 'elevation']) {
    const line = newAngleLine([], kind)
    const group = (projection = 'a') => angleLayer(projection,line,segs).segGroups[0]
    assert.deepEqual([line.width,line.color,line.dash], [0.7,'#000000','solid'])
    assert.equal(newAngleLine([], kind, 'shell').color, '#ffffff')
    const cardinal = [points[0],points[2],points[4],points[6]]
    assert.deepEqual(group().labels,cardinal)
    saveAt(group().anchors[0], points[7])
    assert.deepEqual(group().labels,[points[7],points[1],points[3],points[5]])
    assert.deepEqual(group('b').labels,cardinal)
    line.labelMode = 'single'
    assert.deepEqual(group().labels,[points[0]])
    saveAt(group().anchors[0], points[5])
    line.labels = false
    assert.equal(group().labels,undefined)
    line.labels = true
    assert.deepEqual(group().labels,[points[5]])
    line.labelMode = 'cardinal'
    assert.deepEqual(group().labels,[points[7],points[1],points[3],points[5]])
  }
})

test('dragging a repeated label previews the whole row, clamps open ends and restores on cancel', () => {
  const points = [[0,0], [30,0], [60,0], [90,0]]
  const segs = points.slice(1).map((p, i) => [points[i], p])
  const level = { lab: 1, labelOffsets: {} }
  const opts = { showVal: true, labelMode: 'interval', valSize: 12, labelGap: 30 }
  const build = () => numericLabelGroup(segs, opts, level, 0, 1, 'shell/0/a/near',
    (key, offset) => { level.labelOffsets[key] = offset })
  const stage = Object.assign(new EventTarget(), {
    setPointerCapture() {}, hasPointerCapture() { return false }
  })
  for (const end of ['pointercancel', 'lostpointercapture', 'pointerup']) {
    const group = build(), before = group.labels.slice()
    assert.ok(before.length >= 3)
    const targets = group.anchors.map((anchor, i) => ({
      anchor, width: 5, height: 5, project: ([x,y]) => ({ x, y }),
      preview: p => { group.labels[i] = p }
    }))
    const down = { clientX: before[1][0], clientY: 0, pointerId: 2, currentTarget: stage,
      stopPropagation() {}, preventDefault() {} }
    startAngleLabelDrag(down, targets)
    const pointer = type => Object.assign(new Event(type), { clientX: 150, clientY: 0, pointerId: 2 })
    stage.dispatchEvent(pointer('pointermove'))
    assert.equal(group.labels.at(-1)[0], 90)
    const shift = 90 - before.at(-1)[0]
    for (const [i, p] of group.labels.entries()) assert.ok(Math.abs(p[0] - before[i][0] - shift) < 1e-10)
    assert.deepEqual(level.labelOffsets, {})
    stage.dispatchEvent(pointer(end))
    assert.deepEqual(build().labels, group.labels)
    if (end !== 'pointerup') assert.deepEqual(group.labels, before)
    else assert.equal(Object.keys(level.labelOffsets).length, 1)
  }
})

test('WGS84 tilted cone, including longitude seam', () => {
  const segs = beamContour(basis, 18)
  assert.ok(segs.length >= 360)
  assert.ok(segs.some(([p,q]) => Math.abs(p[0] - q[0]) > 180))
  for (const [p] of segs) {
    const d = unit(diff(geodeticToEcef(...p), basis.S))
    assert.ok(Math.abs(Math.acos(dot(basis.z,d))*deg-9) < 1e-8)
  }
})

test('wide, grazing and outward cones', () => {
  const wide = beamContour(geo, 70)
  assert.ok(wide.length >= 360)
  for (const [p] of wide) assert.ok(Math.abs(elevationDeg(...p,geo.S)) < 1e-8)
  const grazing = antennaBasisAzEl(8, 22, 35786, 9, 0)
  const arc = beamContour(grazing, 6)
  assert.ok(arc.length > 30)
  for (const [p] of arc) {
    const off = Math.acos(dot(grazing.z, unit(diff(geodeticToEcef(...p),grazing.S))))*deg
    assert.ok(Math.abs(off-3) < 1e-8 || (off < 3+1e-8 && Math.abs(elevationDeg(...p,grazing.S)) < 1e-8))
  }
  assert.equal(beamContour({ ...geo, z: [1,0,0] }, 7).length, 0)
})

test('a narrow GEO cone intersection between azimuth samples is retained on both shell branches', () => {
  const S = [A+35786, 0, 0], g = shellGeom({ S }, A+550)
  const tangent = Math.asin(g.R/S[0]), half = 5/deg
  for (const bearing of [13.25, 48.17, 142.8]) {
    const axis = tilt => [-Math.cos(tilt), Math.sin(tilt)*Math.cos(bearing/deg), Math.sin(tilt)*Math.sin(bearing/deg)]
    for (const branch of ['near', 'far']) {
      const rim = beamContour({ S, z: axis(tangent+half-1e-5/deg) }, 10, g, branch)
      assert.ok(rim.length > 1)
      assert.equal(beamContour({ S, z: axis(tangent+half+1e-5/deg) }, 10, g, branch).length, 0)
    }
  }
})

test('ground elevation near zenith and from a low polar source', () => {
  for (const [lat,h,e] of [[55,750,89.99], [87,8,10]]) {
    const sat = geodeticToEcef(10,lat,h)
    const ring = isoElevationContourAt(sat,e,120)
    assert.equal(ring.length,121)
    for (const p of ring) assert.ok(Math.abs(elevationDeg(...p,sat)-e)<1e-8)
  }
})

test('shell intersections respect beam width, near/far and Earth occultation', () => {
  for (const br of ['near', 'far']) {
    const segs = beamContour(geo, 18, low, br)
    assert.ok(segs.length >= 360)
    let rim = 0
    for (const [p] of segs) {
      const P = geocentricToEcef(...p, 550), d = unit(diff(P,geo.S))
      assert.ok(Math.acos(dot(d,geo.z))*deg < 9+1e-8)
      if (Math.abs(Math.acos(dot(d,geo.z))*deg-9)<1e-8) {
        assert.equal(losBlocked(geo.S,P), false)
        rim++
      }
    }
    assert.ok(rim >= 360)
  }
  assert.equal(beamContour(geo, 2, low, 'far').length, 0)
})

test('both observer conventions satisfy the independently reconstructed elevation', () => {
  const outer = shellGeom(basis, A+1200)
  for (const [g,e,observer,br] of [[low,15,'shell','near'], [low,-4,'shell','far'],
    [outer,-25,'shell','far'], [outer,20,'satellite','far']]) {
    const segs = elevationContour(g,e,observer,br)
    assert.ok(segs.length > 100, observer + ' ' + e)
    for (const [p] of segs) {
      const P = geocentricToEcef(...p,g.R-A)
      const [from,to] = observer === 'shell' ? [P,g.S] : [g.S,P]
      const actual = Math.asin(dot(unit(from),unit(diff(to,from))))*deg
      assert.ok(Math.abs(actual-e) < 1e-8)
      assert.equal(losBlocked(g.S,P),false)
    }
  }
  assert.equal(elevationContour(outer,15,'shell','far').length,0)
  assert.equal(elevationContour(low,15,'shell','far').length,0)
})

function installCoverageTestApi() {
  globalThis.requestAnimationFrame = cb => { cb(); return 0 }
  globalThis.localStorage = { getItem: () => null, setItem() {} }
  let saved
  globalThis.window = { api: { coverageGrd: {
    save: async (file,text) => { saved = text; return { file } }, raw: async () => ({ text: saved })
  } } }
}

test('tree children render independently and survive scene restore and rename', async () => {
  installCoverageTestApi()
  let ground = [], shell = [], rays = []
  const scene = { setCoverageField(ls) { ground=ls }, setShellField(ls) { shell=ls },
    setShellRays(ls) { rays=ls }, setShellGuides() {}, patchCoverageLayers() {}, faceLonLat() {}, viewMetrics: () => null }
  let isFlat = false, flatLayers
  const flat = { setField(layers) { flatLayers = layers } }
  const make = () => {
    const g = useGrdCoverage(() => scene, () => null)
    return [g, useShellCoverage(g, () => scene, () => flat, () => isFlat)]
  }
  const [g,s] = make()
  const node = g.addSatellite({ name:'GEO', lon:0, lat:0, altKm:35786 })
  const record = buildRecord({ models:[{ id:'m1', fGHz:14.5, drv:'D', D:1, eff:55, back:-30, k:'stk' }], beams:[{ az:0, el:0, model:'m1' }] })
  const key = await g.createAnalyticAntenna(node.folder, { name:'A', record })
  await g.toggleAnt(node,node.antennas[0])
  g.angleLines.add(key); s.angleLines.add(key); g.s.showRay = true
  await nextTick()
  g.recompute(); s.recompute()
  assert.deepEqual(g.selected.value,[]); assert.deepEqual(s.selected.value,[])
  assert.ok(ground.length && ground.every(l=>l.angleContour))
  assert.ok(shell.length && shell.every(l=>l.angleContour)); assert.equal(rays.length,1)
  const beamLine = g.angleLines.rows.value[0]
  assert.equal(ground[0].segGroups[0].txt, '5°')
  beamLine.angle = s.angleLines.rows.value[0].angle = 7.5
  g.recompute(); s.recompute()
  assert.equal(ground[0].segGroups[0].txt, '7.5°')
  assert.ok(shell.length && shell.every(layer => layer.segGroups[0].txt === '7.5°'))
  const moved = ground[0].segGroups[0].segs[8][0]
  saveAt(ground[0].segGroups[0].anchors[1], moved)
  beamLine.labels = false
  g.recompute()
  assert.equal(ground[0].segGroups[0].txt, undefined)
  isFlat = true
  await s.toggleAnt(node,node.antennas[0])
  s.recompute()
  assert.ok(flatLayers.length > 0)
  assert.ok(flatLayers.every(layer => !layer.angleContour), '2D draws the beam footprint without its shell angle line')
  isFlat = false
  s.recompute()
  assert.ok(shell.some(layer => layer.angleContour))
  await s.angleLines.toggle(s.angleLines.rows.value[0])
  s.recompute()
  assert.ok(shell.length && shell.every(l=>!l.angleContour))
  assert.ok(g.angleLines.rows.value[0].show)
  const [g2,s2] = make()
  const olderScene = JSON.parse(JSON.stringify(g.getState()))
  olderScene.angleLines[0].angleMode = 'antennaElevation'
  await g2.restoreState(olderScene)
  await s2.restoreState(JSON.parse(JSON.stringify(s.getState())))
  assert.equal(g2.angleLines.rows.value[0].angle,7.5)
  assert.ok(!('angleMode' in g2.getState().angleLines[0]))
  assert.equal(s2.angleLines.rows.value[0].angle,7.5)
  g2.angleLines.rows.value[0].labels = true
  g2.recompute()
  assert.equal(ground[0].segGroups[0].txt, '7.5°')
  assert.deepEqual(ground[0].segGroups[0].labels[1], moved)
  assert.deepEqual(g2.selected.value,[]); assert.ok(ground.some(l=>l.angleContour))
  assert.equal(s2.angleLines.rows.value[0].show,false)
  g2.renameAntenna(node.folder,'A','B')
  assert.equal(g2.angleLines.rows.value[0].key,'GEO|B')
  assert.equal(s2.angleLines.rows.value[0].key,'GEO|B')

  await g.toggleAnt(node, node.antennas[0])
  g.s.showVal = true
  g.s.labelMode = 'interval'
  g.s.labelGap = 2
  await nextTick()
  g.recompute(); s.recompute()
  function repeated(layers) {
    return layers.filter(l => !l.angleContour).flatMap(l => l.segGroups).find(group => group.anchors.length > 1)
  }
  const groundGroup = repeated(ground), shellGroup = repeated(shell)
  assert.ok(groundGroup && shellGroup)
  const initialGround = groundGroup.labels, initialShell = shellGroup.labels
  groundGroup.anchors[1].group.save(0.025)
  g.recompute(); s.recompute()
  assert.notDeepEqual(repeated(ground).labels, initialGround)
  assert.deepEqual(repeated(shell).labels, initialShell)
  repeated(shell).anchors[1].group.save(0.1)
  s.recompute()
  const movedShell = repeated(shell).labels
  assert.notDeepEqual(movedShell, initialShell)
  isFlat = true
  s.recompute()
  assert.ok(repeated(flatLayers).anchors.length > 1)
  isFlat = false
  const [g3, s3] = make()
  await g3.restoreState(JSON.parse(JSON.stringify(g.getState())))
  await s3.restoreState(JSON.parse(JSON.stringify(s.getState())))
  s3.recompute()
  assert.deepEqual(repeated(shell).labels, movedShell)
})

test('dragging a cone off the Earth clears its angle layer before release in 2D and 3D', async () => {
  installCoverageTestApi()
  const layers = new Map()
  const patch = batch => { for (const layer of batch) layers.set(layer.id, layer) }
  const replace = batch => { layers.clear(); patch(batch) }
  const scene = { setCoverageField: replace, patchCoverageLayers: patch, faceLonLat() {} }
  const flat = { setField: replace, patchField: patch }
  let isFlat = false
  const grd = useGrdCoverage(() => scene, () => flat, () => isFlat, { flatActive: () => isFlat })
  const node = grd.addSatellite({ name: 'GEO', lon: 0, lat: 0, altKm: 35786 })
  const record = buildRecord({ models: [{ id: 'm', fGHz: 14.5, drv: 'D', D: 1, eff: 55, back: -30, k: 'stk' }],
    beams: [{ az: 0, el: 0, model: 'm' }] })
  const key = await grd.createAnalyticAntenna(node.folder, { name: 'A', record })
  await grd.setActive(node, node.antennas[0], { face: false })
  grd.angleLines.add(key, 'beam', { angle: 2 })
  const id = grd.angleLines.rows.value[0].id
  for (isFlat of [false, true]) {
    Object.assign(grd.s, { boreType: 'azel', boreAz: 7, boreEl: 0 })
    await nextTick()
    grd.recompute()
    assert.ok(layers.has(id))
    grd.beamDrag({ lon: -60, lat: 0 }, 'start')
    grd.beamDrag({ lon: 60, lat: 0 }, 'move')
    await nextTick()
    assert.ok(!layers.has(id))
    grd.beamDrag({ lon: -60, lat: 0 }, 'move')
    await nextTick()
    assert.ok(layers.has(id))
    grd.beamDrag(null, 'end')
    await nextTick()
  }
})

test('elevation rows need no antennas, honor shell selection, persist standalone positions and migrate older settings', async () => {
  let ground, shell, flatLayers, hidden = false
  const scene = { setCoverageField(ls) { ground = ls }, setShellField(ls) { shell = ls }, setShellGuides() {} }
  const grd = useGrdCoverage(() => scene, () => null, () => false, { satelliteHidden: () => hidden })
  const flat = { setField(layers) { flatLayers = layers } }
  // Exporting a flat map while the globe is visible feeds both renderers.
  const sc = useShellCoverage(grd, () => scene, () => flat, () => false, () => true, () => true)
  const node = grd.addSatellite({ name:'GEO2', lon:179, lat:40, altKm:35786 })
  grd.angleLines.add(node.folder,'elevation')
  grd.recompute()
  assert.equal(ground.length,1)
  for (const [p] of ground[0].segGroups[0].segs) {
    assert.ok(Math.abs(elevationDeg(...p,geodeticToEcef(node.lon,node.lat,node.altKm))-10)<1e-7)
  }
  const sh = sc.shells.value[1]
  sc.angleLines.add(node.folder,'elevation',{ shellIds:[sh.id], labelSize:23, labelColor:'#e66799' })
  sc.recompute()
  assert.equal(shell.length,1)
  assert.equal(shell[0].R, A+sh.altKm)
  assert.equal(shell[0].angleLabel.size,23)
  assert.equal(shell[0].angleLabel.color,'#e66799')
  hidden = true
  grd.recompute(); sc.recompute()
  assert.equal(ground.length, 0)
  assert.equal(shell.length, 0)
  hidden = false
  grd.recompute(); sc.recompute()
  assert.equal(ground.length, 1)
  assert.equal(shell.length, 1)
  assert.equal(flatLayers.length,0, 'a standalone shell elevation line belongs only to the globe')
  sc.updateShell(sh.id,{show:false})
  sc.recompute()
  assert.equal(shell.length,0)
  sc.angleLines.add('','elevation',{ position:{lon:10,lat:0,altKm:35786} })
  const restored = useShellCoverage(grd,()=>scene)
  await restored.restoreState(JSON.parse(JSON.stringify(sc.getState())))
  assert.equal(restored.angleLines.list('','elevation').length,1)
  assert.equal(shell.length,1)
  assert.equal(shell[0].R,A+sc.shells.value[0].altKm)
  const old = grd.getState()
  delete old.angleLines
  Object.assign(old.sats[0], { els:'0°, 22°', elevShow:true, elevColor:'#ffeeaa', elevWidth:2 })
  old.sats.push({ ...old.sats[0], folder:'Unused', els:'5,10', elevShow:false })
  await grd.restoreState(old)
  const lines = grd.angleLines.list(node.folder,'elevation')
  assert.equal(grd.angleLines.list('Unused', 'elevation').length, 0)
  assert.deepEqual(lines.map(line=>line.angle),[0,22])
  assert.equal(lines[1].labelColor,'#ffeeaa')
  assert.ok(lines.every(line=>line.show))
  assert.equal(grd.sats.value[0].elevShow,false)
  grd.removeSatellite(node.folder)
  assert.equal(grd.angleLines.rows.value.length,0)
  assert.equal(restored.angleLines.rows.value.length,1)
})
