# 任务书 · 3GPP NTN 解调门限改「SNR」口径 + 3GPP 原生载波描述

> 交给 Opus 执行。仓库：卫星仿真平台（Electron + Vue 3），`C:\Users\85256\WeChatProjects\卫星仿真平台`，基线 main @ b1b68a5（v1.4.3 之后）。
> 2026-09-05 由 Fable 5.1 按代码现状与 3GPP / 公开链路级仿真资料拟定。§11「待拍板」若用户未另行答复，一律按其中的建议项执行。

---

## 0 执行守则（先读）

1. 先读仓库根 `CLAUDE.md`：**界面上不写解释性/教学性文字**（口径说明只放 `title`，空态只留一句陈述）；**结果输出纯数字**（禁「达标 / 合格 / 满足」一类文字判定；数值着色与报错诊断保留）。违反即返工。
2. 本任务书 §2 的现状分析已逐文件核实过（含行号），**不必重查**；行号会随改动漂几行，按符号名定位。§3 的研究结论与 §4 的数据是本任务的依据，落代码注释时引用 §12 的出处。
3. 工作树上有「SLA 建议模块」的未提交改动（`src/shared/lbSla.js`、`src/components/LbSlaPane.vue`、四个 App 等）。**本任务在 SLA 提交之后再开始**；开始时若工作树仍脏，先问用户，不要在别人的半成品上叠改动。
4. 按 §10 分三期落地；每期 `npm run build` 与 `npm test` 全绿再进下一期。提交信息沿用仓库风格（中文，说清根因与口径），末尾附 `Co-Authored-By: Claude <noreply@anthropic.com>`。
5. 三条红线：**DVB 各体制（DVB-S / S2 / S2X / RCS2）与「自定义」的计算一位都不许变**；**老配置里已存在的 3GPP 行不许静默换数**（见 §5.5）；**不许为了省事收窄功能**，确实做不完的部分最后如实列出。
6. 与用户沟通一律中文。

---

## 1 目标

把 3GPP NTN 两个体制（`3GPP NR-NTN` / `3GPP NB-IoT NTN`）的解调门限，从平台现在的「Es/N₀（噪声带宽 = 按帧效率反推的符号率）」改成 NTN 厂家通用的 **SNR（每资源元素 RE 的信噪比，噪声带宽 = 本次分配的占用带宽）**，并让 3GPP 载波按物理层参数描述——子载波间隔、PRB 数（NB-IoT 为音数）、MCS 表与索引、重复次数、开销——信息速率与带宽由此推导，不再套 DVB 的「信息速率 → 帧效率 → 符号率 → 滚降」链。具体交付：

1. 门限口径新增第三档 `snr`，定义写死：**SNR = C/N，噪声带宽 = N_RB × 12 × SCS（NB-IoT 上行 = 音数 × SCS）**，与 3GPP 的每 RE SINR 定义、MATLAB 链路仿真、gNB/UE 的 DMRS 估计同口径（§3.1–3.2）。
2. 3GPP 载波描述子 `phy`（§5.2）+ 纯函数模块 `ntnPhy.js`（核心层 + 渲染端镜像，§5.3）：占用带宽 / 信道带宽 / TBS / 信息速率 / 含重复的有效门限全部由它算。
3. 三个链路引擎 + 端到端链 + 扫描器接入 `snr` 分支（§5.4），输出新增 SNR 系列出参；级联、链路表、报表、i18n、SLA 的 MIR 跟着改口径（§5.7）。
4. 内置门限表重构：NR 五张 MCS 表（TS 38.214 表 1 / 2 / 3、变换预编码表 1 / 2）+ NB-IoT 三张（NPDSCH / NPUSCH 多音 / NPUSCH 单音），门限列按公开链路级仿真数据重定基线（§4.2、§4.4），每张表带条件元数据（BLER 目标 / 信道 / 码块规模 / 来源）；厂家给的 SNR 表可在「文件管理 · MODCOD 表」原样录入覆盖（§5.6）。

---

## 2 现状分析（已核实，勿重查）

### 2.1 两张 NTN 表长什么样

`packages/core/utils/constants.js`：`NR_NTN_MODCOD_TABLE`（行 ~236–283，MCS 0–28 = TS 38.214 Table 5.1.3.1-1，2026-07-26 已复核）、`NB_IOT_NTN_MODCOD_TABLE`（行 ~285–310，NPDSCH I_TBS 0/2/4/5/6/8/11/12）。每行七个字段与 DVB 表同形：

```
{ label, modulation, fec, rsCode: '0.9'(NR) / '1'(NB), bandwidthFactor: 1.1, noiseRatioMode: 'esno', threshold }
```

- `rsCode 0.9`：注释写的是「综合 CP 开销 ~6.7% 与 DMRS/导频开销」的工程值；
- `bandwidthFactor 1.1`：不是滚降，是「占用带宽 → 信道带宽」（5 MHz@15 kHz = 25 RB = 4.5 MHz 的倒数 1.11），只对 5 MHz 档准；
- 门限列注释已自认「AWGN、BLER=10% 的仿真预置，高阶 MCS 偏保守」。

### 2.2 门限怎么进引擎（GSO 引擎为准，NGSO / 再生式逐位镜像）

`packages/core/utils/linkCalculator.js`：

- 行 272–275 读 `noiseRatioMode`（只认 `'ebno'` / `'esno'`）与 `ebno`（门限值）；
- 行 394–398 速率链：`carrierRate = infoRate / rsCode / fec`，`symbolRate = carrierRate·m / modFactor`，`allocBandwidth = bandwidthFactor · symbolRate`，`k = fec·rsCode·modFactor / m`；
- 行 400–408：`esno` 模式下 `esno = 门限值`，`ebno = esno − 10lg k`；
- 行 650–659：**噪声带宽 `noiseBW = symbolRate`**，`thresholdCN = ebno + 10lg(infoRate / noiseBW) ≡ esno`；
- 行 1202–1206 出参 `ebnoResult / esnoResult / ebnoActualResult / esnoActualResult`。

同样的四段在 `linkCalculatorNGSO.js` 行 342–345 / 510–519 / 829–837 / 1474–1478；再生式 `linkCalculatorRegen.js` 行 96–100 / 268–271 / 393–395 只改写「实际值 = 门限 + 单侧余量」。

也就是说：**平台的「门限 Es/N₀」就是「符号率带宽内的门限 C/N」**，而 3GPP 行的「符号率」= `infoRate / (0.9 × R × Qm)`，是一个由用户填的信息速率与 0.9 反推出来的数，不是物理层的占用带宽。

### 2.3 全部触点（改动落点清单）

