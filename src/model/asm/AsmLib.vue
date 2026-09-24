<script setup>
// 装配页组件库（契约 §6.3）：listComponents(文档领域) 按首领域分组（当前领域在前、通用在后）的卡片网格 + 「从模板开始」。
//   · 拖入用 pointer 方案（不用 HTML5 拖放：那条路与整窗文件拖放冲突、拖动中没有 pointermove、修饰键不实时）：
//     卡片上左键按下、越过 DRAG_START_PX 就交给编辑器 beginDragFromLib（它接管 window 级 move / up / Esc / 滚轮）。
//   · 双击卡片 = quickAdd（空文档作根；否则接到选中件第一个兼容空闲插座）。
//   · 缩略图按可见性懒取（IntersectionObserver → wb.componentThumb，串行出图、本机缓存）；未出图前放角色图标。
import { inject, computed, ref, watch, nextTick, onMounted, onBeforeUnmount, onActivated } from 'vue'
import Icon from '../../components/Icon.vue'
import { DRAG_START_PX } from '@core/models/asmSnap.mjs'
import { libGroups, compTip, roleIcon, DOMAIN_LABELS, DOMAIN_ICONS, NEW_DOMAINS } from '../asmLogic.js'
import { matchQuery, displayName } from '../wbLogic.js'

const props = defineProps({ q: { type: String, default: '' } })
const asm = inject('asm')
const wb = inject('wb')
const { st } = wb
const ui = asm.ui

const domain = computed(() => (asm.doc.value && asm.doc.value.domain) || wb.asm.domain || 'spacecraft')
const groups = computed(() => libGroups(domain.value, props.q))
const nComps = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0))
const editLock = computed(() => ui.posePreview)

// 实体模板：库清单里的 ent 条目（异步加载完才有；没有就整区不出）
const tplGroups = computed(() => {
  const by = new Map()
  for (const e of st.list) {
    if (e.origin !== 'entTemplate' || !matchQuery(e, props.q)) continue
    const d = NEW_DOMAINS.includes(e.kind) ? e.kind : 'ground'
    if (!by.has(d)) by.set(d, [])
    by.get(d).push(e)
  }
  const order = [domain.value, ...NEW_DOMAINS.filter((d) => d !== domain.value)]
  return order.filter((d) => by.has(d)).map((d) => ({ key: d, label: DOMAIN_LABELS[d], icon: DOMAIN_ICONS[d], items: by.get(d).sort((a, b) => (a.tplOrder || 0) - (b.tplOrder || 0)) }))
})
const nTpls = computed(() => tplGroups.value.reduce((n, g) => n + g.items.length, 0))

const isOpen = (k) => ui.secOpen['lib-' + k] !== false
function toggle(k) { ui.secOpen = { ...ui.secOpen, ['lib-' + k]: !isOpen(k) } }

// ── 缩略图懒取 ──
const rootEl = ref(null)
let io = null
function observeAll() {
  if (!rootEl.value) return
  if (!io) {
    io = new IntersectionObserver((ents) => {
      for (const en of ents) {
        if (!en.isIntersecting) continue
        const t = en.target.getAttribute('data-type')
        if (t) wb.componentThumb(t)
        const id = en.target.getAttribute('data-ent')
        if (id) { const e = wb.byId(id); if (e) wb.requestThumb(e) }
        io.unobserve(en.target)
      }
    }, { root: rootEl.value, rootMargin: '160px 0px' })
  }
  for (const el of rootEl.value.querySelectorAll('[data-type]')) if (!st.compThumbs[el.getAttribute('data-type')]) io.observe(el)
  for (const el of rootEl.value.querySelectorAll('[data-ent]')) if (!st.thumbs[el.getAttribute('data-ent')]) io.observe(el)
}
watch([groups, tplGroups, () => ui.secOpen], () => nextTick(observeAll), { deep: false })
// 换领域（新建飞机 / 打开地球站…）：组件库回到顶上（不停在上一份卫星库的滚动位置），按新领域重新登记懒取
watch(domain, () => nextTick(() => { if (rootEl.value) rootEl.value.scrollTop = 0; observeAll() }))
onMounted(() => nextTick(observeAll))
onActivated(() => nextTick(observeAll))

