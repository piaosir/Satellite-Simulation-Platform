// 航天器 PBR 材质库 + 程序纹理（模型工作台 / 缩略图 / 3D 球模型层共用）。
//
// 为什么自己造材质库而不是给 IR 的纯色直出 MeshStandardMaterial：
//   参数化整星（paramBus）与 CAD 导入件只带「这是什么材料」的语义键，纯色 + 统一粗糙度出来就是塑料玩具感 ——
//   用户要的是 NASA 3D Resources / NASA Eyes 那种「一眼是真材料」：MLI 金箔的褶皱闪光、电池片栅格与汇流条、
//   OSR 镜面方格、白漆反射面。这些观感九成靠法线 / 粗糙度的空间变化，而不是底色，所以每种材料都配一套程序纹理。
//
// 口径：
//   · 颜色一律线性（three 的工作色彩空间就是线性 sRGB；Color.setRGB 默认按工作空间解释），贴图 map 标 SRGBColorSpace，
//     法线 / 粗糙度 / 金属度贴图保持 NoColorSpace。
//   · 纹理按「UV = 米」重复：texture.repeat = 1 / 纹理一格代表的米数。irToThree 在没有米制 UV 时按主法向盒投影生成。
//     所以同一张共享纹理在任何尺寸的部件上，电池片都是 40 × 80 mm，而不是随部件拉伸。
//   · 纹理与材质全局共享、只生成一次（打 userData._shared），disposeObject 见到就跳过 —— 一个窗口里几十个模型共用同一套。
//     真正释放只在窗口卸载时调 disposeMaterialLibrary()。
//   · 画布优先 HTMLCanvasElement（GLTFExporter 导出贴图、WebGL 上传都最稳），没有 document（Worker / 离屏页）时退 OffscreenCanvas。
import * as THREE from 'three'

// 材质键 → 参数。数值按真实材料取（DESIGN §5.2），不是凭观感拍的：
//   金箔 MLI（镀铝聚酰亚胺，外观琥珀金）：全金属、中低粗糙；褶皱靠法线贴图，粗糙度逐块抖动。
//   电池片：三结砷化镓 + 盖片玻璃，底色深蓝近黑，清漆层 = 盖片的镜面反射（clearcoat 1 / 0.05）。
//   OSR：石英镜面二次表面镜，银白、极光滑，小方格拼贴。
//   反射面：通信星的天线反射面多为白色热控漆（碳纤维面板外喷白漆），漫反射为主。
export const MATERIAL_KEYS = ['mli_gold', 'mli_silver', 'mli_black', 'solar_cell', 'solar_substrate', 'reflector', 'reflector_mesh',
  'aluminum', 'radiator', 'titanium', 'carbon', 'kapton_black', 'white_paint', 'glass', 'dark_metal',
  'paint_red', 'paint_navy', 'paint_blue', 'paint_green', 'paint_orange', 'paint_yellow', 'paint_grey', 'rubber', 'concrete']

const PRESETS = {
  // ★ 金 / 银箔粗糙度 0.32 / 0.30（DESIGN 写 0.28 / 0.25；W5 一度抬到 0.45）：光滑金属在太阳档里只有镜面方向那一小块亮、
  //   其余面映的是黑天 —— 真的镀铝聚酰亚胺在阳光下从哪个角度看都有一片碎金光，靠的是各尺度的褶皱把镜面瓣摊开。
  //   第三版的碎片法线斜率大（细碎片 ±12°），瓣已经靠几何摊开，粗糙度回到接近 DESIGN 的值，影棚里才有箔的光泽而不是砂面。
  //   法线贴图只管得了厘米级褶皱，更细的那部分折进粗糙度。外层聚酰亚胺膜本身是光滑电介质（n≈1.7），用满强度清漆层
  //   （1 / 0.08，法线跟着褶皱走）给出膜面的细碎高光 —— 金色来自膜下的铝镜被琥珀色膜染色，所以底色取偏橙的琥珀而不是黄金。
  mli_gold:        { phys: true, color: [0.88, 0.60, 0.20], metalness: 1, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08, tex: 'mli' },
  mli_silver:      { phys: true, color: [0.86, 0.86, 0.86], metalness: 1, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08, tex: 'mli' },
  mli_black:       { phys: false, color: [0.03, 0.03, 0.03], metalness: 0.2, roughness: 0.5, tex: 'mli' },
  kapton_black:    { phys: false, color: [0.03, 0.03, 0.03], metalness: 0.2, roughness: 0.5, tex: 'mli' },
  solar_cell:      { phys: true, color: [1, 1, 1], metalness: 1, roughness: 1, clearcoat: 1, clearcoatRoughness: 0.04, tex: 'cell' },
  solar_substrate: { phys: false, color: [1, 1, 1], metalness: 0, roughness: 0.6, tex: 'substrate' },
  reflector:       { phys: false, color: [0.92, 0.92, 0.90], metalness: 0, roughness: 0.55 },
  // 可展开网状反射面（镀金钼丝网）：半透明金网；双面
  reflector_mesh:  { phys: false, color: [0.83, 0.62, 0.30], metalness: 1, roughness: 0.45, opacity: 0.82, side: 'double' },
  aluminum:        { phys: false, color: [0.91, 0.92, 0.92], metalness: 1, roughness: 0.35 },
  titanium:        { phys: false, color: [0.54, 0.50, 0.45], metalness: 1, roughness: 0.38 },
  dark_metal:      { phys: false, color: [0.10, 0.10, 0.11], metalness: 0.8, roughness: 0.45 },
  carbon:          { phys: true, color: [0.035, 0.035, 0.038], metalness: 0.1, roughness: 0.4, clearcoat: 0.35, clearcoatRoughness: 0.25 },
  white_paint:     { phys: false, color: [0.85, 0.85, 0.84], metalness: 0, roughness: 0.6 },
  radiator:        { phys: false, color: [1, 1, 1], metalness: 1, roughness: 1, tex: 'osr' },
  // 光学窗口 / 镜头：不用 transmission（要多一趟透射渲染，工作台与球面第二趟都背不起），深色高光近似
  glass:           { phys: true, color: [0.02, 0.025, 0.03], metalness: 0, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02 },
  // 非卫星领域（A3）：船壳 / 甲板 / 集装箱 / 机身漆面、轮胎、混凝土。漆面是非金属电介质：水线下防污漆无光（0.7）、
  // 干舷与集装箱醇酸 / 环氧面漆半光（0.5 左右）、甲板防滑漆偏糙（0.75）、救生艇玻璃钢橙色面光亮（0.45）；
  // 轮胎炭黑橡胶近全漫反射；混凝土粗糙、底色偏暖灰。颜色与 paramBus.MATERIALS 同值（线性）。
  paint_red:       { phys: false, color: [0.45, 0.05, 0.04], metalness: 0, roughness: 0.7 },
  paint_navy:      { phys: false, color: [0.03, 0.05, 0.12], metalness: 0, roughness: 0.5 },
  paint_blue:      { phys: false, color: [0.05, 0.18, 0.45], metalness: 0, roughness: 0.55 },
  paint_green:     { phys: false, color: [0.12, 0.30, 0.14], metalness: 0, roughness: 0.75 },
  paint_orange:    { phys: false, color: [0.80, 0.30, 0.05], metalness: 0, roughness: 0.45 },
  paint_yellow:    { phys: false, color: [0.80, 0.60, 0.08], metalness: 0, roughness: 0.55 },
  paint_grey:      { phys: false, color: [0.45, 0.47, 0.50], metalness: 0, roughness: 0.45 },
  rubber:          { phys: false, color: [0.02, 0.02, 0.02], metalness: 0, roughness: 0.9 },
  concrete:        { phys: false, color: [0.55, 0.54, 0.50], metalness: 0, roughness: 0.95 }
}

