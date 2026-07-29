# NGSO 时变 C/I ：评审结论与改进方案

> **落地状态（2026-07-28）**：一~四期已全部实现，§5 的 ①–⑭ 条验收全部写进
> [interference.test.mjs](../packages/core/test/interference.test.mjs)（该文件 376 项全绿，`npm test` 全绿）。
> 与本文成文时相比有四处**口径修正**，均写在对应小节的「落地说明」里：
>   1. §6 的 S.1528 取数待办**已不成立**——本仓库 `utils/pfdmask/s1528.js` 早已按 ITU-R S.1528 (2001)
>      正文逐段核对实现（三个 recommends 全覆盖、原文 Annex 1/2 算例作 golden test）。
>      `patternsSat.js` 直接复用那一份，一个系数都没有另写。
>   2. §1 B2 说「AP8 分支没有这个问题」——**不准确**。AP8 旁瓣段（29−25lgφ、−10 dBi）是绝对限值，
>      不随 η 变，故 η 在 AP8 分支上仍是杠杆。但那是 RR 定的绝对口径，本就该那么用，故**刻意不改**，
>      只把这件事写进测试锁住。
>   3. §1 A1 说「离轴>40° 星的贡献占比应大幅下降」——只在**指向模型合理**时成立。实测：
>      nadir 47.4%→32.4%、cells(32 波束/200 km) 47.4%→9.1%；但 cells 配到 8 波束/50 km 那种
>      极窄服务区时，占比反而升到 64%（存活的全是近天顶的星）。故结果里同时给出
>      `farSharePct` 与 `farShareNoPatternPct` 两条，外加 `satPatternReductionDb`。
>   4. §P4 的 `criteria` 默认值（−12.2 dB / 6%）**没有预置**：S.1323 原文未核对，
>      UI 上三个门限一律留空，留空即不算越限占比。
>
> `mode:'grd'` 的引擎与服务层已通（`grd.ngsoSampler` + 注入式采样器），并已处理**多波束**：
> 见下方「多波束 GRD 的口径」。尚无实测 GRD 的回归算例（合成 GRD 已验证）。

### 统计层的三处修正（2026-07-29）

四期落地时物理层是对的，**统计层有三处会给出明显错误的数值**，已修。三处的共同点是
「看上去在做统计，实际上算的不是那个量」，且都不报错、图也正常。

| # | 症状 | 根因 | 修法 | 实测 |
|---|---|---|---|---|
| ① | 可用度的中断概率系统性偏低 | 雨衰 CDF 每档整档取**右端点**（档内最小衰减），门限落在档内时整档要么全中断要么全不中断 | 每档按 pct 线性细分 `subBins`（默认 8）份，衰减按 **log10(pct)** 轴插值 | 「A>13 dB 即中断」由 0.001% → 0.00775%，解析真值 0.0075%（原先低估 **7.5 倍**，上限是一整个档宽即 10 倍） |
| ② | 95% 置信区间假窄 | 对合并样本池逐样本 **i.i.d.** 重采样，而池子是若干段连续时序拼的，段内 C/I 高度自相关 | 改按**历元整块**重采样（cluster bootstrap），块数 < 8 打 `lowResolution` | AR(1) φ=0.98 场景：i.i.d. 0.272 dB，块版 0.952 dB，真实散布 2.763 dB |
| ③ | 没收敛却报「已收敛」 | 判据盯**累积池**分位的相邻差，而累积量的相邻差天然 O(1/k) 递减，与各历元差多少无关 | 改盯**逐历元各自独立**估值的散布：其均值的 95% 区间宽度 < tol 才算收敛 | 8 个历元 C/I(1%) 在 30/40 dB 交替（摆 10 dB），旧判据报「第 3 个历元收敛」，新判据正确报未收敛（区间宽 6.9 dB） |

顺带把 `availabilityWithRain` 的内层判定改写成不含 `pow`/`log10` 的等价形式
（`X[k]·K_b < N_b + I[k]·J_b`），无干扰对照那一路再预排序 + 二分：细分 8 倍的同时
**从 428 ms 降到 98.8 ms**。

**两条必须留在结果里的诚实边界**（新增出参，报表须照列）：

