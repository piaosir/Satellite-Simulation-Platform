// 性能指标表窗口 ⇄ 主窗口（3D 页）的桥。
//
// 弹窗只管界面：主窗口把状态【整字段】推过来（{type:'state', patch:{…}}），弹窗上的每个操作
// 发回主窗口（act），需要回话的（目标星搜索、取航迹航点）走 req / reply 配 reqId。
// 主进程只中继（electron/main.js 的 perfWin），两窗之间不共享任何响应式对象——推过来的都是纯数据。
//
// ★ 双向镜像的回声：弹窗把整份城市列表发给主窗口，主窗口落桶后又会把同一份推回来；反之亦然。
//   靠【内容签名】而不是标志位判回声（Vue 的 watcher 是异步冲刷的，标志位罩不住它）：
//   只记一个 hostSig＝据我们所知主窗口此刻持有的那份。收到的等于它 → 回声，不再应用；
//   本地变成等于它 → 是应用推送引起的（或主窗口本就是这份），不必发。见 useMirror。
import { reactive, ref, watch } from 'vue'

const api = typeof window !== 'undefined' && window.api ? window.api.perfWin : null

export function useBridge() {
  const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
  const self = { id: q.get('id') || '', kind: q.get('kind') || 'ground', key: q.get('key') || '' }
  const st = reactive({})              // 主窗口推来的状态：字段整份替换
  const connected = ref(false)         // 收到过第一份状态
  const pending = new Map()
  const handlers = new Map()
  let seq = 0
  if (api) {
    api.onMsg((m) => {
      if (!m || typeof m !== 'object') return
      if (m.type === 'state') {
        const p = m.patch || {}
        for (const k of Object.keys(p)) st[k] = p[k]
        connected.value = true
      } else if (m.type === 'reply') {
        const h = pending.get(m.reqId)
        if (h) { pending.delete(m.reqId); clearTimeout(h.timer); m.error ? h.reject(new Error(m.error)) : h.resolve(m.result) }
      } else {
        const fn = handlers.get(m.type)
        if (fn) fn(m)
      }
    })
  }
  // 出 IPC 前把载荷压成纯数据：Vue 的响应式代理过不了结构化克隆（invoke 会抛且静默）
  const plain = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)))
  function act(type, payload) { if (api) api.act({ type, payload: plain(payload) }) }
  function req(type, payload, timeoutMs = 20000) {
    if (!api) return Promise.resolve(null)
    const reqId = 'r' + (++seq)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(reqId); reject(new Error('timeout')) }, timeoutMs)
      pending.set(reqId, { resolve, reject, timer })
      api.act({ type, payload: plain(payload), reqId })
    })
  }
  function on(type, fn) { handlers.set(type, fn) }
  function ready() { act('ready') }
  return { self, st, connected, act, req, on, ready, hasApi: !!api }
}

// 双向镜像：主窗口推的字段 ⇄ 本地可编辑模型。
//   field   — st 上的字段名（主窗口推的）
//   sigOf   — 值 → 内容签名（两边按同一口径归一后比较）
//   apply   — 把推来的值落进本地模型
//   local   — () => 本地当前值（watch 源，深监听）
//   send    — 本地变化时发给主窗口（收 local 的值）
export function useMirror(st, field, { sigOf, apply, local, send }) {
  // hostSig：据我们所知主窗口此刻持有的那份的签名 —— 收到推送时记下，发出去时也记下（主窗口马上就是这份）。
  // ★ 必须是这一个变量，不能「上次收到的 / 上次发出的」各记各的：两个参照都会陈旧 —— 标记从矩形改成椭圆（发出）
  //   再改回矩形，矩形的签名等于最初收到的那份，被当成「应用推送引起的」吞掉，主窗口停在椭圆上；
  //   删一座城再撤销、勾选框关了再开，凡是改回初值的操作都一样丢。
  let hostSig = '', got = false
  watch(() => st[field], (v) => {
    if (v === undefined) return
    const s = sigOf(v)
    got = true
    if (s === hostSig) return       // 自己发出去的那份回来了（或主窗口重推了同一份）
    hostSig = s
    apply(v)
  }, { immediate: true })
  watch(local, (v) => {
    // ★ 主窗口那份还没到之前不许发：本地模型建出来的出厂默认值若先发出去，会把存盘的那份冲掉
    if (!got) return
    const s = sigOf(v)
    if (s === hostSig) return       // 应用推送引起的变化，或主窗口本就是这份
    hostSig = s
    send(v)
  }, { deep: true })
}

// 主窗口那边偶尔要把一段纯数据推到别的窗口：这里只提供签名工具，口径两边共用
export const sigJson = (v) => JSON.stringify(v == null ? null : v)
