// 和风天气凭证（示例）。【复制】本文件为同目录下的 weatherConfig.js 并填入真实值 —— 是复制不是重命名，
// 本文件要留在仓库里：它是模板，也是下面这段控制台步骤与安全边界说明的唯一存放处
// （weatherConfig.js 不进版本库，见 .gitignore）。
//
// 不必手抄：跑 `node scripts/setup-weather-config.mjs` 会向导式生成 weatherConfig.js，
// 并从 ~/.qweather/ed25519-private.pem 直接读私钥（私钥因此不必经过剪贴板 / 聊天窗口）。
//
// ⚠️ 与 shareConfig.js 同一条铁律：这份凭据随安装包发给每一个用户，而 asar 不是加密——
//    `npx asar extract` 几秒就能取出。所以【凭据能调什么，就等于把什么公开】。
//    唯一的防线在和风控制台侧，务必按第 5 步把 API 限制配上，不要图省事跳过。
//
// ── 控制台准备步骤（dev.qweather.com）─────────────────────────────────────
//   1. 本地生成 Ed25519 密钥对（私钥永不上传）：
//        node scripts/setup-weather-config.mjs --genkey
//      产物在 ~/.qweather/ 下：ed25519-private.pem（自己收好）/ ed25519-public.pem（要上传）。
//
//   2. 控制台 → 设置：抄下 **开发者ID**（Q 开头 10 位 → 下面的 iss）与
//      **API Host**（形如 h2a9cf3mhs.xy.qweatherapi.com → 下面的 apiHost）。
//      ★ 别再用 api.qweather.com / devapi.qweather.com 这类公共域名，它们自 2026 年起逐步停服。
//
//   3. 控制台 → 项目管理 → 「创建项目」→ 填名称（≤20 字符）→ 保存。
//      抄下 **项目ID** → 下面的 sub。
//
//   4. 进该项目 → 凭据区右侧「添加凭据」→ 认证方式选 **JSON Web Token**（不要选 API KEY：
//      自 2027-02-01 起 API KEY 会被限制每日请求数）→ 把 ed25519-public.pem 全文粘进公钥框 → 保存。
//      抄下 **凭据ID** → 下面的 kid。
//      注：公钥只在创建时显示一次，之后控制台只给 SHA256 供比对（setup 脚本会打印本地 SHA256）。
//
//   5. ★ 同一页往下滑到「API限制」，**只放行本平台真正用到的两个前缀**：
//        /weather/v1/*     实时天气与逐小时预报（全球 1 km）
//        /v7/minutely/*    分钟级降水（仅中国）
//      这一步是内置凭据唯一的实质防线：凭据被挖出来也只能查天气，动不了账号里别的东西。
//      另建议在「应用限制」里按需收紧。
//
//   6. 计费：每月前 5 万次请求 0 元，之后 ¥0.0007/次（后付费）。本平台的取数计划器
//      （packages/core/utils/metFetchPlan.js）自带硬上限与软阈值，正常用法（5°×5° 场 @0.5°
//      + 几个站点，一天刷 4 次）约 1.5 万次/月，稳在免费额度内。仍建议定期到控制台看用量。
//
// ── 归因（许可硬要求，不是可选项）───────────────────────────────────────────
//   和风《注明来源》条款：用到其数据的页面必须清晰显示「和风天气 / QWeather」并链到
//   https://www.qweather.com，且须单独放置、不与正文混排。界面上那一行不是解释性文字
//   （CLAUDE.md 禁的是那类），是许可要求的署名，必须留。手填气象时不显示——那时没用他们的数据。

module.exports = {
  // 账号专属 API Host，不带协议头。控制台-设置
  apiHost: 'xxxxxxxxxx.xy.qweatherapi.com',

  // JWT 三件套
  kid: 'ABCDE12345',      // 凭据ID   控制台-项目管理-凭据
  iss: 'Q12345ABCD',      // 开发者ID 控制台-设置（Q 开头 10 位）
  sub: 'ABCDE23456',      // 项目ID   控制台-项目管理

  // Ed25519 私钥（PKCS#8 PEM）。由 setup 脚本从 ~/.qweather/ed25519-private.pem 读入并写在这里。
  // 保持 -----BEGIN PRIVATE KEY----- / -----END PRIVATE KEY----- 首尾两行完整。
  privateKeyPem: [
    '-----BEGIN PRIVATE KEY-----',
    'MC4CAQAwBQYDK2VwBCIEIExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    '-----END PRIVATE KEY-----'
  ].join('\n')
};