| 层 | 文件 | 位置 / 要点 |
|---|---|---|
| 内置表 | `packages/core/utils/constants.js` | 两张 NTN 表（§2.1）；`DVB_STANDARD_OPTIONS` 行 ~121–131 |
| 合并层 | `packages/core/utils/modcodTables.js` | `BUILTIN` 行 ~28–35（key → 表名）；`normMode()` 行 52–57 **只认 ebno/esno，认不出按 esno**；`normalizeRow()` 行 71–89；`ROW_KEYS` 行 99；`listStandards / storeFromList / standardOptions / modcodMap` |
| 主进程 | `electron/services/modcod.js` | 改写层文件 I/O（`userData/data/modcod.json`，只存差异） |
| MODCOD 编辑页 | `src/shared/modcodTable.js` + `src/components/FileManager.vue` 第 ④ 页 | `MODE_LABEL / MODE_OPTIONS` 行 16–17、`parseMode` 行 ~20、列定义行 40（tip）、枚举 options 行 55、显示行 63、setter 行 78、新行默认行 93、Excel 出表行 113、Excel 入表行 176 |
| 载波面板 | `src/linkbudget/BasebandPanel.vue`（GSO）；`src/ngso/BasebandPanel.vue`（NGSO，**再生式与端到端也 import 这一份**，多一个 `rateLocked` prop） | `toggleEbno` 行 42–50；`applyModcod` 行 123–135（把七个字段整套写进表单）；速率锚定链行 136–175（`rateChain / infoRateFrom / anchorOf` 来自 `src/shared/carrierRate.js` 行 96–160）；NTN 带宽提示 `ntnBw` 行 170 + 模板行 257–261；模板行 181–260 |
| 限值判据 | `src/shared/ntnLimits.js` | `NTN_BW_LIMITS`（NR 5/10/15/20/30 MHz、NB 200 kHz），`checkNtnBandwidth()` |
| 渲染端速率镜像 | `src/shared/carrierRate.js` | `rateFactors / rateChain / infoRateFrom / rateDisplays / anchoredRate`；`packages/core/test/modulation.test.mjs` 与 core 逐条对拍 |
| 端到端 | `src/e2e/e2eParams.js` 行 35–45 `CARRIER_FIELDS`（`noiseRatioMode` def `'ebno'`）、行 266–275 `thresholdCNOf()`（渲染端就地算门限 C/N，`esno` 直接返回）；`packages/core/utils/linkChain.js` 行 163–177 `carrierInto()`（逐字段拷贝载波到 linkParams）、行 1039 出参键表 |
| 扫描 / 级联 | `packages/core/utils/linkSweep.js`（行 576 附近注释提到 Es/N₀）；`packages/core/utils/waterfallBuilder.js` 行 75（`WF_DICT` 英译）、`'门限 Es/N₀'` 出现在行 732 / 1005 / 1350 / 1501 / 1646 / 1834，`'Es/N₀'`(实际) 在行 919 / 1260 / 1447 / 1598 / 1701 |
| 输出定义 | `packages/core/utils/lbOutputDefs.js` 行 47（thresholdCN）、54–55（ebno/esno 实际）；`src/shared/lbResultLabels.js` 行 33–41 |
| 报表 | `electron/services/report.js` 行 151 / 198（中英标签 `esno`）、359–385 / 434（取值）；`electron/services/reportDocx.js`；`src/report/ReportApp.vue`；`src/shared/lbReport.js` 行 425（参考文献表只有 DVB 条目，没有 3GPP） |
| i18n | `src/shared/i18n/uiDict.data.js`（EXACT 表，Es/N₀ 两条） |
| SLA | `src/shared/lbSla.js` 行 233–263：`rowThreshold()` 把 `ebno` 行换算到 Es/N₀，`pickMir()` 用 `esnoClear` 与 `symbolRateKsps × log2M × fec × rs` 算 MIR |
| 设置 | `src/pages/Settings.vue` 的 `noiseRatioMode`（新建载波的缺省口径，主进程白名单 `electron/ipc/register.js:868 SETTINGS_WRITABLE`）——只有 ebno/esno 两档，本任务不改它（3GPP 行的口径由标准决定，不由这个缺省决定） |
| 测试 | `packages/core/test/ntnParams.test.mjs`（锁 MCS 表调制/码率、门限单调、`bandwidthFactor === 1.1`——**这条断言本任务要改**）、`modcodTables.test.mjs`、`linkChain.test.js`、`accuracy.test.js` |

### 2.4 现状与厂家口径的差别（量化）

1. **名字**：厂家谈的是 SNR（每 RE）；平台叫 Es/N₀，且 Eb/N₀⇄Es/N₀ 切换钮对 3GPP 行没有意义。
2. **噪声带宽**：平台 = `symbolRate = infoRate / (rsCode·R·Qm)`；物理层 `infoRate = B_occ · (14/15) · (1 − OH) · Qm · R`（正常 CP 的 RE 速率 = 占用带宽 × 14/15；OH 为 TS 38.306 的开销系数，FR1 下行 0.14 / 上行 0.08），代入得 `symbolRate = B_occ · (14/15)(1 − OH) / rsCode`。取 rsCode = 0.9：下行 `symbolRate = 0.892·B_occ`，上行 `0.954·B_occ`。**同一条链路，平台报的 Es/N₀ 比厂家的每 RE SNR 高 0.50 dB（下行）/ 0.20 dB（上行）**。数不大，但它是「按经验系数反推」而不是「按分配算」，PRB 数、SCS 在平台里根本不存在。
3. **门限数值**：NR 表与公开 AWGN 链路级仿真基线（§4.2）相比高 0.6 dB（MCS0）… 6.2 dB（MCS28），越高阶越保守；NB-IoT 表反过来比公开基线（§4.4）**乐观** 0.3–3.0 dB（I_TBS=0：−8.8 vs −5.8）。两张表都没有条件元数据（BLER 目标 / 信道 / 码块规模），厂家的数录进来后无法对表。
4. **缺的东西**：MCS 表 2（256QAM）、表 3（低频谱效率，NTN 覆盖受限场景常用）、PUSCH 变换预编码表（π/2-BPSK，NTN 上行的主力）；NB-IoT 只有 NPDSCH，没有 NPUSCH 多音/单音（单音 15 kHz / 3.75 kHz 的噪声带宽比 180 kHz 小 10.8 / 16.8 dB，是 IoT-NTN 上行闭合链路的核心手段）；重复次数 / 聚合因子；PRB 数与 SCS；BLER 目标。
5. `bandwidthFactor 1.1` 只对 5 MHz@15 kHz 准（真实比值：5/10/15/20/30 MHz @15 kHz = 1.111 / 1.068 / 1.055 / 1.048 / 1.042）。

---

## 3 研究结论（口径定义与依据）

### 3.1 厂家说的 SNR 是什么

- **3GPP 定义**：TS 38.215 §5.1.6 SS-SINR =「承载 SSS 的各资源元素上信号功率的线性平均 ÷ 同一带宽内各资源元素上噪声+干扰功率的线性平均」；CSI-SINR 同构。即 **按 RE 定义**，UE 上报的 SINR、gNB 从 DMRS 估出来的 PUSCH SNR（srsRAN / Amarisoft 的 `snr` 字段）、模组 AT 指令回的 SNR（Quectel `AT+QENG` 从参考信号估）都是这一口径。
- **链路级仿真定义**：MATLAB 5G Toolbox「SNR Definition Used in Link Simulations」：`SNR = S_RE / N_RE`（每 RE、每接收天线），时域加噪时 `N0 = 1/√(N_Rx·N_FFT·SNR)`，等价于 `SNR = S·N_FFT / (N·K_S)`（K_S = 占用子载波数）。MATLAB 的 NR NTN PDSCH 吞吐示例同样写明「SNR 按 RE 定义」。
- **厂家的门限表**：给的是「MCS i 在 BLER=10%（首传）下所需 SNR」，条件通常是 AWGN 或 NTN-TDL 信道、单层、某个 PRB 数 / TBS。厂家实现之间差几个 dB 是常态——例：srsRAN 开源 gNB 的 UL SNR→MCS 表（§4.3 列）与 UC3M/York 的 MATLAB LLS 在 64QAM 高码率相差 3 dB 以上。**所以口径要钉死、数值要可覆盖。**

### 3.2 SNR（每 RE）≡ Es/N₀（每 RE）≡ 占用带宽内的 C/N

对 OFDM：信号功率均匀分布在 N_sc = N_RB × 12 个子载波上，每 RE 信号功率 `S_RE = C / N_sc`；每 RE 噪声功率 `N_RE = N₀ · SCS`；于是 `SNR_RE = C / (N₀ · N_sc · SCS) = C / (N₀ · B_occ)`。又每 RE 的符号能量 `Es = S_RE · T_u = S_RE / SCS`，故 `Es/N₀ = S_RE / (N₀·SCS) = SNR_RE`。**三者是同一个数**，前提只有一条：噪声带宽取 **占用带宽 B_occ = N_RB × 12 × SCS**（NB-IoT 上行 = 音数 × SCS）。CP 被接收端丢掉、DMRS 不载数据，这些只进 Eb/N₀（速率折算），不进 SNR。

### 3.3 3GPP 链路预算的 CNR 就是这个口径

TR 38.821 §6.1.3.1 / TR 36.763（MATLAB「NB-IoT NTN Link Budget Analysis」逐字复现）：

```
CNR [dB] = EIRP + G/T − k − PL_FS − PL_A − PL_SM − PL_SL − PL_AD − 10·lg(B)
```

