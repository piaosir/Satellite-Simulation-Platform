// 端到端分享适配：体制在节点上，只有地球站与卫星两库；引用随每条链的节点走。
import { shareNgsoSat } from '../shared/lbShare.js'
import { normNgsoSat } from './e2eParams.js'

export function createE2eShareAdapter({ esConfigs, satConfigs, makeEsConfig, makeSatConfig, migrateCarriers }) {
  const packBase = (c) => ({ id: c.id, name: c.name, nameAuto: !!c.nameAuto, form: c.form })
  const lib = {
    es: { arr: esConfigs, label: '地球站', keys: [], pack: packBase, makeNew: makeEsConfig },
    sat: {
      arr: satConfigs, label: '卫星', keys: ['ngsoSat'],
      pack: (c) => ({ ...packBase(c), ngsoSat: normNgsoSat(c.ngsoSat) }),
      sanitize: (e) => ({ ...e, ngsoSat: shareNgsoSat(normNgsoSat(e.ngsoSat)) }),
      makeNew: makeSatConfig
    }
  }
  // 与本窗 resolveEs / resolveSat 一致：仅按 id 找，失效或留空均取第一份，不按名字命中。
  const resolve = (arr, id) => ((id && arr.find((c) => c.id === id)) || arr[0] || {}).id || ''
  function eachNode(st, visit) {
    for (const chain of (st && st.chains) || []) for (const nd of chain.nodes || []) visit(nd)
  }
  function refsOf(st) {
    const refs = { es: [], carrier: [], sat: [] }
    eachNode(st, (nd) => {
      if (nd.kind === 'es') refs.es.push(resolve(esConfigs, nd.esId))
      else refs.sat.push(resolve(satConfigs, nd.satId))
    })
    return refs
  }
  function pinRefs(st) {
    if (!st) return st
    const state = JSON.parse(JSON.stringify(st))
    // 未打开过的旧配置仍可能引用退役的载波库；先把体制内嵌，包不依赖发送方的旧库。
    if (migrateCarriers) for (const chain of state.chains || []) migrateCarriers(chain)
    eachNode(state, (nd) => {
      if (nd.kind === 'es') nd.esId = resolve(esConfigs, nd.esId)
      else nd.satId = resolve(satConfigs, nd.satId)
    })
    return state
  }
  function remapState(state, idMap) {
    eachNode(state, (nd) => {
      if (nd.kind === 'es') nd.esId = idMap.es[nd.esId] || ''
      else nd.satId = idMap.sat[nd.satId] || ''
    })
  }
  return { lib, refsOf, pinRefs, remapState }
}
