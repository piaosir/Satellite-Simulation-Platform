// 影像瓦片网格：把 GIBS EPSG:4326 的定义钉死。
// 这些数字不是推导出来的，是从 gibs.earthdata.nasa.gov 的 WMTSCapabilities 里读出来的实测值 ——
// 改动本文件里任何一个期望值之前，先去核对官方 capabilities，不要顺着代码改测试。
import assert from 'node:assert/strict'
import { TILE, MAXZ, res, span, cols, rows, tileBox, pickZoom, tileRange } from '../../../src/viz/imageryTiles.js'

let n = 0
const ok = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }

console.log('imageryTiles')

ok('瓦片是 512×512，不是 256', () => assert.equal(TILE, 512))

ok('各级分辨率与官方 ScaleDenominator 一致（含 GIBS 独有的 L8–L11）', () => {
  const M_PER_DEG = 111320
  // L0–L7 是 500m 矩阵集；L8 属 250m 集（VIIRS/MODIS 真彩）；L9–L11 属 31.25m 集（HLS / Landsat WELD）。
  // 离线包只切到 L6，但网格本身要一路对到 L11 —— 在线源按同一套寻址取片，算错一级就整屏错位。
  const exp = [62617.5, 31308.7, 15654.4, 7827.2, 3913.6, 1956.8, 978.4, 489.2, 244.6, 122.3, 61.1, 30.6]
  for (let z = 0; z < exp.length; z++) {
    assert.ok(Math.abs(res(z) * M_PER_DEG - exp[z]) < 0.2, `L${z} 应 ≈${exp[z]} m/px，实为 ${res(z) * M_PER_DEG}`)
  }
})

ok('各级网格尺寸与官方 MatrixWidth/Height 一致（含 L8–L11）', () => {
  const exp = [[2, 1], [3, 2], [5, 3], [10, 5], [20, 10], [40, 20], [80, 40], [160, 80], [320, 160], [640, 320], [1280, 640], [2560, 1280]]
  for (let z = 0; z < exp.length; z++) {
    assert.equal(cols(z), exp[z][0], `L${z} 列数`)
    assert.equal(rows(z), exp[z][1], `L${z} 行数`)
  }
})

ok('L3 起世界尺寸恰是 512 整数倍（无补边片）', () => {
  for (let z = 3; z <= MAXZ; z++) {
    assert.equal(cols(z) * span(z), 360, `L${z} 宽应正好铺满 360°`)
    assert.equal(rows(z) * span(z), 180, `L${z} 高应正好铺满 180°`)
  }
})

ok('L0/L1/L2 网格大于世界（右/下缘是补边片）', () => {
  // 注意不是「都横向溢出」：L2 的 5×72°=360 横向恰好铺满，只有纵向 3×72°=216>180 溢出。
  // 补边逻辑按行列分别判，别写成一个统一分支。
  assert.ok(cols(0) * span(0) > 360 && rows(0) * span(0) > 180, 'L0 应两向都溢出')
  assert.ok(cols(1) * span(1) > 360 && rows(1) * span(1) > 180, 'L1 应两向都溢出')
  assert.equal(cols(2) * span(2), 360, 'L2 横向恰好铺满')
  assert.ok(rows(2) * span(2) > 180, 'L2 应只有纵向溢出')
})

ok('左上角片锚在 (−180, +90)', () => {
  for (let z = 0; z <= MAXZ; z++) {
    const b = tileBox(z, 0, 0)
    assert.equal(b.west, -180); assert.equal(b.north, 90)
  }
})

ok('tileBox 首尾相接、无缝无叠', () => {
  const z = 5
  for (let c = 0; c + 1 < cols(z); c++) assert.equal(tileBox(z, 0, c).east, tileBox(z, 0, c + 1).west)
  for (let r = 0; r + 1 < rows(z); r++) assert.equal(tileBox(z, r, 0).south, tileBox(z, r + 1, 0).north)
})

ok('北京落在 L7 的 (row 22, col 131)', () => {
  // 与实拉的 GIBS 片位对照：span(7)=2.25°，(116.4+180)/2.25=131.7 → 131；(90−39.9)/2.25=22.3 → 22
  const { c0, r0 } = tileRange(7, 116.4, 116.4, 39.9, 39.9)
  assert.equal(c0, 131); assert.equal(r0, 22)
  const b = tileBox(7, 22, 131)
  assert.ok(b.west <= 116.4 && 116.4 < b.east, '经度应落在片内')
  assert.ok(b.south < 39.9 && 39.9 <= b.north, '纬度应落在片内')
})

ok('pickZoom：texel 不粗于 pixel', () => {
  for (let z = 0; z <= MAXZ; z++) assert.ok(res(pickZoom(res(z))) <= res(z) + 1e-12, `L${z} 自映射`)
  // 稍粗于某级 → 选该级（宁可多一点细节，不可糊）
  assert.equal(pickZoom(res(4) * 0.99), 5)
  assert.equal(pickZoom(res(4) * 1.01), 4)
})

ok('pickZoom 钳位', () => {
  assert.equal(pickZoom(999), 0)
  assert.equal(pickZoom(1e-9), MAXZ)
  assert.equal(pickZoom(1e-9, 11), 11, '显式给 maxZ 时能到 L11（GIBS 真彩天花板）')
  assert.equal(pickZoom(0), 0)
  assert.equal(pickZoom(-1), 0)
})

ok('★ 平台缩放上限落在 L6–L7，不多不少', () => {
  // 3D：fov 42° + minDistance 1.02 → 109 m/CSS px；2D：SCAP≈139 → 180 m/CSS px（见 imagery.js 头注）。
  // 这一条是「离线包为什么做到 L7 就够、再往下白花钱」的判据，改缩放常数时必须回来重看。
  const M_PER_DEG = 111320
  assert.equal(pickZoom(109 / M_PER_DEG), 7, '3D 拉到底应正好吃满 L7')
  assert.equal(pickZoom(180 / M_PER_DEG), 7, '2D 拉到底应落在 L7')
  // ★ 别拿「978」这种四舍五入过的读数当输入：L6 真值是 978.4 m/px，传 978 比它细，会选到 L7。
  assert.equal(pickZoom(1000 / M_PER_DEG), 6, '1000 m/px 应落在 L6（978.4 够用）')
  assert.equal(pickZoom(2446 / M_PER_DEG), 5, '现状 16K 整幅那一档相当于 L5')
})

ok('tileRange 覆盖窗口且钳在网格内', () => {
  const z = 6
  const r = tileRange(z, -180, 180, 90, -90)
  assert.equal(r.c0, 0); assert.equal(r.c1, cols(z) - 1)
  assert.equal(r.r0, 0); assert.equal(r.r1, rows(z) - 1)
  const q = tileRange(z, 119.5, 121.5, 25, 23)
  assert.ok(tileBox(z, q.r0, q.c0).west <= 119.5 && tileBox(z, q.r1, q.c1).east >= 121.5)
  assert.ok(tileBox(z, q.r0, q.c0).north >= 25 && tileBox(z, q.r1, q.c1).south <= 23)
})

ok('tileRange 越界输入不产生负片号', () => {
  const r = tileRange(4, -400, 400, 200, -200)
  assert.ok(r.c0 >= 0 && r.r0 >= 0 && r.c1 < cols(4) && r.r1 < rows(4))
})

console.log(`imageryTiles: ${n} 项全过`)
