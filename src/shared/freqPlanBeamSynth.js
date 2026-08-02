// 波束合成草图读取（频率计划窗口）。同 freqPlanSats：独立窗口与主窗口同 origin，
// 直读 localStorage 'globe3d/beamSynth'（v2 嵌套：卫星 ▸ 波束组 ▸ 波束），不走 IPC。
//
// ★ 频率计划这边要的只有两样东西：【波束代号】与【它的频率复用色号】。
//   波束合成负责几何（哪个波束在哪、谁与谁同色 —— 同色 = 同频同极化，是复用图案本身），
//   频率计划负责频率（这一条占哪一段、多宽）。故这里只把代号与色号摘出来，波束的经纬度、
//   宽度、设置一概不带过来 —— 带过来就成了同一份几何在两处各存一份。
// ★★ **同色合并成一条**：一个色覆盖一批波束是复用图案的常态，而这一批在频率上是同一件事
//   （同一段频率、同一个极化）。分成几条会让同一段频率在表里出现几遍，改一处得改几处。
//
// ★★ 波束号 = 【整星连续编号】，与 3D 页草图上画的那个数、波束信息表里的「编号」同一套：
//   同一颗星下各组按存储次序首尾相接编号（第 2 组的第 1 个波束接着第 1 组的最后一个往下数）。
//   3D 页那处还会按「可见组」（激活 + 常显）过滤，那是一个显示态；跟着它走会让导进来的号随
//   开关变，故这里恒按该星【全部有波束的组】编号。
//
// 赋形组（shaped / 相控阵赋形）没有离散波束，不参与编号也不出现在列表里。

import { fcCss } from './freqReuseColors.js'

const KEY = 'globe3d/beamSynth'

function readGroups() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null')
    return d && typeof d === 'object' && d.v >= 2 && Array.isArray(d.groups) ? d.groups : []
  } catch { return [] }
}

// 参与编号的组 = 有放置波束的那些（与 3D 页 visibleGroups 的类型判据同口径，只是不看「可见」）
const hasBeams = (g) => g && (g.mode === 'gauss' || (g.mode === 'pam' && (g.p || {}).pamCover !== 'shaped'))

/**
 * 全部波束组：[{ id, satFolder, name, mode, beamCount, uncolored, entries, colors }]
 *   entries —— 导进去就是几条：**同色的波束合并成一条**（同色 = 同频同极化，频率上是一件事），
 *              未配色的逐个成条。[{ fc, css, beamId, nos }]：nos = 这一条覆盖的波束代号
 *              （整星连续编号，升序）；fc = 色号（0 基，未配色为 null）；
 *              beamId = 未配色那种的配对键（按色合并的用 fc 配对，beamId 为空）。
 *   colors  —— [{ fc, css, count }]：该组用到的色，按色号升序 —— 只给列表上那排色片用
 *   uncolored —— 还没配色的波束数（波束合成里没跑过「自动分配」的那些）
 */
export function loadSynthGroups() {
  const out = []
  const off = new Map()                     // satFolder → 该星已编号的波束数
  for (const g of readGroups()) {
    if (!hasBeams(g)) continue
    const sat = g.satFolder || ''
    const base = off.get(sat) || 0
    const raw = Array.isArray(g.beams) ? g.beams : []
    off.set(sat, base + raw.length)
    const byColor = new Map()               // fc → [代号]
    const alone = []                        // 未配色的那几个
    raw.forEach((b, i) => {
      const no = base + i + 1
      const n = Number(b && b.fc)
      const fc = Number.isInteger(n) && n >= 0 ? n : null
      if (fc == null) { alone.push({ fc: null, css: null, beamId: String((b && b.id) || ''), nos: [no] }); return }
      if (!byColor.has(fc)) byColor.set(fc, [])
      byColor.get(fc).push(no)
    })
    const colors = [...byColor.entries()].sort((a, b) => a[0] - b[0])
    out.push({
      id: String(g.id || ''),
      satFolder: sat,
      name: g.name || '波束组',
      mode: g.mode === 'pam' ? 'pam' : 'gauss',
      beamCount: raw.length,
      uncolored: alone.length,
      // 按色的排前面（色号升序），未配色的按代号跟在后面
      entries: colors.map(([fc, nos]) => ({ fc, css: fcCss(fc), beamId: '', nos })).concat(alone),
      colors: colors.map(([fc, nos]) => ({ fc, css: fcCss(fc), count: nos.length }))
    })
  }
  return out
}
