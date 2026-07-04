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
