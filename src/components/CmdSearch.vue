<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { diagMsg } from '../stores/log.js'
import { commands, recent, noteUsed, searchCommands } from '../stores/commands'
import Icon from './Icon.vue'

// 标题栏搜索框 —— 仿 Office 标题栏「搜索」（旧版「告诉我你想要做什么」，Alt+Q）。
//   空框获焦：「最近使用的操作」+「建议的操作」
//   输入：「操作」= 命中的命令（标题 / 关键词 / 位置 / 说明多路匹配，多词取交集）；末尾「在星座中搜索“…”」
//   行为：↑↓ 选、Enter 执行、→ 展开子菜单（带 ▸ 的行）、← 收回、Esc 关；执行后清空并交回焦点
//   数据全部来自 stores/commands.js 的登记表；本组件不认识任何具体功能。
const props = defineProps({
  find: { type: Function, default: null },        // (q) => void：「在星座中搜索」
  findAvail: { type: Boolean, default: false }
})
const emit = defineEmits(['run', 'hint', 'open'])

const MAX_ACTIONS = 10      // 「操作」最多显示条数（参数行入索引后同名命中多，列表可滚）
const MAX_RECENT = 5
const MAX_SUGGEST = 5
// 建议的操作（空框时；已在「最近使用」里的不重复出现）
const SUGGEST_IDS = ['menu.calc.0', 'menu.file.0', 'menu.calc.5', 'side.vis', 'menu.export.1', 'menu.tools.2', 'menu.file.1']

const q = ref('')
const open = ref(false)
const active = ref(-1)      // 当前高亮行（flat 序号）
const sub = ref(null)       // 展开中的子菜单：{ row, items, active, top }
const boxEl = ref(null)
const inputEl = ref(null)
const listEl = ref(null)

// ---- 结果分区 ----
const byId = computed(() => {
  const m = new Map()
  for (const c of commands.value) {
    m.set(c.id, { cmd: c, parent: null })
    if (Array.isArray(c.children)) for (const ch of c.children) m.set(ch.id, { cmd: ch, parent: c })
  }
  return m
})
const sections = computed(() => {
  const text = q.value.trim()
  const out = []
  if (!text) {
    const seen = new Set()
    const rec = []
    for (const id of recent.ids) {
      const e = byId.value.get(id)
      if (!e || seen.has(id)) continue
      seen.add(id); rec.push(e)
      if (rec.length >= MAX_RECENT) break
    }
    if (rec.length) out.push({ key: 'recent', title: '最近使用的操作', items: rec })
    const sug = []
    for (const id of SUGGEST_IDS) {
      const e = byId.value.get(id)
      if (!e || seen.has(id)) continue
      seen.add(id); sug.push(e)
      if (sug.length >= MAX_SUGGEST) break
    }
    if (sug.length) out.push({ key: 'suggest', title: '建议的操作', items: sug })
    return out
  }
  const hits = searchCommands(text, commands.value, MAX_ACTIONS)
  out.push({ key: 'actions', title: '操作', items: hits.map((h) => ({ cmd: h.cmd, parent: h.parent })) })
  if (props.find && props.findAvail) {
    out.push({ key: 'find', title: '', items: [{ find: true, text }] })
  }
  return out
})
// 键盘导航用的扁平行表
const flat = computed(() => sections.value.flatMap((s) => s.items))
const hasChildren = (row) => !!(row && row.cmd && Array.isArray(row.cmd.children) && row.cmd.children.length)

// 开合状态报给宿主：标题栏是窗口拖拽区（-webkit-app-region: drag），点在空白处 DOM 收不到 mousedown，
// 「点外面收起」在那里失效 —— 宿主据此在下拉开着时把标题栏临时切成非拖拽区（App.vue .menubar.ms-open）。
watch(open, (v) => emit('open', v))

// 结果行的身份签名：命令表是 computed，任一登记方读到的响应式状态一变（每分钟一次的激活自查、
// 时钟播放态、主题 / 语言…）就整表重建，flat 于是换了一批【内容相同】的新对象。只按引用比就会
// 在键盘导航中途把高亮打回第一条、把飞出子菜单关掉 —— 改按 id 序列比，真没变就什么都不做。
const rowSig = (rows) => rows.map((r) => (r.cmd ? (r.parent ? r.parent.id + '>' : '') + (r.cmd.id || r.cmd.label) : (r.find ? 'find:' + r.text : 'x'))).join('|')
let lastSig = ''
watch(flat, (rows) => {
  const sig = rowSig(rows)
  if (sig === lastSig) return                  // 只是命令表重建、结果没变：高亮与子菜单原样留着
  lastSig = sig
  if (open.value && q.value.trim()) diagMsg('结果表变化：' + rows.length + ' 行（高亮复位）')
  // 结果变了：高亮回到第一条（Office：Enter 执行第一条）；空框时不预选
  active.value = rows.length && q.value.trim() ? 0 : -1
  sub.value = null
})

