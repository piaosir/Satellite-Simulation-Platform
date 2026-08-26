<script setup>
import { reactive, ref, computed, onMounted } from 'vue'
import { theme, setTheme } from '../stores/theme'
import { getLang, setLang } from '../shared/i18n/runtime'
import { POV_META, CUSTOM_POV, MAP_POV_DEF, normMapPov, povTableOf } from '../viz/geo/povList.js'
import { CUSTOMIZABLE_DISPUTES, OWNER_ZH } from '../viz/geo/frozen.js'
import { setMapPov } from '../stores/mapPov.js'

const langCur = ref(getLang())
function pickLang(v) { setLang(v); langCur.value = v }

const hasApi = typeof window !== 'undefined' && !!window.api
const form = reactive({ amapKey: '', units: 'metric', noiseRatioMode: 'ebno' })
// 地图视角：全局唯一入口（★ 不进 ConstellationMap3D 的 viewPrefs 快照 —— 两处都存会打架）。
// overrides 的键是争议区【分组键】，值是归属；layers 是三类附加线的总开关。
const pov = reactive(JSON.parse(JSON.stringify(MAP_POV_DEF)))
const saved = ref(false)

// 当前视角声明了南海十段线才允许开关它（没声明就没这条线可开）
const claimAvail = computed(() => {
  const p = povTableOf(pov.id)
  return !!(p && p.lines && Array.isArray(p.lines.claim) && p.lines.claim.length)
})
const ownerLabel = (v) => OWNER_ZH[v] || v

// 改一下就立刻作用到地图（stores/mapPov 广播 → 解算器重算 → 两个渲染器整份重建），落盘仍走「保存」。
// ★ 只碰这个轻量状态源，绝不 import povResolver —— 那会把 3.8 MB 底图与整套渲染器并进设置页的包。
function applyPov() { setMapPov(JSON.parse(JSON.stringify(pov))) }
function setPovId(v) { pov.id = v; applyPov() }
function setDispute(k, v) { if (v) pov.overrides[k] = v; else delete pov.overrides[k]; applyPov() }
function toggleLayer(k) { pov.layers[k] = !pov.layers[k]; applyPov() }

async function load() {
  if (!hasApi) return
  const s = await window.api.store.getSettings()
  Object.assign(form, { amapKey: s.amapKey || '', units: s.units || 'metric', noiseRatioMode: s.noiseRatioMode || 'ebno' })
  const p = normMapPov(s.mapPov)
  pov.id = p.id; pov.layers = p.layers
  for (const k of Object.keys(pov.overrides)) delete pov.overrides[k]
  Object.assign(pov.overrides, p.overrides)
}
async function save() {
  if (!hasApi) return
  await window.api.store.setSettings({ ...form, mapPov: JSON.parse(JSON.stringify(pov)) })
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
        <label>地图视角</label>
        <select :value="pov.id" title="底图的国界、陆地着色、点选与国名全部按该视角的归属表解算；「自定义」以中国视角为底再逐项覆写。台湾、香港、澳门恒属中国，不随视角变" @change="setPovId($event.target.value)">
          <option v-for="p in POV_META" :key="p.id" :value="p.id">{{ p.zh }}</option>
        </select>
      </div>
      <template v-if="pov.id === CUSTOM_POV">
        <div v-for="g in CUSTOMIZABLE_DISPUTES" :key="g.key" class="row sub">
          <label>{{ g.zh }}</label>
          <select :value="pov.overrides[g.key] || ''" :title="g.en" @change="setDispute(g.key, $event.target.value)">
            <option value="">跟随底图默认</option>
            <option v-for="o in g.opts" :key="o" :value="o">{{ ownerLabel(o) }}</option>
            <option value="none">不显示</option>
          </select>
        </div>
      </template>
      <div class="row">
        <label>附加线图层</label>
        <span class="chks">
          <label class="ck" :class="{ dis: !claimAvail }" title="海上主张线；当前视角未声明主张线时不可用"><input type="checkbox" :disabled="!claimAvail" :checked="pov.layers.claim" @change="toggleLayer('claim')" /><span>南海十段线</span></label>
          <label class="ck" title="实际控制线（Line of control）"><input type="checkbox" :checked="pov.layers.loc" @change="toggleLayer('loc')" /><span>停火线</span></label>
          <label class="ck" title="任一侧归属为「争议」的边界，以及底图自带的未定界线"><input type="checkbox" :checked="pov.layers.indefinite" @change="toggleLayer('indefinite')" /><span>未定界虚线</span></label>
        </span>
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
.set h2 { font-size: 18px; margin-bottom: 16px; }
.row { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.row label { width: 110px; color: var(--text-muted); font-size: 12.5px; }
.row input, .row select { border: 1px solid var(--border); background-color: var(--bg); padding: 5px 8px; outline: none; min-width: 240px; }
.row button { border: 1px solid var(--border); background: var(--bg); padding: 5px 16px; cursor: pointer; }
.row.sub { margin-bottom: 8px; }
.row.sub label { padding-left: 12px; width: 98px; }
.chks { display: flex; flex-wrap: wrap; gap: 4px 16px; }
.ck { display: inline-flex; align-items: center; gap: 6px; width: auto; color: var(--text); font-size: 12.5px; cursor: pointer; }
.ck.dis { color: var(--text-faint); cursor: default; }
.ck input { min-width: 0; }
.ok { color: var(--ok); font-size: 12px; }
.empty { color: var(--text-faint); }
.hint { color: var(--text-faint); font-size: 11.5px; margin-top: 18px; }
</style>
