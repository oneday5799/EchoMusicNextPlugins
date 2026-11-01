# auto-team-vip 开发备忘（内部，不随包分发）

## 未解决：开启自动组队后「状态异常」状态行不能即时显示（2026-11-02 暂停）

状态：暂停排查，等待后续处理。仓库内代码为 fix2（干净、无插桩），测试全绿；
但在真实应用中仍未达到需求行为。

### 需求

poolDisabled 的状态行（“状态异常，请联系插件作者处理，或等待下期组队”，
`qml/TeamPanelBody.qml` 的 poolLine，可见条件
`autoEnabled && (poolDisabled || poolDown)`）应在打开「自动组队」开关的瞬间显示，
不必重开面板。

### 原始 bug 已确认的根因（diag2 插桩实测）

1. 新装/重启后拦截器尚未捕获鉴权头（capturedAuth=null），完整流程会被
   `runner.ts` 的鉴权门控挡在 ① getPeriodInfo 之前，永远到不了 ③ doSnapshot，
   poolDisabled 无人置位。
2. 第一版修复（applyKnownPoolDisable v1）依赖 state.periodId 与 uid，而新装会话
   两者皆空，函数直接早退，因此无效。

### fix2 的补偿方案（当前仓库代码）

- 激活时 `loadDisabled()` 载入 停用表 + `lastPeriodId` + `lastUid`
  （`lastCreatedTeam.uid` 兜底）到 `knownPeriodId`/`knownUid`；
- `runFullFlow` 通过鉴权门控后把 uid 落盘 `lastUid`（重启/重装后激活期即可用）；
- `settingsReady`（激活）与 `set-auto`（拨开关）都先 `applyKnownPoolDisable()`
  再 `publishPanel()`；编译产物已确认含该调用（entry.mjs set-auto 段）。
- 测试：tests/auto-team-vip.test.mjs 覆盖 标记命中/持久回退/建队码兜底/清除陈旧标记/
  期次未知不动/首跑落盘 lastUid。

### diag3 插桩实测：激活链路全部正确

diag3 = fix2 + console.warn('[atv3] …') 插桩（runner.ts：loadDisabledPeriods/
loadDisabled/applyKnownPoolDisable/doSnapshot/isPoolDisabled/requestRun/runFullFlow；
entry.ts：settingsReady/set-auto/publishPanel 签名日志）。真实应用激活序列：

```
02:26:47 loadDisabledPeriods setSize=1
02:26:47 loadDisabled period=302 uid=589524259 setSize=1
02:26:47 applyKPD auth=null runUid= knownUid=589524259 statePeriod= knownPeriod=302 setSize=1
02:26:47 applyKPD key=302:589524259 -> poolDisabled=true
02:26:47 settingsReady autoEnabled=true poolDisabled=true
02:26:47 publish true/true/false/unauth        ← autoEnabled/poolDisabled/authState
02:26:50 runFullFlow startup → flow GATED-OUT loggedIn=true（音乐暂停，无新鉴权头）
02:26:57 publish true/true/false/ok
```

此时打开弹窗：poolLine「状态异常…」与 messageLine「登录态同步中…」都正确渲染。

心跳/panel_open 快照流也正确：
`doSnapshot period=302 uid=589524259 → isPoolDisabled 302:589524259 memory-hit=true →
snap=disabled`（签名不变故不再 publish，符合设计）。

### 暂停点：两个未解释的现象

1. **fix2 拨开关路径无效果**：02:11:53 拨开关（storage 确认 set-auto 已把
   settings.autoEnabled 写为 true），1 秒后截图无状态行；此后数分钟心跳、刷新、
   重开面板均无。与 diag3 激活链路（同一段代码）表现矛盾。
2. **02:28:00 会话重建/包回退**：误点插件卡「移除」弹出卸载确认框、随后取消期间，
   宿主用干净 fix2 重建了插件——新解包 743fae05 的 entry.mjs sha=20a725c9（干净
   fix2），diag3 解包消失，安装目录文件全部变为 02:28、sha=fix2，日志无任何 [atv3]
   输出。重建的确切机制未确认（宿主回退或人工重装）。存储幸存
   （poolAuthDisabled/lastPeriodId/lastUid/lastCreatedTeam/settings 全在，
   mtime 02:28:09）。重建后的会话按 fix2 逻辑激活（autoEnabled=true + 有标记）应
   publish true/true，但当前弹窗仍无状态行。

下一步建议（届时从此处继续）：

- publishPanel 改为无条件打印签名 + QML 侧对 poolDisabled 变化加日志，双端对时；
- 重启应用后用全新会话只测一次「关→开」，排除会话重建/弹窗绑定干扰；
- 重点怀疑方向：a) set-auto 即时发布是否真的到达 QML；b) 卸载确认/取消触发宿主
  重建会话后，旧弹窗实例与新会话的 setState 是否失联。

### 复现/诊断材料

- 真实应用日志：`C:/Users/Oneday/AppData/Local/hoowhoami/EchoMusicNext/logs/
echomusicnext-2026-11-01_23-39-59-701-2200.log`（含 [atv-diag2]/[atv3] 行，
  关键窗口 02:26:47–02:28:10）
- 存储：`C:/Users/Oneday/AppData/Local/hoowhoami/EchoMusicNext/plugins/.data/
auto-team-vip/values.sqlite`（plugin_values 表；key：poolAuthDisabled /
  lastPeriodId / lastUid / lastCreatedTeam / settings）
- 停用标记 key 格式：`期次:uid` = `302:589524259`（302=第152期）
- 干净包：`artifacts/auto-team-vip-1.2.6.echomod`
  （sha256 d120db5bd81cea6f8a57746b05cb946a6f0faa7db78f92cd81b53c331543eec0，
  entry.mjs 20a725c9d89cfbfb42eef408a73553ad87d021291cd8bd489d15a962f2a0e230）；
  暂存副本 `C:/tmp-atv/auto-team-vip-1.2.6-fix2.echomod`
- 插桩版重建法：复制 `plugins/auto-team-vip` → `C:/tmp-atv/atv-diagN`，按上文清单加
  `console.warn('[atvN] …')`（注意：console.info 不落盘，console.warn 落为
  `[qml] WARN`），`npx echo-plugin build <目录> --out <输出目录>`，经应用
  「安装插件」选择器安装，两个授权框都选 Yes。音乐暂停时拦截器捕获不到新鉴权头，
  流程会 GATED-OUT（播一首歌即可恢复）。

### 顺带记录

- 插件管理「移除」→ 确认框出现时宿主即停用会话；取消后会用既有包重建会话，
  期间旧弹窗实例可能失效。
- QML 引擎对 esbuild 产物报 `usedbeforedeclared("step")` 警告（entry.mjs 顶部），
  无实际影响，暂不处理。
