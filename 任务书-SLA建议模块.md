# 任务书 · 链路预算「SLA 建议」模块

> 交给 Opus 执行。仓库：卫星仿真平台（Electron + Vue 3），`C:\Users\85256\WeChatProjects\卫星仿真平台`，基线 main @ 0eae217（v1.4.3）。
> 2026-09-05 由 Fable 5.1 按四个链路预算窗口的现状分析拟定。§10「待拍板」若用户未另行答复，一律按其中的建议项执行。

---

## 0 执行守则（先读）

1. 先读仓库根 `CLAUDE.md`：**界面上不写解释性/教学性文字**（口径说明只放 `title`，空态只留一句陈述）；**结果输出纯数字**（禁「达标 / 合格 / 受限 / 满足」一类文字判定；数值着色与报错诊断保留）。这两条是用户反复强调过的，违反即返工。
2. 本任务书 §2 的现状分析已逐文件核实过（含行号），**不必重查**；行号可能随改动漂几行，按符号名定位。
3. 直接在 main 上做，按 §8 分三期落地；每期 `npm run build` 与 `npm test` 全绿再进下一期。提交信息沿用仓库风格（中文，说清根因与口径），末尾附 `Co-Authored-By: Claude <noreply@anthropic.com>`。
4. 不许为了省事收窄功能；确实做不完的部分在最后如实列出，不要静默略过。
5. 与用户沟通一律中文。

---

## 1 目标

在四个链路预算窗口（GSO `src/linkbudget/`、NGSO `src/ngso/`、再生式 `src/regen/`、端到端 `src/e2e/`）各加一个**「SLA 建议」分区**：

1. 按当前这条链路的计算结果，给出五类 SLA 条款的**建议值**：可用度 / 带宽与速率 / 时延与丢包 / 故障响应与恢复 / 发射合规（运营商反过来约束客户的那一条）；
2. 工程师可逐条填写**采用值**覆盖建议（留空 = 采用建议值）；
3. 逐条勾选**入报告**；交付级报告（Excel / Word / PDF 三份）据此多出「SLA 建议」一节；导出对话框再给一个总开关「含 SLA 建议」。

---

## 2 现状分析（已核实，勿重查）

### 2.1 四窗骨架完全同构

| | GSO | NGSO | 再生式 | 端到端 |
|---|---|---|---|---|
| App | `src/linkbudget/LinkBudgetApp.vue` | `src/ngso/NgsoLinkBudgetApp.vue` | `src/regen/RegenLinkBudgetApp.vue` | `src/e2e/E2eLinkBudgetApp.vue` |
| orbitType / 配置 ns / storeKey | `GEO` / `geo` / `linkbudget` | `NGSO` / `ngso` / `ngso` | `REGEN`（`linkMode` 四模式 uplink / downlink / isl / laser）/ `regen` / `regen` | `E2E` / `e2e` / `e2e` |
| 分节 `<LbSection>`（滚动面 `.lbx-flow`） | `sat` → `links` → `detail`（行 1659 / 1703 / 1735） | `sat` → `links` → `detail`（1950 / 1967 / 1999） | `tx`∣`rx`∣`isl`∣`laser`（按模式 v-if）→ `detail`（2082） | `links` → `chain` → `detail`（1285 / 1334 / 1445） |
| 结果 | `links.value[i] = { i, rowId, txName, rxName, data, ok, error, resolvedMargin }`；`sel = links[selected]`，详细预算跟 `sel` 走 | 同左，另带 `geom` | 同左，按 `linkMode` 各一批 | `results[row._id]` / `errors[row._id]`；当前链 `cur` / `curIdx` / `curResult` |
| 送引擎的入参留底 | `sweepParamsByRow.value[rowId] = { satParams, linkParams, opt }`（`compute()` 里 `sweepStore`，行 ~930） | 同左；`linkParams` 是最差候选 `worstLp`（含注入几何与 §8 片段），行 1085–1240 | 同左，三处 `sweepStore[...]`（1142 / 1187 / 1255）；激光 `opt: { visibilityPct }` | 无留底；链描述子由 `buildChain(row, { es, sat })`（`src/e2e/e2eParams.js`）现组，`api.linkBudget.chainCompute(chain)`（行 ~770–790） |
| 场景存档 | `serializeState()` → `{ v: 3, rows: [行的非 `_` 键], satId }`；`applyState()` 重建行并**重发 `_id`**；`fingerprintOf()` 决定「未保存」小灯；`blankState()` | 同 | 同（另有 `linkMode` 等） | `chains[]`（含 `nodes` / `hops`） |
| `ok` 判据（compute 内现成） | 设置余量方式：功率/带宽占用 ≤ 100 %；其余方式：`linkmargin ≥ 0` | 同 | 同 | 端到端余量 `e2eMarginResult ≥ 0` |
| 报告接线 | `useLbReport({...})` 行 1444；`<LbReportDialog>` 行 1768 | 1719 / 2125 | 1711 / 2268 | 857 / 1469（`paramsFor: () => null`，恒无图） |
| 库 / MODCOD | `resolveBaseband(row.basebandId).form`；`basebandOpts.value = api.linkBudget.baseband()` → `{ modulation, fec, dvbStandards, modcod: { [std]: rows[] } }` | 同 | 同 | 体制在节点上 `node.carrier`（链首那份贯穿） |

### 2.2 报告链路：一份模型，三份文件

`src/shared/useLbReport.js run()` → `src/shared/lbReport.js buildReportModel()`（`doc` 元信息 / `links[]{ no, txName, rxName, data, inputs, figures, … }` / `t = labelBundle(lang)` 标签包 / `method` 方法学）→ IPC `report:exportReport`（`electron/ipc/register.js:1108`：主进程补 `segments`，`report.enrichReportModel()` 补 `summary`）→

- Excel `electron/services/report.js`：`buildMasterSheet`（行 1229：§1 逐参数对照 / §2 容量与统计 / §3 计算模型与参考 / 详情索引）+ 逐链路 `writeReportLinkSheet`（行 1422：输入参数 → 详细计算结果 → 图件）；
- Word `electron/services/reportDocx.js`：`masterTablesSection`（§1）/ `masterTailSection`（§2、§3，行 320）/ `detailSection`（行 358）；
- PDF `src/report/ReportApp.vue`（隐藏窗 + `printToPDF`；`tblNo` / `toc` 计算属性；整窗 `data-i18n-skip`，**语汇必须随模型带进来**）。
- 对话框 `src/components/LbReportDialog.vue`：`opt = { xlsx, docx, pdf, figures }`，`persist()` 存 `<storeKey>/report/opt`，`submit()` 发 `{ doc, formats, withFigures }`。
- 版式口径：全篇三线表、宋体/黑体/TNR、表题在表上方、无底纹无竖线、纯数字（`electron/services/reportStyle.js`）。

### 2.3 引擎已经出了 SLA 需要的几乎全部数字（出参全是字符串数）