// ---- 打开 / 关闭 ----
function show() { open.value = true; active.value = flat.value.length && q.value.trim() ? 0 : -1 }
function hide() { open.value = false; sub.value = null; active.value = -1; emit('hint', '') }
// 再次聚焦时全选已有文字（Office / Windows 搜索框惯例）：Esc 后框里留着上次的词，直接打字就是换词而不是接着写
function focusBox() { if (inputEl.value) { inputEl.value.focus(); inputEl.value.select() } show() }
function clearText() { q.value = ''; inputEl.value && inputEl.value.focus(); show() }
function onFocus() { show() }
function onInput(e) { q.value = e.target.value; if (!open.value) open.value = true }
function onDocDown(e) { if (open.value && boxEl.value && !boxEl.value.contains(e.target)) hide() }
function onWinKey(e) {
  // Alt+Q：Office 的搜索框快捷键
  if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'q' || e.key === 'Q')) { e.preventDefault(); focusBox() }
}

// ---- 执行 ----
function finish() {
  q.value = ''
  hide()
  inputEl.value && inputEl.value.blur()
}
function runRow(row) {
  if (!row) return
  if (row.find) { const t = row.text; finish(); props.find && props.find(t); return }
  if (hasChildren(row)) { openSub(flat.value.indexOf(row)); return }
  const cmd = row.cmd
  if (cmd.disabled) return
  noteUsed(cmd.id)
  finish()
  emit('run', cmd)
}
function runSubItem(item) {
  if (!item || item.disabled) return
  noteUsed(item.id)
  finish()
  emit('run', item)
}

// ---- 子菜单（带 ▸ 的行：Office 的「方向 ▸ 纵向 / 横向」）----
function openSub(i) {
  const row = flat.value[i]
  if (!hasChildren(row)) { sub.value = null; return }
  active.value = i
  const el = listEl.value && listEl.value.querySelector('[data-row="' + i + '"]')
  // 5 = .ms-sub 1px 边 + 4px 内距：子菜单首行对齐父行；offsetTop 不含中间滚动容器的滚动量，列表滚过要扣掉
  const top = el ? el.offsetTop - listEl.value.scrollTop - 5 : 0
  sub.value = { row: i, items: row.cmd.children, active: 0, top }
}
function closeSub() { sub.value = null }
function hoverRow(i) {
  active.value = i
  const row = flat.value[i]
  emit('hint', (row && row.cmd && !row.cmd.disabled && row.cmd.hint) || '')
  if (hasChildren(row)) openSub(i); else if (sub.value && sub.value.row !== i) closeSub()
}

// ---- 键盘 ----
function onKey(e) {
  if (!open.value) {
    if (e.key === 'ArrowDown' || e.key === 'Enter') { show(); e.preventDefault() }
    return
  }
  const n = flat.value.length
  if (sub.value) {
    const s = sub.value, m = s.items.length
    if (e.key === 'ArrowDown') { s.active = (s.active + 1) % m; e.preventDefault(); return }
    if (e.key === 'ArrowUp') { s.active = (s.active - 1 + m) % m; e.preventDefault(); return }
    if (e.key === 'ArrowLeft') { closeSub(); e.preventDefault(); return }
    if (e.key === 'Enter') { runSubItem(s.items[s.active]); e.preventDefault(); return }
    if (e.key === 'Escape') { closeSub(); e.preventDefault(); return }
  }
  if (e.key === 'ArrowDown') { if (n) active.value = (active.value + 1) % n; scrollActive(); e.preventDefault() }
  else if (e.key === 'ArrowUp') { if (n) active.value = (active.value - 1 + n) % n; scrollActive(); e.preventDefault() }
  else if (e.key === 'ArrowRight') { if (hasChildren(flat.value[active.value])) { openSub(active.value); e.preventDefault() } }
  else if (e.key === 'Enter') { const row = flat.value[active.value >= 0 ? active.value : 0]; if (row) runRow(row); e.preventDefault() }
  else if (e.key === 'Escape') { hide(); inputEl.value && inputEl.value.blur(); e.preventDefault() }
  else if (e.key === 'Tab') hide()
}
function scrollActive() {
  nextTick(() => {
    const el = listEl.value && listEl.value.querySelector('[data-row="' + active.value + '"]')
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
  })
}

