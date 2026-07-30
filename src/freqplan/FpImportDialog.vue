<script setup>
// 截图导入 · 识别与校对。
//
// 立场：不承诺「导入即用」，承诺「导入后改几个数」。所以这一屏的重点不是识别本身，而是把
// 【识别到了什么 / 哪几项不可信 / 图上对应哪个框】三件事摆到人眼前，让核对成本降到最低：
//   · 左侧原图叠检测框，右侧逐条结果，两边点选联动；
//   · 每条标出来源——OCR 读到的 / 由频率标度几何推出的 / 与几何对不上被判存疑的；
//   · 存疑与几何推算的条目默认排在前面，先看该看的。
import { ref, computed, nextTick } from 'vue'
import { analyzeImage } from '../shared/freqPlanVision.js'
import { normalizePlan, resolveChannel, validatePlan, POLS } from '../shared/freqPlanModel.js'
import Icon from '../components/Icon.vue'

const emit = defineEmits(['close', 'confirm'])

const busy = ref('')
const imgUrl = ref('')
const imgName = ref('')
const imgW = ref(0), imgH = ref(0)
const result = ref(null)       // analyzeImage 的返回
const plan = ref(null)
const selectedId = ref('')
const showAllBlocks = ref(true)
const zoom = ref(1)
const api = typeof window !== 'undefined' ? window.api : null

const stats = computed(() => result.value?.stats || null)
const warnings = computed(() => result.value?.warnings || [])
const issues = computed(() => (plan.value ? validatePlan(plan.value) : []))

// 通道行：带上「来源」标记，存疑/几何推算的排前面
const rows = computed(() => {
  if (!plan.value) return []
  const list = plan.value.channels.map((ch, i) => {
    const r = resolveChannel(plan.value, ch)
    return {
      ch, i, r,
      suspect: !!ch._suspect,
      geom: !!ch._geom,
      lowConf: (ch._labelConf ?? 1) < 0.55,
      px: ch._px || null
    }
  })
  return list.sort((a, b) => {
    const rank = (x) => (x.suspect ? 0 : x.lowConf ? 1 : x.geom ? 2 : 3)
    return rank(a) - rank(b) || (a.ch.up.fcMHz ?? 0) - (b.ch.up.fcMHz ?? 0)
  })
})
const needAttention = computed(() => rows.value.filter((r) => r.suspect || r.lowConf).length)

async function pickImage() {
  if (!api?.freqPlan?.openImage) return
  busy.value = '选择图片…'
  try {
    const r = await api.freqPlan.openImage()
    if (!r || r.canceled) return
    if (r.error) { busy.value = ''; alertMsg.value = '读取失败：' + r.error; return }
    imgName.value = r.name || ''
    await loadAndAnalyze(r.dataUrl)
  } finally { busy.value = '' }
}

// 支持直接 Ctrl+V 粘贴截图——这类图最常见的来路就是从 PPT/PDF 里截一张
async function onPaste(e) {
  const items = e.clipboardData?.items || []
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      const f = it.getAsFile()
      if (!f) continue
      const url = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f) })
      imgName.value = '（剪贴板）'
      await loadAndAnalyze(url)
      e.preventDefault()
      return
    }
  }
}

const alertMsg = ref('')

async function loadAndAnalyze(dataUrl) {
  busy.value = '解析图像…'
  alertMsg.value = ''
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image()
      im.onload = () => res(im)
      im.onerror = () => rej(new Error('图片无法解码'))
      im.src = dataUrl
    })
    imgUrl.value = dataUrl
    imgW.value = img.naturalWidth; imgH.value = img.naturalHeight
    // 放大到至少 1400px 宽再识别：截图分辨率不足时字符只有几像素高，模板匹配无从下手。
    // 这一步等价于「先把图放大看清楚再读」，对小图提升明显，对大图是恒等操作。
    const scale = img.naturalWidth < 1400 ? Math.min(3, 1400 / img.naturalWidth) : 1
    const cw = Math.round(img.naturalWidth * scale), chh = Math.round(img.naturalHeight * scale)
    const cv = document.createElement('canvas')
    cv.width = cw; cv.height = chh
    const g = cv.getContext('2d', { willReadFrequently: true })
    g.imageSmoothingEnabled = true
    g.imageSmoothingQuality = 'high'
    g.fillStyle = '#fff'; g.fillRect(0, 0, cw, chh)
    g.drawImage(img, 0, 0, cw, chh)
    const data = g.getImageData(0, 0, cw, chh)

    busy.value = '识别中…'
    await nextTick()
    const r = analyzeImage(data)
    // 检测坐标是放大后的，换算回原图比例，叠加层才能对上 <img>
    r._scale = scale
    result.value = r
    plan.value = normalizePlan(r.plan)
    selectedId.value = plan.value.channels[0]?.id || ''
    if (!plan.value.channels.length) alertMsg.value = '未能从图中识别出转发器 — 可改用「批量生成」手工录入，或换一张分辨率更高的图'
  } catch (e) {
    alertMsg.value = '识别失败：' + e.message
  } finally { busy.value = '' }
}

