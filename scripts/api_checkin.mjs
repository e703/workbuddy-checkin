#!/usr/bin/env node
// WorkBuddy 每日签到 - API 版（Buddy加油站）
// 原理：读取 WorkBuddy 桌面端本地登录态文件，直接调用签到 API。
//       纯 HTTP 调用，不依赖任何 GUI/屏幕焦点，锁屏/息屏/无头环境均可运行。
// 用法：
//   node api_checkin.mjs            # 完整流程：随机延迟→查状态→可领则领→复核（幂等）
//   node api_checkin.mjs --status   # 只读查询，不领取（不延迟）
//   node api_checkin.mjs --no-jitter # 完整流程但跳过随机延迟
// 随机延迟（防风控）：默认签到前随机等待 5~35 分钟，可用环境变量调整：
//   WORKBUDDY_JITTER_MIN_SEC / WORKBUDDY_JITTER_MAX_SEC（设为 0 关闭）
// 参考：github.com/SIMON-WORLD/workbuddy-daily-credit（Python 原版）
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const API_BASE = process.env.WORKBUDDY_API_BASE || 'https://copilot.tencent.com';

function defaultAuthFile() {
  const rel = path.join('CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), rel);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', rel);
  }
  // Linux 等其他平台候选
  return path.join(os.homedir(), '.config', rel);
}

const AUTH_FILE = process.env.WORKBUDDY_AUTH_FILE || defaultAuthFile();

const STATUS_ONLY = process.argv.includes('--status');

// ---------- 0. 构造客户端 User-Agent（模拟桌面端，防风控） ----------
// 版本号动态取自安装目录 app.asar 内的 package.json，客户端升级后自动跟随。
// 可用环境变量 WORKBUDDY_UA 完全覆盖。
function readAppVersion() {
  const candidates =
    process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WorkBuddy', 'resources', 'app.asar')]
      : process.platform === 'darwin'
        ? ['/Applications/WorkBuddy.app/Contents/Resources/app.asar']
        : [];
  for (const asar of candidates) {
    try {
      const b = readFileSync(asar);
      // asar 头部 JSON 从偏移 16 开始，括号配对找边界
      let end = -1, depth = 0, inStr = false, esc = false;
      for (let i = 16; i < b.length && end < 0; i++) {
        const c = b[i];
        if (esc) { esc = false; continue; }
        if (c === 92) { esc = true; continue; }
        if (c === 34) inStr = !inStr;
        if (inStr) continue;
        if (c === 123) depth++;
        if (c === 125) { depth--; if (depth === 0) end = i + 1; }
      }
      if (end < 0) continue;
      const hdr = JSON.parse(b.slice(16, end).toString('utf8'));
      const pj = hdr.files?.['package.json'];
      if (!pj) continue;
      const dataBase = 16 + Math.ceil((end - 16) / 4) * 4;
      const pkg = JSON.parse(b.slice(dataBase + Number(pj.offset), dataBase + Number(pj.offset) + pj.size).toString('utf8'));
      if (pkg.version) return pkg.version;
    } catch (e) { /* try next */ }
  }
  return null; // 读不到版本，用默认
}

function buildUserAgent() {
  if (process.env.WORKBUDDY_UA) return process.env.WORKBUDDY_UA;
  const ver = readAppVersion() || '5.3.14'; // 兜底版本
  const plat = process.platform === 'win32'
    ? 'Windows NT 10.0; Win64; x64'
    : process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : 'X11; Linux x86_64';
  // 结构与 Electron 客户端 navigator.userAgent 一致（Chrome/Electron 版本为构建期基准值）
  return `Mozilla/5.0 (${plat}) AppleWebKit/537.36 (KHTML, like Gecko) WorkBuddy/${ver} Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36`;
}

const USER_AGENT = buildUserAgent();

