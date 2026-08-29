<script setup>
// 二维场图（GSO / NGSO / 再生式三窗共用）——两根轴张成的平面上，一张场 + 一组等值线。
// 当前唯一的用法见 LbSpacePane：地理（站址经纬度 + 世界地图底图）。组件本身不认这一种，
// 底图/色标/可导航都由外部传参决定（曾并存的「环境场图」即以 basemap:false + navigable:false 用它）。
//
// 为什么是这张图：链路预算的表只讲得清「此刻这一点」，讲不清「换个地方 / 换个天气会怎样」。
// 把两根轴铺成平面、逐格重跑引擎，等值线一画就是答案：要 3 dB 余量的区域在哪、当前这条
// 链路离那条线还有多远，一眼可见。这是表里没有、也算不出来的东西。
// 图上不叠任何「可行/不可行」的判定层（斜线纹理与 0 线曾经有过，已删）：等值线本身带着
// 数值，哪边够、哪边不够看一眼就知道，再糊一层结论只是替读者下判断。
//
// 图面分工（对齐 MATLAB contourf + colorbar 与 STK 参数化研究的读图习惯）：
//   场      连续色（发散色标以物理临界值为中性中点，见 shared/lbColorScale.js）
//   等值线  细线 + 数值标注，读数不依赖比对色标；线取自己那一档的色（地图上）
//   工作点  当前链路在这张图上的位置，十字 + 读数
//   算不出的格留空（透明），绝不涂色：无解区涂上颜色就成了假结论
//
// 画法：场走 canvas（在细化网格分辨率上出一张小图，再由 canvas 原生重采样放大到图框——
// 逐屏幕像素在 JS 里插值等于把同一份信息重算上千遍，一张 1300×560 的图要几百万次函数调用），
// 等值线与轴走 SVG（矢量、导出进报告放大不失真）。两层严格对齐同一个绘图矩形。
//
// 平滑：粗网格（21~41 格，每格一次完整引擎调用，密不起来）直接提等值线只能得到折线，
// 而引擎出参按 toFixed(2) 取整，跨度小的场还会被压成台阶、等值线沿格边退化成直角阶梯。
// 故：去量化（±半个取整步内解最平滑的场）→ 双三次细化到 ~121 格 → 提线 → DP 抽稀 →
// 向心 Catmull-Rom 转三次贝塞尔——见 shared/lbContour.js。
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { niceScale, fmtTick, fmtVal, linScale, isFlatSpan } from '../shared/lbPlotScale.js'
import { isDark } from '../shared/lbPlotTheme.js'
import { buildColorScale } from '../shared/lbColorScale.js'
import { contourSegments, stitchSegments, contourLevels, bilinear, fieldExtent, refineField, dequantize, buildBlocks, smoothPathD, labelAnchors } from '../shared/lbContour.js'
import { loadBasemap, basemapPaths, OCEAN, LAND, MAP_COAST, MAP_BORDER, MAP_LW, WASH, scaleInk } from '../shared/lbBasemap.js'
import { lbDocT } from '../shared/lbDocI18n.js'
import { DOC_FONT_STACK } from '../shared/lbFont.js'

const props = defineProps({
  // —— 网格 ——
  xs: { type: Object, default: null },       // Float64Array(nx)
  ys: { type: Object, default: null },       // Float64Array(ny)
  nx: { type: Number, default: 0 },
  ny: { type: Number, default: 0 },
  z: { type: Object, default: null },        // Float64Array(nx*ny)：要画的场
  // —— 标注 ——
  xLabel: { type: String, default: '' }, xUnit: { type: String, default: '' },
  yLabel: { type: String, default: '' }, yUnit: { type: String, default: '' },
  zLabel: { type: String, default: '' }, zUnit: { type: String, default: '' },
  zCrit: { type: Number, default: null },    // 场的物理临界值（有则发散色标）
  zGood: { type: String, default: 'above' }, // 临界值哪一侧算好
  // 当前链路在设计空间中的位置
  markX: { type: Number, default: null }, markY: { type: Number, default: null },
  levelCount: { type: Number, default: 8 },
  // 画世界地图底图：仅当两根轴确实是「经度 × 纬度」时才有意义（地理图专用）。
  // 同时把图框锁成 1°经 = 1°纬，见 plotBox。
  basemap: { type: Boolean, default: false },
  // 地物线（岸线 / 国界）的浓淡倍率：α 与线宽同乘这一个数，不换色相（见 lbBasemap.scaleInk）。
  // 1 = 定标值（岸线不透明 / 国界 0.85，见 MAP_COAST / MAP_BORDER）。给用户一档旋钮的缘由：
  // 「地理参照该多重」取决于看图的人在这张图上找什么——找站落在哪个国家时要它压得住，
  // 只看场的形状时又嫌它吵。定标值只能取一个折中，那就把折中交给用户。
  mapInk: { type: Number, default: 1 },
  // 色标：'turbo' 强制走 Turbo（地理图），留空则按有无临界值自动选发散/顺序
  palette: { type: String, default: '' },
  // 视图可达的最大范围（地理图 = 整幅世界地图 360°×180°）。给定则缩到「刚好一整幅」为止，
  // 再往外滚不动、也拖不出界：世界之外没有站址可扫，一直缩下去只会得到一圈越来越大的空白。
  bounds: { type: Object, default: null },      // { x0, x1, y0, y1 }
  // 是否可导航（拖拽平移 / 滚轮缩放 / 双击复位）。环境图关掉：两根轴是可用度与降雨率，
  // 工程区间就那么一段，用上方输入框给定即可；而且它嵌在可滚动的文档栏里，
  // 滚轮在图上理应翻页而不是改区间。关掉后悬停读数照常。
  navigable: { type: Boolean, default: true },
  // SVG 总高（含四周留白），不是绘图区高——并排的两张图传同一个数才真齐脚。
  // 绘图区高由它减去上下边距反推（地理图除外：那里高由经纬跨度定，见 plotBox）。
  height: { type: Number, default: 340 },
  // 报表语言（功能区「语言」）：轴名/场名由上层按语言传进来，图上只剩这两句说明要自己翻
  lang: { type: String, default: 'zh' }
})
const emit = defineEmits(['zoom', 'reset'])
const t = computed(() => lbDocT(props.lang))

const wrap = ref(null)
const baseEl = ref(null)      // 底图：海 + 陆 + 洗淡
const fieldEl = ref(null)     // 场：唯一跟着数据域走、拖拽时被 CSS 变换搬运的一层
const lineEl = ref(null)      // 国界：压在场之上
const svgEl = ref(null)
const width = ref(560)
// 色标渐变的 id 必须逐实例唯一：同页面出现两张图时，重名的 <linearGradient>
// 会让后一张引用到前一张的色标（SVG 的 id 是全文档作用域）
let _seq = 0
const _uid = (typeof window !== 'undefined' ? (window.__lbSfSeq = (window.__lbSfSeq || 0) + 1) : ++_seq)
const gradId = 'sf-bar-' + _uid
const clipId = 'sf-clip-' + _uid
const maskId = 'sf-mask-' + _uid

// —— 字号/字体：跟随功能区「字号」组（--lb-fs 写在 <html> 行内样式上，只能自己盯） ——
const fs = ref(11)
const themeTick = ref(0)
function readCssVars() {
  try {
    const cs = getComputedStyle(document.documentElement)
    fs.value = parseFloat(cs.getPropertyValue('--lb-fs')) || 11
  } catch (e) { /* 保持默认 */ }
}
let _ro = null, _mo = null
onMounted(() => {
  readCssVars()
  if (window.MutationObserver) {
    _mo = new MutationObserver(() => { readCssVars(); themeTick.value++ })
    _mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] })
  }
  const el = wrap.value
  if (el) {
    const measure = () => { width.value = Math.max(300, el.clientWidth || 560) }
    measure()
    if (window.ResizeObserver) { _ro = new ResizeObserver(measure); _ro.observe(el) }
  }
  schedule()
})
// 拖拽多半在图外松手（拖平移本来就是要把图外的东西拽进来），故 mouseup / mousemove
// 都挂在 window 上：只挂在 svg 上会漏掉松手事件，之后整幅图都黏在鼠标上
if (typeof window !== 'undefined') {
  window.addEventListener('mouseup', onUp)
  window.addEventListener('mousemove', onPanMove)
}
onBeforeUnmount(() => {
  if (_ro) _ro.disconnect()
  if (_mo) _mo.disconnect()
  if (_raf) cancelAnimationFrame(_raf)
  if (typeof window !== 'undefined') {
    window.removeEventListener('mouseup', onUp)
    window.removeEventListener('mousemove', onPanMove)
  }
})

// —— 版面（一律由字号推导，调字号时整图同比缩放）——
// 四周压到「刚好放得下字」：这张图长在文档右栏里，边距每省 1em，图就宽 1em。
// 左右两侧按刻度数字的**实际位数**算，不按最坏情况留死量：常见的两位数只花 3em，
// 真滚轮放大到出现「30.555」这种六位刻度时才自动让位。纵轴那一侧的位数只能由值域估
//（量真实文本要等布局，而布局又依赖边距，会转成死循环）；色标那一侧刻度数固定，
// 没有这层循环，故直接按真实字数留位（见 barTickText）。
const digitsOf = (a, b) => {
  const span = Math.abs(b - a)
  const dec = span >= 20 ? 0 : span >= 2 ? 1 : span >= 0.2 ? 2 : 3
  const mag = Math.max(Math.abs(a), Math.abs(b))
  const ip = Math.max(1, Math.floor(Math.log10(Math.max(1, mag))) + 1)
  return ip + (dec ? dec + 1 : 0) + (a < 0 || b < 0 ? 1 : 0)
}
const CH = 0.55                                          // 衬线数字宽 ≈ 0.5em，留一成余量
// 边距是逐段摞出来的，不留死量：图框 →(TICK_GAP)→ 刻度数字 →(AXL_GAP)→ 竖排轴名 →(字尾)→ 边。
// 旧版左边距是 max(4.4em, …)：两位数刻度时算出来才 2.7em，那 4.4 的地板等于在刻度与轴名
// 之间白留将近 2em 的空隙（正是「坐标系与轴名离得老远」的来源），还顺带削掉一截图宽。
const TICK_GAP = 0.45     // 图框 → 刻度数字
const AXL_GAP = 0.4       // 刻度数字 → 轴名
// 轴名的字冠 / 字尾。中文字面几乎占满 em 框（实测宋体字冠 0.89em、字尾 0.175em），
// 字尾按 0.24 留是给英文报表的：Longitude 的 g、Frequency 的 y 都吊在基线下面，
// 按中文那 0.175 留位的话换成英文就会被 SVG 根元素裁掉一截笔画。
const ROT_ASC = 0.9, ROT_DESC = 0.24
const EDGE = 0.05         // 贴边余量：SVG 根元素默认裁剪，轴名探出去一点就被切掉半个字
const BAR_GAP = 0.6       // 图框 → 色标条
const yDigits = computed(() => digitsOf(yDomain.value[0], yDomain.value[1]))
// 色标刻度按**真实字数**留位（不像纵轴那样只能估）：色标的刻度数钉在 5 个、不随图高变，
// 故文本算得出来而不会回头依赖布局。估算常多留两位——值域 [2,17] 估成「一位小数」，
// 实际 niceScale 给的是 5、10、15，白占一个字宽。
const barTickText = computed(() => {
  const ex = zDomain.value
  if (!ex) return { items: [], step: 1 }
  const sc = niceScale(ex[0], ex[1], 5)
  return { items: sc.ticks.filter((t) => t >= ex[0] && t <= ex[1]).map((t) => ({ v: t, text: fmtTick(t, sc.step) })), step: sc.step }
})
// 拖色标条期间冻住的字数（见「色标条可拖」一节的 barDigitsHold）：右边距按字数留位，
// 拖过「9.5 → 10.5」这种进位处时若让它缩回去，整幅图会跟着抖一下。故只增不减，松手复零。
const barDigitsHold = ref(0)
const barDigits = computed(() => Math.max(barDigitsHold.value,
  barTickText.value.items.reduce((m, it) => Math.max(m, it.text.length), 1)))
