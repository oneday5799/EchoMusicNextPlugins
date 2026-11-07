# PixelSnap 递归崩溃修复后续：剩余问题报告

- 日期：2026-11-07（R1 复现升级后同日更新）
- 关联文档：`host-crash-report-pixel-snap-recursion.md`（原始崩溃报告）
- 宿主修复提交：EchoMusicNext `main-3` `79ed7d6`（6 文件，+71/−4）
- 插件侧缓解提交：EchoMusicNextPlugins `5be098d`（扫描进度限流与无变化跳过）
- 取证脚本：`build/diagnostics/`（walk-dump.py、stack-loop.py、thread-frames.py、symbolize-map.py、relink-map.cmd、launch-app.py）
- ⚠️ **当前状态：R1 已定位根因并修复**——根因是 **Qt 6.12.0 QV4 GC 回归（上游 bug，非宿主/插件代码缺陷）**，已用带两个上游修复的补丁版 `Qt6Qml.dll` 替换运行时（原件已备份），local-music 插件已恢复启用；风暴态 10/10 轮存活。详见 R1。

## 1. 修复范围与验证结论（回顾）

宿主侧按原报告 §6 实施：

1. **① 值即时 + 通知排队合并**（`EchoPixelSnapAttached`）：refresh() 立即落值（读你所写语义不变），`scenePositionChanged` / `devicePixelRatioChanged` / `densityChanged` 改为经 `QMetaObject::invokeMethod(Qt::QueuedConnection)` 排队、按事件循环轮次合并为一次 flush。同步 emit 造成的「绑定 → 写子几何 → 观察者链 → 再入 refresh」单栈嵌套环被打断为有界收敛。
2. **④ UiPart 视觉迟滞**（`EchoUiPartRegistration` + `EchoUiPartHost`）：`setResolved()` 的视觉覆盖标志改为排队重算（按稳定值翻转布尔），消除 refresh() detach→attach 穿过 `{}` 时 Loader 同步拆建；键/声明变更的身份重发布契约不变（`PluginRuntimeUiParts.cpp` 身份测试仍绿）。

A/B 实测（未缓解 local-music 插件，values.sqlite 复位触发全量重扫，CUA 驱动真实 UI）：

| 轮次 | 宿主 | 场景 | 结果 |
|---|---|---|---|
| A1–A4 | 基线 exe（267831d9…） | 页面加载 | 4/4 全崩，原始签名（Qt6Qml+0x11819c，slot×15/refresh×3/y-binding×3） |
| B1 | 修复版 exe（40b03ca9…） | 页面加载 + 扫描×3 | 活过页面加载与扫描 #1–#2；#3 后崩（见 R1） |
| C1 对照 | 基线 exe + `ECHO_PIXEL_SNAP=0` | 扫描×10 | 0 崩溃 |
| B2 复跑 | 修复版 exe | 扫描×6 | 0 崩溃（越过 B1 死亡点） |
| B3 | 修复版 exe + **缓解版**插件 | 纯启动（重扫风暴） | **启动即崩**（dump 3ef99501，16:36） |
| B4 | 同上 | 再次启动 | **再次启动即崩**（dump c611947e，16:44） |
| B5 | 修复版 exe，**禁用 local-music** | 启动 + 2 分钟观察 | 稳定（pid 23772） |

结论：原始 pixel-snap 观察者环**已打断**（基线 4/4 页面加载崩 → 修复版 9 次扫描 + 多次页面加载不再复现该签名）。但 R1 的 UAF 家族与 PixelSnap 无关、且**不依赖未缓解插件**——缓解版插件在插件库重扫期间同样触发，当前已升级为阻断级问题，见 R1。

## 2. 剩余问题

### R1（已修复）Qt 6.12.0 QV4 GC 回归：挂起 generator 帧不被标记 → UAF 家族崩溃

**最终定性：上游 Qt bug，宿主与插件代码均无需修改。**

**现象与复现时间线**：