// ---------- 1. 读取登录态 ----------
// WorkBuddy v5.6+ 将登录态文件中的敏感字段（accessToken/nickname/phoneNumber）做静态加密：
// 字段值变为 { $wbEncrypted: 1, envelope: "<base64 JSON>" }。
// 加密方案（逆向自客户端 app.asar 的 at-rest-crypto 包，2026-09-28）：
//   key   = sha256(STATIC_SECRET 的 utf8 字节)         // 32 字节 AES-256 key
//   keyId = sha256(key).hex 前 16 位                     // 校验用，须与 envelope 内一致
//   AAD   = "WB-AAD\0" || 0x01 || lp("WBEV1") || lp("sym-v1") || u32(suite)
//           || lp(keyId) || 0x02 || 0x00 || 0x00         // lp=length-prefixed, 0x02=field framing
//   明文  = AES-256-GCM(key, nonce=12B, authTag=16B, AAD)
// STATIC_SECRET 是编译期嵌入魔改 Electron（electron.workbuddyStorage.loggerGet()）的静态钥，
// 同版本客户端全局一致（跨平台是否一致未验证，macOS 构建可能不同）；可用环境变量
// WORKBUDDY_STATIC_SECRET 覆盖（如 mac 端钥不同时在 launchd 中注入，无需改代码）。
// 客户端更换静态钥时需重新提取（见 README 维护注意 §5）。
const STATIC_SECRET = process.env.WORKBUDDY_STATIC_SECRET || 'Sik9U5aXhCdwTVEwsEySDOmDoB9r9ntFxHF1fst9LQI=';
const STATIC_KEY = crypto.createHash('sha256').update(STATIC_SECRET, 'utf8').digest();

function u32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; }
function lp(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]); }

