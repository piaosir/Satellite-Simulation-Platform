// 弹窗自己的界面偏好（中缝高度这类不进页面快照的东西）：按名字落 localStorage，下次开同类窗口原样回来。
// 三扇表窗与主窗口同一 origin、共用一份 localStorage，键前缀 perfwin/ 与主窗口的键隔开。
import { ref, watch } from 'vue'

export function persistedRef(key, def, { min = -Infinity, max = Infinity } = {}) {
  const k = 'perfwin/' + key
  let v = def
  try {
    const raw = localStorage.getItem(k)
    if (raw != null) { const n = Number(raw); if (Number.isFinite(n)) v = Math.max(min, Math.min(max, n)) }
  } catch { /* 无存储：用默认值 */ }
  const r = ref(v)
  watch(r, (n) => { try { localStorage.setItem(k, String(n)) } catch { /* 配额满等忽略 */ } })
  return r
}
