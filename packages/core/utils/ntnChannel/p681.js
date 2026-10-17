// ITU-R P.681-11（08/2019）陆地移动卫星业务（LMSS）传播数据 —— 衰落余量（纯函数，CommonJS）。
//
// 主体是 Annex 1 §6.1「单星链路衰落统计预测」：增强二状态（GOOD / BAD）半马尔可夫模型 + Loo 分布，
// 参数表逐值取自 Annex 2（Tables 7–10 及其后 54 张参数表）。给定频率 / 环境 / 仰角与时间（或位置、
// 行驶距离）百分比 p，求「信号低于 LOS 电平 F dB 的概率 = p」的衰落余量 F。
//
// 模型（§6，式 (14)–(21)）：
//   · 状态时长服从对数正态（式 14，参数 μ、σ 是 ln(米) 的均值与标准差），有最短时长 dur_min；
//   · 状态内信号 = 直射分量 A + 漫射多径（瑞利）。20lg A ~ N(M_A, Σ_A²)，M_A ~ N(μ_MA, σ_MA²)
//     截尾（GOOD 取 5%–95%，即 μ ± 1.645σ；BAD 取 [p_B,min, p_B,max]，式 18）；
//     Σ_A = g1·M_A + g2，多径功率 MP = h1·M_A + h2（dB，相对 LOS）；
//   · 式 (17a) 截尾对数正态均值给出 <dur>_G、<dur>_B；式 (17b) 过渡长度 <dur>_T；
//     式 (19) p_G = (<dur>_G + <dur>_T)/(<dur>_G + <dur>_B + 2<dur>_T)，p_B 同理；
//   · 式 (20a)：P(x ≤ x0 | 状态) = ∫dM_A ∫da ∫dx（截尾正态 × 对数正态 × 莱斯）；式 (20b)：σ_MA = 0 时去掉 M_A 积分；
//   · 式 (21)：P(x ≤ x0) = p_G·P(x ≤ x0|G) + p_B·P(x ≤ x0|B)。
//   x 是相对无遮挡 LOS 电平（0 dB）的接收包络，衰落余量 F(p) = −20lg x0，P(x ≤ x0) = p/100。
//
// 实现说明（与原文的对应）：
//   · 式 (20a) 最内层 ∫₀^x0 dx 是莱斯 CDF，用 numeric.riceCdf 精确算（= 1 − Marcum Q1），不做近似；
//     a 的积分限 a_min/a_max = 10^((M_A ∓ 3Σ_A)/20) 照原文【不归一化】（只覆盖 99.73%），
//     所以 P(x ≤ ∞) = 0.9973，p ≥ 99.73% 的余量不存在（返回 null）——这正是原文式子的行为。
//   · Σ_A = g1·M_A + g2 在截尾区间内个别表会过零变负（如 20 GHz 郊区 BAD：g1 = −0.45, g2 = 0）。
//     照原文积分限写法，Σ_A < 0 时 a_min > a_max、被积函数也带负号，两负相乘结果等于用 |Σ_A|；
//     本实现直接取 |Σ_A|（Σ_A 极小时退化为确定的直射幅度）。式 (22)(24) 同样取 |Σ_A|。
//   · 式 (17a) 里的 log 是自然对数：式 (14) 时长分布按 ln x 写，且只有按 ln 解读，
//     复算出的 Figure 12 曲线（城区 30°：P(x<−10 dB) ≈ 0.47）才对得上。
//   · Step 0「取频率与仰角最接近的表」：频率先按 Tables 8/9/10 的标称区间（1.5–3 / 3–5 / 10–20 GHz）归档，
//     区间之外（5–10 GHz）按最近频率；同档内仰角取最近，正好居中时取较低仰角（低仰角衰落更深，偏保守）。
//     该环境在所选频档没有表（例如 20 GHz 的 village）→ 返回 null，不跨档凑。
//   · 适用范围（§6.1）：仰角 20°–90°，频率 1.5–20 GHz；超出返回 null。
//   · 参数表的测量天线：1.5–5 GHz 为 < 5 dBi，11.7 GHz 为 19 dBi，20 GHz 为 31 dBi（各表 Information 行，
//     见 gainDbi）。多径功率随天线方向性变，0 dBi 手持终端的多径会比表里略强，用时心里有数。
//
// ★ 原文正文与原文示例图不一致（参数表与 §6.1 正文在 P.681-8 / -10 / -11 三版相同）：
//   式 (18a)(18b) 与式 (20a) 下表要求 BAD 状态的 M_A 截在 [p_B,min, p_B,max]（多为 10%–90%）。
//   照此复算 Figures 12–14（2.2 GHz 城区 / 郊区 30°），0 到 −10 dB 与图吻合（±0.01），
//   但深衰落尾部比图轻：城区 30° 在 −20 dB 处 0.109 对图 0.133，−30 dB 处 0.012 对 0.017；
//   Figure 14 总功率在 −20 dB 处 0.004 对 0.035。
//   只去掉 BAD 状态 M_A 的【下】截断（保留上截断与 GOOD 的 5%–95%），三张图全部复现：
//   Figure 12 城区 30° 0.895/0.602/0.467/0.292/0.133/0.049/0.016（图 0.893/0.600/0.465/0.290/0.133/0.050/0.017），
//   Figure 14 城区 30° 0.910/0.572/0.481/0.222/0.036（图 0.91/0.572/0.48/0.222/0.035）。
//   可见原文示例图是按「BAD 只截上限」算的。缺省按正文公式（badMaLowerCut = true）；
//   传 { badMaLowerCut: false } 即按示例图口径，深衰落余量更大、偏保守
//   （2.2 GHz 城区 30°：p = 1% / 10% 时 32.2 / 21.5 dB，正文口径 30.9 / 20.4 dB）。
//   两种口径的取舍留给使用方拍板。
//
// 另附（同样给出「p% 距离 / 时间下的衰落」）：
//   §4.1.1 路边树木遮蔽经验模型（式 1–5，Step 4，§4.1.1.1 + Table 1 高仰角外推）；
//   §4.2   路边建筑遮挡概率（式 8）；
//   §5.1 / §5.2 清晰视距下山区 / 林荫路多径衰落（式 12 / 13，Tables 3 / 4）。
//
// 原文：https://www.itu.int/rec/R-REC-P.681-11-201908-I/en

const { erf, erfc, normPdf, normCdf, normInv, integrate, riceCdf, brentRoot, num } = require('./numeric.js')

