// 实时/预报气象场图层的状态与编排（侧栏「实时气象」视图）。
//
// 与 useEnvField.js 是姊妹件：上色、值域、图例、2D/3D 两个渲染通道**全部复用**
// （envRaster.js 原样用），所以两张图在地图上长得一模一样、读图习惯一致。
// 只有等值线是那边独有的：云图是连续场，提线读的是「档位边界」，而档位边界在分级填色里
// 本来就是硬边（见下方「云图观感」第 2 条），再压一层线属于重复表达。
// 多出来的三件事，正是「实时」与「气候」的全部差别：
//
//   ① 数据要现取。ITU 气候场是随包分发的地图，格距随便拉；这边要联网拉一个时空立方体。
//      ★ 取数模型与「按点查询的天气 API」**正好相反**，界面必须让人感觉得到：
//        请求数 = **帧数**，与格点数无关 —— 换范围、换格距、换字段一律免费，只有拉长时间轴才多花请求。
//        故这里的读数是「格数 × 帧数 / 内存 / 下载量 / 预计耗时」，不是「请求配额」。
//        （实测：东亚全境 281×161 = 45241 格，一次请求 821 KB / 2.1 s。）
//
//   ② 有时间维。帧由全局仿真时钟 clock.tMs 就近选（不插值，见 liveField.js 的说明）。
//      拖时间轴 = 逐帧重取栅格，每帧一次 IPC；故这里有在飞闸 + 尾帧补算，
//      快拖时丢中间帧但**一定会落到松手那一帧**。
//
//   ③ 衰减场依赖卫星。每一格仰角不同，故要目标星 + freq/pol，外加一个**最低仰角闸** ——
//      擦地几何下斜路径发散，一格能算出 150 dB，那个数会毁掉整条色带（见 liveField 的低仰角闸）。
//      ★ 目标星三档（GEO 轨位 / 在轨卫星 / 手动星下点）而不是一个轨位输入框：只认轨位等于整个模块
//        只对静止轨道成立。选真星时星下点按 SGP4 在**时钟时刻**解算，LEO 的衰减场就是它此刻的足迹。
//
// ── 云图观感 ──────────────────────────────────────────────────────────────
// 「像不像气象局那张图」不在配色好不好看，在三件事：低值透明、档位按业务量级、压在影像底图上。
// 前两件由 metPalette.js 的气象业务色阶 + 字段自带的 levels 锚点实现，默认就走这一档；
// 第三件是地图设置里的「影像底图」，两边一起开才是那个效果。

import { ref, reactive, computed, watch } from 'vue'
import { colorize, autoDomain, legendStops, bandEdges, valueAt, fmtValue, rasterCanvas, levelTicks } from './envRaster.js'
import { MET_SCHEMES } from './metPalette.js'
import { clock } from '../../stores/simClock.js'

const LS_KEY = 'live-field-ui'

// 取数范围预置。★ 范围**不花钱**（一次请求一整块），故档位按「读图想看多大一片」给，
// 不像按点的源那样要为每一度经纬肉疼。
const REGIONS = [
  { v: 'cn', label: '中国', bbox: { latMin: 15, latMax: 55, lonMin: 70, lonMax: 140 } },
  { v: 'ea', label: '东亚', bbox: { latMin: 10, latMax: 55, lonMin: 95, lonMax: 150 } },
  { v: 'ap', label: '亚太', bbox: { latMin: -15, latMax: 55, lonMin: 60, lonMax: 160 } },
  { v: 'eu', label: '欧洲 · 中东', bbox: { latMin: 20, latMax: 70, lonMin: -15, lonMax: 60 } },
  { v: 'glb', label: '全球', bbox: { latMin: -60, latMax: 75, lonMin: -179, lonMax: 179 } },
  { v: 'cst', label: '自定义', bbox: null },
  // Polygon：取数窗仍是它的外接矩形（子集服务只吃 bbox），但**出图裁到多边形内**。
  // 故这一档与「自定义」的差别不在取多少数，在看哪一片 —— 服务区 / 协调区的形状不是矩形。
  { v: 'poly', label: 'Polygon（地图多边形）', bbox: null }
]
// 格距 = 换数据集，不是抽稀。全球 0.25° 一帧要下 38 MB，1° 只要 2.3 MB —— 全球图跑不跑得动全看这一项。
const RES = [
  { v: 0.25, label: '0.25°（逐小时 · 区域）' },
  { v: 0.5, label: '0.5°（逐 3 h）' },
  { v: 1, label: '1°（逐 3 h · 全球）' }
]
const STEP_H = [
  { v: 1, label: '1 小时' }, { v: 3, label: '3 小时' }, { v: 6, label: '6 小时' }, { v: 12, label: '12 小时' }
]
const HOURS = [
  { v: 12, label: '未来 12 小时' }, { v: 24, label: '未来 24 小时' }, { v: 48, label: '未来 48 小时' },
  { v: 72, label: '未来 72 小时' }, { v: 120, label: '未来 5 天' }, { v: 240, label: '未来 10 天' },
  { v: 384, label: '未来 16 天（上限）' }
]
// 出图格距：在已取回的立方体上做双线性细化，纯本地计算，随便拉，不联网。
// ★ 细于 0.25° 的档是**插值**不是新信息 —— 源就是 0.25°，再细只是把格子磨平。
//   留这些档是为了消掉屏幕上的马赛克感（云图观感），不是为了更准，UI 的 title 里说清楚。
const OUT_STEPS = [
  { v: 0, label: '自动（源格距的一半）' },
  { v: 0.5, label: '0.5°' }, { v: 0.25, label: '0.25°' }, { v: 0.1, label: '0.1°' },
  { v: 0.05, label: '0.05°' }, { v: 0.02, label: '0.02°（最细）' }
]
// 衰减场逐格要跑一次 ITU 引擎，故点数上限做成显式档位：拖时间轴要跟得上，出图要够细，二者取舍。
// ★ 档位按约 √2 递进（点数 ×1.7~2，即格距 ×1.3~1.4）—— 相邻两档在屏幕上看得出差别、又不至于
//   一跳就把耗时翻三倍。原来 4 万 → 12 万那一跳跨了 3 倍，中间没有可用的落点。
const DETAILS = [
  { v: 20000, label: '2 万点' },
  { v: 40000, label: '4 万点（标准）' },
  { v: 70000, label: '7 万点' },
  { v: 120000, label: '12 万点' },
  { v: 200000, label: '20 万点' },
  { v: 360000, label: '36 万点（上限）' }
]
// 色阶两族并列：上面四档是气象业务色阶（低值透明、按业务档位），下面五档是科学色图（连续、全不透明）。
const SCHEMES = [
  ...MET_SCHEMES,
  { v: 'turbo', label: 'Turbo' }, { v: 'jet', label: 'Jet' }, { v: 'viridis', label: 'Viridis' },
  { v: 'inferno', label: 'Inferno' }, { v: 'gray', label: 'Gray' }
]
const PATH_MODELS = [
  { v: 'uniform', label: '均匀（雨层内全长）' },
  { v: 'p618', label: '统计折减（ITU-R P.618 因子）' }
]
const CLOUD_MODES = [
  { v: 'measured', label: '实测柱云水（模式输出）' },
  { v: 'p840', label: 'ITU-R P.840 统计值' },
  { v: 'none', label: '不计云衰' }
]
const MIN_ELEVS = [
  { v: 0, label: '0°（不限制）' }, { v: 5, label: '5°（ITU-R P.618 下限）' }, { v: 10, label: '10°' }, { v: 20, label: '20°' }
]

