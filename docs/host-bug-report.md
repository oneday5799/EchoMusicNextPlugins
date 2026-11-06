# 宿主侧问题报告：插件存储 FFI 数组序列化、激活期读取竞态与命令名路由

- 日期：2026-11-06
- 宿主版本：`0.1.0-dev build=20261105T221716Z-9dd960da6b46-dirty`（Qt 6.12.0 / MSVC x86_64 / Windows）
- 受影响插件：`local-music 1.0.0`（本人开发，仓库 `hyhoowhoami/EchoMusicNextPlugins`）；问题 H3 同样影响 `webdav-music` 与 `spectrum-visualizer`
- 排查方式：插件内临时诊断快照持久化到插件私有 KV（`plugins/.data/local-music/values.sqlite`）、QML 侧指纹 toast、宿主日志与 KV 数据库直接比对
- 结论状态：插件侧已全部兜底修复并验证通过（设置页、曲库热启动、重启持久化均正常）；宿主侧仍有值得根修的两个缺陷，见 H1、H2

---

## TL;DR

排查「点击添加文件夹后设置页显示 0 个文件夹、能扫描到歌曲、重启后全部消失」这一现象过程中，确认了三个宿主侧行为缺陷与一个插件生态约定问题：

| 编号 | 问题                                                                                 | 严重度                          | 状态                             |
| ---- | ------------------------------------------------------------------------------------ | ------------------------------- | -------------------------------- |
| H1   | io 服务跨 FFI 交付的 JSON 数组丢失 `Array` 原型（JS 与 QML 双方向）                  | **高（数据类 API 全面受影响）** | 插件侧已兜底，建议宿主根修       |
| H2   | 插件激活期 `io.readValue` / 授权账本首次读取存在“瞬态为空”窗口                       | 中                              | 插件侧已自愈，建议宿主根修       |
| H3   | QML `plugin.executeCommand` 按命令名全局路由，跨插件同名命令互相抢答且**无任何告警** | 高（静默数据错接）              | 插件改名回避，建议宿主加冲突检测 |
| E1   | 插件生态层面 `settings.get` 等通用命令名的使用约定缺失                               | 低                              | 文档/命名约定即可                |

---

## H1 io 服务跨 FFI 交付的 JSON 数组丢失 Array 原型

### 现象

- 插件 `activate()` 中 `await ctx.io.readValue('settings')` 明确读回了完整数据（对象、字段、字符串全部正常），但值内的 `folders` 数组在运行时里 **`Array.isArray()` 返回 false**，`.map` 等 Array 方法不可用。
- 插件代码里所有依赖 `Array.isArray`/`Array.prototype` 的判断因此把宿主返回的数据判空：设置文件夹列表为空 → “0 个文件夹”；曲库缓存块（每首歌是 10 元素数组）无法还原 → 重启后曲库为空；封面索引读回失败 → `coverIndex` 长期残缺（长期只剩 1 条）。
- **同一数据写回宿主再宿主持久化是完好的**：宿主把运行时递回的对象序列化成真正的 JSON 数组存进 SQLite；即“JS 读进来不是数组，JS 写出去是数组”。
- **QML 方向对称存在**：插件命令 `library.settings.get` 的返回值里的 `folders` 数组（由插件用 `.map()` 构造的真实 JS 数组），跨 FFI 交付到 QML 页面后 `Array.isArray(result.folders)` 同样为 false（`JSON.stringify` 显示为 `[...]`，数据完好）。而同一份结果中的 `result.songs`（曲库页数据）在 QML 里却是真数组、`.map` 可用——两种表现并存，说明丢原型的转换路径只覆盖了部分绑定/作用域。

### 证据

激活瞬间诊断快照（插件在 `activate()` 读取后立即持久化 `__diag2` 到 KV）：

```json
{
  "activation": 1,
  "raw": {
    "folders": [
      {
        "id": "b81f7da6-c29c-4d8d-9db1-54514c73cb3c",
        "name": "Music",
        "path": "E:/Users/Oneday/Music"
      }
    ],
    "onlineFetch": false,
    "readEmbedded": true
  },
  "foldersLoaded": 0,
  "shape": {
    "topType": "object",
    "foldersIsArray": false,
    "firstType": "undefined",
    "firstJson": null
  }
}
```

- `raw` 经宿主序列化落到 KV 后包含真正的数组与字符串；
- 同一进程、同一时刻，运行时侧 `typeof folders !== 'array'`（`firstType: undefined` 是因为 `Array.isArray` 失败导致没取到下标 0）。

对照实验：

- `ctx.files.listGrants()` 的返回数组在运行时里是**真数组**（`ledger.map(...)` 正常工作）——files 服务的数组转换是对的，io 服务的不是。
- 使用 `Array.from`/`length`+循环索引/连续数字键三种兜底策略都能完整还原数据，证明不是内容问题，而是原型/包装问题。

### 复现

