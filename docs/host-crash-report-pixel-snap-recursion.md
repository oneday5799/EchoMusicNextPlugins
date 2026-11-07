# 宿主缺陷报告：EchoPixelSnap / EchoItemObserver / EchoUiPart 场景图同步递归导致栈溢出崩溃

- 日期：2026-11-07
- 宿主版本：EchoMusicNext（Qt 6.12.0，安装版 exe md5 `9b609bc89e691ffdb06ade83c2ddc73d`，与 `build/release/app/echomusicnext.exe` 一致，构建于 11-06 23:15）
- 触发方：local-music 插件“扫描”（复现概率 5/7；插件侧缓解后 0/7，见 §8）
- 崩溃形态：主线程栈溢出（AccessViolation），崩溃前 ~5 秒内进程内存 +200–260MB
- 结论一句话：**扫描期间的界面churn（delegate/部件大量创建销毁）进入了一条宿主内部的同步信号递归——`EchoPixelSnapAttached::refresh()` 的 scenePositionChanged 发射 → EchoIcon/EchoCover 的 snap 绑定重评估并写回子项几何 → `EchoItemObserver` 的几何/销毁/挂接级联再次触发 refresh——每层循环叠加 EchoUiPart 的 detach/attach（identity 递增、overrides 乒乓），约 140 层后栈溢出。**

---

## 1. 证据来源与可信度

| 证据 | 说明 |
| --- | --- |
| 崩溃转储 ×5 | `C:\Users\Oneday\AppData\Local\hoowhoami\EchoMusicNext\logs\crashes\database\reports\*.dmp`，5 份dump 堆栈同签名（同层重复组、同嵌套深度量级） |
| 实时 RIP 采样 | psutil + OpenThread/SuspendThread/GetThreadContext（12ms），主线程 RIP 直方图确认死亡窗口在 Qt6Qml/Qt6Quick/exe 代码内 |
| PDB 符号化 | 安装版 exe 的 PDB 过期（GUID 不匹配），改用 `.pdata` 尺寸指纹把 app exe 函数逐一映射到同源构建 `echomusicnext-map.exe`（有配套 360MB PDB），再由 llvm-symbolizer 出符号；已用尺寸匹配（±8B）验证锚点，排除漂移误判 |
| 反汇编交叉验证 | capstone 反汇编 `refresh()`（三次 `mapToScene` 调用 + hypot 浮点链 + QPointer 空守卫）与源码逐一对应，确认函数身份 |

方法学说明：QML AOT 函数为 `QmlCacheGeneratedCode` 匿名命名空间代码，exe 无导出符号、无可用 PDB。映射管线：dump 栈 → exe `.pdata` 函数边界 → ±10 邻域尺寸指纹 → map 构建 VA → PDB 符号。对模板实例（如 `QCallableObject<void(T::*)()>::impl`，尺寸均为 0x54）符号结果不唯一，报告中标注为“槽激活（模板多解）”。

## 2. 崩溃签名（5 份 dump 一致）

重复栈组（自深至浅，一层循环）：

```
Qt6Core  信号激活 (QMetaObject::activate +0xec884/+0xe9906/+0xe9e63)
Quick    tiny lambda-invoker stub (0x5b9a1 / 0x5b9d0 / 0x607d0)
QV4      绑定求值帧群 (0x2efb4a / 0x4cb1e0 / 0x2ef064 / 0x1519fe / 0x1b8e08 / 0x1beb04 / 0x1c2240;
                  含 d_unchecked@QObjectMethod —— QV4 方法调用)
exe+0x8d290f  AOT 绑定帧（见 §3 符号化）
→ 回到信号激活，循环
```

- 循环 ~140 层（每层约 450 个栈槽 / ~3.6KB），随后 AV。
- 死亡前 5 秒 RSS 线性 +200–260MB：每层的 QV4 求值分配 + `EchoUiPartRegistry` detach/attach 的 QVariantMap churn + `EchoIconSource.urlFor()` 触发的 `AppIconService` 缓存插入（栈上可见 `QHashPrivate::Node<QString, AppIconService::Entry>` 构造帧）。
- 崩溃为时序敏感（flaky）：同操作 5/7 次崩溃；插件侧限流后 7/7 存活。

## 3. 循环成员符号化结果（精确）