const barTextX = computed(() => barW.value + fs.value * 0.5)                       // 色标刻度数字起点
// 竖排单位名：让开数字那一列（旧版只让 0.7em，比字冠还窄，长刻度时单位名压在数字上）
const barLabX = computed(() => barTextX.value + fs.value * (CH * barDigits.value + AXL_GAP + ROT_ASC))
const mL = computed(() => Math.round(fs.value * Math.max(3.0,                      // 左：纵轴刻度 + 竖排轴名
  CH * yDigits.value + TICK_GAP + AXL_GAP + ROT_ASC + ROT_DESC + EDGE)))
// 右：图框到色标条那一段（BAR_GAP，与模板里色标组的落点同源）+ 色标条 + 刻度 + 竖排单位
const mR = computed(() => Math.round(fs.value * BAR_GAP + barLabX.value + fs.value * (ROT_DESC + EDGE)))
const mT = computed(() => Math.round(fs.value * 0.9))    // 上：只需容下最高一格刻度数字的字冠
// 下：横轴刻度（基线 1.15em，数字无字尾）+ 轴名。摞法与左边同一套
const xAxlY = computed(() => fs.value * (1.15 + AXL_GAP + ROT_ASC))
const mB = computed(() => Math.round(xAxlY.value + fs.value * (ROT_DESC + EDGE)))
const availW = computed(() => Math.max(60, width.value - mL.value - mR.value))   // 容器允许的最大绘图宽
const barW = computed(() => Math.round(fs.value * 1.15))  // 色标条宽
// 线宽的同比系数：功能区调字号时整幅图一起缩，线不跟着走就会显得越调越细。
// canvas 的岸线国界（drawMap）与 SVG 的等值线（--sf-k）共用这一条曲线——两边任一边不跟，
// 调到 15px 时就会出现「岸线比等值线还粗」这种把参照与数据颠倒过来的层级。
// 夹在 0.85~1.45：字号能调的范围里线宽只该微调，全比例放大会把发丝线变成马克笔。
const lwK = computed(() => Math.max(0.85, Math.min(1.45, fs.value / 11)))

const ready = computed(() => !!(props.z && props.nx > 1 && props.ny > 1 && props.xs && props.ys))

// —— 标度 ——
// 数据域 = 这批格点实际覆盖的范围；视图域 = 屏幕上正在看的范围。
// 稳态下两者相同；拖拽/滚轮期间视图先动，数据要等重扫（0.1~2 s）才跟上——
// 这段时间里旧场按两域之差平移缩放着画（地图软件等新瓦片时就是这么干的），
// 于是手感是跟手的，画面也始终是地理正确的：场画在它自己那块经纬上，只是位置变了。
const dataDomain = computed(() => (ready.value
  ? { x0: props.xs[0], x1: props.xs[props.nx - 1], y0: props.ys[0], y1: props.ys[props.ny - 1] }
  : null))
const view = ref(null)          // null = 与数据对齐（稳态）
const curDom = () => view.value || dataDomain.value || { x0: 0, x1: 1, y0: 0, y1: 1 }
const xDomain = computed(() => { const d = view.value || dataDomain.value; return d ? [d.x0, d.x1] : [0, 1] })
const yDomain = computed(() => { const d = view.value || dataDomain.value; return d ? [d.y0, d.y1] : [0, 1] })

// 已发出、还没等到结果的区间队列。新数据到达时：
//   命中队列里某一项 → 该项及之前的作废；队列空了说明已追上最新意图，回到稳态；
//   一项都不命中     → 区间是外部改的（复位 / 手输 / 换站），视图无条件跟数据走。
// 只记「最后一次发的是什么」是不够的：连拖两次时先到的是上一次的结果，
// 那时若判成外部变更就会把画面弹回上一个位置。
let _emits = []
const nearDom = (a, b) => {
  const tol = (s) => Math.max(1e-4, Math.abs(s) * 1e-6)
  const tx = tol(a.x1 - a.x0), ty = tol(a.y1 - a.y0)
  return Math.abs(a.x0 - b.x0) <= tx && Math.abs(a.x1 - b.x1) <= tx &&
    Math.abs(a.y0 - b.y0) <= ty && Math.abs(a.y1 - b.y1) <= ty
}
watch(dataDomain, (d) => {
  if (!d || !view.value) { _emits.length = 0; return }
  const i = _emits.findIndex((e) => nearDom(e, d))
  if (i < 0) { _emits.length = 0; view.value = null; return }
  _emits.splice(0, i + 1)
  if (!_emits.length) view.value = null
})
// 视图限位：把提议的区间收回 bounds 之内（未给 bounds 则原样放行）。
// 逐轴各自限跨度，而不是两轴同一个倍率一起卡住——同倍率的话，先到界的那根轴会把另一根
// 一并按住，缩到底得到的是「经度整幅、纬度只剩 150°」这种半幅图；逐轴限位缩到底
// 正好是一整幅世界地图（1°经=1°纬 的图框形状仍由 plotBox 按跨度算，不会畸变）。
function fitAxis(a0, a1, lo, hi) {
  const span = a1 - a0
  if (!(span > 0) || span >= hi - lo) return [lo, hi]     // 到界：整轴铺满，正好一整幅
  if (a0 < lo) return [lo, lo + span]                     // 出界：整体推回界内，跨度不变
  if (a1 > hi) return [hi - span, hi]
  return [a0, a1]
}
function clampView(v) {
  const b = props.bounds
  if (!b) return v
  const [x0, x1] = fitAxis(v.x0, v.x1, Math.min(b.x0, b.x1), Math.max(b.x0, b.x1))
  const [y0, y1] = fitAxis(v.y0, v.y1, Math.min(b.y0, b.y1), Math.max(b.y0, b.y1))
  return { x0, x1, y0, y1 }
}
function pushView(v) {
  view.value = v
  _emits.push({ ...v })
  if (_emits.length > 8) _emits.shift()      // 扫描失败时队列不至于无限长
  emit('zoom', { xMin: v.x0, xMax: v.x1, yMin: v.y0, yMax: v.y1 })
}

// 绘图矩形。常规图：铺满可用宽，高由给定总高反推。
// 地理图（带底图）：图框严格按经纬跨度定形，1° 经度与 1° 纬度占同样的像素——
// 否则一张 2.7:1 的画布套上 1.45:1 的经纬窗口，大陆会被横向拉扁近两倍，
// 底图就从「参照系」变成了「误导」。
// 高度顶到上限时不是压扁而是**收窄**：两边留白（信箱式），比例一分不让。
// 旧版在此处夹高度（140~560），窗口一宽、经纬窗口一方，夹住的那一下就是几十个百分点的畸变。
const plotBox = computed(() => {
  const W = availW.value
  const base = Math.max(60, props.height - mT.value - mB.value)
  if (!props.basemap || !ready.value) return { w: W, h: base }
  const dx = Math.abs(xDomain.value[1] - xDomain.value[0])
  const dy = Math.abs(yDomain.value[1] - yDomain.value[0])
  if (!(dx > 0) || !(dy > 0)) return { w: W, h: base }
  // 高度上限：与宽度挂钩（宽图配高图），并封顶。
  // 上限就是**栏宽本身**（近正方的经纬窗口因此能一路铺满右栏，见 LbSpacePane 的默认区间：
  // 两轴同跨 100°）——旧版的 0.78×W 把正方窗口按住，图面白丢两成。
  // 600 px 的封顶留给宽屏：右栏一宽，正方形图就会高得把下面的参考段全顶出屏幕，
  // 那时改走信箱式留白（两侧留白、比例一分不让）。
  const capH = Math.max(240, Math.min(600, W))
  let h = W * dy / dx, w = W
  if (h > capH) { h = capH; w = h * dx / dy }
  return { w: Math.max(60, Math.round(w)), h: Math.max(60, Math.round(h)) }
})
const plotW = computed(() => plotBox.value.w)
const plotH = computed(() => plotBox.value.h)
const totalH = computed(() => plotH.value + mT.value + mB.value)
// 信箱式留白时 SVG 自身收窄并居中（.sf-svg 的 margin:0 auto）；场画布是绝对定位的，
// 得自己补上这段偏移才对得回绘图矩形
const svgW = computed(() => mL.value + plotW.value + mR.value)
const offX = computed(() => Math.max(0, Math.round((width.value - svgW.value) / 2)))
const X = computed(() => linScale(xDomain.value[0], xDomain.value[1], 0, plotW.value))
const Y = computed(() => linScale(yDomain.value[0], yDomain.value[1], plotH.value, 0))
const xTicks = computed(() => niceScale(xDomain.value[0], xDomain.value[1], Math.max(3, Math.min(8, Math.floor(plotW.value / (fs.value * 5))))))
const yTicks = computed(() => niceScale(yDomain.value[0], yDomain.value[1], Math.max(3, Math.min(7, Math.floor(plotH.value / (fs.value * 3.2))))))

// —— 细化网格：画什么都从它取 ——
// 目标每边 ~120 格：21×21 补到 81、31/41 补到 121。再密下去等值线已经看不出区别，
// marching squares 的格数却是平方增长。
// 补密之前先去量化：引擎出参是 toFixed(2) 的字符串，跨度小的场（上行 C/N 常只有 0.3 dB）
// 因此被 0.01 dB 的取整压成台阶，色块成阶梯状、等值线沿格边走出一片直角（见 shared/lbContour.js
// 的 dequantize）。改动量有硬上界 ±半个取整步，即引擎打印时已经丢掉的那点信息。
// 场、等值线、悬停读数一律取这同一份细化网格：三者必须对得上，读数与格点原值的差别
// 也就锁在半个取整步之内（即引擎打印的最后一位）。
// 统计量（色标域、电平表、极值、导出）一律仍走原始网格：细化只补格与格之间的走势，
// 不该反过来去定「这批数的范围是多少」。
const REFINE_TARGET = 120
const refined = computed(() => {
  if (!ready.value) return null
  const f = Math.max(1, Math.min(5, Math.round(REFINE_TARGET / Math.max(props.nx, props.ny))))
  const dq = dequantize(props.z, props.nx, props.ny)
  const R = refineField(dq.z, props.nx, props.ny, f)
  // 块极值索引：一条电平只穿过场的一小片，整块跳过省下九成的格点试探。
  // 建一次给全部电平共用，故挂在细化结果上跟着一起缓存。
  return { z: R.z, nx: R.nx, ny: R.ny, blocks: buildBlocks(R.z, R.nx, R.ny), q: dq.applied ? dq.q : 0 }
})
// 细化网格坐标（连续索引）→ 绘图区像素（按**数据域**铺满图框；视图跑偏时整层再做一次
// 仿射搬运，见 fieldXf——这样等值线的几何只算一次，拖拽时只是把它挪个位置）
const gx = (gi) => (gi / ((refined.value ? refined.value.nx : props.nx) - 1)) * plotW.value
const gy = (gj) => plotH.value - (gj / ((refined.value ? refined.value.ny : props.ny) - 1)) * plotH.value

