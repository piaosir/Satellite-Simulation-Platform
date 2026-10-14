// 时间轴事件层：画在刻度尺上的区间 / 时刻标记（过境窗口、计算窗口推来的 t*、日凌窗口、星间距离极值……）。
// 单击标记 = 把仿真时钟拨到它的起点；Ctrl+← / Ctrl+→ 在标记之间跳；右键出菜单（跳到起点 / 终点、清除这一类 = 同 src）。
// 只存内存：分析结果重算即重建，计算窗口重推即覆盖（同 src + label 覆盖）。
import { reactive } from 'vue'

const MAX = 500
export const tlMarks = reactive({ list: [] })   // [{ id, src, label, t0, t1 }]，t1 = null 为时刻点
let _id = 0

const norm = (src, it) => {
  const t0 = Number(it && it.t0), t1raw = it && it.t1 != null ? Number(it.t1) : null
  if (!Number.isFinite(t0)) return null
  const t1 = t1raw != null && Number.isFinite(t1raw) && t1raw > t0 ? t1raw : null
  return { id: ++_id, src: String(src || ''), label: String((it && it.label) || '').slice(0, 120), t0, t1 }
}
const cap = (L) => (L.length > MAX ? L.slice(L.length - MAX) : L)

/** 整类替换：src 下原有的全部换成 items（[{label,t0,t1?}]） */
export function setMarks(src, items) {
  const keep = tlMarks.list.filter((m) => m.src !== src)
  const add = (items || []).map((it) => norm(src, it)).filter(Boolean)
  tlMarks.list = cap(keep.concat(add))
}
/** 单条覆盖：同 src + label 的旧条目换成这一条 */
export function upsertMark(src, label, t0, t1) {
  const m = norm(src, { label, t0, t1 }); if (!m) return
  tlMarks.list = cap(tlMarks.list.filter((x) => !(x.src === m.src && x.label === m.label)).concat([m]))
}
export function clearMarks(src) { tlMarks.list = src ? tlMarks.list.filter((m) => m.src !== src) : [] }

/** 从时刻 t 起往前 / 往后最近的一个标记起点（dir = ±1）；没有返回 null */
export function adjacentMarkMs(t, dir) {
  let best = null
  for (const m of tlMarks.list) {
    const x = m.t0
    if (dir > 0 ? x > t + 500 : x < t - 500) {
      if (best == null || (dir > 0 ? x < best : x > best)) best = x
    }
  }
  return best
}