// ===== Annex 2 参数表（54 张，逐值转录；行序 = Table 7 的格式）=====
// 字段：mu/sigma = 状态时长对数正态参数（ln 米）；durMin = 最短时长（米）；muMA/sigmaMA = M_A 的分布（dB）；
//       h1/h2 → MP = h1·M_A + h2（dB）；g1/g2 → Σ_A = g1·M_A + g2（dB）；lcorr = 直射幅度相关距离（米，仅生成模型用）；
//       f1/f2 → L_trans = f1·ΔM_A + f2（米）；pB = BAD 状态 M_A 取值的概率区间；gainDbi = 测量天线增益。
// 原表的两处排版问题照实处理、不改数：
//   · 2.2 GHz 村镇 30° 与 3.8 GHz 郊区 30° 两张表的第 3–5 行标签印错（印成 h1,h2 / g1,g2 / h1,h2），
//     数值仍按 Table 7 的行序排列（μ_MA,σ_MA / h1,h2 / g1,g2），按位置取数；
//   · 2.2 GHz 郊区 70° 与城区 70° 两张表数值完全相同（原文如此）；
//   · 2.2 GHz 乡村林地 45° 原表标题写作「Wooded」；20 GHz 铁路的表题写作「Train」（Table 10 称 Railway）。
const P681_TABLES = [
  // 2.2 GHz / 城区 / 20°
  { fGHz: 2.2, env: 'urban', elev: 20, gainDbi: '<5',
    G: { mu: 2.0042, sigma: 1.2049, durMin: 3.9889, muMA: -3.3681, sigmaMA: 3.3226, h1: 0.1739, h2: -11.5966, g1: 0.0036, g2: 1.3230, lcorr: 0.9680 },
    B: { mu: 3.689, sigma: 0.9796, durMin: 10.3114, muMA: -18.1771, sigmaMA: 3.2672, h1: 1.1411, h2: 4.0581, g1: -0.2502, g2: -1.2528, lcorr: 0.9680 },
    f1: 0.0870, f2: 2.8469, pB: [0.1, 0.9] },
  // 2.2 GHz / 城区 / 30°
  { fGHz: 2.2, env: 'urban', elev: 30, gainDbi: '<5',
    G: { mu: 2.7332, sigma: 1.1030, durMin: 7.3174, muMA: -2.3773, sigmaMA: 2.1222, h1: 0.0941, h2: -13.1679, g1: -0.2811, g2: 0.9323, lcorr: 1.4731 },
    B: { mu: 2.7582, sigma: 1.2210, durMin: 5.7276, muMA: -17.4276, sigmaMA: 3.9532, h1: 0.9175, h2: -0.8009, g1: -0.1484, g2: 0.5910, lcorr: 1.4731 },
    f1: 0.1378, f2: 3.3733, pB: [0.1, 0.9] },
  // 2.2 GHz / 城区 / 45°
  { fGHz: 2.2, env: 'urban', elev: 45, gainDbi: '<5',
    G: { mu: 3.0639, sigma: 1.6980, durMin: 10.0, muMA: -1.8225, sigmaMA: 1.1317, h1: -0.0481, h2: -14.7450, g1: -0.4643, g2: 0.3334, lcorr: 1.7910 },
    B: { mu: 2.9108, sigma: 1.2602, durMin: 6.0, muMA: -15.4844, sigmaMA: 3.3245, h1: 0.9434, h2: -1.7555, g1: -0.0798, g2: 2.8101, lcorr: 1.7910 },
    f1: 0.0744, f2: 2.1423, pB: [0.1, 0.9] },
  // 2.2 GHz / 城区 / 60°
  { fGHz: 2.2, env: 'urban', elev: 60, gainDbi: '<5',
    G: { mu: 2.8135, sigma: 1.5962, durMin: 10.0, muMA: -1.5872, sigmaMA: 1.2446, h1: -0.5168, h2: -17.4060, g1: -0.1953, g2: 0.5353, lcorr: 1.7977 },
    B: { mu: 2.0211, sigma: 0.6568, durMin: 1.9126, muMA: -14.1435, sigmaMA: 3.2706, h1: 0.6975, h2: -7.5383, g1: 0.0422, g2: 3.2030, lcorr: 1.7977 },
    f1: -0.1285, f2: 5.4991, pB: [0.1, 0.9] },
  // 2.2 GHz / 城区 / 70°
  { fGHz: 2.2, env: 'urban', elev: 70, gainDbi: '<5',
    G: { mu: 4.2919, sigma: 2.4703, durMin: 118.3312, muMA: -1.8434, sigmaMA: 0.5370, h1: -4.7301, h2: -26.5687, g1: 0.5192, g2: 1.9583, lcorr: 2.0963 },
    B: { mu: 2.1012, sigma: 1.0341, durMin: 4.8569, muMA: -12.9383, sigmaMA: 1.7588, h1: 2.5318, h2: 16.8468, g1: 0.3768, g2: 8.4377, lcorr: 2.0963 },
    f1: -0.0826, f2: 2.8824, pB: [0.1, 0.9] },
  // 2.2 GHz / 郊区 / 20°
  { fGHz: 2.2, env: 'suburban', elev: 20, gainDbi: '<5',
    G: { mu: 2.2201, sigma: 1.2767, durMin: 2.2914, muMA: -2.7191, sigmaMA: 1.3840, h1: -0.3037, h2: -13.0719, g1: -0.1254, g2: 0.7894, lcorr: 0.9290 },
    B: { mu: 2.2657, sigma: 1.3812, durMin: 2.5585, muMA: -13.8808, sigmaMA: 2.5830, h1: 1.0136, h2: 0.5158, g1: -0.1441, g2: 0.7757, lcorr: 0.9290 },
    f1: 0.2904, f2: 1.0324, pB: [0.1, 0.9] },
  // 2.2 GHz / 郊区 / 30°
  { fGHz: 2.2, env: 'suburban', elev: 30, gainDbi: '<5',
    G: { mu: 3.0138, sigma: 1.4161, durMin: 8.3214, muMA: -0.7018, sigmaMA: 1.2107, h1: -0.6543, h2: -14.6457, g1: -0.1333, g2: 0.8992, lcorr: 1.7135 },
    B: { mu: 2.4521, sigma: 0.7637, durMin: 5.9087, muMA: -11.9823, sigmaMA: 3.4728, h1: 0.6200, h2: -7.5485, g1: -0.1644, g2: 0.2762, lcorr: 1.7135 },
    f1: 0.1091, f2: 3.3000, pB: [0.1, 0.9] },
  // 2.2 GHz / 郊区 / 45°
  { fGHz: 2.2, env: 'suburban', elev: 45, gainDbi: '<5',
    G: { mu: 4.5857, sigma: 1.3918, durMin: 126.8375, muMA: -1.1496, sigmaMA: 1.0369, h1: 0.2148, h2: -17.8462, g1: 0.0729, g2: 1.0303, lcorr: 3.2293 },
    B: { mu: 2.2414, sigma: 0.7884, durMin: 4.3132, muMA: -10.3806, sigmaMA: 2.3543, h1: 0.0344, h2: -14.2087, g1: 0.0662, g2: 3.5043, lcorr: 3.2293 },
    f1: 0.5766, f2: 0.7163, pB: [0.1, 0.9] },
  // 2.2 GHz / 郊区 / 60°
  { fGHz: 2.2, env: 'suburban', elev: 60, gainDbi: '<5',
    G: { mu: 3.4124, sigma: 1.4331, durMin: 19.5431, muMA: -0.7811, sigmaMA: 0.7979, h1: -2.1102, h2: -19.7954, g1: -0.2284, g2: 0.2796, lcorr: 2.0215 },
    B: { mu: 1.9922, sigma: 0.7132, durMin: 3.1213, muMA: -12.1436, sigmaMA: 3.1798, h1: 0.4372, h2: -8.3651, g1: -0.2903, g2: -0.6001, lcorr: 2.0215 },
    f1: -0.4097, f2: 8.7440, pB: [0.1, 0.9] },
  // 2.2 GHz / 郊区 / 70°
  { fGHz: 2.2, env: 'suburban', elev: 70, gainDbi: '<5',
    G: { mu: 4.2919, sigma: 2.4703, durMin: 118.3312, muMA: -1.8434, sigmaMA: 0.5370, h1: -4.7301, h2: -26.5687, g1: 0.5192, g2: 1.9583, lcorr: 2.0963 },
    B: { mu: 2.1012, sigma: 1.0341, durMin: 4.8569, muMA: -12.9383, sigmaMA: 1.7588, h1: 2.5318, h2: 16.8468, g1: 0.3768, g2: 8.4377, lcorr: 2.0963 },
    f1: -0.0826, f2: 2.8824, pB: [0.1, 0.9] },
  // 2.2 GHz / 村镇 / 20°
  { fGHz: 2.2, env: 'village', elev: 20, gainDbi: '<5',
    G: { mu: 2.7663, sigma: 1.1211, durMin: 6.5373, muMA: -2.5017, sigmaMA: 2.3059, h1: 0.0238, h2: -11.4824, g1: -0.2735, g2: 1.3898, lcorr: 0.8574 },
    B: { mu: 2.2328, sigma: 1.3788, durMin: 2.8174, muMA: -15.2300, sigmaMA: 5.0919, h1: 0.9971, h2: 0.8970, g1: -0.0568, g2: 1.9253, lcorr: 0.8574 },
    f1: 0.0644, f2: 2.6740, pB: [0.1, 0.9] },
  // 2.2 GHz / 村镇 / 30°
  { fGHz: 2.2, env: 'village', elev: 30, gainDbi: '<5',
    G: { mu: 2.4246, sigma: 1.3025, durMin: 5.4326, muMA: -2.2284, sigmaMA: 1.4984, h1: -0.3431, h2: -14.0798, g1: -0.2215, g2: 1.0077, lcorr: 0.8264 },
    B: { mu: 1.8980, sigma: 1.0505, durMin: 2.4696, muMA: -15.1583, sigmaMA: 4.0987, h1: 0.9614, h2: 0.3719, g1: -0.0961, g2: 1.3123, lcorr: 0.8264 },
    f1: -0.0576, f2: 3.3977, pB: [0.1, 0.9] },
  // 2.2 GHz / 村镇 / 45°
  { fGHz: 2.2, env: 'village', elev: 45, gainDbi: '<5',
    G: { mu: 2.8402, sigma: 1.4563, durMin: 10.4906, muMA: -1.2871, sigmaMA: 0.6346, h1: -0.0222, h2: -16.7316, g1: -0.3905, g2: 0.4880, lcorr: 1.4256 },
    B: { mu: 1.8509, sigma: 0.8736, durMin: 2.6515, muMA: -12.6718, sigmaMA: 3.1722, h1: 0.8329, h2: -3.9947, g1: -0.0980, g2: 1.3381, lcorr: 1.4256 },
    f1: -0.0493, f2: 5.3952, pB: [0.1, 0.9] },
  // 2.2 GHz / 村镇 / 60°
  { fGHz: 2.2, env: 'village', elev: 60, gainDbi: '<5',
    G: { mu: 3.7630, sigma: 1.2854, durMin: 17.6726, muMA: -0.5364, sigmaMA: 0.6115, h1: -0.1418, h2: -17.8032, g1: -0.2120, g2: 0.7819, lcorr: 0.8830 },
    B: { mu: 1.7192, sigma: 1.1420, durMin: 2.5981, muMA: -9.5399, sigmaMA: 2.0732, h1: -0.4454, h2: -16.8201, g1: 0.0609, g2: 2.5925, lcorr: 0.8830 },
    f1: -0.8818, f2: 10.1610, pB: [0.1, 0.9] },
  // 2.2 GHz / 村镇 / 70°
  { fGHz: 2.2, env: 'village', elev: 70, gainDbi: '<5',
    G: { mu: 4.0717, sigma: 1.2475, durMin: 30.8829, muMA: -0.3340, sigmaMA: 0.6279, h1: -1.6253, h2: -19.7558, g1: -0.4438, g2: 0.6355, lcorr: 1.5633 },
    B: { mu: 1.5673, sigma: 0.5948, durMin: 2.1609, muMA: -8.3686, sigmaMA: 2.5603, h1: 0.1788, h2: -9.5153, g1: -0.0779, g2: 1.1209, lcorr: 1.5633 },
    f1: -0.3483, f2: 5.1244, pB: [0.1, 0.9] },
  // 2.2 GHz / 乡村林地 / 20°
  { fGHz: 2.2, env: 'ruralWooded', elev: 20, gainDbi: '<5',
    G: { mu: 2.1597, sigma: 1.3766, durMin: 2.0744, muMA: -0.8065, sigmaMA: 1.5635, h1: -0.9170, h2: -12.1228, g1: -0.0348, g2: 0.9571, lcorr: 0.8845 },
    B: { mu: 1.9587, sigma: 1.5465, durMin: 1.3934, muMA: -10.6615, sigmaMA: 2.6170, h1: 0.8440, h2: -1.4804, g1: -0.1069, g2: 1.6141, lcorr: 0.8845 },
    f1: 0.0550, f2: 2.6383, pB: [0.1, 0.9] },
  // 2.2 GHz / 乡村林地 / 30°
  { fGHz: 2.2, env: 'ruralWooded', elev: 30, gainDbi: '<5',
    G: { mu: 2.5579, sigma: 1.2444, durMin: 3.5947, muMA: -1.3214, sigmaMA: 1.6645, h1: -1.0445, h2: -14.3176, g1: -0.1656, g2: 0.7180, lcorr: 1.0942 },
    B: { mu: 2.3791, sigma: 1.1778, durMin: 2.2800, muMA: -10.4240, sigmaMA: 2.4446, h1: 0.6278, h2: -4.8146, g1: -0.0451, g2: 2.2327, lcorr: 1.0942 },
    f1: 0.0256, f2: 3.8527, pB: [0.1, 0.9] },
  // 2.2 GHz / 乡村林地 / 45°（原表标题写作 Wooded）
  { fGHz: 2.2, env: 'ruralWooded', elev: 45, gainDbi: '<5',
    G: { mu: 3.1803, sigma: 1.3427, durMin: 6.7673, muMA: -0.9902, sigmaMA: 1.0348, h1: -0.4235, h2: -16.8380, g1: -0.1095, g2: 0.6893, lcorr: 2.3956 },
    B: { mu: 2.5382, sigma: 1.1291, durMin: 3.3683, muMA: -10.2891, sigmaMA: 2.3090, h1: 0.3386, h2: -9.7118, g1: -0.0460, g2: 2.1310, lcorr: 2.3956 },
    f1: 0.2803, f2: 4.0004, pB: [0.1, 0.9] },
  // 2.2 GHz / 乡村林地 / 60°
  { fGHz: 2.2, env: 'ruralWooded', elev: 60, gainDbi: '<5',
    G: { mu: 2.9322, sigma: 1.3234, durMin: 5.7209, muMA: -0.6153, sigmaMA: 1.1723, h1: -1.4024, h2: -16.9664, g1: -0.2516, g2: 0.5353, lcorr: 1.7586 },
    B: { mu: 2.1955, sigma: 1.1115, durMin: 1.6512, muMA: -9.9595, sigmaMA: 2.2188, h1: 0.2666, h2: -9.0046, g1: -0.0907, g2: 1.4730, lcorr: 1.7586 },
    f1: 0.1099, f2: 4.2183, pB: [0.1, 0.9] },
  // 2.2 GHz / 乡村林地 / 70°
  { fGHz: 2.2, env: 'ruralWooded', elev: 70, gainDbi: '<5',
    G: { mu: 3.8768, sigma: 1.4738, durMin: 16.0855, muMA: -0.7818, sigmaMA: 0.7044, h1: -2.9566, h2: -20.0326, g1: -0.2874, g2: 0.4050, lcorr: 1.6546 },
    B: { mu: 1.8445, sigma: 0.8874, durMin: 2.9629, muMA: -6.7769, sigmaMA: 2.1339, h1: -0.3723, h2: -14.9638, g1: -0.1822, g2: 0.1163, lcorr: 1.6546 },
    f1: -0.3914, f2: 6.6931, pB: [0.1, 0.9] },
  // 2.2 GHz / 居民区 / 20°
  { fGHz: 2.2, env: 'residential', elev: 20, gainDbi: '<5',
    G: { mu: 2.5818, sigma: 1.7310, durMin: 9.2291, muMA: -0.8449, sigmaMA: 1.3050, h1: -0.3977, h2: -12.3714, g1: 0.0984, g2: 1.3138, lcorr: 1.1578 },
    B: { mu: 1.7136, sigma: 1.1421, durMin: 1.6385, muMA: -10.8315, sigmaMA: 2.2642, h1: 0.8589, h2: -2.4054, g1: -0.1804, g2: 0.8553, lcorr: 1.1578 },
    f1: 0.0994, f2: 2.4200, pB: [0.1, 0.9] },
  // 2.2 GHz / 居民区 / 30°
  { fGHz: 2.2, env: 'residential', elev: 30, gainDbi: '<5',
    G: { mu: 3.2810, sigma: 1.4200, durMin: 14.4825, muMA: -1.3799, sigmaMA: 1.0010, h1: -0.8893, h2: -16.4615, g1: -0.2432, g2: 0.6519, lcorr: 1.9053 },
    B: { mu: 1.8414, sigma: 0.9697, durMin: 2.7681, muMA: -11.1669, sigmaMA: 2.4724, h1: -0.1030, h2: -13.7102, g1: -0.1025, g2: 1.7671, lcorr: 1.9053 },
    f1: 0.0196, f2: 3.9374, pB: [0.1, 0.9] },
  // 2.2 GHz / 居民区 / 60°
  { fGHz: 2.2, env: 'residential', elev: 60, gainDbi: '<5',
    G: { mu: 3.255, sigma: 1.287, durMin: 6.47, muMA: 0, sigmaMA: 0.30, h1: -2.024, h2: -19.454, g1: 0.273, g2: 0.403, lcorr: 3.84 },
    B: { mu: 3.277, sigma: 1.260, durMin: 7.81, muMA: -2.32, sigmaMA: 2.06, h1: -1.496, h2: -22.894, g1: -0.361, g2: -0.119, lcorr: 3.84 },
    f1: -1.591, f2: 12.274, pB: [0.1, 0.9] },
  // 2.2 GHz / 居民区 / 70°
  { fGHz: 2.2, env: 'residential', elev: 70, gainDbi: '<5',
    G: { mu: 4.3291, sigma: 0.7249, durMin: 27.3637, muMA: -0.1625, sigmaMA: 0.3249, h1: 0.6321, h2: -21.5594, g1: 0.1764, g2: 0.4135, lcorr: 1.6854 },
    B: { mu: 3.4534, sigma: 0.9763, durMin: 8.9481, muMA: -1.6084, sigmaMA: 0.5817, h1: -0.3976, h2: -22.7905, g1: -0.0796, g2: 0.1939, lcorr: 1.6854 },
    f1: 3.0127, f2: 6.2345, pB: [0.1, 0.9] },
  // 3.8 GHz / 城区 / 20°
  { fGHz: 3.8, env: 'urban', elev: 20, gainDbi: '<5',
    G: { mu: 2.5467, sigma: 1.0431, durMin: 5.2610, muMA: -2.7844, sigmaMA: 2.6841, h1: 0.1757, h2: -12.9417, g1: -0.2044, g2: 1.5866, lcorr: 1.4243 },
    B: { mu: 3.6890, sigma: 0.9796, durMin: 10.3114, muMA: -19.4022, sigmaMA: 3.2428, h1: 0.9638, h2: -0.9382, g1: 0.0537, g2: 4.5670, lcorr: 1.4243 },
    f1: 0.1073, f2: 1.9199, pB: [0.1, 0.9] },
  // 3.8 GHz / 城区 / 30°
  { fGHz: 3.8, env: 'urban', elev: 30, gainDbi: '<5',
    G: { mu: 2.0158, sigma: 1.2348, durMin: 4.5491, muMA: -3.7749, sigmaMA: 2.2381, h1: -0.1564, h2: -15.1531, g1: -0.0343, g2: 1.0602, lcorr: 0.8999 },
    B: { mu: 2.2627, sigma: 1.4901, durMin: 2.0749, muMA: -17.9098, sigmaMA: 2.9828, h1: 0.8250, h2: -2.5833, g1: -0.0741, g2: 2.1406, lcorr: 0.8999 },
    f1: 0.2707, f2: -0.0287, pB: [0.1, 0.9] },
  // 3.8 GHz / 城区 / 45°
  { fGHz: 3.8, env: 'urban', elev: 45, gainDbi: '<5',
    G: { mu: 2.3005, sigma: 1.6960, durMin: 10.0, muMA: -1.4466, sigmaMA: 1.1472, h1: 0.1550, h2: -13.6861, g1: 0.1666, g2: 1.2558, lcorr: 1.6424 },
    B: { mu: 2.6314, sigma: 1.1210, durMin: 6.0, muMA: -15.3926, sigmaMA: 3.2527, h1: 0.9509, h2: -1.2462, g1: 0.0363, g2: 4.4356, lcorr: 1.6424 },
    f1: 0.2517, f2: -0.3512, pB: [0.1, 0.9] },
  // 3.8 GHz / 城区 / 60°
  { fGHz: 3.8, env: 'urban', elev: 60, gainDbi: '<5',
    G: { mu: 2.4546, sigma: 1.9595, durMin: 10.0, muMA: -1.6655, sigmaMA: 0.8244, h1: -0.4887, h2: -17.2505, g1: -0.3373, g2: 0.3285, lcorr: 2.3036 },
    B: { mu: 1.8892, sigma: 0.8982, durMin: 1.9126, muMA: -14.4922, sigmaMA: 3.4941, h1: 0.4501, h2: -9.6935, g1: 0.1202, g2: 4.8329, lcorr: 2.3036 },
    f1: 0.0025, f2: 1.4949, pB: [0.1, 0.9] },
  // 3.8 GHz / 城区 / 70°
  { fGHz: 3.8, env: 'urban', elev: 70, gainDbi: '<5',
    G: { mu: 2.8354, sigma: 2.4631, durMin: 67.5721, muMA: -1.0455, sigmaMA: 0.2934, h1: -3.0973, h2: -20.7862, g1: 0.0808, g2: 0.8952, lcorr: 2.2062 },
    B: { mu: 1.5170, sigma: 1.1057, durMin: 3.6673, muMA: -14.2294, sigmaMA: 5.4444, h1: 0.0908, h2: -15.8022, g1: 0.0065, g2: 3.1520, lcorr: 2.2062 },
    f1: 0.0755, f2: 2.1426, pB: [0.1, 0.9] },
  // 3.8 GHz / 郊区 / 20°
  { fGHz: 3.8, env: 'suburban', elev: 20, gainDbi: '<5',
    G: { mu: 2.8194, sigma: 1.6507, durMin: 11.1083, muMA: -4.8136, sigmaMA: 1.9133, h1: -0.4500, h2: -17.9227, g1: -0.1763, g2: 0.8244, lcorr: 1.2571 },
    B: { mu: 2.5873, sigma: 1.3919, durMin: 4.4393, muMA: -17.0970, sigmaMA: 2.9350, h1: 0.8991, h2: -2.4082, g1: 0.0582, g2: 4.0347, lcorr: 1.2571 },
    f1: 0.0727, f2: 2.8177, pB: [0.1, 0.9] },
  // 3.8 GHz / 郊区 / 30°
  { fGHz: 3.8, env: 'suburban', elev: 30, gainDbi: '<5',
    G: { mu: 2.9226, sigma: 1.3840, durMin: 6.7899, muMA: -1.9611, sigmaMA: 1.8460, h1: 0.2329, h2: -15.0063, g1: 0.0334, g2: 1.3323, lcorr: 1.6156 },
    B: { mu: 2.7375, sigma: 0.6890, durMin: 7.7356, muMA: -15.3022, sigmaMA: 2.9379, h1: 0.5146, h2: -8.9987, g1: 0.0880, g2: 4.4692, lcorr: 1.6156 },
    f1: 0.1281, f2: 2.3949, pB: [0.1, 0.9] },
  // 3.8 GHz / 郊区 / 45°
  { fGHz: 3.8, env: 'suburban', elev: 45, gainDbi: '<5',
    G: { mu: 4.3019, sigma: 0.8530, durMin: 36.1277, muMA: -1.2730, sigmaMA: 0.9286, h1: 0.2050, h2: -17.5670, g1: 0.0074, g2: 0.7490, lcorr: 1.1191 },
    B: { mu: 2.3715, sigma: 1.3435, durMin: 9.5511, muMA: -5.6373, sigmaMA: 2.9302, h1: -0.7188, h2: -21.0513, g1: -0.2896, g2: -0.3951, lcorr: 1.1191 },
    f1: -0.9586, f2: 10.8084, pB: [0.1, 0.9] },
  // 3.8 GHz / 郊区 / 60°
  { fGHz: 3.8, env: 'suburban', elev: 60, gainDbi: '<5',
    G: { mu: 2.8958, sigma: 1.7061, durMin: 13.9133, muMA: -1.1987, sigmaMA: 1.0492, h1: -1.6501, h2: -18.9375, g1: -0.1369, g2: 0.4477, lcorr: 3.0619 },
    B: { mu: 1.9128, sigma: 0.6869, durMin: 2.9398, muMA: -13.1811, sigmaMA: 2.6228, h1: 0.6911, h2: -6.0721, g1: 0.0598, g2: 3.7220, lcorr: 3.0619 },
    f1: -0.0419, f2: 5.8920, pB: [0.1, 0.9] },
  // 3.8 GHz / 郊区 / 70°
  { fGHz: 3.8, env: 'suburban', elev: 70, gainDbi: '<5',
    G: { mu: 4.1684, sigma: 1.0766, durMin: 42.0185, muMA: 0.1600, sigmaMA: 0.5082, h1: -3.4369, h2: -18.1632, g1: -1.1144, g2: 0.9703, lcorr: 2.5817 },
    B: { mu: 1.4778, sigma: 0.7033, durMin: 1.8473, muMA: -10.2225, sigmaMA: 1.8417, h1: 0.3934, h2: -9.6284, g1: -0.1331, g2: 0.7223, lcorr: 2.5817 },
    f1: -0.1129, f2: 4.0555, pB: [0.1, 0.9] },
  // 3.8 GHz / 村镇 / 20°
  { fGHz: 3.8, env: 'village', elev: 20, gainDbi: '<5',
    G: { mu: 2.0262, sigma: 1.2355, durMin: 2.2401, muMA: -3.1324, sigmaMA: 1.8929, h1: -0.4368, h2: -15.1009, g1: -0.0423, g2: 1.2532, lcorr: 0.8380 },
    B: { mu: 1.9451, sigma: 1.4293, durMin: 1.9624, muMA: -16.5697, sigmaMA: 4.0368, h1: 1.0921, h2: 1.6440, g1: -0.0325, g2: 2.4452, lcorr: 0.8380 },
    f1: 0.0590, f2: 1.5623, pB: [0.1, 0.9] },
  // 3.8 GHz / 村镇 / 30°
  { fGHz: 3.8, env: 'village', elev: 30, gainDbi: '<5',
    G: { mu: 2.4504, sigma: 1.1061, durMin: 2.3941, muMA: -1.8384, sigmaMA: 1.7960, h1: -0.5582, h2: -14.4416, g1: -0.4545, g2: 0.8188, lcorr: 0.9268 },
    B: { mu: 1.7813, sigma: 1.2802, durMin: 2.1484, muMA: -15.4143, sigmaMA: 4.5579, h1: 0.8549, h2: -2.2415, g1: -0.0761, g2: 1.6768, lcorr: 0.9268 },
    f1: -0.0330, f2: 2.7056, pB: [0.1, 0.9] },
  // 3.8 GHz / 村镇 / 45°
  { fGHz: 3.8, env: 'village', elev: 45, gainDbi: '<5',
    G: { mu: 2.2910, sigma: 1.4229, durMin: 2.8605, muMA: -0.0018, sigmaMA: 1.1193, h1: -1.2023, h2: -14.0732, g1: -0.1033, g2: 0.9299, lcorr: 0.9288 },
    B: { mu: 1.2738, sigma: 1.1539, durMin: 0.7797, muMA: -12.1063, sigmaMA: 2.9814, h1: 0.6537, h2: -4.5948, g1: -0.0815, g2: 1.6693, lcorr: 0.9288 },
    f1: 0.0002, f2: 1.9694, pB: [0.1, 0.9] },
  // 3.8 GHz / 村镇 / 60°
  { fGHz: 3.8, env: 'village', elev: 60, gainDbi: '<5',
    G: { mu: 3.0956, sigma: 1.3725, durMin: 8.1516, muMA: -0.5220, sigmaMA: 1.0950, h1: 0.0831, h2: -16.8546, g1: 0.0411, g2: 1.1482, lcorr: 1.2251 },
    B: { mu: 1.0920, sigma: 1.2080, durMin: 0.7934, muMA: -12.1817, sigmaMA: 3.3604, h1: 1.1006, h2: 0.5381, g1: -0.0098, g2: 2.4287, lcorr: 1.2251 },
    f1: -0.0530, f2: 2.7165, pB: [0.1, 0.9] },
  // 3.8 GHz / 村镇 / 70°
  { fGHz: 3.8, env: 'village', elev: 70, gainDbi: '<5',
    G: { mu: 3.9982, sigma: 1.3320, durMin: 28.3220, muMA: -1.3403, sigmaMA: 0.7793, h1: -0.4861, h2: -19.5316, g1: -0.2356, g2: 0.7178, lcorr: 1.4378 },
    B: { mu: 1.4165, sigma: 0.4685, durMin: 2.5168, muMA: -11.9560, sigmaMA: 1.5654, h1: 0.5663, h2: -6.8615, g1: -0.2903, g2: -1.2715, lcorr: 1.4378 },
    f1: -0.0983, f2: 3.9005, pB: [0.1, 0.9] },
  // 3.8 GHz / 乡村林地 / 20°
  { fGHz: 3.8, env: 'ruralWooded', elev: 20, gainDbi: '<5',
    G: { mu: 2.0294, sigma: 1.4280, durMin: 1.7836, muMA: -3.2536, sigmaMA: 1.6159, h1: -0.5718, h2: -16.1382, g1: -0.0805, g2: 0.9430, lcorr: 1.0863 },
    B: { mu: 2.0290, sigma: 1.5493, durMin: 1.5269, muMA: -14.3363, sigmaMA: 2.7753, h1: 0.8186, h2: -2.9963, g1: -0.0822, g2: 1.7660, lcorr: 1.0863 },
    f1: 0.1263, f2: 1.4478, pB: [0.1, 0.9] },
  // 3.8 GHz / 乡村林地 / 30°
  { fGHz: 3.8, env: 'ruralWooded', elev: 30, gainDbi: '<5',
    G: { mu: 2.1218, sigma: 1.4895, durMin: 2.4539, muMA: -1.5431, sigmaMA: 1.8811, h1: -0.7288, h2: -14.1626, g1: -0.1241, g2: 0.9482, lcorr: 1.3253 },
    B: { mu: 2.2051, sigma: 1.5741, durMin: 2.1289, muMA: -12.8884, sigmaMA: 3.0097, h1: 0.6635, h2: -4.6034, g1: -0.0634, g2: 2.3898, lcorr: 1.3253 },
    f1: 0.0849, f2: 1.6324, pB: [0.1, 0.9] },
  // 3.8 GHz / 乡村林地 / 45°
  { fGHz: 3.8, env: 'ruralWooded', elev: 45, gainDbi: '<5',
    G: { mu: 3.1803, sigma: 1.3427, durMin: 6.7673, muMA: 0.0428, sigmaMA: 1.6768, h1: -0.9948, h2: -14.4265, g1: -0.1377, g2: 1.0077, lcorr: 2.0419 },
    B: { mu: 2.4017, sigma: 1.1315, durMin: 3.5668, muMA: -11.3173, sigmaMA: 2.7467, h1: 0.2929, h2: -9.7910, g1: -0.0387, g2: 2.6194, lcorr: 2.0419 },
    f1: 0.1894, f2: 2.1378, pB: [0.1, 0.9] },
  // 3.8 GHz / 乡村林地 / 60°
  { fGHz: 3.8, env: 'ruralWooded', elev: 60, gainDbi: '<5',
    G: { mu: 2.4961, sigma: 1.4379, durMin: 3.7229, muMA: -1.0828, sigmaMA: 1.0022, h1: -1.2973, h2: -16.6791, g1: -0.1187, g2: 0.6254, lcorr: 1.9038 },
    B: { mu: 2.2113, sigma: 1.1254, durMin: 1.9001, muMA: -12.3044, sigmaMA: 2.3641, h1: 0.5456, h2: -6.4660, g1: -0.0443, g2: 2.3029, lcorr: 1.9038 },
    f1: 0.1624, f2: 1.8417, pB: [0.1, 0.9] },
  // 3.8 GHz / 乡村林地 / 70°
  { fGHz: 3.8, env: 'ruralWooded', elev: 70, gainDbi: '<5',
    G: { mu: 2.8382, sigma: 1.3804, durMin: 6.8051, muMA: -0.8923, sigmaMA: 0.9455, h1: -1.3425, h2: -17.5636, g1: -0.1210, g2: 0.6444, lcorr: 2.1466 },
    B: { mu: 2.1470, sigma: 1.0038, durMin: 1.9195, muMA: -11.5722, sigmaMA: 2.3437, h1: 0.3459, h2: -9.5399, g1: -0.0275, g2: 2.6238, lcorr: 2.1466 },
    f1: 0.0593, f2: 2.8854, pB: [0.1, 0.9] },
  // 3.8 GHz / 居民区 / 20°
  { fGHz: 3.8, env: 'residential', elev: 20, gainDbi: '<5',
    G: { mu: 2.9050, sigma: 1.7236, durMin: 10.7373, muMA: -1.4426, sigmaMA: 1.2989, h1: 0.4875, h2: -13.5981, g1: 0.1343, g2: 1.8247, lcorr: 1.2788 },
    B: { mu: 2.1969, sigma: 0.9865, durMin: 2.2901, muMA: -14.4036, sigmaMA: 3.0396, h1: 0.5813, h2: -6.9790, g1: -0.0911, g2: 2.1475, lcorr: 1.2788 },
    f1: 0.2334, f2: 0.7612, pB: [0.1, 0.9] },
  // 3.8 GHz / 居民区 / 30°
  { fGHz: 3.8, env: 'residential', elev: 30, gainDbi: '<5',
    G: { mu: 2.7334, sigma: 1.6971, durMin: 10.2996, muMA: -0.9996, sigmaMA: 1.0752, h1: 0.3407, h2: -14.8465, g1: -0.0413, g2: 1.2006, lcorr: 1.7072 },
    B: { mu: 1.8403, sigma: 0.9268, durMin: 1.8073, muMA: -12.9855, sigmaMA: 2.8149, h1: 0.3553, h2: -9.9284, g1: 0.0501, g2: 3.8667, lcorr: 1.7072 },
    f1: 0.0443, f2: 2.2591, pB: [0.1, 0.9] },
  // 3.8 GHz / 居民区 / 60°
  { fGHz: 3.8, env: 'residential', elev: 60, gainDbi: '<5',
    G: { mu: 3.4044, sigma: 1.3980, durMin: 10.4862, muMA: 0.4640, sigmaMA: 0.7060, h1: 0.3710, h2: -19.6032, g1: 0.0332, g2: 0.5053, lcorr: 1.8017 },
    B: { mu: 2.5534, sigma: 1.7143, durMin: 4.7289, muMA: -2.3787, sigmaMA: 0.8123, h1: -2.3834, h2: -24.6987, g1: 0.0172, g2: 0.7237, lcorr: 1.8017 },
    f1: 3.1149, f2: 3.5721, pB: [0.1, 0.9] },
  // 3.8 GHz / 居民区 / 70°
  { fGHz: 3.8, env: 'residential', elev: 70, gainDbi: '<5',
    G: { mu: 2.9223, sigma: 1.0267, durMin: 7.3764, muMA: -0.1628, sigmaMA: 0.5104, h1: 0.1590, h2: -20.4767, g1: 0.1137, g2: 0.4579, lcorr: 1.3531 },
    B: { mu: 2.5188, sigma: 1.3166, durMin: 7.2801, muMA: -2.3703, sigmaMA: 1.5998, h1: -1.0228, h2: -22.4769, g1: -0.0986, g2: 0.2879, lcorr: 1.3531 },
    f1: -0.0538, f2: 5.1204, pB: [0.1, 0.9] },
  // 11.7 GHz / 乡村 / 34°
  { fGHz: 11.7, env: 'rural', elev: 34, gainDbi: 19,
    G: { mu: 1.7663, sigma: 1.9350, durMin: 0.9, muMA: 0.05, sigmaMA: 0, h1: 0, h2: -40.25, g1: 0, g2: 0.39, lcorr: 0.5 },
    B: { mu: -0.4722, sigma: 1.7232, durMin: 0.8, muMA: -16, sigmaMA: 10.4, h1: 0.87, h2: -14.26, g1: -0.21, g2: 0, lcorr: 0.5 },
    f1: 0.088, f2: 1.21, pB: [0.1, 0.9] },
  // 11.7 GHz / 郊区 / 34°
  { fGHz: 11.7, env: 'suburban', elev: 34, gainDbi: 19,
    G: { mu: 1.0125, sigma: 1.6944, durMin: 1.5, muMA: -0.02, sigmaMA: 0, h1: 0, h2: -38.17, g1: 0, g2: 0.39, lcorr: 0.5 },
    B: { mu: -0.8026, sigma: 1.288, durMin: 1.1, muMA: -5.4, sigmaMA: 7.3, h1: 0.69, h2: -15.97, g1: -0.21, g2: 0, lcorr: 0.5 },
    f1: 0.036, f2: 0.80, pB: [0.1, 0.6] },
  // 20 GHz / 郊区 / 30°
  { fGHz: 20, env: 'suburban', elev: 30, gainDbi: 31,
    G: { mu: 1.66, sigma: 1.64, durMin: 0.01, muMA: -0.23, sigmaMA: 0.49, h1: 0, h2: -30.99, g1: 0, g2: 0.49, lcorr: 7.9 },
    B: { mu: 0.10, sigma: 1.70, durMin: 0.5, muMA: -8.93, sigmaMA: 8.41, h1: 0.48, h2: -11.37, g1: -0.45, g2: 0, lcorr: 7.9 },
    f1: 0.08, f2: 1.67, pB: [0.006, 0.921] },
  // 20 GHz / 公路 / 30°
  { fGHz: 20, env: 'highway', elev: 30, gainDbi: 31,
    G: { mu: 1.27, sigma: 1.86, durMin: 0.01, muMA: -0.16, sigmaMA: 0.39, h1: 0.00, h2: -29.61, g1: 0.00, g2: 0.39, lcorr: 31.7 },
    B: { mu: -0.31, sigma: 1.35, durMin: 0.5, muMA: -5.92, sigmaMA: 8.20, h1: 0.34, h2: -14.39, g1: -0.41, g2: 0.00, lcorr: 31.7 },
    f1: 0.15, f2: 1.28, pB: [0.001, 0.861] },
  // 20 GHz / 城区 / 30°
  { fGHz: 20, env: 'urban', elev: 30, gainDbi: 31,
    G: { mu: 1.95, sigma: 1.82, durMin: 0.01, muMA: -0.21, sigmaMA: 0.44, h1: 0, h2: -32.62, g1: 0, g2: 0.44, lcorr: 5.67 },
    B: { mu: 0.05, sigma: 1.40, durMin: 1, muMA: -13.96, sigmaMA: 8.93, h1: 0.68, h2: -10.06, g1: -0.37, g2: 0, lcorr: 5.67 },
    f1: 0.10, f2: 1.49, pB: [0.03, 0.97] },
  // 20 GHz / 铁路 / 30°
  { fGHz: 20, env: 'railway', elev: 30, gainDbi: 31,
    G: { mu: 1.37, sigma: 1.94, durMin: 0.01, muMA: -0.19, sigmaMA: 0.47, h1: 0, h2: -26.07, g1: 0, g2: 0.47, lcorr: 19.52 },
    B: { mu: -0.02, sigma: 1.92, durMin: 0.5, muMA: -5.84, sigmaMA: 7.47, h1: 0.47, h2: -12.78, g1: -0.41, g2: 0, lcorr: 19.52 },
    f1: 0.12, f2: 1.78, pB: [0.0006, 0.88] }
]

