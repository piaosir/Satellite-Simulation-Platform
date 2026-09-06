// 投影档瓦片影像的分桶器（src/viz/geo/tileBins.js）。运行：npm test
//
// 分桶是「同一份三角网 → 每个三角形该从哪一片瓦片取样」的纯几何。这里钉的是它的不变量：
// 覆盖（每个三角形至少落一片）、只落有效窗、跨接缝落两端、L0/L1 按周期不按取模、极点格、
// 复制的平面坐标逐字不变、输出确定。像素比对在 .imgharness 的 pxdiff 上做，不在这里。
import { makeProjection } from '../../../src/viz/geo/projection.js'
import { planRasterMesh } from '../../../src/viz/geo/rasterMesh.js'
import { binByTiles, tileUvToPx, tileWindow } from '../../../src/viz/geo/tileBins.js'
import { span, cols, rows, tileClip, TILE, pickZoom } from '../../../src/viz/imageryTiles.js'

let pass = 0, fail = 0
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail++; console.log('FAIL  ' + name + (note ? '  — ' + note : '')) }
}
const WORLD = { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 }
const LON0 = -30
const KINDS = ['mercator', 'equalEarth', 'robinson', 'albers', 'azeq']
const DPR = 1.5, BASE = 1920 / 360 / DPR          // 1280 CSS 宽、DPR 1.5：全图 8 设备像素/度

// 三个视角：全图 / 以 105°E 35°N 为中心放大 ×6 / ×12（平面窗口按缩放倍数缩小）
function views(PJ) {
  const [cx, cy] = PJ.fwd(105, 35, [0, 0])
  const at = (mul) => {
    const res = BASE * DPR * mul
    const hw = PJ.W / (2 * mul), hh = PJ.H / (2 * mul)
    return { bx0: Math.max(0, cx - hw), bx1: Math.min(PJ.W, cx + hw), by0: Math.max(0, cy - hh), by1: Math.min(PJ.H, cy + hh), res }
  }
  return [{ tag: '全图', bx0: 0, bx1: PJ.W, by0: 0, by1: PJ.H, res: BASE * DPR }, { tag: '×6', ...at(6) }, { tag: '×12', ...at(12) }]
}
const zOf = (res) => pickZoom(1 / res, 6)
// 一份复制的 uv 包围盒与该片有效窗 [0,fx]×[0,fy] 相交
function inWindow(B, k, z) {
  const b = B.bins.find((x) => k >= x.first && k < x.first + x.count)
  const [fx, fy] = tileWindow(z, b.r, b.c)
  const o = k * 6
  const u0 = Math.min(B.uv[o], B.uv[o + 2], B.uv[o + 4]), u1 = Math.max(B.uv[o], B.uv[o + 2], B.uv[o + 4])
  const v0 = Math.min(B.uv[o + 1], B.uv[o + 3], B.uv[o + 5]), v1 = Math.max(B.uv[o + 1], B.uv[o + 3], B.uv[o + 5])
  return u0 < fx + 1e-9 && u1 > -1e-9 && v0 < fy + 1e-9 && v1 > -1e-9
}
// 手造一个三角形（整幅世界的 uv）
const tri = (u0, v0, u1, v1, u2, v2) => ({ n: 1, xy: new Float64Array([0, 0, 1, 0, 0, 1]), uv: new Float64Array([u0, v0, u1, v1, u2, v2]) })
const U = (lon) => (lon + 180) / 360, V = (lat) => (90 - lat) / 180

