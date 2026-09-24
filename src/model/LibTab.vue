<script setup>
// 库页：缩略图画廊（NASA 3D Resources 的观感）+ 搜索 / 分段 / 类别 + 右键菜单 + 选中即预览、双击进模型页。
// 缩略图按可见性懒取（IntersectionObserver）：远端条目经 models:thumbnail 按需下载、参数化模板现场出图、本机缺图的补拍。
// 装配件（asm:）双击 / 右键进装配页；实体模板（ent:）右键「从此模板新建装配」；参数化卫星右键「转为装配件」。
import { ref, computed, inject, watch, nextTick, onMounted, onBeforeUnmount, onActivated } from 'vue'
import Icon from '../components/Icon.vue'
import { byLang, curLang } from '../shared/i18n/lang.js'
import { onLangChange } from '../shared/i18n/runtime.js'
import { SEGMENTS, CATEGORIES, filterEntries, entryFacts, displayName, fmtBytes, fmtInt, categoryOf, bodyBoxOfMeta } from './wbLogic.js'
import { DEFAULT_MODEL_ID, resolveParamModelId } from '@core/models/paramTemplates.mjs'

const wb = inject('wb')
const { st, cur } = wb
const langNow = ref(curLang())
onLangChange(() => { langNow.value = curLang() })
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v } catch { return d } }
const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch { /* 便利数据 */ } }

const q = ref(lsGet('model/lib/q', ''))
const seg = ref(SEGMENTS.some((s) => s.key === lsGet('model/lib/seg', 'all')) ? lsGet('model/lib/seg', 'all') : 'all')
const cat = ref(lsGet('model/lib/cat', 'all'))
watch(q, (v) => lsSet('model/lib/q', v)); watch(seg, (v) => lsSet('model/lib/seg', v)); watch(cat, (v) => lsSet('model/lib/cat', v))

const shown = computed(() => filterEntries(st.list, { seg: seg.value, cat: cat.value, q: q.value, lang: langNow.value }))
const segCount = computed(() => {
  const n = {}
  for (const s of SEGMENTS) n[s.key] = 0
  for (const e of st.list) { const f = entryFacts(e); n.all++; for (const k of ['builtin', 'cached', 'cloud', 'local', 'stk', 'param', 'asm']) if (f[k]) n[k]++ }
  return n
})
const cats = computed(() => {
  const have = new Set(st.list.map(categoryOf))
  return CATEGORIES.filter((c) => have.has(c.key))
})

const FID = {
  outreach: { icon: 'image', tip: '科普美术模型（outreach）：外形示意，尺寸与质量不作工程依据' },
  parametric: { icon: 'sliders-horizontal', tip: '参数化生成（parametric）：平台尺寸有出处，细节为示意值' },
  cad: { icon: 'box', tip: 'CAD 工程几何（cad）：来自 STEP / IGES / BREP，零件名保留' },
  engineering: { icon: 'weight', tip: '工程级（engineering）：尺寸与质量特性已核定' }
}
function nameOf(e) { void langNow.value; return displayName(e, langNow.value) }
function tipOf(e) {
  const f = entryFacts(e)
  const lines = [e.titleZh && e.title && e.titleZh !== e.title ? `${e.titleZh}\n${e.title}` : (e.titleZh || e.title || e.id), e.id]
  const src = e.source || {}
  if (src.credit) lines.push(src.credit)
  if (src.license) lines.push(src.license)
  const l0 = e.files && e.files.lod0
  if (l0 && l0.bytes) lines.push(`lod0 ${fmtBytes(l0.bytes)} · ${fmtInt(l0.tris)} ▲`)
  const b = e.units ? bodyBoxOfMeta(e) : null   // 落盘的 bboxM 是模型轴米，悬停读数给本体系（X 速度 · Y · Z 天底）
  if (b) {
    lines.push(`${[0, 1, 2].map((k) => (b.max[k] - b.min[k]).toPrecision(3)).join(' × ')} m${e.units.sizeVerified ? '' : '（尺寸未核定）'}`)
  }
  if (f.stk) lines.push('STK 本机模型：不可导出、不可分发（AGI SLA）')
  return lines.filter(Boolean).join('\n')
}
function dlOf(e) { return st.dl[e.id] || null }
function pctOf(e) { const d = dlOf(e); return d && d.total ? Math.min(100, Math.round((d.received / d.total) * 100)) : 0 }

