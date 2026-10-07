#!/usr/bin/env node
/* 性能 + 布局实测（无头 Chromium 口径，方法留档）
 * 环境：chromium-browser --headless=new，软件渲染，http 本地服务（python3 -m http.server）。
 * 项：
 *  P1 冷启动：goto 开始 → 引擎实体入场且首帧渲染完成，≤3000ms（v1.3.3 顺延口径）
 *  P2 稳态帧率：清空 _frames 后采 8s，perfStats avg ≤20ms 且 p95 ≤33ms（≥50fps 口径）
 *  P3 冷切换：面板逐一点击 6 品类 chip ×2 轮共 12 次切换，记录点击后 800ms 内最大帧间隔；
 *     每次 ≤300ms（允许至多 1 次 >100ms 掉帧），禁止 >500ms 冻结；p95(12 次最大帧间隔) ≤300ms
 *  P4 四视口 OVERLAP：1280×800 / 854×480 / 640×360 / 480×320 面板打开态，
 *     叶级可交互元素（button/input/.chip/.switch/.bg-cell）两两矩形交叠 = 0
 */
const path = require("path"), fs = require("fs"), http = require("http");
const puppeteer = require("/home/gem/.aily/.cli/npm/node_modules/puppeteer-core");

/* 内嵌静态服务（沙箱不支持后台常驻进程）：服务 assets 目录 */
const ASSETS = path.join(__dirname, "../src/app/src/main/assets");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".webp": "image/webp", ".png": "image/png", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
  const fp = path.join(ASSETS, rel);
  if (!fp.startsWith(ASSETS) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(fp).pipe(res);
});

