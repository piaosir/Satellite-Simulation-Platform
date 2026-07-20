import { reactive, computed, watch } from 'vue'

// 全局显示画质（游戏式档位）：低/中/高/超高/极致/自定义，作用于 3D 球体 + 2D 平面（星座图 / 覆盖分析 / GXT 共用同一引擎）。
// 每个档位预设下列底层可调项；选「自定义」时各项解锁手调。改任意项自动落到「自定义」。
//  - pixelRatio  渲染分辨率倍率（= THREE 的 setPixelRatio；UI 以 % 显示，100%=1×）。头号性能杠杆，热切无缝。
//  - mapDetail   底图几何精度：'10m'(精细) | '50m'(粗)。换 topojson 源，重建陆地网格+边界线。
//  - mapThin     海岸线/边界抽稀阈值（度）；越大段数越少。0=不抽稀。
//  - gridStride  覆盖网格三角化降采样步长（1=全分辨率；2/4=每 N 格一三角）。只影响渲染网格密度，
//                不改 SATSOFT 已验证的场/峰值计算 → 等值线/填充变粗但数值不变。
//  - msaa        MSAA 抗锯齿。WebGL 上下文创建期参数，切换需重建场景（由 3D 视图按 key 重挂载实现）。
//  - fps         渲染帧率上限（0=不限/每帧；30/60=省电节流）。
//  - sphereSeg   海洋球细分段数。
const PRESETS = {
  low:    { pixelRatio: 1.0,  mapDetail: '110m', mapThin: 0, gridStride: 2, msaa: true,  fps: 30, sphereSeg: 64 },
  mid:    { pixelRatio: 1.5,  mapDetail: '110m', mapThin: 0, gridStride: 1, msaa: true,  fps: 30, sphereSeg: 96 },
  high:   { pixelRatio: 2.0,  mapDetail: '50m',  mapThin: 0, gridStride: 1, msaa: true,  fps: 60, sphereSeg: 128 },
  ultra:  { pixelRatio: 3.0,  mapDetail: '50m',  mapThin: 0, gridStride: 1, msaa: true,  fps: 0,  sphereSeg: 192 },
  native: { pixelRatio: 3.0,  mapDetail: '10m',  mapThin: 0, gridStride: 1, msaa: true,  fps: 0,  sphereSeg: 192 }
}
export const TIERS = [
  { key: 'low', label: '低' }, { key: 'mid', label: '中' }, { key: 'high', label: '高' },
  { key: 'ultra', label: '超高' }, { key: 'native', label: '极致' }, { key: 'custom', label: '自定义' }
]
// 底图精细化「档位」（由 50m/10m 两套 topojson + 顶点抽稀阈值 thin 组合出多级，粗→细）。
// 单一下拉选择，内部同时落 mapDetail(数据源) 与 mapThin(抽稀阈值，度)。各档位粗→细顺序排列。
export const MAP_LEVELS = [
  { detail: '110m', thin: 0, label: '粗（110m）' },
  { detail: '50m',  thin: 0, label: '中（50m）' },
  { detail: '10m',  thin: 0, label: '精细（10m）' }
]
// 自定义档可选值（供下拉/滑块），文案与档位预设对应
export const FIELD_OPTS = {
  pixelRatio: [
    { v: 0.75, label: '75%' }, { v: 1.0, label: '100%' }, { v: 1.5, label: '150%' },
    { v: 2.0, label: '200%' }, { v: 3.0, label: '300%' }, { v: 4.0, label: '400%' }
  ],
  gridStride: [{ v: 2, label: '1/2' }, { v: 1, label: '全分辨率' }],
  fps: [{ v: 30, label: '30 fps' }, { v: 60, label: '60 fps' }, { v: 0, label: '不限' }],
  sphereSeg: [{ v: 64, label: '低' }, { v: 96, label: '中' }, { v: 128, label: '高' }, { v: 192, label: '超高' }]
}

const KEY = 'globe3d/displayQuality'
const DEFAULT_TIER = 'high'

function loadInit() {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (o && typeof o === 'object') {
      const tier = TIERS.some((t) => t.key === o.tier) ? o.tier : DEFAULT_TIER
      const custom = { ...PRESETS.high, ...(o.custom || {}) }
      return { tier, custom }
    }
  } catch { /* ignore */ }
  return { tier: DEFAULT_TIER, custom: { ...PRESETS.high } }
}

const init = loadInit()
export const quality = reactive({ tier: init.tier, custom: init.custom })

// 生效值：非自定义档取预设，自定义档取 custom
export const effective = computed(() => quality.tier === 'custom' ? quality.custom : PRESETS[quality.tier])

export function setTier(t) {
  if (!TIERS.some((x) => x.key === t)) return
  // 切到自定义档时，以当前生效值为起点，便于在此基础上微调
  if (t === 'custom') quality.custom = { ...effective.value }
  quality.tier = t
}
// 改单项 → 自动转「自定义」，并写入 custom
export function setField(key, val) {
  if (!(key in PRESETS.high)) return
  const base = quality.tier === 'custom' ? { ...quality.custom } : { ...effective.value }
  base[key] = val
  quality.custom = base
  quality.tier = 'custom'
}
// 底图精细化：一次同时落 mapDetail + mapThin（来自 MAP_LEVELS 某档）→ 自动转「自定义」
export function setMapLevel(detail, thin) {
  const base = quality.tier === 'custom' ? { ...quality.custom } : { ...effective.value }
  base.mapDetail = detail; base.mapThin = thin
  quality.custom = base
  quality.tier = 'custom'
}
// 当前生效值对应的 MAP_LEVELS 序号（精确匹配；无匹配按 detail+最近 thin 兜底）
export function currentMapLevelIndex(eff) {
  const exact = MAP_LEVELS.findIndex((l) => l.detail === eff.mapDetail && l.thin === eff.mapThin)
  if (exact >= 0) return exact
  let best = -1, bd = Infinity
  MAP_LEVELS.forEach((l, i) => { if (l.detail === eff.mapDetail) { const d = Math.abs(l.thin - eff.mapThin); if (d < bd) { bd = d; best = i } } })
  return best >= 0 ? best : 0
}

watch(() => ({ tier: quality.tier, custom: quality.custom }),
  (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)) } catch { /* ignore */ } },
  { deep: true })