// 场层（画好的位图与等值线）从「数据域铺满图框」搬到「视图域该在的位置」的仿射变换。
// 稳态下是恒等变换。
const fieldXf = computed(() => {
  const d = dataDomain.value
  const [vx0, vx1] = xDomain.value, [vy0, vy1] = yDomain.value
  if (!d || !(vx1 - vx0) || !(vy1 - vy0)) return { tx: 0, ty: 0, sx: 1, sy: 1, id: true }
  const sx = (d.x1 - d.x0) / (vx1 - vx0), sy = (d.y1 - d.y0) / (vy1 - vy0)
  const tx = (d.x0 - vx0) / (vx1 - vx0) * plotW.value
  const ty = (1 - (d.y1 - vy0) / (vy1 - vy0)) * plotH.value
  const id = Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9 && Math.abs(tx) < 0.02 && Math.abs(ty) < 0.02
  return { tx, ty, sx, sy, id }
})
const xfAttr = computed(() => {
  const t = fieldXf.value
  return t.id ? null : `translate(${t.tx.toFixed(2)},${t.ty.toFixed(2)}) scale(${t.sx.toFixed(6)},${t.sy.toFixed(6)})`
})
const xfStyle = computed(() => {
  const t = fieldXf.value
  return t.id ? null : { transform: `translate(${t.tx.toFixed(2)}px,${t.ty.toFixed(2)}px) scale(${t.sx.toFixed(6)},${t.sy.toFixed(6)})` }
})
// 等值线数值标注不能跟着缩放（字会被拉扁），故单独把落点过一遍变换
const labPos = (x, y) => {
  const t = fieldXf.value
  return [t.tx + x * t.sx, t.ty + y * t.sy]
}

// —— 场统计与色标 ——
const zExtent = computed(() => (ready.value ? fieldExtent(props.z) : null))
// 场在本区间内是否恒定。恒定往往不是 bug 而是配置使然（如「设置功放瓦数」下功放建议功率
// 恒等于设定值），但此时全场的起伏只剩数值噪声——照画等值线会在浮点尾巴上描出满屏花纹，
// 看着像有结构，实则一片虚无。
// 判据按该量自己的显示步长定（见 shared/lbPlotScale.js 的 isFlatSpan），与控制条上给选项
// 加「· 恒定」后缀用的是同一把尺：图上不画线、下拉里就该标着，两处不能各说一套。
const flat = computed(() => {
  const ex = zExtent.value
  return ex ? isFlatSpan(ex[0], ex[1], props.zUnit) : false
})
const flatValue = computed(() => {
  const ex = zExtent.value
  return ex ? (ex[0] + ex[1]) / 2 : NaN
})
// 带插值的句子不进字典（占位符一多就看不出译文长什么样），在此按语言拼
const flatText = computed(() => {
  const v = fmtVal(flatValue.value) + (props.zUnit ? ' ' + props.zUnit : '')
  return props.lang === 'en'
    ? `${props.zLabel} is constant over this range (${v})`
    : `${props.zLabel}在本区间内恒定（${v}）`
})

// 色标与等值线的取值域：取 2–98 分位，不取极值。
// 地理图上站址一扫到卫星几乎不可见的角落，余量就掉到 −100 dB 这个量级；发散色标两臂
// 共用半幅，被这么一个离群值一撑，其余 95% 的格点全挤在中性色附近——整张图糊成一片灰，
// 该看的 ±10 dB 区间反而分不出层次。裁剪后超出域的值取端点色（仍看得出「这里更差」），
// 对比度留给真正要读的区间；读数与导出的 CSV 一律仍是真实值，不受裁剪影响。
const zSorted = computed(() => {
  if (!ready.value) return null
  const vals = []
  for (let i = 0; i < props.z.length; i++) { const v = props.z[i]; if (v === v) vals.push(v) }
  if (!vals.length) return null
  vals.sort((a, b) => a - b)
  return vals
})
const zAuto = computed(() => {
  const vals = zSorted.value
  if (!vals) return null
  const q = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))]
  const lo = q(0.02), hi = q(0.98)
  // 分位退化（大片同值）时回落到真实极值，否则色标域会塌成一个点
  return (hi > lo) ? [lo, hi] : [vals[0], vals[vals.length - 1]]
})
// 用户在色标条上拖出来的域（见「色标条可拖」一节）。自动的 2–98 分位是个稳妥的默认，
// 但一张真实的场常常有八成格点挤在色标顶端那一小段里——那时把上限往上一拖，
// 糊成一色的那片主区里的层次就出来了；反过来把两端收拢，则是把对比度全花在关心的那一段上。
// 钉住之后跨视图不变（拖着地图重扫、换个区间比对时，两幅图用的是同一把尺）。
const zManual = ref(null)      // { lo, hi } | null（null = 跟着 2–98 分位走）
// 换了场变量（或换了语言导致场名变）就撤掉手动域：一把按 dB 余量定的尺子套到「功放功率 W」上毫无意义
watch(() => props.zLabel + ' ' + props.zUnit, () => { zManual.value = null })
const zDomain = computed(() => {
  const a = zAuto.value
  if (!a) return null
  const m = zManual.value
  return m ? [m.lo, m.hi] : a
})
// 真实极值是否越过了色标域（越过则在色标条两端画箭头，明示「外面还有更极端的」）
const zClipped = computed(() => {
  const ex = zExtent.value, dm = zDomain.value
  if (!ex || !dm) return { lo: false, hi: false }
  return { lo: ex[0] < dm[0] - 1e-9, hi: ex[1] > dm[1] + 1e-9 }
})
// 色标域给出「用哪一段色标」，样本再给出「这一段怎么分给具体的值」：真实的地理场几乎
// 从不均匀，八成格点常挤在值域的一小截里，按值线性铺色的话那一整片主区就是一个颜色。
// 交给 buildColorScale 按密度自适应展布（单调色标才展布，发散色标的中点不容动），
// 色标条随之按值画出这条非线性关系，读数仍一一对得上。见 shared/lbColorScale.js。
const scale = computed(() => {
  themeTick.value                                   // 主题切换要重取色板
  const dm = zDomain.value || [0, 1]
  return buildColorScale({
    min: dm[0], max: dm[1],
    crit: Number.isFinite(props.zCrit) ? props.zCrit : undefined,
    good: props.zGood, dark: isDark(), palette: props.palette,
    samples: flat.value ? null : zSorted.value
  })
})

// —— 等值线 ——
// 电平表跟着**数据的疏密**局部加密（见 contourLevels）：等间距下，主瓣里那一大片
// 只跨几个 dB，分到的线远少于它占的地——读者最关心的那块反而一条线也没有。
// 骨架（base 的整数倍）仍是全域等间距，加密线画得轻一档（.sf-iso-minor）。
const levelInfo = computed(() => {
  const ex = zDomain.value
  if (!ex) return { levels: [], step: 1, base: 1, minor: [] }
  return contourLevels(ex[0], ex[1], Number.isFinite(props.zCrit) ? props.zCrit : null, props.levelCount,
    flat.value ? null : zSorted.value)
})
const levels = computed(() => (flat.value ? [] : levelInfo.value.levels))
const levelStep = computed(() => levelInfo.value.step)
const minorSet = computed(() => new Set(levelInfo.value.minor))
// 电平标注的小数位按**这一条自己**取。加密后同一张图上会同时出现 5 与 2.5：
// 一律按最细步长格式化，骨架就成了「5.0」；一律按 base，2.5 会被写成「3」——
// 数字与它标的那条线对不上，比不标还糟。
const levelText = (v) => {
  for (let d = 0; d <= 3; d++) if (Math.abs(v - +v.toFixed(d)) < 1e-9) return fmtTick(v, d ? Math.pow(10, -d) : 1)
  return fmtTick(v, levelStep.value)
}
// —— 工作点 ——
const markPx = computed(() => {
  if (!ready.value || !Number.isFinite(props.markX) || !Number.isFinite(props.markY)) return null
  const [x0, x1] = xDomain.value, [y0, y1] = yDomain.value
  if (props.markX < Math.min(x0, x1) || props.markX > Math.max(x0, x1)) return null
  if (props.markY < Math.min(y0, y1) || props.markY > Math.max(y0, y1)) return null
  return { x: X.value(props.markX), y: Y.value(props.markY) }
})
// 工作点在「数据域铺满图框」这套坐标里的落点——等值线标注避让它时用这个，不用随视图
// 逐帧变的 markPx：contours 一旦依赖视图，拖拽的每一帧都得把 marching squares 连同
// 平滑与布标重跑一遍（8 条电平 × 121×121 格），而那份几何本来一帧都不必变。
const markData = computed(() => {
  const d = dataDomain.value
  if (!ready.value || !d || !Number.isFinite(props.markX) || !Number.isFinite(props.markY)) return null
  const u = (props.markX - d.x0) / ((d.x1 - d.x0) || 1)
  const v = (props.markY - d.y0) / ((d.y1 - d.y0) || 1)
  if (u < 0 || u > 1 || v < 0 || v > 1) return null
  return [u * plotW.value, (1 - v) * plotH.value]
})
// 工作点的墨色：它是**数据**（当前这条链路落在图上的哪儿），必须在任何一档色上都认得出，
// 但同样不该靠一圈白边去撑。取它脚下那一格的明暗，深底配浅墨、浅底配深墨——与等值线
// 的 shiftInk 同一个思路，只是标记不带色相（它标的是位置，不是某个数值）。
const markInk = computed(() => {
  if (!props.basemap) return null
  const F = refined.value, d = dataDomain.value
  let rgb = null
  if (F && d && markData.value) {
    const fi = (F.nx - 1) * (props.markX - d.x0) / ((d.x1 - d.x0) || 1)
    const fj = (F.ny - 1) * (props.markY - d.y0) / ((d.y1 - d.y0) || 1)
    rgb = flat.value ? scale.value.flatRgb : scale.value.rgbAt(bilinear(F.z, F.nx, F.ny, fi, fj))
  }
  if (!rgb) return '#12181d'
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
  return lum < 0.42 ? '#f3f7fa' : '#12181d'
})