| exe RVA | 函数（map 构建 PDB） | 对应源码 |
| --- | --- | --- |
| 0x8d2040..0x8d29d5 (0x995) | `EchoIcon_qml::<lambda_27>::operator()` | **EchoIcon.qml:51 `alignedSurface.y` snap 绑定**（生成码 echo_controls_EchoIcon_qml.cpp:2407 注释 “expression for y at line 51, column 9” 实锤） |
| 0x8d4630 (0x9bd) | `EchoIcon_qml::<lambda_37>` | echo_controls_EchoIcon_qml.cpp:3660（EchoIcon 内另一绑定） |
| 0x8d5350 (0x6c5) | `EchoIcon_qml::<lambda_7>` | echo_controls_EchoIcon_qml.cpp:1154 |
| 0x8d37b0 (0xee) | `EchoIcon_qml::<lambda_31>` | echo_controls_EchoIcon_qml.cpp:2985 |
| 0x872480 (0x591) | **`EchoPixelSnapAttached::refresh()`**（反汇编确认，非早期误判的 resolve()） | EchoPixelSnap.cpp:47-87 |
| 0x17560 (0x54) ×26/栈 | `QCallableObject<void (T::*)()>::impl` —— void() 成员槽激活（模板多解；结合调用序为 observer→refresh 一类连接） | qobjectdefs_impl.h:538 |
| 0x867db0 (0x93) | `validSelector` 内联所在小包装（query/registerRule 路径，佐证部件注册churn在环内） | EchoUiPartRegistry.cpp:65 |
| 栈散布 | `AppIconService` QHash 节点构造（图标缓存插入，每循环一次） | AppIconService.cpp |

一份 dump 的实测帧序（栈槽号自旧到新）：

```
y绑定@3373 → 槽@3305 → 槽@3205 → refresh@3161 → validSelector@2068
→ (0x3b8 未知帧)@1441 → 槽@1149 → 槽@1099 → refresh@1055 → y绑定@721 → y绑定@671
```

注意 **y绑定@721 → y绑定@671 仅隔 50 槽**：同一 y 绑定（或不同 EchoIcon 实例的同名 lambda）在中间仅隔一次信号激活即重入——典型的“写几何 → 通知 → 同一/同类绑定立即重评估”。

## 4. 根因：四个宿主组件构成的同步反馈网

宿主源码参考（只读）：

### 4.1 EchoItemObserver —— 观察者按需创建 + 同步 emit（引擎的“点火与传播”）

`D:\Code\EchoMusicNext\modules\EchoMusic\Controls\EchoItemObserver.cpp`

- 87-90 行：观察目标项自身 `xChanged/yChanged/widthChanged/heightChanged` → `sceneChanged`。
- 128-146 行 `reparent()`：**按需递归创建祖先观察者**（`observeItem(m_item->parentItem())`），把父观察者的 `sceneChanged` 连到自身（父→子传播）；**`reparent()` 结尾同步 `emit changed(); emit sceneChanged();`**——即“挂接观察者”这个动作本身就会点火。
- 94-95/98-100 行：`parentChanged/windowChanged` → `connectTarget()+refresh()`；96-101 行：**目标 `destroyed` 时同步 `retire(); emit changed(); emit sceneChanged();`**——delegate 销毁在信号链内直接点火。
- 净效果：任何一处几何写/创建/销毁，都会沿观察者图**同步**扩散，且扩散路径会随“按需创建”而增长。

### 4.2 EchoPixelSnapAttached::refresh —— 变更即发射（循环的“发电机”）

`D:\Code\EchoMusicNext\modules\EchoMusic\Controls\EchoPixelSnap.cpp:47-87`

- 由 observer 的 `sceneChanged` 驱动（42-43 行连接）；重算 `mapToScene` ×3 + density。
- 有变化守卫（58-62 行：scene/dpr/density 均未变则直接返回），**但在churn期间 scene 位置真实地在变，守卫挡不住**；每次变化同步 `emit scenePositionChanged()`（81-82 行）。

### 4.3 EchoIcon / EchoCover / EchoDivider —— snap 绑定写子项几何（循环的“执行器”）

- `EchoIcon.qml:50-53`（alignedSurface.x/y/width/height）、`EchoCover.qml:122-125`、`EchoDivider.qml:27-30`：
  `x/y = (Math.round(snapScene * dpr) − snapScene * dpr) / density` —— 读取**附着在自身 control 上的** EchoPixelSnap.scenePosition，写到**子项** alignedSurface 上。
- 关键在**嵌套**：EchoCover 的 alignedSurface 内含 CoverPlaceholder + 占位 EchoIcon（EchoCover.qml:88-101），EchoButton/EchoIconButton 内含 EchoIcon。嵌套的内层 EchoIcon 挂接时，`reparent()` 会为**其祖先链**（包括外层的 alignedSurface）创建观察者——于是外层 alignedSurface 的几何写会同步触发内层 EchoIcon 的 refresh → 内层绑定写内层 alignedSurface → 继续向下传播。多层嵌套组件使级联越走越深。
- 亚像素抖动：`Math.round` 补偿公式在分数 DPR（Windows 125%）+ 布局偏移下，可能在两个半设备像素边界间来回翻转（每次写回产生新的修正量），使同一组件的 snap 绑定反复重评估（与 dump 中 y绑定@721→@671 相邻自重入吻合）。