// 每种程序纹理一格对应的实际尺寸（米）。电池片：8 列 × 4 行、单片 40 × 80 mm → 0.32 m 见方。
// MLI 一格 0.8 m：碎片花纹没有可辨认的大图案（不像脊纹那样有一条条可认的流线），0.8 m 重复在 2–4 m 的面上认不出来
export const TEX_TILE_M = { mli: 0.8, cell: 0.32, substrate: 0.32, osr: 0.2 }

// ---------------------------------------------------------------------------------------------
// 画布与确定性随机数（纹理每次生成都一样：缩略图 / 截图可复现，便于逐像素对拍）
// ---------------------------------------------------------------------------------------------
function makeCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c
  }
  return new OffscreenCanvas(w, h)
}
function rng(seed) {
  let s = seed >>> 0
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

// ---------------------------------------------------------------------------------------------
// MLI 褶皱（第三版）。前两版的教训：
//   · 第一版「软 Voronoi 小平面、每块 ±19°」：块大、斜率大，远看一格格明暗拼块 —— 迷彩。
//   · 第二版「多尺度脊状噪声」：折痕是连续弯曲的细脊，太阳档硬光下亮脊连成一条条流纹 —— 大理石（W5 自评）。
// 真的镀铝聚酰亚胺毯子（看在轨照片）：箔片被揉过又抻平，表面是「大大小小的平面碎片」，碎片之间是短而直的折线；
// 硬光下每块碎片要么正好把太阳反进眼里（一片亮）、要么不反（暗），于是一面毯子是一大片细碎的亮暗拼花，没有流线。
// 所以这一版 = 两层尺度的 Voronoi 碎片（5 / 2.2 cm，每块随机倾斜 6° / 12°：越细的碎片揉得越狠，小碎片套在大碎片里），碎片边界（F2 − F1 小的
// 地方）就是折线；底下垫一层平缓的大起伏（周期值噪声的梯度，±3°，毯子被抻平后残留的波）+ 绑扎点之间的鼓包（±2°）
// + 一道压条（拼缝胶带，平、更光滑）。
//   ★ 大尺度不用碎片：试过 11 cm 碎片 × 7°，影棚里一面毯子成了豹纹（大块明暗拼块，远看比真的粗十倍）；
//     真毯子在分米尺度上是软的波，硬折线只在厘米级。
// 各层在平铺周期上取模（种子格 / 噪声格按周期回绕），整张图无缝平铺。
// 粗糙度（G）逐碎片轻抖、折线处更粗：远看不是一块均匀的金属镜面，是有颗粒感的箔。
// ---------------------------------------------------------------------------------------------
function mliTextures() {
  const S = 512
  const R = rng(20260924)
  const D2R = Math.PI / 180
  // 大起伏：周期值噪声（两个八度）的高度场，差分求斜率，最后按最大斜率 3° 归一
  const lattice = (p) => { const g = new Float32Array(p * p); for (let i = 0; i < g.length; i++) g[i] = R(); return g }
  const oct = [{ p: 5, a: 1, g: lattice(5) }, { p: 11, a: 0.4, g: lattice(11) }]
  const vnoise = (O, u, v) => {
    const x = u * O.p, y = v * O.p, ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), p = O.p, w = (k) => ((k % p) + p) % p
    const g = O.g, x0 = w(ix), x1 = w(ix + 1), y0 = w(iy), y1 = w(iy + 1)
    const a = g[y0 * p + x0] + (g[y0 * p + x1] - g[y0 * p + x0]) * sx
    const b = g[y1 * p + x0] + (g[y1 * p + x1] - g[y1 * p + x0]) * sx
    return a + (b - a) * sy
  }
  const H = new Float32Array(S * S)
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { let h = 0; for (const O of oct) h += O.a * vnoise(O, x / S, y / S); H[y * S + x] = h }
  const WX = new Float32Array(S * S), WY = new Float32Array(S * S)
  let wmax = 1e-9
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const o = y * S + x
      WX[o] = H[y * S + (x + 1) % S] - H[y * S + (x + S - 1) % S]
      WY[o] = H[((y + 1) % S) * S + x] - H[((y + S - 1) % S) * S + x]
      wmax = Math.max(wmax, Math.hypot(WX[o], WY[o]))
    }
  }
  const WK = Math.tan(3 * D2R) / wmax
  const layers = [
    { N: 16, tilt: Math.tan(6 * D2R), rj: 0.05, crease: 0.07 },
    { N: 36, tilt: Math.tan(12 * D2R), rj: 0.04, crease: 0.05 }
  ].map((L) => {
    const n = L.N * L.N
    const px = new Float32Array(n), py = new Float32Array(n), tx = new Float32Array(n), ty = new Float32Array(n), rr = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      px[i] = 0.1 + 0.8 * R(); py[i] = 0.1 + 0.8 * R()
      // 圆盘内均匀取倾斜（开方：不往中心扎堆）
      const a = R() * Math.PI * 2, m = Math.sqrt(R()) * L.tilt
      tx[i] = Math.cos(a) * m; ty[i] = Math.sin(a) * m
      rr[i] = (R() - 0.5) * 2 * L.rj
    }
    return { ...L, px, py, tx, ty, rr }
  })
  const NX = new Float32Array(S * S), NY = new Float32Array(S * S), RG = new Float32Array(S * S)
  const TIE = 3                              // 每格 3 × 3 个鼓包（绑扎点间距 ≈ 27 cm）
  const PIL = Math.tan(2 * D2R)              // 鼓包最大斜率 ≈ 2°
  for (let y = 0; y < S; y++) {
    const v = (y + 0.5) / S
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S
      const o0 = y * S + x
      let sx = WX[o0] * WK, sy = WY[o0] * WK, rough = 0.62, crease = 0
      for (const L of layers) {
        const N = L.N, gx = u * N, gy = v * N
        const cx = Math.floor(gx), cy = Math.floor(gy)
        let d1 = 1e9, d2 = 1e9, k1 = 0
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) {
            const qx = cx + i, qy = cy + j
            const wx = ((qx % N) + N) % N, wy = ((qy % N) + N) % N
            const k = wy * N + wx
            const dx = qx + L.px[k] - gx, dy = qy + L.py[k] - gy
            const d = dx * dx + dy * dy
            if (d < d1) { d2 = d1; d1 = d; k1 = k } else if (d < d2) d2 = d
          }
        }
        sx += L.tx[k1]; sy += L.ty[k1]
        rough += L.rr[k1]
        if (L.crease) {
          const e = Math.sqrt(d2) - Math.sqrt(d1)          // 到最近折线的距离（种子格单位）
          if (e < L.crease) crease = Math.max(crease, 1 - e / L.crease)
        }
      }
      // 鼓包：h ∝ (1 − cos 2πkU)(1 − cos 2πkV)，斜率解析给出（最大 ≈ PIL）
      const a = 2 * Math.PI * TIE
      const cu = 1 - Math.cos(a * u), cv = 1 - Math.cos(a * v)
      sx += PIL * Math.sin(a * u) * cv * 0.5
      sy += PIL * Math.sin(a * v) * cu * 0.5
      // 压条：u ≈ 0 一道 3 cm 宽的胶带（平、更光滑），两侧各一道很窄的压痕
      const du = Math.min(u, 1 - u) * 0.8                // 米（一格 0.8 m）
      if (du < 0.015) { sx *= 0.4; sy *= 0.4; rough = 0.7; crease = 0 }
      else if (du < 0.019) { sx += (u < 0.5 ? 1 : -1) * Math.tan(10 * D2R); rough = 0.8 }
      const o = y * S + x
      NX[o] = sx; NY[o] = sy
      RG[o] = Math.min(1, Math.max(0.3, rough + 0.28 * crease))
    }
  }
  const nrm = makeCanvas(S, S), rgh = makeCanvas(S, S)
  const nctx = nrm.getContext('2d'), rctx = rgh.getContext('2d')
  const nimg = nctx.createImageData(S, S), rimg = rctx.createImageData(S, S)
  const nd = nimg.data, rd = rimg.data
  for (let o = 0; o < S * S; o++) {
    const inv = 1 / Math.sqrt(NX[o] * NX[o] + NY[o] * NY[o] + 1)
    const i = o * 4
    nd[i] = (NX[o] * inv * 0.5 + 0.5) * 255
    nd[i + 1] = (-NY[o] * inv * 0.5 + 0.5) * 255   // 画布 y 向下、纹理 v 向上：G 取反号
    nd[i + 2] = (inv * 0.5 + 0.5) * 255
    nd[i + 3] = 255
    rd[i] = 0; rd[i + 1] = RG[o] * 255; rd[i + 2] = 255; rd[i + 3] = 255
  }
  nctx.putImageData(nimg, 0, 0); rctx.putImageData(rimg, 0, 0)
  return { normal: nrm, rough: rgh }
}
// 粗糙度贴图 G 通道的均值（材质名义粗糙度按它折回：m.roughness = 名义 / 均值）
const MLI_ROUGH_MEAN = 0.66

