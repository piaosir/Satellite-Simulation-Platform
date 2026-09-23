# scripts/nasa3d —— NASA 3D 语料离线管线

npm script（参数跟在 `--` 后面，例如 `npm run nasa3d:fetch -- --groups=station`）：

- `nasa3d:catalog` —— 拉 NASA 3D Resources 全部条目、解析 glb 直链与体积，写 `.models-src/catalog.json`，与 `include-list.json` 逐条对账。
- `nasa3d:fetch` —— 按 `include-list.json` 分组下载 glb 原件到 `.models-src/nasa/<slug>/`（Range 续传、sha256 旁车、只读保存；缺省七组）。
- `nasa3d:corpus-report` —— 只读 glb 文件头统计语料（generator / 扩展 / 计数 / 三角形 / 包围盒 + 四类标记），写 `.models-src/corpus-report.{md,json}`。

共用件在 `lib.mjs`（参数、代理、续传下载、sha256、`parseGlbHeader`、`summarizeGltf`），后续 build / sheets / publish 直接复用。
`include-list.json` 是用户给定的分组清单，原样保存，不由脚本改写。
