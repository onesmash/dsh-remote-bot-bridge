# dsh-remote-bot-bridge

跨机器的 Bot 之间传话，基于 [ds-harness-remote](https://github.com/liguobao/ds-harness-remote)。

## 它解决什么

机器 A 和机器 B 各跑一套 DSH。A 上的 Bot 想给 B 上的 Bot 发一条消息。

`ds-harness-remote` 已经提供了需要的一切：端到端加密通道（Noise）、账号级鉴权、
`LAN → P2P → TURN → Relay` 自动穿透（Host 只出站，不需要公网 IP），以及
`plugin.route.v1` —— 它把 ds-bot 的 `POST api/bot` 操作转发到对端 Host。

这个插件只做最后一厘米：把 remote 的 client runtime 包装成 Bot 能调的工具。

## 安装

```sh
# 1. 两台机器都装 ds-harness-remote 并登录同一账号
dsh plugin --profile desktop add -w ds-harness-remote@0.5.17

# 2. 装本插件
dsh plugin --profile desktop add dsh-remote-bot-bridge

# 3. 重启 DSH
```

接收方（Host）必须启用 `ds-bot`，且 remote 版本支持 `plugin.route.v1`。

## 用法

正常情况下不用记工具名，直接对 Bot 说：

> 发给远端的 Chief：ZOOM-1449791 那个 MR 帮我看下状态

没有设置过目标时，只有在**一台对端在线**的情况下会自动选中它并记住，之后不用再管。

需要精确控制时：

| 工具 | 作用 |
|---|---|
| `remote_status` | 登录态、当前后台目标、同账号设备（名字 / deviceId / 在线） |
| `remote_target` | 可选：固定目标设备或设别名，`"none"` 清除 |
| `remote_bots` | 列出对端 Bot（名字 + session id） |
| `remote_send` | 给对端某个 Bot 发消息（`to` 给名字或 id，`message` 给正文） |
| `remote_ping` | 测冷/热连接耗时，报告协商出的传输路径 |

消息在对端以「用户输入」的身份进入目标 Bot 的会话（ds-bot 的 `send` 内部走
`ctx.sessionController.prompt({ mode: 'queue' })`）。

## 为什么不接管窗口

`ds-harness-remote` 的 `setMode('client', id)` 会把本机整个 Harness API 代理到对端 ——
窗口变成对方的。那是给人用的（远程操作另一台机器），不是给 Bot 后台传话用的。

这个插件用的是 client runtime 实例上的 `connect(deviceId)`：只建立连接，返回
`{ client, target, ... }`，**不设置 `this.connected`，不碰 API/gateway 切换**。
用完由插件自己管理连接的关闭。窗口全程不动。

## 连接复用

一次冷连接的开销远大于一次调用：

| 阶段 | LAN 实测 |
|---|---|
| 建立连接 | 4.3 – 5.3 s |
| 一次 RPC 调用 | 15 – 18 ms |

连接建立要串行走四次 HTTPS（listDevices / authorizeHostPeer / presenceFor / authenticate）
外加 WebSocket + Noise 握手。所以插件做了三层复用：

1. **借道**：Remote UI 已经连着同一台对端时，直接复用那条连接，零成本、不改变窗口状态
2. **池**：自建一条私有连接并复用，空闲 5 分钟自动关闭
3. **冷启动**：都没有时新建

所以实际体感是：第一次 4-5 秒，之后 20-50 毫秒。

探针 `remote_ping` 会分别报告冷连接和复用命中的耗时。

## 双向传话

`plugin.route` 是 **Client → Host** 单方向。Remote 的 RPC 全部由 Client 发起、Host 应答；
Host 没有主动推送任意消息的接口（它只能往 Client 主动打开的流里推事件）。所以**一条连接
只能一个方向用**。

要双向，两台机器都装这个插件，各自把目标指向对方：

```
A --client--> B   (A 发给 B)
B --client--> A   (B 发给 A)
```

两条连接相互独立，各自走连接池。

## 安装约定（给插件开发者）

profile 的 `dsh.profile.bundles` 是有序白名单，bundle 必须列在里面才会被加载。

**不要静态 import 任何 `@deepseek-ai/*` 包。** profile bundle 在安装侧的模块解析钩子就绪
之前就被 import，静态 import 失败会让整个 bundle **静默不加载**，工具直接消失且没有可见
错误。这里的工具对象是手写的（JSON Schema 参数），通过 `ctx.inject(['tools'])` 注册。

纯宿主插件不要声明 `dsh.client`。

## License

MIT