// 各环境键的中文名（数据，不是界面文案）
const ENV_ZH = { urban: '城区', suburban: '郊区', village: '村镇', ruralWooded: '乡村林地', residential: '居民区', rural: '乡村', highway: '公路', railway: '铁路' }
const ENV_ALIAS = { train: 'railway', wooded: 'ruralWooded', ruralwooded: 'ruralWooded' }

// Tables 8 / 9 / 10 的标称频率区间 → 该区间的表频率
const FREQ_GROUPS = [
  { lo: 1.5, hi: 3, hiOpen: true, freqs: [2.2] },     // Table 8：1.5–3 GHz
  { lo: 3, hi: 5, hiOpen: false, freqs: [3.8] },      // Table 9：3–5 GHz
  { lo: 10, hi: 20, hiOpen: false, freqs: [11.7, 20] } // Table 10：10–20 GHz
]

function envKey(env) {
  if (env == null) return null
  const s = String(env).trim()
  if (ENV_ZH[s]) return s
  const a = ENV_ALIAS[s.toLowerCase().replace(/[\s_-]/g, '')]
  return a || null
}

/**
 * §6.1 Step 0：按频率 / 环境 / 仰角选参数表。
 * @returns {object|null} P681_TABLES 中的一项；不适用（频率 ∉ [1.5, 20] GHz、仰角 ∉ [20°, 90°]、
 *   该频档无此环境）返回 null。
 */
