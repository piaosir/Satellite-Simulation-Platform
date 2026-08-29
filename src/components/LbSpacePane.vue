<script setup>
// 地理场图面板（GSO / NGSO / 再生式三窗共用）：两根轴逐格重跑引擎，交给 LbSurfacePlot 出场图。
//
// 轴不让用户任意挑，钉死在「站址经纬度」这一组——链路预算里真正值得铺成平面的就是它：
// 横纵轴 = 站址经纬度（发信站或收信站二选一），底图叠 110m 世界地图，回答「这条链路搬到
// 哪儿还成立」；场限与站址真有关系的量（雨、仰角、几何、余量）。站址联动强制打开：不重查
// 每格的降雨率与海拔，画出来的就不是地理场而是一片斜坡。
//
// 曾并排的「环境场图」（可用度 × 降雨率）已删：那两根轴上的雨衰、可用度、余量，左边三线表
// 逐行都列着，图上只是把同一份数换个形状。它腾出的位置改放链路视图（见 LbLinkPane）——
// 几何才是表里表达不出来的东西。
//
// 场变量池取自主进程的可绘输出量清单（core/utils/lbOutputDefs.js，带物理临界值与按端归属
// 声明）：清单里 geoField 标了的就是本图的候选，再按 geoSide 掐掉与本次扫描无关的那一端
// ——扫发信站时下行传播的每一项都逐格同值，列出来只是让人白点一遍。分组与次序照抄清单，
// 于是「哪个量属于哪一段链路」在表、图、清单三处是同一口径。
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import LbSurfacePlot from './LbSurfacePlot.vue'
import { lbDocT, lbZName } from '../shared/lbDocI18n.js'
import { satForSide } from '../shared/lbLinkScene.js'
import { isFlatSpan } from '../shared/lbPlotScale.js'

const props = defineProps({
  engine: { type: String, default: 'geo' },
  params: { type: Object, default: null },
  // 主进程二维扫描通道：spec => Promise<{xs, ys, nx, ny, series, ...}>
  // （还会带 feas/feasMeta 可行裕度，本图不取：够不够看等值线上的数值即可，不再叠判定层）
  sweep2D: { type: Function, default: null },
  outputDefs: { type: Function, default: null },
  storeKey: { type: String, default: 'lb' },
  // 报表语言（功能区「语言」）：本图与详细预算的表同属一份文档，一起换语言。
  // 界面语汇走 shared/lbDocI18n.js，场变量名走清单自带的 labelEn。
  lang: { type: String, default: 'zh' },
  unavailable: { type: String, default: '' },
  // 锁定扫哪一端的站址（'tx' | 'rx'）。留空 = 由用户在控制条上二选一。
  // 再生式上下行各只有一个真站（另一端的站址字段是引擎用的镜像，见 regenParams），
  // 让人去选「发信还是收信」只会选出一个物理上不存在的扫法。
  fixedSite: { type: String, default: '' },
  // 链路场景描述子（shared/lbLinkScene.js 产出，与链路视图同一份）：这里只取被扫那一端
  // 连的那颗星的位置，用作覆盖门——站挪到卫星地平线以下就没有链路，图上留白。
  scene: { type: Object, default: null },
  // 覆盖门与方向图联动的其余料，由各窗按自己的匹配状态给：
  //   { minElev: { tx, rx },                     两端最低工作仰角（°），覆盖圈的边界
  //     pattern: { tx: {...}|null, rx: {...} } } 已匹配的 GRD 天线（每项 {key,file,sat,cfg}）
  // 有方向图时，卫星 EIRP / G·T 逐格重采（站挪一格就换一个离轴角），网格域外/波束背面同样留白。
  geoLink: { type: Object, default: null },
  plotHeight: { type: Number, default: 320 }
})
const t = computed(() => lbDocT(props.lang))

// 网格档位：逐格一次完整引擎调用（「功带平衡」还含二分求解）。
// 实测 GEO：设置余量 0.05 ms/格、功带平衡 1.2 ms/格 → 41×41 分别约 0.1 s 与 2 s。
const RES = [
  { n: 21, label: '粗 21×21' },
  { n: 31, label: '中 31×31' },
  { n: 41, label: '细 41×41' }
]

