<script setup>
// 「导入星历」对话框：主进程预览好的文件逐个列出，点序列星逐颗选「新建卫星」或「对应已有卫星」，确认后一次提交。
//   · 预览由主进程做（omm:importPick / omm:importPreview）：解析、编码识别、逐星按几何找候选（编目 / 自定义库 / 别的导入星）；
//     候选按距离排，建议项（足够近、与次近者拉得开或名字对得上）缺省选中。
//   · 「其它卫星…」：用宿主给的 searchSats(q) 在全量目录里挑任意一颗。
//   · 平均根数文件（OMM / TLE / 年历）按编号认星，没有对应关系可选，只列读数。
//   · mode='rebind'：给已导入的点序列组改对应关系（预览来自 omm:rebindPreview，提交由宿主逐星 ephemRebind）。
// 对话框壳自带（ephi- 前缀、z 300），不依赖宿主窗口的 CSS（同 LinkImportDialog 的做法）。
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import Icon from './Icon.vue'
import { byLang } from '../shared/i18n/lang.js'

const props = defineProps({
  previews: { type: Array, default: () => [] },
  // (q) => [{ noradId, name, groupLabel }]：任意卫星检索（宿主的全量目录）
  searchSats: { type: Function, default: null },
  mode: { type: String, default: 'import' },       // 'import' | 'rebind'
  z: { type: Number, default: 300 }                 // 叠在别的模态（文件管理 z 2000）之上时调高
})
const rebind = computed(() => props.mode === 'rebind')
const emit = defineEmits(['commit', 'close'])

