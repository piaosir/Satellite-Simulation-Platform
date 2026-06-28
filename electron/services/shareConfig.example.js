// 在线分享凭证（示例）。复制本文件为同目录下的 shareConfig.js 并填入真实值。
// shareConfig.js 已加入 .gitignore（不进仓库），但会随 electron/** 打进安装包。
//
// 准备步骤（腾讯云控制台）：
//   1. 用现有 COS 桶（可与更新桶同一个，如 update-1385987144 / ap-beijing），或新建一个。
//   2. CAM 新建子账号 + 密钥（SecretId/SecretKey）。
//   3. 给该子账号一条最小权限策略，仅作用于本桶的 share/* 前缀，【只需两个动作】：
//        name/cos:PutObject, name/cos:GetObject
//      信箱是单个聚合对象 share/<用户ID>/inbox.json，收发只读写对象——
//      不需要 GetBucket（列举桶）、也不需要 DeleteObject，CAM 配置最简单、最不易出错。
//      策略 JSON（已按本桶 ap-beijing / APPID 1385987144 填好，可直接用）：
//        {
//          "version": "2.0",
//          "statement": [{
//            "effect": "allow",
//            "action": ["name/cos:PutObject", "name/cos:GetObject"],
//            "resource": ["qcs::cos:ap-beijing:uid/1385987144:update-1385987144/share/*"]
//          }]
//        }
//   4. 把 SecretId/SecretKey 填到下面，另存为 shareConfig.js。
//
// 安全说明：该密钥随客户端分发，务必【权限最小化】——只给 share/* 前缀的对象读写，别给整桶或其它桶。
module.exports = {
  secretId: '',                 // CAM 子账号 SecretId
  secretKey: '',                // CAM 子账号 SecretKey
  bucket: 'update-1385987144',  // COS 桶名
  region: 'ap-beijing',         // COS 地域
  prefix: 'share'               // 信箱前缀（对象路径形如 share/<用户ID>/inbox.json）
}
