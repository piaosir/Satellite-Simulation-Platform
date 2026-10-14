<script>
// 全平台对话框外壳（2026-10-14 前端审查 §3「对话框外壳」：主窗 8 套、链路预算 3 套、工具窗 5 套 → 这一套）。
//
//   <AppDialog :open="x" title="标题" :width="420" @close="x = false">
//     正文……
//     <template #footer>
//       <button class="btn" @click="x = false">取消</button>
//       <button class="btn primary" @click="ok">确定</button>
//     </template>
//   </AppDialog>
//
// 也可以整件 v-if 挂载（open 缺省 true）。
// 压在别的模态之上开的（CityPicker、文件管理里再开的导入 / 导出星历）传 layer="pop"：z 取 --z-dialog-pop。
// 外形：36 px 题条 + 44 px 关闭钮（Windows 风矩形热区，悬停红底白字）、右对齐 [次][主] 页脚、fixed 全窗遮罩。
// 行为：Esc 关（输入法组字中的 Esc 归输入法）；点遮罩【不】关 —— 全平台一个口径，防误触丢掉填了一半的表单；
//       打开时聚焦首个控件（或 initialFocus 指定的那个）、Tab 在框内循环、关闭后焦点回到打开前的地方。
// ★ 刻意不用原生 <dialog>.showModal()：它进 top layer，Teleport 到 body 的浮层（链路表下拉 .sg-dd、
//   右键菜单 .sg-ctx、CityPicker 选点框）无论 z-index 多大都会被压在对话框下面。
// ★ 多个对话框叠开（设置里再开选城市）时只有最上面那个接 Esc / 管 Tab：模块级的一列打开顺序，不是全局弹层栈。
const openStack = []
let uid = 0
</script>

<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount, onMounted } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  open: { type: Boolean, default: true },
  title: { type: String, default: '' },
  // 框宽：数字按 px，字符串原样（'min(720px, 92vw)'）
  width: { type: [Number, String], default: 420 },
  // 可关：显示关闭钮、接 Esc。进行中不许打断的（导出写盘中）传 false
  closable: { type: Boolean, default: true },
  // 正文不加内距（正文自己是表格 / 分栏时）
  flush: { type: Boolean, default: false },
  // 打开时先聚焦的元素（框内选择器）；缺省 = 正文里第一个可聚焦控件，没有就落到页脚最后一颗（主按钮）
  initialFocus: { type: String, default: '' },
  // 追加到框体上的类名（各处微调尺寸用）
  dialogClass: { type: [String, Array, Object], default: '' },
  // z 档：'dialog' = --z-dialog（缺省）；'pop' = --z-dialog-pop，压在别的模态之上开的（CityPicker、文件管理里再开的导入 / 导出星历）
  layer: { type: String, default: 'dialog' },
})
const emit = defineEmits(['close'])

const id = 'appdlg-' + (++uid)
const box = ref(null)
let restoreTo = null
const me = {}

const boxStyle = computed(() => ({ width: typeof props.width === 'number' ? props.width + 'px' : props.width }))

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
function focusables() {
  if (!box.value) return []
  return [...box.value.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
}
function isTop() { return openStack[openStack.length - 1] === me }

function onOpen() {
  if (openStack.includes(me)) return
  restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
  openStack.push(me)
  nextTick(() => {
    if (!box.value) return
    let el = props.initialFocus ? box.value.querySelector(props.initialFocus) : null
    if (!el) el = box.value.querySelector('.adlg-bd ' + FOCUSABLE.split(', ').join(', .adlg-bd '))
    if (!el) { const ft = box.value.querySelectorAll('.adlg-ft button:not([disabled])'); el = ft[ft.length - 1] || null }
    ;(el || box.value).focus({ preventScroll: true })
  })
}
function onClosed() {
  const i = openStack.indexOf(me)
  if (i < 0) return
  openStack.splice(i, 1)
  const r = restoreTo; restoreTo = null
  if (r && r.isConnected) nextTick(() => r.focus({ preventScroll: true }))
}

function close() { if (props.closable) emit('close') }

function onKey(e) {
  if (!isTop()) return
  if (e.key === 'Escape') {
    if (e.isComposing || e.defaultPrevented || !props.closable) return
    e.preventDefault(); e.stopPropagation()
    close()
  } else if (e.key === 'Tab') {
    const list = focusables()
    if (!list.length) { e.preventDefault(); return }
    const first = list[0], last = list[list.length - 1]
    const a = document.activeElement
    if (e.shiftKey && (a === first || !box.value.contains(a))) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && (a === last || !box.value.contains(a))) { e.preventDefault(); first.focus() }
  }
}
// 焦点落在框外（点了遮罩、或框内控件被删掉）时 Esc / Tab 也要归最上面的对话框；
// 焦点在框外的浮层里（Teleport 出去的下拉）则交给那个浮层自己处理。
function onWinKey(e) {
  if (!isTop() || !box.value) return
  const a = document.activeElement
  if (a && a !== document.body && !box.value.contains(a)) return
  if (box.value.contains(e.target)) return   // 框内的已由 onKey 处理
  onKey(e)
}

