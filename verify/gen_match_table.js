#!/usr/bin/env node
/* gen_match_table.js — R8-10/S6：离线枚举生成器（本轮入库，v1.4.3 未随源码包分发）
 * 输入：manifest.json 36 组实测字段（dY/dH/tex，测量值不随规则版本变化）+ data.js 出厂阈值（单一来源）。
 * 规则：R6-05.v3 —— bad 任一命中：① dY<dyMain 且 dH<dhRescue（色度救援）；② dY<dyAux 且 dH<dhAux(20°)；
 *       ③ tex 且 dY<dyTex 且 dH<dhTex；④ bg ∈ nearBlack.bgs 且 dY<nearBlack.dyMax（R7-01 终裁不动，不受救援）。
 *       rec：dY≥dyRec 且 dH≥dhRec。其余中性。
 * 阈值读取：用 vm 加载 data.js 取 CC.DEFAULTS.config.tuning.match —— 与运行时同一出厂值，避免双维护。
 * 输出：artifacts/evidence/match_table.json —— 36 行 {cat,bg,dY,dH,tex,verdict} + 元数据（规则版本/阈值/生成时间）。
 * 消费方：verify/match_runtime_check.js（运行时 cellVerdict/bgVerdict 对照）、verify/harness_static.js AC-8。 */
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
const GAME = path.join(ROOT, "src/app/src/main/assets/game");

/* 与运行时同一份出厂阈值（vm 加载真实 data.js） */
const ctx = vm.createContext({ localStorage: { getItem: () => null, setItem: () => {} }, console });
vm.runInContext("var window = this;", ctx);
vm.runInContext(fs.readFileSync(path.join(GAME, "js/data.js"), "utf8"), ctx);
const CC = ctx.window.CC;
if (CC.MATCH_RULE_VER !== "R6-05.v3") { console.error("规则版本异常: " + CC.MATCH_RULE_VER); process.exit(2); }
const t = CC.DEFAULTS.config.tuning.match;

const manifest = JSON.parse(fs.readFileSync(path.join(GAME, "manifest.json"), "utf8"));
const cats = ["ladybug", "housefly", "bee", "butterfly", "mouse", "goldfish"];
const bgs = ["wood", "grass", "tile", "carpet", "desk", "black"];

function verdictOf(cat, bg) {
  const c = manifest.match[cat][bg];
  const nb = t.nearBlack || {};
  if (c.dY < t.dyMain && c.dH < t.dhRescue) return "bad";                    // ① 主分支 + 色度救援
  if (c.dY < t.dyAux && c.dH < t.dhAux) return "bad";                        // ② 同色系收窄（dhAux=20）
  if (c.tex && c.dY < t.dyTex && c.dH < t.dhTex) return "bad";               // ③ 高纹理
  if ((nb.bgs || []).includes(bg) && c.dY < nb.dyMax) return "bad";          // ④ 近黑（不受救援）
  if (c.dY >= t.dyRec && c.dH >= t.dhRec) return "rec";
  return "ok";
}

const rows = [];
for (const cat of cats) for (const bg of bgs) {
  const c = manifest.match[cat][bg];
  rows.push({ cat, bg, dY: c.dY, dH: c.dH, tex: !!c.tex, verdict: verdictOf(cat, bg) });
}
const bad = rows.filter(r => r.verdict === "bad").length;
const rec = rows.filter(r => r.verdict === "rec").length;

/* 自检：R8 第四章 4.1 基线 —— bad 15 / rec 2 / 翻档 8 组零反向 */
const FLIP = [["bee", "grass"], ["housefly", "grass"], ["butterfly", "tile"], ["mouse", "grass"],
              ["mouse", "tile"], ["mouse", "desk"], ["goldfish", "grass"], ["goldfish", "tile"]];
const KEEP_BAD = [["ladybug", "carpet"], ["ladybug", "black"], ["housefly", "wood"], ["housefly", "carpet"],
                  ["housefly", "black"], ["bee", "carpet"], ["bee", "black"], ["butterfly", "wood"],
                  ["butterfly", "carpet"], ["butterfly", "desk"], ["mouse", "wood"], ["mouse", "carpet"],
                  ["goldfish", "wood"], ["goldfish", "carpet"], ["goldfish", "desk"]];
const v = (c, b) => rows.find(r => r.cat === c && r.bg === b).verdict;
const problems = [];
if (bad !== 15) problems.push("bad=" + bad + " 期望 15");
if (rec !== 2) problems.push("rec=" + rec + " 期望 2");
for (const [c, b] of FLIP) if (v(c, b) === "bad") problems.push(`翻档组 ${c}×${b} 仍 bad`);
for (const [c, b] of KEEP_BAD) if (v(c, b) !== "bad") problems.push(`保留组 ${c}×${b} 非 bad`);

const out = {
  generated: new Date().toISOString().slice(0, 10),
  rule_ver: CC.MATCH_RULE_VER,
  thresholds: { dyMain: t.dyMain, dhRescue: t.dhRescue, dyAux: t.dyAux, dhAux: t.dhAux,
                dyTex: t.dyTex, dhTex: t.dhTex, dyRec: t.dyRec, dhRec: t.dhRec,
                nearBlack: t.nearBlack, highTextureBgs: t.highTextureBgs },
  source: "manifest.json match 表实测字段（测量值不随规则版本变化）",
  rows,
  summary: { total: rows.length, bad, rec, ok: rows.length - bad - rec }
};
const outPath = path.join(ROOT, "artifacts/evidence/match_table.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ suite: "gen_match_table", out: outPath, ...out.summary, baseline_problems: problems }, null, 1));
process.exit(problems.length ? 1 : 0);
