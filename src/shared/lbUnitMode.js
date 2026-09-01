// 结果显示单位的档位（GSO / NGSO / 再生式 / 端到端 四窗共享，功能区「单位」组）。
//
// 两档：
//   锁定（出厂默认）—— 一律按引擎基准单位显示（W / kHz / kbps / dBW），数值大小不改单位；
//   自适应          —— 按数值大小换档（0.5 W → 500 mW、2457.6 kHz → 2.4576 MHz、整组 <0 dBW → dBm）。
//
// 出厂锁定的理由：录进去的是 W 与 kHz，核对结果时同一个量换了单位就得先心算一次；且档位是按
// 本批数值挑的（整列共选），同一列换一批链路就可能换个单位，两次结果并排看单位对不上。
// 要「500 mW 比 0.5 W 好读」的场合再切自适应。
//
// 作用范围＝原本走单位自适应的那一整套显示：链路表结果列与本行读数、详细预算瀑布（core 的
// adaptSegments，经 waterfall IPC 的 ctx.adaptUnits 传下去）、TSV 复制、交付级报告的汇总行与
// 详表、功放尾标与配平残差。**不含自动命名**（资源库条目名是数据，不该随一个显示开关改写，
// 见 lbAutoName.js / carrierRate.js 里显式传 true 的那两处）。
//
// 值走 localStorage（四窗同源）+ storage 事件跨窗同步（storage 只发给别的窗口，本窗切换靠订阅表）。

const KEY = 'lb/unitAdaptive'
const subs = new Set()
let cur = null      // 进程内缓存：每个数据格显示都要问一次，不能每次读 localStorage
let hooked = false

function read() {
  try { return localStorage.getItem(KEY) === '1' } catch (e) { return false }
}

// 当前是否自适应；出厂 false（锁定）
export function isUnitAdaptive() {
  if (cur === null) cur = read()
  return cur
}

export function setUnitAdaptive(v) {
  const b = !!v
  cur = b
  try { localStorage.setItem(KEY, b ? '1' : '0') } catch (e) { /* ignore */ }
  notify(b)
  return b
}

function notify(b) {
  for (const fn of Array.from(subs)) { try { fn(b) } catch (e) { /* 一个订阅者出错不拖累其余 */ } }
}

// 订阅档位变化（本窗切换 + 别的链路预算窗改动）；返回退订函数，组件 onBeforeUnmount 调用
export function onUnitModeChange(fn) {
  subs.add(fn)
  if (!hooked && typeof window !== 'undefined') {
    hooked = true
    window.addEventListener('storage', (e) => {
      if (e.key !== KEY) return
      const b = read()
      if (b === cur) return
      cur = b
      notify(b)
    })
  }
  return () => { subs.delete(fn) }
}