// 叠加层：把检测框按 <img> 的显示尺寸缩放
const dispW = computed(() => Math.round(imgW.value * zoom.value))
const overlayScale = computed(() => (imgW.value && result.value ? (dispW.value / imgW.value) / (result.value._scale || 1) : 1))
const overlayBlocks = computed(() => {
  if (!result.value) return []
  const s = overlayScale.value
  return result.value.overlay.blocks.map((b) => ({
    x: b.x0 * s, y: b.y0 * s, w: (b.x1 - b.x0 + 1) * s, h: (b.y1 - b.y0 + 1) * s,
    suspect: !!b.freqSuspect, geom: !!b.freqFromGeom, label: b.labelText || '', freq: b.freqFinal
  }))
})
// 选中通道 → 图上高亮框
const selBox = computed(() => {
  const row = rows.value.find((r) => r.ch.id === selectedId.value)
  if (!row?.px) return null
  const s = overlayScale.value
  return { x: row.px.x0 * s, y: (row.px.cy - 14) * s, w: (row.px.x1 - row.px.x0) * s, h: 28 * s }
})

function selectRow(id) {
  selectedId.value = id
  nextTick(() => {
    const el = document.querySelector('.fpi-row.on')
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
  })
}

function setNum(ch, path, v) {
  const n = v === '' || v == null ? null : Number(v)
  const val = Number.isFinite(n) ? n : null
  if (path === 'upFc') { ch.up.fcMHz = val; ch._suspect = false; ch._geom = false }
  else if (path === 'upBw') ch.up.bwMHz = val
  else if (path === 'dnFc') ch.dn.fcMHz = val
}
function setNo(ch, v) { ch.no = String(v || '').trim(); ch._labelConf = 1 }

function confirm() {
  if (!plan.value) return
  // 校对痕迹（_px/_suspect/_geom）不入库：它们只服务这一屏，留在数据里会跟着分享包扩散出去
  const clean = normalizePlan({
    ...plan.value,
    channels: plan.value.channels.map((c) => {
      const { _px, _suspect, _geom, _labelConf, ...rest } = c
      return rest
    })
  })
  emit('confirm', { plan: clean, imageDataUrl: imgUrl.value || '', imageName: imgName.value })
}
</script>

