#!/usr/bin/env node
/* R8-11/S4（v1.4.4）：面板运行时判定（panel.js 原函数源码，Node vm 加载）× 36 组
 * 对照离线枚举表 match_table.json —— 须 36/36 一致（bad 15 / 翻档 8 组零反向）。
 * 既有 3 条断言（R8-11：裁判已核 v3 复算保持成立）重跑确认：
 *   housefly×black=bad、housefly×wood=bad、bee×wood≠bad。
 * 新增断言：
 *   ① 翻档 8 组（R8 第八章 4.1）运行时全部 ≠bad（防回退）；
 *   ② bgVerdict ALL-bad 聚合同径（R8-09）：全选 6 类仅地毯挂红标；
 *      63 种非空选法枚举 0 种全背景红标、挂标分布 挂1=42/挂2=17/挂3=4、任一选法最多挂 3/6；
 *      单选 6 类逐类 ALL=ANY 等价（零回归）。
 * 注意：bgVerdict 内部调用 cellVerdict，两函数必须组合抽取（同一 CC 闭包）。 */
const fs = require("fs"), path = require("path"), vm = require("vm");
const SRC = path.join(__dirname, "../src");
const ctx = vm.createContext({ localStorage: { getItem: () => null, setItem: () => {} }, console });
vm.runInContext("var window = this;", ctx); // 浏览器语义：window.CC= 即全局 CC
vm.runInContext(fs.readFileSync(path.join(SRC, "app/src/main/assets/game/js/data.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(SRC, "app/src/main/assets/game/manifest.js"), "utf8"), ctx);
const CC = ctx.window.CC;
CC.config = JSON.parse(JSON.stringify(CC.DEFAULTS.config)); // 出厂配置（tuning 默认）
CC.engine = { manifest: ctx.window.CC_MANIFEST };

// 原样抽取 panel.js 的 cellVerdict + bgVerdict 函数源码执行（与运行时同一实现；组合闭包）
const panelSrc = fs.readFileSync(path.join(SRC, "app/src/main/assets/game/js/panel.js"), "utf8");
const mCell = panelSrc.match(/function cellVerdict\(cat, bgName\) \{[\s\S]*?\n  \}/);
const mBg = panelSrc.match(/function bgVerdict\(bgName\) \{[\s\S]*?\n  \}/);
if (!mCell || !mBg) { console.error("cellVerdict/bgVerdict 提取失败"); process.exit(2); }
const verdicts = vm.runInContext("(function(){ const CC = arguments[0]; " + mCell[0] + " " + mBg[0] + " return { cellVerdict: cellVerdict, bgVerdict: bgVerdict }; })", ctx)(CC);
const cellVerdict = verdicts.cellVerdict, bgVerdict = verdicts.bgVerdict;

const mtDoc = JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/evidence/match_table.json"), "utf8"));
const mt = mtDoc.rows;
let same = 0; const diffs = [];
let keepBad = 0;
for (const r of mt) {
  const v = cellVerdict(r.cat, r.bg);
  // showRecommendBadge 默认关：离线表 rec 档与运行时 ok 同为「不挂标」——按徽标档位归一化比较
  const badge = v === "bad" ? "bad" : "ok";            // 运行时实际挂标档位（绿标关）
  const off = r.verdict === "bad" ? "bad" : "ok";      // 离线表同口径归一（rec/ok 均不挂标）
  if (badge === off) same++; else diffs.push(`${r.cat}×${r.bg}: runtime=${badge} offline=${r.verdict}`);
  if (r.verdict === "bad" && v === "bad") keepBad++;
}

/* 翻档 8 组（R8 第四章 4.1 基线）：v3 下全部 ≠bad（零反向翻档由 36/36 中 bad 15 组保持共同保证） */
const FLIP8 = [["bee", "grass"], ["housefly", "grass"], ["butterfly", "tile"], ["mouse", "grass"],
               ["mouse", "tile"], ["mouse", "desk"], ["goldfish", "grass"], ["goldfish", "tile"]];
const flip8 = FLIP8.map(([c, b]) => ({ cell: `${c}×${b}`, runtime: cellVerdict(c, b) }));
const flip8Ok = flip8.every(r => r.runtime !== "bad");

/* bgVerdict ALL-bad 聚合（R8-09）：选法枚举 */
const CATS = ["ladybug", "housefly", "bee", "butterfly", "mouse", "goldfish"];
const BGS = ["wood", "grass", "tile", "carpet", "desk", "black"];
function badgesOf(catsSel) {
  CC.config.cats = catsSel;
  const out = {};
  for (const b of BGS) out[b] = bgVerdict(b);
  return out;
}
// 全选 6 类：仅地毯挂红标（4.2 预期表）
CC.config.cats = CATS.slice();
const full6 = {}; let full6Bad = 0;
for (const b of BGS) { full6[b] = bgVerdict(b); if (full6[b] === "bad") full6Bad++; }
const full6OnlyCarpet = full6Bad === 1 && full6.carpet === "bad";
// 63 种非空选法：0 种全背景红标；挂标数分布 挂1=42 / 挂2=17 / 挂3=4；最多挂 3/6
const dist = { 1: 0, 2: 0, 3: 0 };
let allRedSubsets = 0, maxBad = 0, subsets = 0;
for (let mask = 1; mask < 64; mask++) {
  const sel = CATS.filter((_, k) => mask & (1 << k));
  const bd = badgesOf(sel);
  const nBad = BGS.filter(b => bd[b] === "bad").length;
  subsets++;
  if (nBad === 6) allRedSubsets++;
  if (nBad > 0) dist[nBad]++;
  if (nBad > maxBad) maxBad = nBad;
}
const subsetsOk = subsets === 63 && allRedSubsets === 0 && dist[1] === 42 && dist[2] === 17 && dist[3] === 4 && maxBad === 3;
// 单选 6 类逐类：ALL=ANY 等价（bgVerdict 与 cellVerdict 逐背景一致，零回归）
const singleEq = CATS.map(c => {
  const bd = badgesOf([c]);
  const mismatch = BGS.filter(b => (bd[b] === "bad") !== (cellVerdict(c, b) === "bad"));
  return { cat: c, mismatches: mismatch.length };
});
const singleEqOk = singleEq.every(r => r.mismatches === 0);

const out = {
  suite: "match_runtime_vs_offline", rule_ver: CC.MATCH_RULE_VER,
  groups: mt.length, consistent: same, inconsistent: diffs, keep_bad_groups: keepBad,
  accept3_housefly_black: cellVerdict("housefly", "black"),
  accept3_housefly_wood: cellVerdict("housefly", "wood"),
  accept1_bee_wood: cellVerdict("bee", "wood"),
  flip8: { groups: flip8, all_not_bad: flip8Ok },
  bg_all_bad: {
    full6: full6, full6_only_carpet: full6OnlyCarpet,
    subsets63: { total: subsets, all_red: allRedSubsets, dist, max_bad_bgs: maxBad, ok: subsetsOk },
    single_select_all_eq_any: { per_cat: singleEq, ok: singleEqOk }
  },
  pass: same === mt.length && diffs.length === 0 && keepBad === 15 &&
        cellVerdict("housefly", "black") === "bad" && cellVerdict("housefly", "wood") === "bad" &&
        cellVerdict("bee", "wood") !== "bad" &&
        flip8Ok && full6OnlyCarpet && subsetsOk && singleEqOk
};
const EVID = path.join(__dirname, "../artifacts/evidence");
fs.mkdirSync(EVID, { recursive: true });
fs.writeFileSync(path.join(EVID, "match_runtime_check.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
