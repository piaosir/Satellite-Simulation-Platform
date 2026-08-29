<script setup>
// 分享 / 导入弹窗（GEO / NGSO / 再生式三窗共用）。
//
// 与旧版（三份各自为政的弹窗）的区别：
//   · 分享单元从「当前聚焦的那一个配置」扩展为【勾选的 N 个配置 + 勾选的 M 条库条目】，
//     一份包可以只带配置、只带库、或两者兼有；
//   · 被勾选配置所引用的库条目自动进包并锁定（🔒，不可取消）——这是「对端算出来的数与我这边
//     一致」的唯一保证，见 shared/lbShare.js 文件头记的那个静默算错的老 bug；
//   · 顶层页签先分「分享 / 发到小程序 / 导入」（旧版是「线下 / 线上」，把"选什么"和"怎么发"混在一起了）；
//     分享码 / 文件 / 发给用户ID 三条路共用同一份勾选结果；发到小程序走另一套载荷，故提到顶层；
//   · 导入一律先出「包内清单」再落盘：别人的包会往本机全局资源库里塞东西，得先看一眼。
//
// 体制差异全部由父组件经 ctx 注入，本组件不认识任何一种体制：
//   ctx = {
//     mod:'GEO'|'NGSO'|'REGEN',            // 与 configs.json 里的 orbitType 同值
//     getConfigs()  → 本机配置树扁平数组（含文件夹，已按体制过滤）
//     getActiveId() → 当前聚焦配置 id
//     getDraft()    → { name, state } 当前工作参数（未保存的那份）
//     lib: { es|carrier|sat: spec }        // spec 见 shared/lbShare.js（arr/label/keys/pack/sanitize/makeNew）
//     refsOf(state) → { es:[], carrier:[], sat:[] }   该场景引用了哪些库条目（含空串=库里第一份）
//     remapState(state, idMap)             // 就地把行引用改写成本机 id
//     saveConfig(payload) → Promise<item>  // 直通 api.store.saveConfig
//     flushLib() → Promise                 // 冲刷全局库的防抖写盘（并库后、写配置前必须等它）
//     onImported({ last, plan })           // 落盘后：刷新列表 / 载入末条 / 展开新建的文件夹
//   }
import { ref, reactive, computed, watch } from 'vue'
import Icon from './Icon.vue'
import MiniSendDialog from './MiniSendDialog.vue'
import { byLang } from '../shared/i18n/lang.js'   // 空名占位是界面语汇，却画在打了 skip 的名字位上（呈现层翻不到），故在这里按语言出字
import {
  SHARE_PREFIX, LIB_KINDS, KIND_LABEL, MOD_LABEL,
  makeBundle, encodeShare, bundleFileText, decodeShare, describeBundle, legacyItemsOf,
  normalizeBundle, packLib, lockedRefsOf, planImport, adoptLib, pathOf
} from '../shared/lbShare.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  ctx: { type: Object, required: true },
  deviceId: { type: String, default: '' },
  configured: { type: Boolean, default: false }   // 在线分享是否已配置（COS 子账号密钥）
})
const emit = defineEmits(['update:open', 'toast'])
const api = typeof window !== 'undefined' ? window.api : null
const toast = (m) => emit('toast', m)
const close = () => emit('update:open', false)

const tab = ref('share')          // 'share' | 'mini' | 'import'
const way = ref('code')           // 'code' | 'file' | 'online'
const items = ref([])             // 打开弹窗那一刻的配置树快照（模态期间不会变）
const draft = ref(null)           // { name, state } 当前工作参数
// 勾选态：cfg = 配置 id；es/carrier/sat = 各库显式勾选的条目 id（被引用而自动带上的另见 locked）
const sel = reactive({ draft: false, cfg: new Set(), es: new Set(), carrier: new Set(), sat: new Set() })

function reset() {
  items.value = (props.ctx.getConfigs && props.ctx.getConfigs()) || []
  try { draft.value = props.ctx.getDraft ? props.ctx.getDraft() : null } catch (e) { draft.value = null }
  sel.cfg.clear(); sel.es.clear(); sel.carrier.clear(); sel.sat.clear()
  // 默认勾上当前聚焦的配置；没有聚焦配置（新开窗口 / 刚改过参数还没存）就勾「当前工作参数」
  const act = props.ctx.getActiveId && props.ctx.getActiveId()
  const hit = act && items.value.some((i) => i.id === act && i.type !== 'folder')
  if (hit) { sel.cfg.add(act); sel.draft = false } else sel.draft = !!draft.value
  tab.value = 'share'; way.value = 'code'; recip.value = ''
  imp.text = ''; imp.plan = null; imp.err = ''; imp.src = ''; imp.msgId = ''
  if (props.configured) loadInbox()
}
watch(() => props.open, (v) => { if (v) reset() })

