<script setup>
// 应用场景仿真 · 添加卫星（三条取星路径 + 预置快捷区）。
//
// 一期从模块库点 A 类条目 —— 20 颗写死的星，用户想用 AsiaSat 7 / Starlink / 北斗 /
// 自己导入的星就没辙。二期这里是唯一入口，三个页签覆盖三种「用户手里已经有什么」：
//   ① 卫星库    —— 已经建过的条目（与端到端链路预算窗口是同一份库）
//   ② 轨位目录  —— 在轨静止星按定点经度排；叠一层中文别名，搜「中星 26」命中 CHINASAT 26
//   ③ 星历搜索  —— 全量 NGSO：CelesTrak active ∪ 常用名组 ∪ 自定义卫星 ∪ 自定义星座
// 后两条选中即在卫星库里建一条条目再加入场景 —— 建好之后它与用户自己建的条目没有区别。
//
// 取星逻辑走 shared/satPick.js（与端到端窗口共用一份）：同一颗星在两个窗口里必须解出同一条轨道。
import { ref, computed, onMounted, watch } from 'vue'
import Icon from './Icon.vue'
import { scene, addSatEntry, addSatEntryFromRec, addSatModule, scheduleSatSave, fillSatSlot, modById } from '../viz/scene/sceneStore.js'
import { satBrief } from '../viz/scene/sceneSatLib.js'
import { ensureSearchPool } from '../ngso/satSearchPool.js'
import { searchPool } from '../shared/satPick.js'
import { geoSlotOfOmm } from '../shared/geoSlot.js'
import { SAT_FIELDS, defaultsFor } from '../e2e/e2eParams.js'

const emit = defineEmits(['close', 'added'])

const tab = ref('lib')
const kw = ref('')
const busy = ref('')
const err = ref('')

// ── ① 卫星库 ──
const libRows = computed(() => {
  const q = kw.value.trim().toLowerCase()
  return scene.satLib
    .map((c) => ({ c, brief: satBrief(c), name: c.name || (c.form && c.form.satelliteName) || c.id }))
    .filter((r) => !q || (r.name + ' ' + r.brief).toLowerCase().includes(q))
})

// ── ② 轨位目录（在轨静止星，按定点经度排）──
// 池里 GEO 那一组本来就带定点经度（geoSlotOfOmm 按历元星下点算，受控 GEO 摆动 < 0.1°）。
const pool = ref(null)
const poolErr = ref('')
const loading = ref(false)
async function ensurePool() {
  if (pool.value || loading.value) return
  loading.value = true; poolErr.value = ''
  try {
    const r = await ensureSearchPool()
    pool.value = r.all
    if (!r.all.length) poolErr.value = '未取到任何卫星（需联网获取 CelesTrak OMM，或本地无缓存 / 自定义星座）'
  } catch (e) {
    poolErr.value = '卫星星历加载失败：' + ((e && e.message) || e)
  } finally { loading.value = false }
}
// 中文别名表：预置里的 zh ↔ 英文编目名（搜「中星 26」要命中 CHINASAT 26）
const aliases = computed(() => (scene.satPresets || []).map((p) => ({ zh: p.zh, en: p.en })))
const slotRows = computed(() => {
  if (!pool.value) return []
  const q = kw.value.trim().toLowerCase()
  const zhOf = new Map((scene.satPresets || []).map((p) => [String(p.en || '').toUpperCase(), p.zh]))
  const aliasEn = aliases.value.filter((a) => a.zh && String(a.zh).toLowerCase().includes(q)).map((a) => String(a.en).toLowerCase())
  const out = []
  for (const s of pool.value) {
    const slot = geoSlotOfOmm(s)
    if (!slot) continue                     // 只列解得出定点经度的（严区制判 GEO）
    const nm = String(s.name || '').toLowerCase()
    if (q && !(nm.includes(q) || String(s.noradId).includes(q) || slot.toLowerCase().includes(q) || aliasEn.some((x) => nm.includes(x)))) continue
    out.push({ rec: s, slot, lon: slotLon(slot), zh: zhOf.get(String(s.name || '').toUpperCase()) || '' })
    if (out.length >= 400) break
  }
  return out.sort((a, b) => a.lon - b.lon)
})
const slotLon = (t) => { const m = /^([\d.]+)°([EW])$/.exec(t || ''); return m ? (+m[1]) * (m[2] === 'W' ? -1 : 1) : 999 }

// ── ③ 星历搜索（全量 NGSO）──
const searchRows = computed(() => searchPool(pool.value, kw.value, 60, aliases.value))

watch(tab, (t) => { if (t !== 'lib') ensurePool() })

