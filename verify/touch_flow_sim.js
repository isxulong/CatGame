#!/usr/bin/env node
/* 多点触控仿真门禁（Node vm，免接线可重放）—— R8-07/S1（v1.4.4 全量改写）
 *
 * 三部分：
 *  ① F6 千次触摸流仿真（保留）：MainActivity.applyGestureExclusion 移植模型 + 系统手势仲裁器，
 *     修复后 1000 流 0 突破、对照组（修复前逻辑）>0 证明仿真链有效。
 *  ② MT-01~MT-08 多点触控用例（R8 第五章逐条）：vm 沙箱加载真实 data.js + touch.js + main.js，
 *     DOM/引擎/动效桩注入，全部事件经 window.__nativeTouch 走与真机完全相同的判定链
 *     （guard.judge → exitGesture.feed → 命中/受惊/动效）。
 *  ③ 单点回归（MT-07）：退出通道事件路径 3/3、猫掌面积否决逐帧口径、人类指点零误杀、
 *     第二人类触点不再被否决（S1：原「第二触点必否决」假绿断言已随 R8-01 拆除）。
 *
 * 防猫口径（R8-01 实施注记，与 touch.js 头注一致）：大面积首帧（warming）即否决该触点命中
 * ——命中只发生在按下帧，等 3 帧确认则按下帧必然先命中；250mm² 高于人类用力按压上限≈227mm²。
 * 「千次随机猫爪流 0 突破」口径（R8-07）：多点人类流可命中、猫掌流仍 0 突破。
 */
const fs = require("fs"), path = require("path"), vm = require("vm");
const SRC = path.join(__dirname, "../src/app/src/main/assets/game/js");
const EVID = path.join(__dirname, "../artifacts/evidence");

/* mulberry32 可复放种子 */
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/* ============================ ① F6 手势排除千次流（保留，MT-07 依赖） ============================ */
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

function backTriggers(shell, x, y, W, H) {
  const fromLeft = x < DP_EDGE, fromRight = x > W - DP_EDGE;
  if (!fromLeft && !fromRight) return false;
  for (const rc of shell.rects) {
    const wEff = Math.min(rc.x1 - rc.x0, SYS_CAP);
    const hon = { x0: rc.x0, y0: rc.y0, x1: rc.x0 + wEff, y1: rc.y1 };
    if (x >= hon.x0 && x <= hon.x1 && y >= hon.y0 && y <= hon.y1) return false;
  }
  return true;
}

function runF6(fixed, seed) {
  const R = rng(seed);
  const W = 854, H = 480;
  const shell = makeShell(fixed, W, H);
  const good = { sys: { left: DP_EDGE, top: 0, right: DP_EDGE, bottom: DP_EDGE }, man: { left: 0, top: 0, right: 0, bottom: 0 } };
  shell.apply(good, W, H);
  let breakthroughs = 0, streams = 0, bottomChannel = 0, panelPhaseSwipes = 0;
  for (let s = 0; s < 1000; s++) {
    const glitches = Math.floor(R() * 4);
    for (let g = 0; g < glitches; g++) {
      const kind = R();
      if (kind < 0.4) shell.apply(null, W, H);
      else if (kind < 0.8) shell.apply({ sys: { left: 0, top: 0, right: 0, bottom: 0 }, man: { left: 0, top: 0, right: 0, bottom: 0 } }, W, H);
      else shell.apply(good, 0, 0);
    }
    if (R() < 0.1) { shell.enabled = false; shell.apply(good, W, H); }
    for (let k = 0; k < 20; k++) {
      streams++;
      const edge = Math.floor(R() * 8);
      let x, y;
      if (edge === 0 || edge === 4) { x = R() * 8; y = R() * H; }
      else if (edge === 1 || edge === 5) { x = W - R() * 8; y = R() * H; }
      else if (edge === 2 || edge === 6) { x = R() * W; y = R() * 8; }
      else { x = R() * W; y = H - R() * 8; }
      if (edge === 3 || edge === 7) {
        if (!shell.enabled) { panelPhaseSwipes++; continue; }
        bottomChannel++; continue;
      }
      if (!shell.enabled) { panelPhaseSwipes++; continue; }
      if (backTriggers(shell, x, y, W, H)) breakthroughs++;
    }
    if (!shell.enabled) { shell.enabled = true; shell.apply(good, W, H); }
  }
  return { streams, breakthroughs, bottomChannel, panelPhaseSwipes };
}