// ============ 缩略图懒取 ============
const gridEl = ref(null)
let io = null
function observeAll() {
  if (!gridEl.value) return
  if (!io) {
    io = new IntersectionObserver((ents) => {
      for (const en of ents) {
        if (!en.isIntersecting) continue
        const id = en.target.getAttribute('data-id')
        const e = wb.byId(id)
        if (e) wb.requestThumb(e)
        io.unobserve(en.target)
      }
    }, { root: gridEl.value, rootMargin: '200px 0px' })
  }
  for (const el of gridEl.value.querySelectorAll('.card[data-id]')) {
    const id = el.getAttribute('data-id')
    if (!st.thumbs[id]) io.observe(el)
  }
}
watch(shown, () => nextTick(observeAll))
watch(() => st.list, () => nextTick(observeAll))
onMounted(() => nextTick(observeAll))
onActivated(() => nextTick(() => { observeAll(); scrollToSel() }))
onBeforeUnmount(() => { if (io) io.disconnect(); io = null })

// ============ 选中 / 预览 / 打开 ============
function pick(e) {
  if (!e) return
  wb.select(e.id, { lod: 'lod2' })
}
function openModel(e) {
  if (!e) return
  // 装配件：改动只能在装配页（模型页对它只读）
  if (isAsm(e)) { openAssembly(e); return }
  if (st.selId !== e.id) wb.select(e.id, { lod: 'lod0' })
  st.tab = 'model'
}
function openModelPage(e) {
  if (!e) return
  if (st.selId !== e.id) wb.select(e.id, { lod: 'lod0' })
  st.tab = 'model'
}
// ── 装配 ──
const isAsm = (e) => typeof e.id === 'string' && e.id.startsWith('asm:')
const isEnt = (e) => e.origin === 'entTemplate' || (typeof e.id === 'string' && e.id.startsWith('ent:'))
const canToAsm = (e) => { const f = entryFacts(e); return f.param && !isAsm(e) && !isEnt(e) && !e.fleet && (e.kind || 'spacecraft') === 'spacecraft' }
function openAssembly(e) { wb.requestAssembly({ kind: 'open', id: e.id }) }
function newFromTemplate(e) { wb.requestAssembly({ kind: 'template', entId: e.id }) }
function toAssembly(e) { wb.requestAssembly({ kind: 'spec', from: e.id }) }
const KIND_ICON = { ground: 'satellite-dish', aircraft: 'plane', ship: 'ship', vehicle: 'car' }
const phIcon = (e) => KIND_ICON[e.kind] || 'satellite'
function scrollToSel() {
  if (!gridEl.value || !st.selId) return
  const el = gridEl.value.querySelector(`.card[data-id="${CSS.escape(st.selId)}"]`)
  if (el) el.scrollIntoView({ block: 'nearest' })
}
// 方向键在画廊里移选（列数按实际排版量）
function navKey(ev) {
  const list = shown.value
  if (!list.length) return
  let i = list.findIndex((e) => e.id === st.selId)
  const cards = gridEl.value ? gridEl.value.querySelectorAll('.card') : []
  let cols = 1
  if (cards.length > 1) { const y0 = cards[0].offsetTop; cols = 0; for (const c of cards) { if (c.offsetTop !== y0) break; cols++ } cols = Math.max(1, cols) }
  let j = i
  if (ev.key === 'ArrowRight') j = i + 1
  else if (ev.key === 'ArrowLeft') j = i - 1
  else if (ev.key === 'ArrowDown') j = i + cols
  else if (ev.key === 'ArrowUp') j = i - cols
  else if (ev.key === 'Home') j = 0
  else if (ev.key === 'End') j = list.length - 1
  else if (ev.key === 'Enter') { if (i >= 0) openModel(list[i]); ev.preventDefault(); return }
  else return
  ev.preventDefault()
  if (i < 0) j = 0
  j = Math.max(0, Math.min(list.length - 1, j))
  pick(list[j])
  nextTick(scrollToSel)
}

