pragma ComponentBehavior: Bound
import QtQuick

// 间奏三点动画，逐行移植宿主 EchoMusic.Playback 的 LyricInterlude：
// 进入渐显、按段点亮、呼吸缩放与收尾放大消隐，缓动用三次贝塞尔求解。
QtObject {
    id: interlude

    property real timeMs: 0
    property bool available: false
    property real opacity: 0
    property real scaleFactor: 1
    property real firstOpacity: 0
    property real secondOpacity: 0
    property real thirdOpacity: 0
    property real __start: -1
    property real __end: -1
    property real __anchor: 0
    property real __hold: 500

    // 与宿主一致的呼吸样条：8 段三次贝塞尔（ax, ay, bx, by, 段末 y），
    // 段末 x 由段序号决定（i/8 → (i+1)/8）。
    readonly property var __breath: [
        [0.041666667, 0.000117847, 0.083333333, 0.000944377, 0.0444],
        [0.166666667, 0.087855623, 0.208333333, 0.178028547, 0.266],
        [0.291666667, 0.353971453, 0.333333333, 0.427308506, 0.4624],
        [0.416666667, 0.497491494, 0.458333333, 0.499851904, 0.5],
        [0.541666667, 0.500148096, 0.583333333, 0.500944377, 0.5444],
        [0.666666667, 0.587855623, 0.708333333, 0.678028547, 0.766],
        [0.791666667, 0.853971453, 0.833333333, 0.927308506, 0.9624],
        [0.916666667, 0.997491494, 0.958333333, 0.999821655, 1]
    ]
    // 单段进入/点亮/收缩/消隐曲线（控制点 + 段末 (1,1)）
    readonly property var __enter: [0.59, 0.02, 0.07, 1]
    readonly property var __lighting: [0.56, 0.01, 0.45, 1]
    readonly property var __expand: [0.14, 0.06, 0.25, 1]
    readonly property var __shrink: [0.29, 0.03, 1, 0.38]
    readonly property var __fade: [0.43, 0.08, 0.83, 0.31]

    function __unit(value: real): real {
        return Math.min(1, Math.max(0, value));
    }
    // 解贝塞尔 x(u)=p（Newton 迭代），返回 y(u)。坐标为绝对值。
    function __curveAt(x0: real, y0: real, ax: real, ay: real, bx: real, by: real, x1: real, y1: real, p: real): real {
        let u = __unit((p - x0) / Math.max(1e-9, x1 - x0));
        for (let i = 0; i < 8; ++i) {
            const o = 1 - u;
            const x = o * o * o * x0 + 3 * o * o * u * ax + 3 * o * u * u * bx + u * u * u * x1 - p;
            if (Math.abs(x) < 1e-5)
                break;
            const dx = 3 * o * o * (ax - x0) + 6 * o * u * (bx - ax) + 3 * u * u * (x1 - bx);
            if (Math.abs(dx) < 1e-6)
                break;
            u -= x / dx;
            u = Math.min(1, Math.max(0, u));
        }
        const o = 1 - u;
        return o * o * o * y0 + 3 * o * o * u * ay + 3 * o * u * u * by + u * u * u * y1;
    }
    function __single(points: var, p: real): real {
        return __curveAt(0, 0, points[0], points[1], points[2], points[3], 1, 1, __unit(p));
    }
    function __breathAt(p: real): real {
        const q = __unit(p);
        const i = Math.min(7, Math.floor(q * 8));
        const segment = __breath[i];
        const y0 = i === 0 ? 0 : __breath[i - 1][4];
        return __curveAt(i / 8, y0, segment[0], segment[1], segment[2], segment[3], (i + 1) / 8, segment[4], q);
    }
    function configure(start: real, end: real, now: real, intro: bool, restart: bool): void {
        if (!isFinite(start) || !isFinite(end) || !isFinite(now))
            return;
        if (start === __start && end === __end && !restart)
            return;
        __start = start;
        __end = end;
        __anchor = restart ? now : start;
        __hold = intro && !restart ? 0 : 500;
        available = start >= 0 && end > start && end - __anchor - __hold - 1000 >= 910;
        // 不得给 timeMs 赋值：会摧毁 LyricFlow 的声明式绑定
        // （timeMs: waiting && live ? renderTime : 0），时间只剩 configure 时刻的静态值，
        // 间奏演出全程不再逐帧求值，圆点永远停在透明
        __evaluate();
    }
    onTimeMsChanged: __evaluate()
    function __evaluate(): void {
        opacity = 0;
        scaleFactor = 1;
        firstOpacity = secondOpacity = thirdOpacity = 0;
        if (!available || timeMs < __anchor + __hold || timeMs >= __end)
            return;
        const body = __end - __anchor - __hold - 1000;
        const t = timeMs - __anchor - __hold;
        opacity = __single(__enter, __unit(t / 180));
        const shortBody = body < 3000;
        const segment = Math.round((body + 750) / 3), lastDuration = body - 2 * segment;
        const lastTarget = shortBody ? 1 : lastDuration / segment;
        const dots = [0, 0, 0];
        for (let i = 0; i < 3; ++i) {
            let fraction = 1;
            if (!shortBody)
                fraction = __single(__lighting, __unit((t - i * segment) / (i === 2 ? lastDuration : segment))) * (i === 2 ? lastTarget : 1);
            if (t >= body)
                fraction = i === 2 ? lastTarget + (1 - lastTarget) * __unit((t - body) / 750) : 1;
            const entrance = __unit((t - i * 80) / 750);
            dots[i] = (0.2 + 0.7 * __unit(fraction)) * entrance * entrance;
        }
        firstOpacity = dots[0];
        secondOpacity = dots[1];
        thirdOpacity = dots[2];
        if (t >= body) {
            const tail = t - body;
            scaleFactor = tail < 750 ? 1 + 0.25 * __single(__expand, __unit(tail / 750)) : 1.25 - 0.85 * __single(__shrink, __unit((tail - 750) / 250));
            opacity *= 1 - __single(__fade, __unit((tail - 750) / 250));
        } else if (!shortBody) {
            const period = body / Math.max(1, Math.floor(body / 4000));
            const phase = __breathAt(t % period / period);
            scaleFactor = 1 + 0.5 * Math.min(phase, 1 - phase);
        }
    }
}