| SLA 条款 | 已有出参 / 入参 | 备注 |
|---|---|---|
| 可用度 | 入参 `uplinkAvailability`（发信站列）、`rxDownlinkAvailability`（收信站列）；出参 `uplinkAvailabilityResult` `downlinkAvailabilityResult` `systemAvailabilityResult`（%）、`interruptionMinutes` `interruptionHours` | GSO/NGSO 系统可用度 = 上下行之积（`packages/core/utils/linkCalculator.js:388`）；再生式上行模式 = 上行、下行模式 = 下行（`linkCalculatorRegen.js:105 / 281`）、星间 = 互视占比（:544）、激光为空；端到端 = 各星地跳站址可用度之积（`linkChain.js:780`），逐跳 `hops[].availabilityResult` |
| 时延 | `linkDelayResult`（单程 ms）；NGSO 另有 `linkDelayUpResult` / `linkDelayDownResult`；星间 `islDelayResult`（UI `mergeIslGeometry` 注入）；端到端 `e2eDelayResult` `propDelayResult` `procDelayResult` | RTT 引擎不出，`waterfallBuilder.js:713` 就地 ×2 |
| 带宽 / 速率 | `infoRateResult`（kbps）`symbolRateResult`（ksps）`allocBandwidthResult`（载波带宽 kHz）`PowerBWResult`（功率带宽 kHz）`transponderBandwidthResult`（MHz）`bandwidthUsageRatio` `powerUsageRatio` `spectralEfficiencyResult`；容量 = η×B 由各窗前端派生 | 「结算带宽 = max(载波带宽, 功率带宽)」没有现成出参；端到端逐透明星 `transponders[]{ carrierBandwidthResult, powerRatioResult, transponderBandwidthResult }` |
| 丢包 | 入参 `ber`（10⁻ⁿ 的 n）；出参 `berResult`（'1×10⁻⁷'）；端到端 `e2eBerResult`（各段之和） | 平台刻意不建 BER–C/N 曲线，丢包只能由设计 BER 给上界 |
| 发射合规 | `uplinkFrequencyResult`（GHz）`uplinkPolarizationResult`（V/H/L/R）`allocBandwidthResult` `stationEIRPResult`（dBW）`stationPSDResult`（dBW/Hz）`arrivalPFDAtSatelliteResult` `effectiveXpolUplinkFactorResult`；频率计划核对 `src/shared/lbFreqPlanRef.js checkAgainstChannel(plan, no, { occBwMHz, fcMHz, polUp, polDn })` 已返回数值化的 `bwOver / outOfBand / polUp / polDn`（GSO 卫星条目 `grd.fpId / fpNo`，`src/linkbudget/SatellitePanel.vue:78`） | 端到端引擎没有「发信站 EIRP / PSD」独立出参（级联算式行里有权威值，见 §7.3） |
| MIR（ACM 峰值） | 载波表单 `dvbStandard / modcodLabel / noiseRatioMode / ebno / fec / rsCode / bandwidthFactor / m`；MODCOD 表行 `{ label, modulation, fec, rsCode, bandwidthFactor, noiseRatioMode, threshold }`；Eb/N₀⇄Es/N₀ 关系 `linkCalculator.js:397–408`（`k = fec·rs·log2M / m`，`esno = ebno + 10lg k`）；调制因子 `src/shared/carrierRate.js modFactorOf()`；晴空 = 可用度填 100 %（引擎 p = 0 即晴天，`linkCalculator.js:535–573`） | 现有 `sweepLink`（`packages/core/utils/linkSweep.js:281`）有 `_availability` 合成轴（上下行同调）与「钉住工作点」`_pinnedOpt`（:244），但只支持等距采样、两侧只能写同一个值 |

### 2.4 缺口（本任务要补的）

1. 没有「SLA 条款」这一层：建议值、采用值、入报告勾选、SLA 参数都不存在。
2. 引擎没有「按给定可用度档位逐档重算」的入口（等距扫描不合用；两侧要按比例缩放）。
3. 报告模型与三个渲染器没有 SLA 节；对话框没有开关。
4. 端到端引擎缺链首发信站 EIRP / PSD 出参。

---

## 3 口径决策（每条建议值怎么来、依据写什么、诚实边界在哪）

通用规则：**建议值只从「本行真正送进引擎的那份入参」与引擎出参推导**（`sweepParamsByRow[rowId]` + `links[i].data`），不读表单当前值——用户算完又改了表单时，建议必须对应算出这组结果的那些数（与报告输入清单同一原则）。链路计算失败或 `ok === false` 的行：依据列照给数字并标红，建议值留空。

### 3.1 可用度

- **口径**：SLA 承诺的是端到端可用度 = 引擎 `systemAvailabilityResult`（上下行之积），不是单侧输入列。两侧各填 99.90 时系统只有 99.80——这正是 SLA 最常踩的坑，模块要把它摆在明处：依据列写 `99.90 × 99.90 = 99.80`。
- **建议值** = 系统可用度**向下**取标准档 `AVAIL_TIERS = [99, 99.5, 99.7, 99.8, 99.9, 99.95, 99.99]`（%）；低于 99 % 留空。
- **配套行「年中断时长上限」** = (100 − 采用可用度)/100 × 365.25 × 24 × 60 min（与引擎 `interruptionMinutes` 同式）；采用值改了要跟着变。
- **档位扫描**（分区右下小表，§5.3）：对每一档 S，把当前上下行不可用度**按比例同步缩放**使系统可用度恰为 S：
  a = (100 − up)/100，b = (100 − dn)/100，s = S/100，解 (1 − a·k)(1 − b·k) = s 的小根
  k = [(a + b) − √((a + b)² − 4ab(1 − s))] / (2ab)（ab = 0 时 k = (1 − s)/(a + b)），up′ = 100 − 100·a·k，dn′ = 100 − 100·b·k。
  这样保住工程师配的上下行分配（关口站带 UPC 给高、远端给低）。单侧体制（再生式上行/下行）直接 up′ = S 或 dn′ = S。逐档**钉住当前工作点**重算（§7.1），表列：档位 / 上行·下行设计可用度 / 上行·下行雨衰 / 链路余量 / 功率占用 / 带宽占用 / 年中断。余量 ≥ 0 的最高档整行加粗（数字加粗是视觉辅助，不是文字判定）。
- 星间微波：可用度 = 互视占比，建议值 = 它向下取档，不扫描；激光：本项整组不出。
- 端到端：系统可用度 = 星地跳站址可用度之积；扫描时对链上**全部地球站节点**的 `availability` 按同一 k 缩放（星间跳不参与）。
- 诚实边界：扫描钉的是设计点解出来的工作点（与地理场图同口径），回答的是「这套硬件在档 X 还剩多少余量」，不替用户重解功放。

### 3.2 带宽与速率