// ── 建条目 + 加入场景 ──
// 正在给一个【卫星槽】选型（按图施工）时，落进那一槽而不是新加一颗 ——
// 骨架上那个位置已经画好、边也连着，再加一颗就成了两颗星。
const satSlot = computed(() => {
  const s = scene.sel
  if (!s || s.type !== 'module') return null
  const m = modById.value.get(s.id)
  return m && m.pending && m.kind === 'sat' ? m : null
})
function place(entry) {
  if (satSlot.value) { fillSatSlot(satSlot.value.id, entry.id); emit('close'); return }
  const m = addSatModule(entry.id)
  emit('added', m)
  emit('close')
}
function fromLib(c) { place(c) }

// 建条目那一步在 store 里（addSatEntryFromRec）：它是数据逻辑不是视图逻辑，
// 真窗口自检脚本也要走同一条路，放在组件里就只有点击才跑得到。
function fromSlot(row) {
  err.value = ''
  const e = addSatEntryFromRec(row.rec, { gso: true, lon: slotLon(row.slot), zh: row.zh })
  if (!e) { err.value = '建库条目失败'; return }
  place(e)
}
function fromSearch(rec) {
  err.value = ''
  const e = addSatEntryFromRec(rec, { gso: false })
  if (!e) { err.value = '建库条目失败'; return }
  place(e)
}
/** 预置芯片：一键建条目（中国卫通 / 亚太 / 天启那几颗） */
async function fromPreset(p) {
  busy.value = p.key
  try {
    const api = (typeof window !== 'undefined' && window.api) || {}
    const full = await api.scene?.satPreset?.(p.key)
    const form = { ...defaultsFor(SAT_FIELDS) }
    for (const k of Object.keys((full && full.sat) || {})) form[k] = full.sat[k] == null ? '' : String(full.sat[k])
    const e = addSatEntry(p.zh, form, null, p.key)
    place(e)
  } catch (e2) { err.value = (e2 && e2.message) || String(e2) } finally { busy.value = '' }
}
/** 空白条目：轨位 / 频段 / 电平全部自填 */
function fromBlank() {
  const e = addSatEntry('新建卫星', null, null, '')
  scheduleSatSave()
  place(e)
}

onMounted(() => { if (!scene.satLib.length) tab.value = 'slot' })
const presets = computed(() => scene.satPresets || [])
</script>

<template>
  <div class="spk-mask" @click="emit('close')">
    <div class="spk" @click.stop>
      <div class="spk-hd">
        <span class="spk-t">{{ satSlot ? '为「' + satSlot.name + '」选星' : '添加卫星' }}</span>
        <span class="spk-x" @click="emit('close')"><Icon name="x" :size="14" /></span>
      </div>

      <div class="spk-tabs">
        <span :class="{ on: tab === 'lib' }" @click="tab = 'lib'">卫星库 {{ scene.satLib.length }}</span>
        <span :class="{ on: tab === 'slot' }" @click="tab = 'slot'">轨位目录</span>
        <span :class="{ on: tab === 'search' }" @click="tab = 'search'">星历搜索</span>
      </div>

      <div class="spk-search">
        <input class="ci" v-model="kw" :placeholder="tab === 'lib' ? '搜卫星库' : (tab === 'slot' ? '名称 / 轨位，如 中星 26 或 125°E' : '名称 / NORAD 号，如 STARLINK / 44713')" />
      </div>

      <div class="spk-body">
        <!-- ① 卫星库 -->
        <template v-if="tab === 'lib'">
          <div v-if="!libRows.length" class="spk-empty">卫星库里还没有条目。</div>
          <div v-for="r in libRows" :key="r.c.id" class="spk-row" @click="fromLib(r.c)">
            <span class="spk-n">{{ r.name }}</span>
            <span class="spk-i">{{ r.brief }}</span>
          </div>
        </template>

        <!-- ② 轨位目录 -->
        <template v-else-if="tab === 'slot'">
          <div v-if="loading" class="spk-empty">正在加载星历…</div>
          <div v-else-if="poolErr" class="spk-err">{{ poolErr }}</div>
          <div v-else-if="!slotRows.length" class="spk-empty">没有匹配的静止星。</div>
          <div v-for="r in slotRows" :key="r.rec.noradId" class="spk-row" @click="fromSlot(r)">
            <span class="spk-slot">{{ r.slot }}</span>
            <span class="spk-n" data-i18n-skip>{{ r.zh || r.rec.name }}<em v-if="r.zh"> · {{ r.rec.name }}</em></span>
            <span class="spk-i">NORAD {{ r.rec.noradId }}</span>
          </div>
        </template>

        <!-- ③ 星历搜索 -->
        <template v-else>
          <div v-if="loading" class="spk-empty">正在加载星历…</div>
          <div v-else-if="poolErr" class="spk-err">{{ poolErr }}</div>
          <div v-else-if="!searchRows.length" class="spk-empty">无匹配卫星。</div>
          <div v-for="r in searchRows" :key="r.noradId" class="spk-row" @click="fromSearch(r)">
            <span class="spk-n" data-i18n-skip>
              {{ r.name }}
              <em v-if="r.custom" class="spk-bd on">自定义</em>
              <em v-else-if="r.groupLabel" class="spk-bd">{{ r.groupLabel }}</em>
              <em v-if="r._regime && r._regime !== 'LEO'" class="spk-bd">{{ r._slot ? r._regime + ' ' + r._slot : r._regime }}</em>
            </span>
            <span class="spk-i">i={{ (+r.incl).toFixed(1) }}° ·
              <template v-if="(+r.ecc) >= 0.01">近{{ Math.round(r.perigeeKm) }}/远{{ Math.round(r.apogeeKm) }} km</template>
              <template v-else>h≈{{ Math.round(r.perigeeKm) }} km</template>
            </span>
          </div>
        </template>
      </div>

      <!-- 预置快捷区 -->
      <div class="spk-pre">
        <span v-for="p in presets" :key="p.key" class="spk-chip" :class="{ busy: busy === p.key }" :title="p.src" @click="fromPreset(p)">{{ p.zh }}</span>
        <span class="spk-chip add" @click="fromBlank">＋ 空白条目</span>
      </div>
      <div v-if="err" class="spk-err">{{ err }}</div>
      <div v-if="scene.satLibError" class="spk-err">{{ scene.satLibError }}</div>
    </div>
  </div>
