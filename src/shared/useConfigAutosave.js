// 场景自动保存（链路预算四窗；2026-10-06 起取代「保存」按钮与「是否保存」对话框）。
//
// 口径：工作区恒对应配置列表里的一份配置（activeId）。场景一变（各窗深监听调 touch）约 1 s 后写回这份配置；
// 连续不停地改，从第一笔没落盘的改动起最迟 5 s 也写一次；切换 / 新建 / 分享 / 关窗 / 窗口失焦时立即写（flush）。
//   · 写盘走 store.updateConfigState：只更新、不新建——删掉的配置不会被一次迟到的写盘以原 id 复活；
//   · 写成功后就地更新配置列表里那一项的 state / 名字：复制、分享、引用计数读到的都是落盘后的那份，不必整表重读；
//   · 指纹（各窗原有的 fingerprintOf，只认场景内容）没变就不写；名字随内容的配置（nameAuto）名字变了也写；
//   · 写盘串行：同一时刻只有一笔在路上，写盘期间换了配置（gen 变了），迟到的结果不改新配置的基线；
//   · 失败：error 置文案（界面只在这时出告警），按 2 / 5 / 10 / 30 s 退避重试；有新改动照常再试。
// 系统自己写进场景的值（GRD 回填、斜距、站址降雨 / 海拔、实时星位同步）与手改一样落盘：屏幕上是什么，盘上就是什么。
//
// 历史版本（后悔药，替代原来「不保存」那条退路）：
//   · 打开一份配置后第一次真正写盘前，先把「打开时」那份留一档 —— 只是翻看、没改过的配置不留；
//   · 此后连续编辑每满 10 分钟，写盘后留一档「自动」；
//   · 还原历史版本前，先把当前留一档「还原前」（snapshot）。
//   每份配置最多 30 档；裁剪与「与最新一档相同不重复留」在主进程 storage.addVersion。
// 模块不碰 DOM / 生命周期（listen 除外，且窗口与文档对象可注入），计时器可注入——node 单测直接跑。
import { ref } from 'vue'
import { stableStringify } from './configDirty.js'

export const AUTOSAVE_DELAY_MS = 1000
export const AUTOSAVE_MAX_WAIT_MS = 5000
export const VERSION_EVERY_MS = 10 * 60 * 1000
export const RETRY_MS = [2000, 5000, 10000, 30000]

// 场景指纹 → 64 位短哈希（两路 FNV-1a 拼接）：版本去重只比哈希，不把整串指纹存进历史文件。
// 撞了的代价只是少留一档，不影响写盘。
export function fpHash(s) {
  const str = String(s == null ? '' : s)
  let a = 0x811c9dc5, b = 0x01000193
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x01000193) >>> 0
    b = (b ^ (b >>> 13)) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

const errText = (e) => (e && e.message) || String(e)
function failText(r) {
  if (r && r.locked) return '软件未激活'
  if (r && r.error) return String(r.error)
  return '写盘失败'
}

