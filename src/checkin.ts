import puppeteer from '@cloudflare/puppeteer';

import {
  buildAppConfig,
  generateBalanceHash,
  getLocalTimeStr,
  loadBalanceHash,
  parseCookies,
  saveBalanceHash,
  saveLastRun,
  type AccountConfig,
  type ProviderConfig,
} from './config';
import type { CheckInDetail, CheckInResult, Env, ManagedConfig, RunAllResult, UserInfoResult } from './types';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

const STEALTH_SCRIPT = `(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
  try { Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] }); } catch (e) {}
  try { Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] }); } catch (e) {}
  try { window.chrome = window.chrome || { runtime: {} }; } catch (e) {}
  try {
    const q = window.navigator.permissions && window.navigator.permissions.query;
    if (q) {
      window.navigator.permissions.query = (p) =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : q(p);
    }
  } catch (e) {}
  try {
    const gp = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return gp.call(this, parameter);
    };
  } catch (e) {}
})();`;

export async function diagnoseWaf(env: Env, config: ManagedConfig, providerName: string): Promise<Record<string, unknown>> {
  const provider = buildAppConfig(config).getProvider(providerName);
  if (!provider) {
    return { ok: false, error: `Provider "${providerName}" not found` };
  }

  if (!provider.needsWafCookies()) {
    return { ok: true, provider: providerName, note: 'Provider does not require WAF cookies', required: [] };
  }

  const loginUrl = provider.domain + provider.loginPath;
  const required = provider.wafCookieNames;
  let browser: BrowserLike | null = null;

  try {
    browser = await puppeteer.launch(env.BROWSER as never) as unknown as BrowserLike;
    const page = await preparePage(browser);
    try {
      const response = await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      const got = await waitForWafCookies(page, required);
      const title = await page.title().catch(() => '');
      const allCookieNames = (await page.cookies()).map((cookie) => cookie.name);

      return {
        ok: required.every((cookieName) => Boolean(got[cookieName])),
        provider: providerName,
        loginUrl,
        status: response ? response.status() : 0,
        finalUrl: page.url(),
        title,
        required,
        obtained: Object.keys(got),
        missing: required.filter((cookieName) => !got[cookieName]),
        allCookieNames,
      };
    } finally {
      await page.close();
    }
  } catch (error) {
    return { ok: false, provider: providerName, loginUrl, error: String(error) };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export async function runAllCheckIns(
  env: Env,
  config: ManagedConfig,
  isManualRun: boolean,
  options: { includeDisabled?: boolean } = {},
): Promise<RunAllResult> {
  console.log('[SYSTEM] AnyRouter multi-account auto check-in started (Cloudflare Worker)');
  console.log(`[TIME] Execution time: ${getLocalTimeStr()}`);
  console.log(isManualRun ? '[INFO] Manual run detected' : '[INFO] Scheduled run detected');

  const appConfig = buildAppConfig(config);
  const accountEntries = appConfig.accounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => options.includeDisabled || account.enabled);
  const notificationContent: string[] = [];

  if (accountEntries.length === 0) {
    const result = {
      successCount: 0,
      totalCount: 0,
      notificationContent: [isManualRun ? '❗ 没有可运行账号，请先启用账号或勾选“包含禁用”' : 'ℹ️ 没有启用账号，定时任务已跳过'],
      needNotify: isManualRun,
    };
    await saveLastRun(env.APP_KV, { ...result, time: getLocalTimeStr(), manual: isManualRun });
    return result;
  }

  const lastBalanceHash = await loadBalanceHash(env.APP_KV);
  const currentBalances: Record<string, { quota: number }> = {};
  const accountDetails: CheckInDetail[] = [];
  let successCount = 0;
  let needNotify = false;
  let balanceChanged = false;

  for (const { account, index } of accountEntries) {
    const accountName = account.getDisplayName(index);
    const provider = appConfig.getProvider(account.provider);

    if (!provider) {
      console.log(`[FAILED] ${accountName}: Provider "${account.provider}" not found`);
      needNotify = true;
      notificationContent.push(`【失败】**${accountName}** - 未找到 Provider：${account.provider}`);
      continue;
    }

    try {
      const result = await checkInAccount(env, account, index, provider);
      if (result.success) {
        successCount++;
      } else {
        needNotify = true;
        notificationContent.push(formatFailedNotification(accountName, result));
      }

      if (result.detail) {
        currentBalances[`account_${index + 1}`] = { quota: result.detail.afterQuota };
        accountDetails.push(result.detail);
      }
    } catch (error) {
      console.log(`[FAILED] ${accountName}: ${error}`);
      needNotify = true;
      notificationContent.push(`【失败】**${accountName}** - ${String(error).substring(0, 80)}`);
    }
  }

  if (Object.keys(currentBalances).length > 0) {
    const currentHash = await generateBalanceHash(currentBalances);
    if (!lastBalanceHash || currentHash !== lastBalanceHash) {
      balanceChanged = true;
      needNotify = true;
    }
    await saveBalanceHash(env.APP_KV, currentHash);
  }

  if (balanceChanged || isManualRun) {
    for (const detail of accountDetails) {
      if (!notificationContent.some((item) => item.includes(detail.name))) {
        notificationContent.push(formatCheckInNotification(detail));
      }
    }
  }

  const summary = [
    '【统计】签到结果统计：',
    `✅ 成功: ${successCount}/${accountEntries.length}  |  ❌ 失败: ${accountEntries.length - successCount}/${accountEntries.length}`,
    successCount === accountEntries.length ? '🎉 全部账号签到成功！' : successCount > 0 ? '⚠️ 部分账号签到成功' : '❗ 全部账号签到失败',
  ].join('\n');

  if (notificationContent.length > 0) {
    notificationContent.unshift(summary);
  }

  if (!isManualRun && !balanceChanged && successCount === accountEntries.length) {
    needNotify = false;
    console.log('[INFO] No balance changes and all check-ins successful, skipping notification');
  }

  const runResult = {
    successCount,
    totalCount: accountEntries.length,
    notificationContent,
    needNotify,
  };
  await saveLastRun(env.APP_KV, {
    ...runResult,
    balanceChanged,
    time: getLocalTimeStr(),
    manual: isManualRun,
  });

  return runResult;
}

export async function checkInAccount(
  env: Env,
  account: AccountConfig,
  accountIndex: number,
  provider: ProviderConfig,
): Promise<CheckInResult> {
  const accountName = account.getDisplayName(accountIndex);
  console.log(`\n[PROCESSING] Starting to process ${accountName}`);
  console.log(`[INFO] ${accountName}: Using provider "${provider.name}" (${provider.domain})`);

  const userCookies = parseCookies(account.cookies);
  if (Object.keys(userCookies).length === 0) {
    console.log(`[FAILED] ${accountName}: Invalid cookies`);
    return { success: false, userInfoBefore: null, userInfoAfter: null };
  }

  if (provider.needsWafCookies()) {
    return await checkInViaBrowser(env, account, accountName, provider, userCookies);
  }

  return await checkInViaFetch(account, accountName, provider, userCookies);
}

export function formatCheckInNotification(detail: CheckInDetail): string {
  const lines = [
    `【签到】**${detail.name}**`,
    '  ━━━━━━━━━━━━━━━━━━━━',
    '  📍 签到前',
    `     💵 余额: $${detail.beforeQuota.toFixed(2)}  |  📊 累计消耗: $${detail.beforeUsed.toFixed(2)}`,
    '  📍 签到后',
    `     💵 余额: $${detail.afterQuota.toFixed(2)}  |  📊 累计消耗: $${detail.afterUsed.toFixed(2)}`,
  ];

  const hasReward = detail.checkInReward !== 0;
  const hasUsage = detail.usageIncrease !== 0;

  lines.push('  ━━━━━━━━━━━━━━━━━━━━');
  if (!hasReward && !hasUsage) {
    lines.push('  ℹ️  今日已签到，暂无变化');
  }
  if (!hasReward && hasUsage) {
    lines.push('  ℹ️  今日已签到（期间有消耗）');
  }
  if (hasReward) {
    lines.push(`  🎁 签到奖励: +$${detail.checkInReward.toFixed(2)}`);
  }
  if (hasUsage) {
    lines.push(`  📉 期间消耗: $${detail.usageIncrease.toFixed(2)}`);
  }
  if (detail.balanceChange !== 0) {
    const changeSymbol = detail.balanceChange > 0 ? '+' : '';
    const changeEmoji = detail.balanceChange > 0 ? '📈' : '📉';
    lines.push(`  ${changeEmoji} 余额变动: ${changeSymbol}$${detail.balanceChange.toFixed(2)}`);
  }

  return lines.join('\n');
}

function formatFailedNotification(accountName: string, result: CheckInResult): string {
  return `【失败】**${accountName}** - ${result.userInfoBefore?.error ?? result.userInfoAfter?.error ?? '签到失败'}`;
}

async function checkInViaBrowser(
  env: Env,
  account: AccountConfig,
  accountName: string,
  provider: ProviderConfig,
  userCookies: Record<string, string>,
): Promise<CheckInResult> {
  let browser: BrowserLike | null = null;

  try {
    browser = await puppeteer.launch(env.BROWSER as never) as unknown as BrowserLike;
    const page = await preparePage(browser);
    try {
      const hostname = new URL(provider.domain).hostname;
      const cookieParams = Object.entries(userCookies).map(([name, value]) => ({
        name,
        value,
        domain: hostname,
        path: '/',
      }));

      if (cookieParams.length > 0) {
        await page.setCookie(...cookieParams);
      }

      const loginUrl = provider.domain + provider.loginPath;
      console.log(`[PROCESSING] ${accountName}: Loading page to pass WAF...`);
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((error) => {
        console.log(`[INFO] ${accountName}: Navigation note: ${error}`);
      });

      if (provider.wafCookieNames.length > 0) {
        await waitForWafCookies(page, provider.wafCookieNames);
      }

      const userInfoUrl = provider.domain + provider.userInfoPath;
      const beforeResponse = await inPageFetch(page, userInfoUrl, 'GET', provider.apiUserKey, account.apiUser);
      const userInfoBefore = parseUserInfo(beforeResponse.status, beforeResponse.text);
      logUserInfo(accountName, userInfoBefore);

      let success = true;
      if (provider.needsManualCheckIn()) {
        const signInUrl = provider.domain + provider.signInPath;
        const signInResponse = await inPageFetch(page, signInUrl, 'POST', provider.apiUserKey, account.apiUser);
        console.log(`[RESPONSE] ${accountName}: sign_in HTTP ${signInResponse.status}`);
        success = parseSignIn(signInResponse.status, signInResponse.text, accountName);
      } else {
        console.log(`[INFO] ${accountName}: Check-in completed automatically (triggered by user info request)`);
      }

      const afterResponse = await inPageFetch(page, userInfoUrl, 'GET', provider.apiUserKey, account.apiUser);
      const userInfoAfter = parseUserInfo(afterResponse.status, afterResponse.text);

      return {
        success,
        userInfoBefore,
        userInfoAfter,
        detail: buildDetail(accountName, userInfoBefore, userInfoAfter),
      };
    } finally {
      await page.close();
    }
  } catch (error) {
    console.log(`[FAILED] ${accountName}: Browser check-in error: ${error}`);
    return { success: false, userInfoBefore: null, userInfoAfter: null };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function checkInViaFetch(
  account: AccountConfig,
  accountName: string,
  provider: ProviderConfig,
  userCookies: Record<string, string>,
): Promise<CheckInResult> {
  console.log(`[INFO] ${accountName}: Bypass WAF not required, using Worker fetch directly`);
  const cookieString = cookiesToString(userCookies);
  const headers: Record<string, string> = {
    'User-Agent': DESKTOP_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: provider.domain,
    Origin: provider.domain,
    [provider.apiUserKey]: account.apiUser,
  };

  const userInfoUrl = provider.domain + provider.userInfoPath;
  const userInfoBefore = await getUserInfo(userInfoUrl, headers, cookieString);
  logUserInfo(accountName, userInfoBefore);

  let success = true;
  if (provider.needsManualCheckIn()) {
    const signInUrl = provider.domain + provider.signInPath;
    success = await executeCheckIn(signInUrl, headers, cookieString, accountName);
  } else {
    console.log(`[INFO] ${accountName}: Check-in completed automatically (triggered by user info request)`);
  }

  const userInfoAfter = await getUserInfo(userInfoUrl, headers, cookieString);
  return {
    success,
    userInfoBefore,
    userInfoAfter,
    detail: buildDetail(accountName, userInfoBefore, userInfoAfter),
  };
}

async function preparePage(browser: BrowserLike): Promise<PageLike> {
  const page = await browser.newPage();
  await page.setUserAgent(DESKTOP_UA);
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });
  await page.evaluateOnNewDocument(STEALTH_SCRIPT);
  return page;
}

async function waitForWafCookies(page: PageLike, required: string[]): Promise<Record<string, string>> {
  let got: Record<string, string> = {};

  for (let attempt = 0; attempt < 20; attempt++) {
    const cookies = await page.cookies();
    got = {};
    for (const cookie of cookies) {
      if (required.includes(cookie.name) && cookie.value) {
        got[cookie.name] = cookie.value;
      }
    }
    if (required.every((cookieName) => got[cookieName])) {
      break;
    }
    await sleep(1000);
  }

  return got;
}

async function inPageFetch(
  page: PageLike,
  url: string,
  method: 'GET' | 'POST',
  apiUserKey: string,
  apiUser: string,
): Promise<{ status: number; text: string }> {
  const contentType = method === 'POST' ? ', "Content-Type": "application/json"' : '';
  const code = `(async () => {
    try {
      const res = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        headers: {
          [${JSON.stringify(apiUserKey)}]: ${JSON.stringify(apiUser)},
          "Accept": "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest"${contentType}
        },
        credentials: "include"
      });
      const text = await res.text();
      return { status: res.status, text };
    } catch (e) { return { status: 0, text: String(e) }; }
  })()`;

  try {
    return await page.evaluate(code) as { status: number; text: string };
  } catch (error) {
    return { status: 0, text: String(error) };
  }
}

async function getUserInfo(
  userInfoUrl: string,
  headers: Record<string, string>,
  cookieString: string,
): Promise<UserInfoResult> {
  try {
    const response = await fetch(userInfoUrl, {
      method: 'GET',
      headers: { ...headers, Cookie: cookieString },
    });

    return parseUserInfo(response.status, await response.text());
  } catch (error) {
    return { success: false, error: `获取用户信息失败：${String(error).substring(0, 50)}` };
  }
}

async function executeCheckIn(
  signInUrl: string,
  headers: Record<string, string>,
  cookieString: string,
  accountName: string,
): Promise<boolean> {
  console.log(`[NETWORK] ${accountName}: Executing check-in`);
  const response = await fetch(signInUrl, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: cookieString,
    },
  });
  return parseSignIn(response.status, await response.text(), accountName);
}

