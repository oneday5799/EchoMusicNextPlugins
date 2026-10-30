# 自动组队领VIP

移植自 EchoMusicPlugins/auto-team-vip（v2 快照/租约协议），配合码池服务器 `team-pool-worker/`（Cloudflare Worker + Durable Object，协议未变）。

- 自动参加酷狗概念版官方活动「组队瓜分畅听VIP」并组队，入口在标题栏 ★。
- 自动组队开关默认**关闭**：关闭时与码池服务器零交流（不上报快照、不申请组队码），只读酷狗展示期次与队伍，并支持手动加入（组队码由用户输入）。开启后走完整 ①GUARD → ②MYINFO → ③SNAPSHOT → ④DECIDE → ⑤ASSIGN → ⑥JOIN_KUGOU → ⑦RESULT → ⑧VERIFY 流程。
- 名额计算、租约自愈、匹配策略、身份防伪（token 按 uid 签发）、多设备与隐私语义均由码池 v2 协议承担，与旧插件一致；单地址 `https://echo-team-pool.oneday.vip`。

## 与旧 EchoMusic 插件的架构差异

- **登录态获取**：宿主不向插件暴露账号凭证。插件声明 `serverIntercept` 能力（首次调用请求用户授权，管理页可撤销），在 api 阶段**被动读取**宿主业务请求携带的逻辑 `Authorization` 头（token/userid/dfid/mid/uuid/guid/dev/mac，与旧插件从 pinia 拼装的字段一致）。该头仅驻内存、不落盘，账号切换（`sessionInvalidated`）即清除并等待新会话重新捕获；未捕获前面板明确显示"登录态同步中"。
- **组队接口**：旧宿主的 `/team/*` 内置路由对应 `gateway.kugou.com` 的 `/youth/v1/ut/*`（get_period_info / get_my_team_info / create_team / join_team）。签名与 h5 token 派生在插件内实现（`src/crypto.ts`：纯 JS MD5 + 1024 位 RSA NO_PADDING 模幂，与旧宿主 server 模块逐位对齐），经 `net.request`（`unrestrictedNetwork` 能力）直连网关。
- **验证码**：`ssa-code`/`ssaCode` 触发时调用 `ctx.kugou.verify(eventId)`，由宿主现有验证界面承接 proof 与重放，之后重试一次；已知业务终态错误码（143001/143004/143010/143005/20006）不触发验证。
- **界面**：Vue teleport 弹窗改为原生 QML 页面（`qml/TeamPanel.qml`），经 `registerTitlebarActionDefinition`（图标 `star`）+ `registerPage` 进入；面板状态经 `ctx.ui.setState` 发布，操作经插件命令（`refresh` / `set-auto` / `join-manual` / `error-detail` / `panel.opened`）回流状态机。
- **存储**：`settings`、`poolTokens`、`poolAuthDisabled`、`lastPeriodId` 语义不变，改存安装私有 values.sqlite（`ctx.io`）。
- **心跳**：60s 巡检定时器 + 面板打开通知；期次 inactive 每 30min 低频探测、已入队 30min 保活快照（面板打开 5min）、未入队每 10min 完整流程等新码，池空退避 20→30→60min。

## 能力与授权

- features：`server.intercept`、`kugou.api`、`kugou.verification`、`net.request`、`storage`、`ui.pages`、`ui.titlebar`、`ui.toast`、`timers` 等。
- capabilities：`serverIntercept`（读取宿主请求中的逻辑 Authorization，仅内存）、`unrestrictedNetwork`（网关与码池直连）、`kugouApi`（登录态查询）、`kugouVerification`（验证码界面）。
- 授权被拒绝时插件保持诚实降级：面板提示"插件授权未开启"，不会伪造组队成功。

## 码池版本头

码池 Worker 按 `X-Plugin-Version` 做 `MIN_CLIENT_VERSION`（当前 1.2.0）门禁。插件版本 1.2.6 直接满足，请求头即携带 manifest 中的真实版本（`PLUGIN_VERSION` 常量与 manifest 同步维护，宿主上下文不暴露 manifest）；后续升级码池协议时以该头为准判断客户端兼容性。

## 构建

仓库根执行 `npm run build`，生成 `dist/auto-team-vip-1.2.6.echomod`；`--plugin-dir` 加载构建目录可开发调试。图标沿用旧插件 MIT 许可，见 `LICENSE`。
