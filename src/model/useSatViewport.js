// 「卫星」「分析」两页与预览视口的联动（ModelApp 调一次）：
//   · 在这两页时，预览里画当前卫星的挂点（mount：圆盘 + 视轴射线 + 视场锥），点圆盘选中挂点（与表格选中联动）；离开两页还原成模型挂点；
//   · 当前卫星的模型（绑定写了就用它，自动 = autoMatch）自动载入预览，不配模型时视口只留一句「未配模型。」；
//   · 选中挂点有掩模时画红色球面片（分析页「球面片」开关）；天线视角（分析页开关）离开两页即退出。
import { ref, watch } from 'vue'
import { byLang } from '../shared/i18n/lang.js'

export const SAT_TABS = ['sat', 'ana']

/**
 * @param {{wb:object, sat:object, getVp:()=>object|null}} o
 * @returns {{maskOn:import('vue').Ref<boolean>, av:import('vue').Ref<{mountId:string, fovDeg:number}|null>, apply:()=>void}}
 */
export function useSatViewport({ wb, sat, getVp }) {
  const { st, cur } = wb
  const maskOn = ref(true)
  const av = ref(null)   // 天线视角：{mountId, fovDeg} | null
  const on = () => SAT_TABS.includes(st.tab)

  // ── 挂点叠加与点选 ──
  let mountsOn = false
  function syncMounts() {
    const vp = getVp()
    if (!vp) return
    if (on() && sat.st.binding) {
      vp.setMounts(sat.mountsForViewport(), { selId: sat.st.mountSel || null })
      vp.onMountPick((id) => { sat.st.mountSel = id })
      mountsOn = true
    } else if (mountsOn) {
      vp.setMounts(null); vp.onMountPick(null)
      mountsOn = false
    }
  }
  watch(() => [st.tab, sat.st.rev, cur.id, cur.geomRev], syncMounts)
  watch(() => sat.st.mountSel, (id) => { const vp = getVp(); if (vp && mountsOn) vp.setMountSelection(id || null) })

  // ── 模型跟着卫星走 ──
  let lastWant = null
  async function syncModel() {
    if (!on() || !sat.st.satKey || !sat.st.binding) return
    if (!st.loaded) await wb.refresh()
    const r = sat.resolvedModel()
    const want = r.id || ''
    if (want === lastWant && (want ? cur.id === want : !cur.meta)) return
    lastWant = want
    if (!want) { wb.showBlank(byLang('未配模型。', 'No model.')); return }
    if (cur.id === want && (cur.meta || cur.loading)) return
    // 掩模按 lod1 算（DESIGN2 §2），预览也就停在 lod1（模型页要全精度时它自己升 lod0）
    if (wb.byId(want)) wb.select(want, { lod: 'lod1' })
    else { wb.showBlank(byLang('模型不在库里。', 'Model not in library.')) }
  }
  watch(() => [st.tab, sat.st.satKey, sat.st.binding && sat.st.binding.model && sat.st.binding.model.id, st.loaded, st.list.length], () => { syncModel() })

  // ── 掩模球面片 ──
  let lastMask = ''
  function syncMask() {
    const vp = getVp()
    if (!vp) return
    const rec = on() && sat.st.mountSel ? sat.maskOf(sat.st.mountSel) : null
    // 换模型 / 升降档（geomRev）时视口会丢掉球面片（它属于那一份几何），键里带上 geomRev 让它重挂
    const key = rec && cur.meta ? `${cur.id}|${cur.geomRev}|${sat.st.mountSel}|${rec.sig || ''}|${rec.originBody.join(',')}|${rec.stamp || ''}` : ''
    if (key !== lastMask) {
      lastMask = key
      vp.setMaskOverlay(rec && cur.meta ? { blocked: rec.mask.blocked, originBody: rec.originBody } : null)
    }
    vp.setMaskVisible(maskOn.value)
  }
  // maskOf 按当前输入（模型元数据 · 关节值 · 挂点）判签名：这些变了也要重判（cur.rev 覆盖轴向 / 缩放 / 参数化口径，sat.art 是关节值）
  watch(() => [st.tab, sat.st.mountSel, sat.st.maskRev, sat.st.rev, cur.id, cur.rev, cur.geomRev, cur.lod, maskOn.value, JSON.stringify(sat.art)], syncMask)

  // ── 天线视角 ──
  function syncAv() {
    const vp = getVp()
    if (!vp) return
    const a = av.value
    const m = a && on() ? sat.mounts.value.find((x) => x.id === a.mountId) : null
    if (!m || !cur.meta) { if (vp.antennaView) vp.setAntennaView(null); if (a && (!on() || !m)) av.value = null; return }
    // 不画的节点 = 掩模的排除名单（挂点 excludeNodes ∪ 模型「不遮挡」节点）：天线视角里看到的遮挡与掩模一致
    const hideNodes = [...(Array.isArray(m.excludeNodes) ? m.excludeNodes : []), ...(Array.isArray(cur.meta.noObscurationNodes) ? cur.meta.noObscurationNodes : [])]
    vp.setAntennaView({ posBody: m.posBody, boresightBody: m.boresightBody, upBody: m.upBody, fovDeg: a.fovDeg, hideNodes })
  }
  watch(() => [av.value, st.tab, sat.st.rev, cur.id, cur.geomRev], syncAv, { deep: true })

  function apply() {
    // 视口自己退出天线视角（切视角 1 / 3 / 7、功能区「视角」、聚焦）：按钮状态跟着灭
    const vp = getVp()
    if (vp && vp.onAntennaViewChange) vp.onAntennaViewChange((isOn) => { if (!isOn && av.value) av.value = null })
    lastMask = ''; syncMounts(); syncModel(); syncMask(); syncAv()
  }
  return { maskOn, av, apply }
}