1. 插件通过 `ctx.io.writeValue('settings', { folders: [{ id, name, path }], readEmbedded, onlineFetch })` 写入任意数组型 JSON；
2. `await ctx.io.readValue('settings')`，在运行时执行 `Array.isArray(result.folders)` → false；
3. 同一对象把 `result` 直接 `ctx.io.writeValue('__probe', result)` 写回，从 KV 读出序列化内容为正常 JSON 数组。

QML 方向：注册一个返回 `{ folders: [...] }` 的命令，在 QML 页 `plugin.executeCommand` 完成回调里对 `result.folders` 做 `Array.isArray` 判断即可复现 false（同时 `JSON.stringify(result)` 显示 `[...]`）。

### 根因推测（host 代码定位建议）

- io 服务的值在 worker/sqlite 层反序列化后，经 Qt→JS 边界转换为某种**丢失 Array 原型的宿主列表包装**（例如直接以 `QObject`/custom wrapper/`QVariantMap` 引用形式暴露，而不是按 `QJsonArray → JS Array` 的标准转换）。
- files 服务的 `listGrants`/`listFiles` 走的转换路径是正确的，**以它的实现为基准修正 io 服务的值转换即可**。
- QML 方向的问题在 `EchoPluginOperation.result` 的 QProperty/SIGNAL 交付转换处，同样的包装泄漏到 QML JS 引擎（V4）中。

### 建议修复

1. io 服务 `readValue` 返回值转换处：确保 JSON 数组一律转换为 JS 原生 Array（或至少带上 `Array.prototype` 的宿主代理），并补充类型回调/单测：写入→读回→`Array.isArray` 断言。
2. `EchoPluginOperation.result` 的 QML 交付转换：与上一条同基准。
3. 回归用例建议包含：嵌套数组（对象内数组）、数组内嵌对象、空数组、大数组（约 500 项）四类形状。

### 插件侧临时规避（已上线）

`plugins/local-music/src/codec.ts` 的 `coerceJsonArray()`：真数组 → `Symbol.iterator` 可迭代 → 数值 `length`+循环索引 → 连续 `"0..n-1"` 数字键 → 空数组，四级还原；插件所有 io 读消费点（settings、library cache meta/chunks、cover index）与 QML 侧 `asArray()`（`Settings.qml`/`BrowserPage.qml`）均已接入。宿主根修后此兜底无害。

---

## H2 激活期 `io.readValue` / 授权账本瞬态为空

### 现象

- 插件 `activate()` 早期对 `ctx.io.readValue(SETTINGS_KEY)` 的首次读取偶发返回空/失败；同一会话稍后（实测 +2s 起）同一键可读回完整数据。
- 解析观察：某次激活的自愈定时器（t≈+2s）触发时**早于激活自身完成**（激活内首次 `readValue` 等待约 4 秒才落定），期间打开的页面看到空状态。
- 文档既有口径：「授权账本可在插件更新等窗口瞬态为空」（仓库注释所述），本次观察表明 io 读取同样处于该窗口且**失败不报错、静默返回 undefined**，而插件依赖激活读装载全部状态，导致整个会话空跑直至用户重新添加文件夹。

### 证据

- 同一会话诊断快照时间线：`__diag2`（激活内读取完成）于 `00:27:30.140Z` 写入、内容完整且 `foldersLoaded: 1`；自愈定时器快照 `__diag` 于 `00:27:28.306Z`（激活仍进行中）已能成功读回同一键数据。
- 多次重启中 `readValue('settings')` 在激活瞬间返回空、+2s 后返回数据，且 KV 内容自始至终未被破坏。

### 建议修复

1. io worker 的 SQLite 连接应在激活准入前完成绑定；激活期读未就绪时应**挂起（pending）**而非立即解析为 `undefined`，或直接让操作进入 Failed 态（带 errorCode），让插件可感知重试。
2. 激活预算（5s）与此竞态叠加时，建议：io 未就绪期间 `readValue` 操作处于 Running 而不结算；或宿主延迟插件激活直到存储服务可用。
3. 与授权账本（files service）行为对齐：同一个窗口两类资源一起修复。

### 插件侧临时规避（已上线）

- `ensureStorage()`：`settings.folders.length === 0` 时重读存储，恢复设置→重新认领文件夹→`warmStart()` 曲库缓存；
- 激活后 t≈+2s、必要 +6s 两轮自愈定时器；
- `settingsGet`/`libraryInfo` 响应前先跑 `ensureStorage/ensureGrants`；
- 恢复成功后递增 `settingsRevision`/`libraryRevision` 并推送 state，已渲染页面（`Settings.qml` 增加 `onStateChanged` 监听、`BrowserPage.qml` 沿用 revision 比对）自动重查。

---

## H3 QML `executeCommand` 按命令名全局路由，同名互相抢答

### 现象

- 插件 `local-music`、`webdav-music`、`spectrum-visualizer` 均注册了内部命令 `settings.get` / `settings.patch`（spectrum 还有 `settings.reset`）。
- 任一插件页面（含宿主「插件管理→设置」页面与插件自开对话框）调用 `plugin.executeCommand('settings.get')`，实际由**其他插件**响应：返回对方结构的 JSON（不含 `folders` 字段），`Array.isArray(result.folders)` 为 false → 页面显示“0 个文件夹”，**全程无错误、无日志、无告警**。
- 文档口径「内部命令不进入公开目录、不能被另一个插件调用」与实现行为不一致：QML 侧按名路由实际是全局命名空间。

