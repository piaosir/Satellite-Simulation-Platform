<script setup>
// 导出页（DESIGN §7 / 任务书 §5.7）：glb（LOD 档 / meshopt / 同出 .gmdf 与 .satsim.json / 原点移到质心）+ 缩略图 / 三视图 / 视口截图 PNG。
// 授权闸与主进程同一个 isRedistributable（exporter.exportBlocked）：STK 本机模型整页只剩一句状态，条款写在 title。
// 参数化模板与生成页的临时星在库里没有条目（主进程 models:export 按库里的 meta 过闸），glb 导出只对库里的模型开放；图片照常可出。
// 不可再分发的模型（STK 本机件等）连图片也不出（二期契约 D16：redistributable=false 出图禁止）。
import { ref, reactive, computed, inject, watch } from 'vue'
import Icon from '../components/Icon.vue'
import MdSec from './MdSec.vue'
import { exportBlocked, isStkModel, bakeTargetOf } from '../viz/models/exporter.js'
import { renderThumb, renderThreeView } from '../viz/models/thumbs.js'
import { fmtBytes, fmtInt } from './wbLogic.js'

const wb = inject('wb')
const getVp = inject('viewport')
const { st, cur } = wb
const api = typeof window !== 'undefined' ? window.api : null
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v } catch { return d } }
const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch { /* 便利数据 */ } }

const o = reactive((() => {
  const d = { lod: 'lod0', meshopt: false, gmdf: true, satsim: true, originAtCom: true }
  try { const s = JSON.parse(lsGet('model/export/opts', 'null')); if (s && typeof s === 'object') for (const k of Object.keys(d)) if (typeof s[k] === typeof d[k]) d[k] = s[k] } catch { /* 便利数据 */ }
  d.meshopt = false   // meshopt 缺省不勾，也不记忆（压缩件部分查看器不认）
  return d
})())
watch(o, (v) => lsSet('model/export/opts', JSON.stringify({ ...v, meshopt: false })), { deep: true })

const m = computed(() => cur.meta)
const blocked = computed(() => (m.value ? exportBlocked(m.value) : null))
const stk = computed(() => !!(m.value && isStkModel(m.value)))
const notInLib = computed(() => cur.kind === 'tpl' || cur.kind === 'gen')
const lodPending = computed(() => cur.kind === 'glb' && cur.lod && cur.lod !== 'lod0')
const hasCom = computed(() => !!(m.value && m.value.massProps && Array.isArray(m.value.massProps.comBody)))
// 导出轴向（烘焙目标按类别，exporter.bakeTargetOf）：只进导出钮的 title
const exportTip = computed(() => '另存为 .glb\n' + (m.value && bakeTargetOf(m.value).key === 'yup'
  ? '轴向：glTF +Y 朝上（天顶）、+Z 朝前（飞机 / 船舶 / 车辆 / 地球站：标准 glTF 口径）'
  : '轴向：STK 映射（glTF +Y = 本体 +Z 天底、glTF +Z = 本体 +X 速度向）'))
const canGlb = computed(() => !!api && !!m.value && !blocked.value && !notInLib.value && !lodPending.value && !busy.value && !!wb.currentRoot())
const LODS = [
  { key: 'lod0', label: '原精度', tip: 'lod0：全部三角形' },
  { key: 'lod1', label: '中', tip: 'lod1：抽稀到约 30 %（几何误差 ≤ 1 % 模型尺寸）' },
  { key: 'lod2', label: '低', tip: 'lod2：抽稀到约 10 %（误差 ≤ 2 %），剔除小于误差的孤立小件' }
]
const busy = ref('')
const res = ref(null)          // {path, bytes, nodes, ms, warnings, errors, lodTris}
const err = ref('')
const picState = ref(null)     // {kind, text}
watch(() => cur.id, () => { res.value = null; err.value = ''; picState.value = null })

async function doExport() {
  if (!canGlb.value) return
  busy.value = 'glb'; err.value = ''; res.value = null
  try {
    const r = await wb.exportCurrent({ lod: o.lod, meshopt: o.meshopt, gmdf: o.gmdf, satsim: o.satsim, originAtCom: o.originAtCom && hasCom.value })
    if (r && !r.canceled) res.value = r
  } catch (e) { err.value = (e && e.message) || String(e) }
  finally { busy.value = '' }
}

