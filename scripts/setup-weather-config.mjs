// 和风天气凭据配置向导。
//   node scripts/setup-weather-config.mjs --genkey     只生成 Ed25519 密钥对（幂等，已存在不覆盖）
//   node scripts/setup-weather-config.mjs              向导式填四个值 → 写出 weatherConfig.js
//   node scripts/setup-weather-config.mjs --check      只体检现有配置（不改动）
//   node scripts/setup-weather-config.mjs --set \      非交互写入（脚本 / CI / 远程协助用）
//        --apiHost=xxx.xy.qweatherapi.com --iss=Q… --sub=… --kid=…
//
// ★ 向导模式只在真终端（TTY）下可靠：管道喂输入时 readline 会丢行。要脚本化就用 --set。
//
// ★ 私钥全程走文件，不经剪贴板、不打印、不进任何日志：生成在 ~/.qweather/ed25519-private.pem，
//   写配置时由本脚本直接读取内嵌。控制台只需要公钥。
//
// 与 shareConfig 同一套规矩：weatherConfig.js 不进版本库（.gitignore），但随安装包分发；
// 因此凭据的安全边界由和风控制台侧的「API限制」承担 —— 见 weatherConfig.example.js 第 5 步。

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import readline from 'readline';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY_DIR = path.join(os.homedir(), '.qweather');
const PRIV = path.join(KEY_DIR, 'ed25519-private.pem');
const PUB = path.join(KEY_DIR, 'ed25519-public.pem');
const OUT = path.join(ROOT, 'electron', 'services', 'weatherConfig.js');

const argv = process.argv.slice(2);
const args = new Set(argv.filter((a) => !a.includes('=')));
// --key=value 形式的具名参数（--set 模式用）
const opts = Object.fromEntries(argv.filter((a) => a.startsWith('--') && a.includes('='))
  .map((a) => { const i = a.indexOf('='); return [a.slice(2, i), a.slice(i + 1)]; }));