// —— 配置树（模态期间全展开：分享要的是一眼看全，不折腾折叠态）——
const rows = computed(() => {
  const list = items.value
  const ids = new Set(list.map((i) => i.id))
  const kids = new Map(); const roots = []
  for (const it of list) {
    const p = (it.parentId != null && ids.has(it.parentId)) ? it.parentId : null   // 孤儿容错，与 ConfigTree 同法
    if (p == null) roots.push(it)
    else { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(it) }
  }
  const out = []
  const walk = (arr, depth) => { for (const it of arr) { out.push({ item: it, depth, isFolder: it.type === 'folder' }); const k = kids.get(it.id); if (k) walk(k, depth + 1) } }
  walk(roots, 0)
  return out
})
const allCfgIds = computed(() => rows.value.filter((r) => !r.isFolder).map((r) => r.item.id))
function descConfigs(folderId) {
  const set = new Set([folderId])
  let grew = true
  while (grew) { grew = false; for (const it of items.value) { if (it.parentId != null && set.has(it.parentId) && !set.has(it.id)) { set.add(it.id); grew = true } } }
  return items.value.filter((it) => it.type !== 'folder' && set.has(it.id)).map((it) => it.id)
}
function folderState(folderId) {
  const d = descConfigs(folderId)
  if (!d.length) return 'none'
  const n = d.filter((id) => sel.cfg.has(id)).length
  return n === 0 ? 'none' : (n === d.length ? 'all' : 'some')
}
function toggleFolderSel(folderId) {
  const d = descConfigs(folderId)
  const on = folderState(folderId) !== 'all'
  for (const id of d) { if (on) sel.cfg.add(id); else sel.cfg.delete(id) }
}
function toggleCfg(id) { if (sel.cfg.has(id)) sel.cfg.delete(id); else sel.cfg.add(id) }
function selectAllCfg(on) {
  for (const id of allCfgIds.value) { if (on) sel.cfg.add(id); else sel.cfg.delete(id) }
  sel.draft = !!(on && draft.value)
}

// —— 依赖闭包：勾选的配置引用到哪些库条目（空引用已按引擎口径解析成库里第一份）——
const libArrays = computed(() => {
  const o = {}
  for (const k of LIB_KINDS) o[k] = (props.ctx.lib && props.ctx.lib[k] && props.ctx.lib[k].arr) || []
  return o
})
const selStates = computed(() => {
  const out = []
  if (sel.draft && draft.value && draft.value.state) out.push(draft.value.state)
  for (const r of rows.value) if (!r.isFolder && sel.cfg.has(r.item.id) && r.item.state) out.push(r.item.state)
  return out
})
const locked = computed(() => lockedRefsOf(selStates.value, props.ctx.refsOf, libArrays.value))
const effIds = computed(() => {
  const o = {}
  for (const k of LIB_KINDS) { const s = new Set(locked.value[k]); for (const id of sel[k]) s.add(id); o[k] = s }
  return o
})
const isLocked = (k, id) => locked.value[k].has(id)
function toggleLib(k, id) { if (isLocked(k, id)) return; if (sel[k].has(id)) sel[k].delete(id); else sel[k].add(id) }
function selectAllLib(k, on) {
  for (const c of libArrays.value[k]) { if (on) sel[k].add(c.id); else sel[k].delete(c.id) }
}

const nCfg = computed(() => (sel.draft && draft.value ? 1 : 0) + rows.value.filter((r) => !r.isFolder && sel.cfg.has(r.item.id)).length)
const nLib = computed(() => LIB_KINDS.reduce((n, k) => n + effIds.value[k].size, 0))
const nAuto = computed(() => LIB_KINDS.reduce((n, k) => n + [...locked.value[k]].filter((id) => !sel[k].has(id)).length, 0))

// 打包前把空引用「钉死」成显式 id：链路表里 stationId:'' 的意思是「用库里第一份」，原样发过去
// 到了对端就变成「用【他】库里第一份」——同一个包在两台机器上算出不同的数，还是那类静默错误。
const pin = (st) => (props.ctx.pinRefs ? props.ctx.pinRefs(st) : st)
const bundle = computed(() => {
  if (!nCfg.value && !nLib.value) return null
  const configs = []
  if (sel.draft && draft.value && draft.value.state) configs.push({ name: draft.value.name || '当前工作参数', path: [], state: pin(draft.value.state) })
  for (const r of rows.value) {
    if (r.isFolder || !sel.cfg.has(r.item.id) || !r.item.state) continue
    configs.push({ name: r.item.name, path: pathOf(r.item, items.value), state: pin(r.item.state) })
  }
  try { return makeBundle({ mod: props.ctx.mod, from: props.deviceId, configs, lib: packLib(props.ctx.lib, effIds.value) }) }
  catch (e) { return null }
})
const code = computed(() => { try { return bundle.value ? encodeShare(bundle.value) : '' } catch (e) { return '' } })
// 发送/导出用的一句话标题
const label = computed(() => {
  const p = []
  if (nCfg.value === 1) {
    const one = sel.draft && draft.value ? draft.value.name : (rows.value.find((r) => !r.isFolder && sel.cfg.has(r.item.id)) || { item: {} }).item.name
    p.push(one || '1 个配置')
  } else if (nCfg.value > 1) p.push(`${nCfg.value} 个配置`)
  if (nLib.value) p.push(`${nLib.value} 条库条目`)
  return p.join(' · ') || '（未选内容）'
})

