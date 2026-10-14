<script setup>
// 库页：缩略图画廊（NASA 3D Resources 的观感）+ 搜索 / 分段 / 类别 + 右键菜单 + 选中即预览、双击在设计页打开。
// 缩略图按可见性懒取（IntersectionObserver）：远端条目经 models:thumbnail 按需下载、参数化模板现场出图、本机缺图的补拍。
// 单击 / 方向键 = 选中（视口预览）；离开设计页之后在这里选过的那一项，进设计页时打开为签（wb.notePick，事件触发）。
// 打开（双击 / Enter / 右键「打开」，wb.openInDesign）= 打开或激活签：装配件 → 装配签；卫星整星模板 / 实体模板 → 模板签
// （原样不入库，编辑时自动创建副本）；其余 → 模型签。右键「查看模型属性」= 模型签（模板 / 装配件也按只读模型看）。
// 进库页时选中项跟随设计页激活签对应的库条目（wbStore 里做），这里只负责滚到可见。
// 右键「新建副本」（§3.2）：装配件不经编辑直接复制一份（新 id、「<名称> 副本」）并在设计页打开为新签。
// 2026-10-12 页眉两档「模型 | 组件」（同设计页左栏的连体页签）：组件档 = 全部组件与常用型号（LibComps.vue），两档各记各的选中项，
//   视口显示当前档的那一件（wb.setLibPane）。页眉由本页自己画（ModelApp 不给库页套通用栏头）。
import { ref, computed, inject, watch, nextTick, onMounted, onBeforeUnmount, onActivated } from 'vue'
import Icon from '../components/Icon.vue'
import LibComps from './LibComps.vue'
import { byLang, curLang } from '../shared/i18n/lang.js'
import { onLangChange } from '../shared/i18n/runtime.js'
import { SEGMENTS, CATEGORIES, filterEntries, entryFacts, displayName, fmtBytes, fmtInt, categoryOf, bodyBoxOfMeta, previewLod } from './wbLogic.js'
import { DEFAULT_MODEL_ID, resolveParamModelId } from '@core/models/paramTemplates.mjs'

const wb = inject('wb')
const { st, cur } = wb
// 左栏的档：模型库 / 组件库（档位在 wb.st.libPane，跨开窗记住）；组件档第一次打开时才挂（之后 v-show 保留滚动位置）
const pane = computed({ get: () => st.libPane, set: (v) => wb.setLibPane(v) })
const compSeen = ref(st.libPane === 'comp')
watch(pane, (v) => { if (v === 'comp') compSeen.value = true })
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
// 选中项跟随激活签（进库页时 wbStore 换选中）：滚到可见
watch(() => st.selId, () => { if (st.tab === 'lib') nextTick(scrollToSel) })
onBeforeUnmount(() => { if (io) io.disconnect(); io = null })