// ---------- 图片 ----------
const safeName = () => String(wb.displayTitle(m.value) || 'model').replace(/[\\/:*?"<>|]+/g, '_')
async function savePng(blob, name) {
  if (!api || typeof api.exportFile !== 'function') return
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const r = await api.exportFile({ defaultName: name, filters: [{ name: 'PNG', extensions: ['png'] }], data: bytes })
  if (r && r.locked) return
  if (r && r.ok) picState.value = { kind: 'ok', text: r.filePath }
  else if (r && !r.canceled) picState.value = { kind: 'bad', text: r.error || '保存失败' }
}
const thumbSize = ref(Number(lsGet('model/export/thumb', '1024')) || 1024)
watch(thumbSize, (v) => lsSet('model/export/thumb', String(v)))
async function exportThumb() {
  const root = wb.currentRoot()
  if (!root || !m.value) return
  busy.value = 'thumb'; picState.value = null
  try { await savePng(await renderThumb(root, wb.viewMeta(), { size: thumbSize.value, type: 'image/png' }), safeName() + '_thumb.png') }
  catch (e) { picState.value = { kind: 'bad', text: (e && e.message) || String(e) } }
  finally { busy.value = '' }
}
async function exportThreeView() {
  const root = wb.currentRoot()
  if (!root || !m.value) return
  busy.value = 'three'; picState.value = null
  try { await savePng(await renderThreeView(root, wb.viewMeta(), { cell: 800 }), safeName() + '_三视图.png') }
  catch (e) { picState.value = { kind: 'bad', text: (e && e.message) || String(e) } }
  finally { busy.value = '' }
}
const SHOT_SIZES = [{ key: '1920x1080', w: 1920, h: 1080 }, { key: '2560x1440', w: 2560, h: 1440 }, { key: '3840x2160', w: 3840, h: 2160 }]
const shotSize = ref(SHOT_SIZES.some((s) => s.key === lsGet('model/export/shot', '')) ? lsGet('model/export/shot', '') : '1920x1080')
watch(shotSize, (v) => lsSet('model/export/shot', v))
const shotBg = ref(lsGet('model/export/shotBg', 'bg') === 'clear' ? 'clear' : 'bg')
watch(shotBg, (v) => lsSet('model/export/shotBg', v))
async function exportShot() {
  const vp = getVp()
  if (!vp || !m.value) return
  const s = SHOT_SIZES.find((x) => x.key === shotSize.value) || SHOT_SIZES[0]
  busy.value = 'shot'; picState.value = null
  try { await savePng(await vp.snapshot({ w: s.w, h: s.h, transparent: shotBg.value === 'clear' }), safeName() + '_视图.png') }
  catch (e) { picState.value = { kind: 'bad', text: (e && e.message) || String(e) } }
  finally { busy.value = '' }
}
const STK_TIP = 'AGI 软件许可协议（SLA）§2(k)、§2.3(d)：STK 随附模型只能在 STK 内使用，不得拆出另行分发'
</script>

<template>
  <div class="ex">
    <div v-if="!m" class="lb-placeholder">未选中模型。</div>
    <div v-else-if="blocked" class="md-state warn ex-block" :title="stk ? STK_TIP : (m.source && m.source.license) || ''"><Icon name="lock" :size="13" />{{ blocked }}</div>
    <template v-else>
      <MdSec id="x-glb" title="glTF 二进制（.glb）">
          <div v-if="notInLib" class="md-state warn" title="参数化模板与生成页的临时星没有库条目；在「生成」页改参数后「保存到库」即可导出"><Icon name="alert-triangle" :size="12" />未保存到库。</div>
          <div v-if="lodPending" class="md-state"><span class="ex-spin"></span><span data-i18n-skip>{{ cur.lod }} → lod0</span></div>
          <div class="srow"><label title="导出档：几何抽稀程度">精度</label>
            <div class="lbu-seg ex-seg">
              <button v-for="l in LODS" :key="l.key" :class="{ on: o.lod === l.key }" :title="l.tip" @click="o.lod = l.key">{{ l.label }}</button>
            </div></div>
          <label class="md-chkrow" title="EXT_meshopt_compression：体积约为原来的 1/4；部分查看器（含较老版本 STK）不认"><input v-model="o.meshopt" type="checkbox" />meshopt 压缩</label>
          <label class="md-chkrow" title="同名 .gmdf 旁车（AGI 挂点 / 关节 / 太阳翼组；STK 读取时整份替代内嵌元数据）"><input v-model="o.gmdf" type="checkbox" />同时写 .gmdf</label>
          <label class="md-chkrow" title="同名 .satsim.json（完整元数据：单位、本体轴、质量特性、部件、挂点）"><input v-model="o.satsim" type="checkbox" />同时写 .satsim.json</label>
          <label class="md-chkrow" :class="{ dim: !hasCom }" :title="hasCom ? '平移模型使质心落在导出件原点（平移量记进 frame.t_model2body）' : '没有质量特性'"><input v-model="o.originAtCom" type="checkbox" :disabled="!hasCom" />原点移到质心</label>
          <div class="md-acts">
            <button class="lb-mini primary ex-go" :disabled="!canGlb" :title="exportTip" @click="doExport"><Icon name="download" :size="13" />{{ busy === 'glb' ? '导出中…' : '导出…' }}</button>
          </div>
          <div v-if="err" class="md-state bad" :title="err"><Icon name="alert-triangle" :size="12" /><span class="ex-t" data-i18n-skip>{{ err }}</span></div>
          <div v-if="res" class="md-kvs ex-res">
            <div class="md-kv" :title="res.path"><span class="k">文件</span><span class="v ex-path" data-i18n-skip>{{ res.path }}</span></div>
            <div class="md-kv"><span class="k">大小</span><span class="v" data-i18n-skip>{{ fmtBytes(res.bytes) }}</span></div>
            <div class="md-kv"><span class="k">节点</span><span class="v" data-i18n-skip>{{ fmtInt(res.nodes) }}</span></div>
            <div v-if="res.lodTris" class="md-kv" :title="JSON.stringify(res.lodTris)"><span class="k">三角形</span><span class="v" data-i18n-skip>{{ fmtInt(res.lodTris.tris1) }} / {{ fmtInt(res.lodTris.tris0) }}</span></div>
            <div class="md-kv"><span class="k">耗时</span><span class="v" data-i18n-skip>{{ fmtInt(res.ms) }}</span><span class="u">ms</span></div>
            <div v-if="res.warnings && res.warnings.length" class="md-kv" :title="res.warnings.join('\n')"><span class="k">告警</span><span class="v" data-i18n-skip>{{ res.warnings.length }}</span></div>
          </div>
      </MdSec>

      <MdSec id="x-img" title="图片">
          <div class="srow"><label title="3/4 视角、透明底、影棚光">缩略图</label>
            <select v-model.number="thumbSize" class="ci ex-sz"><option :value="512">512</option><option :value="1024">1024</option><option :value="2048">2048</option></select>
            <span class="u">px</span>
            <button class="lb-mini" :disabled="!!busy || !wb.currentRoot()" @click="exportThumb"><Icon name="image" :size="12" />导出…</button>
          </div>
          <div class="srow"><label title="前 / 侧 / 顶正交三视图 + 透视，同一比例尺，挂点引线与名称、本体轴、比例尺">三视图</label>
            <span class="ex-fill"></span>
            <button class="lb-mini" :disabled="!!busy || !wb.currentRoot()" @click="exportThreeView"><Icon name="grid-3x3" :size="12" />导出…</button>
          </div>
          <div class="srow"><label title="按当前视角与画质重画一帧（含叠加层）">视图</label>
            <select v-model="shotSize" class="ci ex-sz"><option v-for="s in SHOT_SIZES" :key="s.key" :value="s.key" data-i18n-skip>{{ s.w }} × {{ s.h }}</option></select>
            <div class="lbu-seg ex-bg">
              <button :class="{ on: shotBg === 'bg' }" title="带背景" @click="shotBg = 'bg'">背景</button>
              <button :class="{ on: shotBg === 'clear' }" title="透明底" @click="shotBg = 'clear'">透明</button>
            </div>
            <button class="lb-mini" :disabled="!!busy || !cur.meta" @click="exportShot"><Icon name="image" :size="12" />导出…</button>
          </div>
          <div v-if="busy && busy !== 'glb'" class="md-state"><span class="ex-spin"></span></div>
          <div v-if="picState" class="md-state" :class="picState.kind === 'bad' ? 'bad' : 'ok'" :title="picState.text">
            <Icon :name="picState.kind === 'bad' ? 'alert-triangle' : 'check'" :size="12" /><span class="ex-t" data-i18n-skip>{{ picState.text }}</span>
          </div>
      </MdSec>
    </template>
  </div>
</template>

<style scoped>
.ex { display: flex; flex-direction: column; gap: 2px; }
.ex-block { font-size: var(--fs-3); padding: 4px 0; }
.ex-seg, .ex-bg { display: flex; }
.ex-seg { flex: 1 1 auto; }
.ex-seg > button, .ex-bg > button { flex: 1 1 auto; height: var(--h-ctl); padding-top: 0; padding-bottom: 0; font-size: var(--fs-3); }
.ex-go { height: var(--h-ctl-lg) !important; padding: 0 16px !important; font-size: var(--fs-3) !important; }
.ex-res { margin-top: 4px; grid-template-columns: 1fr; }
.ex-path { font-family: var(--font-ui) !important; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; max-width: 260px; }
.ex-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ex-sz { flex: none !important; width: 110px; min-width: 0 !important; }
.ex-fill { flex: 1; }
.ex-spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--text) 18%, transparent); border-top-color: var(--accent-ui); animation: ex-spin .7s linear infinite; }
@keyframes ex-spin { to { transform: rotate(360deg); } }
</style>