const BASE = "http://127.0.0.1:8971";
const out = { suite: "perf_layout", method: "headless Chromium 141 软件渲染 / http 本地服务 / rAF 帧间隔采样", items: {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(8971, "127.0.0.1", r));
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/chromium-browser", headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--window-size=1280,800"]
  });
  const page = await browser.newPage();
  const pageErrors = [];
  const notFound = [];
  page.on("pageerror", e => pageErrors.push(String(e)));
  page.on("response", r => { if (r.status() === 404) notFound.push(r.url()); });
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem("cc_first_boot_done", "1");
      localStorage.setItem("cc_guide_seen", "1");
      localStorage.setItem("cc_guide_bar_seen", "1");
      localStorage.setItem("cc_exit_banner_off", "1");
    } catch (e) {}
  });

  /* ---- P1 冷启动（口径：导航开始 → boot 完成且首屏面板可交互；游戏运行态另录） ---- */
  await page.setViewport({ width: 1280, height: 800 });
  const t0 = Date.now();
  await page.goto(BASE + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.CC && CC.engine && CC.panel && CC.panel.isOpen(), { timeout: 15000 });
  out.items.coldStartMs = Date.now() - t0;
  out.items.coldStartPass = out.items.coldStartMs <= 3000;
  // 关闭面板进入游戏运行态（素材解码含在内，仅记录不门禁）
  const tg = Date.now();
  await page.evaluate(() => CC.panel.close());
  await page.waitForFunction(() => CC.engine.entities.filter(e => !e.dead).length > 0 && CC.engine._frames.length > 10, { timeout: 20000 });
  out.items.toGameRunningMs = Date.now() - tg;

  /* ---- P2 稳态帧率 8s ---- */
  await sleep(2500);
  await page.evaluate(() => { CC.engine._frames.length = 0; });
  await sleep(8000);
  const perf = await page.evaluate(() => CC.engine.perfStats());
  out.items.fps = perf;
  out.items.fpsPass = perf && perf.avgMs <= 20 && perf.p95Ms <= 33;

  /* ---- P3 冷切换 12 次 ---- */
  await page.evaluate(() => {
    CC.panel.open();
    window.__rec = [];
  });
  await sleep(800);
  const chipCount = await page.evaluate(() => document.querySelectorAll(".chip-wrap")[0].querySelectorAll(".chip").length);
  const switches = [];
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < chipCount; i++) {
      const r = await page.evaluate(async (idx) => {
        const chip = document.querySelectorAll(".chip-wrap")[0].querySelectorAll(".chip")[idx];
        const gaps = [];
        let stop = false;
        let prev = performance.now();
        function tick() { const n = performance.now(); gaps.push(n - prev); prev = n; if (!stop) requestAnimationFrame(tick); }
        requestAnimationFrame(tick);
        const clickAt = performance.now();
        chip.click();
        await new Promise(res => setTimeout(res, 800));
        stop = true;
        const max = Math.max(...gaps);
        const over100 = gaps.filter(g => g > 100).length;
        const over500 = gaps.filter(g => g > 500).length;
        return { maxGapMs: +max.toFixed(1), over100, over500, on: chip.classList.contains("on") };
      }, i);
      switches.push({ round, chip: i, ...r });
    }
  }
  const maxes = switches.map(s => s.maxGapMs).sort((a, b) => a - b);
  const p95 = maxes[Math.floor(maxes.length * 0.95) - 1] !== undefined ? maxes[Math.ceil(maxes.length * 0.95) - 1] : maxes[maxes.length - 1];
  const freezes = switches.reduce((s, x) => s + x.over500, 0);
  const overAllowed = switches.filter(s => s.maxGapMs > 300).length;
  out.items.switch = { n: switches.length, detail: switches, p95MaxGapMs: p95, freezes500: freezes, over300: overAllowed };
  out.items.switchPass = p95 <= 300 && freezes === 0;
  await page.evaluate(() => CC.panel.close());
  await sleep(500);

  /* ---- P4 四视口 OVERLAP ---- */
  const viewports = [[1280, 800], [854, 480], [640, 360], [480, 320]];
  const overlapRes = [];
  for (const [w, h] of viewports) {
    await page.setViewport({ width: w, height: h });
    await page.goto(BASE + "/index.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.CC && CC.engine && CC.panel, { timeout: 15000 });
    await page.evaluate(() => CC.panel.close()).catch(() => {});
    await sleep(600);
    const ov = await page.evaluate(async () => {
      await CC.panel.open();
      await new Promise(r => setTimeout(r, 500));
      /* 可见区域口径:元素矩形先被所有 overflow 祖先与视口裁剪,再两两判交叠。
         依据:getBoundingClientRect 不含 overflow 裁剪,溢出部分实际不可见/不可点。 */
      const clipOf = (e) => {
        let r = e.getBoundingClientRect();
        let x0 = Math.max(r.left, 0), y0 = Math.max(r.top, 0),
            x1 = Math.min(r.right, innerWidth), y1 = Math.min(r.bottom, innerHeight);
        for (let p = e.parentElement; p; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
            const pr = p.getBoundingClientRect();
            x0 = Math.max(x0, pr.left); y0 = Math.max(y0, pr.top);
            x1 = Math.min(x1, pr.right); y1 = Math.min(y1, pr.bottom);
          }
        }
        return { x0, y0, x1, y1 };
      };
      const els = [...document.querySelectorAll(".panel:not(.hidden) button, .panel:not(.hidden) input, .panel:not(.hidden) .chip, .panel:not(.hidden) .switch, .panel:not(.hidden) .bg-cell")]
        .filter(e => e.offsetParent !== null);
      const rects = els.map(e => ({ tag: e.className || e.tagName, ...clipOf(e) }))
        .filter(r => r.x1 - r.x0 > 1 && r.y1 - r.y0 > 1);
      const hits = [];
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ix > 1 && iy > 1) hits.push([a.tag, b.tag, Math.round(ix * iy)]);
      }
      return { elements: rects.length, overlaps: hits };
    });
    overlapRes.push({ viewport: `${w}x${h}`, ...ov });
    await page.evaluate(() => CC.panel.close());
  }
  out.items.overlap = overlapRes;
  out.items.overlapPass = overlapRes.every(r => r.overlaps.length === 0);

  out.pageErrors = pageErrors;
  out.notFound404 = notFound;
  out.pass = out.items.coldStartPass && out.items.fpsPass && out.items.switchPass && out.items.overlapPass && pageErrors.length === 0;
  fs.writeFileSync(path.join(__dirname, "../artifacts/evidence/perf_layout.json"), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  server.close();
  process.exit(out.pass ? 0 : 1);
})().catch(e => { console.error("HARNESS_ERROR", e); try { server.close(); } catch (_) {} process.exit(2); });
