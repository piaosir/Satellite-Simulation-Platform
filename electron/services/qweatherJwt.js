// qweatherJwt.js — 和风天气 JWT（Ed25519 / EdDSA）签发
//
// 和风支持 JWT 与 API KEY 两种认证，本平台一律走 JWT：
//   · API KEY 自 2027-02-01 起会被限制每日请求数，且和风 SDK v5+ 只认 JWT；
//   · JWT 的私钥不出本机（只上传公钥），凭据即使被读走也无法伪造签名。
//
// ★ 零新依赖：Node 内置 crypto 直接支持 Ed25519 签名（crypto.sign(null, data, key)）。
//   electron/services/activation.js 里已有同一算法的**验签**（激活书 Ed25519 签发链），
//   这里只是把方向反过来，两处用的是同一套内置能力，不引 jose / jsonwebtoken。
//
// 三个容易踩的点（都来自和风文档，踩了会 401 且难查）：
//   ① 必须 base64**url**，不是 base64（'+/' → '-_'，去掉 '=' 补位）。
//   ② Header/Payload 里**只放**文档点名的字段。typ / aud / nbf 是保留字段，
//      文档明说别加 —— 而大多数 JWT 库默认会塞一个 typ:'JWT'。手写正好绕开。
//   ③ iat 要比当前时间早 30 s（文档建议，防两端时钟误差把刚签的 token 判成「尚未生效」）。
//
// exp 最长允许 24 h。这里取 15 min 并在 60 s 余量内复用同一个 token：签一次几十微秒，
// 但每次请求都签会在批量取数（几百个格点）时白烧 CPU，而拉长有效期又不必要地扩大泄露窗口。

const { createPrivateKey, sign } = require('crypto');

const TTL_SEC = 900;          // token 有效期
const SKEW_SEC = 30;          // iat 提前量（文档建议值）
const RENEW_MARGIN_SEC = 60;  // 距到期不足这么多秒就重签

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/**
 * 签一个和风 JWT。
 * @param {object} cfg { kid, iss, sub, privateKeyPem }
 *   kid  凭据ID（控制台-项目管理-凭据）
 *   iss  开发者ID（控制台-设置，Q 开头 10 位）
 *   sub  项目ID（控制台-项目管理）
 *   privateKeyPem  Ed25519 私钥 PEM（PKCS#8，-----BEGIN PRIVATE KEY-----）
 * @param {number} [nowMs] 便于测试注入时刻
 * @returns {{ token:string, expSec:number }}
 */
function signJwt(cfg, nowMs) {
  const c = cfg || {};
  for (const k of ['kid', 'iss', 'sub', 'privateKeyPem']) {
    if (!c[k] || !String(c[k]).trim()) throw new Error('和风凭据缺少 ' + k);
  }
  const now = Math.floor((Number.isFinite(nowMs) ? nowMs : Date.now()) / 1000);
  const iat = now - SKEW_SEC;
  const exp = iat + TTL_SEC;

  // 字段顺序无关紧要，但只放这几个 —— 见文件头 ②
  const head = b64u(JSON.stringify({ alg: 'EdDSA', kid: String(c.kid) }));
  const body = b64u(JSON.stringify({ iss: String(c.iss), sub: String(c.sub), iat, exp }));
  const data = head + '.' + body;

  let key;
  try {
    key = createPrivateKey(String(c.privateKeyPem));
  } catch (e) {
    throw new Error('私钥无法解析（需 PKCS#8 PEM 的 Ed25519 私钥）：' + e.message);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('私钥不是 Ed25519（拿到的是 ' + key.asymmetricKeyType + '），和风 JWT 只接受 EdDSA');
  }
  const sig = sign(null, Buffer.from(data), key);
  return { token: data + '.' + b64u(sig), expSec: exp };
}

/**
 * 带缓存的取 token：同一份凭据在有效期内复用，到期前 RENEW_MARGIN_SEC 重签。
 * 缓存挂在返回的闭包里，调用方持有一个实例即可。
 */
function createTokenCache() {
  let cached = null, cachedExp = 0, cachedFp = '';
  return function getToken(cfg, nowMs) {
    const now = Math.floor((Number.isFinite(nowMs) ? nowMs : Date.now()) / 1000);
    // 指纹只用非机密部分 + 私钥长度：换了凭据要立刻失效，但别把私钥留在内存里当键
    const fp = [cfg && cfg.kid, cfg && cfg.iss, cfg && cfg.sub,
      cfg && cfg.privateKeyPem ? String(cfg.privateKeyPem).length : 0].join('|');
    if (cached && fp === cachedFp && now < cachedExp - RENEW_MARGIN_SEC) return cached;
    const r = signJwt(cfg, nowMs);
    cached = r.token; cachedExp = r.expSec; cachedFp = fp;
    return cached;
  };
}

/** 拆开一个 token 看 header/payload（自检与排错用，不验签） */
function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const j = (s) => { try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch (e) { return null; } };
  return { header: j(parts[0]), payload: j(parts[1]), signature: parts[2] };
}

module.exports = { signJwt, createTokenCache, decodeJwt, TTL_SEC, SKEW_SEC };
