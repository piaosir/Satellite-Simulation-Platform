// 内置实体模板数据文件共用的小工具（三期契约 DESIGN3 E13；A3 规格 §7.1 / §7.3）。
//
// 纯函数、零依赖：四个领域数据文件（ground / air / sea / veh）各自 import，汇总与校验在 models/entityTemplates.mjs。
//
// 导出：
//   dim(value, unit, source, note?, confidence?)  一条有出处尺寸（value / unit / source / confidence 逐字抄研究表；note 为中性短句）
//   round9(v)                                    派生量取 1e-9 m 精度（避免 8.23 − 3.704 = 4.526000000000001 这类尾数进文档）
//   urlsOf(dims)                                 dims 里出现的 URL 去重（按出现顺序）
//   record(domain, r)                            记录收尾：补 domain / modelKind / fidelity / urls / hover / ops（缺省 {}）
//
// 记录形状（A3 规格 §7.3）：{id, domain, modelKind, title, titleZh, representative, fidelity, hover, urls, dims, prov, ops, needsInput, doc}
//   prov 的键：'<compId>.<param>' = 组件参数；'<compId>#massKg' = 组件级质量覆盖（装配文档 comps[].massKg，按比例缩放该件全部质量元）。
//   prov 的值：{dim, pick?, k?}（值 = dims[dim].value 取 [pick] 再 × k）或 {dims, derive, fn, with}（派生：derive 人读式子、fn 机读式子名、
//   with 式子里用到的示意输入；单测按 fn 独立重算对拍，式子清单见各数据文件文件头）。

/** 一条有出处的尺寸。confidence 缺省 primary（研究表原值是 secondary 的照抄 secondary）。 */
export const dim = (value, unit, source, note = null, confidence = 'primary') => (note ? { value, unit, source, confidence, note } : { value, unit, source, confidence })
export const round9 = (v) => Math.round(v * 1e9) / 1e9
export const urlsOf = (dims) => [...new Set(Object.values(dims).map((d) => d.source))]
const hoverOf = (rep, urls) => `代表型号：${rep}；出处：${urls.join('；')}`
/** 记录收尾：modelKind = 领域（schema.ASM_DOMAIN_KINDS 四个实体领域同名），urls 按 dims 出现顺序去重，hover 拼好。 */
export function record(domain, r) {
  const urls = urlsOf(r.dims)
  return { domain, modelKind: domain, fidelity: 'parametric', ops: {}, ...r, urls, hover: hoverOf(r.representative, urls) }
}
