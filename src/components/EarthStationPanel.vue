<script setup>
// 地球站配置面板（GEO / NGSO / 再生式链路预算共用）：一份配置 = 一种站型的收发射频参数。
// 顶部为「公共参数」条（收发共用同一面天线的量，如天线口径——口径收发一致，效率按收发频段分设），
// 下方「发射参数 / 接收参数」两栏分列——对应一座站的上行发射链（天线效率/功放/馈线/UPC/工作点）与
// 下行接收链（天线效率/噪温/馈线）。字段集由各模块 params.js 的 ES_COMMON_FIELDS / ES_TX_FIELDS /
// ES_RX_FIELDS 提供（三模块字段略有差异，如再生式含干扰项 intf:true 子区与工作点 showIf 条件显隐），
// 本组件只按字段声明通用渲染，不掺业务逻辑。
import { computed } from 'vue'

const props = defineProps({
  form: { type: Object, required: true },      // 该份配置的表单（公共/发/收字段合在一个对象里，key 与引擎入参一致）
  txFields: { type: Array, required: true },   // 发射链字段声明
  rxFields: { type: Array, required: true },   // 接收链字段声明
  commonFields: { type: Array, default: () => [] }   // 收发共用字段声明（如天线口径）
})

// showIf 条件显隐（如再生式工作点：设置功放→显功放功率、设置余量→显系统余量）；访问 form 值自动建立响应追踪
const vis = (fields) => fields.filter((f) => !f.showIf || f.showIf(props.form))
const sections = computed(() => [
  { key: 'tx', title: '发射参数', sub: '发信站引用', main: vis(props.txFields).filter((f) => !f.intf), intf: vis(props.txFields).filter((f) => f.intf) },
  { key: 'rx', title: '接收参数', sub: '收信站引用', main: vis(props.rxFields).filter((f) => !f.intf), intf: vis(props.rxFields).filter((f) => f.intf) }
])
const commonVis = computed(() => vis(props.commonFields))
</script>

<template>
  <div class="es-box">
    <div v-if="commonVis.length" class="es-common">
      <label v-for="f in commonVis" :key="f.key" class="es-f" :title="f.tip || ''">
        <span class="es-l">{{ f.label }}<i v-if="f.unit"> ({{ f.unit }})</i></span>
        <select v-if="f.type === 'select'" v-model="form[f.key]" class="es-i">
          <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
        </select>
        <input v-else v-model="form[f.key]" class="es-i mono" :placeholder="f.def" />
      </label>
      <span class="es-common-note">收发共用同一面天线：口径一致，效率/馈线等按收发链分设</span>
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
          <div v-if="s.intf.length" class="es-intf">
            <span class="es-intf-t">干扰项</span>
            <div class="es-grid">
              <label v-for="f in s.intf" :key="f.key" class="es-f" :title="f.tip || ''">
                <span class="es-l">{{ f.label }}<i v-if="f.unit"> ({{ f.unit }})</i></span>
                <input v-model="form[f.key]" class="es-i mono" :placeholder="f.def" />
              </label>
            </div>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.es-common { display: grid; grid-template-columns: 1fr 1fr 2fr; gap: 8px 10px; align-items: end; margin-bottom: 10px; padding-bottom: 9px; border-bottom: 1px dashed var(--border); }
.es-common-note { grid-column: -2 / -1; font-size: 11px; color: var(--text-faint); line-height: 1.5; padding-bottom: 3px; }
.es { display: flex; gap: 14px; align-items: stretch; }
.es-side { flex: 1; min-width: 0; }
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
.es-intf { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--border); }
.es-intf-t { display: block; font-size: 11px; color: var(--text-faint); margin-bottom: 6px; }
</style>
