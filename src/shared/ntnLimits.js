// 3GPP NTN 载波带宽限值（IoT NTN / NR-NTN）——载波信号面板的合规提示单一出处。
//
// 为什么要判：DVB 系列的载波带宽由用户按转发器切片自由定，而 3GPP 体制的「信道带宽」是标准里
// 枚举死的几档，超出即不是该体制的合法载波。用户在本平台按 3GPP 体制做预算时，很容易顺手填一个
// 转发器口径的带宽（如 36 MHz），那条链路在真实 NTN 网络里根本配不出来。
//
// 口径：本平台「载波带宽」= 符号率 × 滚降/带宽因子，对 3GPP 各档即【信道带宽】，故本文件的限值
// 一律按信道带宽比较，与面板上那个数同口径。
//
// ★ 2026-09-05：3GPP 载波改按物理层参数 phy 描述（PRB 数 + 子载波间隔 + MCS，见 ntnPhy.js）之后，
//   snr 口径的行的信道带宽本来就是从 TS 38.101-5 的档位表【查出来的】，不可能超限 —— 那种行本判据
//   恒不出（checkNtnBandwidth 第三个参数传 'snr' 即返回 null）。留着它是为了老配置：
//   帧效率 0.9 + 滚降 1.1 + Es/N₀ 口径的那些行，带宽仍由用户填的信息速率反推，照旧要判。
//
// 数据来源：
//   · 档位表不再在本文件里写死，直接派生自 ntnPhy.NR_RB_TABLE —— 那一份是 TS 38.101-5 Table 5.3.2-1
//     的转录，两处各写一遍迟早会分叉。
//   · NB-IoT NTN：信道带宽 200 kHz、N_RB = 1（占用 180 kHz = 12×15 kHz）；上行另有 3.75 kHz
//     单音模式，仍在同一 200 kHz 内。
//     ★ IoT-NTN 有独立的 UE 射频分册：TS 36.102（E-UTRA UE radio transmission and reception for
//       satellite access，V18.11.0 2026-02），SAN 侧是 TS 36.108。Table 5.3B-1：NB1/NB2 信道带宽
//       200 kHz、N_RB = 1、N_tone = 12@15 kHz / 48@3.75 kHz；§5.4B.1：独立部署标称栅格 200 kHz、
//       带内 180 kHz；Table 5.2-1：卫星接入频段 256 / 255 / 254 / 253。载波结构见 TS 36.211 §10，
//       NTN 上下文见 TR 36.763。
//       （早先这里写「36.101 不分册、IoT-NTN 未见独立的 UE 射频分册」——那条诚实边界已由原文消解。）
//   · eMTC（Cat-M1）NTN：信道带宽 1.4 MHz、N_RB = 6（TS 36.102 Table 5.3A-1）。IoT-NTN 是含
//     NB-IoT 与 eMTC 两条的上位概念，本平台只做了 NB-IoT 那一半，eMTC 未收，仅备注。
//   · NR-NTN：逐频段的信道带宽档在 TS 38.101-5 Table 5.3.5-1/-2，已按 V19.5.0 全量收进
//     ntnPhy.NTN_BANDS（含 Rel-19 新增的 n253/n252/n251/n250 与 Ku 的 n248/n247、n509/n508）；
//     FR2-NTN 的 N_RB 表也已核到原文 Table 5.3.2-2，早先「按 TS 38.101-2 同值收」的诚实边界已消解。
//     ★ 30 MHz 不在任何频段的档位里：V18.6.0 / V18.11.0 / V19.5.0 三版的 5.3.5-1 逐频段一栏都没有它，
//       CR 0033「Adding 30 MHz CBW for NTN UE」只往 N_RB 表（5.3.2-1）加了一列。早先
//       「Rel-18 为 n255 增加 30 MHz」的说法不成立，已删。
//
// ★ 判据只看「超没超」，不替用户下达标/合格一类的结论；具体取哪一档信道带宽由用户按频段与版本自定。

