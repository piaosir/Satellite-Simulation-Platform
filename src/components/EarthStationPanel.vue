<script setup>
// 地球站配置面板（GEO / NGSO / 再生式链路预算共用）：一份配置 = 一种站型的收发射频参数。
// 顶部为「主参数」条：收发共用字段（side:'common'，如天线口径——口径收发一致，效率按收发频段分设）
// 外加各链路标了 hero 的关键指标（如功放功率预设）——这几项最能定性一份站型，故加重排在最前。
// （标签后曾缀「收发共用 / 发射链」归属小标 + 右侧一句说明小字，用户嫌碎已删：归属看下方两栏即可。）
// 下方「发射参数 / 接收参数」两栏分列余下字段——对应一座站的上行发射链（天线效率/回退/馈线/UPC）
// 与下行接收链（天线效率/噪温/馈线）。字段集由各模块 params.js 的 ES_COMMON_FIELDS / ES_TX_FIELDS /
// ES_RX_FIELDS 提供（三模块字段略有差异；频率/极化与干扰项均在卫星侧，不在本库），
// 本组件只按字段声明通用渲染，不掺业务逻辑。
import { computed } from 'vue'

const props = defineProps({
  form: { type: Object, required: true },      // 该份配置的表单（公共/发/收字段合在一个对象里，key 与引擎入参一致）
  txFields: { type: Array, required: true },   // 发射链字段声明
  rxFields: { type: Array, required: true },   // 接收链字段声明
  commonFields: { type: Array, default: () => [] }    // 收发共用字段声明（如天线口径）
})

// showIf 条件显隐（字段声明可挂条件函数，如按模式显隐工作点）；访问 form 值自动建立响应追踪
const vis = (fields) => fields.filter((f) => !f.showIf || f.showIf(props.form))
// hero 字段（如功放功率）保持原 side 声明不变（引擎组装/迁移一律按 side 走），仅渲染位置提到顶部条
const sections = computed(() => [
  { key: 'tx', title: '发射参数', sub: '发信站引用', main: vis(props.txFields).filter((f) => !f.hero) },
  { key: 'rx', title: '接收参数', sub: '收信站引用', main: vis(props.rxFields).filter((f) => !f.hero) }
])
const heroVis = computed(() => [
  ...vis(props.commonFields),
  ...vis(props.txFields).filter((f) => f.hero),
  ...vis(props.rxFields).filter((f) => f.hero)
])
</script>

<template>
  <div class="es-box">
    <div v-if="heroVis.length" class="es-common">
      <label v-for="f in heroVis" :key="f.key" class="es-f es-f-big" :title="f.tip || ''">
        <span class="es-l">{{ f.label }}</span>
        <span class="es-ibox">
          <select v-if="f.type === 'select'" v-model="form[f.key]" class="es-i">
            <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
          </select>
          <input v-else v-model="form[f.key]" class="es-i mono" :placeholder="f.def" />
          <i v-if="f.unit" class="es-u">{{ f.unit }}</i>
        </span>
      </label>
    </div>
    <div class="es">
      <template v-for="(s, si) in sections" :key="s.key">
        <div v-if="si" class="es-div"></div>
        <section class="es-side">
          <div class="es-hd">
            <svg viewBox="0 0 20 20" class="es-arrow">
              <template v-if="s.key === 'tx'"><line x1="10" y1="17" x2="10" y2="4" /><path d="M5.5,8.5 L10,4 L14.5,8.5" /></template>
              <template v-else><line x1="10" y1="3" x2="10" y2="16" /><path d="M5.5,11.5 L10,16 L14.5,11.5" /></template>
            </svg>
            <span class="es-hd-t">{{ s.title }}</span>
            <span class="es-hd-s">{{ s.sub }}</span>
          </div>
          <div class="es-grid">
            <label v-for="f in s.main" :key="f.key" class="es-f" :title="f.tip || ''">
              <span class="es-l">{{ f.label }}<i v-if="f.unit"> ({{ f.unit }})</i></span>
              <select v-if="f.type === 'select'" v-model="form[f.key]" class="es-i">
                <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
              </select>
              <input v-else v-model="form[f.key]" class="es-i mono" :placeholder="f.def" />
            </label>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 主参数条：一份配置的定性指标（口径 + 功放功率预设）——加重排在最前，一眼可读可改 */
.es-common { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 6px 18px; margin-bottom: 12px; padding-bottom: 11px; border-bottom: 1px dashed var(--border); }
.es-f-big { flex: 0 0 auto; gap: 4px; }
.es-f-big .es-l { font-size: 11px; font-weight: 600; color: var(--text); letter-spacing: .3px; }
/* 输入 + 单位后缀：单位挪出标签贴在框右侧，读数区留给数字本身 */
.es-ibox { display: flex; align-items: baseline; gap: 6px; }
.es-f-big .es-i { font-size: 17px; font-weight: 600; line-height: 1.25; padding: 3px 9px; width: 118px; text-align: right; letter-spacing: .5px; }
.es-f-big select.es-i { text-align: left; }
.es-u { font-size: 11px; color: var(--text-muted); font-style: normal; }
.es { display: flex; gap: 14px; align-items: stretch; flex-wrap: wrap; }   /* 窄容器（库主从视图右栏）下发/收两栏自动上下堆叠 */
.es-side { flex: 1; min-width: 280px; }
.es-div { width: 1px; flex: none; background: var(--border); }
.es-hd { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.es-arrow { width: 13px; height: 13px; flex: none; fill: none; stroke: var(--text-muted); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.es-hd-t { font-size: 12px; font-weight: 700; color: var(--text); letter-spacing: .5px; }
.es-hd-s { font-size: 11px; color: var(--text-faint); }
.es-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 10px; }
.es-f { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.es-l { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.es-l i { color: var(--text-faint); font-style: normal; }
.es-i { font: inherit; font-size: 12px; padding: 4px 7px; width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.es-i:focus { outline: none; border-color: var(--accent); }
.es-i.mono { font-family: var(--font-mono); }
</style>
