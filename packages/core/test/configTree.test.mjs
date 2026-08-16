// 配置列表树的操作层（shared/useConfigTree.js）+ 与真 storage 的接线。
//
// ★ 这套测试刻意【不 mock 存储】：假 api 按 preload.js / register.js 的原样解构转发到真 storage。
//   端到端窗口那个「拖拽整条静默失效」的 BUG，根因正是 ConfigTree emit 的 dragId 与 IPC 期待的 id
//   对不上名字 —— 只有把这段接线一并跑通，这类错才拦得住。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { nextTick } from 'vue'

const require = createRequire(import.meta.url)
let pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++ }
const eq = (a, b, m) => { assert.deepEqual(a, b, m); pass++ }

// —— 浏览器面的两处 shim（composable 只用到这两样）——
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
}
globalThis.document = { querySelector: () => null }

const dir = mkdtempSync(join(tmpdir(), 'satsim-tree-'))
process.env.SATSIM_DATA_DIR = dir
const storage = require('../../../electron/services/storage.js')

// preload.js + register.js 的签名逐字复刻：ns 首参、moveItem 展开 payload 后按 { id, parentId, anchorId, position } 解构
const api = {
  store: {
    listConfigs: async (ns) => storage.listConfigs(ns),
    saveConfig: async (ns, cfg) => storage.saveConfig(ns, cfg),
    deleteConfig: async (ns, id) => storage.deleteConfig(ns, id),
    deleteFolder: async (ns, id) => storage.deleteFolder(ns, id),
    moveItem: async (ns, payload) => {
      const { id, parentId, anchorId, position } = { ...payload }
      return storage.moveItem(ns, id, parentId, anchorId, position)
    }
  }
}

const { useConfigTree, flattenTree } = await import('../../../src/shared/useConfigTree.js')

let workspace = null            // applyState 落点，用来看「新建配置有没有真的载入」
const toasts = []
// 每个用例一份干净的库：不清的话「新建文件夹」这类默认名会跨用例撞车，byName 拿到的是上一例留下的那个
function mkTree(over = {}) {
  store.clear()
  for (const f of ['configs.e2e.json', 'configs.e2e.json.bak']) { try { rmSync(join(dir, f)) } catch (e) { /* 本就不在 */ } }
  return useConfigTree({
    ns: 'e2e', orbitType: 'E2E', api, storageKey: 'test/expanded',
    toast: (m) => toasts.push(m),
    blankState: () => ({ orbitType: 'E2E', chains: [{ name: '默认链' }] }),
    serializeState: () => ({ orbitType: 'E2E', chains: [{ name: '当前工作区' }] }),
    applyState: (st) => { workspace = st },
    setBaseline: () => {},
    guardedLeave: async () => true,
    askConfirm: async () => true,
    defaultCfgName: () => '新场景',
    ...over
  })
}
const names = (t) => t.configs.value.map((c) => c.name)
const byName = (t, n) => t.configs.value.find((c) => c.name === n)
const childrenOf = (t, id) => t.configs.value.filter((c) => c.parentId === id).map((c) => c.name)

// ================= ① flattenTree：渲染与键盘导航共用的那一份 =================
{
  const items = [
    { id: 'f', type: 'folder', name: 'F' }, { id: 'a', name: 'A', parentId: 'f' },
    { id: 'b', name: 'B' }, { id: 'orphan', name: '孤儿', parentId: '已删除的父级' }
  ]
  eq(flattenTree(items, new Set()).map((r) => r.item.id), ['f', 'b', 'orphan'], '折叠时不展开子项')
  eq(flattenTree(items, new Set(['f'])).map((r) => r.item.id), ['f', 'a', 'b', 'orphan'], '展开后子项紧跟父级')
  eq(flattenTree(items, new Set(['f'])).map((r) => r.depth), [0, 1, 0, 0], '深度逐层递增')
  eq(flattenTree(items, new Set()).find((r) => r.item.id === 'orphan').depth, 0, '孤儿容错：父级不存在则落根（不许凭空消失）')
  eq(flattenTree(items, new Set(['f'])).find((r) => r.item.id === 'f').childCount, 1, '文件夹带直接子项计数')
}

