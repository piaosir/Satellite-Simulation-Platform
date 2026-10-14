<script setup>
// 组件库（契约 §6.3；2026-10-12 组件不限领域）：全部组件按功能分组 → 组件族的卡片网格（asmLogic.libGroups）+「从模板新建」。
//   · 卡片 = 库条目（asmLogic.libEntries）：组件本身 + 它的常用型号（ComponentDef.presets，拖入 / 双击即带型号参数）；卡片键 d.key。
//   · 两种用法（mode）：
//       design —— 设计页左栏「组件」档：当前领域 = 装配文档的领域，族内常用于该领域的件在前，别的领域的件角上标设计领域（d.badge）。
//                 拖入用 pointer 方案（不用 HTML5 拖放：那条路与整窗文件拖放冲突、拖动中没有 pointermove、修饰键不实时）：
//                 卡片上左键按下、越过 DRAG_START_PX 就交给编辑器 beginDragFromLib（它接管 window 级 move / up / Esc / 滚轮）；
//                 双击卡片 = quickAdd（空文档作根；否则接到选中件第一个兼容空闲插座）。
//       browse —— 库页「组件」档：没有当前领域（不分常用、不标角标，可按领域筛 only），没有编辑器可拖。单击 = 选中（emit pick，
//                 库页拿去在视口里预览），双击 / Enter = emit open（以这一件为根件新建装配件），右键 = emit menu；方向键在卡片间移选。
//   · 缩略图按可见性懒取（IntersectionObserver → wb.componentThumb(卡片键)，串行出图、本机缓存；型号按型号参数出图）；未出图前放角色图标。
//   · 折叠状态两档共用（asm.ui.secOpen 'lib-<组>' / 'lib-<组>-<族>'）。
import { inject, computed, ref, watch, nextTick, onMounted, onBeforeUnmount, onActivated } from 'vue'
import Icon from '../../components/Icon.vue'
import { DRAG_START_PX } from '@core/models/asmSnap.mjs'
import { libGroups, compTip, roleIcon, DOMAIN_LABELS, DOMAIN_ICONS, NEW_DOMAINS } from '../asmLogic.js'
import { matchQuery, displayName } from '../wbLogic.js'

const props = defineProps({
  q: { type: String, default: '' },
  mode: { type: String, default: 'design' },   // 'design' | 'browse'
  only: { type: String, default: '' },         // browse：只列常用于该领域的组件（'' = 全部）
  sel: { type: String, default: '' }           // browse：选中的卡片键
})
const emit = defineEmits(['pick', 'open', 'menu'])
const asm = inject('asm')
const wb = inject('wb')
const { st } = wb
const ui = asm.ui
const browse = computed(() => props.mode === 'browse')

const domain = computed(() => (browse.value ? null : (asm.doc.value && asm.doc.value.domain) || wb.asm.domain || 'spacecraft'))
const groups = computed(() => libGroups(domain.value, props.q, undefined, { only: browse.value ? props.only : '' }))
const nComps = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0))
const editLock = computed(() => !browse.value && ui.posePreview)

