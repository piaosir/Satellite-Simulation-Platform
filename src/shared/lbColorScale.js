// 设计空间图的场色标（链路预算三窗共用）。
//
// 三把尺子。地理场图钉死用 Turbo（见文末 TURBO，与覆盖填充面同一组锚点）——地图上铺的是
// 「哪儿高哪儿低」的地理分布，读者要的是一眼分出十几档层次，彩虹型色标的层次分辨率
// 远高于单色阶；不指定色板时（`palette` 留空）则按「这个量有没有物理临界值」在下面两把里自动选
// （临界值声明见 core/utils/lbOutputDefs.js）：
//   顺序色标 seq —— 一个色相由浅到深，只表达「多少」。给功放功率、带宽、噪温这类没有
//                    硬门限的量。亮色端可以贴近纸面（近零就该退到背景里去）。
//   发散色标 div —— 两个色相 + 中性灰中点，表达「在临界值的哪一侧、离多远」。给余量
//                    （0 为界）、占用率（100% 为界）这类跨过某个值就换性质的量。
//                    好的一侧走冷色（蓝），坏的一侧走暖色（红）——红绿对色盲不友好，
//                    蓝红是经过色觉模拟验证的那一对。
//
// 两臂用同一个半幅归一化（half = max(|max−crit|, |min−crit|)），不各归各的：
// 各归各的会让「离临界 1 dB」在两侧显出不同深浅，读者会读出实际不存在的不对称。
//
// 插值在 OKLab 里做，不在 sRGB 里做：sRGB 直插会在中途穿过灰调（蓝→红穿出脏紫），
// OKLab 是感知均匀空间，等距的数值差在视觉上也等距——色标的刻度才对得上颜色的深浅。
//
// 色板来源：蓝阶为经校验的顺序色阶（见 shared/lbPlotTheme.js 同批校验），暖臂由蓝阶
// 逐级镜像而来（保持每级的明度 L 与彩度 C，只换色相），故两臂天生感知对称。
//
// 校验记录（dataviz 校验器 + 本文件下方的自测口径，纸白 #ffffff / 暗底 #1c1c1a）：
//   ✓ 色觉模拟分离度：两臂对应级 ΔE 11.8–19.9（阈值 8），深级 17.7、中级 19.0、暗底 19.9；
//   ✓ 两臂逐级明度相等（L 差 ≤0.001，仅来自色域压缩后的 8bit 量化），冷暖两侧深浅可直接互比；
//   ✓ 明度单调：冷/暖臂 L 0.905→0.338 逐级降，暗底顺序阶反向逐级升；
//   ✓ 发散中点彩度 C=0.003 ≈ 无彩（「什么也没发生」处读起来必须是灰的）。
//   ✗ 校验器的「明度带 0.43–0.77」与「彩度下限 0.10」两项在色标两端不成立——那是分类色的
//     尺子（每个色都要独立承载身份），顺序/发散色标的浅端本就该退向纸面、中点本就该无彩，
//     故此两项在这里不适用。对底色的对比度同理：色标是大面积填充，不是需要 3:1 的标记，
//     读数由等值线数值标注与色标条刻度承担，不靠颜色本身认值。

// —— sRGB ↔ OKLab（Ottosson 2020）——
const _f = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const _g = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)