// —— 分享方式 ——
async function copyCode() {
  if (!code.value) return
  try { await navigator.clipboard.writeText(code.value); toast('分享码已复制，可发给对方') }
  catch (e) { toast('复制失败，请手动选择文本复制') }
}
async function exportFile() {
  if (!api || !bundle.value) return
  const base = (label.value || '链路预算分享').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  const r = await api.exportFile({ defaultName: base + '.lbcfg', data: bundleFileText(bundle.value), filters: [{ name: '链路预算分享包', extensions: ['lbcfg', 'json'] }] })
  if (r && r.ok) toast('已导出：' + r.filePath)
  else if (r && !r.canceled) toast('导出失败：' + (r.error || ''))
}
const recip = ref('')
const sending = ref(false)
async function sendOnline() {
  if (!api || !props.configured) { toast('在线分享未配置'); return }
  const rid = (recip.value || '').trim()
  if (!rid) { toast('请输入对方用户 ID'); return }
  if (!bundle.value) { toast('请先勾选要分享的内容'); return }
  sending.value = true
  try {
    // items：给还没升级的老客户端留的兼容字段（它读 it.lib，因此这份对它是完整可用的）
    const payload = { from: props.deviceId, name: label.value, bundle: bundle.value, items: legacyItemsOf(bundle.value) }
    const r = await api.share.send(rid, payload)
    if (r && r.ok) toast(`已发送「${label.value}」给 ${rid}`)
    else toast('发送失败：' + ((r && r.error) || '未知错误'))
  } catch (e) { toast('发送失败：' + (e.message || e)) } finally { sending.value = false }
}

// —— 顶层第三个页签：发到小程序 ——
// 与「分享」共用同一份勾选结果，但走的是【另一套载荷】：小程序没有三库结构，故不发分享包，
// 而是把勾选的每份配置【逐行摊平】成小程序那边的扁平配置（一行 = 一份，见 shared/lbMiniExport.js）。
// 载荷不同、可选内容也不同（资源库不单独发），所以它不是「分享方式」的第 4 个按钮，而是与分享平级。
// 摊平要用到本机的三个库（行里存的是引用），故由父组件经 ctx.toMiniItems 提供——本组件仍不认识体制。
// 没有这个钩子的窗口（再生式暂未接）不显示这个页签。
const canMini = computed(() => typeof props.ctx.toMiniItems === 'function')
const miniOpen = ref(false)
// id 一并给出去（草稿为 '__draft__'）：父组件据此判「这一份是不是工作台上正算着的那一份」，
// 是才把平台的计算结果随配置带过去（见 §结果一并带走）。别的配置没有对应的结果，不能张冠李戴。
function buildMini() {
  const picked = []
  if (sel.draft && draft.value && draft.value.state) picked.push({ id: '__draft__', name: draft.value.name || '当前工作参数', state: draft.value.state })
  for (const r of rows.value) {
    if (r.isFolder || !sel.cfg.has(r.item.id) || !r.item.state) continue
    picked.push({ id: r.item.id, name: r.item.name, state: r.item.state })
  }
  return { name: label.value, from: props.deviceId, items: props.ctx.toMiniItems(picked) || [] }
}