- **结算带宽（转发器带宽承诺）** = max(载波带宽 `allocBandwidthResult`, 功率带宽 `PowerBWResult`)，kHz；依据列并列写两者。再生式没有功率带宽 → 取载波带宽。端到端：**逐透明星一行**（`transponders[]`：载波带宽 `carrierBandwidthResult`，功率带宽 = `powerRatioResult`/100 × `transponderBandwidthResult` × 1000），**不合成链级数**（用户否决过「链级占比」这类编出来的指标）。
- **CIR** = `infoRateResult`（kbps）——在采用可用度下、余量 ≥ 0 时可承诺的信息速率。不取整。
- **MIR（ACM 峰值）**：只在载波 `dvbStandard !== 'custom'` 时给：晴空样本（两侧可用度 100 %，钉住工作点）取 `esnoActualResult`；在该标准的 MODCOD 表里选满足 `Es/N₀_th(i) + 系统余量 ≤ 晴空 Es/N₀` 的**最高效率档 i**（表行门限若是 Eb/N₀，用引擎同一式 `esno = ebno + 10lg(fec·rs·log2M/m)` 换算；效率 = log2M·fec·rs），MIR = 符号率 `symbolRateResult` × log2M_i × fec_i × rs_i（符号率不变 ⇔ 载波带宽不变）。系统余量取 `links[i].resolvedMargin`（全精度）。依据列：晴空 Es/N₀、当前 MODCOD 名 → 选中 MODCOD 名。`custom`、或选不出更高档 → MIR = CIR。端到端：MIR = CIR（逐段体制可不同，不做 ACM 外推）。
- 诚实边界：MIR 假定 ACM 在同一符号率内切档、且保留同样的系统余量；MODCOD 门限取自用户当前的表（可编辑库）。

### 3.3 时延与丢包

- **单程时延** = `linkDelayResult`（NGSO 已是最差几何即上限；端到端 = `e2eDelayResult`，已含再生处理时延）。
- **往返时延上限（RTT）建议** = ⌈(2 × 单程 + 2 × 处理时延预留) / 10⌉ × 10 ms；「处理时延预留」是 SLA 参数（缺省 20 ms/端，调制解调与封装）。依据列写 `2 × 119.6 + 2 × 20`。再生式上行/下行模式只出「本段单程时延」，RTT 建议留空由工程师填；星间/激光出 `islDelayResult` 单程。
- **丢包率上限建议** = 1 − (1 − 10⁻ⁿ)^(8·L)，n = 载波 `ber`，L = SLA 参数「报文长度」（缺省 1500 B）；端到端 n 由 `e2eBerResult`（字符串）解析。结果**向上**取档 `LOSS_TIERS = [0.001, 0.01, 0.05, 0.1, 0.5, 1]`（%），超过 1 % 原值。依据列写 `10⁻⁷ × 12000 bit`。
- 诚实边界：丢包是门限工况下的上界，不是预测；时延不含地面段与排队。

### 3.4 故障响应与恢复

- 纯合同条款，无计算依据（依据列 `—`）。建议值 = 缺省 30 min / 4 h（进 `DEFAULT_SLA_PARAMS`），工程师在采用值里改。**不做金银铜套餐**。

### 3.5 发射合规（运营商约束客户）

只在有客户发射端的体制/模式出：GSO、NGSO、再生式上行、端到端链首上行跳；再生式下行/星间/激光整组不出。

- **上行中心频率**：`uplinkFrequencyResult` GHz → 以 MHz 显示（4 位小数）；卫星条目引用了频率计划时，依据列附转发器频带 f1–f2 MHz（`checkAgainstChannel` 返回的 `nums`）。
- **载波占用带宽**：`allocBandwidthResult` kHz；依据列 `fc ± B/2`；频率计划核对结果（`bwOver` / `outOfBand`）以**数值**给（超出量 MHz），不写「越界」二字。
- **最大 EIRP**：`stationEIRPResult` + EIRP 容差（SLA 参数，缺省 +1.0 dB），dBW。
- **最大功率谱密度**：`stationPSDResult` + 36.02 → dBW/4 kHz（运营商与 ITU 惯用参考带宽），再加同一容差；依据列同时给 dBW/Hz 原值。
- **极化**：`uplinkPolarizationResult` 文本原样（V/H/L/R 是数据，不是判定）；**极化隔离度下限** = SLA 参数（缺省 30 dB）；频率计划极化不一致（`polUp`）时依据列写计划极化。
- 端到端：频率/极化/带宽取 `data.hops[0]`（type 'up'）；EIRP/PSD 用 §7.3 新出参。
- 诚实边界：容差、隔离度是可改缺省，`title` 写「按运营商入网要求填」；代码里**不给任何建议书编号背书**这些数。

---

## 4 架构与落点

### 4.1 新增文件

| 文件 | 职责 |
|---|---|
| `src/shared/lbSla.js` | **纯逻辑，四窗共用，零框架依赖**（Node 测试直接 import，同 `lbCustomCols.js` 的做法）：常量 `SLA_GROUPS / SLA_ITEMS（含 label / labelEn / unit / kind）/ AVAIL_TIERS / LOSS_TIERS / DEFAULT_SLA_PARAMS`；`splitUnavailability(up, dn, S)`；`tierPlan(ctx)` → 扫描样本；`packetLossPct(n, bytes)`；`pickMir(ctx)`；`deriveSla(ctx)` → `{ items: { [key]: { basis: [{ label, value, unit }], suggest, unit, text?, bad? } }, scanRows }`；`slaRows(derived, rowSla, params)` → 面板行；`slaReportBlock(derived, rowSla, params, lang, fmt)` → 报告块或 null；`snapDown / snapUp` |
| `src/components/LbSlaPane.vue` | 四窗共用 UI（§5） |
| `packages/core/utils/linkSweep.js` 新增 `scanSlaTiers(spec)` | 复用 `_solver / _pinnedOpt / _quiet / _precise / _invisible`（§7.1）；`module.exports` 加；`packages/core/index.js` 透出 |
| `electron/ipc/register.js` + `electron/preload.js` | IPC `link:slaScan`（单）/ `link:slaScanBatch`（批）；`api.linkBudget.slaScan / slaScanBatch` |
| `packages/core/test/lbSla.test.mjs`、`packages/core/test/slaScan.test.mjs` | §7.2 / §7.4；`package.json` 的 `test` 串追加两条 |
| `.slaharness/`（vite 验证台） | `LbSlaPane` 挂 fixtures（四体制各一份 data + scan），深浅主题、中英；`.gitignore` 加条目（照既有注释格式）、`.claude/launch.json` 加 `sla-harness` |

### 4.2 数据模型

