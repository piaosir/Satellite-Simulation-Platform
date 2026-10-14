<script setup>
// 导出页（DESIGN §7 / 任务书 §5.7）：glb（LOD 档 / meshopt / 同出 .gmdf 与 .satsim.json / 原点移到质心）+ 缩略图 / 三视图 / 视口截图 PNG。
// 授权闸与主进程同一个 isRedistributable（exporter.exportBlocked）：STK 本机模型整页只剩一句状态，条款写在 title。
// 模板（参数化整星 / 实体模板）在库里没有条目（主进程 models:export 按库里的 meta 过闸），glb 导出只对库里的模型开放；图片照常可出。
// 不可再分发的模型（STK 本机件等）连图片也不出（二期契约 D16：redistributable=false 出图禁止）。
// 导出对象（2026-10-06 任务书 §3.1）：顶部下拉 = 已打开的签 + 库中选中项（wb.exportTargets），缺省按来处（设计页 → 激活签、库页 → 库选中项，
// wbStore 进页时定）。选定后 wb.loadExportTarget 把它载进 cur（lod0），下面各处（授权闸 / 质心 / 库条目 / 缩略图 / 三视图 / 截图）都按 cur，
// 只在 cur 就是导出对象时可用（ready）。装配签：待存的改动先入库、按 id 读库里那份；从未入库的，「导出」先入库再导出（授权闸仍在主进程）。
import { ref, reactive, computed, inject, watch, onBeforeUnmount } from 'vue'
import Icon from '../components/Icon.vue'
import MdSec from './MdSec.vue'
import { exportBlocked, isStkModel, bakeTargetOf } from '../viz/models/exporter.js'
import { renderThumb, renderThreeView } from '../viz/models/thumbs.js'
import { fmtBytes, fmtInt } from './wbLogic.js'
import { curLang } from '../shared/i18n/lang.js'
import { onLangChange } from '../shared/i18n/runtime.js'

const wb = inject('wb')
// 窗口通知条（ModelApp 的 useNotice）：导出成功给一句「已导出 · 打开 · 在文件夹中显示」
const notice = inject('notice', null)
const receipt = (p) => { if (notice && p) notice.toastFile('已导出：' + String(p).split(/[\\/]/).pop(), p) }
// 「透明」在词典里是透明转发（Bent pipe），这里是透明背景：按语言直接出字
const langNow = ref(curLang())
const offLang = onLangChange(() => { langNow.value = curLang() })
onBeforeUnmount(() => offLang())
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

// ── 导出对象 ──
const targets = computed(() => { void st.docs.length; void st.selId; void st.list; return wb.exportTargets() })
const tDocs = computed(() => targets.value.filter((t) => t.group === 'doc'))
const tLib = computed(() => targets.value.filter((t) => t.group === 'lib'))
const tgt = computed(() => { void st.docs.length; void st.list; return wb.exportTargetOf(st.exportTarget) })
// 未入库的装配签（新文档 / 已分叉还没入库的副本）：「导出」先入库
const pendingAsm = computed(() => !!tgt.value && tgt.value.kind === 'asm' && !tgt.value.libId)
const pendingOk = computed(() => pendingAsm.value && !tgt.value.d.empty && !tgt.value.d.invalid)
// cur 就是导出对象（载完）：下面各处才按 cur 取
const ready = computed(() => !!tgt.value && !!tgt.value.libId && cur.id === tgt.value.libId && !!cur.meta && !cur.loading)
const loadingTgt = computed(() => !!tgt.value && !!tgt.value.libId && !ready.value && !cur.error)
function setTarget(k) { st.exportTarget = k }
// 进导出页 / 换导出对象 / 装配签入库后（libId 有了）：载进 cur
watch(() => [st.tab, st.exportTarget, tgt.value ? tgt.value.libId : ''], () => {
  if (st.tab !== 'export') return
  if (!tgt.value && targets.value.length) { st.exportTarget = targets.value[0].key; return }
  if (tgt.value) wb.loadExportTarget(st.exportTarget)
}, { immediate: true })

