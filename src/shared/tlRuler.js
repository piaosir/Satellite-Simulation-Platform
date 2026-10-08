// 时间轴刻度尺 v3（精密仪器）的排布计算 —— 纯函数，取宽 / 时区 / 吸附都由调用方注入（o.lw / o.parts / o.snapX …）。
// 原在 ConstellationMap3D.vue 里；时段放开到 100 年后补了「日历档」（月 / 年），挪出来单独维护。
//
// 标签贴在各自刻线右侧 3px；刻度分三级（带字长刻线 / 6px 次刻 / 3px 细刻），只靠长短与灰阶区分。
// 主步长按【实测字宽】取（界面字体用户可改，不能按字符数估），标签最小间距 56px；多级格式同 OpenMCT / d3 多尺度：
//   秒档：主步长 ≥ 1 天或逢该档位午夜 → MM-DD（日界；逢元旦写年份 YYYY），否则 ≥ 1 min → HH:MM，否则 HH:MM:SS；
//   日历档（秒档最大 7 天仍放不下时接上）：月档 → YYYY-MM（逢一月为年界），年档 → YYYY。
// 日历档的刻度落在显示时区的月初 / 年初零点（月长不定，不能按固定秒数走）。

export const NICE = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 14400, 21600, 43200, 86400, 172800, 345600, 604800]   // 「整齐」刻度阶梯(秒)；10800 = 3h 档
// 日历档（月数）：1/2/3/6 个月 → 1/2/5/10/20/50/100/200/500/1000 年
export const CAL_MO = [1, 2, 3, 6, 12, 24, 60, 120, 240, 600, 1200, 2400, 6000, 12000]
export const LAB_PAD = 3, LAB_GAP = 6, FLIP_GAP = 16, LAB_MIN_STEP = 56, MID_MIN_PX = 14, TINY_MIN_PX = 6, TXT_CLEAR = 3, PIN_CLEAR = 4
// 日历档一格「最短」有多长（选档按最挤的那一格算，标签永不相撞）：k 个月 ≥ 28k 天（2 月 59、3 月 89、6 月 181 都够），年按 365 天
const calMinSec = (mo) => (mo < 12 ? mo * 28 : (mo / 12) * 365) * 86400

// 月序号区间 [leftMs, rightMs] 内、按 stepMo 对齐的月初 / 年初零点（显示时区）
function calTicks(leftMs, rightMs, stepMo, o) {
  const q = o.parts(leftMs)
  let idx = Math.floor((q.y * 12 + q.mo - 1) / stepMo) * stepMo
  const out = []
  for (let g = 0; g < 2000; g++, idx += stepMo) {
    const Y = Math.floor(idx / 12), M = idx - Y * 12 + 1
    const t = o.dateMs(Y, M, 1)
    if (!Number.isFinite(t) || t > rightMs) break
    if (t >= leftMs) out.push({ t, Y, M })
  }
  return out
}

