<script setup>
// 通用字段栅格（端到端窗口的资源库编辑器与检查器共用）：按字段声明渲染「标签 … 数值」读数行。
// 类名沿用 sp-f / sp-l / sp-i —— lbworkbench.css 的检查器密排规则按这几个类写死（定高行 +
// 行间发丝线 + 无框数值，hover/focus 才浮出边框），套上即与三窗的资源库面板同一套版式。
const props = defineProps({
  fields: { type: Array, required: true },
  form: { type: Object, required: true },
  // 覆盖模式：值为空即「跟随库条目」，占位符显示库里的值（行内可覆盖，见 §4.3）
  base: { type: Object, default: null },
  // 只读字段（值由别处确定，如选星后的轨道高度/倾角）：单位位置改显「自动」，输入框锁死
  readonlyKeys: { type: Array, default: () => [] }
})
const ph = (f) => (props.base && props.base[f.key] != null ? String(props.base[f.key]) : '')
const ro = (f) => props.readonlyKeys.includes(f.key)
</script>

<template>
  <div class="sp-fields">
    <label v-for="f in fields" :key="f.key" class="sp-f" :title="f.tip || f.label">
      <span class="sp-l">{{ f.label }}<i v-if="f.unit || ro(f)"> ({{ ro(f) ? '自动' : f.unit }})</i></span>
      <select v-if="f.type === 'select'" v-model="form[f.key]" class="sp-i">
        <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
      </select>
      <input v-else v-model="form[f.key]" class="sp-i" :class="{ auto: ro(f) }" :readonly="ro(f)" :placeholder="ph(f)" :inputmode="f.type === 'num' ? 'decimal' : undefined" />
    </label>
  </div>
</template>

<style scoped>
.sp-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 2px 20px; }
.sp-f { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 21px; }
.sp-l { font-size: var(--fs-3); color: var(--text-muted); flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-l i { font-style: normal; color: var(--text-faint); }
.sp-i {
  width: 112px; flex: none; text-align: right; font: inherit; font-size: var(--fs-3); padding: 2px 4px;
  color: var(--text); background-color: transparent; border: 1px solid transparent; border-radius: var(--r-ctl, 2px);
}
select.sp-i { text-align: left; }
.sp-i:hover { background-color: var(--field-bg); border-color: var(--field-border-hover); }
.sp-i:focus { outline: none; background-color: var(--field-bg); border-color: var(--accent-ui); }
.sp-i::placeholder { color: var(--text-faint); }
.sp-i.auto { color: var(--text-muted); cursor: not-allowed; }
</style>