export function hexToRgb(hex) {
  const h = String(hex).replace('#', '').trim()
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)]
}
export function rgbToHex(r, g, b) {
  const q = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return '#' + q(r) + q(g) + q(b)
}
export function rgbToOklab(r, g, b) {
  const lr = _f(r / 255), lg = _f(g / 255), lb = _f(b / 255)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  ]
}
export function oklabToRgb(L, a, bb) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * bb) ** 3
  return [
    255 * _g(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    255 * _g(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    255 * _g(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
  ]
}
const inGamut = (rgb) => rgb.every((v) => v >= -0.5 && v <= 255.5)
// 保明度、压彩度直到落回 sRGB 色域（换色相后暖臂在高彩度端会出界；宁可少一点彩度，
// 也不能让 clamp 把三通道各自截断——那会把色相拧歪，两臂就不再对称了）
function toGamut(L, a, b) {
  let lo = 0, hi = 1, rgb = oklabToRgb(L, a, b)
  if (inGamut(rgb)) return rgb
  for (let k = 0; k < 24; k++) {
    const t = (lo + hi) / 2
    rgb = oklabToRgb(L, a * t, b * t)
    if (inGamut(rgb)) lo = t; else hi = t
  }
  return oklabToRgb(L, a * lo, b * lo)
}

// —— 色板 ——
// 冷臂 / 顺序色阶：经校验的蓝阶 100→700（浅→深）
const BLUE = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b']
// 暖臂色相（OKLab 极角，取自 status critical #d03b3b）——只借色相，明度彩度仍跟蓝阶逐级走
const WARM_HUE = (() => { const [, a, b] = rgbToOklab(...hexToRgb('#d03b3b')); return Math.atan2(b, a) })()
// 中性中点：亮/暗两套纸面灰（发散色标的「什么也没发生」处必须读起来是无彩色）
const MID_LIGHT = '#f0efec', MID_DARK = '#383835'

// 把蓝阶第 i 级镜像成暖色：保 L 与 C，换到暖色相
function warmStep(hex) {
  const [L, a, b] = rgbToOklab(...hexToRgb(hex))
  const C = Math.hypot(a, b)
  return toGamut(L, C * Math.cos(WARM_HUE), C * Math.sin(WARM_HUE))
}
const RED = BLUE.map((h) => { const [r, g, b] = warmStep(h); return rgbToHex(r, g, b) })

// 暗底下顺序色标要翻向：近零的一端应贴近背景（深），值大的一端才亮。
// 起点不取最深的 700（在 #1c1c1a 上几乎糊进背景，读不出「有值但很小」），取 600。
const SEQ_LIGHT = BLUE.slice()
const SEQ_DARK = ['#123457', ...BLUE.slice(0, 6).reverse()]

// Turbo（Google 2019 提出的彩虹替代品：保住彩虹的层次分辨率，去掉 jet 的假边界与
// 明度乱跳）。锚点直接取覆盖填充面那一份（viz/grd/colormap.js），两个模块的图看起来
// 才是一家的。**按 sRGB 线性插值**——Turbo 的形状本就是在 sRGB 里调出来的，搬进 OKLab
// 插值等于把它拉成另一条曲线，就不是 Turbo 了。
const TURBO = [[48, 18, 59], [62, 74, 211], [38, 168, 234], [33, 220, 169], [148, 237, 64], [241, 184, 41], [232, 92, 24], [148, 24, 17]]
function rampRgb(stops) {
  return (t) => {
    const x = Math.max(0, Math.min(1, t)) * (stops.length - 1)
    const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i
    const a = stops[i], b = stops[i + 1]
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
  }
}

// OKLab 分段线性插值：把一串 hex 锚点变成 t∈[0,1] → [r,g,b]
function ramp(hexes) {
  const labs = hexes.map((h) => rgbToOklab(...hexToRgb(h)))
  return (t) => {
    const x = Math.max(0, Math.min(1, t)) * (labs.length - 1)
    const i = Math.min(labs.length - 2, Math.floor(x)), f = x - i
    const A = labs[i], B = labs[i + 1]
    return toGamut(A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f)
  }
}

const LUT_N = 256   // 逐像素上色走查找表：一张 480×320 的场是 15 万次取色，不能每次都跑一遍 OKLab

// —— 值 → 色的分配（自适应展布）——
//
// 线性铺色（值域等分给色标）只有在场的取值大致均匀分布时才划算。真实的地理场几乎从不
// 均匀：一张余量图上，八成的格点挤在 8~13 dB 这几个 dB 里，另外那一大截值域是覆盖边缘
// 掉下去的长尾。线性铺色把色标按**值**等分，于是那八成格点只分到色标的一小段——整片
// 主区读起来就是「一个颜色」，而真正要比较的差别全被压没了（长尾那边倒是层次丰富，
// 可那里除了「反正很差」没什么可读的）。2–98 分位裁剪只砍掉极端离群值，砍不掉这件事。
//
// 故改成按**数据密度**分配色带：值密的地方多给颜色，值稀的地方少给。但不能给到底——
// 全直方图均衡会把恒定不变的一小片噪声也拉成整条彩虹。三道闸门把它按在「有用」的区间里：
//   ① 每档占比夹在 [floor, ceil]/N 之间（下限保证稀疏段不塌成一色，上限防止一个尖峰
//      把整条色标吃光）；夹完再归一，反复几轮直到既落在区间内又和为 1；
//   ② 再与线性档按 λ 混合，故任何一段的色带占比相对线性至少还有 (1−λ)；
//   ③ 直方图先平滑两道，免得逐档的斜率跳变在图上显成一圈圈马赫带。
// 合起来：任何一段值域拿到的色带宽度是「线性应得」的 0.4~3.4 倍之间，两头都有界——
// 既不会整片糊成一色，也不会凭空放大噪声。色标条按**值**线性画（见 stops），
// 于是这条非线性关系在色标条上原样看得见：颜色挤在哪一段，那段就是数据密的地方。
const STRETCH = { bins: 64, lambda: 0.8, floor: 0.25, ceil: 4 }

/**
 * 由一批场值建「值 → t∈[0,1]」的展布函数（单调、分段线性、端点固定 0/1）。
 * @param values 场值（可含 NaN，顺序无所谓）
 * @param min,max 色标域（一般是 2–98 分位）
 * @returns (v)=>t 或 null（样本太少 / 域退化时不展布，调用方回落到线性）
 */
export function buildStretch(values, min, max, opt) {
  const o = Object.assign({}, STRETCH, opt || {})
  const N = Math.max(8, o.bins | 0)
  const span = max - min
  if (!(span > 0) || !values || values.length < N * 2) return null
  const p = new Float64Array(N)
  let tot = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!(v === v)) continue
    let k = Math.floor((v - min) / span * N)
    if (k < 0) k = 0; else if (k >= N) k = N - 1
    p[k]++; tot++
  }
  if (!tot) return null
  for (let i = 0; i < N; i++) p[i] /= tot
  // ③ 直方图平滑（[1,2,1] 两道）：直方图本身是有限样本的抖动，逐档照抄会把抖动变成
  // 色标上的斜率跳变，图上就是一圈圈马赫带
  for (let pass = 0; pass < 2; pass++) {
    const q = Float64Array.from(p)
    for (let i = 0; i < N; i++) {
      const a = q[i > 0 ? i - 1 : 0], b = q[i], c = q[i < N - 1 ? i + 1 : N - 1]
      p[i] = (a + 2 * b + c) / 4
    }
  }
  // ① 夹 + 归一交替迭代：单夹一次的话归一又会把它顶出界，来回几轮即收敛到
  // 「全部落在 [lo,hi] 内且和为 1」（N·lo ≤ 1 ≤ N·hi 保证这个不动点存在）
  const lo = o.floor / N, hi = o.ceil / N
  for (let it = 0; it < 8; it++) {
    let sum = 0
    for (let i = 0; i < N; i++) { const v = p[i] < lo ? lo : p[i] > hi ? hi : p[i]; p[i] = v; sum += v }
    if (!(sum > 0)) return null
    if (Math.abs(sum - 1) < 1e-9) break
    for (let i = 0; i < N; i++) p[i] /= sum
  }
  // ② 与线性档混合，累加成分段线性的转移曲线
  const lam = Math.max(0, Math.min(1, o.lambda))
  const edges = new Float64Array(N + 1)
  for (let i = 0; i < N; i++) edges[i + 1] = edges[i] + (1 - lam) / N + lam * p[i]
  const last = edges[N] || 1
  for (let i = 1; i <= N; i++) edges[i] /= last
  return (v) => {
    const x = (v - min) / span
    if (!(x > 0)) return 0
    if (x >= 1) return 1
    const f = x * N
    const i = Math.min(N - 1, Math.floor(f))
    return edges[i] + (edges[i + 1] - edges[i]) * (f - i)
  }
}