- **行级（随链路行存，进场景 / 分享包 / 复制粘贴）**：`row.sla = { adopt: { [itemKey]: string }, include: { [itemKey]: boolean } }`。`include` 缺省全 true（缺键即 true）；`adopt` 只存用户填过的键。
  ★ 不能按 `rowId` 建 Map 存进 state：`applyState()` 会重发 `_id`。挂在行上，`serializeState` 的「非 `_` 键全存」自然带走，`fingerprintOf` 自然计入（SLA 改动 = 场景改动，该亮「未保存」），分享包 v3 深拷贝 state 自然带走，**格式不用升级**。
  ★ `StationGrid.vue` 的 `addRow / insertRowsAt`（行 457 / 1226）与复制粘贴走的是字段级 setter，先确认它们不会把 `row.sla` 这个对象引用在两行之间共享；若有 `{ ...row }` 一类浅拷贝复制整行，复制件要 `sla` 深拷贝或删掉。端到端 `chains[]` 同理（`row.sla`）。
- **场景级**：`state.slaParams = { pktBytes: 1500, procMsPerEnd: 20, eirpTolDb: 1, xpdMinDb: 30, respondMin: 30, restoreH: 4 }`：`serializeState / applyState / blankState` 三处 + `fingerprintOf` 计入；旧场景缺省补齐（四窗各一份，键名一致）。
- **会话态（不入存档）**：`slaScanByRow.value[rowId] = { pin, rows, message }`，`compute()` 成功后一次批量 IPC 求得；随 `resultsStale` 一起过期；切「单位」档不重扫。
- **报告**：`model.links[i].sla = { rows: [{ key, group, groupLabel, label, basis, suggest, adopt, unit }] }`（只含 `include` 为真的行，标签已按 lang 翻好，`basis` 是一行纯数字串），`model.slaParams`，`model.hasSla`。

### 4.3 各窗接线（同一份适配器思路，四窗各写一小段）

```js
// 送给 lbSla.deriveSla 的上下文（GSO 为例；NGSO/再生式同形；端到端见备注）
const slaCtxOf = (l) => ({
  orbitType: 'GEO', regenMode: '',
  data: l.data, ok: l.ok, error: l.error, resolvedMargin: l.resolvedMargin,
  params: sweepParamsByRow.value[l.rowId] || null,          // linkParams.uplinkAvailability / rxDownlinkAvailability / margin
  carrierForm: resolveBaseband(row.basebandId).form,        // dvbStandard / ber / noiseRatioMode / m ...
  modcodRows: (basebandOpts.value.modcod || {})[form.dvbStandard] || [],
  scan: slaScanByRow.value[l.rowId] || null,
  fp: fpCheckOf(l),                                          // GSO：卫星条目 grd.fpId/fpNo 有值时 checkAgainstChannel(...)，否则 null
  slaParams: slaParams,                                      // 场景级 reactive
  rowSla: row.sla
})
```

- 端到端：`data` 为链结果（`systemAvailabilityResult / e2eDelayResult / e2eBerResult / infoRateResult / transponders[] / hops[]`），`carrierForm` 取链首节点 `node.carrier`，`params` 为 null（可用度从 `hops[].availabilityResult` 与节点上读）。
- 再生式：按 `linkMode` 给 `regenMode`，`deriveSla` 内部据此决定哪些条款出、哪一侧可用度可缩放。
- `compute()` 末尾（`links.value = out` 之后）：组 `specs`（每条成功链路一份 `{ engine, satParams, linkParams, opt, samples }`，端到端为 `{ engine: 'chain', chain, samples }`），`api.linkBudget.slaScanBatch(specs)` → 写 `slaScanByRow`。★ 出 IPC 前 `JSON.parse(JSON.stringify(...))`，Vue Proxy 过不了结构化克隆且无 catch 时全静默。
- 引擎名：GSO `'geo'`、NGSO `'ngso'`、再生式上行 `'regen-up'` / 下行 `'regen-down'`（星间、激光不扫），端到端 `'chain'`。

---

## 5 界面

### 5.1 位置与骨架

- 每窗在「详细预算」之后加 `<LbSection id="sla" title="SLA 建议" :summary="...">`；summary 例：`#2 北京 → 上海 · 99.8 % · 2.048 Mbps`（有结果时）。跟 `sel`（端到端跟 `cur`）走，与详细预算同一条链路。
- 空态一句：「尚无 SLA 建议。」；选中链路计算失败时沿用详细预算那句「计算失败：…」。
- 节头动作（`#actions` 插槽）：「全部入报告 / 全不入」切换、「清除采用值」。**不加功能区按钮**。
- 分区内排版沿用 `.lbx-doc` 那套（衬线 `--lb-serif`、字号 `--lb-fs`、`tabular-nums`）：
  - **左：SLA 条款三线表**。列：条款 | 计算依据 | 建议值 | 采用值 | 单位 | 入报告。五个组用组头行（工艺对齐 `WaterfallTable.vue` 的 `wf-title` / `k-sub`：加粗 + 发丝线，无底纹）。
  - **右上：SLA 参数条**（`.lbx-kv` 读数风格但可编辑）：报文长度 B · 处理时延预留 ms/端 · EIRP 容差 dB · 极化隔离度 dB。
  - **右下：可用度档位扫描表**（§3.1）；无扫描的体制/模式不渲染该块；扫描未就绪时该块空着（不写「扫描中」以外的说明）。
- 采用值格用 `src/components/NumBox.vue`（`:model-value` + `@commit`，见 `LbAdvBalanceDialog.vue:224` 用法），占位符 = 建议值，空 = 采用建议；极化这种文本项用普通 `<input>`。入报告 = 复选框（沿用 `styles/controls.css` 自绘复选框）。
- 样式落 `src/styles/lbworkbench.css`，前缀 `.lbx-sla*`（scoped 盖不到子组件，四窗共用）；深浅主题都过一遍，颜色只用 token（`--danger` / `--text-*` / `--lb-rule*`）。

### 5.2 着色（纯数值辅助，允许）

采用值比建议更激进 → 该格 `st-bad`：可用度采用值 > 扫描中余量 ≥ 0 的最高档；CIR 采用 > 信息速率；MIR 采用 > MIR 建议；RTT 采用 < 计算 RTT；丢包采用 < 换算值；EIRP / PSD 采用 > 建议；结算带宽采用 < 建议。链路不成立时依据列的余量 / 占用标红。**不在任何地方出现判定文字。**

### 5.3 档位扫描表

列：档位 % | 上行 % | 下行 % | 上行雨衰 dB | 下行雨衰 dB | 链路余量 dB | 功率占用 % | 带宽占用 % | 年中断 min。余量 < 0 的格标红，余量 ≥ 0 的最高档整行加粗；晴空样本不列进这张表（它只喂 MIR）。表头 `title` 写「逐档钉住当前工作点重算：功放 = 设计点解出的 X W」（数值来自扫描返回的 `pin`）。

### 5.4 单位与格式

速率 / 带宽走 `src/shared/adaptUnits.js fmtQty()`（缺省锁定档，与结果列同口径；报告端走 `model.adaptUnits`）；dB 两位小数；可用度 2–3 位（99.95）；分钟取整；频率 MHz 四位小数。依据列**只含数字、单位与运算符**（`99.90 × 99.90 = 99.80`、`2 × 119.6 + 2 × 20`），不含汉字——避免生成串漏译。

