// 资源库表单的退役键（四窗共用，纯函数）。
//
// v1.5.4 在 GSO 资源库里加过五个字段：卫星「倾角 geoIncl / 偏心率 geoEcc / 东西保持 ± geoBoxEW」、
// 地球站「跟踪方式 trackMode / 跟踪残差 trackResidual」（收侧引擎键 rxTrackMode / rxTrackResidual）。
// 其后撤出资源库与引擎，改由 GSO 窗口的「指向误差」工具承接（components/LbPointingTool.vue，工具自己的状态不落盘）。
//
// 那一版存过的库里每份条目都带着它们（applyLibrary 按字段集补齐缺省值后整份入库），「复制到」别的窗口时也一并带过去。
// 引擎不再读、界面也不再画，但留在 form 里仍有两处后果：随分享包发出去；同参数的两份条目内容指纹对不上
// （并库时凭空多出「关口站 6.2m 2」）。故 GSO 窗口载入库时就地剥掉，分享包打包 / 拆包与内容指纹一律不认它们。
export const RETIRED_FORM_KEYS = Object.freeze(['geoIncl', 'geoEcc', 'geoBoxEW', 'trackMode', 'trackResidual', 'rxTrackMode', 'rxTrackResidual'])

const hasAny = (form) => !!form && typeof form === 'object' && RETIRED_FORM_KEYS.some((k) => k in form)

// 就地剥掉，返回剥掉了几个键（0 = 原样未动）
export function stripRetiredKeys(form) {
  if (!hasAny(form)) return 0
  let n = 0
  for (const k of RETIRED_FORM_KEYS) if (k in form) { delete form[k]; n++ }
  return n
}

// 不动原对象：没有退役键时原样返回同一个对象，有则返回剥掉后的浅拷贝
export function withoutRetiredKeys(form) {
  if (!hasAny(form)) return form
  const o = { ...form }
  stripRetiredKeys(o)
  return o
}
