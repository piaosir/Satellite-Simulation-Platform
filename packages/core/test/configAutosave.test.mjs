// 链路预算四窗「纯自动保存」（2026-10-06 取代「保存」按钮）：存储层 + 自动保存 + 历史版本 + 配置树自动保存模式。
//   ① storage.updateConfigState：只更新、不新建 —— 删掉的配置不会被一次迟到的写盘以原 id 复活；
//   ② storage 历史版本：留档 / 清单不带 state / 与最新一档相同不重复 / 每份最多 30 档 / 删配置（含文件夹级联）连带删；
//   ③ useConfigAutosave：1 s 防抖、最迟 5 s、内容没变不写、「打开时」只在第一次真写盘前留、每 10 分钟留「自动」、
//      自动名随内容（钉死的不动）、写盘中换配置不串、失败告警 + 退避重试 + 恢复、snapshot / isDirty；
//   ④ useConfigTree 自动保存模式：开上次 / 开第一份 / 空库新建、删当前接替相邻、副本、改名钉死 / 清空交还自动、复制取工作区现值；
//      不开自动保存的窗口（雨衰 / 空间态势 / 日凌）行为不变。
// 同 configTree.test：不 mock 存储，假 api 按 preload / register 的签名转发到真 storage。计时器注入，不靠真时间。
// 运行：node packages/core/test/configAutosave.test.mjs
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { ref } from 'vue'

const require = createRequire(import.meta.url)
let pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++ }
const eq = (a, b, m) => { assert.deepEqual(a, b, m); pass++ }

// —— 浏览器面的 shim（lbAutoName / useConfigTree 只用到这两样）——
const ls = new Map()
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) }
globalThis.document = { querySelector: () => null }

const dir = mkdtempSync(join(tmpdir(), 'satsim-autosave-'))
process.env.SATSIM_DATA_DIR = dir
const storage = require('../../../electron/services/storage.js')
const { useConfigAutosave, fpHash, RETRY_MS, AUTOSAVE_DELAY_MS, AUTOSAVE_MAX_WAIT_MS, VERSION_EVERY_MS } = await import('../../../src/shared/useConfigAutosave.js')
const { useConfigTree, flattenTree } = await import('../../../src/shared/useConfigTree.js')
const { useConfigVersions } = await import('../../../src/shared/useConfigVersions.js')

const NS = 'geo'
const readCfg = () => JSON.parse(readFileSync(join(dir, `configs.${NS}.json`), 'utf8'))
function wipe() {
  for (const f of [`configs.${NS}.json`, `configs.${NS}.json.bak`]) { try { rmSync(join(dir, f)) } catch (e) { /* 本就不在 */ } }
  rmSync(join(dir, 'versions'), { recursive: true, force: true })
  ls.clear()
}
const verPath = (id) => join(dir, 'versions', NS, id + '.json')

// 计时器桩：advance 按到期先后逐个触发，每触发一个就把 Promise 链跑干净
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)) }
function mkClock() {
  let t = 1_000_000, seq = 0
  const q = new Map()
  return {
    now: () => t,
    set: (fn, ms) => { const id = ++seq; q.set(id, { at: t + Math.max(0, ms), fn }); return id },
    clear: (id) => { q.delete(id) },
    pending: () => q.size,
    async advance(ms) {
      const end = t + ms
      for (;;) {
        let nx = null
        for (const [id, e] of q) if (e.at <= end && (!nx || e.at < nx[1].at)) nx = [id, e]
        if (!nx) break
        t = nx[1].at; q.delete(nx[0]); nx[1].fn()
        await settle()
      }
      t = end
      await settle()
    }
  }
}

// 假 api：签名照 preload.js；updateConfigState 可注入失败 / 挂起，并计数
function mkApi() {
  const s = { writes: 0, fail: null, hold: null }
  const api = {
    store: {
      listConfigs: async (ns) => storage.listConfigs(ns),
      saveConfig: async (ns, cfg) => storage.saveConfig(ns, cfg),
      deleteConfig: async (ns, id) => storage.deleteConfig(ns, id),
      deleteFolder: async (ns, id) => storage.deleteFolder(ns, id),
      moveItem: async (ns, payload) => { const { id, parentId, anchorId, position } = { ...payload }; return storage.moveItem(ns, id, parentId, anchorId, position) },
      updateConfigState: async (ns, id, patch) => {
        if (s.fail) throw new Error(s.fail)
        if (s.hold) await s.hold
        s.writes++
        return storage.updateConfigState(ns, id, structuredClone({ ...patch }))   // 过结构化克隆：Proxy 混进来当场抛
      },
      listVersions: async (ns, id) => storage.listVersions(ns, id),
      getVersion: async (ns, id, v) => storage.getVersion(ns, id, v),
      addVersion: async (ns, id, v) => storage.addVersion(ns, id, structuredClone(v))
    }
  }
  return { api, s }
}