// ---------------------------------------------------------------------------------------------
// 电池片：8 列 × 4 行、单片 40 × 80 mm（三结砷化镓的常见规格，两角切角），片间 1.2 mm 缝露出基板，
// 每片一侧一条银色汇流条 + 三个跨缝互连片，片面上极淡的细栅线。底色逐片轻微抖动（同一批片子的色差是真实可见的）。
// 同布局出一张「金属度 / 粗糙度」贴图：片面 = 盖片玻璃下的半导体（介质：金属 0.08 / 粗糙 0.32，镜面反射交给清漆层 = 盖片），
// 银件 = 金属，缝 = 基板（粗）。
// ★ 第二版把对比压下来：汇流条 / 细栅 / 缝与片面反差太大时，中距离一格电池片只占两三个像素，规则的亮线与屏幕像素拍频
//   出斜条纹。远看电池片就该是一片深蓝，细节只在近看时浮出来。（条纹的另一大头是与基板共面的 z-fighting，见材质的 polygonOffset）
// ---------------------------------------------------------------------------------------------
function cellTextures() {
  const S = 1024, COLS = 8, ROWS = 4, CW = S / COLS, CH = S / ROWS
  const gap = 3, crop = 16, bus = 5
  const R = rng(7331)
  const col = makeCanvas(S, S), mr = makeCanvas(S, S)
  const c = col.getContext('2d'), m = mr.getContext('2d')
  // 缝 / 基板：深灰蓝（与片面同一明度段，远看不出方格纸）
  c.fillStyle = 'rgb(46,50,62)'; c.fillRect(0, 0, S, S)
  m.fillStyle = 'rgb(0,178,0)'; m.fillRect(0, 0, S, S)
  const cellPath = (ctx, x0, y0) => {
    const x1 = x0 + CW - gap, y1 = y0 + CH - gap, xa = x0 + gap, ya = y0 + gap
    ctx.beginPath()
    ctx.moveTo(xa + crop, ya); ctx.lineTo(x1 - crop, ya); ctx.lineTo(x1, ya + crop)
    ctx.lineTo(x1, y1); ctx.lineTo(xa, y1); ctx.lineTo(xa, ya + crop); ctx.closePath()
  }
  for (let r = 0; r < ROWS; r++) {
    for (let k = 0; k < COLS; k++) {
      const x0 = k * CW, y0 = r * CH
      const j = (R() - 0.5) * 7, hue = (R() - 0.5) * 5
      // 片面：减反膜的深蓝紫，自上而下一点点渐变（不同入射角下的色偏），逐片色差
      const g = c.createLinearGradient(x0, y0, x0 + CW * 0.6, y0 + CH)
      g.addColorStop(0, `rgb(${Math.round(24 + j + hue)},${Math.round(32 + j)},${Math.round(74 + j - hue)})`)
      g.addColorStop(1, `rgb(${Math.round(18 + j + hue)},${Math.round(25 + j)},${Math.round(60 + j - hue)})`)
      cellPath(c, x0, y0); c.fillStyle = g; c.fill()
      cellPath(m, x0, y0); m.fillStyle = 'rgb(0,82,20)'; m.fill()
      // 细栅线：竖向每 8 px 一根（≈ 2.5 mm），极淡
      c.save(); cellPath(c, x0, y0); c.clip()
      c.fillStyle = 'rgba(120,132,170,0.12)'
      for (let x = x0 + gap + 6; x < x0 + CW - gap; x += 8) c.fillRect(x, y0, 1, CH)
      c.restore()
      // 汇流条（片底边）+ 三个互连片跨过缝
      const by = y0 + CH - gap - bus
      c.fillStyle = 'rgb(128,132,146)'; c.fillRect(x0 + gap, by, CW - 2 * gap, bus)
      m.fillStyle = 'rgb(0,90,235)'; m.fillRect(x0 + gap, by, CW - 2 * gap, bus)
      for (let t = 0; t < 3; t++) {
        const tx = x0 + gap + (CW - 2 * gap) * (0.2 + 0.3 * t) - 6
        c.fillStyle = 'rgb(122,126,140)'; c.fillRect(tx, by, 12, bus + gap * 2 + 3)
        m.fillStyle = 'rgb(0,96,235)'; m.fillRect(tx, by, 12, bus + gap * 2 + 3)
      }
    }
  }
  return { map: col, mr }
}

