// 投影档瓦片影像的【分桶器】：把 planRasterMesh 规划出来的三角网按「落在哪片瓦片」分桶。
//
// 为什么要它（《2D 投影档高精影像》§2 方案 B）：投影档下影像已经是「一份三角网 + 贴图」，
// 整幅 16K 那一路是一张纹理贴到底；换成瓦片金字塔，同一份三角网不动，只是每个三角形要知道
// 自己该从哪一片（z, r, c）取样、在那一片里的 uv 是多少。分桶是纯几何：
//   · 输入 uv 是【整幅世界】的归一坐标（u = (lon+180)/360，可越出 [0,1]：跨接缝的格规划器已复制两遍）
//   · 输出逐三角形【复制到每一片】：一个三角形跨几片就复制几份，每份 uv 换成【该片全跨度】的归一坐标，
//     只画得出自己片内那一部分（GPU 靠 discard、CPU 靠源矩形在图外画不出），合起来互补 —— 边界在
//     uv 空间是同一条线、两份共用同一组顶点 → 无裂缝。
//   · 桶按 (r, c) 排成连续区间，GPU 每桶一次 drawArrays、CPU 每桶换一张源图。
//
// 三条最容易错的口径（都有测试钉着）：
//   ① 经度按【周期 p ∈ {−1, 0, +1}】折进 [−180, 180]，不按列号取模 —— L0/L1 的列数 × 跨度是
//      576° / 432° > 360°，取模是错的；
//   ② 只分给【有效窗】（tileClip：L0–L2 边缘片补边那一段不算内容）与三角形相交的片；
//   ③ 输出确定：同输入逐字节同输出（排序键 (r, c, 原三角序, p)，不用 Map 迭代序）。
// 纯几何、不碰 DOM、不读模块状态 —— Node 里直接测（packages/core/test/tileBins.test.mjs）。
import { TILE, span as tileSpan, cols as tileCols, rows as tileRows, tileClip } from '../imageryTiles.js'

const EPS = 1e-9

/**
 * @param M    planRasterMesh 的出参 { xy, uv, n }（S 必须是整幅世界 −180..180 / −90..90）
 * @param z    瓦片级
 * @param set  集名（当前只用于 tileClip 的口径统一；gutter 由调用方按集取）
 * @returns { xy: Float64Array, uv: Float64Array, n, src: Uint32Array, bins: [{ z, r, c, first, count }], tiles: [{ r, c }] }
 *          xy / uv 是分桶后逐三角形（含复制）的数组；uv 已换成【该片全跨度】的归一坐标；
 *          src[k] 是第 k 份复制来自输入的第几个三角形（测试与诊断用）。
 */