</template>

<style scoped>
.spk-mask { position: fixed; inset: 0; z-index: 70; background: rgba(0,0,0,.2); display: flex; align-items: center; justify-content: center; }
.spk { width: 520px; max-width: 92vw; max-height: 80vh; display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--border-strong); box-shadow: var(--shadow-3, 0 8px 24px rgba(0,0,0,.2)); font-size: var(--fs-3); }
.spk-hd { display: flex; align-items: center; padding: 8px 12px; background: var(--surface); border-bottom: 1px solid var(--border); }
.spk-t { font-weight: 600; }
.spk-x { margin-left: auto; cursor: pointer; color: var(--text-faint); display: inline-flex; }
.spk-x:hover { color: var(--text); }
.spk-tabs { display: flex; gap: 2px; padding: 8px 12px 0; }
.spk-tabs > span { padding: 3px 12px; border: 1px solid var(--field-border); border-bottom: none; color: var(--text-muted); cursor: pointer; user-select: none; }
.spk-tabs > span.on { background: var(--accent-ui); border-color: var(--accent-ui); color: var(--bg); }
.spk-search { padding: 6px 12px; border-bottom: 1px solid var(--border); }
.spk-search .ci { width: 100%; border: 1px solid var(--field-border); background-color: var(--field-bg); padding: 4px 7px; font-size: var(--fs-3); outline: none; color: var(--text); }
.spk-search .ci:focus { border-color: var(--accent-ui); }
.spk-body { flex: 1; min-height: 180px; overflow-y: auto; }
.spk-row { display: flex; align-items: baseline; gap: 8px; padding: 4px 12px; cursor: pointer; border-bottom: 1px solid var(--border); }
.spk-row:hover { background: var(--accent-ui-wash); }
.spk-slot { flex: none; min-width: 62px; font-variant-numeric: tabular-nums; color: var(--accent-ui); }
.spk-n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spk-n em { font-style: normal; color: var(--text-faint); font-size: var(--fs-2, 11px); }
.spk-i { flex: none; color: var(--text-faint); font-size: var(--fs-2, 11px); font-variant-numeric: tabular-nums; }
.spk-bd { display: inline-block; font-style: normal; font-size: 10px; padding: 0 5px; margin-left: 5px; border: 1px solid var(--border); border-radius: var(--r-pill, 9px); color: var(--text-muted); }
.spk-bd.on { background: var(--accent-ui); border-color: var(--accent-ui); color: var(--bg); }
.spk-pre { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); max-height: 108px; overflow-y: auto; }
.spk-chip { padding: 1px 8px; border: 1px solid var(--border-strong); color: var(--text-muted); cursor: pointer; font-size: var(--fs-2, 11px); border-radius: var(--r-pill, 9px); }
.spk-chip:hover { border-color: var(--accent-ui); color: var(--text); }
.spk-chip.add { border-style: dashed; }
.spk-chip.busy { opacity: .5; }
.spk-empty { padding: 14px 12px; color: var(--text-faint); }
.spk-err { padding: 6px 12px; color: var(--danger); font-size: var(--fs-2, 11px); }
</style>