// ── 拖入：按下记起点，越过阈值交给编辑器 ──
const pressed = ref('')
let press = null
function onDown(ev, def) {
  if (ev.button !== 0 || editLock.value) return
  press = { type: def.type, x: ev.clientX, y: ev.clientY, id: ev.pointerId }
  pressed.value = def.type
  // 还没过拖动门槛就预热：几何建进缓存、边线 / BVH 插队进 Worker、ghost 材质异步编译——真拖起来第一帧不卡
  if (typeof asm.prewarm === 'function') asm.prewarm(def.type)
  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', endPress, true)
  window.addEventListener('pointercancel', endPress, true)
  window.addEventListener('blur', endPress)
}
function onMove(ev) {
  if (!press || ev.pointerId !== press.id) return
  const dx = ev.clientX - press.x, dy = ev.clientY - press.y
  if (dx * dx + dy * dy < DRAG_START_PX * DRAG_START_PX) return
  const type = press.type
  endPress()
  // 选中的文字 / 焦点框别跟着拖（卡片本身 user-select:none，这里防的是搜索框里残留的选区）
  try { window.getSelection() && window.getSelection().removeAllRanges() } catch { /* 无 */ }
  asm.beginDragFromLib(type, ev.clientX, ev.clientY)
}
function endPress() {
  press = null
  pressed.value = ''
  window.removeEventListener('pointermove', onMove, true)
  window.removeEventListener('pointerup', endPress, true)
  window.removeEventListener('pointercancel', endPress, true)
  window.removeEventListener('blur', endPress)
}
function quick(def) { if (!editLock.value) asm.quickAdd(def.type) }
function fromTemplate(e) { wb.requestAssembly({ kind: 'template', entId: e.id }) }
const tplTip = (e) => [e.titleZh, e.title && e.title !== e.titleZh ? e.title : '', e.source && e.source.credit, e.source && e.source.url].filter(Boolean).join('\n')

onBeforeUnmount(() => { endPress(); if (io) io.disconnect(); io = null })
</script>

<template>
  <div ref="rootEl" class="asm-lib">
    <div v-if="!nComps && !nTpls" class="asm-empty">{{ q ? '没有匹配的组件。' : '还没有组件。' }}</div>

    <section v-for="g in groups" :key="g.key" class="asm-lg">
      <div class="sect acc" :title="g.label + '组件'" @click="toggle(g.key)">
        <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen(g.key) }" :size="12" />
        <Icon :name="g.icon" :size="13" />
        <span class="sect-t">{{ g.label }}</span>
        <span class="cnt" data-i18n-skip>{{ g.items.length }}</span>
      </div>
      <div v-show="isOpen(g.key)" class="asm-grid">
        <div v-for="d in g.items" :key="d.type" class="asm-card" :class="{ press: pressed === d.type, lock: editLock }" :data-type="d.type"
             :title="editLock ? '初值姿态下不可编辑' : compTip(d)" draggable="false"
             @pointerdown="onDown($event, d)" @dblclick="quick(d)" @dragstart.prevent>
          <div class="asm-card-img">
            <img v-if="st.compThumbs[d.type]" :src="st.compThumbs[d.type]" alt="" draggable="false" decoding="async" />
            <Icon v-else class="asm-card-ph" :name="roleIcon(d.role)" :size="26" :stroke-width="1.2" />
          </div>
          <div class="asm-card-name" data-i18n-skip>{{ d.titleZh || d.title }}</div>
        </div>
      </div>
    </section>

    <section v-if="nTpls" class="asm-lg asm-tpls">
      <div class="sect acc" @click="toggle('tpl')">
        <Icon name="chevron-down" class="disc" :class="{ shut: !isOpen('tpl') }" :size="12" />
        <Icon name="layers" :size="13" />
        <span class="sect-t">从模板开始</span>
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
.asm-lg { display: flex; flex-direction: column; gap: 6px; }
.asm-lg > .sect { margin-inline: -4px; padding: 3px 4px; }
.asm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 6px; }
.asm-grid.wide { grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); }
.asm-card {
  display: flex; flex-direction: column; min-width: 0; padding: 3px; cursor: grab; user-select: none; touch-action: none;
  border: 1px solid transparent; border-radius: var(--r-card); transition: var(--t-state);
}
.asm-card.tpl { cursor: pointer; }
.asm-card:hover { border-color: var(--border); background: var(--surface); }
.asm-card.press { border-color: var(--accent-ui); background: color-mix(in srgb, var(--accent-ui) 7%, var(--bg)); transition-duration: 0s; }
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
.asm-card-name {
  margin-top: 4px; padding: 0 2px; font-size: var(--fs-2); line-height: 1.3; color: var(--text); min-height: 2.6em; text-align: center;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word;
}
.asm-tg-grp { display: flex; flex-direction: column; gap: 4px; margin-top: 2px; }
.asm-tg-h { display: flex; align-items: center; gap: 5px; font-size: var(--fs-2); color: var(--text-muted); padding: 2px 0; }
.asm-tg-h .app-icon { color: var(--text-faint); }
</style>