const p2 = (n) => String(n).padStart(2, '0')
const utc = (ms) => { if (!Number.isFinite(ms)) return '—'; const d = new Date(ms); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` }
const utcS = (ms) => { if (!Number.isFinite(ms)) return '—'; const d = new Date(ms); return `${utc(ms)}:${p2(d.getUTCSeconds())}` }
const FRAME_TXT = { FIXED: '地固系', J2000: 'J2000', TEME: 'TEME', TOD: '真赤道', MOD: '平赤道' }
const ENC_TXT = { 'utf-8': 'UTF-8', 'utf-16le': 'UTF-16LE', 'utf-16be': 'UTF-16BE', gb18030: 'GBK', latin1: 'Latin-1', text: '' }
const fmtKm = (d) => (d < 10 ? d.toFixed(2) : d < 1000 ? d.toFixed(1) : d.toFixed(0))
const fmtStep = (s) => (!Number.isFinite(s) ? '—' : s >= 3600 && s % 3600 === 0 ? s / 3600 + ' h' : s >= 60 && s % 60 === 0 ? s / 60 + ' min' : s + ' s')

// 每个文件一份可编辑状态：组名 + 逐星目标（'' = 新建卫星；'n:<NORAD>' = 对应该星）
const state = reactive({})
const picked = reactive({})      // `${token}#${idx}` -> { noradId, name }（「其它卫星…」挑中的）
for (const p of props.previews) {
  if (!p || !p.token) continue
  // 缺省目标：改对应时先认现有的对应关系；其余取建议项（没有建议 = 新建卫星）
  state[p.token] = { name: p.name || '', targets: (p.sats || []).map((s) => (p.kind !== 'ephem' ? '' : (s.bind ? 'n:' + s.bind.noradId : (rebind.value ? '' : (s.suggest ? 'n:' + s.suggest : ''))))) }
  ;(p.sats || []).forEach((s, i) => { if (s.bind) picked[p.token + '#' + i] = { noradId: String(s.bind.noradId), name: s.bind.name || '' } })
}
const files = computed(() => props.previews.filter(Boolean))
const okFiles = computed(() => files.value.filter((p) => p.token && p.ok))
const satCount = computed(() => okFiles.value.reduce((n, p) => n + (p.kind === 'ephem' ? (p.sats || []).filter((s) => s.valid !== false).length : (p.count || 0)), 0))
const boundCount = computed(() => okFiles.value.reduce((n, p) => n + (p.kind === 'ephem' ? state[p.token].targets.filter(Boolean).length : 0), 0))

function candLabel(c) { return `${c.name} · ${c.noradId} · Δ ${fmtKm(c.distKm)} km` }
// 悬停说明里混着数据，整串在生成时按语言出字（词典查不到拼出来的整串）
function candTitle(c) {
  const src = c.kind === 'ephem' ? byLang('导入星历', 'Imported ephemeris') : (c.kind === 'custom' ? byLang('自定义卫星', 'Custom satellite') : byLang('编目卫星', 'Catalog satellite'))
  const g = c.groupName ? ' · ' + c.groupName : ''
  return byLang(`${c.name}（${c.noradId}）｜${src}${g}｜与导入星历同一时刻的位置差 ${fmtKm(c.distKm)} km（${utcS(c.tRef)} UTC）`,
    `${c.name} (${c.noradId}) | ${src}${g} | Position difference from the imported ephemeris at the same epoch: ${fmtKm(c.distKm)} km (${utcS(c.tRef)} UTC)`)
}
const colTitle = (s) => byLang((s.hasVel ? '位置 + 速度' : '仅位置') + (s.unitPos ? ' · ' + s.unitPos + (s.unitVel ? ' / ' + s.unitVel : '') : '') + ' · ' + s.timeScale,
  (s.hasVel ? 'Position + velocity' : 'Position only') + (s.unitPos ? ' · ' + s.unitPos + (s.unitVel ? ' / ' + s.unitVel : '') : '') + ' · ' + s.timeScale)
// 下拉选项：新建 / 候选 / 「其它卫星…」挑中的那颗 / 「其它卫星…」
function options(p, s, i) {
  const out = [{ v: '', t: rebind.value ? '不对应（独立卫星）' : '新建卫星' }]
  for (const c of (s.candidates || [])) out.push({ v: 'n:' + c.noradId, t: candLabel(c), title: candTitle(c) })
  const pk = picked[p.token + '#' + i]
  if (pk && !out.some((o) => o.v === 'n:' + pk.noradId)) out.push({ v: 'n:' + pk.noradId, t: `${pk.name} · ${pk.noradId}` })
  if (props.searchSats) out.push({ v: '?', t: '其它卫星…' })
  return out
}
const searchKey = ref('')        // 正在检索的那一行 `${token}#${idx}`
const searchQ = ref('')
const searchHits = ref([])
const searchEl = ref(null)
function onTarget(p, i, v, ev) {
  if (v === '?') {
    // 下拉先退回当前值（挑中之前它不是一个选择）；检索行展开在该星下方
    if (ev && ev.target) ev.target.value = state[p.token].targets[i]
    searchKey.value = p.token + '#' + i; searchQ.value = ''; searchHits.value = []
    // 检索框在 v-for 里：模板 ref 编译成 ref_for，searchEl 拿到的是数组 [input]（同一时刻只展开一行，取第一个）
    nextTick(() => { try { const el = Array.isArray(searchEl.value) ? searchEl.value[0] : searchEl.value; if (el) el.focus() } catch { /* ignore */ } })
    return
  }
  state[p.token].targets[i] = v
  if (searchKey.value === p.token + '#' + i) searchKey.value = ''
}
let searchT = 0
function onSearch() {
  clearTimeout(searchT)
  const q = searchQ.value.trim()
  if (!q || !props.searchSats) { searchHits.value = []; return }
  searchT = setTimeout(async () => {
    try { const r = await props.searchSats(q); searchHits.value = (Array.isArray(r) ? r : []).slice(0, 30) } catch { searchHits.value = [] }
  }, 120)
}
function pickHit(h) {
  const [token, idx] = searchKey.value.split('#')
  if (!token || !state[token]) return
  picked[searchKey.value] = { noradId: String(h.noradId), name: h.name }
  state[token].targets[+idx] = 'n:' + h.noradId
  searchKey.value = ''
}
function closeSearch() { searchKey.value = '' }

// 目标显示名（提交时随 NORAD 一起带上，库里记目标名供界面读数）
function targetOf(p, s, i) {
  const v = state[p.token].targets[i]
  if (!v || v[0] !== 'n') return null
  const id = v.slice(2)
  const c = (s.candidates || []).find((x) => String(x.noradId) === id)
  const pk = picked[p.token + '#' + i]
  return { noradId: id, name: c ? c.name : (pk && String(pk.noradId) === id ? pk.name : '') }
}
function commit() {
  const list = []
  for (const p of okFiles.value) {
    const st = state[p.token]
    list.push({
      token: p.token, label: p.fileName || p.name, name: (st.name || '').trim() || p.name,
      binds: p.kind === 'ephem' ? (p.sats || []).map((s, i) => targetOf(p, s, i)) : []
    })
  }
  if (list.length) emit('commit', list)
}
// 缺口 / 机动读数：列出拆段的与 > 1.5 倍步长的
const gapText = (g) => `${utcS(g.t0)} → ${utcS(g.t1)}（${fmtStep(Math.round(g.dtS))}）`

function onKey(e) {
  if (e.key !== 'Escape' || e.isComposing) return
  e.preventDefault(); e.stopPropagation()
  if (searchKey.value) { closeSearch(); return }
  emit('close')
}
onMounted(() => document.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => { document.removeEventListener('keydown', onKey, true); clearTimeout(searchT) })
</script>

<template>
  <div class="ephi-mask" :style="{ zIndex: z }" @mousedown.self="emit('close')">
    <div class="ephi-dlg" role="dialog" aria-modal="true">
      <div class="ephi-hd">
        <span>{{ rebind ? '对应已有卫星' : '导入星历' }}</span>
        <button type="button" class="ephi-x" aria-label="关闭" title="关闭" @click="emit('close')"><Icon name="x" :size="12" /></button>
      </div>
      <div class="ephi-body">
        <section v-for="p in files" :key="p.token || p.fileName" class="ephi-file" :class="{ bad: !p.ok }">
          <div class="ephi-fh">
            <Icon :name="p.kind === 'ephem' ? 'clock' : 'import'" :size="13" />
            <span class="ephi-fn" data-i18n-skip :title="p.fileName">{{ p.fileName }}</span>
            <span v-if="p.formatLabel" class="ephi-tag">{{ p.formatLabel }}</span>
            <span v-if="p.encoding && ENC_TXT[p.encoding]" class="ephi-tag dim" title="文件编码">{{ ENC_TXT[p.encoding] }}</span>
          </div>
          <div v-if="!p.ok" class="ephi-err">{{ p.error || (p.errors && p.errors[0]) || '无法识别的星历格式' }}</div>
          <template v-else>
            <label v-if="!rebind" class="ephi-row">
              <span class="ephi-k">组名</span>
              <input v-model="state[p.token].name" type="text" class="ephi-in" spellcheck="false" />
            </label>
            <!-- 点序列：逐星选对应 -->
            <table v-if="p.kind === 'ephem'" class="ephi-tbl">
              <thead>
                <tr><th>卫星</th><th class="num">点数</th><th>时段（UTC）</th><th class="num">步长</th><th>坐标系</th><th class="tgt">对应</th></tr>
              </thead>
              <tbody>
                <template v-for="(s, i) in p.sats" :key="i">
                  <tr :class="{ off: s.valid === false }">
                    <td class="nm" data-i18n-skip :title="s.name">{{ s.name }}</td>
                    <td class="num">{{ s.n }}</td>
                    <td class="dt">{{ utc(s.t0) }} → {{ utc(s.t1) }}</td>
                    <td class="num">{{ fmtStep(s.stepS) }}</td>
                    <td :title="colTitle(s)">{{ FRAME_TXT[s.frame] || s.frame }}</td>
                    <td class="tgt">
                      <select v-if="s.valid !== false" class="ephi-sel" :value="state[p.token].targets[i]" @change="onTarget(p, i, $event.target.value, $event)">
                        <option v-for="o in options(p, s, i)" :key="o.v" :value="o.v" :title="o.title || o.t">{{ o.t }}</option>
                      </select>
                      <span v-else class="ephi-dim">无有效采样点</span>
                    </td>
                  </tr>
                  <tr v-if="searchKey === p.token + '#' + i" class="ephi-srow">
                    <td colspan="6">
                      <div class="ephi-search">
                        <Icon name="search" :size="12" />
                        <input ref="searchEl" v-model="searchQ" type="search" class="ephi-in" placeholder="名称 / NORAD" spellcheck="false" @input="onSearch" />
                        <button type="button" class="ephi-x" title="关闭" @click="closeSearch"><Icon name="x" :size="11" /></button>
                      </div>
                      <div v-if="searchHits.length" class="ephi-hits">
                        <div v-for="h in searchHits" :key="h.noradId" class="ephi-hit" @click="pickHit(h)">
                          <span class="nm" data-i18n-skip>{{ h.name }}</span><span class="id">{{ h.noradId }}</span><span v-if="h.groupLabel" class="gl" data-i18n-skip>{{ h.groupLabel }}</span>
                        </div>
                      </div>
                      <div v-else-if="searchQ.trim()" class="ephi-dim pad">无匹配卫星。</div>
                    </td>
                  </tr>
                  <tr v-if="(s.gaps && s.gaps.length) || s.jumps" class="ephi-sub">
                    <td colspan="6">
                      <span v-if="s.gaps && s.gaps.length" class="ephi-rd" :title="s.gaps.map(gapText).join('\n')"><span>采样间断</span> {{ s.gaps.length }}<template v-if="s.gaps.length === 1"><span class="sep">·</span>{{ gapText(s.gaps[0]) }}</template></span>
                      <span v-if="s.jumps" class="ephi-rd"><span>状态跳变</span> {{ s.jumps }}</span>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
            <div v-else class="ephi-rd"><span>平均根数</span> {{ p.count }} <span>颗</span></div>
            <div v-for="(w, k) in (p.warnings || []).slice(0, 4)" :key="'w' + k" class="ephi-warn">{{ w }}</div>
            <div v-if="(p.warnings || []).length > 4" class="ephi-warn" :title="p.warnings.slice(4).join('\n')">… {{ p.warnings.length - 4 }}</div>
          </template>
        </section>
        <div v-if="!files.length" class="ephi-dim pad">未选择文件。</div>
      </div>
      <div class="ephi-ft">
        <span class="ephi-cnt"><span>文件</span> {{ okFiles.length }}/{{ files.length }}<span class="sep">·</span><span>卫星</span> {{ satCount }}<template v-if="boundCount"><span class="sep">·</span><span>对应已有卫星</span> {{ boundCount }}</template></span>
        <button type="button" class="ephi-btn ghost" @click="emit('close')">取消</button>
        <button type="button" class="ephi-btn" :disabled="!okFiles.length" @click="commit">{{ rebind ? '确定' : '导入' }}</button>
      </div>
    </div>
  </div>
</template>

<style>
/* 壳与 LinkImportDialog 同一套（lki- → ephi-）：遮罩 + 标题条 + 页脚，不吃宿主窗口的 CSS */
.ephi-mask { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; background: var(--scrim); }
.ephi-dlg { width: 860px; max-width: calc(100% - 32px); max-height: 86%; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-card); overflow: hidden; box-shadow: var(--shadow-3); animation: ui-dlg-in var(--dur-3) var(--ease-out); }
.ephi-hd { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); font-family: var(--font-serif); font-size: var(--fs-5); color: var(--text); flex: none; }
.ephi-x { margin-left: auto; cursor: pointer; display: inline-flex; border: 0; background: transparent; padding: 2px; border-radius: var(--r-ctl); color: var(--text-faint); }
.ephi-x:hover { color: var(--text); background: var(--wash-hover); }
.ephi-body { padding: 10px 14px; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.ephi-file { border: 1px solid var(--border); border-radius: var(--r-ctl); background: var(--bg); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.ephi-file.bad { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.ephi-fh { display: flex; align-items: center; gap: 8px; color: var(--text); font-size: var(--fs-3); min-width: 0; }
.ephi-fn { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ephi-tag { flex: none; font-size: var(--fs-2); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-box); padding: 0 6px; line-height: 18px; }
.ephi-tag.dim { color: var(--text-faint); }
.ephi-row { display: flex; align-items: center; gap: 8px; font-size: var(--fs-3); color: var(--text-muted); }
.ephi-k { flex: none; width: 3.5em; }
.ephi-in { flex: 1; min-width: 0; padding-inline: 7px; }
.ephi-tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-3); table-layout: fixed; }
.ephi-tbl th { text-align: left; font-weight: 500; color: var(--text-faint); font-size: var(--fs-2); padding: 3px 6px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.ephi-tbl td { padding: 4px 6px; color: var(--text); border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); vertical-align: middle; }
.ephi-tbl th.num, .ephi-tbl td.num { text-align: right; font-family: var(--font-mono); width: 64px; }
.ephi-tbl td.dt { font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ephi-tbl th:nth-child(1) { width: 18%; } .ephi-tbl th:nth-child(3) { width: 30%; } .ephi-tbl th:nth-child(5) { width: 64px; }
.ephi-tbl th.tgt, .ephi-tbl td.tgt { width: 30%; }
.ephi-tbl td.nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ephi-tbl tr.off td { color: var(--text-faint); }
.ephi-tbl tr.ephi-sub td, .ephi-tbl tr.ephi-srow td { border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); padding-top: 0; }
.ephi-sel { width: 100%; min-width: 0; }
.ephi-search { display: flex; align-items: center; gap: 6px; color: var(--text-faint); }
.ephi-hits { max-height: 160px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-ctl); margin-top: 4px; background: var(--surface); }
.ephi-hit { display: flex; align-items: center; gap: 8px; padding: 3px 8px; cursor: pointer; font-size: var(--fs-3); }
.ephi-hit + .ephi-hit { border-top: 1px solid var(--border); }
.ephi-hit:hover { background: var(--wash-hover); }
.ephi-hit .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.ephi-hit .id { flex: none; font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-muted); }
.ephi-hit .gl { flex: none; font-size: var(--fs-2); color: var(--text-faint); }
.ephi-rd { font-size: var(--fs-2); color: var(--text-muted); font-family: var(--font-mono); margin-right: 14px; white-space: nowrap; }
.ephi-rd .sep, .ephi-cnt .sep { margin: 0 6px; color: var(--text-faint); }
.ephi-warn { font-size: var(--fs-2); color: var(--warn); }
.ephi-err { font-size: var(--fs-3); color: var(--danger); }
.ephi-dim { color: var(--text-faint); font-size: var(--fs-2); }
.ephi-dim.pad { padding: 8px 2px; }
.ephi-ft { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); flex: none; }
.ephi-cnt { font-size: var(--fs-2); color: var(--text-faint); font-family: var(--font-mono); white-space: nowrap; margin-right: auto; }
.ephi-btn { display: inline-flex; align-items: center; justify-content: center; height: var(--h-ctl-lg); padding: 0 18px;
            font-size: var(--fs-3); white-space: nowrap; cursor: pointer; user-select: none; color: var(--primary-on);
            background: var(--primary-fill); border: 1px solid var(--primary-fill); border-radius: var(--r-ctl); }
.ephi-btn:hover:not(:disabled) { background: var(--primary-fill-hover); border-color: var(--primary-fill-hover); }
.ephi-btn.ghost { color: var(--text); background: var(--bg); border-color: var(--border-strong); }
.ephi-btn.ghost:hover:not(:disabled) { background: var(--bg); border-color: var(--line-hover); }
.ephi-btn:disabled { opacity: .45; cursor: not-allowed; }
</style>
