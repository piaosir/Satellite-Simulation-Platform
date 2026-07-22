# 卫星仿真平台 — 架构设计

> Windows 桌面端 · 离线优先 · 复用小程序的纯 JS 链路引擎
> 版本：架构 v0.1（待评审，尚未实现）

## 1. 定位与边界

- **平台**：纯 PC，仅支持 Windows。
- **离线优先**：除以下两处外，全部功能离线可用：
  - 高德地图瓦片（卫星覆盖图）
  - CelesTrak OMM/TLE 抓取（星座地图 / 星间链路）
  - OMM 取数链路（逐级兜底，任一级成立即止，全程不打扰用户）：
    今日本地缓存 → CelesTrak 直连（主端点 ×3 → 补充端点 ×2）→ 众包云镜像（腾讯云 COS，
    见 `electron/services/ommCloud.js`）→ 本地旧缓存 / 随包内置快照（`resources/omm`）。
    直连成功的用户会把当天星历 best-effort 回传云镜像，供屏蔽 celestrak 的网络兜底下载。
- **本地化存储**：原 CloudBase 云存储全部改为本地（SQLite + JSON）。
- **数据全精度**：不再受小程序 20MB 包体限制，ITU-R 数据 / 地形 / 海岸线全精度内置。
- **已砍功能**：AR 对星（ar-align）整页移除。

## 2. 技术栈（已确认）

| 层 | 选型 |
|---|---|
| 桌面外壳 | Electron |
| 前端框架 | Vue 3 + Vite |
| 3D 地球 | CesiumJS（星座地图 + 星间链路） |
| 地图 | 高德 JsAPI（卫星覆盖，全精度，用户自有 key） |
| 本地存储 | SQLite（better-sqlite3，历史/配置）+ JSON（设置/缓存） |
| 状态管理 | Pinia |
| 组件库 | Naive UI 或 Element Plus（主题化，保留期刊风） |
| 打包 | electron-builder → NSIS 安装包 |

## 3. 进程与分层

```
渲染进程 Renderer (Chromium) —— 前端 UI
  Vue 3 + Vite + 组件库
  ├─ 链路预算 / 配置管理 / 历史记录 / 参数输入 / 设置
  ├─ CesiumJS      → 星座地图（全精度 3D 地球）
  ├─ CesiumJS/three → 星间链路 ISL 几何
  ├─ 高德 JsAPI     → 卫星覆盖（全精度）
  └─ import satlink-core  ← 纯 JS 引擎，直接调用（重算走 Web Worker）
            ↕ IPC（contextBridge 安全桥）
主进程 Main (Node.js) —— 本地能力
  ├─ storage   : SQLite（history / configs）+ JSON（settings / cache）
  ├─ report    : docx / exceljs / pdfkit（原云函数代码直接搬）
  ├─ omm       : CelesTrak 抓取 + 本地磁盘缓存 + 众包云镜像兜底（原 fetchTLE 逻辑）
  ├─ dataPacks : 读本地 ITU-R .bin / 全精度 topo / 海岸线
  └─ dialog    : 原生保存/打开文件框

本地资源：ITU-R 全套 .bin + 全精度 topo + 海岸线/国界
联网仅两处：高德地图瓦片 + CelesTrak OMM（含腾讯云 COS 众包镜像兜底 / 自动更新 / 在线分享）
```

## 4. satlink-core（纯 JS 引擎，packages/core）

从现有小程序原样搬入（零 `wx.*` 耦合）：
`linkCalculator` · `linkCalculatorNGSO` · `p676Data` · 四个 data grid
（cloudParamsGrid / waterVaporGrid / rainRateGrid / isothermHeightGrid）·
`elevation` · `rainRate` · `isothermHeight` · `sunOutageCalculator` ·
`validator` · `formatter` · `constants` · `waterfallBuilder`

### 需重构的 23 处 `wx.*`（抽成接口注入）
| 文件 | 处数 | 抽成接口 | 桌面端实现 |
|---|---|---|---|
| tleStore.js | 15 | `OmmSource` | 主进程 IPC → omm 服务 |
| coverageSettingsCache.js | 4 | `Storage` | JSON/SQLite |
| rainRateGrid.js | 2 | `DataPackReader` | Node fs |
| isothermHeightGrid.js | 2 | `DataPackReader` | Node fs |

引擎本身不认识平台 → 将来可回灌小程序 / 做 Web。

## 5. 本地存储设计

- SQLite：`history`（每次预算的输入+结果快照，排序/筛选/多选批量导出）、
  `configs`（命名参数预设，GEO/NGSO 模板，复制/删除）。
- JSON（`%APPDATA%/卫星仿真平台/`）：应用设置（单位/语言/主题/高德 key）、
  星座/ISL 选择缓存。
- 报告导出：原生保存对话框 → 用户任意目录。

## 6. 集成风险（搭骨架时先验证）

1. 高德 JsAPI 的 key Referer 校验：渲染进程走 `http://localhost`（本地静态服务）
   而非 `file://`，否则 Referer 校验可能失败。
2. Cesium 体积与首屏：按需加载 + 本地影像兜底，断网时地球仍可渲染。
3. OMM 离线兜底：拉不到时回退本地缓存。

## 7. 目录结构

```
卫星仿真平台/
├─ packages/core/        satlink-core 纯 JS 引擎
├─ electron/
│  ├─ main.ts  preload.ts
│  ├─ ipc/               IPC 处理器
│  └─ services/  storage.ts  omm.ts  report.ts  dataPacks.ts
├─ src/                  Vue3 渲染进程
│  ├─ pages/  components/  stores/
│  └─ viz/               Cesium / three.js / 高德 封装
├─ resources/            内置：ITU-R .bin / 全精度 topo / 海岸线
└─ docs/                 本文档
```

## 8. UI 原则（回应"前端太卡通"的顾虑）

- 卡通感来自默认组件库样式，不来自 Web 技术本身（VS Code / Figma / Grafana 均为 Web/Electron）。
- 沿用现有"Nature 期刊风"：黑白灰 + 衬线标题 + 等宽数字 + 填空线输入。
- 桌面端走"仪器化"方向：菜单栏 + 多窗格 + 数据密集表格 + 可拖拽分隔条 + 状态栏。
- 组件库用 theme token 压扁圆角、去糖果色、收紧间距。
