# 宿主崩溃综合报告：PixelSnap 同步递归栈溢出 与 Qt 6.12.0 QV4 GC 回归

- 日期：2026-11-07（本报告合并原《pixel-snap 递归崩溃报告》与《修复后续：剩余问题报告》两篇文档并吸收其勘误，为唯一权威版本；原两篇见提交 `225cbf4`）
- 宿主：EchoMusicNext（Qt 6.12.0）；宿主修复提交：`main-3` `79ed7d6`（6 文件，+71/−4）
- 插件侧缓解提交：EchoMusicNextPlugins `5be098d`（扫描进度限流与无变化跳过）
- 取证脚本：宿主仓库 `build/diagnostics/`（walk-dump.py、stack-loop.py、thread-frames.py、symbolize-map.py、relink-map.cmd、launch-app.py、repro-r1.py）
- 行号约定：正文中宿主源码行号均指**修复前**源码（`79ed7d6` 之前）
- 最终状态：**两个独立根因均已修复，local-music 插件已恢复启用**——

## 1. 结论速览

|          | D1：PixelSnap 同步递归                                                                                                                      | D2（原 R1）：QV4 GC 回归                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 定性     | **宿主代码缺陷**                                                                                                                            | **Qt 上游 bug**（宿主与插件代码均无缺陷）                                                                          |
| 崩溃形态 | 主线程栈溢出（AV），死亡前 ~5 秒 RSS +200–260MB                                                                                             | UAF 家族：`getterFallback` 读已释放对象 / sweeper 工作表弹出 NULL                                                  |
| 机制     | `refresh()` 同步 emit scenePositionChanged → snap 绑定写子几何 → `EchoItemObserver` 级联 → 再入 refresh，叠加 EchoUiPart detach/attach 乒乓 | 6.12.0 重构 `collectFromJSStack` 后**挂起 generator 帧不被 GC 标记**，帧内独占对象被释放，generator 恢复执行即 UAF |
| 触发     | delegate/部件 churn（扫描重扫、页面重建、进度重渲染）                                                                                       | 启动期封面回填风暴挂起数十个 generator（async/await → `function*`），与增量 GC 相撞                                |
| 修复     | ① 通知排队合并 + ④ UiPart 视觉迟滞（`79ed7d6`）                                                                                             | 替换带两个上游修复的补丁版 `Qt6Qml.dll`（原件已备份）                                                              |
| 验证     | 基线 4/4 页面加载崩 → 修复版 9 次扫描 + 多次页面加载无该签名                                                                                | 风暴态 10/10 轮存活；实机启动稳定                                                                                  |

## 2. 时间线（全程，A/B 实测由 CUA 驱动真实 UI；未缓解插件 + values.sqlite 复位触发全量重扫）

| 顺序/时刻          | 场景                                                      | 结果                                                                                                        | 归属                     |
| ------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------ |
| 前期               | 未缓解插件扫描，7 次迭代                                  | 5 次崩溃，5 份 dump 同签名（同步递归栈溢出）                                                                | D1 定性                  |
| 插件缓解 `5be098d` | 7 次全场景迭代（空库首扫/有列表重扫/重启进页/完整库重扫） | 0 崩溃，主线程无 >64ms 忙 burst                                                                             | D1 缓解                  |
| A1–A4              | 基线 exe（md5 267831d9…），页面加载                       | **4/4 全崩**，原始签名（Qt6Qml+0x11819c，slot×15/refresh×3/y-binding×3）                                    | D1 复现基线              |
| B1                 | 修复版 exe（md5 40b03ca9…），页面加载 + 扫描×3            | 页面加载与扫描 #1–#2 存活；**12:11 扫描 #3 崩**（dump b9365d0e，Qt6Qml+0x19e3c8）                           | D1 环已断；该崩后归入 D2 |
| B2 复跑            | 修复版 exe，扫描×6                                        | 0 崩溃（越过 B1 死亡点）                                                                                    | —                        |
| C1 对照            | 基线 exe + `ECHO_PIXEL_SNAP=0`，扫描×10                   | 0 崩溃                                                                                                      | D1 对照                  |
| B3                 | 修复版 exe + **缓解版**插件，纯启动（插件库重扫风暴）     | **16:36 启动即崩**（dump 3ef99501，getterFallback UAF 直接确证：rax=0xC0000001，指令 `mov rcx,[rax+0x10]`） | **D2 升级为阻断**        |
| B4                 | 同上，再次启动                                            | **16:44 即崩**（dump c611947e，Qt6Qml+0x1a6a98，rax=0，QV4 求值链）                                         | D2                       |
| B5                 | 修复版 exe，**禁用 local-music**，启动 + 2 分钟观察       | 稳定（pid 23772）                                                                                           | D2 触发面定位            |
| 18:00              | 风暴复现 harness（`repro-r1.py`，重扫态启动循环）         | round 2/8 崩（dump 7787486a，getterFallback 链 + rax 指向不可读页）                                         | D2 稳定复现              |
| 18:04              | 同 harness + `QV4_MM_CROSS_VALIDATE_INCREMENTAL_GC=1`     | **6/6 存活**                                                                                                | D2 指向 GC               |
| 18:11              | 同 harness + `QV4_GC_TIMELIMIT=0`（禁增量 GC）            | **6/6 存活**                                                                                                | D2：禁增量 GC 即消失     |
| 19:13              | 同 harness + **补丁版 Qt6Qml.dll**                        | **10/10 存活**（每轮风暴 183–186 invokes）                                                                  | D2 修复验证              |
| 收尾               | 插件恢复启用，实机启动                                    | 稳定（>100s 观察）                                                                                          | 完结                     |