// 太阳翼背面（基板）：浅灰白，按电池片的格距压一道很淡的格线（背面看得见的蜂窝板分区 / 预埋件行列）
function substrateTexture() {
  const S = 512, COLS = 8, ROWS = 4
  const cv = makeCanvas(S, S), c = cv.getContext('2d')
  c.fillStyle = 'rgb(206,207,210)'; c.fillRect(0, 0, S, S)
  c.fillStyle = 'rgba(120,122,128,0.22)'
  for (let k = 0; k <= COLS; k++) c.fillRect(Math.round(k * S / COLS) - 1, 0, 2, S)
  for (let r = 0; r <= ROWS; r++) c.fillRect(0, Math.round(r * S / ROWS) - 1, S, 2)
  // 预埋件：每格中心一个小深点
  c.fillStyle = 'rgba(90,92,98,0.35)'
  for (let r = 0; r < ROWS; r++) for (let k = 0; k < COLS; k++) { c.beginPath(); c.arc((k + 0.5) * S / COLS, (r + 0.5) * S / ROWS, 3, 0, Math.PI * 2); c.fill() }
  return cv
}

// OSR 散热面：4×4 片、每片 50 mm，片间深色胶缝；每片粗糙度微抖；★ 每片还各自歪一点（±3.5°，法线贴图）：
// 真的 OSR 是一片片粘上去的石英镜，没有两片完全共面 —— 每片映到环境的不同方向，于是一面散热面是深浅不一的镜片拼花。
// 全部共面时整面映的是环境里同一个方向，太阳档下就是一整片平涂的地球蓝（W5 自评）。
function osrTextures() {
  const S = 512, N = 4, P = S / N, gap = 3
  const R = rng(4242)
  const col = makeCanvas(S, S), mr = makeCanvas(S, S), nm = makeCanvas(S, S)
  const c = col.getContext('2d'), m = mr.getContext('2d'), n = nm.getContext('2d')
  c.fillStyle = 'rgb(58,60,64)'; c.fillRect(0, 0, S, S)
  m.fillStyle = 'rgb(0,178,0)'; m.fillRect(0, 0, S, S)
  n.fillStyle = 'rgb(128,128,255)'; n.fillRect(0, 0, S, S)
  const tmax = Math.tan(3.5 * Math.PI / 180)
  for (let r = 0; r < N; r++) {
    for (let k = 0; k < N; k++) {
      const j = Math.round((R() - 0.5) * 8)
      c.fillStyle = `rgb(${226 + j},${229 + j},${234 + j})`
      c.fillRect(k * P + gap, r * P + gap, P - 2 * gap, P - 2 * gap)
      const rough = Math.round((0.05 + 0.07 * R()) * 255)
      m.fillStyle = `rgb(0,${rough},230)`
      m.fillRect(k * P + gap, r * P + gap, P - 2 * gap, P - 2 * gap)
      const a = R() * Math.PI * 2, t = Math.sqrt(R()) * tmax
      const nx = Math.cos(a) * t, ny = Math.sin(a) * t, inv = 1 / Math.sqrt(nx * nx + ny * ny + 1)
      n.fillStyle = `rgb(${Math.round((nx * inv * 0.5 + 0.5) * 255)},${Math.round((ny * inv * 0.5 + 0.5) * 255)},${Math.round((inv * 0.5 + 0.5) * 255)})`
      n.fillRect(k * P + gap, r * P + gap, P - 2 * gap, P - 2 * gap)
    }
  }
  return { map: col, mr, normal: nm }
}

