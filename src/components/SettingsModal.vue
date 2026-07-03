<script setup>
import { computed } from 'vue'
import { quality, effective, setTier, setField, setMapLevel, currentMapLevelIndex, TIERS, FIELD_OPTS, MAP_LEVELS } from '../stores/displayQuality'
import { viewPrefs } from '../stores/viewPrefs'
import { theme, setTheme } from '../stores/theme'
import Icon from './Icon.vue'

// 外观：跟随系统 / 浅色 / 深色
const THEME_OPTS = [
  { key: 'system', label: '跟随系统', icon: 'monitor' },
  { key: 'light', label: '浅色', icon: 'sun' },
  { key: 'dark', label: '深色', icon: 'moon' }
]

const emit = defineEmits(['close'])

const eff = effective   // 当前生效值（预设或自定义）

const optsOf = (k) => FIELD_OPTS[k] || []
const onPick = (k, e) => setField(k, Number(e.target.value))
// 底图精细化：单下拉映射 MAP_LEVELS（粗→细）。当前序号据生效值反查。
const mapLevelIdx = computed(() => currentMapLevelIndex(eff.value))
const onPickMapLevel = (e) => { const l = MAP_LEVELS[Number(e.target.value)]; if (l) setMapLevel(l.detail, l.thin) }

const msaaOn = computed(() => eff.value.msaa !== false)
function toggleMsaa() { setField('msaa', !msaaOn.value) }

const speedPct = computed({
  get: () => Math.round((viewPrefs.autoRotateSpeed / 2) * 100),
  set: (v) => { viewPrefs.autoRotateSpeed = (Number(v) / 100) * 2 }
})
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg" role="dialog" aria-modal="true">
      <header class="dhd">
        <span class="dt">设置</span>
        <span class="x" @click="emit('close')"><Icon name="x" :size="14" /></span>
      </header>

      <div class="body">
        <!-- 外观 -->
        <section class="sec">
          <div class="shd">外观</div>
          <div class="tiers">
            <button v-for="t in THEME_OPTS" :key="t.key" class="tier ttheme" :class="{ on: theme.mode === t.key }" @click="setTheme(t.key)">
              <Icon :name="t.icon" :size="13" />{{ t.label }}
            </button>
          </div>
        </section>

        <!-- 显示设置 -->
        <section class="sec">
          <div class="shd">显示设置</div>
          <div class="tiers">
            <button v-for="t in TIERS" :key="t.key" class="tier" :class="{ on: quality.tier === t.key }" @click="setTier(t.key)">{{ t.label }}</button>
          </div>
          <p class="tip">原画为可达最高画质；改动任意项将切换为「自定义」。</p>

          <div class="grid">
            <label class="frow">
              <span class="fn">渲染分辨率<em>超采样倍率，性能头号杠杆</em></span>
              <select :value="eff.pixelRatio" @change="onPick('pixelRatio', $event)">
                <option v-for="o in optsOf('pixelRatio')" :key="o.label" :value="o.v">{{ o.label }}</option>
              </select>
            </label>
            <label class="frow">
              <span class="fn">底图精细化<em>海岸线/国界几何精度（粗→细）</em></span>
              <select :value="mapLevelIdx" @change="onPickMapLevel">
                <option v-for="(l, i) in MAP_LEVELS" :key="i" :value="i">{{ l.label }}</option>
              </select>
            </label>
            <label class="frow">
              <span class="fn">覆盖网格<em>等值线/填充密度（数值不变）</em></span>
              <select :value="eff.gridStride" @change="onPick('gridStride', $event)">
                <option v-for="o in optsOf('gridStride')" :key="o.label" :value="o.v">{{ o.label }}</option>
              </select>
            </label>
            <label class="frow">
              <span class="fn">渲染帧率<em>上限越低越省电</em></span>
              <select :value="eff.fps" @change="onPick('fps', $event)">
                <option v-for="o in optsOf('fps')" :key="o.label" :value="o.v">{{ o.label }}</option>
              </select>
            </label>
            <label class="frow">
              <span class="fn">球体细分<em>地球网格精度</em></span>
              <select :value="eff.sphereSeg" @change="onPick('sphereSeg', $event)">
                <option v-for="o in optsOf('sphereSeg')" :key="o.label" :value="o.v">{{ o.label }}</option>
              </select>
            </label>
            <div class="frow">
              <span class="fn">MSAA 抗锯齿<em>切换后 3D 视图会重渲一次</em></span>
              <span class="sw" :class="{ on: msaaOn }" @click="toggleMsaa"><i></i></span>
            </div>
          </div>
        </section>

        <!-- 基础设置 -->
        <section class="sec">
          <div class="shd">基础设置</div>
          <div class="grid">
            <div class="frow">
              <span class="fn">地球自转</span>
              <span class="sw" :class="{ on: viewPrefs.autoRotate }" @click="viewPrefs.autoRotate = !viewPrefs.autoRotate"><i></i></span>
            </div>
            <label class="frow">
              <span class="fn">自转速度<em>{{ speedPct }}%</em></span>
              <input type="range" min="10" max="100" step="5" v-model.number="speedPct" :disabled="!viewPrefs.autoRotate" />
            </label>
          </div>
        </section>
      </div>

      <footer class="dft">
        <button class="ghost" @click="setTier('high')">恢复默认（高）</button>
        <button class="ok" @click="emit('close')">完成</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.mask { position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; }
