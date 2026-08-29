// 影像底图：整幅等经纬（Plate Carrée）世界影像，2D 平面图与 3D 球体共用同一份解码结果。
//
// ── 取向约定（改这里之前先读完）─────────────────────────────────────────────
// 图像左边缘 = 180°W、上边缘 = 90°N、宽高比恒 2:1。这不是随便定的：
//   · 3D：three.js SphereGeometry 的 uv 正好是 u=(lon+180)/360、v=(90+lat)/180，
//     与 scene.js 的 emitVert（theta=(lon+180)、phi=(90−lat)）同一套取向 —— 故整幅图
//     直接贴上球面就是正的，不需要任何旋转。贴反了的典型症状是「北京画在埃及上空」，
//     一眼看不出错在哪，务必用已知地物核对（见 setImagery 处的注释）。
//   · 2D：本模块的世界度坐标是 x=lon−LON0，而图像左边是 −180°，两者差一个 LON0 偏移 →
//     须按 LON0 切成两片错位画，见 flatCoverage 的 drawImagery。
//
// ── 分辨率的天花板 ─────────────────────────────────────────────────────────
// 两个视图拉到最近分别是 ~109 m/CSS px（3D：fov 42°、minDistance 1.02 → 离地 127 km、
// 视野高 98 km）与 ~180 m/CSS px（2D：SCAP≈139）。也就是说 30 m/px 级的影像就已经吃满，
// 再高的源看不出差别。反过来，单张贴图受 GPU 纹理上限（多数机器 16384）约束，整幅最高
// 16384×8192 = 2.45 km/px —— 离 100 m/px 还差 24 倍，拉近必然糊。要真正到顶只能上瓦片
// 金字塔（在线 + 本地缓存），那是另一档工程量。这里做满的是整幅单张这一档。

// 内置源。resKm = 每像素约多少公里（赤道）、vramMB = 上到 GPU 后占多少显存、credit = 署名。
// 三者都落在界面 title 上：前者是选档依据，后两者解释了「为什么留着 8K」与 NASA 的署名要求。
//
// 目前只有一种影像（BMNG 日间真彩）的两个精度档，故 zh 只写档位、不重复图种 ——
// 每个按钮都顶着同样四个字是白占版面。将来接在线源（GIBS / 天地图）时再把「图种」这一层加回来。
//
// 授权：NASA Visible Earth / Blue Marble 系公有领域素材（使用时署名 NASA Earth Observatory）。
// ★ 两档必须同源：8K 原先用的是仓库里那张 8k_earth_daymap，海洋是一整片纯色（实测七个海域点
//   全是 30,59,117、极差 0/0/0），而 BMNG 是 topo.bathy 版、带真实水深晕渲（马里亚纳海沟 5,4,20、
//   北海大陆架 26,71,128、极差 24/68/108）—— 同一个下拉里换个档位像换了颗星球。故 8K 也由
//   同一份 21600×10800 缩制。换源时务必两档一起换。
// 两张都由官方 world.topo.bathy.200407.3x21600x10800.jpg（21600×10800，1.86 km/px）缩制而来 ——
// 缩到 16384 不是随手取的整数，而是多数 GPU 的 MAX_TEXTURE_SIZE，即【整幅单张贴图这条路的物理上限】。
// 再往上只能改用瓦片金字塔（分块纹理 + LOD 调度），那是另一档工程量。
export const IMAGERY_SOURCES = [
  { k: 'bm16k', zh: '16K', en: '16K', w: 16384, h: 8192, resKm: 2.45, vramMB: 716, credit: 'NASA Blue Marble', url: new URL('./globe3d/textures/16k_earth_bmng.jpg', import.meta.url).href },
  { k: 'bm8k', zh: '8K', en: '8K', w: 8192, h: 4096, resKm: 4.9, vramMB: 179, credit: 'NASA Blue Marble', url: new URL('./globe3d/textures/8k_earth_bmng.jpg', import.meta.url).href }
]

export const DEFAULT_IMAGERY = 'bm16k'

export function imagerySource(k) {
  return IMAGERY_SOURCES.find((s) => s.k === k) || IMAGERY_SOURCES[0]
}

// 解码缓存：按 url 存一份 Promise<HTMLImageElement>。2D 与 3D 共用这一份，不各解一次。
// 代价按 RGBA8 算（每像素 4 字节，GPU 侧含 mipmap 再 ×1.33）：
//   8192×4096  → 解码后 134 MB，显存约 179 MB
//   16384×8192 → 解码后 537 MB，显存约 716 MB
// 16K 那一档对集显机器是实打实的负担，故 8K 留在清单里作低配选项；GPU 纹理上限的降级在 scene.js 的 setImagery。
const _cache = new Map()

export function loadImagery(url) {
  if (!url) return Promise.reject(new Error('imagery: 缺少 url'))
  let p = _cache.get(url)
  if (p) return p
  p = new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => { _cache.delete(url); reject(new Error('imagery: 载入失败 ' + url)) }
    img.src = url
  })
  _cache.set(url, p)
  return p
}