### 5.5 i18n

- 新增界面串补进 `src/shared/i18n/uiDict.data.js`（EXACT）；条款 label 在 `SLA_ITEMS` 里带 `labelEn`，报告模型按 lang 直接取。术语：Availability / Annual outage / Settled bandwidth / Committed Information Rate (CIR) / Maximum Information Rate (MIR) / One-way delay / Round-trip delay / Packet loss / Response time / Restoration time / Transmit compliance / Centre frequency / Occupied bandwidth / Maximum EIRP / Maximum PSD / Polarisation / Polarisation isolation。
- 跑 `node scripts/i18n-scan.mjs --misses` 与 `--leaks`，两关都要干净；`title` 里的三元串扫描器扫不到，手工查一遍。
- 报告窗口 `data-i18n-skip`，SLA 节的每个标签都要在模型里带翻好的字。

---

## 6 报告

### 6.1 模型与对话框

- `useLbReport` 注入项加 `slaFor: (l) => block | null`（各窗用 `slaReportBlock(...)` 出纯数据）与 `slaParams: () => ({...})`；`run()` 在 `opts.withSla` 为真时把 `sla` 挂到每条链路、`model.hasSla = links.some(l => l.sla)`。
- `buildReportModel` 透传 `slaParams`、`hasSla`；`labelBundle` 加 `sla: t('SLA 建议')`、`slaTerm: t('条款')`、`slaBasis: t('计算依据')`、`slaSuggest: t('建议值')`、`slaAdopt: t('采用值')`；`LB_REPORT_EN` 补译。
- `LbReportDialog.vue`：`opt.sla`（缺省 true，进 `persist()`）；新增 prop `slaCount`（有入报告条款的链路数），为 0 时该复选框置灰（同 `figures` 之于 `vizAvailable`）；`submit()` 带 `withSla`。四窗模板传 `:sla-count`。

### 6.2 三个渲染器

- **Excel** `report.js`：`buildMasterSheet` 在 §3 之后、详情索引之前加 **「4　SLA 建议」**：矩阵表 条款（含单位）× 链路（采用值，空则建议值），`tableCap` 连续编号；`writeReportLinkSheet` 在「详细计算结果」之后、「图件」之前加块「SLA 建议」：条款 / 计算依据 / 建议值 / 采用值 / 单位 五列三线表（表号按「链路序号-块序号」）。
- **Word** `reportDocx.js`：`masterTailSection` 加 §4 同矩阵（`docTable`，`keyRows` 分组行换黑体不加粗）；`detailSection` 每链路同五列表。
- **PDF** `ReportApp.vue`：总报告纵向页加 §4；`toc` 加「4 SLA 建议」；`tblNo` 加 `sla`；详情页级联表之后加块。
- 三处都以 `model.hasSla` 门控：没有任何链路带 sla 就整节不出、目录不列、表号不占。
- 全篇纯数字：矩阵与明细里不出现「达标 / 满足」；`slaParams` 以一行参数表附在 §4 末（报文长度 / 处理时延预留 / 容差 / 隔离度）。

---

## 7 引擎扩展与测试

### 7.1 `scanSlaTiers(spec)`（`packages/core/utils/linkSweep.js`）

```
spec = {
  engine: 'geo' | 'ngso' | 'regen-up' | 'regen-down' | 'chain',
  satParams, linkParams, opt,            // 三窗：与 sweepLink 同一份留底
  chain,                                  // 端到端：buildChain 出的链描述子
  samples: [{ tag: '99.9', up: '99.95', dn: '99.95' }, …, { tag: 'clear', up: '100', dn: '100' }],   // 三窗
  samples: [{ tag: '99.9', k: 0.5 }, …],  // chain：对全部 kind==='es' 节点 availability ← 100 − (100 − a)·k
  keys                                    // 可选，默认 ALL_OUTPUT_KEYS ∪ 可用度组
}
→ { pin, rows: [{ tag, up, dn, ok, message, data: { linkmargin, powerUsageRatio, bandwidthUsageRatio,
     uplinkRainAttenuation, downlinkRainAttenuationResult, systemAvailabilityResult, interruptionMinutes,
     esnoActualResult, ebnoActualResult, paRecommendation, symbolRateResult, … } }], message }
```

- 三窗引擎：`_pinnedOpt` 钉工作点（与地理场图同口径，常态 `{ kind: 'pa', powerW }`，再生下行 `{ kind: 'gt' }`）；逐样本复制 `linkParams`，写 `uplinkAvailability` / `rxDownlinkAvailability`（`regen-up` 只写上行、`regen-down` 只写下行）；`_quiet(() => _precise(() => solve(...)))`；`_invisible` 的样本 `ok: false` 不抛。
- `chain`：`require('./linkChain.js').computeLinkChain`，逐样本深拷贝链、缩放地球站节点 `availability`，取 `systemAvailabilityResult / e2eMarginResult / interruptionMinutes / hops[].rainResult`；chain 不钉工作点（正向递推本无自由变量）。
- 样本数封顶 `MAX_STEPS`；返回纯数据。`register.js` 新 `link:slaScan` / `link:slaScanBatch`（批量照 `link:computeModeBatch` 的写法，逐条 try/catch），`preload.js` 对应两条。

### 7.2 `lbSla.test.mjs`（ESM，照 `lbAutoName.test.mjs` 的 ok/pass 计数风格）

1. `splitUnavailability`：up = dn = 99.9 → S = 99.9 时两侧 ≈ 99.95（√ 关系）；up 99.99 / dn 99.9 → 比例 1:10 保持；ab = 0 退化分支；k 单调；S = 100 → 两侧 100。
2. `snapDown([...AVAIL_TIERS], 99.8001) = 99.8`、`98.9 → null`；`snapUp(LOSS_TIERS, 0.12) = 0.5`、`1.3 → 1.3`。
3. `packetLossPct(7, 1500)` ≈ 0.1199 %；n 缺省 / 非法 → null。
4. RTT：单程 119.6、预留 20 → 290 ms（⌈279.2/10⌉×10）。
5. `pickMir`：给一张 DVB-S2 表片段、晴空 Es/N₀ 与余量，选出的档满足门限 + 余量 ≤ 晴空且效率最高；Eb/N₀ 口径的表行换算与 `linkCalculator.js:397–408` 同式（用 QPSK 3/4、188/204、m = 1 手算对拍）；`custom` → MIR = CIR；晴空缺失 → MIR = CIR。
6. `deriveSla`：GSO 真引擎算例（`require('../utils/modeSolver.js').computeLinkMode` 默认参数）→ 可用度建议 = 99.8、结算带宽 = max(两带宽)、CIR = infoRateResult、合规四项存在；`ok: false` 时建议留空、依据 `bad`；再生式下行 / 星间 / 激光不出合规组；端到端 `transponders` 两颗 → 带宽两行且无链级合成行。
7. `slaRows` / `slaReportBlock`：`include` 缺键 = true；全不勾 → block 为 null；`adopt` 空 → 报告写建议值；lang = 'en' 时 label 为 `labelEn`。
8. 端到端 `e2eBerResult` 字符串（'1×10⁻⁷' 或指数形式）解析。

