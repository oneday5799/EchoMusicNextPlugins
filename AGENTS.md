# AGENTS.md —— local 分支（插件开发线）

面向 AI 代理与贡献者。`local` 是新插件的活跃开发分支；插件成熟后按本文「发布流程」提交到
`main`（发布分支的不变量与验收标准见 main 分支的 AGENTS.md）。

## 分支模型

| 分支 | 角色 |
| --- | --- |
| `main`（默认） | 发布分支：upstream 基线 + **每个插件一个自包含提交**；安装源指向这里 |
| `main2` | 完整开发历史（原 main），仅归档 |
| `local` | 新插件开发、试验；定期 merge upstream |
| `upstream` | `hoowhoami/EchoMusicNextPlugins` |

## 在 local 上开发新插件

1. **先同步上游**：`git fetch upstream && git merge upstream/main`。
   冲突原则：`echo-plugins.json` / `echo-plugin.build.json` 取并集；README、docs、packages、tests
   等共享文件尽量不动。
2. 插件目录 `plugins/<id>/` 必备：`manifest.json`（id / version / entry）、`src/*.ts`、`qml/`、
   `icon.svg`、`LICENSE`、`plugin.config.json`。**源码 entry 与发布 entry 必须不同**，工具会拒绝覆盖作者入口。
3. 构建与发布物（三要素：包路径、sha256、版本号必须与 manifest 一致）：

   ```bash
   npx echo-plugin build plugins/<id>                 # 产出 dist/<id>-<version>.echomod
   cp dist/<id>-<version>.echomod artifacts/
   npx echo-plugin publish-manifest artifacts/<id>-<version>.echomod --artifact artifacts/<id>-<version>.echomod
   # ↑ 将 distribution { artifact, sha256 } 写回 plugins/<id>/manifest.json
   ```

   或把插件加入 `echo-plugin.build.json` 后执行 `npm run prepare:source`（批量生成并核对 artifacts）。
4. 测试：`npm test`；新插件应配套 `tests/<id>.test.mjs`。
5. 提交到 local：常规 `feat(<id>): ...` 提交即可，无单提交限制。

## 发布流程：local → main（核心）

原则：**main 上每个插件一个自包含提交**；除插件目录、其构建包、`echo-plugins.json` 一条新登记外，
不得改动任何上游文件（README.md、docs/、tests/、packages/、echo-plugin.build.json、其他索引条目）。

1. 确认 local 已合并最新 `upstream/main`，插件版本冻结，`npm test` 全绿。
2. 在 main 上创建单个提交（文件从 local 检出）：

   ```bash
   git checkout main
   git checkout local -- plugins/<id>
   git checkout local -- artifacts/<id>-<version>.echomod
   # 新插件：编辑 echo-plugins.json，在 plugins 数组末尾追加一条登记：
   # { "id": "<id>", "repo": "https://github.com/oneday5799/EchoMusicNextPlugins", "path": "plugins/<id>" }
   git commit -m "feat: add <id> plugin"
   ```

3. 一致性校验：包文件名版本 == manifest `version`；`sha256sum artifacts/<id>-<version>.echomod`
   == manifest `distribution.sha256`。
4. `npm test` 全绿后推送；fast-forward 优先。
5. 推送后验收：

   ```bash
   curl -f https://raw.githubusercontent.com/oneday5799/EchoMusicNextPlugins/HEAD/plugins/<id>/manifest.json
   curl -f https://raw.githubusercontent.com/oneday5799/EchoMusicNextPlugins/HEAD/artifacts/<id>-<version>.echomod
   # 均应返回 200；完整校验可跑 npm run check:published
   ```

6. 若需修正已推送的插件提交（补包、改哈希、补登记）：重写该提交及其后的插件提交
   （local-music 类后续提交会被重放），用 `--force-with-lease` 推送；重写前先建 `backup/*` 分支。
   更新已有插件版本同理 —— 始终修订该插件自己的提交，保持「每插件一个提交」不变。

## 与上游同步

local 与 main 都用 `git merge upstream/main`；`echo-plugins.json` / `echo-plugin.build.json`
冲突按并集解决，其余以「不改共享文件」为原则。

## 网络备注

直连 GitHub 失败：`git -c http.proxy=http://127.0.0.1:7890 <cmd>`；
`schannel` 握手失败：追加 `-c http.sslBackend=openssl`；
Node 侧联网脚本（如 `npm run check:published`）设 `HTTPS_PROXY=http://127.0.0.1:7890`。
