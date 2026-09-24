<script setup>
// 卫星搜索的筛选条（星座侧栏搜索框下方 + 卫星组管理器搜索框下方，两处同一个组件）。
//
// 一行「筛选」链接，点开才展开九个字段。判定逻辑一概不在这里 —— 全在 shared/satFilter.js，
// 本组件只管铺格子与回传。编目取不到时前四项禁用（title 说明去哪儿下载）。
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import NumBox from './NumBox.vue'
import { ownerName } from '../shared/satcatCodes.js'
import { OBJECT_TYPES, ORBIT_CLASSES, STATUS_KINDS, emptyFilters, isEmpty, ownersIn } from '../shared/satFilter.js'
import { byLang } from '../shared/i18n/lang.js'

const props = defineProps({
  modelValue: { type: Object, default: null },
  satcat: { type: Object, default: null },      // Map(NORAD -> row) 或 null
  pool: { type: Array, default: () => [] },     // 供「所有者」下拉只列池里真有的那些
  matched: { type: Number, default: -1 },       // >=0 时显示「已筛选 · N 颗」
  expanded: { type: Boolean, default: false }   // 常开且不出折叠头（嵌在「查找卫星」对话框里那份）
})
const emit = defineEmits(['update:modelValue', 'change'])

const open = ref(false)   // expanded=true 时忽略它
const f = computed(() => props.modelValue || emptyFilters())
const hasCat = computed(() => !!(props.satcat && props.satcat.size > 0))
const active = computed(() => !isEmpty(f.value))
const owners = computed(() => ownersIn(props.pool, props.satcat))
const CAT_TIP = '需先在文件管理下载卫星编目'

function set(k, v) {
  const next = { ...f.value, [k]: v }
  emit('update:modelValue', next)
  emit('change', next)
}
function clearAll() {
  const next = emptyFilters()
  emit('update:modelValue', next)
  emit('change', next)
}
</script>

<template>
  <div class="satfb">
    <div v-if="!expanded" class="fbh">
      <span class="lnk" :class="{ on: open }" @click="open = !open">
        <Icon name="chevron-down" class="disc" :class="{ shut: !open }" :size="12" /> 筛选
      </span>
      <span v-if="matched >= 0" class="fbn" data-i18n-skip>已筛选 · {{ matched }} 颗</span>
      <span v-if="active" class="lnk clr" title="清空全部筛选" @click="clearAll"><Icon name="x" :size="12" /> 清空</span>
    </div>
    <div v-if="open || expanded" class="fbody">
      <div class="frow" :title="hasCat ? '' : CAT_TIP">
        <label>所有者</label>
        <select class="ci" :disabled="!hasCat" :value="f.owner" @change="set('owner', $event.target.value)">
          <option value="">不限</option>
          <option v-for="o in owners" :key="o" :value="o">{{ ownerName(o) }}</option>
        </select>
      </div>
      <div class="frow" :title="hasCat ? '' : CAT_TIP">
        <label>对象类型</label>
        <select class="ci" :disabled="!hasCat" :value="f.type" @change="set('type', $event.target.value)">
          <option value="">不限</option>
          <option v-for="t in OBJECT_TYPES" :key="t" :value="t">{{ t }}</option>
        </select>
      </div>
      <div class="frow" :title="hasCat ? '' : CAT_TIP">
        <label>状态</label>
        <select class="ci" :disabled="!hasCat" :value="f.status" @change="set('status', $event.target.value)">
          <option value="">不限</option>
          <option v-for="s in STATUS_KINDS" :key="s.key" :value="s.key">{{ byLang(s.zh, s.en) }}</option>
        </select>
      </div>
      <div class="frow2" :title="hasCat ? '' : CAT_TIP">
        <label>发射年</label>
        <NumBox class="ci" :disabled="!hasCat" allow-empty :model-value="f.launchFrom" :min="1957" :max="2100" :step="1" placeholder="从" @commit="v => set('launchFrom', v)" />
        <span class="dash">–</span>
        <NumBox class="ci" :disabled="!hasCat" allow-empty :model-value="f.launchTo" :min="1957" :max="2100" :step="1" placeholder="至" @commit="v => set('launchTo', v)" />
        <span class="u"></span>
      </div>
      <div class="frow">
        <label>轨道区制</label>
        <select class="ci" :value="f.orbit" @change="set('orbit', $event.target.value)">
          <option value="">不限</option>
          <option v-for="o in ORBIT_CLASSES" :key="o" :value="o">{{ o }}</option>
        </select>
      </div>
      <div class="frow2">
        <label>近地点</label>
        <NumBox class="ci" allow-empty :model-value="f.perigeeFrom" :step="100" placeholder="从" @commit="v => set('perigeeFrom', v)" />
        <span class="dash">–</span>
        <NumBox class="ci" allow-empty :model-value="f.perigeeTo" :step="100" placeholder="至" @commit="v => set('perigeeTo', v)" />
        <span class="u">km</span>
      </div>
      <div class="frow2">
        <label>远地点</label>
        <NumBox class="ci" allow-empty :model-value="f.apogeeFrom" :step="100" placeholder="从" @commit="v => set('apogeeFrom', v)" />
        <span class="dash">–</span>
        <NumBox class="ci" allow-empty :model-value="f.apogeeTo" :step="100" placeholder="至" @commit="v => set('apogeeTo', v)" />
        <span class="u">km</span>
      </div>
      <div class="frow2">
        <label>倾角</label>
        <NumBox class="ci" allow-empty :model-value="f.inclFrom" :min="0" :max="180" :step="1" placeholder="从" @commit="v => set('inclFrom', v)" />
        <span class="dash">–</span>
        <NumBox class="ci" allow-empty :model-value="f.inclTo" :min="0" :max="180" :step="1" placeholder="至" @commit="v => set('inclTo', v)" />
        <span class="u">°</span>
      </div>
      <div class="frow2">
        <label>周期</label>
        <NumBox class="ci" allow-empty :model-value="f.periodFrom" :min="0" :step="10" placeholder="从" @commit="v => set('periodFrom', v)" />
        <span class="dash">–</span>
        <NumBox class="ci" allow-empty :model-value="f.periodTo" :min="0" :step="10" placeholder="至" @commit="v => set('periodTo', v)" />
        <span class="u">min</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.satfb { border-top: 1px solid var(--border); }
.fbh { display: flex; align-items: center; gap: 8px; padding: 3px 12px; font-size: var(--fs-2); color: var(--text-muted); }
.fbh .lnk { cursor: pointer; color: var(--accent); display: inline-flex; align-items: center; gap: 3px; }
.fbh .lnk.clr { margin-left: auto; }
.fbn { color: var(--text-faint); font-variant-numeric: lnum tnum; }
.fbody { padding: 2px 12px 6px; display: flex; flex-direction: column; gap: 3px; }
.frow, .frow2 { display: flex; align-items: center; gap: 4px; font-size: var(--fs-2); }
.frow > label, .frow2 > label { flex: 0 0 60px; min-width: 60px; color: var(--text-muted); }
.frow > .ci { flex: 1 1 auto; min-width: 0; }
.frow2 > .ci { flex: 1 1 0; min-width: 0; }
/* 范围行对齐：短横与单位列定宽（单位列最宽的「min」约 17px；发射年那行补一个空的单位格），
   五行「从 / 至」两个数字框的左右缘上下对齐，不再随 km / ° / min 的字宽各自伸缩 */
.dash { flex: 0 0 6px; text-align: center; color: var(--text-faint); }
.u { flex: 0 0 auto; color: var(--text-faint); }
.frow2 > .u { flex: none; min-width: 18px; }
</style>
