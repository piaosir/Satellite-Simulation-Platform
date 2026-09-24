<script setup>
// 装配结构树（契约 §6.4）：照 ConfigTree 的几何写（名称起点 41 + 14d、每层一根绝对定位导引线、chevron-down .disc 折叠），不复用组件
// （ConfigTree 只许文件夹有子项）。行 = 文档主件按树序；派生件不单列，用对称角标 ×n 给出件数。
//   · 选择：单击选中、Ctrl 切换、Shift 按行序连选；选择的真相在编辑器（select 事件回写 ui.selIds），这里只发命令。
//   · 键盘：↑↓ 移选、←→ 折叠 / 展开（或跳父 / 首子）、F2 改名、Delete 删除、Enter 取景（处理过的键 preventDefault，全局快捷键不再重复处理）。
//   · 行拖动改父件（pointer 方案，越过 4 px 开始）：落在另一行 = reparent（方式变自由、保持世界位姿）；拖到树外取消。
//   · 右键菜单（树与视口 context 事件共用一份：ui.ctx）。
import { inject, computed, ref, watch, nextTick, onBeforeUnmount } from 'vue'
import Icon from '../../components/Icon.vue'
import { DRAG_START_PX } from '@core/models/asmSnap.mjs'
import { defaultAsmName } from '@core/models/asmMeta.mjs'
import { getComponent } from '@core/models/components/index.mjs'
import { flattenTree, subtreeIds, compById, splitSymInfo, DOMAIN_LABELS } from '../asmLogic.js'

const asm = inject('asm')
const wb = inject('wb')
const ui = asm.ui

const doc = computed(() => asm.doc.value)
const domain = computed(() => (doc.value && doc.value.domain) || wb.asm.domain || 'spacecraft')
const docName = computed(() => (doc.value && doc.value.name) || defaultAsmName(domain.value))
const nComps = computed(() => (doc.value ? doc.value.comps.length : 0))
// 树头与视口读数同一个口径：展开对称后的件数（主件数进 title）
const nAll = computed(() => (ui.ready && ui.stats.count >= nComps.value ? ui.stats.count : nComps.value))
const collapsed = ref(new Set())
const rows = computed(() => (doc.value ? flattenTree(doc.value, collapsed.value) : []))
const selSet = computed(() => new Set(ui.selIds))
const badSet = computed(() => new Set(Object.keys(ui.invalid || {})))
const rootEl = ref(null)

function toggle(id) {
  const s = new Set(collapsed.value)
  if (s.has(id)) s.delete(id); else s.add(id)
  collapsed.value = s
}
// 视口里点中的件藏在折叠的父件下：展开祖先并滚到可见
function reveal(id) {
  const d = doc.value
  if (!d) return
  const s = new Set(collapsed.value)
  let c = compById(d, id), changed = false, guard = 0
  while (c && c.parent && guard++ < 256) { if (s.delete(c.parent)) changed = true; c = compById(d, c.parent) }
  if (changed) collapsed.value = s
  nextTick(() => { const el = rootEl.value && rootEl.value.querySelector(`[data-id="${CSS.escape(id)}"]`); if (el) el.scrollIntoView({ block: 'nearest' }) })
}
watch(() => ui.primary, (id) => { if (id) reveal(id) })

