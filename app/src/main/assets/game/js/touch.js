/* touch.js — 配置化面积/触点判定模块（B1）+ 标定缺失检测器（B3）+ 退出手势（R5/B4）。
 * 单元测试级规格：输入 MotionEvent 序列（JSON，与壳桥接格式一致）→ 输出判定结果。
 * 判定语义：整掌压屏专用否决——须连续多帧大面积才否决，单帧大面积不误杀（B1）；
 * 标定缺失时面积否决自动失效、仅保留第二触点否决兜底（v2 裁决）。 */
window.CC = window.CC || {};

CC.guard = (function () {
  /* B3 标定缺失检测器：跨多次触摸会话滑动窗口采样（N≥20），每次触摸重新评估、不锁死；
   * 偏严格：窗口内样本全恒定（极差<0.05mm）才判缺失——宁可误判标定正常保留否决。 */
  const calibWindow = [];
  let calibMissing = false;

  function feedCalibration(touchMajorMm) {
    if (!(touchMajorMm > 0)) return;
    calibWindow.push(touchMajorMm);
    if (calibWindow.length > CC.debug.calibWindowN) calibWindow.shift();
    if (calibWindow.length >= CC.debug.calibWindowN) {
      const min = Math.min(...calibWindow), max = Math.max(...calibWindow);
      calibMissing = (max - min) < 0.05;
    }
  }

  /* 椭圆面积 mm²：major(mm) × minor —— v2 裁决禁用 getSize()。
   * F5(v1.1)：壳侧桥接真实 touchMinorMm（getTouchMinor/xdpi*25.4），
   * >0 时优先使用真实 minor；缺失（≤0/未传）回退 major*minorMajorRatio(0.8)。 */
  function areaOf(touchMajorMm, touchMinorMm) {
    const a = touchMajorMm / 2;
    const minorMm = (touchMinorMm > 0) ? touchMinorMm : touchMajorMm * CC.debug.minorMajorRatio;
    return Math.PI * a * (minorMm / 2);
  }

  /* B1 连续多帧大面积跟踪：pointerId -> 连续大面积帧数 */
  const bigFrames = new Map();

  /**
   * 输入单条 MotionEvent JSON（壳推送格式）→ 输出判定结果
   * @returns {vetoed:bool, reason:string|null, isPalm:bool}
   */
  function judge(ev) {
    const D = CC.debug;
    const i = ev.actionIndex || 0;
    const p = ev.pts[i] || ev.pts[0];
    if (!p) return { vetoed: false, reason: null, isPalm: false };

    // R2-12 修复：上行/取消/副点抬起的 bigFrames 清理提到面积判断之前
    // （原清理行在面积否决早退路径之后不可达，上行帧面积大时残留连续帧计数带入下次按压）
    if (ev.action === 1 || ev.action === 3 || ev.action === 6) bigFrames.delete(p.id);

    // 第二触点否决（任何流程）：按下非首触点 → 否决（长按期间出现第二触点否决 R5）
    if (ev.action === 5 || (ev.action === 0 && ev.count > 1)) {
      return { vetoed: true, reason: "second-pointer", isPalm: true };
    }
    // R4 多点保护：同时触点 >5 判猫掌
    if (ev.count > D.maxPointers) {
      return { vetoed: true, reason: "too-many-pointers", isPalm: true };
    }
    // B1 面积否决：标定正常时生效；须连续 N 帧大面积
    feedCalibration(p.touchMajorMm);
    if (!calibMissing) {
      const area = areaOf(p.touchMajorMm, p.touchMinorMm); // F5 真实 minor 优先
      if (area > D.areaThreshMm2) {
        const n = (bigFrames.get(p.id) || 0) + 1;
        bigFrames.set(p.id, n);
        if (n >= D.areaConsecFrames) {
          return { vetoed: true, reason: "palm-area", isPalm: true, areaMm2: area, frames: n };
        }
        return { vetoed: false, reason: "palm-warming", isPalm: false, areaMm2: area, frames: n };
      }
      // R6 修复：面积回落帧即清零 bigFrames，恢复「连续 N 帧」真语义（此前仅抬手/取消才清，累积 3 帧误杀）
      bigFrames.delete(p.id);
    }
    return { vetoed: false, reason: null, isPalm: false };
  }

  function state() {
    return { calibMissing, windowSize: calibWindow.length,
             windowN: CC.debug.calibWindowN, areaThreshMm2: CC.debug.areaThreshMm2,
             areaConsecFrames: CC.debug.areaConsecFrames };
  }

  /* 测试钩子：重置内部状态（M2 千次流分组间隔离） */
  function reset() { calibWindow.length = 0; calibMissing = false; bigFrames.clear(); }

  return { judge, state, reset, feedCalibration, areaOf };
})();

