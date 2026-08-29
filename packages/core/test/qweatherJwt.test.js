// 和风天气 JWT 签发测试（无框架，纯断言）。运行： node packages/core/test/qweatherJwt.test.js
//
// 自己生成一把临时 Ed25519 密钥，不依赖任何本机凭据 —— 别的机器 / CI 上照样能跑。
// 验的是「和风服务端会做的那件事」：拿公钥验 header.payload 的签名。本地过了，
// 服务端只要凭据ID对得上就能过；反过来 401 时也能立刻排除签名这一环。
//
// 三条最容易踩的（都会 401 且报错信息看不出所以然）：base64url 而非 base64、
// 不许带 typ/aud/nbf 保留字段、iat 要提前 30 s。这里逐条钉住。

const crypto = require('crypto');
const J = require('../../../electron/services/qweatherJwt.js');

let pass = 0, fail = 0;
const ok = (n, v, extra) => { console.log((v ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '   ' + extra : '')); v ? pass++ : fail++; };

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const CFG = { kid: 'TESTKID01', iss: 'Q1234567AB', sub: 'PROJ123456', privateKeyPem: pem };
const NOW = 1756400000000;   // 固定时刻，结果可复现

const { token } = J.signJwt(CFG, NOW);
const d = J.decodeJwt(token);

ok('token 为三段式', token.split('.').length === 3);
ok('header: alg=EdDSA 且带 kid', d.header.alg === 'EdDSA' && d.header.kid === CFG.kid);
ok('header 不含保留字段 typ（多数 JWT 库默认会塞）', !('typ' in d.header), JSON.stringify(d.header));
ok('payload 恰为 iss/sub/iat/exp（无 aud / nbf）',
  Object.keys(d.payload).sort().join(',') === 'exp,iat,iss,sub', JSON.stringify(d.payload));
ok('iat 比签发时刻早 30 s（防两端时钟误差）', d.payload.iat === Math.floor(NOW / 1000) - 30);
ok('有效期 900 s，远在 24 h 上限内', d.payload.exp - d.payload.iat === 900);
ok('通篇 base64url（不出现 + / =）', !/[+/=]/.test(token));

// ★ 服务端做的就是这一步
const P = token.split('.');
ok('用公钥验签通过',
  crypto.verify(null, Buffer.from(P[0] + '.' + P[1]), publicKey, Buffer.from(P[2], 'base64url')));

// 反证：这条测试不是空转
const T = [P[0], Buffer.from('{"iss":"HACK"}').toString('base64url'), P[2]];
ok('★ 反证：篡改 payload 后验签失败',
  !crypto.verify(null, Buffer.from(T[0] + '.' + T[1]), publicKey, Buffer.from(T[2], 'base64url')));

// token 缓存：批量取数（几百个格点）时不该每次重签
const get = J.createTokenCache();
const t1 = get(CFG, NOW);
ok('有效期内复用同一 token', get(CFG, NOW + 60000) === t1);
ok('临近到期自动重签', get(CFG, NOW + 900000) !== t1);
ok('换凭据（kid 变）立刻重签', get({ ...CFG, kid: 'OTHER' }, NOW) !== t1);

// 错误路径要报得出原因
const boom = (f) => { try { f(); return ''; } catch (e) { return e.message; } };
ok('缺字段时点名是哪一项', /kid/.test(boom(() => J.signJwt({ iss: 'a', sub: 'b', privateKeyPem: pem }))));
const rsaPem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
ok('私钥不是 Ed25519 时明确拒绝', /Ed25519/.test(boom(() => J.signJwt({ ...CFG, privateKeyPem: rsaPem }))));
ok('私钥格式不对时明确拒绝', /私钥无法解析/.test(boom(() => J.signJwt({ ...CFG, privateKeyPem: 'not a pem' }))));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
