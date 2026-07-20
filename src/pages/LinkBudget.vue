<script setup>
import { reactive, ref, computed, onMounted, watch } from 'vue'
import { logMsg } from '../stores/log'

const hasApi = typeof window !== 'undefined' && !!window.api

const form = reactive({
  satelliteName: 'DEMO-1',
  frequencyBand: 'Ku',
  infoRate: '2048',
  modulation: 'QPSK',
  fec: '3/4',
  antennaDiameter: '7.3',
  latitude: '39.9042',
  longitude: '116.4074',
  rainRate: '42',
  rxEIRP: '46',
  G_Ts: '2',
  ebno: '5',
  margin: '3'
})

const data = ref(null)
const error = ref('')
const computing = ref(false)

async function compute() {
  if (!hasApi) {
    error.value = '引擎需在桌面客户端中运行'
    return
  }
  computing.value = true
  const satParams = {
    satelliteName: form.satelliteName,
    frequencyBand: form.frequencyBand
  }
  const linkParams = {
    infoRate: form.infoRate,
    modulation: form.modulation,
    fec: form.fec,
    antennaDiameter: form.antennaDiameter,
    latitude: form.latitude,
    longitude: form.longitude,
    rainRate: form.rainRate,
    rxEIRP: form.rxEIRP,
    G_Ts: form.G_Ts,
    ebno: form.ebno,
    margin: form.margin
  }
  try {
    const r = await window.api.computeLink(satParams, linkParams)
    if (r && r.success) {
      data.value = r.data
      error.value = ''
    } else {
      error.value = (r && r.message) || '计算失败'
    }
  } catch (e) {
    error.value = String(e)
  } finally {
    computing.value = false
  }
}

function num(key, d = 2) {
  const v = data.value && data.value[key]
  if (v === undefined || v === null || v === '-') return '--'
  const n = parseFloat(v)
  return isNaN(n) ? v : n.toFixed(d)
}

const margin = computed(() => num('linkmargin', 2))
const marginOk = computed(() => {
  const n = parseFloat(margin.value)
  return !isNaN(n) && n >= 0
})

const waterfall = [
  { label: '上行站 EIRP', key: 'stationEIRPResult', unit: 'dBW' },
  { label: '上行自由空间损耗', key: 'uplinkFSLResult', unit: 'dB' },
  { label: '上行雨衰 (P.618)', key: 'uplinkRainAttenuation', unit: 'dB' },
  { label: '上行 C/N', key: 'uplinkCN', unit: 'dB' },
  { label: '卫星下行 EIRP', key: 'EIRPsResult', unit: 'dBW' },
  { label: '下行自由空间损耗', key: 'downlinkFSLResult', unit: 'dB' },
  { label: '接收 G/T', key: 'satelliteGTResult', unit: 'dB/K' },
  { label: '下行 C/N', key: 'downlinkCN', unit: 'dB' }
]

const toastMsg = ref('')
let toastT
function toast(m) {
  toastMsg.value = m
  logMsg(`链路预算：${m}`)
  clearTimeout(toastT)
  toastT = setTimeout(() => (toastMsg.value = ''), 2800)
}

async function saveHistory() {
  if (!hasApi || !data.value) return
  await window.api.store.addHistory({
    satelliteName: form.satelliteName,
    frequencyBand: form.frequencyBand,
    cnTotal: data.value.carrierTotalCN,
    margin: data.value.linkmargin,
    params: { ...form },
    results: data.value
  })
  toast('已保存到历史')
}

async function exportReport(format) {
  if (!hasApi || !data.value) return
  const r = await window.api.report.export({
    format,
    results: data.value,
    params: { satelliteName: form.satelliteName, frequencyBand: form.frequencyBand },
    meta: { title: '卫星链路预算报告' }
  })
  if (r && r.ok) toast('已导出：' + r.filePath)
}

let timer
watch(form, () => {
  clearTimeout(timer)
  timer = setTimeout(compute, 200)
})
onMounted(compute)
</script>