<template>
  <div class="mask" @paste="onPaste" tabindex="0">
    <div class="dlg" role="dialog" aria-modal="true">
      <header class="dhd">
        <span class="dt">从截图导入频率计划</span>
        <span class="dsub" v-if="imgName">{{ imgName }} · {{ imgW }}×{{ imgH }}</span>
        <span class="spacer"></span>
        <button class="winx" type="button" aria-label="关闭" @click="emit('close')"><Icon name="x" :size="11" /></button>
      </header>

      <div class="bar">
        <button class="mini imp" :disabled="!!busy" @click="pickImage">
          <Icon name="import" :size="12" /> {{ busy || '选择图片…' }}
        </button>
        <span class="hint">也可直接 Ctrl+V 粘贴截图</span>
        <span class="spacer"></span>
        <template v-if="stats">
          <span class="stat"><b>{{ stats.blocks }}</b> 色块</span>
          <span class="stat"><b>{{ stats.ocrFreq }}</b> 频率读出</span>
          <span class="stat" :class="{ warn: stats.geomFilled }"><b>{{ stats.geomFilled }}</b> 几何补全</span>
          <span class="stat" :class="{ bad: stats.suspect }"><b>{{ stats.suspect }}</b> 存疑</span>
          <span class="stat"><b>{{ zoom.toFixed(1) }}×</b></span>
          <button class="mini ghost" @click="zoom = Math.max(0.25, zoom - 0.25)">−</button>
          <button class="mini ghost" @click="zoom = Math.min(3, zoom + 0.25)">＋</button>
        </template>
      </div>

      <div v-if="alertMsg" class="alert">{{ alertMsg }}</div>

      <div class="body">
        <!-- 左：原图 + 检测叠加 -->
        <div class="imgpane">
          <div v-if="!imgUrl" class="drop">
            <Icon name="image" :size="28" />
            <p>选择或粘贴一张标准频率计划图</p>
            <p class="dim">支持上下行两排、双极化、多波束着色的常规版式。识别出的每一项都会标出来源，可逐条改。</p>
          </div>
          <div v-else class="imgwrap" :style="{ width: dispW + 'px' }">
            <img :src="imgUrl" :width="dispW" alt="原图" />
            <svg v-if="showAllBlocks" class="ovl" :width="dispW" :height="imgH * zoom">
              <rect v-for="(b, i) in overlayBlocks" :key="i" :x="b.x" :y="b.y" :width="b.w" :height="b.h"
                class="ob" :class="{ suspect: b.suspect, geom: b.geom }" />
              <rect v-if="selBox" :x="selBox.x" :y="selBox.y" :width="selBox.w" :height="selBox.h" class="ob sel" />
            </svg>
          </div>
        </div>

        <!-- 右：识别结果逐条校对 -->
        <div class="tblpane">
          <div class="tbar">
            <label class="ck"><input type="checkbox" v-model="showAllBlocks" /> 显示检测框</label>
            <span class="spacer"></span>
            <span v-if="rows.length" class="cnt">
              {{ rows.length }} 条<template v-if="needAttention"> · <b class="bad">{{ needAttention }}</b> 待核对</template>
            </span>
          </div>

          <div class="tscroll">
            <table v-if="rows.length" class="t">
              <thead>
                <tr>
                  <th>来源</th><th>编号</th><th>上行 MHz</th><th>带宽</th><th>极化</th><th>下行 MHz</th><th>LO</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in rows" :key="row.ch.id" class="fpi-row"
                  :class="{ on: row.ch.id === selectedId, sus: row.suspect }" @click="selectRow(row.ch.id)">
                  <td>
                    <span v-if="row.suspect" class="tag bad" title="OCR 读出的数与频率标度几何推算差得过大 — 已按几何取值，请核对">存疑</span>
                    <span v-else-if="row.geom" class="tag warn" title="该框未读到频率标注，按频率标度几何推算">几何</span>
                    <span v-else-if="row.lowConf" class="tag warn" title="编号识别置信度低">编号?</span>
                    <span v-else class="tag ok" title="OCR 读出且与几何一致">读出</span>
                  </td>
                  <td><input class="ci nar" :value="row.ch.no" @input="setNo(row.ch, $event.target.value)" @click.stop /></td>
                  <td><input class="ci num" :value="row.ch.up.fcMHz ?? ''" @input="setNum(row.ch, 'upFc', $event.target.value)" @click.stop /></td>
                  <td><input class="ci num nar" :value="row.ch.up.bwMHz ?? ''" @input="setNum(row.ch, 'upBw', $event.target.value)" @click.stop /></td>
                  <td>
                    <select class="ci nar" v-model="row.ch.up.pol" @click.stop>
                      <option v-for="p in POLS" :key="p" :value="p">{{ p }}</option>
                    </select>
                  </td>
                  <td class="dnum" :title="row.r.dnDerived ? '由 LO 推算' : '显式指定'">
                    <span v-if="row.r.dn" :class="{ derived: row.r.dnDerived }">{{ row.r.dn.fc.toFixed(2) }}</span>
                    <span v-else class="dim">—</span>
                  </td>
                  <td class="dim">{{ row.r.lo ? row.r.lo.name : '—' }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else-if="imgUrl && !busy" class="none">未识别出转发器</div>
          </div>

          <div v-if="warnings.length || issues.length" class="wpane">
            <div v-for="(w, i) in warnings" :key="'w' + i" class="witem">{{ w }}</div>
            <div v-for="(is, i) in issues.slice(0, 6)" :key="'i' + i" class="witem" :class="is.severity">{{ is.msg }}</div>
          </div>
        </div>
      </div>

      <footer class="dft">
        <span class="dim" v-if="plan">
          识别到 {{ plan.channels.length }} 个转发器 · {{ plan.los.length }} 个 LO · {{ plan.beams.length }} 个波束
        </span>
        <span class="spacer"></span>
        <button class="mini ghost" @click="emit('close')">取消</button>
        <button class="mini imp" :disabled="!plan || !plan.channels.length" @click="confirm">导入为新计划</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.mask { position: fixed; inset: 0; background: rgba(0,0,0,.42); display: flex; align-items: center; justify-content: center; z-index: 90; outline: none; }
.dlg { width: min(1500px, 96vw); height: min(920px, 94vh); background: var(--bg); border: 1px solid var(--border-strong); display: flex; flex-direction: column; }
.dhd { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.dt { font-weight: 600; }
.dsub { color: var(--text-muted); font-size: 12px; }
.spacer { flex: 1; }
.winx { border: none; background: transparent; color: var(--text-muted); cursor: pointer; padding: 4px 8px; }
.winx:hover { background: var(--surface-2); color: var(--text); }

.bar { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--border); background: var(--surface); }
.hint { color: var(--text-faint); font-size: 12px; }
.stat { font-size: 12px; color: var(--text-muted); }
.stat b { color: var(--text); font-variant-numeric: tabular-nums; }
.stat.warn b { color: var(--warn); }
.stat.bad b { color: var(--danger); }
.alert { padding: 6px 10px; background: color-mix(in srgb, var(--danger) 12%, var(--bg)); color: var(--danger); font-size: 12.5px; }

.body { flex: 1; display: grid; grid-template-columns: 1fr 560px; min-height: 0; }
.imgpane { overflow: auto; border-right: 1px solid var(--border); background: var(--surface-2); padding: 8px; }
.drop { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--text-muted); }
.drop p { margin: 0; max-width: 420px; text-align: center; line-height: 1.6; }
.drop .dim { color: var(--text-faint); font-size: 12.5px; }
.imgwrap { position: relative; }
.imgwrap img { display: block; }
.ovl { position: absolute; left: 0; top: 0; pointer-events: none; }
.ob { fill: none; stroke: #1e88e5; stroke-width: 1.2; opacity: .75; }
.ob.geom { stroke: #f9a825; }
.ob.suspect { stroke: #e53935; stroke-width: 2; }
.ob.sel { stroke: #111; stroke-width: 2.4; opacity: 1; }

.tblpane { display: flex; flex-direction: column; min-height: 0; }
.tbar { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 12.5px; }
.ck { display: inline-flex; align-items: center; gap: 5px; color: var(--text-muted); cursor: pointer; }
.cnt { color: var(--text-muted); }
.cnt .bad { color: var(--danger); }
.tscroll { flex: 1; overflow: auto; }
.t { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.t thead th { position: sticky; top: 0; background: var(--surface); border-bottom: 1px solid var(--border-strong); padding: 5px 6px; text-align: left; font-weight: 600; }
.t td { border-bottom: 1px solid var(--border); padding: 2px 6px; }
.fpi-row { cursor: pointer; }
.fpi-row:hover { background: var(--surface); }
.fpi-row.on { background: var(--surface-2); box-shadow: inset 2px 0 0 var(--text); }
.fpi-row.sus { background: color-mix(in srgb, var(--danger) 7%, transparent); }
.ci { width: 100%; background: transparent; border: 1px solid transparent; color: var(--text); padding: 2px 3px; font: inherit; font-family: var(--font-serif); }
.ci:hover { border-color: var(--border); }
.ci:focus { border-color: var(--text); outline: none; background: var(--bg); }
.ci.num { text-align: right; font-variant-numeric: tabular-nums; }
.ci.nar { max-width: 76px; }
.dnum { text-align: right; font-variant-numeric: tabular-nums; }
.dnum .derived { color: var(--text-muted); font-style: italic; }
.dim { color: var(--text-faint); }
.tag { font-size: 11px; padding: 1px 5px; border: 1px solid var(--border-strong); white-space: nowrap; }
.tag.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); }
.tag.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--border)); }
.tag.bad { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.none { padding: 24px; text-align: center; color: var(--text-faint); }
.wpane { max-height: 132px; overflow: auto; border-top: 1px solid var(--border); padding: 6px 10px; background: var(--surface); }
.witem { font-size: 12px; color: var(--text-muted); padding: 2px 0; line-height: 1.5; }
.witem.error { color: var(--danger); }
.witem.warn { color: var(--warn); }

.dft { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--border); }
.mini { font: inherit; font-size: 12.5px; padding: 3px 10px; border: 1px solid var(--border-strong); background: var(--bg); color: var(--text); cursor: pointer; }
.mini:hover:not(:disabled) { background: var(--surface-2); }
.mini:disabled { opacity: .45; cursor: default; }
.mini.imp { background: var(--text); color: var(--bg); border-color: var(--text); }
.mini.ghost { color: var(--text-muted); }
</style>
