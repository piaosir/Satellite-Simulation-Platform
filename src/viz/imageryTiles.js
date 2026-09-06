// 影像瓦片：EPSG:4326 金字塔的网格数学 + 取片缓存。2D 平面图与 3D 球体共用这一份。
//
// ── 为什么照 NASA GIBS 的网格切，而不是自定义 2:1 方案 ─────────────────────────
// 离线随包那一半（resources/imagery）与将来可能接的在线增强那一半（GIBS 的
// BlueMarble_ShadedRelief_Bathymetry / VIIRS 真彩）共用同一套 (z,row,col) 寻址 →
// 取片只有一个函数，本地有就读本地，没有就打网络，addressing 不分叉。
//
// 网格定义（实测自 gibs.earthdata.nasa.gov 的 WMTSCapabilities，非臆造）：
//   res(L) = 0.5625 / 2^L   度/像素
//   瓦片 512×512（★不是 256，这一条最容易照搬错）
//   左上角 (−180°, +90°)，一片跨 span(L) = 512·res(L) 度
//   L0 2×1 · L1 3×2 · L2 5×3 · L3 10×5 · L4 20×10 · L5 40×20 · L6 80×40 · L7 160×80
// L3 起世界尺寸恰是 512 的整数倍；L0/L1/L2 的网格比世界大，右/下缘那几片是补过边的。
//
// ── 取向 ───────────────────────────────────────────────────────────────────
// 与整幅贴图同一套（见 imagery.js 的取向约定）：片内图像左边=西、上边=北。
//   · 3D：一片正好是 SphereGeometry 的一个 phi/theta 扇区，UV 天然 0–1，不需旋转。
//   · 2D：本模块只给「图像经度」，LON0 偏移与环绕分档由 flatCoverage 那边处理。
export const TILE = 512
// 成品图是 514×514：内容 512 + 四周各 1 px gutter（多采的一圈邻片像素）。渲染时只用中间 512，
// gutter 纯粹是喂给双线性/mipmap 采样器的 —— 没有它，相邻片各自独立采样，边界上双线性退化成
// 硬边（片内相邻纹素是平滑过渡、缝上却是瞬变），3D 高倍放大时就是一条发丝线。见 scripts/build-imagery-tiles.mjs。
export const GUTTER = 1
export const IMGSIZE = TILE + 2 * GUTTER
export const MAXZ = 7                       // 离线包做到 L7 = 489 m/px（BMNG 500m 原生的物理上限）
export const res = (z) => 0.5625 / 2 ** z   // 度/像素
export const span = (z) => TILE * res(z)    // 一片跨多少度
export const cols = (z) => Math.ceil(360 / span(z))
export const rows = (z) => Math.ceil(180 / span(z))

// 一片覆盖的经纬范围（图像经度，−180..180）。注意 L0/L1/L2 的边缘片会超出世界范围，
// 那部分在切片时补成了黑边 —— 调用方按 world 范围裁剪即可，不必特殊处理。
export function tileBox(z, row, col) {
  const s = span(z)
  return { west: -180 + col * s, east: -180 + (col + 1) * s, north: 90 - row * s, south: 90 - (row + 1) * s, span: s }
}

// 一片【裁到世界矩形之内】的那一块：跨度 spanX/spanY（度）+ 它占整片的比例 fx/fy（用来设纹理窗口）。
// ★ 为什么必须裁 —— L0/L1 的网格比世界大（L0 是 2 列 × 288° = 576°，横向越界 216°；L1 是
//   3 列 × 144° = 432°，越界 72°），切片脚本 build-imagery-tiles.mjs 的 cutTile 把越出世界的
//   部分按边缘复制补齐了（gutter 采样需要）。渲染端若照【整片跨度】建球面扇区，那段补边内容
//   就绕过 ±180 压回世界另一侧：L1 第 2 列 west=108 跨 144° → 覆盖 108..252，右半等于
//   −180..−108，与第 0 列同半径同 polygonOffset 叠画，z-fighting 出竖条纹；L0 第 1 列
//   west=108 east=396 → 环绕覆盖 −180..+36 整整 216°。纵向同理：L0 单行跨 288° 越过南极
//   108°，只是绕序翻转被背面剔除，看不见但顶点与纹理白算白传。
//   （2D 不受影响：imageryPlan 画到世界矩形之外的部分被 drawBelowContent 的 clip 裁掉。）
// L3 起世界尺寸恰是片跨度的整数倍 → fx = fy = 1，本函数对那几级是恒等。
// 越界到整片都在世界之外（当前网格不会出现，纯防御）或行列号越界时返回 null，调用方跳过该片。
export function tileClip(z, row, col) {
  if (z < 0 || row < 0 || col < 0 || row >= rows(z) || col >= cols(z)) return null
  const b = tileBox(z, row, col), s = b.span
  const spanX = Math.min(b.east, 180) - b.west
  const spanY = b.north - Math.max(b.south, -90)
  if (!(spanX > 0) || !(spanY > 0)) return null
  return { west: b.west, north: b.north, spanX, spanY, fx: spanX / s, fy: spanY / s }
}