---

## 3. 缺陷一（D1）：PixelSnap 同步递归 —— 栈溢出（宿主代码缺陷，已修复）

### 3.1 证据与崩溃签名

证据：崩溃转储 ×5（`C:\Users\Oneday\AppData\Local\hoowhoami\EchoMusicNext\logs\crashes\database\reports\*.dmp`，同签名）；主线程 RIP 实时采样（12ms，确认死亡窗口在 Qt6Qml/Qt6Quick/exe 代码内）；`.pdata` 尺寸指纹 + 同源 map 构建 PDB 符号化（方法学与教训见 §7）。最初取证对象为安装版 exe（md5 `9b609bc8…`，与 `build/release/app` 产物一致，11-06 构建）。

重复栈组（5 份 dump 一致，自深至浅，一层循环）：

```
Qt6Core  信号激活 (QMetaObject::activate +0xec884/+0xe9906/+0xe9e63)
Quick    tiny lambda-invoker stub (0x5b9a1 / 0x5b9d0 / 0x607d0)
QV4      绑定求值帧群 (0x2efb4a / 0x4cb1e0 / 0x2ef064 / 0x1519fe / 0x1b8e08 / 0x1beb04 / 0x1c2240;
                  含 d_unchecked@QObjectMethod —— QV4 方法调用)
exe+0x8d290f  AOT 绑定帧（见 §3.2 符号化）
→ 回到信号激活，循环
```

- 循环嵌套约 ~140 层（22KB crashpad 栈窗口内可见 ~6 层，该数字为估计量级）。随后 AV。
- 死亡前 5 秒 RSS 线性 +200–260MB：每层的 QV4 求值分配 + `EchoUiPartRegistry` detach/attach 的 QVariantMap churn + `EchoIconSource.urlFor()` 触发的 `AppIconService` 缓存插入（栈上可见 `QHashPrivate::Node<QString, AppIconService::Entry>` 构造帧）。
- 时序敏感：同操作 5/7 次崩溃；插件限流后 7/7 存活。

### 3.2 循环成员符号化结果

| exe RVA                    | 函数（map 构建 PDB）                                                                                                           | 对应源码                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0x8d2040..0x8d29d5 (0x995) | `EchoIcon_qml::<lambda_27>::operator()`                                                                                        | **EchoIcon.qml:51 `alignedSurface.y` snap 绑定**（生成码 echo_controls_EchoIcon_qml.cpp:**2417** 注释 "expression for y at line 51, column 9" 实锤） |
| 0x8d4630 (0x9bd)           | `EchoIcon_qml::<lambda_37>`                                                                                                    | 生成码 ：3660                                                                                                                                        |
| 0x8d5350 (0x6c5)           | `EchoIcon_qml::<lambda_7>`                                                                                                     | 生成码 ：1154                                                                                                                                        |
| 0x8d37b0 (0xee)            | `EchoIcon_qml::<lambda_31>`                                                                                                    | 生成码 ：2985                                                                                                                                        |
| 0x872480 (0x591)           | **`EchoPixelSnapAttached::refresh()`**（反汇编确认：三次 `mapToScene` + hypot + QPointer 空守卫；早期误判为 resolve() 已撤销） | EchoPixelSnap.cpp:47-87                                                                                                                              |
| 0x17560 (0x54) ×26/栈      | `QCallableObject<void (T::*)()>::impl` —— void() 成员槽激活（模板多解；结合调用序为 observer→refresh 一类连接）                | qobjectdefs_impl.h:538                                                                                                                               |
| 0x867db0 (0x93)            | `validSelector` 内联所在小包装（query/registerRule 路径，佐证部件注册 churn 在环内）                                           | EchoUiPartRegistry.cpp:65                                                                                                                            |
| 栈散布                     | `AppIconService` QHash 节点构造（图标缓存插入，每循环一次）                                                                    | AppIconService.cpp                                                                                                                                   |