// 每条电平：折线（细化网格坐标）→ 平滑路径 d + 一组沿线的标注锚点（位置 + 切向角）
// + 该电平自己那一档的线色（见 lbColorScale 的 shiftInk）。
// 线色随主题重取，故要跟 themeTick 挂上；几何与色都在这一层算，模板只管画。
const contours = computed(() => {
  const F = refined.value
  if (!ready.value || !F) return []
  const sc = scale.value
  const out = []
  const map = (gi, gj) => [gx(gi), gy(gj)]
  const F1 = fs.value
  const mk = markData.value
  // 布标顺序：骨架先、加密线后。名额与地盘有限时该先满足全域那几条主线
  // （加密线只在局部补细节，少标一个不伤大局）
  const ms = minorSet.value
  const ordered = levels.value.slice().sort((a, b) => (ms.has(a) ? 1 : 0) - (ms.has(b) ? 1 : 0))
  // 已放下的标注：后面的线绕开它们。加密之后同一处常常挤着好几条线，
  // 不互相让位的话数字会叠成一团（均匀场左上角实测三条线的数值堆在一小块里）
  const placed = mk ? [[mk[0], mk[1], F1 * 1.3]] : []
  for (const lv of ordered) {
    const lines = stitchSegments(contourSegments(F.z, F.nx, F.ny, lv, F.blocks))
    if (!lines.length) continue
    const crit = Number.isFinite(props.zCrit) && Math.abs(lv - props.zCrit) < 1e-9
    const minor = ms.has(lv)
    const text = levelText(lv)
    // 名额按**线条数**给，不是每条电平一个死数。一条电平在图上常常是十几条互不相连的线，
    // 给 2~3 个死名额等于「只有最长的那两三条带数字，其余的线读者无从知道它是多少」——
    // 截图里那一片「模糊的场线但没有标记」正是这么来的（实测 62% 的可见线不带数字）。
    // 上限仍在（加密线 8 / 骨架 12）：真碰上一条电平碎成几十段时，图面不能全变成数字。
    // 挤不挤得下另有两道闸：够长才进（minLen）、与已放下的数值撞了要挪开（avoid + r）。
    const nLab = Math.min(minor ? 8 : 12, Math.max(crit ? 4 : minor ? 2 : 3, lines.length))
    const labs = labelAnchors(lines, map, {
      // 加密线只出现在数据本就密的那一带（那里线本来就挨得近），门槛比骨架高一点、
      // 重复标得更疏，但**不再是「整条电平只给两个」**
      minLen: F1 * (minor ? 8 : 7),    // 短线不标，免得图面全是数字
      gap: F1 * (minor ? 30 : 20),     // 一条线上每隔约 20 em 再标一次
      max: nLab,
      r: F1 * (0.75 + 0.28 * text.length),   // 本电平自己这些数字也要互相让开
      tan: F1 * 1.6,
      pad: F1 * 1.6, w: plotW.value, h: plotH.value,
      avoid: placed.length ? placed : null   // 工作点十字（数字压上去两样都读不清，避让半径
                                             // 跟着小十字一起收）+ 已放下的其它数值
    })
    for (const l of labs) placed.push([l.x, l.y, F1 * (0.75 + 0.28 * text.length)])
    // 抽稀容差 0.35 px：与线宽同量级的偏差在纸上看不出，换来的是控制点少一个量级
    out.push({
      lv, d: smoothPathD(lines, map, 0.35), crit, minor, labs, text,
      color: props.basemap ? sc.lineCssAt(lv) : null,
      labColor: props.basemap ? sc.labelCssAt(lv) : null
    })
  }
  // 绘制顺序反过来：加密线在下、骨架在上（重叠处该由骨架压住）
  out.sort((a, b) => (a.minor ? 0 : 1) - (b.minor ? 0 : 1))
  return out
})
// 标注处要把等值线断开让位（纸质等值线图的成法：数字不是「盖」在线上，线是让开的）。
// 断口用一层 SVG mask 挖出来——线在彩色场上，描一圈底色的白边只会在图上留一串白斑。
// 落点走 labPos（与文字同一套搬运变换），尺寸不随缩放变（字本来就不缩）。
const LAB_H = 1.02, LAB_PAD = 0.5     // 断口高 / 两侧留白（em）
const labBoxes = computed(() => {
  const out = []
  const F1 = fs.value
  for (const c of contours.value) {
    // 字宽按等宽衬线数字估（0.55 em/字），不量真实文本：量文本要等布局，
    // 而这一层本身就在布局里，会转成死循环
    const w = (F1 - 1) * 0.55 * c.text.length + F1 * LAB_PAD * 2
    for (const l of c.labs) {
      const p = labPos(l.x, l.y)
      out.push({ xf: `translate(${p[0].toFixed(1)},${p[1].toFixed(1)}) rotate(${l.a.toFixed(1)})`, w, h: F1 * LAB_H })
    }
  }
  return out
})
// —— 三层画布 ——
// 海陆面（视图域，实时重投）│ 场（数据域，只在数据变时重画，拖拽期间只做 CSS 变换）│ 岸线国界（视图域，压在场上）
// 分三层的理由：拖拽一帧要动的只是场的位置，重画一遍场纯属浪费；而底图与线层必须
// 立刻按新视图重投——不然缩小时四周会空着一圈，那才叫「等瓦片」。
// 线层单独一层是因为它得压在场上面：地理参照被场糊住的话，这张图就只是块彩色方块了。
// feats 存的是 { land, borders }（见 shared/lbBasemap），不是数组
const feats = ref(null)
watch(() => props.basemap, (on) => {
  if (!on || feats.value) return
  loadBasemap().then((f) => { feats.value = f; schedule('map') })
}, { immediate: true })

const DPR = () => Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
function sizeCanvas(cv, W, H, dpr) {
  const cw = Math.max(1, Math.round(W * dpr)), ch = Math.max(1, Math.round(H * dpr))
  if (cv.width !== cw) cv.width = cw
  if (cv.height !== ch) cv.height = ch
  cv.style.width = W + 'px'; cv.style.height = H + 'px'
  return [cw, ch]
}

// —— 底图两层 ——
// 底层：海 + 陆 + 洗淡一道（不洗淡的话浅蓝的海与场的蓝端会混作一团，读者分不清一块蓝是
// 「余量高」还是「这里是海」）。线层：国界与岸线（都是实线），压在场之上。
//
// 地物线**一道过**：无彩、发丝粗、不带衬底，而且**不半透明**（见 lbBasemap 的 MAP_* 与
// MAP_LW 的第三代那一段：α 与上屏覆盖率是同一笔账里的两个因子，dpr=1 时 0.6 px 的线被
// 抗锯齿摊掉一半，再乘 0.62 的 α 就只剩三成——那正是「地理参照太淡」的病根）。
// 衬底那条路走到头了：先是「暗衬底 + 浅线芯」，等值线又反过来配白衬底去压过它，
// 结果每条线都镶着一圈相反色的边，整幅图的墨全花在边上（用户原话「信息堆在一起、
// 可读性极差」）。线要退后靠的是少给墨，不是再加一层边去撑。
// 地理参照与数据的分野改由**颜色语言**承担：地物线一律无彩，等值线一律取自己那一档的
// 色相（见 contours 的 color）——无彩的是地图，带颜色的是数据，一眼分得开，不必比线宽。
// 无彩线取深墨还是取白按主题走（MAP_* 收的是 {light,dark} 两套）：场整层软化之后，亮底上
// 它的明度被抬到 0.49~0.87，白线只剩 0.107 的落差、几乎没有，深墨才压得住；暗底的软化是
// 沉下去，白线原样最好。取色的账见 lbBasemap 的 ① 段。
// 先国界后岸线：两者在沿海重合时该由岸线压住（岸线是更强的参照，且国界在海上本就该断）。
// 线宽随字号同比缩放——功能区调字号时整幅图一起缩，线不跟着走就会显得越调越粗或越细。
//
// ss = 每 CSS 像素画多少设备像素。屏幕上就是 DPR()；**出图时传的是出图倍率**——
// 岸线与国界是矢量线，拿屏上这张 dpr 大小的画布去放大 4 倍，得到的是三四个像素宽的糊边，
// 这正是「出图质量差」的头号来源。故两条路共用这一支，只差一个 ss。
function paintMap(base, line, ss) {
  if (!base || !line) return false
  const dpr = ss || DPR(), W = plotW.value, H = plotH.value
  const [cw, ch] = sizeCanvas(base, W, H, dpr)
  sizeCanvas(line, W, H, dpr)
  const bx = base.getContext('2d'), lx = line.getContext('2d')
  bx.clearRect(0, 0, cw, ch); lx.clearRect(0, 0, cw, ch)
  const m = feats.value
  // 拿不到地图数据时整幅不画（loadBasemap 失败会给回空清单）——只铺一层海色而没有一根
  // 岸线，得到的是一块纯蓝底板，比没有底图更误导
  if (!props.basemap || !m || !(m.land.length || m.borders.length)) return false
  bx.fillStyle = OCEAN
  bx.fillRect(0, 0, cw, ch)
  const [x0, x1] = xDomain.value, [y0, y1] = yDomain.value
  const view = { lon0: Math.min(x0, x1), lon1: Math.max(x0, x1), lat0: Math.min(y0, y1), lat1: Math.max(y0, y1) }
  const size = { w: cw, h: ch }
  // 抽稀阈值 ≈ 1 个 CSS 像素，即一条线上点距的可见下限：再密也画不出差别，再疏就开始
  // 丢形。缩到整幅世界地图时 50m 的 8.0 万点压到 2 万上下（约 110m 的 3 倍——那是真有了
  // 岸线细节与独立国界层的价钱），放大到一国时几乎不抽，全份细节回来。
  // minSize（整条路径的包围盒下限）从 2.0 提到 2.6 CSS px：50m 里近千个环是礁与小岛，
  // 缩到整幅时它们各自不足三个像素，画出来只是沿岸一圈噪点——正是「太乱」的一部分。
  const dec = { minPx: 1.1 * dpr, minSize: 2.6 * dpr }
  const land = basemapPaths(m.land, view, size, dec)
  const bord = basemapPaths(m.borders, view, size, dec)
  const trace = (ctx, paths, close) => {
    ctx.beginPath()
    for (const r of paths) {
      ctx.moveTo(r[0], r[1])
      for (let i = 2; i < r.length; i += 2) ctx.lineTo(r[i], r[i + 1])
      if (close) ctx.closePath()
    }
  }
  if (land.length) {
    trace(bx, land, true)
    bx.fillStyle = LAND
    bx.fill('evenodd')          // evenodd：内环（内陆湖、飞地空洞）自然挖空
  }
  bx.fillStyle = isDark() ? WASH.dark : WASH.light
  bx.fillRect(0, 0, cw, ch)

  const k = lwK.value * dpr, th = isDark() ? 'dark' : 'light'
  // 浓淡档（界面上的「地图」一项）：α 与线宽同乘，见 props.mapInk
  const ink = Math.max(0.5, Math.min(1.6, props.mapInk || 1))
  // 线宽 = max(设备像素下限, CSS 宽 × 字号系数 × 每 CSS 像素的设备像素数)，两者都乘浓淡档。
  // 下限只在 dpr=1 时咬得住：那时 0.6~0.75 的宽度不足一个设备像素，抗锯齿把它摊到相邻两行，
  // 线像素的平均合成 α 只有 0.30 ——「地理参照太淡」的一半就出在这儿（见 lbBasemap 的 MAP_LW）。
  // 出图倍率下 w·k·dpr 远大于下限，故报告里的线宽一分没变。
  const lw = (s) => Math.max(s.min, s.w * k) * ink
  lx.lineJoin = 'round'; lx.lineCap = 'round'
  if (bord.length) {
    trace(lx, bord, false)
    // 国界**也是实线**。断续线型（虚线 / 点划线）在纸质地图上是国界的惯例，但那是整开幅
    // 的尺度；这张图只有三四百像素宽，欧亚大陆一屏几十条国界，一断开就成了满图碎点碎笔画，
    // 比线本身还吵（用户原话「看着特别乱」）。与岸线的区别只在「更淡一档、更细一档」。
    lx.strokeStyle = scaleInk(MAP_BORDER[th], ink); lx.lineWidth = lw(MAP_LW.border); lx.stroke()
  }
  if (land.length) {
    trace(lx, land, true)
    lx.strokeStyle = scaleInk(MAP_COAST[th], ink); lx.lineWidth = lw(MAP_LW.coast); lx.stroke()
  }
  return true
}
function drawMap() { paintMap(baseEl.value, lineEl.value, DPR()) }

