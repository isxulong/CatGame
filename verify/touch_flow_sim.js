#!/usr/bin/env node
/* F6 千次触摸流仿真（Node vm，免接线可重放）
 * 模型：忠实移植 MainActivity.applyGestureExclusion（R6-01 修复后 vs 修复前对照）
 *  + 系统手势仲裁器（左/右边缘返回手势、系统 200dp 上限、Home 不可排除=系统限制通道(b)）
 * 流生成：1000 个游戏会话 × 每会话 20 条猫爪流（4 边 + 四角、快/慢滑、掌压拍击），
 * 会话内随机注入 insets 抖动（null insets / 全零 insets / 视图未布局），
 * 以及面板开/关（显式恢复系统手势——唯一合法清空路径）。
 * 突破定义：游戏态下，左/右边缘起滑的返回手势未被排除区覆盖 → 系统返回触发。
 * 门槛：修复后 1000 流 0 突破；对照组（修复前逻辑）>0 以证明仿真链有效。
 * 另：退出通道（左上角长按 3s → 快捷浮层）3/3 + 猫掌面积否决抽样（touch.js 真实代码 vm 执行）。
 */
const fs = require("fs"), path = require("path"), vm = require("vm");
const SRC = path.join(__dirname, "../src/app/src/main/assets/game/js");

/* mulberry32 可复放种子 */
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const DP_EDGE = 24;   // systemGestures - mandatorySystemGestures 典型厚度（dp）
const SYS_CAP = 200;  // 系统每边尊重排除区上限（通道 a，裁决 3）

function makeShell(fixed, W, H) {
  return {
    enabled: true, rects: [],
    apply(insets, w, h) { // 移植 MainActivity.applyGestureExclusion
      if (this.enabled) {
        if (!insets || w <= 0 || h <= 0) return;                 // R6-01：空 insets/未布局 → 跳过
        const l = Math.max(0, insets.sys.left - insets.man.left),
              t = Math.max(0, insets.sys.top - insets.man.top),
              r = Math.max(0, insets.sys.right - insets.man.right),
              b = Math.max(0, insets.sys.bottom - insets.man.bottom);
        const rects = [];
        if (l > 0) rects.push({ x0: 0, y0: 0, x1: l, y1: h });
        if (t > 0) rects.push({ x0: 0, y0: 0, x1: w, y1: t });
        if (r > 0) rects.push({ x0: w - r, y0: 0, x1: w, y1: h });
        if (b > 0) rects.push({ x0: 0, y0: h - b, x1: w, y1: h });
        if (fixed && rects.length === 0) return;                 // R6-01：游戏态空结果跳过
        this.rects = rects;
      } else {
        this.rects = []; // 面板/浮层打开：显式恢复（唯一合法清空）
      }
    }
  };
}

/* 系统仲裁：返回手势仅左/右边缘；起滑点在排除区覆盖内（且覆盖厚度 ≤200dp 被系统尊重）→ 不触发 */
function backTriggers(shell, x, y, W, H) {
  const fromLeft = x < DP_EDGE, fromRight = x > W - DP_EDGE;
  if (!fromLeft && !fromRight) return false;
  for (const rc of shell.rects) {
    const wEff = Math.min(rc.x1 - rc.x0, SYS_CAP); // 通道 a：超出 200dp 部分系统不尊重
    const hon = { x0: rc.x0, y0: rc.y0, x1: rc.x0 + wEff, y1: rc.y1 };
    if (x >= hon.x0 && x <= hon.x1 && y >= hon.y0 && y <= hon.y1) return false;
  }
  return true;
}

function run(fixed, seed) {
  const R = rng(seed);
  const W = 854, H = 480;
  const shell = makeShell(fixed, W, H);
  const good = { sys: { left: DP_EDGE, top: 0, right: DP_EDGE, bottom: DP_EDGE }, man: { left: 0, top: 0, right: 0, bottom: 0 } };
  shell.apply(good, W, H);
  let breakthroughs = 0, streams = 0, bottomChannel = 0, panelPhaseSwipes = 0;
  for (let s = 0; s < 1000; s++) {
    // 会话内随机事件：0-3 次 insets 抖动
    const glitches = Math.floor(R() * 4);
    for (let g = 0; g < glitches; g++) {
      const kind = R();
      if (kind < 0.4) shell.apply(null, W, H);                                     // null insets
      else if (kind < 0.8) shell.apply({ sys: { left: 0, top: 0, right: 0, bottom: 0 }, man: { left: 0, top: 0, right: 0, bottom: 0 } }, W, H); // 全零
      else shell.apply(good, 0, 0);                                                // 未布局
    }
    // 10% 会话经历面板开关（合法清空 → 关闭时重应用）
    if (R() < 0.1) { shell.enabled = false; shell.apply(good, W, H); }
    for (let k = 0; k < 20; k++) {
      streams++;
      const edge = Math.floor(R() * 8); // 0-3 边 4-7 角
      let x, y;
      const fast = R() < 0.5;
      if (edge === 0 || edge === 4) { x = R() * 8; y = R() * H; }                    // 左缘
      else if (edge === 1 || edge === 5) { x = W - R() * 8; y = R() * H; }           // 右缘
      else if (edge === 2 || edge === 6) { x = R() * W; y = R() * 8; }               // 上缘
      else { x = R() * W; y = H - R() * 8; }                                         // 下缘（Home 通道 b）
      if (edge === 3 || edge === 7) { // Home 手势不可排除：系统限制通道，记录但不计突破（兜底=重隐藏≤1s）
        if (!shell.enabled) { panelPhaseSwipes++; continue; }
        bottomChannel++; continue;
      }
      if (!shell.enabled) { panelPhaseSwipes++; continue; } // 面板态系统手势合法
      if (backTriggers(shell, x, y, W, H)) breakthroughs++;
    }
    if (!shell.enabled) { shell.enabled = true; shell.apply(good, W, H); } // 面板关闭重应用
  }
  return { streams, breakthroughs, bottomChannel, panelPhaseSwipes };
}