// ---------------------------------------------------------------------------------------------
// 共享纹理与材质缓存
// ---------------------------------------------------------------------------------------------
let _tex = null
const _mats = new Map()
let _aniso = 1

function tex(canvas, { srgb = false, tileM = 1 } = {}) {
  const t = new THREE.CanvasTexture(canvas)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(1 / tileM, 1 / tileM)
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.anisotropy = _aniso
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.userData._shared = true
  // 导出时颜色图走 JPEG（GLTFExporter 认 texture.userData.mimeType）：1024² 电池片图 PNG 要 1 MB+，JPEG 一两百 KB；法线 / 粗糙度图留 PNG（JPEG 块效应会变成假褶皱）
  if (srgb) t.userData.mimeType = 'image/jpeg'
  return t
}

function textures() {
  if (_tex) return _tex
  const mli = mliTextures(), cell = cellTextures(), osr = osrTextures()
  _tex = {
    mliNormal: tex(mli.normal, { tileM: TEX_TILE_M.mli }),
    mliRough: tex(mli.rough, { tileM: TEX_TILE_M.mli }),
    cellMap: tex(cell.map, { srgb: true, tileM: TEX_TILE_M.cell }),
    cellMR: tex(cell.mr, { tileM: TEX_TILE_M.cell }),
    substrate: tex(substrateTexture(), { srgb: true, tileM: TEX_TILE_M.substrate }),
    osrMap: tex(osr.map, { srgb: true, tileM: TEX_TILE_M.osr }),
    osrMR: tex(osr.mr, { tileM: TEX_TILE_M.osr }),
    osrNormal: tex(osr.normal, { tileM: TEX_TILE_M.osr })
  }
  return _tex
}

/** 这个材质键是否依赖米制 UV（irToThree 据此决定要不要给没有 UV 的网格生成盒投影 UV） */
export function keyNeedsUv(key) { const p = PRESETS[key]; return !!(p && p.tex) }

/**
 * 取库材质（全局共享，别 dispose；要改透明度等就 clone 一份自己管）。
 * @param {string} key MaterialKey
 * @param {{doubleSided?:boolean}} [o]
 */