// 场：一格一个像素画成一张「细化网格那么大」的小图（121×121 ≈ 1.5 万像素），再交给 canvas
// 放大到图框。旧版是逐屏幕像素在 JS 里做双线性：1300×560 的图在 dpr=2 下要 290 万次
// 函数调用 + 三次数组读，换主题、换字号、拖窗口都得重来一遍，几百毫秒全花在重算同一份
// 只有 1681 个数的场上。放大交给浏览器的原生重采样，量级从「百万次 JS」降到「一次 drawImage」。
// 平滑度反而更好：小图本身已是双三次细化的结果，再插一道等于二次平滑。
// ss 同 paintMap：屏上 = DPR()，出图 = 出图倍率（121 格的小图交给原生重采样放大，
// 目标画布大一倍插出来的坡就细腻一倍——拿屏上那张再放大只会把已经量化好的像素撑成方块）。
let _off = null
function paintField(cv, ss) {
  const F = refined.value
  if (!cv || !ready.value || !F) return false
  const dpr = ss || DPR()
  const [cw, ch] = sizeCanvas(cv, plotW.value, plotH.value, dpr)
  const ctx = cv.getContext('2d')
  ctx.clearRect(0, 0, cw, ch)

  const sc = scale.value, lut = sc.lut
  const { z, nx, ny } = F
  // 恒定场整片涂一色（见 lbColorScale 的 flatRgb）：不让 ±0.005 的浮点尾巴被色标
  // 放大成假的浓淡分布，也把「这里没有信息」的视觉重量降到最低。
  const fr = flat.value ? sc.flatRgb : null
  if (!_off) _off = document.createElement('canvas')
  _off.width = nx; _off.height = ny
  const octx = _off.getContext('2d')
  const img = octx.createImageData(nx, ny)
  const d = img.data
  // 网格 j 自下而上、图像行自上而下，故按行倒着填
  for (let j = 0; j < ny; j++) {
    const src = (ny - 1 - j) * nx, dst = j * nx * 4
    for (let i = 0; i < nx; i++) {
      const v = z[src + i], o = dst + i * 4
      if (!(v === v)) { d[o + 3] = 0; continue }         // 算不出的区域留空，不涂色
      if (fr) { d[o] = fr[0]; d[o + 1] = fr[1]; d[o + 2] = fr[2]; d[o + 3] = 255; continue }
      const k = sc.idxOf(v) * 3
      d[o] = lut[k]; d[o + 1] = lut[k + 1]; d[o + 2] = lut[k + 2]; d[o + 3] = 255
    }
  }
  octx.putImageData(img, 0, 0)

  ctx.save()
  ctx.beginPath(); ctx.rect(0, 0, cw, ch); ctx.clip()    // 下面要外扩半格，多出的部分裁掉
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  // 场**不透明**地压在底图上（0.62 → 0.86 → 1）。留一线底图透出来曾是想让人「认得出
  // 海陆」，但那等于把每一档色按底下是海还是陆各染一遍：同一个数值在海上与陆上显出两种
  // 颜色，色标就不再对得上场，整幅还发闷（浓度全被那层洗淡的海陆色摊薄了）。
  // 海陆参照现在全部交给压在场上的岸线与国界两层线；底图只在「算不出的格」那里露脸，
  // 而那里场本就留空。
  // 「场太浓压掉了国界」这件事**在色标里解**，不在这里解：查找表出口已经削过彩度、朝纸面
  // 收过明度（见 lbColorScale 的 SOFT），得到的淡与 globalAlpha 一模一样，却是对**一块均匀
  // 纸面**淡的——处处等价，故色标条照旧对得上场。这里一旦真设 alpha，上面那笔账立刻回来。
  // 外扩半格：图像像素的中心（(k+0.5)/n）要对上格点的位置（k/(n−1)），否则整张场
  // 会朝右下偏半格，等值线与色块错开半个格子
  const sw = cw / (nx - 1), sh = ch / (ny - 1)
  ctx.drawImage(_off, -sw / 2, -sh / 2, cw + sw, ch + sh)
  ctx.restore()
  return true
}
function drawField() { paintField(fieldEl.value, DPR()) }

// 重绘按帧合并：拖拽时视图每帧都在变，底图不该一次事件画一遍。
// 定时器兜底是必须的——窗口最小化 / 页面不合成时 rAF 被节流到 0 fps，只挂 rAF 的话
// 那段时间里的改动一次也画不出来。谁先到谁画，另一个作废。
let _raf = 0, _timer = 0, _needMap = false, _needField = false
function schedule(what) {
  if (what !== 'field') _needMap = true
  if (what !== 'map') _needField = true
  if (_raf || _timer) return
  const run = () => {
    if (_raf) { cancelAnimationFrame(_raf); _raf = 0 }
    if (_timer) { clearTimeout(_timer); _timer = 0 }
    if (_needField) { _needField = false; drawField() }
    if (_needMap) { _needMap = false; drawMap() }
  }
  if (typeof requestAnimationFrame === 'function') _raf = requestAnimationFrame(run)
  _timer = setTimeout(run, 100)
}
watch([refined, scale, plotW, plotH, () => props.basemap], () => schedule())
watch([xDomain, yDomain, feats, themeTick, () => props.mapInk], () => schedule('map'))

// —— 悬停读数（MATLAB 的 data cursor：十字游标 + 三值读数）——
// 取值走细化网格，与画出来的场同一份数：读数与色块、等值线必须对得上，
// 差别本就在插值误差之内，真算过的格点上读数就是该格点的值（Catmull-Rom 穿过样本点）。
// 该值可能与引擎打印的字符串差半个取整步（去量化的硬上界，见 refined），即最后一位上下。
const hover = ref(null)      // { px, py, x, y, z }
function atPixel(px, py) {
  const F = refined.value, d = dataDomain.value
  const [vx0, vx1] = xDomain.value, [vy0, vy1] = yDomain.value
  const x = vx0 + (vx1 - vx0) * (px / plotW.value)
  const y = vy0 + (vy1 - vy0) * (1 - py / plotH.value)
  let z = NaN
  // 取值按**数据域**换算格号：拖到数据窗口之外的地方还没算过，报个 —— 才是诚实的
  if (F && d && d.x1 !== d.x0 && d.y1 !== d.y0) {
    const fi = (F.nx - 1) * (x - d.x0) / (d.x1 - d.x0)
    const fj = (F.ny - 1) * (y - d.y0) / (d.y1 - d.y0)
    if (fi >= 0 && fi <= F.nx - 1 && fj >= 0 && fj <= F.ny - 1) z = bilinear(F.z, F.nx, F.ny, fi, fj)
  }
  return { px, py, x, y, z }
}
// 图框内的局部坐标；clamp=true 时不管拖到哪儿都算（拖平移要的就是图外那一段位移）
function localXY(e, clamp) {
  const box = svgEl.value && svgEl.value.getBoundingClientRect()
  if (!box) return null
  const px = e.clientX - box.left - mL.value, py = e.clientY - box.top - mT.value
  if (clamp) return [px, py]
  if (px < 0 || py < 0 || px > plotW.value || py > plotH.value) return null
  return [px, py]
}
function onMove(e) {
  if (!ready.value || drag.value) return
  const p = localXY(e)
  hover.value = p ? atPixel(p[0], p[1]) : null
}
function onLeave() { if (!drag.value) hover.value = null }

// —— 拖拽平移 + 滚轮缩放（与 2D 视图同一套手感）——
// 松手/滚动即 emit 新区间，由上层按新区间重扫（网格分辨率有限，纯视图放大只会看到
// 马赛克；参数化研究里「放大」的本义就是在更小的区间上重算）。等结果这段时间里，
// 旧场按 fieldXf 搬到新视图该在的位置——所以手是跟得上的，画面也一直是对的。
const drag = ref(null)
function onDown(e) {
  if (!ready.value || !props.navigable || e.button !== 0) return
  const p = localXY(e)
  if (!p) return
  drag.value = { px: p[0], py: p[1], dom: { ...curDom() }, moved: false }
  hover.value = null
  e.preventDefault()
}
function onPanMove(e) {
  // 色标条的拖动与图框的平移共用这两个 window 级监听（松手多半在元素之外）
  if (barDrag.value) { onBarDragMove(e); return }
  const g = drag.value
  if (!g) return
  const p = localXY(e, true)
  if (!p) return
  const dx = (p[0] - g.px) / plotW.value * (g.dom.x1 - g.dom.x0)
  const dy = (p[1] - g.py) / plotH.value * (g.dom.y1 - g.dom.y0)
  if (!g.moved && Math.abs(p[0] - g.px) + Math.abs(p[1] - g.py) < 3) return   // 3px 内当误触，不动图
  g.moved = true
  // 图跟着手走 = 窗口朝反方向挪；屏幕 y 向下、纬度向上，故 y 取正号
  // 限位后是「推到界就停」（拖到底时手还在动、图已经不动了，与地图软件同一手感）
  view.value = clampView({ x0: g.dom.x0 - dx, x1: g.dom.x1 - dx, y0: g.dom.y0 + dy, y1: g.dom.y1 + dy })
}
function onUp() {
  if (barDrag.value) { barDrag.value = null; barDigitsHold.value = 0; return }
  const g = drag.value
  drag.value = null
  if (!g || !g.moved || !view.value) return
  // 全程顶着界，区间一分没挪：回到起手那个区间即可，不必发一次白扫描
  if (nearDom(view.value, g.dom)) { view.value = { ...g.dom }; return }
  pushView({ ...view.value })
}
// 滚轮缩放：以光标处的数据点为锚（缩放前后光标下的那一点不动），倍率与 2D 视图同一条曲线。
// 两轴同倍率 → 地理图的 1°经=1°纬 与图框形状全程不变，版面不会跟着跳。
// **缩放只在图框之内**：指针落在轴刻度、轴名、色标条、信箱式留白或读数行上时，滚轮一律
// **原样放行给页面**（不 preventDefault），把文档栏翻下去——这是用户定的（2026-07-25）。
// 关键是 preventDefault 必须排在「在不在框内」之后：旧版先 preventDefault 再判定，于是
// 框外那一圈既不缩放、又把页面滚动吃掉了，滚轮在那儿什么也不做，看着就是「卡住了」。
// 中间还试过「框外也缩放（锚点夹到最近的边）」，用户否掉：图框以外的边距不是地图。
// 不可导航时一律不吃这个事件：图嵌在可滚动的文档栏里，滚轮该把页面翻下去
function onWheel(e) {
  if (!ready.value || !props.navigable || drag.value) return
  const p = localXY(e)                      // 不夹取：框外直接放行
  if (!p) return
  e.preventDefault()
  const d = curDom()
  const f = Math.exp(e.deltaY * 0.0015)
  const ax = d.x0 + (d.x1 - d.x0) * (p[0] / plotW.value)
  const ay = d.y0 + (d.y1 - d.y0) * (1 - p[1] / plotH.value)
  const v = clampView({
    x0: ax + (d.x0 - ax) * f, x1: ax + (d.x1 - ax) * f,
    y0: ay + (d.y0 - ay) * f, y1: ay + (d.y1 - ay) * f
  })
  if (!(v.x1 - v.x0 > 1e-9) || !(v.y1 - v.y0 > 1e-9)) return
  if (nearDom(v, d)) return                 // 已经缩到整幅世界地图，再往外滚不动
  pushView(v)
  hover.value = atPixel(p[0], p[1])
}
function onDbl() {
  if (!props.navigable) return
  view.value = null; _emits.length = 0; emit('reset')
}