// —— 主次分配：主区降彩、热点区满浓度（focus + context）——
//
// 展布（上一节）管的是「哪一段值分到多少颜色」，管不到「哪一段值该占多重的视觉分量」。
// Turbo 每一档都是满饱和的浓色，于是整幅图从头到尾一样响：八成面积是「到处都差不多」
// 的常见值，却与真正要看的那一小片极端区抢同样的注意力——雨露均沾，读者不知道该看哪儿。
//
// 故在色标上再叠一层显著度：离主体越远的值越浓，主体附近的值越淡。
//   · 「主体」取中位数——「常见情况落在哪儿」的最稳健估计，不被长尾牵着走；
//   · 「热点端」不由人指定，也不假定「值大就是重点」，而是取**离中位数更远的那条尾**：
//     功放功率图的主体贴着低端、长尾甩向大功率，热点自然在高端；C/N 与余量图正相反
//     （主体在高端，覆盖边缘掉下去的长尾在低端），热点落在低端。权重按两条尾的长度之比
//     给，短的那头几乎抬不起头；两条尾一样长时两端同权——对称分布本就没有单一的「重点」。
//   · 淡下去靠**收明度 + 削彩度**，不是一路洗向纸白：洗白会把主区糊成一片白雾（寡淡），
//     而把主区的明度朝一个中性档收拢，得到的是一块安静、匀质的底——压在它上面的岸线
//     国界（近白细线）与等值线也因此处处读得出，不必再挑「哪一段底色最难压」。
//
// 只对地理图的 Turbo 生效：发散色标的两臂对称不容动，顺序色标本身就是「浅→深」的显著度。
// 色标条与等值线线色都从同一张查找表取色，故这条主次关系在色标条上原样看得见（浓的那一段
// 就是重点区间），每条等值线也仍旧是它脚下那一档的颜色。
const FOCUS = {
  lift: 0.58,       // 主区明度朝中性档收拢的比例（1 = 完全收平）
  chroma: 0.62,     // 主区削掉的彩度比例
  midLight: 0.74,   // 亮底主区收拢到的明度（OKLab L）
  midDark: 0.46     // 暗底同上——暗底的「安静」是暗下去，不是亮起来
}

