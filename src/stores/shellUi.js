import { reactive, watch } from 'vue'

// 壳层 UI 状态（本地记忆）：
//  - side：侧栏当前视图（VS Code 活动栏范式，同屏只显示一个视图；'' = 侧栏收起）
//          'constellation' 星座 | 'antenna' 对地覆盖分析 | 'satcov' 对星覆盖分析 | 'beams' 天线波束合成
//          | 'vis' 可见性分析 | 'poly' Polygon | 'gxt' 覆盖图 | 'markers' 标记 | 'env' 环境场
//          | 'scene' 应用场景仿真 | 'focus' 聚焦卫星（显示样式） | 'geo' 地图设置
//  - sideLast：收起前停在哪个视图（恒为非空，见下面 sideCtx）
//  - toolbar / log：图标工具栏、底部日志窗格显隐
//  - exw：侧栏宽度（px）；exwVis：可见性分析视图的专属宽度（时段过境双时刻表格+甘特轴信息密度高，
//    独立记忆且默认更宽、拖拽上限也更高——两条轨互不影响，拖谁记谁）
// 单独成 store：3D 页的 Teleport（把各视图挂入侧栏）需要感知 side。
// KEY 带版本号：日志窗格默认改为收起前，早期版本可能已把 log:true 存进旧 key，
// 不换 key 的话旧用户会一直读到那个 true，看起来像「默认没生效」。
const KEY = 'shell-ui-v2'
// 注意：这张表是 side 的持久化白名单，活动栏新增一项就必须同步加进来，
// 否则重开软件后 localStorage 里的值过不了 :18 的校验、静默回落到 'constellation'
//（'env' 曾经就漏在这里，表现为「环境场不被记忆」）。
const SIDES = ['constellation', 'antenna', 'satcov', 'beams', 'vis', 'poly', 'gxt', 'markers', 'env', 'envLive', 'scene', 'focus', 'geo']
// 出厂宽度 340（原 300）：参数行是「标签列 + 控件 + 读数列」三段，300px 下控件那段只剩一百出头，
// 英文标签列还要再宽一档 —— 拖过一次的用户读的是自己存的值，这里只管第一次打开时的观感。
export const shellUi = reactive({ toolbar: true, log: false, side: 'constellation', sideLast: 'constellation', exw: 340, exwVis: 400 })
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || 'null')
  if (saved && typeof saved === 'object') {
    for (const k of ['toolbar', 'log']) if (typeof saved[k] === 'boolean') shellUi[k] = saved[k]
    if (saved.side === '' || SIDES.includes(saved.side)) shellUi.side = saved.side
    else if (saved.explorer === false) shellUi.side = ''   // 旧版「资源管理器」布尔量迁移
    if (SIDES.includes(saved.sideLast)) shellUi.sideLast = saved.sideLast
    if (Number.isFinite(saved.exw)) shellUi.exw = Math.max(240, Math.min(420, saved.exw))
    if (Number.isFinite(saved.exwVis)) shellUi.exwVis = Math.max(240, Math.min(560, saved.exwVis))
  }
} catch { /* ignore */ }
if (shellUi.side) shellUi.sideLast = shellUi.side   // 老快照没有 sideLast 字段：由当前 side 补一个
// flush:'sync' 是必须的：活动栏「再点一次收起」走的是 side='satcov' → '' 这一步赋值，
// 默认的 pre-flush 会让 sideLast 慢一拍 —— 中间那一瞬 sideCtx() 读到的是【上上个】视图。
watch(() => shellUi.side, (v) => { if (v) shellUi.sideLast = v }, { flush: 'sync' })
watch(shellUi, () => { try { localStorage.setItem(KEY, JSON.stringify(shellUi)) } catch { /* ignore */ } }, { deep: true })

// 【上下文视图】：收起侧栏（side=''）只是把面板藏起来，不该动画面上任何东西 —— 场景内容、图层归属、
// 拖拽方式一律沿用收起前那个视图，只有真的切到别的视图才算离开。
// 分工：side 管「面板画不画」（模板里的 v-if/v-show 用它），sideCtx() 管「场景怎么画」（绘制侧的闸一律用它）。
export const sideCtx = () => shellUi.side || shellUi.sideLast

// 侧栏宽度按视图分轨：当前视图用哪个宽度字段 + 各自的拖拽范围（App.vue 的绑定与分隔条共用）
export const sideWKey = () => (shellUi.side === 'vis' ? 'exwVis' : 'exw')
export const SIDE_W_LIM = { exw: [240, 420], exwVis: [240, 560] }

export function toggleUi(k) { shellUi[k] = !shellUi[k] }