### 4.4 EchoUiPartRegistration —— detach/attach 乒乓（循环的“燃料泵”）

`D:\Code\EchoMusicNext\modules\EchoMusic\Controls\EchoUiPartRegistration.cpp`

- 38-45 行 `refresh()`：**先 `detach` 再 `attach` 再 `emit changed()`**；`setRole/setKey/setSurface/...` 每个 setter 都触发 refresh（58-74 行宏），目标 `parentChanged/windowChanged` 也触发（93-101 行）。
- `EchoUiPartRegistry::attach()`（EchoUiPartRegistry.cpp:37-49）：**每次 attach 分配新 identity（`++m_sequence`）**，然后 `resolve(part)` → `setResolved(values)`；`detach()`（50-60 行）先 `setResolved({})`。
- 后果：**detach→attach 把 overrides 在 `{}` ↔ map 之间乒乓，`setResolved` 的相等守卫（EchoUiPartRegistration.cpp:117-118）每次都放行**，每次都 `emit overridesChanged()+changed()`；同时 `emit removed(id)`、`emit added(part)`、identity 每轮递增。churn 期间每个 delegate 里的每个部件都跑一遍这个循环，为信号网持续供能。
- 消费端放大：`EchoUiPartHost.qml` 的 `Loader.active` 绑定在 `Object.keys(hostPart.overrides).some(...)` 上——overrides 每次乒乓都会同步重建/销毁 Loader 内容（几何变化 → 又回到 4.1 的观察者级联）。

### 4.5 闭环描述

```
扫描churn（delegate/部件大量创建销毁、进度重渲染）
  → [同步信号链内] 部件创建(componentComplete)/销毁(~dtor) / 几何写
  → EchoItemObserver: xChanged/yChanged/destroyed/reparent 点火，观察者按需创建并扩散
  → EchoPixelSnapAttached::refresh()：scene 变了 → emit scenePositionChanged
  → EchoIcon/EchoCover/EchoDivider snap 绑定（QV4/AOT）重评估 → 写子项几何
  → 子项几何写再次进入观察者（含嵌套组件的祖先观察者）
  → （并行地）EchoUiPartRegistration setter/parentChanged → refresh() → detach+attach
      → setResolved 乒乓 + added/removed/changed + Loader.active 同步重建
  → …嵌套 ~140 层 → 栈溢出 AV；每层泄漏式分配 → +200–260MB
```

## 5. 为什么插件扫描会点燃它

1. 扫描进度最初**每文件**发布 → 页面同步重渲染数百次（19 秒主线程冻结）；插件限流到 300ms 后仍保留每 300ms 一次的同步重渲染机会。
2. walk 结束 `notifyLibraryChanged()` → 页面 `resetView()`：`clearSongRows()`（model 重置，**同步销毁全部 row delegate**——每个 row 含 EchoCover/EchoButton/EchoIconButton/EchoIcon，即大量 EchoUiPart + EchoPixelSnap + 观察者）+ `pageLoad()` 逐批重建（`appendSongRows` 内 `forceLayout()` **同步**实例化可见 delegate）。
3. delegate 创建/销毁发生在信号链内时（forceLayout、Loader 重建、Enter 过渡期间），正好构成 4.5 的闭环起点。
4. 此后 enrich/covers 阶段的持续进度发布提供反复的点火机会——单次点火即可成环（flaky 的来源）。

## 6. 宿主侧修复建议（按优先级）

1. **打破同步自环（最高优先）**：`EchoPixelSnapAttached::refresh()` 的 emit 改为合并/排队（`QMetaObject::invokeMethod(..., Qt::QueuedConnection)` 或脏标记 + 事件循环尾部统一 flush）。scene 位置类通知不具备“必须在当拍生效”的正确性需求——snap 只影响亚像素对齐，晚一拍视觉无感，但能彻底拆掉 binding→geometry→observer→binding 的同步环。
2. **`EchoItemObserver` 降噪**：
   - `destroyed` 路径（96-101 行）不要同步 `emit changed()/sceneChanged()`，改为排队；
   - `reparent()` 结尾的双 emit（144-145 行）同样排队；祖先观察者的按需创建延后到事件循环，避免在信号链内扩张传播图。