const m = computed(() => (ready.value ? cur.meta : null))
const blocked = computed(() => (m.value ? exportBlocked(m.value) : null))
const stk = computed(() => !!(m.value && isStkModel(m.value)))
const notInLib = computed(() => !!m.value && (cur.kind === 'tpl' || cur.kind === 'gen'))
// 全精度在路上（升档 / 下载中）vs 拿不到（离线、只有随包低档：wb.fullDetailMissing）——后者不挂转圈，只给状态
const lowLod = computed(() => ready.value && cur.kind === 'glb' && !!cur.lod && cur.lod !== 'lod0')
const noFull = computed(() => lowLod.value && wb.fullDetailMissing(cur.id))
const lodPending = computed(() => lowLod.value && !noFull.value)
const hasCom = computed(() => !!(m.value && m.value.massProps && Array.isArray(m.value.massProps.comBody)))
// 导出轴向（烘焙目标按类别，exporter.bakeTargetOf）：只进导出钮的 title
const exportTip = computed(() => '另存为 .glb\n' + (m.value && bakeTargetOf(m.value).key === 'yup'
  ? '轴向：glTF +Y 朝上（天顶）、+Z 朝前（飞机 / 船舶 / 车辆 / 地球站：标准 glTF 约定）'
  : '轴向：STK 映射（glTF +Y = 本体 +Z 天底、glTF +Z = 本体 +X 速度方向）'))
const canGlb = computed(() => !!api && !busy.value && (pendingAsm.value ? pendingOk.value : (!!m.value && !blocked.value && !notInLib.value && !lowLod.value && !!wb.currentRoot())))
const LODS = [
  { key: 'lod0', label: '原精度', tip: 'lod0：全部三角形' },
  { key: 'lod1', label: '中', tip: 'lod1：抽稀至约 30 %（几何误差 ≤ 1 % 模型尺寸）' },
  { key: 'lod2', label: '低', tip: 'lod2：抽稀至约 10 %（误差 ≤ 2 %），剔除尺寸小于误差的孤立小部件' }
]
const busy = ref('')
const res = ref(null)          // {path, bytes, nodes, ms, warnings, errors, lodTris}
const err = ref('')
const picState = ref(null)     // {kind, text}
watch(() => [cur.id, st.exportTarget], () => { res.value = null; err.value = ''; picState.value = null })