function parseUserInfo(status: number, text: string): UserInfoResult {
  if (status === 200) {
    try {
      const data = JSON.parse(text) as NewApiUserInfoResponse;
      if (data.success) {
        const userData = data.data ?? {};
        const quota = Math.round(((userData.quota ?? 0) / 500000) * 100) / 100;
        const usedQuota = Math.round(((userData.used_quota ?? 0) / 500000) * 100) / 100;
        return { success: true, quota, usedQuota };
      }
      return { success: false, error: `获取用户信息失败：响应未成功${data.message ? `（${data.message}）` : ''}` };
    } catch {
      return { success: false, error: `获取用户信息失败：非 JSON 响应（HTTP ${status}）` };
    }
  }

  return { success: false, error: `获取用户信息失败：HTTP ${status}` };
}

function parseSignIn(status: number, text: string, accountName: string): boolean {
  console.log(`[RESPONSE] ${accountName}: Response status code ${status}`);
  if (status !== 200) {
    console.log(`[FAILED] ${accountName}: Check-in failed - HTTP ${status}`);
    return false;
  }

  try {
    const result = JSON.parse(text) as NewApiSignInResponse;
    if (result.ret === 1 || result.code === 0 || result.success) {
      console.log(`[SUCCESS] ${accountName}: Check-in successful!`);
      return true;
    }

    const errorMsg = String(result.msg ?? result.message ?? 'Unknown error');
    const alreadyCheckedKeywords = ['已经签到', '已签到', '重复签到', 'already checked', 'already signed'];
    if (alreadyCheckedKeywords.some((keyword) => errorMsg.toLowerCase().includes(keyword.toLowerCase()))) {
      console.log(`[SUCCESS] ${accountName}: Already checked in today`);
      return true;
    }

    console.log(`[FAILED] ${accountName}: Check-in failed - ${errorMsg}`);
    return false;
  } catch {
    if (text.toLowerCase().includes('success')) {
      console.log(`[SUCCESS] ${accountName}: Check-in successful!`);
      return true;
    }
    console.log(`[FAILED] ${accountName}: Check-in failed - Invalid response format`);
    return false;
  }
}

