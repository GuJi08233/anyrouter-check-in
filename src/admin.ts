import {
  DEFAULT_PROVIDERS,
  SESSION_TOKEN_KEY,
  loadLastRun,
  loadManagedConfig,
  saveManagedConfig,
  validateManagedConfig,
} from './config';
import type { Env, ManagedConfig } from './types';

export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token',
  };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, {
    ...init,
    headers: {
      ...corsHeaders(),
      ...(init.headers ?? {}),
    },
  });
}

export async function requireAuth(request: Request, env: Env): Promise<Response | null> {
  if (!env.PANEL_PASSWORD) {
    return jsonResponse(
      {
        success: false,
        error: 'PANEL_PASSWORD 未配置。请先执行 wrangler secret put PANEL_PASSWORD，再访问管理 API。',
      },
      { status: 403 },
    );
  }

  if (!(await isAuthorized(request, env))) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}

export async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  if (!env.PANEL_PASSWORD) {
    return false;
  }

  const url = new URL(request.url);
  const authHeader = request.headers.get('Authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
  const token = bearer ?? request.headers.get('X-Auth-Token') ?? url.searchParams.get('token');
  if (!token) {
    return false;
  }

  const storedToken = await env.APP_KV.get(SESSION_TOKEN_KEY);
  return token === storedToken;
}

export async function handleAdminApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === '/api/health') {
    return jsonResponse({
      status: 'ok',
      service: 'anyrouter-check-in-worker',
      authConfigured: Boolean(env.PANEL_PASSWORD),
      time: new Date().toISOString(),
    });
  }

  if (url.pathname === '/api/login' && request.method === 'POST') {
    if (!env.PANEL_PASSWORD) {
      return jsonResponse({ success: false, error: 'PANEL_PASSWORD 未配置' }, { status: 500 });
    }

    const body = await request.json().catch(() => ({})) as { password?: string };
    if (body.password !== env.PANEL_PASSWORD) {
      return jsonResponse({ success: false, error: '密码错误' }, { status: 401 });
    }

    const token = makeSessionToken();
    await env.APP_KV.put(SESSION_TOKEN_KEY, token);
    return jsonResponse({
      success: true,
      token,
      config: await loadManagedConfig(env),
      defaultProviders: DEFAULT_PROVIDERS,
      lastRun: await loadLastRun(env.APP_KV),
    });
  }

  if (!url.pathname.startsWith('/api/')) {
    return null;
  }

  const authError = await requireAuth(request, env);
  if (authError) {
    return authError;
  }

  if (url.pathname === '/api/logout' && request.method === 'POST') {
    await env.APP_KV.delete(SESSION_TOKEN_KEY);
    return jsonResponse({ success: true });
  }

  if (url.pathname === '/api/config' && request.method === 'GET') {
    const config = await loadManagedConfig(env);
    return jsonResponse({ success: true, config, defaultProviders: DEFAULT_PROVIDERS });
  }

  if (url.pathname === '/api/config' && request.method === 'PUT') {
    const body = await request.json() as ManagedConfig;
    const errors = validateManagedConfig(body);
    if (errors.length > 0) {
      return jsonResponse({ success: false, errors }, { status: 400 });
    }

    const config = await saveManagedConfig(env, body);
    return jsonResponse({ success: true, config });
  }

  if (url.pathname === '/api/status' && request.method === 'GET') {
    return jsonResponse({
      success: true,
      lastRun: await loadLastRun(env.APP_KV),
      authConfigured: Boolean(env.PANEL_PASSWORD),
    });
  }

  return null;
}