一份 dump 的实测帧序（栈槽号自旧到新）：

```
y绑定@3373 → 槽@3305 → 槽@3205 → refresh@3161 → validSelector@2068
→ (0x3b8 未知帧)@1441 → 槽@1149 → 槽@1099 → refresh@1055 → y绑定@721 → y绑定@671
```

注意 **y绑定@721 → y绑定@671 仅隔 50 槽**：同一 y 绑定（或不同 EchoIcon 实例的同名 lambda）在中间仅隔一次信号激活即重入——典型的"写几何 → 通知 → 同一/同类绑定立即重评估"。

### 3.3 根因：四个宿主组件构成的同步反馈网

宿主源码参考（只读）：`D:\Code\EchoMusicNext\modules\EchoMusic\Controls\`

**(a) EchoItemObserver —— 观察者按需创建 + 同步 emit（"点火与传播"）**

- 87-92 行：观察目标自身 `x/y/width/height/transformOrigin/scale/rotation` 变化 → `sceneChanged`/`notifyTransform`。
- 94-95 行：`parentChanged/windowChanged` → `reparent()`（重连父观察者）。
- 96-101 行：**目标 `destroyed` 时同步 `retire(); emit changed(); emit sceneChanged();`**——delegate 销毁在信号链内直接点火。
- 128-146 行 `reparent()`：**按需递归创建祖先观察者**（`observeItem(m_item->parentItem())`，133 行），把父观察者的 `sceneChanged` 转发到自身（135-139 行）；**结尾同步 `emit changed(); emit sceneChanged();`（144-145 行）**——"挂接观察者"这个动作本身就会点火。
- 净效果：任何一处几何写/创建/销毁，都会沿观察者图**同步**扩散，且传播路径随"按需创建"而增长。

**(b) EchoPixelSnapAttached::refresh —— 变更即发射（"发电机"）**

- EchoPixelSnap.cpp:47-87；由 observer 的 `sceneChanged` 驱动（42-43 行连接）；重算 `mapToScene` ×3 + density。
- 有变化守卫（58-62 行：scene/dpr/density 均未变则直接返回），**但 churn 期间 scene 位置真实地在变，守卫挡不住**；每次变化同步 `emit scenePositionChanged()`（81-82 行）。

**(c) EchoIcon / EchoCover / EchoDivider —— snap 绑定写子项几何（"执行器"）**

- `EchoIcon.qml:50-53`、`EchoCover.qml:122-125`、`EchoDivider.qml:27-30`：`x/y = (Math.round(snapScene * dpr) − snapScene * dpr) / density`——读取**附着在自身 control 上的** EchoPixelSnap.scenePosition，写到**子项** alignedSurface 上。
- 关键在**嵌套**：EchoCover 的 alignedSurface 内含 CoverPlaceholder + 占位 EchoIcon（EchoCover.qml:88-101），EchoButton/EchoIconButton 内含 EchoIcon。嵌套的内层 EchoIcon 挂接时，`reparent()` 会为**其祖先链**（包括外层的 alignedSurface）创建观察者——外层 alignedSurface 的几何写会同步触发内层 EchoIcon 的 refresh → 内层绑定写内层 alignedSurface → 继续向下传播。多层嵌套组件使级联越走越深。
- 亚像素抖动：`Math.round` 补偿公式在分数 DPR（Windows 125%）+ 布局偏移下，可能在两个半设备像素边界间来回翻转（每次写回产生新的修正量），使同一组件的 snap 绑定反复重评估（与 dump 中 y绑定@721→@671 相邻自重入吻合）。

**(d) EchoUiPartRegistration —— detach/attach 乒乓（"燃料泵"）**

- 38-45 行 `refresh()`：**先 `detach` 再 `attach` 再 `emit changed()`**；`setRole/setKey/setSurface/...` 每个 setter 都触发（58-74 行宏）；**`parentChanged/windowChanged` 处理器（93-102 行）也走 `connectTarget()+refresh()`**（此归属曾误写为 EchoItemObserver，已按源码更正）。
- `EchoUiPartRegistry::attach()`（EchoUiPartRegistry.cpp:37-49）：**每次 attach 分配新 identity（`++m_sequence`）**，然后 `resolve(part)` → `setResolved(values)`；`detach()`（50-60 行）先 `setResolved({})`。
- 后果：**detach→attach 把 overrides 在 `{}` ↔ map 之间乒乓，`setResolved` 的相等守卫（119-126 行；117-118 行是 `setBaseValues`）每次都放行**，每次都 `emit overridesChanged()+changed()`；同时 `emit removed(id)`、`emit added(part)`、identity 每轮递增。churn 期间每个 delegate 里的每个部件都跑一遍，为信号网持续供能。
- 消费端放大：`EchoUiPartHost.qml:21-40` 的 `Loader.active` 绑定在 `Object.keys(hostPart.overrides).some(...)` 上——overrides 每次乒乓都会同步重建/销毁 Loader 内容（几何变化 → 又回到 (a) 的观察者级联）。

**闭环描述**：

```
扫描 churn（delegate/部件大量创建销毁、进度重渲染）
  → [同步信号链内] 部件创建(componentComplete)/销毁(~dtor) / 几何写
  → EchoItemObserver: xChanged/yChanged/destroyed/reparent 点火，观察者按需创建并扩散
  → EchoPixelSnapAttached::refresh()：scene 变了 → emit scenePositionChanged
  → EchoIcon/EchoCover/EchoDivider snap 绑定（QV4/AOT）重评估 → 写子项几何
  → 子项几何写再次进入观察者（含嵌套组件的祖先观察者）
  → （并行地）EchoUiPartRegistration setter/parentChanged → refresh() → detach+attach
      → setResolved 乒乓 + added/removed/changed + Loader.active 同步重建
  → …嵌套 ~140 层 → 栈溢出 AV；每层泄漏式分配 → +200–260MB
