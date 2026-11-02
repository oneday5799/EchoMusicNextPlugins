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

## 2026-11-03 创建队占用设备：DECIDE 规则修正（1.2.7）

- 用户实测（第152期/302，uid 2154330018）：创建队 1/3 **未满员**时队长申请加入他人
  队伍同样被 143005"每台设备只能加入一个队伍"拒绝。旧观察"未满员创建队仍可加入
  他人"不成立（可能酷狗已调整规则）。
- ④ DECIDE 由此改为：设备在任一队伍（加入的或创建的，无论满员）即终态，队长只等
  待队员经组队码加入；快照照常上报，不再为队长消耗租约（旧行为会领码→join→143005
  →device_already_bound 报错，浪费一个租约并吓到用户）。
- `device_already_bound`（143005 且查不到任何队伍）分支保留：覆盖设备绑定来源不可
  见的场景（如旧客户端残留绑定）。
- `deviceCreatedPeriods` 标记分支补充建队探测：直查仍取不到码时探测一次 create——
  若用户已在概念版APP解散队伍，借此自动恢复；仍被拒则维持 created_code_pending 轻提示。
- 自动模式随之改为 **joiner-first**：不再预建队（旧版 ② MYINFO 后无条件 create——
  若保留，所有设备都立刻成为队长终态，码池里只有 1/3 的队、无人租码加入，全局死锁）。
  新顺序：② MYINFO → ③ SNAPSHOT → ④ DECIDE（joined/created 即终态）→ ⑤ 租码 →
  join；仅当码池返回 pool_empty 时才转入建队（ensureTeamCreated），成队后补一次
  快照把新码注册入池，失败则报 create_team_failed 并武装空池退避（20/30/60min）。
  角色由此按池内供需自发分配：有队可加就加入（快满优先填满 3/3），池空才建队供码。
- 手动模式（自动开关关闭）保持"无条件自动建队"语义（用户 2026-11-03 要求），
  零码池交流不变；deviceCreatedPeriods 标记分支与探测恢复对手动模式照常生效。
- 队长（创建队）心跳仍走完整流程（state.joined 只覆盖加入侧）：DECIDE 直接终态，
  但完整流程顺带刷新成员人数，且 APP 解散队伍后可经 pool_empty 建队路径自愈。

## 2026-11-03 用户更正：资格问题与组队不可解散（1.2.7 内修正）

- 用户反馈两条关键事实：
  1. 本次的"无法加入其他队伍"（143005/device_already_bound）与稍早的"当前设备已经
     创建过队伍"（拒建）**都是因为该账号从没有组过队**——从未组过队的账号首次使用
     必须先在概念版APP中**手动组队一次**，之后 create/join 才正常。酷狗在两种场景
     给出的都是误导性文案（"设备"措辞），并非真实的设备绑定原因。
  2. **组队没有解散的方法，官方APP也不行**。期内一旦入队即为终态，只能等期次切换。
- 据此修正：
  - ④ DECIDE 撤回"任意创建队即终态"：恢复旧规则——已加入他人队伍、或创建队**满员**
    才是终态；未满员队长默认可租码加入他人。
  - 自适应兜底：队长 join 被拒且 myinfo 可见创建队（143005）时，落期次级
    `joinBlockedPeriods` 标记（仅内存，重启重新学习，每期至多浪费一个租约），
    本期退回等待态不再逐轮租码。若"创建队占用设备"实际不存在，该分支永不触发。
  - 移除 marker 分支的建队探测：组队无法解散，"已建队查不到码"只能是查询滞后或
    资格性拒建，再次 create 无意义；直查 miss 给 created_code_pending 轻提示。
  - 三条错误文案（created_team_unreadable / created_code_pending / device_already_bound
    两分支）统一补充"若本账号从未组过队，需先在APP中手动组队一次"的补救指引。
  - pool_empty 转建队路径无论成败都武装空池退避（等待中的队长经 snapshotOnly 分支
    继续按面板开/关 5/30min 刷新人数，不再每 10min 空转完整流程）。
- joiner-first（先租码后建队）不受影响保留：与资格问题无关，它解决的是角色分配
  效率（避免开局人人预建队互等），且在"队长可加入"与"队长被锁"两种世界里都能收敛。
- 用户进一步澄清（同日）：建队被拒（"当前设备已经创建过队伍"）的补救是**在概念版APP
  中打开一次组队页面**——打开组队页即自动建队；加入被 143005 拒（含面板手动加入）
  的补救是**在APP组队页手动加入一次其他人的队伍**。toast 一律只显示酷狗原始
  errorMsg（如"每台设备只能加入一个队伍~~"），完整补救指引显示在面板下方状态区。
