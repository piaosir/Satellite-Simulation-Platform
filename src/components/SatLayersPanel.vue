<script setup>
// 星座侧栏 · 图层面板（原型 → 落地件）。
//
// 把「内置星座 / 卫星组 / 导入星历 / 自定义星座 / 搜索结果」统一成一种实体：图层。每一行同一套控件，
// 手势只有四个，各段都一样，不再有「点内置组＝切换、点卫星组＝显示、点自定义星座＝单独显示」三套口径：
//   · 眼睛        显 / 隐（可多开，地图 = 所有可见图层的并集）
//   · Alt + 眼睛  仅显示此层（其余暂隐；顶部出现「仅显示：X」，点它还原）
//   · 点行        展开 / 收起该层的成员表（同一时刻只开一处）
//   · 双击行      聚焦（转到它那一面并选中）
// 其余操作（重命名 / 编辑 / 管理成员 / 导出 / 复制 / 删除 / 存为组 / 发送到小程序…）一律收进行尾「⋯」菜单与右键菜单，
// 菜单项由宿主按图层种类给（menuItems(row)），本组件不知道各种图层的业务。
// 本组件只管呈现与本地 UI 态（折叠 / 改名 / 菜单 / 两步删除）；数据与动作全在宿主（emit 出去）。
import { ref, reactive, nextTick, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import SatList from './SatList.vue'

const props = defineProps({
  // [{ key, title, count, actions:[{ key, label, icon, title }], rows:[row], epoch?: 'YYYY-MM-DDTHH:mm', empty: '一句陈述' }]
  sections: { type: Array, default: () => [] },
  // row: { id, kind, name, count, sub, color, colorable, visible, renamable, icon?, iconTitle? }
  summary: { type: Object, default: () => ({}) },      // { shown, layers, dataTime, status }
  solo: { type: Object, default: null },               // { id, name } → 顶部「仅显示：name」
  expanded: { type: String, default: '' },             // 正展开成员表的行 id
  expItems: { type: Array, default: () => [] },
  expLoading: { type: Boolean, default: false },
  expError: { type: String, default: '' },
  expActions: { type: Array, default: () => [] },
  // { keyword, results:[{ noradId, name, groupLabel, slot, picked }], finderActive }
  search: { type: Object, default: () => ({ keyword: '', results: [], finderActive: false }) },
  menuItems: { type: Function, default: null },        // (row) => [{ key, label, icon, tone, sep }]
  defaultColor: { type: String, default: '#4dabf7' }
})
const emit = defineEmits([
  'toggle', 'solo', 'restore', 'expand', 'activate', 'action', 'section-action',
  'color', 'color-reset', 'rename',
  'search-input', 'search-clear', 'search-pick', 'search-toggle-pick', 'open-finder',
  'epoch', 'epoch-now', 'list-action', 'list-activate'
])

/* —— 分区折叠 —— */
const closed = reactive(new Set())
const isOpen = (k) => !closed.has(k)
function toggleSec(k) { if (closed.has(k)) closed.delete(k); else closed.add(k) }

/* —— 行内改名（双击名字 / 菜单「重命名」）—— */
const renameId = ref('')
const renameVal = ref('')
let rnEl = null
const setRnEl = (el) => { rnEl = el }
function startRename(row) {
  if (!row || !row.renamable) return
  renameId.value = row.id; renameVal.value = row.name
  nextTick(() => { try { if (rnEl) { rnEl.focus(); rnEl.select() } } catch { /* ignore */ } })
}
function commitRename(row) {
  if (renameId.value !== row.id) return
  const v = renameVal.value.trim()
  renameId.value = ''
  if (v && v !== row.name) emit('rename', row, v)
}

/* —— 行菜单（⋯ / 右键）+ 两步删除 —— */
const menu = ref(null)
function openMenu(ev, row) {
  if (!props.menuItems) return
  const items = (props.menuItems(row) || []).filter(Boolean)
  if (!items.length) return
  const W = 196, H = Math.min(340, items.length * 26 + 10)
  const x = Math.max(4, Math.min(ev.clientX, window.innerWidth - W - 4))
  const y = Math.max(4, Math.min(ev.clientY, window.innerHeight - H - 4))
  menu.value = { row, items, x, y }
}
function closeMenu() { menu.value = null }
const delArm = ref('')
let armT = 0
function onItem(it) {
  const m = menu.value; if (!m) return
  const row = m.row
  closeMenu()
  if (it.key === 'rename') { startRename(row); return }
  if (it.key === 'delete') {
    if (delArm.value === row.id) { clearTimeout(armT); delArm.value = ''; emit('action', 'delete', row); return }
    delArm.value = row.id; clearTimeout(armT); armT = setTimeout(() => { delArm.value = '' }, 5000)
    return
  }
  emit('action', it.key, row)
}
const itemLabel = (it, row) => (it.key === 'delete' && delArm.value === row.id ? '确认删除' : it.label)
onBeforeUnmount(() => clearTimeout(armT))

/* —— 眼睛：普通点 = 显隐；Alt + 点 = 仅显示此层 —— */
function onEye(ev, row) { if (ev.altKey) emit('solo', row); else emit('toggle', row) }
const eyeTitle = (row) => (row.visible ? '隐藏（Alt + 点击：仅显示此层）' : '显示（Alt + 点击：仅显示此层）')
</script>

<template>
  <div class="lp">
    <div class="lp-top">
      <div class="lp-search">
        <span class="lp-si"><Icon name="search" :size="12" /></span>
        <input :value="search.keyword" placeholder="搜索名 / 编号" spellcheck="false" @input="emit('search-input', $event.target.value)" />
        <span v-if="search.keyword" class="lp-x" title="清除" @click="emit('search-clear')"><Icon name="x" :size="12" /></span>
        <button type="button" class="lp-finder" :class="{ on: search.finderActive }" title="查找卫星：按所有者 / 对象类型 / 状态 / 发射年 / 轨道区制 / 近远地点 / 倾角 / 周期" @click="emit('open-finder')"><Icon name="filter" :size="12" /></button>
        <div v-if="search.results && search.results.length" class="lp-drop">
          <div v-for="it in search.results" :key="it.noradId" class="lp-di" :class="{ picked: it.picked }" @click="emit('search-pick', it)">
            <div class="lp-dt">
              <div class="lp-dn" data-i18n-skip>{{ it.name }}</div>
              <div class="lp-ds" data-i18n-skip>{{ it.groupLabel }} · NORAD {{ it.noradId }}<span v-if="it.slot"> · {{ it.slot }}</span></div>
            </div>
            <span class="lp-dp" :title="it.picked ? '已在选中集中，点击移出' : '加入选中集'" @click.stop="emit('search-toggle-pick', it)"><Icon :name="it.picked ? 'check' : 'plus'" :size="12" /></span>
          </div>
        </div>
      </div>
      <div class="lp-sum" data-i18n-skip>
        <span class="lp-sn">显示 {{ summary.shown ?? 0 }} 颗 · {{ summary.layers ?? 0 }} 图层<template v-if="summary.dataTime"> · OMM {{ summary.dataTime }}</template><template v-if="summary.status"> · {{ summary.status }}</template></span>
        <span v-if="solo" class="lp-solo" title="点击还原之前的显示" @click="emit('restore')">仅显示：{{ solo.name }} <Icon name="x" :size="11" /></span>
      </div>
    </div>

    <div class="lp-body">
      <div v-for="sec in sections" :key="sec.key" class="lp-sec" :class="'lp-sec-' + sec.key">
        <div class="lp-sh" @click="toggleSec(sec.key)">
          <span class="lp-sv"><Icon :name="isOpen(sec.key) ? 'chevron-down' : 'chevron-right'" :size="12" /></span>
          <span class="lp-st">{{ sec.title }}</span>
          <span v-if="sec.count != null" class="lp-sc" data-i18n-skip>{{ sec.count }}</span>
          <span class="lp-sa" @click.stop>
            <span v-for="a in (sec.actions || [])" :key="a.key" class="lnk" :title="a.title || ''" @click="emit('section-action', sec.key, a.key)"><Icon v-if="a.icon" :name="a.icon" :size="12" />{{ a.label }}</span>
          </span>
        </div>
        <template v-if="isOpen(sec.key)">
          <div v-if="sec.epoch !== undefined" class="lp-epoch" title="全部自定义星座共用的场景历元：星座定向以此为准，拖时间轴仍从此历元向后推演">
            <label>场景历元</label>
            <input class="ci" type="datetime-local" :value="sec.epoch" @change="emit('epoch', $event.target.value)" />
            <span class="lnk" title="取当前时刻为场景历元" @click="emit('epoch-now')">当前</span>
          </div>
          <div v-if="!sec.rows.length" class="lp-empty">{{ sec.empty }}</div>
          <template v-for="row in sec.rows" :key="row.id">
            <div
              class="lp-row"
              :class="{ off: !row.visible, exp: expanded === row.id, solo: solo && solo.id === row.id, arm: delArm === row.id }"
              @click="emit('expand', row)" @dblclick="emit('activate', row)"
              @contextmenu.prevent.stop="openMenu($event, row)"
            >
              <span class="lp-eye" :title="eyeTitle(row)" @click.stop="onEye($event, row)"><Icon :name="row.visible ? 'eye' : 'eye-off'" :size="13" /></span>
              <label v-if="row.colorable" class="lp-sw" :title="'星点颜色（' + (row.color || '未设置') + '）'" @click.stop>
                <span class="lp-swi" :class="{ unset: !row.color }" :style="row.color ? { background: row.color } : null"></span>
                <input type="color" :value="row.color || defaultColor" @input="emit('color', row, $event.target.value)" />
              </label>
              <span v-else class="lp-sw fixed"><span class="lp-swi" :style="{ background: row.color || defaultColor }"></span></span>
              <span v-if="row.icon" class="lp-ki" :title="row.iconTitle || ''"><Icon :name="row.icon" :size="12" /></span>
              <input
                v-if="renameId === row.id" :ref="setRnEl" class="lp-rn" v-model="renameVal"
                @click.stop @dblclick.stop @keydown.enter="commitRename(row)" @keydown.esc.stop="renameId = ''" @blur="commitRename(row)"
              />
              <span v-else class="lp-nm" :title="row.name" data-i18n-skip @dblclick.stop="startRename(row)">{{ row.name }}</span>
              <span v-if="row.sub" class="lp-sub" data-i18n-skip>{{ row.sub }}</span>
              <span class="lp-cnt" data-i18n-skip>{{ row.count }}</span>
              <span class="lp-more" title="更多操作（右键同）" @click.stop="openMenu($event, row)"><Icon name="ellipsis" :size="13" /></span>
              <span class="lp-chev"><Icon :name="expanded === row.id ? 'chevron-down' : 'chevron-right'" :size="12" /></span>
            </div>
            <SatList
              v-if="expanded === row.id"
              :items="expItems" :reset-key="row.id" :loading="expLoading" :error="expError" :actions="expActions" :rows="14"
              :placeholder="'在「' + row.name + '」里筛选'" empty="该层还没有卫星。"
              @action="(k, p) => emit('list-action', k, p, row)" @activate="(it) => emit('list-activate', it, row)"
            />
          </template>
        </template>
      </div>
    </div>

    <template v-if="menu">
      <div class="lp-mbd" @mousedown="closeMenu" @contextmenu.prevent="closeMenu"></div>
      <div class="lp-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
        <div class="lp-mh" data-i18n-skip>{{ menu.row.name }}</div>
        <template v-for="(it, i) in menu.items" :key="it.key + i">
          <div v-if="it.sep" class="lp-msep"></div>
          <div v-else class="lp-mi" :class="[it.tone || '', { warn: it.key === 'delete' && delArm === menu.row.id }]" @click="onItem(it)">
            <Icon v-if="it.icon" :name="it.icon" :size="12" /><span>{{ itemLabel(it, menu.row) }}</span>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lp { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.lp-top { flex: none; padding: 8px 12px 6px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; }
.lp-search { position: relative; display: flex; align-items: center; gap: 4px; }
.lp-search input { flex: 1; min-width: 0; height: var(--h-ctl); padding: 0 24px 0 24px; box-sizing: border-box; }
.lp-si { position: absolute; left: 7px; top: 50%; transform: translateY(-50%); color: var(--text-faint); display: inline-flex; pointer-events: none; }
.lp-x { position: absolute; right: 34px; top: 50%; transform: translateY(-50%); color: var(--text-faint); cursor: pointer; display: inline-flex; padding: 2px; }
.lp-x:hover { color: var(--text); }
.lp-finder { flex: none; width: var(--h-ctl); height: var(--h-ctl); display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--field-border); background: var(--field-bg); color: var(--text-muted); border-radius: var(--r-ctl); cursor: pointer; padding: 0; }
.lp-finder:hover { border-color: var(--field-border-hover); color: var(--text); }
.lp-finder.on { border-color: var(--accent); color: var(--accent); }
.lp-drop { position: absolute; left: 0; right: 0; top: calc(100% + 2px); z-index: 30; max-height: 280px; overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: var(--shadow-2); border-radius: var(--r-box); }
.lp-di { display: flex; align-items: center; gap: 6px; padding: 4px 8px; cursor: pointer; }
.lp-di:hover { background: var(--surface-2); }
.lp-di.picked .lp-dn { color: var(--accent); }
.lp-dt { flex: 1; min-width: 0; }
.lp-dn { font-size: var(--fs-3); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lp-ds { font-size: var(--fs-1); color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.lp-dp { flex: none; display: inline-flex; color: var(--text-faint); padding: 2px; border-radius: var(--r-box); }
.lp-dp:hover { color: var(--accent); background: var(--bg); }
.lp-sum { display: flex; align-items: center; gap: 8px; font-size: var(--fs-2); color: var(--text-faint); line-height: 1.5; font-variant-numeric: tabular-nums; flex-wrap: wrap; }
.lp-sn { white-space: nowrap; }
.lp-solo { display: inline-flex; align-items: center; gap: 3px; padding: 1px 7px; border-radius: var(--r-pill); background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); cursor: pointer; white-space: nowrap; }
.lp-solo:hover { background: color-mix(in srgb, var(--accent) 26%, transparent); }

.lp-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 0 10px; }
.lp-sec + .lp-sec { border-top: 1px solid var(--border); margin-top: 4px; padding-top: 2px; }
.lp-sh { display: flex; align-items: center; gap: 5px; padding: 5px 12px 4px 8px; font-size: var(--fs-3); color: var(--text-muted); cursor: pointer; user-select: none; }
.lp-sh:hover { color: var(--text); }
.lp-sv { flex: none; display: inline-flex; color: var(--text-faint); }
.lp-st { font-weight: 600; letter-spacing: var(--ls-label); }
.lp-sc { font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.lp-sa { margin-left: auto; display: inline-flex; gap: 10px; }
.lnk { cursor: pointer; color: var(--accent); display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
.lnk:hover { text-decoration: underline; }
.lp-epoch { display: flex; align-items: center; gap: 6px; padding: 2px 12px 6px 30px; font-size: var(--fs-2); color: var(--text-muted); }
.lp-epoch label { flex: none; }
.lp-epoch .ci { flex: 1; min-width: 0; }
.lp-empty { padding: 2px 12px 6px 30px; font-size: var(--fs-2); color: var(--text-faint); }

.lp-row { display: flex; align-items: center; gap: 6px; padding: 3px 8px 3px 8px; min-height: 24px; font-size: var(--fs-3); color: var(--text-muted); cursor: pointer; white-space: nowrap; }
.lp-row:hover { background: var(--surface-2); color: var(--text); }
.lp-row.exp { color: var(--text); background: color-mix(in srgb, var(--surface-2) 70%, transparent); }
.lp-row.off .lp-nm, .lp-row.off .lp-cnt, .lp-row.off .lp-sub, .lp-row.off .lp-swi { opacity: 0.45; }
.lp-row.solo .lp-nm { color: var(--accent); }
.lp-row.arm { box-shadow: inset 2px 0 0 var(--danger); }
.lp-eye { flex: none; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-muted); border-radius: var(--r-box); }
.lp-eye:hover { color: var(--text); background: var(--bg); }
.lp-row.off .lp-eye { color: var(--text-faint); }
.lp-sw { position: relative; flex: none; width: 12px; height: 12px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.lp-sw.fixed { cursor: default; }
.lp-sw input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; opacity: 0; cursor: pointer; }
.lp-swi { width: 10px; height: 10px; border-radius: 3px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 25%, transparent); }
.lp-swi.unset { background: repeating-linear-gradient(135deg, transparent 0 2px, color-mix(in srgb, var(--text) 30%, transparent) 2px 3px); }
.lp-ki { flex: none; display: inline-flex; color: var(--text-faint); }
.lp-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.lp-rn { flex: 1; min-width: 0; height: 20px; font: inherit; padding: 0 4px; border: 1px solid var(--accent); background: var(--field-bg); color: var(--text); border-radius: var(--r-ctl); user-select: text; }
.lp-sub { flex: none; font-size: var(--fs-1); color: var(--text-faint); font-variant-numeric: tabular-nums; max-width: 46%; overflow: hidden; text-overflow: ellipsis; }
.lp-cnt { flex: none; min-width: 34px; text-align: right; font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.lp-more { flex: none; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); border-radius: var(--r-box); opacity: 0; }
.lp-row:hover .lp-more, .lp-row.arm .lp-more { opacity: 1; }
.lp-more:hover { color: var(--text); background: var(--bg); }
.lp-row.arm .lp-more { color: var(--danger); }
.lp-chev { flex: none; width: 14px; display: inline-flex; justify-content: center; color: var(--text-faint); }
.lp-row.exp .lp-chev { color: var(--text); }

.lp-mbd { position: fixed; inset: 0; z-index: 2190; }
.lp-menu { position: fixed; z-index: 2200; width: 196px; max-height: 340px; overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: var(--shadow-2); border-radius: var(--r-box); padding: 4px 0; }
.lp-mh { padding: 3px 10px 5px; font-size: var(--fs-1); color: var(--text-faint); border-bottom: 1px solid var(--border); margin-bottom: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lp-mi { display: flex; align-items: center; gap: 7px; padding: 4px 10px; font-size: var(--fs-3); color: var(--text); cursor: pointer; }
.lp-mi:hover { background: var(--surface-2); }
.lp-mi.warn { color: var(--danger); }
.lp-mi.danger:hover { color: var(--danger); }
.lp-msep { height: 1px; background: var(--border); margin: 3px 0; }
</style>
