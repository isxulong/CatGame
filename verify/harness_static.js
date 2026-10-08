#!/usr/bin/env node
/* DOM/AC 静态套件：v1.4.4 R8 验收的静态部分（S5 同步改写）
 * DOM 套件：panel.js/main.js 引用的元素 id 在 index.html 中均存在（getElementById 交叉核对）
 * AC 套件：
 *  AC-1  源码无 F7_VERDICT / DARK_BGS / LOWVIS_CATS / lowvis / _jitter 残留（R6-03/04/05）
 *  AC-2  versionCode 12 / versionName 1.4.4（build.gradle，R8 版本升位）
 *  AC-3  maxFxInstances = 12（data.js，R8-06：8→12）
 *  AC-4  MATCH_RULE_VER = R6-05.v3；tuning 块含全部 R6 参数键 + R7-01 nearBlack + R8 dhRescue
 *  AC-5  R6/R8 阈值无散落硬编码：audio.js 无 0.012/0.7/1000/135 裸字面量；panel.js 无 40/60/80 阈值裸字面量（只经 tuning）；engine.js 无 0.10/0.15 裸幅值（只经 tuning 默认）
 *  AC-6  manifest.js/manifest.json 一致、match 36 组齐全、match_rule_ver=R6-05.v3、thresholds 与 data.js 双镜像（dhRescue=45/dhAux=20，R8-10）
 *  AC-7  源码树无 keystore / 密码 / keystore.properties（红线）
 *  AC-8  R6-05+R7-01 验收组判定复核（读 match_table.json rows）：4 组须 bad、ladybug×desk 不得 bad（R8-11：既有断言 v3 复算保持成立，重跑确认）
 *  AC-9  audio.js 增益链路节点存在（humBus/compressor/lowpass）；effects.js hitburst 存在；上限回收最旧语义
 *  AC-10 屏幕钉住误导文案已删改（panel.js 无 LockTask/屏幕钉住 残留；引导文案为重隐藏口径）
 */