function selectTable(fGHz, env, elevDeg) {
  const f = num(fGHz), e = num(elevDeg), k = envKey(env)
  if (f === null || e === null || !k) return null
  if (f < 1.5 || f > 20 || e < 20 || e > 90) return null
  const cands = P681_TABLES.filter((t) => t.env === k)
  if (!cands.length) return null
  const grp = FREQ_GROUPS.find((g) => f >= g.lo && (g.hiOpen ? f < g.hi : f <= g.hi))
  let freqs = Array.from(new Set(cands.map((t) => t.fGHz)))
  if (grp) freqs = freqs.filter((x) => grp.freqs.indexOf(x) >= 0)
  if (!freqs.length) return null
  // 档内（或区间外）取最接近的表频率；Table 10 的郊区有 11.7 / 20 两张，原文 §4.2 说取频率最近的。
  // 等距时取较高频率的表（只会出现在 5–10 GHz 空档，如郊区 7.75 GHz → 11.7 GHz）。
  freqs.sort((a, b) => Math.abs(a - f) - Math.abs(b - f) || b - a)
  const fSel = freqs[0]
  const inF = cands.filter((t) => t.fGHz === fSel)
  inF.sort((a, b) => Math.abs(a.elev - e) - Math.abs(b.elev - e) || a.elev - b.elev)
  return inF[0]
}