- `firstBinTruncatedPct` / `firstBinAttenDb` —— 最严的 (0, p₀] 那一档无法插值（p → 0 时
  A → ∞，而表列不给），只能取表列最大衰减。这是**乐观**边界。
- `epochStats.perEpoch` —— 逐历元各自估出的目标分位。cluster bootstrap 在小块数下本就
  系统性偏窄（nB=8 实测仍窄约 2.9 倍），与其争论哪种区间估计更好，不如把这组原始数摆出来
  让人自己看散布。UI 在块数不足时已强制显示这一行。

**一条测出来的真实限制**（写进测试而不是掩盖）：低分位的区间宽度**不保证**随历元数收窄。
2 h 时窗下每历元只有约 3.6 个样本落在 1% 分位以下，块间散布本身被采样噪声主导
（实测 8 → 24 历元反而 ×1.12，而 10% 档 ×0.72、50% 档 ×0.62 都对上 √n 律）。
**要让尾部的区间也稳，得延长各段时窗（增大每历元的 nEff），光加历元数不够。**

★ 测这件事时子集必须**步进**取（每 m 个取 1）而不是取前 k 个：区间宽度 ∝ σ_块/√块数，
而 σ_块 取决于这批历元覆盖多大的几何跨度。取前 8 个只跨 1.65 天（σ_块 0.186），
全 24 个跨 6.76 天（σ_块 0.287）—— σ_块 的变化正好抵消 √n，收窄就测不出来了。

### 多波束 GRD 的口径（2026-07-28 补）

一份 GRD 常含多个 set。**干扰算的是与受扰载波同频的那一个波束，不是整副天线**——
不同波束照的是不同小区，混在一起取最大等于假设任一波束都可能同频满功率照到本站。

合成算例实测（两波束，峰值差 3 dB，u 向相隔 0.2 ≈ 11.5°，星下点指向，1200 km）：

| 地面点离星下点 | 全部波束取最大 | 仅第 2 波束 | 差 |
|---|---|---|---|
| 0° | 0.00 dB | −3.94 dB | 3.9 dB |
| 4° | −11.64 dB | −29.12 dB | **17.5 dB** |
| 8° | −32.59 dB | −59.20 dB | **26.6 dB** |

处置：`grd.ngsoSampler(file, cfg, beamIndex)` 显式收波束号（原始 GRD set 序号，0 基，
覆盖 `keptSets`），**采样与峰值归一同时跟着走**；不指定即全部取最大，此时
`info.allBeamsMax = true` 并必出告警。UI 在天线含多波束时出现「同频波束」下拉，
未选定时给红色警示块。另：多波束 GRD 与 `pointing:'cells'` 叠加会把波束排布用两遍
（方向图自身已含排布，小区模型又整体重指一次），也已单独告警。

对 v1.3.6 已发版的 `ciNgso` 做的一次算法评审，以及据此定下的改动方案。
被评审的代码：[ciNgso.js](../packages/core/utils/interference/ciNgso.js)、
[patterns.js](../packages/core/utils/interference/patterns.js)、
[interference.js](../electron/services/interference.js) 的星座解析、`src/ci/` 的 UI 与
[interference.test.mjs](../packages/core/test/interference.test.mjs) 第 ⑥⑦ 段。

设计背景见 [干扰分析模块调研.md](干扰分析模块调研.md) §3.4，本文只讲「哪里不严谨、怎么改」。

---

## 0. 一句话结论

**框架是对的，源模型停在半路。**

时域逐时刻扫描 → 排序出 CDF → 报 C/I(p%) + in-line 事件，这正是 ITU-R S.1325 为 NGSO-NGSO
共用规定的做法。防混叠那一套（`requiredStepSec` / 细化重扫 / degenerate 告警）也是对的，
而且做得比多数商业工具诚实。

但干扰源模型缺了**卫星侧天线**：地平线以上的每一颗干扰星，都按其满 EIRP 谱密度计入，
不问它的波束此刻指向哪里。于是本模块算出来的量，准确的说法是

> 「若所有干扰星在任意方向都满功率发射时的聚合 C/I」

——一个有意义的上界包络，但不能不加限定地叫「NGSO C/I」。

### 评审时的实测数（1584 颗 Walker 干扰座 @ 北京站，1.2 m / 12.5 GHz）