// ── 选择 ──
let anchor = null, suppressClick = false
function onRowClick(ev, r) {
  if (suppressClick) { suppressClick = false; return }
  if (ui.renaming) return
  if (ev.ctrlKey || ev.metaKey) { asm.select([r.id], { toggle: true }); anchor = r.id }
  else if (ev.shiftKey && anchor) {
    const ids = rows.value.map((x) => x.id)
    const a = ids.indexOf(anchor), b = ids.indexOf(r.id)
    if (a >= 0 && b >= 0) asm.select(ids.slice(Math.min(a, b), Math.max(a, b) + 1))
    else asm.select([r.id])
  } else { asm.select([r.id]); anchor = r.id }
  if (rootEl.value) rootEl.value.focus({ preventScroll: true })
}
function onKey(ev) {
  // 焦点在树里的输入框上（行内改名 / 文档名）：按键归输入框，不当树导航（改名回车提交后不再冒泡成「取景」）
  if (ev.target !== rootEl.value || ui.renaming || ev.isComposing) return
  const list = rows.value
  if (!list.length) return
  const cur = ui.primary || ui.selIds[0] || null
  const i = list.findIndex((r) => r.id === cur)
  const r = i >= 0 ? list[i] : null
  const go = (j) => { const x = list[Math.max(0, Math.min(list.length - 1, j))]; asm.select([x.id]); anchor = x.id }
  switch (ev.key) {
    case 'ArrowDown': go(i < 0 ? 0 : i + 1); break
    case 'ArrowUp': go(i < 0 ? 0 : i - 1); break
    case 'Home': go(0); break
    case 'End': go(list.length - 1); break
    case 'ArrowLeft':
      if (!r) return
      if (r.hasKids && r.open) toggle(r.id)
      else if (r.parent) { const p = list.findIndex((x) => x.id === r.parent); if (p >= 0) go(p) }
      break
    case 'ArrowRight':
      if (!r || !r.hasKids) return
      if (!r.open) toggle(r.id)
      else go(i + 1)
      break
    case 'F2': if (r) startRename(r.id); break
    case 'Delete': case 'Backspace': if (ui.selIds.length) asm.remove(); break
    case 'Enter': asm.frameSelection(); break
    default: return
  }
  ev.preventDefault()
}

// ── 改名（行内）──
const renameDraft = ref('')
const renameIn = ref(null)
function startRename(id) {
  const c = doc.value && compById(doc.value, id)
  if (!c || c.locked) return
  ui.renaming = id
  renameDraft.value = c.name || ''
  nextTick(() => { const el = Array.isArray(renameIn.value) ? renameIn.value[0] : renameIn.value; if (el) { el.focus(); el.select() } })
}
function commitRename() {
  const id = ui.renaming
  if (!id) return
  ui.renaming = ''
  const c = doc.value && compById(doc.value, id)
  const v = renameDraft.value.trim()
  if (c && v !== (c.name || '')) asm.cmd({ type: 'rename', id, name: v })
  nextTick(() => rootEl.value && rootEl.value.focus({ preventScroll: true }))
}
function cancelRename() { ui.renaming = ''; nextTick(() => rootEl.value && rootEl.value.focus({ preventScroll: true })) }
const defTitle = (type) => { const d = getComponent(type); return d ? d.titleZh || d.title : type }

// 文档名（头行双击改名）
const docRenaming = ref(false), docDraft = ref(''), docIn = ref(null)
function startDocRename() { docDraft.value = (doc.value && doc.value.name) || ''; docRenaming.value = true; nextTick(() => { if (docIn.value) { docIn.value.focus(); docIn.value.select() } }) }
function commitDoc() {
  if (!docRenaming.value) return
  docRenaming.value = false
  const v = docDraft.value.trim()
  if (doc.value && v !== doc.value.name) asm.cmd({ type: 'setDoc', patch: { name: v || defaultAsmName(domain.value) } })
}