// 参数既可以是选表条件 {fGHz, env, elevDeg}，也可以直接是一张表
function asTable(sel) {
  if (!sel) return null
  if (sel.G && sel.B && sel.pB) return sel
  return selectTable(sel.fGHz, sel.env, sel.elevDeg)
}

// ===== 式 (17)–(19)：状态时长与状态概率 =====
// 式 (17a)：截尾（≥ dur_min）对数正态的均值。原式写 1 − erf(·)，这里用等价的 erfc(·)，自变量大时不丢精度。
function meanDuration(st) {
  const lnD = Math.log(st.durMin), s = st.sigma
  const num1 = erfc((lnD - (st.mu + s * s)) / (s * Math.SQRT2))
  const den = erfc((lnD - st.mu) / (s * Math.SQRT2))
  return Math.exp(st.mu + s * s / 2) * num1 / den
}

// GOOD：5%–95%（μ ± 1.645σ）；BAD：[p_B,min, p_B,max]（式 18：μ + √2σ·erf⁻¹(2p − 1) = μ + σΦ⁻¹(p)）。
// lowerCut = false 时 BAD 不截下限（示例图口径，见文件头），下限取 μ − 8σ（其下质量 < 1e-15）。
const maRangeGood = (G) => [G.muMA - 1.645 * G.sigmaMA, G.muMA + 1.645 * G.sigmaMA]
const maRangeBad = (B, pB, lowerCut) => [
  lowerCut ? B.muMA + B.sigmaMA * normInv(pB[0]) : B.muMA - 8 * B.sigmaMA,
  B.muMA + B.sigmaMA * normInv(pB[1])
]
const lowerCutOf = (opts) => !(opts && opts.badMaLowerCut === false)