// ============ 右键菜单 ============
const ctx = ref(null)   // {x, y, e}
function openCtx(ev, e) {
  ev.preventDefault()
  if (st.selId !== e.id) pick(e)
  const w = 210, h = 220
  ctx.value = { x: Math.min(ev.clientX, window.innerWidth - w - 6), y: Math.min(ev.clientY, window.innerHeight - h - 6), e }
}
function closeCtx() { ctx.value = null }
const ctxFacts = computed(() => (ctx.value ? entryFacts(ctx.value.e) : null))
function ctxDo(fn) { const e = ctx.value && ctx.value.e; closeCtx(); if (e) fn(e) }
const canDownload = (e) => { const f = entryFacts(e); return f.cloud && !(e.local && e.local.lod0 === 'ready') && !!wb.api }
const canRemoveCache = (e) => { const f = entryFacts(e); return f.cloud && (f.cached || f.partial) }
const canDelete = (e) => { const f = entryFacts(e); return (f.local || f.stk || (f.param && e.origin !== 'template')) && !!wb.api }
// GEO 缺省：主进程 validateBindings 已把 prefs.geoDefault 的旧模板 id 换成现行 id、缺省填 DEFAULT_MODEL_ID；
// 这里再兜一次（无 api 的预览 / prefs 还没读到时），星标与 3D 页 autoMatch 的 GEO 缺省始终是同一个 id
const geoDefaultId = computed(() => resolveParamModelId((st.prefs && st.prefs.geoDefault) || DEFAULT_MODEL_ID))
const isGeoDefault = (e) => geoDefaultId.value === e.id
// GEO 默认只收卫星类：实体模板（运行时现生成，3D 页没有文件可挂）与飞机 / 船 / 车 / 地球站条目设成 GEO 星的缺省模型没有意义
const canGeoDefault = (e) => !isEnt(e) && (!e.kind || e.kind === 'spacecraft')

const cacheText = computed(() => `${fmtBytes(st.cache.bytes || 0)} / ${fmtBytes(st.cache.cap || 0)}`)
</script>