// ============ 选中 / 预览 / 打开 ============
function pick(e) {
  if (!e) return
  wb.notePick(e.id)
  wb.select(e.id, { lod: previewLod(e) })
}
function openModel(e) {
  if (!e) return
  wb.openInDesign(e.id)
}
/** 模型签：直接在设计页模型视图看这一件（模板 / 装配件只读，可看质量特性、挂点、关节等模型级属性） */
function openModelPage(e) {
  if (!e) return
  wb.openModelTab(e.id)
}
// ── 装配 ──
const isAsm = (e) => typeof e.id === 'string' && e.id.startsWith('asm:')
const isEnt = (e) => e.origin === 'entTemplate' || (typeof e.id === 'string' && e.id.startsWith('ent:'))
const isTpl = (e) => isEnt(e) || (e.origin === 'template' && !e.fleet)
/** 已存参数化件（param:<哈希>）：以它的整星参数新建驱动装配件 */
const canCopy = (e) => { const f = entryFacts(e); return f.param && !isAsm(e) && !isTpl(e) && !e.fleet && (e.kind || 'spacecraft') === 'spacecraft' }
function copyAssembly(e) { wb.requestAssembly({ kind: 'spec', from: e.id }) }
/** 装配件：不经编辑直接复制并打开（已打开着 = 按签里的当前内容） */
const canDup = (e) => isAsm(e) && !!wb.api
function dupAssembly(e) { wb.copyLibAsm(e.id) }
const openTip = (e) => (isTpl(e) ? '在设计页打开为模板签（编辑时自动创建副本）' : '在设计页打开')
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
  <div class="libw">
    <div class="libw-hd">
      <div class="libw-tabs" role="tablist">
        <button type="button" role="tab" data-act="lib-pane-model" :class="{ on: pane === 'model' }" :aria-selected="pane === 'model'"
                title="模型库：内置 / 云端 / 本机 / STK / 参数化 / 装配" @click="pane = 'model'">模型</button>
        <button type="button" role="tab" data-act="lib-pane-comp" :class="{ on: pane === 'comp' }" :aria-selected="pane === 'comp'"
                title="组件库：全部组件与常用型号，按功能分组；单击预览，双击以此为根件新建装配件" @click="pane = 'comp'">组件</button>
      </div>
    </div>
    <div class="libw-bd">
      <div v-show="pane === 'model'" class="lib">
        <div class="lib-bar">
          <label class="lib-search search-field">
            <Icon name="search" :size="12" />
            <input v-model="q" class="lib-q" type="text" spellcheck="false" placeholder="搜索" title="按中英文名称、编号、标签、别名搜索；不区分大小写、全角半角与连字符" />
            <button v-if="q" type="button" class="lib-x" title="清空" @click="q = ''"><Icon name="x" :size="12" /></button>
          </label>
          <select v-model="cat" class="ci lib-cat" title="类别">
            <option value="all">全部类别</option>
            <option v-for="c in cats" :key="c.key" :value="c.key">{{ c.label }}</option>
          </select>
          <button class="lb-mini lb-mini-ico" :disabled="!wb.api || !!st.busy" title="刷新云端模型清单" @click="wb.refreshRemote()"><Icon name="refresh-cw" :size="12" /></button>
        </div>
        <div class="lbu-seg lib-seg">
          <button v-for="s in SEGMENTS" :key="s.key" :class="{ on: seg === s.key }" :aria-pressed="(seg === s.key) ? 'true' : 'false'" :title="s.tip + ' · ' + segCount[s.key]" @click="seg = s.key">{{ s.label }}</button>
        </div>

        <div ref="gridEl" class="lib-grid" tabindex="0" @keydown="navKey">
          <div v-if="!shown.length" class="lb-placeholder lib-empty">{{ st.list.length ? '无匹配模型。' : '暂无模型。' }}</div>
          <div v-for="e in shown" :key="e.id" class="card" :class="{ on: st.selId === e.id, busy: !!dlOf(e) }" :data-id="e.id"
               @click="pick(e)" @dblclick="openModel(e)" @contextmenu="openCtx($event, e)">
            <div class="card-img">
              <img v-if="st.thumbs[e.id]" :src="st.thumbs[e.id]" crossorigin="anonymous" decoding="async" draggable="false" alt="" />
              <Icon v-else class="card-ph" :name="phIcon(e)" :size="30" :stroke-width="1.2" />
              <div class="card-bd">
                <span v-if="FID[e.fidelity]" class="card-b" :title="FID[e.fidelity].tip"><Icon :name="FID[e.fidelity].icon" :size="12" /></span>
                <span v-if="e.units && e.units.sizeVerified === false && e.fidelity !== 'parametric' && e.origin !== 'template'" class="card-b dim" title="尺寸未核定：比例按包围盒量级推断，可在设计页快速设置「尺寸」中按已知尺寸反算"><Icon name="ruler" :size="12" /></span>
                <span v-if="entryFacts(e).stk" class="card-b" title="STK 本机模型：不可导出、不可分发（AGI SLA）"><Icon name="lock" :size="12" /></span>
                <span v-if="isAsm(e)" class="card-b" title="装配件"><Icon name="package" :size="12" /></span>
                <span v-else-if="isEnt(e)" class="card-b" title="实体模板"><Icon name="layers" :size="12" /></span>
                <span v-if="entryFacts(e).cloud && !entryFacts(e).ready && !dlOf(e)" class="card-b" title="云端模型：选中时下载预览精度文件"><Icon name="cloud-download" :size="12" /></span>
                <span v-if="isGeoDefault(e)" class="card-b acc" title="GEO 通信卫星默认模型"><Icon name="star" :size="12" /></span>
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
          <div v-if="ctx" class="lb-ctx-mask menu-mask" @mousedown="closeCtx" @contextmenu.prevent="closeCtx">
            <div class="lb-ctx menu" role="menu" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }" @mousedown.stop>
              <button class="lb-ctx-i menu-item" role="menuitem" data-act="lib-open" :title="openTip(ctx.e)" @click="ctxDo(openModel)">打开</button>
              <button v-if="canDup(ctx.e)" class="lb-ctx-i menu-item" role="menuitem" data-act="lib-dup" title="复制为新的装配件并在设计页打开" @click="ctxDo(dupAssembly)">新建副本</button>
              <button v-if="canCopy(ctx.e)" class="lb-ctx-i menu-item" role="menuitem" data-act="lib-copy" title="以本模型的整星参数新建驱动装配件（快速设置与逐件编辑均可用，原件不变）" @click="ctxDo(copyAssembly)">新建可编辑副本</button>
              <button class="lb-ctx-i menu-item" role="menuitem" data-act="lib-props" title="在设计页模型视图中查看质量特性、挂点、关节等模型级属性" @click="ctxDo(openModelPage)">查看模型属性</button>
              <div class="lb-ctx-sep menu-sep" role="separator"></div>
              <button v-if="!dlOf(ctx.e)" class="lb-ctx-i menu-item" role="menuitem" :disabled="!canDownload(ctx.e)" @click="ctxDo((e) => wb.download(e.id, 'lod0'))">下载完整模型</button>
              <button v-else class="lb-ctx-i menu-item" role="menuitem" @click="ctxDo((e) => wb.cancel(e.id))">取消下载</button>
              <button v-if="!ctxFacts.local && !ctxFacts.stk" class="lb-ctx-i menu-item" role="menuitem" :disabled="!canRemoveCache(ctx.e)" @click="ctxDo((e) => wb.remove(e.id))">移除缓存</button>
              <button v-if="canDelete(ctx.e)" class="lb-ctx-i menu-item danger" role="menuitem" @click="ctxDo((e) => wb.remove(e.id))">删除</button>
              <div class="lb-ctx-sep menu-sep" role="separator"></div>
              <button class="lb-ctx-i menu-item" role="menuitem" :disabled="!wb.api || isGeoDefault(ctx.e) || ctxFacts.stk || !canGeoDefault(ctx.e)" :title="canGeoDefault(ctx.e) ? '3D 页中未匹配到具体型号的 GEO 通信卫星采用此模型' : '仅卫星类模型可设为 GEO 默认模型'" @click="ctxDo((e) => wb.setGeoDefault(e.id))">设为 GEO 默认模型</button>
            </div>
          </div>
        </Teleport>
      </div>
      <LibComps v-if="compSeen" v-show="pane === 'comp'" />
    </div>
  </div>
