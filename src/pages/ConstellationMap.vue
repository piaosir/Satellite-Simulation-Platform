<script setup>
import { reactive, ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import pageDef from '../viz/constellation/page.js'
import { makeWx, runPage } from '../compat/wx.js'
import { parseOMMCsv } from '../viz/constellation/tle.js'
import Icon from '../components/Icon.vue'

const root = ref(null)
const canvas = ref(null)
const track = ref(null)
const fileInput = ref(null)
const d = reactive(JSON.parse(JSON.stringify(pageDef.data)))
const apiOk = typeof window !== 'undefined' && !!(window.api && window.api.omm)

let inst = null
const call = (name, ev) => { if (inst && typeof inst[name] === 'function') inst[name](ev) }

function retry() { inst && inst._loadGroup && inst._loadGroup(d.groupIndex) }
function pickFile() { fileInput.value && fileInput.value.click() }
function onFile(e) {
  const f = e.target.files && e.target.files[0]
  if (!f) return
  const reader = new FileReader()
  reader.onload = () => {
    const text = String(reader.result || '')
    const sats = parseOMMCsv(text)
    if (sats.length && inst) {
      inst._ingest({ group: 'import', fetchedAt: new Date().toISOString(), count: sats.length, sats })
    } else {
      d.statusText = '文件解析失败：请用 CelesTrak「FORMAT=csv」的 OMM 文件'
    }
  }
  reader.readAsText(f)
  e.target.value = ''
}

// ---- 指针拖拽（旋转地球 / 拖时间轴），监听挂到 document 以便移出元素仍连续 ----
function dragify(startEv, onMove, onUp) {
  const move = (e) => onMove(e)
  const up = (e) => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); onUp && onUp(e) }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}

// 鼠标视口坐标 -> 画布局部坐标（_hitTest / _screen 用的就是画布内坐标，
// 画布上方有工具栏、左侧有导航栏，必须扣掉画布的偏移，否则点击命中永远对不上）。
function localXY(e) {
  const r = canvas.value.getBoundingClientRect()
  return { clientX: e.clientX - r.left, clientY: e.clientY - r.top }
}
function canvasDown(e) {
  call('onTouchStart', { touches: [localXY(e)] })
  dragify(e,
    (ev) => call('onTouchMove', { touches: [localXY(ev)] }),
    (ev) => call('onTouchEnd', { changedTouches: [localXY(ev)], touches: [] }))
}
function canvasWheel(e) { e.preventDefault(); call('onWheel', { detail: { deltaY: e.deltaY } }) }

function trackDown(e) {
  call('onTrackTouch', { touches: [{ clientX: e.clientX }] })
  dragify(e,
    (ev) => call('onTrackTouch', { touches: [{ clientX: ev.clientX }] }),
    (ev) => call('onTrackEnd', { changedTouches: [{ clientX: ev.clientX }] }))
}

onMounted(async () => {
  const c = canvas.value
  // 小程序里 canvas.node 自带 requestAnimationFrame；浏览器 canvas 没有，补上。
  c.requestAnimationFrame = (cb) => window.requestAnimationFrame(cb)
  c.cancelAnimationFrame = (id) => window.cancelAnimationFrame(id)
  window.wx = makeWx({ canvasEl: c, getRoot: () => root.value })

  inst = runPage(pageDef, d)
  inst.onLoad && inst.onLoad()
  await nextTick()
  inst.onReady && inst.onReady()
})

onBeforeUnmount(() => { inst && inst.onUnload && inst.onUnload() })
</script>

