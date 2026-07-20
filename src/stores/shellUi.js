import { reactive, watch } from 'vue'

// 壳层 UI 状态（本地记忆）：
//  - side：侧栏当前视图（VS Code 活动栏范式，同屏只显示一个视图；'' = 侧栏收起）
//          'constellation' 星座 | 'antenna' 卫星天线树 | 'beams' 波束合成 | 'poly' Polygon | 'gxt' 覆盖图 | 'markers' 标记 | 'geo' 地图设置
//  - toolbar / log：图标工具栏、底部日志窗格显隐
//  - exw：侧栏宽度（px）
// 单独成 store：3D 页的 Teleport（把各视图挂入侧栏）需要感知 side。
// KEY 带版本号：日志窗格默认改为收起前，早期版本可能已把 log:true 存进旧 key，
// 不换 key 的话旧用户会一直读到那个 true，看起来像「默认没生效」。
const KEY = 'shell-ui-v2'
const SIDES = ['constellation', 'antenna', 'beams', 'poly', 'gxt', 'markers', 'geo']
export const shellUi = reactive({ toolbar: true, log: false, side: 'constellation', exw: 300 })
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || 'null')
  if (saved && typeof saved === 'object') {
    for (const k of ['toolbar', 'log']) if (typeof saved[k] === 'boolean') shellUi[k] = saved[k]
    if (saved.side === '' || SIDES.includes(saved.side)) shellUi.side = saved.side
    else if (saved.explorer === false) shellUi.side = ''   // 旧版「资源管理器」布尔量迁移
    if (Number.isFinite(saved.exw)) shellUi.exw = Math.max(240, Math.min(420, saved.exw))
  }
} catch { /* ignore */ }
watch(shellUi, () => { try { localStorage.setItem(KEY, JSON.stringify(shellUi)) } catch { /* ignore */ } }, { deep: true })

export function toggleUi(k) { shellUi[k] = !shellUi[k] }