// ★ 档位【写死】成 Rel-17 的 L/S 四档，不再派生自 ntnPhy 的清单。
//   本判据现在只对老式 esno 行生效，那些配置成型时平台里只有 Rel-17 的 L/S 频段（n254/n255/n256），
//   可选的就是 5 / 10 / 15 / 20 MHz。Rel-19 给 Ku 的 n248/n247 开到 100 MHz、FR2 开到 400 MHz，
//   把这些并进来只会让「填了 36 MHz」这种明显配不出的带宽变成「落 50 MHz 档」。
//   新配置走 phy 描述（那条路按频段逐档校验，本判据恒不出）。
const NR_STEPS = [5000, 10000, 15000, 20000]

// 各体制的信道带宽档位（kHz）与适用范围。键按前缀匹配：'3GPP NR-NTN T2' 一类的新增表共用同一份限值。
export const NTN_BW_LIMITS = {
  '3GPP NB-IoT NTN': {
    label: 'NB-IoT NTN',
    steps: [200],                 // 单载波只有一档
    maxKHz: 200,
    occupiedKHz: 180,             // 1 个 PRB = 12×15 kHz
    scope: '单载波信道带宽 200 kHz（占用带宽 180 kHz = 1 个 PRB）',
    ref: 'TS 36.102 §5.3B · TS 36.211 §10'
  },
  '3GPP NR-NTN': {
    label: 'NR-NTN',
    steps: NR_STEPS,
    maxKHz: NR_STEPS[NR_STEPS.length - 1],
    scope: 'FR1-NTN（n254 / n255 / n256）5 / 10 / 15 / 20 MHz',
    fr2Scope: 'FR2-NTN（n510 / n511 / n512 与 n509 / n508（Ku，120 kHz））50 / 100 / 200 / 400 MHz',
    ref: 'TS 38.101-5 V19.5.0 Table 5.3.5-1'
  }
}

// 标准 key → 限值档。按前缀匹配：NB-IoT 的三张表、NR 的五张表各共用一份（key 见 modcodTables.BUILTIN）。
// ★ 先试 NB-IoT 再试 NR：'3GPP NB-IoT NTN' 不以 '3GPP NR-NTN' 开头，两者本不相交，但把更长的放前面
//   能保证将来加 key 时不至于被短前缀抢走。
function limitOf(std) {
  const k = String(std == null ? '' : std)
  if (k.indexOf('3GPP NB-IoT NTN') === 0) return NTN_BW_LIMITS['3GPP NB-IoT NTN']
  if (k.indexOf('3GPP NR-NTN') === 0) return NTN_BW_LIMITS['3GPP NR-NTN']
  return null
}

export function isNtnStandard(std) {
  return !!limitOf(std)
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
 * @param {string} [mode]    门限口径（form.noiseRatioMode）：'snr' 的行带宽是查表来的，恒不提示
 * @returns {null|{level:'over'|'ok', text:string, limitKHz:number, fitKHz:number|null}}
 *          非 NTN 体制 / 按 phy 描述的行 / 带宽无效 → null（不提示）
 */
export function checkNtnBandwidth(standard, bwKHz, mode) {
  if (mode === 'snr') return null
  const L = limitOf(standard)
  if (!L) return null
  const bw = Number(bwKHz)
  if (!isFinite(bw) || bw <= 0) return null
  // 落在哪一档标准信道带宽内（取能装下它的最小一档）
  const fit = L.steps.find((s) => bw <= s + 1e-9)
  if (fit == null) {
    return {
      level: 'over', limitKHz: L.maxKHz, fitKHz: null,
      text: `载波带宽 ${fmtBw(bw)} 超出 ${L.label} 信道带宽上限 ${fmtBw(L.maxKHz)}：${L.scope}（${L.ref}）`
    }
  }
  return {
    level: 'ok', limitKHz: L.maxKHz, fitKHz: fit,
    text: `${L.label}：需占用 ${fmtBw(fit)} 信道带宽（${L.scope}）`
  }
}
