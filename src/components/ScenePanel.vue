<script setup>
// 应用场景仿真 · 侧栏面板。
//
// ============ 二期重排：库 → 大纲 → 业务流 → 检查器 → 校验清单 → 结果 ============
// 一期是「模块库 / 模块 / 连线 / 业务流」四段并列 —— 连线自成一段，可它从来不是一个
// 独立的东西（它属于两个模块之间）；模块列表也只是一串平铺，看不出「哪几件在同一座站」。
// 二期改成【大纲树】：站点 ▸ 模块，边挂在模块下；「连线」那一段整个删掉。
// 新增【校验清单】：把「这张图现在还差什么」摊开，点一条即选中那个对象 ——
// 一期只有「点计算 → 引擎报一串错」，而错误里一半是「某某没有坐标」这种当场就能看出来的。
//
// 数据直接读 viz/scene/sceneStore.js（模块级单例），不经 props —— 拓扑视图与地图渲染读的是
// 同一份，「两种可视化是同一个场景的两个投影」这条约束在数据层就成立。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import SceneInspect from './SceneInspect.vue'
import SatPicker from './SatPicker.vue'
import {
  scene, loadLibrary, applyTemplate, applyBlueprint, newScene, addModule, removeModule, removeLink,
  addFlow, removeFlow, compute, effective, modById, libById, mediaLabel, tierOf, placeOf,
  snapshot, loadSatLibrary, satEntryOf, addSatModule, portsCompatible,
  lint, lintBlocks, pushUndo, undo, redo, canUndo, canRedo, fillSlot, pendingCount, refreshSteps
} from '../viz/scene/sceneStore.js'
import { drawSymbol } from '../viz/scene/sceneSymbols.js'
import { exportSceneReport } from '../shared/sceneReport.js'
import { mediaOf } from '../viz/scene/sceneStore.js'
import { siteKeyOf } from '../viz/scene/topoLayout.js'

const emit = defineEmits(['focus-module'])

const open = ref({ lib: true, tree: true, flows: true, lint: true })
const toggle = (k) => { open.value[k] = !open.value[k] }
const kw = ref('')
const catFilter = ref('')
const tplOpen = ref(false)
const tplInd = ref('')
const satPickOpen = ref(false)

onMounted(() => {
  loadLibrary()
  // 另一个窗口（端到端链路预算）可能改过同一份卫星库：回到本窗口时重读一次。
  // 这是「最后写入者赢」那条已知边界的补偿，见 viz/scene/sceneSatLib.js 头注。
  window.addEventListener('focus', onWinFocus)
})
onBeforeUnmount(() => window.removeEventListener('focus', onWinFocus))
function onWinFocus() { loadSatLibrary(true) }

// ── 模块库（按当前聚焦的槽过滤：按图施工时只列放得进这一槽的型号）──
const slotMod = computed(() => {
  const s = scene.sel
  if (!s || s.type !== 'module') return null
  const m = modById.value.get(s.id)
  return m && m.pending ? m : null
})
/**
 * 给某一槽挑型号时，「接得上」的判据：这一槽已有的每条边，对面若已定型，
 * 候选就得有一个能与对面那个端口相容的口。★ 不做这一步，用户按顺序逐槽选完，
 * 骨架上的边会掉一半（选站时星还没定、选星时站已经是别的频段了）。
 */