// 等值线的档位密度（= 骨架电平数，图上实际线数还会按数据疏密局部加密，见 lbContour 的
// contourLevels）。原先固定 8：一张图上合适的线数随场的形状、图框大小与读图目的变化——
// 看高低趋势时 5 条即足够清晰，要在主瓣里量出零点几 dB 时 8 条尚不足。
// 固定取值只能折中，故开放为可调项（用户 2026-07-26：「画线密度改为可调整」）。
const DENSITY = [
  { n: 5, label: '疏' },
  { n: 8, label: '中' },
  { n: 12, label: '密' },
  { n: 16, label: '很密' }
]
// 地物线（岸线 / 国界）的浓淡倍率：α 与线宽同乘一个数（见 LbSurfacePlot 的 mapInk）。
// 1 = 定标值。给旋钮的缘由同上：找站落在哪个国家时要它压得住，只看场的形状时又嫌它吵。
const MAPINK = [
  { k: 0.7, label: '淡' },
  { k: 1, label: '中' },
  { k: 1.35, label: '浓' }
]

// 默认场 = 下行雨衰（收信站侧）：链路搬到别处最先失效的就是这一项，故作为进图第一眼。
// 扫发信站时它属对端、不在场列表里，退到 ALT_Z（链路余量）。
const DEF_Z = 'downlinkRainAttenuationResult'
const ALT_Z = 'linkmargin'
// 视图限位：整幅世界地图。缩到刚好一整幅即为下界，亦不可拖出边界——世界之外没有站址可扫，
// 再缩只是把图面摊小、四周围一圈重复的地图与空网格。
const WORLD = { x0: -180, x1: 180, y0: -90, y1: 90 }

// —— 轴 ——
// 站址二选一（轴键随之切换）；上层锁定时以锁定值为准，控制条上不再出现这一项。
// 默认收信站：下行段是余量的常见瓶颈，与默认场（下行雨衰）同侧。
const siteSel = ref(load('site', 'rx'))
const locked = computed(() => (props.fixedSite === 'tx' || props.fixedSite === 'rx'))
const site = computed(() => (locked.value ? props.fixedSite : siteSel.value))
// 轴名同时是图上的轴标注与导出 CSV 的表头，故在这里就按报表语言定好
const axes = computed(() => {
  const tr = t.value, rx = site.value === 'rx'
  return {
    x: { key: rx ? 'rxLongitude' : 'longitude', target: 'link', label: tr((rx ? '收信站' : '发信站') + '经度'), unit: '°E' },
    y: { key: rx ? 'rxLatitude' : 'latitude', target: 'link', label: tr((rx ? '收信站' : '发信站') + '纬度'), unit: '°N' }
  }
})

const xMin = ref(''), xMax = ref(''), yMin = ref(''), yMax = ref('')
const res = ref(load('res', 21))
const levelCount = ref(load('levels', 5))
const mapInk = ref(load('mapink', 1.35))

// 默认区间：当前站址周围一个**正方**窗口（整幅世界地图上一条链路只是一个点，铺满全球既慢
// 又看不出名堂）。两轴同跨 100°——图框的形状由经纬跨度锁死（1°经 = 1°纬，见 LbSurfacePlot
// 的 plotBox），窗口取多方图就有多方：旧版 144°×60° 出来是一条 2.4:1 的横带，同样的栏宽只
// 换来一半多点的图面，纬向还看不全一颗 GEO 的可视范围。100° 横向仍是半个东半球，纵向从
// 南回归线一路到高纬，正好是一条链路「搬到哪儿还成立」问得到的地方。
// 顶到世界边界时**整体推回界内、跨度不变**（旧版在此把跨度剪短，一到边图就被压扁成横带）。
const HALF = 50
function windowAt(c, lo, hi) {
  const s = Math.min(2 * HALF, hi - lo)
  let a = c - s / 2
  if (a < lo) a = lo
  if (a + s > hi) a = hi - s
  return [a, a + s]
}
function defaultRange() {
  const rx = site.value === 'rx'
  const lon = parseFloat(curValue(rx ? 'rxLongitude' : 'longitude'))
  const lat = parseFloat(curValue(rx ? 'rxLatitude' : 'latitude'))
  const or = (v, d) => (Number.isFinite(v) ? v : d)
  // 纬向不取到极点：±80 之外只有冰盖，没有站址可扫，留着只会把图面摊薄
  return { x: windowAt(or(lon, 116), -180, 180), y: windowAt(or(lat, 40), -80, 80) }
}
function resetRange() {
  const d = defaultRange()
  xMin.value = fmt(d.x[0]); xMax.value = fmt(d.x[1])
  yMin.value = fmt(d.y[0]); yMax.value = fmt(d.y[1])
}
// 定小数位后再回到数字去尾零：直接对字符串剪 /\.?0+$/ 会把 "0.000" 剪成空串
function fmt(n) {
  if (!Number.isFinite(+n)) return ''
  const a = Math.abs(+n)
  return String(parseFloat((+n).toFixed(a >= 100 ? 0 : a >= 1 ? 2 : 3)))
}
// 换站 → 区间跟着回到新站周围（留着上一个站的窗口，图上就看不见新站了）
watch(site, () => { resetRange(); if (!locked.value) save('site', siteSel.value) })