</template>

<style scoped>
.libw { flex: 1; min-height: 0; display: flex; flex-direction: column; }
/* 页眉两档：经典连体页签（同 design/DesignSide.vue 的 .dsg-hd / .dsg-tabs：选中页与内容面同底 + 底缘机位色） */
.libw-hd { flex: none; display: flex; align-items: center; height: 30px; padding: 0 8px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.libw-tabs { display: flex; align-self: stretch; gap: 0; }
.libw-tabs > button {
  position: relative; display: inline-flex; align-items: center; padding: 0 12px; font: inherit; font-size: var(--fs-3); font-weight: 600; cursor: pointer;
  color: var(--text-muted); background: transparent; border: 0; border-right: 1px solid transparent; border-left: 1px solid transparent; transition: var(--t-state);
}
.libw-tabs > button:hover:not(.on) { color: var(--text); background: var(--wash-hover); }
.libw-tabs > button.on { color: var(--text); background: var(--bg); border-left-color: var(--border); border-right-color: var(--border); transition-duration: 0s; }
.libw-tabs > button.on::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: var(--accent-ui); }
.libw-tabs > button:first-child.on { border-left-color: transparent; }
.libw-bd { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 10px 10px 16px; }
.lib { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 7px; }
.lib-bar { display: flex; align-items: center; gap: 6px; }
.lib-search { flex: 1; min-width: 0; display: flex; align-items: center; gap: 5px; height: var(--h-ctl); padding: 0 6px; color: var(--text-faint);
  background: var(--field-bg); border: 1px solid var(--field-border); border-radius: var(--r-ctl); }
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
