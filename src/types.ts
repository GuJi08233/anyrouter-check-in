export interface Env {
  BROWSER: unknown;
  APP_KV: KVNamespace;
  PANEL_PASSWORD?: string;
}

export interface ProviderConfigData {
  domain: string;
  login_path?: string;
  sign_in_path?: string | null;
  user_info_path?: string;
  api_user_key?: string;
  bypass_method?: 'waf_cookies' | null;
  waf_cookie_names?: string[];
}

export interface AccountConfigData {
  enabled?: boolean;
  name?: string;
  site_type?: 'anyrouter' | 'newapi';
  provider?: string;
  cookies?: Record<string, string> | string;
  api_user?: string;
  token?: string;
  site_url?: string;
  balance_divisor?: number;
}

export interface TelegramConfig {
  enabled?: boolean;
  botToken?: string;
  chatId?: string;
}

export interface WebhookConfig {
  enabled?: boolean;
  webhook?: string;
}

export interface TokenConfig {
  enabled?: boolean;
  token?: string;
}

export interface GotifyConfig {
  enabled?: boolean;
  url?: string;
  token?: string;
  priority?: number;
}

export interface BarkConfig {
  enabled?: boolean;
  key?: string;
  server?: string;
}

export interface NotificationConfig {
  telegram?: TelegramConfig;
  dingding?: WebhookConfig;
  feishu?: WebhookConfig;
  weixin?: WebhookConfig;
  pushplus?: TokenConfig;
  serverChan?: TokenConfig;
  gotify?: GotifyConfig;
  bark?: BarkConfig;
}

export interface ManagedConfig {
  accounts: AccountConfigData[];
  providers: Record<string, ProviderConfigData>;
  notifications: NotificationConfig;
}

export interface UserInfoResult {
  success: boolean;
  quota?: number;
  usedQuota?: number;
  error?: string;
}

export interface CheckInDetail {
  name: string;
  beforeQuota: number;
  beforeUsed: number;
  afterQuota: number;
  afterUsed: number;
  checkInReward: number;
  usageIncrease: number;
  balanceChange: number;
}

export interface CheckInResult {
  success: boolean;
  userInfoBefore: UserInfoResult | null;
  userInfoAfter: UserInfoResult | null;
  detail?: CheckInDetail;
}

export interface RunAllResult {
  successCount: number;
  totalCount: number;
  notificationContent: string[];
  needNotify: boolean;
}