function openEncryptedField(wrapper) {
  const env = JSON.parse(Buffer.from(wrapper.envelope, 'base64').toString('utf8'));
  const aad = Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]),
    lp('WBEV1'), lp('sym-v1'), u32(env.suite), lp(env.keyId),
    Buffer.from([2]), Buffer.from([0]), Buffer.from([0]),
  ]);
  const decipher = crypto.createDecipheriv('aes-256-gcm', STATIC_KEY, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(env.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(env.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

function unwrapField(value, label) {
  if (typeof value === 'string') return value;               // 旧版客户端：明文
  if (value && value.$wbEncrypted === 1 && typeof value.envelope === 'string') {
    try { return openEncryptedField(value); }
    catch (e) { throw new Error(`解密 ${label} 失败（客户端可能已更换静态钥）: ${e.message}`); }
  }
  return undefined;
}

function loadAuth() {
  let raw;
  try {
    raw = readFileSync(AUTH_FILE, 'utf8');
  } catch (e) {
    throw new Error(`登录态文件不可读: ${AUTH_FILE} (${e.message})。请先登录 WorkBuddy 桌面端。`);
  }
  let j;
  try { j = JSON.parse(raw); } catch (e) { throw new Error('登录态文件不是有效 JSON: ' + e.message); }
  const token = unwrapField(j?.auth?.accessToken, 'accessToken');
  const uid = j?.account?.uid;
  const nick = unwrapField(j?.account?.nickname, 'nickname');
  const expiresAt = j?.auth?.expiresAt;
  if (!token || !uid) throw new Error('登录态文件中缺少 accessToken/uid，可能未登录');
  if (expiresAt && Date.now() > expiresAt) throw new Error('accessToken 已过期(expiresAt)，请打开 WorkBuddy 重新登录以刷新');
  return { token, uid, nick, expiresAt };
}

// ---------- 2. API 调用（node:https，避免 undici 退出崩溃） ----------
function api(endpoint, token, uid) {
  return new Promise((resolve, reject) => {
    const u = new URL(API_BASE + endpoint);
    const body = JSON.stringify({ uid });
    const req = httpsRequest({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = { raw: data.slice(0, 300) }; }
        resolve({ httpStatus: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时(15s)')); });
    req.on('error', (e) => { e.cause = e.cause || { code: e.code }; reject(e); });
    req.end(body);
  });
}

function mask(obj) {
  // 脱敏：只保留业务字段，避免日志泄露
  const s = JSON.stringify(obj);
  return s.length > 500 ? s.slice(0, 500) + '...' : s;
}

// ---------- 主流程 ----------
async function main() {
  console.log('=== WorkBuddy 每日签到 (API 版) ===');
  console.log(`时间: ${new Date().toLocaleString()}`);

  // 随机延迟（防风控）：完整签到模式下先随机等待
  if (!STATUS_ONLY && !process.argv.includes('--no-jitter')) {
    const minSec = Number(process.env.WORKBUDDY_JITTER_MIN_SEC ?? 300);   // 默认 5 分钟
    const maxSec = Number(process.env.WORKBUDDY_JITTER_MAX_SEC ?? 2100);  // 默认 35 分钟
    if (maxSec > 0) {
      const lo = Math.max(0, Math.min(minSec, maxSec));
      const delaySec = lo + Math.floor(Math.random() * (maxSec - lo + 1));
      console.log(`[0/3] 随机延迟 ${delaySec} 秒（${Math.round(delaySec / 60)} 分钟）后签到...`);
      await new Promise((r) => setTimeout(r, delaySec * 1000));
      console.log(`延迟结束: ${new Date().toLocaleString()}`);
    }
  }

  const { token, uid, nick, expiresAt } = loadAuth();
  console.log(`账号: ${nick} (${uid})`);
  console.log(`token 有效期至: ${expiresAt ? new Date(expiresAt).toLocaleString() : '未知'}`);
  console.log(`User-Agent: ${USER_AGENT}`);

  // 查询签到状态
  console.log('\n[1/3] 查询今日签到状态...');
  const st = await api('/v2/billing/meter/checkin-activity-status', token, uid);
  console.log(`  HTTP ${st.httpStatus} -> ${mask(st.body)}`);
  if (st.httpStatus === 401 || st.httpStatus === 403) {
    console.log('[错误] 登录态失效，请打开 WorkBuddy 重新登录');
    process.exit(2);
  }
  if (st.httpStatus !== 200) {
    console.log('[错误] 状态查询失败（接口可能已变更）');
    process.exit(4);
  }

  if (STATUS_ONLY) {
    console.log('\n=== 只读查询完成 ===');
    process.exit(0);
  }

  // 判断是否已签（实际字段 today_checked_in，兼容其他候选）
  const data = st.body?.data ?? st.body;
  const checkedIn = data?.today_checked_in ?? data?.checkedIn ?? data?.isCheckedIn ?? null;
  if (checkedIn === true) {
    console.log(`\n今日已签到（连续 ${data?.streak_days ?? '?'} 天，今日 +${data?.today_credit ?? '?'} 积分），无需领取。`);
    process.exit(0);
  }
  if (checkedIn === false) console.log('\n[2/3] 今日未签到，执行领取...');
  else console.log('\n[2/3] 无法确定签到状态字段，尝试直接领取(幂等)...');

  const claim = await api('/v2/billing/meter/daily-checkin', token, uid);
  console.log(`  HTTP ${claim.httpStatus} -> ${mask(claim.body)}`);
  if (claim.httpStatus !== 200) {
    console.log('[错误] 领取失败');
    process.exit(4);
  }

  // 复核
  console.log('\n[3/3] 复核签到状态...');
  await new Promise((r) => setTimeout(r, 1500));
  const verify = await api('/v2/billing/meter/checkin-activity-status', token, uid);
  const vData = verify.body?.data ?? verify.body;
  const vChecked = vData?.today_checked_in ?? vData?.checkedIn ?? vData?.isCheckedIn ?? null;
  console.log(`  HTTP ${verify.httpStatus} -> ${mask(verify.body)}`);

  if (vChecked === true) {
    console.log(`\n=== 签到成功（今日 +${vData?.today_credit ?? '?'} 积分，连续 ${vData?.streak_days ?? '?'} 天）===`);
    process.exit(0);
  } else {
    console.log('\n=== 领取请求已发出，但复核状态未能确认，请以积分余额为准 ===');
    process.exit(0);  // 请求已成功返回200，不算失败
  }
}

main().catch((e) => {
  // 网络类错误
  if (e.cause?.code || /fetch|network|ENOTFOUND|ETIMEDOUT|ECONN/i.test(e.message)) {
    console.error('[失败] 网络异常: ' + (e.cause?.code || e.message));
    process.exit(3);
  }
  console.error('[失败] ' + e.message);
  process.exit(1);
});
