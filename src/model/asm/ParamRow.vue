<script setup>
// 组件参数的一行（属性面板「主要参数 / 细节参数」共用，2026-10 统一设计）：标签 + 控件（数字 / 下拉 / 复选）+ 单位。
// 驱动装配件的参数另有状态（drive.driveMarks）：
//   link —— 驱动参数：与整星总体参数一一对应，改它即改驱动参数（关联件随之重排）；标签前一枚链环。
//   over —— 改写：本件这一项不再跟随驱动参数；标签加粗、行左缘一条机位色竖条，标签前的恢复钮一键恢复驱动值（悬停给出驱动值）。
// 模板示意值 / 校验错误的红色标示（row.bad）与上述状态正交，并存。口径一律只进 title。
import { computed } from 'vue'
import Icon from '../../components/Icon.vue'
import NumIn from '../NumIn.vue'
import { encOpt, decOpt } from '../asmLogic.js'

const props = defineProps({
  row: { type: Object, required: true },
  state: { type: String, default: '' },       // '' | 'link' | 'over'
  baseText: { type: String, default: '' },    // 改写行：驱动值（悬停 / 恢复钮 title）
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['set', 'reset'])
const r = computed(() => props.row)
const labelTip = computed(() => [r.value.title, props.state === 'link' ? '驱动参数：与总体参数一一对应，修改即更新驱动参数' : '', props.state === 'over' ? '已改写（驱动值 ' + props.baseText + '）' : ''].filter(Boolean).join('\n'))
</script>

<template>
  <div class="srow pr" :class="{ link: state === 'link', over: state === 'over' }" :data-param="r.key">
    <label :class="{ 'md-red': r.bad }" :title="labelTip || null">
      <button v-if="state === 'over'" type="button" class="pr-rst" data-act="p-reset" :disabled="disabled" :title="'恢复驱动值：' + baseText" @click="emit('reset')"><Icon name="undo-2" :size="11" /></button>
      <Icon v-else-if="state === 'link'" name="link-2" :size="11" class="pr-ic" />{{ r.label }}
    </label>
    <NumIn v-if="r.control === 'num'" :model-value="r.value" :min="r.min" :max="r.max" :integer="r.integer" :allow-empty="r.allowEmpty"
           :placeholder="r.placeholder" :bad="r.bad" :title="r.title" :sig="6" :disabled="disabled" @commit="(v) => emit('set', v)" />
    <select v-else-if="r.control === 'select'" :class="{ 'md-red': r.bad }" :value="encOpt(r.value)" :title="r.title || null" :disabled="disabled" @change="emit('set', decOpt($event.target.value))">
      <option v-for="o in r.options" :key="encOpt(o.value)" :value="encOpt(o.value)">{{ o.label }}</option>
    </select>
    <label v-else class="md-chkrow" :title="r.title || null"><input type="checkbox" :checked="!!r.value" :disabled="disabled" @change="emit('set', $event.target.checked)" /></label>
    <span class="u" data-i18n-skip>{{ r.unit }}</span>
  </div>
</template>

<style scoped>
.pr { position: relative; }
.pr > label { display: inline-flex; align-items: center; gap: 3px; }
.pr-ic { flex: none; color: var(--accent-ui); opacity: .8; }
/* 改写：标签加粗 + 行左缘机位色竖条（落在分区内边距里，不挤动对齐线） */
.pr.over > label { font-weight: 600; color: var(--text); }
.pr.over::before { content: ''; position: absolute; left: -8px; top: 3px; bottom: 3px; width: 2px; border-radius: 1px; background: var(--accent-ui); }
.pr-rst { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; margin-left: -2px;
  color: var(--accent-ui); background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl); cursor: pointer; transition: var(--t-state); }
.pr-rst:hover:not(:disabled) { background: var(--wash-hover); border-color: var(--border); }
.pr-rst:disabled { opacity: .4; cursor: not-allowed; }
</style>