.dlg { width: 560px; max-width: calc(100vw - 32px); max-height: calc(100vh - 64px); display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: 4px; box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
.dhd { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.dt { font-family: var(--font-serif); font-size: 15px; }
.x { cursor: pointer; color: var(--text-muted); padding: 2px 6px; display: inline-flex; align-items: center; }
.x:hover { color: var(--text); }
.body { padding: 14px 16px; overflow: auto; }
.sec { margin-bottom: 18px; }
.shd { font-size: 12px; color: var(--text-muted); letter-spacing: .5px; margin-bottom: 10px; }
.tiers { display: flex; gap: 6px; flex-wrap: wrap; }
.tier { flex: 1; min-width: 64px; padding: 7px 0; cursor: pointer; font-size: 13px; color: var(--text-muted);
  background: var(--bg); border: 1px solid var(--border); border-radius: 3px; transition: all .12s; }
.tier.ttheme { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.tier:hover { color: var(--text); border-color: var(--accent); }
.tier.on { color: var(--bg); background: var(--accent); border-color: var(--accent); font-weight: 600; }
.tip { font-size: 11.5px; color: var(--text-faint); margin: 8px 0 12px; }
.grid { display: flex; flex-direction: column; gap: 9px; }
.frow { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.fn { font-size: 12.5px; color: var(--text); display: flex; flex-direction: column; }
.fn em { font-style: normal; font-size: 11px; color: var(--text-faint); margin-top: 2px; }
.frow select { min-width: 150px; border: 1px solid var(--border); background: var(--bg); color: var(--text); padding: 5px 8px; outline: none; }
.frow input[type=range] { width: 150px; }
.sw { width: 40px; height: 22px; border-radius: 12px; background: var(--border); position: relative; cursor: pointer; transition: background .15s; flex: none; }
.sw i { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--text-faint); transition: all .15s; }
.sw.on { background: var(--accent); }
.sw.on i { left: 20px; background: var(--bg); }
.dft { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--border); }
.dft button { padding: 6px 16px; cursor: pointer; border-radius: 3px; font-size: 12.5px; }
.ghost { background: var(--bg); border: 1px solid var(--border); color: var(--text-muted); }
.ghost:hover { color: var(--text); border-color: var(--accent); }
.ok { background: var(--accent); border: 1px solid var(--accent); color: var(--bg); font-weight: 600; }
</style>
