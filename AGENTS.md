# AGENTS.md —— main 分支（发布分支 / 默认安装源）

面向 AI 代理与维护者的操作规范。本仓库分支模型：

| 分支 | 角色 |
| --- | --- |
| `main`（默认） | 发布分支：upstream 基线 + **每个插件一个自包含提交**；插件的安装源（索引 `repo` 指针）指向这里 |
| `main2` | 完整开发历史（原 main），仅归档，不做日常修改 |
| `local` | 插件活跃开发分支；新插件从这里发布到 main |
| `upstream` | `hoowhoami/EchoMusicNextPlugins`（基线 `97b39c4`） |

## main 的不变量（任何改动必须维持）

1. **基线 `97b39c4` 之后，一个提交 = 一个插件**，内容仅限：
   - `plugins/<id>/`（源码、`entry.mjs`、`manifest.json`）
   - `artifacts/<id>-<version>.echomod`（正式构建包）
   - 新插件首次引入时，在 `echo-plugins.json` 追加一条登记（格式见下）
2. **不改任何其他文件**：README.md、docs/、tests/、packages/、echo-plugin.build.json、
   其他插件目录与其他索引条目一律保持 upstream 原样 —— 这是与上游保持低冲突的关键。
3. **发布物三要素必须一致**（安装器强校验，缺一即安装失败）：
   - `artifacts/<id>-<version>.echomod` 文件名中的版本 == `manifest.json` 的 `version`
   - 包文件 sha256 == `manifest.json` 的 `distribution.sha256`
   - `distribution.artifact` 路径 == 包的实际仓库路径
   缺包 → 安装报“未找到插件资源（HTTP 404）”；哈希不符 → 安装校验失败。
4. **更新已有插件 = 修订（amend）该插件自己的提交**：源码、构建包、哈希三位一体同步更新，
   保持“每插件一个提交”不变；用 `--force-with-lease` 推送（禁止裸 `-f`），大重写前先建 `backup/*` 分支。
5. 与 upstream 同步只使用 **merge**（`echo-plugins.json` / `echo-plugin.build.json` 冲突按并集解决），不 rebase 插件提交。

## echo-plugins.json 登记格式

```json
{
  "id": "<id>",
  "repo": "https://github.com/oneday5799/EchoMusicNextPlugins",
  "path": "plugins/<id>"
}
```

追加到 `plugins` 数组末尾；除新增条目外不得改动既有条目。

## 从 local 接收新插件的验收清单

1. `git show --stat` 确认提交内容仅含上述文件，无越界文件。
2. `npm test` 全绿（至少 `node --test tests/tooling.test.mjs`）。
3. `sha256sum artifacts/<id>-<version>.echomod` == manifest 中 `distribution.sha256`。
4. 推送后验收：
   `curl -f https://raw.githubusercontent.com/oneday5799/EchoMusicNextPlugins/HEAD/plugins/<id>/manifest.json`
   与对应 `.echomod` 均返回 200（HEAD 即默认分支）。
5. 完整联网校验：`npm run check:published`。

## 网络备注

直连 GitHub 失败时附加 `-c http.proxy=http://127.0.0.1:7890`；
出现 `schannel` 握手失败改用 `-c http.sslBackend=openssl`。
