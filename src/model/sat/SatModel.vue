<script setup>
// 卫星页「模型」：这颗星用哪个模型（自动 = autoMatch 按名称 / NORAD / 类别匹配，与 3D 页同一口径；无 = 不配模型；或指定库里的某一个）。
// 选定后预览自动换成它（useSatViewport）；挂点表的「attach point」下拉、掩模计算都按预览里这一个模型。
import { computed, inject } from 'vue'
import MdSec from '../MdSec.vue'
import { displayName, sourceTag } from '../wbLogic.js'
import { byLang } from '../../shared/i18n/lang.js'

const wb = inject('wb')
const sat = inject('sat')
const S = sat.st
const b = computed(() => { void S.rev; return S.binding })
const cur = computed(() => (b.value && b.value.model ? b.value.model.id : 'auto'))
const lang = () => (byLang('zh', 'en') === 'en' ? 'en' : 'zh')
// 下拉：库里的卫星类条目（参数化模板在前，其余按名字排）。实体模板（ent:，3D 页不现生成）与非卫星类（地球站 / 飞机 / 船 / 车）
// 与库页「设为 GEO 默认」同一口径排除；当前已绑的那个即使不在此列也留着（看得见现状）
const satOk = (e) => e.origin !== 'entTemplate' && (!e.kind || e.kind === 'spacecraft')
const opts = computed(() => {
  const list = wb.st.list.filter((e) => satOk(e) || e.id === cur.value)
  const tpl = list.filter((e) => e.origin === 'template').sort((x, y) => (x.tplOrder || 0) - (y.tplOrder || 0))
  const rest = list.filter((e) => e.origin !== 'template').sort((x, y) => String(displayName(x, lang())).localeCompare(String(displayName(y, lang())), 'zh'))
  return [...tpl, ...rest].map((e) => ({ id: e.id, label: displayName(e, lang()) || e.id, tag: sourceTag(e) || (e.origin === 'template' ? '参数化' : '') }))
})
const resolved = computed(() => { void S.rev; void wb.st.list.length; return sat.resolvedModel() })
const resolvedName = computed(() => {
  const r = resolved.value
  if (!r.id) return ''
  const e = wb.byId(r.id)
  return e ? (displayName(e, lang()) || r.id) : r.id
})
function setModel(v) {
  const id = v === '__auto' ? 'auto' : v === '__none' ? null : v
  if (b.value && b.value.model && b.value.model.id === id) return
  // 实际用的模型换了（自动 → 指定同一个不算）：挂点上的掩模签名（含对日扫描那一套）属于旧模型，同一次改动里删掉
  // （撤销时一起回来）；本页缓存同时清
  const before = sat.resolvedModel().id
  let changed = false
  sat.edit((x) => {
    x.model = { ...(x.model || {}), id }
    changed = sat.resolvedModel().id !== before
    if (changed) for (const m of x.mounts || []) { delete m.maskSig; delete m.maskSun }
  })
  if (changed) sat.dropMasks()
}
</script>

<template>
  <MdSec id="s-model" title="模型" :summary="resolvedName">
    <template v-if="b">
      <div class="srow">
        <label title="自动：按卫星名称 / NORAD 号 / 类别匹配库里的模型（GEO 通信星缺省用默认卫星）；无：不配模型">模型</label>
        <select class="ci sm-sel" :value="cur === 'auto' ? '__auto' : cur === null ? '__none' : cur" @change="setModel($event.target.value)">
          <option value="__auto">自动</option>
          <option value="__none">无</option>
          <option v-for="o in opts" :key="o.id" :value="o.id" data-i18n-skip>{{ o.label }}{{ o.tag ? ' · ' + o.tag : '' }}</option>
        </select>
      </div>
      <div v-if="resolved.auto && resolved.id" class="md-kvs">
        <div class="md-kv" :title="resolved.rule ? '匹配规则：' + resolved.rule : ''"><span class="k">自动匹配</span><span class="v sm-v" data-i18n-skip>{{ resolvedName }}</span></div>
      </div>
      <div v-else-if="cur !== null && resolved.id && !wb.byId(resolved.id)" class="md-state warn">模型不在库里。</div>
    </template>
  </MdSec>
</template>

<style scoped>
.sm-sel { flex: 1 1 160px; min-width: 0 !important; }
.sm-v { font-family: var(--font-ui) !important; overflow: hidden; text-overflow: ellipsis; }
</style>
