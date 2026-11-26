<script setup>
import { computed, ref } from 'vue'
const props = defineProps({ line: Object, display: Object, shells: Array })
const elevation = computed(() => props.line.kind === 'elevation')
const title = computed(() => elevation.value ? '仰角线' : '波束角线')
const angleTip = computed(() => elevation.value ? '从观测端当地水平面量起' : '圆锥两侧边缘之间的夹角')
const patterns = [['solid', '实线', ''], ['dash', '虚线', '7 5'], ['dot', '点线', '1 4'], ['dashdot', '点划线', '9 4 2 4']]
const labelMode = computed({
  get: () => props.line.labels ? (props.line.labelMode || 'cardinal') : 'none',
  set(mode) {
    props.line.labels = mode !== 'none'
    if (props.line.labels) props.line.labelMode = mode
  }
})
const angleError = ref(false)
const positionFields = [['lon', '经度', -180, 180, '°E'], ['lat', '纬度', -90, 90, '°N'], ['altKm', '卫星高度', 0, undefined, 'km']]
function setPosition(field, input) {
  if (input.checkValidity() && (field !== 'altKm' || input.valueAsNumber > 0)) props.line.position[field] = input.valueAsNumber
  input.value = props.line.position[field]
}
function changeAngle(input) {
  const n = input.valueAsNumber
  angleError.value = !input.checkValidity() || (elevation.value ? Math.abs(n) >= 90 : n <= 0)
  if (!angleError.value) props.line.angle = n
}
</script>

<template>
    <div class="angle-fields">
      <label>名称<input class="ci angle-caption" v-model.trim.lazy="line.name" :placeholder="title" /></label>
      <template v-if="line.position">
        <label v-for="[field, label, min, max, unit] in positionFields" :key="field">{{ label }}
          <span class="angle-value"><input class="ci" type="number" step="any" required :min="min" :max="max" :value="line.position[field]"
            @change="setPosition(field, $event.target)" />{{ unit }}</span>
        </label>
      </template>
      <label>{{ elevation ? '仰角' : '波束全角' }}<span class="angle-value"><input type="number" class="ci" step="any" :min="elevation && shells ? -90 : 0" :max="elevation ? 90 : 180" required :value="line.angle" :aria-invalid="angleError"
         :title="angleTip" @input="angleError = false" @change="changeAngle($event.target)" /> °</span></label>
      <span v-if="angleError" role="alert" class="angle-error">{{ !elevation ? '全角须大于 0° 且不超过 180°' : (shells ? '仰角须在 −90° 与 90° 之间' : '仰角须大于等于 0° 且小于 90°') }}</span>
      <template v-if="elevation && shells">
        <label>观测方向<select v-model="line.observer" title="观测端当地水平面垂直于地心径向"><option value="shell">壳层看卫星</option><option value="satellite">卫星看壳层</option></select></label>
        <label>投影壳层<select :value="line.shellIds ? 'some' : 'all'" @change="line.shellIds = $event.target.value === 'all' ? null : shells.filter(sh => sh.show).map(sh => sh.id)">
          <option value="all">全部可见壳层</option><option value="some">指定壳层</option>
        </select></label>
        <div v-if="line.shellIds" class="angle-shells">
          <label v-for="sh in shells" :key="sh.id"><input type="checkbox" :value="sh.id" v-model="line.shellIds" />
            <i :style="{ background: sh.color }"></i>{{ sh.name || sh.altKm + ' km' }}<small v-if="sh.name">{{ sh.altKm }} km</small></label>
        </div>
        <label>交点<select v-model="line.branch"><option value="inherit">跟随壳层设置</option><option value="both">近侧与远侧</option><option value="near">近侧</option><option value="far">远侧</option></select></label>
      </template>
      <div class="angle-style-group">
        <div class="angle-pair">
          <label>线型<select v-model="line.dash"><option v-for="[value, label] in patterns" :key="value" :value="value">{{ label }}</option></select></label>
          <input type="color" v-model="line.color" aria-label="线色" title="线色" />
        </div>
        <label class="angle-slider"><span>线宽</span><input type="range" min="0.1" max="10" step="0.1" v-model.number="line.width" /><output>{{ line.width.toFixed(1) }} px</output></label>
        <label class="angle-slider"><span>不透明度</span><input type="range" min="0" max="1" step="0.01" v-model.number="line.opacity" /><output>{{ Math.round(line.opacity * 100) }}%</output></label>
      </div>
      <div class="angle-style-group">
        <div class="angle-pair">
          <label>角度标注<select v-model="labelMode" title="可在图上沿线拖动标注"><option value="cardinal">四方位标注</option><option value="single">单点标注</option><option value="none">隐藏</option></select></label>
          <input v-if="line.labels" type="color" v-model="line.labelColor" aria-label="标注颜色" title="标注颜色" />
        </div>
        <template v-if="line.labels">
          <label class="angle-slider"><span>字号</span><input type="range" min="1" max="100" step="0.1" v-model.number="line.labelSize" /><output>{{ line.labelSize.toFixed(1) }}</output></label>
          <label class="angle-check"><input type="checkbox" v-model="line.labelBold" />标注粗体</label>
        </template>
      </div>
      <label v-if="!elevation" class="angle-check angle-ray" title="与覆盖分析的全局显示选项同步"><input type="checkbox" v-model="display.showRay" />显示天线视轴</label>
    </div>
</template>

<style scoped>
.angle-fields label, .angle-value { display: flex; align-items: center; gap: 6px; min-width: 0; }
.angle-fields output { font-variant-numeric: tabular-nums; }
.angle-fields {
  --angle-label-width: 4.4em;
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 12px 16px;
  border: none;
  border-radius: var(--r-box);
  background: var(--surface);
}
.angle-fields > label, .angle-pair > label {
  display: grid;
  grid-template-columns: var(--angle-label-width) minmax(0, 1fr);
  column-gap: 6px;
}
.angle-fields select, .angle-caption, .angle-value input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 24px;
}
.angle-value { display: grid; grid-template-columns: minmax(0, 1fr) 2em; gap: 4px; }
.angle-value input { text-align: right; font-variant-numeric: tabular-nums; }
.angle-error { color: var(--danger); }
.angle-style-group { display: grid; gap: 6px; padding-top: 7px; border-top: 1px solid var(--border); }
.angle-pair { display: flex; align-items: center; gap: 6px; }
.angle-pair > label { flex: 1; }
.angle-fields input[type=color] { box-sizing: border-box; width: 25px; height: 23px; padding: 1px; flex: none; cursor: pointer; }
.angle-fields .angle-slider { display: flex; }
.angle-slider > span:first-child { flex: 0 0 var(--angle-label-width); }
.angle-slider > input { flex: 1; width: 0; min-width: 0; margin: 0; }
.angle-slider output { flex: none; text-align: right; white-space: nowrap; }
.angle-fields .angle-check { display: flex; gap: 6px; cursor: pointer; }
.angle-check input, .angle-shells input { margin: 0; }
.angle-ray { border-top: 1px solid var(--border); padding-top: 7px; }
.angle-shells { display: grid; gap: 5px; max-height: 116px; overflow: auto; }
.angle-shells i { width: 6px; height: 6px; border-radius: 50%; }
.angle-shells small { margin-left: auto; white-space: nowrap; }
</style>
