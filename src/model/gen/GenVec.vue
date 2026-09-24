<script setup>
// 生成页的一格三维向量字段（位置 / 方向，本体系：+X 速度、+Y 南、+Z 对地；原点 = 平台体中心）：标签 + x / y / z 三个数字框 + 单位。
// 与 GenNum 同一套上下文（provide 'gen'）：值、描红、出处 title 按 spec 路径取，分量路径写成 path[0] / path[1] / path[2]。
import { computed, inject } from 'vue'
import NumIn from '../NumIn.vue'

const props = defineProps({
  path: { type: String, required: true },
  label: { type: String, required: true },
  unit: { type: String, default: '' },
  min: { type: Number, default: -Infinity },
  max: { type: Number, default: Infinity },
  tip: { type: String, default: '' }
})
const gen = inject('gen')
const bad = computed(() => gen.bad(props.path))
const title = computed(() => [props.tip, gen.tip(props.path)].filter(Boolean).join('\n'))
const AX = ['x', 'y', 'z']
</script>

<template>
  <div class="gn-v">
    <label :class="{ 'md-red': bad }" :title="title || null">{{ label }}</label>
    <div class="gn-v3">
      <NumIn v-for="k in [0, 1, 2]" :key="k" :model-value="gen.val(path + '[' + k + ']')" :min="min" :max="max" :bad="bad" :sig="6"
             :title="(title ? title + '\n' : '') + AX[k]" @commit="(v) => gen.setVal(path + '[' + k + ']', v == null ? 0 : v)" />
    </div>
    <span class="gn-u">{{ unit }}</span>
  </div>
</template>

<style scoped>
.gn-v { display: flex; align-items: center; gap: 5px; min-width: 0; min-height: var(--h-ctl); grid-column: 1 / -1; }
.gn-v > label { flex: none; width: var(--gn-lab, 58px); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: var(--fs-3); }
.gn-v3 { flex: 1 1 auto; min-width: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3px; }
.gn-v3 > input { width: 100%; min-width: 0; }
.gn-u { flex: none; width: var(--gn-u, 22px); color: var(--text-faint); font-size: var(--fs-2); }
</style>