/**
 * 由样本定「热点端」，返回 (t)=>s∈[0,1]：1 = 满浓度（热点端），0 = 最淡（主体处）。
 * t 是**展布之后**的色标位置，故显著度与色带分配同步——色标上浓的那一段，正是
 * 稀疏长尾拿到的那一段。
 */
function buildFocus(values, min, max, toT) {
  if (!values || !(max > min)) return null
  const v = []
  for (let i = 0; i < values.length; i++) { const x = values[i]; if (x === x) v.push(x) }
  if (v.length < 32) return null                     // 样本太少，中位数说明不了「主体在哪」
  v.sort((a, b) => a - b)
  const med = v[Math.round(0.5 * (v.length - 1))]
  const hi = Math.max(0, max - med), lo = Math.max(0, med - min)
  const far = Math.max(hi, lo)
  if (!(far > 0)) return null                        // 主体正压在域端点上，分不出主次
  const wHi = hi / far, wLo = lo / far
  const tm = Math.max(0, Math.min(1, toT(med)))
  return (t) => {
    const uHi = tm < 1 ? (t - tm) / (1 - tm) : 0
    const uLo = tm > 0 ? (tm - t) / tm : 0
    const s = Math.max(wHi * Math.max(0, uHi), wLo * Math.max(0, uLo))
    return s > 1 ? 1 : s
  }
}

// 按显著度把一档色「推回背景」：明度朝中性档收、彩度按比例削。s=1 原样返回。
function recede(rgb, s, dark) {
  if (s >= 0.999) return rgb
  const f = 1 - s
  const [L, a, b] = rgbToOklab(rgb[0], rgb[1], rgb[2])
  const mid = dark ? FOCUS.midDark : FOCUS.midLight
  const k = 1 - f * FOCUS.chroma
  return toGamut(L + (mid - L) * f * FOCUS.lift, a * k, b * k)
}

