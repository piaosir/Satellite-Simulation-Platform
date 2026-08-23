<script setup>
// 波束多选。一条转发器可以同时落在几个波束里（同频复用是常态），图上该块就画成多色片。
//
// ★ 上下行各选各的：多波束不是转发器的整体属性，而是分方向的 —— 几个波束收、一个波束发
//   （或反过来的下行广播）都是常态，两侧勾的个数本就可以不一样。故这个组件一次只管一侧，
//   上行一个、下行一个，各自成集合。
//
// 两种形态共用这一份逻辑，都是「就地点选」而不是弹层：
//   chips —— 表格那两列，横排小色块，点亮 = 归属。一份计划的波束通常 2~8 个，
//            全列出来就能选完，弹层反而多一次点击、还要处理表格滚动时的定位。
//   list  —— 右栏检查器与批量生成，一行一个（色块 + 名称:带宽），空间够就把话写全。
import { computed } from 'vue'
import { beamLabel, beamSynthText } from '../shared/freqPlanModel.js'

const props = defineProps({
  beams: { type: Array, default: () => [] },
  modelValue: { type: Array, default: () => [] },
  mode: { type: String, default: 'list' },     // 'list' | 'chips'
  unit: { type: String, default: 'MHz' },      // 标签里的带宽用图上当前刻度写，与轴上的数同一把尺
  // 下行那一处专用：留空时实际生效的那一组（= 上行）。空集不是「没有波束」而是「随上行」，
  // 两者在图上是两回事，界面必须画得出这个区别 —— 用灰掉的色片示意，与带宽那格的灰字继承值同一套读法。
  inherit: { type: Array, default: null }
})
const emit = defineEmits(['update:modelValue'])

const has = (id) => (props.modelValue || []).includes(id)
// 继承态：本侧一个没勾、且调用方给了「留空时随谁」。勾任意一个即转为本侧单独指定，全部取消即回到继承态。
const inheriting = computed(() => !!props.inherit && !(props.modelValue || []).length)
const inherited = (id) => inheriting.value && props.inherit.includes(id)
const shown = (id) => (inheriting.value ? props.inherit.includes(id) : has(id))
const inheritText = computed(() => (props.inherit || [])
  .map((id) => props.beams.find((b) => b.id === id)).filter(Boolean).map((b) => b.name).join(' + '))

// 从波束合成导入的那几条，把「这一色对应哪几个波束号」写进 title：一份 HTS 计划里
// 认色片靠的就是这个（F3 落在哪几个波束上），名字与带宽都说不出这件事。
// 频率不在这里写 —— 一个波束在各转发器里各占各的段，写哪一条都是指错。
function bandText(b) {
  const syn = beamSynthText(b)
  return syn ? `｜${syn}` : ''
}

function toggle(id) {
  // ★ 结果按波束表的顺序排，不按点击顺序：色片自上而下就是这个次序，
  //   先点谁后点谁不该改变图上的样子（也免得同一组波束在不同转发器上画成不同次序）。
  emit('update:modelValue', props.beams.filter((b) => (b.id === id ? !has(id) : has(b.id))).map((b) => b.id))
}
</script>

<template>
  <div v-if="mode === 'chips'" class="bp-chips">
    <button v-for="b in beams" :key="b.id" type="button" class="chip" :class="{ on: has(b.id), gh: inherited(b.id) }"
      :style="{ background: shown(b.id) ? b.color : 'transparent', borderColor: b.color }"
      :title="beamLabel(b, unit) + bandText(b) + (has(b.id) ? '（已选）' : inherited(b.id) ? '（随上行）' : '')"
      @click.stop="toggle(b.id)"></button>
    <!-- 上行也没归波束时不写这三个字：一份新计划每行都挂一句「随上行」只是噪声 -->
    <span v-if="inheriting && inherit.length" class="bp-inh" :title="'下行未单独指定，随上行：' + inheritText">随上行</span>
    <span v-if="!beams.length" class="bp-none">—</span>
  </div>

  <div v-else class="bp-list">
    <button v-for="b in beams" :key="b.id" type="button" class="bp-row" :class="{ on: has(b.id), gh: inherited(b.id) }"
      :title="beamLabel(b, unit) + bandText(b)" @click="toggle(b.id)">
      <i class="sw" :style="{ background: shown(b.id) ? b.color : 'transparent', borderColor: b.color }"></i>
      <span class="nm">{{ beamLabel(b, unit) }}</span>
    </button>
    <p v-if="inheriting && inherit.length" class="bp-inh">未选 = 随上行（{{ inheritText }}）</p>
    <p v-if="!beams.length" class="bp-none">还没有波束。</p>
  </div>
</template>

<style scoped>
.bp-chips { display: flex; align-items: center; gap: 3px; flex-wrap: nowrap; }
.chip {
  width: 13px; height: 13px; padding: 0; flex: none;
  border: 1.5px solid var(--border); border-radius: var(--r-ctl); cursor: pointer;
}
.chip:hover { outline: 1px solid var(--text-muted); outline-offset: 1px; }
/* 继承态（下行留空）：色片灰掉 + 虚线边 —— 与带宽那格的灰字占位同一套读法「这不是我填的，是随来的」 */
.chip.gh { opacity: .42; border-style: dashed; }
.bp-none { color: var(--text-faint); font-size: 11px; }
.bp-inh { color: var(--text-faint); font-size: 10.5px; white-space: nowrap; margin: 0; }

.bp-list { display: flex; flex-direction: column; gap: 2px; }
.bp-row {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 3px 5px; background: transparent; border: 1px solid transparent;
  color: var(--text-muted); font-size: 12px; text-align: left; cursor: pointer; border-radius: var(--r-ctl);
}
.bp-row:hover { background: var(--surface); color: var(--text); }
.bp-row.on { color: var(--text); border-color: var(--border); background: var(--surface); }
.bp-row .sw { width: 12px; height: 12px; flex: none; border: 1.5px solid var(--border); border-radius: var(--r-ctl); }
.bp-row.gh .sw { opacity: .42; border-style: dashed; }
.bp-row .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