// —— 色标条刻度 ——
// 文本已在 barTickText 里定好（边距要按它留位），这里只把每一条摆到条上。
// 落位走 scale.tAt（= 颜色的轴）而不是值的线性比例：条上每一档色占的长度就是它分到的
// 色带份额，读者一眼看得出「颜色都花在哪一段值上」。代价是刻度不等距——稀疏段的刻度会
// 挤到一起，故挤过头的直接不画（间距不足 1.5 em 时舍去，两端那两个优先保）。
const barTicks = computed(() => {
  const ex = zDomain.value
  if (!ex) return []
  const sc = scale.value, H = plotH.value
  const all = barTickText.value.items.map((it) => ({ v: it.v, y: H * (1 - sc.tAt(it.v)), text: it.text }))
  const out = []
  const gap = fs.value * 1.5
  for (let i = 0; i < all.length; i++) {
    const keep = i === 0 || i === all.length - 1
    if (!out.length || Math.abs(all[i].y - out[out.length - 1].y) >= gap) { out.push(all[i]); continue }
    if (keep) { out[out.length - 1] = all[i] }        // 末档优先：端点比中间刻度更值得留
  }
  return out
})
const barStops = computed(() => scale.value.stops(32))
const critBarY = computed(() => {
  const ex = zDomain.value
  if (!ex || !Number.isFinite(props.zCrit) || props.zCrit < ex[0] || props.zCrit > ex[1]) return null
  return plotH.value * (1 - scale.value.tAt(props.zCrit))
})

// —— 色标条可拖 ——
// 色标条不只是图例，也是这张图唯一一处「调色阶」的入口：拖上端改上限、拖下端改下限、
// 拖条身把整段窗口平移，双击回到自动（2–98 分位）。为什么要给：自动域是按分位数定的，
// 稳妥但保守——真实的场常有大半格点挤在色标的一小段里糊成一色（截图里那一大片暗红），
// 那时把上限往上一拖，那片里的层次立刻出来；反过来把两端收拢，就是把全部对比度
// 花在关心的那一段上。等值线电平表跟着新域重算（见 levelInfo），故拖完线也跟着变密变疏。
//
// 位移一律按**起手时的域**线性折算，不走条上的 tAt：条的轴是「颜色的轴」（刻度本就不等距，
// 见 barTicks），拿它反解会自己咬自己的尾巴——域一变 tAt 就变，手感会随拖动越来越飘；
// 而且按值线性才拖得出数据范围之外去（把上限抬到没有数据的地方，正是「留白让主区展开」）。
const BAR_GRIP = 0.9           // 两端热区高度（em）：太窄抓不住，太宽就吃掉条身的平移区
const barDrag = ref(null)      // { mode:'lo'|'hi'|'pan', py, lo, hi }
const barHot = ref('')         // 悬停在哪一段（决定光标形状）
function barZoneAt(py) {
  const g = Math.max(6, fs.value * BAR_GRIP)
  if (py <= g) return 'hi'
  if (py >= plotH.value - g) return 'lo'
  return 'pan'
}
function barLocalY(e) {
  const box = svgEl.value && svgEl.value.getBoundingClientRect()
  return box ? e.clientY - box.top - mT.value : null
}
const barCursor = computed(() => {
  const m = barDrag.value ? barDrag.value.mode : barHot.value
  return m === 'pan' ? (barDrag.value ? 'z-grabbing' : 'z-grab') : m ? 'z-ns' : ''
})
function onBarHover(e) { if (!barDrag.value) barHot.value = barZoneAt(barLocalY(e) ?? -1) }
function onBarDown(e) {
  const ex = zDomain.value
  const py = barLocalY(e)
  if (e.button !== 0 || !ready.value || flat.value || !ex || py === null) return
  e.preventDefault(); e.stopPropagation()     // 别让它落到图框那套拖拽平移上去
  barDigitsHold.value = barDigits.value
  barDrag.value = { mode: barZoneAt(py), py, lo: ex[0], hi: ex[1] }
}
function onBarDragMove(e) {
  const g = barDrag.value
  const py = barLocalY(e)
  if (!g || py === null) return
  const dv = -(py - g.py) / Math.max(1, plotH.value) * (g.hi - g.lo)
  // 限位：域再怎么拖也不离开数据一个量程。全落到场值之外时整幅图会塌成一色，
  // 那时连「往回拖」的线索都没有了（条上一片同色，看不出自己拖到了哪儿）
  const ex = zExtent.value || [g.lo, g.hi]
  const full = Math.max(1e-9, ex[1] - ex[0])
  const lim0 = ex[0] - full, lim1 = ex[1] + full
  const clamp = (v) => Math.max(lim0, Math.min(lim1, v))
  const minSpan = full * 0.02                 // 域收到比这更窄就只剩两档色，色标不再是尺子
  let lo = g.lo, hi = g.hi
  if (g.mode === 'hi') hi = Math.max(lo + minSpan, clamp(g.hi + dv))
  else if (g.mode === 'lo') lo = Math.min(hi - minSpan, clamp(g.lo + dv))
  else {
    const d = Math.max(lim0 - g.lo, Math.min(lim1 - g.hi, dv))
    lo = g.lo + d; hi = g.hi + d
  }
  zManual.value = { lo, hi }
}
function onBarDbl(e) {
  e.preventDefault(); e.stopPropagation()     // 图框的双击是「复位视图」，两件事不能混
  zManual.value = null
}

// —— 导出 ——
// 三层画布先合成一张（底图 → 场（带当前搬运变换）→ 国界），再作为 <image> 嵌进 SVG 副本：
// 屏幕上是三层只是为了拖拽时少画一点，出图时它们本就是一幅。
// ss = 目标位图的每 CSS 像素设备像素数。出图时**按 ss 重画三层**而不是搬屏上那三张：
// 屏上的画布只有 dpr（1~2）那么大，直接放大 4 倍进报告，岸线成糊边、场成方块。
function composeField(ss) {
  const dpr = ss || DPR()
  const W = plotW.value, H = plotH.value
  const cw = Math.max(1, Math.round(W * dpr)), ch = Math.max(1, Math.round(H * dpr))
  const c = document.createElement('canvas')
  c.width = cw; c.height = ch
  const x = c.getContext('2d')
  const t = fieldXf.value
  const mk = () => document.createElement('canvas')
  let base = null, line = null
  if (props.basemap) { base = mk(); line = mk(); if (!paintMap(base, line, dpr)) { base = null; line = null } }
  const fld = mk()
  const hasF = paintField(fld, dpr)
  if (base) x.drawImage(base, 0, 0, cw, ch)
  if (hasF) {
    x.save()
    x.beginPath(); x.rect(0, 0, cw, ch); x.clip()
    x.imageSmoothingEnabled = true
    x.imageSmoothingQuality = 'high'
    x.drawImage(fld, t.tx * dpr, t.ty * dpr, W * t.sx * dpr, H * t.sy * dpr)
    x.restore()
  }
  if (line) x.drawImage(line, 0, 0, cw, ch)
  return c
}
// scale = 调用方待会儿要把这幅 SVG 放大几倍去栅格化（见 LbSpacePane.exportPng）。
// 这个数**只用来定嵌进去那张位图的分辨率**：矢量部分（等值线、刻度、文字）由浏览器在
// drawImage 的目标尺寸上重新栅格化，多大都实，不必也**不能**在这里把 SVG 自身放大——
// 等值线带 vector-effect="non-scaling-stroke"（屏上是为了让线宽不随场层的搬运变换缩放），
// 一旦给 SVG 加上 viewBox 把坐标系放大 4 倍，这条属性就把线宽钉死在 4 倍前的那个像素数上，
// 出来的图里等值线细成一根发丝。位图那一层没有这层保护，只能在这里按 scale 重画。
function exportSvgString(cssVars, scale) {
  const svg = svgEl.value
  if (!svg) return ''
  const s = Math.max(1, scale || 1)
  const clone = svg.cloneNode(true)
  // 色标条的拖拽把手是控件不是图：报告里的色标只是一把图例尺，没有「可拖」这回事
  clone.querySelectorAll('.sf-barui').forEach((n) => n.remove())
  const im = document.createElementNS('http://www.w3.org/2000/svg', 'image')
  im.setAttribute('x', String(mL.value)); im.setAttribute('y', String(mT.value))
  im.setAttribute('width', String(plotW.value)); im.setAttribute('height', String(plotH.value))
  im.setAttribute('preserveAspectRatio', 'none')
  // 位图按 s 倍出：放大 s 倍成图后它正好占 plotW·s × plotH·s 个像素，1:1，不再被拉伸一道
  im.setAttribute('href', composeField(s).toDataURL('image/png'))
  const anchor = clone.querySelector('.sf-field-anchor')
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(im, anchor)
  else clone.insertBefore(im, clone.firstChild)
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  // 字体必须显式写死：屏幕上这幅 SVG 的字体是从外层 .sf 继承来的，而导出的这份离开页面
  // 后没有祖先可继承，不写就落到栅格化器的默认字体上。
  // ★ 这里刻意**不再**读屏幕上的计算值：屏上走界面字体（无衬线）、导出走报告字体（衬线），
  //   两者本就应该不同；跟着屏幕读的话，导进报告的图与正文又不是一套字了。
  clone.setAttribute('style', (cssVars ? cssVars + ';' : '') + 'font-family:' + DOC_FONT_STACK)
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone)
}
// SVG 尺寸（导 PNG 时按它乘倍数定位图大小）
const svgSize = () => ({ w: svgW.value, h: totalH.value })
// 原始网格转 CSV（长表：一行一格，便于再进 Excel 透视或 MATLAB reshape）。
// 导的是引擎真算出来的那 nx×ny 个数，不是细化后的场——细化只为画得顺，不产生数据。
function toCSV() {
  const head = [
    `${props.xLabel}${props.xUnit ? '(' + props.xUnit + ')' : ''}`,
    `${props.yLabel}${props.yUnit ? '(' + props.yUnit + ')' : ''}`,
    `${props.zLabel}${props.zUnit ? '(' + props.zUnit + ')' : ''}`
  ]
  const rows = [head.join(',')]
  for (let j = 0; j < props.ny; j++) {
    for (let i = 0; i < props.nx; i++) {
      const zv = props.z[j * props.nx + i]
      rows.push([props.xs[i], props.ys[j], (zv === zv ? zv : '')].join(','))
    }
  }
  return rows.join('\r\n')
}
defineExpose({ exportSvgString, svgSize, toCSV, svg: svgEl })
</script>

