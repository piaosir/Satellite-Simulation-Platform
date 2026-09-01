<script setup>
// 显示时区档位选择器（全平台共用）：触发器由调用方给（默认显示当前角标），点开是一列档位 ——
// 本机 / UTC / UTC−12…UTC+14。档位口径与格式化全在 shared/tz.js，本组件只管弹与选。
//
// ★ 菜单 Teleport 到 body：时间条挂了 container-type: inline-size（它对 fixed 后代就是包含块），
//   浮窗侧栏又层层 overflow —— 菜单留在原位不是被裁掉就是坐标算错。
// ★ class / title 这类透传显式 v-bind 到触发器上（inheritAttrs: false）：调用方给的样式类
//   必须落在触发器那一枚元素上，不能哪天多长一个根节点就散了（模板里那条注释是同一件事）。
import { ref, computed, nextTick, watch, onBeforeUnmount } from 'vue'
import { tzOptions, tzTag, TZ_HOUR_MIN } from '../shared/tz.js'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  modelValue: { type: [String, Number], default: 'local' },
  ms: { type: Number, default: 0 },          // 参照时刻：本机档角标按它取（夏令时区里 7 月与 1 月不同）；0＝此刻
  align: { type: String, default: 'left' }   // 菜单贴触发器的哪条边
})
const emit = defineEmits(['update:modelValue'])

const MENU_W = 150, MENU_H = 292      // 与下面 .tzp-menu 的 width / max-height 一致（越界翻转要先知道盒子多大）
const open = ref(false)
const btn = ref(null)
const menu = ref(null)
const pos = ref({ left: '0px', top: '0px' })
const refMs = computed(() => props.ms || Date.now())
const opts = computed(() => tzOptions(refMs.value))
const tag = computed(() => tzTag(props.modelValue, refMs.value))
const FIRST_FIXED = TZ_HOUR_MIN * 60

function place() {
  const el = btn.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const up = r.bottom + 4 + MENU_H > window.innerHeight     // 下方装不下就朝上开（时间条在屏幕最底下，常态即此）
  let left = props.align === 'right' ? r.right - MENU_W : r.left
  left = Math.max(4, Math.min(left, window.innerWidth - MENU_W - 4))
  const top = up ? Math.max(4, r.top - 4 - MENU_H) : r.bottom + 4
  pos.value = { left: left + 'px', top: top + 'px' }
}
function onKey(e) { if (e.key === 'Escape') open.value = false }
function toggle() {
  open.value = !open.value
  if (!open.value) return
  place()
  nextTick(() => {
    // 当前档滚进视野：26 个固定偏移里选中的那个多半在列表深处，开出来看不到等于没选中
    const m = menu.value
    const on = m && m.querySelector('.tzp-i.on')
    if (m && on) m.scrollTop = Math.max(0, on.offsetTop - m.clientHeight / 2 + on.offsetHeight / 2)
  })
}
function pick(v) { emit('update:modelValue', v); open.value = false }
watch(open, (v) => {
  if (v) document.addEventListener('keydown', onKey)
  else document.removeEventListener('keydown', onKey)
})
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <!-- ★ Teleport 套在触发器【里面】：组件必须单根，否则父组件的 scoped 样式落不到触发器上
       （scoped 的 scopeId 只在「元素即组件 subTree 根」时才继承下来，fragment 根一律不给）——
       表现就是时间读数块丢掉定宽、几何卡上的角标丢掉边框。Teleport 内容照样搬去 body。 -->
  <span ref="btn" class="tzp" :class="{ open }" v-bind="$attrs" @click="toggle"><slot :tag="tag">{{ tag }}</slot>
    <Teleport to="body">
      <div v-if="open" class="tzp-mask" @mousedown="open = false" @contextmenu.prevent="open = false" @wheel.prevent>
        <div ref="menu" class="tzp-menu" :style="pos" @mousedown.stop @wheel.stop>
          <button v-for="o in opts" :key="String(o.value)" type="button" class="tzp-i"
                  :class="{ on: o.value === modelValue, sep: o.value === FIRST_FIXED }" @click="pick(o.value)">
            <span :data-i18n-skip="o.fixed ? '' : null">{{ o.label }}</span><em v-if="o.tag" data-i18n-skip>{{ o.tag }}</em>
          </button>
        </div>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.tzp { cursor: pointer; user-select: none; }
</style>

<style>
/* 菜单 Teleport 出去了，scoped 打不到它的节点（scoped 只给组件自身 DOM 加标记） */
.tzp-mask { position: fixed; inset: 0; z-index: 2400; }
.tzp-menu {
  position: fixed; z-index: 2401; width: 150px; max-height: 292px; overflow-y: auto; padding: 3px;
  background: var(--surface, var(--bg)); border: 1px solid var(--border-strong, var(--border)); border-radius: var(--r-float); box-shadow: var(--shadow-3);
}
.tzp-i {
  display: flex; align-items: baseline; gap: 8px; width: 100%; font: inherit; font-size: var(--fs-3); text-align: left;
  padding: 4px 9px; cursor: pointer; background: transparent; color: var(--text); border: 0; border-radius: var(--r-card); white-space: nowrap;
}
.tzp-i > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.tzp-i > em { flex: none; font-style: normal; font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.tzp-i:hover { background: color-mix(in srgb, var(--accent-ui) 18%, transparent); }
.tzp-i.on { background: var(--accent-ui); color: var(--bg); }
.tzp-i.on > em { color: var(--bg); opacity: .75; }
.tzp-i.sep { margin-top: 4px; border-top: 1px solid var(--border); padding-top: 6px; }
</style>