<template>
  <div class="cm" ref="root">
    <div class="ctrl">
      <div class="row">
        <select class="grp" :value="d.groupIndex" @change="e => call('onGroupChange', { detail: { value: Number(e.target.value) } })">
          <option v-for="(g, i) in d.groups" :key="g.key" :value="i">{{ g.label }}</option>
        </select>
        <div class="search">
          <input :value="d.keyword" placeholder="搜索卫星名 / 编号"
                 @input="e => call('onSearchInput', { detail: { value: e.target.value } })" />
          <span v-if="d.keyword" class="clr" @click="call('clearSearch')"><Icon name="x" :size="11" /></span>
        </div>
      </div>

      <div class="row tl">
        <div class="tb-track" ref="track" @mousedown="trackDown">
          <div class="tb-bar"><div class="tb-fill" :style="{ width: d.timePct + '%' }"></div></div>
          <div class="tb-knob" :style="{ left: d.timePct + '%' }"></div>
        </div>
        <span class="tb-time">{{ d.liveRefresh ? '实时' : d.timeLabel }}</span>
      </div>

      <div class="steps">
        <span class="step" :class="{ dis: d.liveRefresh }" @click="call('stepTime', { currentTarget: { dataset: { d: '-60' } } })">−1h</span>
        <span class="step" :class="{ dis: d.liveRefresh }" @click="call('stepTime', { currentTarget: { dataset: { d: '-10' } } })">−10m</span>
        <span class="step" :class="{ dis: d.liveRefresh }" @click="call('stepTime', { currentTarget: { dataset: { d: '-1' } } })">−1m</span>
        <span class="now" :class="{ dis: d.liveRefresh || !d.timeOffset }" @click="call('resetTime')">此刻</span>
        <span class="step" :class="{ dis: d.liveRefresh }" @click="call('stepTime', { currentTarget: { dataset: { d: '1' } } })">+1m</span>
        <span class="step" :class="{ dis: d.liveRefresh }" @click="call('stepTime', { currentTarget: { dataset: { d: '10' } } })">+10m</span>
        <span class="step" :class="{ dis: d.liveRefresh }" @click="call('stepTime', { currentTarget: { dataset: { d: '60' } } })">+1h</span>
      </div>

      <div class="beam">
        <template v-if="d.selected">
          <span class="bl">波束角</span>
          <input class="bi" :value="d.beam" :placeholder="d.beamAuto || '自动'"
                 @input="e => call('onBeamInput', { detail: { value: e.target.value } })" />
          <span class="bu">°</span>
          <span class="lock" :class="{ on: d.beamLock }" @click="call('toggleBeamLock')"><Icon :name="d.beamLock ? 'lock' : 'lock-open'" :size="12" /></span>
        </template>
        <span v-else class="hint">点击卫星设置波束角</span>
        <div class="toggles">
          <span class="mini" :class="{ on: d.autoRotate }" @click="call('toggleRotate')">{{ d.autoRotate ? '旋转中' : '旋转停' }}</span>
          <span class="mini" :class="{ on: d.liveRefresh }" @click="call('toggleRefresh')">{{ d.liveRefresh ? '实时开' : '实时关' }}</span>
        </div>
      </div>

      <div v-if="d.searchResults.length" class="panel">
        <div v-for="item in d.searchResults" :key="item.noradId" class="item"
             @click="call('onPickResult', { currentTarget: { dataset: { norad: item.noradId, group: item.group } } })">
          <div class="nm">{{ item.name }}</div>
          <div class="sub">{{ item.groupLabel }} · NORAD {{ item.noradId }}<span v-if="item.slot"> · {{ item.slot }}</span></div>
        </div>
      </div>
    </div>

    <div class="globe-wrap">
      <canvas ref="canvas" class="globe-canvas"
              @mousedown="canvasDown" @wheel="canvasWheel"></canvas>

      <div v-if="d.satCount === 0" class="dl-banner">
        <div class="dl-msg">{{ d.statusText || '尚无卫星数据' }}</div>
        <div class="dl-row">
          <button @click="retry">重试下载</button>
          <button @click="pickFile">导入 TLE 文件(CSV)</button>
        </div>
        <div class="dl-diag">桥接 window.api：<b :class="apiOk ? 'ok' : 'bad'">{{ apiOk ? '正常' : '缺失（preload 未生效）' }}</b></div>
        <div class="dl-tip">国内若连不上 celestrak.org：浏览器打开
          <code>celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=csv</code>
          另存为 .csv 后点「导入」。</div>
        <input ref="fileInput" type="file" accept=".csv,.txt" style="display:none" @change="onFile" />
      </div>
      <div class="meta">
        <span v-if="d.loading">{{ d.statusText }}</span>
        <template v-else>
          <span>在轨 {{ d.satCount }}</span>
          <span>OMM {{ d.dataTime }}</span>
          <span v-if="d.statusText" class="warn">{{ d.statusText }}</span>
        </template>
      </div>
      <div class="ghint">点击星点查看 · 拖动旋转 · 滚轮缩放</div>
    </div>

    <div v-if="d.selected" class="card">
      <div class="ch">
        <span class="cn">{{ d.selected.name }}</span>
        <span v-if="d.selected.slot" class="cs">{{ d.selected.slot }}</span>
        <span class="cx" @click="call('closeCard')"><Icon name="x" :size="12" /></span>
      </div>
      <div class="cg">
        <div class="kv"><span class="k">NORAD</span><span class="v">{{ d.selected.noradId }}</span></div>
        <div class="kv"><span class="k">高度</span><span class="v">{{ d.selected.alt }} km</span></div>
        <div class="kv"><span class="k">倾角</span><span class="v">{{ d.selected.incl }}°</span></div>
        <div class="kv"><span class="k">偏心率</span><span class="v">{{ d.selected.ecc }}</span></div>
        <div class="kv"><span class="k">惯性速度</span><span class="v">{{ d.selected.speedAbs }} km/s</span></div>
        <div class="kv"><span class="k">对地速度</span><span class="v">{{ d.selected.speedRel }} km/s</span></div>
        <div class="kv"><span class="k">周期</span><span class="v">{{ d.selected.period }} min</span></div>
        <div class="kv"><span class="k">近/远地点</span><span class="v">{{ d.selected.perigee }}/{{ d.selected.apogee }}</span></div>
        <div class="kv"><span class="k">Ω</span><span class="v">{{ d.selected.raan }}°</span></div>
        <div class="kv"><span class="k">ω</span><span class="v">{{ d.selected.argp }}°</span></div>
        <div class="kv wide"><span class="k">星下点</span><span class="v">{{ d.selected.lat }}, {{ d.selected.lon }}</span></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cm { display: flex; flex-direction: column; height: 100%; position: relative; }