// ★ 切到别的程序 / 窗口最小化时收起下拉：原先只有 Esc、Tab、点外面三条路。挂机切走时下拉还开着、
//   首行还预高亮、标题栏还是 no-drag（.menubar.ms-open），回来随手一个回车就执行了首条命令。
function onWinBlur() { if (open.value) { diagMsg('窗口失焦 → 收起下拉'); hide() } }
function onVis() { if (document.hidden && open.value) { diagMsg('窗口隐藏 → 收起下拉'); hide() } }
onMounted(() => {
  window.addEventListener('keydown', onWinKey)
  document.addEventListener('mousedown', onDocDown, true)
  window.addEventListener('blur', onWinBlur)
  document.addEventListener('visibilitychange', onVis)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWinKey)
  document.removeEventListener('mousedown', onDocDown, true)
  window.removeEventListener('blur', onWinBlur)
  document.removeEventListener('visibilitychange', onVis)
})
</script>

<template>
  <div ref="boxEl" class="ms" :class="{ open }">
    <div class="ms-box" title="搜索 (Alt+Q)" @click="focusBox">
      <Icon class="ms-ico" name="search" :size="14" />
      <input
        ref="inputEl" class="ms-in" type="text" :value="q" placeholder="搜索" spellcheck="false" autocomplete="off"
        @focus="onFocus" @input="onInput" @keydown="onKey"
      />
      <button v-if="q" class="ms-x" type="button" tabindex="-1" title="清除" @mousedown.prevent @click="clearText"><Icon name="x" :size="12" /></button>
    </div>

    <div v-if="open && (flat.length || q.trim())" class="ms-pop" @mousedown.prevent>
      <div ref="listEl" class="ms-list">
        <template v-for="sec in sections" :key="sec.key">
          <div v-if="sec.title" class="ms-h">{{ sec.title }}</div>
          <div v-else class="ms-sep"></div>
          <template v-for="row in sec.items" :key="row.find ? 'find' : (row.parent ? row.parent.id + '/' : '') + row.cmd.id">
            <!-- 「在星座中搜索“…”」：Office 末尾那条「在文档中查找“…”」的对应物 -->
            <div
              v-if="row.find" class="ms-row" :class="{ on: active === flat.indexOf(row) }" :data-row="flat.indexOf(row)"
              @mouseenter="hoverRow(flat.indexOf(row))" @click="runRow(row)"
            >
              <span class="ms-rico"><Icon name="satellite" :size="14" /></span>
              <span class="ms-lbl">在星座中搜索“{{ row.text }}”</span>
            </div>
            <div
              v-else class="ms-row" :class="{ on: active === flat.indexOf(row), dis: row.cmd.disabled }" :data-row="flat.indexOf(row)" :title="row.cmd.hint || (row.parent && row.parent.hint) || null"
              @mouseenter="hoverRow(flat.indexOf(row))" @mouseleave="emit('hint', '')" @click="runRow(row)"
            >
              <span class="ms-rico"><Icon :name="row.cmd.icon || (row.parent && row.parent.icon) || 'chevron-right'" :size="14" /></span>
              <span class="ms-lbl"><template v-if="row.parent || row.cmd.path"><span class="ms-par">{{ row.parent ? row.parent.label : row.cmd.path }}</span><span class="ms-arr">›</span></template>{{ row.cmd.label }}</span>
              <span v-if="row.cmd.group || (row.parent && row.parent.group)" class="ms-grp">{{ row.cmd.group || row.parent.group }}</span>
              <span v-if="row.cmd.check" class="ms-ck"><Icon name="check" :size="12" /></span>
              <span v-if="hasChildren(row)" class="ms-more"><Icon name="chevron-right" :size="12" /></span>
            </div>
          </template>
        </template>
        <div v-if="q.trim() && !flat.length" class="ms-empty">没有匹配的操作。</div>
      </div>

      <!-- 子菜单：贴在面板右侧、与父行齐平 -->
      <div v-if="sub" class="ms-sub" :style="{ top: sub.top + 'px' }" @mouseleave="closeSub">
        <div
          v-for="(it, j) in sub.items" :key="it.id" class="ms-row" :class="{ on: sub.active === j, dis: it.disabled }" :title="it.hint || null"
          @mouseenter="sub.active = j" @click="runSubItem(it)"
        >
          <span class="ms-rico"><Icon v-if="it.icon" :name="it.icon" :size="14" /></span>
          <span class="ms-lbl">{{ it.label }}</span>
          <span v-if="it.check" class="ms-ck"><Icon name="check" :size="12" /></span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 框：标题栏正中，宽随窗口走；获焦时略放宽（Office 标题栏搜索框范式） */
