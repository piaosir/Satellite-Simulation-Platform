// 叠加星历（导入星历时「对应已有卫星」）的渲染端装配：主进程的对应关系 + 采样表 → satPos 的注册表。
//
// 主进程 customSats.bindings() 给出全部对应关系（新导入的在前）：{ noradId（目标）, groupId, key, … }。
// 表本身由宿主按组取（3D 页复用它的点序列表缓存，不为叠加再拉一遍 IPC）。同一目标挂多张表时保持「新导入的在前」，
// 取位时逐张查、落在谁的时段内用谁，都不在才回落本体（见 satPos.posAt）。
//
// 表上另挂 ovlInfo（组名 / 星名 / 格式 / 时段）：信息栏「星历源」读数直接从供位的那张表上取。

import { setOverlays, normId } from './satPos.js'

/**
 * bindings：customSats.bindings() 的结果；tableOf(groupId, key) → Promise<取位表 | null>
 * 返回 { map: Map<NORAD, [表…]>, count, version }（已灌进 satPos）
 */
export async function applyEphemOverlays(bindings, tableOf) {
  const map = new Map()
  let count = 0
  for (const b of (Array.isArray(bindings) ? bindings : [])) {
    const id = normId(b && b.noradId)
    if (!id) continue
    let tab = null
    try { tab = await tableOf(b.groupId, b.key) } catch { tab = null }
    if (!tab || !tab.__ephem) continue
    tab.ovlInfo = { groupId: b.groupId, groupName: b.groupName || '', key: b.key, satName: b.satName || '', format: b.format || '', t0: tab.t0, t1: tab.t1, target: id, targetName: b.name || '' }
    if (!map.has(id)) map.set(id, [])
    map.get(id).push(tab)
    count++
  }
  const version = setOverlays(map)
  return { map, count, version }
}

export default { applyEphemOverlays }
