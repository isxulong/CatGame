#!/usr/bin/env node
/* R6-03 老鼠运动回归（3 种子 60s 仿真）+ 其余 5 动物走读 + R6-09 分布校验
 * 基线（v1.4.1 修复前实测）：沿边 vy 60s 反转 91/93/95 次（三种子）。
 * 门槛：修复后 vy 符号反转 ≤10 次/60s/种子；任意两次反转间隔 ≥2000ms（阈值表：单向 ≥2s）；
 *       位置恒在安全带 [24, W-24]×[24, H-24] 内；无 NaN。
 * 走读：其余 5 动物各 spawn 5 只 × 600 帧无异常、坐标有限且不出屏。
 * R6-09：2000 次 spawn 抽样 sizeMul/spdMul ∈ [0.85,1.15] 全满足；|均值-1| < 0.02；相关系数 < 0。
 * 方法：Node vm 加载真实 data.js + engine.js（canvas/Image 打桩，不渲染，仅驱动 frame()）。
 */
const fs = require("fs"), path = require("path"), vm = require("vm");
const SRC = path.join(__dirname, "../src/app/src/main/assets/game/js");

function mulberry(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function fakeCtx() {
  const g = new Proxy({}, { get: (t, k) => {
    if (k === "createRadialGradient" || k === "createLinearGradient") return () => ({ addColorStop: () => {} });
    if (k === "measureText") return () => ({ width: 0 });
    if (k === "getImageData") return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
    return () => {};
  }, set: () => true });
  return g;
}
function fakeCanvas() { return { width: 0, height: 0, getContext: () => fakeCtx(), style: {} }; }

function boot(seed) {
  const sandbox = {
    document: { createElement: tag => fakeCanvas(), createElementNS: () => fakeCanvas() },
    performance: { now: () => simNow }, console, Image: function () { return {}; },
    localStorage: { getItem: () => null, setItem: () => {} },
    requestAnimationFrame: () => {}, fetch: () => Promise.reject(new Error("no-fetch"))
  };
  vm.createContext(sandbox);
  vm.runInContext("this.window = this; this.CC = this.CC || {};", sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, "data.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, "engine.js"), "utf8"), sandbox);
  const CC = vm.runInContext("this.CC", sandbox);
  CC.config = JSON.parse(JSON.stringify(CC.DEFAULTS.config));
CC.debug = JSON.parse(JSON.stringify(CC.DEFAULTS.debug));
  CC.audio = { startHum: () => {}, stopHum: () => {}, hit: () => {}, ensure: () => {} };
  // 确定性随机：替换 Math.random（vm 内 engine 用全局 Math）
  vm.runInContext(`Math.random = (function(seed){ let a = seed >>> 0; return function(){ a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })(${seed});`, sandbox);
  return CC;
}
let simNow = 0;

function newEngine(CC, W, H) {
  const e = new CC.Engine({ bgCanvas: fakeCanvas(), spriteCanvas: fakeCanvas(), widthDp: W, heightDp: H, dpr: 2 });
  e.isPreview = true; // 跳过降级 tick 与音频
  return e;
}
function fakePr(CC, eng, cat) {
  if (!eng._pr) eng._pr = {};
  const w = CC.BASE_WIDTH_DP[cat];
  eng._pr[cat] = [0, 1, 2].map(() => ({ wDp: w, hDp: w * 0.7, body: fakeCanvas(), wing: null, ratio: 0.7 }));
}

/* ---- R6-03 老鼠 3 种子 ---- */
const BASELINE = [91, 93, 95];
const mouseRes = [];
for (let s = 0; s < 3; s++) {
  const CC = boot(1000 + s);
  CC.config.cats = ["mouse"]; CC.config.count = 1; CC.config.speed = 1;
  const eng = newEngine(CC, 854, 480);
  fakePr(CC, eng, "mouse");
  const e = eng.spawn("mouse");
  let reversals = 0, lastRevAt = -1e9, minGap = Infinity, out = 0, nan = 0;
  let prevSign = Math.sign(e.vy);
  simNow = 0;
  const m = CC.SAFE_BELT;
  for (let f = 0; f < 3600; f++) { // 60s @60fps
    simNow += 1000 / 60;
    eng.frame(simNow, 1 / 60);
    if (!isFinite(e.x) || !isFinite(e.y)) nan++;
    if (e.x < m - 0.01 || e.x > 854 - m + 0.01 || e.y < m - 0.01 || e.y > 480 - m + 0.01) out++;
    const sg = Math.sign(e.vy);
    if (sg !== 0 && prevSign !== 0 && sg !== prevSign) {
      reversals++;
      minGap = Math.min(minGap, simNow - lastRevAt);
      lastRevAt = simNow;
    }
    if (sg !== 0) prevSign = sg;
  }
  mouseRes.push({ seed: 1000 + s, vyReversals: reversals, baseline: BASELINE[s],
    minReverseGapMs: reversals > 0 ? Math.round(minGap) : null, outOfBeltFrames: out, nanFrames: nan });
}

/* ---- 其余 5 动物走读 ---- */
const walkRes = [];
for (const cat of ["ladybug", "housefly", "bee", "butterfly", "goldfish"]) {
  const CC = boot(7);
  CC.config.cats = [cat]; CC.config.count = 5; CC.config.speed = 1;
  const eng = newEngine(CC, 854, 480);
  fakePr(CC, eng, cat);
  const ents = []; for (let i = 0; i < 5; i++) ents.push(eng.spawn(cat));
  let bad = 0;
  simNow = 0;
  const m = CC.SAFE_BELT;
  for (let f = 0; f < 600; f++) {
    simNow += 1000 / 60;
    try { eng.frame(simNow, 1 / 60); } catch (err) { bad++; break; }
    for (const e of eng.entities) {
      if (e.dead) continue;
      if (!isFinite(e.x) || !isFinite(e.y) || e.x < m - 0.01 || e.x > 854 - m + 0.01 || e.y < m - 0.01 || e.y > 480 - m + 0.01) bad++;
    }
  }
  walkRes.push({ cat, entities: eng.entities.filter(e => !e.dead).length, badFrames: bad });
}

/* ---- R6-09 分布校验 ---- */
const CC9 = boot(2026);
CC9.config.cats = ["bee"]; CC9.config.speed = 1; CC9.config.count = 1;
const eng9 = newEngine(CC9, 854, 480);
fakePr(CC9, eng9, "bee");
simNow = 0;
const sizes = [], spds = [];
for (let i = 0; i < 2000; i++) {
  const e = eng9.spawn("bee");
  sizes.push(e.sizeMul); spds.push(e.spdMul);
  eng9.entities.pop();
}
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const inRange = (a, lo, hi) => a.every(v => v >= lo && v <= hi);
const ms = mean(sizes), mp = mean(spds);
let cov = 0; const sd = a => Math.sqrt(mean(a.map(v => (v - mean(a)) ** 2)));
for (let i = 0; i < sizes.length; i++) cov += (sizes[i] - ms) * (spds[i] - mp);
const corr = cov / sizes.length / (sd(sizes) * sd(spds));
const dist = {
  n: 2000, sizeMean: +ms.toFixed(4), spdMean: +mp.toFixed(4),
  sizeInClamp: inRange(sizes, 0.85, 1.15), spdInClamp: inRange(spds, 0.85, 1.15),
  meanDevSizeOK: Math.abs(ms - 1) < 0.02, meanDevSpdOK: Math.abs(mp - 1) < 0.02,
  corr: +corr.toFixed(3), negCorrOK: corr < 0
};

const mousePass = mouseRes.every(r => r.vyReversals <= 10 && (r.minReverseGapMs === null || r.minReverseGapMs >= 2000) && r.outOfBeltFrames === 0 && r.nanFrames === 0);
const out = { suite: "mouse_R6-03_walkthrough_R6-09",
  baseline_v1_4_1: BASELINE, mouse: mouseRes, walkthrough: walkRes, distribution_R6_09: dist,
  pass: mousePass && walkRes.every(w => w.badFrames === 0) && dist.sizeInClamp && dist.spdInClamp && dist.meanDevSizeOK && dist.meanDevSpdOK && dist.negCorrOK };
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