// ================= ① updateConfigState：只更新、不新建 =================
{
  wipe()
  const a = storage.saveConfig(NS, { name: 'A', state: { rows: [1] }, parentId: null })
  const f = storage.saveConfig(NS, { type: 'folder', name: 'F', orbitType: 'GEO' })
  const r = storage.updateConfigState(NS, a.id, { state: { rows: [1, 2] } })
  ok(r.ok && typeof r.updatedAt === 'string', '更新成功回 updatedAt')
  const got = readCfg().find((c) => c.id === a.id)
  eq(got.state, { rows: [1, 2] }, 'state 落盘')
  eq([got.name, got.parentId], ['A', null], '名字 / 归属不动')
  const n0 = readCfg().length
  eq(storage.updateConfigState(NS, 'no-such-id', { state: { rows: [9] } }), { ok: false, gone: true }, '查无此项 → gone')
  eq(readCfg().length, n0, '★ 查无此项不新建（迟到的写盘不复活已删配置）')
  eq(storage.updateConfigState(NS, f.id, { state: { rows: [9] } }), { ok: false, gone: true }, '文件夹不是配置 → gone')
  ok(!readCfg().find((c) => c.id === f.id).state, '文件夹没被塞进 state')
  storage.updateConfigState(NS, a.id, { state: { rows: [3] }, name: '  新名  ', nameAuto: true })
  const g2 = readCfg().find((c) => c.id === a.id)
  eq([g2.name, g2.nameAuto], ['新名', true], '顺带改名（去首尾空白）与 nameAuto')
  storage.updateConfigState(NS, a.id, { state: { rows: [4] }, name: '   ' })
  eq(readCfg().find((c) => c.id === a.id).name, '新名', '空白名不生效')
  assert.throws(() => storage.updateConfigState('nope', a.id, { state: {} }), /未知的配置命名空间/); pass++
}

// ================= ② 历史版本 =================
{
  wipe()
  const a = storage.saveConfig(NS, { name: 'A', state: { rows: [1] } })
  const v1 = storage.addVersion(NS, a.id, { kind: 'open', name: 'A', meta: { label: 'L1' }, hash: 'h1', state: { rows: [1] } })
  ok(v1 && v1.id && v1.kind === 'open', '留档回 { id, t, kind }')
  const list = storage.listVersions(NS, a.id)
  eq(list.length, 1, '清单一档')
  ok(!('state' in list[0]) && list[0].meta.label === 'L1', '清单不带 state、带读数')
  eq(storage.getVersion(NS, a.id, v1.id).state, { rows: [1] }, '按 id 取整份')
  const dup = storage.addVersion(NS, a.id, { kind: 'auto', hash: 'h1', state: { rows: [1] } })
  eq(dup.id, v1.id, '与最新一档同哈希：不重复留，回原档')
  eq(storage.listVersions(NS, a.id).length, 1, '仍一档')
  for (let i = 0; i < 40; i++) storage.addVersion(NS, a.id, { kind: 'auto', hash: 'k' + i, state: { rows: [i] } })
  const l2 = storage.listVersions(NS, a.id)
  eq(l2.length, 30, '每份最多 30 档')
  eq(storage.getVersion(NS, a.id, l2[0].id).state, { rows: [39] }, '新的在前')
  eq(storage.addVersion(NS, a.id, { kind: 'auto' }), null, '没有 state 不留')
  ok(existsSync(verPath(a.id)), '一份配置一个历史文件 versions/<ns>/<id>.json')
  // 删配置连带删历史；文件夹级联
  const f = storage.saveConfig(NS, { type: 'folder', name: 'F', orbitType: 'GEO' })
  const b = storage.saveConfig(NS, { name: 'B', state: { rows: [] }, parentId: f.id })
  storage.addVersion(NS, b.id, { kind: 'open', hash: 'b', state: { rows: [] } })
  storage.addVersion(NS, b.id, { kind: 'auto', hash: 'b2', state: { rows: [1] } })   // 第二档才会留下 .bak
  storage.deleteConfig(NS, a.id)
  eq(storage.listVersions(NS, a.id), [], '删配置 → 它的历史一并删')
  ok(!existsSync(verPath(a.id)) && !existsSync(verPath(a.id) + '.bak'), '…文件连 .bak 都不留')
  eq(storage.listVersions(NS, b.id).length, 2, '别的配置的历史不动')
  storage.deleteFolder(NS, f.id)
  eq(storage.listVersions(NS, b.id), [], '删文件夹 → 子配置历史一并删')
  ok(!existsSync(verPath(b.id)) && !existsSync(verPath(b.id) + '.bak'), '…不留孤儿文件')
  // 配置 id 里混了路径字符也折成 _，不许拼出目录穿越
  storage.addVersion(NS, '../evil', { kind: 'open', hash: 'e', state: { rows: [] } })
  ok(existsSync(join(dir, 'versions', NS, '___evil.json')) && !existsSync(join(dir, 'versions', 'evil.json')), 'id 里的路径字符折成 _')
  storage.addVersion(NS, a.id, { kind: 'open', hash: 'z', state: { rows: [] } })   // 留到下一节由 wipe 清
}

