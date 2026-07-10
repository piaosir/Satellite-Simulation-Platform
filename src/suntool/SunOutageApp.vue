<script setup>
// 日凌预报（GEO）独立窗口。计算在主进程（core.calculateSunOutage，v5 物理恶化门限判据），
// 本组件只负责参数采集与结果展示；导出 Word / ICS 走 sunoutage:* IPC。
import { ref, shallowRef, reactive, computed, watch } from 'vue'
import { SAT_PRESETS } from '../linkbudget/satPresets.js'
import Icon from '../components/Icon.vue'

const api = typeof window !== 'undefined' && window.api ? window.api.sunOutage : null
const cityApi = typeof window !== 'undefined' && window.api ? window.api.linkBudget : null

// 频段参数（镜像 packages/core/utils/sunOutageCalculator.js 的 BAND_PARAMS，改动需两处同步）：
// freq = 典型下行频率 GHz（日凌影响接收链路）；sysTemp = 典型系统噪温 K（仅作未填时的兜底，
// T_sys 是用户站的属性——精确计算应填实测值或由 G/T 反推）。太阳亮温 v5.1 起由引擎按 F10.7 推算。
const BANDS = [
  { key: 'C', label: 'C', freq: 3.95, sysTemp: 65 },
  { key: 'Ku', label: 'Ku', freq: 12.5, sysTemp: 150 },
  { key: 'ExtKu', label: 'Ku扩展', freq: 11.75, sysTemp: 145 },
  { key: 'Ka', label: 'Ka', freq: 19.45, sysTemp: 270 },
  { key: 'Q', label: 'Q', freq: 40.0, sysTemp: 450 }
]
const bandOf = (k) => BANDS.find((b) => b.key === k) || BANDS[1]

const nowYear = new Date().getFullYear()

const form = reactive({
  stationName: '北京',
  lat: '39.9042', lon: '116.4074',
  satName: 'CHINASAT 6C', satLon: '130.5',
  band: 'Ku', freq: '12.5', diameter: '2.4',
  degThreshold: '1', sysTemp: '', solarTemp: '',
  year: String(nowYear), season: 'vernal'
})

// T_sun 默认值预览（镜像引擎 solarTempAt 的口径：F10.7=120 周期均值、太阳视直径 0.533°、
// (2.8/f)^1.8 谱外推、光球层 6000K floor——改动需与 sunOutageCalculator.js 同步）。
// 仅用于 placeholder 展示；实际计算恒在引擎内按当日太阳视直径逐日推算。
const defaultTsun = computed(() => {
  const f = num(form.freq)
  if (!(f > 0)) return null
  const omega = Math.PI / 4 * Math.pow(0.533 * Math.PI / 180, 2)
  const lam = 0.299792458 / 2.8
  const t28 = 120 * 1e-22 * lam * lam / (2 * 1.380649e-23 * omega)
  return Math.round(6000 + (t28 - 6000) * Math.pow(2.8 / f, 1.8))
})

// 频段切换 → 频率跟随该频段典型下行值（可再手改）；Tsys/Tsun 留空则用频段默认（placeholder 提示）
watch(() => form.band, (k) => { form.freq = String(bandOf(k).freq) })

// —— 城市快选（复用链路预算的城市库：中文名/省份/拼音首字母检索）——
const cityKw = ref('')
const cityList = ref([])
const cityOpen = ref(false)
let cityTimer = null
watch(cityKw, (kw) => {
  if (cityTimer) clearTimeout(cityTimer)
  cityTimer = setTimeout(async () => {
    if (!cityApi) return
    try { cityList.value = (await cityApi.searchCities(kw)).slice(0, 12); cityOpen.value = true } catch { /* ignore */ }
  }, 160)
})
function pickCity(c) {
  form.stationName = c.name
  form.lat = String(c.lat)
  form.lon = String(c.lon)
  cityKw.value = ''
  cityOpen.value = false
}