// —— 场变量 ——
const outGroups = shallowRef([])
const outIndex = computed(() => {
  const m = {}
  for (const g of outGroups.value) for (const it of g.items) m[it.key] = it
  return m
})
// 本次扫描可选的场，按清单原有分组给出（组内次序即清单次序）。三重筛：
//   geoField   清单里策展过的「值得铺在站址平面上画」的量（中间量与同形重复量不列）
//   geoSide    'both'/'either' 始终可选；'tx'/'rx' 只在扫那一端时出现——对端专属的量
//              （如扫发信站时的下行雨衰）在这次扫描里逐格同值，列出来是纯噪声
//   availKeys  本体制引擎压根没有的键（再生式没有转发器量等）整条不列
// 恒定的量不再整条剔除，只在选项后缀「· 恒定」：一声不响地拿掉，用户看到的是「链路余量
// 怎么没了」；留着并标出来，看到的才是「这条链路的余量本就不随站址变」——后者才是答案。
const zGroups = computed(() => {
  const side = site.value, avail = availKeys.value
  const out = []
  for (const g of outGroups.value) {
    const items = (g.items || []).filter((it) => it.geoField
      && (it.geoSide === 'both' || it.geoSide === 'either' || it.geoSide === side)
      && (!avail || avail.has(it.key)))
    if (items.length) out.push({ key: g.key, title: g.title, titleEn: g.titleEn, items })
  }
  return out
})
const zOptions = computed(() => zGroups.value.flatMap((g) => g.items))
// 分组名按报表语言取（清单自带 titleEn）
const zGroupName = (g) => (props.lang === 'en' ? (g.titleEn || g.title) : g.title)
const zKey = ref(load('z', ''))
watch(outGroups, () => {
  if (!outGroups.value.length) return
  const it = outIndex.value[zKey.value]
  if (it && it.geoField) return       // 存的选择仍是本图画得出的量（是否属本端交给下方 zOptions 的兜底）
  zKey.value = DEF_Z
}, { immediate: true })
const zDef = computed(() => outIndex.value[zKey.value] || { label: zKey.value, unit: '' })
// 场变量名按报表语言取（清单自带 labelEn，见 core/utils/lbOutputDefs.js）
const zName = (it) => lbZName(it, props.lang)
const zLabel = computed(() => zName(zDef.value))
// 本次扫描实际给出的键（主进程把全场为 NaN 的量整条剔掉了，故这就是「本体制有没有这个量」）。
// 一格都没算成（整片区间都在覆盖外）时不作数：那说明不了引擎有没有这个量，据此剔选项，
// 只会在用户把图拖到地球背面时顺手把他选好的场换掉，拖回来也回不去了。
const availKeys = computed(() => (result.value && result.value.ok ? new Set(Object.keys(result.value.series)) : null))
// 本次扫描中全场不变的量。判据见 shared/lbPlotScale.js 的 isFlatSpan——按该量自己的显示
// 步长定，不按相对变化：dB 与 K 的零点都是人定的，同一把相对尺量出来的结论互相打架
//（0.2 的起伏落在 13 dB 上算「变了」，落在 140 K 上就成了「没变」）。与图内是否画等值线同一判据。
const flatKeys = computed(() => {
  const r = result.value
  const s = new Set()
  if (!r) return s
  for (const [k, arr] of Object.entries(r.series)) {
    let lo = Infinity, hi = -Infinity
    for (let t = 0; t < arr.length; t++) { const v = arr[t]; if (v !== v) continue; if (v < lo) lo = v; if (v > hi) hi = v }
    if (lo === Infinity) continue
    if (isFlatSpan(lo, hi, (outIndex.value[k] || {}).unit)) s.add(k)
  }
  return s
})

