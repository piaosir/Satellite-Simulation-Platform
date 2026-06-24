# GRD 导入与覆盖可视化设计（阶段 1 · SATSOFT 对标）

> 目标：实现 SATSOFT 风格的「导入 GRD → 设置 → 实时等值线」覆盖可视化。
> 地球几何全程 WGS84（见 [src/viz/wgs84.js](../src/viz/wgs84.js)）；解析口径见 GRD格式解析说明.txt。
> 权威参照：SATSOFT 3.2 手册 §4（坐标系/投影）、§7（boresight）、§11（等值线）。

---

## 0. 用户工作流（按你的描述）

1. **从星历选卫星**：用户在星座/星历里选一颗 GEO 卫星。
2. **匹配**：我用 GEO 卫星清单 ↔ TLE/OMM 星历对应到具体那颗（按名称/NORAD/星下点经度；
   GRD 文本头自带星下点经度，如 110.5°E，可辅助匹配到 GEO 槽位）。
3. **预置默认数据**：把你给的每颗卫星的 GRD（EIRP 一份、G/T 一份，可多波束）转换成平台格式，
   存进数据库作为**默认数据**。与 SATSOFT 一致：EIRP、G/T 即卫星上的**天线对象**，命名为 EIRP / G-T。
4. **用户可改可加**：用户也能自行「添加天线（备注）→ 导入 GRD」，得到自定义天线/波束。
5. **导入后设置（本设计核心）**：导入 GRD 后进入与 SATSOFT 一致的设置阶段（见 §3）。

---

## 1. 关键架构决策：静态等值线 vs 原始场实时重算

现状（已实现）：`resources/coverage/<卫星>/<波束>_{EIRP,GT}.json` 存的是**烘焙好的等值线折线**
`{sat,band,beam,type,lon,bore,contours:[{g, p:[[lon,lat]...]}]}` + `index.json`。
等值电平(gains)、颜色由 UI 批次配置。**但折线是离线一次性算死的**——换星下点/增益偏置/路径损耗
都无法实时反映。

SATSOFT 的「导入后可设置增益值、星下点等且实时更新」要求保留**原始场网格**，显示时实时重算：

| 方案 | 存什么 | 导入后能实时改 | 代价 |
|---|---|---|---|
| A 静态折线（现状） | 等值线折线 | 仅显隐/颜色；增益偏置≈整体平移标签 | 轻，渲染即现状 |
| **B 原始场 +实时重算（推荐，SATSOFT 对标）** | dB 场网格 + 网格几何 + 天线指向 | 星下点/boresight 重投影、增益偏置、路径损耗、极化、任意电平、投影 全部实时 | 重：存网格 + Worker 做 marching-squares |

**结论：采用 B**（你的要求是"和 satsoft 完全一致、可设星下点/增益值"，必须 B）。
现有静态 JSON 保留为**快速预览/兜底**（首屏先画烘焙折线，重算就绪后替换）。

---

## 2. 数据模型（方案 B）

### 2.1 原始场存储（默认数据 + 用户导入共用）
每个「天线波束 + 类型」存一份场网格（由 GRD 解析得；二进制定长，紧凑）：

```
resources/coverage/<卫星>/<波束>_<EIRP|GT>.fld.bin   // Float32 dB 网格 NX*NY（无覆盖=NaN）
                                       .fld.json      // 元数据（下）
```
`.fld.json` 元数据：
```jsonc
{
  "sat":"CHINASAT 10R", "norad": 36499, "band":"Ku", "beam":"中国波束",
  "type":"EIRP",                       // 天线类型名（用户可改/可加，如 EIRP/G-T/自定义）
  "igrid":6, "icomp":3, "ncomp":2,     // GRD 头（投影/极化口径）
  "grid":{ "XS":-9,"YS":-9,"XE":9,"YE":9, "NX":181,"NY":181 },
  "antenna":{ "satLon":110.5, "boreLon":120.009,"boreLat":31.172, "yaw":0 }, // 指向(可改)
  "default":{ "gainOffset":0,"pathLoss":"none","pol":"co","levels":[...],"colors":{...} }
}
```
> 多 set（=多波束）的 GRD：拆成 N 份（beam1…beamN，可改名，见 GRD 说明 §2）。
> EIRP/GT 的绝对标定已 baked 进场值；平台只 10log10 出 dB，类型名由用户标注。