这几个数是本次改动的**回归锚点**，改完要能解释每一个数怎么变了、为什么。

```
地平线以上干扰星         89 / 1584 颗
聚合 / 最强单星          6.93 dB
离轴 > 40° 的星贡献      占聚合的 46.5%      ← 真实系统里这些波束照着别的大洲
```

```
6 h / 10 s = 2161 样本
  C/I(0.001%) = 10.90 dB   ← 该分位对应 0.022 个样本
  C/I(0.01%)  = 10.92 dB   ← 该分位对应 0.216 个样本
  C/I(0.1%)   = 11.26 dB
  C/I(50%)    = 40.88 dB
  worst       = 10.89 dB
  → C/I(0.001%) 与 worst 差 0.003 dB：它就是最小值，只是贴了个百分比标签
```

```
起始历元敏感性（同场景，起点相差 0 / 3 / 12 h）
  中位  40.88 / 40.53 / 40.82   ← 稳
  worst 10.89 / 10.64 /  9.70   ← 摆 1.2 dB
  in-line  18 / 16 / 18 次      ← 摆 ±12%
  → 理想 Walker 尚且如此，真实星历（多壳层 + J2 进动）只会更散
```

---

## 1. 问题清单

按「是否改变结论」分级。A 级必改，B 级口径修正，C 级是缺项。

### A 级 · 会改变结论

