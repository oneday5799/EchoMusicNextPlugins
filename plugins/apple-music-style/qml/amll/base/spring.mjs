/**
 * 解析解弹簧与歌词行纵向滚动弹簧策略。
 *
 * Spring 移植自 AMLL utils/spring.ts（MIT License, github.com/pushkine/），
 * 时长参数以毫秒入参（AMLL 为 Duration 品牌类型），内部以秒求解。
 */

/**
 * 数值求导构造速度函数（中心差分，步长 0.001s）。模块私有：仅 solveSpring
 * 的解算器重建使用，不进 index.mjs 统一出口
 * @param {(t: number) => number} f 位移-时间函数
 * @returns {(t: number) => number} 速度-时间函数
 */
function getVelocity(f) {
  const h = 0.001;
  return (x) => (f(x + h) - f(x - h)) / (2 * h);
}

/**
 * 构造弹簧的解析解位移函数
 * @param {number} from 起点位置
 * @param {number} velocity 起点速度（单位/秒）
 * @param {number} to 目标位置
 * @param {number} delay 起始延迟（秒）
 * @param {Partial<SpringParams>} [params]
 */
function solveSpring(from, velocity, to, delay = 0, params) {
  const soft = params?.soft ?? false;
  const stiffness = params?.stiffness ?? 100;
  const damping = params?.damping ?? 10;
  const mass = params?.mass ?? 1;
  const delta = to - from;
  // 过阻尼或 soft 模式：无振荡的指数趋近
  if (soft || 1.0 <= damping / (2.0 * Math.sqrt(stiffness * mass))) {
    const angularFrequency = -Math.sqrt(stiffness / mass);
    const leftover = -angularFrequency * delta - velocity;
    return (t) => {
      t -= delay;
      if (t < 0) return from;
      return to - (delta + t * leftover) * Math.E ** (t * angularFrequency);
    };
  }
  // 欠阻尼：余弦振荡叠加指数衰减
  const dampingFrequency = Math.sqrt(4.0 * mass * stiffness - damping ** 2.0);
  const leftover = (damping * delta - 2.0 * mass * velocity) / dampingFrequency;
  const dfm = (0.5 * dampingFrequency) / mass;
  const dm = -(0.5 * damping) / mass;
  return (t) => {
    t -= delay;
    if (t < 0) return from;
    return to - (Math.cos(t * dfm) * delta + Math.sin(t * dfm) * leftover) * Math.E ** (t * dm);
  };
}

/**
 * @typedef {object} SpringParams
 * @property {number} mass 质量，默认 1
 * @property {number} damping 阻力，默认 10
 * @property {number} stiffness 弹力，默认 100
 * @property {boolean} soft 是否禁止过冲，默认 false
 */

/**
 * 解析解弹簧。
 *
 * 位置与时间解耦：setTargetPosition/updateParams 生成解析解函数，
 * update 按毫秒 delta 推进内部时钟求值；支持带延迟的参数与目标排队。
 */
export class Spring {
  // 注意：QML V4 引擎不支持 class fields 语法（Qt 6.12 实测），
  // 字段一律在构造函数里赋值
  constructor(currentPosition = 0) {
    this.targetPosition = currentPosition;
    this.currentPosition = this.targetPosition;
    this.currentTime = 0; // 秒
    this.params = {};
    this.currentSolver = () => this.targetPosition;
    this.getV = () => 0;
    this.getV2 = () => 0;
    this.queueParams = undefined;
    this.queuePosition = undefined;
  }

  resetSolver() {
    const curV = this.getV(this.currentTime);
    this.currentTime = 0;
    this.currentSolver = solveSpring(
      this.currentPosition,
      curV,
      this.targetPosition,
      0,
      this.params,
    );
    this.getV = getVelocity(this.currentSolver);
    this.getV2 = getVelocity(this.getV);
  }

  arrived() {
    return (
      Math.abs(this.targetPosition - this.currentPosition) < 0.01 &&
      Math.abs(this.getV(this.currentTime)) < 0.01 &&
      Math.abs(this.getV2(this.currentTime)) < 0.01 &&
      this.queueParams === undefined &&
      this.queuePosition === undefined
    );
  }

  setPosition(targetPosition) {
    this.targetPosition = targetPosition;
    this.currentPosition = targetPosition;
    this.currentSolver = () => this.targetPosition;
    this.getV = () => 0;
    this.getV2 = () => 0;
  }

