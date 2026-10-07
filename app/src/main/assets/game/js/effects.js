/* effects.js — R4/D3/D4/D5 触摸动效：涟漪/爪印/星星/粒子。
 * 约束：粒子只用预渲染小图、禁 shadowBlur、单效果 ≤50 粒、对象池；
 * 配色按背景明度自适应亮/暗双色板（D4 一次到位）；
 * 节流：down 一次 / 移动 ≥48dp / 同屏实例 ≤5（D5）。
 * F3(v1.1)：单例改工厂 CC.createEffects()——主画布用默认实例 CC.effects，
 * 设置面板预览视窗跑独立轻量实例（CC._pvFx），draw(ctx,dpr) 按目标 ctx 路由，
 * 修复预览演示渲染到被遮挡主画布、面板内不可见的问题。 */
window.CC = window.CC || {};

CC.createEffects = function () {
  const POOL_MAX = 64;
  const pool = [];
  const active = [];
  let starImg = null, dotImg = null, pawImg = null;
  let starDarkImg = null, dotDarkImg = null, pawDarkImg = null; // R7 浅底预渲染暗色变体
  let palette = "dark"; // dark=深底上用亮色动效；light=浅底用深色动效

  function makeStar(fill) {
    const c = document.createElement("canvas"); c.width = c.height = 32;
    const g = c.getContext("2d");
    g.translate(16, 16); g.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 14 : 6, a = -Math.PI / 2 + i * Math.PI / 5;
      g[i ? "lineTo" : "moveTo"](Math.cos(a) * r, Math.sin(a) * r);
    }
    g.closePath(); g.fillStyle = fill; g.fill();
    return c;
  }
  function makeDot(rgb) {
    const c = document.createElement("canvas"); c.width = c.height = 16;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(8, 8, 0, 8, 8, 8);
    grad.addColorStop(0, "rgba(" + rgb + ",1)"); grad.addColorStop(1, "rgba(" + rgb + ",0)");
    g.fillStyle = grad; g.fillRect(0, 0, 16, 16);
    return c;
  }
  function makePaw(fill) {
    // 标准猫爪：4 趾 + 掌垫，整体 ~40dp 基准（按 40px 画，绘制时按 dp 缩放）
    const c = document.createElement("canvas"); c.width = c.height = 48;
    const g = c.getContext("2d"); g.fillStyle = fill;
    const toe = (x, y) => { g.beginPath(); g.ellipse(x, y, 5.5, 7, 0, 0, 7); g.fill(); };
    toe(10, 14); toe(19, 9); toe(29, 9); toe(38, 14);
    g.beginPath(); g.ellipse(24, 32, 12, 9.5, 0, 0, 7); g.fill();
    return c;
  }

  function init() {
    starImg = makeStar("#fff"); dotImg = makeDot("255,255,255"); pawImg = makePaw("#fff");
    // R7：浅底暗色变体（≈ invert 后的暗点/暗形），不依赖 ctx.filter，旧 WebView 同样可辨
    starDarkImg = makeStar("#2a3c96"); dotDarkImg = makeDot("20,20,40"); pawDarkImg = makePaw("#262626");
  }

  function setPaletteByBgMeanY(y) { palette = y >= 128 ? "light" : "dark"; }
  function colors() {
    return palette === "dark"
      ? { main: "rgba(255,236,140,", accent: "rgba(255,255,255," }
      : { main: "rgba(40,60,180,", accent: "rgba(20,20,20," };
  }

  function obtain(type, x, y) {
    let p = pool.pop();
    if (!p) p = { parts: [] };
    p.type = type; p.x = x; p.y = y; p.t = 0; p.parts.length = 0;
    if (type === "stars") {
      const n = 5 + Math.floor(Math.random() * 4); // D3 5–8 颗
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, v = 120 + Math.random() * 160;
        p.parts.push({ dx: Math.cos(a) * v, dy: Math.sin(a) * v - 120, s: 0.5 + Math.random() * 0.7, rot: Math.random() * 6.28 });
      }
    } else if (type === "particles") {
      const cap = CC.engine ? CC.engine.particleCap() : 50;
      const n = Math.min(50, cap, 24 + Math.floor(Math.random() * 27)); // ≤50 粒
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, v = 80 + Math.random() * 260;
        p.parts.push({ dx: Math.cos(a) * v, dy: Math.sin(a) * v, s: 4 + Math.random() * 3 }); // R6-08：4–7dp
      }
    } else if (type === "hitburst") {
      // R6-08：命中爆裂——扩环 + 一圈迸溅粒子（拍中反馈，与触摸涟漪区分）
      const n = 10 + Math.floor(Math.random() * 5); // 10–14 粒
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.4, v = 140 + Math.random() * 180;
        p.parts.push({ dx: Math.cos(a) * v, dy: Math.sin(a) * v, s: 4 + Math.random() * 3 });
      }
    }
    return p;
  }

  /* D5 节流：同屏实例上限（R6-08/裁决7：5 → 8）；
   * R6-08：超限不再丢弃新触发——回收最旧实例给新触发让位（recycle-oldest） */
  function trigger(type, xDp, yDp) {
    if (!CC.config.fxOn) return;
    if (active.length >= CC.debug.maxFxInstances) {
      const old = active.shift();
      old.parts.length = 0; pool.push(old);
    }
    active.push(obtain(type, xDp, yDp));
  }

  function update(dt) {
    for (let i = active.length - 1; i >= 0; i--) {
      const p = active[i]; p.t += dt;
      const life = p.type === "hitburst" ? 0.4 : 0.8; // R4 单次 ≤0.8s；R6-08 hitburst 0.4s 短促反馈
      if (p.t >= life) { p.parts.length = 0; pool.push(p); active.splice(i, 1); }
    }
  }

  function draw(ctx, dpr) {
    const col = colors();
    for (const p of active) {
      const x = p.x * dpr, y = p.y * dpr, t = p.t;
      if (p.type === "ripple") {
        // R6-08：双环扩散加强——线宽 2→4dp、最大半径 96→140dp、透明度 0.6→0.9，附内圈淡填充
        for (let k = 0; k < 2; k++) {
          const tt = Math.min(1, Math.max(0, t / 0.8 - k * 0.18));
          if (tt <= 0) continue;
          ctx.fillStyle = col.main + (0.12 * (1 - tt)) + ")"; // R6-08：内圈填充（淡）
          ctx.beginPath(); ctx.arc(x, y, tt * 140 * dpr, 0, 7); ctx.fill();
          ctx.strokeStyle = col.main + (0.9 * (1 - tt)) + ")";
          ctx.lineWidth = 4 * dpr;
          ctx.beginPath(); ctx.arc(x, y, tt * 140 * dpr, 0, 7); ctx.stroke();
        }
      } else if (p.type === "hitburst") {
        // R6-08：命中爆裂——扩环 + 迸溅粒子，0.4s 收口
        const tt = Math.min(1, t / 0.4);
        ctx.strokeStyle = col.accent + (0.9 * (1 - tt)) + ")";
        ctx.lineWidth = 3 * dpr;
        ctx.beginPath(); ctx.arc(x, y, (8 + tt * 52) * dpr, 0, 7); ctx.stroke();
        const additive = palette === "dark";
        ctx.globalCompositeOperation = additive ? "lighter" : "source-over";
        const img = additive ? dotImg : dotDarkImg;
        for (const s of p.parts) {
          const px = x + s.dx * t * dpr, py = y + (s.dy * t + 160 * t * t) * dpr;
          const a = Math.max(0, 1 - t / 0.38);
          const sz = s.s * dpr;
          ctx.globalAlpha = a * 0.9;
          ctx.drawImage(img, px - sz / 2, py - sz / 2, sz, sz);
        }
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
      } else if (p.type === "paw") {
        // D3 0.3s 淡入 0.5s 淡出，整体 ~48dp（R6-08：40 → 48dp 加强可辨度）
        const a = t < 0.3 ? t / 0.3 : Math.max(0, 1 - (t - 0.3) / 0.5);
        const s = 48 * dpr / 48;
        ctx.globalAlpha = a * 0.85;
        // R7：浅底——有 ctx.filter 用 invert，旧 WebView（<52）回退预渲染暗爪印
        if (palette !== "dark" && !("filter" in ctx)) ctx.drawImage(pawDarkImg, x - 24 * s, y - 24 * s, 48 * s, 48 * s);
        else {
          ctx.filter = palette === "dark" ? "none" : "invert(0.85)";
          ctx.drawImage(pawImg, x - 24 * s, y - 24 * s, 48 * s, 48 * s);
          ctx.filter = "none";
        }
        ctx.globalAlpha = 1;
      } else if (p.type === "stars") {
        for (const s of p.parts) {
          const px = x + s.dx * t * dpr, py = y + (s.dy * t + 320 * t * t) * dpr; // 重力下坠
          const a = Math.max(0, 1 - t / 0.8);
          const sz = 26 * s.s * dpr * (1 - t * 0.4); // R6-08：星形 22 → 26dp；（F3c 已修复循环变量 s 遮蔽部件缩放字段的 NaN 问题）
          ctx.save(); ctx.translate(px, py); ctx.rotate(s.rot + t * 5);
          ctx.globalAlpha = a;
          // R7：浅底无 ctx.filter 时回退预渲染暗星
          if (palette !== "dark" && !("filter" in ctx)) ctx.drawImage(starDarkImg, -sz / 2, -sz / 2, sz, sz);
          else {
            ctx.filter = palette === "dark" ? "sepia(1) saturate(6) hue-rotate(5deg)" : "invert(0.7) sepia(1) saturate(4)";
            ctx.drawImage(starImg, -sz / 2, -sz / 2, sz, sz);
            ctx.filter = "none";
          }
          ctx.restore();
        }
        ctx.globalAlpha = 1;
      } else if (p.type === "particles") {
        // R7 修复：浅底加法混合只能提亮、暗点≈没画——改 source-over 直接画预渲染暗点；
        // 深底保持 lighter 加法混合。不再依赖 ctx.filter，旧 WebView 天然兼容
        const additive = palette === "dark";
        ctx.globalCompositeOperation = additive ? "lighter" : "source-over";
        const img = additive ? dotImg : dotDarkImg;
        for (const s of p.parts) {
          const px = x + s.dx * t * dpr, py = y + (s.dy * t + 200 * t * t) * dpr;
          const a = Math.max(0, 1 - t / 0.7);
          const sz = s.s * dpr;
          ctx.globalAlpha = a * 0.9;
          ctx.drawImage(img, px - sz / 2, py - sz / 2, sz, sz);
        }
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
      }
    }
  }

  return { init, trigger, update, draw, setPaletteByBgMeanY,
    stats: () => ({ active: active.length, pooled: pool.length, palette }) };
};

/* 默认实例：主画布动效（游戏视图触摸反馈） */
CC.effects = CC.createEffects();