// —— 卫星预设 ——
const satPreset = ref('')
function pickSat() {
  const p = SAT_PRESETS.find((s) => s.name === satPreset.value)
  if (p) { form.satName = p.name; form.satLon = p.position }
}

// —— 判据快选 ——
const DEG_PRESETS = ['0.5', '1', '3']

// —— 计算 ——
const result = shallowRef(null)   // 主进程返回的普通对象（不深代理，导出 IPC 结构化克隆安全）
const computing = ref(false)
const error = ref('')
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN }

async function compute() {
  error.value = ''
  if (!api) { error.value = '引擎需在 Electron 中运行（npm run dev）'; return }
  const lat = num(form.lat), lon = num(form.lon), satLon = num(form.satLon)
  const dia = num(form.diameter), freq = num(form.freq), degTh = num(form.degThreshold)
  const year = parseInt(form.year, 10)
  if (!(lat >= -90 && lat <= 90)) { error.value = '纬度需在 -90 ~ 90 之间'; return }
  if (!(lon >= -180 && lon <= 180)) { error.value = '经度需在 -180 ~ 180 之间'; return }
  if (!(satLon >= -180 && satLon <= 180)) { error.value = '轨位需在 -180 ~ 180 之间'; return }
  if (!(dia > 0)) { error.value = '天线口径需大于 0'; return }
  if (!(degTh > 0)) { error.value = '恶化门限需大于 0 dB'; return }
  if (!(year >= 1900 && year <= 2200)) { error.value = '年份需在 1900 ~ 2200 之间'; return }
  computing.value = true
  try {
    const r = await api.compute({
      lat, lon, satLon, diameter: dia,
      year, season: form.season, band: form.band,
      customFreq: freq > 0 ? freq : undefined,
      degThreshold: degTh,
      sysTemp: form.sysTemp !== '' && num(form.sysTemp) > 0 ? num(form.sysTemp) : undefined,
      solarTemp: form.solarTemp !== '' && num(form.solarTemp) > 0 ? num(form.solarTemp) : undefined
    })
    if (r && r.error) { error.value = r.message || '计算失败'; result.value = null }
    else result.value = r
  } catch (e) {
    error.value = String(e && e.message ? e.message : e)
  } finally {
    computing.value = false
  }
}

// —— 时标与导出 ——
const tz = ref('local')   // 'local'（按地球站经度推算时区）| 'utc'
const isLocal = computed(() => tz.value === 'local')
// 地球站本地时区：按经度推算整点偏移 round(经度/15)h（随站点位置变化，非本机时区）
const staOffsetMin = computed(() => {
  const lon = num(form.lon)
  return isFinite(lon) ? Math.round(lon / 15) * 60 : 0
})
const localTz = computed(() => {
  const h = staOffsetMin.value / 60
  return h === 0 ? 'UTC' : 'UTC' + (h > 0 ? '+' : '−') + Math.abs(h)
})
const status = ref('')

const seasonCN = computed(() => (form.season === 'vernal' ? '春分' : '秋分'))
function exportPayload() {
  return {
    result: result.value,
    station: { name: form.stationName || '地球站', lat: num(form.lat), lon: num(form.lon) },
    satellite: { name: form.satName || '', lon: num(form.satLon) },
    tz: tz.value
  }
}
async function exportWord() {
  if (!result.value || !api) return
  status.value = ''
  const p = exportPayload()
  p.defaultName = `日凌预报_${form.satName || form.satLon + 'E'}_${form.stationName || '站'}_${form.year}${seasonCN.value}.docx`
  const r = await api.exportWord(p)
  status.value = r.ok ? `已导出：${r.filePath}` : (r.canceled ? '' : `导出失败：${r.error}`)
}
async function exportIcs() {
  if (!result.value || !api) return
  status.value = ''
  const p = exportPayload()
  p.defaultName = `日凌预报_${form.satName || form.satLon + 'E'}_${form.stationName || '站'}_${form.year}${seasonCN.value}.ics`
  const r = await api.exportIcs(p)
  status.value = r.ok ? `已导出 ${r.count} 条日历事件：${r.filePath}` : (r.canceled ? '' : `导出失败：${r.error}`)
}