export function libraryMaterial(key, o = {}) {
  const p = PRESETS[key]
  if (!p) return null
  const ds = !!(o.doubleSided || p.side === 'double')
  const ck = key + (ds ? '|ds' : '')
  let m = _mats.get(ck)
  if (m) return m
  const args = {
    name: key,
    color: new THREE.Color().setRGB(p.color[0], p.color[1], p.color[2]),
    metalness: p.metalness,
    roughness: p.roughness,
    side: ds ? THREE.DoubleSide : THREE.FrontSide
  }
  if (p.opacity != null && p.opacity < 1) { args.transparent = true; args.opacity = p.opacity; args.depthWrite = false }
  if (p.phys) {
    args.clearcoat = p.clearcoat || 0
    args.clearcoatRoughness = p.clearcoatRoughness ?? 0.1
  }
  m = p.phys ? new THREE.MeshPhysicalMaterial(args) : new THREE.MeshStandardMaterial(args)
  if (p.tex) {
    const T = textures()
    if (p.tex === 'mli') {
      m.normalMap = T.mliNormal; m.normalScale.set(1, 1)
      m.roughnessMap = T.mliRough
      m.roughness = Math.min(1, p.roughness / MLI_ROUGH_MEAN)   // 贴图 G 通道均值折回名义粗糙度
      if (p.phys) { m.clearcoatNormalMap = T.mliNormal; m.clearcoatNormalScale.set(1, 1) }
    } else if (p.tex === 'cell') {
      m.map = T.cellMap; m.roughnessMap = T.cellMR; m.metalnessMap = T.cellMR
      // 电池片常与基板面共面（参数化翼、不少美术模型都是「基板盒 + 贴面电池片」）：深度往前推一点，免得 z-fighting
      // 把浅灰基板一道道透出来（中远距离深度精度不够时是一片斜纹 —— W5 看到的「条纹」的大头）
      m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -4
    } else if (p.tex === 'substrate') {
      m.map = T.substrate
    } else if (p.tex === 'osr') {
      m.map = T.osrMap; m.roughnessMap = T.osrMR; m.metalnessMap = T.osrMR
      m.normalMap = T.osrNormal; m.normalScale.set(1, 1)
      m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -2
    }
  }
  m.userData._shared = true
  m.userData.materialKey = key
  _mats.set(ck, m)
  return m
}

/**
 * IR 材料条目 → three 材质。有库键走库（共享）；没有就按 IR 的颜色 / 金属度 / 粗糙度现造一份（调用方负责 dispose）。
 * @param {{name?:string,key?:string,color?:number[],metalness?:number,roughness?:number,emissive?:number[],doubleSided?:boolean,opacity?:number}} im
 */
export function materialFromIR(im) {
  if (im && im.key) {
    const lib = libraryMaterial(im.key, { doubleSided: !!im.doubleSided })
    if (lib) return lib
  }
  const c = (im && im.color) || [0.7, 0.7, 0.7]
  const m = new THREE.MeshStandardMaterial({
    name: (im && im.name) || '',
    color: new THREE.Color().setRGB(c[0], c[1], c[2]),
    metalness: im && im.metalness != null ? im.metalness : 0.2,
    roughness: im && im.roughness != null ? im.roughness : 0.6,
    side: im && im.doubleSided ? THREE.DoubleSide : THREE.FrontSide
  })
  if (im && im.emissive) m.emissive.setRGB(im.emissive[0], im.emissive[1], im.emissive[2])
  if (im && im.opacity != null && im.opacity < 1) { m.transparent = true; m.opacity = im.opacity; m.depthWrite = false }
  return m
}

/** 把共享纹理的各向异性抬到 renderer 上限（≤ 8）。每个 renderer 建好后调一次。 */
export function setMaterialAnisotropy(renderer) {
  const a = Math.max(1, Math.min(8, renderer.capabilities.getMaxAnisotropy()))
  if (a <= _aniso) return
  _aniso = a
  if (_tex) for (const k in _tex) { _tex[k].anisotropy = a; _tex[k].needsUpdate = true }
}

/** 窗口卸载时释放整个材质库（只在确定没有任何模型还在用时调） */
export function disposeMaterialLibrary() {
  for (const m of _mats.values()) m.dispose()
  _mats.clear()
  if (_tex) for (const k in _tex) _tex[k].dispose()
  _tex = null
}