B 是**本次分配的带宽**：NR 下行取整载波系统带宽（S 频段 30 MHz、Ka 400 MHz），上行手持终端取小分配（TR 38.821 参数表为 360 kHz，落笔前核对原文 Table 6.1.3.2-1）；NB-IoT 下行 180 kHz，上行 3.75 / 15 / 45 / 90 / 180 kHz 按音数取。Kodheli 等（2019）的 NB-IoT 卫星链路预算同式，并明确「required SNR = 首次 HARQ 传输 BLER 10%」。

### 3.4 其他两种「带宽」口径，明确不用

| 口径 | 与每 RE SNR 的差 | 备注 |
|---|---|---|
| 信道带宽（含保护带） | −0.46 / −0.29 / −0.23 / −0.20 / −0.18 dB（5/10/15/20/30 MHz @15 kHz） | 平台「载波带宽」= 这个，只用于信道带宽档位核对与转发器占用比，**不当噪声带宽** |
| FFT 全带宽 | −10lg(N_FFT/K_S)（5 MHz：−10lg(512/300)= −2.3 dB） | 只是仿真器内部尺度 |
| 符号率带宽（平台现状） | +0.50 dB（DL）/ +0.20 dB（UL） | §2.4 第 2 条 |

### 3.5 NB-IoT 单音的 SNR 带宽

单音 15 kHz 的噪声带宽比 12 音（180 kHz）小 10.8 dB，3.75 kHz 小 16.8 dB；Kodheli 表 3 的单音列门限（−4.2 … 6.9 dB）与多音列（−5.8 … 6.9 dB）不同，正因为 SNR 定义在各自的音带宽上。平台的 NB-IoT 上行必须显式带「音数 + SCS」，否则单音链路预算无从做起。

### 3.6 重复 / 聚合

- NR：`pdsch-AggregationFactor ∈ {2,4,8}`；PUSCH 重复类型 A 到 16（Rel-15/16），Rel-17 覆盖增强到 32；NB-IoT：NPDSCH `N_rep ∈ {1,2,4,…,2048}`（TS 36.213 Table 16.4.1.3-2），NPUSCH 到 128。
- 口径：`SNR_req(N) = SNR_req(1) − 10·lg N + L_comb`，理想合并 L_comb = 0（MATLAB NB-IoT 示例即按 10lg N 折算追加重复数），非理想信道估计下 0.5–1.5 dB，留成参数缺省 0。信息速率 ÷ N。

### 3.7 BLER 目标与 HARQ

- 厂家表几乎都按 **10% 首传 BLER**；AWGN 大码块下 LDPC 曲线很陡：UC3M 数据里 BLER 1e-2 → 1e-3 只差 0.1–0.2 dB，故 10% → 1% 约 +0.3–0.5 dB。
- GEO NTN 常关 HARQ 反馈（RTT 太长），链路自适应改盯 1% 或用盲重传。本任务把 BLER 目标做成**表级元数据 + 用户可改**，不做自动折算（§11-6）。

### 3.8 公开门限数据源盘点

| 来源 | 条件 | 范围 | 结论 |
|---|---|---|---|
| UC3M/York, VTC2024-Fall《BLER-SNR Curves for 5G NR MCS under AWGN》 | MATLAB LLS、AWGN、SISO、大 TBS（4.9k–61k bit）、BLER 1e-2…1e-8 | QPSK 120/1024：−5.1 dB@1e-2；64QAM 910/1024：19.1 dB@1e-2 | **主锚点**（10% 取 1e-2 值 −0.3 dB） |
| Fluid-Antenna 论文（arXiv 2503.05384）表 II | SISO、AWGN、5 MHz、线性拟合到 BLER 0.1 | CQI 表（QPSK 78/1024 −7.84 … 64QAM 948/1024 20.03 dB） | 次锚点 |
| srsRAN Project `mcs_calculator.cpp` `ul_snr_mcs_table` | 真 gNB + AWGN 信道（ZMQ）、20 MHz SISO、判据「BLER=0%」、作者标「temporary」 | MCS0 −5.80 … MCS28 16.59 dB | 厂家口径的实例，不当基线 |
| 5G-LENA（CTTC）`nr-eesm-t1/t2.cc` | NR 合规 LLS，按码块规模分表 | 10% 门限比上两者**高 3–5 dB**（MCS0 ≈ −0.8 dB） | 绝对值不用；**小码块惩罚**可用：CBS ≤ 500 bit 比 ≥ 3000 bit 高 +0.3（MCS0）… +1.3（MCS24）… +2.2 dB（MCS27） |
| Kodheli 等 2019《Link budget analysis for satellite-based NB-IoT》表 3 | MATLAB LLS、AWGN、Turbo、N_rep=1、每档取最大吞吐 TBS、BLER 10% 首传 | NPDSCH/NPUSCH-MT I_TBS 0–13：−5.8 … 6.9 dB；NPUSCH-ST 0–10：−4.2 … 6.9 dB | **NB-IoT 基线** |
| 平台现有预置 | 「AWGN BLER=10% 工程预置」 | NR −5.10 … 25.56；NB −8.80 … 4.76 | NR 偏保守 0.6–6.2 dB，NB 偏乐观 0.3–3.0 dB |

### 3.9 结论

1. 厂家 SNR 与平台 Es/N₀ 在物理上是同一个量；差别在噪声带宽的取法（经验系数反推 vs 按分配算）和名字。改法不是「加一个换算系数」，而是**让 3GPP 载波按 PRB / SCS / MCS / 重复描述，噪声带宽 = 占用带宽**，SNR 自然就对上。
2. 门限数值本身 3GPP 不规定；内置表按公开 LLS 重定基线并标明条件，厂家表原样录入覆盖。
3. DVB 链路与「自定义」体制完全不受影响。

---

## 4 数据（落进 `constants.js` 的数字，均已对照原文）

### 4.1 NR MCS 表（TS 38.214 V17.0.0 原文转录，`MCS: Qm / R×1024`）

- **表 1**（Table 5.1.3.1-1，64QAM）：平台已有且已锁测试，不动。
- **表 2**（Table 5.1.3.1-2，256QAM，MCS 0–27）：0:2/120 1:2/193 2:2/308 3:2/449 4:2/602 5:4/378 6:4/434 7:4/490 8:4/553 9:4/616 10:4/658 11:6/466 12:6/517 13:6/567 14:6/616 15:6/666 16:6/719 17:6/772 18:6/822 19:6/873 20:8/682.5 21:8/711 22:8/754 23:8/797 24:8/841 25:8/885 26:8/916.5 27:8/948。
- **表 3**（Table 5.1.3.1-3，低频谱效率 64QAM，MCS 0–28）：0:2/30 1:2/40 2:2/50 3:2/64 4:2/78 5:2/99 6:2/120 7:2/157 8:2/193 9:2/251 10:2/308 11:2/379 12:2/449 13:2/526 14:2/602 15:4/340 16:4/378 17:4/434 18:4/490 19:4/553 20:4/616 21:6/438 22:6/466 23:6/517 24:6/567 25:6/616 26:6/666 27:6/719 28:6/772。
- **PUSCH 变换预编码表 1**（Table 6.1.4.1-1，MCS 0–27）：0:q/240÷q 1:q/314÷q 2:2/193 3:2/251 4:2/308 5:2/379 6:2/449 7:2/526 8:2/602 9:2/679 10:4/340 11:4/378 12:4/434 13:4/490 14:4/553 15:4/616 16:4/658 17:6/466 18:6/517 19:6/567 20:6/616 21:6/666 22:6/719 23:6/772 24:6/822 25:6/873 26:6/910 27:6/948。`tp-pi2BPSK` 配置时 q=1（π/2-BPSK，R=240/1024、314/1024），否则 q=2（QPSK，R=120/1024、157/1024）。
- **PUSCH 变换预编码表 2**（Table 6.1.4.1-2，低频谱效率，MCS 0–27）：0:q/60÷q 1:q/80÷q 2:q/100÷q 3:q/128÷q 4:q/156÷q 5:q/198÷q 6:2/120 7:2/157 8:2/193 9:2/251 10:2/308 11:2/379 12:2/449 13:2/526 14:2/602 15:2/679 16:4/378 17:4/434 18:4/490 19:4/553 20:4/616 21:4/658 22:4/699 23:4/772 24:6/567 25:6/616 26:6/666 27:6/772。
- 表 4（1024QAM）NTN 不用，不收。
- 表内 q 档在 MODCOD 表里**拆成两行**：`MCS0 (q=1) π/2-BPSK 240/1024` 与 `MCS0 (q=2) QPSK 120/1024`；平台调制方式体系里 π/2-BPSK 记作 `BPSK`（M-PSK，M=2），`fec` 照写 `240/1024`。

