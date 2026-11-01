# team-pool-worker（echo-team-pool）

auto-team-vip 插件的码池服务端：Cloudflare Worker + Durable Object（每期活动一个
DO 实例，DO 内嵌 SQLite 存全部状态），实现"快照 / 租约 / 匹配"模型。插件侧只通过
自定义域 `echo-team-pool.oneday.vip` 访问。

2026-11-02 自对照仓库 `EchoMusicPlugins/team-pool-worker` 复制入库，便于随插件
一同修改。`.wrangler/` 部署本机缓存（含账号信息）不随仓库走。

- `worker.js` —— 服务端全部逻辑（快照存储与名额计算、组队码租约下发与结果跟踪、
  令牌桶限流、审计事件环形日志）；文件头部注释列有全部常量与职责边界。
- `admin.html` —— 管理页面。
- `wrangler.toml` —— 部署配置：DO 绑定 `PERIOD_POOL`、`workers_dev = false`（唯一
  公开入口走 oneday.vip 域的 WAF/限流）、`MIN_CLIENT_VERSION = "1.2.0"`、
  `IDENTITY_CHECK = "on"`。

开发与部署（需要本地 wrangler 登录）：

```sh
npx wrangler dev      # 本地开发
npx wrangler deploy   # 部署到 Cloudflare
```

设计文档 `docs/auto-team-vip-redesign.md`（§6）在旧对照仓库中，未随本次复制带入。

## 身份校验开关（IDENTITY_CHECK）

与 `MIN_CLIENT_VERSION` 同类的部署变量，默认 `on`：uid 已存在时 token 必须精确匹配，
期内永不重签（防劫持）。

改为 `off` 并重新部署（`npx wrangler deploy`，或在 Cloudflare 后台 Workers → 设置 →
变量里保存，同样触发部署）进入**恢复模式**：

- 所有端点跳过 token 比对，不再返回“身份校验失败”401。
- 快照（snapshot）会把 token **重绑**给来者（带 token 用带来的，空则换新签）——
  否则重新打开校验后，新客户端仍会被旧绑定挡住。重绑逐条写入审计事件
  （`check_off_rebind`），其余端点只放行不写库。
- `/v2/health` 与 admin data 返回 `identity_check: "on" | "off"`，用于确认模式已生效。

适用场景：换设备/重装插件后 token 失配（本地停用标记可用面板「解除停用并重试」清除），
或需要批量解绑时，替代逐 uid「删除用户」。**安全边界**：窗口期内知道 uid 的任何人都
能冒用该账号，窗口应尽量短，恢复完成后立即改回 `on` 重新部署；注意 wrangler.toml 里
的值会在下次 deploy 时覆盖后台改动，两处需保持一致。
