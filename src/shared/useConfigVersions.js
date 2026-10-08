// 配置的历史版本（链路预算四窗；自动保存的后悔药，留档口径见 useConfigAutosave.js）。
// 窗口只交：命名空间、配置树（useConfigTree 的返回）、自动保存实例、applyState、版本读数函数。
// 对话框是 components/LbVersionsDialog.vue（它自己按 id 取清单 / 取整份 state，这里只接它回传的那一版）。
//   · 打开对话框：看的是当前配置时，先把没落盘的改动写进去——清单里最新那一档才与屏幕一致；
//   · 「还原」当前配置：先留一档「还原前」，再把那一版载入工作区并当场写盘（还原本身也能再还原回来）；
//     「还原」别的配置：先给它的存档留一档「还原前」，再直接改写它的存档，工作区不动；
//   · 「创建副本」：用那一版内容在原配置之后新建一份（名字 = 原名 + 副本，钉死），并打开它。
import { reactive } from 'vue'
import { copyNameOf } from './lbAutoName.js'
import { fpHash } from './useConfigAutosave.js'
import { stableStringify } from './configDirty.js'

export function useConfigVersions(o) {
  const {
    ns, api, tree, autosave, applyState,
    summarize = () => null,            // (state) => { label }
    fingerprint = stableStringify,
    toast = () => {}
  } = o
  const dlg = reactive({ open: false, id: null, name: '' })
  const plain = (s) => JSON.parse(JSON.stringify(s))

  async function openVersions(id) {
    const c = tree.itemById(id)
    if (!c || c.type === 'folder' || !api) return
    if (id === tree.activeId.value) await autosave.flush()
    dlg.id = id; dlg.name = c.name; dlg.open = true
  }

  async function restoreVersion({ state }) {
    const id = dlg.id
    dlg.open = false
    if (!id || !state) return
    const st = plain(state)
    if (id === tree.activeId.value) {
      await autosave.flush()
      await autosave.snapshot('restore')
      applyState(st)
      toast((await autosave.flush()) ? '已还原历史版本' : '已还原历史版本，但未能写入磁盘')
      return
    }
    const c = tree.itemById(id)
    if (c && c.state) {
      let meta = null
      try { meta = summarize(c.state) || null } catch (e) { meta = null }
      try { await api.store.addVersion(ns, id, { kind: 'restore', name: c.name, meta, hash: fpHash(fingerprint(c.state)), state: plain(c.state) }) } catch (e) { /* 留档失败不拦还原 */ }
    }
    let r = null
    try { r = await api.store.updateConfigState(ns, id, { state: st }) } catch (e) { r = { ok: false, error: (e && e.message) || String(e) } }
    if (r && r.ok) {
      const cur = tree.itemById(id) || c   // 按 id 重取：两次 await 期间配置树可能整表重读，c 已是旧对象
      if (cur) { cur.state = st; if (r.updatedAt) cur.updatedAt = r.updatedAt }
      toast('已还原历史版本')
    } else toast('还原失败：' + ((r && (r.error || (r.locked && '软件未激活'))) || '配置已不存在'))
  }

  async function duplicateVersion({ state }) {
    const c = tree.itemById(dlg.id)
    dlg.open = false
    if (!c || !state) return
    await tree.createAndOpen({ state: plain(state), name: copyNameOf(c.name), nameAuto: false, parentId: c.parentId != null ? c.parentId : null, anchorId: c.id })
  }

  return { verDlg: dlg, openVersions, restoreVersion, duplicateVersion }
}