export function useConfigAutosave(o) {
  const {
    ns, api,
    activeId,                         // ref：工作区对应的配置 id
    itemById,                         // (id) => 配置列表里那一项（写盘后就地更新）
    serialize,                        // () => 场景纯数据（各窗 serializeState；必须能过结构化克隆）
    fingerprint = stableStringify,    // (state) => string：只认场景内容（各窗 fingerprintOf）
    autoName = () => '',              // () => 随内容的名字（nameAuto 的配置用；各窗 defaultCfgName）
    uniqueName = (n) => n,            // (base, selfId) => 在本窗配置里去重后的名字
    summarize = () => null,           // (state) => 版本读数 { label }（历史版本对话框里那一列）
    toast = () => {},
    timers = { now: () => Date.now(), set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) },
    delayMs = AUTOSAVE_DELAY_MS, maxWaitMs = AUTOSAVE_MAX_WAIT_MS, versionEveryMs = VERSION_EVERY_MS
  } = o

  const error = ref('')               // 非空 = 最近一次写盘失败（功能区据此出告警）
  let gen = 0                         // 每次换配置 +1
  let savedFp = null                  // 已落盘内容的指纹；null = 没挂着配置
  let opened = null                   // { id, state, fp, kept }：打开时那份（第一次真写盘前留档）
  let versionedAt = 0                 // 本配置上一次留档的时刻
  let timer = null, dirtySince = 0, retryIdx = 0
  let chain = Promise.resolve(true)   // 写盘串行
  let disposed = false

  const clear = () => { if (timer != null) { timers.clear(timer); timer = null } }
  function schedule(ms) {
    clear()
    timer = timers.set(() => { timer = null; flush() }, Math.max(0, ms))
  }

  // 场景变了：约 1 s 后写；从第一笔没落盘的改动起算最迟 maxWaitMs
  function touch() {
    if (disposed || savedFp == null || !activeId.value) return
    const now = timers.now()
    if (!dirtySince) dirtySince = now
    schedule(Math.min(delayMs, dirtySince + maxWaitMs - now))
  }

  // 一份配置刚载入工作区（applyState 之后）：以当前内容为「已落盘」基线，记下打开时那份。
  // 名字随内容的配置若名字已落后于内容（老版本建的、或在别处改过内容），当场写一次名字。
  function attach() {
    gen++; clear(); dirtySince = 0; retryIdx = 0; error.value = ''
    const id = activeId.value
    if (!id) { savedFp = null; opened = null; return }
    const state = serialize()
    savedFp = fingerprint(state)
    opened = { id, state, fp: savedFp, kept: false }
    versionedAt = 0
    const it = itemById(id)
    if (it && it.nameAuto) {
      const nm = uniqueName(autoName(), id)
      if (nm && nm !== it.name) flush()
    }
  }
  // 工作区不再对应任何配置（当前配置被删）：丢掉挂起的写盘
  function detach() { gen++; clear(); dirtySince = 0; savedFp = null; opened = null; error.value = '' }

  // 立即把挂起的改动写盘；返回 Promise<boolean>：true = 已落盘或本就没有要写的
  function flush() {
    const p = chain.then(run, run)
    chain = p.then(() => true, () => true)
    return p
  }

  async function keep(id, kind, state, fp) {
    if (!api || !api.store || !api.store.addVersion) return null
    const it = itemById(id)
    let meta = null
    try { meta = summarize(state) || null } catch (e) { meta = null }
    try { return await api.store.addVersion(ns, id, { kind, name: it ? it.name : '', meta, hash: fpHash(fp), state }) }
    catch (e) { return null }   // 留档失败不拦写盘
  }

  // 序列化 / 指纹若抛错（场景里混进了过不了克隆的对象之类），按写盘失败处理：告警 + 退避重试，不让调用方（切换 / 关窗）跟着抛
  async function run() {
    try { return await runOnce() } catch (e) {
      const first = !error.value
      error.value = errText(e)
      if (first) toast('配置未能写入磁盘：' + error.value)
      schedule(RETRY_MS[Math.min(retryIdx, RETRY_MS.length - 1)])
      retryIdx++
      return false
    }
  }
  async function runOnce() {
    clear()
    if (disposed) return true
    const id = activeId.value
    if (!id || savedFp == null || !api || !api.store || !api.store.updateConfigState) { dirtySince = 0; return true }
    const it = itemById(id)
    if (!it) { dirtySince = 0; return true }
    const g = gen
    const state = serialize()
    const fp = fingerprint(state)
    const nm = it.nameAuto ? uniqueName(autoName(), id) : ''
    const rename = !!nm && nm !== it.name
    const changed = fp !== savedFp
    if (!changed && !rename) { dirtySince = 0; retryIdx = 0; error.value = ''; return true }
    if (changed && opened && opened.id === id && !opened.kept) {
      opened.kept = true
      versionedAt = timers.now()
      await keep(id, 'open', opened.state, opened.fp)
    }
    let r
    try { r = await api.store.updateConfigState(ns, id, rename ? { state, name: nm } : { state }) }
    catch (e) { r = { ok: false, error: errText(e) } }
    if (g !== gen) return !!(r && (r.ok || r.gone))   // 写盘期间换了配置：结果照报，不动新配置的基线
    if (r && r.ok) {
      savedFp = fp; dirtySince = 0; retryIdx = 0; error.value = ''
      // ★ 按 id 重取：写盘的 await 期间配置树可能整表重读（拖动 / 改名 / 新建文件夹…），
      //   写盘前拿到的 it 已不在列表里，就地改它等于改了个孤儿，列表里那份留着写盘前的旧 state
      const cur = itemById(id) || it
      cur.state = state
      if (r.updatedAt) cur.updatedAt = r.updatedAt
      if (rename) cur.name = nm
      if (changed && opened && opened.kept && timers.now() - versionedAt >= versionEveryMs) {
        versionedAt = timers.now()
        await keep(id, 'auto', state, fp)
      }
      return true
    }
    if (r && r.gone) { savedFp = null; dirtySince = 0; return true }   // 配置已不在（删了）：无处可写
    const first = !error.value
    error.value = failText(r)
    if (first) toast('配置未能写入磁盘：' + error.value)
    schedule(RETRY_MS[Math.min(retryIdx, RETRY_MS.length - 1)])
    retryIdx++
    return false
  }

  // 还原历史版本前：把当前内容留一档（kind 'restore'）
  async function snapshot(kind = 'restore') {
    const id = activeId.value
    if (!id || savedFp == null) return null
    const state = serialize()
    return keep(id, kind, state, fingerprint(state))
  }
  // 有没有没落盘的改动（分享时判「结果能不能随这份配置带走」用；全量指纹，别在每帧里调）
  function isDirty() {
    if (savedFp == null || !activeId.value) return false
    return fingerprint(serialize()) !== savedFp
  }
  // 窗口失焦 / 页面隐藏 / 卸载前立即写（关机、更新安装绕过关窗守卫时，最多丢不到 1 s 的改动）
  function listen(win = typeof window !== 'undefined' ? window : null, doc = typeof document !== 'undefined' ? document : null) {
    if (!win || !doc) return () => {}
    const onBlur = () => { flush() }
    const onVis = () => { if (doc.visibilityState === 'hidden') flush() }
    win.addEventListener('blur', onBlur)
    win.addEventListener('beforeunload', onBlur)
    doc.addEventListener('visibilitychange', onVis)
    return () => {
      win.removeEventListener('blur', onBlur)
      win.removeEventListener('beforeunload', onBlur)
      doc.removeEventListener('visibilitychange', onVis)
    }
  }
  function dispose() { disposed = true; clear() }

  return { error, touch, attach, detach, flush, snapshot, isDirty, listen, dispose }
}
