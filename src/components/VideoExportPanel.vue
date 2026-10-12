<script setup>
// 视频导出面板：地图右侧的停靠栏（与「卫星信息栏」同一种右侧栏），开着时地图上画取景框与叠加信息预览。
// 版面按出片的先后：时间 → 节奏 → 画面 → 叠加信息 → 输出，底下一颗「开始导出」。
// 导出进行中改由整窗进度卡接管（Teleport 到 body，盖住菜单与地图：逐帧渲染期间地图画布按出片尺寸画、不能动）。
// ★ 文案一律经 vx.T(中, 英)（面板根打 data-i18n-skip，不走 DOM 呈现层词典）；说明性的话只进 title。
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { RES_PRESETS, FPS_LIST, fmtClock, fmtBytes, fmtSpeed, fmtSimSec } from '../shared/video/videoPlan.js'
import { parseDur, numTxt, fmtLocalInput, parseLocalInput } from '../shared/tlPeriod.js'
import { tzTag } from '../shared/tz.js'
import { fmtStamp, SAT_SECS } from '../viz/video/hud.js'
import { GEO_STEPS } from '../viz/geo/geoFrame.js'

const props = defineProps({ vx: { type: Object, required: true } })
const vx = props.vx
const S = vx.S
const T = vx.T

const POS = computed(() => [
  ['tl', T('左上', 'Top left')], ['tc', T('上中', 'Top center')], ['tr', T('右上', 'Top right')],
  ['bl', T('左下', 'Bottom left')], ['bc', T('下中', 'Bottom center')], ['br', T('右下', 'Bottom right')]
])
const RES_LABEL = computed(() => ({
  '720p': '1280 × 720', '1080p': '1920 × 1080', '1440p': '2560 × 1440', '2160p': '3840 × 2160 (4K)',
  square: '1080 × 1080 ' + T('方形', 'Square'), portrait: '1080 × 1920 ' + T('竖屏', 'Portrait')
}))

// —— 时间 ——
const tz = computed(() => vx.tzMode())
const rng = computed(() => vx.range.value)
const startTxt = computed(() => fmtLocalInput(rng.value.startMs, tz.value))
const stopTxt = computed(() => fmtLocalInput(rng.value.stopMs, tz.value))
function setRangeMode(m) {
  if (m === 'custom' && S.rangeMode !== 'custom') { S.startMs = rng.value.startMs; S.stopMs = rng.value.stopMs }
  S.rangeMode = m
}
// 改起始：时长跟着屏上这一段走（起止重合 = 单帧，照样保持重合）
function onStart(e) {
  const t = parseLocalInput(e.target.value, tz.value)
  if (t == null) return
  const span = rng.value.stopMs - rng.value.startMs
  S.rangeMode = 'custom'; S.startMs = t; S.stopMs = t + (span >= 0 ? span : 3600e3)
}
function onStop(e) {
  const t = parseLocalInput(e.target.value, tz.value)
  if (t == null) return
  if (S.rangeMode !== 'custom') { S.startMs = rng.value.startMs }
  S.rangeMode = 'custom'; S.stopMs = t
}
const tlFixed = computed(() => { void vx.range.value; return !!vx.tlInfo().fixed })

// —— 节奏 ——
// 「时长」「每帧步长」读数走 fmtSimSec：共用的 fmtSpanSec 取整到秒，亚秒步长会读成「0s」（见 videoPlan.js）
const pace = computed(() => vx.pace.value)
const paceDraft = ref(null)
const paceVal = computed(() => {
  if (paceDraft.value != null) return paceDraft.value
  if (S.paceMode === 'speed') return numTxt(S.speed)
  if (S.paceMode === 'duration') return fmtClock(S.durationSec)
  return fmtSimSec(S.stepSec)
})
function commitPace() {
  const v = paceDraft.value; paceDraft.value = null
  if (v == null) return
  if (S.paceMode === 'speed') { const x = Number(String(v).replace(/[×x,\s]/gi, '')); if (x > 0) S.speed = x; return }
  if (S.paceMode === 'duration') {
    const m = /^(?:(\d+):)?(\d+):(\d{1,2})$/.exec(String(v).trim())
    const sec = m ? (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) : parseDur(v, 1)
    if (sec > 0) S.durationSec = sec
    return
  }
  const sec = parseDur(v, 1); if (sec > 0) S.stepSec = sec
}
const paceUnit = computed(() => (S.paceMode === 'speed' ? '×' : S.paceMode === 'duration' ? 'm:ss' : T('/帧', '/frame')))
// 倍速读数：变速时出最慢–最快（×43.2–864、×60–6,000，三位有效数字），否则平均倍速
const sp3 = (v) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : String(Number(v.toPrecision(3))))
const speedTxt = computed(() => (pace.value.ramped ? '×' + sp3(pace.value.speedMin) + '–' + sp3(pace.value.speedMax) : fmtSpeed(pace.value.speed)))

// —— 变速 ——
const RAMP_OPTS = computed(() => [
  { k: 'none', name: T('匀速', 'Constant') }, { k: 'in', name: T('渐快', 'Speed up') },
  { k: 'out', name: T('渐慢', 'Slow down') }, { k: 'inout', name: T('缓入缓出', 'Ease in-out') }
])
// 变速比走对数滑块（1 … 1000）：读数到整数或一位小数
const ratioLog = computed({ get: () => Math.log10(Math.max(1, Number(S.ramp.ratio) || 1)), set: (v) => { const x = Math.pow(10, Number(v) || 0); S.ramp.ratio = x >= 10 ? Math.round(x) : Math.round(x * 10) / 10 } })
const ratioTxt = computed(() => { const r = Number(S.ramp.ratio) || 1; return (r >= 10 ? Math.round(r).toLocaleString('en-US') : r.toFixed(1)) + '×' })