| 时刻 | 场景 | 结果 |
|---|---|---|
| 12:11 | 修复版 + 未缓解插件，扫描 #3 | 崩溃（dump b9365d0e） |
| 16:36 | 修复版 + **缓解版**插件，纯启动（插件库重扫风暴） | 崩溃（dump 3ef99501） |
| 16:44 | 同上，再次启动 | 崩溃（dump c611947e） |
| 16:45 | 禁用 local-music 后启动 | 稳定运行 |
| 18:00 | 风暴复现 harness（`repro-r1.py`，重扫态启动循环） | round 2/8 崩溃（dump 7787486a） |
| 18:04 | 同 harness + `QV4_MM_CROSS_VALIDATE_INCREMENTAL_GC=1` | **6/6 存活** |
| 18:11 | 同 harness + `QV4_GC_TIMELIMIT=0`（禁增量 GC） | **6/6 存活** |
| 19:13 | 同 harness + 补丁版 Qt6Qml.dll | **10/10 存活**（每轮风暴 183–186 invokes） |

**崩溃机制（根因）**：

1. Qt 6.12.0 对 `MemoryManager::collectFromJSStack` 的重构（QTBUG-151273 修复引入的回归）使**挂起状态的 generator 帧不再被 GC 标记**——generator 帧存于堆对象而非 JS 栈，解释器写入其寄存器无写屏障，挂起期间 GC 全然不知；
2. 帧内**仅被该帧引用**的对象被 GC 释放；generator 恢复执行时即 UAF——三个崩溃签名全部由此而来：`getterFallback` 读已释放对象（dump 3ef99501 rax=0xC0000001、7787486a rax 指向不可读页）、sweeper 工作表弹出 NULL（65a4236d、c611947e）；
3. **触发面**：local-music 的 TS 经 esbuild 编译，每个 `async/await` 均降级为显式 `function*`（`entry.mjs` 内 69 处 `__async(..., function* ...)`）；启动期封面回填风暴（激活 +1.5s 的 `runWarmCoverBackfill`）挂起数十个 generator，与 GC 相撞概率大增；
4. 上游修复：`7d5e24963`（Make sure to mark generator stack frames properly）+ `9eca4322a`（QTBUG-151511，Check function for null before marking generator frames），均在 6.12.0 发布（2026-09-30）之后进入 6.12 分支，fixVersion 6.12.1（**尚未发布**，快照站亦无 6.12.1 预编译包）。

**取证勘误（撤销原"共享宿主链"）**：原报告两次 B 侧崩溃的四个 exe 锚点（`reauthorize+0x6fa` / `~Service+0x53` / `GpuSurface ctor` / `validOptions`）全部为**栈残留误归因**——`0x4d8b4a` 位于函数 epilogue（security-cookie 检查调用之后），不可能作为活动返回地址存在；该地址是历次函数调用结束时 `__security_check_cookie` 调用遗留在栈字节里的代码指针，被自研回走器的扫描回退误捕。宿主 PluginSdk 源码审计（operation/picker/MediaLease/Service 的所有权翻转与 QJSValue 生命周期）未发现缺陷；崩溃实况栈为纯 QV4 求值链（事件循环 → `QQmlJavaScriptExpression::publicContext` → JS 求值 → `getterTwoClasses`/`getterFallback` → `Value::toObject` → 分配 → GC）。

**修复实施（宿主侧 = 替换带补丁的运行时）**：

- 源码：`qtdeclarative-everywhere-src-6.12.0` 官方 tarball（`build/qt-patch/`）+ `genfix1.patch`/`genfix2.patch`（从 6.12 分支 cherry-pick 的两个上游提交，测试文件 hunk 已剔除）；
- **ABI 保持**：上游补丁将 `QV4::Value::mark` 改为 const 成员，导出符号随之改名（`QEBAX`），依赖旧导出的 Qt6Quick 等 DLL 加载即 `0xC0000139 ENTRYPOINT_NOT_FOUND`——已回退该 const 改动（`markJSFrame` 内部 `const_cast`），导出表与原件零缺失（仅新增 `markJSFrame`）；
- 产物 `Qt6Qml.dll`（含 PDB 可选）替换至 `build/qt-official/6.12.0/msvc2022_64/bin/`，原件备份 `build/qt-patch/Qt6Qml.dll.orig-6.12.0`；构建脚本 `build-qml.bat` / `rebuild-qml.bat`（仅编 `Qml` 目标，约 5 分钟）；
- 验证：风暴态（grants 对齐 + `values.sqlite.bak` 重扫态）10/10 轮存活、插件恢复启用后实机启动 100s 稳定；
- 复现/回归 harness：`build/diagnostics/repro-r1.py`（用法 `python -I repro-r1.py [rounds]`，环境变量 `REPRO_WINDOW`）。