// 按「一个屏幕像素对应多少度」选级：要 texel ≤ pixel，故取最小的 z 使 res(z) ≤ degPerPx。
// 传的必须是【设备像素】的度数（CSS px 还要再除 dpr），否则高 DPR 屏上永远选低一级、白糊一层。
export function pickZoom(degPerPx, maxZ = MAXZ) {
  if (!(degPerPx > 0)) return 0
  const z = Math.ceil(Math.log2(0.5625 / degPerPx))
  return Math.max(0, Math.min(maxZ, z))
}

// 某级下覆盖给定经纬窗口的片号范围（含端点）。西经>东经表示跨了 ±180，调用方自行分两段。
export function tileRange(z, west, east, north, south) {
  const s = span(z), nc = cols(z), nr = rows(z)
  const c0 = Math.max(0, Math.min(nc - 1, Math.floor((west + 180) / s)))
  const c1 = Math.max(0, Math.min(nc - 1, Math.floor((east + 180 - 1e-9) / s)))
  const r0 = Math.max(0, Math.min(nr - 1, Math.floor((90 - north) / s)))
  const r1 = Math.max(0, Math.min(nr - 1, Math.floor((90 - south - 1e-9) / s)))
  return { c0, c1, r0, r1 }
}

// ── 瓦片集 ──────────────────────────────────────────────────────────────────
// 一个「集」= 一套 (z,row,col) → URL 的映射 + 它自己的 gutter。
// 目前只有离线包一个集，但这一层保留：gutter 是逐集属性（自切的包烘了 1px，官方源多半没有），
// 渲染端两处都按集取，接第二个源时不用再动渲染代码。
// ★ 若将来再接在线源：跨域片必须在 src 之前设 img.crossOrigin='anonymous'，否则 3D 上传纹理时
//   因画布污染抛安全错误、整块球变黑（2D 的 drawImage 不受影响，故这坑只在 3D 显形）。
let BASE = 'imagery://tiles'
export function setTileBase(u) { if (u) BASE = String(u).replace(/\/+$/, '') }

const SETS = new Map()
export function defineTileSet(name, def) { SETS.set(name, def) }
export const tileSetDef = (name) => SETS.get(name) || null
export const tileGutter = (name) => { const d = SETS.get(name); return d ? (d.gutter | 0) : GUTTER }
export const tileImgSize = (name) => TILE + 2 * tileGutter(name)

export function tileUrl(set, z, row, col) {
  const d = SETS.get(set)
  if (d && d.url) return d.url(z, row, col)
  return `${BASE}/${set}/${z}/${row}/${col}.jpg`   // 缺省：离线包
}

// 出厂离线包
defineTileSet('bmng', { gutter: GUTTER, url: (z, r, c) => `${BASE}/bmng/${z}/${r}/${c}.jpg` })

const KEY = (set, z, r, c) => set + '/' + z + '/' + r + '/' + c