function fitsSlot(cand, inst) {
  const links = scene.links.filter((l) => l.a.modId === inst.id || l.b.modId === inst.id)
  if (!links.length) return true
  for (const l of links) {
    const otherId = l.a.modId === inst.id ? l.b.modId : l.a.modId
    const otherInst = modById.value.get(otherId)
    if (!otherInst || otherInst.pending) continue          // 对面还没定，不作数
    const other = effective(otherInst)
    const op = other && (other.ports || []).find((p) => p.key === (l.a.modId === inst.id ? l.b.portKey : l.a.portKey))
    if (!op) continue
    if (!(cand.ports || []).some((p) => portsCompatible(p, op).ok)) return false
  }
  return true
}
// 这一槽的分组里到底有没有条目（有才收窄；没有就退回同类，免得列表空掉）
const groupHasAny = computed(() => {
  const slot = slotMod.value && slotMod.value.slot
  if (!slot || !slot.accept || !slot.accept.group) return false
  return scene.lib.some((m) => !m.hidden && m.group === slot.accept.group && (!slot.accept.cats.length || slot.accept.cats.includes(m.cat)))
})
const filtered = computed(() => {
  const q = kw.value.trim().toLowerCase()
  const slot = slotMod.value && slotMod.value.slot
  const inst = slotMod.value
  return scene.lib.filter((m) => {
    if (m.hidden) return false
    if (slot && slot.accept && slot.accept.cats && slot.accept.cats.length && !slot.accept.cats.includes(m.cat)) return false
    // ★ 先按【分组】收窄：信关站槽与终端槽同属 B 类，只按类过滤会把 12 台终端列进
    //   「信关站」那一槽 —— 选中去，hub 那条骨干专线就没有端口可挂。同组没有条目才放宽到同类。
    if (slot && slot.accept && slot.accept.group && groupHasAny.value && m.group !== slot.accept.group) return false
    if (inst && !fitsSlot(m, inst)) return false
    if (!slot && catFilter.value && m.cat !== catFilter.value) return false
    if (!q) return true
    return [m.zh, m.en, m.id, (m.tags || []).join(' ')].filter(Boolean).join(' ').toLowerCase().includes(q)
  })
})
const grouped = computed(() => {
  const g = new Map()
  const gl = (scene.catalog && scene.catalog.groups) || {}
  for (const m of filtered.value) {
    const k = m.cat + '/' + m.group
    if (!g.has(k)) g.set(k, { key: k, cat: m.cat, zh: gl[m.group] || m.group, items: [] })
    g.get(k).items.push(m)
  }
  return [...g.values()].sort((a, b) => a.cat.localeCompare(b.cat))
})
// lib:false 的类别不在模块库里（A 空间段＝卫星，改为引用平台卫星库）
const cats = computed(() => ((scene.catalog && scene.catalog.modCats) || []).filter((c) => c.lib !== false))

// 库条目的小图标（16px canvas，符号与地图/拓扑同一支画笔）。
// 传的是【模块条目】不是图标名 —— 逐条映射与徽标都在 drawSymbol 里解析（sceneSymbolMap.js）。
function iconRef(el, mod) {
  if (!el) return
  const n = 32
  el.width = n; el.height = n
  const ctx = el.getContext('2d')
  ctx.clearRect(0, 0, n, n)
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#000'
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#fff'
  drawSymbol(ctx, mod, n / 2, n / 2, n * 0.96, ink, 0, bg)
}

// ── 放置：拖到拓扑画布（不需要坐标）/ 点图落点（要坐标）两条路 ──
function onLibDrag(e, libId) { e.dataTransfer.setData('text/scene-lib', libId); e.dataTransfer.effectAllowed = 'copy' }
function pickLib(libId) {
  // 正在给某个槽选型：点一下即落型号
  if (slotMod.value) {
    pushUndo('选型')
    const r = fillSlot(slotMod.value.id, libId)
    tip.value = r.dropped ? `${r.dropped} 条边端口对不上已删` : ''
    return
  }
  scene.placing = scene.placing === libId ? null : libId
  scene.sel = null
}
const placingName = computed(() => (scene.placing ? (libById.value.get(scene.placing) || {}).zh : ''))
const tip = ref('')