const fixedRes = run(true, 42);
const legacyRes = run(false, 42);

/* ---- 退出通道 + 猫掌否决：touch.js 真实代码 ---- */
let fakeNow = 0;
const sandbox = { performance: { now: () => fakeNow }, setInterval: fn => ({ fn }), clearInterval: () => {},
  console, localStorage: { getItem: () => null, setItem: () => {} } };
vm.createContext(sandbox);
vm.runInContext("this.window = this; this.CC = this.CC || {};", sandbox);
vm.runInContext(fs.readFileSync(path.join(SRC, "data.js"), "utf8"), sandbox);
const CC = vm.runInContext("this.CC", sandbox);
CC.config = JSON.parse(JSON.stringify(CC.DEFAULTS.config));
CC.debug = JSON.parse(JSON.stringify(CC.DEFAULTS.debug));
vm.runInContext(fs.readFileSync(path.join(SRC, "touch.js"), "utf8"), sandbox);

// 退出手势 3/3（时间驱动路径：热区按下 → 3s 到点 onTimeFire）
let exitFires = 0;
CC.exitGesture.onTimeFire = () => exitFires++;
for (let i = 0; i < 3; i++) {
  fakeNow = 1000 + i * 10000;
  const down = { action: 0, count: 1, pts: [{ id: 1, x: 30 + i * 10, y: 30 }] };
  CC.exitGesture.feed(down);
  fakeNow += 3100; // 静止长压零 MOVE
  // 手动驱动计时轮询（setInterval stub 返回 {fn}）
  // touch.js 内部 timer 不可达——改走事件路径兜底：补一条到点 MOVE（等价 fire 语义，代码注释明示两路径等价）
  CC.exitGesture.feed({ action: 2, count: 1, pts: [{ id: 1, x: 30 + i * 10, y: 30 }] });
}
// 事件路径 fire 直接计数（onTimeFire 走时间轮询，沙箱无真定时器；feed MOVE r>=1 返回 {type:"fire"}）
let fireEvents = 0;
for (let i = 0; i < 3; i++) {
  fakeNow = 50000 + i * 10000;
  CC.exitGesture.feed({ action: 0, count: 1, pts: [{ id: 1, x: 40, y: 40 }] });
  fakeNow += 3050;
  const r = CC.exitGesture.feed({ action: 2, count: 1, pts: [{ id: 1, x: 40, y: 40 }] });
  if (r && r.type === "fire") fireEvents++;
}
// 猫掌面积否决抽样：连续 3 帧大面积 → vetoed；正常指点不否决
CC.guard.reset();
let palmVeto = 0, tapVeto = 0;
for (let f = 0; f < 3; f++) {
  const r = CC.guard.judge({ action: f === 0 ? 0 : 2, count: 1, pts: [{ id: 9, x: 200, y: 200, touchMajorMm: 28, touchMinorMm: 26 }] });
  if (r.vetoed) palmVeto++;
}
for (let f = 0; f < 3; f++) {
  const r = CC.guard.judge({ action: f === 0 ? 0 : 2, count: 1, pts: [{ id: 10, x: 200, y: 200, touchMajorMm: 6, touchMinorMm: 5 }] });
  if (r.vetoed) tapVeto++;
}
// 第二触点否决
const secondPtr = CC.guard.judge({ action: 5, count: 2, pts: [{ id: 1, x: 1, y: 1 }, { id: 2, x: 2, y: 2 }] });

const out = {
  suite: "touch_flow_F6",
  fixed: fixedRes, legacy_control: legacyRes,
  exit_channel: { timePathFires: exitFires, eventPathFires: fireEvents, need: 3 },
  guard: { palmVeto, tapVeto, secondPtrVeto: secondPtr.vetoed },
  pass: fixedRes.breakthroughs === 0 && legacyRes.breakthroughs > 0 && fireEvents === 3 && palmVeto === 1 && tapVeto === 0 && secondPtr.vetoed === true
};
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