### 7.3 端到端引擎补出参

`linkChain.js`：链首为地球站的上行跳补 `hops[0].stationEirpResult`（= 级联里 EIRP 的权威值，即那条 `sub` 行取的数）与 `stationPsdResult`（= EIRP − 10lg(B_Hz)，B 取该段载波带宽）。纯回显，不改任何计算；`linkChain.test.js` 加断言：与级联 EIRP 行逐位相等。

### 7.4 `slaScan.test.mjs`

GSO 默认算例 7 档 + 晴空：`pin.powerW` = 设计点 `paRecommendation`（±1e-6 W）；余量随档位单调不增；晴空余量 ≥ 设计点余量；每样本 up·dn/100 = 档位（±1e-6）；`regen-up` 样本只改上行键；`chain` 缩放后 `systemAvailabilityResult` = 档位（±1e-5）；负仰角样本 `ok: false` 且整批不抛；`link:slaScanBatch` 逐条隔离（一条抛错不连累其余）。

---

## 8 分期与验收

**P1 — 面板与存档（先让人看见）**：`lbSla.js`（暂不含扫描与 MIR，MIR = CIR）+ `LbSlaPane.vue` + 四窗接线（分区 / `row.sla` / `slaParams` / 指纹）+ `lbSla.test.mjs`。验收：四窗分区就位、中英文、深浅主题；改采用值亮「未保存」灯，保存重开值仍在；分享码往返 `row.sla` 不丢；`npm run build` / `npm test` 绿。
**P2 — 扫描与 MIR**：`scanSlaTiers` + IPC + 批量接线 + 扫描表 + MIR + §7.3 出参 + 两组测试。验收：GSO 默认算例扫描 8 样本 < 50 ms；NGSO 12 行批量扫描不卡；再生式四模式各自只出该出的组；端到端 k 缩放正确。
**P3 — 报告与验证台**：三渲染器 + 对话框开关 + i18n 两关 + `.slaharness/`；`.rpharness/model.mjs` 的 `makeModel()` 加 sla 块，跑 `node .rpharness/check.mjs` 出三份文件核对：三线表、黑体分组行、表号连续、目录含 §4、无判定文字、`hasSla` 为假时整节消失。

验收清单（逐条可勾）：
- [ ] 界面无任何解释性文字段；所有口径只在 `title`
- [ ] 结果区无任何文字判定；着色只按 §5.2
- [ ] `row.sla` / `slaParams` 进场景、进指纹、进分享包；`_id` 重发后仍对得上
- [ ] 建议值全部来自留底入参 + 引擎出参，表单改动不影响已出建议（`resultsStale` 时与结果一同标「输入已变」）
- [ ] 再生式下行 / 星间 / 激光无合规组；激光无可用度组；端到端带宽逐透明星
- [ ] MIR 只在选了 MODCOD 标准时 ≠ CIR
- [ ] 三份报告 SLA 节一致；对话框开关置灰逻辑正确；英文报告标签全英文
- [ ] `npm run build`、`npm test`、`node scripts/i18n-scan.mjs --misses` / `--leaks` 全绿
- [ ] 提交前 `git diff --stat` 里没有误改 `WaterfallTable.vue` 两份镜像与 `uiDict.data.js` 之外的词典文件

---

## 9 红线（做错要返工的）

1. 纯数字、不写说明文字、空态一句——见 §0。
2. **建议值不写回三库（地球站 / 卫星 / 载波），不改链路行的可用度输入**：SLA 是「这组场景的结论」，改设计由工程师自己去改表；采用值只存 `row.sla`。
3. 出 IPC 前深拷贝成纯数据；扫描结果、派生建议不进存档。
4. 不改 `orbitType` 存储键；不动 `src/linkbudget/WaterfallTable.vue` 与 `src/ngso/WaterfallTable.vue` 两份镜像；不重开「报表语言」下拉（报表语言 = 平台语言）。
5. 删带 `v-if` 的元素时检查后面的 `v-else / v-else-if` 链；模板指令别整串替换。
6. 不加新的顶部页签、不加功能区按钮；分区放 `.lbx-flow` 里，样式进 `lbworkbench.css`。
7. 数值输入一律 `NumBox`（数字输入框「打到一半跳回原值」是已知陷阱）。
8. 单位显示走 `fmtQty`（缺省锁定档）；报告端走 `model.adaptUnits`；级联算式类的 dB 值不换单位。
9. 不编造标准数值：极化隔离度 / 容差 / 响应 / 恢复只是可改缺省，`title` 写「按运营商入网要求填」；不在代码里引某建议书编号为这些数背书。
10. 明确不做：SLA 套餐（金银铜）、抖动、可用度月度折算、罚则 / 赔付计算、把 SLA 值送小程序、分享包格式升级（`row.sla` 随行自然带走，v3 不变）、用扫描去重解功放。

---

## 10 待拍板（用户未答复即按建议执行）

1. **可用度口径**取端到端系统可用度（两侧之积）、建议向下取档；档位扫描按当前上下行不可用度**比例**缩放。→ 建议采纳。备选：按单侧输入列取档（简单但会把 99.80 的链路写成 99.9 承诺）。
2. **MIR** 仅在选了 MODCOD 标准（非「自定义」）时按 ACM 给，否则 = CIR。→ 建议采纳。
3. **存储**：采用值存链路行 `row.sla`、SLA 参数场景级；都不入资源库。→ 建议采纳。
4. **报告位置**：总报告 §4「SLA 建议」矩阵 + 逐链路详情五列表 + 对话框「含 SLA 建议」开关。→ 建议采纳。备选：插成 §3 并把「计算模型与参考」顺延为 §4（三处渲染器与目录一起改号，风险略高）。
5. **缺省值**：处理时延预留 20 ms/端、报文 1500 B、EIRP / PSD 容差 +1.0 dB、极化隔离度 30 dB、响应 30 min、恢复 4 h。→ 只是缺省，随时可改。
6. **档位表**：可用度 [99, 99.5, 99.7, 99.8, 99.9, 99.95, 99.99] %，丢包 [0.001, 0.01, 0.05, 0.1, 0.5, 1] %。

---

## 11 定案与改动（2026-09-05，用户拍板后执行）

原 §5.1「分区放 `.lbx-flow` 里、不加功能区按钮」与 §10 的四项待拍板，用户答复后作废/改写如下。以下为**现行口径**，与代码一致。

1. **弹窗式，不是分区**。四窗功能区「导出」组各加一颗 **SLA** 按钮 → `src/components/LbSlaDialog.vue`（壳层照 `LbReportDialog`，宽 `min(1120px, 94vw)`）。`LbSlaPane` 原样搬进弹窗正文。
   - 弹窗头部自带**链路下拉**（`slaIdx`），与链路表的聚焦行（`selected` / `curIdx`）分开走：填 SLA 不该把详细预算与图表一起拽到别的链路上；打开时对齐到当前聚焦行，此后各走各的。重算后条数变少即回落第一条；再生式换子链路归零。
   - 端到端的下拉只列**算过**的链（有结果或有报错）。