// —— 导入：粘贴 / 文件 / 收件箱 三个入口收敛到同一条「解析 → 预览 → 落盘」流水线 ——
const imp = reactive({ text: '', plan: null, err: '', busy: false, src: '', msgId: '' })
function makePlan(input, src, msgId) {
  try {
    const b = typeof input === 'string' ? decodeShare(input) : normalizeBundle(input)
    imp.plan = planImport(b, props.ctx)
    imp.err = ''; imp.src = src || ''; imp.msgId = msgId || ''
    tab.value = 'import'
  } catch (e) { imp.plan = null; imp.err = String((e && e.message) || e) }
}
function parseText() { if (imp.text.trim()) makePlan(imp.text, '粘贴的分享码') }
async function parseClipboard() {
  try { imp.text = await navigator.clipboard.readText() } catch (e) { toast('读剪贴板失败，请手动粘贴'); return }
  parseText()
}
async function parseFile() {
  if (!api) return
  const r = await api.linkBudget.openConfig()
  if (!r || r.canceled) return
  if (!r.ok) { imp.err = '读取失败：' + (r.error || ''); return }
  makePlan(r.text, '文件')
}
const planSummary = computed(() => {
  const p = imp.plan
  if (!p) return ''
  const s = []
  if (p.counts.libNew) s.push(`新增 ${p.counts.libNew} 条库条目`)
  if (p.counts.libReuse) s.push(`复用 ${p.counts.libReuse} 条`)
  if (p.counts.config) s.push(`新建 ${p.counts.config} 个配置`)
  if (p.counts.folderNew) s.push(`新建 ${p.counts.folderNew} 个文件夹`)
  return s.join('、') || '包内没有可导入的内容'
})
const ACTION_TEXT = {
  reuse: (r) => `复用本机「${r.finalName}」`,
  'reuse-loose': (r) => `复用本机「${r.finalName}」（方向图沿用本机匹配）`,
  new: (r) => (r.renamed ? `新增为「${r.finalName}」（重名加序号）` : '新增')
}
const actionOf = (r) => (ACTION_TEXT[r.action] || (() => r.action))(r)
async function doImport() {
  const plan = imp.plan
  if (!plan || plan.reject || imp.busy) return
  if (!api) { imp.err = '导入需在桌面客户端中运行'; return }
  imp.busy = true
  try {
    const idMap = adoptLib(plan, props.ctx)                      // ① 并库（就地 push 进各库数组）
    // 库先落盘，再写配置：新配置的行引用指向的正是这批条目，反了顺序则中途关窗后引用解析不到，
    // 会静默回退到本机库里第一份配置——算出一组看着合理其实是别人参数的数（见 lbShare.js 文件头）
    if (props.ctx.flushLib) await props.ctx.flushLib()
    const fid = new Map()                                        // ② 文件夹 find-or-create（plan.folders 已是根→叶序）
    for (const f of plan.folders) {
      if (f.id) { fid.set(f.key, f.id); continue }
      const parent = f.parentKey ? (fid.get(f.parentKey) || null) : null
      const it = await props.ctx.saveConfig({ type: 'folder', name: f.name, parentId: parent, orbitType: props.ctx.mod })
      fid.set(f.key, (it && it.id) || null)
    }
    let last = null                                              // ③ 配置：行引用按 idMap 改写后存为新配置
    for (const c of plan.configs) {
      const state = JSON.parse(JSON.stringify(c.config.state))
      if (props.ctx.remapState) props.ctx.remapState(state, idMap)
      const it = await props.ctx.saveConfig({ name: c.finalName, state, parentId: (c.folderKey ? fid.get(c.folderKey) : null) || null })
      if (it) last = { id: it.id, state }
    }
    if (imp.msgId) {                                             // ④ 从收件箱移除已接收的那条
      try { await api.share.remove(props.deviceId, imp.msgId) } catch (e) { /* 清理失败无妨 */ }
      inbox.value = inbox.value.filter((x) => x.id !== imp.msgId)
    }
    if (props.ctx.onImported) await props.ctx.onImported({ last, plan, idMap, folderIds: [...fid.values()].filter(Boolean) })
    toast('已导入：' + planSummary.value)
    close()
  } catch (e) { imp.err = '导入失败：' + ((e && e.message) || e) } finally { imp.busy = false }
}

// —— 在线收件箱 ——
const inbox = ref([])
const inboxMsg = ref('')
const loadingInbox = ref(false)
async function loadInbox() {
  if (!api || !props.configured) return
  loadingInbox.value = true; inboxMsg.value = ''
  try {
    const r = await api.share.inbox(props.deviceId)
    if (r && r.ok) { inbox.value = r.items || []; if (!inbox.value.length) inboxMsg.value = '收件箱为空' }
    else inboxMsg.value = '获取失败：' + ((r && r.error) || '')
  } catch (e) { inboxMsg.value = '获取失败：' + ((e && e.message) || e) } finally { loadingInbox.value = false }
}
// 信箱里既可能躺着新版的 bundle，也可能躺着老版的 items[] / 裸 state
function bundleOfMsg(it) {
  if (it && it.bundle) return normalizeBundle(it.bundle)
  return normalizeBundle({ items: (it && it.items) || (it && it.state ? [{ name: it.name, state: it.state }] : []) })
}
function inboxLabel(it) {
  try { return describeBundle(bundleOfMsg(it)).text } catch (e) { return it.name || '分享内容' }
}
// 来源只写「收件箱」——发件人由清单抬头统一按 plan.from 显示，此处再写一遍会重复成「来自 X · 来自 X」
function acceptInbox(it) { try { makePlan(bundleOfMsg(it), '收件箱', it.id) } catch (e) { imp.err = '这条内容解析失败：' + ((e && e.message) || e); tab.value = 'import' } }
async function dismissInbox(it) {
  try { await api.share.remove(props.deviceId, it.id) } catch (e) { /* 忽略 */ }
  inbox.value = inbox.value.filter((x) => x.id !== it.id)
}
watch(() => way.value, (w) => { if (w === 'online' && props.configured && !inbox.value.length) loadInbox() })
</script>

