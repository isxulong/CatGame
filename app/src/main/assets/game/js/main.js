/* main.js — 启动装配 + rAF 主循环 + 原生触摸桥（__nativeTouch）路由。
 * 游戏视图零可交互控件（E6）；触摸判定链：guard（B1/B3/R4）→ 退出手势（R5）→
 * 命中（A4）/受惊（A5）/动效（D5）。注入事件与真实触摸同路径（B2）。
 * R4-07 需求9：长按满 → 直达游戏内快捷设置浮层（CC.quick），验证滑块链路整体移除。 */
window.CC = window.CC || {};

(function () {
  let last = 0;
  const fxLastPoint = new Map(); // D5 滑动触点 ≥48dp 再触发

  function setupCanvases() {
    const bgC = document.getElementById("bg-layer");
    const spC = document.getElementById("sprite-layer");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const wCss = window.innerWidth, hCss = window.innerHeight;
    for (const c of [bgC, spC]) { c.width = wCss * dpr; c.height = hCss * dpr; }
    const insets = safeInsets();
    // dp 基准：CSS px ≈ dp（WebView 默认 viewport）
    if (!CC.engine) {
      CC.engine = new CC.Engine({ bgCanvas: bgC, spriteCanvas: spC, widthDp: wCss, heightDp: hCss, dpr });
    } else {
      // R1 修复：resize 只更新画布尺寸与既有引擎（宽高、重绘背景、重预渲染），
      // 实体 / manifest / sprites / paused 状态全部保留——不再无条件 new Engine 清空游戏
      CC.engine.W = wCss; CC.engine.H = hCss; CC.engine.dpr = dpr;
      CC.engine._paintBg();
      CC.engine.prerender();
    }
    CC.exitGesture.setInsets(insets);
    if (CC.hotzoneMark) CC.hotzoneMark.place(); // R5 角标跟随安全区
    return dpr;
  }

  function safeInsets() {
    try {
      if (window.CatShell) return JSON.parse(CatShell.getSafeInsetsJson());
    } catch (e) {}
    return { left: 0, top: 0, right: 0, bottom: 0, density: 1, testHooks: false };
  }

  /* 原生触摸事件入口（壳 dispatchTouchEvent 推送；含 debug 注入事件，同判定链） */
  window.__nativeTouch = function (ev) {
    // R4-07：面板/引导/快捷浮层打开时游戏侧不响应（守卫扩展，防猫爪穿层触发命中/动效）
    if (CC.panel.isOpen() || CC.guide.isOpen() || (CC.quick && CC.quick.isOpen())) return;
    const i = ev.actionIndex || 0;
    const p = ev.pts[i] || ev.pts[0];
    if (!p) return;

    const verdict = CC.guard.judge(ev);

    // 退出手势链（人类通道）：任何触点都可参与，但 guard 否决（猫掌/第二触点）即中断。
    // F4 按压级否决跟踪：按压会话内任意帧被否决即阻断本次 fire（含时间驱动路径）。
    if (ev.action === 0) CC._hotPressVetoed = false;
    const g = CC.exitGesture.feed(ev);
    if (CC.exitGesture.isTracking() && verdict.vetoed) {
      CC._hotPressVetoed = true;
      // R6 修复：按压中触发面积否决不再静默——进度环变红叉 + 文案提示
      if (verdict.reason === "palm-area") showHoldVeto();
    }
    if (g) {
      if (g.type === "progress") showHoldProgress(g.ratio);
      else if (g.type === "cancel") showHoldCancel(); // R4：取消收缩淡出 + 灰色×
      else if (g.type === "fire" && !verdict.vetoed && !CC._hotPressVetoed) {
        holdPulseThenQuick(); // R4-07：满 100% 150ms 脉冲后直达快捷设置浮层
        return;
      }
    }

    if (ev.action === 0 && ev.count === 1) {
      if (verdict.vetoed) {
        // R4 猫掌：只触动效不判命中
        CC.effects.trigger(CC.config.fxType, p.x, p.y);
        CC.perfLog("guard-veto", { reason: verdict.reason, injected: !!ev.injected });
        return;
      }
      // D5 每次 touch-down 触发一次动效
      CC.effects.trigger(CC.config.fxType, p.x, p.y);
      fxLastPoint.set(p.id, { x: p.x, y: p.y });
      // A4 命中判定
      const hit = CC.engine.hitTest(p.x, p.y);
      if (hit) { CC.engine.onHit(hit); CC.effects.trigger("hitburst", p.x, p.y); CC.hud.refresh(); } // R6-08：拍中爆裂反馈
      else CC.engine.startle(p.x, p.y); // §7 拍空：附近目标受惊远离 1s
    } else if (ev.action === 2) {
      const q = ev.pts.find(t => fxLastPoint.has(t.id));
      if (q) {
        const lp = fxLastPoint.get(q.id);
        if (Math.hypot(q.x - lp.x, q.y - lp.y) >= CC.debug.moveRetriggerDp) {
          CC.effects.trigger(CC.config.fxType, q.x, q.y);
          fxLastPoint.set(q.id, { x: q.x, y: q.y });
        }
      }
    } else if (ev.action === 1 || ev.action === 3 || ev.action === 6) {
      fxLastPoint.delete(p.id);
    }
  };

  /* 长按进度环（视觉反馈，非控件）。
   * R4：DOM conic-gradient + CSS 变量 --p 驱动角度，挂在 100ms 轮询 onProgress 上，
   * 位置跟随 hotZone() insets 定位（兼 R13 安全区偏移）；按下即显 0%。 */
  let holdEl, holdTxt, vetoUntil = 0;
  function ensureHoldRing() {
    if (holdEl) return;
    holdEl = document.createElement("div");
    holdEl.id = "hold-ring";
    holdTxt = document.createElement("div");
    holdTxt.className = "hold-ring-inner";
    holdEl.appendChild(holdTxt);
    document.body.appendChild(holdEl);
  }
  function placeHoldRing() {
    const z = CC.exitGesture.hotZone(); // R13：随 WindowInsets 安全区偏移，不再硬编码 36px
    holdEl.style.left = (z.x0 + 24) + "px";
    holdEl.style.top = (z.y0 + 24) + "px";
  }
  /* R2-15：显式隐藏入口（showHoldProgress(0) 语义已改为「按下同帧显示 0% 环」） */
  function hideHoldProgress() {
    if (!holdEl) return;
    holdEl.style.display = "none";
    holdEl.style.setProperty("--p", 0);
  }
  function showHoldProgress(r) {
    ensureHoldRing();
    // R2-07 修复：面积否决红叉展示期内，100ms 轮询不得覆盖 veto class（原首行 remove 致红叉一闪即没）
    if (performance.now() < vetoUntil) return;
    // R2-15 修复：r=0 也显示并定位（按下同帧即显 0% 环，不再等首轮 100ms 轮询）
    placeHoldRing();
    holdEl.classList.remove("canceling", "veto");
    holdEl.style.setProperty("--p", Math.min(1, r));
    holdTxt.textContent = Math.round(r * 100) + "%";
    holdEl.style.display = "flex";
  }
  /* R4 取消：环收缩淡出 + 灰色× */
  function showHoldCancel() {
    if (!holdEl || holdEl.style.display === "none") return;
    holdEl.classList.remove("veto");
    holdTxt.textContent = "×";
    holdEl.classList.add("canceling");
    setTimeout(() => { holdEl.classList.remove("canceling"); holdEl.style.display = "none"; }, 260);
  }
  /* R6 面积否决提示：进度环变红叉 + 文案「按压力度过大，请轻按」1s 淡出 */
  let vetoToastT = null;
  function showHoldVeto() {
    ensureHoldRing();
    placeHoldRing();
    holdEl.classList.remove("canceling");
    holdEl.classList.add("veto");
    holdEl.style.setProperty("--p", 1);
    holdTxt.textContent = "×";
    holdEl.style.display = "flex";
    vetoUntil = performance.now() + 1000; // R2-07：红叉展示期，轮询进度不得覆盖
    let toast = document.getElementById("hold-veto-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "hold-veto-toast";
      toast.textContent = "按压力度过大，请轻按";
      document.body.appendChild(toast);
    }
    const z = CC.exitGesture.hotZone();
    toast.style.left = (z.x0 + 24) + "px";
    toast.style.top = (z.y0 + 104) + "px";
    toast.style.opacity = "1";
    if (vetoToastT) clearTimeout(vetoToastT);
    vetoToastT = setTimeout(() => {
      toast.style.opacity = "0";
      if (holdEl) { holdEl.classList.remove("veto"); holdEl.style.display = "none"; }
    }, 1000);
  }
  /* R4 满 100%：150ms 脉冲后直达快捷设置浮层（R4-07 需求9：验证滑块移除） */
  function holdPulseThenQuick() {
    showHoldProgress(1);
    holdEl.classList.add("pulse");
    setTimeout(() => {
      holdEl.classList.remove("pulse");
      hideHoldProgress(); // R2-15：显式隐藏（showHoldProgress(0) 语义已变）
      CC.quick.show();
    }, 150);
  }

  /* R5 热区常驻角标：左上角直角括号（两条 12dp 细线、alpha≤0.18、按背景明度自适应低对比、
   * 静态无动画、纯展示不可交互 pointer-events:none，不违反 E6） */
  CC.hotzoneMark = (function () {
    let el;
    function ensure() {
      if (el) return el;
      el = document.createElement("div");
      el.id = "hotzone-mark";
      const h = document.createElement("i"), v = document.createElement("i");
      h.className = "hz-h"; v.className = "hz-v";
      el.appendChild(h); el.appendChild(v);
      document.body.appendChild(el);
      return el;
    }
    return {
      init() { ensure(); this.place(); },
      place() {
        const m = ensure();
        const z = CC.exitGesture.hotZone();
        m.style.left = z.x0 + "px"; m.style.top = z.y0 + "px";
      },
      setBrightness(y) { ensure().classList.toggle("on-light", y >= 128); } // D4 同口径 meanY≥128 判浅底
    };
  })();

  /* R4-07 需求9：B4 验证滑块模块整体移除——长按满直达 CC.quick 快捷设置浮层。
   * 防猫唯一且充分门槛 = touch.js 定点静止长按 3 秒 + 面积否决 + 第二触点否决（千次流 0 突破由该层贡献）。 */

  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    if (!CC.engine.isPaused()) {
      CC.engine.frame(now, dt);
      CC.engine.render(now);
    }
    if (CC.panel.isOpen() && CC.panelPreview()) {
      const pv = CC.panelPreview();
      pv.frame(now, dt); pv.render(now);
      // F3 预览动效实例：update/draw 路由到预览画布 ctx
      if (CC._pvFx) { CC._pvFx.update(dt); CC._pvFx.draw(pv.ctx, pv.dpr); }
    }
    CC.effects.update(dt);
    const ctx = CC.engine.ctx;
    CC.effects.draw(ctx, CC.engine.dpr);
    requestAnimationFrame(loop);
  }
  CC.panelPreview = () => null; // 由 panel.initPreview 挂接

  async function boot() {
    CC.config = CC.store.load("cc_config", CC.DEFAULTS.config);
    CC.debug = CC.store.load("cc_debug", CC.DEFAULTS.debug);
    CC.effects.init();
    setupCanvases();
    await CC.engine.loadManifest();
    CC.hud.init();
    if (CC.hotzoneMark) CC.hotzoneMark.init(); // R5：热区角标随安全区落位
    // F4 时间驱动 fire：与事件路径同处理（按压级否决阻断），不依赖 MOVE 事件流
    CC.exitGesture.onTimeFire = () => {
      // R4-07：守卫同步扩展至快捷浮层（浮层已开时时间驱动 fire 不得重入）
      if (CC.panel.isOpen() || CC.guide.isOpen() || (CC.quick && CC.quick.isOpen())) { hideHoldProgress(); return; }
      if (CC._hotPressVetoed) { hideHoldProgress(); CC.perfLog("exit-timefire-vetoed", {}); return; }
      holdPulseThenQuick(); // R4-07：时间驱动同样 150ms 脉冲 → 快捷设置浮层
    };
    // R4：exitGesture 100ms 轮询 → 进度环 --p
    CC.exitGesture.onProgress = ratio => showHoldProgress(ratio);
    // 面板预览挂接
    CC.panelPreview = () => CC._pvEngine || null;
    // R3 修复：先启动渲染循环再并行加载素材——首帧 / 面板不再等全部图片解码，
    // 加载期由面板预览占位（反馈5 pv-placeholder）兜底；单图失败超时 3s 不再卡死整体（engine.loadImg）
    requestAnimationFrame(loop);
    CC.panel.open(); // 反馈5 / R18：首屏直接打开设置面板（含引导条），替代 guide.maybeShow()
    CC.engine.loadInitial().then(() => {
      CC.engine.prerender();
      CC.engine.syncCount();
      if (CC.panel.assetsReady) CC.panel.assetsReady(); // 反馈5：素材就绪，清占位
    }).catch(err => {
      // R2-10 修复：加载异常不再静默挂起——记 perfLog 并兜底摘占位（原无 catch，异常后面板占位永驻）
      CC.perfLog("loadInitial-fail", { err: String(err && err.message || err) });
      if (CC.panel.assetsReady) CC.panel.assetsReady();
    });
    console.log("[CC] boot ok, testHooks=" + safeInsets().testHooks);
  }

  // R1：resize 只走 setupCanvases（其内部已含 _paintBg/prerender 与引擎保持分支）
  // R2-11 修复：面板打开时同步重设预览画布（原预览画布不更新，视口变化后预览拉伸变形）
  window.addEventListener("resize", () => {
    setupCanvases();
    if (CC.panel.isOpen() && CC.panel.resizePreview) CC.panel.resizePreview();
  });
  document.addEventListener("DOMContentLoaded", boot);
})();