// —— 扫描 ——
const result = shallowRef(null)     // 网格是 Float64Array，不要进深响应式（几千个数逐个建代理纯属烧 CPU）
const running = ref(false)
const errMsg = ref('')
// 「已排上队但还没开跑」：入参刚变、正等那 400 ms 防抖的这段时间里 running 仍是 false，而
// 图上画的还是上一条链路的场。批量出图（报告导出逐条取图）必须能分辨这一刻，否则取到的是前一条的图。
const pending = ref(false)
let _t = null, _seq = 0
function schedule() { pending.value = true; clearTimeout(_t); _t = setTimeout(run, 400) }

// 入参过 IPC 前先脱掉 Vue 的响应式外衣：留底的引擎入参存在 ref 里，取出来是 reactive
// Proxy，而结构化克隆不认 Proxy（会以「An object could not be cloned.」告败）
function plain(v) {
  try { return JSON.parse(JSON.stringify(v === undefined ? null : v)) } catch (e) { return null }
}
const curValue = (key) => {
  const p = props.params
  return p ? ((p.linkParams || {})[key]) : null
}

// 送进扫描的「卫星关联」：星位取自链路视图那份场景（三窗归一，见 lbLinkScene.satForSide），
// 仰角门限与已匹配的方向图由各窗给。星位取不到（如手动圆轨道：方位是示意的）就只剩方向图
// 那一重门——宁可不画覆盖圈，也不照着一个编出来的方位画。
const geoSpec = computed(() => {
  const g = props.geoLink || {}
  const sat = satForSide(props.scene, site.value)
  if (!sat && !((g.pattern || {})[site.value])) return null
  return { sat, minElev: g.minElev || {}, pattern: g.pattern || {} }
})

async function run() {
  clearTimeout(_t)
  if (props.unavailable || !props.sweep2D || !props.params) { result.value = null; pending.value = false; return }
  const ax = axes.value
  const x0 = parseFloat(xMin.value), x1 = parseFloat(xMax.value)
  const y0 = parseFloat(yMin.value), y1 = parseFloat(yMax.value)
  if (!(x1 > x0) || !(y1 > y0)) { errMsg.value = '区间无效（上限须大于下限）'; pending.value = false; return }
  const seq = ++_seq
  running.value = true
  try {
    const r = await props.sweep2D({
      engine: props.engine,
      satParams: plain(props.params.satParams),
      linkParams: plain(props.params.linkParams),
      opt: plain(props.params.opt) || { mode: 'margin' },
      x: { key: ax.x.key, target: ax.x.target, min: x0, max: x1, steps: res.value },
      y: { key: ax.y.key, target: ax.y.target, min: y0, max: y1, steps: res.value },
      autoGeo: true,                      // 站址联动：逐格重查降雨率与海拔，否则画出来不是地理场
      geo: plain(geoSpec.value)           // 覆盖门 + 方向图联动（见 geoSpec / core 的 spec.geo）
      // 工作点恒定钉在当前链路上，由 core 的 sweepLink2D 一律施加，不经此处传参
    })
    if (seq !== _seq) return                  // 已有更新的一次扫描在跑，丢弃这次的结果
    result.value = (r && r.nx > 1) ? r : null
    errMsg.value = (r && r.message) || ''
  } catch (e) {
    if (seq !== _seq) return
    result.value = null
    errMsg.value = (e && e.message) ? e.message : '扫描失败'
  } finally { if (seq === _seq) { running.value = false; pending.value = false } }
}
// 星位/方向图匹配变了，覆盖圈跟着变 → 与入参同等对待，一起触发重扫
watch([() => props.params, () => props.scene, () => props.geoLink], schedule, { deep: true })
watch([xMin, xMax, yMin, yMax, res, site, () => props.engine], schedule)
// 选中的量不在本次的列表里了（换了扫描端 → 它属对端；或换了体制 → 引擎没有这个量）
// → 换到还在列表里的量（优先默认量），不然下拉显示空白。恒定不再是剔除的理由，故这里
// 只管「真的没有这一项」。挂在这里而不是 zOptions 定义处：watch 会立刻求一次值，
// 而 zOptions → availKeys → result 的链条要等 result 声明之后才算得动。
watch(zOptions, (opts) => {
  if (!opts.length || opts.some((o) => o.key === zKey.value)) return
  zKey.value = (opts.find((o) => o.key === DEF_Z) || opts.find((o) => o.key === ALT_Z) || opts[0]).key
})