<template>
  <div v-if="open" class="lbs-mask" @click="close">
    <div class="lbs-dlg" @click.stop>
      <div class="lbs-hd">
        <span class="lbs-hd-t">分享 / 导入</span>
        <span class="lbs-mod" :title="'本窗口体制：' + (MOD_LABEL[ctx.mod] || ctx.mod)">{{ ctx.mod }}</span>
        <span class="lbs-sp"></span>
        <span v-if="deviceId" class="lbs-id">本机标识：<b>{{ deviceId }}</b></span>
      </div>
      <nav class="lbs-tabs">
        <button class="lbs-tab" :class="{ on: tab === 'share' }" @click="tab = 'share'">分享</button>
        <button v-if="canMini" class="lbs-tab" :class="{ on: tab === 'mini' }" @click="tab = 'mini'">发送到小程序</button>
        <button class="lbs-tab" :class="{ on: tab === 'import' }" @click="tab = 'import'">导入</button>
      </nav>

      <!-- ============ 分享 / 发到小程序（共用同一份勾选结果） ============ -->
      <div v-if="tab !== 'import'" class="lbs-bd">
        <div class="lbs-sec">{{ tab === 'mini' ? '发送内容' : '分享内容' }}</div>
        <div class="lbs-pick" :class="{ solo: tab === 'mini' }">
          <!-- 左：配置（全展开的树，文件夹勾选=递归勾其下配置） -->
          <div class="lbs-col">
            <div class="lbs-col-hd">
              <span>配置</span><span class="lbs-n">{{ nCfg }}</span>
              <span class="lbs-sp"></span>
              <button class="lbs-lnk" @click="selectAllCfg(true)">全选</button>
              <button class="lbs-lnk" @click="selectAllCfg(false)">清空</button>
            </div>
            <div class="lbs-list">
              <label v-if="draft" class="lbs-row lbs-draft">
                <input type="checkbox" :checked="sel.draft" @change="sel.draft = $event.target.checked" />
                <span class="lbs-nm" data-i18n-skip>{{ draft.name }}</span>
                <span class="lbs-tag" title="工作台当前参数（尚未存为命名配置）">当前工作参数</span>
              </label>
              <template v-for="r in rows" :key="r.item.id">
                <div v-if="r.isFolder" class="lbs-row lbs-fold" :style="{ paddingLeft: (7 + r.depth * 13) + 'px' }" @click="toggleFolderSel(r.item.id)">
                  <input type="checkbox" :checked="folderState(r.item.id) === 'all'" :indeterminate.prop="folderState(r.item.id) === 'some'" @click.stop="toggleFolderSel(r.item.id)" />
                  <Icon name="folder" :size="12" class="lbs-fi" />
                  <span class="lbs-nm" data-i18n-skip>{{ r.item.name }}</span>
                </div>
                <label v-else class="lbs-row" :style="{ paddingLeft: (7 + r.depth * 13) + 'px' }">
                  <input type="checkbox" :checked="sel.cfg.has(r.item.id)" @change="toggleCfg(r.item.id)" />
                  <span class="lbs-nm" data-i18n-skip>{{ r.item.name }}</span>
                </label>
              </template>
              <div v-if="!rows.length && !draft" class="lbs-empty">还没有保存过的配置</div>
            </div>
          </div>

          <!-- 右：资源库三段（🔒＝被勾选的配置引用，随配置自动进包）。
               小程序那边没有三库结构、库引用在导出时已摊平进每一份，故「发到小程序」页不出现这一栏。 -->
          <div v-if="tab === 'share'" class="lbs-col">
            <div class="lbs-col-hd">
              <span>资源库</span><span class="lbs-n">{{ nLib }}</span>
              <span class="lbs-sp"></span>
              <span v-if="nAuto" class="lbs-hint" title="被已勾选的配置引用，随配置一起打包，不可取消：此为对端复现同一计算结果的前提">{{ nAuto }} 条随配置</span>
            </div>
            <div class="lbs-list">
              <template v-for="k in LIB_KINDS" :key="k">
                <div class="lbs-grp">
                  <span class="lbs-grp-t">{{ (ctx.lib[k] && ctx.lib[k].label) || KIND_LABEL[k] }}</span>
                  <span class="lbs-grp-n">{{ effIds[k].size }}/{{ libArrays[k].length }}</span>
                  <span class="lbs-sp"></span>
                  <button class="lbs-lnk" @click="selectAllLib(k, true)">全选</button>
                  <button class="lbs-lnk" @click="selectAllLib(k, false)">清空</button>
                </div>
                <label v-for="c in libArrays[k]" :key="c.id" class="lbs-row" :class="{ lock: isLocked(k, c.id) }">
                  <input type="checkbox" :checked="effIds[k].has(c.id)" :disabled="isLocked(k, c.id)" @change="toggleLib(k, c.id)" />
                  <span class="lbs-nm" data-i18n-skip>{{ c.name || byLang('（未命名）', '(Unnamed)') }}</span>
                  <Icon v-if="isLocked(k, c.id)" name="lock" :size="12" class="lbs-lk" />
                </label>
                <div v-if="!libArrays[k].length" class="lbs-empty">（空）</div>
              </template>
            </div>
          </div>
        </div>
        <div v-if="tab === 'mini'" class="lbs-sum">
          已选 <b>{{ nCfg }}</b> 个配置
          <span v-if="!nCfg" class="lbs-warn">— 请至少勾选一个配置</span>
        </div>
        <div v-else class="lbs-sum">
          已选 <b>{{ nCfg }}</b> 个配置 · <b>{{ nLib }}</b> 条库条目<i v-if="nAuto">（其中 {{ nAuto }} 条随配置自动带上）</i>
          <span v-if="!nCfg && !nLib" class="lbs-warn">— 请至少勾选一项</span>
        </div>

        <!-- 发到小程序：载荷现造（见 buildMini），清单与密钥都在 MiniSendDialog 里 -->
        <div v-if="tab === 'mini'" class="lbs-acts">
          <button class="lbs-btn primary" :disabled="!nCfg" title="勾选的每份配置逐行拆分为小程序侧的配置（小程序中一份配置 = 一条链路）；库引用已摊平至每一份，资源库不单独发送" @click="miniOpen = true">发送到小程序…</button>
        </div>

        <template v-else>
          <div class="lbs-sec">分享方式</div>
          <div class="lbs-ways">
            <button class="lbs-way" :class="{ on: way === 'code' }" @click="way = 'code'"><Icon name="clipboard" :size="12" />分享码</button>
            <button class="lbs-way" :class="{ on: way === 'file' }" @click="way = 'file'"><Icon name="file-text" :size="12" />文件 .lbcfg</button>
            <button class="lbs-way" :class="{ on: way === 'online' }" @click="way = 'online'"><Icon name="external-link" :size="12" />发给用户 ID</button>
          </div>

          <template v-if="way === 'code'">
            <textarea class="lbs-area" :value="code" readonly rows="3" :placeholder="'勾选内容后这里会出现 ' + SHARE_PREFIX + '… 分享码'" @focus="$event.target.select()"></textarea>
            <div class="lbs-acts">
              <button class="lbs-btn primary" :disabled="!code" @click="copyCode">复制分享码</button>
            </div>
          </template>
          <template v-else-if="way === 'file'">
            <div class="lbs-acts">
              <button class="lbs-btn primary" :disabled="!bundle" @click="exportFile">导出为文件（.lbcfg）</button>
            </div>
          </template>
          <template v-else>
            <template v-if="configured">
              <div class="lbs-acts">
                <input v-model="recip" class="lbs-inp" placeholder="接收方标识，例如 3F9A2C7B10" @keyup.enter="sendOnline" />
                <button class="lbs-btn primary" :disabled="sending || !recip.trim() || !bundle" @click="sendOnline">{{ sending ? '发送中…' : '发送' }}</button>
              </div>
              <div class="lbs-inbox-hd">
                <span>收件箱</span>
                <button class="lbs-lnk" :disabled="loadingInbox" @click="loadInbox">{{ loadingInbox ? '刷新中…' : '刷新' }}</button>
              </div>
              <div v-if="inboxMsg" class="lbs-note">{{ inboxMsg }}</div>
              <ul v-if="inbox.length" class="lbs-inbox">
                <li v-for="it in inbox" :key="it.id">
                  <span class="lbs-inbox-nm" :title="it.name || ''">{{ inboxLabel(it) }}<i v-if="it.from"> · 来自 {{ it.from }}</i></span>
                  <button class="lbs-btn" @click="acceptInbox(it)">查看并导入</button>
                  <button class="lbs-btn" @click="dismissInbox(it)">忽略</button>
                </li>
              </ul>
            </template>
            <div v-else class="lbs-warnbox">在线分享尚未配置。</div>
          </template>
        </template>
      </div>

      <!-- ============ 导入 ============ -->
      <div v-else class="lbs-bd">
        <template v-if="!imp.plan">
          <div class="lbs-sec">粘贴分享码</div>
          <textarea v-model="imp.text" class="lbs-area" rows="3" :placeholder="'在此粘贴 ' + SHARE_PREFIX + '… 分享码'"></textarea>
          <div class="lbs-acts">
            <button class="lbs-btn primary" :disabled="!imp.text.trim()" @click="parseText">解析</button>
            <button class="lbs-btn" @click="parseClipboard">从剪贴板粘贴</button>
            <button class="lbs-btn" @click="parseFile">从文件导入（.lbcfg）</button>
          </div>
          <div v-if="imp.err" class="lbs-warnbox">{{ imp.err }}</div>
          <div v-if="configured && inbox.length" class="lbs-inbox-hd"><span>收件箱里还有 {{ inbox.length }} 条</span><button class="lbs-lnk" @click="tab = 'share'; way = 'online'">去查看</button></div>
        </template>

        <!-- 包内清单：先看清楚要往本机塞什么，再落盘 -->
        <template v-else>
          <div class="lbs-sec">
            包内清单
            <span class="lbs-src">{{ imp.src }}<template v-if="imp.plan.from"> · 来自 {{ imp.plan.from }}</template><template v-if="imp.plan.mod"> · {{ MOD_LABEL[imp.plan.mod] || imp.plan.mod }}</template></span>
          </div>
          <div v-if="imp.plan.reject" class="lbs-warnbox">{{ imp.plan.reject }}</div>
          <template v-else>
            <div class="lbs-plan">
              <table class="lbs-tb">
                <thead><tr><th>类型</th><th>名称</th><th>落点</th></tr></thead>
                <tbody>
                  <tr v-for="(r, i) in imp.plan.lib" :key="'l' + i" :class="{ isnew: r.action === 'new' }">
                    <td class="lbs-k">{{ r.kindLabel }}</td>
                    <td class="lbs-nmc" :title="r.srcName">{{ r.srcName }}</td>
                    <td class="lbs-act">{{ actionOf(r) }}</td>
                  </tr>
                  <tr v-for="(c, i) in imp.plan.configs" :key="'c' + i" class="isnew">
                    <td class="lbs-k">配置</td>
                    <td class="lbs-nmc" :title="c.srcName">{{ c.srcName }}</td>
                    <td class="lbs-act">存入 {{ c.pathText }}<template v-if="c.folderNew">（文件夹将新建）</template><template v-if="c.renamed"> · 重名 → 「{{ c.finalName }}」</template></td>
                  </tr>
                  <tr v-if="!imp.plan.lib.length && !imp.plan.configs.length"><td colspan="3" class="lbs-empty">包里没有内容</td></tr>
                </tbody>
              </table>
            </div>
            <div class="lbs-sum">{{ planSummary }}</div>
            <div v-if="imp.err" class="lbs-warnbox">{{ imp.err }}</div>
          </template>
          <div class="lbs-acts">
            <button class="lbs-btn primary" :disabled="!!imp.plan.reject || imp.busy" @click="doImport">{{ imp.busy ? '导入中…' : '确认导入' }}</button>
            <button class="lbs-btn" @click="imp.plan = null; imp.msgId = ''">重选</button>
          </div>
        </template>
      </div>

      <div class="lbs-ft"><button class="lbs-btn" @click="close">关闭</button></div>
    </div>
  </div>
  <!-- 同级而不是嵌在 .lbs-mask 里：那一层的 @click 是「点遮罩即关闭」，嵌进去的话点小程序弹窗的
       遮罩会把两个窗一起关掉（本组件的关闭要由用户自己按） -->
  <MiniSendDialog v-if="open && canMini" v-model:open="miniOpen" :build="buildMini" :device-id="deviceId" :configured="configured" @toast="(m) => emit('toast', m)" />