export function renderAdminPage(): Response {
  return new Response(adminHtml(), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function makeSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function adminHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AnyRouter Check-in</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #20242a;
      --muted: #68707d;
      --line: #dfe3e8;
      --accent: #0f766e;
      --accent-strong: #115e59;
      --danger: #b42318;
      --warn: #b45309;
      --soft: #eef7f5;
      --shadow: 0 12px 30px rgba(20, 28, 38, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.5;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.92);
      backdrop-filter: blur(10px);
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 12px;
      max-width: 1280px;
      margin: 0 auto;
      padding: 14px 20px;
    }
    .brand {
      display: flex;
      flex-direction: column;
      min-width: 190px;
      margin-right: auto;
    }
    .brand strong { font-size: 18px; letter-spacing: 0; }
    .brand span { color: var(--muted); font-size: 12px; }
    main {
      max-width: 1280px;
      margin: 0 auto;
      padding: 20px;
    }
    .layout {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }
    nav {
      position: sticky;
      top: 78px;
      display: grid;
      gap: 8px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    nav button {
      justify-content: flex-start;
      width: 100%;
      background: transparent;
      color: var(--text);
      border-color: transparent;
    }
    nav button.active {
      background: var(--soft);
      border-color: #b7ded8;
      color: var(--accent-strong);
    }
    section {
      display: none;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    section.active { display: block; }
    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 18px;
      border-bottom: 1px solid var(--line);
    }
    h2 {
      margin: 0;
      font-size: 18px;
      letter-spacing: 0;
    }
    .body {
      display: grid;
      gap: 14px;
      padding: 18px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .item {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      background: #fbfcfd;
    }
    .item-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }
    label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
    }
    input, textarea, select {
      width: 100%;
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      padding: 8px 10px;
      font: inherit;
    }
    textarea {
      min-height: 96px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      padding: 8px 12px;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
      white-space: nowrap;
    }
    button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }
    button.primary:hover { background: var(--accent-strong); }
    button.danger {
      border-color: #f3b7b0;
      color: var(--danger);
      background: #fff7f6;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .auth {
      display: flex;
      gap: 8px;
      min-width: min(520px, 100%);
    }
    .auth input { min-width: 260px; }
    .status {
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 12px;
      color: var(--muted);
      white-space: pre-wrap;
      overflow: auto;
      max-height: 300px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border-radius: 999px;
      padding: 2px 9px;
      background: var(--soft);
      color: var(--accent-strong);
      font-size: 12px;
      font-weight: 700;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text);
      font-size: 13px;
      font-weight: 650;
    }
    .check input {
      width: 16px;
      min-height: 16px;
    }
    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
      nav { position: static; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid { grid-template-columns: 1fr; }
      .bar { flex-wrap: wrap; }
      .auth { width: 100%; }
      .auth input { min-width: 0; }
    }
  </style>
