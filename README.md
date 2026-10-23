# dsh-remote-bot-bridge

跨机器的 Bot 之间传话，基于 `ds-harness-remote`。

## 它解决什么

机器 A 和机器 B 各跑一套 DSH。B 上的 Bot 想给 A 上的 Bot 发一条消息。

`ds-harness-remote` 已经提供了需要的一切：端到端加密通道（Noise）、账号级鉴权、
`LAN → P2P → TURN → Relay` 自动穿透（Host 只出站，不需要公网 IP），以及
`plugin.route.v1` —— 它把 ds-bot 的 `POST api/bot` 操作转发到对端 Host。

这个插件只做最后一厘米：把 remote 的 client runtime 包装成两个工具，
让 Bot 能调。

## 安装

```sh
# 1. 两台机器都装 ds-harness-remote 并登录同一账号
dsh plugin --profile desktop add -w ds-harness-remote@0.5.17

# 2. 装本插件
dsh plugin --profile desktop add link:/Users/hui.xu/SourceCode/dsh-remote-bot-bridge

# 3. 重启 DSH
```

Host 侧（接收方）必须是启用了 `ds-bot` 的那台，且 remote 版本支持 `plugin.route.v1`。

## 用法

在**作为 Client 连接对端**的那台机器上，Bot 有两个工具：

| 工具 | 作用 |
|---|---|
| `remote_bots` | 列出对端 Host 上的 Bot（名字 + session id） |
| `remote_send` | 给对端某个 Bot 发消息（`to` 给名字或 id，`message` 给正文） |

消息在对端以「用户输入」的身份进入目标 Bot 的会话
（ds-bot 的 `send` 内部走 `ctx.sessionController.prompt({ mode: 'queue' })`）。

## 双向传话

`plugin.route` 是 Client → Host 方向。要双向，两台机器都装 remote，
各自作为 Client 连对方一次（协议 §8.1.2 `register-owned-role` 支持同一安装
同时持有 Host 和 Client 两种角色）。

## 实现说明

- 依赖 `dshRemoteClient` 这个 cordis 服务（remote 在 `ctx.provide` 里暴露），
  调 `pluginRoute('api/bot', { endpoint, payload })`。不走 HTTP，因此不受
  `requestRejection` 的 cookie 认证约束。
- 纯宿主插件，不声明 `dsh.client`。
- 模块级 `inject = []`，运行时 `ctx.inject(['dshRemoteClient'])` 动态解析，
  服务缺失时工具报可读错误而不是拖垮宿主。
- **不 import 任何 `@deepseek-ai/*` 包**。profile bundle 在 DSH 运行时里被
  import 时，安装侧的模块解析钩子还没就绪；静态 `import { defineTool } from
  '@deepseek-ai/dsh-tools'` 会让整个 bundle 加载失败，而且不产生可见错误
  （工具体静默消失）。所以工具对象手写，参数用 JSON Schema，通过
  `ctx.inject(['tools'])` 注册。