// 「从模板新建」两路来源（卡片单击 = 打开模板签，与库页双击模板、功能区「新建 ▸ 从模板新建」同一行为，2026-10-06 任务书 §3.2）：
//   · 实体模板（地球站 / 飞机 / 船 / 车）：库清单里的 ent 条目（异步加载完才有）；
//   · 卫星：内置参数化整星模板（默认卫星 / SSL-1300 / 立方星…）→ 驱动装配件模板签。
//   模板签是新签（同一模板已开着 = 激活它），不替换当前文档；原样不入库，编辑时自动创建副本。
//     星座精模（fleet）不是 paramBus spec、拆不出组件，不列；用户另存的参数化件不是模板，仍走库页右键。
//   库页浏览档不列（模板就在库页「模型」档里）。
const satTpl = (e) => e.origin === 'template' && !e.fleet && wb.TEMPLATE_IDS.includes(e.templateId)
const tplGroups = computed(() => {
  if (browse.value) return []
  const by = new Map()
  for (const e of st.list) {
    const ent = e.origin === 'entTemplate'
    if (!(ent || satTpl(e)) || !matchQuery(e, props.q)) continue
    const d = !ent ? 'spacecraft' : NEW_DOMAINS.includes(e.kind) ? e.kind : 'ground'
    if (!by.has(d)) by.set(d, [])
    by.get(d).push(e)
  }
  const order = [domain.value, ...NEW_DOMAINS.filter((d) => d !== domain.value)]
  return order.filter((d) => by.has(d)).map((d) => ({ key: d, label: DOMAIN_LABELS[d], icon: DOMAIN_ICONS[d], items: by.get(d).sort((a, b) => (a.tplOrder || 0) - (b.tplOrder || 0)) }))
})
const nTpls = computed(() => tplGroups.value.reduce((n, g) => n + g.items.length, 0))

const isOpen = (k) => ui.secOpen['lib-' + k] !== false
function toggle(k) { ui.secOpen = { ...ui.secOpen, ['lib-' + k]: !isOpen(k) } }
/** 组内的卡片块：分了族（libGroups 的 subs）按族排，否则一整块（无小标题） */
const blocksOf = (g) => (g.subs && g.subs.length ? g.subs : [{ key: g.key + '-all', label: '', icon: '', items: g.items }])
const tipOf = (d) => (editLock.value ? '初值姿态下不可编辑' : compTip(d, { browse: browse.value }))

// ── 缩略图懒取 ──
const rootEl = ref(null)
let io = null
function observeAll() {
  if (!rootEl.value) return
  if (!io) {
    io = new IntersectionObserver((ents) => {
      for (const en of ents) {
        if (!en.isIntersecting) continue
        const t = en.target.getAttribute('data-ckey')
        if (t) wb.componentThumb(t)
        const id = en.target.getAttribute('data-ent')
        if (id) { const e = wb.byId(id); if (e) wb.requestThumb(e) }
        io.unobserve(en.target)
      }
    }, { root: rootEl.value, rootMargin: '160px 0px' })
  }
  for (const el of rootEl.value.querySelectorAll('[data-ckey]')) if (!st.compThumbs[el.getAttribute('data-ckey')]) io.observe(el)
  for (const el of rootEl.value.querySelectorAll('[data-ent]')) if (!st.thumbs[el.getAttribute('data-ent')]) io.observe(el)
}
watch([groups, tplGroups, () => ui.secOpen], () => nextTick(observeAll), { deep: false })
// 换领域（新建飞机 / 打开地球站…）：组件库回到顶上（不停在上一份文档的滚动位置；族内排序也换了），按新排列重新登记懒取
watch(domain, () => nextTick(() => { if (rootEl.value) rootEl.value.scrollTop = 0; observeAll() }))
onMounted(() => nextTick(observeAll))
onActivated(() => nextTick(observeAll))

