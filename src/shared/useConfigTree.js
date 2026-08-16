// 配置列表树的操作层（五个工作台共用：GEO / NGSO / 再生式 / 端到端 / 雨衰）。
//
// 由来：这套逻辑原本在五个 App 里各抄了一份，于是同一件事有五种成色 ——
// 端到端那份漏了剪贴板与右键菜单、onMove 还把 dragId 原样透传给期待 id 的 IPC（拖拽整个失效），
// 另外三份则一致地缺「剪切文件夹」。收进一处后，改一次五窗同得。
//
// 分工：本模块只管【树本身】（增删改移、剪贴板、焦点、键盘、右键菜单状态）。
// 各窗自己的东西经 opts 注入：场景怎么序列化（serializeState/applyState）、脏态怎么判、
// 离开前怎么问（guardedLeave）、确认框长什么样（askConfirm）。
//
// ★ 存储已按工作台分家（configs.<ns>.json，见 electron/services/storage.js）：
//   listConfigs(ns) 拿到的就是本窗全部条目，不必再按 orbitType 过滤。
//   但配置的 state.orbitType 仍要照写 —— 瀑布表/报表按它分体制，那是另一件事。
import { ref, reactive, computed, shallowRef, nextTick } from 'vue'
import { newCfgName, newFolderName, copyNameOf } from './lbAutoName.js'

// 扁平数组 → 可见行（深度优先，折叠的文件夹不展开其子）。
// ConfigTree.vue 的渲染与这里的键盘导航必须走同一份，否则「↓ 到下一行」会跟眼睛看到的对不上。
export function flattenTree(items, expanded) {
  const list = items || []
  const ids = new Set(list.map((i) => i.id))
  const childrenOf = new Map()
  const roots = []
  for (const it of list) {
    const p = (it.parentId != null && ids.has(it.parentId)) ? it.parentId : null   // 孤儿容错
    if (p == null) roots.push(it)
    else { if (!childrenOf.has(p)) childrenOf.set(p, []); childrenOf.get(p).push(it) }
  }
  const out = []
  const walk = (arr, depth) => {
    for (const it of arr) {
      const kids = childrenOf.get(it.id) || []
      const isFolder = it.type === 'folder'
      out.push({ item: it, depth, isFolder, childCount: kids.length })
      if (isFolder && kids.length && expanded.has(it.id)) walk(kids, depth + 1)
    }
  }
  walk(roots, 0)
  return out
}