### 4.2 NR 门限基线（每 RE SNR，dB，BLER 10% 首传，AWGN，SISO，大码块 ≥ 3000 bit，N_rep=1）

**方法**（可复现，写进代码注释）：门限 = Shannon 极限 `10lg(2^SE − 1)` + 按调制族线性拟合的实现差距 `gap(SE)`，SE = Qm·R/1024。锚点：UC3M/York 表 II 的 BLER 1e-2 值减 0.3 dB，与 Fluid-Antenna 表 II 的 BLER 0.1 值，最小二乘得
`QPSK: gap = 1.606 − 0.270·SE`，`16QAM: gap = 1.689 + 0.094·SE`，`64QAM: gap = 2.019 + 0.121·SE`；256QAM 外推 64QAM 的式子；π/2-BPSK 用 QPSK 的式子（同频谱效率，差别在 PAPR 不在 SNR）；表 3 前六档（R ≤ 99/1024）是外推，与「R < 1/5 时 LDPC 只做重复」的 10lg 折算一致（MCS0 −12.2 ≈ QPSK 120 的 −6.0 − 10lg(120/30)）。

| MCS | 表 1 基线 | 平台现值 | Δ | srsRAN UL 表（参考） |
|---|---|---|---|---|
| 0 | −6.0 | −5.10 | +0.9 | −5.80 |
| 1 | −4.7 | −4.10 | +0.6 | −3.55 |
| 2 | −3.7 | −3.16 | +0.6 | −2.92 |
| 3 | −2.5 | −1.80 | +0.7 | −2.56 |
| 4 | −1.4 | −0.69 | +0.7 | −1.05 |
| 5 | −0.3 | 0.73 | +1.1 | 0.98 |
| 6 | 0.6 | 2.02 | +1.4 | 1.62 |
| 7 | 1.5 | 3.41 | +1.9 | 2.54 |
| 8 | 2.3 | 4.72 | +2.4 | 3.42 |
| 9 | 3.0 | 5.94 | +2.9 | 4.35 |
| 10 | 3.6 | 5.95 | +2.4 | 5.37 |
| 11 | 4.3 | 6.93 | +2.6 | 5.83 |
| 12 | 5.3 | 8.12 | +2.8 | 6.64 |
| 13 | 6.3 | 9.31 | +3.0 | 7.64 |
| 14 | 7.3 | 10.68 | +3.4 | 9.59 |
| 15 | 8.2 | 11.93 | +3.7 | 10.40 |
| 16 | 8.9 | 12.73 | +3.9 | 11.15 |
| 17 | 9.3 | 12.79 | +3.5 | 12.11 |
| 18 | 9.9 | 13.65 | +3.8 | 12.53 |
| 19 | 10.9 | 14.93 | +4.0 | 13.06 |
| 20 | 12.0 | 16.13 | +4.2 | 13.53 |
| 21 | 12.9 | 17.40 | +4.5 | 13.94 |
| 22 | 13.9 | 18.62 | +4.7 | 14.12 |
| 23 | 15.0 | 19.84 | +4.9 | 14.55 |
| 24 | 16.0 | 21.19 | +5.2 | 14.97 |
| 25 | 16.9 | 22.40 | +5.5 | 15.35 |
| 26 | 17.9 | 23.66 | +5.8 | 15.92 |
| 27 | 18.6 | 24.59 | +6.0 | 16.04 |
| 28 | 19.3 | 25.56 | +6.2 | 16.59 |

同一模型算出的其余四张表（按 MCS 0 起逐档，dB）：

- 表 2：−6.0, −3.7, −1.4, 0.6, 2.3, 4.3, 5.3, 6.3, 7.3, 8.3, 8.9, 9.9, 10.9, 12.0, 12.9, 13.9, 15.0, 16.0, 16.9, 17.9, 18.6, 19.3, 20.4, 21.5, 22.5, 23.6, 24.4, 25.2
- 表 3：−12.2, −11.0, −10.0, −8.9, −8.0, −6.9, −6.0, −4.7, −3.7, −2.5, −1.4, −0.3, 0.6, 1.5, 2.3, 3.6, 4.3, 5.3, 6.3, 7.3, 8.3, 9.3, 9.9, 10.9, 12.0, 12.9, 13.9, 15.0, 16.0
- 变换预编码表 1（q=1 与 q=2 同值）：−6.0, −4.7, −3.7, −2.5, −1.4, −0.3, 0.6, 1.5, 2.3, 3.0, 3.6, 4.3, 5.3, 6.3, 7.3, 8.3, 8.9, 9.9, 10.9, 12.0, 12.9, 13.9, 15.0, 16.0, 16.9, 17.9, 18.6, 19.3
- 变换预编码表 2：−12.2, −11.0, −10.0, −8.9, −8.0, −6.9, −6.0, −4.7, −3.7, −2.5, −1.4, −0.3, 0.6, 1.5, 2.3, 3.0, 4.3, 5.3, 6.3, 7.3, 8.3, 8.9, 9.5, 10.5, 12.0, 12.9, 13.9, 16.0

**小分配修正（元数据，不自动加）**：TBS ≤ 500 bit 时门限抬高约 +0.3（低阶）… +1.3（64QAM 中段）… +2.2 dB（MCS27），来自 5G-LENA 表的小/大码块中位数之差。NTN 上行 1–2 PRB 恰在此区间，`title` 里要把这条口径写出来。

### 4.3 参考：srsRAN 的三张 UL 表（只进代码注释与 §12，不进内置表）

64QAM 表见 §4.2 最右列；256QAM 表 MCS0–27：1.80, 3.55, 4.93, 5.56, 6.05, 7.98, 8.63, 9.54, 10.42, 11.35, 12.37, 12.83, 13.14, 13.85, 14.69, 15.55, 15.95, 16.11, 16.83, 17.06, 17.43, 17.94, 18.12, 18.55, 18.87, 19.02, 20.59, 21.69；低频谱效率表与 64QAM 表相同（作者未单独测）。

### 4.4 NB-IoT

**TBS 表**（TS 36.213 v13.2.0，取自 srsRAN 4G `tbs_tables_nbiot.h`；Rel-14 Cat-NB2 另有 I_TBS=13 与更大 TBS（最大 2536），落表时按 ETSI TS 136 213 核对补齐，核不到就先收 Rel-13 并注明）：

NPDSCH Table 16.4.1.5.1-1（行 I_TBS 0–12，列 I_SF 0–7 ↔ N_SF = 1,2,3,4,5,6,8,10）：
```
16 32 56 88 120 152 208 256 | 24 56 88 144 176 208 256 344 | 32 72 144 176 208 256 328 424 | 40 104 176 208 256 328 440 568
56 120 208 256 328 408 552 680 | 72 144 224 328 424 504 680 – | 88 176 256 392 504 600 – – | 104 224 328 472 584 680 – –
120 256 392 536 680 – – – | 136 296 456 616 – – – – | 144 328 504 680 – – – – | 176 376 584 – – – – – | 208 440 680 – – – – –
```
NPUSCH Table 16.5.1.2-2（行 I_TBS 0–12，列 I_RU 0–7 ↔ N_RU = 1,2,3,4,5,6,8,10）：
```
16 32 56 88 120 152 208 256 | 24 56 88 144 176 208 256 344 | 32 72 144 176 208 256 328 424 | 40 104 176 208 256 328 440 568
56 120 208 256 328 408 552 680 | 72 144 224 328 424 504 680 872 | 88 176 256 392 504 600 808 1000 | 104 224 328 472 584 712 1000 –
120 256 392 536 680 808 – – | 136 296 456 616 776 936 – – | 144 328 504 680 872 1000 – – | 176 376 584 776 1000 – – – | 208 440 680 1000 – – – –
```
NPUSCH 单音（N_sc^RU = 1）的 I_MCS → (调制, I_TBS)（Table 16.5.1.2-1）：0→(π/2-BPSK, 0)，1→(π/2-BPSK, 2)，2→(π/4-QPSK, 1)，3…10→(π/4-QPSK, 3…10)；多音 I_MCS = I_TBS，QPSK。