watch(() => props.open, (v) => (v ? onOpen() : onClosed()))
onMounted(() => { if (props.open) onOpen(); window.addEventListener('keydown', onWinKey) })
onBeforeUnmount(() => { window.removeEventListener('keydown', onWinKey); onClosed() })

defineExpose({ close })
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="adlg-mask" :class="{ pop: layer === 'pop' }">
      <div ref="box" class="adlg" :class="dialogClass" :style="boxStyle" role="dialog" aria-modal="true"
           :aria-labelledby="title || $slots.title ? id + '-t' : undefined" tabindex="-1" @keydown="onKey">
        <header class="adlg-hd">
          <span :id="id + '-t'" class="adlg-t"><slot name="title">{{ title }}</slot></span>
          <slot name="head" />
          <button v-if="closable" class="winx" type="button" aria-label="关闭" title="关闭" @click="close"><Icon name="x" :size="12" /></button>
        </header>
        <div class="adlg-bd" :class="{ flush }"><slot /></div>
        <footer v-if="$slots.footer" class="adlg-ft"><slot name="footer" /></footer>
      </div>
    </div>
  </Teleport>
</template>

<style>
/* 不 scoped：页脚 / 正文是调用方的插槽内容，scoped 选择器够不着；类名都带 adlg- 前缀免撞车。 */
/* 遮罩瞬时出现（压在画布上不做淡入）；框体 160ms 升入，出场瞬时 */
.adlg-mask { position: fixed; inset: 0; z-index: var(--z-dialog); background: var(--scrim); display: flex; align-items: center; justify-content: center; }
.adlg-mask.pop { z-index: var(--z-dialog-pop); }
.adlg { max-width: calc(100vw - 32px); max-height: calc(100vh - 48px); display: flex; flex-direction: column; min-height: 0;
  font-family: var(--font-ui); font-size: var(--fs-4); color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-card); box-shadow: var(--shadow-3);
  animation: ui-dlg-in var(--dur-3) var(--ease-out); outline: none; }
/* 36 px 题条：标题左内距 14，关闭钮占满整条高度 */
.adlg-hd { flex: none; display: flex; align-items: stretch; height: 36px; border-bottom: 1px solid var(--border); }
.adlg-t { flex: 1; min-width: 0; align-self: center; padding: 0 14px; font-size: var(--fs-4); font-weight: 600; letter-spacing: var(--ls-label);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 关闭键：Windows 风矩形热区，悬停红底白字（系统关闭键的颜色，不随主题）；右上内圆角 = 框体圆角 − 1px */
.adlg-hd > .winx { flex: none; width: 44px; padding: 0; border: 0; border-radius: 0 calc(var(--r-card) - 1px) 0 0; background: transparent; color: var(--text-muted);
  display: flex; align-items: center; justify-content: center; cursor: pointer; transition: var(--t-state); }
.adlg-hd > .winx:hover { background: #c42b1c; color: #fff; }
.adlg-hd > .winx:focus-visible { outline-offset: -2px; }
.adlg-bd { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px 16px; user-select: text; }
.adlg-bd.flush { padding: 0; }
/* 页脚：右对齐 [次][主]；页脚左端要放东西（「恢复默认」这类）就在插槽里放一个 .adlg-ft-l */
.adlg-ft { flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--border); }
.adlg-ft > .adlg-ft-l { margin-right: auto; display: flex; align-items: center; gap: 8px; }
</style>