// —— 图面数据 ——
const field = computed(() => {
  const r = result.value
  if (!r) return null
  return r.series[zKey.value] || null
})
// 整片区间都在覆盖外：一个格都没算成，series 里的键被主进程整条剔干净了（全 NaN 的量不留）
const allMasked = computed(() => {
  const r = result.value
  return !!(r && r.masked && !r.ok)
})
// 当前链路在图上的落点
const markX = computed(() => {
  const n = parseFloat(curValue(axes.value.x.key))
  return Number.isFinite(n) ? n : null
})
const markY = computed(() => {
  const n = parseFloat(curValue(axes.value.y.key))
  return Number.isFinite(n) ? n : null
})

// 拖拽平移 / 滚轮缩放 → 把两轴区间挪到新视图并重扫（不是把已有网格放大：网格分辨率
// 有限，纯视图放大只会看到马赛克；参数化研究里「放大」的本义就是在更小的区间上重算）。
// 滚轮一次会连发好几个事件，靠 run() 那 400 ms 防抖合并成一次扫描。区间已在图内按 WORLD 限过位。
function onZoom(r) {
  xMin.value = String(+r.xMin.toFixed(4)); xMax.value = String(+r.xMax.toFixed(4))
  yMin.value = String(+r.yMin.toFixed(4)); yMax.value = String(+r.yMax.toFixed(4))
}

// —— 导出 ——
// 就地做，不上交给外层：外层还得先判断「当前是哪张图」，而按钮本来就长在图上。
const plotEl = ref(null)
const exportFile = (typeof window !== 'undefined' && window.api) ? window.api.exportFile : null
const CSS_VARS = ['--lb-fs', '--lb-serif', '--font-serif', '--text', '--text-muted', '--text-faint',
  '--lb-rule-strong', '--lb-rule', '--lb-rule-soft', '--ok', '--danger', '--accent', '--bg', '--surface']
const figName = computed(() => t.value('地理场图') + '·' + zLabel.value)