3. **`EchoUiPartRegistration::refresh()` 去乒乓**：声明属性未变时不 detach+attach（setter 已有相等守卫，但 `parentChanged` 路径没有）；`attach()` 在 identity 未变时可跳过重新 `resolve`；或 detach 时不把 overrides 清空为 `{}`（保留到重新 attach 后一次性写入），从根上消除 `{}`↔map 乒乓与 Loader.active 抖动。
4. **`EchoUiPartHost` Loader 迟滞**：`Loader.active` 对 overrides 变化加去抖（例如仅当“存在非 opacity 键”这一布尔值翻转时才重建），避免每次样式解析都重建 Rectangle。
5. **防御性护栏**：`refresh()` 加重入计数/深度告警（`qWarning` on depth > N）；开发构建对 “binding eval 内同步创建/销毁 delegate” 打印。
6. **现成的临时开关**：宿主已内置 A/B 环境变量 **`ECHO_PIXEL_SNAP=0`**（EchoPixelSnap.cpp:30-34，把所有补偿钉在 0），可作为用户侧应急缓解（代价是失去亚像素对齐），也可用于验证本报告——设为 0 后该崩溃路径应无法复现。

## 7. 复现步骤（供宿主侧验证）

1. 启用 local-music 插件、禁用其他插件；删除/备份
   `C:\Users\Oneday\AppData\Local\hoowhoami\EchoMusicNext\plugins\.data\local-music\values.sqlite`（清空曲库）。
2. 启动宿主 → 进入“本地音乐” → 点击“扫描”。
3. 预期：约 5 秒内崩溃（概率 ~5/7）；`logs/crashes/database/reports/` 出现新 dump，签名同 §2。
4. 对照实验：设置 `ECHO_PIXEL_SNAP=0` 后重复步骤 1-3（预期不崩）；
   以及使用插件侧修复版（§8）重复（预期概率大幅下降）。
5. 采样工具：`C:\Users\Oneday\AppData\Local\Temp\sampler2.py`（主线程 RIP 采样 + 忙 burst 时抓 32KB 栈窗）与 `analyze-caps.py` 可实时捕捉递归开始时刻的活栈。

## 8. 插件侧已做的缓解（非根治）

插件仓库 `EchoMusicNextPlugins`，提交 `5be098d`（local 分支，仅插件文件）：

1. 扫描进度合并发布：300ms 窗口（`SCAN_PROGRESS_INTERVAL_MS`），消除每文件发布的 19 秒冻结；
2. 任务进度独立 1s 限流（`TASK_PROGRESS_INTERVAL_MS`）；
3. 页面 `onStateChanged` 对无变化的 scan 状态跳过赋值（`scanStateEquals`），稳态阶段横幅绑定零重评估；
4. artistLinks 项补空 `id`：消除宿主 `EchoArtistLinks.qml:50` 对 `modelData.id.length` 的逐次 TypeError（曾放大每次重评估成本）。

效果：复现崩溃率 5/7 → 0/7（7 次全场景迭代：空库首扫、有列表重扫、重启进页、完整库重扫），主线程再无 >64ms 忙 burst。**但根因环在宿主代码内，建议按 §6 处理。**

## 9. 附录：关键文件与行号速查

| 文件 | 位置 | 内容 |
| --- | --- | --- |
| `modules/EchoMusic/Controls/EchoPixelSnap.cpp` | 30-34 / 47-87 | `ECHO_PIXEL_SNAP=0` 开关 / refresh() 与同步 emit |
| `modules/EchoMusic/Controls/EchoItemObserver.cpp` | 87-101 / 128-146 | 观察目标信号 / reparent 按需创建 + 双 emit |
| `modules/EchoMusic/Controls/EchoIcon.qml` | 41-45 / 50-53 | 附着属性读取 / alignedSurface snap 绑定（lambda_27=y:51） |
| `modules/EchoMusic/Controls/EchoCover.qml` | 114-125 / 88-101 | 同构 snap 绑定 / alignedSurface 内嵌占位 EchoIcon（嵌套环关键） |
| `modules/EchoMusic/Controls/EchoDivider.qml` | 20-31 | 第三处 snap 绑定 |
| `modules/EchoMusic/Controls/EchoUiPartRegistration.cpp` | 38-45 / 58-74 / 93-101 / 115-122 | refresh=detach+attach / setter 全走 refresh / parentChanged 路径 / setResolved 守卫 |
| `modules/EchoMusic/Controls/EchoUiPartRegistry.cpp` | 37-49 / 50-60 / 187-202 | attach（identity++ + resolve）/ detach（setResolved({})）/ resolve |
| `modules/EchoMusic/Controls/EchoUiPartHost.qml` | 21-40 | Loader.active 绑定 overrides（乒乓放大器） |
| `modules/EchoMusic/PluginSdk/EchoPluginUiStyles.cpp` | 109-118 | putStyle→resolve 链（本次未涉及，但同环风险面） |
| 崩溃转储 | `$R/logs/crashes/database/reports/` | 5 份同签名 dump（00bb9fe4… 等） |