// ---------- ① 五投影 × 三视角：形状、覆盖、只落有效窗、平面坐标逐字不变、复制数量级 ----------
for (const kind of KINDS) {
  const PJ = makeProjection(kind, LON0)
  for (const vw of views(PJ)) {
    const M = planRasterMesh(PJ, { bx0: vw.bx0, bx1: vw.bx1, by0: vw.by0, by1: vw.by1, res: vw.res, S: WORLD })
    const z = zOf(vw.res)
    const B = binByTiles(M, z, 'bmng')
    const tag = kind + ' · ' + vw.tag + ' · L' + z
    let sum = 0, contiguous = true, sorted = true
    for (let i = 0; i < B.bins.length; i++) {
      const b = B.bins[i]
      if (b.first !== sum) contiguous = false
      sum += b.count
      if (i && (b.r < B.bins[i - 1].r || (b.r === B.bins[i - 1].r && b.c <= B.bins[i - 1].c))) sorted = false
    }
    ok('① ' + tag + '：桶连续、按 (r,c) 升序、计数相加 = 复制数', contiguous && sorted && sum === B.n && B.xy.length === B.n * 6 && B.uv.length === B.n * 6, M.n + ' △ → ' + B.n + ' 份 / ' + B.bins.length + ' 桶')
    const covered = new Uint8Array(M.n)
    for (let k = 0; k < B.n; k++) covered[B.src[k]] = 1
    let miss = 0
    for (let t = 0; t < M.n; t++) if (!covered[t]) miss++
    ok('① ' + tag + '：每个三角形至少落一片', miss === 0, miss + ' 个没落')
    let bad = 0
    for (let k = 0; k < B.n; k++) if (!inWindow(B, k, z)) bad++
    ok('① ' + tag + '：每份复制的 uv 都与该片有效窗相交', bad === 0, bad + ' 份落在补边上')
    let xyOk = true
    for (let k = 0; k < B.n && xyOk; k++) {
      const t = B.src[k]
      for (let j = 0; j < 6; j++) if (B.xy[k * 6 + j] !== M.xy[t * 6 + j]) { xyOk = false; break }
    }
    ok('① ' + tag + '：复制的平面坐标与原三角形逐字相同', xyOk)
    ok('① ' + tag + '：复制数 ≥ 原数、≤ 原数 × 12', B.n >= M.n && B.n <= M.n * 12, (B.n / M.n).toFixed(2) + ' 份/△')
    const inGrid = B.tiles.every((t) => t.r >= 0 && t.r < rows(z) && t.c >= 0 && t.c < cols(z))
    const uniq = new Set(B.tiles.map((t) => t.r + '/' + t.c)).size === B.tiles.length
    ok('① ' + tag + '：片集去重且行列在网格内', inGrid && uniq, B.tiles.length + ' 片')
  }
}

// ---------- ② 跨接缝的三角形落到两端两片 ----------
{
  const z = 3, s = span(z)                                  // 36°，10 列
  const B = binByTiles(tri(U(178), V(1), U(182), V(1), U(180), V(-1)), z, 'bmng')
  const cs = B.tiles.map((t) => t.c).sort((a, b) => a - b)
  ok('② 跨 ±180 的三角形：落到第 0 列与最后一列', cs.length === 2 && cs[0] === 0 && cs[1] === cols(z) - 1, JSON.stringify(cs))
  ok('② 两份复制的平面坐标都是原三角形的', B.n === 2 && B.xy[0] === 0 && B.xy[6] === 0)
  ok('② 两份复制各与自己那一片的有效窗相交', inWindow(B, 0, z) && inWindow(B, 1, z))
  void s
}

// ---------- ③ L0 / L1 按周期折，不按列号取模 ----------
{
  // L0：2 列 × 288°。lon 170..175 只能落在第 1 列（west=108），且落在有效窗 fx=0.25 之内
  const B0 = binByTiles(tri(U(170), V(5), U(175), V(5), U(172), V(0)), 0, 'bmng')
  ok('③ L0：lon 170..175 只落第 1 列', B0.n === 1 && B0.tiles.length === 1 && B0.tiles[0].c === 1 && B0.tiles[0].r === 0, JSON.stringify(B0.tiles))
  const u0 = (170 - 108) / span(0)
  ok('③ L0：片内 u 按全跨度归一（(170−108)/288）且 < fx', Math.abs(B0.uv[0] - u0) < 1e-12 && B0.uv[0] < tileWindow(0, 0, 1)[0], B0.uv[0].toFixed(4))
  // 列号取模的错法会把 lon −170 折到 (−170+180)/288 → 第 0 列没错，但 L1 的第 2 列（west=108，跨 144°）
  // 若按取模就会认为 −170 ≡ 190 落在它里面 —— 正确答案只有第 0 列
  const B1 = binByTiles(tri(U(-170), V(5), U(-165), V(5), U(-168), V(0)), 1, 'bmng')
  ok('③ L1：lon −170..−165 只落第 0 列，不落第 2 列的补边', B1.n === 1 && B1.tiles[0].c === 0, JSON.stringify(B1.tiles))
  // L1 第 2 列的有效窗 fx = 0.5（108..180）：lon 175..179 落进去且 u < 0.5
  const B2 = binByTiles(tri(U(175), V(5), U(179), V(5), U(177), V(0)), 1, 'bmng')
  ok('③ L1：lon 175..179 落第 2 列且 u < fx=0.5', B2.n === 1 && B2.tiles[0].c === 2 && B2.uv[0] < 0.5 && tileWindow(1, 0, 2)[0] === 0.5, B2.uv[0].toFixed(4))
}