// 站点表的列定义 —— 体例与性能指标表的 COL_DEFS 一致（同一套 ExcelGrid 渲染：列宽 / 小数位 /
// 单位走表头 / 点列头排序 / 框选复制）。差别只在**可选项换成气象与链路指标**。
//   key   直接对应 samplePoints 出参的字段名
//   sat   该列依赖卫星几何（每一站仰角不同），没指定目标星就没有值
//   mul   显示前的倍数（引擎里 rh/cloud 是 0~1 分数，表上按 % 读）
const MET_COL_DEFS = [
  { key: 'name', label: '站名', w: 128 },
  { key: 'lon', label: '经度', w: 92, num: true, fix: 3, unit: '°E', tip: '东经为正，负值表示西经' },
  { key: 'lat', label: '纬度', w: 92, num: true, fix: 3, unit: '°N', tip: '北纬为正，负值表示南纬' },
  { key: 'altKm', label: '海拔', w: 72, num: true, fix: 3, unit: 'km', tip: 'ITU-R P.1511 地形高程（用于气体吸收的站点气压）' },
  { key: 'elev', label: '仰角', w: 72, num: true, fix: 2, unit: '°', sat: true, tip: '该站对该卫星的仰角；低于「最低仰角」的行仅给出仰角，不给衰减' },
  { key: 'az', label: '方位', w: 72, num: true, fix: 2, unit: '°', sat: true, tip: '自正北顺时针 0–360°' },
  { key: 'rangeKm', label: '斜距', w: 92, num: true, fix: 1, unit: 'km', sat: true, tip: '站到卫星的直线距离，按 WGS-84 椭球计算；非静止轨道目标随时间轴显著变化' },
  { key: 'totalDb', label: '合计衰减', w: 88, num: true, fix: 3, unit: 'dB', sat: true, tip: '气体 + 云 + 雨（ITU-R P.676 + P.840 + P.838）' },
  { key: 'rainDb', label: '雨衰', w: 78, num: true, fix: 3, unit: 'dB', sat: true, tip: 'ITU-R P.838，由该时刻该点雨强计算；雪 / 冰不适用时以破折号表示' },
  { key: 'cloudDb', label: '云衰', w: 78, num: true, fix: 3, unit: 'dB', sat: true, tip: 'ITU-R P.840；实测档由柱云水计算，统计档取长期分布' },
  { key: 'gasDb', label: '气体吸收', w: 84, num: true, fix: 3, unit: 'dB', sat: true, tip: 'ITU-R P.676，取该点实测 T / P / ρ' },
  { key: 'scintDb', label: '闪烁 σ', w: 78, num: true, fix: 3, unit: 'dB', sat: true, tip: 'ITU-R P.618 §2.4.1 起伏标准差，非固定衰减量' },
  { key: 'rainMmH', label: '雨强', w: 78, num: true, fix: 2, unit: 'mm/h' },
  { key: 'ptype', label: '相态', w: 62, tip: '雨 / 雪 / 冰 / 混合。雪与冰不适用 ITU-R P.838，雨衰列以破折号表示' },
  { key: 'cwat', label: '柱云水', w: 82, num: true, fix: 3, unit: 'kg/m²', tip: 'NCEP GFS 输出的柱云水，云衰实测档的输入（含冰相，偏高）' },
  { key: 'cloud', label: '云量', w: 68, num: true, fix: 0, unit: '%', mul: 100 },
  { key: 'tC', label: '气温', w: 72, num: true, fix: 1, unit: '°C' },
  { key: 'tdC', label: '露点', w: 72, num: true, fix: 1, unit: '°C' },
  { key: 'rh', label: '相对湿度', w: 80, num: true, fix: 0, unit: '%', mul: 100 },
  { key: 'pMslHpa', label: '海平面气压', w: 92, num: true, fix: 1, unit: 'hPa' },
  { key: 'rho', label: '水汽密度', w: 84, num: true, fix: 1, unit: 'g/m³', tip: 'ITU-R P.453，由实测 T / 湿度导出' },
  { key: 'nwet', label: 'N_wet', w: 74, num: true, fix: 0, tip: 'ITU-R P.453 湿项折射率，闪烁计算的输入' },
  { key: 'wind', label: '风速', w: 72, num: true, fix: 1, unit: 'm/s' },
  // —— 和风按点列。★ 与上面的列是**两个数据源**：上面是 NCEP GFS 0.25° 格点场在站址的插值，
  //    这几列是和风按点产品（全球 1 km）。两边都取时间轴当前时刻，故并列可比，差值列才有意义。
  //    ★ 和风按点产品只有「本小时＝实况观测」与「未来＝逐小时预报」两段，没有历史，
  //      时间轴退到本小时之前这几列一律留空 —— 拿"现在"的观测冒充过去那一刻是假数。
  { key: 'oKind', label: '和风口径', w: 84, obs: true, tip: '实况观测（本小时）/ 逐小时预报（未来）。和风按点源无历史数据，早于本小时的时刻留空' },
  { key: 'oTC', label: '和风气温', w: 84, num: true, fix: 1, unit: '°C', obs: true, tip: '和风天气（QWeather）按点值，对应时间轴当前时刻；与左侧 NCEP GFS 模式值不同数据源' },
  { key: 'oRainMmH', label: '和风雨强', w: 84, num: true, fix: 2, unit: 'mm/h', obs: true, tip: '和风天气（QWeather）按点值，对应时间轴当前时刻' },
  { key: 'oCloud', label: '和风云量', w: 84, num: true, fix: 0, unit: '%', mul: 100, obs: true },
  { key: 'oRh', label: '和风湿度', w: 84, num: true, fix: 0, unit: '%', mul: 100, obs: true },
  { key: 'oTotalDb', label: '和风合计衰减', w: 100, num: true, fix: 3, unit: 'dB', obs: true, sat: true, tip: '按和风天气按点气象量就地计算一次瞬时衰减；该产品无柱云水，此列云衰恒取 ITU-R P.840 统计值' },
  { key: 'dRainMmH', label: '雨强 和风−模式', w: 108, num: true, fix: 2, unit: 'mm/h', obs: true, tip: '和风天气按点值 − NCEP GFS 模式值，同一时刻。0.25° 格点值为约 28 km 网格的平均，站址为单点值' },
  { key: 'oText', label: '天气', w: 84, obs: true },
  { key: 'note', label: '备注', w: 148, tip: '越界 / 不可见 / 仰角过低 / 雪冰等情形在此如实标明，不以 0 代替' }
]
// 列分组（仅供选项弹窗排版）
const MET_COL_GROUPS = [
  { title: '站点', keys: ['name', 'lon', 'lat', 'altKm'] },
  { title: '几何', keys: ['elev', 'az', 'rangeKm'] },
  { title: '链路衰减', keys: ['totalDb', 'rainDb', 'cloudDb', 'gasDb', 'scintDb'] },
  { title: '降水与云', keys: ['rainMmH', 'ptype', 'cwat', 'cloud'] },
  { title: '大气', keys: ['tC', 'tdC', 'rh', 'pMslHpa', 'rho', 'nwet', 'wind'] },
  { title: '和风天气（按站请求 · 随时间轴，需执行「获取和风数据」）', keys: ['oKind', 'oText', 'oTC', 'oRainMmH', 'oCloud', 'oRh', 'oTotalDb', 'dRainMmH'] },
  { title: '其他', keys: ['note'] }
]
const MET_COLS_DEFAULT = ['name', 'lon', 'lat', 'elev', 'totalDb', 'rainDb', 'rainMmH', 'note']
// 相态码 → 中文。★ 雪与冰上 P.838 不适用，表里必须看得出这一行为什么没有雨衰。
const PTYPE_ZH = { none: '无', rain: '雨', snow: '雪', ice: '冰', mixed: '混合', unknown: '未知' }