```

### 3.4 为什么插件扫描会点燃它

1. 扫描进度最初**每文件**发布 → 页面同步重渲染数百次（19 秒主线程冻结）；插件限流到 300ms 后仍保留每 300ms 一次的同步重渲染机会。
2. walk 结束 `notifyLibraryChanged()` → 页面 `resetView()`：`clearSongRows()`（model 重置，**同步销毁全部 row delegate**——每个 row 含 EchoCover/EchoButton/EchoIconButton/EchoIcon，即大量 EchoUiPart + EchoPixelSnap + 观察者）+ `pageLoad()` 逐批重建（`appendSongRows` 内 `forceLayout()` **同步**实例化可见 delegate）。
3. delegate 创建/销毁发生在信号链内时（forceLayout、Loader 重建、Enter 过渡期间），正好构成 §3.3 闭环的起点。
4. 此后 enrich/covers 阶段的持续进度发布提供反复的点火机会——单次点火即可成环（flaky 的来源）。

### 3.5 宿主修复实施与验证（`79ed7d6`）

1. **① 值即时 + 通知排队合并**（`EchoPixelSnapAttached`）：refresh() 立即落值（读你所写语义不变），`scenePositionChanged` / `devicePixelRatioChanged` / `densityChanged` 改为经 `QMetaObject::invokeMethod(Qt::QueuedConnection)` 排队、按事件循环轮次合并为一次 flush。「绑定 → 写子几何 → 观察者链 → 再入 refresh」的单栈嵌套环被打断为有界收敛。
2. **④ UiPart 视觉迟滞**（`EchoUiPartRegistration` + `EchoUiPartHost`）：`setResolved()` 的视觉覆盖标志改为排队重算（按稳定值翻转布尔，源码见 EchoUiPartRegistration.cpp:121-132），消除 refresh() detach→attach 穿过 `{}` 时 Loader 同步拆建；键/声明变更的身份重发布契约不变（`PluginRuntimeUiParts.cpp` 身份测试仍绿）。

验证见 §2 时间线：基线 4/4 页面加载崩 → 修复版 9 次扫描 + 多次页面加载不再复现 D1 签名；`ECHO_PIXEL_SNAP=0` 对照亦 0 崩。原报告 §6 建议中的 **②③⑤ 尚未实施**，仍建议纳入（见 §6）。

### 3.6 插件侧缓解（非根治；`5be098d`）

1. 扫描进度合并发布：300ms 窗口（`SCAN_PROGRESS_INTERVAL_MS`），消除每文件发布的 19 秒冻结；
2. 任务进度独立 1s 限流（`TASK_PROGRESS_INTERVAL_MS`）；
3. 页面 `onStateChanged` 对无变化的 scan 状态跳过赋值（`scanStateEquals`），稳态阶段横幅绑定零重评估；
4. artistLinks 项补空 `id`：消除宿主 `EchoArtistLinks.qml:50` 对 `modelData.id.length` 的逐次 TypeError（曾放大每次重评估成本）。

效果：复现崩溃率 5/7 → 0/7。**根因环在宿主代码内，已按 §3.5 根治。**

### 3.7 复现步骤（D1）

1. 启用 local-music 插件、禁用其他插件；删除/备份 `C:\Users\Oneday\AppData\Local\hoowhoami\EchoMusicNext\plugins\.data\local-music\values.sqlite`（清空曲库）。
2. 启动宿主 → 进入"本地音乐" → 点击"扫描"。
3. 预期：约 5 秒内崩溃（修复前概率 ~5/7）；`logs/crashes/database/reports/` 出现新 dump，签名同 §3.1。
4. 对照实验：设置 `ECHO_PIXEL_SNAP=0` 后重复（预期不崩，EchoPixelSnap.cpp:30-34 内置开关）；使用修复版宿主/缓解版插件重复（预期概率大幅下降直至消失）。
5. 采样工具：`Temp\sampler2.py`（主线程 RIP 采样 + 忙 burst 时抓 32KB 栈窗）与 `analyze-caps.py` 可实时捕捉递归开始时刻的活栈。

---

## 4. 缺陷二（D2，原 R1）：Qt 6.12.0 QV4 GC 回归 —— 挂起 generator 帧不被标记 → UAF（上游 bug，已用补丁运行时解决）

**最终定性：上游 Qt bug，宿主与插件代码均无需修改。**

### 4.1 现象

宿主修复 D1 之后仍崩：B1 扫描 #3（未缓解插件）、B3/B4 缓解版插件**纯启动**（插件库重扫风暴）即崩——不依赖 PixelSnap、不依赖未缓解插件。经 `repro-r1.py` harness 稳定复现，环境变量对照（§2 时间线 18:04/18:11 两行）锁定增量 GC。

### 4.2 崩溃机制（根因）

1. Qt 6.12.0 对 `MemoryManager::collectFromJSStack` 的重构（QTBUG-151273 修复引入的回归）使**挂起状态的 generator 帧不再被 GC 标记**——generator 帧存于堆对象而非 JS 栈，解释器写入其寄存器无写屏障，挂起期间 GC 全然不知；
2. 帧内**仅被该帧引用**的对象被 GC 释放；generator 恢复执行时即 UAF——三个崩溃签名全部由此而来：`getterFallback` 读已释放对象（dump 3ef99501 rax=0xC0000001、7787486a rax 指向不可读页）、sweeper 工作表弹出 NULL（65a4236d、c611947e）；
3. **触发面**：local-music 的 TS 经 esbuild 编译，每个 `async/await` 均降级为显式 `function*`（`entry.mjs` 内 69 处 `__async(..., function* ...)`）；启动期封面回填风暴（激活 +1.5s 的 `runWarmCoverBackfill`）挂起数十个 generator，与 GC 相撞概率大增；
4. 上游修复：`7d5e24963`（Make sure to mark generator stack frames properly）+ `9eca4322a`（QTBUG-151511，Check function for null before marking generator frames），均在 6.12.0 发布（2026-09-30）之后进入 6.12 分支，fixVersion 6.12.1（**尚未发布**，快照站亦无 6.12.1 预编译包）。

### 4.3 取证勘误（两次误归因，均已撤销）

- **「共享宿主链」撤销**：B3/B4 崩溃的四个 exe 锚点（`reauthorize+0x6fa` / `~Service+0x53` / `GpuSurface ctor` / `validOptions`）全部为**栈残留误归因**——`0x4d8b4a` 位于函数 epilogue（security-cookie 检查调用之后），不可能作为活动返回地址存在；它是历次函数调用结束时 `__security_check_cookie` 遗留在栈字节里的代码指针，被自研回走器的扫描回退误捕。宿主 PluginSdk 源码审计（operation/picker/MediaLease/Service 的所有权翻转与 QJSValue 生命周期）未发现缺陷；崩溃实况栈为纯 QV4 求值链（事件循环 → `QQmlJavaScriptExpression::publicContext` → JS 求值 → `getterTwoClasses`/`getterFallback` → `Value::toObject` → 分配 → GC）。
- **ProxyPacDns 线索撤销**：`stack-loop.py` 对 RSP±4MB 的**全部内存范围**做直方图，把堆内存中巧合的 `ProxyPacDns::lookup/myIpAddress/ProxyResolver::resolve` 返回地址样值（×50+）当成了栈帧。逐线程核对（`thread-frames.py`）：dump 共 71 线程，没有任何线程的捕获栈含该 RVA 窗口（0x260600–0x261200）——整条线索是堆数据噪音。

### 4.4 修复实施（宿主侧 = 替换带补丁的运行时）

- 源码：`qtdeclarative-everywhere-src-6.12.0` 官方 tarball（`build/qt-patch/`）+ `genfix1.patch`/`genfix2.patch`（从 6.12 分支 cherry-pick 的两个上游提交，测试文件 hunk 已剔除）；
- **ABI 保持**：上游补丁将 `QV4::Value::mark` 改为 const 成员，导出符号随之改名（`QEBAX`），依赖旧导出的 Qt6Quick 等 DLL 加载即 `0xC0000139 ENTRYPOINT_NOT_FOUND`——已回退该 const 改动（`markJSFrame` 内部 `const_cast`），导出表与原件零缺失（仅新增 `markJSFrame`）；
- 产物 `Qt6Qml.dll`（含 PDB 可选）替换至 `build/qt-official/6.12.0/msvc2022_64/bin/`，原件备份 `build/qt-patch/Qt6Qml.dll.orig-6.12.0`；构建脚本 `build-qml.bat` / `rebuild-qml.bat`（仅编 `Qml` 目标，约 5 分钟）；
- 验证：风暴态（grants 对齐 + `values.sqlite.bak` 重扫态）10/10 轮存活、插件恢复启用后实机启动 100s 稳定；
- 复现/回归 harness：`build/diagnostics/repro-r1.py`（用法 `python -I repro-r1.py [rounds]`，环境变量 `REPRO_WINDOW`）。

### 4.5 遗留跟进

1. Qt 6.12.1 官方包发布后，换官方 QtQml 并可移除本地补丁树（保留备份原件即可回滚）；
2. 同期 6.12 分支还有数个相关修复（`5f22a7236` JIT SetLookup 累加器、`1365c0422` lost-object ReferenceError、`0e96f017a` Incubator UAF）不在 6.12.0 内，6.12.1 发布时一并覆盖；
3. 插件侧无需改动：async/await 是正当写法，风暴是其正常启动路径。

---

## 5. 次级问题与行为变化记录

### R2（环境）控件测试套件在无窗口运行环境大面积失败

- 全套 `tests/qt/controls` 在当前非交互环境下 9 通过 / 55 失败 / 3 跳过（`session.create()` 失败一类），基线同样如此——套件依赖可交互 QML 会话；
- 两个单测失败（`iconButtonHoverScalesStableRasterAndHitRegion`、`uiPartMountsReplaceAndRetire`）经 stash 基线对照确认为**预存/环境性**，与本修复无关；
- D1 修复相关子集已单独跑绿：`pixelSnapTracksScenePositionAcrossReparentAndWindows`、`imageDensity×2`、`uiStyleLayersRestoreLiveBindings`、`uiPartsIdentityObservationAndPublicActions`、`uiPartsProductionPlaybackAndMini`、`uiPartInstanceStylesAndLeasesStayBounded`、`temporaryAppearancePriorityLiveBaseAndRevocation`、`appearanceErrorsAndActivationRollback`；
- 建议：为 CI/本地提供窗口化测试 harness（或在文档中固定「测试须在交互会话运行」），并给两个预存失败建立跟踪。

### R3（工程化）Release 链接不产出新 PDB，符号化依赖 /MAP 重链

- `build/release/app/echomusicnext.pdb` 为旧配置残留（链接规则虽带 `/pdb:`，但当前 Release 链接实际未产出可用 PDB），崩溃归因只能走「/MAP 重链 + .pdata 指纹比对」管线；
- 现有工具：`relink-map.cmd`（从 build.ninja 边重建 rsp 并 `/MAP` 重链）+ `symbolize-map.py`（校验 `.pdata` md5 与崩溃映像一致后按 map 符号化）。本次 `.pdata` md5=`5191dc808c9a7d7fb9052443c9975a19`；
- 建议：Release 构建保留符号（`/Zi /DEBUG` + PDB 归档，或 CI 上传符号工件），能把每次取证的半小时管线缩到一条命令。

### R4（语义记录）修复带来的可观察行为变化

- snap 相关属性（scenePosition/devicePixelRatio/density）**值立即生效、通知延迟一事件循环轮**且突发合并为一次。仅影响亚像素对齐，视觉不可见；依赖同步通知的消费者需改走 QTRY（本次唯一需要适配的测试即如此）；
- `hasVisualOverrides` 相对 overrides 稳定值**迟滞一事件循环轮**，Loader 不再在 attach/detach 穿越期拆建；`overrides` 属性本身与身份重发布时序完全不变；
- 测试适配：`ControlsUiPixelSnap.cpp` 一处 `QCOMPARE` → `QTRY_COMPARE`（附注释）。

---

## 6. 剩余建议优先级

1. **D2 收尾**：Qt 6.12.1 官方包发布后换官方 QtQml，移除本地补丁树（保留备份原件即可回滚）；
2. **R3**：Release PDB（低成本的长期取证收益）；
3. **R2**：窗口化测试 harness（改善回归效率）+ 两个预存失败跟踪；
4. **D1 未实施的宿主建议仍建议纳入**：② `EchoItemObserver` 降噪（destroyed/reparent 的双 emit 排队、祖先观察者按需创建延后到事件循环）；③ `refresh()` 去乒乓（声明属性未变时不 detach+attach，或 detach 不清空 overrides）；⑤ 防御性护栏（重入计数/深度告警）。环虽已断，同环风险面仍在（如 `EchoPluginUiStyles.cpp:109-118` 的 putStyle→resolve 链）；
5. R4：无行动项，仅语义记录。

## 7. 取证方法论（教训汇总）

- **符号化管线**（exe 无导出符号、PDB 过期）：dump 栈 → exe `.pdata` 函数边界 → ±10 邻域尺寸指纹 → 同源 map 构建 VA → llvm-symbolizer + 配套 PDB（360MB）。尺寸匹配（±8B）验证锚点以排除漂移误判；模板实例（如 `QCallableObject<void(T::*)()>::impl`，尺寸均 0x54）符号多解，需结合调用序判定；关键函数用 capstone 反汇编与源码逐一对应确认身份。
- **直方图教训**：直方图只可用于**同线程栈窗口内**的循环成员计数（如 D1 的 slot×26）；跨线程/大窗口扫描（如 RSP±4MB 全内存）一律先用逐线程栈归属过滤（`thread-frames.py` 即为此新增）——否则堆数据噪音会伪造"新递归"线索（ProxyPacDns 事件）。
- **栈残留误归因**：位于函数 epilogue（security-cookie 检查之后）的地址不可能作为活动返回地址存在；自研回走器的扫描回退易误捕遗留代码指针。
- **最快判据**：异常参数（ExceptionInformation：读/写 + 错误地址）与寄存器 rax 的组合，可快速区分「栈溢出 / 空指针 / UAF 毒化」——D2 家族重分类完全靠它。
- **无 PDB 的 Qt 模块**：`llvm-objdump` 直接反汇编 Qt6Qml 等 DLL，也能定位崩溃指令与函数名。

## 8. 证据与工件索引

| 工件              | 位置 / 标识                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 崩溃 dumps ×5  | `$R/logs/crashes/database/reports/`（00bb9fe4… 等；`$R` = `C:\Users\Oneday\AppData\Local\hoowhoami\EchoMusicNext`）                                      |
| A 侧基线 dumps    | e330e31b / 08d766f4 / 4f0a0cd4 / e5684867 + 历史 11 个（全部浅栈 + freed/毒化指针读）                                                                    |
| B1 崩溃 dump      | `logs/crashes/database/reports/b9365d0e-….dmp`（tid 28280，getterFallback UAF 前驱，Qt6Qml+0x19e3c8）                                                    |
| B3 崩溃 dump      | `logs/crashes/database/reports/3ef99501-829c-48d0-a62f-797476b58f71.dmp`（getterFallback UAF 直接确证：rax=0xC0000001，指令 `mov rcx,[rax+0x10]`）       |
| B4 崩溃 dump      | `logs/crashes/database/reports/c611947e-….dmp`（Qt6Qml+0x1a6a98，rax=0，QV4 求值链）                                                                     |
| R1 复现崩溃 dump  | `logs/crashes/database/reports/7787486a-….dmp`（风暴 harness round 2/8；getterFallback 链 + rax 指向不可读页）                                           |
| 会话日志          | `logs/echomusicnext-2026-11-07_12-06-43-707-11204.log`（止于 12:11:10.114）；`logs/echomusicnext-2026-11-07_16-36-12-913-22284.log`（止于 16:36:21.865） |
| 基线 exe          | `build/diagnostics/echomusicnext-BASELINE.exe`（md5 267831d9…）                                                                                          |
| 修复 exe          | `build/diagnostics/echomusicnext-FIXED.exe`（md5 40b03ca9…；与 `main-3` `79ed7d6` 源码对应）                                                             |
| /MAP 重链产物     | `build/release/app/echomusicnext-map.exe` + `echomusicnext.map`（`.pdata` md5 5191dc80… 与 B1 崩溃映像一致）                                             |
| 补丁版 Qt6Qml.dll | `build/qt-official/6.12.0/msvc2022_64/bin/Qt6Qml.dll`（原件备份 `build/qt-patch/Qt6Qml.dll.orig-6.12.0`）                                                |
| 补丁源码树        | `build/qt-patch/qtdeclarative-everywhere-src-6.12.0/`（genfix1+genfix2 已应用；构建脚本 `build-qml.bat`/`rebuild-qml.bat`）                              |
| 风暴复现 harness  | `build/diagnostics/repro-r1.py`（重扫态启动循环；配套 `values.sqlite.bak`、grants 对齐说明见 §4.4）                                                      |
| D1 采样工具       | `Temp\sampler2.py` + `analyze-caps.py`（主线程 RIP 采样 + 忙 burst 抓 32KB 栈窗）                                                                        |
| 取证脚本          | 宿主仓库 `build/diagnostics/`：walk-dump.py、stack-loop.py、thread-frames.py、symbolize-map.py、relink-map.cmd、launch-app.py                            |
| 测试基线定性      | stash 法对照两轮输出（`build/diagnostics/test-out.txt`）                                                                                                 |
| 当前运行状态      | local-music 已恢复启用；补丁版运行时下风暴态 10/10 存活、实机启动稳定                                                                                    |

## 9. 附录：D1 关键文件与行号速查（修复前源码）

| 文件                                                    | 位置                             | 内容                                                                                                                                                      |
| ------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modules/EchoMusic/Controls/EchoPixelSnap.cpp`          | 30-34 / 47-87                    | `ECHO_PIXEL_SNAP=0` 开关 / refresh() 与同步 emit                                                                                                          |
| `modules/EchoMusic/Controls/EchoItemObserver.cpp`       | 87-101 / 128-146                 | 观察目标信号（94-95 为 reparent 重连）/ reparent 按需创建 + 双 emit                                                                                       |
| `modules/EchoMusic/Controls/EchoIcon.qml`               | 41-45 / 50-53                    | 附着属性读取 / alignedSurface snap 绑定（lambda_27=y:51，生成码注释 2417）                                                                                |
| `modules/EchoMusic/Controls/EchoCover.qml`              | 114-125 / 88-101                 | 同构 snap 绑定 / alignedSurface 内嵌占位 EchoIcon（嵌套环关键）                                                                                           |
| `modules/EchoMusic/Controls/EchoDivider.qml`            | 20-31                            | 第三处 snap 绑定                                                                                                                                          |
| `modules/EchoMusic/Controls/EchoUiPartRegistration.cpp` | 38-45 / 58-74 / 93-102 / 119-126 | refresh=detach+attach / setter 全走 refresh / parentChanged+windowChanged 走 connectTarget()+refresh() / setResolved 相等守卫（117-118 为 setBaseValues） |
| `modules/EchoMusic/Controls/EchoUiPartRegistry.cpp`     | 37-49 / 50-60 / 187-202          | attach（identity++ + resolve）/ detach（setResolved({})）/ resolve                                                                                        |
| `modules/EchoMusic/Controls/EchoUiPartHost.qml`         | 21-40                            | Loader.active 绑定 overrides（乒乓放大器）                                                                                                                |
| `modules/EchoMusic/PluginSdk/EchoPluginUiStyles.cpp`    | 109-118                          | putStyle→resolve 链（同环风险面）                                                                                                                         |
