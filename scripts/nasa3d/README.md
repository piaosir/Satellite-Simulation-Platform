# scripts/nasa3d —— NASA 3D 语料离线管线

npm script（参数跟在 `--` 后面，例如 `npm run nasa3d:fetch -- --groups=station`）：

- `nasa3d:catalog` —— 拉 NASA 3D Resources 全部条目、解析 glb 直链与体积，写 `.models-src/catalog.json`，与 `include-list.json` 逐条对账。
- `nasa3d:fetch` —— 按 `include-list.json` 分组下载 glb 原件到 `.models-src/nasa/<slug>/`（Range 续传、sha256 旁车、只读保存；缺省七组）。
- `nasa3d:corpus-report` —— 只读 glb 文件头统计语料（generator / 扩展 / 计数 / 三角形 / 包围盒 + 四类标记），写 `.models-src/corpus-report.{md,json}`。
- `nasa3d:build` —— 原件 → `build/models/<slug>[~n]/{lod0,lod1,lod2}.glb + meta.json + build.json`、`manifest.json`、`REPORT.md`（Draco 解码、meshopt 三档、webp 贴图、单位按 `known-dims.json`、中文名与 kind 按 `titles-zh.json` / `kind-overrides.json`；原件与管线没变的文件走缓存，`--force` 全重做）。`--groups` 没选全、或有文件既没处理也没旧产物时只写 `manifest.partial.json`，不覆盖 `manifest.json`。本体朝向按 `frame-overrides.json`（逐件核过的 q 与 nadir / velocity 轴，`--frame-overrides=<文件>` 换一份）出，没收的件取 +Y 天顶缺省；覆盖表有坏条目（id 不过 `schema.parseModelId`、q 非单位、axes 与 q 不符）或全量运行时有目录里找不到的失效 id，那几条按缺省出、`REPORT.md`「本体朝向」列出、退出码 1（子集运行不判失效 id）。
- 出厂处理档：`nasa3d:build` 缺省 `--level=high`（meshopt 法线 / 切线 8 位滤波；lod0 全集 185 MB，达 ≤ 200 MB）+ `--lod2-tex=256`（lod2 贴图边长上限）+ lod2 预算 `--lod2-max-tris=25000`（三角形上限）/ `--lod2-cull=0.01`（剔除包围半径 < 1 % 整件的零碎网格，节点名保留）+ 固定口径（位置 12 位量化、删 glTF 动画、带贴图图元按 uv 计误差简化）——lod2 全集 29.4 MB，达 ≤ 30 MB。另有材质兜底（无材质图元给中性浅灰、整件退化黑按材质名还原）。`--level=medium` / `--lod2-tex=512` / `--lod2-max-tris=0` 只作对照，每种处理档最近一次全量的总量记进 `build/models/history.json`，`REPORT.md`「处理档对照」逐档列出，另有「lod2 构成」与「材质兜底」两节。
- `nasa3d:sheets`（`electron scripts/nasa3d/sheets.mjs`）—— 离屏窗口 + `sheet://` 协议（`repo` 放行四棵源码子树、`build` 映射 `--build-dir`）+ importmap，直接加载 `src/viz/models` 的 studio / thumbs / materials / loader / irToThree：每个 NASA 条目出 512 px WebP 缩略图 `build/models/<id 目录>/thumb.webp`、每个参数化模板出 `build/models/_param/<模板>/thumb.webp`，另出复核图 `build/review/*.png`（本体轴 + 米制比例尺 + 三视图）。朝向与视角就是 `thumbs.renderThumb` 的缺省（与工作台预览、应用内重拍同一张脸）；本体只剩一小块的件按稳健取景重画那一块（`setViewOffset`，不放大像素）；每张量一次画面（过小 / 过暗 / 发白）记进 `build/review/sheets.json`。WebGL2 / WebP 起不来直接中止；出图失败退回 NASA 官方缩图，退回超过 5 % 退出码 1（`--allow-fallback` 放行）。跑完再跑一次 `nasa3d:build`（走缓存）：build 按 `sheets.json` 的内容键核对（模型 / 标定变了的不认）后把缩略图并进 meta 与 manifest。
- `nasa3d:builtin` —— 从 build 选内置层写 `resources/models`（进 git，≤ 15 MiB）：缺省只出点名子集（带 lod2 + 缩略图；ISS 取 D IGOAL）。`--templates=entries`（参数化模板条目）与 `--catalog=full`（没带模型的目录条目）默认关：前者要等工作台 `wbStore.refresh` 与 3D 页 `loadModelLib` 改成「同 id 以模板为底合并」、后者要等 3D 页 autoMatch 按「本机能出图」判可用；缺缩略图 / 缩略图核对不过 / 文件 sha 对不上一律报错不写，写盘失败不留 `.models-tmp-*`。
- `nasa3d:publish` —— 分发件与原件镜像上 COS（`updates/models/blobs/<sha256>`、`updates/models/src/nasa/…`、manifest 快照 → `manifest.json` 最后传）；先 `--dry-run` 看计划（不联网），`--only-src` / `--only-build` 分开传。实传前先与云端 `manifest.json` 比对条目，少了就拒绝（确要下架加 `--allow-shrink`）；这道缩水闸同时查缩略图：云端带缩略图、本次同一 id 却没有的也拒绝（退出码 2，改了朝向 / 显示系后须按 sheets → build → publish 重跑；确要去掉同样加 `--allow-shrink`），dry-run 显示「带缩略图 N」。凭据读环境变量 `COS_*`。
- `check:models`（`scripts/check-models.mjs`，dist 链在 check-imagery 之后以 `--online` 调用）—— 打包前自检内置子集 `resources/models`：打包配置（models 与 licenses 走 extraResources、LGPL 原文在）、manifest 校验、文件 sha 与 GLB 头、兜底模型随包带 lod、目录条目缺省拦下、模板条目（有的话）须是已知模板、缩略图、孤儿文件、≤ 15 MiB、无不可分发条目；`--online` 另查内置 manifest 的 `sourceBuildId` 在云端已发布（`manifest.<sourceBuildId>.json` HEAD 200）。

`known-dims.json`（已知尺寸，带出处）、`kind-overrides.json`（181 条 kind）、`titles-zh.json`（中文名）是人工维护的数据表，build 只读不写。
COS 签名与上传在 `scripts/lib/cos.mjs`，与 `scripts/publish-cos.mjs`（安装包发版）共用。
顺序：`nasa3d:build` → `nasa3d:sheets` → `nasa3d:build`（走缓存）→ `nasa3d:builtin` → `check:models` →（编排者复核后）`nasa3d:publish` → 才能 `dist`（dist 链的 `check-models --online` 查这批分发件已上云；先打包后发布，装上后联网升档一律 404）。
LGPL 组件（occt-import-js / OCCT）的许可原文与源码地址在 `resources/licenses/`。

共用件在 `lib.mjs`（参数、代理、续传下载、sha256、`parseGlbHeader`、`summarizeGltf`），后续 build / sheets / publish 直接复用。
`include-list.json` 是用户给定的分组清单，原样保存，不由脚本改写。