// ---------------------------------------------------------------------------------------------
// 用户导入件的材质兜底（渲染端导入 OBJ / FBX 走这里；与离线管线 scripts/nasa3d/build.mjs 的 applyMaterialFallbacks 同口径）
// ---------------------------------------------------------------------------------------------
// 两类「在任何查看器里都画不出形状」的材质（离线管线已对 NASA 语料修过一遍，用户自己导入的件不经过那里，渲染端补一道）：
//   ① 没有材质（OBJ 没有 .mtl / .mtl 里没定义这个名字、FBX 的 __DEFAULT）：给一份共用的中性浅灰漆面（非金属，双面）；
//   ② 退化黑（底色近黑、没贴图、不自发光、不反射——导出器把颜色丢了）：占整件三角形一半以上时按材质名关键词还原
//      （金色 MLI / 银色金属 / 白漆 / 灰 / 黑漆……）；电池片正面的名字不论占比都换成电池片外观（电池片从来不是哑光黑）。
// 常量逐条与 build.mjs 同值（modelRenderStack 单测对拍）；判据是 three 材质上的等价写法：
//   build.mjs 看 KHR_materials_specular.specularFactor = 0；这里的 OBJ / FBX 没有那个扩展，按「底色近黑、非金属或镜面强度 0」认。
export const NEUTRAL_MATERIAL_NAME = 'satsim-neutral'
export const DEGENERATE_SHARE = 0.5
export const SOLAR_FACE_RE = /solar.*(face|front)|cells?(?![a-z])/i
export const DEGENERATE_PALETTE = Object.freeze([
  Object.freeze({ re: SOLAR_FACE_RE, color: [0.02, 0.04, 0.12], metallic: 0.35, roughness: 0.18 }),
  Object.freeze({ re: /gold|mli|kapton/i, color: [0.83, 0.6, 0.25], metallic: 1, roughness: 0.3 }),
  Object.freeze({ re: /silver|alum|anod|metal|chrome|steel|titan/i, color: [0.8, 0.8, 0.82], metallic: 1, roughness: 0.35 }),
  Object.freeze({ re: /white/i, color: [0.85, 0.85, 0.85], metallic: 0, roughness: 0.5 }),
  Object.freeze({ re: /gr[ae]y/i, color: [0.4, 0.4, 0.42], metallic: 0, roughness: 0.55 }),
  Object.freeze({ re: /red|orange/i, color: [0.6, 0.18, 0.06], metallic: 0, roughness: 0.5 }),
  Object.freeze({ re: /black|dark/i, color: [0.03, 0.03, 0.03], metallic: 0, roughness: 0.5 }),
  Object.freeze({ re: null, color: [0.6, 0.6, 0.6], metallic: 0, roughness: 0.5 })
])
export function degeneratePaletteFor(name) {
  const s = String(name || '')
  return DEGENERATE_PALETTE.find((p) => !p.re || p.re.test(s))
}
/** 中性浅灰（与 build.mjs 的 NEUTRAL 同值：线性 0.8、金属 0、粗糙 0.6、双面）；每次导入造一份，随模型走（不是共享库材质） */
export function neutralMaterial(o = {}) {
  const m = new THREE.MeshStandardMaterial({ name: NEUTRAL_MATERIAL_NAME, color: new THREE.Color().setRGB(0.8, 0.8, 0.8), metalness: 0, roughness: 0.6, side: THREE.DoubleSide, vertexColors: !!o.vertexColors })
  if (o.vertexColors) m.color.setRGB(1, 1, 1)
  return m
}
const lumMax3 = (c) => (c ? Math.max(c.r, c.g, c.b) : 0)
/** three 材质是否「退化黑」：底色近黑、没有底色贴图、不自发光，且不反射（非金属，或物理材质的镜面强度为 0）。 */
export function isDegenerateBlack(m) {
  if (!m || !m.isMeshStandardMaterial) return false
  if (lumMax3(m.color) >= 0.02 || m.map || m.vertexColors) return false
  if (lumMax3(m.emissive) >= 0.02 || m.emissiveMap) return false
  return m.metalness < 0.5 || m.specularIntensity === 0
}
/**
 * 对一棵刚导入的树做退化黑还原（无材质的已在导入器里换成中性灰）。原地改材质，返回 {share, fixed:[名字]}。
 * 三角形占比按网格的索引 / 顶点数算（多材质网格按 groups 分摊）。
 */
export function applyDegenerateFallback(root) {
  const tris = new Map()
  let total = 0
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return
    const g = o.geometry, n = Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3)
    total += n
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    if (Array.isArray(o.material) && g.groups.length) {
      for (const gr of g.groups) { const m = mats[gr.materialIndex]; if (m) tris.set(m, (tris.get(m) || 0) + Math.floor(gr.count / 3)) }
    } else if (mats[0]) tris.set(mats[0], (tris.get(mats[0]) || 0) + n)
  })
  let deg = 0
  for (const [m, n] of tris) if (isDegenerateBlack(m)) deg += n
  const share = total ? deg / total : 0
  const fixed = []
  for (const m of tris.keys()) {
    if (!isDegenerateBlack(m)) continue
    if (share > DEGENERATE_SHARE || SOLAR_FACE_RE.test(m.name || '')) {
      const p = degeneratePaletteFor(m.name)
      m.color.setRGB(p.color[0], p.color[1], p.color[2])
      m.metalness = p.metallic; m.roughness = p.roughness
      if (m.specularIntensity === 0) m.specularIntensity = 1
      m.needsUpdate = true
      fixed.push(m.name || '（无名）')
    }
  }
  return { share: +share.toFixed(4), fixed }
}

