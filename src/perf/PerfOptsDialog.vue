<script setup>
// 表选项（对地 / 对星共用一套）：显示列 / 波束筛选 / 过滤 / 参数计算。
// 指向误差不在这里 —— 它属于城市设置（SATSOFT Cities 页）；对星表没有城市，仍留在本对话框。
// opts 是调用方传进来的响应式对象，这里直接改它（调用方的镜像 watcher 负责发回主窗口）。
import { ref, computed, watch } from 'vue'
import { useCheckList } from '../shared/ui/useCheckList.js'
import { filterBeamsByQuery, beamSelOn, beamSelIdsOf, normBeamSel } from '../viz/grd/usePerfTable.js'
import PwDialog from './PwDialog.vue'

const props = defineProps({
  title: { type: String, default: '性能表选项' },
  sub: { type: String, default: '' },
  opts: { type: Object, required: true },
  colDefs: { type: Array, required: true },
  colGroups: { type: Array, required: true },
  ctxBeams: { type: Array, default: () => [] },
  unitChoice: { type: Boolean, default: false },    // 对地表有 Parameter 单位（dB / 功率 / 电压）
  pointing: { type: Boolean, default: false },      // 对星表：指向误差留在这里
  filterLabel: { type: String, default: '剔除低于最低方向性的记录' }
})
const emit = defineEmits(['close', 'reset'])
const o = computed(() => props.opts)
const colDef = (k) => props.colDefs.find((c) => c.key === k)
const colLabel = (k) => { const c = colDef(k); return c ? c.label + (c.unit ? '(' + c.unit + ')' : '') : k }
const colNa = (k) => { const c = colDef(k); return !!(c && c.na) }

// 波束筛选：点 / 按住拖刷 / Shift 连选 / 键盘（shared/ui/useCheckList.js）
const beamQuery = ref('')
const bEl = ref(null)
const bRows = computed(() => filterBeamsByQuery(props.ctxBeams, beamQuery.value))
const allBi = () => props.ctxBeams.map((b) => b.bi)
const bp = useCheckList({
  rows: () => bRows.value,
  idOf: (b) => b.bi,
  isOn: (bi) => beamSelOn(o.value, bi),
  current: () => beamSelIdsOf(o.value, allBi()),
  commit: (ids) => { o.value.beamSel = normBeamSel(allBi(), [...new Set(ids)]) },
  el: () => bEl.value
})
watch(() => props.ctxBeams, () => bp.reset())
const isOn = (bi) => beamSelOn(o.value, bi)
</script>

<template>
  <PwDialog :title="title" :sub="sub" :width="700" @close="emit('close')">
    <div class="po-body">
      <section class="po-card po-cols">
        <div class="po-ct">显示列</div>
        <div class="po-scroll">
          <div v-for="g in colGroups" :key="g.title" class="po-grp">
            <div class="po-gt">{{ g.title }}</div>
            <label v-for="k in g.keys" :key="k" class="po-ck" :class="{ dis: colNa(k) }">
              <input type="checkbox" v-model="o.cols[k]" :disabled="colNa(k)" />
              <span>{{ colLabel(k) }}<em v-if="colNa(k)"> *</em></span>
            </label>
          </div>
        </div>
      </section>
      <div class="po-right">
        <section v-if="ctxBeams.length > 1" class="po-card">
          <div class="po-ct">波束筛选</div>
          <input class="ci bq" v-model="beamQuery" placeholder="搜索：波束名，或序号 1-62、1,3,5、1-10,20-30" />
          <div ref="bEl" class="bplist" :class="{ painting: bp.painting.value }" tabindex="0" title="点一行翻勾选 · 按住拖＝刷选一片 · Shift 点＝连选一段 · Ctrl+A 全选" @keydown="bp.onKey">
            <div class="brow ball" @mousedown="bp.onHeadDown">
              <input type="checkbox" :checked="bp.allOn()" :indeterminate.prop="bp.anyOn() && !bp.allOn()" />
              <span class="balln">{{ beamQuery.trim() ? '(全选搜索结果)' : '(全选)' }}</span>
              <span class="bpk">{{ bp.onCount.value }}/{{ ctxBeams.length }}</span>
            </div>
            <div v-for="(b, i) in bRows" :key="b.seq" class="brow bitem" :class="{ on: isOn(b.bi), cur: bp.cur.value === i }" @mousedown="bp.onRowDown($event, i)">
              <input type="checkbox" :checked="isOn(b.bi)" />
              <span class="bseq">{{ b.seq }}</span>
              <span class="pbnm" :title="b.name" data-i18n-skip>{{ b.name }}</span>
              <span class="bpk">{{ b.peakDb == null ? '—' : b.peakDb.toFixed(1) }}</span>
            </div>
            <div v-if="!bRows.length" class="empty">无匹配波束</div>
          </div>
        </section>
        <section class="po-card">
          <div class="po-ct">过滤</div>
          <label class="po-chk"><input type="checkbox" v-model="o.filterOn" /><span>{{ filterLabel }}</span></label>
          <div class="po-row"><label>最低方向性</label><input class="ci" type="number" step="0.5" v-model.lazy.number="o.minDir" :disabled="!o.filterOn" /><span class="u">dB</span></div>
        </section>
        <section class="po-card">
          <div class="po-ct">参数计算</div>
          <label class="po-chk"><input type="checkbox" v-model="o.sameAsAnt" /><span>与天线当前设置一致</span></label>
          <template v-if="!o.sameAsAnt">
            <div class="po-row"><label>极化</label><select v-model="o.pol"><option value="P1">P1 共极化</option><option value="P2">P2 交叉</option><option value="RSS">RSS 合成</option><option value="P1/P2">P1/P2</option><option value="P2/P1">P2/P1</option></select></div>
            <div v-if="unitChoice" class="po-row"><label>单位</label><span class="seg2"><span class="sg" :class="{ on: o.unit === 'dB' }" @click="o.unit = 'dB'">dB</span><span class="sg" :class="{ on: o.unit === 'power' }" @click="o.unit = 'power'">功率</span><span class="sg" :class="{ on: o.unit === 'voltage' }" @click="o.unit = 'voltage'">电压</span></span></div>
            <div class="po-row"><label>路径损耗</label><select v-model="o.pathLoss"><option value="none">无</option><option value="relative">相对(h/Rs)²</option><option value="absolute">通量密度</option></select></div>
            <div class="po-row"><label>增益偏置</label><input class="ci" type="number" step="0.5" v-model.lazy.number="o.gainOffset" /><span class="u">dB</span></div>
          </template>
        </section>
        <section v-if="pointing" class="po-card">
          <div class="po-ct">指向误差 · Min/Max Pointing</div>
          <div class="po-row"><label>方位 Az</label><input class="ci" type="number" step="any" min="0" v-model.lazy.number="o.pointAz" /><span class="u">°</span></div>
          <div class="po-row"><label>俯仰 El</label><input class="ci" type="number" step="any" min="0" v-model.lazy.number="o.pointEl" /><span class="u">°</span></div>
          <div class="po-row"><label>偏航 Yaw</label><input class="ci" type="number" step="any" min="0" v-model.lazy.number="o.pointYaw" /><span class="u">°</span></div>
        </section>
      </div>
    </div>
    <template #foot>
      <span class="save ghost po-reset" title="将本表选项恢复为默认值" @click="emit('reset')">恢复默认</span>
      <span class="save" @click="emit('close')">完成</span>
    </template>
  </PwDialog>
</template>