2. **「报文长度」改名「IP 包长」**，缺省仍 1500 B。它只干一件事：把设计误码率换算成丢包率（`1 − (1 − 10⁻ⁿ)^(8L)`）。与北斗短报文无关，也与轨道/体制无关 —— 包长是应用层的事，1500 B 只是以太网 MTU。物联短包业务应按实际值改小（20 B 与 1500 B 差 75 倍）。
3. **可用度构成**（本次新增的实质内容）。引擎的 `systemAvailabilityResult` 只是**传播可用度**（雨衰统计），默认设备永不故障、卫星永不倒换、地面回传永不断。现在按连乘补齐：
   `A_总 = A_传播 × A_发端站 × A_收端站 × A_空间段 ×（A_地面段）`
   - 四项都是**场景级 SLA 参数**（不进三库）：`esTxAvail / esRxAvail / spaceAvail / groundAvail`，**缺省 99.99 %**（2026-09-05 用户改定，原拟 99.9）；`groundOn`（0/1，缺省 0）是地面段的勾选闸 —— 只卖空间段不勾，卖网络服务才勾。★ 值一律是数不是布尔：`normSlaParams` 逐键走 `num()`。
   - 填 **100 即该项不计入**（依据列里也不出现这个因子）。一项都不计入时不出「传播可用度」那一行（同一个数不印两遍）。
   - 各体制计入哪几格由 `equipSlots()` 定：GSO/NGSO = 发端站·收端站·空间段；再生上行 = 发端站·空间段；下行 = 收端站·空间段；星间 = 空间段×2；激光整组不出；端到端 = 链首按发端站、其余地球站（含中间转接站）按收端站、卫星逐颗计空间段（窗口传 `esCount` / `satCount`）。
   - 条款表因此多一行只读的**传播可用度**（`kind: 'ro'`，无采用值格）；**系统可用度**的建议值 = 综合值向下取档，依据列写整条连乘。**年中断**跟综合走。
   - **档位扫描表**的「档位」列仍是**传播域**（扫描能动的只有雨衰那一份），故新增一列**综合** = 档位 × 连乘系数，年中断也按综合算；着色参照（最高可行档）同样折算后再比。列头 `title` 写明这个关系。
   - 诚实边界：连乘假定各环节独立；两类中断性质不同（雨衰＝多次短中断，设备故障＝少次长中断），后者由「故障响应 / 恢复」两条条款单独约束。
4. **用词**：「入报告」→ 列头「**列入**」（`title` 写「列入报告」）；两颗动作钮 → 「**全部列入 / 全部不列入**」「**重置**」。
   ★ **报告里那一节不叫「SLA 建议」，叫「服务等级指标（SLA）」**（EN `Service Level Metrics (SLA)`）：「建议」是工作台里的说法 —— 工具算出建议、工程师可改；印进交付文档的是已定稿的指标，再写「建议」既贬低了它、读起来也像软件在替甲方拿主意。三个渲染器的章标题、表题注、PDF 目录都取 `labelBundle.sla` 这一个口，改一处即全改；导出对话框的开关随之改叫「含服务等级指标」。工作台那一侧（功能区按钮、弹窗抬头）**仍叫 SLA 建议**，那里「建议」是实情。
   ★「重置」两件事一起做：本条链路的**采用值清空** + **SLA 参数回缺省**。参数是场景级的，但它只在这个弹窗里露面，另设一颗按钮反而找不着 —— 用户第一次试用时按了「重置为建议值」发现参数没回去，报的就是「重置按钮没用」。
5. **字体走界面字体**：`.lbx-sla*` 与弹窗壳层一律 `var(--font-ui)`（设置 → 界面字体），不吃 `--lb-serif`。判据是「会不会进交付文档」—— 详细预算那张级联表是报告正文的屏上预览，故跟报告走衬线；SLA 弹窗是填条款的**界面**。字号仍吃 `--lb-fs`（功能区「字号」）。★ 组件根不再挂 `.lbx-doc`（那条会把衬线栈带进来），布局在 `.lbx-sla` 自己写全。
6. **版式**（弹窗里量出来的）：条款表与参数轨并排、可用度档位表整幅独占一行（十列数塞进右轨会与条款表叠在一起）；依据列按整块折行（连乘串会把 nowrap 的表撑出容器）；采用值格 8.4em（6.6em 会把 `1777.838` 截成 `1777.`）且**不再拿建议值当占位符**（相邻两列印同一个数）；参数轨只列本体制用得上的那几项。
7. **保存失败（本次修掉的硬伤）**：`row.sla` 是嵌套对象，三窗 `serializeState` 从响应式行上浅拷出来的是 Vue 的 Proxy，**结构化克隆过不了** → `saveConfig` 走 IPC 当场抛「保存失败：…」。修法：行序列化时 `applyRowSla(o, o.sla)` 落成纯数据（端到端本来就 `JSON.parse(JSON.stringify(...))`，不受影响）。

---

## 12 2026-09-05 第三轮（用户实测后）

1. **导出对话框**：一条条款都没勾（`slaCount === 0`）时，「含服务等级指标（SLA）」**整项不出现**（原来是留一个点不动的灰选项）；名字带上 **SLA** 简称 —— 报告章节名叫「服务等级指标」是对的，但工程师口头都说 SLA，选项里不带简称找不着。三个渲染器仍以 `model.hasSla` 门控，一条都没勾时整节连同章号、表号、目录条目一起消失。
2. **Word 报告的目录改成静态排版**（`reportDocx.js` 的 `tocSection` / `tocItems`）。原来用的是 Word 的 `TableOfContents` 域 —— 域在文档打开时是**空的**，要用户自己右键「更新域」才填得出来，没人会去点，交付出去就是一整页空白。现在逐条对应正文里真正出现的 H1 / H2（章号跳号也照抄：没有容量统计时正文本就是 1、3、4），不给页码（生成时不知道分页，写一个错的页码比不写更糟）。连带去掉 `features.updateFields`（文档里已无域，留着只会每次打开弹一次「是否更新域」）与那句「右键目录 → 更新域」的说明。样式新增 `RptToc1` / `RptToc2` 两级。
3. `.rpharness/check.mjs` 加了两条断言：文档里没有 `<w:instrText>`（＝没有域，目录是排出来的）、`hasSla` 为假时目录里也没有那一条。

---

## 13 2026-09-06 审查修正定案（一句一条）

算法口径（第一期，提交 1–3）：