function buildDetail(name: string, before: UserInfoResult, after: UserInfoResult): CheckInDetail | undefined {
  if (!before.success || !after.success) {
    return undefined;
  }

  const beforeQuota = before.quota ?? 0;
  const beforeUsed = before.usedQuota ?? 0;
  const afterQuota = after.quota ?? 0;
  const afterUsed = after.usedQuota ?? 0;

  return {
    name,
    beforeQuota,
    beforeUsed,
    afterQuota,
    afterUsed,
    checkInReward: afterQuota - beforeQuota + (afterUsed - beforeUsed),
    usageIncrease: afterUsed - beforeUsed,
    balanceChange: afterQuota - beforeQuota,
  };
}

function logUserInfo(accountName: string, userInfo: UserInfoResult): void {
  if (userInfo.success) {
    console.log(`[INFO] ${accountName}: Current balance: $${userInfo.quota}, Used: $${userInfo.usedQuota}`);
  } else if (userInfo.error) {
    console.log(`[FAILED] ${accountName}: ${userInfo.error}`);
  }
}

function cookiesToString(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; ');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

interface PageLike {
  setUserAgent(value: string): Promise<void>;
  setViewport(value: { width: number; height: number }): Promise<void>;
  setExtraHTTPHeaders(value: Record<string, string>): Promise<void>;
  evaluateOnNewDocument(value: string): Promise<unknown>;
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<{ status(): number } | null>;
  title(): Promise<string>;
  url(): string;
  cookies(): Promise<Array<{ name: string; value: string }>>;
  setCookie(...cookies: Array<{ name: string; value: string; domain: string; path: string }>): Promise<void>;
  evaluate(value: string): Promise<unknown>;
  close(): Promise<void>;
}

interface NewApiUserInfoResponse {
  success?: boolean;
  message?: string;
  data?: {
    quota?: number;
    used_quota?: number;
  };
}

interface NewApiSignInResponse {
  ret?: number;
  code?: number;
  success?: boolean;
  msg?: string;
  message?: string;
}
