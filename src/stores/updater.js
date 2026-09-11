// 自动更新状态（渲染端镜像；主进程 services/updater.js 是唯一真源，快照口径见 services/updaterState.js）。
// 「检查更新」对话框只读这份快照：打开时拉一次，此后随主进程 updater:changed 推送刷新。
// 浏览器直跑（无 preload）没有 api.updater → 视同开发模式 disabled。
import { reactive } from 'vue'

export const updater = reactive({
  ready: false,      // 已取到一次快照
  phase: 'idle',     // idle / disabled / checking / downloading / downloaded / latest / error
  current: '',
  latest: '',
  percent: 0,
  transferred: 0,
  total: 0,
  error: '',
  checkedAt: 0,
  busy: false        // 手动检查进行中（按钮态；主进程的 checking 事件到达前也算）
})

function apply(st) {
  if (!st || typeof st !== 'object') return
  updater.phase = st.phase || 'idle'
  updater.current = st.current || ''
  updater.latest = st.latest || ''
  updater.percent = Number(st.percent) || 0
  updater.transferred = Number(st.transferred) || 0
  updater.total = Number(st.total) || 0
  updater.error = st.error || ''
  updater.checkedAt = Number(st.checkedAt) || 0
  updater.ready = true
}

let _inited = false
export function initUpdater() {
  if (_inited) return
  _inited = true
  const api = window.api && window.api.updater
  if (!api) { updater.phase = 'disabled'; updater.ready = true; return }
  // 先订阅后取快照：反过来会有毫秒级 race，changed(新) 先到、state(旧一拍) 后到把新状态盖回去
  api.onChanged(apply)
  api.state().then((st) => { if (!updater.ready) apply(st) }).catch(() => { /* IPC 未就绪，等 onChanged */ })
}

// 用户点「检查更新」：立即检查，返回检查结束后的快照（下载进度随后经 onChanged 推送）
export async function checkUpdate() {
  const api = window.api && window.api.updater
  if (!api || updater.busy) return updater
  updater.busy = true
  try { apply(await api.check()) } catch { /* 主进程异常：维持现状 */ }
  finally { updater.busy = false }
  return updater
}

// 「立即重启安装」：只在 downloaded 时有效。成功即程序退出、安装器接手，返回值只在失败时有意义
export async function installUpdate() {
  const api = window.api && window.api.updater
  if (!api) return false
  try { return !!(await api.install()) } catch { return false }
}
