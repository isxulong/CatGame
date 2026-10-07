#!/usr/bin/env node
/* R7-01 验收 #2：面板运行时 cellVerdict（panel.js 原函数源码，Node vm 加载）× 36 组
 * 对照离线枚举表 match_table.json —— 须 36/36 一致。
 * 同时输出验收 #3 关键组：housefly×black 与 housefly×wood 同为 bad（同款红标渲染路径）。 */
const fs = require("fs"), path = require("path"), vm = require("vm");
const SRC = path.join(__dirname, "../src");
const ctx = vm.createContext({ localStorage: { getItem: () => null, setItem: () => {} }, console });
vm.runInContext("var window = this;", ctx); // 浏览器语义：window.CC= 即全局 CC
vm.runInContext(fs.readFileSync(path.join(SRC, "app/src/main/assets/game/js/data.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(SRC, "app/src/main/assets/game/manifest.js"), "utf8"), ctx);
const CC = ctx.window.CC;
CC.config = JSON.parse(JSON.stringify(CC.DEFAULTS.config)); // 出厂配置（tuning 默认）
CC.engine = { manifest: ctx.window.CC_MANIFEST };
// 原样抽取 panel.js 的 cellVerdict 函数源码执行（与运行时同一实现）
const panelSrc = fs.readFileSync(path.join(SRC, "app/src/main/assets/game/js/panel.js"), "utf8");
const m = panelSrc.match(/function cellVerdict\(cat, bgName\) \{[\s\S]*?\n  \}/);
if (!m) { console.error("cellVerdict 提取失败"); process.exit(2); }
const cellVerdict = vm.runInContext("(function(){ const CC = arguments[0]; return " + m[0] + " })", ctx)(CC);

const mt = JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/evidence/match_table.json"), "utf8"));
let same = 0; const diffs = [];
for (const r of mt) {
  const v = cellVerdict(r.cat, r.bg);
  // showRecommendBadge 默认关：离线表 rec 档与运行时 ok 同为「不挂标」——按徽标档位归一化比较
  const badge = v === "bad" ? "bad" : "ok";            // 运行时实际挂标档位（绿标关）
  const off = r.verdict === "bad" ? "bad" : "ok";      // 离线表同口径归一（rec/ok 均不挂标）
  const sameBadge = badge === off;
  if (sameBadge) same++; else diffs.push(`${r.cat}×${r.bg}: runtime=${badge} offline=${r.verdict}`);
}
const out = {
  suite: "match_runtime_vs_offline", rule_ver: CC.MATCH_RULE_VER,
  groups: mt.length, consistent: same, inconsistent: diffs,
  accept3_housefly_black: cellVerdict("housefly", "black"),
  accept3_housefly_wood: cellVerdict("housefly", "wood"),
  accept1_bee_wood: cellVerdict("bee", "wood"),
  pass: same === mt.length && diffs.length === 0 &&
        cellVerdict("housefly", "black") === "bad" && cellVerdict("housefly", "wood") === "bad" &&
        cellVerdict("bee", "wood") !== "bad"
};
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