</head>
<body>
  <header>
    <div class="bar">
      <div class="brand">
        <strong>AnyRouter Check-in</strong>
        <span>Cloudflare Worker 管理面板</span>
      </div>
      <div class="auth">
        <input id="token" type="password" autocomplete="current-password" placeholder="PANEL_PASSWORD">
        <button id="remember" title="登录管理面板">登录</button>
      </div>
      <button id="reload">刷新</button>
      <button class="primary" id="save">保存配置</button>
      <label class="check"><input id="includeDisabled" type="checkbox">包含禁用</label>
      <button id="run">立即签到</button>
    </div>
  </header>
  <main>
    <div class="layout">
      <nav>
        <button class="active" data-tab="accounts">账号</button>
        <button data-tab="providers">服务商</button>
        <button data-tab="notify">通知</button>
        <button data-tab="status">状态</button>
      </nav>
      <div>
        <section id="accounts" class="active">
          <div class="section-head">
            <h2>账号配置</h2>
            <button id="addAccount">添加账号</button>
          </div>
          <div class="body">
            <div id="accountsList" class="grid"></div>
          </div>
        </section>
        <section id="providers">
          <div class="section-head">
            <h2>服务商配置</h2>
            <div class="toolbar">
              <button id="addProvider">添加服务商</button>
              <span class="pill">内置 anyrouter</span>
            </div>
          </div>
          <div class="body">
            <div id="providersList" class="grid"></div>
          </div>
        </section>
        <section id="notify">
          <div class="section-head">
            <h2>通知配置</h2>
          </div>
          <div class="body">
            <div id="notifyList" class="grid"></div>
          </div>
        </section>
        <section id="status">
          <div class="section-head">
            <h2>运行状态</h2>
            <div class="toolbar">
              <button id="loadStatus">读取状态</button>
              <button id="debugWaf">诊断 WAF</button>
            </div>
          </div>
          <div class="body">
            <label>诊断 provider
              <input id="debugProvider" value="anyrouter">
            </label>
            <div id="statusBox" class="status">等待操作。</div>
          </div>
        </section>
      </div>
    </div>
  </main>
  <script>
    const state = {
      config: { accounts: [], providers: {}, notifications: {} },
      defaultProviders: {},
      activeTab: 'accounts'
    };

    const $ = (id) => document.getElementById(id);
    const tokenInput = $('token');
    let sessionToken = localStorage.getItem('anyrouter_session_token') || '';

    function token() { return sessionToken; }
    function headers() {
      return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token() };
    }
    function show(value) {
      $('statusBox').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    }
    async function api(path, options) {
      const res = await fetch(path, Object.assign({ headers: headers() }, options || {}));
      const data = await res.json().catch(() => ({ success: false, error: 'Invalid JSON response' }));
      if (res.status === 401) {
        sessionToken = '';
        localStorage.removeItem('anyrouter_session_token');
      }
      if (!res.ok || data.success === false) throw data;
      return data;
    }
    function field(label, value, onInput, type) {
      const wrap = document.createElement('label');
      wrap.textContent = label;
      const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
      input.value = value || '';
      if (type && type !== 'textarea') input.type = type;
      input.addEventListener('input', () => onInput(input.value));
      wrap.appendChild(input);
      return wrap;
    }
    function checkbox(label, checked, onInput) {
      const wrap = document.createElement('label');
      wrap.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(checked);
      input.addEventListener('change', () => onInput(input.checked));
      wrap.appendChild(input);
      wrap.append(label);
      return wrap;
    }
    function select(label, value, options, onInput) {
      const wrap = document.createElement('label');
      wrap.textContent = label;
      const input = document.createElement('select');
      for (const optionValue of options) {
        const option = document.createElement('option');
        option.value = optionValue.value;
        option.textContent = optionValue.label;
        input.appendChild(option);
      }
      input.value = value || '';
      input.addEventListener('change', () => onInput(input.value));
      wrap.appendChild(input);
      return wrap;
    }
    function item(title, onDelete) {
      const box = document.createElement('div');
      box.className = 'item';
      const head = document.createElement('div');
      head.className = 'item-head';
      const strong = document.createElement('strong');
      strong.textContent = title;
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '删除';
      del.addEventListener('click', onDelete);
      head.append(strong, del);
      box.appendChild(head);
      return box;
    }
    function renderAccounts() {
      const list = $('accountsList');
      list.innerHTML = '';
      const providerNames = Object.keys(Object.assign({}, state.defaultProviders, state.config.providers));
      state.config.accounts.forEach((account, index) => {
        const box = item(account.name || 'Account ' + (index + 1), () => {
          state.config.accounts.splice(index, 1);
          renderAccounts();
        });
        box.append(
          checkbox('启用', account.enabled !== false, (v) => account.enabled = v),
          field('名称', account.name, (v) => account.name = v),
          select('Provider', account.provider || 'anyrouter', providerNames.map((name) => ({ label: name, value: name })), (v) => account.provider = v),
          field('API User', account.api_user, (v) => account.api_user = v),
          field('Cookies', typeof account.cookies === 'string' ? account.cookies : JSON.stringify(account.cookies), (v) => account.cookies = v, 'textarea')
        );
        list.appendChild(box);
      });
    }
    function renderProviders() {
      const list = $('providersList');
      list.innerHTML = '';
      for (const name of Object.keys(state.config.providers)) {
        const provider = state.config.providers[name];
        const box = item(name, () => {
          delete state.config.providers[name];
          renderProviders();
          renderAccounts();
        });
        box.append(
          field('Domain', provider.domain, (v) => provider.domain = v),
          field('Login Path', provider.login_path || '/login', (v) => provider.login_path = v),
          field('Sign In Path（留空表示不手动调用）', provider.sign_in_path || '', (v) => provider.sign_in_path = v || null),
          field('User Info Path', provider.user_info_path || '/api/user/self', (v) => provider.user_info_path = v),
          field('API User Header', provider.api_user_key || 'new-api-user', (v) => provider.api_user_key = v),
          select('WAF', provider.bypass_method || '', [{ label: '不启用', value: '' }, { label: 'waf_cookies', value: 'waf_cookies' }], (v) => provider.bypass_method = v || null),
          field('WAF Cookie Names（逗号分隔）', (provider.waf_cookie_names || []).join(', '), (v) => provider.waf_cookie_names = v.split(',').map((x) => x.trim()).filter(Boolean))
        );
        list.appendChild(box);
      }
      if (!Object.keys(state.config.providers).length) {
        const empty = document.createElement('div');
        empty.className = 'status';
        empty.textContent = '当前只使用内置 provider。添加自定义服务商后会显示在这里。';
        list.appendChild(empty);
      }
    }
    function ensureNotify() {
      const n = state.config.notifications || {};
      n.telegram = n.telegram || {};
      n.dingding = n.dingding || {};
      n.feishu = n.feishu || {};
      n.weixin = n.weixin || {};
      n.pushplus = n.pushplus || {};
      n.serverChan = n.serverChan || {};
      n.gotify = n.gotify || {};
      n.bark = n.bark || {};
      state.config.notifications = n;
      return n;
    }
    function renderNotify() {
      const n = ensureNotify();
      const list = $('notifyList');
      list.innerHTML = '';
      list.append(
        notifyBox('Telegram', n.telegram, [
          field('Bot Token', n.telegram.botToken, (v) => n.telegram.botToken = v, 'password'),
          field('Chat ID', n.telegram.chatId, (v) => n.telegram.chatId = v)
        ]),
        notifyBox('钉钉', n.dingding, [field('Webhook', n.dingding.webhook, (v) => n.dingding.webhook = v, 'password')]),
        notifyBox('飞书', n.feishu, [field('Webhook', n.feishu.webhook, (v) => n.feishu.webhook = v, 'password')]),
        notifyBox('企业微信', n.weixin, [field('Webhook', n.weixin.webhook, (v) => n.weixin.webhook = v, 'password')]),
        notifyBox('PushPlus', n.pushplus, [field('Token', n.pushplus.token, (v) => n.pushplus.token = v, 'password')]),
        notifyBox('Server 酱', n.serverChan, [field('SendKey', n.serverChan.token, (v) => n.serverChan.token = v, 'password')]),
        notifyBox('Gotify', n.gotify, [
          field('URL', n.gotify.url, (v) => n.gotify.url = v),
          field('Token', n.gotify.token, (v) => n.gotify.token = v, 'password'),
          field('Priority', String(n.gotify.priority || 9), (v) => n.gotify.priority = Number(v), 'number')
        ]),
        notifyBox('Bark', n.bark, [
          field('Key', n.bark.key, (v) => n.bark.key = v, 'password'),
          field('Server', n.bark.server || 'https://api.day.app', (v) => n.bark.server = v)
        ])
      );
    }
    function notifyBox(title, config, fields) {
      const box = document.createElement('div');
      box.className = 'item';
      const head = document.createElement('div');
      head.className = 'item-head';
      const strong = document.createElement('strong');
      strong.textContent = title;
      head.append(strong, checkbox('启用', config.enabled, (v) => config.enabled = v));
      box.appendChild(head);
      box.append(...fields);
      return box;
    }
    function renderAll() {
      renderAccounts();
      renderProviders();
      renderNotify();
    }
    async function loadConfig() {
      try {
        const data = await api('/api/config');
        state.config = data.config;
        state.defaultProviders = data.defaultProviders || {};
        renderAll();
        show('配置已加载。');
      } catch (e) { show(e); }
    }
    async function login() {
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: tokenInput.value.trim() })
        });
        const data = await res.json();
        if (!res.ok || data.success === false) throw data;
        sessionToken = data.token;
        localStorage.setItem('anyrouter_session_token', sessionToken);
        state.config = data.config;
        state.defaultProviders = data.defaultProviders || {};
        renderAll();
        show('登录成功，配置已加载。');
      } catch (e) { show(e); }
    }
    async function saveConfig() {
      try {
        const data = await api('/api/config', { method: 'PUT', body: JSON.stringify(state.config) });
        state.config = data.config;
        renderAll();
        show('配置已保存。');
      } catch (e) { show(e); }
    }
    async function runCheckIn() {
      try {
        const path = $('includeDisabled').checked ? '/api/checkin?includeDisabled=1' : '/api/checkin';
        const data = await api(path, { method: 'POST' });
        show(data);
      } catch (e) { show(e); }
    }
    async function loadStatus() {
      try { show(await api('/api/status')); } catch (e) { show(e); }
    }
    async function debugWaf() {
      try { show(await api('/api/debug-waf?provider=' + encodeURIComponent($('debugProvider').value || 'anyrouter'))); }
      catch (e) { show(e); }
    }

    document.querySelectorAll('nav button').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelectorAll('nav button').forEach((item) => item.classList.remove('active'));
        document.querySelectorAll('section').forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
        $(button.dataset.tab).classList.add('active');
      });
    });
    $('remember').addEventListener('click', login);
    $('reload').addEventListener('click', loadConfig);
    $('save').addEventListener('click', saveConfig);
    $('run').addEventListener('click', runCheckIn);
    $('loadStatus').addEventListener('click', loadStatus);
    $('debugWaf').addEventListener('click', debugWaf);
    $('addAccount').addEventListener('click', () => {
      state.config.accounts.push({ enabled: true, name: '', provider: 'anyrouter', api_user: '', cookies: '' });
      renderAccounts();
    });
    $('addProvider').addEventListener('click', () => {
      const name = prompt('Provider 名称');
      if (!name) return;
      state.config.providers[name] = {
        domain: 'https://example.com',
        login_path: '/login',
        sign_in_path: '/api/user/sign_in',
        user_info_path: '/api/user/self',
        api_user_key: 'new-api-user',
        bypass_method: null,
        waf_cookie_names: []
      };
      renderProviders();
      renderAccounts();
    });
    renderAll();
    if (token()) loadConfig();
  </script>
</body>
</html>`;
}