// o: { anchorMs, wStart, wMin, W, hp, snapX, tzOffMin(ms), parts(ms)→{y,mo,d,h,mi,s}, dateMs(Y,Mo,D)→ms, lw(s), nowX|null, pinX|null, tagSides: [] | ['r','l'] | ['l'] | ['r'], tagW }
// 返回 { labels:[{x,label,day,flip,st}], poles:[{x,day}], majors:[x], mids:[x], tinies:[x], tag:'l'|'r'|null }，x 均已落整设备像素
export function computeRuler(o) {
  const { W } = o, p2 = (n) => String(n).padStart(2, '0')
  const span = o.wMin * 60, leftMs = o.anchorMs + o.wStart * 60000, rightMs = leftMs + span * 1000
  // 以左边缘所在日的午夜为对齐基准。★必须跟着 tzMode 走（UTC / 固定偏移档下按本地午夜对齐，刻度落在碎数上）
  const off = o.tzOffMin(leftMs) * 60000, d0 = new Date(leftMs + off)
  const epoch = (Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate()) - off) / 1000
  const start = leftMs / 1000 - epoch, end = start + span, pps = W / span
  const need = (w) => Math.max(w + LAB_PAD + 12, LAB_MIN_STEP)
  const pick = (w) => NICE.find((s) => s * pps >= need(w))
  let main = pick(o.lw('00:00'))
  if (main != null && main < 60) main = pick(o.lw('00:00:00'))
  const px = (t) => o.snapX((t - start) * pps)
  const pxMs = (ms) => o.snapX((ms - leftMs) / 1000 * pps)
  const on = (t, s) => Math.abs(t / s - Math.round(t / s)) < 1e-9
  const cands = []
  let mids = [], tinies = []
  if (main != null) {
    // —— 秒档（原样）——
    const div = (m, minPx) => { for (let i = NICE.indexOf(m) - 1; i >= 0; i--) { const s = NICE[i]; if (m % s === 0 && s * pps >= minPx && m / s <= 6) return s } return 0 }
    const mid = div(main, MID_MIN_PX), tiny = div(mid || main, TINY_MIN_PX)
    for (let t = Math.ceil(start / main) * main; t <= end + 1e-6; t += main) {
      const x = px(t)
      if (x < 0 || x > W) continue
      const q = o.parts((epoch + t) * 1000), day = q.h === 0 && q.mi === 0 && q.s === 0
      const label = day && q.mo === 1 && q.d === 1 ? String(q.y)
        : main >= 86400 || day ? `${p2(q.mo)}-${p2(q.d)}` : main >= 60 ? `${p2(q.h)}:${p2(q.mi)}` : `${p2(q.h)}:${p2(q.mi)}:${p2(q.s)}`
      cands.push({ x, label, day, w: o.lw(label) })
    }
    if (mid) for (let t = Math.ceil(start / mid) * mid; t <= end + 1e-6; t += mid) if (!on(t, main)) mids.push(px(t))
    if (tiny) for (let t = Math.ceil(start / tiny) * tiny; t <= end + 1e-6; t += tiny) if (!on(t, mid || main)) tinies.push(px(t))
  } else {
    // —— 日历档：月 / 年 ——
    const wM = o.lw('0000-00'), wY = o.lw('0000')
    const cm = CAL_MO.find((m) => calMinSec(m) * pps >= need(m < 12 ? wM : wY)) || CAL_MO[CAL_MO.length - 1]
    const cdiv = (m, minPx) => { for (let i = CAL_MO.indexOf(m) - 1; i >= 0; i--) { const s = CAL_MO[i]; if (m % s === 0 && calMinSec(s) * pps >= minPx && m / s <= 6) return s } return 0 }
    const mid = cdiv(cm, MID_MIN_PX), tiny = cdiv(mid || cm, TINY_MIN_PX)
    for (const k of calTicks(leftMs, rightMs, cm, o)) {
      const x = pxMs(k.t)
      if (x < 0 || x > W) continue
      const label = cm < 12 ? `${k.Y}-${p2(k.M)}` : String(k.Y)
      cands.push({ x, label, day: cm < 12 && k.M === 1, w: o.lw(label) })
    }
    const onCal = (k, s) => ((k.Y * 12 + k.M - 1) % s + s) % s === 0
    if (mid) for (const k of calTicks(leftMs, rightMs, mid, o)) if (!onCal(k, cm)) mids.push(pxMs(k.t))
    if (tiny) for (const k of calTicks(leftMs, rightMs, tiny, o)) if (!onCal(k, mid || cm)) tinies.push(pxMs(k.t))
    // 月档再往下没有日历细分：一天 ≥ 6px 时逐日补细刻（日界都落在零点，与月界自然对齐）
    if (!tiny && cm < 12 && 86400 * pps >= TINY_MIN_PX) {
      const q = o.parts(leftMs)
      for (let i = 0; i < 400; i++) {
        const t = o.dateMs(q.y, q.mo, q.d + i)
        if (!Number.isFinite(t) || t > rightMs) break
        if (t < leftMs) continue
        if (o.parts(t).d !== 1) tinies.push(pxMs(t))
      }
    }
  }
  // 障碍：此刻线（含停在此刻时与它重合的游标）、实时档钉在 25% 的游标 —— 字与它们至少隔 3 / 4px，线永不穿字
  const obs = []
  if (o.nowX != null) obs.push([o.nowX - TXT_CLEAR, o.nowX + o.hp + TXT_CLEAR])
  if (o.pinX != null) obs.push([o.pinX - PIN_CLEAR, o.pinX + PIN_CLEAR])
  // taken: [左, 右, 左侧须留的空]。翻到刻线左侧的日界标签左边多留（FLIP_GAP）：否则「12:00  09-24|」读成一个时刻
  const taken = []
  const clearOf = (a, b, gapL) => taken.every(([l, r, gl]) => b + Math.max(LAB_GAP, gl) <= l || a - gapL >= r)
  const free = (a, b, gapL = LAB_GAP) => a >= 0 && b <= W && obs.every(([l, r]) => b <= l || a >= r) && clearOf(a, b, gapL)
  const labels = [], poles = [], majors = []
  const put = (c, side) => labels.push({ x: c.x, label: c.label, day: c.day, flip: side === 'l',
    st: side === 'l' ? { right: (W - c.x + LAB_PAD) + 'px' } : { left: (c.x + LAB_PAD) + 'px' } })
  // ① 日界：先右；右边被此刻 / 钉住的游标 / 右端占了就翻到刻线左侧；两边都不行才不写字 —— 日界刻线无论如何保持全高
  for (const c of cands) {
    if (!c.day) continue
    const R = [c.x + LAB_PAD, c.x + LAB_PAD + c.w], L = [c.x - LAB_PAD - c.w, c.x - LAB_PAD]
    const side = free(R[0], R[1]) ? 'r' : free(L[0], L[1], FLIP_GAP) ? 'l' : null
    if (side) { taken.push(side === 'r' ? [R[0], R[1], LAB_GAP] : [L[0], L[1], FLIP_GAP]); put(c, side) }
    poles.push({ x: c.x, day: true })
  }
  // ② 其余主刻：只挂右侧；放不下就退成 10px 短主刻
  for (const c of cands) {
    if (c.day) continue
    const R = [c.x + LAB_PAD, c.x + LAB_PAD + c.w]
    if (free(R[0], R[1])) { taken.push([R[0], R[1], LAB_GAP]); put(c, 'r'); poles.push({ x: c.x, day: false }) }
    else majors.push(c.x)
  }
  // ③「此刻」最后放、只让不抢：刻度标签一个都不因它挪动（它换边 / 隐现时尺上别的字纹丝不动）
  let tag = null
  if (o.nowX != null) {
    const n = o.nowX, box = { r: [n + o.hp + LAB_PAD, n + o.hp + LAB_PAD + o.tagW], l: [n - LAB_PAD - o.tagW, n - LAB_PAD] }
    for (const s of o.tagSides) { const [a, b] = box[s]; if (a >= 0 && b <= W && clearOf(a, b, LAB_GAP)) { tag = s; break } }
  }
  return { labels, poles, majors, mids, tinies, tag }
}