  /**
   * 推进弹簧时钟
   * @param {number} deltaMs 距上次调用的毫秒数
   */
  update(deltaMs = 0) {
    const dt = deltaMs / 1000;
    this.currentTime += dt;
    this.currentPosition = this.currentSolver(this.currentTime);
    if (this.queueParams) {
      this.queueParams.time -= dt;
      if (this.queueParams.time <= 0) {
        // 先摘队再生效：无延迟分支不触碰 queueParams，留队会让后续每帧
        // 重复触发参数生效并重建解算器（AMLL 上游同位置漏清队，此处修正）
        const queued = this.queueParams;
        this.queueParams = undefined;
        this.updateParams(Object.assign({}, queued));
      }
    }
    if (this.queuePosition) {
      this.queuePosition.time -= dt;
      if (this.queuePosition.time <= 0) {
        this.setTargetPosition(this.queuePosition.position);
      }
    }
    if (this.arrived()) {
      this.setPosition(this.targetPosition);
    }
  }

  /**
   * 更新弹簧参数，可选延迟生效
   * @param {Partial<SpringParams>} params
   * @param {number} delayMs 参数延迟生效的毫秒数
   */
  updateParams(params, delayMs = 0) {
    if (delayMs > 0) {
      // 延迟参数并入参数队列（queueParams），不得并入目标位置队列
      //（queuePosition）：AMLL 上游误用 queuePosition 作合并源，会丢失
      // 先前排队的参数并混入 position 键（此处修正）
      this.queueParams = Object.assign(Object.assign({}, this.queueParams), params, {
        time: delayMs / 1000,
      });
    } else {
      this.queuePosition = undefined;
      this.params = Object.assign(Object.assign({}, this.params), params);
      this.resetSolver();
    }
  }

  /**
   * 设置目标位置，可选延迟到达
   * @param {number} targetPosition
   * @param {number} delayMs 目标延迟生效的毫秒数
   */
  setTargetPosition(targetPosition, delayMs = 0) {
    if (delayMs <= 0 && Math.abs(this.targetPosition - targetPosition) < 0.001) {
      this.queuePosition = undefined;
      return;
    }

    if (delayMs > 0) {
      this.queuePosition = Object.assign(Object.assign({}, this.queuePosition), {
        position: targetPosition,
        time: delayMs / 1000,
      });
    } else {
      this.queuePosition = undefined;
      this.targetPosition = targetPosition;
      this.resetSolver();
    }
  }

  getCurrentPosition() {
    return this.currentPosition;
  }
}

//#region 弹簧策略
// 缓慢模式参数，适用于 Seek 状态、间奏状态、首尾边界等场景
const SLOW_STIFFNESS = 90;
const SLOW_DAMPING = 15;

// 中速模式参数，目前用于歌曲结束的场景
const MEDIUM_STIFFNESS = 140;
const MEDIUM_DAMPING = 22;

// 正常播放时候的参数，会根据歌词行之间的间隔动态调整弹簧效果
const MIN_INTERVAL = 100;
const MAX_INTERVAL = 800;
const MIN_STIFFNESS = 170;
const MAX_STIFFNESS = 220;
const DAMPING_MULTIPLIER = 2.2;
const INTERVAL_EXPONENT = 0.2;

/**
 * 获取歌词行纵向滚动的弹簧物理参数
 * @param {boolean} isSeeking 当前是否是跳转状态
 * @param {boolean} isInterludeActive 当前是否处于间奏动画状态
 * @param {number | undefined} intervalMs 当前歌词行与上一行的时间差，无法提供时传 undefined
 * @param {boolean} isEndOfSong 歌曲是否播放完毕
 * @returns {Partial<SpringParams>}
 */
export function getPosYSpringPolicy(isSeeking, isInterludeActive, intervalMs, isEndOfSong = false) {
  // Seek 和间奏使用较为缓慢的弹簧参数
  if (isSeeking || isInterludeActive) {
    return {
      stiffness: SLOW_STIFFNESS,
      damping: SLOW_DAMPING,
    };
  }

  // 歌曲播放完毕时，使用中速参数
  if (isEndOfSong) {
    return {
      stiffness: MEDIUM_STIFFNESS,
      damping: MEDIUM_DAMPING,
    };
  }

  // 没有间隔，即处于第一句或最后一句，用慢速模式兜底
  if (intervalMs == null) {
    return {
      stiffness: SLOW_STIFFNESS,
      damping: SLOW_DAMPING,
    };
  }

  // 将间隔限制在一个合理的范围内
  const clampedInterval = Math.min(Math.max(intervalMs, MIN_INTERVAL), MAX_INTERVAL);

  // 反转时间差的位置以便计算映射比例
  let ratio = 1 - (clampedInterval - MIN_INTERVAL) / (MAX_INTERVAL - MIN_INTERVAL);

  // 开五次方根以便尽量保持较大的 ratio，偏向更快的速度
  ratio = ratio ** INTERVAL_EXPONENT;

  const targetStiffness = MIN_STIFFNESS + ratio * (MAX_STIFFNESS - MIN_STIFFNESS);
  const targetDamping = Math.sqrt(targetStiffness) * DAMPING_MULTIPLIER;

  return {
    stiffness: targetStiffness,
    damping: targetDamping,
  };
}
//#endregion