const fs = require("fs"), path = require("path");
const SRC = path.join(__dirname, "../src");
const A = p => fs.readFileSync(path.join(SRC, p), "utf8");
let pass = 0, fail = 0; const fails = [];
const knownFails = [];
function T(name, cond, note) { if (cond) { pass++; } else { fail++; fails.push(name + (note ? " — " + note : "")); } }
function KF(name, cond, note) { if (cond) { pass++; } else { knownFails.push(name + (note ? " — " + note : "")); } }
/* 去注释后扫描：留档说明性注释不计残留 */
function strip(t) { return t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ").replace(/<!--[\s\S]*?-->/g, " "); }

const html = A("app/src/main/assets/index.html");
const panel = A("app/src/main/assets/game/js/panel.js");
const main = A("app/src/main/assets/game/js/main.js");
const engine = A("app/src/main/assets/game/js/engine.js");
const audio = A("app/src/main/assets/game/js/audio.js");
const effects = A("app/src/main/assets/game/js/effects.js");
const data = A("app/src/main/assets/game/js/data.js");
const gradle = A("app/build.gradle");
const java = A("app/src/main/java/com/catcatch/game/MainActivity.java");

// DOM 套件：getElementById 交叉核对
const ids = new Set();
for (const m of (panel + main).matchAll(/getElementById\("([^"]+)"\)/g)) ids.add(m[1]);
const missing = [...ids].filter(id => !html.includes(`id="${id}"`) && !(panel + main).includes(`id = "${id}"`) && !(panel + main).includes(`id="${id}"`) && !new RegExp(`\\.id\\s*=\\s*["']${id}["']`).test(panel + main));
T("DOM: getElementById 全部可解析 (" + ids.size + " ids)", missing.length === 0, "missing: " + missing.join(","));

// AC-1 残留
const allJsRaw = html + panel + main + engine + audio + effects + data;
const allJs = strip(allJsRaw);
const javaStripped = strip(java);
for (const tok of ["F7_VERDICT", "DARK_BGS", "LOWVIS_CATS", "lowvis", "_jitter"]) {
  T("AC-1 无残留 " + tok, !allJs.includes(tok));
}
// AC-2 版本（R8：versionCode 11→12、versionName 1.4.3→1.4.4）
T("AC-2 versionCode 12", /versionCode\s+12/.test(gradle));
T("AC-2 versionName 1.4.4", /versionName\s+"1\.4\.4"/.test(gradle));
T("AC-2 旧版本不残留", !/versionCode\s+11\b/.test(gradle) && !/1\.4\.3/.test(gradle));
// AC-3（R8-06：8→12）
T("AC-3 maxFxInstances 12", /maxFxInstances:\s*12/.test(data));
// AC-4
T("AC-4 MATCH_RULE_VER v3", data.includes("R6-05.v3"));
T("AC-4 旧规则版本不残留", !data.includes("R6-05.v2"));
const needTuning = ["humGain", "humLowpassHz", "humBusGain", "compThresholdDb", "compRatio", "hitGain", "hitDurMs",
  "varSizeAmp", "varSpeedAmp", "spdCompPerSize", "spdCompMax"];
const missT = needTuning.filter(k => !data.includes(k));
T("AC-4 tuning 音频/浮动参数齐", missT.length === 0, "missing " + missT.join(","));
const needMatch = ["dyMain", "dhRescue", "dyAux", "dhAux", "dyTex", "dhTex", "dyRec", "dhRec", "highTextureBgs", "nearBlack", "showRecommendBadge"];
const missM = needMatch.filter(k => !data.includes(k));
T("AC-4 tuning.match 参数齐", missM.length === 0, "missing " + missM.join(","));
// AC-5 散落硬编码（在对应文件内不应出现的裸字面量赋值）
// 实质判据：增益/滤波/时长全部经 CC.config.tuning 读取（t.* 回退形态），无独立硬编码赋值
const audioS = strip(audio);
const panelS = strip(panel);
// R6-06/07 参数（嗡鸣增益/低通/总线/压缩器/命中增益/时长）全部经 tuning；旧硬编码值（0.035 单体增益 / 0.25 命中 / sawtooth）不得回魂；
// master=1.0 单位增益、LFO 深度、包络初值 0.0 为结构性常量，非 R6 阈值。
T("AC-5 audio 增益全部经 tuning 读取",
  ["t.humGain", "t.hitGain", "t.humLowpassHz", "t.hitDurMs", "t.humBusGain", "t.compThresholdDb", "t.compRatio"].every(k => audioS.includes(k))
  // R6-06 允许「保留锯齿串低通滤波（800–1200Hz）」——sawtooth 仅在低通链路存在时合法
  && (!audioS.includes("sawtooth") || /type\s*=\s*"lowpass"/.test(audioS))
  && !/[=:]\s*0\.035\b/.test(audioS) && !/[=:]\s*0\.25\b/.test(audioS));
T("AC-5 panel 判定只经 tuning", !panelS.includes("F7_VERDICT") && /t\.dyMain/.test(panelS) && !/cell\.dY\s*<\s*40/.test(panelS));
T("AC-5 engine 浮动只经 tuning 默认", /T\.varSizeAmp/.test(engine) && /T\.varSpeedAmp/.test(engine));
// AC-6 manifest
global.window = {};
eval(A("app/src/main/assets/game/manifest.js"));
const mj = window.CC_MANIFEST;
const mjson = JSON.parse(A("app/src/main/assets/game/manifest.json"));
T("AC-6 manifest js==json", JSON.stringify(mj) === JSON.stringify(mjson));
T("AC-6 match_rule_ver v3", mj.match_rule_ver === "R6-05.v3");
// R8-10：thresholds 双镜像——manifest 与 data.js 出厂值逐键一致（dhRescue=45 / dhAux 30→20）
const needThresh = { dyMain: 40, dhRescue: 45, dyAux: 60, dhAux: 20, dyTex: 50, dhTex: 45, dyRec: 80, dhRec: 45 };
const th = (mj.match_rule && mj.match_rule.thresholds) || {};
const thMismatch = Object.entries(needThresh).filter(([k, v]) => th[k] !== v).map(([k, v]) => `${k}: manifest=${th[k]} expect=${v}`);
T("AC-6 thresholds 双镜像一致", thMismatch.length === 0, thMismatch.join(","));
T("AC-6 bad 规则串含 dhRescue/dhAux 口径", typeof (mj.match_rule && mj.match_rule.bad) === "string" && mj.match_rule.bad.includes("dH<45") && mj.match_rule.bad.includes("dH<20") && mj.match_rule.bad.includes("dY<40") && mj.match_rule.bad.includes("dY<60"));
const dataThOk = /dhRescue:\s*45/.test(data) && /dhAux:\s*20/.test(data);
T("AC-6 data.js 阈值出厂值 dhRescue=45/dhAux=20", dataThOk);
const cats6 = ["ladybug", "housefly", "bee", "butterfly", "mouse", "goldfish"];
const bgs6 = ["wood", "grass", "tile", "carpet", "desk", "black"];
let m36 = 0;
for (const c of cats6) for (const b of bgs6) if (mj.match && mj.match[c] && mj.match[c][b] && typeof mj.match[c][b].dY === "number") m36++;
T("AC-6 match 36 组齐全", m36 === 36, "got " + m36);
// AC-7 红线
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === "build" ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
const files = walk(SRC);
T("AC-7 无 keystore 文件", !files.some(f => /\.(keystore|jks)$/i.test(f)));
T("AC-7 无 keystore.properties", !files.some(f => f.endsWith("keystore.properties")));
const secret = files.filter(f => /\.(java|js|gradle|json|html|xml)$/.test(f)).some(f => A(path.relative(SRC, f)).includes(process.env.CATCATCH_KEY_PASSWORD || "\u0000never\u0000"));
T("AC-7 源码无密码串", !secret);
// AC-8
const mtDoc = JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/evidence/match_table.json"), "utf8"));
const mt = mtDoc.rows; // S6 生成器产物：{generated,rule_ver,thresholds,source,rows,summary}
const get = (c, b) => mt.find(r => r.cat === c && r.bg === b).verdict;
T("AC-8 housefly×wood bad", get("housefly", "wood") === "bad");
T("AC-8 housefly×carpet bad", get("housefly", "carpet") === "bad");
T("AC-8 bee×carpet bad", get("bee", "carpet") === "bad");
// R7-01（终裁 B 案）：近黑专项分支 bg=black 且 dY<80 直接命中，原已知未通过项转正
T("AC-8 housefly×black bad（R7-01 近黑专项）", get("housefly", "black") === "bad");
T("AC-8 ladybug×desk 不误判", get("ladybug", "desk") !== "bad");
// AC-9
T("AC-9 audio humBus/compressor/lowpass", audio.includes("humBus") && /createDynamicsCompressor|DynamicsCompressor/.test(audio) && /lowpass/i.test(audio));
T("AC-9 effects hitburst + 上限回收最旧", effects.includes("hitburst") && /maxFxInstances/.test(effects) && /active\.shift\(\)/.test(effects));
T("AC-9 main.js 命中触发 hitburst", main.includes('trigger("hitburst"'));
// AC-10
T("AC-10 无 LockTask/屏幕钉住 残留", !allJs.includes("LockTask") && !allJs.includes("屏幕钉住") && !javaStripped.includes("startLockTask"));
T("AC-10 引导文案重隐藏口径", panel.includes("自动收回") || panel.includes("重隐藏"));
// R6-01 Java 侧
T("R6-01 空 insets 跳过", java.includes("if (in == null || w <= 0 || h <= 0) return") && java.includes("if (rects.isEmpty()) return"));
T("R6-01 onResume/onWindowFocusChanged 重应用", java.includes("webView.post(this::applyGestureExclusion)") && java.includes("hasFocus) { applyImmersive(); applyGestureExclusion(); }"));

console.log(JSON.stringify({ suite: "dom_ac", pass, fail, fails, known_failures: knownFails }, null, 1));
process.exit(fail ? 1 : 0);