**RU 时长**：12 音 1 ms、6 音 2 ms、3 音 4 ms、单音 15 kHz 8 ms、单音 3.75 kHz 32 ms。NPDSCH 一个子帧 1 ms。

**门限基线**（Kodheli 2019 表 3；每档 TBS 取最大吞吐那格，BLER 10% 首传，AWGN，Turbo，N_rep=1；SNR 定义在分配带宽上）：

| I_TBS | NPDSCH（180 kHz） | NPUSCH 多音（45/90/180 kHz） | NPUSCH 单音（15 或 3.75 kHz） |
|---|---|---|---|
| 0 | −5.8 | −5.8 | −4.2 |
| 1 | −4.9 | −4.9 | −3.2 |
| 2 | −3.9 | −3.9 | −2.2 |
| 3 | −3.0 | −3.0 | −1.2 |
| 4 | −2.0 | −2.0 | −0.1 |
| 5 | −1.1 | −1.1 | 0.9 |
| 6 | −0.1 | −0.2 | 1.9 |
| 7 | 0.6 | 0.7 | 3.1 |
| 8 | 1.3 | 1.4 | 4.3 |
| 9 | 2.2 | 2.2 | 5.6 |
| 10 | 3.1 | 3.1 | 6.9 |
| 11 | 4.2 | 4.2 | — |
| 12 | 5.5 | 5.5 | — |
| 13 | 6.9 | 6.9 | — |

单音那列对 15 kHz 与 3.75 kHz 同值（SNR 各按自己的音带宽定义）。

### 4.5 信道带宽 ↔ N_RB（TS 38.101-5 Table 5.3.2-1，与 TS 38.101-1 同值；FR2-NTN 为 Rel-18 新增，落表前核对 TS 38.101-5 V18 的 FR2-NTN 表）

| 信道带宽 | 15 kHz | 30 kHz | 60 kHz | 信道/占用（15 kHz） |
|---|---|---|---|---|
| 5 MHz | 25 | 11 | — | 1.111 |
| 10 MHz | 52 | 24 | 11 | 1.068 |
| 15 MHz | 79 | 38 | 18 | 1.055 |
| 20 MHz | 106 | 51 | 24 | 1.048 |
| 30 MHz（n255，Rel-18） | 160 | 78 | 38 | 1.042 |

FR2-NTN（n510/n511/n512，Ka）：60 kHz：50→66、100→132、200→264 RB；120 kHz：50→32、100→66、200→132、400→264 RB。

### 4.6 TBS 与速率

