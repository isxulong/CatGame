/* touch.js — 配置化面积/触点判定模块（B1）+ 标定缺失检测器（B3）+ 退出手势（R5/B4）。
 * 单元测试级规格：输入 MotionEvent 序列（JSON，与壳桥接格式一致）→ 输出判定结果。
 * R8-01（v1.4.4）：拆除全局「第二触点否决」，防猫改为逐触点判定——
 *   任何否决只针对触点 id，不再存在「因为出现了第二触点」这一否决理由；
 *   猫掌边界：① 该触点连续 3 帧 touchMajor 面积 ≥250mm²（B1 面积否决，逐触点独立）；
 *   ② 在屏触点 >maxPointers(5) 时超出的触点（猫掌口径，data.js 衔接）；
 *   ③ 标定缺失检测器行为不变（缺失时面积否决自动失效）。
 *   否决只否决命中与计分，动效照播，不波及其他触点。
 * 实施注记：大面积首帧（warming）即否决该触点命中——命中只发生在按下帧，若等 3 帧确认
 * 则按下帧必然先命中（MT-06「猫掌 0 突破」不可达成）；250mm² 已高于人类用力按压上限
 * （≈227mm²），首帧达阈值即按猫掌处理不构成误杀；「连续 3 帧」保留为确认口径（palmPointerIds）。
 * R8-04（v1.4.4）：退出手势只跟踪热区触点 id——计时中任何非 tracking 触点出现/移动/抬起
 * 一律忽略，不取消、不重置计时；tracking 触点自身位移超容差 / 抬起 / 被防猫否决才取消。 */
window.CC = window.CC || {};

CC.guard = (function () {
  /* B3 标定缺失检测器：跨多次触摸会话滑动窗口采样（N≥20），每次触摸重新评估、不锁死；
   * 偏严格：窗口内样本全恒定（极差<0.05mm）才判缺失——宁可误判标定正常保留否决。
   * R8-01 ③：行为不变——仍只采样 actionIndex 触点（与 v1.4.3 口径一致）。 */
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

  /* B1 连续多帧大面积跟踪：pointerId -> 连续大面积帧数（逐触点独立） */
  const bigFrames = new Map();

  /* R8-01 逐触点否决状态（每次 judge 全量重算；isBlocked 供 exitGesture 等按 id 查询） */
  let blocked = new Set();
  let palms = new Set();
  let warming = new Set();
  let overCap = new Set();

  /**
   * 输入单条 MotionEvent JSON（壳推送格式）→ 输出判定结果（逐触点口径）。
   * @returns {vetoed:bool(actionIndex 触点兼容口径), reason:string|null, isPalm:bool,
   *           blockedPointerIds:[], palmPointerIds:[], warmingPointerIds:[], overCapPointerIds:[]}
   *  - blockedPointerIds = 确认猫掌 ∪ 大面积首帧(warming) ∪ 超出 maxPointers 的触点（命中/计分否决集）
   *  - 动效照播不在此层管；调用方（main.js）按触点 id 消费，不波及其他触点 */
  function judge(ev) {
    const D = CC.debug;
    const i = ev.actionIndex || 0;
    const p = ev.pts[i] || ev.pts[0];
    blocked = new Set(); palms = new Set(); warming = new Set(); overCap = new Set();
    if (!p) {
      return { vetoed: false, reason: null, isPalm: false,
               blockedPointerIds: [], palmPointerIds: [], warmingPointerIds: [], overCapPointerIds: [] };
    }

    // R2-12 修复（保持）：上行/取消/副点抬起的 bigFrames 清理提到面积判断之前
    if (ev.action === 1 || ev.action === 3 || ev.action === 6) bigFrames.delete(p.id);

    // R8-01 ③：标定检测行为不变——仅采样 actionIndex 触点
    feedCalibration(p.touchMajorMm);

    // R8-01 ①：B1 面积否决逐触点独立生效（遍历本帧全部在屏触点，不因多点整体失效/误杀）
    if (!calibMissing) {
      for (const q of ev.pts) {
        const area = areaOf(q.touchMajorMm, q.touchMinorMm); // F5 真实 minor 优先
        if (area >= D.areaThreshMm2) {
          const n = (bigFrames.get(q.id) || 0) + 1;
          bigFrames.set(q.id, n);
          if (n >= D.areaConsecFrames) palms.add(q.id);       // 确认猫掌（连续 N 帧）
          else warming.add(q.id);                              // 大面积未确认（首帧即否决命中，见实施注记）
        } else {
          // R6 修复（保持）：面积回落帧即清零，恢复「连续 N 帧」真语义
          bigFrames.delete(q.id);
        }
      }
    }

    // R8-05 ②：在屏触点 >maxPointers 时，超出上限的触点不判命中（猫掌口径，动效照播，前 5 指不受影响）
    if (ev.count > D.maxPointers) {
      for (let k = D.maxPointers; k < ev.pts.length; k++) overCap.add(ev.pts[k].id);
    }

    for (const id of palms) blocked.add(id);
    for (const id of warming) blocked.add(id);
    for (const id of overCap) blocked.add(id);

    // 兼容口径：actionIndex 触点是否被否决 + 归因（perfLog / 否决提示用）
    let reason = null, isPalm = false;
    if (palms.has(p.id)) { reason = "palm-area"; isPalm = true; }
    else if (overCap.has(p.id)) { reason = "too-many-pointers"; isPalm = true; }
    else if (warming.has(p.id)) { reason = "palm-warming"; isPalm = false; }

    return { vetoed: blocked.has(p.id), reason, isPalm,
             blockedPointerIds: [...blocked], palmPointerIds: [...palms],
             warmingPointerIds: [...warming], overCapPointerIds: [...overCap] };
  }

  /** R8-04 依赖：按触点 id 查询当前帧否决状态（judge 后有效） */
  function isBlocked(pointerId) { return blocked.has(pointerId); }

  function state() {
    return { calibMissing, windowSize: calibWindow.length,
             windowN: CC.debug.calibWindowN, areaThreshMm2: CC.debug.areaThreshMm2,
             areaConsecFrames: CC.debug.areaConsecFrames };
  }

  /* 测试钩子：重置内部状态（M2 千次流分组间隔离） */
  function reset() { calibWindow.length = 0; calibMissing = false; bigFrames.clear();
                    blocked = new Set(); palms = new Set(); warming = new Set(); overCap = new Set(); }

  return { judge, state, reset, feedCalibration, areaOf, isBlocked };
})();