// —— 画面 ——
const flat = computed(() => !!vx.isFlatView())   // 宿主读的是 flatView 这个 ref：computed 里调用即被追踪，切视图当场跟上
function setView(v) { vx.setFlatView(v) }
const dims = computed(() => vx.dims.value)
const ssOn = computed({ get: () => S.ss !== 'off', set: (v) => { S.ss = v ? 'auto' : 'off' } })
const ssApplies = computed(() => !flat.value && dims.value.w * dims.value.h <= 2560 * 1440)

// —— 叠加信息 ——
const it = S.hud.items
const open = ref({})
const togOpen = (k) => { open.value = { ...open.value, [k]: !open.value[k] } }
const src = computed(() => vx.sources())
const ptList = computed(() => [...(src.value.stations || []), ...(src.value.points || [])])
function togId(list, id) { const i = list.indexOf(id); if (i >= 0) list.splice(i, 1); else list.push(id) }
const antOpts = computed(() => src.value.antennas || [])
// 聚焦卫星：逐节逐字段勾选（字段目录与右侧信息栏同一份，见 hud.js SAT_SECS）；节头 = 三态全选
const satF = it.sat.f
const secAll = (sec) => sec.f.every((f) => satF[f.k])
const secSome = (sec) => sec.f.some((f) => satF[f.k])
function setSec(sec, v) { for (const f of sec.f) satF[f.k] = v }
// 字段符号：空格分隔多个，「e_x」= e 带下标 x（同 hud.js 的卡片画法）
const symParts = (s) => String(s).split(' ').map((t) => { const i = t.indexOf('_'); return i > 0 ? [t.slice(0, i), t.slice(i + 1)] : [t, ''] })
const logoFile = ref(null)
function pickLogo(e) {
  const f = e.target.files && e.target.files[0]
  if (!f) return
  const rd = new FileReader()
  rd.onload = () => { it.logo.dataUrl = String(rd.result || ''); it.logo.src = 'custom' }
  rd.readAsDataURL(f)
  e.target.value = ''
}
const ITEMS = computed(() => [
  { k: 'time', name: T('时间', 'Time') },
  { k: 'title', name: T('标题', 'Title') },
  { k: 'sat', name: T('聚焦卫星', 'Focused satellites') },
  { k: 'aer', name: T('站星几何', 'Station geometry') },
  { k: 'field', name: T('场强', 'Field strength') },
  { k: 'legend', name: T('图例', 'Legend') },
  { k: 'logo', name: T('徽标', 'Logo') },   // 不叫「标识」：聚焦卫星字段里「标识」是星的身份（NORAD / 区制…）
  { k: 'progress', name: T('时间进度条', 'Time progress bar'), noPos: true }
])

// —— 输出 ——
const enc = computed(() => vx.encSupport.value)
const encText = computed(() => {
  const p = vx.encPath.value
  if (S.format !== 'mp4') return ''
  if (!enc.value) return '…'
  return p === 'hw' ? T('硬件编码', 'Hardware') : p === 'sw' ? T('软件编码', 'Software') : '—'
})
const levelText = computed(() => (vx.codec.value ? 'H.264 High ' + vx.codec.value.level.toFixed(1) : ''))
const issue = computed(() => vx.issue.value)

// —— 进度卡 ——
const phase = computed(() => vx.phase.value)
const busy = computed(() => phase.value === 'running' || phase.value === 'finishing')
const showCard = computed(() => phase.value !== 'idle')
const pr = vx.prog
const pct = computed(() => (pr.N ? pr.k / pr.N : 0))
// 缩略图位图宽 448、高随成片比例；屏上大小由 CSS 收（.vxc-th 限高 50vh、宽随比例）——竖屏 1080×1920 的位图有 796 高，不收就把卡撑出窗口
const thumbW = 448
const thumbH = computed(() => Math.round(thumbW * dims.value.h / dims.value.w))
const thumb = ref(null)
watch(thumb, (el) => { vx.thumbEl.value = el || null })
// 卡是模态的：开着时键盘在这儿（捕获阶段、先于页面）截住，不往下漏到地图 / 时间轴快捷键。
// 导出中 Esc = 取消；覆盖确认 Esc = 取消、Enter = 替换；完成 / 出错 / 已取消 Esc、Enter 都关卡。
// 焦点在卡里的按钮上时 Enter / 空格交给按钮本身；卡外（被遮住的面板）的键不放默认动作，免得按到底下的「开始导出」。
// ★ 覆盖确认刚弹出的 400 ms 内不认 Enter：保存框里按 Enter 确认文件名、手快连按的第二下会落到这张卡上，「替换」要删旧帧，不能让它顺手点掉
let askAt = 0
watch(phase, (p) => { if (p === 'confirm') askAt = performance.now() })
function onKey(e) {
  if (!showCard.value) return
  e.stopImmediatePropagation()
  if (busy.value) { e.preventDefault(); if (e.key === 'Escape') vx.cancel(); return }
  const el = e.target instanceof Element ? e.target : null
  const inCard = !!(el && el.closest('.vxc'))
  const onBtn = inCard && el.tagName === 'BUTTON'
  const confirming = phase.value === 'confirm'
  if (e.key === 'Escape') { e.preventDefault(); if (confirming) vx.answerAsk(false); else vx.dismiss() }
  else if (e.key === 'Enter' && !onBtn) {
    e.preventDefault()
    if (e.repeat) return
    if (!confirming) vx.dismiss()
    else if (performance.now() - askAt > 400) vx.answerAsk(true)
  }
  else if (!inCard && e.key !== 'Tab' && !e.ctrlKey && !e.metaKey) e.preventDefault()
}
// immediate：完成卡开着时收起面板、再打开，卡还在（phase 没回 idle），键也得接上
watch(showCard, (on) => {
  if (on) window.addEventListener('keydown', onKey, true)
  else window.removeEventListener('keydown', onKey, true)
}, { immediate: true })
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey, true) })
const res = computed(() => vx.result.value)
const resStill = computed(() => !!res.value && res.value.fmt !== 'mp4' && res.value.frames === 1)   // 单张图像：读数不出帧率 / 帧数 / 时长
const ask = computed(() => vx.ask.value)   // 图片序列覆盖确认：{ path, n, answered }
const cardTitle = computed(() => ({
  confirm: T('已有同名图片序列', 'Image sequence already exists'),
  running: pr.still ? T('正在导出图片', 'Exporting image') : T('正在导出视频', 'Exporting video'), finishing: T('正在收尾', 'Finalizing'),
  done: T('导出完成', 'Export complete'), error: T('导出失败', 'Export failed'), canceled: T('已取消', 'Canceled')
}[phase.value] || ''))
const fmtMs = (ms) => fmtClock((Number(ms) || 0) / 1000)
</script>