.ctrl { padding: 8px 14px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; align-items: center; gap: 12px; }
.grp { border: 1px solid var(--border); background: var(--bg); padding: 4px 8px; }
.search { flex: 1; max-width: 280px; position: relative; }
.search input { width: 100%; border: 1px solid var(--border); background: var(--bg); padding: 4px 24px 4px 8px; outline: none; }
.clr { position: absolute; right: 5px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; justify-content: center; width: 16px; height: 16px; font-size: 11px; line-height: 1; cursor: pointer; color: var(--text-faint); }
.clr:hover { color: var(--text); }
.tl { gap: 14px; }
.tb-track { flex: 1; height: 24px; position: relative; cursor: pointer; display: flex; align-items: center; }
.tb-bar { width: 100%; height: 3px; background: var(--border-strong); position: relative; }
.tb-fill { height: 100%; background: var(--accent); }
.tb-knob { position: absolute; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); transform: translateX(-50%); }
.tb-time { font-family: var(--font-mono); font-size: 12px; color: var(--text-muted); min-width: 120px; text-align: right; }
.steps { display: flex; gap: 6px; font-size: 11.5px; }
.steps span { padding: 2px 8px; border: 1px solid var(--border); cursor: pointer; color: var(--text-muted); }
.steps .dis { opacity: 0.4; pointer-events: none; }
.beam { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.bi { width: 60px; border: 0; border-bottom: 1px solid var(--border-strong); background: transparent; outline: none; }
.lock { cursor: pointer; }
.hint { color: var(--text-faint); }
.toggles { margin-left: auto; display: flex; gap: 8px; }
.mini { padding: 3px 10px; border: 1px solid var(--border); cursor: pointer; color: var(--text-muted); }
.mini.on { color: var(--text); border-color: var(--accent); }
.panel { max-height: 220px; overflow: auto; border: 1px solid var(--border); }
.item { padding: 6px 10px; border-bottom: 1px solid var(--border); cursor: pointer; }
.item:hover { background: var(--surface); }
.nm { font-size: 12.5px; }
.sub { font-size: 11px; color: var(--text-faint); }
.globe-wrap { flex: 1; min-height: 0; position: relative; background: #0b0b10; }
.dl-banner { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 420px; max-width: 86%; background: rgba(20,22,28,0.94); border: 1px solid #34384a; border-radius: 6px; padding: 16px 18px; color: #d7dde6; text-align: center; }
.dl-msg { font-size: 13px; margin-bottom: 12px; color: #f0c674; line-height: 1.5; }
.dl-row { display: flex; gap: 10px; justify-content: center; margin-bottom: 10px; }
.dl-row button { border: 1px solid #4a5168; background: #1c2230; color: #d7dde6; padding: 6px 14px; cursor: pointer; border-radius: 4px; font-size: 12.5px; }
.dl-row button:hover { border-color: #6b7490; }
.dl-diag { font-size: 11.5px; color: #9aa3b2; margin-bottom: 8px; }
.dl-diag .ok { color: #6cc28a; }
.dl-diag .bad { color: #e26a6a; }
.dl-tip { font-size: 11px; color: #79839a; line-height: 1.6; }
.dl-tip code { font-family: var(--font-mono); color: #9fb4d0; word-break: break-all; }
.globe-canvas { width: 100%; height: 100%; display: block; }
.meta { position: absolute; left: 12px; bottom: 28px; display: flex; gap: 12px; font-size: 11.5px; color: #cfd8e0; }
.meta .warn { color: #e2b84b; }
.ghint { position: absolute; right: 12px; bottom: 10px; font-size: 11px; color: #6b7686; }
.card { position: absolute; right: 14px; top: 130px; width: 240px; background: var(--bg); border: 1px solid var(--border-strong); padding: 10px 12px; }
.ch { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cn { font-family: var(--font-serif); font-size: 14px; }
.cs { font-size: 11px; color: var(--text-muted); }
.cx { margin-left: auto; cursor: pointer; color: var(--text-faint); display: inline-flex; align-items: center; }
.cg { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 12px; font-size: 11.5px; }
.kv { display: flex; justify-content: space-between; gap: 6px; }
.kv.wide { grid-column: 1 / 3; }
.kv .k { color: var(--text-muted); }
.kv .v { font-family: var(--font-mono); }
</style>
