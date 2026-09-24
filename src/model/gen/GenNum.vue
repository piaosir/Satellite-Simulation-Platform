<script setup>
// 生成页的一格数字字段：标签 + 数字框 + 单位。值、描红、出处 title 都按 spec 路径从生成页上下文（provide 'gen'）取，
// 各节只写路径与标签，不重复那一套逻辑。
import { computed, inject } from 'vue'
import NumIn from '../NumIn.vue'

const props = defineProps({
  path: { type: String, required: true },
  label: { type: String, required: true },
  unit: { type: String, default: '' },
  integer: { type: Boolean, default: false },
  allowEmpty: { type: Boolean, default: false },   // 允许留空 = null（「自动」）
  min: { type: Number, default: -Infinity },
  max: { type: Number, default: Infinity },
  tip: { type: String, default: '' },               // 字段口径（出处之前）
  placeholder: { type: String, default: '' }
})
const gen = inject('gen')
const bad = computed(() => gen.bad(props.path))
const title = computed(() => [props.tip, gen.tip(props.path)].filter(Boolean).join('\n'))
// 没写出来的字段显示生成器缺省值作占位（灰字）：看得到实际按多少生成
const ph = computed(() => { if (props.placeholder) return props.placeholder; const d = gen.def(props.path); return d == null ? '' : String(+d.toPrecision(6)) })
</script>

<template>
  <div class="gn-f">
    <label :class="{ 'md-red': bad }" :title="title || null">{{ label }}</label>
    <NumIn :model-value="gen.val(path)" :min="min" :max="max" :integer="integer" :allow-empty="allowEmpty" :bad="bad" :title="title"
           :placeholder="ph" :sig="6" @commit="(v) => gen.setVal(path, v)" />
    <span class="gn-u">{{ unit }}</span>
  </div>
</template>

<style scoped>
.gn-f { display: flex; align-items: center; gap: 5px; min-width: 0; min-height: var(--h-ctl); }
.gn-f > label { flex: none; width: var(--gn-lab, 58px); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: var(--fs-3); }
.gn-f > input { flex: 1 1 auto; min-width: 0; width: 0; }
.gn-u { flex: none; width: var(--gn-u, 22px); color: var(--text-faint); font-size: var(--fs-2); white-space: nowrap; }
</style>