- **TS 38.306 §4.1.2 近似式**：`R_b = ν · Qm · f · R · (N_RB·12 / T_s) · (1 − OH)`，`T_s = 1 ms / (14·2^μ)`（含 CP 的平均符号时长，故 `N_RB·12/T_s = B_occ · 14/15`），`OH` = 0.14（FR1 DL）/ 0.08（FR1 UL）/ 0.18（FR2 DL）/ 0.10（FR2 UL）。校验值：20 MHz@15 kHz、106 RB、64QAM 948/1024、ν=1、OH 0.14 → **85.07 Mbps**。
- **TS 38.214 §5.1.3.2 精确 TBS（每时隙）**：`N'_RE = 12·N_symb − N_DMRS − N_oh`（`N_oh` = xOverhead 0/6/12/18，缺省 0）；`N_RE = min(156, N'_RE) · n_PRB`；`N_info = N_RE·R·Qm·ν`；
  - `N_info ≤ 3824`：`n = max(3, ⌊log2 N_info⌋ − 6)`，`N'_info = max(24, 2^n·⌊N_info/2^n⌋)`，TBS = Table 5.1.3.2-1 中 ≥ N'_info 的最小值；
  - 否则：`n = ⌊log2(N_info − 24)⌋ − 5`，`N'_info = max(3840, 2^n · round((N_info − 24)/2^n))`（round 的 .5 向上）；R ≤ 1/4：`C = ⌈(N'_info+24)/3816⌉`，`TBS = 8·C·⌈(N'_info+24)/(8C)⌉ − 24`；R > 1/4 且 N'_info > 8424：`C = ⌈(N'_info+24)/8424⌉`，同式；否则 `TBS = 8·⌈(N'_info+24)/8⌉ − 24`。
  - Table 5.1.3.2-1（93 个）：24 32 40 48 56 64 72 80 88 96 104 112 120 128 136 144 152 160 168 176 184 192 208 224 240 256 272 288 304 320 336 352 368 384 408 432 456 480 504 528 552 576 608 640 672 704 736 768 808 848 888 928 984 1032 1064 1128 1160 1192 1224 1256 1288 1320 1352 1416 1480 1544 1608 1672 1736 1800 1864 1928 2024 2088 2152 2216 2280 2408 2472 2536 2600 2664 2728 2792 2856 2976 3104 3240 3368 3496 3624 3752 3824。
  - 校验值：1 PRB、14 符号、DMRS 12 RE、表 1 MCS0 → N_RE 156、N_info 36.6 → TBS **32 bit/时隙**（15 kHz 下 32 kbps）；25 PRB、14 符号、DMRS 12 RE、MCS9 → N_info 5172.1 → N'_info 5120 → TBS **5120 bit/时隙**（5.12 Mbps）。
- **NB-IoT**：下行 `R_b = TBS(I_TBS, I_SF) / (N_SF · 1 ms · N_rep)`；上行 `R_b = TBS(I_TBS, I_RU) / (N_RU · T_RU · N_rep)`。校验值：单音 15 kHz、I_TBS 0、I_RU 0、N_rep 1 → 16 bit / 8 ms = **2 kbps**，噪声带宽 15 kHz；12 音、I_TBS 12、I_RU 3 → 1000 bit / 4 ms = **250 kbps**，噪声带宽 180 kHz。

---

## 5 方案设计

### 5.1 口径 `snr`

- `noiseRatioMode` 第三个合法值 `'snr'`：**门限值 = 每 RE SNR = 占用带宽内的 C/N**。`modcodTables.normMode()` 认 `snr / sinr / 信噪比 / SNR(dB)`；`normalizeRow()` 保留；`src/shared/modcodTable.js` 的 `MODE_LABEL/MODE_OPTIONS/parseMode` 加第三项（显示名 `SNR`）。
- 不变式：`snr` 行送进引擎时 `symbolRate ≡ 噪声带宽 ≡ B_occ`，于是既有的 `thresholdCN = ebno + 10lg(infoRate/noiseBW) = esno` 恒等式**不用改一行**就等于 SNR；`k := infoRate / B_occ`（占用带宽上的频谱效率，bit/s/Hz），`ebno = snr − 10lg k`——Eb/N₀ 自动把 CP、DMRS、开销、重复全算进去。
- `snr` 行不允许 Eb/N₀⇄Es/N₀ 切换（面板上不出那颗钮）；Eb/N₀ 等价值放 `title`。

### 5.2 载波描述子 `phy`（只在 3GPP 标准下存在，随载波表单入库 / 入分享包 / 入端到端节点）

```js
// NR
phy: { kind: 'nr', dir: 'dl'|'ul', scs: 15|30|60|120, nRb: 25, chBwMHz: 5|null,
       mcsTable: 't1'|'t2'|'t3'|'tp1'|'tp2', mcs: 7, q: 2,          // q 只对 tp 表 MCS 0–1 / 0–5 有意义
       nSymb: 14, nDmrs: 12, nOh: 0,                                // 精确 TBS 用；缺省 UL 14 / DL 12 符号
       rateModel: 'tbs'|'oh38306', oh: 0.14|0.08,                   // 见 §11-3
       nRep: 1, combLossDb: 0, layers: 1 }
// NB-IoT
phy: { kind: 'nbiot', dir: 'dl'|'ul', scs: 15|3.75, nTones: 1|3|6|12,
       iTbs: 0, iSf: 7, iRu: 7, nRep: 1, combLossDb: 0 }
```

- 标准 → `phy.kind / mcsTable / dir` 由 `modcodTables.js` 的 `PHY_OF` 表给（内置 key 见 §5.6）；用户自建标准在「文件管理 · MODCOD 表」的标准头上选 `无 / NR / NB-IoT`（存 `custom[].phy`、`overrides[key]` 不需要——内置标准的 phy 不可改）。
- 下行 NR 的 `nRb` 按 `chBwMHz + scs` 查 §4.5 表自动填；上行 `nRb` 直填（title：本 UE 的分配）。下行「一条载波 = 整个 NR 载波」，上行「一条载波 = 一个 UE 的分配」，两句话写进 `title`。
- `mcs` 与 MODCOD 表行一一对应：`applyModcod()` 选中某行即写 `phy.mcs / q`，并把该行的 `modulation / fec / threshold / noiseRatioMode` 照旧写进表单（老字段继续是「真值」，`phy` 只补物理层参数）。MODCOD 行新增可选数值字段 `idx`（MCS 索引或 I_TBS），`ROW_KEYS` 加 `idx`，`normalizeRow` 认不出留空——别再用正则从 label 里抠 `I_TBS=`。

### 5.3 纯函数模块 `ntnPhy.js`（核心层 `packages/core/utils/ntnPhy.js` 是真值，渲染端 `src/shared/ntnPhy.js` 是 ESM 镜像，`packages/core/test/ntnPhy.test.mjs` 拿同一组向量逐条对拍，照 `modulation.js / carrierRate.js` 的老办法）

```
nrRbTable(scs)                 → { 5:25, 10:52, ... }            §4.5
nrOccupiedBwKHz(phy)           = nRb·12·scs
nrChannelBwKHz(phy)            = chBwMHz·1000（有）| 否则查表取能装下 nRb 的最小档 | 查不到 = 占用带宽
nrTbsPerSlot(phy, Qm, R)       §4.6 精确算法（含 Table 5.1.3.2-1）
nrInfoRateKbps(phy, Qm, R)     'tbs'：TBS × 1000·2^μ / nRep；'oh38306'：B_occ·(14/15)·(1−oh)·Qm·R·layers / nRep
nbOccupiedBwKHz(phy)           = nTones·scs
nbChannelBwKHz(phy)            = 200（dl 或 12 音）| 否则 = 占用带宽
nbTbs(phy)                     查 §4.4 两张表（dir 决定），越界返回 null
nbInfoRateKbps(phy)            §4.6
effectiveThresholdDb(thr, phy) = thr − 10lg(nRep) + combLossDb
describe(phy, lang)            'NR 15 kHz × 25 PRB · T1 MCS7 · ×1' 一类的短串（数据，须 byLang 生成，见记忆 ui-language-switch）
```

### 5.4 引擎接入（三引擎 + 端到端链 + 扫描器）

`linkCalculator.js / linkCalculatorNGSO.js / linkCalculatorRegen.js`（再生式走前两者的入参，改动只在「实际值」回写处）：

- 入参解析处（GSO 行 272 附近）：`noiseRatioMode === 'snr'` 时要求 `inputs.phy`（对象，IPC 前已是纯数据——见记忆 ipc-no-reactive-proxy），用 `ntnPhy` 算 `bOcc / bCh / infoRate / thrEff`；随后：
  `infoRate := 算出的值`（忽略表单里那份）；`symbolRate := bOcc`；`allocBandwidth := bCh`；`k := infoRate / bOcc`；`esno := thrEff`；`ebno := esno − 10lg k`；`modulationFactor` 照常由调制方式取（只用于显示）。
  DVB 链（`carrierRate / ChipRate / 滚降`）对 `snr` 行不再执行，`m`（扩频增益）视为 1。
- 其余全部不动：`noiseBW = symbolRate` 天然就是 B_occ，`thresholdCN ≡ snr`，功率带宽 / 占用比 / PSD 照旧按 `allocBandwidth`（信道带宽）走——**唯 PSD（dBW/Hz）改按 B_occ 算**，否则 3GPP 行的 PSD 比物理值低 0.2–0.5 dB；DVB 行 PSD 不动。
- 出参新增（字符串数，`toFixed(2 + FX)`）：`snrThresholdResult`（表值）、`snrThresholdEffResult`（含重复）、`snrActualResult`（= 门限有效值 + 余量，与 `esnoActualResult` 同数）、`noiseBwResult`（kHz，= B_occ）、`phyRepResult`、`phyTbsResult`（bit/时隙 或 bit/RU）、`phyDescResult`。`esnoResult / esnoActualResult / ebno*` 对 `snr` 行照出（SLA 的 MIR 与自定义列都在读它们）。
- `linkChain.js carrierInto()`：多拷 `phy`；出参键表（行 1039 附近）加新键；端到端「信息速率全程守恒」的规则对 `snr` 行改为「链首 phy 定信息速率，下游段照抄链首 phy 的 mcs/nRb 不许改速率」。`e2eParams.js thresholdCNOf()`：`snr` 时返回 `effectiveThresholdDb(ebno, phy)`。
- `linkSweep.js`：扫描期间 `phy` 原样透传；SLA 档位扫描同理。

### 5.5 迁移与兼容（写成测试）

1. 老配置里 `dvbStandard ∈ {3GPP NR-NTN, 3GPP NB-IoT NTN}` 且 `noiseRatioMode === 'esno'`、无 `phy` 的行：**逐位照旧**走 DVB 链（本任务的引擎分支只认 `'snr'`）。四窗现有回归基线不许动。
2. 这样的行在面板上显示为现状（Es/N₀ 口径，帧效率 0.9，滚降 1.1），只在用户重新选一次 MODCOD 时才切到 `snr` + `phy` 缺省（下行 5 MHz、15 kHz、UL 1 PRB，nRep 1）。切换不是静默的：是用户点了下拉。
3. 内置表门限数按 §4 改后，通过「刷新」重拉 `link:baseband` 的用户看到新数；已存行不受影响（`applyModcod` 当时就把 threshold 拷进了表单）。这条要写进版本说明。
4. 「文件管理 · MODCOD 表」的改写层只存差异：没改过 NR 表的用户升级后自动吃新表；改过的照旧吃自己那份（新加的四张 NR 表 / 两张 NB 表是新 key，不受旧改写层影响）。
5. 分享包 v3：`phy` 随行深拷贝；`fingerprintOf` 计入。

### 5.6 内置标准清单（`modcodTables.BUILTIN` + `DVB_STANDARD_OPTIONS`）

| key（存档值） | 显示名 | phy | 门限来源 |
|---|---|---|---|
| `3GPP NR-NTN`（不改，兼容老档） | 3GPP NR-NTN · MCS 表 1（64QAM） | nr / t1 | §4.2 表 1 基线 |
| `3GPP NR-NTN T2` | 3GPP NR-NTN · MCS 表 2（256QAM） | nr / t2 | §4.2 |
| `3GPP NR-NTN T3` | 3GPP NR-NTN · MCS 表 3（低频谱效率） | nr / t3 | §4.2 |
| `3GPP NR-NTN TP1` | 3GPP NR-NTN · PUSCH 变换预编码表 1 | nr / tp1 / dir ul | §4.2 |
| `3GPP NR-NTN TP2` | 3GPP NR-NTN · PUSCH 变换预编码表 2（低频谱效率） | nr / tp2 / dir ul | §4.2 |
| `3GPP NB-IoT NTN`（不改） | 3GPP NB-IoT NTN · NPDSCH | nbiot / dl | §4.4 |
| `3GPP NB-IoT NTN NPUSCH MT` | 3GPP NB-IoT NTN · NPUSCH 多音 | nbiot / ul / nTones 3\|6\|12 | §4.4 |
| `3GPP NB-IoT NTN NPUSCH ST` | 3GPP NB-IoT NTN · NPUSCH 单音 | nbiot / ul / nTones 1 | §4.4 |

- 标准下拉按 `<optgroup>` 分「DVB / 3GPP NR-NTN / 3GPP NB-IoT NTN / 自建」。
- 每张 3GPP 内置表带 `meta = { bler: 0.1, channel: 'AWGN', block: '≥3000 bit'|'每档最大吞吐 TBS', rep: 1, source: '…', snrRef: 'perRE' }`；自建标准的 `meta` 在标准头上可填；`meta` 进 `title`，不进版面。
- NB-IoT NPDSCH 表：行改为 I_TBS 0–13 全档（现在只有 8 档），`idx` = I_TBS，`fec` 保留现在的约分写法作显示；单音表行按 I_MCS 0–10（调制 BPSK/QPSK 按 §4.4 映射）。
- `src/shared/ntnLimits.js`：`NTN_BW_LIMITS` 改从 `ntnPhy.nrRbTable` 派生，判据对 `snr` 行恒不出（带宽就是查表来的），只对老式 `esno` 行继续提示；`fr2Note` 在 FR2 表落地后删。

### 5.7 界面、级联、报表、SLA

- **载波面板**（两份 `BasebandPanel.vue` 同改，`rateLocked` 语义照旧）：`form.dvbStandard` 对应 `phy` 非空时，隐藏 帧效率 / 滚降 / 码片速率 / 符号率 / Eb⇄Es 切换钮，改出一组物理层字段：方向、子载波间隔、信道带宽（DL）或 PRB 数（UL）/ 音数 + SCS（NB）、MCS（即 MODCOD 下拉）、重复次数、开销模型与 OH、（NB）I_SF / I_RU；只读读数：占用带宽、信道带宽、信息速率、频谱效率（bit/s/Hz，按 B_occ）、TBS。门限框标签 `SNR (dB)`，`title` 写全口径（每 RE；噪声带宽 = 占用带宽 N_RB×12×SCS；表条件 meta；小分配修正见 §4.2）。速率锚点对 `phy` 行固定为 PRB/信道带宽，`rateAnchor` 不再参与。
- **自动命名**（`lbAutoName`，见记忆 lb-library-auto-naming）：`phy` 行报 `describe(phy, lang)`。
- **级联**（`waterfallBuilder.js` 六处「载波与调制参数」块）：`phy` 行改列 体制 / SCS / PRB(音)数 / 占用带宽 / 信道带宽 / MCS(Qm, R) / TBS / 重复 / 开销 / 信息速率 / 频谱效率 / 门限 SNR（表值）/ 门限 SNR（含重复）；「性能与余量」块的 `Es/N₀` 行对 `phy` 行显示为 `SNR`。`WF_DICT` 加英译。
- **链路表 / 输出定义**：`lbOutputDefs.js` 新增 `snrThresholdEffResult`（门限 SNR）、`snrActualResult`（SNR（实际））、`noiseBwResult`（噪声带宽）三列，默认不勾；`thresholdCN` 列继续是通用列。`lbResultLabels.js` 同步。
- **报表**（`report.js / reportDocx.js / ReportApp.vue / lbReport.js`）：标签包加 `snr`；`phy` 行的详细预算用 SNR 词；`lbReport.js:425` 参考文献表加三条：TS 38.214（MCS 表与 TBS）、TS 38.215（SINR 定义）、TR 38.821 / TR 36.763（NTN 链路预算参数与 CNR 式）。
- **i18n**：`uiDict.data.js` 补齐新标签；`describe()` 的英文串走 byLang。
- **SLA**（`lbSla.js`）：`rowThreshold()` 对 `snr` 行直接取 `threshold`（不乘 k）；`pickMir()` 对 `phy` 行改为「同一 nRb / nRep 下，遍历该表各档，取 `effectiveThresholdDb(thr_i) + 系统余量 ≤ 晴空 SNR` 的最高 `nrInfoRateKbps` 档」，`ctx` 多传 `phy`。
- **MODCOD 编辑页**：门限口径枚举加 `SNR`；`idx` 列；标准头上的 `phy` 选择器与 `meta` 四个格；Excel 进出照通用通道，`normalizeRow` 是最后一道闸。

---

## 6 测试与验证（`npm test` 串里追加）

`packages/core/test/ntnPhy.test.mjs`（核心与镜像对拍）：

1. §4.5 全表：`nrRbTable`、占用带宽、信道带宽反查（25 RB@15 kHz → 5000 kHz；30 RB → 10 MHz 档）。
2. RE 速率 = B_occ × 14/15；38.306 校验值 85.07 Mbps（106 RB、64QAM 948、OH 0.14）。
3. 精确 TBS 两个校验值（32 bit、5120 bit）+ Table 5.1.3.2-1 长度 93、单调、首 24 末 3824。
4. NB-IoT 两个校验值（2 kbps@15 kHz、250 kbps@180 kHz）+ 越界（I_RU 7 在 I_TBS 12）返回 null。
5. `effectiveThresholdDb`：nRep 4 → −6.02 dB；combLoss 1 → −5.02。

`packages/core/test/ntnSnrEngine.test.mjs`：

6. **等价性**：同一条链路，`snr` 行（phy）与手工构造的 `esno` 行（`rsCode := (14/15)(1−OH)`、`bandwidthFactor := bCh/bOcc`、`infoRate` 取 phy 算出的值）三个引擎 `thresholdCN / linkmargin / esnoActualResult` 逐位相同；把 rsCode 换回 0.9，差值 = 0.497 dB（DL，OH 0.14）/ 0.204 dB（UL，OH 0.08），钉死到 1e-3。
7. **不变式**：`snr` 行 `thresholdCN === snrThresholdEffResult`，`esnoActualResult === snrActualResult`，`noiseBwResult === bOcc`。
8. **老行不变**：四窗既有回归夹具（`accuracy.test.js`、`linkChain.test.js`）逐位不变；`esno` 行 + `dvbStandard = '3GPP NR-NTN'` 无 `phy` 走老链。
9. **PSD**：`snr` 行按 B_occ；DVB 行不变。

`packages/core/test/ntnParams.test.mjs`（改）：

10. 五张 NR 表调制/码率逐条等于 §4.1；`bandwidthFactor === 1.1` 断言删掉，改为「`snr` 行 rsCode/bandwidthFactor 不参与计算」；门限随 MCS 单调不降（表 3 / TP2 的 q 行按频谱效率排）；`meta` 齐全；NB 三张表 I_TBS 覆盖 0–13 / 0–13 / 0–10。
11. `modcodTables.normMode('SNR') === 'snr'`、`'sinr'`、`'信噪比'`；`storeFromList` 只存差异对新 key 同样成立；老 `modcod.json`（无 `idx`、无 `phy`）读得进。

验证台 `.ntnharness/`（vite，照 `.mcharness` 的做法）：真 `BasebandPanel` + 内存 `window.api` 桩，四个场景截图：NR DL 5 MHz MCS7、NR UL 1 PRB TP1 MCS2 ×4 重复、NB DL I_TBS 4、NB UL 单音 3.75 kHz I_TBS 0 ×16；深浅主题、中英；`.gitignore` 与 `.claude/launch.json` 加条目。Electron 预览窗拉不起 IPC（记忆 electron-preview-limits），别在那里验。

---

## 7 分期与提交

- **一期（口径与引擎）**：`ntnPhy.js` 核心 + 镜像 + 测试 1–5；`snr` 口径进 `modcodTables / modcodTable.js`；三引擎 + `linkChain` + `e2eParams` + `linkSweep` 的 `snr` 分支与新出参；测试 6–9。此时内置表还没有 `snr` 行，功能靠测试与验证台夹具驱动。
- **二期（数据）**：`constants.js` 五张 NR 表 + 三张 NB 表（§4.1 / §4.2 / §4.4）+ `meta` + `PHY_OF`；`DVB_STANDARD_OPTIONS`；`ntnLimits.js`；测试 10–11；`docs/官方数据与算法来源.xlsx` 加行（3GPP 表、两篇论文、srsRAN、5G-LENA）。
- **三期（界面与报表）**：两份载波面板；级联；输出列；报表三件 + 参考文献；i18n；SLA；MODCOD 编辑页；验证台；版本说明（写清 §5.5 第 3 条）。

---

## 8 不许做的事

- 不在界面上写任何解释段落；口径全进 `title`。
- 不给结果加「可解调 / 不可解调」一类文字；SNR 余量是数字。
- 不改 DVB 链的任何数字路径；不改 `Settings.vue` 那个 ebno/esno 缺省。
- 不把 5G-LENA 的绝对门限当基线；不把 srsRAN 表当基线（二者只进注释与元数据）。
- 不自动按 BLER 目标折算门限；不自动加小分配修正——两者都是元数据 + 用户改数。
- 不在本任务里做 TR 38.821 的终端/卫星参数预置（§11-5）。

---

## 9 已知诚实边界（写进代码注释与版本说明）

1. 门限基线是 AWGN、SISO、大码块的公开 LLS 拟合值；NTN 实际信道（NTN-TDL/CDL、残余多普勒、功放非线性、1–2 PRB 小分配）会再要 1–3 dB，靠厂家实测表覆盖。
2. 精确 TBS 只算 PDSCH/PUSCH 数据 RE，不含 PDCCH/SSB/CSI-RS 的系统级开销；`oh38306` 模型含这些但是平均值。两者都不含 HARQ 重传与调度间隙。
3. NB-IoT 的门限按 I_TBS 给、与 I_SF/I_RU 无关是近似（大 TBS 略好）；Rel-14 Cat-NB2 的扩展档若核不到原文就先不收。
4. 重复合并按 10lg N 理想值，`combLossDb` 缺省 0。
5. FR2-NTN 的 N_RB 表待核对 TS 38.101-5 Rel-18 原文；核不到就按 TS 38.101-2 同值收并注明。

---

## 10 提交信息要点（每期一条，中文，说根因）

一期：`3GPP NTN 门限改 SNR 口径：噪声带宽=占用带宽 N_RB×12×SCS（每 RE SNR ≡ Es/N₀ ≡ 占用带宽内 C/N，旧链按帧效率 0.9 反推符号率、比厂家口径高 0.50/0.20 dB）；新增 ntnPhy 纯函数（TBS/38.306/NB-IoT RU）；老 esno 行逐位不变`。二、三期同风格。

---

## 11 待拍板（用户未答复即按建议项执行）

1. **NR 内置门限是否重定基线**：A 保留现值只改口径；**B（建议）按 §4.2 基线换数**，现值在注释里留一份并写明「保守 0.6–6.2 dB」。理由：目标是贴近厂家，且厂家表会覆盖；6 dB 的保守量会把 64QAM 档位的容量估计整体压低一档。
2. **NB-IoT 内置门限**：**建议**按 Kodheli 表换数并补 NPUSCH 两张表（现值乐观 0.3–3 dB，方向是危险的那一边）。
3. **NR 速率模型缺省**：**建议 `tbs`（精确 TBS，每时隙）** 作缺省，`oh38306` 作可选——厂家谈的是「n PRB、MCS m 一时隙多少 bit」。DL 缺省 12 符号（留 2 个 PDCCH 符号）、DMRS 12 RE；UL 缺省 14 符号、DMRS 12 RE。
4. **是否加 MCL 出参**（最大耦合损耗，IoT-NTN 厂家最常用的指标：`MCL = P_tx(dBm) − [−174 + 10lg B_occ + NF + SNR_eff]`，天线增益不计；NF 由接收噪温折算）：**建议加**，只对 `snr` 行出、默认不勾选，一列纯数字。
5. **TR 38.821 参考终端/卫星预置**（手持 23 dBm / 0 dBi / NF 7 dB / G/T −31.6 dB/K；VSAT 33 dBm / 43.2 dBi / 39.7 dBi / NF 1.2 dB / G/T 15.9 dB/K；Set-1/Set-2 EIRP 密度与 G/T）：**建议另立任务**，不在本任务里做。
6. **BLER 目标**：**建议**只做表级元数据（10%）+ 用户改数，不做 10%→1% 自动加 0.3–0.5 dB。
7. **π/2-BPSK 的显示名**：平台调制体系记作 `BPSK`；**建议**表行 label 写 `π/2-BPSK`、`modulation` 字段存 `BPSK`。

---

## 12 参考来源

- 3GPP TS 38.214 V17.0.0 §5.1.3.1（MCS 表 1–4）、§5.1.3.2（TBS）、§6.1.4.1（PUSCH 变换预编码表）——本任务书 §4.1 / §4.6 由原文转录。
- 3GPP TS 38.215 §5.1.6 SS-SINR / CSI-SINR（每 RE 定义）：https://www.etsi.org/deliver/etsi_ts/138200_138299/138215/16.02.00_60/ts_138215v160200p.pdf
- 3GPP TS 38.306 §4.1.2 数据速率近似式与 OH 系数：https://atisorg.s3.amazonaws.com/archive/3gpp-documents/Rel16/ATIS.3GPP.38.306.V1610.pdf
- 3GPP TS 38.101-5 NTN 频段与信道带宽（n254/n255/n256；n510/n511/n512）：https://www.sharetechnote.com/html/NTN/NTN_Spectrum.html ；https://itecspec.com/spec/3gpp-38-101-5-5-operating-bands-and-channel-arrangement/
- MathWorks「SNR Definition Used in Link Simulations」：https://www.mathworks.com/help/5g/ug/snr-definition-used-in-link-simulations.html
- MathWorks「NR NTN PDSCH Throughput」（SNR 按 RE）：https://www.mathworks.com/help/satcom/ug/nr-ntn-pdsch-throughput.html
- MathWorks「NB-IoT NTN Link Budget Analysis」（TR 36.763 / 38.821 的 CNR 式、带宽取法、重复折算）：https://www.mathworks.com/help/satcom/ug/nb-iot-ntn-link-budget-analysis.html
- Kodheli, Maturo, Andrenacci, Chatzinotas, Zimmer,《Link budget analysis for satellite-based narrowband IoT systems》, AdHoc-Now 2019：https://orbilu.uni.lu/bitstream/10993/40028/1/AdHocNow2019_final.pdf
- Méndez-Monsanto, MacQuarrie, Rahmani Ghourtani, López Morales, García Armada, Burr,《BLER-SNR Curves for 5G NR MCS under AWGN Channel with Optimum Quantization》, IEEE VTC2024-Fall：https://ieeexplore.ieee.org/document/10757540/ （公开 PDF：https://yo-ran.org/wp-content/uploads/2024/09/BLER-SNR-Curves-for-5G-NR-MCS-under-AWGN-Channel-with-Optimum-Quantization-VTC_Paper.pdf ）
- 《Fluid Antenna System Empowering 5G NR》表 II（CQI ↔ SNR@BLER 0.1）：https://arxiv.org/html/2503.05384
- srsRAN Project `lib/scheduler/support/mcs_calculator.cpp`（UL SNR→MCS 表）：https://raw.githubusercontent.com/srsran/srsRAN_Project/main/lib/scheduler/support/mcs_calculator.cpp
- srsRAN 4G `lib/src/phy/phch/tbs_tables_nbiot.h`、`ra_nbiot.c`（NB-IoT TBS 表、I_MCS→I_TBS、N_rep 表）：https://raw.githubusercontent.com/srsran/srsRAN_4G/master/lib/src/phy/phch/tbs_tables_nbiot.h
- 5G-LENA（CTTC）`nr-eesm-t1.cc / nr-eesm-t2.cc` 与 Lagen 等《New Radio Physical Layer Abstraction for System-Level Simulations of 5G Networks》：https://gitlab.com/cttc-lena/nr ；https://arxiv.org/pdf/2001.10309
- Sormunen 等《Simulative Comparison of DVB-S2X/RCS2 and 3GPP 5G NR NTN Technologies in a GEO Satellite Scenario》（DVB 与 NR 在同一 GEO 链路预算下的对比；NR PUSCH 功控盯 SNR、RCS2 盯 Es/N₀）：https://arxiv.org/pdf/2502.13704
- Amarisoft NR SA NTN / LTE NB NTN 测试手册（gNB 侧 `snr` 读数、HARQ、TA、多普勒配置）：https://tech-academy.amarisoft.com/NR_SA_NTN.html ；https://tech-academy.amarisoft.com/LTE_NB_NTN.html
- Quectel 模组 `AT+QENG` 的 SNR/SINR 读数（参考信号估计）：https://forums.quectel.com/t/understanding-qeng-servingcell-responses-for-rats/10508