// ── 行拖动改父件 ──
const dragId = ref(''), dropId = ref(''), dropBad = ref('')
let drag = null
function onRowDown(ev, r) {
  if (ev.button !== 0 || ui.renaming || r.locked || !r.parent) return
  drag = { id: r.id, x: ev.clientX, y: ev.clientY, pid: ev.pointerId, on: false, sub: null }
  window.addEventListener('pointermove', onDragMove, true)
  window.addEventListener('pointerup', onDragUp, true)
  window.addEventListener('pointercancel', endDrag, true)
}
function onDragMove(ev) {
  if (!drag || ev.pointerId !== drag.pid) return
  if (!drag.on) {
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y
    if (dx * dx + dy * dy < DRAG_START_PX * DRAG_START_PX) return
    drag.on = true
    drag.sub = subtreeIds(doc.value, drag.id)
    dragId.value = drag.id
    document.body.style.cursor = 'grabbing'
  }
  const el = document.elementFromPoint(ev.clientX, ev.clientY)
  const row = el && el.closest ? el.closest('.asm-tr[data-id]') : null
  const tid = row && rootEl.value && rootEl.value.contains(row) ? row.getAttribute('data-id') : ''
  const c = compById(doc.value, drag.id)
  const ok = !!tid && !drag.sub.has(tid) && !!c && c.parent !== tid
  dropId.value = ok ? tid : ''
  dropBad.value = tid && !ok && tid !== drag.id ? tid : ''
}
function onDragUp(ev) {
  if (!drag || ev.pointerId !== drag.pid) return
  const d = drag, target = dropId.value
  endDrag()
  if (!d.on) return
  suppressClick = true
  setTimeout(() => { suppressClick = false }, 0)
  if (target) asm.cmd({ type: 'reparent', id: d.id, parent: target })
}
function endDrag() {
  drag = null
  dragId.value = ''; dropId.value = ''; dropBad.value = ''
  document.body.style.cursor = ''
  window.removeEventListener('pointermove', onDragMove, true)
  window.removeEventListener('pointerup', onDragUp, true)
  window.removeEventListener('pointercancel', endDrag, true)
}

// ── 隐藏 / 锁定 ──
function setHidden(r) { asm.cmd({ type: 'setHidden', ids: [r.id], on: !r.hidden }) }
function setLocked(r) { asm.cmd({ type: 'setLocked', ids: [r.id], on: !r.locked }) }

// ── 右键菜单（树 / 视口共用 ui.ctx）──
function onCtx(ev, r) {
  if (!selSet.value.has(r.id)) asm.select([r.id])
  const ids = selSet.value.has(r.id) ? ui.selIds.slice() : [r.id]
  ui.ctx = { ids, x: ev.clientX, y: ev.clientY }
}
// 视口右键在没选中的件上：先选中它，菜单作用于选择集
watch(() => ui.ctx, (c) => { if (c && c.ids.length && !c.ids.every((id) => selSet.value.has(id))) asm.select(c.ids) })
const ctxComps = computed(() => (ui.ctx && doc.value ? ui.ctx.ids.map((id) => compById(doc.value, id)).filter(Boolean) : []))
const ctxOne = computed(() => (ctxComps.value.length === 1 ? ctxComps.value[0] : null))
const ctxPos = computed(() => {
  const c = ui.ctx
  if (!c) return {}
  const w = 200, h = 330
  return { left: Math.max(4, Math.min(c.x, window.innerWidth - w - 6)) + 'px', top: Math.max(4, Math.min(c.y, window.innerHeight - h - 6)) + 'px' }
})
const ctxAllHidden = computed(() => ctxComps.value.length > 0 && ctxComps.value.every((c) => c.hidden))
const ctxAllLocked = computed(() => ctxComps.value.length > 0 && ctxComps.value.every((c) => c.locked))
const ctxAnyLocked = computed(() => ctxComps.value.some((c) => c.locked))
const ctxHasRoot = computed(() => ctxComps.value.some((c) => c.parent === null))
const ctxSplit = computed(() => (ctxOne.value ? splitSymInfo(ctxOne.value) : { ok: false, why: '' }))
function closeCtx() { ui.ctx = null }
// 菜单动作只按调用时刻那份 ui.ctx 取件（关菜单会把 ui.ctx 置空、依赖它的 computed 随之变空）：先取件再关菜单
function ctxDo(fn) { const c = ui.ctx; if (c) fn(c); ui.ctx = null }
const compsOf = (c) => (doc.value ? c.ids.map((id) => compById(doc.value, id)).filter(Boolean) : [])
const oneOf = (c) => { const cs = compsOf(c); return cs.length === 1 ? cs[0] : null }
const doRename = (c) => { const o = oneOf(c); if (o) startRename(o.id) }
const doHidden = (c) => { const cs = compsOf(c); if (cs.length) asm.cmd({ type: 'setHidden', ids: c.ids.slice(), on: !cs.every((x) => x.hidden) }) }
const doLocked = (c) => { const cs = compsOf(c); if (cs.length) asm.cmd({ type: 'setLocked', ids: c.ids.slice(), on: !cs.every((x) => x.locked) }) }
const doSplit = (c) => { const o = oneOf(c); if (o) asm.cmd({ type: 'splitSym', id: o.id }) }
const doRoot = (c) => { const o = oneOf(c); if (o) asm.cmd({ type: 'setRoot', id: o.id }) }
function onCtxKey(ev) { if (ev.key === 'Escape' && ui.ctx) { ui.ctx = null; ev.preventDefault() } }
window.addEventListener('keydown', onCtxKey, true)

