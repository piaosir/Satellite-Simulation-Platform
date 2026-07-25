// 3GPP NTN 载波带宽限值（IoT NTN / NR-NTN）——载波信号面板的合规提示单一出处。
//
// 为什么要判：DVB 系列的载波带宽由用户按转发器切片自由定，而 3GPP 体制的「信道带宽」是标准里
// 枚举死的几档，超出即不是该体制的合法载波。用户在本平台按 3GPP 体制做预算时，很容易顺手填一个
// 转发器口径的带宽（如 36 MHz），那条链路在真实 NTN 网络里根本配不出来。
//
// 口径：本平台「载波带宽」= 符号率 × 滚降/带宽因子。NTN MODCOD 表的带宽因子取 1.1，正是
// 「占用带宽 → 信道带宽」的换算（NR 资源块占用约信道带宽的 90%；NB-IoT 180 kHz PRB 落在
// 200 kHz 栅格上），故本文件的限值一律按【信道带宽】比较，与面板上那个数同口径。
//
// 数据来源：
//   · IoT NTN（NB-IoT NB1/NB2）：信道带宽 200 kHz、N_RB = 1（占用 180 kHz = 12×15 kHz）。
//     3GPP TS 36.101-5（IoT NTN UE 射频）§5.3；上行另有 3.75 kHz 单音模式，仍在同一 200 kHz 内。
//   · eMTC（Cat-M1）NTN：信道带宽 1.4 MHz、N_RB = 6（本平台 MODCOD 表未收 eMTC，仅备注）。
//   · NR-NTN FR1（L/S 频段 n254 / n255 / n256）：Rel-17 支持 5 / 10 / 15 / 20 MHz；
//     Rel-18 为 n255（L 频段）增加 30 MHz。见 3GPP TS 38.101-5 §5.3.5。
//   · NR-NTN FR2（Ka 频段 n510 / n511 / n512，Rel-18 起）：本文件不设限值——未取到权威信道带宽表，
//     宁可不判，也不拿 FR1 的数去误报（见下方 fr2Note）。
//
// ★ 判据只看「超没超」，不替用户下达标/合格一类的结论；具体取哪一档信道带宽由用户按频段与版本自定。

// 各体制的信道带宽档位（kHz）与适用范围
export const NTN_BW_LIMITS = {
  '3GPP NB-IoT NTN': {
    label: 'NB-IoT NTN',
    steps: [200],                 // 单载波只有一档
    maxKHz: 200,
    occupiedKHz: 180,             // 1 个 PRB = 12×15 kHz
    scope: '单载波信道带宽 200 kHz（占用带宽 180 kHz = 1 个 PRB）',
    ref: 'TS 36.101-5 §5.3'
  },
  '3GPP NR-NTN': {
    label: 'NR-NTN',
    steps: [5000, 10000, 15000, 20000, 30000],
    maxKHz: 30000,                // Rel-18 为 n255 增补的 30 MHz
    rel17MaxKHz: 20000,           // Rel-17 口径上限
    scope: 'FR1-NTN（L/S 频段 n254 / n255 / n256）信道带宽 5 / 10 / 15 / 20 MHz（Rel-17），Rel-18 为 n255 增加 30 MHz',
    ref: 'TS 38.101-5 §5.3.5',
    fr2Note: 'Ka 频段（FR2-NTN n510 / n511 / n512，Rel-18 起）信道带宽另有规定，本提示不覆盖'
  }
}

export function isNtnStandard(std) {
  return Object.prototype.hasOwnProperty.call(NTN_BW_LIMITS, std)
}

// 数值格式化：kHz → 便于阅读的 kHz / MHz
function fmtBw(kHz) {
  if (!isFinite(kHz)) return '--'
  return kHz >= 1000 ? `${+(kHz / 1000).toFixed(3)} MHz` : `${+kHz.toFixed(3)} kHz`
}

/**
 * 载波带宽是否超出所选 3GPP NTN 体制的信道带宽限值。
 * @param {string} standard  载波信号的「标准」字段（form.dvbStandard）
 * @param {number} bwKHz     当前载波带宽（kHz，即面板上那个数）
 * @returns {null|{level:'over'|'ok', text:string, limitKHz:number, fitKHz:number|null}}
 *          非 NTN 体制 / 带宽无效 → null（不提示）
 */
export function checkNtnBandwidth(standard, bwKHz) {
  const L = NTN_BW_LIMITS[standard]
  if (!L) return null
  const bw = Number(bwKHz)
  if (!isFinite(bw) || bw <= 0) return null
  // 落在哪一档标准信道带宽内（取能装下它的最小一档）
  const fit = L.steps.find((s) => bw <= s + 1e-9)
  if (fit == null) {
    const extra = L.fr2Note ? `。${L.fr2Note}` : ''
    return {
      level: 'over', limitKHz: L.maxKHz, fitKHz: null,
      text: `载波带宽 ${fmtBw(bw)} 超出 ${L.label} 信道带宽上限 ${fmtBw(L.maxKHz)}：${L.scope}（${L.ref}）${extra}`
    }
  }
  return {
    level: 'ok', limitKHz: L.maxKHz, fitKHz: fit,
    text: `${L.label}：需占用 ${fmtBw(fit)} 信道带宽（${L.scope}）`
  }
}