// —— 展示辅助 ——
const days = computed(() => (result.value && result.value.dailyResults) || [])
const model = computed(() => (result.value && result.value.model) || {})
// 本地时刻：把引擎的 UTC 日期+时刻组成瞬间，按地球站整点时区平移（自动含跨日）
function shiftParts(dateUTC, hmsUTC, offMin) {
  const d = new Date(`${dateUTC}T${hmsUTC}Z`)
  if (isNaN(d.getTime())) return { date: dateUTC, time: hmsUTC }
  d.setTime(d.getTime() + offMin * 60000)
  const p = (n) => String(n).padStart(2, '0')
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  }
}
const dDate = (d) => (isLocal.value ? shiftParts(d.date, d.startTimeUTC, staOffsetMin.value).date : d.date)
const dStart = (d) => (isLocal.value ? shiftParts(d.date, d.startTimeUTC, staOffsetMin.value).time : d.startTimeUTC)
const dPeak = (d) => (isLocal.value ? shiftParts(d.date, d.peakTimeUTC, staOffsetMin.value).time : d.peakTimeUTC)
const dEnd = (d) => (isLocal.value ? shiftParts(d.date, d.endTimeUTC, staOffsetMin.value).time : d.endTimeUTC)
</script>

<template>
  <div class="shell" @click="cityOpen = false">
    <header class="topbar">
      <span class="brand">日凌预报 · GEO</span>
      <span class="grow"></span>
      <span class="tzsel" :title="`逐日表与 Word 报告的时标（本地=按地球站经度推算 ${localTz}，随站点位置变化；ICS 日历恒用 UTC，导入后由日历软件自动换算本地时间）`">
        <button class="tzbtn" :class="{ on: isLocal }" @click="tz = 'local'">本地</button>
        <button class="tzbtn" :class="{ on: !isLocal }" @click="tz = 'utc'">UTC</button>
      </span>
      <button class="act" :disabled="!result || !days.length" @click="exportWord">导出 Word</button>
      <button class="act" :disabled="!result || !days.length" @click="exportIcs" title="RFC 5545 iCalendar，Outlook / Google / Apple 日历直接导入，含提前 1 天与 30 分钟提醒">导出 ICS 日历</button>
    </header>

    <div class="body">
      <aside class="panel">
        <div class="sec">
          <div class="title">地球站</div>
          <label class="row"><span>站名</span><input v-model="form.stationName" placeholder="站名 / 地名" /></label>
          <label class="row cityrow" @click.stop>
            <span>城市快选</span>
            <input v-model="cityKw" placeholder="名称 / 省份 / 拼音首字母" @focus="cityKw && (cityOpen = true)" />
            <div v-if="cityOpen && cityList.length" class="citydrop">
              <div v-for="c in cityList" :key="c.name" class="cityitem" @click="pickCity(c)">
                <span>{{ c.name }}</span><b>{{ c.lat.toFixed(2) }}, {{ c.lon.toFixed(2) }}</b>
              </div>
            </div>
          </label>
          <label class="row"><span>纬度 °N</span><input v-model="form.lat" inputmode="decimal" /></label>
          <label class="row"><span>经度 °E</span><input v-model="form.lon" inputmode="decimal" /></label>
        </div>

        <div class="sec">
          <div class="title">卫星（GEO）</div>
          <label class="row"><span>预设</span>
            <select v-model="satPreset" @change="pickSat">
              <option value="">— 选择预设 —</option>
              <option v-for="s in SAT_PRESETS" :key="s.name + s.position" :value="s.name">{{ s.name }} · {{ s.position }}°E</option>
            </select>
          </label>
          <label class="row"><span>名称</span><input v-model="form.satName" /></label>
          <label class="row"><span>轨位 °E</span><input v-model="form.satLon" inputmode="decimal" /></label>
        </div>

        <div class="sec">
          <div class="title">接收链路</div>
          <label class="row"><span>频段</span>
            <select v-model="form.band"><option v-for="b in BANDS" :key="b.key" :value="b.key">{{ b.label }}</option></select>
          </label>
          <label class="row"><span>频率 GHz</span><input v-model="form.freq" inputmode="decimal" /></label>
          <label class="row"><span>口径 m</span><input v-model="form.diameter" inputmode="decimal" /></label>
        </div>

        <div class="sec">
          <div class="title">时间</div>
          <label class="row"><span>年份</span><input v-model="form.year" inputmode="numeric" /></label>
          <div class="row"><span>分点</span>
            <span class="chips">
              <button class="chip" :class="{ on: form.season === 'vernal' }" @click="form.season = 'vernal'">春分</button>
              <button class="chip" :class="{ on: form.season === 'autumnal' }" @click="form.season = 'autumnal'">秋分</button>
            </span>
          </div>
        </div>

        <div class="sec">
          <div class="title">判据与噪温</div>
          <div class="row"><span>恶化门限</span>
            <span class="chips">
              <button v-for="p in DEG_PRESETS" :key="p" class="chip" :class="{ on: form.degThreshold === p }" @click="form.degThreshold = p">{{ p }} dB</button>
            </span>
          </div>
          <label class="row"><span>自定义 dB</span><input v-model="form.degThreshold" inputmode="decimal" /></label>
          <label class="row" title="天线系统噪声温度（晴空）：天线噪温 + LNA/LNB 噪温，折算到 LNA 输入端——即 G/T 里的 T。它决定日凌恶化深度，知道本站实测值就填，不知道用默认典型值。">
            <span>T_sys K</span><input v-model="form.sysTemp" :placeholder="`默认 ${bandOf(form.band).sysTemp}（典型值）`" inputmode="decimal" />
          </label>
          <label class="row" title="太阳射电亮温：太阳作为射电源在工作频率上的等效温度。默认值按频率由太阳射电流量模型自动推算（随太阳活动强弱有波动），一般无需修改。">
            <span>T_sun K</span><input v-model="form.solarTemp" :placeholder="defaultTsun ? `默认 ${defaultTsun}（按频率推算）` : '按频率自动推算'" inputmode="decimal" />
          </label>
          <div class="hint">T_sys＝接收天线系统噪声温度；T_sun＝太阳射电亮温。</div>
        </div>

        <div class="sec">
          <button class="calc" :disabled="computing" @click="compute">{{ computing ? '计算中…' : '计算日凌' }}</button>
          <div v-if="error" class="err">{{ error }}</div>
        </div>
      </aside>

      <main class="content">
        <template v-if="result && days.length">
          <div class="cards">
            <div class="card"><i>分点（{{ result.seasonName }}）</i><b class="mono">{{ result.equinoxDate }}</b></div>
            <div class="card"><i>日凌区间（UTC 日期）</i><b class="mono">{{ result.startDate }} ~ {{ result.endDate }} · {{ result.totalDays }} 天</b></div>
            <div class="card"><i>单日最长</i><b class="mono">{{ result.maxDurationStr }}</b></div>
            <div class="card"><i>主轴对准恶化上限</i><b class="mono">{{ model.boresightDeg }} dB</b></div>
            <div class="card"><i>3dB 波束宽（70λ/D）</i><b class="mono">{{ model.beamWidth3dB }}°</b></div>
            <div class="card"><i>门限角（分点日）</i><b class="mono">{{ result.thresholdAngle }}°</b></div>
            <div class="card"><i>卫星指向</i><b class="mono">Az {{ result.satAz }}° · El {{ result.satEl }}°</b></div>
            <div class="card"><i>判据 / 噪温</i><b class="mono">≥{{ model.degThreshold }} dB · T<sub>sys</sub> {{ model.sysTemp }}K</b></div>
            <div class="card"><i>太阳亮温 T<sub>sun</sub></i><b class="mono">{{ model.solarTemp }}K（{{ model.solarTempSource === 'manual' ? '手动' : '默认推算' }}）</b></div>
          </div>

          <table class="tbl">
            <thead>
              <tr>
                <th class="c">#</th><th>日期（{{ isLocal ? '本地 ' + localTz : 'UTC' }}）</th>
                <th class="r">开始</th><th class="r">峰值</th><th class="r">结束</th>
                <th class="r">时长</th><th class="r">峰值恶化 dB</th><th class="c">强度</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(d, i) in days" :key="d.date" :class="{ peak: d.isPeak }">
                <td class="c mono">{{ i + 1 }}</td>
                <td class="mono">{{ dDate(d) }}<span v-if="d.isPeak" class="star" title="最长日"> <Icon name="star" :size="10" /></span></td>
                <td class="r mono">{{ dStart(d) }}</td>
                <td class="r mono strong">{{ dPeak(d) }}</td>
                <td class="r mono">{{ dEnd(d) }}</td>
                <td class="r mono">{{ d.durationStr }}</td>
                <td class="r mono">{{ d.peakCNdeg }}</td>
                <td class="c"><span class="badge" :class="d.intensityClass">{{ d.intensity }}</span></td>
              </tr>
            </tbody>
          </table>

          <div class="foot">
            模型：太阳视位置 VSOP87+章动（≈1″）· 太阳均匀盘 × 高斯主瓣<b>精确卷积</b> → ΔT(θ)，D(θ)=10lg(1+ΔT/T<sub>sys</sub>)。
            T<sub>sun</sub> 默认值由太阳射电流量（F10.7=120 周期均值）按频率外推，太阳活动峰年实际值可高 ~30%；
            填入本站实测 T<sub>sys</sub> 时峰值恶化不确定度约 ±1dB，起止时刻对噪温仅对数敏感（±数十秒）。ICS 日历事件恒用 UTC 时刻。
          </div>
        </template>

        <template v-else-if="result && !days.length">
          <div class="empty">
            <p>本季无满足判据的日凌事件。</p>
            <p class="dim">主轴对准恶化上限 {{ model.boresightDeg }} dB，低于门限 {{ model.degThreshold }} dB —— 可降低门限或核对 T_sys / 口径。</p>
          </div>
        </template>

        <template v-else>
          <div class="empty">
            <p>输入地球站与卫星参数，点击「计算日凌」。</p>
            <p class="dim">输出分点前后 ±30 天内逐日的日凌起止/峰值时刻与 C/N 恶化，可导出交付级 Word 报告与 ICS 值班日历。</p>
          </div>
        </template>

        <div v-if="status" class="status">{{ status }}</div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100vh; }
