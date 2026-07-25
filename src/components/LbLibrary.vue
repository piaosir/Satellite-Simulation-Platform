<script setup>
// 资源库主从视图（GEO / NGSO / 再生式共用）：取代旧「竖排大卡片」。
// 列表＝条目名称 + 一行摘要（行内 hover 动作：复制/删除），另一侧＝所选条目的编辑面板（slot，
// 原 BasebandPanel / EarthStationPanel / RegenSatPanel 原样塞入）。同屏只展开一份编辑器，
// 列表本身就是全库速览——信息密度与「同屏一个上下文」两头都占。
// 两种排布（layout）：'row' = 左列表右编辑器（宽区）；'column' = 上列表下编辑器（右侧「资源库」侧栏）。
import { computed, watch } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  items: { type: Array, required: true },        // [{ id, name, form, ... }]
  modelValue: { type: String, default: '' },     // 选中条目 id
  summary: { type: Function, default: null },    // (cfg) => 摘要字符串（mono 单行）
  minKeep: { type: Number, default: 1 },         // 少于等于该数量时禁删
  namePlaceholder: { type: String, default: '配置名称' },
  layout: { type: String, default: 'row' }       // 'row' 主从横排 / 'column' 上下堆叠（侧栏窄区）
})
const emit = defineEmits(['update:modelValue', 'add', 'duplicate', 'remove'])

const selected = computed(() => props.items.find((c) => c.id === props.modelValue) || props.items[0] || null)
// 选中项被删/换库后自动落回第一份
watch(() => [props.items.length, props.modelValue], () => {
  if (!props.items.length) return
  if (!props.items.some((c) => c.id === props.modelValue)) emit('update:modelValue', props.items[0].id)
}, { immediate: true })

const sumOf = (cfg) => { try { return props.summary ? (props.summary(cfg) || '') : '' } catch (e) { return '' } }
</script>

<template>
  <div class="lbl" :class="layout === 'column' ? 'lbl-col' : 'lbl-row'">
    <div class="lbl-list" role="listbox">
      <div v-for="cfg in items" :key="cfg.id" class="lbl-row" :class="{ on: selected && cfg.id === selected.id }"
           role="option" :aria-selected="selected && cfg.id === selected.id" @click="emit('update:modelValue', cfg.id)">
        <span class="lbl-nm" :title="cfg.name">{{ cfg.name || '（未命名）' }}</span>
        <span v-if="sumOf(cfg)" class="lbl-sum" :title="sumOf(cfg)">{{ sumOf(cfg) }}</span>
        <span class="lbl-row-acts">
          <button class="lbl-ico" title="复制此配置" @click.stop="emit('duplicate', cfg)"><Icon name="copy" :size="11" /></button>
          <button class="lbl-ico del" title="删除此配置" :disabled="items.length <= minKeep" @click.stop="emit('remove', cfg)"><Icon name="x" :size="11" /></button>
        </span>
      </div>
      <button class="lbl-add" @click="emit('add')"><Icon name="plus" :size="11" /> 新增</button>
    </div>

    <div v-if="selected" class="lbl-ed">
      <div class="lbl-ed-hd">
        <input v-model="selected.name" class="lbl-ed-nm" :placeholder="namePlaceholder" spellcheck="false" />
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
/* 左列表：全库速览 */
.lbl-list { flex: none; width: 190px; display: flex; flex-direction: column; border-right: 1px solid var(--border); background: var(--bg); overflow-y: auto; max-height: 420px; }
.lbl-row { position: relative; display: flex; flex-direction: column; gap: 1px; padding: 6px 9px 6px 11px; cursor: pointer; border-bottom: 1px solid var(--border); }
.lbl-row:hover { background: var(--surface); }
.lbl-row.on { background: var(--surface-2); box-shadow: inset 2px 0 0 var(--accent); }
.lbl-nm { font-size: 12px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 34px; }
.lbl-row:not(.on) .lbl-nm { color: var(--text-muted); font-weight: 400; }
.lbl-sum { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lbl-row-acts { position: absolute; top: 5px; right: 5px; display: none; gap: 2px; }
.lbl-row:hover .lbl-row-acts { display: inline-flex; }
.lbl-ico { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; cursor: pointer; background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.lbl-ico:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.lbl-ico.del:hover:not(:disabled) { color: var(--danger); }
.lbl-ico:disabled { opacity: .4; cursor: not-allowed; }
.lbl-add { font: inherit; font-size: 11px; display: flex; align-items: center; justify-content: center; gap: 4px; padding: 6px; margin: 6px; cursor: pointer; background: transparent; color: var(--text-muted); border: 1px dashed var(--border-strong); border-radius: var(--r-ctl, 2px); }
.lbl-add:hover { color: var(--text); border-color: var(--text-muted); }
/* 右编辑器 */
.lbl-ed { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.lbl-ed-hd { display: flex; align-items: center; gap: 6px; padding: 5px 10px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.lbl-ed-nm { flex: none; width: 180px; font: inherit; font-size: 12px; font-weight: 600; padding: 3px 7px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.lbl-ed-nm:focus { outline: none; border-color: var(--accent); }
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
