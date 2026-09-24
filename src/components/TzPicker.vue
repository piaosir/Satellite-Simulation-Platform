<script setup>
// 显示时区档位选择器（全平台共用）：触发器由调用方给（默认显示当前角标），点开是一列档位 ——
// 本机 / UTC / UTC−12…UTC+14。档位口径与格式化全在 shared/tz.js，本组件只管弹与选。
//
// ★ 菜单 Teleport 到 body：时间条挂了 container-type: inline-size（它对 fixed 后代就是包含块），
//   浮窗侧栏又层层 overflow —— 菜单留在原位不是被裁掉就是坐标算错。
// ★ class / title 这类透传显式 v-bind 到触发器上（inheritAttrs: false）：调用方给的样式类
//   必须落在触发器那一枚元素上，不能哪天多长一个根节点就散了（模板里那条注释是同一件事）。
//
// 可选具名插槽 head：摆在档位列表上方（一道分隔线隔开），调用方往里放和「这个时刻」相关的操作 ——
// 时间轴读数用它放「跳到指定时刻」的输入框。不给 head 时标记、尺寸（150 宽）、行为与原来逐项相同。
// 给了 head：菜单宽 = max(150, head 实排宽)，翻转 / 贴边 / 夹进视口按实量的盒子算；head 里点击不关菜单；
// 开合经 open / close 事件报给调用方，close() 外露给调用方在 head 里的动作做完后收起。
import { ref, computed, nextTick, watch, onBeforeUnmount, useSlots } from 'vue'
import { tzOptions, tzTag, TZ_HOUR_MIN } from '../shared/tz.js'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  modelValue: { type: [String, Number], default: 'local' },
  ms: { type: Number, default: 0 },          // 参照时刻：本机档角标按它取（夏令时区里 7 月与 1 月不同）；0＝此刻
  align: { type: String, default: 'left' },  // 菜单贴触发器的哪条边
  gap: { type: Number, default: 4 }          // 菜单与触发器之间的空隙（px）
})
const emit = defineEmits(['update:modelValue', 'open', 'close'])
const slots = useSlots()
const hasHead = computed(() => !!slots.head)

const MENU_W = 150, MENU_H = 292      // 与下面 .tzp-menu 的 width / max-height 一致（越界翻转要先知道盒子多大）
const open = ref(false)
const btn = ref(null)
const menu = ref(null)
const list = ref(null)                // 带 head 时的档位滚动区（不带 head 时滚的是菜单本身）
const pos = ref({ left: '0px', top: '0px' })
const refMs = computed(() => props.ms || Date.now())
const opts = computed(() => tzOptions(refMs.value))
const tag = computed(() => tzTag(props.modelValue, refMs.value))
const FIRST_FIXED = TZ_HOUR_MIN * 60

// w / h：菜单盒子的实量尺寸。不带 head 时恒为常数（列表够长，max-height 必顶满）；带 head 时宽高都随内容，
// 先按常数摆一次让它排出来，nextTick 里量了再摆（同一任务内、上屏之前，不闪）
function place(w = MENU_W, h = MENU_H) {
  const el = btn.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const up = r.bottom + props.gap + h > window.innerHeight     // 下方装不下就朝上开（时间条在屏幕最底下，常态即此）
  let left = props.align === 'right' ? r.right - w : r.left
  left = Math.max(4, Math.min(left, window.innerWidth - w - 4))
  const top = up ? Math.max(4, r.top - props.gap - h) : r.bottom + props.gap
  pos.value = { left: left + 'px', top: top + 'px' }
}
// refocus：焦点在菜单里（head 的输入框 / 按键）时关掉 → 交还触发器，键盘用户不被丢回页首。
// 点菜单外关的不交还：那一下点击本身就在决定焦点去哪
function close(refocus = true) {
  if (!open.value) return
  const m = menu.value, b = btn.value
  if (refocus && hasHead.value && m && b && m.contains(document.activeElement)) b.focus({ preventScroll: true })
  open.value = false
}
// Esc：输入法组字中的 Esc 是撤销组字，不关菜单。带 head 时这一下 Esc 就归菜单 —— 监听挂在 document 上，
// stopPropagation 截在冒泡到 window 之前（页面级 Esc 退跟随 / 退编辑不会连带触发）；不带 head 的与原来一样放行
function onKey(e) {
  if (e.key !== 'Escape' || e.isComposing) return
  if (hasHead.value) { e.preventDefault(); e.stopPropagation() }
  close()
}
function toggle() {
  open.value = !open.value
  if (!open.value) return
  place()
  nextTick(() => {
    const m = menu.value
    if (m && hasHead.value) { const r = m.getBoundingClientRect(); place(r.width, r.height) }
    // 当前档滚进视野：26 个固定偏移里选中的那个多半在列表深处，开出来看不到等于没选中
    const sc = list.value || m
    const on = sc && sc.querySelector('.tzp-i.on')
    if (sc && on) sc.scrollTop = Math.max(0, on.offsetTop - sc.clientHeight / 2 + on.offsetHeight / 2)
  })
}
function pick(v) { emit('update:modelValue', v); close() }
watch(open, (v) => {
  if (v) document.addEventListener('keydown', onKey)
  else document.removeEventListener('keydown', onKey)
  emit(v ? 'open' : 'close')
})
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
defineExpose({ close })
</script>

