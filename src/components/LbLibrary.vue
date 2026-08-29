<script setup>
// 资源库主从视图（GEO / NGSO / 再生式共用）：取代旧「竖排大卡片」。
// 列表＝条目名称 + 一行摘要（行内 hover 动作：复制/删除），另一侧＝所选条目的编辑面板（slot，
// 原 BasebandPanel / EarthStationPanel / RegenSatPanel 原样塞入）。同屏只展开一份编辑器，
// 列表本身就是全库速览——信息密度与「同屏一个上下文」两头都占。
// 两种排布（layout）：'row' = 左列表右编辑器（宽区）；'column' = 上列表下编辑器（右侧「资源库」侧栏）。
// 「复制名称」（行内钮 / 名称旁的钮 / 选中条目按 Ctrl+C）把条目名送进剪贴板，到链路表的配置列 Ctrl+V 即套用。
import { computed, ref, watch, nextTick } from 'vue'
import Icon from './Icon.vue'
import { byLang } from '../shared/i18n/lang.js'   // 空名占位是界面语汇，却画在打了 skip 的名字位上（呈现层翻不到），故在这里按语言出字

const props = defineProps({
  items: { type: Array, required: true },        // [{ id, name, form, nameAuto, ... }]
  modelValue: { type: String, default: '' },     // 选中条目 id
  summary: { type: Function, default: null },    // (cfg) => 摘要字符串（mono 单行）
  minKeep: { type: Number, default: 1 },         // 少于等于该数量时禁删
  namePlaceholder: { type: String, default: '配置名称' },
  autoTip: { type: String, default: '关键参数' }, // 自动命名取哪几项（「自动」标记的悬浮说明用）
  layout: { type: String, default: 'row' }       // 'row' 主从横排 / 'column' 上下堆叠（侧栏窄区）
})
const emit = defineEmits(['update:modelValue', 'add', 'duplicate', 'remove', 'toast'])

const selected = computed(() => props.items.find((c) => c.id === props.modelValue) || props.items[0] || null)
// 选中项被删/换库后自动落回第一份
watch(() => [props.items.length, props.modelValue], () => {
  if (!props.items.length) return
  if (!props.items.some((c) => c.id === props.modelValue)) emit('update:modelValue', props.items[0].id)
}, { immediate: true })

// 选中项滚入列表可视区：条目多时，外部「导航到某条目」（链路表格内「编辑参数」钮）选中的那条可能在
// 列表滚动区外，不滚就等于没到。只算本列表容器的 scrollTop（不用 scrollIntoView——它会连带滚动祖先，
// 把整个工作台带跑）；已在视野内则一动不动。
const listEl = ref(null)
watch(() => props.modelValue, () => nextTick(() => {
  const box = listEl.value
  const el = box && box.querySelector('.lbl-row.on')
  if (!box || !el) return
  const top = el.offsetTop, bot = top + el.offsetHeight
  if (top < box.scrollTop) box.scrollTop = top
  else if (bot > box.scrollTop + box.clientHeight) box.scrollTop = bot - box.clientHeight
}))

const sumOf = (cfg) => { try { return props.summary ? (props.summary(cfg) || '') : '' } catch (e) { return '' } }

// —— 名称：自动 ↔ 自定义（自动命名规则见 shared/lbAutoName.js，改名只在这一个入口发生）——
// 输入即「我自己起名」：标志位一落 false，此后参数再改也不动这个名字。清空则交还自动命名
// （在 blur 判定——边打字边判会在删到空的一瞬把自动名塞回输入框，接着打的字就接到了它后面）。
// 提醒只用一句淡出的小字，不弹窗不拦路。
const hint = ref('')
const hintSeq = ref(0)   // :key 用——连着两次同样的提示也要重新播一遍淡出动画（否则第二次只剩不可见的残影）
let _hintT = null
function flash(msg) {
  hint.value = msg
  hintSeq.value++
  clearTimeout(_hintT)
  _hintT = setTimeout(() => { hint.value = '' }, 2600)
}
function onNameInput(e) {
  const cfg = selected.value
  if (!cfg) return
  cfg.name = e.target.value
  if (cfg.nameAuto && cfg.name.trim()) { cfg.nameAuto = false; flash('已固定为自定义名称') }
}
function onNameBlur() {
  const cfg = selected.value
  if (!cfg || cfg.name.trim() || cfg.nameAuto) return
  cfg.nameAuto = true
  flash('已恢复自动命名')
}