// ---------------------------------------------------------------------------------------------
// glTF JSON 层的同一道兜底：用户导入的普通 glb / glTF 走主进程 importGlb 原样入库（不经过 importers.finish），
// 工作台导入作业在入库后对存下来的那一份 JSON 块做这一步、重存（wbStore.runImport 的 glb 路）。判据与改法逐条照 build.mjs 的
// applyMaterialFallbacks（gltf-transform 文档对象上的写法 ↔ 这里的裸 JSON 写法）：
//   ① 图元没有 material → 共用一份中性浅灰（NEUTRAL_MATERIAL_NAME：baseColor 0.8、metallic 0、roughness 0.6、双面）；
//   ② 退化黑 = baseColor 近黑且无底色贴图、不自发光、KHR_materials_specular.specularFactor = 0 且无镜面贴图（gltf-transform 的缺省
//      specularFactor 是 1）；覆盖整件三角形一半以上时全部按名字还原，电池片正面的名字不论占比都还原；还原时去掉该材质的
//      KHR_materials_specular（整件再没人用时连 extensionsUsed / extensionsRequired 里的声明一起去掉）。
//   三角形按 json.meshes 逐图元数一次（不按节点实例重复计，同 build.mjs 的 listMeshes），只数 TRIANGLES（mode 4）。
// ---------------------------------------------------------------------------------------------
const lumArr = (c, d) => { const a = Array.isArray(c) ? c : d; return Math.max(Number(a[0]) || 0, Number(a[1]) || 0, Number(a[2]) || 0) }
/** glTF 材质对象是否「退化黑」（build.mjs isDegenerateBlack 的裸 JSON 写法） */
export function isDegenerateBlackGltf(mat) {
  if (!mat || typeof mat !== 'object') return false
  const pbr = mat.pbrMetallicRoughness || {}
  if (lumArr(pbr.baseColorFactor, [1, 1, 1]) >= 0.02 || pbr.baseColorTexture) return false
  if (lumArr(mat.emissiveFactor, [0, 0, 0]) >= 0.02 || mat.emissiveTexture) return false
  const sp = mat.extensions && mat.extensions.KHR_materials_specular
  if (!sp || typeof sp !== 'object') return false
  const f = sp.specularFactor === undefined ? 1 : Number(sp.specularFactor)
  return f === 0 && !sp.specularTexture
}
function gltfPrimTris(json, prim) {
  if ((prim.mode === undefined ? 4 : prim.mode) !== 4) return 0
  const acc = Array.isArray(json.accessors) ? json.accessors : []
  const ia = Number.isInteger(prim.indices) ? acc[prim.indices] : null
  const pa = prim.attributes && Number.isInteger(prim.attributes.POSITION) ? acc[prim.attributes.POSITION] : null
  const c = ia ? Number(ia.count) : (pa ? Number(pa.count) : 0)
  return Number.isFinite(c) ? Math.floor(c / 3) : 0
}
/**
 * 原地改 glTF JSON。返回 {changed, noMaterialPrims, degenerate:{share, fixed:[名字]}}（口径同 build.mjs applyMaterialFallbacks 的返回）。
 */
export function gltfMaterialFallback(json) {
  const out = { changed: false, noMaterialPrims: 0, degenerate: { share: 0, fixed: [] } }
  if (!json || typeof json !== 'object') return out
  const mats = Array.isArray(json.materials) ? json.materials : null
  let neutral = -1, total = 0, degTris = 0
  for (const mesh of Array.isArray(json.meshes) ? json.meshes : []) {
    for (const prim of mesh && Array.isArray(mesh.primitives) ? mesh.primitives : []) {
      if (!prim || typeof prim !== 'object') continue
      const t = gltfPrimTris(json, prim)
      total += t
      const mi = Number.isInteger(prim.material) ? prim.material : -1
      const mat = mi >= 0 && mats ? mats[mi] : null
      if (!mat) {
        if (neutral < 0) {
          if (!Array.isArray(json.materials)) json.materials = []
          neutral = json.materials.push({ name: NEUTRAL_MATERIAL_NAME, pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.6 }, doubleSided: true }) - 1
        }
        prim.material = neutral
        out.noMaterialPrims++
      } else if (isDegenerateBlackGltf(mat)) degTris += t
    }
  }
  const share = total ? degTris / total : 0
  out.degenerate.share = +share.toFixed(4)
  for (const mat of Array.isArray(json.materials) ? json.materials : []) {
    if (!isDegenerateBlackGltf(mat)) continue
    if (share > DEGENERATE_SHARE || SOLAR_FACE_RE.test(mat.name || '')) {
      const p = degeneratePaletteFor(mat.name)
      const pbr = mat.pbrMetallicRoughness || (mat.pbrMetallicRoughness = {})
      const a = Array.isArray(pbr.baseColorFactor) && Number.isFinite(Number(pbr.baseColorFactor[3])) ? Number(pbr.baseColorFactor[3]) : 1
      pbr.baseColorFactor = [...p.color, a]
      pbr.metallicFactor = p.metallic
      pbr.roughnessFactor = p.roughness
      delete mat.extensions.KHR_materials_specular
      if (!Object.keys(mat.extensions).length) delete mat.extensions
      out.degenerate.fixed.push(mat.name || '（无名）')
    }
  }
  if (out.degenerate.fixed.length) {
    const still = (Array.isArray(json.materials) ? json.materials : []).some((m) => m && m.extensions && m.extensions.KHR_materials_specular)
    if (!still) {
      for (const k of ['extensionsUsed', 'extensionsRequired']) {
        if (!Array.isArray(json[k])) continue
        json[k] = json[k].filter((x) => x !== 'KHR_materials_specular')
        if (!json[k].length) delete json[k]
      }
    }
  }
  out.changed = out.noMaterialPrims > 0 || out.degenerate.fixed.length > 0
  return out
}

/** 部件角色 → 叠色（部件着色叠加层用；色相分得开、明度相近，半透明叠在原材质上） */
export const ROLE_COLORS = {
  bus: 0x8a9bb0, solarArray: 0x3d7bff, reflector: 0xff8a3d, feed: 0xffd23d, boom: 0xb46bff,
  radiator: 0x3dd9e0, thruster: 0xff4d5e, sensor: 0x4dd97a, other: 0x9a9a9a
}