| 编号 | 问题 | 位置 | 后果 |
|---|---|---|---|
| **A1** | 无卫星侧发射方向图与波束指向 | [ciNgso.js:361](../packages/core/utils/interference/ciNgso.js#L361)（C）、[:384](../packages/core/utils/interference/ciNgso.js#L384)（I） | 聚合干扰高估若干 dB；C 侧忽略波束边缘滚降 |
| **A2** | 分位数超出样本能支撑的分辨率 | `DEFAULT_PCTS` [ciNgso.js:527](../packages/core/utils/interference/ciNgso.js#L527) | 0.001% / 0.01% 两档实为最小值，看起来完全正常的错数 |
| **A3** | 默认「取前 200 颗」静默削 16 dB | [useInterference.js:118](../src/ci/useInterference.js#L118)、`applyLimit` [interference.js:82](../electron/services/interference.js#L82) | Starlink 场景 C/I 偏乐观 ~16 dB |

> ⚠️ A1 与 A3 **方向相反、量级相近**，在默认配置下偶然对消。对上了也是巧合，
> 两条都要改，且不能只改一条——只改 A3 会让结果突然变得极度悲观。

`patterns.js` 里 `gaussianSatBeam` 早就写好了，`ciNgso` 从未调用过它。

### B 级 · 口径不严

| 编号 | 问题 | 位置 |
|---|---|---|
| **B1** | S.1428 的频段适用范围（10.7–30 GHz）没有校验，只检查了 `D/λ ≥ 20` | [patterns.js:117-121](../packages/core/utils/interference/patterns.js#L117) |
| **B2** | 天线效率只作用于 C、不作用于 I | C 用 `gPeak(η)` [:168](../packages/core/utils/interference/ciNgso.js#L168)；I 用 S.1428 绝对增益（基准 `gmaxRef`，与 η 无关） |
| **B3** | 无可见干扰源的样本（`Infinity`）被丢出统计池，p% 的分母成了「有干扰的时间」 | [ciNgso.js:388](../packages/core/utils/interference/ciNgso.js#L388) → [:533](../packages/core/utils/interference/ciNgso.js#L533) |
| **B4** | in-line 判据两处不自洽：`θ < bw3` 把全宽当半径用（4 倍立体角），而 `crossingSec = bw3/rate` 又把它当直径 | [:462](../packages/core/utils/interference/ciNgso.js#L462) / [:122](../packages/core/utils/interference/ciNgso.js#L122) |
| **B5** | 仿真时长与起始历元：默认 6 h、起点取 `Date.now()`，同一算例两次跑不一样 | [useInterference.js:477](../src/ci/useInterference.js#L477) |

**B2 的量化**：η 从 65% 改到 50%，C/I 恰好掉 `10lg(0.65/0.50)` = 1.14 dB，纯粹来自两套增益
基准混用，不是物理。注意 `patternKind:'peak'`（AP8）分支**没有**这个问题——`offAxisAP8` 用了 η，
是自洽的。只有 S.1428 分支坏。

**B4 的正确口径**：工程上 in-line 事件应由**显式规避角**定义（如 ±10°），不是由波束宽度定义。

### C 级 · 缺项

- 无大气 / 雨衰差分：C 与 I 都只扣 FSL。共模部分能对消，但两者仰角不同、雨中衰减不同，
  Ka 频段这一项是几个 dB，且降雨压低 C 而干扰星未必同样被压——那正是最坏工况。
- 无 I/N、无 C/(N+I)、无 ΔT/T。规划口径的干扰判据（S.1323）是 I/N 或 ΔT/T，链路口径要 C/(N+I)。
- 无单源分解：`groups` 只回星数与极化折减，不回各座的 I 贡献。ITU 的单入 / 聚合双门限因此算不出。
- 无时序曲线：[干扰分析模块调研.md](干扰分析模块调研.md) §4 承诺了「C/I 时序曲线 + CDF」，
  `summarize` 只回 400 点分位曲线，`ci[]` 原始时序从未出 IPC。
- 无选星规避：服务星固定取最高仰角。真实系统普遍实现 in-line 规避（S.1431），
  而尾部恰由 in-line 主导——现在报的是**无任何缓解措施**的尾巴。
- `selfSystem` 只排除服务星自身（[:381](../packages/core/utils/interference/ciNgso.js#L381)），
  同座其余星全按满功率同频计入；自系统内部本是频率协调好的。

---

## 2. 与业界做法的对照

| 环节 | ITU / 业界 | v1.3.6 现状 | 判定 |
|---|---|---|---|
| 总体框架 | 时域仿真 → 统计分布（S.1325） | 一致 | ✅ |
| 时间步长 | 按角速度与波束宽定，防漏采 in-line | `requiredStepSec` + 细化重扫 + 告警 | ✅ |
| 地球站方向图 | S.1428（动态多源）；GEO 才用 AP8 峰值 | 一致，且 peak/average 可对比 | ✅ |
| **空间站方向图** | **S.1528 或实测，含指向与波束占空** | **无，满 EIRP 全向** | ❌ A1 |
| 仿真时长 | 与回归周期挂钩，或多历元蒙特卡洛 | 单历元、默认 6 h | ⚠️ B5 |
| 报告量 | I/N、ΔT/T 的 CDF；链路侧 C/(N+I) | 仅 C/I | ⚠️ |
| 监管口径（对 GSO） | EPFD，S.1503 + RR 第 22 条 | 明确不做 | 📋 见 §7 |
| 缓解措施 | in-line 规避 / 分带 / 卫星分集（S.1431） | 无 | ⚠️ 本期不做 |

---

## 3. 改动方案

### P1-A1 · 空间站发射方向图

新增 `packages/core/utils/interference/patternsSat.js`，与地球站的 `patterns.js` 并列。
四种模式，由 `satPattern.mode` 分派：

| mode | 含义 | 何时用 |
|---|---|---|
| `none` | 各向同性满 EIRP（= 现状） | 保留，做上界包络与回归对比 |
| `s1528` | ITU-R S.1528 参考图 | 默认。只有设计参数时 |
| `grd` | GRD 实测方向图 | 有干扰星实测图时（走既有 grdSampler） |
| `gaussian` | 高斯主瓣 + 旁瓣底板 | 兜底，复用 `patterns.gaussianSatBeam`，须标 `approx:true` |

> ⚠️ **S.1528 的系数一律不得凭记忆写**。本仓库既有规矩（见 [patterns.js:186](../packages/core/utils/interference/patterns.js#L186)
> 关于 S.672 的说明、以及 S.1428 / S.524-9 两处「由官方 PDF 逐段核对」的头注）在此同样适用。
> 取数待办见 §6。本方案只定接口与分派逻辑，系数留空待核对后填。

**指向模型**（`satPattern.pointing`）——这是比方向图本身更要紧的一半：

| 取值 | 模型 | 适用 |
|---|---|---|
| `nadir` | 波束固定指星下点 | 固定天线 / 粗估 |
| `cells` | 波束指向地面固定小区网格，每星服务其视场内的若干小区 | 相控阵星座，最接近真实 |
| `worst` | 波束始终指向本站（= 现状的等效） | 上界，保留 |

`cells` 模式的最小实现：给定小区间距与每星同时激活波束数 `beamsPerSat`，
在每个时刻按星下点邻域确定性地选小区（不用随机，保证可复现），
本站落在某激活波束内才按主瓣增益计，否则按该离轴角的旁瓣增益计。

**同频占空**（`satPattern.coFreqFactor`，0–1）：同频复用系数 × 波束时隙占空，
线性乘在每颗星的干扰功率上。这一项工程上常常比方向图更能决定结果，必须显式可填、
且在报表上原样列出，不许藏在默认值里。

**C 侧同步改**：服务星的 EIRP 密度也要过一遍方向图（本站相对服务星波束中心的离轴角），
否则 C 用满功率、I 用滚降后的值，等于给 C/I 白送几个 dB。

### P1-A2 · 分位数样本门禁

`summarize` 对每个分位算有效样本数 `nEff = p/100 × samples`：

- `nEff < 1` → 该档返回 `null`，并附 `support: { nEff, needSamples: Math.ceil(100/p) }`
- `1 ≤ nEff < 10` → 出数但标 `weak: true`，UI 打灰并加注「样本仅 N 个，仅供参考」
- UI 分位表与 CDF 图对 `null` 档显示「样本不足（需 ≥ N 个样本，当前 M）」，不显示数字

配套：`createNgsoCiRun` 在建 run 时就按 `horizonSec / stepSec` 预判，
若用户勾了 0.001% 这类档位而样本量根本够不着，在**算之前**就告警并给出所需时窗 / 步长。

### P1-A3 · 抽样默认值

- `useInterference.js` 里 `limit` 默认由 `200` 改为**留空（全量）**
- 算力由既有的 `estimateNgso` + `NGSO_MAX_WORK` 去拦，拦下时给的建议里
  **把「缩短时窗 / 增大步长」排在「减少干扰星数」前面**——前两者只影响统计分辨率，
  后者直接伪造物理
- 一旦 `samplingFactor > 1`，除现有告警外，把该组所有分位数标 `sampled: true`，
  报表上逐行打标，禁止无标输出

### P2 · B 级口径修正

- **B1**：`offAxisS1428` 增 `freqGHz` 入参，`< 10.7` 或 `> 30` 时返回 `null`
  并由 `earthStationOffAxis` 退回 AP8，同时回一个 `fellBack: true` 供上层告警
- **B2**：S.1428 分支改用**鉴别度**口径 `G(θ) = gPeak − (gmaxRef − gain(θ))`，
  使 η 同时作用于 C 与 I。改完 `η` 不再是 C/I 的杠杆——这条要写成测试
- **B3**：`Infinity` 样本改为计入样本池（用一个远高于任何真实值的哨兵，或改用
  「按秩取分位」的实现直接吃 `Infinity`）。改完 `samples + noServing === T` 恒成立，
  把现有那条测试从「恰好成立」升级为**不变式**
- **B4**：统一为**规避角** `inlineGuardDeg`（用户可填，默认 = `bw3 / 2` 即半功率半角），
  `crossingSec = 2 × inlineGuardDeg / rate`。两处同源，不再各算各的
- **B5**：见 P3

### P3 · 仿真时长与多历元

两条腿，UI 上二选一：

**① 回归周期驱动（`epochs.mode = 'repeat'`）**
估算星座相对本站的几何回归周期 `T_rep`：
- Walker / 圆轨道：由轨道周期与地球自转周期（含 J2 交点进动）求近似最小公倍数
- 真实星历：取各壳层的 `T_rep` 取最大，封顶（比如 7 天）并告警

时窗默认取 `min(T_rep, 上限)`，并在结果里明确写出「本次覆盖了回归周期的百分之多少」。

**② 多历元蒙特卡洛（`epochs.mode = 'monte-carlo'`，推荐做默认）**
在一条长基线（默认 7 天）上随机抽 `M` 个起始历元（`seed` 可填，保证可复现），
每个跑一段短窗，**样本池合并**成一条 CDF。相比单历元长跑的好处：
- 同样的算力覆盖到更分散的几何，尾部估计更稳
- 天然能给**置信区间**：对目标分位做 bootstrap，回 `ci95Lo / ci95Hi`
- 可做**收敛判据**：逐个加历元，直到目标分位的估计变化 < 0.2 dB 连续两次，即停

结果里新增 `epochStats: { mode, count, spanDays, seed, converged, ciP: { p: {mean, lo, hi} } }`。
UI 在 KPI 卡上把 C/I(0.1%) 显示成 `11.3 dB ±0.6`——**有误差棒的数才是能报送的数**。

> `startMs` 一律由调用方给（引擎不碰 `Date.now()`，这条现有规矩保持）。
> 蒙特卡洛的历元由渲染端按 `seed` 生成后逐个传入，引擎侧只管合并样本池。

### P4 · 报告量补全

**新增入参**
```js
noise: { tSysK }            // 或 { gOverTdBK, diameterM } 反推；优先接地球站配置库的天线噪温自动模式
criteria: { iOverNDb: -12.2, deltaTOverTPct: 6 }   // 门限，可填；默认值须在 UI 上标明出处
```

**新增出参**
```js
// 逐分位，与 percentiles 同结构
iOverN:      { p: dB },     // I/N
cOverNI:     { p: dB },     // C/(N+I)
deltaTOverT: { p: % },      // ΔT/T
// 单源分解（聚合 / 单入双口径）
perGroup: [{ id, name, iAggDbW, sharePct, worstSingleEntryDbW, worstAtMs }],
// 时序（抽稀到 ~2000 点，够画图不撑爆 IPC）
series: [{ tMs, ciDb, iOverNDb, servingElevDeg, minThetaDeg }],
// 门限越限统计
breach: { ciPct, iOverNPct, deltaTPct }
```

**可用度损失**（本期的落点，也是用户真正要问的那个问题）：
把干扰 CDF 与雨衰 CDF 做**卷积**（两者物理独立 ⇒ 卷积，不是相加，也不是各报各的），
出一条 C/(N+I) 的可用度曲线，并给出

> 「无干扰时可用度 99.7%，计入干扰后 99.4%，需补 1.8 dB 余量」

平台两条分布都现成（雨衰走 P.618 那套），缺的只是合成这一步。
⚠️ 合成结果必须与「纯几何 p%」分开陈列，`ciNgso` 头注里那条
「两者物理独立，不能相加」的告诫依然有效——卷积不违反它，相加才违反。

**UI**：新增时序曲线组件（`CiSeriesPlot.vue`），与 CDF 图并排；
分位表加 I/N、C/(N+I)、ΔT/T 三列；单源分解做成贡献条形图（口径同 C/ASI 页的「谁是主犯」）。

---

## 4. 数据结构变更汇总

```js
createNgsoCiRun({
  // ── 现有，不变 ──────────────────────────────────────
  station, rx, wanted, interferers, minElevDeg,
  startMs, horizonSec, stepSec, patternKind, applyPolarization,

  // ── 新增 ────────────────────────────────────────────
  satPattern: {                       // P1-A1
    mode: 'none'|'s1528'|'grd'|'gaussian',
    pointing: 'nadir'|'cells'|'worst',
    beamsPerSat, cellSpacingKm,       // pointing='cells' 时
    coFreqFactor,                     // 0–1，同频复用 × 时隙占空
    peakGainDbi, beamwidth3dBDeg      // s1528/gaussian 的入参
  },
  noise: { tSysK },                   // P4
  criteria: { iOverNDb, deltaTOverTPct },
  inlineGuardDeg,                     // P2-B4，默认 bw3/2
  seriesMaxPoints                     // P4，默认 2000
})
```

出参在现有基础上加 §P4 那一组，另加 `percentiles` 每档的 `support`（§P1-A2）。

**兼容性**：`satPattern` 缺省时走 `mode:'none'`（= v1.3.6 行为），
旧的持久化面板态能原样读回，只是会在结果上多一条「未计入卫星方向图，结果为上界」的告警。

---

## 5. 分期与验收

| 期 | 内容 | 验收（写进 interference.test.mjs） | 状态 |
|---|---|---|---|
| **一** | A2 + A3 + B1 + B2 + B3 | ①`nEff<1` 的分位返回 null 且带 `needSamples`；②`η` 变化不再改变 C/I（S.1428 分支）；③`samples + noServing === T` 成为不变式（构造无干扰星可见的算例）；④C 频段 3 m 天线走 S.1428 时 `fellBack === true` | ✅ |
| **二** | A1 空间站方向图 + B4 | ⑤`mode:'none'` 与 v1.3.6 逐位一致（回归锁）；⑥`mode:'s1528'` + `pointing:'cells'` 的聚合 I 显著低于 `'worst'`，且「离轴>40° 星的贡献占比」由 46.5% 大幅下降；⑦`coFreqFactor` 线性：0.5 → I 恰好 −3.01 dB；⑧规避角改动后 in-line 次数与占时比的变化方向可解释 | ✅ ⑤改锁「缺省 ≡ none ≡ pointing:worst 三者逐位一致」（一期的 B2/B3 已刻意改过数，与 v1.3.6 的绝对值本就不该再相等） |
| **三** | P3 多历元 + 回归周期 | ⑨同 `seed` 两次跑逐位一致；⑩历元数 ↑ → 目标分位的 95% 区间单调收窄；⑪收敛判据能在合成算例上触发 | ✅ |
| **四** | P4 报告量 + UI | ⑫I/N 与 C/I 的差恒为 `C − N`（同一时刻）；⑬`perGroup` 的 `sharePct` 求和 = 100%；⑭卷积后的可用度 ≤ 无干扰可用度 | ✅ ⑫改成逐样本核（**不同分位来自不同时刻，把两个分位相加没有意义**），锁 `C/(N+I) ≤ min(C/I, C/N)` |

一期改完先发一版——它修的是**会出错数**的路径，优先级高于任何新功能。

### 一期改完的基线位移（同一算例，2 h / 20 s，北京 1.2 m @ 12.5 GHz）

改的是**会出错数**的路径，所以数必然要动，这里记下动了多少，便于对上旧结果：

| 量 | 改前 | 改后 | 为什么 |
|---|---|---|---|
| C/I(0.001%) / (0.01%) / (0.1%) | 有数 | **样本不足，不出数** | A2：361 个样本撑不起这几档 |
| η 65% → 50% 时 C/I 的变化 | −1.14 dB | **0.00 dB** | B2：S.1428 改鉴别度口径，η 在 C 与 I 上对消 |
| `samples + noServing === T` | 恰好成立 | **不变式** | B3：+∞ 样本回到池子里 |
| in-line 判定阈值 | θ < 3 dB 全宽 | **θ < 规避角（默认半宽）** | B4：判定与时长同源；穿越时长逐位不变 |

---

## 6. 取数待办（不凭记忆写系数）

动手前必须先拿到并逐段核对的官方文本。**在拿到之前，相关系数一律留空，不许先填个大概值**：

| 建议书 | 要取什么 | 用在哪 | 落地状态 |
|---|---|---|---|
| **ITU-R S.1528** | NGSO 空间站参考方向图的分段与全部系数；确认版本号与适用频段（<30 GHz FSS） | P1-A1 `patternsSat.js` | ✅ **本仓库已有**：`utils/pfdmask/s1528.js` 按原文逐段核对（§1.2 / §1.3 / §1.4 三个 recommends 全实现，Annex 1/2 算例作 golden test，含两处原文问题的处置说明）。`patternsSat.js` 直接复用，未另写系数 |
| **ITU-R S.1325** | 仿真时间步长与**仿真时长**的规定；统计量的推荐表达方式 | P3 的回归周期判据要对得上 | ✅ 已核对 `R-REC-S.1325-3-200310-I` 正文：§2.7.3 的四步法照抄进 `constellationRepeatPeriodSec`；§2.7.2 的地固系角速度矢量差写进 `maxAngularRateDegPerSec`；§2.7.2 的 Nhits ≥ 5 与本模块 `requiredStepSec(…, 5)` 恰好一致 |
| **ITU-R S.1323** | ΔT/T 与 I/N 的门限数值、单入 / 聚合的分配比例 | P4 `criteria` 的默认值与出处标注 | ⛔ **未核对** → 三个门限在 UI 上一律**留空**，留空即不算越限占比。软件不预置一个数当结论 |
| **ITU-R S.1428** | 复核适用频段 10.7–30 GHz 的原文表述 | B1 的边界条件 | ✅ `patterns.js` 头注原已注明「由 ITU 官方 PDF 正文逐段核对（2001-02 版）」，频段边界据此写死为 10.7–30 GHz |

现有 `patterns.js` 里 S.1428-1 与 S.524-9 两处的头注是逐段核对过的范例，新写的照那个格式记录出处。

### S.1325-3 §2.7.3 的一处刻意不改

Step 3 的判据原文写作 `mod(Δφⱼ, 2π) ≤ ΔPT`。而 mod 落在 `2π − ΔPT` 那一侧（星下点从另一边差同样多）
在物理上是同一件事，照原文实现会给出**更长**的回归周期。对「该跑多久」这个用途来说偏长即偏保守，
且与建议书一致，故不擅自改成对称判据——要对称口径的调用方显式传 `symmetric:true`。

---

## 7. 明确不做的事

- **EPFD**：对 GSO 的保护必须走 S.1503 + RR 第 22 条，与本模块的 C/I 是两回事。
  已单独设计，见该模块的方案文档（2026-07-23 暂停）。
  ⚠️ UI 上要直说一句：**本页的 C/I 是自用的系统设计量，不能用于协调报送**。
- **in-line 规避策略**（S.1431 的切星 / 分带）：本期只报「无缓解措施」的尾巴。
  等 P3 的统计口径稳下来再做，否则无法判断规避到底改善了多少。
- **C/ACI 与 C/IM**：见 [index.js](../packages/core/utils/interference/index.js) 头注，
  它们不满足「与参考带宽无关」的前提，本模块不碰。

---

## 8. 改动涉及的文件

```
packages/core/utils/interference/patternsSat.js   新增：S.1528 / GRD / 高斯 + 指向模型
packages/core/utils/interference/patterns.js      B1 频段校验、B2 鉴别度口径
packages/core/utils/interference/ciNgso.js        主战场：A1 接入、A2 门禁、B3、B4、P3、P4
electron/services/interference.js                 A3 默认值、新报告量透传、多历元编排
src/ci/useInterference.js                         默认值、satPattern / noise / epochs 面板态
src/ci/CiApp.vue                                  新输入区（卫星天线 / 噪声 / 历元）+ 新报告区
src/ci/CiSeriesPlot.vue                           新增：C/I 时序曲线
src/ci/CiCdfPlot.vue                              分位表加列、样本不足档的显示
packages/core/test/interference.test.mjs          §5 的 ⑫ 条验收
```

### 实际落地时多动的几处（成文时没预见到）

```
packages/core/utils/grdSampler.js                 新增 peakDb()：GRD 相对滚降要减的那个峰值，
                                                  必须与采样值同口径（同 pol 组合、同 gainOffset）
electron/services/grd.js                          新增 ngsoSampler()：NGSO 星在动，天线基底每时刻都变，
                                                  但 .grdbin 的载入只该做一次
electron/ipc/register.js                          createInterference 多收一个 grd（GRD 采样器要在主进程现建，
                                                  函数过不了结构化克隆，payload 里只有文件名）
```

### 落地时踩到的三个坑

1. **`percentileWorst` 遇 +∞ 会出 NaN**。B3 把「无干扰源可见」的样本放回池子后，
   `∞ + (∞−∞)·f` 直接是 NaN。改成两端只要有一个非有限就取更差的一侧（不插值）。
2. **多历元忘了合并 C/I 之外的东西**。`summarizeMerged` 一开始只并了 `ci[]`，
   于是 I/N、C/(N+I)、可用度、单源分解全都只拿到第一个历元的数——不报错，只是数不对。
   现在 `cDbArr/iDbArr/servingElev/minTheta/groups` 一并合并，另加 `blocks` 记住每段的起始时刻
   （否则时序曲线会把所有样本按第一个历元的起点排）。
3. **「无雨」那一档的噪温写 0 而不是 null**，会让「分布里有没有带噪温」永远判真，
   于是没带噪温的分布也被当成带了，噪声抬升被静默按 0 计而不是如实报「未计入」。
