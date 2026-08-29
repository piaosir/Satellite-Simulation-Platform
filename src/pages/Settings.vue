<script setup>
import { reactive, ref, onMounted } from 'vue'
import { theme, setTheme } from '../stores/theme'
import { getLang, setLang } from '../shared/i18n/runtime'

const langCur = ref(getLang())
function pickLang(v) { setLang(v); langCur.value = v }

const hasApi = typeof window !== 'undefined' && !!window.api
const form = reactive({ amapKey: '', units: 'metric', noiseRatioMode: 'ebno' })
const saved = ref(false)

// ★「地图视角」不在这里 —— 它已挪到星座地图页的侧栏「地图设置 → 地图视角」，与底图放在一起。
//   落盘仍是 settings 的 mapPov 一项（stores/mapPov 的 saveMapPov 读改写回），故这里保存时
//   必须把 s.mapPov 原样带上，不能用 form 覆盖掉整份设置。
async function load() {
  if (!hasApi) return
  const s = await window.api.store.getSettings()
  Object.assign(form, { amapKey: s.amapKey || '', units: s.units || 'metric', noiseRatioMode: s.noiseRatioMode || 'ebno' })
}
async function save() {
  if (!hasApi) return
  const s = (await window.api.store.getSettings()) || {}
  await window.api.store.setSettings({ ...s, ...form })
  saved.value = true
  setTimeout(() => (saved.value = false), 1500)
}
onMounted(load)
</script>

<template>
  <div class="set">
    <h2>设置</h2>
    <div class="row">
      <label>外观</label>
      <select :value="theme.mode" @change="setTheme($event.target.value)">
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </div>
    <div class="row">
      <label>语言</label>
      <select data-i18n-skip :value="langCur" @change="pickLang($event.target.value)">
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>
    </div>
    <div v-if="!hasApi" class="empty">需在桌面客户端中运行。</div>
    <template v-else>
      <div class="row">
        <label>高德地图 key</label>
        <input v-model="form.amapKey" placeholder="覆盖图所需，仅本地保存" />
      </div>
      <div class="row">
        <label>单位制</label>
        <select v-model="form.units"><option value="metric">公制</option><option value="imperial">英制</option></select>
      </div>
      <div class="row">
        <label>噪声比模式</label>
        <select v-model="form.noiseRatioMode"><option value="ebno">Eb/N₀</option><option value="esno">Es/N₀</option></select>
      </div>
      <div class="row">
        <label></label>
        <button @click="save">保存</button>
        <span v-if="saved" class="ok">已保存</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.set { padding: 20px 24px; max-width: 560px; height: 100%; overflow-y: auto; }   /* 外层 .content 已 overflow:hidden，滚动由页内承担 */
.set h2 { font-size: var(--fs-6); margin-bottom: 16px; }
.row { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.row label { width: 110px; color: var(--text-muted); font-size: var(--fs-4); }
.row input, .row select { border: 1px solid var(--field-border); background-color: var(--field-bg); padding: 5px 8px; outline: none; min-width: 240px; }
.row button { border: 1px solid var(--border); background: var(--bg); height: var(--h-ctl-lg); white-space: nowrap; padding: 0 16px; cursor: pointer; }
.ok { color: var(--ok); font-size: var(--fs-3); }
.empty { color: var(--text-faint); }
.hint { color: var(--text-faint); font-size: var(--fs-3); margin-top: 18px; }
</style>
