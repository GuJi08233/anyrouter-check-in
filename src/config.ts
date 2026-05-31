import type {
  AccountConfigData,
  Env,
  ManagedConfig,
  NotificationConfig,
  ProviderConfigData,
} from './types';

export const CONFIG_KEY = 'managed_config';
export const BALANCE_HASH_KEY = 'balance_hash';
export const LAST_RUN_KEY = 'last_run';
export const SESSION_TOKEN_KEY = 'session_token';

export const DEFAULT_PROVIDERS: Record<string, ProviderConfigData> = {
  anyrouter: {
    domain: 'https://anyrouter.top',
    login_path: '/login',
    sign_in_path: '/api/user/sign_in',
    user_info_path: '/api/user/self',
    api_user_key: 'new-api-user',
    bypass_method: 'waf_cookies',
    waf_cookie_names: ['acw_tc', 'cdn_sec_tc', 'acw_sc__v2'],
  },
};

export class ProviderConfig {
  name: string;
  domain: string;
  loginPath: string;
  signInPath: string | null;
  userInfoPath: string;
  apiUserKey: string;
  bypassMethod: 'waf_cookies' | null;
  wafCookieNames: string[];

  constructor(name: string, data: ProviderConfigData) {
    this.name = name;
    this.domain = data.domain.replace(/\/+$/, '');
    this.loginPath = data.login_path ?? '/login';
    this.signInPath = data.sign_in_path === undefined ? '/api/user/sign_in' : data.sign_in_path;
    this.userInfoPath = data.user_info_path ?? '/api/user/self';
    this.apiUserKey = data.api_user_key ?? 'new-api-user';
    this.bypassMethod = data.bypass_method ?? null;
    this.wafCookieNames = (data.waf_cookie_names ?? [])
      .map((cookieName) => cookieName.trim())
      .filter((cookieName) => cookieName.length > 0);

    if (this.wafCookieNames.length === 0) {
      this.bypassMethod = null;
    }
  }

  needsWafCookies(): boolean {
    return this.bypassMethod === 'waf_cookies';
  }

  needsManualCheckIn(): boolean {
    return this.signInPath !== null;
  }
}

export class AccountConfig {
  enabled: boolean;
  cookies: Record<string, string> | string;
  apiUser: string;
  provider: string;
  name: string | null;

  constructor(data: AccountConfigData, index: number) {
    this.enabled = data.enabled !== false;
    this.cookies = data.cookies;
    this.apiUser = data.api_user;
    this.provider = data.provider ?? 'anyrouter';
    this.name = data.name?.trim() ? data.name.trim() : null;
  }

  getDisplayName(index: number): string {
    return this.name ?? `Account ${index + 1}`;
  }
}

export class AppConfig {
  providers: Record<string, ProviderConfig>;
  accounts: AccountConfig[];
  notifications: NotificationConfig;

  constructor(managedConfig: ManagedConfig) {
    this.providers = {};
    this.accounts = managedConfig.accounts.map((account, index) => new AccountConfig(account, index));
    this.notifications = managedConfig.notifications;

    for (const [name, provider] of Object.entries({
      ...DEFAULT_PROVIDERS,
      ...managedConfig.providers,
    })) {
      this.providers[name] = new ProviderConfig(name, provider);
    }
  }

  getProvider(name: string): ProviderConfig | undefined {
    return this.providers[name];
  }
}

export function emptyManagedConfig(): ManagedConfig {
  return {
    accounts: [],
    providers: {},
    notifications: {},
  };
}

export function parseCookies(cookiesData: Record<string, string> | string): Record<string, string> {
  if (typeof cookiesData === 'object' && cookiesData !== null) {
    return cookiesData;
  }

  if (typeof cookiesData === 'string') {
    const cookiesDict: Record<string, string> = {};
    for (const cookie of cookiesData.split(';')) {
      const splitAt = cookie.indexOf('=');
      if (splitAt > 0) {
        cookiesDict[cookie.substring(0, splitAt).trim()] = cookie.substring(splitAt + 1).trim();
      }
    }
    return cookiesDict;
  }

  return {};
}