// ── 设计档拖入：按下记起点，越过阈值交给编辑器 ──
const pressed = ref('')
let press = null
function onDown(ev, def) {
  if (browse.value) { if (ev.button === 0) { try { rootEl.value && rootEl.value.focus({ preventScroll: true }) } catch { /* 无 */ } emit('pick', def.key) } return }
  if (ev.button !== 0 || editLock.value) return
  press = { type: def.type, params: def.params || null, x: ev.clientX, y: ev.clientY, id: ev.pointerId }
  pressed.value = def.key
  // 还没过拖动门槛就预热：几何建进缓存、边线 / BVH 插队进 Worker、ghost 材质异步编译——真拖起来第一帧不卡
  if (typeof asm.prewarm === 'function') asm.prewarm(def.type, def.params ? { params: def.params } : undefined)
  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', endPress, true)
  window.addEventListener('pointercancel', endPress, true)
  window.addEventListener('blur', endPress)
}
function onMove(ev) {
  if (!press || ev.pointerId !== press.id) return
  const dx = ev.clientX - press.x, dy = ev.clientY - press.y
  if (dx * dx + dy * dy < DRAG_START_PX * DRAG_START_PX) return
  const type = press.type, params = press.params
  endPress()
  // 选中的文字 / 焦点框别跟着拖（卡片本身 user-select:none，这里防的是搜索框里残留的选区）
  try { window.getSelection() && window.getSelection().removeAllRanges() } catch { /* 无 */ }
  asm.beginDragFromLib(type, ev.clientX, ev.clientY, params ? { params } : undefined)
}
function endPress() {
  press = null
  pressed.value = ''
  window.removeEventListener('pointermove', onMove, true)
  window.removeEventListener('pointerup', endPress, true)
  window.removeEventListener('pointercancel', endPress, true)
  window.removeEventListener('blur', endPress)
}
function onDbl(def) {
  if (browse.value) { emit('open', def.key); return }
  if (!editLock.value) asm.quickAdd(def.type, def.params || null)
}
function onCtx(ev, def) {
  if (!browse.value) return
  ev.preventDefault()
  emit('pick', def.key)
  emit('menu', { x: ev.clientX, y: ev.clientY, key: def.key })
}
function fromTemplate(e) { wb.openInDesign(e.id) }
const tplTip = (e) => [e.titleZh, e.title && e.title !== e.titleZh ? e.title : '', e.source && e.source.credit, e.source && e.source.url].filter(Boolean).join('\n')

// ── 浏览档键盘：← → 按卡片顺序，↑ ↓ 到上 / 下一行里横向最近的那张（各组列数不同，按屏上位置找），Home / End，Enter 打开 ──
function cardEls() { return rootEl.value ? [...rootEl.value.querySelectorAll('.asm-card[data-ckey]')].filter((el) => el.offsetParent !== null) : [] }
function scrollToSel() {
  if (!rootEl.value || !props.sel) return
  const el = rootEl.value.querySelector(`.asm-card[data-ckey="${CSS.escape(props.sel)}"]`)
  if (el) el.scrollIntoView({ block: 'nearest' })
}
function navKey(ev) {
  if (!browse.value) return
  const k = ev.key
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(k)) return
  const els = cardEls()
  if (!els.length) return
  ev.preventDefault()
  let i = els.findIndex((el) => el.getAttribute('data-ckey') === props.sel)
  if (k === 'Enter') { if (i >= 0) emit('open', props.sel); return }
  let j = i
  if (i < 0) j = 0
  else if (k === 'ArrowRight') j = Math.min(els.length - 1, i + 1)
  else if (k === 'ArrowLeft') j = Math.max(0, i - 1)
  else if (k === 'Home') j = 0
  else if (k === 'End') j = els.length - 1
  else {
    const r0 = els[i].getBoundingClientRect(), cx = (r0.left + r0.right) / 2, down = k === 'ArrowDown'
    let rowY = null, best = -1, bd = Infinity
    for (let n = 0; n < els.length; n++) {
      const r = els[n].getBoundingClientRect()
      if (down ? r.top < r0.bottom - 2 : r.bottom > r0.top + 2) continue
      if (rowY === null || (down ? r.top < rowY - 2 : r.top > rowY + 2)) { rowY = r.top; best = -1; bd = Infinity }
      if (Math.abs(r.top - rowY) > 2) continue
      const d = Math.abs((r.left + r.right) / 2 - cx)
      if (d < bd) { bd = d; best = n }
    }
    if (best >= 0) j = best
  }
  emit('pick', els[j].getAttribute('data-ckey'))
  nextTick(scrollToSel)
}
watch(() => props.sel, () => { if (browse.value) nextTick(scrollToSel) })

onBeforeUnmount(() => { endPress(); if (io) io.disconnect(); io = null })
</script>