<template>
  <div class="lib">
    <div class="lib-bar">
      <label class="lib-search">
        <Icon name="search" :size="13" />
        <input v-model="q" class="lib-q" type="text" spellcheck="false" placeholder="搜索" title="按中英文名、编号、标签、别名搜索；大小写、全角半角、连字符不计" />
        <button v-if="q" type="button" class="lib-x" title="清空" @click="q = ''"><Icon name="x" :size="12" /></button>
      </label>
      <select v-model="cat" class="ci lib-cat" title="类别">
        <option value="all">全部类别</option>
        <option v-for="c in cats" :key="c.key" :value="c.key">{{ c.label }}</option>
      </select>
      <button class="lb-mini lb-mini-ico" :disabled="!wb.api || !!st.busy" title="重新拉取云端模型清单" @click="wb.refreshRemote()"><Icon name="refresh-cw" :size="13" /></button>
    </div>
    <div class="lbu-seg lib-seg">
      <button v-for="s in SEGMENTS" :key="s.key" :class="{ on: seg === s.key }" :title="s.tip + ' · ' + segCount[s.key]" @click="seg = s.key">{{ s.label }}</button>
    </div>

    <div ref="gridEl" class="lib-grid" tabindex="0" @keydown="navKey">
      <div v-if="!shown.length" class="lb-placeholder lib-empty">{{ st.list.length ? '没有匹配的模型。' : '还没有模型。' }}</div>
      <div v-for="e in shown" :key="e.id" class="card" :class="{ on: st.selId === e.id, busy: !!dlOf(e) }" :data-id="e.id"
           @click="pick(e)" @dblclick="openModel(e)" @contextmenu="openCtx($event, e)">
        <div class="card-img">
          <img v-if="st.thumbs[e.id]" :src="st.thumbs[e.id]" crossorigin="anonymous" decoding="async" draggable="false" alt="" />
          <Icon v-else class="card-ph" :name="phIcon(e)" :size="30" :stroke-width="1.2" />
          <div class="card-bd">
            <span v-if="FID[e.fidelity]" class="card-b" :title="FID[e.fidelity].tip"><Icon :name="FID[e.fidelity].icon" :size="11" /></span>
            <span v-if="e.units && e.units.sizeVerified === false && e.fidelity !== 'parametric' && e.origin !== 'template'" class="card-b dim" title="尺寸未核定：比例按包围盒量级推断，可在「模型」页用已知尺寸反算"><Icon name="ruler" :size="11" /></span>
            <span v-if="entryFacts(e).stk" class="card-b" title="STK 本机模型：不可导出、不可分发（AGI SLA）"><Icon name="lock" :size="11" /></span>
            <span v-if="isAsm(e)" class="card-b" title="装配件"><Icon name="package" :size="11" /></span>
            <span v-else-if="isEnt(e)" class="card-b" title="实体模板"><Icon name="layers" :size="11" /></span>
            <span v-if="entryFacts(e).cloud && !entryFacts(e).ready && !dlOf(e)" class="card-b" title="云端：选中时下载预览档"><Icon name="cloud-download" :size="11" /></span>
            <span v-if="isGeoDefault(e)" class="card-b acc" title="GEO 通信星的默认模型"><Icon name="star" :size="11" /></span>
          </div>
          <div v-if="dlOf(e)" class="card-prog" :title="dlOf(e).lod + ' ' + pctOf(e) + '%'"><i :style="{ width: pctOf(e) + '%' }"></i></div>
        </div>
        <div class="card-name" :title="tipOf(e)" data-i18n-skip>{{ nameOf(e) }}</div>
      </div>
    </div>

    <div class="lib-foot">
      <span>共</span><b data-i18n-skip>{{ st.list.length }}</b><span>个</span>
      <template v-if="shown.length !== st.list.length"><span class="sep">·</span><span>显示</span><b data-i18n-skip>{{ shown.length }}</b></template>
      <span class="sep">·</span><span>已缓存</span><b data-i18n-skip>{{ cacheText }}</b>
    </div>

    <Teleport to="body">
      <div v-if="ctx" class="lb-ctx-mask" @mousedown="closeCtx" @contextmenu.prevent="closeCtx">
        <div class="lb-ctx" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }" @mousedown.stop>
          <button class="lb-ctx-i" @click="ctxDo(openModelPage)">在模型页打开</button>
          <button v-if="isAsm(ctx.e)" class="lb-ctx-i" data-act="lib-open-asm" @click="ctxDo(openAssembly)">在装配页打开</button>
          <button v-else-if="isEnt(ctx.e)" class="lb-ctx-i" data-act="lib-from-tpl" @click="ctxDo(newFromTemplate)">从此模板新建装配</button>
          <button v-else-if="canToAsm(ctx.e)" class="lb-ctx-i" data-act="lib-to-asm" title="按组件拆成装配文档（参数一一对应），在装配页继续手工增删" @click="ctxDo(toAssembly)">转为装配件</button>
          <div class="lb-ctx-sep"></div>
          <button v-if="!dlOf(ctx.e)" class="lb-ctx-i" :disabled="!canDownload(ctx.e)" @click="ctxDo((e) => wb.download(e.id, 'lod0'))">下载完整模型</button>
          <button v-else class="lb-ctx-i" @click="ctxDo((e) => wb.cancel(e.id))">取消下载</button>
          <button v-if="!ctxFacts.local && !ctxFacts.stk" class="lb-ctx-i" :disabled="!canRemoveCache(ctx.e)" @click="ctxDo((e) => wb.remove(e.id))">移除缓存</button>
          <button v-if="canDelete(ctx.e)" class="lb-ctx-i danger" @click="ctxDo((e) => wb.remove(e.id))">删除</button>
          <div class="lb-ctx-sep"></div>
          <button class="lb-ctx-i" :disabled="!wb.api || isGeoDefault(ctx.e) || ctxFacts.stk || !canGeoDefault(ctx.e)" :title="canGeoDefault(ctx.e) ? '3D 页自动匹配不到具体型号的 GEO 通信星用这个模型' : '只有卫星类模型能设为 GEO 默认'" @click="ctxDo((e) => wb.setGeoDefault(e.id))">设为 GEO 默认</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.lib { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 7px; }