<template>
  <div ref="wrap" class="sf">
    <!-- 地理图按经纬跨度锁比例，图框可能比容器窄（信箱式留白）：SVG 自身收窄并居中 -->
    <!-- 滚轮挂在 SVG 上，但只有落在图框内才吃（见 onWheel）：框外那一圈边距不是地图，
         滚轮在那儿该把页面翻下去 -->
    <svg ref="svgEl" class="sf-svg" :class="{ nav: navigable, grab: ready && navigable, grabbing: !!drag }" :width="svgW" :height="totalH"
      @mousemove="onMove" @mouseleave="onLeave" @mousedown="onDown" @wheel="onWheel" @dblclick="onDbl">
      <!-- 场（canvas）落在这个锚点位置上；导出时 <image> 插到锚点之前，层序与屏幕一致 -->
      <g class="sf-field-anchor"></g>

      <!-- 变量 sf-k = 线宽的同比系数，等值线与工作点标记的 stroke-width 都乘它（见 lwK）。
           注意此处的注释不能出现连着的两个半角减号：模板注释会进 DOM，而导出走的是
           XMLSerializer + SVG 解析，XML 注释里带「减减」是非法的，整幅图会解不出来 -->
      <g :transform="`translate(${mL},${mT})`" :style="{ '--sf-k': lwK }">
        <!-- 等值线：细线（压在场上时逐条取自己那一档的色）；临界线加粗（唯一有物理意义的那条）。
             整层跟着场一起被 fieldXf 搬运（等新扫描期间），故要裁在图框内、线宽不随缩放变 -->
        <defs>
          <clipPath :id="clipId"><rect x="0" y="0" :width="plotW" :height="plotH" /></clipPath>
          <!-- 标注处的断口：白=画、黑=挖。白底铺得比图框大一圈，免得被 mask 自身的
               作用域切掉一截（裁剪已由上面的 clipPath 管） -->
          <mask :id="maskId" maskUnits="userSpaceOnUse" :x="-plotW" :y="-plotH" :width="plotW * 3" :height="plotH * 3">
            <rect :x="-plotW" :y="-plotH" :width="plotW * 3" :height="plotH * 3" fill="#fff" />
            <rect v-for="(b, i) in labBoxes" :key="'m' + i" :transform="b.xf"
              :x="-b.w / 2" :y="-b.h / 2" :width="b.w" :height="b.h" fill="#000" />
          </mask>
        </defs>
        <g v-if="ready" :clip-path="`url(#${clipId})`" :class="{ 'sf-onmap': basemap }">
          <g :mask="`url(#${maskId})`">
            <g :transform="xfAttr">
              <!-- 压在场上时每条线取它自己那一档的色（明度朝有余量的那侧推开，见 shiftInk）：
                   线因此是彩色的、且必然与它两侧的填充拉得开，不必再镶白边黑边 -->
              <path v-for="c in contours" :key="'c' + c.lv"
                :class="['sf-iso', c.crit ? 'sf-iso-crit' : '', c.minor ? 'sf-iso-minor' : '']"
                :d="c.d" :style="c.color ? { stroke: c.color } : null" vector-effect="non-scaling-stroke" />
            </g>
          </g>
          <!-- 等值线数值标注：顺着线摆（数字属于哪条线不言自明），线在此处已被 mask 断开。
               不进上面那层：跟着缩放会被拉扁，故只把落点过一遍变换 -->
          <template v-for="c in contours" :key="'l' + c.lv">
            <text v-for="(l, i) in c.labs" :key="'l' + c.lv + '_' + i" class="sf-isolab" :class="{ on: c.crit, minor: c.minor }"
              :style="c.labColor ? { fill: c.labColor } : null"
              :transform="`translate(${labPos(l.x, l.y)[0].toFixed(1)},${labPos(l.x, l.y)[1].toFixed(1)}) rotate(${l.a.toFixed(1)})`"
              :y="fs * 0.34">{{ c.text }}</text>
          </template>
        </g>

        <!-- 绘图区外框（四边闭合，MATLAB box on 的读图习惯） -->
        <rect class="sf-box" x="0" y="0" :width="plotW" :height="plotH" />

        <!-- 刻度：向内短线 -->
        <g v-for="t in xTicks.ticks" :key="'xt' + t">
          <template v-if="t >= Math.min(...xDomain) && t <= Math.max(...xDomain)">
            <line class="sf-tick" :x1="X(t)" :y1="plotH" :x2="X(t)" :y2="plotH - fs * 0.35" />
            <line class="sf-tick" :x1="X(t)" :y1="0" :x2="X(t)" :y2="fs * 0.35" />
            <text class="sf-xt" :x="X(t)" :y="plotH + fs * 1.15">{{ fmtTick(t, xTicks.step) }}</text>
          </template>
        </g>
        <g v-for="t in yTicks.ticks" :key="'yt' + t">
          <template v-if="t >= Math.min(...yDomain) && t <= Math.max(...yDomain)">
            <line class="sf-tick" :x1="0" :y1="Y(t)" :x2="fs * 0.35" :y2="Y(t)" />
            <line class="sf-tick" :x1="plotW" :y1="Y(t)" :x2="plotW - fs * 0.35" :y2="Y(t)" />
            <text class="sf-yt" :x="-fs * 0.45" :y="Y(t) + fs * 0.35">{{ fmtTick(t, yTicks.step) }}</text>
          </template>
        </g>

        <!-- 当前链路的工作点：一个小十字。它只需说明「这条链路落在这里」，不是图上的主角，
             大了反而盖住底下的场与等值线（早先的十字带一圈环、臂长近一个字高，太抢）。
             压在场上时墨色随脚下那一档的明暗翻（见 markInk），故不再铺衬底那一圈白边 -->
        <g v-if="markPx" class="sf-mark" :class="{ onmap: basemap }">
          <g class="sf-markink">
            <line :style="markInk ? { stroke: markInk } : null"
              :x1="markPx.x - fs * 0.42" :y1="markPx.y" :x2="markPx.x + fs * 0.42" :y2="markPx.y" />
            <line :style="markInk ? { stroke: markInk } : null"
              :x1="markPx.x" :y1="markPx.y - fs * 0.42" :x2="markPx.x" :y2="markPx.y + fs * 0.42" />
          </g>
        </g>

        <!-- 场恒定：明说这件事，而不是把浮点尾巴渲染成一片看似有结构的花纹。
             排在工作点之后，标记压不住说明文字 -->
        <template v-if="flat">
          <text class="sf-flat" :x="plotW / 2" :y="plotH / 2 - fs * 0.4">
            {{ flatText }}
          </text>
          <text class="sf-flat sf-flat-sub" :x="plotW / 2" :y="plotH / 2 + fs * 1.2">
            {{ t('该量多由当前计算方式约束为定值 · 可改选随两轴变化的量或更换轴') }}
          </text>
        </template>

        <!-- 悬停游标 -->
        <g v-if="hover && !drag" class="sf-cur">
          <line :x1="hover.px" :y1="0" :x2="hover.px" :y2="plotH" />
          <line :x1="0" :y1="hover.py" :x2="plotW" :y2="hover.py" />
        </g>

        <!-- 轴名（紧贴刻度：这张图长在文档栏里，省下的边距全给数据）。
             落点与边距同源（xAxlY / mL - 字冠），改一处两边一起动，不会再有「边距留了 4.4em、
             轴名却按 0.8em 摆」这种各说各话的死量 -->
        <text class="sf-axl" :x="plotW / 2" :y="plotH + xAxlY">{{ xLabel }}<tspan v-if="xUnit" :dx="fs * 0.3">/ {{ xUnit }}</tspan></text>
        <text class="sf-axl" :transform="`translate(${-mL + fs * (ROT_ASC + EDGE)},${plotH / 2}) rotate(-90)`">{{ yLabel }}<tspan v-if="yUnit" :dx="fs * 0.3">/ {{ yUnit }}</tspan></text>
      </g>

      <!-- 色标条（场恒定时不画：一把量程只有浮点尾巴的尺子只会误导） -->
      <g v-if="ready && !flat" :transform="`translate(${mL + plotW + fs * BAR_GAP},${mT})`">
        <defs>
          <linearGradient :id="gradId" x1="0" y1="1" x2="0" y2="0">
            <stop v-for="s in barStops" :key="s.t" :offset="(s.t * 100).toFixed(1) + '%'" :stop-color="s.css" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" :width="barW" :height="plotH" :fill="`url(#${gradId})`" />
        <rect class="sf-box" x="0" y="0" :width="barW" :height="plotH" />
        <g v-for="t in barTicks" :key="'bt' + t.v">
          <line class="sf-tick" :x1="barW" :y1="t.y" :x2="barW + fs * 0.3" :y2="t.y" />
          <text class="sf-bt" :x="barTextX" :y="t.y + fs * 0.35">{{ t.text }}</text>
        </g>
        <!-- 端点箭头：真实极值越过了色标域时画出，明示这一端是「裁到端点色」
             而不是「数据到此为止」——否则读者会把 −20 dB 的端点当成全场最差值 -->
        <path v-if="zClipped.hi" class="sf-barext" :d="`M0,0 L${barW},0 L${barW / 2},${-fs * 0.6} Z`" :fill="scale.cssAt(zDomain[1])" />
        <path v-if="zClipped.lo" class="sf-barext" :d="`M0,${plotH} L${barW},${plotH} L${barW / 2},${plotH + fs * 0.6} Z`" :fill="scale.cssAt(zDomain[0])" />
        <!-- 临界值在色标上的位置：读者一眼知道中性色对应的是哪个数 -->
        <line v-if="critBarY !== null" class="sf-barcrit" :x1="-1" :y1="critBarY" :x2="barW + 1" :y2="critBarY" />
        <text class="sf-bl" :transform="`translate(${barLabX},${plotH / 2}) rotate(-90)`">{{ zLabel }}<tspan v-if="zUnit" :dx="fs * 0.3">/ {{ zUnit }}</tspan></text>

        <!-- 交互层（出图时整组剔除，见 exportSvgString：报告里的色标只是图例，没有可拖这回事）。
             热区比条本身宽一圈（条只有 1.15 em，照条宽给热区抓不住），两端各一个把手。
             把手常驻但极淡：不画的话读者根本不知道这里可以拖；画重了，一张以场为主角的图上
             又多出两道与数据无关的墨。手动钉住之后加深一档——那是「这把尺子是你自己定的」
             唯一的提示，不另起一行文字（这张图上不放结论性文字，见 lb-pure-numeric）。 -->
        <g class="sf-barui" :class="[barCursor, { on: !!zManual }]">
          <title>{{ t('拖动两端设定色标上下限 · 拖动条身整体平移 · 双击恢复自动') }}</title>
          <rect class="sf-barhit" :x="-fs * 0.4" :y="-fs * 0.55" :width="barW + fs * 0.8" :height="plotH + fs * 1.1"
            @mousedown="onBarDown" @mousemove="onBarHover" @mouseleave="barHot = ''" @dblclick="onBarDbl" />
          <g class="sf-barthumb" :class="{ hot: (barDrag ? barDrag.mode : barHot) === 'hi' }">
            <line :x1="-fs * 0.3" :y1="0" :x2="barW + fs * 0.3" :y2="0" />
          </g>
          <g class="sf-barthumb" :class="{ hot: (barDrag ? barDrag.mode : barHot) === 'lo' }">
            <line :x1="-fs * 0.3" :y1="plotH" :x2="barW + fs * 0.3" :y2="plotH" />
          </g>
        </g>
      </g>
    </svg>

    <!-- 三层画布：绝对定位盖在绘图矩形上（与 SVG 同一坐标；SVG 居中时补上那段留白）。
         外层裁在图框内——场被搬运时会探出框外 -->
    <div class="sf-stage" :style="{ left: (offX + mL) + 'px', top: mT + 'px', width: plotW + 'px', height: plotH + 'px' }">
      <canvas v-show="basemap" ref="baseEl" class="sf-lay"></canvas>
      <canvas ref="fieldEl" class="sf-lay" :style="xfStyle"></canvas>
      <canvas v-show="basemap" ref="lineEl" class="sf-lay"></canvas>
    </div>

    <!-- 读数行：三值同排（x, y, 场值）。不悬停时留空——高度由 min-height 占住，不跳行 -->
    <div class="sf-foot">
      <template v-if="hover">
        <span class="sf-rd">{{ xLabel }} = {{ fmtVal(hover.x) }}<i v-if="xUnit"> {{ xUnit }}</i></span>
        <span class="sf-rd">{{ yLabel }} = {{ fmtVal(hover.y) }}<i v-if="yUnit"> {{ yUnit }}</i></span>
        <span class="sf-rd sf-rd-z">{{ zLabel }} = {{ fmtVal(hover.z) }}<i v-if="zUnit"> {{ zUnit }}</i></span>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 屏上跟界面走无衬线；导出那一份在 toSVG() 里显式写 DOC_FONT_STACK */