// —— 自动保存的工作区桩：ws 是「屏幕上的场景」，list 是配置树内存里那份列表 ——
function mkBench({ nameAuto = false, name = 'A', rows = [1], autoName = () => '' } = {}) {
  wipe()
  const clock = mkClock()
  const { api, s } = mkApi()
  const toasts = []
  const c = storage.saveConfig(NS, { name, state: { rows: [...rows] }, ...(nameAuto ? { nameAuto: true } : {}) })
  const list = storage.listConfigs(NS)
  const activeId = ref(c.id)
  const W = { ws: { rows: [...rows] } }
  const itemById = (id) => list.find((x) => x.id === id) || null
  const uniqueName = (base, selfId) => {
    const names = new Set(list.filter((x) => x.id !== selfId).map((x) => x.name))
    if (!names.has(base)) return base
    let i = 2; while (names.has(base + ' ' + i)) i++
    return base + ' ' + i
  }
  const as = useConfigAutosave({
    ns: NS, api, activeId, itemById, serialize: () => JSON.parse(JSON.stringify(W.ws)),
    autoName, uniqueName, summarize: (st) => ({ label: `链路 ${st.rows.length} 条` }), toast: (m) => toasts.push(m), timers: clock
  })
  return { clock, api, s, toasts, c, list, activeId, W, as, itemById }
}
const stored = (id) => readCfg().find((x) => x.id === id)

// ================= ③-a 防抖 1 s / 最迟 5 s / 没变不写 =================
{
  const B = mkBench()
  B.as.attach()
  B.W.ws.rows.push(2); B.as.touch()
  await B.clock.advance(AUTOSAVE_DELAY_MS - 1)
  eq(B.s.writes, 0, '1 s 之内不写')
  await B.clock.advance(1)
  eq(B.s.writes, 1, '停手 1 s 写一次')
  eq(stored(B.c.id).state, { rows: [1, 2] }, '写的是屏幕上那份')
  eq(B.itemById(B.c.id).state, { rows: [1, 2] }, '★ 内存里配置列表那一项就地更新（复制 / 分享不读旧值）')
  B.as.touch(); await B.clock.advance(5000)
  eq(B.s.writes, 1, '内容没变：touch 了也不写')
  // 连续不停地改：每 400 ms 一笔，最迟 5 s 写
  const t0 = B.clock.now()
  let firstAt = null
  for (let k = 0; k < 20 && firstAt == null; k++) {
    B.W.ws.rows.push(100 + k); B.as.touch()
    await B.clock.advance(400)
    if (B.s.writes > 1) firstAt = B.clock.now() - t0
  }
  ok(firstAt != null && firstAt <= AUTOSAVE_MAX_WAIT_MS + 400 && firstAt > AUTOSAVE_MAX_WAIT_MS - 400, `连续编辑最迟 ${AUTOSAVE_MAX_WAIT_MS} ms 落一次（实测 ${firstAt} ms）`)
  ok(await B.as.flush() === true && !B.as.isDirty(), 'flush 后不脏')
}