.topbar { display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 14px; background: var(--surface); border-bottom: 1px solid var(--border); flex: none; }
.brand { font-family: var(--font-serif); font-size: 15px; letter-spacing: .4px; }
.grow { flex: 1; }
.tzsel { display: inline-flex; border: 1px solid var(--border); border-radius: 2px; overflow: hidden; }
.tzbtn { border: 0; background: var(--bg); color: var(--text-muted); padding: 3px 10px; cursor: pointer; font-size: 12px; }
.tzbtn.on { background: var(--accent); color: var(--bg); font-weight: 600; }
.act { border: 1px solid var(--border); background: var(--bg); color: var(--text-muted); padding: 3px 12px; cursor: pointer; border-radius: 2px; font-size: 12.5px; }
.act:hover:not(:disabled) { color: var(--text); border-color: var(--accent); }
.act:disabled { opacity: .45; cursor: default; }

.body { display: flex; flex: 1; min-height: 0; }
.panel { width: 292px; flex: none; overflow-y: auto; background: var(--surface); border-right: 1px solid var(--border); }
.sec { padding: 10px 14px; border-bottom: 1px solid var(--border); }
.title { font-family: var(--font-serif); font-size: 13px; color: var(--text); margin-bottom: 8px; }
.row { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 12px; color: var(--text-muted); position: relative; }
.row > span:first-child { width: 74px; flex: none; }
.row input, .row select { flex: 1; min-width: 0; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 3px 7px; font-size: 12.5px; border-radius: 2px; }
.row input:focus, .row select:focus { outline: none; border-color: var(--accent); }
.chips { display: flex; gap: 5px; flex: 1; }
.chip { flex: 1; border: 1px solid var(--border); background: var(--bg); color: var(--text-muted); padding: 3px 0; cursor: pointer; border-radius: 2px; font-size: 12px; }
.chip:hover { border-color: var(--accent); color: var(--text); }
.chip.on { background: var(--accent); color: var(--bg); border-color: var(--accent); font-weight: 600; }
.hint { font-size: 11px; color: var(--text-faint); line-height: 1.6; margin-top: 6px; }
.calc { width: 100%; border: 1px solid var(--accent); background: var(--accent); color: var(--bg); padding: 7px 0; cursor: pointer; border-radius: 2px; font-size: 13px; font-weight: 600; }
.calc:disabled { opacity: .6; cursor: default; }
.err { margin-top: 8px; color: var(--danger); font-size: 12px; line-height: 1.5; }