// ── 大纲树：站点 ▸ 模块 ▸ 边 ──
const outline = computed(() => {
  const mods = new Map()
  for (const inst of scene.modules) { const e = effective(inst); if (e) mods.set(inst.id, e) }
  const groups = new Map()
  for (const inst of scene.modules) {
    const k = mods.size ? siteKeyOf(mods, inst.id) : 'i:' + inst.id
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(inst)
  }
  const out = []
  for (const [k, list] of groups) {
    const host = list.find((m) => !(m.place && m.place.mode === 'mounted')) || list[0]
    const pl = placeOf(host.id)
    out.push({
      key: k,
      name: list.length > 1 ? (host.name || '站点') : '',
      pos: pl ? `${(+pl.lat).toFixed(2)}, ${(+pl.lon).toFixed(2)}` : '',
      rows: list.map((inst) => ({
        m: inst, e: mods.get(inst.id) || null,
        pending: !!inst.pending, slot: inst.slot || null,
        miss: inst.kind === 'sat' && !satEntryOf(inst),
        links: scene.links.filter((l) => l.a.modId === inst.id || l.b.modId === inst.id).map((l) => ({
          l, other: (modById.value.get(l.a.modId === inst.id ? l.b.modId : l.a.modId) || {}).name || '?',
          out: l.a.modId === inst.id
        }))
      }))
    })
  }
  return out
})
const openMod = ref({})
const toggleMod = (id) => { openMod.value[id] = !openMod.value[id] }
function selectMod(id) { scene.sel = { type: 'module', id }; scene.placing = null }
function selectLink(id) { scene.sel = { type: 'link', id }; scene.placing = null }
function selectFlow(id) { scene.sel = { type: 'flow', id }; scene.placing = null }

// ── 业务流 ──
const flowRows = computed(() => scene.flows.map((f) => ({
  f, a: (modById.value.get(f.aId) || {}).name || '?', b: (modById.value.get(f.bId) || {}).name || '?',
  r: scene.result ? (scene.result.flows || []).find((x) => x.id === f.id) : null
})))
const canAddFlow = computed(() => scene.modules.length >= 2)
function newFlow() {
  pushUndo('新建业务流')
  const ids = scene.modules.map((m) => m.id)
  addFlow(ids[0], ids[ids.length - 1])
  open.value.flows = true
}

// ── 模板：两条路 ──
const tplList = computed(() => scene.templates.filter((t) => !tplInd.value || t.industry === tplInd.value))
async function useTpl(id) { await applyTemplate(id); tplOpen.value = false; await compute() }
async function useBlueprint(id) { await applyBlueprint(id); tplOpen.value = false; scene.view = 'topo' }

// ── 校验清单 ──
const lintRows = computed(() => lint.value)
function gotoLint(x) {
  if (!x.id) return
  scene.sel = { type: x.type === 'flow' ? 'flow' : (x.type === 'link' ? 'link' : 'module'), id: x.id }
}

// ── 存档 ──
const cfgName = ref('')
async function saveCfg() {
  const api = typeof window !== 'undefined' ? window.api : null
  if (!api || !api.store) return
  // preload 的签名是 saveConfig(ns, cfg) 两个参数，不是一个对象
  const cfg = { id: scene.id || undefined, name: cfgName.value || scene.name, state: snapshot() }
  const r = await api.store.saveConfig('scene', cfg)
  if (r && r.id) scene.id = r.id
  saveTip.value = '已保存'
  setTimeout(() => { saveTip.value = '' }, 1600)
}
const saveTip = ref('')

// ── 方案报告（Excel 三线表，与链路预算报告同款版式）──
const rpBusy = ref('')
async function report() {
  if (!scene.result) { rpBusy.value = '先算一次'; setTimeout(() => { rpBusy.value = '' }, 1600); return }
  rpBusy.value = '导出中'
  try {
    const r = await exportSceneReport({ scene, result: scene.result, effective, mediaOf, tierOf })
    rpBusy.value = (r && r.ok) ? '已导出' : ((r && (r.canceled ? '' : r.error)) || '导出失败')
  } catch (e) { rpBusy.value = e.message } finally { setTimeout(() => { rpBusy.value = '' }, 2200) }
}

function delMod(id) { pushUndo('删除模块'); removeModule(id) }
function delLink(id) { pushUndo('删除连线'); removeLink(id) }
function delFlow(id) { pushUndo('删除业务流'); removeFlow(id) }
</script>