export function binByTiles(M, z, set) {
  void set
  const n = M && M.n ? M.n | 0 : 0
  const sp = tileSpan(z), NC = tileCols(z), NR = tileRows(z)
  const clampR = (r) => Math.max(0, Math.min(NR - 1, r))
  const clampC = (c) => Math.max(0, Math.min(NC - 1, c))
  // tileClip 逐片只算一次（一格能落几十片时省掉重复的 tileBox）
  const clips = new Map()
  const clipOf = (r, c) => {
    const k = r * NC + c
    if (clips.has(k)) return clips.get(k)
    const v = tileClip(z, r, c)
    clips.set(k, v)
    return v
  }
  // 逐三角形记「落到哪些片」：四元组 (r, c, t, p) 平铺进一个数组，最后按 (r, c, t, p) 排序
  const ent = []
  const uv = M.uv
  for (let t = 0; t < n; t++) {
    const i = t * 6
    const lo0 = uv[i] * 360 - 180, lo1 = uv[i + 2] * 360 - 180, lo2 = uv[i + 4] * 360 - 180
    const la0 = 90 - uv[i + 1] * 180, la1 = 90 - uv[i + 3] * 180, la2 = 90 - uv[i + 5] * 180
    const lonLo = Math.min(lo0, lo1, lo2), lonHi = Math.max(lo0, lo1, lo2)
    const latLo = Math.min(la0, la1, la2), latHi = Math.max(la0, la1, la2)
    if (!(lonHi >= lonLo) || !(latHi >= latLo)) continue          // NaN 防呆：一个 NaN 就够把整幅图拉成一条带
    const r0 = clampR(Math.floor((90 - latHi) / sp)), r1 = clampR(Math.floor((90 - latLo - EPS) / sp))
    for (let p = -1; p <= 1; p++) {
      const a = Math.max(lonLo + 360 * p, -180), b = Math.min(lonHi + 360 * p, 180)
      if (!(b > a)) continue                                        // 这一周期与世界不相交
      const c0 = clampC(Math.floor((a + 180) / sp)), c1 = clampC(Math.floor((b + 180 - EPS) / sp))
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const cl = clipOf(r, c)
          if (!cl) continue
          // 有效窗 ∩ 三角形包围盒（都在第 p 周期的经度系里）：不相交就别发 —— 补边那一段不是内容
          const wx0 = cl.west, wx1 = cl.west + cl.spanX, wy1 = cl.north, wy0 = cl.north - cl.spanY
          if (b <= wx0 + EPS || a >= wx1 - EPS || latHi <= wy0 + EPS || latLo >= wy1 - EPS) continue
          ent.push(r, c, t, p)
        }
      }
    }
  }
  const m = ent.length / 4
  const order = new Uint32Array(m)
  for (let k = 0; k < m; k++) order[k] = k
  order.sort((x, y) => {
    const ax = x * 4, ay = y * 4
    return (ent[ax] - ent[ay]) || (ent[ax + 1] - ent[ay + 1]) || (ent[ax + 2] - ent[ay + 2]) || (ent[ax + 3] - ent[ay + 3])
  })
  const oxy = new Float64Array(m * 6), ouv = new Float64Array(m * 6), osrc = new Uint32Array(m)
  const bins = [], tiles = []
  let br = -1, bc = -1
  for (let k = 0; k < m; k++) {
    const e = order[k] * 4
    const r = ent[e], c = ent[e + 1], t = ent[e + 2], p = ent[e + 3]
    if (r !== br || c !== bc) { bins.push({ z, r, c, first: k, count: 0 }); tiles.push({ r, c }); br = r; bc = c }
    bins[bins.length - 1].count++
    osrc[k] = t
    const cl = clipOf(r, c)
    const west = cl.west - 360 * p, north = cl.north
    const i = t * 6, o = k * 6
    for (let v = 0; v < 3; v++) {
      oxy[o + v * 2] = M.xy[i + v * 2]; oxy[o + v * 2 + 1] = M.xy[i + v * 2 + 1]
      const lonU = uv[i + v * 2] * 360 - 180, lat = 90 - uv[i + v * 2 + 1] * 180
      ouv[o + v * 2] = (lonU - west) / sp
      ouv[o + v * 2 + 1] = (north - lat) / sp
    }
  }
  return { xy: oxy, uv: ouv, n: m, src: osrc, bins, tiles }
}

// 片内归一坐标 → 这一片（或它的祖先片）图像里的【像素坐标】。
// hit 是 imageryTiles.getTileOrParent 的返回值：整片时 (u0,v0)=(0,0)、(u1,v1)=(1,1)；祖先片时是
// 本片在祖先里的子矩形。G 是集的 gutter（像素）：内容区落在 [G, G+TILE]，与 3D 的 tileTexture
// 的 offset/repeat 同一式子 —— 写成不带 G 的 /512 会整体偏移一个纹素、片边一条线。
export function tileUvToPx(u, v, hit, G) {
  return [G + (hit.u0 + u * (hit.u1 - hit.u0)) * TILE, G + (hit.v0 + v * (hit.v1 - hit.v0)) * TILE]
}

// 分桶后每一片的【有效窗】上限（uv 归一，1 = 整片）：给 GPU 的 discard 与 CPU 的裁剪用。
// L3 起恒为 (1, 1)；L0–L2 边缘片 < 1（补边那一段不是内容）。
export function tileWindow(z, r, c) {
  const cl = tileClip(z, r, c)
  return cl ? [cl.fx, cl.fy] : [0, 0]
}