<template>
  <aside class="vxp" data-i18n-skip>
    <div class="vxp-hd">
      <Icon name="video" :size="13" />
      <span class="vxp-tt">{{ T('导出视频', 'Export Video') }}</span>
      <span class="vxp-sp"></span>
      <span class="vxp-ib" :title="T('关闭', 'Close')" @click="vx.hide()"><Icon name="x" :size="12" /></span>
    </div>

    <div class="vxp-bd">
      <!-- 时间 -->
      <section class="vs">
        <div class="vs-h">{{ T('时间', 'Time') }}</div>
        <div class="seg3">
          <button type="button" :class="{ on: S.rangeMode === 'timeline' }" :title="T('跟随时间轴：固定时段取其起止，滚动档取当前时间窗', 'Follow the timeline: its fixed period, or the current window when rolling')" @click="setRangeMode('timeline')">{{ tlFixed ? T('时间轴时段', 'Timeline period') : T('时间轴', 'Timeline') }}</button>
          <button type="button" :class="{ on: S.rangeMode === 'window' }" :title="T('时间条当前可见的时间窗', 'The window visible on the time ruler')" @click="setRangeMode('window')">{{ T('当前时间窗', 'Ruler window') }}</button>
          <button type="button" :class="{ on: S.rangeMode === 'custom' }" @click="setRangeMode('custom')">{{ T('自定义', 'Custom') }}</button>
        </div>
        <div class="vr"><label>{{ T('起始', 'Start') }}</label><input class="ci dt" type="datetime-local" step="1" :value="startTxt" @change="onStart" /></div>
        <div class="vr"><label>{{ T('终止', 'Stop') }}</label><input class="ci dt" type="datetime-local" step="1" :value="stopTxt" @change="onStop" /></div>
        <div class="ro">{{ T('时长', 'Span') }} <b>{{ fmtSimSec(vx.spanSec.value) }}</b><span class="ro-sep">·</span>{{ tzTag(tz, rng.startMs) }}</div>
      </section>

      <!-- 节奏 -->
      <section class="vs">
        <div class="vs-h">{{ T('节奏', 'Pacing') }}</div>
        <div class="vr"><label>{{ T('帧率', 'Frame rate') }}</label>
          <select class="ci" v-model.number="S.fps"><option v-for="f in FPS_LIST" :key="f" :value="f">{{ f }} fps</option></select>
        </div>
        <div class="seg3">
          <button type="button" :class="{ on: S.paceMode === 'speed' }" :title="T('每秒视频走过的仿真时间（STK 的 x Real Time）', 'Simulated seconds per second of video')" @click="S.paceMode = 'speed'; paceDraft = null">{{ T('倍速', 'Speed') }}</button>
          <button type="button" :class="{ on: S.paceMode === 'duration' }" :title="T('成片时长，倍速随之推出', 'Target video length; speed follows')" @click="S.paceMode = 'duration'; paceDraft = null">{{ T('视频时长', 'Duration') }}</button>
          <button type="button" :class="{ on: S.paceMode === 'step' }" :title="T('相邻两帧之间的仿真时间', 'Simulated time between frames')" @click="S.paceMode = 'step'; paceDraft = null">{{ T('步长', 'Step') }}</button>
        </div>
        <div class="vr">
          <label>{{ S.paceMode === 'speed' ? T('倍速', 'Speed') : S.paceMode === 'duration' ? T('视频时长', 'Duration') : T('每帧步长', 'Step') }}</label>
          <input class="ci" :value="paceVal" @input="paceDraft = $event.target.value" @change="commitPace" @keydown.enter="commitPace" @blur="commitPace" />
          <span class="u">{{ paceUnit }}</span>
          <span v-if="S.paceMode === 'speed'" class="vxp-ib" :title="T('取时间轴当前倍速', 'Use the timeline speed')" @click="vx.useTimelineSpeed(); paceDraft = null"><Icon name="refresh-cw" :size="11" /></span>
        </div>
        <!-- 变速（时间重映射）：平均倍速仍是上面那一档，剖面只决定怎么分配；停留 = 片头 / 片尾时间静止 -->
        <div class="vr" :title="T('倍速随成片时间的变化；平均倍速不变，片长不变', 'How the playback speed varies over the video; average speed and length unchanged')">
          <label>{{ T('变速', 'Speed ramp') }}</label>
          <select class="ci" v-model="S.ramp.shape"><option v-for="o in RAMP_OPTS" :key="o.k" :value="o.k">{{ o.name }}</option></select>
        </div>
        <template v-if="S.ramp.shape !== 'none'">
          <div class="vr ind" :title="T('最快与最慢倍速之比', 'Fastest ÷ slowest speed')">
            <label>{{ T('变速比', 'Ratio') }}</label>
            <input class="rg" type="range" min="0" max="3" step="0.01" v-model.number="ratioLog" /><span class="rv">{{ ratioTxt }}</span>
          </div>
          <div class="vr ind" :title="T('升速 / 降速段占运动部分的比例', 'Share of the motion spent speeding up / slowing down')">
            <label>{{ T('过渡', 'Transition') }}</label>
            <input class="rg" type="range" min="0.05" max="1" step="0.01" v-model.number="S.ramp.trans" /><span class="rv">{{ Math.round(S.ramp.trans * 100) }}%</span>
          </div>
        </template>
        <div class="vr" :title="T('片头 / 片尾仿真时间静止的时长', 'Seconds at the start / end with simulation time held')">
          <label>{{ T('停留', 'Hold') }}</label>
          <input class="ci num sm" type="number" min="0" max="600" step="0.5" v-model.number="S.ramp.hold0" :title="T('片头', 'Start')" /><span class="u">s</span>
          <span class="x">/</span>
          <input class="ci num sm" type="number" min="0" max="600" step="0.5" v-model.number="S.ramp.hold1" :title="T('片尾', 'End')" /><span class="u">s</span>
        </div>
        <div class="ro" :class="{ bad: !pace.ok }">
          <template v-if="pace.ok && pace.frames === 1"><b>1</b> {{ T('帧', 'frame') }}</template>
          <template v-else-if="pace.ok"><b>{{ pace.frames.toLocaleString('en-US') }}</b> {{ T('帧', 'frames') }}<span class="ro-sep">·</span>{{ fmtClock(pace.durationSec) }}<template v-if="pace.speed > 0"><span class="ro-sep">·</span>{{ speedTxt }}<span class="ro-sep">·</span>{{ fmtSimSec(pace.stepSec) }}{{ T('/帧', '/frame') }}</template></template>
          <template v-else>—</template>
        </div>
      </section>

      <!-- 画面 -->
      <section class="vs">
        <div class="vs-h">{{ T('画面', 'Frame') }}</div>
        <div class="seg3 two">
          <button type="button" :class="{ on: !flat }" @click="setView(false)">{{ T('3D 球体', '3D Globe') }}</button>
          <button type="button" :class="{ on: flat }" @click="setView(true)">{{ T('2D 平面图', '2D Map') }}</button>
        </div>
        <div class="vr"><label>{{ T('分辨率', 'Resolution') }}</label>
          <select class="ci" v-model="S.res">
            <option v-for="r in RES_PRESETS" :key="r.key" :value="r.key">{{ RES_LABEL[r.key] }}</option>
            <option value="custom">{{ T('自定义', 'Custom') }}</option>
          </select>
        </div>
        <div v-if="S.res === 'custom'" class="vr"><label></label>
          <input class="ci num" type="number" min="64" max="4096" step="2" v-model.number="S.cw" /><span class="x">×</span>
          <input class="ci num" type="number" min="64" max="4096" step="2" v-model.number="S.ch" /><span class="u">px</span>
        </div>
        <div class="vr" :title="T('线宽、地名、图标相对画面的大小（1 = 与屏上同比例）', 'Line widths, labels and icons relative to the frame (1 = as on screen)')">
          <label>{{ T('标注缩放', 'Annotation') }}</label>
          <input class="rg" type="range" min="0.5" max="2" step="0.05" v-model.number="S.annot" /><span class="rv">{{ S.annot.toFixed(2) }}×</span>
        </div>
        <div v-if="!flat" class="vr" :title="T('按 2 倍分辨率渲染再缩回（≤ 2560×1440 时生效）', 'Render at 2× and downsample (up to 2560×1440)')">
          <label>{{ T('超采样', 'Supersampling') }}</label>
          <span class="layersw" :class="{ on: ssOn, dis: !ssApplies }" role="switch" :aria-checked="ssOn ? 'true' : 'false'" @click="ssOn = !ssOn"><i></i></span><span class="rv">{{ ssOn && ssApplies ? '2×' : '1×' }}</span>
        </div>
        <div class="vr" :title="T('屏上拖框边移动、拖四角缩放（Alt：以框心缩放），双击框边复位', 'On the map: drag an edge to move, a corner to resize (Alt: about the center); double-click an edge to reset')">
          <label>{{ T('取景框', 'Framing') }}</label>
          <span class="layersw" :class="{ on: S.framing }" role="switch" :aria-checked="S.framing ? 'true' : 'false'" @click="S.framing = !S.framing"><i></i></span>
          <span class="rv">{{ dims.w }} × {{ dims.h }}<template v-if="!vx.frameIsDefault.value"> · {{ Math.round(S.frame.s * 100) }}%</template></span>
          <span v-if="!vx.frameIsDefault.value" class="vxp-ib" :title="T('复位：最大、居中', 'Reset: largest, centered')" @click="vx.resetFrame()"><Icon name="rotate-ccw" :size="12" /></span>
        </div>
        <!-- 2D 经纬图框（SATSOFT 式）：留白 + 四边刻度 + 度数标注 + 轴标题 + 点线网格。
             子项叫法与地图设置 → 2D 投影那一份一致（间隔 / 标注 / 底色 / 网格线；英文同词典） -->
        <template v-if="flat">
          <div class="vr"><label>{{ T('经纬图框', 'Graticule Frame') }}</label>
            <span class="layersw" :class="{ on: S.geo.on }" role="switch" :aria-checked="S.geo.on ? 'true' : 'false'" @click="S.geo.on = !S.geo.on"><i></i></span>
          </div>
          <template v-if="S.geo.on">
            <div class="vr ind"><label>{{ T('间隔', 'Spacing') }}</label>
              <select class="ci" v-model.number="S.geo.step"><option :value="0">{{ T('自动', 'Auto') }}</option><option v-for="s in GEO_STEPS" :key="s" :value="s">{{ s }}°</option></select>
            </div>
            <div class="vr ind"><label>{{ T('标注', 'Labels') }}</label>
              <div class="seg3 two in">
                <button type="button" :class="{ on: S.geo.fmt !== 'hemi' }" @click="S.geo.fmt = 'num'">−50.00</button>
                <button type="button" :class="{ on: S.geo.fmt === 'hemi' }" @click="S.geo.fmt = 'hemi'">50°W</button>
              </div>
            </div>
            <div class="vr ind"><label>{{ T('底色', 'Background') }}</label>
              <div class="seg3 two in">
                <button type="button" :class="{ on: S.geo.theme !== 'dark' }" @click="S.geo.theme = 'light'">{{ T('浅色', 'Light') }}</button>
                <button type="button" :class="{ on: S.geo.theme === 'dark' }" @click="S.geo.theme = 'dark'">{{ T('深色', 'Dark') }}</button>
              </div>
            </div>
            <div class="vr ind"><label>{{ T('网格线', 'Grid lines') }}</label>
              <span class="layersw" :class="{ on: S.geo.lines }" role="switch" :aria-checked="S.geo.lines ? 'true' : 'false'" @click="S.geo.lines = !S.geo.lines"><i></i></span>
            </div>
          </template>
        </template>
      </section>

      <!-- 叠加信息 -->
      <section class="vs">
        <div class="vs-h">{{ T('叠加信息', 'Overlays') }}</div>
        <div class="vr"><label>{{ T('字号', 'Size') }}</label>
          <input class="rg" type="range" min="0.6" max="2" step="0.05" v-model.number="S.hud.size" /><span class="rv">{{ S.hud.size.toFixed(2) }}×</span>
        </div>
        <div class="vr"><label>{{ T('底板', 'Panel') }}</label>
          <span class="layersw" :class="{ on: S.hud.panel }" role="switch" :aria-checked="S.hud.panel ? 'true' : 'false'" @click="S.hud.panel = !S.hud.panel"><i></i></span>
          <input v-if="S.hud.panel" class="rg sm" type="range" min="0.2" max="0.95" step="0.05" v-model.number="S.hud.opacity" :title="T('底板不透明度', 'Panel opacity')" />
        </div>
        <div class="vr"><label>{{ T('字体', 'Font') }}</label>
          <select class="ci" v-model="S.hud.font"><option value="ui">{{ T('界面字体', 'Interface font') }}</option><option value="doc">{{ T('报告衬线', 'Report serif') }}</option></select>
        </div>

        <div v-for="m in ITEMS" :key="m.k" class="hi" :class="{ on: it[m.k].on }">
          <div class="hi-row">
            <span class="layersw" :class="{ on: it[m.k].on }" role="switch" :aria-checked="it[m.k].on ? 'true' : 'false'" @click="it[m.k].on = !it[m.k].on"><i></i></span>
            <span class="hi-n" @click="!m.noPos && togOpen(m.k)">{{ m.name }}</span>
            <select v-if="!m.noPos" class="ci pos" v-model="it[m.k].pos" :title="T('位置', 'Position')"><option v-for="p in POS" :key="p[0]" :value="p[0]">{{ p[1] }}</option></select>
            <span v-if="!m.noPos" class="hi-x" :class="{ open: open[m.k] }" @click="togOpen(m.k)"><Icon name="chevron-down" :size="11" /></span>
          </div>
          <div v-if="open[m.k] && !m.noPos" class="hi-bd">
            <template v-if="m.k === 'time'">
              <label class="ck"><input type="checkbox" v-model="it.time.date" />{{ T('日期', 'Date') }}</label>
              <label class="ck"><input type="checkbox" v-model="it.time.elapsed" />{{ T('经过时间', 'Elapsed') }}</label>
              <label class="ck"><input type="checkbox" v-model="it.time.speed" />{{ T('倍速', 'Speed') }}</label>
              <div class="ro">{{ fmtStamp(rng.startMs, tz, it.time.date !== false) }}</div>
            </template>
            <template v-else-if="m.k === 'title'">
              <input class="ci full" v-model="it.title.text" :placeholder="T('标题', 'Title')" />
              <input class="ci full" v-model="it.title.sub" :placeholder="T('副标题', 'Subtitle')" />
            </template>
            <template v-else-if="m.k === 'sat'">
              <div class="vr"><label>{{ T('颗数上限', 'Max') }}</label><select class="ci" v-model.number="it.sat.max"><option v-for="n in [1, 2, 3, 4, 6]" :key="n" :value="n">{{ n }}</option></select><span class="rv">{{ (src.sats || []).length }}</span></div>
              <div class="vr"><label>{{ T('节标题', 'Section titles') }}</label>
                <span class="layersw" :class="{ on: it.sat.heads }" role="switch" :aria-checked="it.sat.heads ? 'true' : 'false'" @click="it.sat.heads = !it.sat.heads"><i></i></span>
              </div>
              <div v-for="sec in SAT_SECS" :key="sec.k" class="fsec">
                <label class="fsec-h"><input type="checkbox" :checked="secAll(sec)" :indeterminate.prop="secSome(sec) && !secAll(sec)" @change="setSec(sec, !secAll(sec))" /><span>{{ T(sec.zh, sec.en) }}</span></label>
                <div v-if="sec.f.length > 1" class="fsec-g">
                  <label v-for="f in sec.f" :key="f.k" class="ck" :title="T(f.zh, f.en)"><input type="checkbox" v-model="satF[f.k]" /><span class="fn">{{ T(f.zh, f.en) }}</span><i v-if="f.s" class="sym"><template v-for="(p, j) in symParts(f.s)" :key="j"><template v-if="j">{{ ' ' }}</template>{{ p[0] }}<sub v-if="p[1]">{{ p[1] }}</sub></template></i></label>
                </div>
              </div>
            </template>
            <template v-else-if="m.k === 'aer' || m.k === 'field'">
              <template v-if="m.k === 'field'">
                <div class="vr"><label>{{ T('天线', 'Antenna') }}</label>
                  <select class="ci" v-model="it.field.key">
                    <option value="">{{ T('当前聚焦天线', 'Focused antenna') }}</option>
                    <option v-for="a in antOpts" :key="a.key" :value="a.key">{{ a.label }}</option>
                  </select>
                </div>
                <div class="vr"><label>{{ T('单位', 'Unit') }}</label><input class="ci" v-model="it.field.unit" placeholder="dB / dBW / dBW/m²" /></div>
              </template>
              <div v-if="!ptList.length" class="ro">{{ T('没有地球站或点标记。', 'No stations or point markers.') }}</div>
              <div v-else class="plist">
                <label v-for="p in ptList" :key="p.id" class="ck"><input type="checkbox" :checked="(m.k === 'aer' ? it.aer.ids : it.field.ids).includes(p.id)" @change="togId(m.k === 'aer' ? it.aer.ids : it.field.ids, p.id)" /><span class="pn">{{ p.name }}</span></label>
              </div>
            </template>
            <template v-else-if="m.k === 'legend'">
              <div class="vr"><label>{{ T('天线', 'Antenna') }}</label>
                <select class="ci" v-model="it.legend.key">
                  <option value="">{{ T('当前聚焦天线', 'Focused antenna') }}</option>
                  <option v-for="a in antOpts" :key="a.key" :value="a.key">{{ a.label }}</option>
                </select>
              </div>
            </template>
            <template v-else-if="m.k === 'logo'">
              <div class="seg3 two">
                <button type="button" :class="{ on: it.logo.src !== 'custom' }" @click="it.logo.src = 'app'">LinkLab</button>
                <button type="button" :class="{ on: it.logo.src === 'custom' }" @click="it.logo.dataUrl ? (it.logo.src = 'custom') : logoFile.click()">{{ T('自定义图片…', 'Custom image…') }}</button>
              </div>
              <input ref="logoFile" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden @change="pickLogo" />
              <div class="vr"><label>{{ T('大小', 'Size') }}</label><input class="rg" type="range" min="1" max="6" step="0.1" v-model.number="it.logo.h" /><span class="rv">{{ it.logo.h.toFixed(1) }}</span></div>
            </template>
          </div>
        </div>
      </section>

      <!-- 输出 -->
      <section class="vs">
        <div class="vs-h">{{ T('输出', 'Output') }}</div>
        <div class="seg3">
          <button type="button" :class="{ on: S.format === 'mp4' }" @click="S.format = 'mp4'">MP4</button>
          <button type="button" :class="{ on: S.format === 'png' }" :title="T('无损逐帧图片', 'Lossless frame images')" @click="S.format = 'png'">{{ T('PNG 序列', 'PNG frames') }}</button>
          <button type="button" :class="{ on: S.format === 'jpg' }" @click="S.format = 'jpg'">{{ T('JPEG 序列', 'JPEG frames') }}</button>
        </div>
        <template v-if="S.format === 'mp4'">
          <div class="vr"><label>{{ T('质量', 'Quality') }}</label>
            <select class="ci" v-model="S.q">
              <option value="std">{{ T('标准', 'Standard') }}</option><option value="high">{{ T('高', 'High') }}</option>
              <option value="max">{{ T('极高', 'Very high') }}</option><option value="custom">{{ T('自定义码率', 'Custom bitrate') }}</option>
            </select>
          </div>
          <div class="vr"><label>{{ T('码率', 'Bitrate') }}</label>
            <input v-if="S.q === 'custom'" class="ci num" type="number" min="1" max="240" step="0.5" v-model.number="S.mbps" />
            <span v-else class="rv l">{{ (vx.bitrate.value / 1e6).toFixed(1) }}</span><span class="u">Mbps</span>
          </div>
          <div class="vr"><label>{{ T('编码器', 'Encoder') }}</label>
            <select class="ci" v-model="S.enc">
              <option value="auto">{{ T('自动', 'Auto') }}</option><option value="hw">{{ T('硬件', 'Hardware') }}</option><option value="sw">{{ T('软件', 'Software') }}</option>
            </select>
            <span class="rv" :title="levelText">{{ encText }}</span>
          </div>
          <div class="vr"><label>{{ T('关键帧间隔', 'Keyframe interval') }}</label>
            <select class="ci" v-model.number="S.gopSec"><option v-for="g in [0.5, 1, 2, 5]" :key="g" :value="g">{{ g }} s</option></select>
          </div>
        </template>
        <div v-else-if="S.format === 'jpg'" class="vr"><label>{{ T('质量', 'Quality') }}</label>
          <input class="rg" type="range" min="0.5" max="1" step="0.01" v-model.number="S.jpegQ" /><span class="rv">{{ Math.round(S.jpegQ * 100) }}</span>
        </div>
        <div class="ro">{{ T('约', 'About') }} <b>{{ fmtBytes(vx.estBytes.value) }}</b><template v-if="S.format !== 'mp4' && pace.ok"><span class="ro-sep">·</span>{{ pace.frames.toLocaleString('en-US') }} {{ T('个文件', pace.frames === 1 ? 'file' : 'files') }}</template></div>
      </section>
    </div>

    <div class="vxp-ft">
      <div v-if="issue" class="ft-err">{{ issue }}</div>
      <button type="button" class="btn primary go" :disabled="!!issue || busy || vx.starting.value" @click="vx.start()"><Icon name="video" :size="13" />{{ T('开始导出', 'Export') }}</button>
    </div>

    <!-- 整窗进度卡：逐帧渲染期间盖住一切（菜单 / 地图 / 侧栏），Esc 取消；导出前的覆盖确认、导出后的结果也在这张卡上 -->
    <Teleport to="body">
      <div v-if="showCard" class="vxc-mask" data-i18n-skip>
        <div class="vxc">
          <div class="vxc-hd">{{ cardTitle }}</div>
          <canvas v-if="phase !== 'confirm'" ref="thumb" class="vxc-th" :width="thumbW" :height="thumbH"></canvas>
          <template v-if="busy">
            <div class="vxc-bar"><i :style="{ width: (pct * 100).toFixed(2) + '%' }"></i></div>
            <div class="vxc-ro">
              <span><b>{{ pr.k.toLocaleString('en-US') }}</b> / {{ pr.N.toLocaleString('en-US') }} {{ T('帧', 'frames') }}</span>
              <span>{{ fmtStamp(pr.tMs, tz, true) }}</span>
            </div>
            <div class="vxc-ro sub">
              <span v-if="pr.N > 1">{{ pr.fps.toFixed(1) }} {{ T('帧/秒', 'fps') }}</span>
              <span>{{ T('已用', 'Elapsed') }} {{ fmtMs(pr.elapsedMs) }}</span>
              <span v-if="pr.N > 1">{{ T('剩余', 'Remaining') }} {{ fmtMs(pr.etaMs) }}</span>
              <span>{{ fmtBytes(pr.bytes) }}</span>
              <span v-if="pr.encoder">{{ pr.encoder === 'hw' ? T('硬件编码', 'Hardware') : T('软件编码', 'Software') }}</span>
            </div>
            <div class="vxc-ft"><button type="button" class="btn" :disabled="phase === 'finishing'" @click="vx.cancel()">{{ T('取消', 'Cancel') }}</button></div>
          </template>
          <template v-else-if="phase === 'done' && res">
            <div class="vxc-ro">
              <span class="path" :title="res.path">{{ res.path }}</span>
            </div>
            <div class="vxc-ro sub">
              <span v-if="resStill">{{ res.w }} × {{ res.h }}</span>
              <template v-else>
                <span>{{ res.w }} × {{ res.h }} · {{ res.fps }} fps</span>
                <span>{{ res.frames.toLocaleString('en-US') }} {{ T('帧', 'frames') }}</span>
                <span>{{ fmtClock(res.durationSec) }}</span>
              </template>
              <span>{{ fmtBytes(res.bytes) }}</span>
              <span>{{ T('用时', 'Took') }} {{ fmtMs(res.ms) }}</span>
            </div>
            <div class="vxc-ft">
              <button v-if="res.fmt === 'mp4' || resStill" type="button" class="btn" @click="vx.openFile()">{{ res.fmt === 'mp4' ? T('播放', 'Play') : T('打开', 'Open') }}</button>
              <button type="button" class="btn" @click="vx.reveal()">{{ T('在文件夹中显示', 'Show in folder') }}</button>
              <button type="button" class="btn primary" @click="vx.dismiss()">{{ T('完成', 'Done') }}</button>
            </div>
          </template>
          <template v-else-if="phase === 'confirm' && ask">
            <div class="vxc-ro">
              <span class="path" :title="ask.path">{{ ask.path }}</span>
            </div>
            <div class="vxc-ro sub"><span>{{ ask.n.toLocaleString('en-US') }} {{ T('个文件', ask.n === 1 ? 'file' : 'files') }}</span></div>
            <div class="vxc-ft">
              <button type="button" class="btn" :disabled="ask.answered" @click="vx.answerAsk(false)">{{ T('取消', 'Cancel') }}</button>
              <button type="button" class="btn primary" :disabled="ask.answered" @click="vx.answerAsk(true)">{{ T('替换', 'Replace') }}</button>
            </div>
          </template>
          <template v-else>
            <div v-if="phase === 'error'" class="vxc-err">{{ vx.errorMsg.value }}</div>
            <div class="vxc-ft"><button type="button" class="btn primary" @click="vx.dismiss()">{{ T('关闭', 'Close') }}</button></div>
          </template>
        </div>
      </div>
    </Teleport>
  </aside>