// —— 压在场上的线用什么色 ——
// 等值线与它的数值标注一律取**该电平自己那一档的颜色**，只把明度朝「有余量的那一侧」
// 推开一段：线因此是彩色的（一眼看出这条线属于色标的哪一段，不必去数第几条），
// 又必然与它两侧的填充拉得开——因为线正压在那一档上，局部底色就是它自己。
// 明度推的方向按底色定：暗档往亮里推、亮档往暗里推，故 Turbo 从深紫到亮黄绿再到暗红，
// 每一档上的线都自带对比，不需要任何白边黑边来「压住」底色。
const INK_PIVOT = 0.46      // 明暗分界（OKLab L）：低于它往亮推，高于它往暗推
const INK_LINE = 0.26       // 等值线的明度落差
const INK_LABEL = 0.42      // 数值标注：笔画比线细，要拉得更开才读得清
function shiftInk(rgb, amt) {
  const [L, a, b] = rgbToOklab(rgb[0], rgb[1], rgb[2])
  const up = L < INK_PIVOT
  const L2 = up ? Math.min(0.985, L + amt) : Math.max(0.045, L - amt)
  // 提亮时略收彩度、压暗时略放：同一组 a/b 下明度一变，观感上的浓淡会跟着偏
  const k = up ? 0.86 : 1.06
  return toGamut(L2, a * k, b * k).map((v) => Math.max(0, Math.min(255, Math.round(v))))
}

/**
 * 建一把色标尺。
 * @param {object} o
 *   min, max   场的取值范围
 *   crit       物理临界值（有则用发散色标，无则顺序色标）
 *   good       'above' | 'below'：临界值的哪一侧算好（好的一侧走冷色）
 *   dark       是否暗色主题
 *   palette    'turbo' 则不走上面两把、直接用 Turbo（地理场图专用）
 *   samples    场值样本：给了就按数据密度自适应分配色带（见 buildStretch），
 *              Turbo 还据此分主次（主区降彩、热点区满浓度，见 FOCUS）。
 *              展布**只对单调色标（turbo / 顺序）生效**——发散色标的立身之本是
 *              「临界值恰在中性中点、两臂等距等深」，展布会把这两条一起毁掉。
 * @returns {{ kind, rgbAt(v), cssAt(v), lineCssAt(v), labelCssAt(v), stops(n), min, max, crit, midT, flatRgb }}
 *   rgbAt 返回 [r,g,b]；场值非有限时返回 null（调用方据此留空，不要涂成某种颜色）
 */