// LRU：装载好的 HTMLImageElement。上限按「最坏一屏能看到多少片」给，越级 pan 时旧片还留着
// 当粗档兜底（见 getTile 的 fallback），故不能开太小。一片 512² RGBA 解码后 1 MB，600 片 ≈ 600 MB
// 是解码缓存的理论上界，但浏览器对离屏 <img> 会自行回收位图，实测远低于此。
const LIMIT = 600
const cache = new Map()   // key -> HTMLImageElement（已 complete）
const inflight = new Map()
// 缺片负缓存：key -> 失败时刻。★ 没有它，一片取不到就会【每帧重发一次请求】——离线包只切到 L6
// 却按 L7 去取时，那是每秒几百次必然 404 的请求；接在线源时更是直接打成 DoS。
// 只记 MISS_TTL 毫秒，过期重试 → 补装离线包 / 网络恢复后仍能自愈，不需要重启。
const misses = new Map()
export const MISS_TTL = 30000
// 同时在飞的取片数上限。浏览器对单域本就只放 6 个并行，留一点排队深度把管道喂满即可。
const MAX_INFLIGHT = 12
export const isMissing = (set, z, row, col) => {
  const t = misses.get(KEY(set, z, row, col))
  if (t == null) return false
  if (performance.now() - t < MISS_TTL) return true
  misses.delete(KEY(set, z, row, col)); return false
}

function touch(k, v) {
  cache.delete(k); cache.set(k, v)
  while (cache.size > LIMIT) cache.delete(cache.keys().next().value)
}

// 同步取：命中返回图，未命中返回 null 并在后台装载（装好后调 onReady 触发重绘）。
// ★ 渲染路径只准调这个 —— 绝不能在绘制里 await，否则一次 pan 就是几十次异步往返、帧全丢。
export function getTile(set, z, row, col, onReady) {
  if (z < 0 || row < 0 || col < 0 || row >= rows(z) || col >= cols(z)) return null
  const k = KEY(set, z, row, col)
  const hit = cache.get(k)
  if (hit) { touch(k, hit); return hit }
  if (isMissing(set, z, row, col)) return null   // 近期确认缺片：直接放弃，别再发请求
  // ★ 并发闸。渲染端每帧最多新建几片，但一秒 60 帧就是每秒几百个请求 —— 本地读盘时看不出来
  //   （毫秒级就回），一接上高延迟的在线源（GIBS 单片往返约 0.6 s）就瞬间堆到几百个在飞，
  //   浏览器每域只放 6 个并行、其余全在排队，越排越长、越久越不出图。压住入口即可：
  //   闸满时直接返回 null，调用方记成 pending，下一帧自然重试。
  if (!inflight.has(k) && inflight.size >= MAX_INFLIGHT) return null
  if (!inflight.has(k)) {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => { inflight.delete(k); misses.delete(k); touch(k, img); onReady && onReady() }
    img.onerror = () => { inflight.delete(k); misses.set(k, performance.now()) }
    inflight.set(k, img)
    img.src = tileUrl(set, z, row, col)
  }
  return null
}

// 粗档兜底：想要的片还没到时，往上找已装载的祖先片，返回它 + 该片在祖先里的子矩形（0–1）。
// 没有它，pan/缩放时会看到成片的洞 —— 这是瓦片渲染「看起来专不专业」的分界。
export function getTileOrParent(set, z, row, col, onReady) {
  const exact = getTile(set, z, row, col, onReady)
  if (exact) return { img: exact, u0: 0, v0: 0, u1: 1, v1: 1, exact: true }
  return ancestorHit(set, z, row, col)
}
// 只查缓存的祖先片（不为任何片发请求）：GPU 路纹理上传限额时拿它顶一帧
export function ancestorHit(set, z, row, col) {
  for (let pz = z - 1, pr = row >> 1, pc = col >> 1, d = 1; pz >= 0; pz--, pr >>= 1, pc >>= 1, d++) {
    // L0–L2 的行列数不是严格二分（2×1→3×2→5×3），故祖先只在 L3 以上按位移算；
    // 更低的档直接按经纬反查，片数极少、代价可忽略。
    let ar = pr, ac = pc
    if (pz < 3) { const b = tileBox(z, row, col), s = span(pz); ar = Math.floor((90 - b.north) / s); ac = Math.floor((b.west + 180) / s) }
    const img = cache.get(KEY(set, pz, ar, ac))
    if (!img) continue
    const b = tileBox(z, row, col), pb = tileBox(pz, ar, ac)
    return {
      img, exact: false,
      u0: (b.west - pb.west) / pb.span, u1: (b.east - pb.west) / pb.span,
      v0: (pb.north - b.north) / pb.span, v1: (pb.north - b.south) / pb.span
    }
  }
  return null
}