export function getLocalTimeStr(): string {
  const now = new Date();
  const beijingOffset = 8 * 60 * 60 * 1000;
  const beijingTime = new Date(now.getTime() + beijingOffset + now.getTimezoneOffset() * 60 * 1000);
  return beijingTime.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

export async function generateBalanceHash(balances: Record<string, { quota: number }>): Promise<string> {
  const simpleBalances: Record<string, number> = {};
  for (const [key, value] of Object.entries(balances)) {
    simpleBalances[key] = value.quota;
  }

  const sortedKeys = Object.keys(simpleBalances).sort();
  const balanceJson = JSON.stringify(simpleBalances, sortedKeys);
  const data = new TextEncoder().encode(balanceJson);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

export async function loadBalanceHash(kv: KVNamespace): Promise<string | null> {
  try {
    return await kv.get(BALANCE_HASH_KEY);
  } catch {
    return null;
  }
}

export async function saveBalanceHash(kv: KVNamespace, hash: string): Promise<void> {
  try {
    await kv.put(BALANCE_HASH_KEY, hash);
  } catch (error) {
    console.log(`Warning: Failed to save balance hash: ${error}`);
  }
}

export async function loadLastRun(kv: KVNamespace): Promise<unknown> {
  const value = await kv.get(LAST_RUN_KEY);
  return value ? JSON.parse(value) : null;
}

export async function saveLastRun(kv: KVNamespace, value: unknown): Promise<void> {
  await kv.put(LAST_RUN_KEY, JSON.stringify(value, null, 2));
}

export async function loadManagedConfig(env: Env): Promise<ManagedConfig> {
  const stored = await env.APP_KV.get(CONFIG_KEY);
  if (stored) {
    return normalizeManagedConfig(JSON.parse(stored) as Partial<ManagedConfig>);
  }

  return emptyManagedConfig();
}

export async function saveManagedConfig(env: Env, config: ManagedConfig): Promise<ManagedConfig> {
  const normalized = normalizeManagedConfig(config);
  await env.APP_KV.put(CONFIG_KEY, JSON.stringify(normalized, null, 2));
  return normalized;
}

export function buildAppConfig(managedConfig: ManagedConfig): AppConfig {
  return new AppConfig(managedConfig);
}

export function validateManagedConfig(config: ManagedConfig): string[] {
  const errors: string[] = [];

  for (const [index, account] of config.accounts.entries()) {
    if (account.enabled === false) {
      continue;
    }
    if (!account.api_user?.trim()) {
      errors.push(`账号 ${index + 1} 缺少 api_user`);
    }
    if (!account.cookies || Object.keys(parseCookies(account.cookies)).length === 0) {
      errors.push(`账号 ${index + 1} 缺少有效 cookies`);
    }
  }

  const mergedProviders = {
    ...DEFAULT_PROVIDERS,
    ...config.providers,
  };

  for (const [name, provider] of Object.entries(mergedProviders)) {
    if (!provider.domain?.trim()) {
      errors.push(`Provider ${name} 缺少 domain`);
    }
    if (provider.bypass_method === 'waf_cookies' && (!provider.waf_cookie_names || provider.waf_cookie_names.length === 0)) {
      errors.push(`Provider ${name} 启用 WAF 绕过时必须配置 waf_cookie_names`);
    }
  }

  for (const account of config.accounts) {
    if (account.enabled === false) {
      continue;
    }
    const providerName = account.provider ?? 'anyrouter';
    if (!mergedProviders[providerName]) {
      errors.push(`账号 ${account.name ?? account.api_user} 引用了不存在的 Provider：${providerName}`);
    }
  }

  return errors;
}

function normalizeManagedConfig(config: Partial<ManagedConfig>): ManagedConfig {
  return {
    accounts: Array.isArray(config.accounts) ? config.accounts.map(normalizeAccount) : [],
    providers: normalizeProviders(config.providers),
    notifications: normalizeNotifications(config.notifications),
  };
}

function normalizeAccount(account: AccountConfigData): AccountConfigData {
  return {
    enabled: account.enabled !== false,
    name: account.name?.trim() || undefined,
    provider: account.provider?.trim() || 'anyrouter',
    cookies: account.cookies,
    api_user: account.api_user?.trim() ?? '',
  };
}

function normalizeProviders(providers: ManagedConfig['providers'] | undefined): Record<string, ProviderConfigData> {
  const result: Record<string, ProviderConfigData> = {};
  if (!providers || typeof providers !== 'object') {
    return result;
  }

  for (const [name, provider] of Object.entries(providers)) {
    if (!name.trim() || !provider?.domain) {
      continue;
    }

    result[name.trim()] = {
      domain: provider.domain.trim().replace(/\/+$/, ''),
      login_path: provider.login_path?.trim() || '/login',
      sign_in_path: provider.sign_in_path === undefined ? '/api/user/sign_in' : normalizeNullablePath(provider.sign_in_path),
      user_info_path: provider.user_info_path?.trim() || '/api/user/self',
      api_user_key: provider.api_user_key?.trim() || 'new-api-user',
      bypass_method: provider.bypass_method === 'waf_cookies' ? 'waf_cookies' : null,
      waf_cookie_names: (provider.waf_cookie_names ?? []).map((namePart) => namePart.trim()).filter(Boolean),
    };
  }

  return result;
}

function normalizeNullablePath(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeNotifications(notifications: NotificationConfig | undefined): NotificationConfig {
  const source = notifications ?? {};
  return {
    telegram: {
      enabled: Boolean(source.telegram?.enabled),
      botToken: source.telegram?.botToken?.trim() || undefined,
      chatId: source.telegram?.chatId?.trim() || undefined,
    },
    dingding: normalizeWebhook(source.dingding),
    feishu: normalizeWebhook(source.feishu),
    weixin: normalizeWebhook(source.weixin),
    pushplus: normalizeToken(source.pushplus),
    serverChan: normalizeToken(source.serverChan),
    gotify: {
      enabled: Boolean(source.gotify?.enabled),
      url: source.gotify?.url?.trim() || undefined,
      token: source.gotify?.token?.trim() || undefined,
      priority: clampPriority(source.gotify?.priority),
    },
    bark: {
      enabled: Boolean(source.bark?.enabled),
      key: source.bark?.key?.trim() || undefined,
      server: source.bark?.server?.trim() || 'https://api.day.app',
    },
  };
}

function normalizeWebhook(value: { enabled?: boolean; webhook?: string } | undefined): { enabled: boolean; webhook?: string } {
  return {
    enabled: Boolean(value?.enabled),
    webhook: value?.webhook?.trim() || undefined,
  };
}

function normalizeToken(value: { enabled?: boolean; token?: string } | undefined): { enabled: boolean; token?: string } {
  return {
    enabled: Boolean(value?.enabled),
    token: value?.token?.trim() || undefined,
  };
}

function clampPriority(value: number | undefined): number {
  if (!value || Number.isNaN(value)) {
    return 9;
  }
  return Math.max(1, Math.min(10, Math.trunc(value)));
}