// 抓页面里与图有关的 CSS 规则：SVG 离开页面后没有外部样式表可依
function collectRules() {
  const out = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules
    try { rules = sheet.cssRules } catch (e) { continue }   // 跨源样式表读不到，跳过
    for (const r of Array.from(rules || [])) {
      if (r.selectorText && /\.sf-/.test(r.selectorText)) out.push(r.cssText)
    }
  }
  return out.join('\n')
}
// 出图 = PNG。图内部仍先拼成一份自洽的 SVG（矢量的线与字 + 位图的场），再整幅栅格化：
// 直接截屏会连页面背景与相邻元素一起截进来，而按 SVG 渲染的是这张图本身。
// 放大 4 倍出：一张与右栏同宽（~900 px）的图出来是 3600 px，报告里按整幅宽放置约合 600 dpi。
// 倍率同时传进 exportSvgString：矢量层（等值线/刻度/文字）浏览器会在 drawImage 的目标尺寸上
// 重新栅格化，本就实；位图层（底图 / 场 / 国界）没有这个待遇，必须**按倍率重画一遍**。
// 少了这一路，出的图就是把一张屏幕分辨率（dpr 1~2）的位图硬撑成 4 倍大——岸线糊成宽边，
// 正是原先「出图质量太差」的样子。
const PNG_SCALE = 4
// 出一张图 = 一个 data:image/png URL。抽出来单独一支是给「报告导出」用的：那边要把
// 每条链路的这张图收进报告模型，走的必须是与手动「出图」完全相同的一条渲染路径
// ——报告里的图和用户自己导出来的图，不该是两张不一样的图。
async function pngDataUrl(scale) {
  if (!plotEl.value) return ''
  const s = scale || PNG_SCALE
  const cs = getComputedStyle(document.documentElement)
  const bg = (cs.getPropertyValue('--bg') || '#fff').trim() || '#fff'
  // 空值的自定义属性不能写进声明：`--lb-serif:;` 会让 var(--lb-serif, 回落) 落到「空」
  // 而不是回落值（自定义属性的空值是合法值，不触发 fallback），整幅字体因此失效
  const decl = CSS_VARS.map((v) => [v, (cs.getPropertyValue(v) || '').trim()])
    .filter(([, val]) => val).map(([v, val]) => v + ':' + val).join(';') + ';background:' + bg
  let src = plotEl.value.exportSvgString(decl, s)
  if (!src) return ''
  // 离开页面就没有外部样式表可依，故把与图有关的规则内联进去
  src = src.replace(/<svg([^>]*)>/, (m, a) => `<svg${a}><style>${collectRules()}</style>`)
  const { w, h } = plotEl.value.svgSize()
  try {
    const img = new Image()
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(src)
    await img.decode()
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(w * s)); cv.height = Math.max(1, Math.round(h * s))
    const ctx = cv.getContext('2d')
    ctx.fillStyle = bg                       // PNG 不留透明底：贴进报告会露出下面的东西
    ctx.fillRect(0, 0, cv.width, cv.height)
    ctx.drawImage(img, 0, 0, cv.width, cv.height)
    return cv.toDataURL('image/png')
  } catch (e) { return '' }                  // 渲染失败：没有这张图即可，不打断上层
}
async function exportPng() {
  if (!exportFile) return
  const url = await pngDataUrl(PNG_SCALE)
  if (!url) return
  try {
    const data = new Uint8Array(await (await fetch(url)).arrayBuffer())
    await exportFile({ defaultName: figName.value + '.png', data, filters: [{ name: t.value('PNG 图片'), extensions: ['png'] }] })
  } catch (e) { /* 用户取消即可 */ }
}
async function exportCsv() {
  if (!exportFile || !plotEl.value) return
  const csv = plotEl.value.toCSV()
  if (!csv) return
  try {
    // BOM：Excel 认这个才不会把中文表头读成乱码
    await exportFile({ defaultName: figName.value + '.csv', data: new TextEncoder().encode('﻿' + csv), filters: [{ name: t.value('CSV 表格'), extensions: ['csv'] }] })
  } catch (e) { /* 用户取消即可 */ }
}

// —— 会话持久化（三窗各存各的）——
// 键里的 'geo' 是历史留下的图别（曾与「环境图」并存），沿用着，免得升级一次把用户选好的场与网格全清了
function load(k, def) {
  try { const v = JSON.parse(localStorage.getItem(props.storeKey + '/viz/geo/' + k) || 'null'); return v === null ? def : v }
  catch (e) { return def }
}
function save(k, v) { try { localStorage.setItem(props.storeKey + '/viz/geo/' + k, JSON.stringify(v)) } catch (e) { /* ignore */ } }
watch(zKey, (v) => save('z', v)); watch(res, (v) => save('res', v))
watch(levelCount, (v) => save('levels', v))
watch(mapInk, (v) => save('mapink', v))

onMounted(async () => {
  resetRange()
  if (props.outputDefs) {
    try { outGroups.value = (await props.outputDefs()) || [] } catch (e) { outGroups.value = [] }
  }
  run()
})
onBeforeUnmount(() => clearTimeout(_t))

// —— 供「报告导出」逐条链路取图（见 LbVizPane / 各窗 exportReport）——
//   flush  跳过 400 ms 防抖立刻重扫：批量取图时每条链路都白等 0.4 s 是纯浪费
//   ready  这一刻图上画的就是当前入参的场（排队中/扫描中都不算数）
//   figure 图名与图，题注在报告侧统一编号
defineExpose({
  flush: () => run(),
  ready: computed(() => !pending.value && !running.value),
  hasFigure: computed(() => !!field.value),
  figTitle: figName,
  pngDataUrl
})
</script>