onBeforeUnmount(() => { endDrag(); window.removeEventListener('keydown', onCtxKey, true) })
</script>

<template>
  <div class="asm-treebox">
    <div class="asm-hd">
      <span class="asm-hd-k">结构</span>
      <input v-if="docRenaming" ref="docIn" v-model="docDraft" class="asm-hd-in" spellcheck="false" :placeholder="defaultAsmName(domain)"
             @keydown.enter.prevent="commitDoc" @keydown.esc.prevent="docRenaming = false" @blur="commitDoc" />
      <span v-else class="asm-hd-t" data-i18n-skip :title="docName + '\n双击改名'" @dblclick="startDocRename">{{ docName }}</span>
      <span class="asm-hd-tag" :title="'领域：' + DOMAIN_LABELS[domain]">{{ DOMAIN_LABELS[domain] }}</span>
      <span class="asm-hd-n" data-i18n-skip :title="'件数 ' + nAll + ' · 主件 ' + nComps">{{ nAll }}</span>
    </div>
    <div ref="rootEl" class="asm-tree" tabindex="0" @keydown="onKey" @click.self="asm.select([])">
      <div v-if="!rows.length" class="asm-empty">还没有组件。</div>
      <div v-for="r in rows" :key="r.id" class="asm-tr" :data-id="r.id"
           :class="{ on: selSet.has(r.id), pri: ui.primary === r.id, bad: badSet.has(r.id), hid: r.hidden, dragging: dragId === r.id, drop: dropId === r.id, nodrop: dropBad === r.id, renaming: ui.renaming === r.id }"
           :style="{ paddingLeft: (6 + r.depth * 14) + 'px' }" :title="r.type"
           @pointerdown="onRowDown($event, r)" @click="onRowClick($event, r)" @dblclick="startRename(r.id)" @contextmenu.prevent.stop="onCtx($event, r)">
        <span v-for="d in r.depth" :key="'g' + d" class="asm-tr-guide" :style="{ left: (13 + (d - 1) * 14) + 'px' }"></span>
        <span class="asm-tr-chev" :class="{ empty: !r.hasKids }" @click.stop="r.hasKids && toggle(r.id)" @pointerdown.stop @dblclick.stop>
          <Icon v-if="r.hasKids" name="chevron-down" class="disc" :class="{ shut: !r.open }" :size="12" />
        </span>
        <span class="asm-tr-ic"><Icon :name="r.icon" :size="13" /></span>
        <input v-if="ui.renaming === r.id" ref="renameIn" v-model="renameDraft" class="asm-tr-rename" spellcheck="false" :placeholder="defTitle(r.type)"
               @click.stop @dblclick.stop @pointerdown.stop @keydown.enter.prevent.stop="commitRename" @keydown.esc.prevent.stop="cancelRename" @blur="commitRename" />
        <span v-else class="asm-tr-nm" data-i18n-skip>{{ r.label }}<span class="asm-tr-id">{{ r.id }}</span></span>
        <span v-if="r.sym" class="asm-tr-sym" :title="r.sym.tip"><Icon :name="r.sym.icon" :size="11" /><b data-i18n-skip>×{{ r.sym.n }}</b></span>
        <span v-if="r.hidden || r.locked" class="asm-tr-st">
          <Icon v-if="r.hidden" name="eye-off" :size="12" /><Icon v-if="r.locked" name="lock" :size="12" />
        </span>
        <span class="asm-tr-acts" @pointerdown.stop @click.stop @dblclick.stop>
          <button class="asm-tr-ico" :title="r.hidden ? '显示' : '隐藏'" :data-act="'hide-' + r.id" @click="setHidden(r)"><Icon :name="r.hidden ? 'eye-off' : 'eye'" :size="12" /></button>
          <button class="asm-tr-ico" :title="r.locked ? '解锁' : '锁定'" :data-act="'lock-' + r.id" @click="setLocked(r)"><Icon :name="r.locked ? 'lock' : 'lock-open'" :size="12" /></button>
        </span>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="ui.ctx && ctxComps.length" class="lb-ctx-mask" @mousedown="closeCtx" @contextmenu.prevent="closeCtx">
        <div class="lb-ctx asm-ctx" :style="ctxPos" @mousedown.stop @contextmenu.prevent>
          <button class="lb-ctx-i" data-act="ctx-rename" :disabled="!ctxOne || ctxAnyLocked" @click="ctxDo(doRename)">重命名<span class="asm-kbd">F2</span></button>
          <button class="lb-ctx-i" data-act="ctx-frame" @click="ctxDo(() => asm.frameSelection())">取景<span class="asm-kbd">F</span></button>
          <div class="lb-ctx-sep"></div>
          <button class="lb-ctx-i" data-act="ctx-duplicate" :disabled="ui.posePreview" @click="ctxDo(() => asm.duplicate())">复制<span class="asm-kbd">Ctrl+D</span></button>
          <button class="lb-ctx-i" data-act="ctx-mirror" :disabled="ctxHasRoot || ctxAnyLocked" @click="ctxDo(() => asm.mirror())">镜像<span class="asm-kbd">M</span></button>
          <button class="lb-ctx-i" data-act="ctx-split" :disabled="!ctxSplit.ok || ctxAnyLocked" :title="ctxSplit.why" @click="ctxDo(doSplit)">拆分对称</button>
          <button class="lb-ctx-i" data-act="ctx-root" :disabled="!ctxOne || ctxHasRoot || ctxAnyLocked" @click="ctxDo(doRoot)">设为根</button>
          <div class="lb-ctx-sep"></div>
          <button class="lb-ctx-i" data-act="ctx-hide" @click="ctxDo(doHidden)">{{ ctxAllHidden ? '显示' : '隐藏' }}</button>
          <button class="lb-ctx-i" data-act="ctx-lock" @click="ctxDo(doLocked)">{{ ctxAllLocked ? '解锁' : '锁定' }}</button>
          <div class="lb-ctx-sep"></div>
          <button class="lb-ctx-i danger" data-act="ctx-remove" :disabled="ctxAnyLocked" @click="ctxDo(() => asm.remove())">删除<span class="asm-kbd">Delete</span></button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.asm-treebox { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.asm-tree { flex: 1; min-height: 0; overflow: auto; padding: 4px 4px 10px; outline: none; user-select: none; }
.asm-tr {
  position: relative; display: flex; align-items: flex-start; gap: 4px; padding: 4px 6px; font-size: var(--fs-3); cursor: default;
  border-radius: var(--r-ctl); color: var(--text-muted); transition: background-color var(--dur-1) linear;
}
.asm-tr:hover { background: var(--surface-2); color: var(--text); }
.asm-tr.on { background: var(--surface-2); color: var(--text); box-shadow: inset 2px 0 0 var(--accent-ui); transition-duration: 0s; }
.asm-tree:focus-visible .asm-tr.pri { box-shadow: inset 2px 0 0 var(--accent-ui), inset 0 0 0 1px var(--border-strong); }
.asm-tr.hid .asm-tr-nm, .asm-tr.hid .asm-tr-ic { color: var(--text-faint); }
.asm-tr.bad .asm-tr-nm { color: var(--danger); }
.asm-tr.dragging { opacity: .4; }
.asm-tr.drop { background: var(--surface-2); box-shadow: inset 0 0 0 1.5px var(--accent-ui); }
.asm-tr.nodrop { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 60%, transparent); }
/* 层级导引线：top/bottom 拉满整行，逐行首尾相接（ConfigTree 同式） */
.asm-tr-guide { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--border); pointer-events: none; }
.asm-tr:hover .asm-tr-guide, .asm-tr.on .asm-tr-guide { background: var(--border-strong); }
.asm-tr-chev { flex: none; width: 14px; height: 1.35em; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); border-radius: var(--r-box); cursor: pointer; }
.asm-tr-chev.empty { cursor: default; }
.asm-tr-chev:not(.empty):hover { color: var(--text); background: var(--bg); }
.asm-tr-ic { flex: none; height: 1.35em; display: inline-flex; align-items: center; color: var(--text-faint); }
.asm-tr.on .asm-tr-ic { color: var(--accent-ui); }
/* 名称不截断（这栏最窄 260px，组件名常带编号）：换行；id 紧跟名称、等宽小一号 */
.asm-tr-nm { flex: 0 1 auto; min-width: 0; overflow-wrap: anywhere; line-height: 1.35; }
.asm-tr-id { margin-left: 6px; font-family: var(--font-mono); font-size: var(--fs-1); color: var(--text-faint); white-space: nowrap; }
.asm-tr-sym { flex: none; display: inline-flex; align-items: center; gap: 2px; height: 1.35em; padding: 0 4px; margin-left: 2px; font-size: var(--fs-1); color: var(--text-muted); }
.asm-tr-sym b { font-weight: 600; font-variant-numeric: tabular-nums; }
.asm-tr-st { flex: none; display: inline-flex; align-items: center; gap: 3px; height: 1.35em; margin-left: auto; color: var(--text-faint); }
.asm-tr:hover .asm-tr-st { visibility: hidden; }
/* 行尾动作：悬浮不占位（占位的话名字少掉两个钮的宽度）；自带底色遮住其下 */
.asm-tr-acts { position: absolute; top: 2px; right: 4px; display: none; align-items: center; gap: 1px; padding: 1px 2px; border-radius: var(--r-ctl); background: var(--surface-2); }
.asm-tr:hover .asm-tr-acts { display: inline-flex; }
/* 行内改名时悬浮钮不出来（会盖住输入框右端） */
.asm-tr.renaming .asm-tr-acts, .asm-tr.renaming:hover .asm-tr-st { display: none; }
.asm-tr-ico { flex: none; font: inherit; padding: 1px 3px; cursor: pointer; background: transparent; color: var(--text-faint); border: 0; border-radius: var(--r-ctl); display: inline-flex; align-items: center; }
.asm-tr-ico:hover { color: var(--text); background: var(--wash-hover); }
.asm-tr-rename { flex: 1; min-width: 0; font: inherit; font-size: var(--fs-3); height: var(--h-ctl-sm); margin: -1px 0; padding: 0 5px; background: var(--field-bg); color: var(--text); border: 1px solid var(--accent-ui); border-radius: var(--r-ctl); }
.asm-tr-rename:focus { outline: none; }
.asm-ctx { min-width: 188px; }
</style>
