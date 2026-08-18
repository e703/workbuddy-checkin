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

// ---------- 1. 读取登录态 ----------
function loadAuth() {
  let raw;
  try {
    raw = readFileSync(AUTH_FILE, 'utf8');
  } catch (e) {
    throw new Error(`登录态文件不可读: ${AUTH_FILE} (${e.message})。请先登录 WorkBuddy 桌面端。`);
  }
  let j;
  try { j = JSON.parse(raw); } catch (e) { throw new Error('登录态文件不是有效 JSON: ' + e.message); }
  const token = j?.auth?.accessToken;
  const uid = j?.account?.uid;
  const nick = j?.account?.nickname;
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