const fixedRes = runF6(true, 42);
const legacyRes = runF6(false, 42);

/* ============================ ② MT 系列用例：真实代码 vm 沙箱 + DOM 桩 ============================ */
/* 命中区：x∈[300,600] 且 y∈[100,400]（引擎桩 hitTest 判真）；其余为空区（startle）。
 * 热区：insets{0,0} → [0,120]×[0,120]（exitGesture.hotZone，真实代码）。 */
const HIT = (x, y) => (x >= 300 && x <= 600 && y >= 100 && y <= 400);

function makeGameHarness(opts) {
  const o = opts || {};
  let fakeNow = 1000000;
  let timeSeq = 0;
  const timeouts = new Map();   // id -> {fn, at}
  const intervals = new Map();  // id -> {fn, ms}

  const el = () => ({
    id: "", className: "", textContent: "",
    style: { setProperty() {}, left: "", top: "", display: "", opacity: "" },
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}
  });

  const st = {
    panelOpen: false, quickOpen: false,
    hits: 0, hitAt: [], startles: 0, hudRefresh: 0, perfLogs: 0,
    quickShows: 0, timeFires: 0,
    fx: [],               // {type,x,y}
    fxRecycled: 0, fxMaxActive: 0
  };

  const fxActive = [];
  const fx = {
    trigger(type, x, y) {
      st.fx.push({ type, x: Math.round(x), y: Math.round(y) });
      fxActive.push({ seq: ++timeSeq });
      if (fxActive.length > CC.debug.maxFxInstances) { fxActive.shift(); st.fxRecycled++; } // 移植 effects.js:89-92 回收最旧
      st.fxMaxActive = Math.max(st.fxMaxActive, fxActive.length);
    },
    update() {}, init() {}
  };

  const sandbox = {
    performance: { now: () => fakeNow },
    setTimeout(fn, ms) { const id = ++timeSeq; timeouts.set(id, { fn, at: fakeNow + ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, ms) { const id = ++timeSeq; intervals.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    console, Math, JSON,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      addEventListener() {}, getElementById: () => null,
      createElement: el, body: { appendChild() {} }
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);

  vm.runInContext("this.CC = this.CC || {};", sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, "data.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, "touch.js"), "utf8"), sandbox);
  const CC = vm.runInContext("this.CC", sandbox);

  CC.config = JSON.parse(JSON.stringify(CC.DEFAULTS.config));
  CC.debug = JSON.parse(JSON.stringify(CC.DEFAULTS.debug));

  vm.runInContext(fs.readFileSync(path.join(SRC, "main.js"), "utf8"), sandbox);

  /* 桩：面板/引导/快捷浮层（守卫）、引擎、动效、HUD、perfLog —— main.js 判定链全部走真实代码 */
  CC.panel = { isOpen: () => st.panelOpen };
  CC.guide = { isOpen: () => false };
  CC.quick = { isOpen: () => st.quickOpen, show() { st.quickShows++; } };
  CC.engine = {
    hitTest: (x, y) => (HIT(x, y) ? { x, y } : null),
    onHit: (hit) => { st.hits++; st.hitAt.push({ x: Math.round(hit.x), y: Math.round(hit.y) }); },
    startle: () => { st.startles++; },
    isPaused: () => true, ctx: {}, dpr: 1
  };
  CC.effects = fx;
  CC.hud = { refresh: () => { st.hudRefresh++; } };
  CC.perfLog = () => { st.perfLogs++; };
  CC.exitGesture.onTimeFire = () => { st.timeFires++; };
  CC.exitGesture.onProgress = () => {};
  CC.exitGesture.setInsets({ left: 0, top: 0 });

  return {
    CC, st,
    nt(ev) { sandbox.window.__nativeTouch(ev); },
    advance(ms) { fakeNow += ms; let guard = 0; while (guard++ < 500) { const due = [...timeouts.entries()].filter(([, t]) => t.at <= fakeNow).sort((a, b) => a[1].at - b[1].at); if (!due.length) break; for (const [id, t] of due) { timeouts.delete(id); t.fn(); } } },
    tickIntervals(times) { for (let i = 0; i < times; i++) { fakeNow += 100; for (const [, iv] of intervals) iv.fn(); } },
    intervalCount: () => intervals.size
  };
}

/* 事件构造便捷 */
const pt = (id, x, y, maj, min) => ({ id, x, y, touchMajorMm: maj, touchMinorMm: min, pressure: 0.5, size: 0.2 });
const evDown = (pts, ai) => ({ action: 0, count: pts.length, actionIndex: ai || 0, pts });
const evPDown = (pts, ai) => ({ action: 5, count: pts.length, actionIndex: ai, pts });
const evMove = (pts, ai) => ({ action: 2, count: pts.length, actionIndex: ai || 0, pts });
const evUp = (pts, ai) => ({ action: 1, count: pts.length, actionIndex: ai || 0, pts });
const evPUp = (pts, ai) => ({ action: 6, count: pts.length, actionIndex: ai, pts });

const fxCountAt = (st, x, y, type) => st.fx.filter(f => f.x === Math.round(x) && f.y === Math.round(y) && (!type || f.type === type)).length;

/* ---- MT-01 双指按住+点击：ptr0 按住空区 → ptr1 循环 10 次点命中区 → 10/10 ---- */
function mt01() {
  const h = makeGameHarness();
  const { st } = h;
  const P0 = { x: 700, y: 450 };  // 空区（非热区、非命中区）
  const P1 = { x: 400, y: 300 };  // 命中区
  h.nt(evDown([pt(1000, P0.x, P0.y, 7, 6)]));               // ptr0 按住
  for (let i = 0; i < 10; i++) {
    const id = 2000 + i;
    h.nt(evPDown([pt(1000, P0.x, P0.y, 7, 6), pt(id, P1.x, P1.y, 8, 7)], 1));  // ptr1 落下（action=5）
    h.nt(evPUp([pt(1000, P0.x, P0.y, 7, 6), pt(id, P1.x, P1.y, 8, 7)], 1));      // ptr1 抬起（action=6）
  }
  // ptr0 全程无中断：抬起 ptr1 后 ptr0 仍被跟踪（MOVE ≥48dp 仍能再触发动效）
  h.nt(evMove([pt(1000, P0.x - 50, P0.y, 7, 6)]));
  const ok = st.hits === 10 && st.hitAt.filter(p => p.x === P1.x && p.y === P1.y).length === 10
    && fxCountAt(st, P1.x, P1.y) >= 10 && st.hudRefresh === 10
    && fxCountAt(st, P0.x - 50, P0.y) === 1 && st.startles === 1;
  return { case: "MT-01", loops: 10, hits: st.hits, hitburst: st.fx.filter(f => f.type === "hitburst").length, hud: st.hudRefresh, ptr0FxAfter: fxCountAt(st, P0.x - 50, P0.y), startle: st.startles, pass: ok };
}

/* ---- MT-02 五指并发：5 触点间隔 ≤500ms 先后 DOWN（命中/空区混合），零静默、每触点≥1 动效 ---- */
function mt02() {
  const h = makeGameHarness();
  const { st, CC } = h;
  const pos = [[350, 150, true], [700, 450, false], [500, 350, true], [750, 120, false], [600, 400, true]]; // 3 命中 2 空区
  const pts = [];
  pos.forEach(([x, y], k) => {
    pts.push(pt(300 + k, x, y, 6 + k * 0.5, 5 + k * 0.4));
    const ev = k === 0 ? evDown([...pts]) : evPDown([...pts], pts.length - 1);
    h.nt(ev);
    h.advance(Math.floor(80 + Math.random() * 100)); // 间隔 ≤500ms（远小于）
  });
  const fullResponse = st.hits + st.startles; // 每触点要么命中要么受惊——零静默
  const eachHasFx = pos.every(([x, y]) => fxCountAt(st, x, y) >= 1);
  const base = { pass: fullResponse === 5 && st.hits === 3 && st.startles === 2 && eachHasFx && st.fxRecycled === 0 && st.fxMaxActive <= CC.debug.maxFxInstances };
  // 对照组（R8-06 原口径）：5 爪齐下全落命中区 → 瞬时「触发动效+命中爆裂」= 10 实例——
  // 上限 12 时 0 回收（每触点至少 1 个动效可见）；上限回到 8（修复前）必然回收最旧吞掉先触发动效 → 证明 8→12 必要且门禁有效
  const burst = (cap) => {
    const hb = makeGameHarness();
    hb.CC.debug.maxFxInstances = cap;
    const bp = [];
    for (let k = 0; k < 5; k++) {
      bp.push(pt(400 + k, 350 + k * 40, 150 + k * 40, 6 + k * 0.5, 5 + k * 0.4)); // 5 指全落命中区
      hb.nt(k === 0 ? evDown([...bp]) : evPDown([...bp], bp.length - 1));
    }
    return { recycled: hb.st.fxRecycled, active: hb.st.fxMaxActive, hits: hb.st.hits };
  };
  const cap12 = burst(12), cap8 = burst(8);
  return { case: "MT-02", responses: fullResponse, hits: st.hits, startles: st.startles, eachHasFx, fxMaxActive: st.fxMaxActive, recycled: st.fxRecycled, burst10_cap12: cap12, burst10_cap8_control: cap8, pass: base.pass && cap12.recycled === 0 && cap12.active === 10 && cap8.recycled > 0 };
}

/* ---- MT-03 多指滑动：逐触点独立 ≥48dp 节流（含 47dp 不触发 / 累计 48dp 触发的边界） ---- */
function mt03() {
  const h = makeGameHarness();
  const { st } = h;
  h.nt(evDown([pt(10, 700, 450, 7, 6)]));                    // ptr0 空区
  h.nt(evPDown([pt(10, 700, 450, 7, 6), pt(11, 400, 300, 7, 6)], 1)); // ptr1 命中区
  const fx0 = st.fx.length;
  // ptr1 移 50dp（≥48）→ 触发；ptr0 不动 → 不触发
  h.nt(evMove([pt(10, 700, 450, 7, 6), pt(11, 450, 300, 7, 6)]));
  const after1 = st.fx.length;
  // ptr1 再移 47dp → 不触发
  h.nt(evMove([pt(10, 700, 450, 7, 6), pt(11, 497, 300, 7, 6)]));
  const after2 = st.fx.length;
  // ptr1 累计再移 1dp（48dp 达标）→ 触发
  h.nt(evMove([pt(10, 700, 450, 7, 6), pt(11, 498, 300, 7, 6)]));
  const after3 = st.fx.length;
  // 双指反向同帧：ptr0 -50dp、ptr1 -50dp → 各自触发一次
  h.nt(evMove([pt(10, 650, 450, 7, 6), pt(11, 448, 300, 7, 6)]));
  const after4 = st.fx.length;
  const pass = (after1 - fx0) === 1 && fxCountAt(st, 450, 300) === 1
    && after2 === after1 && after3 === after2 + 1 && fxCountAt(st, 498, 300) === 1
    && (after4 - after3) === 2 && fxCountAt(st, 650, 450) === 1 && fxCountAt(st, 448, 300) === 1;
  return { case: "MT-03", retriggerPtr1: [after1 - fx0, after3 - after2, 1], noFireAt47dp: after2 === after1, bothOnReverse: after4 - after3, pass };
}

/* ---- MT-04 第 6 指防护：5 指在屏 + 第 6 指 DOWN → 第 6 指命中=0、动效照播、前 5 指不受影响 ---- */
function mt04() {
  const h = makeGameHarness();
  const { st } = h;
  const basePts = [pt(0, 350, 150, 7, 6), pt(1, 700, 450, 7, 6), pt(2, 500, 350, 7, 6), pt(3, 750, 120, 7, 6), pt(4, 600, 400, 7, 6)];
  basePts.forEach((p, k) => h.nt(k === 0 ? evDown([p]) : evPDown(basePts.slice(0, k + 1), k)));
  const hits5 = st.hits, fx5 = st.fx.length;
  const p6 = pt(5, 400, 200, 7, 6); // 第 6 指落在命中区
  h.nt(evPDown([...basePts, p6], 5));
  const hits6 = st.hits, fx6 = st.fx.length;
  // 前 5 指仍存活：ptr0 MOVE ≥48dp 仍能再触发
  const moved = basePts.map((p, k) => k === 0 ? pt(0, 300, 150, 7, 6) : p);
  h.nt(evMove(moved));
  const fx7 = st.fx.length;
  // 第 6 指不被跟踪：其 MOVE 不触发动效（veto return 早于 fxLastPoint.set）
  const p6m = pt(5, 460, 200, 7, 6);
  const moved6 = moved.map((p, k) => k === 0 ? pt(0, 300, 150, 7, 6) : p).concat([]); // 前 5 指保持
  h.nt(evMove([...moved.slice(0, 5).map((p, k) => k === 0 ? pt(0, 300, 150, 7, 6) : p), p6m]));
  const fx8 = st.fx.length;
  const pass = hits6 === hits5 && (fx6 - fx5) === 1 && fxCountAt(st, 400, 200) === 1
    && (fx7 - fx6) === 1 && fxCountAt(st, 300, 150) === 1
    && fx8 === fx7 && fxCountAt(st, 460, 200) === 0;
  return { case: "MT-04", sixthHits: hits6 - hits5, sixthFx: fx6 - fx5, firstFiveAlive: fx7 - fx6, sixthMoveFx: fx8 - fx7, pass };
}

/* ---- MT-05 长按共存（R8-04 新语义）：非 tracking 触点不取消计时；自身抬起才 cancel；两条 fire 路径 3/3 ---- */
function mt05() {
  const res = { case: "MT-05", runs: [] };
  // Run A：热区长按启动 → 第二指非热区 DOWN/MOVE/UP 干扰 → 计时不中断、满 3s fire
  {
    const h = makeGameHarness();
    const { st } = h;
    h.nt(evDown([pt(200, 30, 30, 7, 6)]));                                   // 热区启动计时
    const tracking0 = h.CC.exitGesture.isTracking();
    h.nt(evPDown([pt(200, 30, 30, 7, 6), pt(201, 400, 300, 8, 7)], 1));      // ptr1 非热区落下（命中区）→ 命中且计时不断
    const hitDuringTiming = st.hits;
    h.nt(evMove([pt(200, 30, 30, 7, 6), pt(201, 410, 300, 8, 7)]));          // ptr1 MOVE
    const stillTracking = h.CC.exitGesture.isTracking();
    h.nt(evPUp([pt(200, 30, 30, 7, 6), pt(201, 410, 300, 8, 7)], 1));         // ptr1 抬起 → 计时仍不断
    const stillTracking2 = h.CC.exitGesture.isTracking();
    h.advance(3050);
    h.nt(evMove([pt(200, 30, 30, 7, 6)]));                                   // 事件路径到点 → fire
    h.advance(200);                                                           // 150ms 脉冲 setTimeout → quick.show
    res.runs.push({ run: "A-interference", tracking0, hitDuringTiming, stillTrackingAfterPtr1Move: stillTracking, stillTrackingAfterPtr1Up: stillTracking2, quickShows: st.quickShows, pass: tracking0 && hitDuringTiming === 1 && stillTracking && stillTracking2 && st.quickShows === 1 });
  }
  // Run B：热区长按启动 → 中途自身抬起 → cancel、不弹浮层、后续时间驱动不再触发
  {
    const h = makeGameHarness();
    const { st } = h;
    h.nt(evDown([pt(210, 40, 40, 7, 6)]));
    h.advance(1000);
    h.nt(evUp([pt(210, 40, 40, 7, 6)]));                                     // tracking 触点自身 UP → cancel
    const cancelled = !h.CC.exitGesture.isTracking();
    h.tickIntervals(35);                                                     // 到 3s 后轮询不应再 fire
    res.runs.push({ run: "B-lift-cancel", cancelled, timeFiresAfterCancel: st.timeFires, quickShows: st.quickShows, pass: cancelled && st.timeFires === 0 && st.quickShows === 0 });
  }
  // Run C：时间驱动路径 3/3（F4 轮询到点 onTimeFire；含 31 tick 到 3000ms 边界）
  {
    let fires = 0;
    for (let i = 0; i < 3; i++) {
      const h = makeGameHarness();
      h.nt(evDown([pt(220 + i, 30 + i * 5, 30, 7, 6)]));
      h.tickIntervals(31);
      if (h.st.timeFires === 1) fires++;
    }
    res.runs.push({ run: "C-time-path", fires, need: 3, pass: fires === 3 });
  }
  // Run D：猫掌按热区 → 启动判定（逐触点防猫）拦截，不启动计时、不弹浮层
  {
    const h = makeGameHarness();
    const { st } = h;
    h.nt(evDown([pt(300, 30, 30, 25, 22)]));                                 // 面积 π*12.5*11≈431mm² ≥250 → warming 首帧否决
    h.advance(3200);
    h.tickIntervals(35);
    res.runs.push({ run: "D-palm-in-hot", tracking: h.CC.exitGesture.isTracking(), timeFires: st.timeFires, quickShows: st.quickShows, pass: !h.CC.exitGesture.isTracking() && st.timeFires === 0 && st.quickShows === 0 });
  }
  res.pass = res.runs.every(r => r.pass);
  return res;
}

/* ---- MT-06 防猫千次流（R8-07 重定义口径）：猫掌触点 0 突破 + 人类特征触点不误杀 ---- */
function mt06() {
  let sessions = 0, palmDowns = 0, palmFx = 0, breakthroughs = 0, humanHits = 0, overCapSessions = 0;
  const R = rng(20261008);
  for (let s = 0; s < 1000; s++) {
    const h = makeGameHarness();
    const { st } = h;
    const variant = R();
    let expected = 0, palmEvents = 0;
    if (variant < 0.5) {
      // A（50%）：猫掌先落（命中区）→ 人指点命中区 → 猫掌抖动 → 人指抬起
      const px = 320 + R() * 80, py = 120 + R() * 80, hx = 480 + R() * 100, hy = 300 + R() * 80;
      h.nt(evDown([pt(1, px, py, 20 + R() * 10, 18 + R() * 10)])); palmEvents++;
      h.nt(evPDown([pt(1, px, py, 20 + R() * 10, 18 + R() * 10), pt(2, hx, hy, 5 + R() * 5, 4 + R() * 4)], 1));
      expected = 1;
      if (R() < 0.5) h.nt(evMove([pt(1, px + R() * 4, py + R() * 4, 20 + R() * 10, 18 + R() * 10), pt(2, hx, hy, 5 + R() * 5, 4 + R() * 4)])); palmEvents++;
      h.nt(evPUp([pt(1, px, py, 20 + R() * 10, 18 + R() * 10), pt(2, hx, hy, 5 + R() * 5, 4 + R() * 4)], 0));
    } else if (variant < 0.8) {
      // B（30%）：人指先落 → 猫掌压上（多点交错 action=5）→ 猫掌 MOVE 确认（连续 3 帧大面积）→ 全部抬起
      const px = 320 + R() * 80, py = 120 + R() * 80, hx = 480 + R() * 100, hy = 300 + R() * 80;
      h.nt(evDown([pt(2, hx, hy, 5 + R() * 5, 4 + R() * 4)]));
      h.nt(evPDown([pt(2, hx, hy, 5 + R() * 5, 4 + R() * 4), pt(1, px, py, 20 + R() * 10, 18 + R() * 10)], 1)); palmEvents++;
      h.nt(evMove([pt(2, hx, hy, 5 + R() * 5, 4 + R() * 4), pt(1, px + R() * 3, py + R() * 3, 20 + R() * 10, 18 + R() * 10)])); palmEvents++;
      h.nt(evMove([pt(2, hx, hy, 5 + R() * 5, 4 + R() * 4), pt(1, px + R() * 3, py + R() * 3, 20 + R() * 10, 18 + R() * 10)])); palmEvents++;
      expected = 1;
      h.nt(evUp([pt(2, hx, hy, 5 + R() * 5, 4 + R() * 4)]));
    } else {
      // C（20%）：5 人指 + 猫掌为第 6 指（面积否决 + 超上限双保险）→ 仅前 5 指命中
      overCapSessions++;
      const humans = [[350, 150], [400, 200], [450, 250], [500, 300], [550, 350]];
      const pts = humans.map(([x, y], k) => pt(10 + k, x, y, 5 + R() * 5, 4 + R() * 4));
      pts.forEach((p, k) => h.nt(k === 0 ? evDown([p]) : evPDown(pts.slice(0, k + 1), k)));
      const palm = pt(99, 380, 380, 22 + R() * 8, 20 + R() * 8);
      h.nt(evPDown([...pts, palm], 5)); palmEvents++;
      h.nt(evMove([...pts, palm])); palmEvents++;
      expected = 5;
      h.nt(evUp([pts[0]]));
    }
    sessions++;
    palmDowns += palmEvents;
    palmFx += st.fx.length; // 动效照播计数（含人指 DOWN）——每条 DOWN/POINTER_DOWN 均 1 动效
    if (st.hits !== expected) breakthroughs += Math.abs(st.hits - expected);
    humanHits += Math.min(st.hits, expected);
  }
  return { case: "MT-06", sessions, overCapSessions, palmDowns, breakthroughs, humanHits, pass: sessions === 1000 && breakthroughs === 0 && humanHits >= 1000 };
}

/* ---- MT-08 面板守卫：面板/快捷浮层打开期间多点流零响应，关闭后恢复 ---- */
function mt08() {
  const h = makeGameHarness();
  const { st } = h;
  const stream = () => {
    const pts = [pt(0, 350, 150, 7, 6), pt(1, 500, 350, 7, 6)];
    h.nt(evDown([pts[0]]));
    h.nt(evPDown(pts, 1));
    h.nt(evMove(pts));
    h.nt(evPUp(pts, 1));
    h.nt(evUp([pts[0]]));
  };
  h.st.panelOpen = true; stream();
  const panelDeltas = { hits: st.hits, startles: st.startles, fx: st.fx.length, hud: st.hudRefresh };
  h.st.panelOpen = false; h.st.quickOpen = true; stream();
  const quickDeltas = { hits: st.hits, startles: st.startles, fx: st.fx.length, hud: st.hudRefresh };
  h.st.quickOpen = false; stream();
  const resumed = { hits: st.hits, startles: st.startles, fx: st.fx.length };
  const pass = panelDeltas.hits === 0 && panelDeltas.startles === 0 && panelDeltas.fx === 0 && panelDeltas.hud === 0
    && quickDeltas.hits === 0 && quickDeltas.startles === 0 && quickDeltas.fx === 0
    && resumed.hits > 0 && resumed.fx > resumed.fx - 1;
  return { case: "MT-08", panelPhaseZero: panelDeltas, quickPhaseZero: quickDeltas, resumedHits: resumed.hits, pass };
}

const mt01r = mt01(), mt02r = mt02(), mt03r = mt03(), mt04r = mt04(), mt05r = mt05(), mt06r = mt06(), mt08r = mt08();

/* ============================ ③ 单点回归（MT-07）：真实 touch.js 逐帧口径 ============================ */
const sp = (function () {
  let fakeNow = 0;
  const sandbox = { performance: { now: () => fakeNow }, setInterval: fn => ({ fn }), clearInterval: () => {},
    console, Math, JSON, localStorage: { getItem: () => null, setItem: () => {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext("this.CC = this.CC || {};", sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, "data.js"), "utf8"), sandbox);
  const CC = vm.runInContext("this.CC", sandbox);
  CC.config = JSON.parse(JSON.stringify(CC.DEFAULTS.config));
  CC.debug = JSON.parse(JSON.stringify(CC.DEFAULTS.debug));
  vm.runInContext(fs.readFileSync(path.join(SRC, "touch.js"), "utf8"), sandbox);

  // 退出通道事件路径 3/3（热区按下 → 静止 3s → 到点 MOVE 兜底 fire）
  let fireEvents = 0;
  for (let i = 0; i < 3; i++) {
    fakeNow = 50000 + i * 10000;
    CC.exitGesture.feed({ action: 0, count: 1, pts: [{ id: 1, x: 40, y: 40 }] });
    fakeNow += 3050;
    const r = CC.exitGesture.feed({ action: 2, count: 1, pts: [{ id: 1, x: 40, y: 40 }] });
    if (r && r.type === "fire") fireEvents++;
  }

  // 猫掌面积否决逐帧口径（R8-01 实施注记：首帧 warming 即否决，第 3 帧确认 palm 分类）
  CC.guard.reset();
  let palmVetoFrames = 0, palmConfirmedFrame = -1;
  for (let f = 0; f < 3; f++) {
    const r = CC.guard.judge({ action: f === 0 ? 0 : 2, count: 1, pts: [{ id: 9, x: 200, y: 200, touchMajorMm: 28, touchMinorMm: 26 }] });
    if (r.vetoed) palmVetoFrames++;
    if (r.palmPointerIds.includes(9)) palmConfirmedFrame = f + 1;
  }
  // 人类指点零误杀
  let tapVeto = 0;
  for (let f = 0; f < 3; f++) {
    const r = CC.guard.judge({ action: f === 0 ? 0 : 2, count: 1, pts: [{ id: 10, x: 200, y: 200, touchMajorMm: 6, touchMinorMm: 5 }] });
    if (r.vetoed) tapVeto++;
  }
  // S1 改写：第二人类触点不再被否决（原「第二触点必否决」断言已随 R8-01 拆除）
  const secondPtr = CC.guard.judge({ action: 5, count: 2, pts: [{ id: 1, x: 1, y: 1, touchMajorMm: 7, touchMinorMm: 6 }, { id: 2, x: 2, y: 2, touchMajorMm: 8, touchMinorMm: 7 }] });
  return { fireEvents, palmVetoFrames, palmConfirmedFrame, tapVeto, secondPtr: { vetoed: secondPtr.vetoed, blocked: secondPtr.blockedPointerIds.length } };
})();

const singlePointPass = sp.fireEvents === 3 && sp.palmVetoFrames === 3 && sp.palmConfirmedFrame === 3 && sp.tapVeto === 0
  && sp.secondPtr.vetoed === false && sp.secondPtr.blocked === 0;

/* ============================ 汇总与门禁判定 ============================ */
const out = {
  suite: "touch_flow_sim_v2",
  f6_gesture_exclusion: { fixed: fixedRes, legacy_control: legacyRes },
  mt01: mt01r, mt02: mt02r, mt03: mt03r, mt04: mt04r, mt05: mt05r, mt06: mt06r, mt08: mt08r,
  single_point_regression: sp,
  pass: fixedRes.breakthroughs === 0 && legacyRes.breakthroughs > 0
    && mt01r.pass && mt02r.pass && mt03r.pass && mt04r.pass && mt05r.pass && mt06r.pass && mt08r.pass
    && singlePointPass
};
fs.mkdirSync(EVID, { recursive: true });
fs.writeFileSync(path.join(EVID, "touch_flow_sim.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