// ================= ② 拖拽移动：dragId → id 的接线（端到端那个 BUG 的回归） =================
{
  const t = mkTree()
  await t.loadConfigs()
  await t.addFolder(null); const f = byName(t, '新建文件夹')
  t.editing.id = null
  await t.addBlankConfig(null); const c = t.configs.value.find((x) => x.type !== 'folder')

  // ConfigTree emit 的就是这个形状
  await t.onMove({ dragId: c.id, parentId: f.id, anchorId: null, position: 'inside' })
  eq(childrenOf(t, f.id), [c.name], '★ onMove 收 dragId 也能落进文件夹（早先原样透传给期待 id 的 IPC，静默不动）')
  ok(t.expandedFolders.value.has(f.id), '落进文件夹后自动展开，看得见落在哪')

  await t.onMove({ dragId: c.id, parentId: null, anchorId: null, position: 'inside' })
  eq(childrenOf(t, f.id), [], '再拖回根')
  eq(byName(t, c.name).parentId, null, 'parentId 已清空')
}

// ================= ③ 新建配置：载入 + 展开父级 + 名称去重 =================
{
  const t = mkTree()
  await t.loadConfigs()
  await t.addFolder(null); const f = byName(t, '新建文件夹')
  t.collapseAll()                                   // 折叠父级：早先在这种情形下新配置会「凭空消失」
  workspace = null
  await t.addBlankConfig(f.id)
  const kid = t.configs.value.find((x) => x.parentId === f.id)
  ok(kid, '在文件夹里建出了配置')
  ok(t.expandedFolders.value.has(f.id), '★ 自动展开父文件夹（否则新配置存进去了却看不见）')
  eq(t.activeId.value, kid.id, '★ 新配置成为当前配置（否则随后「保存」写回的还是旧配置）')
  eq(workspace && workspace.chains[0].name, '默认链', '★ 新配置的内容真的载入了工作区')

  await t.addBlankConfig(f.id)
  const kids = t.configs.value.filter((x) => x.parentId === f.id).map((x) => x.name)
  eq(new Set(kids).size, kids.length, '同名去重：连建两次不会撞名')
}

// ================= ④ 剪贴板：文件夹可剪切（用户点名的那条） =================
{
  const t = mkTree()
  await t.loadConfigs()
  await t.addFolder(null); const a = byName(t, '新建文件夹')
  await t.addFolder(null); const b = t.configs.value.filter((c) => c.type === 'folder').find((c) => c.id !== a.id)
  await t.addBlankConfig(a.id); const inA = t.configs.value.find((x) => x.parentId === a.id)

  // 剪切文件夹 A → 粘进文件夹 B
  t.cutItem(a)
  ok(t.cfgClip.value && t.cfgClip.value.isFolder, '★ 文件夹可以剪切（早先直接 return，只剩拖拽一条路）')
  await t.pasteConfig(b.id, true)
  eq(byName(t, a.name).parentId, b.id, '★ 文件夹已归到目标文件夹下')
  eq(byName(t, inA.name).parentId, a.id, '子项跟着走，父子关系不散')
  eq(t.cfgClip.value, null, '剪切粘完即清空剪贴板')

  // 环路：不能把文件夹粘进自己的子树
  t.cutItem(byName(t, b.name))
  await t.pasteConfig(byName(t, a.name).id, true)
  eq(byName(t, b.name).parentId, null, '★ 拒绝把文件夹移进它自己的子级（B 原地不动）')
  ok(toasts.some((m) => m.includes('自己的子级')), '并给出说法')

  // 复制仍只对配置开放
  toasts.length = 0
  t.copyItem(byName(t, a.name))
  ok(toasts.some((m) => m.includes('只能剪切')), '文件夹不给复制（要连整棵子树克隆，是另一件事）')
}

// ================= ⑤ 复制配置：生成副本、原件不动 =================
{
  const t = mkTree()
  await t.loadConfigs()
  await t.addBlankConfig(null); const c = t.configs.value.find((x) => x.type !== 'folder')
  const n0 = t.configs.value.length
  t.copyItem(c)
  await t.pasteConfig(c.id, false)
  eq(t.configs.value.length, n0 + 1, '复制粘贴生成了一份副本')
  ok(byName(t, c.name), '原件还在')
  ok(t.cfgClip.value, '复制态的剪贴板粘完仍在（可连粘多份）')
}

// ================= ⑥ 粘贴落点跟随 focusId（不是 activeId） =================
{
  const t = mkTree()
  await t.loadConfigs()
  await t.addFolder(null); const f = byName(t, '新建文件夹')
  await t.addBlankConfig(null); const c = t.configs.value.find((x) => x.type !== 'folder' && x.parentId == null)
  t.copyItem(c)
  t.activeId.value = c.id
  t.focusId.value = f.id                       // 右键点在文件夹上：焦点在此，工作区仍是那份配置
  await t.pasteAtFocus()
  eq(childrenOf(t, f.id).length, 1, '★ Ctrl+V 落在焦点项而非已载入项（早先固定粘到 activeId 旁边）')
}