<template>
  <!-- ★ Teleport 套在触发器【里面】：组件必须单根，否则父组件的 scoped 样式落不到触发器上
       （scoped 的 scopeId 只在「元素即组件 subTree 根」时才继承下来，fragment 根一律不给）——
       表现就是时间读数块丢掉定宽、几何卡上的角标丢掉边框。Teleport 内容照样搬去 body。 -->
  <span ref="btn" class="tzp" :class="{ open }" v-bind="$attrs" @click="toggle"><slot :tag="tag">{{ tag }}</slot>
    <Teleport to="body">
      <div v-if="open" class="tzp-mask" @mousedown="close(false)" @contextmenu.prevent="close(false)" @wheel.prevent>
        <!-- 带 head：头 + 档位滚动区上下两段（头不随列表滚走）；不带：档位直接排在菜单里，与原来同一份标记。
             tabindex=-1：点到头里的空白处焦点落在菜单上而不是掉回 body —— 仍算「焦点在菜单里」，Esc 关时照样交还触发器。
             @contextmenu.stop：菜单是遮罩的子节点，菜单里的右键冒泡到遮罩会被当成「点外面」关掉 -->
        <div v-if="hasHead" ref="menu" class="tzp-menu has-head" role="dialog" tabindex="-1" :style="pos" @mousedown.stop @wheel.stop @contextmenu.stop>
          <div class="tzp-head"><slot name="head" /></div>
          <div ref="list" class="tzp-list">
            <button v-for="o in opts" :key="String(o.value)" type="button" class="tzp-i"
                    :class="{ on: o.value === modelValue, sep: o.value === FIRST_FIXED }" @click="pick(o.value)">
              <span :data-i18n-skip="o.fixed ? '' : null">{{ o.label }}</span><em v-if="o.tag" data-i18n-skip>{{ o.tag }}</em>
            </button>
          </div>
        </div>
        <div v-else ref="menu" class="tzp-menu" :style="pos" @mousedown.stop @wheel.stop>
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
  background: var(--surface, var(--bg)); border: 1px solid var(--border-strong, var(--border)); border-radius: var(--r-float); box-shadow: var(--shadow-2);
  /* 会朝上翻也会朝下开，方向不定 → 只淡入不位移；--shadow-3 只留给模态对话框 */
  animation: ui-fade-in var(--dur-2) var(--ease-out);
}
.tzp-i {
  display: flex; align-items: baseline; gap: 8px; width: 100%; font: inherit; font-size: var(--fs-3); text-align: left;
  /* 圆角与外框同心：外框 6 − 内距 3 */
  padding: 4px 9px; cursor: pointer; background: transparent; color: var(--text); border: 0; border-radius: var(--r-box); white-space: nowrap;
}
.tzp-i > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.tzp-i > em { flex: none; font-style: normal; font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
/* 选项拾取器：悬停淡罩、当前档实底，二者必须可分（命令菜单才是机位色实底悬停） */
.tzp-i:hover { background: var(--accent-ui-weak); }
.tzp-i.on { background: var(--accent-ui); color: var(--bg); }
.tzp-i.on > em { color: var(--bg); opacity: .75; }
/* 分隔线两端各让 6px、上下各空 3px，与命令菜单的分隔线同一画法；
   margin 7 + padding 4 = 原 margin 4 + border 1 + padding 6，文字纵向位置不动 */
.tzp-i.sep { margin-top: 7px; padding-top: 4px; border-top: 0; position: relative; }
.tzp-i.sep::before { content: ''; position: absolute; left: 6px; right: 6px; top: -4px; height: 1px; background: var(--border); }
/* 带 head：菜单自己不滚、不定宽（max-content，下限仍 150），内距挪给头与列表各自带 ——
   列表是滚动区，滚动条照旧贴着外框右沿；列表 max-height 290 + 外框 2 = 原菜单 292，档位可见区一行不差。
   头与列表之间的分隔线与 .sep 同一画法：两端各让 6px、上下各空 3px（头底内距 3 + 线 1 + 列表顶内距 3） */
.tzp-menu.has-head { display: flex; flex-direction: column; width: max-content; min-width: 150px; max-height: none; overflow: hidden; padding: 0; }
.tzp-menu.has-head:focus { outline: none; }
.tzp-head { flex: none; position: relative; padding: 3px 3px 4px; }
.tzp-head::after { content: ''; position: absolute; left: 6px; right: 6px; bottom: 0; height: 1px; background: var(--border); }
.tzp-list { position: relative; min-height: 0; max-height: 290px; overflow-y: auto; padding: 3px; }   /* relative：档位的 offsetTop 以列表为参照（滚进视野那段按它算） */
</style>
