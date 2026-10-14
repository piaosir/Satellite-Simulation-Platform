// 频率计划的历史版本（调研 A4）。留档口径与链路预算四窗的自动保存一致（shared/useConfigAutosave.js）：
//   · 打开一份计划后第一次真正写盘（内容确实变了）前，先把「打开时」那份留一档 —— 只翻看不改的不留；
//   · 此后连续编辑每满 10 分钟，写盘后留一档「自动」；
//   · 还原历史版本前，先把当前留一档「还原前」。
// 清单 / 取档 / 还原 / 创建副本直接复用 shared/useConfigVersions.js + components/LbVersionsDialog.vue：
// 「配置」= 一份计划（id 即计划 id），配置树 / 自动保存两件按它要的那几个口子各接一个转接头。
// 版本存在主进程 store:versions:*（versions/freqplan/<计划 id>.json，每份最多 30 档、与最新一档相同不重留）。
// ★ 主进程版本库按命名空间白名单收件：不认 'freqplan' 时 listVersions 会抛 —— 开窗探一次，探不通则
//   available=false：入口不出、留档静默跳过，计划的存取不受任何影响。
import { ref } from 'vue'
import { useConfigVersions } from '../shared/useConfigVersions.js'
import { fpHash, VERSION_EVERY_MS } from '../shared/useConfigAutosave.js'
import { stableStringify } from '../shared/configDirty.js'

export const FP_VERSION_NS = 'freqplan'

/**
 * @param {object} o
 * @param {object} o.api                 window.api
 * @param {import('vue').Ref<string>} o.currentId
 * @param {(id: string) => object|null} o.entryOf   计划索引里那一项 { id, name, … }
 * @param {() => object|null} o.stateNow  当前计划整份纯数据（与写盘同形：计划 + carriers）
 * @param {() => Promise<boolean>} o.saveNow  立即写盘，回是否落盘
 * @param {(state: object) => void} o.applyState  把一档内容装回编辑区（之后照常经深监听写盘、进撤销栈）
 * @param {(state: object) => Promise<any>} o.duplicate  用一档内容另建一份计划并打开
 * @param {(state: object) => ({ label: string }|null)} [o.summarize]
 * @param {(msg: string) => void} [o.toast]
 */
export function useFpVersions(o) {
  const { api, currentId, entryOf, stateNow, saveNow, applyState, duplicate } = o
  const summarize = o.summarize || (() => null)
  const toast = o.toast || (() => {})
  const now = o.now || (() => Date.now())
  const store = api && api.store
  const available = ref(false)
  let opened = null        // { id, state, fp, kept }：打开时那份
  let versionedAt = 0

  async function probe() {
    if (!store || !store.listVersions || !store.addVersion || !store.getVersion) { available.value = false; return false }
    try { available.value = Array.isArray(await store.listVersions(FP_VERSION_NS, '__probe__')) }
    catch (e) { available.value = false }
    return available.value
  }

  async function keep(id, kind, state, fp) {
    if (!available.value || !id || !state) return null
    const it = entryOf(id)
    let meta = null
    try { meta = summarize(state) || null } catch (e) { meta = null }
    try { return await store.addVersion(FP_VERSION_NS, id, { kind, name: it ? it.name : (state.name || ''), meta, hash: fpHash(fp), state }) }
    catch (e) { return null }   // 留档失败不拦写盘
  }

  /** 一份计划刚载入编辑区：记下「打开时」那份（第一次真写盘前才留档） */
  function attach() {
    const id = currentId.value
    const st = id ? stateNow() : null
    opened = st ? { id, state: st, fp: stableStringify(st), kept: false } : null
    versionedAt = 0
  }
  function detach() { opened = null }

  /** 每次写盘成功后调：state = 刚写下去的那一份 */
  async function afterSave(id, state) {
    if (!available.value || !opened || opened.id !== id || !state) return
    const fp = stableStringify(state)
    if (!opened.kept) {
      if (fp === opened.fp) return
      opened.kept = true
      versionedAt = now()
      await keep(id, 'open', opened.state, opened.fp)
      return
    }
    if (now() - versionedAt >= VERSION_EVERY_MS) {
      versionedAt = now()
      await keep(id, 'auto', state, fp)
    }
  }

  // —— 给 useConfigVersions 的两个转接头 ——
  const tree = {
    activeId: currentId,
    itemById: (id) => { const e = entryOf(id); return e ? { ...e, type: 'plan' } : null },
    createAndOpen: ({ state }) => duplicate(state)
  }
  const autosave = {
    flush: () => saveNow(),
    snapshot: async (kind = 'restore') => {
      const id = currentId.value
      const st = id ? stateNow() : null
      return st ? keep(id, kind, st, stableStringify(st)) : null
    }
  }
  const V = useConfigVersions({ ns: FP_VERSION_NS, api, tree, autosave, applyState, summarize, toast })

  // 只开当前这份的历史（还原别的计划要改写它的存盘，频率计划没有那条路）
  async function openVersions() {
    const id = currentId.value
    if (!id || !available.value) return
    await V.openVersions(id)
  }

  return { available, probe, attach, detach, afterSave, verDlg: V.verDlg, openVersions, restoreVersion: V.restoreVersion, duplicateVersion: V.duplicateVersion }
}