**遗留跟进**：

1. Qt 6.12.1 官方包发布后，换官方 QtQml 并可移除本地补丁树（保留备份原件即可回滚）；
2. 同期 6.12 分支还有数个相关修复（`5f22a7236` JIT SetLookup 累加器、`1365c0422` lost-object ReferenceError、`0e96f017a` Incubator UAF）不在 6.12.0 内，6.12.1 发布时一并覆盖；
3. 插件侧无需改动：async/await 是正当写法，风暴是其正常启动路径。

### R2（环境）控件测试套件在无窗口运行环境大面积失败

- 全套 `tests/qt/controls` 在当前非交互环境下 9 通过 / 55 失败 / 3 跳过（`session.create()` 失败一类），基线同样如此 —— 套件依赖可交互 QML 会话；
- 两个单测失败（`iconButtonHoverScalesStableRasterAndHitRegion`、`uiPartMountsReplaceAndRetire`）经 stash 基线对照确认为**预存/环境性**，与本修复无关；
- 本次修复相关子集已单独跑绿：`pixelSnapTracksScenePositionAcrossReparentAndWindows`、`imageDensity×2`、`uiStyleLayersRestoreLiveBindings`、`uiPartsIdentityObservationAndPublicActions`、`uiPartsProductionPlaybackAndMini`、`uiPartInstanceStylesAndLeasesStayBounded`、`temporaryAppearancePriorityLiveBaseAndRevocation`、`appearanceErrorsAndActivationRollback`。
- 建议：为 CI/本地提供窗口化测试 harness（或在文档中固定「测试须在交互会话运行」），并给两个预存失败建立跟踪。

### R3（工程化）Release 链接不产出新 PDB，符号化依赖 /MAP 重链

- `build/release/app/echomusicnext.pdb` 为旧配置残留（链接规则虽带 `/pdb:`，但当前 Release 链接实际未产出可用 PDB），崩溃归因只能走「/MAP 重链 + .pdata 指纹比对」管线；
- 现有工具：`relink-map.cmd`（从 build.ninja 边重建 rsp 并 `/MAP` 重链）+ `symbolize-map.py`（校验 `.pdata` md5 与崩溃映像一致后按 map 符号化）。本次 `.pdata` md5=`5191dc808c9a7d7fb9052443c9975a19`；
- 建议：Release 构建保留符号（`/Zi /DEBUG` + PDB 归档，或 CI 上传符号工件），能把每次取证的半小时管线缩到一条命令。

### R4（语义记录）本修复带来的可观察行为变化

- snap 相关属性（scenePosition/devicePixelRatio/density）**值立即生效、通知延迟一事件循环轮**且突发合并为一次。仅影响亚像素对齐，视觉不可见；依赖同步通知的消费者需改走 QTRY（本次唯一需要适配的测试即如此）；
- `hasVisualOverrides` 相对 overrides 稳定值**迟滞一事件循环轮**，Loader 不再在 attach/detach 穿越期拆建；`overrides` 属性本身与身份重发布时序完全不变；
- 测试适配：`ControlsUiPixelSnap.cpp` 一处 `QCOMPARE` → `QTRY_COMPARE`（附注释）。

## 3. 取证方法论勘误（记录教训）

B1 崩溃初期曾误读为「ProxyPacDns/代理解析新递归」——`stack-loop.py` 对 RSP±4MB 的**全部内存范围**做直方图，把堆内存中巧合的 `ProxyPacDns::lookup/myIpAddress/ProxyResolver::resolve` 返回地址样值（×50+）当成了栈帧。事后用逐线程核对（`thread-frames.py`）：dump 共 71 线程，**没有任何线程的捕获栈**含该 RVA 窗口（0x260600–0x261200）地址 —— 整个 ProxyPacDns 线索是堆数据噪音。

结论：**直方图只可用于同线程栈窗口内的循环成员计数（如原始崩溃的 slot×26），跨线程/大窗口扫描一律先用逐线程栈归属过滤**。`thread-frames.py` 即为此新增。另补充两个必查项：异常参数（ExceptionInformation：读/写 + 错误地址）与寄存器 rax 的组合是区分「栈溢出 / 空指针 / UAF 毒化」的最快判据——本次家族重分类完全靠它；`llvm-objdump` 直接反汇编 Qt 模块（无 PDB 也能定位崩溃指令与函数名）。