export function useConfigTree(opts) {
  const {
    ns,                     // 配置库命名空间：'geo' | 'ngso' | 'regen' | 'e2e' | 'rain'
    orbitType,              // 文件夹项上写的体制标记（过滤已不依赖它，留作回滚兜底与人工辨识）
    api,                    // window.api（浏览器里为 null：全部操作提示「需在桌面客户端中运行」）
    storageKey,             // 展开集的 localStorage 键
    toast = () => {},
    blankState,             // () => state：新建空白配置的内容
    serializeState,         // () => state：把当前工作区存下来
    applyState,             // (state) => void：把配置载入工作区
    setBaseline = () => {}, // () => void：重置脏态基线
    guardedLeave = async () => true,   // 离开已改动配置前的三选一，返回是否放行
    askConfirm = async () => true,     // (msg) => Promise<boolean>
    defaultCfgName = () => newCfgName()  // 「保存为新配置」的预填名
  } = opts

  const configs = ref([])
  const activeId = ref(null)      // 已载入到工作区的那一份
  const focusId = ref(null)       // 键盘与右键的落点（与 activeId 分离：右键别处不改变工作区）
  const expandedFolders = ref(new Set(JSON.parse(localStorage.getItem(storageKey) || '[]')))
  const editing = reactive({ id: null, name: '' })
  const cfgClip = shallowRef(null)   // { mode:'copy'|'cut', id, name, isFolder, state }；shallowRef 免得 state 被再代理
  const cfgDlg = reactive({ open: false, name: '' })

  const needApi = () => { if (!api) { toast('需在桌面客户端中运行'); return false } return true }
  const itemById = (id) => (id == null ? null : configs.value.find((c) => c.id === id) || null)
  const rows = computed(() => flattenTree(configs.value, expandedFolders.value))

  // —— 展开集 ——
  function persistExpanded() { try { localStorage.setItem(storageKey, JSON.stringify([...expandedFolders.value])) } catch (e) { /* 配额满等忽略 */ } }
  function toggleFolder(f) {
    const s = new Set(expandedFolders.value)
    if (s.has(f.id)) s.delete(f.id); else s.add(f.id)
    expandedFolders.value = s; persistExpanded()
  }
  function expandFolder(id) { if (id == null || expandedFolders.value.has(id)) return; const s = new Set(expandedFolders.value); s.add(id); expandedFolders.value = s; persistExpanded() }
  function expandAll() { expandedFolders.value = new Set(configs.value.filter((c) => c.type === 'folder').map((c) => c.id)); persistExpanded() }
  function collapseAll() { expandedFolders.value = new Set(); persistExpanded() }
  // 剪除已不存在的文件夹 id，防展开集无限膨胀
  function pruneExpanded() {
    const ids = new Set(configs.value.filter((c) => c.type === 'folder').map((c) => c.id))
    let changed = false
    const s = new Set(expandedFolders.value)
    for (const id of [...s]) if (!ids.has(id)) { s.delete(id); changed = true }
    if (changed) { expandedFolders.value = s; persistExpanded() }
  }

  // —— 载入 ——
  async function loadConfigs() {
    try { configs.value = (api && await api.store.listConfigs(ns)) || [] }
    catch (e) { configs.value = [] }
    pruneExpanded()
  }
  function uniqueCfgName(base) {
    const names = new Set(configs.value.map((c) => c.name))
    if (!names.has(base)) return base
    let i = 2; while (names.has(base + ' ' + i)) i++
    return base + ' ' + i
  }
  function activeName() { const c = itemById(activeId.value); return c ? c.name : '' }

  // —— 选中 / 保存 ——
  function applyConfig(c) { if (!c) return; activeId.value = c.id; focusId.value = c.id; applyState(c.state); setBaseline() }
  async function selectConfig(c) {
    if (!c || c.id === activeId.value) { if (c) focusId.value = c.id; return }
    if (!(await guardedLeave())) return
    applyConfig(c)
  }
  function openSaveDlg() { if (!needApi()) return; cfgDlg.name = defaultCfgName(); cfgDlg.open = true }
  const errText = (e) => (e && e.message) || String(e)
  async function confirmCfgDlg() {
    const name = (cfgDlg.name || '').trim()
    if (!name) { toast('请输入配置名称'); return }
    let item = null
    try { item = await api.store.saveConfig(ns, { name, state: serializeState() }) }
    catch (e) { toast('保存失败：' + errText(e)); return }   // 对话框留着，用户可改名重试
    cfgDlg.open = false
    await loadConfigs()
    if (item && item.id) { activeId.value = item.id; focusId.value = item.id; setBaseline() }
    toast('已保存配置：' + name)
  }
  // 返回是否真的存进去了——关窗守卫要按它决定放不放行
  async function updateConfig() {
    if (!api || !activeId.value) return false
    const c = itemById(activeId.value); if (!c) return false
    try { await api.store.saveConfig(ns, { id: c.id, name: c.name, state: serializeState() }) }
    catch (e) { toast('保存失败：' + errText(e)); return false }
    setBaseline(); await loadConfigs(); toast('已保存修改到：' + c.name)
    return true
  }
  async function saveCurrent() { if (!needApi()) return; if (activeId.value) await updateConfig(); else openSaveDlg() }

  // —— 新建 ——
  async function addFolder(parentId = null) {
    if (!needApi()) return
    const item = await api.store.saveConfig(ns, { type: 'folder', name: uniqueCfgName(newFolderName()), parentId: parentId || null, orbitType })
    expandFolder(parentId)
    if (item && item.id) expandFolder(item.id)
    await loadConfigs()
    if (item && item.id) { focusId.value = item.id; startRename(item) }
  }
  async function addBlankConfig(parentId = null) {
    if (!needApi()) return
    if (!(await guardedLeave())) return
    const state = blankState()
    const item = await api.store.saveConfig(ns, { name: uniqueCfgName(newCfgName()), state, parentId: parentId || null })
    expandFolder(parentId)          // 建在折叠文件夹里时不展开＝新配置当场「消失」
    await loadConfigs()
    if (item && item.id) { activeId.value = item.id; focusId.value = item.id; applyState(state); setBaseline() }
    toast('已添加空白配置')
  }

  // —— 改名 ——
  function startRename(c) {
    if (!c) return
    editing.id = c.id; editing.name = c.name
    nextTick(() => { const el = document.querySelector('.lb-tree-rename'); if (el) { el.focus(); el.select() } })
  }
  function cancelRename() { editing.id = null }
  async function commitRename() {
    const id = editing.id; if (id == null) return
    const c = itemById(id)
    const nm = (editing.name || '').trim()
    editing.id = null
    // 只传 { id, name }：saveConfig 做 merge，既不动 state/parentId，又对文件夹（无 state）通用，且规避 Proxy 克隆报错
    if (c && nm && nm !== c.name) { await api.store.saveConfig(ns, { id: c.id, name: nm }); await loadConfigs(); toast('已改名：' + nm) }
  }

  // —— 删除 ——
  function forgetIds(removed) {
    const rset = removed instanceof Set ? removed : new Set(removed)
    if (activeId.value && rset.has(activeId.value)) { activeId.value = null; setBaseline() }
    if (focusId.value && rset.has(focusId.value)) focusId.value = null
    if (cfgClip.value && rset.has(cfgClip.value.id)) cfgClip.value = null
    if (rset.size) { const s = new Set(expandedFolders.value); for (const id of rset) s.delete(id); expandedFolders.value = s; persistExpanded() }
  }
  async function removeConfig(id) {
    if (!api || id == null) return
    await api.store.deleteConfig(ns, id)
    forgetIds([id])
    await loadConfigs()
  }
  // 级联删子项：非空先确认，并清掉受影响的 activeId / focus / 剪贴板 / 展开态
  async function removeFolder(folder) {
    if (!api || !folder) return
    const hasChildren = configs.value.some((c) => c.parentId === folder.id)
    if (hasChildren && !(await askConfirm(`删除文件夹「${folder.name}」及其中全部子项？此操作不可撤销。`))) return
    const removed = (await api.store.deleteFolder(ns, folder.id)) || [folder.id]
    forgetIds(removed)
    await loadConfigs()
    toast('已删除文件夹：' + folder.name)
  }
  function onDeleteItem(item) { if (!item) return; if (item.type === 'folder') removeFolder(item); else removeConfig(item.id) }

  // —— 移动（拖拽 / 粘贴 / 移到根）——
  // 纯元数据操作，不载入、不走 guardedLeave（parentId 不入指纹，脏态与 baseline 不受影响）
  async function moveItem(id, parentId, anchorId, position) {
    if (!api || id == null) return
    await api.store.moveItem(ns, { id, parentId, anchorId, position })
    if (position === 'inside' && parentId) expandFolder(parentId)
    await loadConfigs()
  }
  // ★ ConfigTree emit 的是 dragId，IPC 那头解构的是 id —— 名字对不上就静默不动（端到端曾整条拖拽失效）
  async function onMove(payload) {
    if (!payload || !payload.dragId) return
    await moveItem(payload.dragId, payload.parentId, payload.anchorId, payload.position)
  }
  async function moveToRoot(item) {
    if (!item || item.parentId == null) return
    await moveItem(item.id, null, null, 'inside')
    toast('已移到根目录：' + item.name)
  }

  // —— 剪贴板 ——
  // 复制只对配置：文件夹要连整棵子树一起克隆，那是另一件事（且 state 深拷对文件夹无意义）。
  // 剪切两者皆可：它本质是 moveItem，根本不碰 state —— 早先把文件夹一并挡在门外，
  // 于是「把一个文件夹归到另一个文件夹下」只剩拖拽一条路，列表一长就等于做不到。
  function copyItem(c) {
    if (!c) return
    if (c.type === 'folder') { toast('文件夹只能剪切，不能复制'); return }
    cfgClip.value = { mode: 'copy', id: c.id, name: c.name, isFolder: false, state: JSON.parse(JSON.stringify(c.state)) }
    toast('已复制：' + c.name)
  }
  function cutItem(c) {
    if (!c) return
    cfgClip.value = { mode: 'cut', id: c.id, name: c.name, isFolder: c.type === 'folder', state: null }
    toast('已剪切：' + c.name + '（粘贴以换位置）')
  }
  // 复制=生成副本；剪切=移动原项。into=true 且目标是文件夹 → 放入其内；否则放到目标之后；无目标=根末尾。
  async function pasteConfig(targetId, into = false) {
    const clip = cfgClip.value
    if (!clip || !needApi()) return
    let movingId = clip.id
    if (clip.mode === 'copy') {
      const item = await api.store.saveConfig(ns, { name: uniqueCfgName(copyNameOf(clip.name)), state: JSON.parse(JSON.stringify(clip.state)) })
      movingId = item && item.id
    }
    if (!movingId) return
    const target = (targetId && targetId !== movingId) ? itemById(targetId) : null
    // 剪切文件夹时：落点在自己子树内即成环，storage 那头有兜底，这里先挡下来给个说法
    if (clip.mode === 'cut' && clip.isFolder && target && descendantsOf(clip.id).has(target.id)) {
      toast('不能把文件夹移进它自己的子级'); return
    }
    if (into && target && target.type === 'folder') await moveItem(movingId, target.id, null, 'inside')
    else if (target) await moveItem(movingId, target.parentId != null ? target.parentId : null, target.id, 'after')
    else await moveItem(movingId, null, null, 'inside')
    if (clip.mode === 'cut') cfgClip.value = null
    focusId.value = movingId
    toast('已粘贴')
  }
  function descendantsOf(id) {
    const set = new Set([id])
    let grew = true
    while (grew) { grew = false; for (const it of configs.value) { if (it.parentId != null && set.has(it.parentId) && !set.has(it.id)) { set.add(it.id); grew = true } } }
    return set
  }
  // 粘贴的默认落点＝焦点项：焦点是文件夹就进去，是配置就排在它后面，什么都没选则落根末尾。
  // （早先键盘 Ctrl+V 固定粘到 activeId 旁边，与刚右键的那一项对不上号。）
  function pasteAtFocus() {
    const f = itemById(focusId.value)
    return pasteConfig(f ? f.id : null, !!(f && f.type === 'folder'))
  }

  // —— 右键菜单（位置修正在 ConfigTreeMenu 组件里做）——
  const ctxMenu = reactive({ open: false, x: 0, y: 0, id: null })
  const ctxItem = computed(() => itemById(ctxMenu.id))
  const ctxIsFolder = computed(() => !!(ctxItem.value && ctxItem.value.type === 'folder'))
  function openCtx(e, c) {
    e.preventDefault()
    ctxMenu.id = c ? c.id : null
    focusId.value = c ? c.id : null     // 右键即高亮：菜单弹出来时看得见在对哪一行操作
    ctxMenu.x = e.clientX; ctxMenu.y = e.clientY
    ctxMenu.open = true
  }
  function closeCtx() { ctxMenu.open = false }
  function ctxDo(fn) { ctxMenu.open = false; fn() }

  // —— 键盘 ——
  // 落点一律是 focusId。输入框/改名中一律放行给原生行为。
  function onCfgKey(e) {
    if (editing.id != null) return
    const t = e.target && e.target.tagName
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return
    const cur = itemById(focusId.value)
    const list = rows.value

    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase()
      if (k === 'c') { if (cur) { copyItem(cur); e.preventDefault() } }
      else if (k === 'x') { if (cur) { cutItem(cur); e.preventDefault() } }
      else if (k === 'v') { if (cfgClip.value) { pasteAtFocus(); e.preventDefault() } }
      return
    }
    const idx = list.findIndex((r) => cur && r.item.id === cur.id)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!list.length) return
      const next = idx < 0 ? 0 : Math.min(list.length - 1, Math.max(0, idx + (e.key === 'ArrowDown' ? 1 : -1)))
      focusId.value = list[next].item.id
      e.preventDefault()
    } else if (e.key === 'ArrowRight') {
      if (cur && cur.type === 'folder' && !expandedFolders.value.has(cur.id)) { toggleFolder(cur); e.preventDefault() }
    } else if (e.key === 'ArrowLeft') {
      if (!cur) return
      if (cur.type === 'folder' && expandedFolders.value.has(cur.id)) toggleFolder(cur)
      else if (cur.parentId != null) focusId.value = cur.parentId    // 已折叠/非文件夹 → 跳到父级
      e.preventDefault()
    } else if (e.key === 'Enter') {
      if (cur && cur.type !== 'folder') { selectConfig(cur); e.preventDefault() }
      else if (cur) { toggleFolder(cur); e.preventDefault() }
    } else if (e.key === 'F2') {
      if (cur) { startRename(cur); e.preventDefault() }
    } else if (e.key === 'Delete') {
      if (cur) { onDeleteItem(cur); e.preventDefault() }
    }
  }

  return {
    // 状态
    configs, activeId, focusId, expandedFolders, editing, cfgClip, cfgDlg, ctxMenu, rows,
    // 载入 / 保存
    loadConfigs, uniqueCfgName, activeName, itemById,
    applyConfig, selectConfig, openSaveDlg, confirmCfgDlg, updateConfig, saveCurrent,
    // 树结构
    toggleFolder, expandFolder, expandAll, collapseAll, persistExpanded, pruneExpanded,
    addFolder, addBlankConfig, removeConfig, removeFolder, onDeleteItem, onMove, moveToRoot,
    startRename, commitRename, cancelRename,
    // 剪贴板
    copyItem, cutItem, pasteConfig, pasteAtFocus,
    // 右键 / 键盘
    ctxItem, ctxIsFolder, openCtx, closeCtx, ctxDo, onCfgKey
  }
}
