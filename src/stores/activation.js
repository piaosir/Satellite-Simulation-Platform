// 激活状态（渲染端，各窗口各持一份，经 preload 同源）。
// locked 的口径：有 IPC 通道（Electron 内）且已取到状态且未激活 → 锁。
// 浏览器直跑（npm run dev 的 renderer 单开、无 preload）没有 api.activation → 永不锁，
// 开发路径不受影响；打包版 preload 常在，锁由主进程 activation:status 决定。
import { reactive, computed } from 'vue'

export const activation = reactive({
  ready: false,        // 已取到一次状态（ready 前 UI 不上锁，避免启动闪锁；主进程 open 拦截兜底）
  active: false,
  state: 'none',       // none 无激活书 / active / expired 已到期 / revoked 已撤销
  plan: '',
  activatedAt: 0,
  expiresAt: 0,        // 0 = 永久
  deviceId: '',
  busy: false          // 刷新进行中（按钮态）
})

export const activationLocked = computed(() => activation.ready && !activation.active)

function apply(st) {
  if (!st || typeof st !== 'object') return
  activation.active = !!st.active
  activation.state = st.state || 'none'
  activation.plan = st.plan || ''
  activation.activatedAt = Number(st.activatedAt) || 0
  activation.expiresAt = Number(st.expiresAt) || 0
  activation.deviceId = st.deviceId || activation.deviceId
  activation.ready = true
}

let _inited = false
export function initActivation() {
  if (_inited) return
  _inited = true
  const api = window.api && window.api.activation
  if (!api) return                      // 浏览器直跑：保持 ready=false → 不锁
  // 先订阅后取快照，且快照只在「尚无任何状态」时应用——反过来会有毫秒级 race：
  // changed(新) 先到、status(旧一拍) 后到，把刚翻转的状态又盖回去
  api.onChanged(apply)
  api.status().then((st) => { if (!activation.ready) apply(st) }).catch(() => { /* IPC 未就绪，等 onChanged */ })
  // 显示层兜底自查：主进程 current() 是实时判定（撤销/到期翻转不依赖广播到达），每分钟
  // 主动拉一次 —— 即使 changed 广播被窗口 reload/时序错过（错过后「无变化不再广播」，
  // 快照会永远停在旧的激活态），显示最多 1 分钟自愈。纯本地 IPC，不碰网络。
  setInterval(() => { api.status().then(apply).catch(() => { /* 忽略 */ }) }, 60e3)
}

// 用户「刷新激活状态」特定动作：立即心跳 + 拉最新激活书。返回刷新后的状态对象。
export async function refreshActivation() {
  const api = window.api && window.api.activation
  if (!api || activation.busy) return activation
  activation.busy = true
  try { apply(await api.refresh()) } catch { /* 网络不可达：维持现状 */ }
  finally { activation.busy = false }
  return activation
}

// 状态一句话（状态栏 / 日志 / 遮罩共用）
export function activationText() {
  if (!activation.ready) return ''
  if (!activation.active) return activation.state === 'clock' ? '时钟异常' : '未激活'
  if (!activation.expiresAt) return '永久激活'
  const d = new Date(activation.expiresAt)
  const p = (n) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  // 48 小时内到期补上时分：分钟级授权只显示日期会被读成「当天有效」
  const near = activation.expiresAt - Date.now() < 48 * 3600e3
  return `激活至 ${day}${near ? ` ${p(d.getHours())}:${p(d.getMinutes())}` : ''}`
}

// 锁定界面标题（App.vue 锁窗 / ActivationLock 遮罩共用）
export function lockTitle() {
  return activation.state === 'clock' ? '时钟异常' : '未激活'
}
