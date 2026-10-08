// 无名标记的兜底名（点标记 / 地球站）：全平台一个口径。
// 中文「点标记N / 地球站N」（N = 标记表格里的行号，与各窗「导入站址」、主窗「分析 ▸」同一叫法），英文「Point N / Station N」。
// 名字是数据（送进计算窗、写进配置 / 链路名），呈现层翻不到打了 skip 的名字位，故按当前语言现出字。
import { byLang } from './i18n/lang.js'

/** 第 i 个（0 起）点标记的兜底名 */
export const pointFallbackName = (i) => byLang(`点标记${i + 1}`, `Point ${i + 1}`)
/** 第 i 个（0 起）地球站的兜底名 */
export const stationFallbackName = (i) => byLang(`地球站${i + 1}`, `Station ${i + 1}`)
