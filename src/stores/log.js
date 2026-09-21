import { reactive } from 'vue'

// 底部「日志」窗格（仿 SATSOFT Log 面板）：全局事件流水，App.vue 渲染。
// 任意模块 import { logMsg } 即可追加；仅本窗口有效（跨 Electron 窗口的 store 实例互不共享）。
export const logStore = reactive({ items: [] })

const pad = (n) => String(n).padStart(2, '0')

export function logMsg(text, level = 'info') {
  const d = new Date()
  logStore.items.push({
    ts: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    text: String(text == null ? '' : text),
    level
  })
  // 上限 300 条，超出丢最旧（长时间运行不涨内存）
  if (logStore.items.length > 300) logStore.items.splice(0, logStore.items.length - 300)
}

export function clearLog() { logStore.items.length = 0 }

// ---- 搜索诊断（默认关）----
// 顶部命令搜索与侧栏卫星搜索的可疑时刻（下拉自动收起、命令表重建、登记方抛错、全量池换了一批）
// 平时一条都不写；开关打开后才落日志窗格。长时间挂机后再出问题，照着时间线就能自证是哪一条。
const DIAG_KEY = 'search-diag-v1'
export const diag = reactive({ on: false })
try { diag.on = localStorage.getItem(DIAG_KEY) === '1' } catch { /* ignore */ }
export function setDiag(v) { diag.on = !!v; try { localStorage.setItem(DIAG_KEY, diag.on ? '1' : '0') } catch { /* ignore */ } }
export function diagMsg(text) { if (diag.on) logMsg('[搜索] ' + text, 'info') }