// ================= ③-b 「打开时」只在第一次真写盘前留；每 10 分钟留「自动」；snapshot =================
{
  const B = mkBench({ rows: [7] })
  B.as.attach()
  B.as.touch(); await B.clock.advance(3000)
  eq(storage.listVersions(NS, B.c.id), [], '只是翻看（没改）：不留档')
  B.W.ws.rows = [7, 8]; B.as.touch(); await B.clock.advance(1000)
  const l1 = storage.listVersions(NS, B.c.id)
  eq(l1.map((v) => v.kind), ['open'], '第一次真写盘前留「打开时」')
  eq(storage.getVersion(NS, B.c.id, l1[0].id).state, { rows: [7] }, '「打开时」是打开那一刻的内容')
  eq(l1[0].meta, { label: '链路 1 条' }, '读数按留档内容出')
  B.W.ws.rows = [7, 8, 9]; B.as.touch(); await B.clock.advance(1000)
  eq(storage.listVersions(NS, B.c.id).length, 1, '10 分钟内不再留')
  await B.clock.advance(VERSION_EVERY_MS)
  B.W.ws.rows = [7, 8, 9, 10]; B.as.touch(); await B.clock.advance(1000)
  const l2 = storage.listVersions(NS, B.c.id)
  eq(l2.map((v) => v.kind), ['auto', 'open'], '满 10 分钟：写盘后留一档「自动」')
  eq(storage.getVersion(NS, B.c.id, l2[0].id).state, { rows: [7, 8, 9, 10] }, '「自动」是写下去的那份')
  await B.as.snapshot('restore')
  eq(storage.listVersions(NS, B.c.id).length, 2, 'snapshot 与最新一档相同：不重复留')
  B.W.ws.rows = [1]
  await B.as.snapshot('restore')
  eq(storage.listVersions(NS, B.c.id)[0].kind, 'restore', 'snapshot 留「还原前」')
  ok(B.as.isDirty(), 'snapshot 不落盘场景本身')
  // 换一份配置重新挂接：打开时那份重新记
  const c2 = storage.saveConfig(NS, { name: 'C2', state: { rows: [5] } }); B.list.push(c2)
  B.activeId.value = c2.id; B.W.ws = { rows: [5] }; B.as.attach()
  B.W.ws.rows = [5, 6]; B.as.touch(); await B.clock.advance(1000)
  eq(storage.listVersions(NS, c2.id).map((v) => v.kind), ['open'], '换配置后它自己的「打开时」')
  eq(storage.getVersion(NS, c2.id, storage.listVersions(NS, c2.id)[0].id).state, { rows: [5] }, '…内容是它打开时的')
}

// ================= ③-c 自动名随内容；钉死的不动；去重 =================
{
  let label = '中星6D 链路 1 条'
  const B = mkBench({ nameAuto: true, name: '新配置', autoName: () => label })
  B.as.attach(); await B.clock.advance(0)
  eq(stored(B.c.id).name, '中星6D 链路 1 条', '挂接即把名字写成随内容的那句')
  eq(B.itemById(B.c.id).name, '中星6D 链路 1 条', '树上那一项同步改名')
  label = '中星6D 链路 2 条'; B.W.ws.rows.push(2); B.as.touch(); await B.clock.advance(1000)
  eq(stored(B.c.id).name, '中星6D 链路 2 条', '内容变了名字跟着变')
  // 另一份已占用同名 → 去重
  const other = storage.saveConfig(NS, { name: '中星6D 链路 3 条', state: { rows: [] } }); B.list.push(other)
  label = '中星6D 链路 3 条'; B.W.ws.rows.push(3); B.as.touch(); await B.clock.advance(1000)
  eq(stored(B.c.id).name, '中星6D 链路 3 条 2', '与别的配置撞名时加序号')
  // 钉死的不跟
  const P = mkBench({ name: '我的场景', autoName: () => '别的名字' })
  P.as.attach(); P.W.ws.rows.push(2); P.as.touch(); await P.clock.advance(1000)
  eq(stored(P.c.id).name, '我的场景', '改过名（nameAuto 为假）的不随内容改名')
}

// ================= ③-d 删掉的配置：挂起的写盘不复活它 =================
{
  const B = mkBench()
  B.as.attach()
  B.W.ws.rows.push(2); B.as.touch()
  storage.deleteConfig(NS, B.c.id)                  // 防抖期内配置被删（列表里那一项还在：模拟树还没重读）
  await B.clock.advance(1000)
  ok(!readCfg().some((x) => x.id === B.c.id), '★ 迟到的写盘没有把已删配置写回来')
  eq(B.as.error.value, '', '已删不是故障：不告警')
  B.W.ws.rows.push(3); B.as.touch(); await B.clock.advance(1000)
  ok(!readCfg().some((x) => x.id === B.c.id), '此后也不再写')
}