</template>

<style scoped>
/* 视觉语言与各 App 的 .lb-dlg 一致（同一套 CSS 变量），此处自带一份是因为 App 的样式是 scoped 的，
   子组件除根元素外吃不到。类名统一 lbs- 前缀，不与任何 App 内的类冲突。 */
.lbs-mask { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.28); }
.lbs-dlg { width: 720px; max-width: 94vw; max-height: 88vh; display: flex; flex-direction: column; background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--r-card, 4px); box-shadow: var(--shadow-3); overflow: hidden; }
.lbs-hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.lbs-hd-t { font-size: var(--fs-2); font-weight: 600; letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--text-muted); }
.lbs-mod { font-family: var(--font-mono); font-size: var(--fs-1); line-height: 15px; padding: 0 5px; color: var(--text-faint); border: 1px solid var(--border-strong); border-radius: var(--r-pill); cursor: help; }
.lbs-sp { flex: 1; }
.lbs-id { font-size: var(--fs-2); color: var(--text-muted); }
.lbs-id b { font-family: var(--font-code); color: var(--text); }
.lbs-tabs { display: flex; gap: 4px; padding: 8px 12px 0; }
.lbs-tab { flex: 1; font: inherit; font-size: var(--fs-3); padding: 6px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.lbs-tab:hover { color: var(--text); border-color: var(--border-strong); }
.lbs-tab.on { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent-ui); }
.lbs-bd { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 7px; overflow-y: auto; }
.lbs-ft { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }

/* 分节小标题 */
.lbs-sec { display: flex; align-items: baseline; gap: 8px; font-size: var(--fs-2); font-weight: 600; color: var(--text-muted); letter-spacing: var(--ls-tight); padding-top: 2px; }
.lbs-src { font-weight: 400; font-size: var(--fs-2); color: var(--text-faint); }

/* 两栏选择区（.solo＝只剩配置一栏，「发到小程序」页不带资源库） */
.lbs-pick { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.lbs-pick.solo { grid-template-columns: 1fr; }
.lbs-col { display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--border); border-radius: var(--r-box, 3px); overflow: hidden; }
.lbs-col-hd { display: flex; align-items: center; gap: 6px; padding: 4px 7px; font-size: var(--fs-2); color: var(--text-muted); background: var(--surface-2); border-bottom: 1px solid var(--border); }
.lbs-n { font-family: var(--font-mono); font-size: var(--fs-1); padding: 0 5px; line-height: 15px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-pill); }
.lbs-hint { font-size: var(--fs-2); color: var(--text-faint); cursor: help; }
.lbs-lnk { font: inherit; font-size: var(--fs-2); height: var(--h-ctl-sm); white-space: nowrap; padding: 0 4px; cursor: pointer; color: var(--text-faint); background: transparent; border: 0; border-radius: var(--r-ctl); }
.lbs-lnk:hover:not(:disabled) { color: var(--text); background: var(--bg); }
.lbs-lnk:disabled { opacity: .5; cursor: not-allowed; }
.lbs-list { flex: 1; min-height: 128px; max-height: 210px; overflow-y: auto; background: var(--bg); }
.lbs-row { display: flex; align-items: center; gap: 6px; padding: 3px 7px; font-size: var(--fs-3); cursor: pointer; border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); }
.lbs-row:hover { background: var(--surface); }
.lbs-row input { margin: 0; flex: none; }
.lbs-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lbs-fold { color: var(--text-muted); font-weight: 600; }
.lbs-fi { flex: none; opacity: .65; }
.lbs-draft { background: color-mix(in srgb, var(--accent-ui) 5%, var(--bg)); }
.lbs-tag { flex: none; font-size: var(--fs-1); color: var(--text-faint); border: 1px dashed var(--border-strong); border-radius: var(--r-pill); padding: 0 5px; line-height: 14px; }
.lbs-row.lock { color: var(--text-muted); }
.lbs-lk { flex: none; opacity: .55; }
.lbs-grp { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 6px; padding: 3px 7px; background: var(--surface); border-bottom: 1px solid var(--border); }
.lbs-grp-t { font-size: var(--fs-2); font-weight: 600; color: var(--text-muted); }
.lbs-grp-n { font-family: var(--font-mono); font-size: var(--fs-1); color: var(--text-faint); }
.lbs-empty { padding: 8px 9px; font-size: var(--fs-2); color: var(--text-faint); }