<template>
  <div ref="rootEl" class="asm-lib" :class="{ browse }" :tabindex="browse ? 0 : undefined" @keydown="navKey">
    <div v-if="!nComps && !nTpls" class="asm-empty">{{ q ? '无匹配组件。' : '暂无组件。' }}</div>

    <section v-for="g in groups" :key="g.key" class="asm-lg">
      <div class="sect acc" @click="toggle(g.key)">
        <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen(g.key) }" :size="12" />
        <Icon :name="g.icon" :size="12" />
        <span class="sect-t">{{ g.label }}</span>
        <span class="cnt" data-i18n-skip>{{ g.items.length }}</span>
      </div>
      <div v-show="isOpen(g.key)" class="asm-blocks">
        <!-- 分了族的组（结构与机构 / 天线 / 推进）按族排小组；其余一整块 -->
        <div v-for="b in blocksOf(g)" :key="b.key" class="asm-tg-grp">
          <div v-if="b.label" class="asm-tg-h acc" @click="toggle(b.key)">
            <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen(b.key) }" :size="12" />
            <Icon :name="b.icon" :size="12" /><span>{{ b.label }}</span><span class="cnt" data-i18n-skip>{{ b.items.length }}</span>
          </div>
          <div v-show="!b.label || isOpen(b.key)" class="asm-grid">
            <div v-for="d in b.items" :key="d.key" class="asm-card" :class="{ press: pressed === d.key, lock: editLock, on: browse && sel === d.key }" :data-ckey="d.key" :data-type="d.type"
                 :title="tipOf(d)" draggable="false"
                 @pointerdown="onDown($event, d)" @dblclick="onDbl(d)" @contextmenu="onCtx($event, d)" @dragstart.prevent>
              <div class="asm-card-img">
                <img v-if="st.compThumbs[d.key]" :src="st.compThumbs[d.key]" alt="" draggable="false" decoding="async" />
                <Icon v-else class="asm-card-ph" :name="roleIcon(d.role)" :size="26" :stroke-width="1.2" />
                <span v-if="d.badge" class="asm-card-dom" :title="d.badge.tip" :data-dom="d.badge.domain"><Icon :name="d.badge.icon" :size="12" /></span>
              </div>
              <div class="asm-card-name">{{ d.titleZh || d.title }}</div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section v-if="nTpls" class="asm-lg asm-tpls">
      <div class="sect acc" @click="toggle('tpl')">
        <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('tpl') }" :size="12" />
        <Icon name="layers" :size="12" />
        <span class="sect-t">从模板新建</span>
        <span class="cnt" data-i18n-skip>{{ nTpls }}</span>
      </div>
      <template v-if="isOpen('tpl')">
        <div v-for="g in tplGroups" :key="g.key" class="asm-tg-grp">
          <div class="asm-tg-h"><Icon :name="g.icon" :size="12" /><span>{{ g.label }}</span></div>
          <div class="asm-grid wide">
            <div v-for="e in g.items" :key="e.id" class="asm-card tpl" :data-ent="e.id" :title="tplTip(e)" @click="fromTemplate(e)">
              <div class="asm-card-img">
                <img v-if="st.thumbs[e.id]" :src="st.thumbs[e.id]" alt="" draggable="false" decoding="async" />
                <Icon v-else class="asm-card-ph" :name="g.icon" :size="30" :stroke-width="1.2" />
              </div>
              <div class="asm-card-name" data-i18n-skip>{{ displayName(e, 'zh') }}</div>
            </div>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.asm-lib { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 10px; padding: 0 2px 8px; }