export function buildColorScale(o) {
  const dark = !!o.dark
  const min = +o.min, max = +o.max
  const span = (max - min) || 1
  const hasCrit = Number.isFinite(o.crit)
  const mid = hasCrit ? +o.crit : null
  const turbo = o.palette === 'turbo'

  let toT   // 场值 → t∈[0,1]
  let curve // t → [r,g,b]
  // 单调色标才展布（发散色标的中点与两臂对称性不容动）
  const stretch = (turbo || !hasCrit) ? buildStretch(o.samples, min, max) : null
  if (turbo) {
    curve = rampRgb(TURBO)
    toT = stretch || ((v) => (v - min) / span)
  } else if (hasCrit) {
    // 发散：两臂共用半幅，冷色永远在「好」的一侧。
    // 明度必须从中点单调地走到两端，走向由底色定：亮底的中点是最亮的一级、向两侧
    // 逐级加深；暗底的中点最暗（融进纸面）、向两侧逐级提亮。若两边都用「由浅到深」，
    // 暗底上就成了「深灰中点 → 极亮 → 再变深」，临界值附近会横出一条又黑又宽的暗带，
    // 看着像图上有块污渍——这正是暗色模式初版的样子。
    const half = Math.max(Math.abs(max - mid), Math.abs(mid - min)) || 1
    const coldArm = BLUE.slice(1, 6)                              // 浅 → 深
    const warmArm = RED.slice(1, 6)
    const cold = dark ? coldArm.slice().reverse() : coldArm       // 暗底反向：深 → 浅
    const warm = dark ? warmArm.slice().reverse() : warmArm
    const midHex = dark ? MID_DARK : MID_LIGHT
    const goodAbove = o.good !== 'below'
    // 低端 → 高端：好在上则「暖(深)…暖(浅) 灰 冷(浅)…冷(深)」，好在下则整条反过来
    const hexes = goodAbove
      ? [...warm.slice().reverse(), midHex, ...cold]
      : [...cold.slice().reverse(), midHex, ...warm]
    curve = ramp(hexes)
    toT = (v) => 0.5 + (v - mid) / (2 * half)
  } else {
    curve = ramp(dark ? SEQ_DARK : SEQ_LIGHT)
    toT = stretch || ((v) => (v - min) / span)
  }

  // 主次分配只给地理图的 Turbo（理由见 FOCUS 上方）
  const focus = turbo ? buildFocus(o.samples, min, max, toT) : null

  // 预烘查找表
  const lut = new Uint8Array(LUT_N * 3)
  for (let i = 0; i < LUT_N; i++) {
    const t = i / (LUT_N - 1)
    const [r, g, b] = focus ? recede(curve(t), focus(t), dark) : curve(t)
    lut[i * 3] = Math.max(0, Math.min(255, Math.round(r)))
    lut[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(g)))
    lut[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(b)))
  }
  const idxOf = (v) => {
    const t = toT(v)
    return Math.max(0, Math.min(LUT_N - 1, Math.round(t * (LUT_N - 1))))
  }

  // 场恒定时整片涂的那一色：值域只剩浮点尾巴，涂什么都不代表数值，故取「最不像数据」的
  // 一色——顺序色标的浅端 / 发散色标的中性中点 / Turbo 则退出色标另取纸面灰（Turbo 上
  // 任何一档都是浓色，拿来铺满整张图只会让人以为那里真有个极值）。
  const flatRgb = turbo
    ? hexToRgb(dark ? MID_DARK : MID_LIGHT)
    : (hasCrit ? [lut[(LUT_N >> 1) * 3], lut[(LUT_N >> 1) * 3 + 1], lut[(LUT_N >> 1) * 3 + 2]] : [lut[0], lut[1], lut[2]])

  return {
    kind: turbo ? 'turbo' : hasCrit ? 'div' : 'seq',
    min, max, crit: mid,
    adaptive: !!stretch,
    focused: !!focus,
    // 中点在色标条上的相对位置。色标条的轴是**值**（刻度线性等分），故这里也按值算，
    // 不按 t 算：发散色标两臂不等长时 t 与值本就不成比例，展布之后更不成比例。
    midT: hasCrit ? Math.max(0, Math.min(1, (mid - min) / span)) : null,
    lut,
    flatRgb,
    idxOf,
    rgbAt(v) {
      if (!Number.isFinite(v)) return null
      const i = idxOf(v)
      return [lut[i * 3], lut[i * 3 + 1], lut[i * 3 + 2]]
    },
    cssAt(v) {
      const c = this.rgbAt(v)
      return c ? `rgb(${c[0]},${c[1]},${c[2]})` : 'transparent'
    },
    // 压在场上的等值线 / 数值标注用色（见 shiftInk）
    lineCssAt(v) {
      const c = this.rgbAt(v)
      if (!c) return 'transparent'
      const k = shiftInk(c, INK_LINE)
      return `rgb(${k[0]},${k[1]},${k[2]})`
    },
    labelCssAt(v) {
      const c = this.rgbAt(v)
      if (!c) return 'transparent'
      const k = shiftInk(c, INK_LABEL)
      return `rgb(${k[0]},${k[1]},${k[2]})`
    },
    // 色标条用的取样（n 段）：按**值**等分取样，位置也按值——色标条的刻度是线性的值，
    // 颜色就必须按同一根轴摆。早先按 t 等分取样：线性色标下两者恰好一致，
    // 但发散色标两臂不等长时（min=−6/max=12/crit=0）条上画的是 t=0…1 整条曲线，
    // 而场里最低值其实只到 t=0.25，读者拿颜色去比刻度会整段对不上；
    // 自适应展布之后更是非线性关系，那条关系正该原样显示在色标条上。
    stops(n) {
      const out = []
      const m = Math.max(2, n | 0)
      for (let i = 0; i < m; i++) {
        const t = i / (m - 1)
        const k = idxOf(min + span * t) * 3
        out.push({ t, css: `rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]})` })
      }
      return out
    }
  }
}

// 供校验器/自测取用（不参与渲染）
export const PALETTE = { BLUE, RED, SEQ_LIGHT, SEQ_DARK, MID_LIGHT, MID_DARK, TURBO }