// ================= ③-e 写盘失败：告警一次 + 退避重试 + 恢复 =================
{
  const B = mkBench()
  B.as.attach()
  B.s.fail = 'EPERM: operation not permitted, rename'
  B.W.ws.rows.push(2); B.as.touch(); await B.clock.advance(1000)
  ok(B.as.error.value.includes('EPERM'), '失败：error 带原因')
  eq(B.toasts.length, 1, '失败提示一次')
  ok(await B.as.flush() === false, 'flush 回 false（关窗 / 切换据此拦一下）')
  eq(B.toasts.length, 1, '连续失败不重复提示')
  B.s.fail = null
  await B.clock.advance(RETRY_MS[RETRY_MS.length - 1])
  eq(stored(B.c.id).state, { rows: [1, 2] }, '退避重试后写进去了')
  eq(B.as.error.value, '', '恢复后告警消失')
  // 未激活（主进程门禁回 { locked:true }）也按失败处理
  const L = mkBench()
  L.as.attach()
  L.api.store.updateConfigState = async () => ({ locked: true })
  L.W.ws.rows.push(2); L.as.touch(); await L.clock.advance(1000)
  eq(L.as.error.value, '软件未激活', '门禁拦下 → 告警「软件未激活」')
}

// ================= ③-f 写盘途中换配置：结果不串到新配置 =================
{
  const B = mkBench({ rows: [1] })
  B.as.attach()
  let release
  B.s.hold = new Promise((r) => { release = r })
  B.W.ws.rows.push(2); B.as.touch(); await B.clock.advance(1000)   // 写盘挂在半路
  const c2 = storage.saveConfig(NS, { name: 'C2', state: { rows: [50] } }); B.list.push(c2)
  B.activeId.value = c2.id; B.W.ws = { rows: [50] }; B.as.attach()      // 换配置
  B.s.hold = null; release(); await settle()
  eq(stored(B.c.id).state, { rows: [1, 2] }, '半路那笔写进原配置')
  eq(stored(c2.id).state, { rows: [50] }, '新配置没被串写')
  ok(!B.as.isDirty(), '新配置的基线没被迟到的结果改掉')
  B.W.ws.rows.push(51); B.as.touch(); await B.clock.advance(1000)
  eq(stored(c2.id).state, { rows: [50, 51] }, '之后的改动照常写进新配置')
  ok(fpHash('a') !== fpHash('b') && fpHash('x').length === 16, 'fpHash：16 位十六进制、区分内容')
}

// ================= ③-g 历史版本：还原当前 / 还原别的 / 另建副本 =================
{
  wipe()
  const clock = mkClock()
  const { api } = mkApi()
  let ws = { rows: [1] }
  const toasts = []
  const tree = useConfigTree({
    ns: NS, orbitType: 'GEO', api, storageKey: 'test/exp', toast: (m) => toasts.push(m),
    blankState: () => ({ rows: [] }), serializeState: () => JSON.parse(JSON.stringify(ws)), applyState: (st) => { ws = JSON.parse(JSON.stringify(st)) },
    setBaseline: () => as.attach(), guardedLeave: async () => as.flush(), autosave: true
  })
  const as = useConfigAutosave({ ns: NS, api, activeId: tree.activeId, itemById: tree.itemById, serialize: () => JSON.parse(JSON.stringify(ws)), uniqueName: tree.uniqueCfgName, timers: clock })
  const V = useConfigVersions({ ns: NS, api, tree, autosave: as, applyState: (st) => { ws = JSON.parse(JSON.stringify(st)) }, summarize: (st) => ({ label: `链路 ${st.rows.length} 条` }), toast: (m) => toasts.push(m) })
  const a = storage.saveConfig(NS, { name: 'A', state: { rows: [1] } })
  await tree.loadConfigs(); await tree.ensureActive(a.id)
  ws.rows.push(2); as.touch(); await clock.advance(1000)
  const vs = storage.listVersions(NS, a.id)
  const openV = vs.find((v) => v.kind === 'open')
  await V.openVersions(a.id)
  ok(V.verDlg.open && V.verDlg.id === a.id && V.verDlg.name === 'A', '打开对话框记住看的是哪一份')
  await V.restoreVersion({ state: storage.getVersion(NS, a.id, openV.id).state })
  eq(ws, { rows: [1] }, '还原当前配置：工作区回到那一版')
  eq(stored(a.id).state, { rows: [1] }, '…并当场写盘')
  ok(storage.listVersions(NS, a.id).some((v) => v.kind === 'restore'), '还原前留了一档（还原本身也能退回去）')
  // 还原别的配置：工作区不动，改它的存档
  const b = storage.saveConfig(NS, { name: 'B', state: { rows: [9] } }); await tree.loadConfigs()
  storage.addVersion(NS, b.id, { kind: 'open', hash: 'x', state: { rows: [8] } })
  await V.openVersions(b.id)
  await V.restoreVersion({ state: { rows: [8] } })
  eq(stored(b.id).state, { rows: [8] }, '还原别的配置：直接改写它的存档')
  eq(ws, { rows: [1] }, '工作区不动')
  ok(storage.listVersions(NS, b.id).some((v) => v.kind === 'restore'), '它的「还原前」也留了')
  // 用某一版另建副本：紧跟原项、打开它、名字钉死
  await V.openVersions(b.id)
  await V.duplicateVersion({ state: { rows: [8, 8] } })
  const order = flattenTree(tree.configs.value, new Set()).map((r) => r.item.name)
  ok(order.indexOf('B 副本') === order.indexOf('B') + 1, '副本紧跟原项')
  eq(ws, { rows: [8, 8] }, '副本被打开')
  ok(!tree.itemById(tree.activeId.value).nameAuto, '副本名字钉死')
}