1. **丢包率分两支**：选了编码标准（DVB-S2/S2X/RCS2、3GPP NTN）走帧差错 `p = 1 − (1 − 10⁻ⁿ)^N_f`，`N_f = ⌈8L / K⌉`；未选标准（`custom`）保留原来的比特独立随机误码 `1 − (1 − 10⁻ⁿ)^(8L)`。
2. **一帧净荷 K**：DVB 家族取正常 FECFRAME `64800 × FEC 码率`（不扣 BCH 冗余，误差 < 0.5 %），3GPP NTN 取传输块大小 TBS；依据列只写 `N_f`，不写 K。
3. **帧差错率 `ferExp` 是场景级参数**，缺省 7（＝ QEF，ETSI EN 302 307-1 §4.1）；实测 1500 B 包在 DVB-S2 下 `N_f = 1`，丢包 1.00e-5 % → 取档 0.001 %（原随机模型给 0.5 %）。
4. **新增只读条款「设计误码率」**：原样带出载波配置里那个 `10⁻ⁿ`（端到端取链级 BER 串），依据「—」；组名随之由「时延与丢包」改「时延与差错」。
5. **丢包只在可用时间内考核**，中断时段不计入该项统计（写在 `tip` 与报告的定义表里）。
6. **最大 EIRP / PSD = 晴空值 + UPC 余量 + 容差**；UPC 余量取 `UPCmarginResult`（端到端取链首上行跳的 `upcMarginResult`），为 0 或取不到时那一项不写。
7. **处理时延预留改「ms/单程」口径**（发端调制 + 收端解调），RTT 依据写 `⌈2 × (单程 + 预留) / 10⌉ × 10` —— 与原「每端 × 2」的式子恒等，改口径不改数。
8. **星间微波与激光同口径**：两者的 `systemAvailabilityResult` 都是几何互视占比，一律出只读条款「互视可用度」（`visAvail`），系统可用度 = 互视 × 卫星与载荷 × 2；手动几何（引擎给空串）整组仍不出。
9. **端到端中间转接站计两条射频链**：发信射频 ×(站数−1)、收信射频 ×(站数−1)；两站链与旧口径逐位相同，三站链多乘一次。
10. **同站回环取 min**：发信站与收信站坐标完全相同（|Δlat|、|Δlon| < 1e-6）时传播可用度 = `min(上行, 下行)`，不取乘积；引擎那份 `systemAvailabilityResult` 不动。
11. **可用度档补 98 / 98.5**；仍够不着最低档时建议值向下取到 0.1 %（不再留空）。档位扫描样本随之 9 档 + 晴空。
12. **考核周期 `monthly`（0/1，缺省 0 ＝年平均）**：置 1 时传播那一份先按 ITU-R P.841 折到最坏月 `100 − ((100 − A)/0.30)^(1/1.15)`，**再**乘设备因子；设备可用度是长期平均、星间互视是几何量，两者都不折算。
13. **端到端的月口径先乘完各星地跳再整体折一次**（P.841 是对单站降雨统计的经验式，逐跳折算再相乘会把保守叠两次）；依据列因此只出现一次折算式。
14. **月口径下条款改名**：「系统可用度（月）」「月中断时长上限」，中断分母换成 43830 min（= 525960 / 12）；档位表的「档位」列仍是引擎的年口径，「综合」列与中断列跟着周期走。
15. **日凌列为免责事件**：新增组「免责事件」与只读条款「日凌预计中断」（春秋两季合计 min），不参与连乘、不进中断预算；**只对 GSO 出**。判据 C/N 恶化 ≥ 1 dB，入参取收信站经纬度 / 口径 / 下行频率 / 系统噪温 + 卫星轨位；惰性计算（弹窗打开时才算）、按入参哈希缓存到会话态、重算即作废。
16. **新增合同条款「时延抖动」**（`jitterMs`，缺省 30 ms，依据「—」）。
17. **参数轨末尾加一行读数「隐含年故障次数上限」**：`(1 − 设备连乘系数) × 525960 ÷ (恢复时间 × 60)`，设备一项都不计入时不出。
18. **依据列署名补齐**：端到端单程时延写「传播 + 星上处理」，RTT 里那个处理写「地面处理」——两者是不同的量。
19. **措辞**：CIR 的 `tip` 改「设计可用度下、余量 ≥ 0 时的信息速率」；PSD 的 `tip` 补「参考带宽 4 kHz、按分配带宽算」。
20. **依据列新增「粘住右邻」的片**（`PG`）：左括号不再与后一片之间多一个空格（`min(上行 …`）。

独立《服务等级指标（SLA）》报告（第二期，提交 4–7）：

21. **先抽 `electron/services/reportDocxKit.js`**（零行为改动，抽取前后 `out.docx` 的 `word/document.xml` 与 `word/styles.xml` 逐字节相同）：样式表、三线表、图与页眉页脚、封面、目录、表号。唯一签名改动是 `tocSection(model, items)` —— 目录条目改由调用方传入。
22. **模型在 `src/shared/lbSlaReport.js`**（渲染端组装、纯数据）：不取图、不组瀑布、不带输入清单；`kind: 'sla'`，`hasSla` 为假时主进程直接拒。
23. **条款定义表只列这份报告里真出现过的条款**，五栏（指标 / 定义 / 计算式 / 考核周期 / 依据）；计算式与依据列同一套符号；没有出处的合同条款留「—」，不编标准编号。
24. **引用标准只列真用到的**：传播那几项恒有，月口径才加 P.841，有 DVB 链路才加 EN 302 307，有 NTN 才加 3GPP，末尾 S.579 / S.1062 两条口径基准。
25. **免责事件的三条合同惯例条款只列名不编数**（经双方确认的计划维护 / 不可抗力 / 客户侧设备与操作原因）；日凌另给预计窗口。
26. **报告名叫《…服务等级指标（SLA）》**，与全报告 §4 的章名一致；端到端叫《端到端链路服务等级指标（SLA）》。
27. **对话框共用一个壳**：`LbReportDialog` 加 `variant`（`'full' | 'sla'`）；元信息（编号 / 密级 / 单位 / logo）与全报告共用同一存储键，只有标题的自动命名各存一份。
28. **这一份不出 PDF**：对话框不给这个选项，主进程再拒一道。
29. **默认文件名**：`GEO_SLA_<卫星>` / `GEO服务等级指标_<卫星>`（NGSO / REGEN / E2E 各自前缀）。
30. **版式与链路预算报告完全同一套**：Word 走 `reportDocxKit`，Excel 走 `report.js` 新导出的表格件（只加导出、实现一个字不动）；表头居中、数据行左/右对齐、题注跨整幅、`autofitBook` 之后再 `placeLogo`。
31. **验证台**：`.rpharness/sla.mjs`（22 项，含英文版全文无汉字 + 跑一遍 `check.mjs` 回归）、`.rpharness/slaExport.cjs`（真 Electron 走 preload → IPC → 写盘，另验 PDF 与空模型被拒）。
32. **`docs/官方数据与算法来源.xlsx` 补四行**：P.841-6 / EN 302 307-1·-2 / S.579-6 / S.1062-4。
