# AnyRouter 自动签到 Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/GuJi08233/anyrouter-check-in)

基于 Cloudflare Workers + Browser Rendering 的多账号自动签到服务，支持 AnyRouter 以及兼容 NewAPI / OneAPI 的站点。

当前版本是纯 Cloudflare Worker 形态，并内置可视化管理面板，可在浏览器中添加账号、服务商和通知配置。

## 功能

- 多账号、多服务商自动签到
- AnyRouter 内置 provider
- 自定义 NewAPI / OneAPI provider
- 使用 Cloudflare Browser Rendering 处理 WAF
- 使用 Cloudflare KV 保存账号配置、余额 hash、最近运行状态
- 可视化管理面板添加和编辑配置
- 支持手动触发和 Cron 定时触发
- 支持 Telegram、钉钉、飞书、企业微信、PushPlus、Server 酱、Gotify、Bark 通知

## 目录结构

```text
anyrouter-check-in/
├── src/
│   ├── index.ts     # Worker 入口，处理面板、API、Cron
│   ├── admin.ts     # 可视化管理面板和配置 API
│   ├── config.ts    # 配置读取、校验、KV 存储
│   ├── checkin.ts   # 核心签到与 WAF 处理
│   ├── notify.ts    # 通知推送
│   └── types.ts     # 类型定义
├── package.json
├── tsconfig.json
├── wrangler.toml
└── README.md
```

## 前置要求

- Cloudflare Workers Paid 计划
- Cloudflare Browser Rendering
- 一个 KV namespace
- Node.js 22+
- Wrangler 4+

Browser Rendering 是 Cloudflare 付费能力。如果你的 provider 不需要 WAF，可以在 provider 配置中关闭 `waf_cookies`。

## 部署

推荐直接点击 README 顶部的 **Deploy to Cloudflare** 按钮进行一键部署。手动部署可以按下面步骤执行。

### 1. 安装依赖

```bash
npm install
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

### 3. 创建 KV

```bash
npx wrangler kv namespace create ANYROUTER_KV
```

把命令返回的 `id` 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "APP_KV"
id = "你的 KV namespace id"
```

### 4. 设置管理面板密钥

```bash
npx wrangler secret put PANEL_PASSWORD
```

`PANEL_PASSWORD` 是唯一需要的 Worker secret，用于访问管理 API、保存配置、手动签到和 WAF 诊断。不要把它提交到仓库。

### 5. 部署

```bash
npm run deploy
```

部署完成后访问 Worker 域名即可打开管理面板。

## 管理面板

访问 Worker 根路径：

```text
https://你的-worker.你的账户.workers.dev/
```

在顶部输入 `PANEL_PASSWORD` 登录后可以：

1. 添加账号：名称、provider、cookies、api_user
2. 添加自定义 provider：域名、接口路径、请求头、WAF cookie 名称
3. 配置通知：Telegram、钉钉、飞书、企业微信等
4. 手动执行签到
5. 查看最近运行状态
6. 诊断指定 provider 的 WAF cookie 获取情况

配置会保存到 Cloudflare KV 的 `managed_config` 键中。

## 账号配置

面板中的账号结构等价于：

```json
{
  "enabled": true,
  "name": "主账号",
  "provider": "anyrouter",
  "cookies": "session=xxx; other=value",
  "api_user": "12345"
}
```

`cookies` 可以是浏览器复制出来的字符串，也可以是 JSON 对象。

## Provider 配置

内置 provider：

- `anyrouter`

自定义 provider 示例：

```json
{
  "customrouter": {
    "domain": "https://custom.example.com",
    "login_path": "/login",
    "sign_in_path": "/api/user/sign_in",
    "user_info_path": "/api/user/self",
    "api_user_key": "new-api-user",
    "bypass_method": "waf_cookies",
    "waf_cookie_names": ["acw_tc", "cdn_sec_tc"]
  }
}
```

字段说明：

- `domain`：服务商域名
- `login_path`：登录页路径，用于触发 WAF
- `sign_in_path`：签到接口路径，留空表示不手动调用签到接口
- `user_info_path`：用户信息接口路径
- `api_user_key`：API 用户请求头名称
- `bypass_method`：设置为 `waf_cookies` 时启用浏览器 WAF 流程
- `waf_cookie_names`：需要等待的 WAF cookie 名称

## 触发方式

- Cron：`wrangler.toml` 默认每天北京时间 10:00 执行一次
- 面板按钮：点击“立即签到”
- API：`POST /api/checkin`

手动 API 示例：

```bash
curl -X POST "https://你的-worker.workers.dev/api/checkin" \
  -H "Authorization: Bearer 登录后返回的 token"
```

## API

- `GET /`：管理面板
- `GET /api/health`：健康检查
- `POST /api/login`：使用 `PANEL_PASSWORD` 登录，返回 Bearer token
- `GET /api/config`：读取配置，需要鉴权
- `PUT /api/config`：保存配置，需要鉴权
- `GET /api/status`：最近运行状态，需要鉴权
- `POST /api/checkin`：手动签到，需要鉴权
- `GET /api/debug-waf?provider=anyrouter`：WAF 诊断，需要鉴权

## 本地开发

```bash
npm run dev
```

本地开发建议使用 `.dev.vars`：

```text
PANEL_PASSWORD=local-dev-password
```

KV 和 Browser Rendering 在本地环境与线上能力不同，涉及 WAF 的真实验证建议部署到 Cloudflare 后测试。

## 配置管理原则

Worker 只需要一个环境变量：

```text
PANEL_PASSWORD
```

账号、provider、通知渠道、启用状态都在管理面板中维护，并保存到 Cloudflare KV。
面板密码只用于登录换取临时 token，后续管理 API 使用该 token 鉴权。
定时任务只会运行已启用的账号；禁用账号不会自动签到。
手动测试时可以勾选“包含禁用”，用于临时验证禁用账号配置。

## 注意事项

- 面板保存的账号 cookies 和通知 token 会存入 KV，请确保 `PANEL_PASSWORD` 足够强。
- SMTP 邮箱通知没有直接迁移，Cloudflare Worker 原生运行时不适合直接连接传统 SMTP。
- WAF provider 会在 Browser Rendering 页面内部完成 API 请求，以减少指纹和 cookie 不一致导致的失败。
- 如果所有账号都失败且没有余额信息，本项目不会覆盖旧的余额 hash。

## 免责声明

本项目仅用于学习和研究目的，使用前请确保遵守相关网站的使用条款。