// ================= ④ 配置树自动保存模式 =================
function mkTree(over = {}) {
  wipe()
  const { api } = mkApi()
  const W = { ws: { rows: [] }, applied: 0, baselines: 0, autoCalls: [] }
  const t = useConfigTree({
    ns: NS, orbitType: 'GEO', api, storageKey: 'test/exp', toast: () => {},
    blankState: () => ({ rows: ['blank'] }),
    serializeState: () => JSON.parse(JSON.stringify(W.ws)),
    applyState: (st) => { W.ws = JSON.parse(JSON.stringify(st)); W.applied++ },
    setBaseline: () => { W.baselines++ },
    guardedLeave: async () => true, askConfirm: async () => true,
    onNameAuto: (id) => W.autoCalls.push(id),
    autosave: true,
    ...over
  })
  return { t, W }
}
{
  // 空库：新建一份空白配置并打开（名字随内容）
  const { t, W } = mkTree()
  await t.loadConfigs()
  const c = await t.ensureActive(null)
  ok(c && t.activeId.value === c.id, '空库 → 新建并打开')
  ok(t.itemById(c.id).nameAuto === true, '新建的配置名字随内容（nameAuto）')
  eq(W.ws, { rows: ['blank'] }, '工作区载入空白场景')
  ok(W.baselines >= 1, '载入后挂了基线')
}
{
  // 有库：优先开上次那份；那份没了开树序第一份
  const { t, W } = mkTree()
  const a = storage.saveConfig(NS, { name: 'A', state: { rows: ['a'] } })
  const b = storage.saveConfig(NS, { name: 'B', state: { rows: ['b'] } })
  await t.loadConfigs()
  await t.ensureActive(a.id)
  eq([t.activeId.value, W.ws], [a.id, { rows: ['a'] }], '开上次那份')
  t.activeId.value = null
  await t.ensureActive('gone')
  const first = flattenTree(t.configs.value, new Set()).find((r) => r.item.type !== 'folder').item
  eq(t.activeId.value, first.id, '上次那份不在 → 开树序第一份')
  ok(b.id && W.applied >= 2, '每次打开都载入工作区')
}
{
  // 删当前：接替相邻（之后优先、没有往前）；删光了新建一份
  const { t, W } = mkTree()
  const ids = ['P', 'Q', 'R'].map((n) => storage.saveConfig(NS, { name: n, state: { rows: [n] } }).id)
  await t.loadConfigs()
  const order = () => flattenTree(t.configs.value, new Set()).map((r) => r.item.name)
  eq(order(), ['R', 'Q', 'P'], '新建的排在前（unshift）')
  const idOf = (n) => t.configs.value.find((c) => c.name === n).id
  await t.ensureActive(idOf('Q'))
  await t.removeConfig(idOf('Q'))
  eq(t.itemById(t.activeId.value).name, 'P', '删当前 → 打开它后面那一份')
  await t.removeConfig(idOf('P'))
  eq(t.itemById(t.activeId.value).name, 'R', '后面没有 → 打开前面那一份')
  await t.removeConfig(idOf('R'))
  ok(t.activeId.value && t.itemById(t.activeId.value).nameAuto === true, '删光了 → 新建一份空白配置顶上')
  eq(W.ws, { rows: ['blank'] }, '…并载入')
  ok(ids.length === 3, '')
}
{
  // 删文件夹连带当前：接替文件夹外的
  const { t } = mkTree()
  const f = storage.saveConfig(NS, { type: 'folder', name: 'F', orbitType: 'GEO' })
  const inF = storage.saveConfig(NS, { name: 'IN', state: { rows: [1] }, parentId: f.id })
  storage.saveConfig(NS, { name: 'OUT', state: { rows: [2] } })
  await t.loadConfigs()
  await t.ensureActive(inF.id)
  await t.removeFolder(t.itemById(f.id))
  eq(t.itemById(t.activeId.value).name, 'OUT', '删掉含当前配置的文件夹 → 接替文件夹外那一份')
}
{
  // 副本：紧跟原项、打开、钉死名「X 副本」；名字随内容的原项，副本也随内容
  const { t, W } = mkTree()
  const x = storage.saveConfig(NS, { name: 'X', state: { rows: ['x'] } })
  storage.saveConfig(NS, { name: 'Y', state: { rows: ['y'] } })
  await t.loadConfigs()
  await t.ensureActive(x.id)
  W.ws = { rows: ['x', '未落盘的那一笔'] }
  await t.duplicateItem(t.itemById(x.id))
  const order = flattenTree(t.configs.value, new Set()).map((r) => r.item.name)
  ok(order.indexOf('X 副本') === order.indexOf('X') + 1, '副本紧跟原项')
  const cp = t.itemById(t.activeId.value)
  eq([cp.name, !!cp.nameAuto], ['X 副本', false], '副本被打开、名字钉死')
  eq(cp.state, { rows: ['x', '未落盘的那一笔'] }, '★ 当前配置的副本取工作区现值')
  const au = storage.saveConfig(NS, { name: '中星 链路 1 条', nameAuto: true, state: { rows: [1] } })
  await t.loadConfigs()
  await t.duplicateItem(t.itemById(au.id))
  const cp2 = t.itemById(t.activeId.value)
  ok(cp2.nameAuto === true && cp2.name === '中星 链路 1 条 2', '名字随内容的原项：副本也随内容（先去重占位）')
}
{
  // 改名：随内容 → 改了即钉死；清空 → 交还自动命名并通知窗口
  const { t, W } = mkTree()
  const a = storage.saveConfig(NS, { name: '自动名', nameAuto: true, state: { rows: [] } })
  await t.loadConfigs()
  t.startRename(t.itemById(a.id)); t.editing.name = '我起的名'
  await t.commitRename()
  eq([t.itemById(a.id).name, t.itemById(a.id).nameAuto], ['我起的名', false], '改名即钉死')
  t.startRename(t.itemById(a.id)); t.editing.name = '   '
  await t.commitRename()
  ok(t.itemById(a.id).nameAuto === true, '清空名字 → 交还自动命名')
  eq(t.itemById(a.id).name, '我起的名', '名字先不动（由自动保存按内容重写）')
  eq(W.autoCalls, [a.id], '通知窗口：这一份交还了自动命名')
}
{
  // 复制：当前配置取工作区现值；粘出来的名字规则
  const { t, W } = mkTree()
  const a = storage.saveConfig(NS, { name: 'A', state: { rows: ['存档'] } })
  await t.loadConfigs()
  await t.ensureActive(a.id)
  W.ws = { rows: ['屏幕上的'] }
  t.copyItem(t.itemById(a.id))
  eq(t.cfgClip.value.state, { rows: ['屏幕上的'] }, '★ 复制当前配置取工作区现值')
  await t.pasteConfig(a.id, false)
  ok(t.configs.value.some((c) => c.name === 'A 副本' && !c.nameAuto), '钉死名字的原项：粘出「A 副本」')
}
{
  // 删配置先确认（v1.5.0 上线前排查 #4）：自动保存下删配置连历史版本一起删、删当前还会当场换走工作区 ——
  // 行尾 ×（onDeleteItem）、右键「删除」（onDeleteItem）、Delete 键（onCfgKey）三条路都要先过 askConfirm
  const asked = []
  let answer = false
  const { t } = mkTree({ askConfirm: async (m) => { asked.push(m); return answer } })
  const a = storage.saveConfig(NS, { name: '甲', state: { rows: ['a'] } })
  const b = storage.saveConfig(NS, { name: '乙', state: { rows: ['b'] } })
  storage.addVersion(NS, b.id, { kind: 'open', state: { rows: ['b0'] }, hash: 'h-b0' })
  await t.loadConfigs()
  await t.ensureActive(b.id)
  await t.removeConfig(b.id)
  ok(asked.length === 1 && asked[0].includes('「乙」') && asked[0].includes('历史版本'), '删配置先问一句，陈述后果（含名字与历史版本）')
  ok(t.itemById(b.id) && t.activeId.value === b.id, '取消 ⇒ 配置还在、工作区不换')
  ok(existsSync(verPath(b.id)), '取消 ⇒ 历史版本文件不动')
  t.onDeleteItem(t.itemById(b.id)); await settle()
  ok(asked.length === 2 && !!t.itemById(b.id), '行尾 × / 右键「删除」（onDeleteItem）同样先问')
  t.focusId.value = b.id
  t.onCfgKey({ key: 'Delete', target: { tagName: 'DIV' }, preventDefault: () => {} }); await settle()
  ok(asked.length === 3 && !!t.itemById(b.id), 'Delete 键同样先问')
  answer = true
  await t.removeConfig(b.id)
  ok(!t.itemById(b.id) && !existsSync(verPath(b.id)), '确认 ⇒ 删掉，连历史版本')
  eq(t.activeId.value, a.id, '…删的是当前配置 ⇒ 接替相邻那一份')
  const f = storage.saveConfig(NS, { type: 'folder', name: '空夹', orbitType: 'GEO' })
  await t.loadConfigs()
  const n0 = asked.length
  await t.removeFolder(t.itemById(f.id))
  ok(asked.length === n0 && !t.itemById(f.id), '空文件夹照旧直接删（口径不变）')
}
{
  // 不开自动保存的窗口删配置不问（删了工作区内容还在、可重新保存，与此前逐字相同）
  const asked = []
  const { t } = mkTree({ autosave: false, askConfirm: async (m) => { asked.push(m); return false } })
  const p = storage.saveConfig(NS, { name: 'P', state: { rows: [1] } })
  await t.loadConfigs()
  await t.removeConfig(p.id)
  ok(!asked.length && !t.itemById(p.id), '不开自动保存：删配置不弹确认')
}
{
  // 切配置清表格撤销栈（排查 #3）：StationGrid 暴露 clearHistory，四窗 applyState 一进来就清（源码钉）——
  // 栈是组件级的、表格不随配置重建，不清的话在新配置里按撤销会把上一份的行灌进来、约 1 s 后自动写盘
  const src = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  for (const g of ['src/linkbudget/StationGrid.vue', 'src/ngso/StationGrid.vue']) {
    const s = src(g)
    ok(/function clearHistory\(\) \{ undoStack\.value = \[\]; redoStack\.value = \[\] \}/.test(s) && /defineExpose\(\{[^}]*\bclearHistory\b/.test(s), g + '：暴露 clearHistory')
  }
  const wins = [
    ['src/linkbudget/LinkBudgetApp.vue', ['linkGridRef']],
    ['src/ngso/NgsoLinkBudgetApp.vue', ['linkGridRef']],
    ['src/regen/RegenLinkBudgetApp.vue', ['txGridRef', 'rxGridRef', 'islGridRef', 'laserGridRef']],
    ['src/rain/RainApp.vue', ['caseGridRef']],
    ['src/suntool/SunOutageApp.vue', ['stationGridRef']]
  ]
  for (const [w, refs] of wins) {
    const s = src(w)
    const i = s.indexOf('function applyState(st) {'), body = i >= 0 ? s.slice(i, s.indexOf('\n}\n', i)) : ''
    ok(body.includes('.clearHistory()') && refs.every((r) => body.includes(r)), w + '：applyState 清表格撤销栈')
    ok(refs.every((r) => new RegExp('<StationGrid[^>]*\\sref="' + r + '"').test(s)), w + '：表格挂上 ref')
  }
}
{
  // 不开自动保存的窗口（雨衰 / 空间态势 / 日凌）：行为逐字不变
  const { t } = mkTree({ autosave: false })
  await t.loadConfigs()
  await t.addBlankConfig(null)
  const c = t.configs.value.find((x) => x.type !== 'folder')
  ok(c && !('nameAuto' in c), '不开自动保存：新建配置不带 nameAuto')
  const p = storage.saveConfig(NS, { name: 'P', state: { rows: ['存档'] } })
  await t.loadConfigs()
  t.activeId.value = p.id
  t.copyItem(t.itemById(p.id))
  eq(t.cfgClip.value.state, { rows: ['存档'] }, '不开自动保存：复制照旧取存档')
  t.startRename(t.itemById(p.id)); t.editing.name = ''
  await t.commitRename()
  ok(!t.itemById(p.id).nameAuto && t.itemById(p.id).name === 'P', '不开自动保存：清空名字什么都不做')
}

rmSync(dir, { recursive: true, force: true })
ok(!existsSync(dir), '清理临时目录')
console.log(`configAutosave: ${pass} 项断言全部通过`)