### 证据（现场 toast 摘录）

- 同一插件会话内（能正常添加文件夹并通过 `folders.add` 拿到 `ok:true`）：
  - `library.settings.add → {"id":"b81f7da6-…","ok":true,…}`（local-music 独有命令，路由正确）
  - 改名前的 `settings.get` 返回 `{"folders":[],"onlineFetch":false,"readEmbedded":true}`——注意字段顺序是**字母序**（`folders < onlineFetch < readEmbedded`），说明响应大概率非本插件构造字面量/或经 Qt 字典序列化；结合两插件同名注册，判定为跨插件抢答。
- 命令改名（`library.settings.*`）后计数立即正确，证实路由按名匹配而非按注册作用域。

### 建议修复

1. 宿主在 `registerCommand` 时检测**跨插件同名注册**：要么拒绝注册（激活失败并给出明确错误），要么注册成功但在日志里产生 WARN——避免静默抢答。
2. `executeCommand` 路由应绑定发起方的作用域/插件实例（页面所属插件上下文），而非全局名字表；或为 QML 侧提供显式带插件限定符的路由参数。
3. 长期看，生态上应鼓励命名空间化命令名（如 `<plugin-id>.<命令>`），文档目前已有「内部命令」表述，建议把命名空间化写成硬性约定。
4. 顺手修一处：`webdav-music` 与 `spectrum-visualizer` 之间同款撞车仍在（两者互相抢答 `settings.get`），它们需做同样的改名（插件仓库 TODO）。

---

## E1 生态约定：通用命令名命名空间化

- 本次事故的 H3 一半根因是三个插件都选了“通用度最高”的名字。建议在插件开发文档中明确：
  - 内部命令一律 `<插件id>.<域>.<动作>`（local-music 现为 `library.settings.get/patch`）；
  - 宿主对同名注册给出构建/激活期错误；
  - `check-*` 工具链增加「仓库内跨插件命令名重复」静态检查（`plugins/webdav-music`、`plugins/spectrum-visualizer` 当前即重复）。

---

## 排查过程时间线（摘要）

| 时刻（本地） | 事件                                                                            | 关键证据                                                        |
| ------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 07:15 会话   | 旧构建加载；用户报告添加后计数 0、能扫描                                        | 插件 runtime 目录与 KV 均正常写入                               |
| 07:15        | 重装新构建（含两笔授权自愈修复）；用户添加 `3ea98a30…`、扫描 46 首 | KV `settings`/`library` 均正确持久化                            |
| 07:45 重启   | 设置页 0、曲库空（用户观察）；日志无插件错误                                    | KV 数据仍在 → 数据未丢，读取链路存疑                            |
| 08:01        | 用户重新添加（新 grant `acc5f819…`）                                            | 库 `library` 元数据变为新 id（id 每场会话变化，与 H2 竞态一致） |
| 08:12        | 安装改名版 + 重启；报告仍丢                                                     | `settings` 落盘 `bded9075…`；激活读取仍空                       |
| 09:06        | 安装持久化诊断版；`__diag2` 显示**激活读取已拿到完整数据但 `foldersLoaded: 0`** | 定位到归一化层的 `Array.isArray` 误判                           |
| 09:18        | 类型指纹版：`foldersIsArray: false`、真数组还原后 `foldersLoaded: 1`            | **H1 实锤**                                                     |
| 09:27+       | `coerceJsonArray` 全链路修复；toast 显示结果含完整 folders 但 QML 计数仍 0      | **H1/QML 方向实锤**                                             |
| 最终         | QML `asArray` 兜底后全部正常：设置页 1 个文件夹、曲库 46 首热启动、重启持久     | 用户确认                                                        |

旁证：`coverIndex` 长期只剩 1 条、专辑封面清理失效，与 H1 同源（`cleanupCovers` 读回失败即提前返回）。

---

## 宿主修复建议优先级

1. **H1 io/操作结果数组原型丢失**——影响所有插件的所有数组型数据读写，建议尽快修，并补形状回归用例。
2. **H3 命令名全局路由抢答**——静默数据错接，影响面是所有使用通用命令名的插件；建议注册期冲突检测 + 作用域路由。
3. **H2 激活期读取竞态**——影响首体验（空页面/丢状态假象）；建议 ioutil 就绪前挂起 或激活延后。
4. **E1 文档与工具链**——命名约定写成规范，`check-*` 增加重名检测。

## 插件仓库状态（2026-11-06）

- `local-music` 已发布兜底修复版 `dist/local-music-1.0.0.echomod`（rename + coerceJsonArray 全链路 + 自愈 + revision 推送），158 项单测通过。
- 待办：`webdav-music`/`spectrum-visualizer` 改名同款命令；插件诊断代码已全部移除，激活时会清理遗留 `__diag`/`__diag2` 键。
