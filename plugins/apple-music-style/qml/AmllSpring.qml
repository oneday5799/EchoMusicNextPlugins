pragma ComponentBehavior: Bound
import QtQuick

// 闭式阻尼弹簧，逐行移植宿主 EchoMusic.Playback 的 LyricSpring：
// 相同的 k/c 调参、延迟重定向与求值公式，保证行滚动手感与内建歌词页一致。
// 时钟由 FrameAnimation 帧推进，帧间调用 advance() 使用上一帧时刻。
QtObject {
    id: spring

    property real value: 0
    property bool running: false
    property real __clock: 0
    property real __origin: 0
    property real __target: 0
    property real __velocity: 0
    property real __initialVelocity: 0
    property real __k: 140
    property real __c: 22
    property real __begin: 0
    property bool __mode: true
    property var __pending: null

    function snap(target: real): void {
        __pending = null;
        value = __origin = __target = target;
        __velocity = __initialVelocity = 0;
        running = false;
    }
    // 虚拟内容前缀移动时保持屏幕位置与速度
    function shift(delta: real): void {
        value += delta;
        __origin += delta;
        __target += delta;
        if (__pending)
            __pending.target += delta;
    }
    function __beginAt(target: real, intervalMs: real, mode: bool, time: real): void {
        __origin = value;
        __initialVelocity = __velocity;
        __target = target;
        __begin = time;
        __mode = mode;
        const ratio = Math.pow((800 - Math.min(800, Math.max(100, intervalMs))) / 700, 0.2);
        let k = 170 + 50 * ratio;
        let c = 2.2 * Math.sqrt(k);
        if (intervalMs <= 0) {
            k = 90;
            c = 15;
        }
        __k = k / 0.9;
        __c = c / 0.9;
    }
    function retarget(target: real, intervalMs: real, delayMs: int, mode: bool): void {
        if (delayMs > 0 && __pending && Math.abs(target - __pending.target) < 0.001 && intervalMs === __pending.intervalMs && mode === __pending.spring)
            return;
        advance();
        const now = __clock;
        if (delayMs > 0) {
            // 只延迟目标切换，不冻结既有运动，避免快节奏歌词丢速度
            __beginAt(__target, intervalMs, mode, now);
            __pending = {
                "target": target,
                "intervalMs": intervalMs,
                "due": now + delayMs,
                "spring": mode
            };
        } else {
            __pending = null;
            if (Math.abs(target - __target) < 0.001) {
                advance();
                return;
            }
            __beginAt(target, intervalMs, mode, now);
        }
        if (!running)
            running = true;
    }
    function retargetScale(target: real, animate: bool): void {
        if (!animate) {
            snap(target);
            return;
        }
        advance();
        if (Math.abs(target - __target) < 0.001)
            return;
        __pending = null;
        __beginAt(target, 0, true, __clock);
        __k = 100 / 2;
        __c = 25 / 2;
        if (!running)
            running = true;
    }
    function __evaluate(time: real): bool {
        const t = Math.max(0, time - __begin) / 1000;
        const displacement = __origin - __target;
        if (!__mode) {
            const p = Math.min(1, t / 0.5);
            value = __target + displacement * Math.pow(1 - p, 3);
            __velocity = 0;
        } else {
            let x, v;
            if (__c * __c >= 4 * __k) {
                const d = Math.sqrt(__k), b = __initialVelocity + d * displacement;
                const decay = Math.exp(-d * t);
                x = (displacement + b * t) * decay;
                v = (b - d * (displacement + b * t)) * decay;
            } else {
                const d = __c / 2, w = Math.sqrt(__k - d * d);
                const b = (__initialVelocity + d * displacement) / w;
                x = Math.exp(-d * t) * (displacement * Math.cos(w * t) + b * Math.sin(w * t));
                v = -d * x + Math.exp(-d * t) * w * (-displacement * Math.sin(w * t) + b * Math.cos(w * t));
            }
            value = __target + x;
            __velocity = v;
        }
        if (Math.abs(value - __target) < 0.05 && Math.abs(__velocity) < 0.5) {
            value = __target;
            __velocity = 0;
            return false;
        }
        return true;
    }
    function advance(): void {
        if (!running)
            return;
        const now = __clock;
        if (__pending && now >= __pending.due) {
            // 在排定的切换时刻求值，再把新目标积分到当前帧
            const pending = __pending;
            __evaluate(pending.due);
            __pending = null;
            __beginAt(pending.target, pending.intervalMs, pending.spring, pending.due);
        }
        if (!__evaluate(now) && !__pending)
            running = false;
    }

    readonly property FrameAnimation ticker: FrameAnimation {
        running: spring.running
        onTriggered: {
            // frameTime 是上一帧以来的实际秒数；直接累计（限幅避免启动帧携带空闲间隔）
            spring.__clock += Math.min(100, Math.max(0, frameTime * 1000));
            spring.advance();
        }
    }
}