</template>

<style scoped>
.vxp {
  flex: none; width: 300px; display: flex; flex-direction: column; min-height: 0; overflow: hidden;
  background: var(--surface); border-left: 1px solid var(--border); font-size: var(--fs-3); color: var(--text);
}
.vxp-hd { flex: none; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 6px 0 12px; border-bottom: 1px solid var(--border); color: var(--text-muted); }
.vxp-tt { font-weight: 600; color: var(--text); font-size: var(--fs-4); }
.vxp-sp { flex: 1; }
.vxp-ib { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: var(--r-ctl); color: var(--text-muted); cursor: pointer; flex: none; }
.vxp-ib:hover { background: var(--wash-hover); color: var(--text); }
.vxp-bd { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 12px 10px 12px; scrollbar-gutter: stable; }
.vs { padding: 8px 0 10px; border-bottom: 1px solid var(--border); }
.vs:last-child { border-bottom: none; }
.vs-h { font-size: var(--fs-2); font-weight: 600; color: var(--text-muted); letter-spacing: .02em; margin: 2px 0 7px; }
.vr { display: flex; align-items: center; gap: 6px; min-height: var(--h-ctl); margin: 5px 0; }
.vr > label { flex: none; width: 72px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vr .ci { flex: 1; min-width: 0; }
.vr .ci.num { flex: 0 1 78px; }
.vr .ci.dt { font-variant-numeric: tabular-nums; }
.vr .u, .vr .x { flex: none; color: var(--text-muted); }
.vr .rg { flex: 1; min-width: 0; }
.vr .rg.sm { flex: 0 1 110px; margin-left: 8px; }
.vr .rv { flex: none; min-width: 40px; text-align: right; color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.vr .rv.l { flex: 1; text-align: left; color: var(--text); }
.vr .layersw.dis { opacity: .45; }
.ro { margin: 6px 0 0; color: var(--text-muted); font-size: var(--fs-2); font-variant-numeric: tabular-nums; line-height: 1.5; }
.ro b { color: var(--text); font-weight: 600; }
.ro.bad { color: var(--danger); }
.ro-sep { margin: 0 6px; opacity: .6; }

.seg3 { display: flex; border: 1px solid var(--field-border); border-radius: var(--r-ctl); overflow: hidden; margin: 2px 0 6px; }
.seg3 > button {
  flex: 1; min-width: 0; height: var(--h-ctl); padding: 0 4px; border: none; border-right: 1px solid var(--border);
  background: var(--field-bg); color: var(--text); font: inherit; font-size: var(--fs-2); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.seg3 > button:last-child { border-right: none; }
.seg3 > button:hover:not(.on) { background: var(--wash-hover); }
.seg3 > button.on { background: var(--accent-ui); color: var(--bg); }
.vr .seg3.in { flex: 1; min-width: 0; margin: 0; }
.vr.ind > label { padding-left: 12px; }   /* 从属于上一行开关的子项：只缩标签，控件列照旧对齐 */
.vr .ci.num.sm { flex: 0 1 58px; }


.hi { border: 1px solid var(--border); border-radius: var(--r-box); margin: 5px 0; background: var(--bg); }
.hi:not(.on) .hi-n { color: var(--text-muted); }
.hi-row { display: flex; align-items: center; gap: 7px; height: 28px; padding: 0 4px 0 8px; }
.hi-n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.hi-row .ci.pos { flex: none; width: 72px; height: var(--h-ctl-sm); font-size: var(--fs-2); }
.hi-x { display: inline-flex; width: 18px; height: 18px; align-items: center; justify-content: center; color: var(--text-muted); cursor: pointer; transition: transform var(--dur-2) var(--ease-std); }
.hi-x.open { transform: rotate(180deg); }
.hi-bd { padding: 2px 8px 8px; border-top: 1px solid var(--border); }
.hi-bd .ck { display: inline-flex; align-items: center; gap: 4px; margin: 6px 12px 0 0; color: var(--text); white-space: nowrap; }
.hi-bd .ci.full { display: block; width: 100%; margin-top: 6px; }
/* 聚焦卫星字段：一节一组，节头三态全选，字段两列；符号衬线斜体（同信息栏 .rdk-s） */
.fsec { margin-top: 8px; }
.fsec-h { display: flex; align-items: center; gap: 4px; color: var(--text-muted); font-size: var(--fs-2); font-weight: 600; cursor: pointer; user-select: none; }
.fsec-g { display: grid; grid-template-columns: 1fr 1fr; column-gap: 10px; padding-left: 18px; }
.hi-bd .fsec-g .ck { display: flex; min-width: 0; margin: 5px 0 0; }
.fsec-g .fn { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.fsec-g .sym { flex: none; font-family: var(--font-serif); font-style: italic; font-size: var(--fs-4); line-height: 1; color: var(--text); margin-left: 3px; }
.fsec-g .sym sub { font-size: .7em; line-height: 0; vertical-align: -.28em; margin-left: 1px; }
.plist { max-height: 150px; overflow-y: auto; margin-top: 4px; display: flex; flex-direction: column; }
.plist .ck { margin: 4px 0 0; }
.plist .pn { overflow: hidden; text-overflow: ellipsis; }

.vxp-ft { flex: none; padding: 8px 12px 10px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; }
.ft-err { color: var(--danger); font-size: var(--fs-2); }
.btn.go { height: var(--h-ctl-lg); display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-size: var(--fs-4); }

.vxc-mask { position: fixed; inset: 0; z-index: 9000; background: rgba(8, 10, 14, .86); display: flex; align-items: center; justify-content: center; }
/* 卡不超出窗口：内容再高（竖屏缩略图、长报错）就卡内滚动，按钮总够得着 */
.vxc { width: 480px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); overflow: auto; overscroll-behavior: contain; background: var(--surface); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--r-float); box-shadow: var(--shadow-3); padding: 14px 16px 12px; font-size: var(--fs-3); }
.vxc-hd { font-size: var(--fs-5); font-weight: 600; margin-bottom: 10px; }
/* 缩略图：宽高都 auto + max-width / max-height —— 替换元素按位图比例同时满足两道上限（竖屏收到半屏高、宽随比例），不变形；
   object-fit 兜底：万一被拉成别的比例，也是留黑边而不是压扁 */
.vxc-th { display: block; width: auto; height: auto; max-width: 100%; max-height: 50vh; margin: 0 auto; object-fit: contain; background: #000; border: 1px solid var(--border); border-radius: var(--r-box); }
.vxc-bar { height: 6px; margin: 12px 0 8px; background: var(--surface-2); border-radius: 3px; overflow: hidden; }
.vxc-bar > i { display: block; height: 100%; background: var(--accent-ui); transition: width 120ms linear; }
.vxc-ro { display: flex; justify-content: space-between; gap: 10px; margin: 8px 0 0; font-variant-numeric: tabular-nums; }
.vxc-ro.sub { color: var(--text-muted); font-size: var(--fs-2); justify-content: flex-start; flex-wrap: wrap; column-gap: 14px; row-gap: 2px; }
.vxc-ro .path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.vxc-err { margin-top: 10px; color: var(--danger); word-break: break-all; }
.vxc-ft { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
</style>