/**
 * 式 (17a)(17b)(19)：平均时长与 GOOD / BAD 概率。
 * @param {object} [opts] badMaLowerCut（缺省 true = 正文公式；false = 示例图口径，见文件头）
 * @returns {null | {durG, durB, durT, pG, pB, maG:[min,max], maB:[min,max]}}
 */
function stateProbabilities(sel, opts) {
  const t = asTable(sel)
  if (!t) return null
  const G = t.G, B = t.B
  const durG = meanDuration(G), durB = meanDuration(B)
  const maG = maRangeGood(G), maB = maRangeBad(B, t.pB, lowerCutOf(opts))
  let shift = 0
  if (B.sigmaMA > 0) {
    const pN = (x) => normPdf((x - B.muMA) / B.sigmaMA) / B.sigmaMA
    const FN = (x) => normCdf((x - B.muMA) / B.sigmaMA)
    shift = B.sigmaMA * B.sigmaMA * (pN(maB[0]) - pN(maB[1])) / (FN(maB[1]) - FN(maB[0]))
  }
  const durT = t.f1 * (G.muMA - B.muMA - shift) + t.f2
  const den = durG + durB + 2 * durT
  return { durG, durB, durT, pG: (durG + durT) / den, pB: (durB + durT) / den, maG, maB }
}