## 4. 原报告勘误（4 处小偏差，不影响核心结论）

以下行号均指修复前源码：

1. §4.1 将「connectTarget()+refresh()」归于 EchoItemObserver：实际 `EchoItemObserver.cpp:94-95` 连接的是 reparent 信号；`connectTarget()+refresh()` 在 `EchoUiPartRegistration.cpp:93-102`（parentChanged/windowChanged 处理器）；
2. `setResolved` 早退守卫实际在 `EchoUiPartRegistration.cpp:119-126`，报告所写 117-118 是 `setBaseValues`；
3. 生成代码注释行号为 2417 而非 2407；
4. 「~140 层」在 22KB crashpad 栈窗口中只能看到 ~6 层，该数字仅能作为估计引用，无法从物证复核。

## 5. 证据与工件索引

| 工件 | 位置 / 标识 |
|---|---|
| B1 崩溃 dump | `logs/crashes/database/reports/b9365d0e-….dmp`（tid 28280，getterFallback UAF 前驱，Qt6Qml+0x19e3c8） |
| B3 崩溃 dump | `logs/crashes/database/reports/3ef99501-829c-48d0-a62f-797476b58f71.dmp`（16:36，**getterFallback UAF 直接确证**：rax=0xC0000001，指令 `mov rcx,[rax+0x10]`） |
| B4 崩溃 dump | `logs/crashes/database/reports/c611947e-….dmp`（16:44，Qt6Qml+0x1a6a98，rax=0，QV4 求值链） |
| A 侧基线 dumps | e330e31b / 08d766f4 / 4f0a0cd4 / e5684867 + 历史 11 个（全部浅栈 + freed/毒化指针读） |
| 基线 exe | `build/diagnostics/echomusicnext-BASELINE.exe`（md5 267831d9…） |
| 修复 exe | `build/diagnostics/echomusicnext-FIXED.exe`（md5 40b03ca9…；与 main-3 `79ed7d6` 源码对应） |
| /MAP 重链产物 | `build/release/app/echomusicnext-map.exe` + `echomusicnext.map`（`.pdata` md5 5191dc80… 与 B1 崩溃映像一致） |
| B1/B3 会话日志 | `logs/echomusicnext-2026-11-07_12-06-43-707-11204.log`（止于 12:11:10.114）；`logs/echomusicnext-2026-11-07_16-36-12-913-22284.log`（止于 16:36:21.865） |
| R1 复现崩溃 dump | `logs/crashes/database/reports/7787486a-….dmp`（18:00，风暴 harness round 2/8；getterFallback 链 + rax 指向不可读页） |
| 补丁版 Qt6Qml.dll | `build/qt-official/6.12.0/msvc2022_64/bin/Qt6Qml.dll`（原件备份 `build/qt-patch/Qt6Qml.dll.orig-6.12.0`） |
| 补丁源码树 | `build/qt-patch/qtdeclarative-everywhere-src-6.12.0/`（genfix1+genfix2 已应用；构建脚本 `build-qml.bat`/`rebuild-qml.bat`） |
| 风暴复现 harness | `build/diagnostics/repro-r1.py`（重扫态启动循环；配套 `values.sqlite.bak`、grants 对齐说明见 R1） |
| 当前运行状态 | local-music 已恢复启用（`plugins/local-music`），补丁版运行时下风暴态 10/10 存活、实机启动稳定 |
| 取证脚本 | `build/diagnostics/`：walk-dump.py、stack-loop.py、thread-frames.py、symbolize-map.py、relink-map.cmd |
| 测试基线定性 | stash 法对照两轮输出（build/diagnostics/test-out.txt） |

## 6. 建议优先级

1. ~~R1（P0，阻断）~~ **已完成**：根因 = Qt 6.12.0 QV4 GC 回归，补丁版 Qt6Qml.dll 已替换（10/10 风暴轮存活），插件已恢复启用；跟进项 = 6.12.1 发布后换官方包；
2. **R3**：Release PDB（低成本的长期取证收益）；
3. **R2**：测试 harness（改善回归效率）；
4. **R4**：无行动项，仅语义记录。
