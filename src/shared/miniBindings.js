// 已绑定的小程序账号（渲染端 ESM；设置页与「发送到小程序」弹窗共用）。
//
// 存在 settings.json 的 miniBindings 键里 —— 与「我的ID」(deviceId) 同一份设置，跟着这台机器走。
// 一条 = 一个小程序账号的收件地址：
//   { ch 认证码(12位), name 备注名, addedAt, lastSentAt, lastCount }
//
// ★ 认证码由【小程序端】生成，平台只是记下来。方向不能反：通道是单向的（平台能写 COS，
//   小程序只能读），若由平台出码让小程序扫，平台就永远不知道谁扫了、扫了几个 —— 也就做不到
//   「绑定多个账号、分别投递」。让小程序出码、人肉带过来，平台手里才有一份真实的收件人清单。
// ★★ 认证码即凭证。它不是密码，泄露的后果是「别人能往这个账号投东西 / 能读到投过去的东西」，
//    所以小程序侧必须留「重置认证码」这条路（重置 = 换收件地址，各平台需重新绑）。

import { isCh, normalizeCh } from './miniPack.js'

const KEY = 'miniBindings'

const clean = (b) => ({
  ch: normalizeCh(b && b.ch),
  name: String((b && b.name) || '').slice(0, 40),
  addedAt: Number((b && b.addedAt) || 0) || 0,
  lastSentAt: Number((b && b.lastSentAt) || 0) || 0,
  lastCount: Number((b && b.lastCount) || 0) || 0
})

/** 读绑定列表。设置读不到（未在桌面端运行）时返回空数组，不抛。 */
export async function loadBindings(api) {
  try {
    const s = await (api && api.store && api.store.getSettings ? api.store.getSettings() : null)
    const raw = s && Array.isArray(s[KEY]) ? s[KEY] : []
    return raw.map(clean).filter((b) => isCh(b.ch))
  } catch (e) { return [] }
}

/** 整体写回（去重：同一个认证码只留一条，后来的覆盖先前的备注名）。返回落库后的列表。 */
export async function saveBindings(api, list) {
  const seen = new Map()
  for (const b of Array.isArray(list) ? list : []) {
    const c = clean(b)
    if (!isCh(c.ch)) continue
    const prev = seen.get(c.ch)
    // 合并时保住投递记录：新加的那条没有 lastSentAt，别把历史抹了
    seen.set(c.ch, prev ? { ...prev, ...c, lastSentAt: Math.max(prev.lastSentAt, c.lastSentAt) } : c)
  }
  const next = [...seen.values()]
  try { await api.store.setSettings({ [KEY]: next }) } catch (e) { /* 设置写不进去时只影响持久化 */ }
  return next
}

/**
 * 加一条。已存在同码则只更新备注名（不重复添加，也不清掉投递记录）。
 * @returns {Promise<{ok:boolean, list:Array, error?:string, dup?:boolean}>}
 */
export async function addBinding(api, rawCh, name) {
  const ch = normalizeCh(rawCh)
  if (!isCh(ch)) return { ok: false, list: await loadBindings(api), error: '认证码应为 12 位（小程序「设置 → 仿真平台绑定」里复制）' }
  const list = await loadBindings(api)
  const at = list.findIndex((b) => b.ch === ch)
  const dup = at >= 0
  if (dup) list[at] = { ...list[at], name: String(name || list[at].name || '').slice(0, 40) }
  else list.unshift({ ch, name: String(name || '').slice(0, 40), addedAt: Date.now(), lastSentAt: 0, lastCount: 0 })
  return { ok: true, dup, list: await saveBindings(api, list) }
}

export async function removeBinding(api, ch) {
  const c = normalizeCh(ch)
  return saveBindings(api, (await loadBindings(api)).filter((b) => b.ch !== c))
}

export async function renameBinding(api, ch, name) {
  const c = normalizeCh(ch)
  return saveBindings(api, (await loadBindings(api)).map((b) => (b.ch === c ? { ...b, name: String(name || '').slice(0, 40) } : b)))
}

/** 投递成功后记一笔（设置页显示「上次投递」）。失败不影响投递本身，故吞掉异常。 */
export async function markSent(api, chs, count) {
  try {
    const set = new Set((Array.isArray(chs) ? chs : []).map(normalizeCh))
    if (!set.size) return
    const now = Date.now()
    await saveBindings(api, (await loadBindings(api)).map((b) => (
      set.has(b.ch) ? { ...b, lastSentAt: now, lastCount: Number(count) || 0 } : b
    )))
  } catch (e) { /* 记账失败无所谓 */ }
}