// 某片的【父片】(z−1)：L3 以上严格二分按位移算；更低的档按经纬反查（见 getTileOrParent 的注释）。
export function parentOf(z, row, col) {
  if (z <= 0) return null
  const pz = z - 1
  if (pz >= 3) return { z: pz, r: row >> 1, c: col >> 1 }
  const b = tileBox(z, row, col), s = span(pz)
  return { z: pz, r: Math.floor((90 - b.north) / s), c: Math.floor((b.west + 180) / s) }
}
// 屏上实时路径的取片：想要的片没到 → 先看【四个子片】（刚才放大看过的那些细片全在缓存里，
// 缩小时用它们拼比拿祖先片清楚得多）→ 再往上找祖先。子片只在 L3 以上按严格二分找（L2→L3 行数 3→5
// 不是二分）。返回形状：exact / 祖先片同 getTileOrParent；子片时是 { children:[{ img, i, j }×4] }，
// i=0 西半、j=0 北半。★ 只读缓存，不为子片发请求 —— 请求只为想要的那一片发。
export function getTileFallback(set, z, row, col, onReady) {
  const exact = getTile(set, z, row, col, onReady)
  if (exact) return { img: exact, u0: 0, v0: 0, u1: 1, v1: 1, exact: true }
  if (z >= 3 && z + 1 <= MAXZ) {
    const kids = []
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const k = KEY(set, z + 1, row * 2 + j, col * 2 + i)
      const img = cache.get(k)
      if (!img) { kids.length = 0; j = 2; break }
      kids.push({ img, i, j })
    }
    if (kids.length === 4) { for (const c of kids) touch(KEY(set, z + 1, row * 2 + c.j, col * 2 + c.i), c.img); return { children: kids, exact: false } }
  }
  return getTileOrParent(set, z, row, col, onReady)
}
// 顺手把一批片的父片拉进缓存：缩小一档时要的正是它们，本地读盘几毫秒就到，几乎不会再看见祖先片糊一下。
export function prefetchParents(set, z, list, onReady) {
  if (z <= 0 || !list || !list.length) return
  const seen = new Set()
  for (const t of list) {
    const p = parentOf(z, t.r, t.c)
    if (!p) continue
    const k = p.r * 100000 + p.c
    if (seen.has(k)) continue
    seen.add(k)
    getTile(set, p.z, p.r, p.c, onReady)
  }
}

// ── 异步预载（导出专用）──────────────────────────────────────────────────────
// 渲染路径用的是同步 getTile：取不到就跳过、到货后重绘，帧率优先。
// 但【导出】是一次性同步渲染，跳过的片再也没有第二次机会 —— 于是导出的图上会缺一大块。
// 而且导出时选级比屏上深好几级（fit() 重算 base + dpr 换成放大倍率），那一级往往一张都没加载过。
// 故导出前必须先把排布里的片全部等到位，这就是本函数存在的唯一理由。
function loadOne(set, z, row, col) {
  return new Promise((resolve) => {
    if (z < 0 || row < 0 || col < 0 || row >= rows(z) || col >= cols(z)) return resolve(null)
    const k = KEY(set, z, row, col)
    const hit = cache.get(k)
    if (hit) { touch(k, hit); return resolve(hit) }
    if (isMissing(set, z, row, col)) return resolve(null)
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => { misses.delete(k); touch(k, img); resolve(img) }
    img.onerror = () => { misses.set(k, performance.now()); resolve(null) }   // 缺片不算失败：导出照常出，那一片走粗档兜底
    img.src = tileUrl(set, z, row, col)
  })
}

// list = [{r,c}]，按 z 取。并发 CONC 条，避免一次几百个请求把队列压死。
export async function loadTiles(set, z, list, conc = 8) {
  let i = 0
  const worker = async () => { while (i < list.length) { const t = list[i++]; await loadOne(set, z, t.r, t.c) } }
  await Promise.all(Array.from({ length: Math.min(conc, list.length) }, worker))
}

// 预热：把某一级整层拉进缓存（层级低、片数少时才用，供 3D 底球与首帧兜底）。
export function warm(set, z, onReady) {
  const nr = rows(z), nc = cols(z)
  for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) getTile(set, z, r, c, onReady)
}

export function clearTiles() { cache.clear(); inflight.clear() }
export const tileStats = () => ({ cached: cache.size, loading: inflight.size })