// ================= ⑦ 移到根目录 =================
{
  const t = mkTree()
  await t.loadConfigs()
  await t.addFolder(null); const f = byName(t, '新建文件夹')
  await t.addBlankConfig(f.id); const kid = t.configs.value.find((x) => x.parentId === f.id)
  await t.moveToRoot(byName(t, kid.name))
  eq(byName(t, kid.name).parentId, null, '嵌太深的项一步回根')
}

// ================= ⑧ 删除文件夹：级联 + 清干净受影响的引用 =================
{
  const t = mkTree()
  await t.loadConfigs()
  await t.addFolder(null); const f = byName(t, '新建文件夹')
  await t.addBlankConfig(f.id); const kid = t.configs.value.find((x) => x.parentId === f.id)
  t.focusId.value = kid.id
  t.cutItem(kid)
  eq(t.activeId.value, kid.id, '前置：子配置正被载入')

  await t.removeFolder(byName(t, f.name))
  ok(!byName(t, f.name) && !byName(t, kid.name), '文件夹与子项一并删除')
  eq(t.activeId.value, null, '★ 被级联删掉的子配置不再挂在 activeId 上（早先只比对文件夹自身 id）')
  eq(t.focusId.value, null, '焦点一并清空')
  eq(t.cfgClip.value, null, '剪贴板里指向已删项的那份也清空')
  ok(!t.expandedFolders.value.has(f.id), '展开集不留已删 id')
}

// ================= ⑨ 键盘：导航顺序与渲染一致、F2 / Del / 方向键 =================
{
  const t = mkTree()
  await t.loadConfigs()
  await t.addFolder(null); const f = byName(t, '新建文件夹')
  await t.addBlankConfig(f.id)
  await t.addBlankConfig(null)
  t.editing.id = null
  const key = (k, extra = {}) => { let dflt = false; t.onCfgKey({ key: k, target: { tagName: 'DIV' }, preventDefault: () => { dflt = true }, ...extra }); return dflt }

  const order = t.rows.value.map((r) => r.item.id)
  t.focusId.value = order[0]
  key('ArrowDown')
  eq(t.focusId.value, order[1], '↓ 走的是可见行顺序（与 ConfigTree 渲染同一份 flatten）')
  key('ArrowUp')
  eq(t.focusId.value, order[0], '↑ 回来')

  t.focusId.value = f.id
  ok(t.expandedFolders.value.has(f.id), '前置：文件夹是展开的')
  key('ArrowLeft')
  ok(!t.expandedFolders.value.has(f.id), '← 折叠文件夹')
  key('ArrowRight')
  ok(t.expandedFolders.value.has(f.id), '→ 展开文件夹')

  const kid = t.configs.value.find((x) => x.parentId === f.id)
  t.focusId.value = kid.id
  key('ArrowLeft')
  eq(t.focusId.value, f.id, '← 在非文件夹上＝跳到父级')

  t.focusId.value = kid.id
  key('F2')
  eq(t.editing.id, kid.id, 'F2 进入改名')
  t.cancelRename()

  // 改名/输入框中一律放行给原生行为
  t.editing.id = kid.id
  eq(key('Delete'), false, '改名中不拦截 Delete')
  t.editing.id = null
  eq(key('Delete', { target: { tagName: 'INPUT' } }), false, '输入框里不拦截 Delete')

  t.focusId.value = kid.id
  key('Delete')
  await nextTick(); await new Promise((r) => setTimeout(r, 10))
  ok(!byName(t, kid.name), 'Del 删除焦点项')
}

// ================= ⑩ Ctrl+C/X/V 走同一套落点 =================
{
  const t = mkTree()
  await t.loadConfigs()
  await t.addFolder(null); const f = byName(t, '新建文件夹')
  await t.addBlankConfig(null); const c = t.configs.value.find((x) => x.type !== 'folder')
  t.editing.id = null            // addFolder 建完即进改名，而改名中的按键一律放行给原生行为
  const ctrl = (k) => t.onCfgKey({ key: k, ctrlKey: true, target: { tagName: 'DIV' }, preventDefault: () => {} })

  t.focusId.value = c.id
  ctrl('x')
  eq(t.cfgClip.value.mode, 'cut', 'Ctrl+X 剪切焦点项')
  t.focusId.value = f.id
  ctrl('v')
  await new Promise((r) => setTimeout(r, 10))
  eq(childrenOf(t, f.id), [c.name], 'Ctrl+V 粘进焦点所在的文件夹')
}

rmSync(dir, { recursive: true, force: true })
console.log(`configTree: ${pass} 项断言全部通过`)