.sf { position: relative; font-family: var(--font-ui); font-size: var(--lb-fs, 11px); min-width: 0; }
/* 宽度取 width 属性（= 图框 + 四周留白），而非拉满容器：地理图锁比例时图框会比容器窄，
   margin auto 把它连同色标条一起居中，而不是甩在左边 */
/* touch-action 只在可导航时关掉：不可导航的图（环境图）要让触屏照常翻页 */
.sf-svg { display: block; margin: 0 auto; position: relative; z-index: 1; user-select: none; }
.sf-svg.nav { touch-action: none; }
.sf-svg.grab { cursor: grab; }
.sf-svg.grabbing { cursor: grabbing; }
.sf-svg text { font-size: var(--lb-fs, 11px); }
/* 三层画布在 SVG 之下：SVG 除绘图矩形外都是透明的，等值线与刻度自然压在场上面。
   overflow:hidden 是必须的——等新扫描期间场会被搬到框外去 */
.sf-stage { position: absolute; z-index: 0; overflow: hidden; pointer-events: none; }
.sf-lay { position: absolute; left: 0; top: 0; transform-origin: 0 0; }

/* 外框与刻度：发丝墨线，退到数据后面 */
.sf-box { fill: none; stroke: var(--lb-rule); stroke-width: 1; }
.sf-tick { stroke: var(--lb-rule); stroke-width: 1; }
.sf-xt { fill: var(--text-faint); text-anchor: middle; font-variant-numeric: tabular-nums; }
.sf-yt, .sf-bt { fill: var(--text-faint); text-anchor: end; font-variant-numeric: tabular-nums; }
.sf-bt { text-anchor: start; }
.sf-axl, .sf-bl { fill: var(--text-muted); text-anchor: middle; }

/* 等值线：半透明墨线，压在彩色场上仍读得出、又不与数据抢注意力 */
.sf-iso { fill: none; stroke: color-mix(in srgb, var(--text) 55%, transparent); stroke-width: 1; }
.sf-iso-crit { stroke: color-mix(in srgb, var(--text) 88%, transparent); stroke-width: 1.8; }
/* 局部加密出来的电平（见 contourLevels）：轻一档，读者一眼分得出「全域骨架」与
   「这一带补的细节」——不然线一密，「线密 = 坡陡」这条读图直觉就被搅了 */
.sf-iso-minor { stroke: color-mix(in srgb, var(--text) 34%, transparent); stroke-width: 0.7; }
/* 等值线数值：字顺着线走，线在字处已被 mask 断开（同 MATLAB clabel 的读法）。
   仍留一圈细描边——数字底下除了自己那条线，还压着岸线、别的电平与场本身 */
.sf-isolab {
  fill: var(--text); text-anchor: middle; font-size: calc(var(--lb-fs, 11px) - 1px);
  paint-order: stroke; stroke: var(--bg); stroke-width: 2.4px; stroke-linejoin: round;
  font-variant-numeric: tabular-nums; font-weight: 600;
}
.sf-isolab.on { font-weight: 700; }
.sf-isolab.minor { font-size: calc(var(--lb-fs, 11px) - 2px); font-weight: 600; }

/* —— 压在地图与 Turbo 场上时：一律**纯色细线，不带任何衬底** ——
   线宽一律乘 --sf-k（= lwK，与 canvas 那边同一条曲线），字号调大时两边一起变粗。

   等值线与地物线（岸线 / 国界）要分开，但**分开的办法不是加粗加深，不是换线型，
   也不是靠一层相反色的衬底去压过对方**。走过四版弯路：
   ① 三者全是深灰实线、墨色 24/61/95、线宽 1.25/1.15/0.95——粗细只差 0.1~0.3 px，
      在 dpr=1 上量化后完全相等，国界看着与等值线一模一样；
   ② 等值线加粗到 1.5px、白衬底铺到 3px 去「压过」地物线——每条黑线都镶着一圈白边，
      线比场还抢眼；③ 国界改点划线，在三四百像素宽的图上成了满屏碎点；
   ④ 反相（等值线深墨 + 浅衬底 / 地物线浅芯 + 暗衬底）——层级是分开了，但两套衬底
      仍是两倍的墨，整幅仍旧是「线的图」而不是「场的图」。
   现在靠**颜色语言**：地物线一律无彩（近白，见 lbBasemap 的 MAP_*），等值线一律取
   它那一档在色标上的颜色、只把明度朝有余量的一侧推开（见 lbColorScale 的 shiftInk，
   色由 contours 逐条算好写进 style，故这里不写 stroke）。灰的是地图、带色的是数据，
   一眼分得开，不必比线宽也不必比墨色；而每条等值线的色相直接告诉读者它落在色标的
   哪一段。于是两套线都能一路轻下去（0.8px / 半透明），版面全让给场——
   这张图的主角本就是场。数值标注同色但推得更开（笔画细，要拉得更狠才读得清）。 */
.sf-onmap .sf-iso { stroke-width: calc(0.8px * var(--sf-k, 1)); stroke-opacity: 0.82; }
.sf-onmap .sf-iso-crit { stroke-width: calc(1.3px * var(--sf-k, 1)); stroke-opacity: 1; }
/* 加密线与骨架的分野走**透明度**，不走线宽：0.8 vs 0.55 px 在 dpr=1 上量化后一样粗
   （这条弯路在地物线那边已经走过一次），而 α 不受像素量化影响 */
.sf-onmap .sf-iso-minor { stroke-width: calc(0.6px * var(--sf-k, 1)); stroke-opacity: 0.5; }
/* 标注不再描边：颜色本身已保证与它脚下那一档拉得开（同一色相、明度推开一档），
   白描边只会在彩色场上留一串白斑——这正是上一版「臃肿」的来源 */
.sf-onmap .sf-isolab { stroke: none; font-weight: 700; }
.sf-onmap .sf-isolab.minor { font-weight: 600; }
/* 恒定场的说明：压在空场中央，底色描边保证任何填充色上都读得清 */
.sf-flat {
  fill: var(--text); text-anchor: middle; font-weight: 700;
  paint-order: stroke; stroke: var(--bg); stroke-width: 4px; stroke-linejoin: round;
}
.sf-flat-sub { fill: var(--text-muted); font-weight: 400; font-size: calc(var(--lb-fs, 11px) - 1px); }

.sf-mark line { stroke: var(--text); stroke-width: 1.3; }
/* 地图上：墨色由 markInk 逐次算（脚下深就用浅墨、浅就用深墨），故这里不写 stroke */
.sf-mark.onmap .sf-markink line { stroke-width: calc(1.4px * var(--sf-k, 1)); }
.sf-cur line { stroke: color-mix(in srgb, var(--text) 45%, transparent); stroke-width: 1; stroke-dasharray: 3 3; }
.sf-barcrit { stroke: var(--text); stroke-width: 1.4; }
.sf-barext { stroke: var(--lb-rule); stroke-width: 1; }

/* 色标条的交互层：热区透明（fill:none 不吃指针事件，必须给 transparent），
   把手是两道细横线。常驻但淡到 0.32——它是控件不是数据，抢不过场也丢不掉。 */
.sf-barhit { fill: transparent; }
.sf-barui.z-ns .sf-barhit { cursor: ns-resize; }
.sf-barui.z-grab .sf-barhit { cursor: grab; }
.sf-barui.z-grabbing .sf-barhit { cursor: grabbing; }
/* 把手不吃事件：热区是唯一的入口，免得指针在把手与热区之间来回切换时光标闪 */
.sf-barthumb { pointer-events: none; }
.sf-barthumb line {
  stroke: var(--text); stroke-width: 2; stroke-linecap: round; stroke-opacity: 0.32;
  transition: stroke-opacity .12s;
}
/* 手动钉住了色标域：两端一起加深，读者一眼知道这把尺子不再是自动的那把 */
.sf-barui.on .sf-barthumb line { stroke-opacity: 0.72; }
.sf-barthumb.hot line { stroke-opacity: 0.95; }

.sf-foot {
  display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
  min-height: calc(var(--lb-fs, 11px) + 8px); padding: 4px 2px 0;
  font-size: calc(var(--lb-fs, 11px) - 1px);
}
.sf-rd { color: var(--text); font-variant-numeric: tabular-nums; }
.sf-rd i { font-style: normal; color: var(--text-faint); }
.sf-rd-z { font-weight: 700; }
</style>