.cityrow { z-index: 5; }
.citydrop { position: absolute; top: calc(100% + 3px); left: 82px; right: 0; z-index: 50; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: 0 6px 18px rgba(0,0,0,.18); max-height: 260px; overflow-y: auto; }
.cityitem { display: flex; justify-content: space-between; gap: 8px; padding: 5px 9px; cursor: pointer; font-size: 12px; color: var(--text-muted); }
.cityitem:hover { background: var(--bg); color: var(--text); }
.cityitem b { font-family: var(--font-mono); font-weight: 400; color: var(--text-faint); }

.content { flex: 1; min-width: 0; overflow-y: auto; padding: 16px 20px; position: relative; }
.cards { display: grid; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap: 8px; margin-bottom: 14px; }
.card { border: 1px solid var(--border); background: var(--surface); padding: 8px 11px; border-radius: 2px; display: flex; flex-direction: column; gap: 4px; }
.card i { font-style: normal; font-size: 11px; color: var(--text-faint); }
.card b { font-weight: 600; font-size: 13px; color: var(--text); }

.tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.tbl th { text-align: left; color: var(--text-muted); font-weight: 500; border-top: 2px solid var(--border-strong); border-bottom: 1px solid var(--border-strong); padding: 6px 9px; white-space: nowrap; }
.tbl td { padding: 5px 9px; border-bottom: 1px solid var(--border); }
.tbl tr:last-child td { border-bottom: 2px solid var(--border-strong); }
.tbl .r { text-align: right; }
.tbl .c { text-align: center; }
.tbl .strong { font-weight: 600; }
.tbl tr.peak td { background: var(--surface-2); }
.star { color: var(--warn); }
.badge { display: inline-block; min-width: 30px; text-align: center; padding: 1px 7px; border-radius: 2px; font-size: 11.5px; border: 1px solid var(--border); }
.so-intensity-high { color: var(--danger); border-color: var(--danger); }
.so-intensity-mid { color: var(--warn); border-color: var(--warn); }
.so-intensity-low { color: var(--ok); border-color: var(--ok); }

.foot { margin-top: 12px; font-size: 11px; color: var(--text-faint); line-height: 1.7; max-width: 860px; }
.empty { padding: 60px 20px; text-align: center; color: var(--text-muted); }
.empty .dim { color: var(--text-faint); font-size: 12px; margin-top: 8px; line-height: 1.7; }
.status { position: sticky; bottom: 0; margin-top: 10px; padding: 7px 11px; background: var(--surface); border: 1px solid var(--border); font-size: 12px; color: var(--text); border-radius: 2px; }
</style>