// ===== 式 (20a)(20b)：状态内信号包络 CDF =====
const NG_MA = 20, NG_S = 16
const DB20 = 20 / Math.LN10   // 8.686：幅度 → dB 的导数系数

// 给定 M_A 的 Loo 分布 CDF（式 20 的内两层积分），x0 线性幅度、u = 20lg x0
function looCdf(x0, u, MA, st) {
  const SA = Math.abs(st.g1 * MA + st.g2)
  const P = Math.pow(10, (st.h1 * MA + st.h2) / 10)
  if (SA < 1e-6) return riceCdf(x0, Math.pow(10, MA / 20), P)
  // 莱斯核在 a ≈ x0（s ≈ u）处是个台阶，宽约 ±6σ_r（σ_r = √(P/2)）；把台阶两侧放进断点才积得准
  const sr = Math.sqrt(P / 2)
  const w = x0 > 6 * sr ? DB20 * 6 * sr / x0 : 0
  const breaks = w > 0 ? [u - w, u, u + w] : [u]
  return integrate((s) => normPdf((s - MA) / SA) / SA * riceCdf(x0, Math.pow(10, s / 20), P),
    MA - 3 * SA, MA + 3 * SA, NG_S, breaks)
}

function stateSignalCdf(uDb, st, range) {
  const x0 = Math.pow(10, uDb / 20)
  if (!(st.sigmaMA > 0)) return looCdf(x0, uDb, st.muMA, st)       // 式 (20b)
  const Z = normCdf((range[1] - st.muMA) / st.sigmaMA) - normCdf((range[0] - st.muMA) / st.sigmaMA)
  const v = integrate((MA) => normPdf((MA - st.muMA) / st.sigmaMA) / st.sigmaMA * looCdf(x0, uDb, MA, st),
    range[0], range[1], NG_MA, [uDb - 6, uDb, uDb + 6])
  return v / Z
}

/**
 * 式 (21)：信号电平 CDF P(20lg x ≤ uDb)，x 相对 LOS 电平。opts 同 stateProbabilities。
 * @returns {null | {p, pGood, pBad, pG, pB}}
 */
function signalCdf(uDb, sel, opts) {
  const t = asTable(sel), u = num(uDb)
  if (!t || u === null) return null
  const sp = stateProbabilities(t, opts)
  const pGood = stateSignalCdf(u, t.G, sp.maG)
  const pBad = stateSignalCdf(u, t.B, sp.maB)
  return { p: sp.pG * pGood + sp.pB * pBad, pGood, pBad, pG: sp.pG, pB: sp.pB }
}

/**
 * 时间（或位置 / 行驶距离）百分比 p 下的衰落余量（dB，正数 = 低于 LOS 电平）。
 * 求 P(x ≤ x0) = p/100，返回 F = −20lg x0。可用度 99% 对应 p = 1。
 * @param {number} pPercent 0 < p < 99.73
 * @param {object} sel {fGHz, env, elevDeg} 或一张参数表
 * @param {object} [opts] badMaLowerCut（见文件头）
 * @returns {null | {fadeDb, pG, pB, table: {fGHz, env, elev, gainDbi}}}
 */
function fadeMarginDb(pPercent, sel, opts) {
  const p = num(pPercent), t = asTable(sel)
  if (p === null || !t || !(p > 0 && p < 100)) return null
  const sp = stateProbabilities(t, opts)
  const target = p / 100
  const F = (u) => sp.pG * stateSignalCdf(u, t.G, sp.maG) + sp.pB * stateSignalCdf(u, t.B, sp.maB) - target
  let lo = -80
  while (F(lo) > 0 && lo > -200) lo -= 40
  const u = brentRoot(F, lo, 20, 1e-4)
  if (u === null) return null
  return { fadeDb: -u, pG: sp.pG, pB: sp.pB, table: { fGHz: t.fGHz, env: t.env, elev: t.elev, gainDbi: t.gainDbi } }
}

// ===== 式 (22)(23)：莱斯因子 K（dB）的 CDF =====
function stateKCdf(K0, st, range) {
  const kc = (MA) => {
    const SA = Math.abs(st.g1 * MA + st.g2)
    const mk = (1 - st.h1) * MA - st.h2
    if (SA < 1e-9) return K0 >= mk ? 1 : 0
    return 0.5 * (1 + erf((K0 - mk) / (SA * Math.SQRT2)))
  }
  if (!(st.sigmaMA > 0)) return kc(st.muMA)                         // 式 (22b)
  const Z = normCdf((range[1] - st.muMA) / st.sigmaMA) - normCdf((range[0] - st.muMA) / st.sigmaMA)
  return integrate((MA) => normPdf((MA - st.muMA) / st.sigmaMA) / st.sigmaMA * kc(MA), range[0], range[1], 32) / Z
}

/** 莱斯因子 CDF P(K ≤ K0)（式 23）。K = 20lg A − MP（dB）。opts 同 stateProbabilities。 */
function riceFactorCdf(K0Db, sel, opts) {
  const t = asTable(sel), k = num(K0Db)
  if (!t || k === null) return null
  const sp = stateProbabilities(t, opts)
  return sp.pG * stateKCdf(k, t.G, sp.maG) + sp.pB * stateKCdf(k, t.B, sp.maB)
}

// ===== 式 (24)(25)：总功率 p_t = A² + MP 的 CDF（局部均值，不含快衰落）=====
function statePtCdf(pt0Db, st, range) {
  const pt0 = Math.pow(10, pt0Db / 10)
  const pc = (MA) => {
    const mp = Math.pow(10, (st.h1 * MA + st.h2) / 10)
    if (mp >= pt0) return 0                                          // 式 (24a)(24c) 的积分限
    const SA = Math.abs(st.g1 * MA + st.g2)
    const lv = 10 * Math.log10(pt0 - mp) - MA
    if (SA < 1e-9) return lv >= 0 ? 1 : 0
    return 0.5 * (1 + erf(lv / (SA * Math.SQRT2)))
  }
  if (!(st.sigmaMA > 0)) return pc(st.muMA)                          // 式 (24e)
  const Z = normCdf((range[1] - st.muMA) / st.sigmaMA) - normCdf((range[0] - st.muMA) / st.sigmaMA)
  const brk = st.h1 !== 0 ? [(pt0Db - st.h2) / st.h1] : null
  return integrate((MA) => normPdf((MA - st.muMA) / st.sigmaMA) / st.sigmaMA * pc(MA), range[0], range[1], 32, brk) / Z
}