.ms { position: relative; width: clamp(240px, 30vw, 460px); transition: width var(--dur-2) var(--ease-out); align-self: center; }
.ms.open { width: clamp(300px, 36vw, 560px); }
.ms-box {
  display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 6px 0 8px;
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-card);
  color: var(--text-muted); cursor: text;
  transition: border-color var(--dur-1) linear, box-shadow var(--dur-1) linear;
}
.ms-box:hover { border-color: var(--border-strong); }
.ms.open .ms-box { border-color: var(--accent-ui); box-shadow: 0 0 0 1px var(--accent-ui); color: var(--text); }
.ms-ico { flex: none; color: var(--text-faint); }
.ms-in {
  flex: 1; min-width: 0; height: 100% !important; border: 0; outline: 0; background: transparent; padding: 0;
  font-size: var(--fs-4); color: var(--text);
}
.ms-in::placeholder { color: var(--text-faint); }
/* 焦点环只画一层：controls.css 给所有输入框的 2px 机位色环带 !important，这里同样带 !important 压掉，
   由整个框（.ms.open .ms-box 的 1px 描边 + 1px 外环 = 2px）来画 —— 否则框内再套一圈就是双重聚焦框 */
.ms-in:focus, .ms-in:focus-visible { outline: none !important; }
.ms-x { flex: none; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; background: transparent; color: var(--text-faint); cursor: pointer; border-radius: var(--r-ctl); }
.ms-x:hover { background: var(--surface-2); color: var(--text); }

/* 下拉：与框同宽，贴在框下。四周 4px 内距让高亮行成为与外框同心的圆角块（6 − 4 = 2）；
   行的左右内距各减 4px，图标与文字 x 不动 */
.ms-pop {
  position: absolute; top: calc(100% + 3px); left: 0; right: 0; z-index: 120;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-float);
  box-shadow: var(--shadow-2); padding: 4px;
  animation: ui-float-in var(--dur-2) var(--ease-out);
}
.ms-list { max-height: min(60vh, 520px); overflow-y: auto; }
.ms-h { padding: 6px 8px 3px; font-size: var(--fs-2); font-weight: 400; letter-spacing: var(--ls-label); color: var(--text-faint); }
.ms-h + .ms-row { margin-top: 1px; }
.ms-sep { height: 0; border-top: 1px solid var(--border); margin: 4px 4px; }
.ms-row {
  display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 8px 0 6px; border-radius: var(--r-ctl);
  font-size: var(--fs-4); color: var(--text); cursor: default; white-space: nowrap;
}
.ms-row.on { background: var(--accent-ui); color: var(--bg); }
.ms-row.dis { color: var(--text-faint); }
.ms-row.dis.on { background: var(--wash-hover); color: var(--text-faint); }   /* 键盘光标落在禁用项上仍可见，但不像可执行 */
.ms-rico { width: 16px; flex: none; display: inline-flex; justify-content: center; color: var(--text-faint); }
.ms-row.on .ms-rico { color: inherit; }
.ms-lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ms-par { color: var(--text-muted); }
.ms-arr { margin: 0 5px; color: var(--text-faint); }
.ms-row.on .ms-par, .ms-row.on .ms-arr, .ms-row.on .ms-grp { color: inherit; opacity: .8; }
.ms-grp { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; font-size: var(--fs-2); color: var(--text-faint); }
.ms-ck, .ms-more { flex: none; display: inline-flex; color: var(--text-muted); }
.ms-row.on .ms-ck, .ms-row.on .ms-more { color: inherit; }
.ms-empty { padding: 8px 8px 6px; font-size: var(--fs-3); color: var(--text-faint); }

/* 子菜单：面板右侧、首行与父行齐平（top 由 openSub 扣掉边框 + 内距）；悬停即出，不加入场 */
.ms-sub {
  position: absolute; left: calc(100% - 2px); min-width: 180px; z-index: 121;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-float);
  box-shadow: var(--shadow-2); padding: 4px;
}
</style>
