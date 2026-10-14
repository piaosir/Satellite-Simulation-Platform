<script setup>
// 分析页（DESIGN2 §3「分析」、任务书 §6.4 / §6.5 / §6.7 / §6.8）：当前卫星 + 选中挂点，四项分析——
// 本体遮挡掩模 · 万向节可达 · 太阳翼功率 · 星侧太阳侵入。时段缺省 = 当前时刻（主窗口时间轴上的场景时刻）起 24 h、步长 60 s；逐拍星位（satPos.posAt 唯一取位入口）
// 与本体姿态（姿态律）四项共用一份（anaContext.series，按「星 · 姿态律 · 时段」缓存）。重活都分块跑（进度 + 取消），不卡界面。
// 结果区只出数字与图（CLAUDE.md）；本体遮挡只在这里算、看、存、导出，不接入可见性 / 对星 / 星间链路（2026-09-24 用户叫停）。
import { computed, inject, provide, watch, onActivated } from 'vue'
import Icon from '../components/Icon.vue'
import NumIn from './NumIn.vue'
import AnaMask from './ana/AnaMask.vue'
import AnaGimbal from './ana/AnaGimbal.vue'
import AnaPower from './ana/AnaPower.vue'
import AnaSun from './ana/AnaSun.vue'
import { createAnaContext, minuteNow } from './anaContext.js'
import { inputText, parseInput, endFromHours, hoursFromEnd } from '../shared/timeWindowInput.js'

const wb = inject('wb')
const sat = inject('sat')
const S = sat.st
const ana = createAnaContext({ wb, sat })
provide('ana', ana)
const W = ana.win

// 起点 / 终点：datetime-local（按显示时区解释；读写与半截年份判据见 shared/timeWindowInput.js）。
// change 里只认合格的值、不回写框（Chromium 每改一段发一次 change，回写会打断逐段键入）；失焦时框回到实际生效的值
const t0Text = computed(() => inputText(W.t0, W.tz))
function setT0(v) { const t = parseInput(v, W.tz); if (!Number.isFinite(t)) return; W.t0 = t; ana.invalidate() }
// 终点 ⇄ 时长：终点按起点 + 时长显示；改终点＝改时长（须晚于起点、≤ 8760 h），改起点时长不变
const t1Text = computed(() => inputText(endFromHours(W.t0, W.hours), W.tz))
function setT1(v) { const h = hoursFromEnd(W.t0, parseInput(v, W.tz), 8760); if (Number.isFinite(h)) setHours(h) }
// 「设为当前时刻」= 主窗口时间轴上的此刻（场景时刻），与 3D 页同一条时间线
function nowT0() { W.t0 = minuteNow(); ana.invalidate() }
function setHours(v) { if (v > 0) { W.hours = v; ana.saveWin(); ana.invalidate() } }
function setStep(v) { if (v > 0) { W.stepS = v; ana.saveWin(); ana.invalidate() } }
function setTz(z) { W.tz = z; ana.saveWin() }
// 姿态律改了 / 换星：缓存按键自己作废（键含姿态律与星）；这里只清掉挂着的旧结果之外的东西不必动
watch(() => [S.satKey], () => ana.invalidate())
onActivated(() => { if (!S.orbit && S.satKey) sat.ensureOrbit() })
</script>

<template>
  <div class="ana">
    <div v-if="!S.binding" class="lb-placeholder">未选择卫星。</div>
    <template v-else>
      <div class="ana-top">
        <span class="ana-name" :title="S.satKey" data-i18n-skip>{{ S.label }}</span>
        <select class="ci ana-m" :value="S.mountSel" :disabled="!sat.mounts.value.length" title="待分析的挂点（与卫星页挂点表、预览中的挂点圆盘选择同步）" @change="S.mountSel = $event.target.value">
          <option v-if="!sat.mounts.value.length" value="">无挂点。</option>
          <option v-for="m in sat.mounts.value" :key="m.id" :value="m.id" data-i18n-skip>{{ m.name || m.id }}</option>
        </select>
      </div>
      <div class="ana-win">
        <div class="srow">
          <label title="时段起点（按显示时区）">起点</label>
          <input class="ci ana-t0" type="datetime-local" :value="t0Text" @change="setT0($event.target.value)" @blur="$event.target.value = t0Text" />
          <button class="lb-mini lb-mini-ico" title="设为当前时刻" @click="nowT0"><Icon name="clock" :size="12" /></button>
          <div class="lbu-seg ana-tz">
            <button :class="{ on: W.tz === 'local' }" :aria-pressed="(W.tz === 'local') ? 'true' : 'false'" title="本机时区" @click="setTz('local')">本机</button>
            <button :class="{ on: W.tz === 'utc' }" :aria-pressed="(W.tz === 'utc') ? 'true' : 'false'" title="UTC" @click="setTz('utc')">UTC</button>
          </div>
        </div>
        <div class="srow">
          <label title="时段终点（按显示时区）；改终点＝改时长，改起点时长不变">终点</label>
          <input class="ci ana-t0" type="datetime-local" :value="t1Text" @change="setT1($event.target.value)" @blur="$event.target.value = t1Text" />
        </div>
        <div class="srow">
          <label>时长</label>
          <NumIn :model-value="W.hours" :min="0.01" :max="8760" :sig="6" @commit="setHours" />
          <span class="u">h</span>
          <label class="ana-l2">步长</label>
          <NumIn :model-value="W.stepS" :min="0.1" :max="86400" :sig="6" @commit="setStep" />
          <span class="u">s</span>
          <span class="ana-n" :class="{ bad: ana.tooMany.value }" title="样本数（上限 200 万）">{{ ana.nSamples.value }}</span>
        </div>
        <div v-if="S.orbitErr" class="md-state bad">{{ S.orbitErr }}</div>
      </div>
      <div v-if="!sat.selMount.value" class="lb-placeholder ana-l">未选择挂点。</div>
      <AnaMask />
      <AnaGimbal />
      <AnaPower />
      <AnaSun />
    </template>
  </div>
</template>

<style scoped>
.ana { display: flex; flex-direction: column; gap: 2px; }
.ana-top { display: flex; align-items: center; gap: 8px; min-height: 28px; margin: 0 0 4px; }
.ana-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: calc(var(--lb-fs, 11px) + 3px); font-weight: 700; letter-spacing: var(--ls-tight); }
.ana-m { flex: 1 1 120px; min-width: 0 !important; }
.ana-win { display: flex; flex-direction: column; gap: 3px; padding: 5px 7px 6px; margin-bottom: 6px; border: 1px solid var(--border); border-radius: var(--r-box); background: var(--surface); }
.ana-t0 { flex: 1 1 150px; min-width: 0 !important; }
.ana-tz { flex: none; display: flex; }
.ana-tz > button { height: var(--h-ctl); padding: 0 8px; }
.ana-l2 { min-width: 0 !important; margin-left: 4px; }
.ana-n { margin-left: auto; font-size: var(--fs-2); font-family: var(--font-mono); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.ana-n.bad { color: var(--danger); }
.ana-l { text-align: left; padding: 2px 0 6px; }
.srow :deep(.md-num) { flex: 1 1 56px; }
</style>