.asm-lib.browse { outline: none; }
.asm-lg { display: flex; flex-direction: column; gap: 6px; }
.asm-lg > .sect { margin-inline: -4px; padding: 3px 4px; }
.asm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 6px; }
.asm-grid.wide { grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); }
.asm-card {
  display: flex; flex-direction: column; min-width: 0; padding: 3px; cursor: grab; user-select: none; touch-action: none;
  border: 1px solid transparent; border-radius: var(--r-card); transition: var(--t-state);
}
.asm-card.tpl, .asm-lib.browse .asm-card { cursor: pointer; }
.asm-card:hover { border-color: var(--border); background: var(--surface); }
.asm-card.press { border-color: var(--accent-ui); background: color-mix(in srgb, var(--accent-ui) 7%, var(--bg)); transition-duration: 0s; }
/* 浏览档选中（同库页模型卡片 .card.on） */
.asm-card.on { border-color: var(--accent-ui); background: color-mix(in srgb, var(--accent-ui) 8%, var(--bg)); box-shadow: 0 0 0 1px var(--accent-ui); transition-duration: 0s; }
.asm-card.on .asm-card-name { font-weight: 600; }
.asm-card.lock { cursor: not-allowed; opacity: .55; }
.asm-card.lock:hover { border-color: transparent; background: transparent; }
.asm-card-img {
  position: relative; aspect-ratio: 1 / 1; border-radius: var(--r-box); overflow: hidden; display: flex; align-items: center; justify-content: center;
  /* 影棚灰（同库页卡片）：白 / 银的件贴着近白底会整片消失 */
  background: radial-gradient(ellipse at 50% 36%, #e7eaee 0%, #dce0e5 58%, #c9ced6 100%);
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
}
html[data-theme='dark'] .asm-card-img { background: radial-gradient(ellipse at 50% 38%, #3a3c40 0%, #26272a 60%, #18191b 100%); }
.asm-card-img img { width: 100%; height: 100%; object-fit: contain; pointer-events: none; -webkit-user-drag: none; }
/* 深色主题：缩略图是透明底，碳纤维杆 / 深色太阳翼 / 敏感器贴着深灰底会融掉 —— 沿剪影加一圈浅色轮廓光（跟 alpha 走，不画方框） */
html[data-theme='dark'] .asm-card-img img { filter: drop-shadow(0 0 0.6px rgba(236, 240, 246, 0.7)) drop-shadow(0 0 2.5px rgba(236, 240, 246, 0.22)); }
/* 浅色主题同理：白 / 银件（相控阵面、天线塔、反射面）贴着浅灰底会融掉 —— 沿剪影加一圈深色细轮廓 + 一点落影 */
html:not([data-theme='dark']) .asm-card-img img { filter: drop-shadow(0 0 0.6px rgba(20, 24, 30, 0.45)) drop-shadow(0 1px 2px rgba(20, 24, 30, 0.16)); }
.asm-card-ph { color: color-mix(in srgb, var(--text-faint) 70%, transparent); }
/* 别的领域的件：左上角标它的设计领域（同库页卡片角标 .card-b 的形制，小一号） */
.asm-card-dom {
  position: absolute; left: 3px; top: 3px; display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; border-radius: 3px;
  color: var(--text-muted); background: color-mix(in srgb, var(--bg) 82%, transparent); border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}
.asm-card-name {
  margin-top: 4px; padding: 0 2px; font-size: var(--fs-2); line-height: 1.3; color: var(--text); min-height: 2.6em; text-align: center;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word;
}
.asm-tg-grp { display: flex; flex-direction: column; gap: 4px; margin-top: 2px; }
.asm-tg-h { display: flex; align-items: center; gap: 5px; font-size: var(--fs-2); color: var(--text-muted); padding: 2px 0; }
.asm-tg-h .app-icon { color: var(--text-faint); }
.asm-blocks { display: flex; flex-direction: column; gap: 6px; }
.asm-tg-h.acc { cursor: pointer; user-select: none; margin-inline: -4px; padding: 2px 4px; border-radius: var(--r-box); transition: background-color var(--dur-1) linear; }
.asm-tg-h.acc:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.asm-tg-h .cnt { margin-left: auto; color: var(--text-faint); font-variant-numeric: tabular-nums; }
</style>