/**
 * 总功率 CDF P(10lg p_t ≤ pt0Db)（式 25）。opts 同 stateProbabilities。
 * Figure 14 横轴印作「20 log(p_t,0)」，按其数值与式 (24) 对拍，实际是 10lg（功率 dB）。
 */
function totalPowerCdf(pt0Db, sel, opts) {
  const t = asTable(sel), v = num(pt0Db)
  if (!t || v === null) return null
  const sp = stateProbabilities(t, opts)
  return sp.pG * statePtCdf(v, t.G, sp.maG) + sp.pB * statePtCdf(v, t.B, sp.maB)
}

// ===== §4.1.1 路边树木遮蔽经验模型（ERS）=====
// Table 1：80° 仰角的衰落（dB），仅 1.6 / 2.6 GHz，p = 1/5/10/15/20/30 %（树木遮蔽）
const ERS_TABLE1_80DEG = {
  1.6: { 1: 4.1, 5: 2.0, 10: 1.5, 15: 1.4, 20: 1.3, 30: 1.2 },
  2.6: { 1: 9.0, 5: 5.2, 10: 3.8, 15: 3.2, 20: 2.8, 30: 2.5 }
}

// 式 (1)–(5)：θ ∈ [20°, 60°]、p ∈ [1, 80]%、f ∈ [0.8, 20] GHz
function ersCore(p, theta, f) {
  const M = 3.44 + 0.0975 * theta - 0.002 * theta * theta      // 式 (2)
  const N = -0.443 * theta + 34.76                               // 式 (3)
  const AL = (pp) => -M * Math.log(pp) + N                       // 式 (1)
  const scale = Math.exp(1.5 * (1 / Math.sqrt(1.5) - 1 / Math.sqrt(f)))   // 式 (4)
  if (p <= 20) return AL(p) * scale
  return AL(20) * scale * Math.log(80 / p) / Math.log(4)         // 式 (5)
}

/**
 * 路边树木遮蔽：行驶距离 p% 上被超过的衰落（dB）。
 * 适用：f 0.8–20 GHz（Step 3 写 0.85 GHz 起，p > 20% 时按 0.85 卡）、p 1–80 %、θ 7°–60°（7°–20° 按 20°，Step 4）；
 * θ 60°–90° 仅 f = 1.6 / 2.6 GHz 且 p ∈ Table 1 时可外推（§4.1.1.1：60° 值 → 80° 表值 → 90° 为 0，分段线性）。
 */
function roadsideTreeFadeDb(pPercent, elevDeg, fGHz) {
  const p = num(pPercent), th = num(elevDeg), f = num(fGHz)
  if (p === null || th === null || f === null) return null
  if (p < 1 || p > 80 || th < 7 || th > 90 || f < 0.8 || f > 20) return null
  if (p > 20 && f < 0.85) return null
  if (th <= 60) return ersCore(p, Math.max(20, th), f)
  const fk = Math.abs(f - 1.6) < 1e-9 ? 1.6 : (Math.abs(f - 2.6) < 1e-9 ? 2.6 : null)
  if (fk === null || ERS_TABLE1_80DEG[fk][p] === undefined) return null
  const a60 = ersCore(p, 60, f), a80 = ERS_TABLE1_80DEG[fk][p]
  if (th <= 80) return a60 + (a80 - a60) * (th - 60) / 20
  return a80 * (90 - th) / 10
}

// ===== §4.2 路边建筑遮挡（式 8）=====
/**
 * 路边建筑遮挡的百分比概率 p = 100·exp(−(h1 − h2)²/(2h_b²))（h1 > h2；h1 ≤ h2 时射线必被挡，返回 100）。
 *   h1 = h_m + d_m·tanθ/sinφ（式 8a）；h2 = C_f·(λ·d_r)^0.5（式 8b）；d_r = d_m/(sinφ·cosθ)（式 8c）。
 * 原文：0 < θ < 90°、0 < φ < 180°，端点值不可用。
 * @param {{hbM, hmM, dmM, elevDeg, azDeg, fGHz, cf}} o  cf 缺省 0（只在无视距时算遮挡）；0.7 = 0.7 菲涅尔区净空
 */
function buildingBlockagePct(o) {
  const hb = num(o && o.hbM), hm = num(o && o.hmM), dm = num(o && o.dmM)
  const th = num(o && o.elevDeg), ph = num(o && o.azDeg), f = num(o && o.fGHz)
  const cf = o && o.cf != null ? num(o.cf) : 0
  if ([hb, hm, dm, th, ph, f, cf].some((v) => v === null)) return null
  if (!(hb > 0) || !(dm > 0) || !(f > 0) || !(th > 0 && th < 90) || !(ph > 0 && ph < 180) || cf < 0) return null
  const r = Math.PI / 180
  const lambda = 0.299792458 / f
  const h1 = hm + dm * Math.tan(th * r) / Math.sin(ph * r)
  const dr = dm / (Math.sin(ph * r) * Math.cos(th * r))
  const h2 = cf * Math.sqrt(lambda * dr)
  if (h1 <= h2) return 100
  return 100 * Math.exp(-(h1 - h2) * (h1 - h2) / (2 * hb * hb))
}

// ===== §5.1 / §5.2 清晰视距下的多径衰落 =====
// Table 3：山区多径 p = a·A^(−b)，1% ≤ p ≤ 10%；range = 拟合的衰落区间（dB）
const MOUNTAIN_MP = {
  0.87: { 30: { a: 34.52, b: 1.855, range: [2, 7] }, 45: { a: 31.64, b: 2.464, range: [2, 4] } },
  1.5: { 30: { a: 33.19, b: 1.710, range: [2, 8] }, 45: { a: 39.95, b: 2.321, range: [2, 5] } }
}
// Table 4：林荫路多径 p = u·exp(−v·A)，1% ≤ p ≤ 50%（对 30°–60° 仰角不敏感）
const TREE_ROAD_MP = {
  0.87: { u: 125.6, v: 1.116, range: [1, 4.5] },
  1.5: { u: 127.7, v: 0.8573, range: [1, 6] }
}

const tabFreq = (f, keys) => keys.find((k) => Math.abs(Number(k) - f) < 1e-9)

/**
 * 山区多径：距离 p% 上被超过的衰落（dB），式 (12) 反解 A = (a/p)^(1/b)。
 * 仅 Table 3 的频率（0.87 / 1.5 GHz）与仰角（30° / 45°），p ∈ [1, 10]%。
 * @returns {null | {fadeDb, inFitRange}}  inFitRange = 结果是否落在原表「Range (dB)」内
 */
function mountainMultipathFadeDb(pPercent, fGHz, elevDeg) {
  const p = num(pPercent), f = num(fGHz), e = num(elevDeg)
  if (p === null || f === null || e === null || p < 1 || p > 10) return null
  const fk = tabFreq(f, Object.keys(MOUNTAIN_MP))
  const c = fk && MOUNTAIN_MP[fk][e]
  if (!c) return null
  const A = Math.pow(c.a / p, 1 / c.b)
  return { fadeDb: A, inFitRange: A >= c.range[0] && A <= c.range[1] }
}

/**
 * 林荫路多径：距离 p% 上被超过的衰落（dB），式 (13) 反解 A = ln(u/p)/v。
 * 仅 Table 4 的频率（0.87 / 1.5 GHz），p ∈ [1, 50]%。
 */
function treeRoadMultipathFadeDb(pPercent, fGHz) {
  const p = num(pPercent), f = num(fGHz)
  if (p === null || f === null || p < 1 || p > 50) return null
  const fk = tabFreq(f, Object.keys(TREE_ROAD_MP))
  if (!fk) return null
  const c = TREE_ROAD_MP[fk]
  const A = Math.log(c.u / p) / c.v
  return { fadeDb: A, inFitRange: A >= c.range[0] && A <= c.range[1] }
}

module.exports = {
  P681_TABLES, ENV_ZH, FREQ_GROUPS, ERS_TABLE1_80DEG, MOUNTAIN_MP, TREE_ROAD_MP,
  selectTable, stateProbabilities, meanDuration, signalCdf, fadeMarginDb, riceFactorCdf, totalPowerCdf,
  roadsideTreeFadeDb, buildingBlockagePct, mountainMultipathFadeDb, treeRoadMultipathFadeDb
}
