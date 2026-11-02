# 自动组队领VIP

移植自 EchoMusicPlugins/auto-team-vip（v2 快照/租约协议），配合码池服务器 `team-pool-worker/`（Cloudflare Worker + Durable Object，协议未变）。

- 自动参加酷狗概念版官方活动「组队瓜分畅听VIP」并组队，入口在标题栏 ★。
- 自动组队开关默认**关闭**：关闭时同样自动创建队伍并展示队伍码（可复制分享，或手动输入他人组队码加入），但与码池服务器零交流（不上报快照、不申请组队码、不做自动分配）。开启后走完整 ①GUARD → ②MYINFO → ③SNAPSHOT → ④DECIDE → ⑤ASSIGN → ⑥JOIN_KUGOU → ⑦RESULT → ⑧VERIFY 流程；无队伍的设备**先租码加入他人**（快满优先），仅当码池无队可发（pool_empty）时才转入建队入池——角色由池内供需自发分配，避免旧版预建队"开局人人 1/3 队、互等人加入"的低效开局。
- **从未组过队的账号**：create/join 都会被酷狗以误导性文案拒绝（"当前设备已经创建过队伍~~"/143005"每台设备只能加入一个队伍"）。补救：在概念版APP中**打开一次组队页面**（打开即自动建队，解决建队被拒），或在组队页面**手动加入一次其他人的队伍**（解决加入被拒）；相关错误提示均已附带指引，toast 只显示酷狗原始文案，完整指引在面板下方状态区。组队**无法解散**（官方APP亦无解散入口），期内一旦入队即为终态，期次切换后重新开始。
- 名额计算、租约自愈、匹配策略、身份防伪（token 按 uid 签发）、多设备与隐私语义均由码池 v2 协议承担，与旧插件一致；单地址 `https://echo-team-pool.oneday.vip`。

## 与旧 EchoMusic 插件的架构差异

- **登录态获取**：宿主不向插件暴露账号凭证。插件声明 `serverIntercept` 能力（首次调用请求用户授权，管理页可撤销），在 api 阶段**被动读取**宿主业务请求携带的逻辑 `Authorization` 头（token/userid/dfid/mid/uuid/guid/dev/mac，与旧插件从 pinia 拼装的字段一致）。该头仅驻内存、不落盘，账号切换（`sessionInvalidated`）即清除并等待新会话重新捕获；未捕获前面板明确显示"登录态同步中"。
- **组队接口**：旧宿主的 `/team/*` 内置路由对应 `gateway.kugou.com` 的 `/youth/v1/ut/*`（get_period_info / get_my_team_info / create_team / join_team）。签名与 h5 token 派生在插件内实现（`src/crypto.ts`：纯 JS MD5 + 1024 位 RSA NO_PADDING 模幂，与旧宿主 server 模块逐位对齐），经 `net.request`（`unrestrictedNetwork` 能力）直连网关。
- **验证码**：`ssa-code`/`ssaCode` 触发时调用 `ctx.kugou.verify(eventId)`，由宿主现有验证界面承接 proof 与重放，之后重试一次；已知业务终态错误码（143001/143004/143010/143005/20006）不触发验证。
- **界面**：Vue teleport 弹窗改为原生 QML：标题栏 ★ 打开主窗口共享弹层（`qml/PanelDialog.qml`，默认入口），弹层不可用时回退页面（`qml/TeamPanel.qml`，`registerPage`），正文共用 `qml/TeamPanelBody.qml`；面板状态经 `ctx.ui.setState` 发布，操作经插件命令（`refresh` / `set-auto` / `join-manual` / `pool-retry` / `error-detail` / `panel.opened`）回流状态机。
- **存储**：`settings`、`poolTokens`、`poolAuthDisabled`、`lastPeriodId` 语义不变，另有 `lastCreatedTeam`（本期已建队伍码的展示缓存，酷狗查询失败时面板不空等）与 `deviceCreatedPeriods`（设备级"本期已建队/被拒建"标记：酷狗拒建后落盘，后续流程免重查循环、直查 myinfo 取码，取不到时给轻提示等待下轮；随期次切换裁剪），改存安装私有 values.sqlite（`ctx.io`）。
- **队长语义**：未满员的创建队队长默认仍可租码加入他人（2026-11-03 用户更正：此前 143005 样本实为"账号从未组过队"的资格问题，并非创建队占用设备）；若某设备真实被 143005 拒绝（创建队可见），自动落期次级标记退回等待态，本期不再消耗租约。满员创建队即为终态。组队无法解散，期内一旦入队即等待期次切换。
- **心跳**：60s 巡检定时器 + 面板打开通知；期次 inactive 每 30min 低频探测、已入队 30min 保活快照（面板打开 5min）、未入队每 10min 完整流程等新码，池空退避 20→30→60min。

## 能力与授权

- features：`server.intercept`、`kugou.api`、`kugou.verification`、`net.request`、`storage`、`ui.pages`、`ui.titlebar`、`ui.toast`、`timers` 等。
- capabilities：`serverIntercept`（读取宿主请求中的逻辑 Authorization，仅内存）、`unrestrictedNetwork`（网关与码池直连）、`kugouApi`（登录态查询）、`kugouVerification`（验证码界面）。
- 授权被拒绝时插件保持诚实降级：面板提示"插件授权未开启"，不会伪造组队成功。

## 码池版本头

码池 Worker 按 `X-Plugin-Version` 做 `MIN_CLIENT_VERSION`（当前 1.2.0）门禁。插件版本 1.2.7 直接满足，请求头即携带 manifest 中的真实版本（`PLUGIN_VERSION` 常量与 manifest 同步维护，宿主上下文不暴露 manifest）；后续升级码池协议时以该头为准判断客户端兼容性。

## 换设备/重装后的“身份校验失败”恢复

码池按期次给每个 uid 只签发一次 token、期内永不重签（防劫持）。从旧 EchoMusic 迁移或重装插件后，本地存储是全新的，快照带不上原 token，服务端返回 401，面板显示“身份校验失败，本期码池功能停用（下期自动恢复）”并落下本地停用标记。本期恢复步骤：

1. 退出旧 EchoMusic（或停用其自动组队插件），避免旧客户端抢先重签 token。
2. 码池管理端（`team-pool-worker/admin.html`，需 `ADMIN_TOKEN`）对当前期次执行「删除用户」解除该 uid 的 token 绑定；批量恢复也可由站长临时把码池 `IDENTITY_CHECK` 变量设为 `off`（恢复模式，快照自动重绑 token，用完改回），见 `contrib/team-pool-worker/README.md`。
3. 在面板的“状态异常”提示旁点击**解除停用并重试**：插件清除本地停用标记并立即重发快照，重签 token 后本期即恢复。

不做任何处理也可，下期开始自动恢复（新期次用户表全新，本地停用表跨期裁剪）。

## 构建

仓库根执行 `npm run build`，生成 `dist/auto-team-vip-1.2.7.echomod`；`--plugin-dir` 加载构建目录可开发调试。图标沿用旧插件 MIT 许可，见 `LICENSE`。
