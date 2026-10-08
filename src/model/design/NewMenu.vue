<script setup>
// 功能区「新建」下拉（设计页装配视图 / 模型视图共用，2026-10 统一设计）：
//   上段 = 空白文档（卫星 / 地球站 / 飞机 / 船舶 / 车辆，每次一个新签）；下段 = 从模板新建（按领域一级，悬停 / 点击展开二级模板列表）。
//   模板一律打开为模板签（与库页双击模板同一行为；同一模板已有模板签 = 激活它）：卫星整星模板 → 驱动装配件（快速设置可用），
//   地球站 / 飞机 / 船 / 车 → 实体模板文档。原样都不入库，第一次修改后自动入库（签成副本）。
// 位置由调用方给（按钮下沿）；Esc / 点外面关；二级菜单贴一级菜单右缘，放不下翻到左侧。
import { inject, computed, ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import Icon from '../../components/Icon.vue'
import { DOMAIN_LABELS, DOMAIN_ICONS, NEW_DOMAINS } from '../asmLogic.js'
import { displayName } from '../wbLogic.js'

const props = defineProps({ x: { type: Number, required: true }, y: { type: Number, required: true } })
const emit = defineEmits(['close'])
const wb = inject('wb')
const { st } = wb

/** 领域 → 模板条目（卫星 = 内置整星模板，排除星座精模；其余 = 实体模板） */
const tpls = computed(() => {
  const by = Object.fromEntries(NEW_DOMAINS.map((d) => [d, []]))
  for (const e of st.list) {
    if (e.origin === 'template' && !e.fleet && (e.kind || 'spacecraft') === 'spacecraft') by.spacecraft.push(e)
    else if (e.origin === 'entTemplate' && by[e.kind]) by[e.kind].push(e)
  }
  for (const d of NEW_DOMAINS) by[d].sort((a, b) => (a.tplOrder || 0) - (b.tplOrder || 0))
  return by
})
const sub = ref(null)            // {domain, x, y}
const menuEl = ref(null)
function openSub(d, ev) {
  const r = ev.currentTarget.getBoundingClientRect()
  const w = 220
  const x = r.right + w + 4 <= window.innerWidth ? r.right + 2 : Math.max(4, r.left - w - 2)
  sub.value = { domain: d, x, y: Math.min(r.top - 4, window.innerHeight - 40) }
}
function pickBlank(d) { emit('close'); wb.requestAssembly({ kind: 'new', domain: d }) }
// 与库页双击模板、组件库「从模板新建」卡片同一个入口（wb.openInDesign → 模板签）
function pickTpl(e) {
  emit('close')
  wb.openInDesign(e.id)
}
function onKey(ev) { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); if (sub.value) sub.value = null; else emit('close') } }
onMounted(() => { window.addEventListener('keydown', onKey, true); nextTick(() => { const el = menuEl.value; if (el) { const r = el.getBoundingClientRect(); if (r.bottom > window.innerHeight - 4) el.style.top = Math.max(4, window.innerHeight - 4 - r.height) + 'px' } }) })
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <Teleport to="body">
    <div class="lb-ctx-mask" @mousedown="emit('close')" @contextmenu.prevent="emit('close')">
      <div ref="menuEl" class="lb-ctx nm" :style="{ left: props.x + 'px', top: props.y + 'px' }" @mousedown.stop>
        <div class="nm-cap">空白</div>
        <button v-for="d in NEW_DOMAINS" :key="'b' + d" class="lb-ctx-i" :data-act="'new-' + d" @mouseenter="sub = null" @click="pickBlank(d)">
          <Icon :name="DOMAIN_ICONS[d]" :size="14" />{{ DOMAIN_LABELS[d] }}
        </button>
        <div class="lb-ctx-sep"></div>
        <div class="nm-cap">从模板新建</div>
        <button v-for="d in NEW_DOMAINS.filter((x) => tpls[x].length)" :key="'t' + d" class="lb-ctx-i nm-has" :class="{ on: sub && sub.domain === d }" :data-act="'newtpl-' + d"
                @mouseenter="openSub(d, $event)" @click="openSub(d, $event)">
          <Icon :name="DOMAIN_ICONS[d]" :size="14" />{{ DOMAIN_LABELS[d] }}<span class="nm-n" data-i18n-skip>{{ tpls[d].length }}</span><Icon name="chevron-right" :size="12" class="nm-chev" />
        </button>
      </div>
      <div v-if="sub" class="lb-ctx nm nm-sub" :style="{ left: sub.x + 'px', top: sub.y + 'px' }" @mousedown.stop>
        <button v-for="e in tpls[sub.domain]" :key="e.id" class="lb-ctx-i" :data-tpl="e.id" :title="[e.titleZh, e.title !== e.titleZh ? e.title : '', e.source && e.source.credit].filter(Boolean).join('\n')" @click="pickTpl(e)">
          <span data-i18n-skip>{{ displayName(e, 'zh') }}</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.nm { min-width: 168px; }
.nm-sub { width: 220px; max-height: 70vh; overflow-y: auto; }
.nm-cap { padding: 4px 10px 2px; font-size: var(--fs-1); font-weight: 600; letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--text-faint); }
.nm-has { display: flex; align-items: center; }
.nm-has.on { background: var(--wash-hover); }
.nm-n { margin-left: auto; padding-left: 10px; font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.nm-chev { flex: none; margin-left: 4px; color: var(--text-faint); }
</style>