<template>
  <div class="cov-side sc-side docked">

    <!-- ═══ 工具条 ═══ -->
    <div class="sec sc-top">
      <div class="srow"><label>场景</label><input class="ci" v-model="scene.name" placeholder="场景名称" /></div>
      <div class="scbar">
        <button class="sb" @click="newScene()"><Icon name="plus" :size="12" /> 新建</button>
        <button class="sb" :class="{ on: tplOpen }" @click="tplOpen = !tplOpen"><Icon name="layers" :size="12" /> 模板</button>
        <button class="sb" @click="saveCfg"><Icon name="save" :size="12" /> 保存</button>
        <button class="sb" :disabled="!scene.result" title="导出方案报告（Excel · 三线表）" @click="report"><Icon name="file-down" :size="12" /> 报告</button>
        <button class="sb pri" :disabled="scene.busy" @click="compute()">
          <Icon name="play" :size="12" /> {{ scene.busy ? '计算中' : '计算' }}
        </button>
      </div>
      <div v-if="tplOpen" class="tpl">
        <div class="tplf">
          <span class="tg" :class="{ on: !tplInd }" @click="tplInd = ''">全部</span>
          <span v-for="i in scene.industries" :key="i" class="tg" :class="{ on: tplInd === i }" @click="tplInd = i">{{ i }}</span>
        </div>
        <div v-for="t in tplList" :key="t.id" class="tpli">
          <b>{{ t.zh }}</b><em>{{ t.hint }}</em>
          <div class="tpla">
            <span class="lnk" title="画出角色骨架，逐槽挑型号" @click="useBlueprint(t.id)">按图施工</span>
            <span class="lnk" title="按推荐型号整套落地" @click="useTpl(t.id)">用推荐一键落地</span>
          </div>
        </div>
      </div>
      <div class="scstat">
        <span>{{ scene.modules.length }} 模块 · {{ scene.links.length }} 边 · {{ scene.flows.length }} 流</span>
        <span v-if="rpBusy" class="okc">{{ rpBusy }}</span>
        <span v-else-if="saveTip" class="okc">{{ saveTip }}</span>
        <span v-else-if="scene.error" class="errc">{{ scene.error }}</span>
        <span v-else-if="scene.busy">…</span>
        <span v-else-if="scene.result && !scene.dirty">{{ scene.ms }} ms</span>
        <span v-else-if="scene.result && scene.dirty" class="warnc">输入已变</span>
      </div>
      <div v-for="(w, i) in scene.geoWarn" :key="'g' + i" class="warnc">{{ w }}</div>
      <div v-if="tip" class="warnc">{{ tip }}</div>
      <div class="scbar">
        <span class="seg2" role="group" aria-label="视图">
          <span :class="{ on: scene.view === 'map' }" @click="scene.view = 'map'">地图</span>
          <span :class="{ on: scene.view === 'topo' }" @click="scene.view = 'topo'">拓扑</span>
        </span>
        <button class="sb" :disabled="!canUndo" title="撤销（Ctrl+Z）" @click="undo()"><Icon name="undo-2" :size="12" /></button>
        <button class="sb" :disabled="!canRedo" title="重做（Ctrl+Y）" @click="redo()"><Icon name="redo-2" :size="12" /></button>
      </div>
      <div class="scbar">
        <button type="button" class="layersw" :class="{ on: scene.showLayer }" role="switch" :aria-checked="scene.showLayer ? 'true' : 'false'" title="显示 / 隐藏场景层" @click="scene.showLayer = !scene.showLayer"><i></i></button>
        <label class="chk2"><input type="checkbox" v-model="scene.labels" /><span>名称</span></label>
        <label class="chk2"><input type="checkbox" v-model="scene.showLinks" /><span>连线</span></label>
        <label class="chk2" title="阻塞项为零时自动重算"><input type="checkbox" v-model="scene.autoCalc" /><span>自动算</span></label>
        <span class="lnk" :class="{ on: scene.editPos }" :title="scene.editPos ? '完成，退出拖动' : '解锁鼠标拖动：在图上直接拖模块改坐标'" @click="scene.editPos = !scene.editPos">{{ scene.editPos ? '完成调整' : '调整位置' }}</span>
      </div>
    </div>

    <!-- ═══ 库 ═══ -->
    <div class="sec">
      <div class="sect acc" :class="{ open: open.lib }" @click="toggle('lib')">
        <Icon :name="open.lib ? 'chevron-down' : 'chevron-right'" :size="12" /><span>库</span>
        <span class="lnk" title="添加卫星：卫星库 / 轨位目录 / 星历搜索" @click.stop="satPickOpen = true">＋ 卫星</span>
        <span class="cnt">{{ filtered.length }}</span>
      </div>
      <template v-if="open.lib">
        <div class="srow"><input class="ci" v-model="kw" placeholder="搜模块 / 型号 / 行业" /></div>
        <div v-if="!slotMod" class="tplf">
          <span class="tg" :class="{ on: !catFilter }" @click="catFilter = ''">全部</span>
          <span v-for="c in cats" :key="c.key" class="tg" :class="{ on: catFilter === c.key }" :title="c.hint" @click="catFilter = c.key">{{ c.zh }}</span>
        </div>
        <div v-if="slotMod" class="hintbar">{{ slotMod.slot ? slotMod.slot.zh : '' }}：{{ slotMod.name }}<span class="x" @click="scene.sel = null"><Icon name="x" :size="11" /></span></div>
        <div v-if="scene.libError" class="errc">{{ scene.libError }}</div>
        <div v-if="scene.placing" class="hintbar">{{ placingName }}<span class="x" @click="scene.placing = null"><Icon name="x" :size="11" /></span></div>
        <div class="libl">
          <template v-for="g in grouped" :key="g.key">
            <div class="lgh">{{ g.zh }}</div>
            <div v-for="m in g.items" :key="m.id" class="lgi" :class="{ on: scene.placing === m.id }" :title="m.src"
                 draggable="true" @dragstart="onLibDrag($event, m.id)" @click="pickLib(m.id)">
              <canvas class="lic" :ref="(el) => iconRef(el, m)"></canvas>
              <span class="lnm">{{ m.zh }}</span>
              <span v-if="m.typical" class="tpc" title="电平类数值为该类设备典型值，非该型号实测">典</span>
              <span v-if="m.modified" class="tpc mod" title="已改过出厂值">改</span>
            </div>
          </template>
        </div>
      </template>
    </div>

    <!-- ═══ 大纲：站点 ▸ 模块 ▸ 边 ═══ -->
    <div class="sec">
      <div class="sect acc" :class="{ open: open.tree }" @click="toggle('tree')">
        <Icon :name="open.tree ? 'chevron-down' : 'chevron-right'" :size="12" /><span>大纲</span>
        <span class="cnt">{{ scene.modules.length }}</span>
      </div>
      <template v-if="open.tree">
        <div v-if="!scene.modules.length" class="empty">还没有模块。</div>
        <div class="mlist">
          <template v-for="g in outline" :key="g.key">
            <div v-if="g.name" class="ogh">{{ g.name }}<em v-if="g.pos">{{ g.pos }}</em></div>
            <template v-for="r in g.rows" :key="r.m.id">
              <div class="mrow2" :class="{ on: scene.sel && scene.sel.id === r.m.id, pend: r.pending }" @click="selectMod(r.m.id)">
                <span class="tw" @click.stop="toggleMod(r.m.id)"><Icon v-if="r.links.length" :name="openMod[r.m.id] ? 'chevron-down' : 'chevron-right'" :size="10" /></span>
                <canvas class="lic" :ref="(el) => iconRef(el, r.e)"></canvas>
                <span class="mnm">{{ r.m.name }}<em v-if="r.pending && r.slot">{{ r.slot.zh }} · 未选型</em><em v-if="r.miss" class="miss">卫星库条目不存在</em></span>
                <span class="mac" title="在图上定位" @click.stop="emit('focus-module', r.m.id)"><Icon name="crosshair" :size="11" /></span>
                <span class="del" @click.stop="delMod(r.m.id)"><Icon name="x" :size="12" /></span>
              </div>
              <div v-if="openMod[r.m.id]" class="lrow" v-for="lr in r.links" :key="lr.l.id"
                   :class="{ on: scene.sel && scene.sel.id === lr.l.id }" @click="selectLink(lr.l.id)">
                <span class="tier" :class="tierOf(lr.l.medium)"></span>
                <span class="mnm">{{ lr.out ? '→' : '←' }} {{ lr.other }}<em>{{ mediaLabel(lr.l.medium) }}</em></span>
                <span v-if="lr.l.role === 'backup'" class="tpc" title="备份链路：与主路并联，合成可用度走「至少一条在」">备</span>
                <span class="del" @click.stop="delLink(lr.l.id)"><Icon name="x" :size="11" /></span>
              </div>
            </template>
          </template>
        </div>
      </template>
    </div>

    <!-- ═══ 业务流 ═══ -->
    <div class="sec">
      <div class="sect acc" :class="{ open: open.flows }" @click="toggle('flows')">
        <Icon :name="open.flows ? 'chevron-down' : 'chevron-right'" :size="12" /><span>业务流</span>
        <span v-if="canAddFlow" class="lnk" @click.stop="newFlow">新建</span>
      </div>
      <template v-if="open.flows">
        <div v-if="!scene.flows.length" class="empty">还没有业务流。</div>
        <div class="mlist">
          <div v-for="r in flowRows" :key="r.f.id" class="frow" :class="{ on: scene.sel && scene.sel.id === r.f.id }" @click="selectFlow(r.f.id)">
            <div class="fhd">
              <span class="fnm">{{ r.f.name }}</span>
              <span class="fdir" :title="r.f.dir === 'bidir' ? '双向：两个方向各自成链' : '单向'">{{ r.f.dir === 'bidir' ? '⇄' : '→' }}</span>
              <span class="del" @click.stop="delFlow(r.f.id)"><Icon name="x" :size="12" /></span>
            </div>
            <div class="fsub">{{ r.a }} {{ r.f.dir === 'ba' ? '←' : (r.f.dir === 'ab' ? '→' : '⇄') }} {{ r.b }}</div>
            <div v-if="r.r" class="fnum">
              <span :class="{ neg: r.r.summary.marginDb != null && r.r.summary.marginDb < 0 }">
                {{ r.r.summary.marginDb == null ? '—' : r.r.summary.marginDb.toFixed(2) + ' dB' }}
              </span>
              <span>{{ r.r.summary.availPct == null ? '—' : r.r.summary.availPct.toFixed(3) + '%' }}</span>
              <span>{{ r.r.summary.rttMs != null ? r.r.summary.rttMs.toFixed(0) + ' ms' : (r.r.summary.latencyMs != null ? r.r.summary.latencyMs.toFixed(0) + ' ms' : '—') }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- ═══ 检查器 + 结果 ═══ -->
    <SceneInspect />

    <!-- ═══ 校验清单 ═══ -->
    <div class="sec">
      <div class="sect acc" :class="{ open: open.lint }" @click="toggle('lint')">
        <Icon :name="open.lint ? 'chevron-down' : 'chevron-right'" :size="12" /><span>校验清单</span>
        <span class="cnt" :class="{ neg: lintBlocks.length }">{{ lintBlocks.length }} / {{ lintRows.length }}</span>
      </div>
      <template v-if="open.lint">
        <div v-if="!lintRows.length" class="empty">没有待办项。</div>
        <div class="mlist">
          <div v-for="(x, i) in lintRows" :key="i" class="krow" :class="[x.level, { on: scene.sel && scene.sel.id === x.id }]" @click="gotoLint(x)">
            <span class="kdot"></span><span class="ktx">{{ x.text }}</span>
          </div>
        </div>
      </template>
    </div>

    <SatPicker v-if="satPickOpen" @close="satPickOpen = false" />
  </div>
</template>

<style scoped>
/* 侧栏外壳：与 SatCovPanel.vue / ConstellationMap3D.vue 的 .cov-side 一套同值副本
   （那两份是 scoped 的、进不到本组件）。改动请三处对照。 */
.cov-side { width: 286px; flex: none; border-left: 1px solid var(--border-strong); background: var(--surface); overflow-y: auto; display: flex; flex-direction: column; font-size: var(--fs-3); }
.cov-side.docked { width: auto; border-left: 0; overflow: visible; }
.sec { padding: 12px 16px; border-bottom: 1px solid var(--border); }
.sec > * + * { margin-top: 8px; }
.sec > * + .sect { margin-top: 12px; }
.sec > .sect + * { margin-top: 6px; }
.srow { --srow-lab: 70px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.srow label { color: var(--text-muted); min-width: var(--srow-lab); max-width: 100%; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.srow .ci { flex: 1; min-width: 0; border: 1px solid var(--field-border); background-color: var(--field-bg); padding: 3px 6px; font-size: var(--fs-3); outline: none; color: var(--text); }
.sect { display: flex; align-items: center; color: var(--text-muted); }
.sect.acc { cursor: pointer; user-select: none; gap: 5px; }
.sect.acc:hover { color: var(--text); }
.sect .lnk { margin-left: auto; color: var(--accent); cursor: pointer; font-size: var(--fs-3); }
.sect .lnk:hover { text-decoration: underline; }
.sect .lnk + .cnt { margin-left: 8px; }
.sect .cnt { margin-left: auto; color: var(--text-faint); font-size: var(--fs-2, 11px); font-variant-numeric: tabular-nums; }
.sect .cnt.neg { color: var(--danger); }

/* ── 工具条 ── */
.scbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sb { display: inline-flex; align-items: center; gap: 4px; height: var(--ctl-h, 24px); padding: 0 8px; border: 1px solid var(--field-border); background: var(--bg); color: var(--text); font-size: var(--fs-3); cursor: pointer; border-radius: var(--r-1, 2px); }
.sb:hover { border-color: var(--field-border-hover); }
.sb.on, .sb.pri { background: var(--accent-ui); border-color: var(--accent-ui); color: var(--bg); }
.sb:disabled { opacity: .55; cursor: default; }
.scstat { display: flex; gap: 10px; align-items: center; color: var(--text-faint); font-size: var(--fs-2, 11px); font-variant-numeric: tabular-nums; }
.okc { color: var(--ok); } .errc { color: var(--danger); font-size: var(--fs-2, 11px); } .warnc { color: var(--warn); font-size: var(--fs-2, 11px); line-height: 1.5; }
.lnk.on { font-weight: 600; }
.seg2 { display: inline-flex; border: 1px solid var(--field-border); border-radius: var(--r-1, 2px); overflow: hidden; }
.seg2 > span { padding: 2px 11px; cursor: pointer; color: var(--text-muted); user-select: none; }
.seg2 > span + span { border-left: 1px solid var(--field-border); }
.seg2 > span.on { background: var(--accent-ui); color: var(--bg); }

/* ── 模板 ── */
.tpl { border: 1px solid var(--border); background: var(--bg); max-height: 300px; overflow-y: auto; }
.tplf { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px; }
.tg { padding: 1px 7px; border: 1px solid var(--border); color: var(--text-muted); cursor: pointer; font-size: var(--fs-2, 11px); border-radius: var(--r-pill, 9px); }
.tg.on { background: var(--accent-ui); border-color: var(--accent-ui); color: var(--bg); }
.tpli { padding: 6px 9px; border-top: 1px solid var(--border); }
.tpli b { display: block; font-weight: 600; }
.tpli em { display: block; font-style: normal; color: var(--text-faint); font-size: var(--fs-2, 11px); margin-top: 2px; line-height: 1.45; }
.tpla { display: flex; gap: 12px; margin-top: 4px; }
.tpla .lnk { color: var(--accent); cursor: pointer; font-size: var(--fs-2, 11px); }
.tpla .lnk:hover { text-decoration: underline; }

/* ── 库列表 ── */
.libl { max-height: 300px; overflow-y: auto; border: 1px solid var(--border); background: var(--bg); }
.lgh { padding: 4px 8px; background: var(--surface-2); color: var(--text-muted); font-size: var(--fs-2, 11px); position: sticky; top: 0; }
.lgi { display: flex; align-items: center; gap: 6px; padding: 3px 8px; cursor: grab; }
.lgi:hover { background: var(--accent-ui-wash); }
.lgi.on { background: var(--accent-ui-weak); }
.lic { width: 16px; height: 16px; flex: none; }
.lnm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tpc { flex: none; font-size: 9px; padding: 0 3px; border: 1px solid var(--border-strong); color: var(--text-faint); border-radius: 2px; }
.tpc.mod { color: var(--accent-ui); border-color: var(--accent-ui); }

/* ── 大纲 ── */
.mlist { max-height: 280px; overflow-y: auto; }
.ogh { padding: 3px 6px; background: var(--surface-2); color: var(--text-muted); font-size: var(--fs-2, 11px); display: flex; gap: 8px; }
.ogh em { font-style: normal; color: var(--text-faint); margin-left: auto; font-variant-numeric: tabular-nums; }
.mrow2 { display: flex; align-items: center; gap: 5px; padding: 3px 4px; cursor: pointer; border-bottom: 1px solid var(--border); }
.mrow2:hover { background: var(--accent-ui-wash); }
.mrow2.on { background: var(--accent-ui-weak); }
.mrow2.pend { opacity: .75; }
.mrow2.pend .mnm { font-style: italic; }
.tw { width: 12px; flex: none; display: inline-flex; color: var(--text-faint); }
.lrow { display: flex; align-items: center; gap: 5px; padding: 2px 4px 2px 26px; cursor: pointer; border-bottom: 1px solid var(--border); font-size: var(--fs-2, 11px); }
.lrow:hover { background: var(--accent-ui-wash); }
.lrow.on { background: var(--accent-ui-weak); }
.mnm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mnm em { font-style: normal; color: var(--text-faint); margin-left: 5px; font-size: var(--fs-2, 11px); }
.mnm em.miss { color: var(--danger); }
.mac, .del { flex: none; color: var(--text-faint); cursor: pointer; padding: 1px; }
.mac:hover, .del:hover { color: var(--text); }
.tier { width: 3px; align-self: stretch; flex: none; background: var(--border-strong); }
.tier.satellite { background: var(--accent-ui); }
.tier.contract { background: var(--warn); }
.tier.power { background: var(--text); }
.tier.supply { background: var(--text-faint); }
.empty { color: var(--text-faint); }
.hintbar { display: flex; align-items: center; gap: 6px; padding: 3px 7px; background: var(--accent-ui-weak); color: var(--text); font-size: var(--fs-2, 11px); }
.hintbar .x { margin-left: auto; cursor: pointer; }

/* ── 业务流 ── */
.frow { padding: 5px 4px; border-bottom: 1px solid var(--border); cursor: pointer; }
.frow:hover { background: var(--accent-ui-wash); }
.frow.on { background: var(--accent-ui-weak); }
.fhd { display: flex; align-items: center; gap: 6px; }
.fnm { flex: 1; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fdir { color: var(--accent-ui); font-size: 13px; }
.fsub { color: var(--text-faint); font-size: var(--fs-2, 11px); margin-top: 1px; }
.fnum { display: flex; gap: 12px; margin-top: 3px; font-variant-numeric: tabular-nums; font-size: var(--fs-2, 11px); color: var(--text-muted); }
.fnum .neg { color: var(--danger); }

/* ── 校验清单 ── */
.krow { display: flex; align-items: baseline; gap: 6px; padding: 3px 4px; cursor: pointer; border-bottom: 1px solid var(--border); font-size: var(--fs-2, 11px); }
.krow:hover { background: var(--accent-ui-wash); }
.krow.on { background: var(--accent-ui-weak); }
.kdot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--warn); }
.krow.block .kdot { background: var(--danger); }
.ktx { flex: 1; min-width: 0; color: var(--text-muted); line-height: 1.5; }
.krow.block .ktx { color: var(--text); }
</style>