function genKey() {
  fs.mkdirSync(KEY_DIR, { recursive: true });
  if (fs.existsSync(PRIV)) {
    console.log('私钥已存在，未覆盖：' + PRIV);
  } else {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(PRIV, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(PUB, publicKey.export({ type: 'spki', format: 'pem' }));
    console.log('已生成密钥对。');
  }
  const pubText = fs.readFileSync(PUB, 'utf8').trim();
  // 和风控制台显示的是「删除首尾空白与换行后」的 SHA256，用来核对上传的是不是这一把
  const sha = crypto.createHash('sha256').update(pubText).digest('hex');
  console.log('');
  console.log('  私钥  ' + PRIV + '   （不要外传）');
  console.log('  公钥  ' + PUB);
  console.log('  公钥 SHA256（与控制台显示的比对）');
  console.log('        ' + sha);
  console.log('');
  console.log('── 整段贴进和风控制台的「公钥」框（含首尾两行）──');
  console.log(pubText);
  console.log('────────────────────────────────────────────────');
  return pubText;
}

// 拿私钥真签一个 JWT 再用公钥验回来 —— 配置写出去之前先确认这把钥匙能用
function selfTest(pem) {
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('私钥不是 Ed25519：' + key.asymmetricKeyType);
  const pub = crypto.createPublicKey(key);
  const msg = Buffer.from('qweather-jwt-selftest');
  const sig = crypto.sign(null, msg, key);
  if (!crypto.verify(null, msg, pub, sig)) throw new Error('私钥自签自验失败');
  return true;
}

function check() {
  if (!fs.existsSync(OUT)) { console.log('✕ 未配置：' + OUT + ' 不存在'); return 1; }
  const txt = fs.readFileSync(OUT, 'utf8');
  const pick = (k) => { const m = new RegExp(k + "\\s*:\\s*'([^']*)'").exec(txt); return m ? m[1] : ''; };
  const cfg = { apiHost: pick('apiHost'), kid: pick('kid'), iss: pick('iss'), sub: pick('sub') };
  let bad = 0;
  for (const [k, v] of Object.entries(cfg)) {
    const placeholder = /^x+|^ABCDE|^Q12345/.test(v) || !v;
    console.log((placeholder ? '✕' : '✓') + '  ' + k.padEnd(8) + (v || '(空)') + (placeholder ? '   ← 仍是示例值' : ''));
    if (placeholder) bad++;
  }
  const pm = /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/.exec(txt.replace(/',\s*'/g, '\n').replace(/'/g, ''));
  if (!pm) { console.log('✕  privateKeyPem  缺失或格式不对'); bad++; }
  else {
    try { selfTest(pm[0]); console.log('✓  privateKeyPem  Ed25519 自签自验通过'); }
    catch (e) { console.log('✕  privateKeyPem  ' + e.message); bad++; }
  }
  console.log(bad ? '\n还有 ' + bad + ' 项没配好。' : '\n配置完整。');
  return bad ? 1 : 0;
}

function write(cfg, pem) {
  const lines = pem.trim().split(/\r?\n/).map((l) => "    '" + l + "'").join(',\n');
  const body = `// 和风天气凭证（真实值）。本文件不进版本库，但随安装包分发。
// 说明、控制台步骤与安全边界见同目录 weatherConfig.example.js。
// 重新生成： node scripts/setup-weather-config.mjs
module.exports = {
  apiHost: '${cfg.apiHost}',
  kid: '${cfg.kid}',
  iss: '${cfg.iss}',
  sub: '${cfg.sub}',
  privateKeyPem: [
${lines}
  ].join('\\n')
};
`;
  fs.writeFileSync(OUT, body, 'utf8');
}

async function wizard() {
  if (!fs.existsSync(PRIV)) { console.log('未找到私钥，先生成一对：\n'); genKey(); console.log(''); }
  const pem = fs.readFileSync(PRIV, 'utf8');
  selfTest(pem);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, hint) => new Promise((res) => rl.question(`${q}\n  ${hint}\n> `, (a) => res(a.trim())));

  console.log('从和风控制台抄四个值（都不是机密，私钥不必输入）：\n');
  const apiHost = (await ask('API Host', '控制台-设置。形如 h2a9cf3mhs.xy.qweatherapi.com，不带 https://'))
    .replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const iss = await ask('开发者ID (iss)', '控制台-设置。Q 开头 10 位字母数字');
  const sub = await ask('项目ID (sub)', '控制台-项目管理，点进你的项目');
  const kid = await ask('凭据ID (kid)', '控制台-项目管理-凭据，添加 JWT 凭据后显示');
  rl.close();

  const miss = Object.entries({ apiHost, iss, sub, kid }).filter(([, v]) => !v).map(([k]) => k);
  if (miss.length) { console.error('\n✕ 这几项是空的：' + miss.join(', ') + '，未写出配置。'); process.exit(1); }

  write({ apiHost, iss, sub, kid }, pem);
  console.log('\n已写出 ' + OUT);
  console.log('（该文件在 .gitignore 里，不会进版本库）\n');
  check();
  console.log('\n别忘了控制台第 5 步：给凭据加「API限制」，只放行 /weather/v1/* 与 /v7/minutely/*。');
}

// 非交互写入。四个值都不是机密（私钥仍从 ~/.qweather 读），故可以安全地走命令行参数。
function setNonInteractive() {
  if (!fs.existsSync(PRIV)) { console.error('✕ 未找到私钥，先跑： node scripts/setup-weather-config.mjs --genkey'); return 1; }
  const pem = fs.readFileSync(PRIV, 'utf8');
  try { selfTest(pem); } catch (e) { console.error('✕ 私钥自检失败：' + e.message); return 1; }

  const cfg = {
    apiHost: String(opts.apiHost || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    iss: String(opts.iss || '').trim(),
    sub: String(opts.sub || '').trim(),
    kid: String(opts.kid || '').trim()
  };
  const miss = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => '--' + k);
  if (miss.length) { console.error('✕ 缺少参数：' + miss.join(' ')); return 1; }
  // API Host 形状校验：漏填成公共域名是最常见的错，且它 2026 年起会停服，早点拦下
  if (/^(dev)?api\.qweather\.com$|^geoapi\.qweather\.com$/.test(cfg.apiHost)) {
    console.error('✕ apiHost 填成了公共域名（' + cfg.apiHost + '）。公共域名自 2026 年起逐步停服，'
      + '请到控制台-设置抄你的专属 API Host。');
    return 1;
  }
  if (!/\.qweatherapi\.com$/.test(cfg.apiHost)) console.warn('⚠ apiHost 不以 .qweatherapi.com 结尾，确认没抄错：' + cfg.apiHost);

  write(cfg, pem);
  console.log('已写出 ' + OUT + '（在 .gitignore 里，不进版本库）\n');
  const bad = check();
  if (!bad) console.log('\n别忘了控制台第 5 步：给凭据加「API限制」，只放行 /weather/v1/* 与 /v7/minutely/*。');
  return bad;
}

// 真打一次接口的连通性自检。整条链路一次验穿：签 JWT → 专属 API Host → gzip 解压 → 字段映射。
// 花 1 次请求（免费额度内）。诊断按 HTTP 状态分因，因为这几种错的修法完全不同。
async function liveTest() {
  const { createRequire } = await import('module');
  const require_ = createRequire(import.meta.url);
  const https = require_('https');
  const zlib = require_('zlib');
  if (!fs.existsSync(OUT)) { console.error('✕ 未配置，先跑 --set'); return 1; }
  const cfg = require_(OUT);
  const J = require_(path.join(ROOT, 'electron', 'services', 'qweatherJwt.js'));
  const M = require_(path.join(ROOT, 'packages', 'core', 'utils', 'metSnapshot.js'));

  let token;
  try { token = J.signJwt(cfg).token; } catch (e) { console.error('✕ 签 JWT 失败：' + e.message); return 1; }

  const LAT = 39.92, LON = 116.41;                       // 和风文档自己的示例坐标（北京）
  const reqPath = `/weather/v1/current/${LAT}/${LON}`;
  console.log('GET https://' + cfg.apiHost + reqPath + '\n');

  const res = await new Promise((resolve, reject) => {
    const r = https.request({
      host: cfg.apiHost, method: 'GET', path: reqPath, timeout: 15000,
      headers: { Authorization: 'Bearer ' + token, 'Accept-Encoding': 'gzip' }
    }, (rs) => {
      const chunks = [];
      rs.on('data', (c) => chunks.push(c));
      rs.on('end', () => {
        let buf = Buffer.concat(chunks);
        // 文档的请求示例带 --compressed，故服务端会回 gzip；不解压就是一堆二进制
        if (/gzip/i.test(rs.headers['content-encoding'] || '')) {
          try { buf = zlib.gunzipSync(buf); } catch (e) { return reject(new Error('gzip 解压失败：' + e.message)); }
        }
        resolve({ status: rs.statusCode, headers: rs.headers, body: buf.toString('utf8') });
      });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('请求超时 15 s')); });
    r.on('error', reject);
    r.end();
  }).catch((e) => ({ status: 0, err: e.message }));

  if (res.status !== 200) {
    console.error('✕ HTTP ' + (res.status || '连接失败') + (res.err ? '  ' + res.err : ''));
    if (res.status === 401) console.error('   401 = 身份认证不过。查 kid / iss / sub 是否抄错，或上传的公钥与本地私钥不是一对（比对 --genkey 打印的 SHA256）。');
    else if (res.status === 403) console.error('   403 = 认证通过但没权限。多半是控制台里没启用「天气预报」，或凭据的「API限制」把 /weather/v1/* 挡住了。');
    else if (res.status === 404) console.error('   404 = 路径或 API Host 不对。确认用的是控制台-设置里的专属 Host，不是公共域名。');
    else if (res.status === 429) console.error('   429 = 触发限流，稍后再试。');
    if (res.body) console.error('   响应：' + res.body.slice(0, 300));
    return 1;
  }

  let j;
  try { j = JSON.parse(res.body); } catch (e) { console.error('✕ 返回不是 JSON：' + res.body.slice(0, 200)); return 1; }

  const v = (o) => (o && typeof o === 'object' && 'value' in o ? o.value : o);
  console.log('✓ HTTP 200，链路通。北京实况：');
  console.log('   天气      ' + (j.condition && j.condition.text));
  console.log('   气温      ' + v(j.temperature) + ' °C     露点 ' + v(j.dewPoint) + ' °C');
  console.log('   相对湿度  ' + j.humidity + '   （0~1，不是百分数）');
  console.log('   海平面气压 ' + v(j.pressure) + ' hPa');
  console.log('   降水强度  ' + v(j.precipitation && j.precipitation.intensity) + ' mm/h   类型 ' + (j.precipitation && j.precipitation.type));
  console.log('   云量      ' + j.cloudCover + '     风 ' + v(j.wind && j.wind.speed) + ' m/s @ ' + (j.wind && j.wind.direction && j.wind.direction.degree) + '°');

  // 把真数据喂进派生量，确认 adapter 口径对得上（这一步才是「能不能算」的证明）
  const snap = {
    t: Date.now(), kind: 'obs', tC: v(j.temperature), pMslHpa: v(j.pressure),
    rh: j.humidity, tdC: v(j.dewPoint),
    rainMmH: v(j.precipitation && j.precipitation.intensity) || 0,
    precipType: (j.precipitation && j.precipitation.type) || 'none',
    cloud: j.cloudCover, windMs: v(j.wind && j.wind.speed),
    src: 'qweather', attrib: (j.metadata && j.metadata.attributions) || []
  };
  const d = M.derive(snap, 0.045);
  console.log('\n✓ 派生量（喂 P.676 / P.618 的那几个）：');
  console.log('   水汽压 e   ' + d.e.toFixed(2) + ' hPa');
  console.log('   水汽密度 ρ ' + d.rho.toFixed(2) + ' g/m³   （统计分支从 P.836 地图取，这里是实测）');
  console.log('   N_wet      ' + d.nWet.toFixed(1) + '        （引擎里原先全球写死 42）');
  console.log('   站点气压   ' + d.psHpa.toFixed(1) + ' hPa   （由海平面值按海拔 45 m 折算）');
  if (d.warn.length) console.log('   告警：' + d.warn.join('；'));
  console.log('\n   归因（许可要求随数据显示）：' + (snap.attrib.join(' ') || '(响应未带)'));
  return 0;
}

if (args.has('--genkey')) { genKey(); }
else if (args.has('--check')) { process.exit(check()); }
else if (args.has('--test')) { liveTest().then((c) => process.exit(c)).catch((e) => { console.error('✕ ' + e.message); process.exit(1); }); }
else if (args.has('--set')) { process.exit(setNonInteractive()); }
else if (!process.stdin.isTTY) {
  console.error('✕ 非终端环境下向导会丢输入。请改用：\n'
    + '  node scripts/setup-weather-config.mjs --set --apiHost=… --iss=… --sub=… --kid=…');
  process.exit(1);
} else { wizard().catch((e) => { console.error('✕ ' + e.message); process.exit(1); }); }