### 2.2 索引（扩展现有 index.json）
沿用 `{satellites:[{folder,displayName,satName,lon,norad?,beams:[...]}]}`；
beam 增加 `fld`(场文件) 字段，`gains`→默认电平，保留 `file`(烘焙折线)作兜底。

### 2.3 卫星 ↔ 星历匹配
你给 GEO 清单（名/槽位）→ 我对 tle.js/OMM 的 GEO 组匹配 NORAD，写入 index 的 `norad`，
用户从星历选中即能挂上其覆盖天线。

---

## 3. 导入 GRD 后的设置（SATSOFT 完整对标 · 你说"不全"的补全）

> 来源：手册 §11 Contour Dialog、§7 Boresight、§3.1.6 Spacecraft、§4.2 Maps&Cities。

### 3.1 天线/卫星指向（§7 + Spacecraft）
- **星下点（卫星位置）**：经度 / 纬度 / 高度（GEO 按钮一键 35786 km）。
- **boresight 指向**三选一：① 地图上 (lon,lat)；② 相对天底 (az,el)；③ 三个欧拉角(φ,θ,ψ, yaw-pitch-yaw)。
- **tracking**：星下点变化时，boresight 跟踪同一地面点（自动重算欧拉角）。
- **boresight 标记**：`+` / `+标签` / `标签` / 无；可拖拽交互改指向；可设为某覆盖多边形质心。

### 3.2 等值线 + 填充面（§11 Contour Dialog，并**超过它**）
★ 渲染＝**面 + 线**（不只画线，这是超过 SATSOFT 的点）：
- **填充面（heatmap）**：把 dB 场按 colormap 渲成平滑彩色面（主体画面）。
- **等值线**：在面上叠 marching-squares 等值折线（标注用）。
- 二者同源同一份场，可各自开关、各自配色/透明度。

设置项（**按你要求精简**）：
- **等值类型 Contour Type**：只保留 **相对峰值** 与 **绝对值** 两种（去掉相对输入/功率比/电压比等）。
- **等值电平 Levels**：dB 列表，每条可设颜色 + 线型。
  默认（相对峰值）＝ **−1 −2 −3 −4 −5 dB**；绝对值模式下为绝对 EIRP/G·T 电平。
  可「生成」(起始/间隔/条数) + 配色方案。
- **极化 Polarization**：P1(共极化) / P2(交叉) / P1÷P2 / P2÷P1 / **RSS**=10log(P1²+P2²)。
  （对应 GRD icomp 的分量取法；RSS=总场，比值=XPD。本语料 EIRP/GT 一般取 P1/RSS。）
- **增益偏置 Gain Offset(dB)**：★你说的"增益值"。加到场再等值化——把方向图(dBi)换算成 EIRP/G·T/通量。
- **路径损耗 Path Loss**：无 / 相对 (h/Rs)² / 绝对 1/(4πRs²)（地面通量密度）。Rs=星地斜距(WGS84)。
- **填充透明度 / 线宽 / 颜色方案**。
- （Whittaker 上采样：可选，仅用于让面/线更平滑，默认关。）

> ⚠ **不走 GXT 线思路**：现有 resources/coverage 的折线 JSON 是 GXT 式"只有线"的产物，会把方案
> 带歪。本设计以**原始场**为唯一真值，面与线都由场实时导出。

### 3.3 地图/显示（§4.2）
- **投影**（9 种，阶段 2 落地）：uv / θ / az-el / el-az / 方位等距 ×2 / 等积 / 正射 / 经纬度(现有)。
- 地图视点（可与卫星位置不同）、地图旋转（把 boresight 放到原点）。
- 指向误差(roll/pitch/yaw)→ 指向框；城市、经纬网、sin 空间单位圆。
- 坐标轴范围/标注、缩放。

### 3.4 可见性（仰角）等值线（§3.1.6 / §11.2）
- 输入 0–90° 仰角列表，画等仰角线（已 WGS84，见 wgs84.js `isoElevationContour`），可设颜色/线型/标签。

---

## 4. 性能架构（最佳方案 · 你的首要关切）

核心思想：**把"贵"和"便宜"分层，按依赖只重算变化的那层；贵的只在指向变化时做一次。**
一份场 NX×NY≈181²≈3.3 万点。各层耗时（单波束，JS）：