export function useLiveField(host) {
  const H = host || {}

  const open = ref(false)
  const on = ref(false)
  const defs = ref([])
  const key = ref('rainAtten')

  // —— 取数范围与档位 ——
  const region = ref('cn')
  const custom = reactive({ latMin: 15, latMax: 55, lonMin: 70, lonMax: 140 })
  const polyId = ref('')             // region==='poly' 时选中的地图多边形
  const res = ref(0.25)
  const hours = ref(24)
  const stepH = ref(3)
  const outStep = ref(0)
  const detail = ref(40000)          // 衰减场点数上限（拖时间轴的跟手度 vs 出图细度）

  // 可选的多边形清单由宿主给（地图上画的那批协调区多边形），此处只认 { id, name, pts }
  const polyList = computed(() => {
    const list = H.polys?.() || []
    return list.filter((p) => p && Array.isArray(p.pts) && p.pts.length >= 3)
      .map((p) => ({ id: p.id, name: p.name || 'Polygon', n: p.pts.length, pts: p.pts }))
  })
  const curPoly = computed(() => polyList.value.find((p) => p.id === polyId.value) || null)
  // 顶点 → [[lon,lat],…]。地图上存的是 [lon,lat] 数组，这里只做形状校验不做投影
  const polyPts = computed(() => {
    const p = curPoly.value
    if (!p) return null
    const out = p.pts.map((q) => [Number(q[0]), Number(q[1])]).filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]))
    return out.length >= 3 ? out : null
  })

  // ★ 不支持跨 ±180° 的窗口：栅格索引与子集服务的坐标都按 [-180,180] 线性排布，跨接缝要另写一套
  //   拼接逻辑。「全球」预置刻意留在 ±179 而不是 ±180，正是为了不去碰那条线。
  const bbox = computed(() => {
    const r = REGIONS.find((x) => x.v === region.value)
    if (r && r.bbox) return { ...r.bbox }
    const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0))
    // Polygon：外接矩形再各外扩一格。不外扩的话小多边形会被 normBox 的网格对齐压成零宽，
    // 且边缘那一圈格心正好落在边界上，图会缺一道边。
    if (region.value === 'poly') {
      const pts = polyPts.value
      if (!pts) return { latMin: 15, latMax: 55, lonMin: 70, lonMax: 140 }
      const m = Math.max(0.25, Number(res.value) || 0.25)
      let laMin = Infinity, laMax = -Infinity, loMin = Infinity, loMax = -Infinity
      for (const [lo2, la2] of pts) {
        if (la2 < laMin) laMin = la2; if (la2 > laMax) laMax = la2
        if (lo2 < loMin) loMin = lo2; if (lo2 > loMax) loMax = lo2
      }
      return {
        latMin: cl(laMin - m, -90, 89), latMax: cl(laMax + m, -89, 90),
        lonMin: cl(loMin - m, -180, 179), lonMax: cl(loMax + m, -179, 180)
      }
    }
    let latMin = cl(custom.latMin, -90, 89), latMax = cl(custom.latMax, -89, 90)
    let lonMin = cl(custom.lonMin, -180, 179), lonMax = cl(custom.lonMax, -179, 180)
    if (latMax <= latMin) latMax = latMin + 1
    if (lonMax <= lonMin) lonMax = lonMin + 1
    return { latMin, latMax, lonMin, lonMax }
  })

  // —— 链路参数（衰减场与气象指标表共用）——
  // ★ 目标星三档，这是「普适性」的入口：从前只有 GEO 轨位一个输入框，等于整个模块只对静止轨道成立。
  //   geo   静止轨道位置：填轨位，走与 GSO 链路预算同源的球面闭式
  //   sat   在轨卫星：选一颗真星（星座目录 / 卫星组 / 自定义星座），星下点按 SGP4 在**时间轴当前时刻**解算
  //   pos   手动星下点：直接给星下点与轨道高度（临时轨道方案、HAPS、目录里没有的星）
  // ★ 几何取的是**时钟时刻**而不是气象帧时刻：地图上的星画在时钟那一刻，衰减场的足迹若按帧时刻画，
  //   LEO 会与星标错开小半圈。气象只有 1~3 h 一帧，几何却是连续的，两者对不齐是数据本身的性质。
  const satMode = ref('geo')
  const satLon = ref('110.5')
  const satId = ref('')                                   // 'n:<NORAD>' / 'm:<名字>'，宿主 satPosAt 认这个键
  const satName = ref('')
  const manSat = reactive({ lat: 0, lon: 110.5, altKm: 1200 })
  const satTick = ref(0)                                  // 宿主星历目录就绪后拨一下，重解算
  const freq = ref('12.5')
  const pol = ref('C')
  const pathModel = ref('uniform')
  const cloudMode = ref('measured')
  const minElev = ref(5)

  // 目标星在时间轴当前时刻的星下点。sat 档由宿主解算（星历与 SGP4 都在渲染端），
  // pos 档直接读手填值。geo 档不走这条 —— 它给的是轨位，几何用闭式，见引擎侧 satGeom。
  const satPos = computed(() => {
    if (satMode.value === 'pos') {
      const lat = Number(manSat.lat), lon = Number(manSat.lon), altKm = Number(manSat.altKm)
      return (Number.isFinite(lat) && Number.isFinite(lon) && altKm > 0) ? { lat, lon, altKm } : null
    }
    if (satMode.value !== 'sat' || !satId.value) return null
    void satTick.value                                    // 目录懒加载完成后重解（宿主拨这个 ref）
    const p = H.satPosAt?.(satId.value, clock.tMs)
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || !Number.isFinite(p.altKm)) return null
    return { lat: p.lat, lon: p.lon, altKm: p.altKm }
  })
  // 选了星却解算不出来（目录还没载入 / 该星已不在星历里）：如实报，不静默按 GEO 顶替
  const satUnresolved = computed(() => satMode.value === 'sat' && !!satId.value && !satPos.value)
  const satReady = computed(() => (satMode.value === 'geo' ? Number.isFinite(parseFloat(satLon.value)) : !!satPos.value))
  /** 出 IPC 的目标星入参。★ 必须是纯对象：Vue 的 Proxy 过不了结构化克隆（见 IPC 那条老账） */
  const satArgs = () => (satMode.value === 'geo'
    ? { satLon: parseFloat(satLon.value) }
    : (satPos.value ? { satPos: { lat: satPos.value.lat, lon: satPos.value.lon, altKm: satPos.value.altKm } } : {}))
  // 几何变了就得重算整场。量化到 0.01°（≈1 km）再比：GEO 档几乎不动，LEO 档随时钟连续变，
  // 由在飞闸把连拍合并成「算得多快就刷多快」，不额外压节流（压了就成了错帧的画面）。
  const satKey = computed(() => {
    if (satMode.value === 'geo') return 'geo:' + parseFloat(satLon.value)
    const p = satPos.value
    return p ? `orb:${p.lat.toFixed(2)},${p.lon.toFixed(2)},${p.altKm.toFixed(1)}` : 'none'
  })

  // —— 样式（与环境场同一套）——
  const scheme = ref('atten'), invert = ref(false)
  const bands = ref(0)
  const domainMode = ref('levels')
  const manualLo = ref(''), manualHi = ref('')
  const alpha = ref(0.85)
  const landOnly = ref(false)

  // —— 运行时 ——
  const providers = ref(null)           // { field:{ok,…}, point:{ok,…} }
  const busy = ref(false), loading = ref(false)
  const progress = reactive({ done: 0, total: 0 })
  const msg = ref('')
  const meta = ref(null)                // 立方体元信息（times / nx / ny / 起报时次 / 取数统计）
  const field = ref(null)
  const est = ref(null)                // 取数预算 { nx, ny, nt, bytes, dlBytes, etaSec, need, cached }
  const usage = ref(null)               // 本地缓存占用

  // —— 站点表（多站，值跟随时间轴）——
  // ★ 这不是「实况查询」而是**在时间轴当前时刻，这批站点上的读数**：值从立方体逐点取、
  //   逐点跑一次 ITU 引擎，时钟一动整表跟着刷。和风实况只能给"现在"，是另一条路（见下）。
  // ★ 手动录入按**先经度后纬度**：与地图坐标的书写惯例一致（x 在前），也与站表导出对齐。
  const sites = ref([])                 // [{ id, name, lon, lat, src }]  src: manual|pt|st|traj
  const siteRows = ref([])              // 引擎回来的逐行读数（与 sites 同序，含 err 行）
  const siteMeta = ref(null)            // { frameT, model, cloudFellBack, ms }
  const siteBusy = ref(false)
  const siteCols = ref([...MET_COLS_DEFAULT])
  const newSite = reactive({ lon: '', lat: '', name: '' })
  const siteMsg = ref('')
  let siteSeq = 0

  // —— 和风按点值（与模式列并列的第二个数据源）——
  // 模式格值是 28 km 一片的平均，站址要的是那一个点的值。两者并列，差多少本身就是信息。
  // ★ 值**跟随时间轴**：本小时取实况观测，未来取逐小时预报（最长 240 h），本小时之前没有数据。
  // ★ 花钱的只有「获取」那一下：逐小时接口一次回一整条时间轴，取过之后拖时间轴只是查主进程里
  //   那条序列（allowFetch=false，一次 HTTP 都不发）。故按钮取一次，整条轴就都跟着走了。
  const siteObs = ref({})           // id → { ok, kind, tC, rainMmH, cloud, rh, totalDb, text, t } | { ok:false, message }
  const obsAt = ref(0)              // 这批和风值对应的时刻（＝时间轴当前帧就近的整点）
  const obsBusy = ref(false)
  const obsArmed = ref(false)       // 用户是否已取过一次（没取过就不必为每次拖时间轴发 IPC）

  let canvas = null
  let reqSeq = 0
  let inFlight = false, pending = false

  const def = computed(() => defs.value.find((d) => d.key === key.value) || null)
  const isSatField = computed(() => !!(def.value && def.value.sat))
  // 下拉按族分组：链路量（每格跑过一次 ITU 引擎）与气象量（源直出或 P.453 派生）不是一回事
  const defGroups = computed(() => {
    const link = defs.value.filter((d) => d.band === 'link')
    const met = defs.value.filter((d) => d.band !== 'link')
    return [{ label: '链路量', items: link }, { label: '气象量', items: met }].filter((g) => g.items.length)
  })

  // ---- 时间 ----
  // 帧由全局时钟就近选。cur.inRange=false 表示时钟走到了已取时段之外 —— 图层灰掉，不外推。
  const frameInfo = computed(() => {
    const m = meta.value
    if (!m || !m.times || !m.times.length) return { idx: -1, t: 0, inRange: false }
    const T = m.times
    let best = 0, bd = Infinity
    for (let i = 0; i < T.length; i++) { const d = Math.abs(T[i] - clock.tMs); if (d < bd) { bd = d; best = i } }
    const stepMs = T.length > 1 ? Math.abs(T[1] - T[0]) : 3600000
    return { idx: best, t: T[best], inRange: bd <= stepMs, offMs: T[best] - clock.tMs }
  })
  const timeSpan = computed(() => {
    const m = meta.value
    if (!m || !m.times || !m.times.length) return null
    return { t0: m.times[0], t1: m.times[m.times.length - 1], n: m.times.length, cycle: m.cycle }
  })

  // ---- 值域 / 图例 ----
  const stats = computed(() => {
    const f = field.value
    if (!f) return null
    return (landOnly.value && f.statsLand) ? f.statsLand : f.stats
  })
  // 业务档位可用 = 该字段自带 levels。没有 levels 的字段（气温/气压这类线性量）落回分位拉伸。
  const hasLevels = computed(() => !!(field.value && field.value.levels && field.value.levels.length > 1))
  const useLevels = computed(() => domainMode.value === 'levels' && hasLevels.value)
  const domain = computed(() => {
    const f = field.value, s = stats.value
    if (useLevels.value) { const L = f.levels; return [L[0], L[L.length - 1]] }
    if (!s) return null
    if (domainMode.value === 'manual') {
      const lo = Number(manualLo.value), hi = Number(manualHi.value)
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) return [lo, hi]
    }
    return autoDomain(s, domainMode.value === 'minmax' ? 'minmax' : 'p2p98')
  })
  const legend = computed(() => {
    const f = field.value, d = domain.value
    if (!f || !d) return null
    // 业务档位下图例画成**分档色块 + 边界值**，不是连续渐变条：色轴等分而值轴按锚点，
    // 画成渐变条的话条上任何一个位置都读不出对应的数 —— 气象图的图例本来就长这样。
    if (useLevels.value) {
      const L = f.levels, n = L.length
      // 走 legendStops 而不是自己拼 lutCss：前者带 alpha —— 低档在图上是半透明的，
      // 图例画成实色人就会以为那一档是纯色块，反而读错。
      return { stops: legendStops(scheme.value, invert.value, n - 1), ticks: levelTicks(L), edges: null,
        lo: L[0], hi: L[n - 1], unit: f.unit, label: f.label, dec: f.dec, stepped: true }
    }
    return {
      stops: legendStops(scheme.value, invert.value, bands.value),
      edges: bands.value > 0 ? bandEdges(d[0], d[1], bands.value) : null,
      ticks: null, stepped: false,
      lo: d[0], hi: d[1], unit: f.unit, label: f.label, dec: f.dec
    }
  })
  const fmt = (v) => fmtValue(v, field.value ? field.value.dec : 2)

  const srcNote = computed(() => {
    const f = field.value, m = meta.value
    if (!f || !m) return ''
    const g = f.step >= 1 ? f.step.toFixed(0) : String(+f.step.toFixed(3))
    return `${f.rec} · 源格距 ${m.step}° · 渲染格距 ${g}°`
  })
  // ---- 预算（不联网）----
  async function refreshEstimate() {
    if (!window.api?.weather?.estimate) return
    // 区域＝Polygon 却一个都没选：bbox 会回落到缺省窗，此时报预算等于诱人下载一片没要的数据
    if (region.value === 'poly' && !polyPts.value) { est.value = { error: '未选择 Polygon' }; return }
    try {
      est.value = await window.api.weather.estimate({
        bbox: bbox.value, res: Number(res.value), hours: Number(hours.value), stepH: Number(stepH.value)
      })
    } catch { est.value = null }
  }
  async function refreshUsage() {
    try { usage.value = (await window.api?.weather?.usage?.()) || null } catch { usage.value = null }
  }

  // ---- 取数 ----
  async function loadCube() {
    if (!window.api?.weather?.load) { msg.value = '气象数据通道不可用'; return }
    if (region.value === 'poly' && !polyPts.value) { msg.value = '未选择 Polygon'; return }
    if (est.value && est.value.overHard) { msg.value = est.value.error || '本次数据体超过内存上限，请缩小范围或放粗格距'; return }
    loading.value = true; progress.done = 0; progress.total = est.value ? est.value.nt : 0
    msg.value = '获取中…'
    try {
      const m = await window.api.weather.load({
        bbox: bbox.value, res: Number(res.value), hours: Number(hours.value), stepH: Number(stepH.value)
      })
      if (!m || m.error) { msg.value = (m && m.error) || '数据获取失败'; meta.value = null; clearLayer(); return }
      meta.value = m
      const parts = [`${m.nx}×${m.ny} 格 · ${m.nt} 帧`, `新取 ${m.fetched}`, `缓存 ${m.cached}`]
      if (m.failed) parts.push(`失败 ${m.failed}${m.failMsg ? '（' + m.failMsg + '）' : ''}`)
      msg.value = parts.join(' · ')
      // 时钟若不在已取时段内，把它挪到第一帧 —— 否则取完什么都看不见，像是没生效
      if (m.times && m.times.length && (clock.tMs < m.times[0] || clock.tMs > m.times[m.times.length - 1])) {
        H.setClock?.(m.times[0])
      }
      await refreshUsage(); await refreshEstimate()
      await refreshField(true)
    } catch (e) {
      msg.value = e.message || String(e); meta.value = null; clearLayer()
    } finally { loading.value = false; progress.total = 0 }
  }

  // ---- 逐帧取栅格 ----
  // 在飞闸：拖时间轴时每帧一次 IPC，慢的那次回来若已不是最新就丢弃；同时记住最后请求的帧，
  // 在飞期间到来的帧只留最后一个 —— 快拖时中间帧会被丢掉，但松手那一帧一定会算出来。
  async function refreshField(force) {
    const m = meta.value
    if (!m || !on.value) { if (!on.value) H.draw?.(null); return }
    const fi = frameInfo.value
    if (fi.idx < 0) return
    if (!fi.inRange) {                       // 时钟在已取时段之外：如实留白，不外推
      field.value = null
      H.draw?.(null)
      msg.value = '当前时刻不在已获取的气象时段内'
      return
    }
    if (inFlight && !force) { pending = true; return }
    inFlight = true
    const seq = ++reqSeq
    busy.value = true
    try {
      const o = {
        key: key.value, frame: fi.idx,
        step: Number(outStep.value) || undefined,
        cap: Number(detail.value) || undefined,
        mask: landOnly.value,
        pathModel: pathModel.value, cloudMode: cloudMode.value
      }
      // Polygon 档：裁剪交给引擎，多边形外的格连 ITU 引擎都不跑
      if (region.value === 'poly' && polyPts.value) o.poly = polyPts.value
      if (isSatField.value) {
        Object.assign(o, satArgs())
        o.freq = parseFloat(freq.value)
        o.pol = pol.value
        o.minElev = Number(minElev.value)
      }
      const res2 = await window.api.weather.field(o)
      if (seq !== reqSeq) return
      if (!res2 || res2.error) { msg.value = (res2 && res2.error) || '渲染失败'; field.value = null; H.draw?.(null); return }
      field.value = res2
      msg.value = res2.note || ''
      if (!userScheme && res2.scheme && scheme.value !== res2.scheme) { autoScheme = res2.scheme; scheme.value = res2.scheme }
      // 换到没有业务档位的字段（气温/气压）时，值域档自动落回分位 —— 否则色标是空的
      if (domainMode.value === 'levels' && !(res2.levels && res2.levels.length > 1)) domainMode.value = 'p2p98'
      redraw()
    } catch (e) {
      if (seq === reqSeq) { msg.value = e.message || String(e) }
    } finally {
      busy.value = false; inFlight = false
      if (pending) { pending = false; refreshField() }
    }
  }

  // ---- 上色 + 提交渲染 ----
  function redraw() {
    const f = field.value, d = domain.value
    if (!f || !d || !on.value) { H.draw?.(null); return }
    const rgba = colorize(f.values, f.land, {
      lo: d[0], hi: d[1], scheme: scheme.value, invert: invert.value,
      bands: bands.value, landOnly: landOnly.value, opacity: 1,
      levels: useLevels.value ? f.levels : null
    })
    canvas = rasterCanvas(rgba, f.nx, f.ny, canvas)
    H.draw?.({ canvas, bbox: f.bbox, alpha: alpha.value, smooth: bands.value === 0 })
  }

  function readAt(lat, lon) {
    const f = field.value
    if (!f || !on.value) return null
    const v = valueAt(f, lat, lon)
    if (!Number.isFinite(v)) return null
    return { short: f.short, label: f.label, unit: f.unit, text: fmtValue(v, f.dec), value: v, step: f.step }
  }

  function clearLayer() {
    field.value = null
    H.draw?.(null)
  }

  // ---- 站点表 ----
  // 一批点一次 IPC：时间轴一动全表刷新，逐点发 IPC 会把主进程打满。实测 6 站 < 1 ms。
  // ★ 在飞闸（与图层那条同一形状）：非静止轨道目标下几何**每一拍都变**，倍速播放时逐拍发 IPC
  //   会把主进程排满，且排在队里的都是过期时刻。故在飞期间只记一个「还欠一次」，回来再补算 ——
  //   中间拍会被丢掉，但一定会落到最后那一拍。
  let siteInFlight = false, sitePending = false
  async function refreshSites(force) {
    if (!meta.value || !sites.value.length) { siteRows.value = []; siteMeta.value = null; return }
    if (!window.api?.weather?.points) { siteMsg.value = '气象数据通道不可用'; return }
    const fi = frameInfo.value
    if (fi.idx < 0 || (!fi.inRange && !force)) { siteRows.value = []; siteMeta.value = null; siteMsg.value = '当前时刻不在已获取的气象时段内'; return }
    if (siteInFlight && !force) { sitePending = true; return }
    siteInFlight = true
    const seq = ++siteSeq
    siteBusy.value = true
    try {
      const r = await window.api.weather.points({
        pts: sites.value.map((s) => ({ id: s.id, name: s.name, lat: Number(s.lat), lon: Number(s.lon) })),
        frame: fi.idx,
        ...satArgs(), freq: parseFloat(freq.value), pol: pol.value,
        pathModel: pathModel.value, cloudMode: cloudMode.value, minElev: Number(minElev.value)
      })
      if (seq !== siteSeq) return                       // 快拖时间轴时慢的那次回来就丢掉
      if (!r || r.error) { siteMsg.value = (r && r.error) || '站点读数计算失败'; siteRows.value = []; return }
      siteRows.value = r.rows || []
      siteMeta.value = { frameT: r.frameT, model: r.model, cloudFellBack: r.cloudFellBack, ms: r.ms, minElev: r.minElev }
      siteMsg.value = ''
    } catch (e) { if (seq === siteSeq) siteMsg.value = e.message || String(e) } finally {
      siteBusy.value = false; siteInFlight = false
      if (sitePending) { sitePending = false; refreshSites() }
    }
  }

  // 结果行 = 站点 ∪ 引擎回来的读数。★ 站点在、读数没回来（还没取数 / 该点越界）时仍要出行，
  //   否则表会"少几站"而看不出是哪几站 —— 空行加一句备注比消失诚实。
  //   排序不在这里做：只读表的列头排序由 ExcelGrid / useGridSelect 统管（与性能指标表同一套）。
  const metRows = computed(() => {
    const byId = new Map(siteRows.value.map((r) => [r.id, r]))
    return sites.value.map((s) => {
      const r = byId.get(s.id)
      const base = { id: s.id, name: s.name, lon: Number(s.lon), lat: Number(s.lat), src: s.src }
      const o = siteObs.value[s.id]
      // 和风列一律加 o 前缀，与模式列分得开；差值列只有两边都在时才算，缺一个就留空（不拿 0 顶替）
      const obsFields = o && o.ok ? {
        oKind: o.kind === 'obs' ? '实况观测' : '逐小时预报',
        oTC: o.tC, oRainMmH: o.rainMmH, oCloud: o.cloud, oRh: o.rh,
        oTotalDb: o.totalDb, oText: o.text
      } : {}
      if (!r) return { ...base, ...obsFields, note: meta.value ? '' : '尚未获取气象数据' }
      const { id, name, lat, lon, err, note, ...vals } = r
      const dRain = (o && o.ok && Number.isFinite(o.rainMmH) && Number.isFinite(vals.rainMmH))
        ? o.rainMmH - vals.rainMmH : undefined
      const oMsg = o && !o.ok ? ('和风：' + (o.message || '获取失败')) : ''
      return { ...base, ...vals, ...obsFields, dRainMmH: dRain, note: err || note || oMsg }
    })
  })
  /** 当前显示的列（恒按 MET_COL_DEFS 的原序，与性能表的 visibleColumns 同口径） */
  const metCols = computed(() => MET_COL_DEFS.filter((c) => siteCols.value.includes(c.key)))

  // 站点 id = 时间戳 + 单调自增号。★ 随机后缀在这里行不通：从标记导入是在一个同步循环里逐点建站的，
  //   一整批的 Date.now() 完全相同，全靠那几千个随机取值分辨——60 个航点撞车的概率就过半（生日问题）。
  //   而 id 是这张表的主键（读数按 id 归并、删行按 id 过滤、ExcelGrid 拿它当 key），撞了的现象是
  //   「两行显示同一份读数、删一行掉两行、改一格只改到第一条」。自增号在一次会话内绝不重复，
  //   跨会话由时间戳分开。★ 宿主页的 metNewSite 也走这一支（见 return），两处共用同一个计数器。
  let _sidSeq = 0
  const nextSiteId = () => 'lv' + Date.now().toString(36) + '-' + (_sidSeq++).toString(36)
  function addSite() {
    const lon = Number(newSite.lon), lat = Number(newSite.lat)
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) { siteMsg.value = '经纬度须填写完整（先经度、后纬度）'; return }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) { siteMsg.value = '经纬度超出范围'; return }
    sites.value.push({ id: nextSiteId(), name: (newSite.name || '').trim() || fmtLL(lon, lat), lon, lat, src: 'manual' })
    newSite.lon = ''; newSite.lat = ''; newSite.name = ''
    siteMsg.value = ''
    refreshSites()
  }
  function delSite(id) { sites.value = sites.value.filter((s) => s.id !== id); refreshSites() }
  function clearSites() { sites.value = []; siteRows.value = []; siteMeta.value = null }
  const fmtLL = (lon, lat) => `${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'} ${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}`

  /**
   * 从地图标记导入。三类各有各的取法：
   *   pt   点标记 —— 无名字，用坐标当名字
   *   st   地球站 —— 自带名字
   *   traj 航迹   —— ★ 航迹的顶点**不带时间戳**，故不能算「此刻这条船在哪」。
   *        逐顶点各成一行是唯一诚实的做法：读出来的是「当前时刻，沿这条航线各点的衰减」，
   *        正是航路规划要看的东西。不去凭空给顶点安一个时间再插值假装船在动。
   * 同坐标去重（0.01° 内视为同一点），重复导入不会把表堆爆。
   */
  function importMarkers(kind) {
    const M = H.markers?.()
    if (!M) { siteMsg.value = '读取地图标记失败' ; return }
    const add = []
    if (kind === 'pt') for (const p of (M.pts || [])) add.push({ lon: p.lon, lat: p.lat, name: fmtLL(p.lon, p.lat), src: 'pt' })
    if (kind === 'st') for (const s of (M.sts || [])) add.push({ lon: s.lon, lat: s.lat, name: s.name || '地球站', src: 'st' })
    if (kind === 'traj') for (const t of (M.trs || [])) {
      const pts = t.pts || []
      pts.forEach((p, i) => add.push({ lon: p.lon, lat: p.lat, name: `${t.name || '航迹'} #${i + 1}`, src: 'traj' }))
    }
    const key = (o) => Math.round(o.lon * 100) + ',' + Math.round(o.lat * 100)
    const have = new Set(sites.value.map(key))
    let n = 0
    for (const o of add) {
      if (!Number.isFinite(o.lon) || !Number.isFinite(o.lat) || have.has(key(o))) continue
      have.add(key(o)); sites.value.push({ id: nextSiteId(), ...o }); n++
    }
    siteMsg.value = n ? `导入 ${n} 站` + (add.length > n ? `（${add.length - n} 个坐标重复，已跳过）` : '') : '无可导入的标记'
    if (n) refreshSites()
  }

  function toggleSiteCol(k) {
    const on = siteCols.value.includes(k)
    const next = new Set(siteCols.value)
    if (on) next.delete(k); else next.add(k)
    if (!next.size) return                                    // 至少留一列，否则表整个消失
    siteCols.value = MET_COL_DEFS.filter((c) => next.has(c.key)).map((c) => c.key)   // 恒按原序
  }
  function resetSiteCols() { siteCols.value = [...MET_COLS_DEFAULT] }

  /** 一格的显示文本（与复制/导出同口径：数字按列定义的小数位，取不到值给破折号） */
  function metText(r, c) {
    if (c.key === 'ptype') return PTYPE_ZH[r.ptype] || (r.ptype ? String(r.ptype) : '')
    const v = r[c.key]
    if (!c.num) return v == null ? '' : String(v)
    const n = Number(v) * (c.mul || 1)
    return Number.isFinite(n) ? n.toFixed(c.fix == null ? 2 : c.fix) : '—'
  }
  /** 站点表 → TSV（直接粘进 Excel）。表头带单位；行序由调用方给（屏幕上排过序的那一份） */
  function metTsv(rows) {
    const cols = metCols.value
    const head = cols.map((c) => c.label + (c.unit ? '(' + c.unit + ')' : '')).join('\t')
    const body = (rows || metRows.value).map((r) => cols.map((c) => {
      const t = metText(r, c)
      return t === '—' ? '' : t
    }).join('\t'))
    return [head, ...body].join('\n')
  }

  // ---- 和风按点值（气象指标表的「和风」列组）----
  // 一次调用 = 一批站点在**时间轴当前时刻**的值。花钱与否只看 allowFetch：
  //   true  用户点了按钮 —— 允许发 HTTP，一站一次，且一次买下整条时间轴（horizonMs 给到末帧）；
  //   false 时间轴联动 —— 只在主进程已买到的序列里查，查不到就留空并如实写「尚未获取该站数据」。
  let obsSeq = 0
  async function refreshObs(allowFetch) {
    if (!window.api?.weather?.obs) { if (allowFetch) siteMsg.value = '和风天气通道不可用'; return }
    const pts = sites.value.filter((s) => Number.isFinite(Number(s.lon)) && Number.isFinite(Number(s.lat)))
    if (!pts.length) { if (allowFetch) siteMsg.value = '尚未添加站点'; siteObs.value = {}; return }
    // 取值时刻：优先用已取回栅格的那一帧（两个数据源摆在同一张表里，必须对齐同一时刻）
    const fi = frameInfo.value
    const tMs = (meta.value && fi.idx >= 0 && fi.inRange) ? fi.t : clock.tMs
    const sp = timeSpan.value
    const horizonMs = sp ? Math.max(0, sp.t1 - Date.now()) : 0
    const seq = ++obsSeq
    if (allowFetch) { obsBusy.value = true; siteMsg.value = `获取和风数据…（${pts.length} 站，逐站各一次请求）` }
    try {
      const r = await window.api.weather.obs({
        pts: pts.map((s) => ({ id: s.id, lat: Number(s.lat), lon: Number(s.lon) })),
        tMs, allowFetch: !!allowFetch, horizonMs,
        ...satArgs(), freq: parseFloat(freq.value), pol: pol.value,
        pathModel: pathModel.value, cloudMode: cloudMode.value
      })
      if (seq !== obsSeq) return                        // 快拖时间轴时慢的那次回来就丢掉
      if (!r || r.error) { if (allowFetch) siteMsg.value = (r && r.error) || '和风数据获取失败'; return }
      const m = {}
      let ok = 0
      for (const row of (r.rows || [])) { m[row.id] = row; if (row.ok) ok++ }
      siteObs.value = m
      obsAt.value = ok ? (r.t || tMs) : 0
      if (ok) obsArmed.value = true
      if (allowFetch) siteMsg.value = `和风数据 ${ok}/${(r.rows || []).length} 站` + (ok < (r.rows || []).length ? '（其余见备注列）' : '')
    } catch (e) { if (allowFetch) siteMsg.value = e.message || String(e) } finally { if (allowFetch) obsBusy.value = false }
  }
  const fetchObsAll = () => refreshObs(true)
  function clearObs() { siteObs.value = {}; obsAt.value = 0; obsArmed.value = false }
  // 站点被删掉时顺手清掉它的和风值，不留孤儿
  watch(() => sites.value.map((s) => s.id).join(','), (ids) => {
    const keep = new Set(ids.split(','))
    const m = siteObs.value, next = {}
    let drop = 0
    for (const k of Object.keys(m)) { if (keep.has(k)) next[k] = m[k]; else drop++ }
    if (drop) siteObs.value = next
  })

  async function testConn(which) {
    msg.value = '连通测试中…'
    try {
      const r = await window.api?.weather?.test?.(which)
      msg.value = r && r.ok
        ? (which === 'point' ? `站点实况源连通正常（北京 ${r.temp} °C，${r.text}）` : `栅格源连通正常（${r.text}，北京附近 ${r.temp} °C）`)
        : ('连接失败：' + ((r && r.message) || '未知'))
    } catch (e) { msg.value = '连接失败：' + e.message }
  }

  async function clearCache() {
    try {
      const r = await window.api?.weather?.clearCache?.()
      meta.value = null; clearLayer()
      msg.value = r && r.ok ? `已清除缓存（${r.removed} 个分片）` : '缓存清除失败'
      await refreshEstimate(); await refreshUsage()
    } catch (e) { msg.value = e.message }
  }

  // ---- 面板 ----
  async function openPanel() {
    open.value = true
    if (!defs.value.length && window.api?.weather?.defs) {
      try { const d = await window.api.weather.defs(); if (Array.isArray(d)) defs.value = d } catch { /* 通道不可用，下面会报 */ }
    }
    if (!providers.value) {
      try { providers.value = await window.api?.weather?.providers?.() } catch { providers.value = null }
    }
    if (!meta.value) { try { meta.value = await window.api?.weather?.meta?.() } catch { /* 无立方体 */ } }
    await refreshEstimate(); await refreshUsage()
    if (on.value && meta.value) refreshField(true)
  }
  function close() { open.value = false }   // 面板收起不撤图层（与环境场同约定）

  // ---- 联动 ----
  let userScheme = false, autoScheme = ''
  watch(scheme, (v) => { if (v !== autoScheme) userScheme = true })
  // 换字段 / 换出图格距 / 换链路参数 → 只重出一张栅格，**不重新取数**（立方体已含全部要素）
  watch([key, outStep, detail, freq, pol, pathModel, cloudMode, minElev], () => { if (on.value && meta.value) refreshField() })
  // ★ 目标星几何：GEO 档只在改轨位时动，sat 档随时钟连续动（LEO 一分钟走 3.5°）。
  //   在飞闸把连拍并成「算得多快刷多快」，不另加节流 —— 节流出来的是错帧的画面。
  watch(satKey, () => {
    if (on.value && meta.value && isSatField.value) refreshField()
    refreshSites(); if (obsArmed.value) refreshObs(false)
  })
  // 换区域档 / 换多边形 → 裁剪范围变了，重出一张（同样不重新取数：立方体照旧，只是少画一片）
  watch([region, polyId], () => { if (on.value && meta.value) refreshField() })
  // 站点表：链路参数一改，整表跟着重算（表里的衰减列全依赖这几项）
  watch([freq, pol, pathModel, cloudMode, minElev], () => { refreshSites(); if (obsArmed.value) refreshObs(false) })
  // ★ 站点表跟时间轴：帧号一变就整表刷新。与图层各走各的 —— 图层可以关着，表照样有数。
  //   和风列同步重取值，但**只查已买到的序列**（allowFetch=false），拖时间轴不产生请求。
  watch(() => frameInfo.value.idx, () => { refreshSites(); if (obsArmed.value) refreshObs(false) })
  watch(() => frameInfo.value.inRange, () => refreshSites())
  watch(() => sites.value.length, () => refreshSites())
  // 没取过栅格数据时时间轴仍在走，和风列照样该跟着动（两者互不依赖）
  watch(() => Math.round(clock.tMs / 3600000), () => { if (obsArmed.value && !meta.value) refreshObs(false) })
  watch(landOnly, () => { if (on.value && meta.value) refreshField(); else redraw() })
  watch([scheme, invert, bands, domainMode, manualLo, manualHi], () => redraw())
  watch(alpha, (a) => { if (on.value) H.setAlpha?.(a) })
  // 换字段时把「手动上下限」清掉：单位跟着字段变，留着必然是错的
  watch(key, () => { manualLo.value = ''; manualHi.value = '' })
  // 改取数范围/格距/时段 → 只更新预算读数，不自动取数（取数要联网等几十秒，必须用户点）
  watch([bbox, res, hours, stepH], () => refreshEstimate(), { deep: true })
  // 格距一变，帧间隔的合法档跟着变（0.5°/1° 只有逐 3 小时的产品）
  watch(res, (v) => { if (Number(v) > 0.25 && Number(stepH.value) < 3) stepH.value = 3 })
  // 总开关
  watch(on, (v) => { if (v && meta.value) refreshField(true); else clearLayer() })
  // ★ 时间轴：时钟一动就换帧。只在帧号真的变了才重算 —— 时钟每拍都跳，但一帧管一小时。
  watch(() => frameInfo.value.idx, () => { if (on.value && meta.value) refreshField() })
  watch(() => frameInfo.value.inRange, () => { if (on.value && meta.value) refreshField() })

  // ---- 设置记忆（只记界面选择，不记数据）----
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null')
    if (s && typeof s === 'object') {
      if (typeof s.on === 'boolean') on.value = s.on
      if (s.key) key.value = s.key
      if (s.region) region.value = s.region
      if (s.custom) Object.assign(custom, s.custom)
      if (s.polyId) polyId.value = s.polyId
      if (Number.isFinite(s.res)) res.value = s.res
      if (Number.isFinite(s.hours)) hours.value = s.hours
      if (Number.isFinite(s.stepH)) stepH.value = s.stepH
      if (Number.isFinite(s.outStep)) outStep.value = s.outStep
      if (Number.isFinite(s.detail)) detail.value = s.detail
      // ★ 老存档里可能已经躺着重复 id（旧的随机后缀撞出来的）：进场就地换一个新的，
      //   否则那几行会一直互相盖读数，而用户看不出是 id 的事
      if (Array.isArray(s.sites)) {
        const seen = new Set()
        sites.value = s.sites
          .filter((x) => x && Number.isFinite(Number(x.lon)) && Number.isFinite(Number(x.lat)))
          .map((x) => { const id = (x.id && !seen.has(x.id)) ? x.id : nextSiteId(); seen.add(id); return { ...x, id } })
      }
      if (Array.isArray(s.siteCols) && s.siteCols.length) siteCols.value = MET_COL_DEFS.filter((c) => s.siteCols.includes(c.key)).map((c) => c.key)
      if (s.satMode === 'geo' || s.satMode === 'sat' || s.satMode === 'pos') satMode.value = s.satMode
      if (s.satLon) satLon.value = s.satLon
      if (s.satId) { satId.value = s.satId; satName.value = s.satName || '' }
      if (s.manSat) Object.assign(manSat, s.manSat)
      if (s.freq) freq.value = s.freq
      if (s.pol) pol.value = s.pol
      if (s.pathModel) pathModel.value = s.pathModel
      if (s.cloudMode) cloudMode.value = s.cloudMode
      if (Number.isFinite(s.minElev)) minElev.value = s.minElev
      if (s.scheme && s.schemeLocked) { scheme.value = s.scheme; userScheme = true }
      if (Number.isFinite(s.alpha)) alpha.value = s.alpha
      if (Number.isFinite(s.bands)) bands.value = s.bands
      if (s.domainMode) domainMode.value = s.domainMode
      invert.value = !!s.invert; landOnly.value = !!s.landOnly
    }
  } catch { /* 首次运行无缓存 */ }
  watch([on, key, region, polyId, res, hours, stepH, outStep, detail, sites, siteCols,
    satMode, satLon, satId, satName, freq, pol, pathModel, cloudMode, minElev,
    scheme, alpha, bands, domainMode, invert, landOnly,
    () => custom.latMin, () => custom.latMax, () => custom.lonMin, () => custom.lonMax,
    () => manSat.lat, () => manSat.lon, () => manSat.altKm], () => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        on: on.value, key: key.value, region: region.value, custom: { ...custom }, polyId: polyId.value,
        res: Number(res.value), hours: Number(hours.value), stepH: Number(stepH.value), outStep: Number(outStep.value),
        detail: Number(detail.value), sites: sites.value, siteCols: siteCols.value,
        satMode: satMode.value, satLon: satLon.value, satId: satId.value, satName: satName.value,
        manSat: { ...manSat }, freq: freq.value, pol: pol.value,
        pathModel: pathModel.value, cloudMode: cloudMode.value, minElev: Number(minElev.value),
        scheme: scheme.value, schemeLocked: userScheme, alpha: alpha.value, bands: bands.value,
        domainMode: domainMode.value, invert: invert.value, landOnly: landOnly.value
      }))
    } catch { /* 隐私模式等写不进去，忽略 */ }
  })

  // 取数进度（主进程按帧回推）
  try { window.api?.weather?.onProgress?.((p) => { progress.done = p.done; progress.total = p.total }) } catch { /* 通道不可用 */ }

  return {
    open, on, defs, key, defGroups,
    region, custom, polyId, polyList, curPoly, polyPts, bbox, res, hours, stepH, outStep, detail,
    satMode, satLon, satId, satName, manSat, satTick, satPos, satUnresolved, satReady,
    freq, pol, pathModel, cloudMode, minElev,
    scheme, invert, bands, domainMode, manualLo, manualHi, alpha, landOnly,
    providers, busy, loading, progress, msg, meta, field, est, usage,
    obsBusy, obsArmed, siteObs, obsAt, fetchObsAll, refreshObs, clearObs,
    // 站点表（多站，值跟随时间轴）
    sites, siteRows, siteMeta, siteBusy, siteCols, siteMsg, newSite,
    metRows, metCols, metText, metTsv,
    MET_COL_DEFS, MET_COL_GROUPS, MET_COLS_DEFAULT, PTYPE_ZH,
    // nextSiteId 对外给：宿主页的 metNewSite（表内增行 / 粘贴 / 导入 Excel）建的是同一批站点，
    // 必须与本模块共用同一个计数器，否则两边各自的自增号会在同一毫秒里撞上
    nextSiteId,
    refreshSites, addSite, delSite, clearSites, importMarkers, toggleSiteCol, resetSiteCols, fmtLL,
    def, isSatField, stats, domain, legend, srcNote, frameInfo, timeSpan, hasLevels, useLevels,
    REGIONS, RES, STEP_H, HOURS, OUT_STEPS, DETAILS, SCHEMES, PATH_MODELS, CLOUD_MODES, MIN_ELEVS,
    openPanel, close, loadCube, refreshField, refreshEstimate, refreshUsage,
    // redraw 要对外给：2D 平面图是懒创建的，切过去时 feedFlat 得把当前这张场按原样再喂一遍
    // （与 ITU 环境场同一条约定；两句谁先谁后无所谓，宿主的归属闸保证不会互相抹掉）
    redraw, clearLayer, readAt, fmt, testConn, clearCache
  }
}