<template>
  <div class="sp">
    <!-- 题行：图名 + 一句话用途 + 本图的控制项与导出 -->
    <div class="sp-hd">
      <b class="sp-name">{{ t('地理场图') }}</b>
      <span class="sp-sub">{{ t('站址经纬度') }}</span>
      <span class="sp-flex"></span>
      <button class="sp-exp" :title="t('导出网格数据为 CSV（一行一格）')" @click="exportCsv">{{ t('数据') }}</button>
      <button class="sp-exp" :title="t('导出为 PNG 图片（4 倍分辨率）')" @click="exportPng">{{ t('导出') }}</button>
    </div>

    <div class="sp-bar">
      <!-- 站址二选一（轴键随之切换）；上层锁定了就不再出现这一项 -->
      <label v-if="!locked" class="sp-f" :title="t('扫描站址所在端；另一端保持当前取值')">
        <span class="sp-l">{{ t('站') }}</span>
        <select v-model="siteSel" class="sp-sel sp-sel-s">
          <option value="tx">{{ t('发信站') }}</option>
          <option value="rx">{{ t('收信站') }}</option>
        </select>
      </label>
      <span class="sp-rng" :title="axes.x.label">
        <span class="sp-l">{{ t('经度') }}</span>
        <input v-model="xMin" class="sp-in" type="number" />
        <span class="sp-dash">–</span>
        <input v-model="xMax" class="sp-in" type="number" />
      </span>
      <span class="sp-rng" :title="axes.y.label">
        <span class="sp-l">{{ t('纬度') }}</span>
        <input v-model="yMin" class="sp-in" type="number" />
        <span class="sp-dash">–</span>
        <input v-model="yMax" class="sp-in" type="number" />
      </span>
      <label class="sp-f" :title="t('等值线所绘物理量')">
        <span class="sp-l">{{ t('场') }}</span>
        <!-- 按清单的分组分档（链路质量 / 传播 / 几何 …），组名即「这个量属于链路的哪一段」。
             与本次扫描无关的那一端整组不出现（见 zGroups）；恒定的量留着并标注，不剔除 -->
        <select v-model="zKey" class="sp-sel sp-sel-z">
          <optgroup v-for="g in zGroups" :key="g.key" :label="zGroupName(g)">
            <option v-for="it in g.items" :key="it.key" :value="it.key">
              {{ zName(it) }}{{ it.unit ? ' (' + it.unit + ')' : '' }}{{ flatKeys.has(it.key) ? t(' · 恒定') : '' }}
            </option>
          </optgroup>
        </select>
      </label>
      <label class="sp-f" :title="t('网格分辨率：逐格调用一次引擎，分辨率越高耗时越长')">
        <span class="sp-l">{{ t('网格') }}</span>
        <select v-model.number="res" class="sp-sel sp-sel-n">
          <option v-for="r in RES" :key="r.n" :value="r.n">{{ t(r.label) }}</option>
        </select>
      </label>
      <!-- 等值线密度与地物线浓淡：两项都只改画法、不重扫（网格数据一个字不动） -->
      <label class="sp-f" :title="t('等值线档位密度（仅影响绘制，不重新计算）')">
        <span class="sp-l">{{ t('线密') }}</span>
        <select v-model.number="levelCount" class="sp-sel sp-sel-t">
          <option v-for="d in DENSITY" :key="d.n" :value="d.n">{{ t(d.label) }}</option>
        </select>
      </label>
      <label class="sp-f" :title="t('岸线与国界的线条浓淡')">
        <span class="sp-l">{{ t('地图') }}</span>
        <select v-model.number="mapInk" class="sp-sel sp-sel-t">
          <option v-for="m in MAPINK" :key="m.k" :value="m.k">{{ t(m.label) }}</option>
        </select>
      </label>
      <button class="sp-exp" :title="t('回到默认区间')" @click="resetRange">{{ t('复位') }}</button>
    </div>

    <div v-if="unavailable" class="sp-ph">{{ unavailable }}</div>
    <div v-else-if="!params" class="sp-ph">{{ t('尚无计算结果') }}</div>
    <!-- errMsg 存的是中文原文，在此按语言翻；引擎抛回来的消息不在字典里，原样透出。
         整片区间都在覆盖外时一个数也算不出来，此时说「暂无扫描结果」会被当成程序出错 -->
    <div v-else-if="!field && !running" class="sp-ph">
      {{ allMasked ? t('本区间全部不在卫星覆盖内') : t(errMsg || '暂无扫描结果') }}
    </div>
    <template v-else>
      <LbSurfacePlot v-if="field" ref="plotEl"
        :xs="result.xs" :ys="result.ys" :nx="result.nx" :ny="result.ny" :z="field"
        :x-label="axes.x.label" :x-unit="axes.x.unit" :y-label="axes.y.label" :y-unit="axes.y.unit"
        :z-label="zLabel" :z-unit="zDef.unit"
        :z-crit="Number.isFinite(zDef.crit) ? zDef.crit : null" :z-good="zDef.good || 'above'"
        :mark-x="markX" :mark-y="markY" :level-count="levelCount" :map-ink="mapInk"
        basemap palette="turbo" :bounds="WORLD" navigable
        :height="plotHeight" :lang="lang"
        @zoom="onZoom" @reset="resetRange" />
      <!-- 图下只留状态：扫描中与报错。口径说明（工作点/留白缘由/方向图联动）已按要求撤掉 -->
      <div v-if="running || errMsg" class="sp-note">
        <span v-if="running" class="sp-run">{{ t('扫描中…') }} {{ res }}×{{ res }} {{ t('格') }}</span>
        <span v-if="errMsg" class="sp-err">{{ t(errMsg) }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.sp { font-family: var(--font-ui); min-width: 0; }
/* 题行：图名用三线表的小题语言（加粗 + 1px 题线） */
.sp-hd {
  display: flex; align-items: baseline; gap: 8px;
  padding: 0 1px 2px; font-size: var(--lb-fs, 11px); color: var(--text);
  border-bottom: 1px solid var(--lb-rule);
}
.sp-name { font-weight: 700; }
.sp-sub { font-size: calc(var(--lb-fs, 11px) - 1px); color: var(--text-faint); }
.sp-flex { flex: 1 1 auto; }
/* 控制条：与功能区小表单同一套控件语言（方角、细边、衬线数字） */
.sp-bar { display: flex; align-items: center; gap: 5px 9px; flex-wrap: wrap; padding: 5px 1px 6px; }
.sp-f { display: inline-flex; align-items: center; gap: 4px; }
.sp-l { font-size: var(--lb-fs, 11px); color: var(--text-muted); white-space: nowrap; }
.sp-sel, .sp-in, .sp-exp {
  font: inherit; font-size: var(--lb-fs, 11px); padding: 2px 4px;
  background-color: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px);
}
.sp-sel { cursor: pointer; max-width: 12em; }
.sp-sel-z { max-width: 13em; }
.sp-sel-n, .sp-sel-s { max-width: 8em; }
/* 线密 / 地图：选项只有一两个字，按内容收窄（撑到 8em 会在控制条上白占两格） */
.sp-sel-t { max-width: 5.6em; }
.sp-sel:focus, .sp-in:focus { outline: none; border-color: var(--accent-ui); }
.sp-in { width: 4.4em; text-align: right; font-variant-numeric: tabular-nums; }
.sp-rng { display: inline-flex; align-items: center; gap: 3px; }
.sp-dash { color: var(--text-faint); }
.sp-exp { font-size: calc(var(--lb-fs, 11px) - 1px); color: var(--text-muted); cursor: pointer; padding: 1px 6px; }
.sp-exp:hover { color: var(--text); border-color: var(--border-strong); }

.sp-ph { padding: 16px 4px; font-size: var(--lb-fs, 11px); color: var(--text-faint); text-align: center; }
.sp-note { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; font-size: calc(var(--lb-fs, 11px) - 1px); padding-top: 2px; }
.sp-run { color: var(--text-muted); }
.sp-err { color: var(--danger); }
</style>
