# 贡献指南

感谢你愿意改进 AnyRouter Check-in Worker。

## 开发环境

需要：

- Node.js 20+
- npm
- Wrangler 4+
- Cloudflare Workers Paid 计划（涉及 Browser Rendering 的真实验证需要）

安装依赖：

```bash
npm install
```

本地开发：

```bash
npm run dev
```

类型检查：

```bash
npm run typecheck
```

## 项目结构

```text
src/
├── index.ts     # Worker 入口
├── admin.ts     # 管理面板和 API
├── config.ts    # KV 配置、默认 provider、校验
├── checkin.ts   # 签到流程和 WAF 处理
├── notify.ts    # 通知渠道
└── types.ts     # 类型定义
```

## 代码规范

- 保持 TypeScript `strict` 可通过
- 新增配置必须有默认值或兼容旧配置
- 涉及账号 cookies、token、webhook 的日志必须避免输出完整敏感值
- Provider 变更需要兼容多账号、多服务商场景
- WAF 相关逻辑要优先在浏览器上下文中验证

## Pull Request 检查

提交前请运行：

```bash
npm run typecheck
```

如改动了部署配置，请确认：

- `wrangler.toml` 的 binding 名称没有破坏现有代码
- README 已同步更新
- 管理面板仍能保存配置并触发签到

## Commit 信息

推荐使用语义化提交：

```text
feat: add provider editor
fix: preserve null sign_in_path
docs: update worker deployment guide
```