.lib-bar { display: flex; align-items: center; gap: 6px; }
.lib-search { flex: 1; min-width: 0; display: flex; align-items: center; gap: 5px; height: var(--h-ctl); padding: 0 6px; color: var(--text-faint);
  background: var(--field-bg); border: 1px solid var(--field-border); border-radius: var(--r-ctl); }
.lib-search:focus-within { border-color: var(--accent-ui); }
.lib-q { flex: 1; min-width: 0; height: 100%; border: 0 !important; background: transparent !important; outline: none; padding: 0 !important; font-size: var(--fs-3); color: var(--text); box-shadow: none !important; }
.lib-x { display: inline-flex; padding: 0; border: 0; background: transparent; color: var(--text-faint); cursor: pointer; }
.lib-x:hover { color: var(--text); }
.lib-cat { flex: none; width: 104px; min-width: 0; }
.lib-seg { display: flex; width: 100%; }
.lib-seg > button { flex: 1 1 auto; min-width: 0; padding: 4px 3px; height: var(--h-ctl); font-size: var(--fs-2); overflow: hidden; text-overflow: ellipsis; }

.lib-grid {
  flex: 1; min-height: 0; overflow-y: auto; outline: none; align-content: start;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 8px; padding: 2px 2px 6px;
}
.lib-empty { grid-column: 1 / -1; padding-top: 40px; }
.card { display: flex; flex-direction: column; min-width: 0; cursor: pointer; border-radius: var(--r-card); padding: 3px; border: 1px solid transparent; transition: var(--t-state); }
.card:hover { border-color: var(--border); background: var(--surface); }
.card.on { border-color: var(--accent-ui); background: color-mix(in srgb, var(--accent-ui) 8%, var(--bg)); box-shadow: 0 0 0 1px var(--accent-ui); transition-duration: 0s; }
.card-img {
  position: relative; aspect-ratio: 1 / 1; border-radius: var(--r-box); overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  /* 影棚灰（比页面底色深一档）：NASA 美术件多是白 / 银，贴着近白底会整片消失 */
  background: radial-gradient(ellipse at 50% 36%, #f1f3f5 0%, #dfe3e8 58%, #c9ced6 100%);
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
}
html[data-theme='dark'] .card-img { background: radial-gradient(ellipse at 50% 38%, #3a3c40 0%, #26272a 60%, #18191b 100%); }
.card-img img { width: 100%; height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; }
.card-ph { color: color-mix(in srgb, var(--text-faint) 60%, transparent); }
.card-bd { position: absolute; left: 3px; top: 3px; display: flex; gap: 2px; }
.card-b { display: inline-flex; align-items: center; justify-content: center; width: 17px; height: 17px; border-radius: 3px; color: var(--text-muted);
  background: color-mix(in srgb, var(--bg) 82%, transparent); border: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
.card-b.dim { color: var(--text-faint); }
.card-b.acc { color: var(--accent-ui); }
.card-prog { position: absolute; left: 6px; right: 6px; bottom: 6px; height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--text) 14%, transparent); overflow: hidden; }
.card-prog i { display: block; height: 100%; background: var(--accent-ui); transition: width .2s linear; }
.card-name {
  margin-top: 4px; padding: 0 2px; font-size: var(--fs-2); line-height: 1.3; color: var(--text); min-height: 2.6em;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word;
}
.card.on .card-name { font-weight: 600; }
.lib-foot { flex: none; display: flex; align-items: baseline; gap: 4px; font-size: var(--fs-2); color: var(--text-muted); padding-top: 4px; border-top: 1px solid var(--border); }
.lib-foot b { font-weight: 600; color: var(--text); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.lib-foot .sep { color: var(--text-faint); padding: 0 2px; }
</style>