/* ---------- 退出手势状态机（R5：左上角热区定点长按 3s（位移 ≤20dp）→ 长按 3 秒直达快捷设置浮层） ----------
 * F4(v1.1)：fire 改时间驱动——热区按下即起 100ms 计时轮询，到 3s 经 onTimeFire 回调触发，
 * 不再依赖 MOVE 事件流（零 MOVE 静止长压亦可触发）；MOVE 分支保留作进度环刷新。
 * R8-04（v1.4.4）：只跟踪热区触点 id——
 *   启动：仅 action=0 且 count=1 的首指、落点在热区、且该触点通过 R8-01 逐触点防猫判定；
 *   计时中：任何非 tracking 触点出现/移动/抬起（无论落点）→ 忽略，不取消、不重置计时；
 *   tracking 触点自身：位移超容差 / UP/CANCEL / 被防猫否决（猫爪沉降确认）→ cancel；满 3 秒 → fire。
 *   ≥2 指同帧落下不启动计时（action=0 天然 count=1，保持现状）；浮层弹出后游戏侧多点响应暂停（面板守卫保持）。 */
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

  /** @returns null | {type:"progress",ratio} | {type:"fire"} | {type:"cancel",veto?:bool} */
  function feed(ev) {
    const i = ev.actionIndex || 0;
    const p = ev.pts[i] || ev.pts[0];
    if (!p) return null;
    if (!track) {
      // R8-04 启动：单指首按 + 热区 + 逐触点防猫判定通过（猫爪按热区不启动计时）
      if (ev.action === 0 && ev.count === 1 && inHot(p.x, p.y) &&
          !(CC.guard && typeof CC.guard.isBlocked === "function" && CC.guard.isBlocked(p.id))) {
        track = { x0: p.x, y0: p.y, start: performance.now(), id: p.id };
        _startTimer(); // F4 按下即起计时
        return { type: "progress", ratio: 0 };
      }
      return null;
    }
    // R8-04 计时中：tracking 触点被防猫否决（如猫爪沉降确认）→ cancel+veto（防误弹由启动判定+此处兜底）
    if (CC.guard && typeof CC.guard.isBlocked === "function" && CC.guard.isBlocked(track.id)) {
      _clearTrack(); return { type: "cancel", veto: true };
    }
    // R8-04：非 tracking 触点出现/移动/抬起一律忽略（原「第二触点即取消」已拆除）——
    // 仅 tracking 触点自身的事件才影响计时：
    const q = ev.pts.find(t => t.id === track.id);
    if (!q) { _clearTrack(); return { type: "cancel" }; } // tracking 触点从 pts 消失（被抬起的兜底）
    if ((ev.action === 1 || ev.action === 3 || ev.action === 6) && p.id === track.id) {
      _clearTrack(); return { type: "cancel" }; // tracking 触点自身 UP/CANCEL/POINTER_UP
    }
    if (Math.hypot(q.x - track.x0, q.y - track.y0) > MOVE_TOLERANCE_DP) {
      _clearTrack(); return { type: "cancel" };
    }
    if (ev.action === 2) {
      // MOVE 分支保留：仅作进度刷新（fire 由计时轮询负责，此处到点也兜底一次）
      const r = Math.min(1, (performance.now() - track.start) / HOLD_MS);
      if (r >= 1) { _clearTrack(); return { type: "fire" }; }
      return { type: "progress", ratio: r };
    }
    return null; // 其他触点的 DOWN/MOVE/抬起：忽略，计时不中断
  }

  function cancel() { _clearTrack(); }
  return { feed, cancel, setInsets, hotZone,
    isTracking: () => !!track,
    trackingId: () => (track ? track.id : null), // R8-04：暴露 tracking 触点 id（main.js 防猫提示用）
    onTimeFire: null /* F4 由 main.js 挂接：与事件路径 fire 同处理 */,
    onProgress: null /* R4 由 main.js 挂接：100ms 轮询进度回调驱动 DOM 进度环 */ };
})();
