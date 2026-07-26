// 在线分享凭证（示例）。【复制】本文件为同目录下的 shareConfig.js 并填入真实值 —— 是复制不是重命名，
// 本文件要留在仓库里：它是模板，也是下面那段 CAM 策略说明的唯一存放处（shareConfig.js 不进版本库）。
//
// ⚠️ 最重要的一条：这把密钥随安装包发给每一个用户，而 asar 不是加密——
//    `npx asar extract` 几秒就能取出。所以【策略里给什么权限，就等于把什么权限公开】。
//    唯一的防线是 CAM 策略的前缀，务必按下面写死，不要图省事放宽。
//
// 准备步骤（腾讯云控制台）：
//   1. 用现有 COS 桶（与更新桶同一个：update-1385987144 / ap-beijing）。
//   2. CAM 新建子账号 + 密钥（SecretId/SecretKey）。
//      注：SecretKey 只在创建时显示一次，事后无法找回 —— 忘了就新建一把，别去翻。
//   3. 给该子账号一条最小权限策略，【只给下面三个前缀，只给两个动作】：
//        动作：name/cos:PutObject, name/cos:GetObject
//        前缀：share/*        —— 配置信箱（share/<用户ID>/inbox.json，私有读写）
//              omm/*          —— 星历众包云镜像（见 ommCloud.js，公有读、签名写）
//              updates/gxt/*  —— 发送到小程序的画面快照（见 share.js putSnapshot）
//      信箱是单个聚合对象，收发只读写对象——不需要 GetBucket（列举桶）、也不需要
//      DeleteObject（「接收/忽略」是 PUT 覆写整个 inbox.json），CAM 配置最简单、最不易出错。
//
//      策略 JSON（已按本桶 ap-beijing / APPID 1385987144 填好，可直接用）：
//        {
//          "version": "2.0",
//          "statement": [{
//            "effect": "allow",
//            "action": ["name/cos:PutObject", "name/cos:GetObject"],
//            "resource": [
//              "qcs::cos:ap-beijing:uid/1385987144:update-1385987144/share/*",
//              "qcs::cos:ap-beijing:uid/1385987144:update-1385987144/omm/*",
//              "qcs::cos:ap-beijing:uid/1385987144:update-1385987144/updates/gxt/*"
//            ]
//          }]
//        }
//
//   ★★ 绝不可把最后一条写成 `.../updates/*` ★★
//      updates/ 是自动更新的下载目录：electron-updater 从 updates/latest.yml 读版本、
//      再拉同目录下的 .exe 装上（package.json build.publish + updater.js，且
//      autoInstallOnAppQuit=true，用户关软件时自动安装、无需确认）。
//      一旦这把随包分发的密钥能写 updates/*，任何拿到安装包的人都能覆盖 latest.yml
//      并上传自己的 exe，全体用户下次关程序时静默装上 —— 等于把机器交出去。
//      CAM 的 resource 是精确前缀匹配：`updates/gxt/*` 只能写 updates/gxt/ 下的对象，
//      碰不到 updates/latest.yml 和安装包，所以按上面那样写是安全的。
//      发布用的主账号密钥只放开发机环境变量（COS_SECRET_ID/KEY，见 scripts/publish-cos.mjs），
//      任何情况下都不要写进本文件。
//
//   4. 把 SecretId/SecretKey 填到下面，另存为 shareConfig.js。
//   5. 存好后跑一次 `npm run check:share` 自检（打包前会自动跑）。
//      配好之后建议发版都带 SATSIM_REQUIRE_SHARE=1，这样万一文件丢了会直接中断打包，
//      不会再悄悄打出一个没有分享功能的包。
//
// 权限缺失时的降级（都不会崩，但功能会静默变弱，所以别漏配）：
//   · 缺 share/*       → 在线分享收发报错「未配置」
//   · 缺 omm/*         → 星历回传拿 403 后静默跳过，云镜像退化为只有开发者 seed 的那份
//   · 缺 updates/gxt/* → 「发送到小程序」报错，拿不到密钥
module.exports = {
  secretId: '',                 // CAM 子账号 SecretId
  secretKey: '',                // CAM 子账号 SecretKey
  bucket: 'update-1385987144',  // COS 桶名
  region: 'ap-beijing',         // COS 地域
  prefix: 'share'               // 信箱前缀（对象路径形如 share/<用户ID>/inbox.json）
}