/* ---------- 退出手势状态机（R5：左上角热区定点长按 3s（位移 ≤20dp）→ 长按 3 秒直达快捷设置浮层） ----------
 * F4(v1.1)：fire 改时间驱动——热区按下即起 100ms 计时轮询，到 3s 经 onTimeFire 回调触发，
 * 不再依赖 MOVE 事件流（零 MOVE 静止长压亦可触发）；MOVE 分支保留作进度环刷新。 */
CC.exitGesture = (function () {
  const HOLD_MS = 3000, MOVE_TOLERANCE_DP = 20, POLL_MS = 100;
  let track = null; // {x0,y0,start,id}
  let timer = null;
  let insets = { left: 0, top: 0 };

  function setInsets(o) { insets = o || insets; }
  function hotZone() { // 左上角热区按 WindowInsets 安全区偏移
    return { x0: insets.left, y0: insets.top, x1: insets.left + 120, y1: insets.top + 120 };
  }
  function inHot(x, y) { const z = hotZone(); return x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1; }

  function _stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function _clearTrack() { track = null; _stopTimer(); }

  /* F4 计时轮询：track 存活且到点即时间触发（回调式，与事件路径 fire 等价且只触发一次）
   * R4 修复：轮询中新增 onProgress(ratio) 回调——静止按压零 MOVE 也持续上报进度（按下即显 0%） */
  function _startTimer() {
    _stopTimer();
    timer = setInterval(() => {
      if (!track) { _stopTimer(); return; }
      const elapsed = performance.now() - track.start;
      if (elapsed >= HOLD_MS) {
        _clearTrack();
        if (typeof CC.exitGesture.onTimeFire === "function") CC.exitGesture.onTimeFire();
      } else if (typeof CC.exitGesture.onProgress === "function") {
        CC.exitGesture.onProgress(Math.min(1, elapsed / HOLD_MS));
      }
    }, POLL_MS);
  }

  /** @returns null | {type:"progress",ratio} | {type:"fire"} */
  function feed(ev) {
    const i = ev.actionIndex || 0;
    const p = ev.pts[i] || ev.pts[0];
    if (!p) return null;
    if (ev.action === 0 && ev.count === 1) {
      if (inHot(p.x, p.y)) {
        track = { x0: p.x, y0: p.y, start: performance.now(), id: p.id };
        _startTimer(); // F4 按下即起计时
        return { type: "progress", ratio: 0 };
      }
      return null;
    }
    if (!track) return null;
    if (ev.count > 1) { _clearTrack(); return { type: "cancel" }; } // 第二触点否决
    const q = ev.pts.find(t => t.id === track.id);
    if (!q) { _clearTrack(); return { type: "cancel" }; }
    if (Math.hypot(q.x - track.x0, q.y - track.y0) > MOVE_TOLERANCE_DP) {
      _clearTrack(); return { type: "cancel" };
    }
    if (ev.action === 2) {
      // MOVE 分支保留：仅作进度刷新（fire 由计时轮询负责，此处到点也兜底一次）
      const r = Math.min(1, (performance.now() - track.start) / HOLD_MS);
      if (r >= 1) { _clearTrack(); return { type: "fire" }; }
      return { type: "progress", ratio: r };
    }
    if (ev.action === 1 || ev.action === 3) { _clearTrack(); return { type: "cancel" }; }
    return null;
  }

  function cancel() { _clearTrack(); }
  return { feed, cancel, setInsets, hotZone,
    isTracking: () => !!track,
    onTimeFire: null /* F4 由 main.js 挂接：与事件路径 fire 同处理 */,
    onProgress: null /* R4 由 main.js 挂接：100ms 轮询进度回调驱动 DOM 进度环 */ };
})();