| 层 | 触发条件 | 内容 | 量级 |
|---|---|---|---|
| **L0 投影网格（贵）** | 仅星下点/boresight/yaw 变 | 每节点 gridDir→姿态→rayEllipsoid→大地经纬度，缓存为 lon/lat 网格 | ~3–5 ms |
| **L1 场标量（中）** | 极化/路径损耗 变 | 取分量(P1/RSS/比值) + 路径损耗(斜距按指向已定，可同 L0 缓存) → dB 网格 | ~2 ms |
| **L2a 填充面（便宜）** | colormap/增益偏置/透明度 变 | 仅按 colormap 重新着色（增益偏置=平移色标域，不动几何） | ~1–2 ms |
| **L2b 等值线（中）** | 电平 变 | marching-squares @ 电平 → 折线 | 5 电平 ~2–3 ms |

- **增益偏置/换 colormap/调透明度 = 只走 L2a**（亚帧，丝滑）；**改电平 = 只走 L2b**；
  **换星下点/boresight = 才走 L0**（Worker + 防抖，几十 ms 一次，不卡 UI）。
- **逐波束缓存、逐波束失效**：只重算被改的那个波束，多波束/多星不互相拖累。
- **默认预置数据**（GEO 星下点固定）：导入时**预烘 L0+L1**（投影网格 + dB 网格）随 `.fld` 存盘，
  打开即只做 L2（着色+取线），零等待。用户改指向才触发 L0 实时重算。
- 重算放 **Web Worker**，传 Transferable(Float32/Typed Array) 零拷贝；首帧用预烘结果兜底。

## 5. 渲染（面 + 线，2D & 3D 同源）

L0 得到「投影网格」(每格 lon/lat) + L1 的 dB → 两个渲染器各自消费：

- **填充面**
  - 3D(scene.js)：投影网格三角化成贴地 mesh，**逐顶点 colormap 着色**（同现有 buildLandMesh 路子），
    改色只更新 color 属性。
  - 2D(flatCoverage)：把 dB 网格按 colormap 栅格化成等距圆柱 ImageData 贴图，blit 到面层；
    平移/缩放只做变换，改色才重栅格化。
- **等值线**：marching-squares 折线，3D 走 fatStrip / 2D 走 drawPolyline（**复用现有**），叠在面上。
- 复用现有批次/电平/颜色 UI；扩展为「面开关 + 线开关 + 透明度」。

---

## 6. 数据现状（C:\Users\Lenovo\Desktop\GRD\GRD，已盘点）

**76 个文件 = 一种 GRASP 网格格式**（68 `.grd` + 8 `.pat`，扩展名无关、按内容解析）。
解析器在 GRD说明 §8 基础上需 4 处健壮化：
1. 结束标记接受 **4 个或更多 `+`**（CS11 用 `+++++`）。
2. **不假设 KTYPE=1**（CS26 为 KTYPE=2，字段结构相同）。
3. 不假设方形/固定尺寸：实见 91² / 101×66 / 179² / 181² / 201×161 / 201² / 361²。
4. 指数 `E+001`(三位) 与 `E+01` 均可（`Number()` 直接吃）。
覆盖的网格类型：**igrid 1/4/6、icomp 2/3、ncomp 2、klimit 0** —— 全部已被
wgs84.js + gridDir/valueDB 覆盖，无需新数学。错误数据 .ssw/.gxt 已由用户移除。

**卫星身份已解决**（无需再问）：现有 resources/coverage/index.json 已含
CSxx→中星/CHINASAT 名+GEO 经度（CS10R=110.5、CS15=51.5 与 GRD 头内嵌值吻合）。
NORAD 由 satName 对 CelesTrak GEO 组匹配（平台已有能力）。

**待办/待确认**：
- [ ] **波束命名归一**：各星目录/文件名规则不一（"C BAND ASIA EIRP" / "QUANGUO EIRP A" /
      "300_X01G_EIRP"）。我自动解析出草稿清单(sat/type/band/beam/grid/peak)，你过目修正。
- [ ] **CS26 对账**：GRD 主文件 EIRP_OK1=**94 set**(KTYPE2,IG4)、另有 馈电EIRP/GT(IG6,201×161,
      偏置网关波束)；现有 index 记 100 beams。94/100 与馈电波束如何归并，需确认。
- 已定：方案 B（原始场）、**面+线**渲染、等值类型仅**相对峰值(默认 −1~−5)+绝对值**、性能分层(§4)。