async function doExport() {
  if (!canGlb.value) return
  busy.value = 'glb'; err.value = ''; res.value = null
  try {
    // 未入库的装配签：先入库（授权闸在主进程按引用现算），再按 id 读库里那份导出
    if (!ready.value) {
      const key = st.exportTarget
      const id = await wb.loadExportTarget(key, { save: true })
      if (st.exportTarget !== key) return
      if (!id || !ready.value) { const d = tgt.value && tgt.value.d; err.value = (d && d.saveErr) || '未入库。'; return }
      if (blocked.value || notInLib.value) return
    }
    const r = await wb.exportCurrent({ lod: o.lod, meshopt: o.meshopt, gmdf: o.gmdf, satsim: o.satsim, originAtCom: o.originAtCom && hasCom.value })
    if (r && !r.canceled) { res.value = r; receipt(r.path) }
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
  if (r && r.ok) { picState.value = { kind: 'ok', text: r.path || r.filePath }; receipt(r.path || r.filePath) }
  else if (r && !r.canceled) picState.value = { kind: 'bad', text: r.error || '保存失败' }
}
const thumbSize = ref(Number(lsGet('model/export/thumb', '1024')) || 1024)
watch(thumbSize, (v) => lsSet('model/export/thumb', String(v)))
async function exportThumb() {
  const root = wb.currentRoot()
  if (!root || !m.value || !ready.value) return
  busy.value = 'thumb'; picState.value = null
  try { await savePng(await renderThumb(root, wb.viewMeta(), { size: thumbSize.value, type: 'image/png' }), safeName() + '_thumb.png') }
  catch (e) { picState.value = { kind: 'bad', text: (e && e.message) || String(e) } }
  finally { busy.value = '' }
}
async function exportThreeView() {
  const root = wb.currentRoot()
  if (!root || !m.value || !ready.value) return
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
  if (!vp || !m.value || !ready.value) return
  const s = SHOT_SIZES.find((x) => x.key === shotSize.value) || SHOT_SIZES[0]
  busy.value = 'shot'; picState.value = null
  try { await savePng(await vp.snapshot({ w: s.w, h: s.h, transparent: shotBg.value === 'clear' }), safeName() + '_视图.png') }
  catch (e) { picState.value = { kind: 'bad', text: (e && e.message) || String(e) } }
  finally { busy.value = '' }
}
const STK_TIP = 'AGI 软件许可协议（SLA）§2(k)、§2.3(d)：STK 随附模型仅限在 STK 内使用，不得单独分发'
</script>

<template>
  <div class="ex">
    <div v-if="targets.length" class="srow ex-tgt"><label title="已打开的签与库中选中的模型">导出对象</label>
      <select class="ci" data-act="export-target" :value="st.exportTarget" @change="setTarget($event.target.value)">
        <optgroup v-if="tDocs.length" label="已打开">
          <option v-for="t in tDocs" :key="t.key" :value="t.key" data-i18n-skip>{{ t.label }}</option>
        </optgroup>
        <optgroup v-if="tLib.length" label="库">
          <option v-for="t in tLib" :key="t.key" :value="t.key" data-i18n-skip>{{ t.label }}</option>
        </optgroup>
      </select>
    </div>
    <div v-if="!tgt" class="lb-placeholder">未选择模型。</div>
    <div v-else-if="loadingTgt" class="md-state"><span class="ex-spin"></span></div>
    <div v-else-if="!m && !pendingAsm && cur.error" class="md-state bad"><Icon name="alert-triangle" :size="12" /><span class="ex-t">{{ cur.error }}</span></div>
    <div v-else-if="!m && !pendingAsm" class="lb-placeholder">未选择模型。</div>
    <div v-else-if="blocked" class="md-state warn ex-block" :title="stk ? STK_TIP : (m.source && m.source.license) || ''"><Icon name="lock" :size="12" />{{ blocked }}</div>
    <template v-else>
      <MdSec id="x-glb" title="glTF 二进制（.glb）">
          <div v-if="notInLib" class="md-state warn" title="模板没有库条目；在设计页编辑后自动创建的副本可导出"><Icon name="alert-triangle" :size="12" />未保存到库。</div>
          <div v-if="pendingAsm" class="md-state" data-ex-pending>未入库。</div>
          <div v-if="lodPending" class="md-state"><span class="ex-spin"></span><span data-i18n-skip>{{ cur.lod }} → lod0</span></div>
          <div v-else-if="noFull" class="md-state warn"><Icon name="alert-triangle" :size="12" />完整精度模型不可用。</div>
          <div class="srow"><label title="导出精度：几何抽稀程度">精度</label>
            <div class="lbu-seg ex-seg">
              <button v-for="l in LODS" :key="l.key" :class="{ on: o.lod === l.key }" :aria-pressed="(o.lod === l.key) ? 'true' : 'false'" :title="l.tip" @click="o.lod = l.key">{{ l.label }}</button>
            </div></div>
          <label class="md-chkrow" title="EXT_meshopt_compression：文件体积约为原来的 1/4；部分查看器（含较早版本 STK）不支持"><input v-model="o.meshopt" type="checkbox" />meshopt 压缩</label>
          <label class="md-chkrow" title="同名 .gmdf 附属文件（AGI 挂点 / 关节 / 太阳翼组；STK 读取时整体替代内嵌元数据）"><input v-model="o.gmdf" type="checkbox" />同时导出 .gmdf</label>
          <label class="md-chkrow" title="同名 .satsim.json（完整元数据：单位、本体轴、质量特性、部件、挂点）"><input v-model="o.satsim" type="checkbox" />同时导出 .satsim.json</label>
          <label class="md-chkrow" :class="{ dim: !hasCom }" :title="hasCom ? '平移模型使质心与导出模型原点重合（平移量记入 frame.t_model2body）' : '无质量特性'"><input v-model="o.originAtCom" type="checkbox" :disabled="!hasCom" />原点移到质心</label>
          <div class="md-acts">
            <button class="lb-mini primary ex-go" :disabled="!canGlb" :title="exportTip" @click="doExport"><Icon name="file-export" :size="12" />{{ busy === 'glb' ? '导出中…' : '导出…' }}</button>
          </div>
          <div v-if="err" class="md-state bad" :title="err"><Icon name="alert-triangle" :size="12" /><span class="ex-t">{{ err }}</span></div>
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
          <div class="srow"><label title="3/4 视角、透明背景、影棚光照">缩略图</label>
            <select v-model.number="thumbSize" class="ci ex-sz"><option :value="512">512</option><option :value="1024">1024</option><option :value="2048">2048</option></select>
            <span class="u">px</span>
            <button class="lb-mini" :disabled="!!busy || !ready || !wb.currentRoot()" @click="exportThumb"><Icon name="image" :size="12" />导出…</button>
          </div>
          <div class="srow"><label title="前 / 侧 / 顶正交三视图 + 透视，同一比例尺，挂点引线与名称、本体轴、比例尺">三视图</label>
            <span class="ex-fill"></span>
            <button class="lb-mini" :disabled="!!busy || !ready || !wb.currentRoot()" @click="exportThreeView"><Icon name="grid-2x2" :size="12" />导出…</button>
          </div>
          <div class="srow"><label title="按当前视角与画质重新渲染一帧（含叠加层）">视图</label>
            <select v-model="shotSize" class="ci ex-sz"><option v-for="s in SHOT_SIZES" :key="s.key" :value="s.key" data-i18n-skip>{{ s.w }} × {{ s.h }}</option></select>
            <div class="lbu-seg ex-bg">
              <button :class="{ on: shotBg === 'bg' }" :aria-pressed="(shotBg === 'bg') ? 'true' : 'false'" title="带背景" @click="shotBg = 'bg'">背景</button>
              <button :class="{ on: shotBg === 'clear' }" :aria-pressed="(shotBg === 'clear') ? 'true' : 'false'" title="透明背景" @click="shotBg = 'clear'"><span data-i18n-skip>{{ langNow === 'en' ? 'Transparent' : '透明' }}</span></button>
            </div>
            <button class="lb-mini" :disabled="!!busy || !ready" @click="exportShot"><Icon name="image" :size="12" />导出…</button>
          </div>
          <div v-if="busy && busy !== 'glb'" class="md-state"><span class="ex-spin"></span></div>
          <div v-if="picState" class="md-state" :class="picState.kind === 'bad' ? 'bad' : 'ok'" :title="picState.text">
            <Icon :name="picState.kind === 'bad' ? 'alert-triangle' : 'check'" :size="12" /><span class="ex-t" :data-i18n-skip="picState.kind === 'ok' ? '' : null">{{ picState.text }}</span>
          </div>
      </MdSec>
    </template>
  </div>
</template>

<style scoped>
.ex { display: flex; flex-direction: column; gap: 2px; }
.ex-block { font-size: var(--fs-3); padding: 4px 0; }
.ex-tgt { margin-bottom: 4px; }
.ex-tgt > select { flex: 1 1 auto; min-width: 0; }
.ex-seg, .ex-bg { display: flex; }
.ex-seg { flex: 1 1 auto; }
.ex-seg > button, .ex-bg > button { flex: 1 1 auto; height: var(--h-ctl); padding-top: 0; padding-bottom: 0; font-size: var(--fs-3); }
.ex-go { height: var(--h-ctl-lg) !important; padding: 0 16px !important; font-size: var(--fs-3) !important; }
.ex-res { margin-top: 4px; grid-template-columns: 1fr; }
.ex-path { font-family: var(--font-ui) !important; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; max-width: 260px; }
.ex-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ex-sz { flex: none !important; width: 110px; min-width: 0 !important; }
.ex-fill { flex: 1; }
.ex-spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--text) 18%, transparent); border-top-color: var(--accent-ui); animation: ui-spin .7s linear infinite; }
</style>