<template>
  <div class="lb">
    <section class="params">
      <h2>上行链路参数</h2>
      <p class="sub">GEO · 透明转发 · {{ form.frequencyBand }} 频段</p>

      <div class="grid">
        <label><span>频段</span>
          <select v-model="form.frequencyBand">
            <option>C</option><option>Ku</option><option>Ka</option><option>ExtC</option>
          </select>
        </label>
        <label><span>信息速率</span><input class="mono" v-model="form.infoRate" /><i>kbps</i></label>
        <label><span>调制方式</span>
          <select v-model="form.modulation">
            <option>BPSK</option><option>QPSK</option><option>8PSK</option><option>16APSK</option>
          </select>
        </label>
        <label><span>FEC 码率</span><input class="mono" v-model="form.fec" /></label>
        <label><span>天线口径</span><input class="mono" v-model="form.antennaDiameter" /><i>m</i></label>
        <label><span>站点纬度</span><input class="mono" v-model="form.latitude" /><i>°</i></label>
        <label><span>站点经度</span><input class="mono" v-model="form.longitude" /><i>°</i></label>
        <label><span>降雨率</span><input class="mono" v-model="form.rainRate" /><i>mm/h</i></label>
        <label><span>下行 EIRP</span><input class="mono" v-model="form.rxEIRP" /><i>dBW</i></label>
        <label><span>卫星 G/T</span><input class="mono" v-model="form.G_Ts" /><i>dB/K</i></label>
        <label><span>门限 Eb/N₀</span><input class="mono" v-model="form.ebno" /><i>dB</i></label>
        <label><span>链路余量</span><input class="mono" v-model="form.margin" /><i>dB</i></label>
      </div>

      <h2 class="wf-title">链路余量瀑布</h2>
      <table class="wf">
        <tr v-for="row in waterfall" :key="row.key">
          <td>{{ row.label }}</td>
          <td class="mono val">{{ num(row.key) }}</td>
          <td class="unit">{{ row.unit }}</td>
        </tr>
      </table>
    </section>

    <aside class="preview">
      <div class="pv-label">实时 C/N 预览</div>
      <div class="pv-big">
        <span class="mono">{{ num('carrierTotalCN') }}</span><em>dB</em>
      </div>
      <div class="pv-sub">合成载噪比 (C/N)<sub>total</sub></div>

      <div class="pv-rows">
        <div><span>上行 C/N</span><b class="mono">{{ num('uplinkCN') }}</b></div>
        <div><span>下行 C/N</span><b class="mono">{{ num('downlinkCN') }}</b></div>
        <div><span>门限 C/N</span><b class="mono">{{ num('thresholdCN') }}</b></div>
        <div class="sep"><span>链路余量</span>
          <b class="mono" :style="{ color: marginOk ? 'var(--ok)' : 'var(--danger)' }">
            {{ marginOk ? '+' : '' }}{{ margin }}
          </b>
        </div>
      </div>

      <div class="pv-state" :class="{ bad: !marginOk && data }">
        <template v-if="error">{{ error }}</template>
        <template v-else-if="computing">计算中…</template>
        <template v-else-if="data">{{ marginOk ? '链路闭合，余量充足' : '余量不足，链路未闭合' }}</template>
        <template v-else>等待计算</template>
      </div>

      <div class="pv-actions">
        <button @click="saveHistory" :disabled="!data">保存到历史</button>
        <button @click="exportReport('word')" :disabled="!data">导出 Word</button>
        <button @click="exportReport('excel')" :disabled="!data">导出 Excel</button>
      </div>
      <div v-if="toastMsg" class="pv-toast">{{ toastMsg }}</div>
    </aside>
  </div>
</template>

<style scoped>
.lb { display: flex; height: 100%; }
.params { flex: 1; min-width: 0; padding: 16px 22px; border-right: 1px solid var(--border); overflow: auto; }
.params h2 { font-size: 15px; }
.sub { margin: 2px 0 16px; font-size: 11.5px; color: var(--text-faint); }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 26px; }
.grid label { display: flex; align-items: baseline; gap: 9px; font-size: 12.5px; }
.grid label > span { width: 78px; color: var(--text-muted); flex: none; }
.grid input {
  flex: 1; min-width: 0; border: 0; border-bottom: 1px solid var(--border-strong);
  background: transparent; padding: 2px 0; outline: none;
}
.grid input:focus { border-bottom-color: var(--accent); }
.grid select {
  flex: 1; border: 1px solid var(--border); background: var(--bg);
  padding: 2px 4px; border-radius: 0; outline: none;
}
.grid label > i { color: var(--text-faint); font-style: normal; width: 34px; }
.wf-title { font-size: 15px; margin-top: 22px; }
.wf { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
.wf td { padding: 4px 0; border-top: 1px solid var(--border); }
.wf .val { text-align: right; }
.wf .unit { text-align: right; width: 46px; color: var(--text-faint); }
.preview { width: 210px; flex: none; padding: 16px 16px; background: var(--surface); }
.pv-label { font-size: 11.5px; color: var(--text-faint); letter-spacing: .5px; }
.pv-big { display: flex; align-items: baseline; gap: 6px; margin: 8px 0 2px; }
.pv-big .mono { font-size: 32px; font-weight: 500; }
.pv-big em { font-style: normal; font-size: 13px; color: var(--text-muted); }
.pv-sub { font-size: 11.5px; color: var(--text-muted); margin-bottom: 16px; }
.pv-rows { display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
.pv-rows > div { display: flex; justify-content: space-between; }
.pv-rows > div > span { color: var(--text-muted); }
.pv-rows .sep { border-top: 1px solid var(--border); padding-top: 8px; margin-top: 2px; }
.pv-state {
  margin-top: 18px; padding: 8px 10px; border: 1px solid var(--border);
  font-size: 11.5px; color: var(--text-muted); line-height: 1.5;
}
.pv-state.bad { color: var(--danger); border-color: var(--danger); }
.pv-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
.pv-actions button { border: 1px solid var(--border-strong); background: var(--bg); padding: 6px 10px; cursor: pointer; font-size: 12px; }
.pv-actions button:hover:not(:disabled) { background: var(--bg); border-color: var(--accent); }
.pv-actions button:disabled { color: var(--text-faint); cursor: default; }
.pv-toast { margin-top: 10px; font-size: 11px; color: var(--ok); word-break: break-all; }
</style>