// ---------- ④ 极点附近经度跨度大的格：落到多片，每份都在有效窗内 ----------
{
  const z = 3
  const B = binByTiles(tri(U(0), V(90), U(90), V(90), U(45), V(89)), z, 'bmng')
  const cs = B.tiles.map((t) => t.c)
  ok('④ 极点格 lon 0..90 在 L3 落 3 列（5、6、7）', B.n === 3 && cs.join(',') === '5,6,7' && B.tiles.every((t) => t.r === 0), JSON.stringify(cs))
  ok('④ 极点格每份复制都与有效窗相交', [0, 1, 2].every((k) => inWindow(B, k, z)))
}

// ---------- ⑤ 输出确定 ----------
{
  const PJ = makeProjection('azeq', LON0)
  const M = planRasterMesh(PJ, { bx0: 0, bx1: PJ.W, by0: 0, by1: PJ.H, res: 8, S: WORLD })
  const A = binByTiles(M, 3, 'bmng'), B = binByTiles(M, 3, 'bmng')
  const same = A.n === B.n && A.xy.every((v, i) => v === B.xy[i]) && A.uv.every((v, i) => v === B.uv[i]) &&
    A.src.every((v, i) => v === B.src[i]) && JSON.stringify(A.bins) === JSON.stringify(B.bins)
  ok('⑤ 同输入两次分桶逐字节相同', same, A.n + ' 份')
}

// ---------- ⑥ 片内 uv → 图像像素（含 gutter 与祖先片子矩形） ----------
{
  const G = 1
  const whole = { u0: 0, v0: 0, u1: 1, v1: 1 }
  ok('⑥ 整片：u=0 → G，u=1 → G+512', tileUvToPx(0, 0, whole, G)[0] === 1 && tileUvToPx(1, 1, whole, G)[0] === 1 + TILE && tileUvToPx(1, 1, whole, G)[1] === 1 + TILE)
  const parent = { u0: 0.5, v0: 0.25, u1: 1, v1: 0.5 }
  const p = tileUvToPx(0, 0, parent, G), q = tileUvToPx(1, 1, parent, G)
  ok('⑥ 祖先片：本片子矩形 (0.5,0.25)–(1,0.5) → 像素 (257,129)–(513,257)', p[0] === 1 + 256 && p[1] === 1 + 128 && q[0] === 1 + 512 && q[1] === 1 + 256, JSON.stringify([p, q]))
  ok('⑥ 有效窗：L3 恒 (1,1)；L0 第 1 列 (0.25, 0.625)；L2 末行 fy=0.5', tileWindow(3, 2, 4).join() === '1,1' && tileWindow(0, 0, 1).join() === '0.25,0.625' && tileWindow(2, 2, 0)[1] === 0.5, tileWindow(0, 0, 1).join() + ' / ' + tileWindow(2, 2, 0).join())
  ok('⑥ 行列越界的片：有效窗 (0,0)', tileWindow(3, 99, 0).join() === '0,0' && tileClip(3, 0, 99) === null)
}

// ---------- ⑦ 六个投影同一缩放同一级（选级公式与等距圆柱同式，这里只钉 pickZoom 的口径） ----------
{
  const zs = [BASE * DPR, BASE * DPR * 6, BASE * DPR * 12].map((res) => zOf(res))
  // 全图 5.33 设备像素/度 → 0.5625/0.1875 = 3 → ceil(log2 3) = 2；×6 → 18 → 5；×12 → 36 → 6
  ok('⑦ 全图 / ×6 / ×12 在 1280×720 @1.5 上选 L2 / L5 / L6', zs.join(',') === '2,5,6', zs.join(','))
}

console.log(`tileBins: ${pass} 通过, ${fail} 失败`)
if (fail) process.exit(1)