// —— 复制名称：条目名进剪贴板，到链路表的「载波信号配置 / 地球站配置」那一格 Ctrl+V 就套用了 ——
// 那些列存的是条目 id、显示的是条目名，粘贴时按显示名反查存值（StationGrid.normalizeFieldValue），
// 所以剪贴板里放的就是这个名字：粘一格改一条，先框一片格再粘就整片套用（Excel 平铺），与手动下拉选同一结果。
// 名字本身也常要往外抄（发给同事、贴进报告），故按钮就叫「复制名称」，不掺别的内容——只放这一行纯文本。
const copied = ref('')   // 刚复制过的条目 id：该条的按钮图标临时翻成 ✓（复制类操作的常规回执）
let _copyT = null
async function copyName(cfg) {
  const nm = String((cfg && cfg.name) || '').trim()
  if (!nm) { flash('这条还没有名称'); return }
  try { await navigator.clipboard.writeText(nm) } catch (e) { emit('toast', '复制失败：剪贴板不可用'); return }
  emit('toast', `已复制「${nm}」——在链路表选中配置格 Ctrl+V 即套用本条`)
  copied.value = cfg.id
  clearTimeout(_copyT)
  _copyT = setTimeout(() => { copied.value = '' }, 1500)
}
// Ctrl+C：焦点在资源库内（点过列表/面板空白处即是）＝复制当前条目名称，与上面那两个钮同一件事，
// 「选中条目 → Ctrl+C → 到链路表 Ctrl+V」一气呵成。输入框/文本域里的 Ctrl+C 是复制选中文本，一律放行。
function onKey(e) {
  if (!(e.ctrlKey || e.metaKey) || (e.key !== 'c' && e.key !== 'C')) return
  const t = e.target
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
  if (!selected.value) return
  copyName(selected.value)
  e.preventDefault()
}
// 列表（role=listbox）上下键换条目：配合 Ctrl+C 可全键盘取名，也是可聚焦列表该有的键盘行为
function onListKey(e) {
  const n = props.items.length
  if (!n || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
  const i = props.items.findIndex((c) => selected.value && c.id === selected.value.id)
  emit('update:modelValue', props.items[e.key === 'ArrowDown' ? Math.min(n - 1, i + 1) : Math.max(0, i - 1)].id)
  e.preventDefault()
}
</script>

<template>
  <!-- tabindex=-1：点面板任意空白处即让容器接住焦点，Ctrl+C 才有落点（列表另有 tabindex=0，可 Tab 进来） -->
  <div class="lbl" :class="layout === 'column' ? 'lbl-col' : 'lbl-row'" tabindex="-1" @keydown="onKey">
    <div ref="listEl" class="lbl-list" role="listbox" tabindex="0" @keydown="onListKey">
      <div v-for="cfg in items" :key="cfg.id" class="lbl-row" :class="{ on: selected && cfg.id === selected.id }"
           role="option" :aria-selected="selected && cfg.id === selected.id" @click="emit('update:modelValue', cfg.id)">
        <span class="lbl-nm" :title="cfg.name" data-i18n-skip>{{ cfg.name || byLang('（未命名）', '(Unnamed)') }}</span>
        <span v-if="sumOf(cfg)" class="lbl-sum" :title="sumOf(cfg)">{{ sumOf(cfg) }}</span>
        <span class="lbl-row-acts">
          <button class="lbl-ico" :class="{ done: copied === cfg.id }" title="复制名称（到链路表的配置格 Ctrl+V 即套用本条）"
                  @click.stop="copyName(cfg)"><Icon :name="copied === cfg.id ? 'check' : 'clipboard'" :size="12" /></button>
          <button class="lbl-ico" title="复制此配置" @click.stop="emit('duplicate', cfg)"><Icon name="copy" :size="12" /></button>
          <button class="lbl-ico del" title="删除此配置" :disabled="items.length <= minKeep" @click.stop="emit('remove', cfg)"><Icon name="x" :size="12" /></button>
        </span>
      </div>
      <button class="lbl-add" @click="emit('add')"><Icon name="plus" :size="12" /> 新增</button>
    </div>

    <div v-if="selected" class="lbl-ed">
      <div class="lbl-ed-hd">
        <input :value="selected.name" class="lbl-ed-nm" :placeholder="namePlaceholder" spellcheck="false"
               @input="onNameInput" @blur="onNameBlur" />
        <button class="lbl-cpy" :class="{ done: copied === selected.id }" @click="copyName(selected)"
                :title="`复制名称「${selected.name}」到剪贴板：在链路表选中「载波信号配置 / 地球站配置」单元格后 Ctrl+V 即套用本条（选中条目直接按 Ctrl+C 亦可）`">
          <Icon :name="copied === selected.id ? 'check' : 'clipboard'" :size="12" />
        </button>
        <span v-if="selected.nameAuto" class="lbl-auto" :title="`名称随${autoTip}自动生成；在此改名后就固定为自定义名称，不再自动更新（清空名称可恢复自动）`">自动</span>
        <span v-if="hint" :key="hintSeq" class="lbl-hint">{{ hint }}</span>
        <span class="lbl-ed-sp"></span>
        <slot name="editor-actions" :cfg="selected" />
      </div>
      <div class="lbl-ed-bd">
        <slot :cfg="selected" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.lbl { display: flex; align-items: stretch; gap: 0; border: 1px solid var(--border); border-radius: var(--r-box, 3px); background: var(--surface); overflow: hidden; }
/* 容器/列表只是 Ctrl+C 的焦点落点，不该有焦点框；键盘 Tab 进来才给一道内描边 */
.lbl:focus, .lbl-list:focus { outline: none; }
.lbl-list:focus-visible { box-shadow: inset 0 0 0 1px var(--accent-ui); }
/* 左列表：全库速览 */
.lbl-list { flex: none; width: 190px; display: flex; flex-direction: column; border-right: 1px solid var(--border); background: var(--bg); overflow-y: auto; max-height: 420px; }
.lbl-row { position: relative; display: flex; flex-direction: column; gap: 1px; padding: 6px 9px 6px 11px; cursor: pointer; border-bottom: 1px solid var(--border); }
.lbl-row:hover { background: var(--surface); }
.lbl-row.on { background: var(--surface-2); box-shadow: inset 2px 0 0 var(--accent-ui); }
.lbl-nm { font-size: var(--fs-3); font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 56px; }
.lbl-row:not(.on) .lbl-nm { color: var(--text-muted); font-weight: 400; }
.lbl-sum { font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lbl-row-acts { position: absolute; top: 5px; right: 5px; display: none; gap: 2px; }
.lbl-row:hover .lbl-row-acts { display: inline-flex; }
.lbl-ico { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; cursor: pointer; background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.lbl-ico:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.lbl-ico.del:hover:not(:disabled) { color: var(--danger); }
.lbl-ico:disabled { opacity: .4; cursor: not-allowed; }
/* 复制成功的一瞬（✓）：行内钮与名称旁的钮同一套回执色 */
.lbl-ico.done, .lbl-cpy.done { color: var(--accent); border-color: var(--accent); }
.lbl-add { font: inherit; font-size: var(--fs-2); display: flex; align-items: center; justify-content: center; gap: 4px; padding: 6px; margin: 6px; cursor: pointer; background: transparent; color: var(--text-muted); border: 1px dashed var(--border-strong); border-radius: var(--r-ctl, 2px); }
.lbl-add:hover { color: var(--text); border-color: var(--text-muted); }
/* 右编辑器 */
.lbl-ed { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.lbl-ed-hd { display: flex; align-items: center; gap: 6px; padding: 5px 10px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.lbl-ed-nm { flex: none; width: 180px; font: inherit; font-size: var(--fs-3); font-weight: 600; padding: 3px 7px; background: var(--field-bg); color: var(--text); border: 1px solid var(--field-border); border-radius: var(--r-ctl, 2px); }
.lbl-ed-nm:focus { outline: none; border-color: var(--accent-ui); }
/* 名称旁的「复制名称」钮：与同排的 .lb-mini（复制/删除）等高，图标独一份不带字，紧挨着名称才读得出是复制它 */
.lbl-cpy { flex: none; display: inline-flex; align-items: center; justify-content: center; padding: 3px 5px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.lbl-cpy:hover { color: var(--text); border-color: var(--border-strong); }
/* 自动命名标记：极轻的一枚小牌（虚线＝还没被钉住），改过名就不再出现 */
.lbl-auto { flex: none; font-size: var(--fs-1); line-height: 15px; padding: 0 5px; cursor: help; color: var(--text-faint); background: var(--bg); border: 1px dashed var(--border-strong); border-radius: var(--r-pill); }
.lbl-hint { flex: 0 1 auto; min-width: 0; font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; animation: lbl-hint-fade 2.6s ease forwards; }
@keyframes lbl-hint-fade { 0% { opacity: 0 } 8%, 70% { opacity: 1 } 100% { opacity: 0 } }
.lbl-ed-sp { flex: 1; }
.lbl-ed-bd { padding: 10px 12px 6px; overflow-x: auto; }

/* —— 竖排（右侧「资源库」侧栏）：上＝条目列表（自身内滚，占上部）/ 下＝编辑器（占余高内滚）——
   侧栏本身已有边框与表头，故此处去掉外框，整体吃满侧栏高度。 */
.lbl-col { flex-direction: column; height: 100%; border: 0; border-radius: 0; background: transparent; }
.lbl-col .lbl-list { width: auto; flex: 0 1 auto; max-height: 38%; min-height: 92px; border-right: 0; border-bottom: 1px solid var(--border-strong); }
.lbl-col .lbl-ed { min-height: 0; }
.lbl-col .lbl-ed-nm { flex: 1; min-width: 0; width: auto; }
.lbl-col .lbl-ed-bd { flex: 1; min-height: 0; padding: 9px 10px 14px; overflow-y: auto; overflow-x: hidden; }
</style>