/* 汇总行：这次到底发/收了什么，唯一读数 */
.lbs-sum { font-size: var(--fs-3); color: var(--text-muted); padding: 4px 1px; border-top: 1px dashed var(--border); }
.lbs-sum b { color: var(--text); font-family: var(--font-mono); }
.lbs-sum i { font-style: normal; color: var(--text-faint); }
.lbs-warn { color: var(--warn); }

/* 分享方式 */
.lbs-ways { display: flex; gap: 4px; }
.lbs-way { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 5px; font: inherit; font-size: var(--fs-3); padding: 5px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.lbs-way:hover { color: var(--text); border-color: var(--border-strong); }
.lbs-way.on { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent-ui); }
.lbs-area { font-family: var(--font-code); font-size: var(--fs-2); padding: 6px 8px; background: var(--field-bg); color: var(--text); border: 1px solid var(--field-border); border-radius: var(--r-ctl, 2px); resize: vertical; word-break: break-all; }
.lbs-area:focus { outline: none; border-color: var(--accent-ui); }
.lbs-inp { flex: 1; min-width: 0; font: inherit; font-family: var(--font-code); font-size: var(--fs-3); padding: 5px 8px; background: var(--field-bg); color: var(--text); border: 1px solid var(--field-border); border-radius: var(--r-ctl, 2px); }
.lbs-inp:focus { outline: none; border-color: var(--accent-ui); }
.lbs-acts { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.lbs-btn { font: inherit; font-size: var(--fs-2); line-height: 1; padding: 5px 9px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.lbs-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.lbs-btn:disabled { opacity: .45; cursor: not-allowed; }
.lbs-btn.primary { background: var(--accent-ui); color: var(--bg); border-color: var(--accent-ui); }
.lbs-btn.primary:hover:not(:disabled) { opacity: .88; }
.lbs-note { font-size: var(--fs-2); color: var(--text-faint); }
.lbs-warnbox { font-size: var(--fs-3); line-height: 1.6; color: var(--warn); background: color-mix(in srgb, var(--warn) 8%, var(--bg)); border: 1px solid color-mix(in srgb, var(--warn) 30%, var(--border)); border-radius: var(--r-ctl, 2px); padding: 6px 8px; }

/* 收件箱 */
.lbs-inbox-hd { display: flex; align-items: center; justify-content: space-between; margin-top: 2px; padding-top: 6px; border-top: 1px dashed var(--border); font-size: var(--fs-3); color: var(--text-muted); }
.lbs-inbox { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 150px; overflow: auto; }
.lbs-inbox li { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); font-size: var(--fs-3); }
.lbs-inbox-nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lbs-inbox-nm i { color: var(--text-faint); font-style: normal; font-size: var(--fs-2); }

/* 包内清单表：三线式，与全软件的报表排版同调 */
.lbs-plan { max-height: 260px; overflow-y: auto; }
.lbs-tb { width: 100%; border-collapse: collapse; font-size: var(--fs-3); }
.lbs-tb th { text-align: left; font-weight: 600; color: var(--text-muted); font-size: var(--fs-2); padding: 3px 6px; border-bottom: 1px solid var(--lb-rule, var(--border-strong)); position: sticky; top: 0; background: var(--bg); }
.lbs-tb td { padding: 3px 6px; border-bottom: 1px solid var(--lb-rule-soft, var(--border)); }
.lbs-k { width: 52px; color: var(--text-faint); white-space: nowrap; }
.lbs-nmc { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lbs-act { color: var(--text-muted); }
.lbs-tb tr.isnew .lbs-act { color: var(--text); }
</style>
