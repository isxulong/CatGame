/* panel.js — 设置面板（C1/C2/C3）+ 首次引导层（B5，沿用 C1 规范）+ 操作说明 + 隐藏调试档。
 * C1 横屏全屏模态；触控目标 ≥48dp；滑块 0.25 步进吸附+数字实时回显+一键重置；
 * 背景 2×3 缩略图网格、选中 2dp 描边、「不推荐」角标；固定高对比中性配色（≥4.5:1）；
 * 验证滑块与调节滑块视觉明确区分；主按钮实色、退出 App 危险次级+二次确认。
 * C2 空闲 60s 自动保存返回（可调）；保存语义=面板状态即真值（任何离开路径都保存）。
 * C3 预览区=实时渲染迷你游戏视窗（16:9，同一引擎与参数源）。 */
window.CC = window.CC || {};

CC.panel = (function () {
  let root, previewEngine, idleTimer = null, debugOpen = false, titleTapN = 0, titleTapT = 0;
  const syncers = []; // R5-02：真值→DOM 回刷闭包注册表，open() 复用 DOM 时统一执行

  const $ = sel => root.querySelector(sel);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };

  function save() { CC.store.save("cc_config", CC.config); }
  function saveDebug() { CC.store.save("cc_debug", CC.debug); }

  /* R6-02 P1-2：滑杆 input 事件 180ms 防抖（阈值表 150–200ms），松手后一次全量 prerender/预览刷新 */
  let liveDebTimer = null;
  function liveDebounced() {
    if (liveDebTimer) clearTimeout(liveDebTimer);
    liveDebTimer = setTimeout(() => { liveDebTimer = null; live(); }, 180);
  }

  /* ---------- 滑块控件（调节滑块：步进吸附+数字回显+重置） ---------- */
  function sliderRow(label, get, set, min, max, step, fmt, def) {
    const row = el("div", "row");
    row.appendChild(el("div", "row-label", label));
    const wrap = el("div", "slider-wrap");
    const inp = el("input"); inp.type = "range";
    inp.min = min; inp.max = max; inp.step = step; inp.value = get();
    const val = el("span", "slider-val", fmt(get()));
    syncers.push(() => { inp.value = get(); val.textContent = fmt(get()); }); // R5-02：滑块值+数字回显回刷
    inp.addEventListener("input", () => {
      let v = Math.round(parseFloat(inp.value) / step) * step; // 0.25 步进吸附
      v = Math.min(max, Math.max(min, v));
      set(v); val.textContent = fmt(v); save(); touchIdle(); liveDebounced(); // R6-02 P1-2：拖动期防抖，松手一次全量刷新
    });
    const reset = el("button", "btn-mini", "重置");
    reset.addEventListener("click", () => { set(def); inp.value = def; val.textContent = fmt(def); save(); touchIdle(); live(); });
    wrap.appendChild(inp); wrap.appendChild(val); wrap.appendChild(reset);
    row.appendChild(wrap);
    return row;
  }

  function switchRow(label, get, set) {
    const row = el("div", "row");
    row.appendChild(el("div", "row-label", label));
    const b = el("button", "switch" + (get() ? " on" : ""), get() ? "开" : "关");
    syncers.push(() => { b.className = "switch" + (get() ? " on" : ""); b.textContent = get() ? "开" : "关"; }); // R5-02：开关回刷
    b.addEventListener("click", () => {
      set(!get()); b.className = "switch" + (get() ? " on" : ""); b.textContent = get() ? "开" : "关";
      save(); touchIdle(); live();
    });
    row.appendChild(b);
    return row;
  }

  /* R6-05 匹配度动态判定（取代 R9 静态 F7_VERDICT 名单）：
   * dY 明度差 / dH 主色相差 / 纹理标记 三维度离线预计算入 manifest.match（运行时零图像处理），
   * 运行时按 CC.config.tuning.match 阈值对「所选品类 × 背景」即时求值——改阈值重启即生效。
   * 裁决5：「不推荐」只能由 dY 直接命中（主阈值 / dH 辅助 / 高纹理辅助 / 近黑专项 四分支均 dY 前置）。
   * R7-01（终裁 B 案）第四分支：bg ∈ nearBlack.bgs 且 dY < nearBlack.dyMax → 不推荐，
   * 修复苍蝇×纯黑落入 (dyAux, dyMax) 真空带不挂标；bg 名单仅收紧、dY 直接命中，与既有辅助分支同构。
   * bad=不推荐（红标，样式同 R6-04）；ok=中性不挂标；rec=推荐（绿标，配置项默认关）。
   * R6-04：苍蝇×纯黑由本规则统一产出「不推荐」，原 lowvis 置灰体系已整体下线。
   * R8-08（v1.4.4）：判定升级 R6-05.v3——主分支加 dH≥dhRescue(45°) 色度救援（dY<40 且 dH<45 才
   * 判 bad，色相差大的组合不再被明度单通道误伤）；辅助分支 dhAux 30°→20°（同色系边界收窄）。
   * 近黑分支不受救援（R7-01 终裁不动）；推荐档与高纹理分支不动。 */
  function cellVerdict(cat, bgName) {
    const m = CC.engine && CC.engine.manifest && CC.engine.manifest.match;
    const t = (CC.config.tuning && CC.config.tuning.match) || {};
    const cell = m && m[cat] && m[cat][bgName];
    if (!cell) return "ok";
    /* R8-08 修订一（核心）：色度救援——dY<dyMain 还须 dH<dhRescue 才判 bad */
    if (cell.dY < (t.dyMain != null ? t.dyMain : 40) && cell.dH < (t.dhRescue != null ? t.dhRescue : 45)) return "bad";
    /* R8-08 修订二：同色系收紧边界收窄——dhAux 30°→20° */
    if (cell.dY < (t.dyAux != null ? t.dyAux : 60) && cell.dH < (t.dhAux != null ? t.dhAux : 20)) return "bad";
    if (cell.tex && cell.dY < (t.dyTex != null ? t.dyTex : 50) && cell.dH < (t.dhTex != null ? t.dhTex : 45)) return "bad";
    /* R7-01 近黑专项（第四分支，置于「推荐」档判定之前；回退默认与 tuning 出厂值一致） */
    const nb = t.nearBlack || {};
    if ((nb.bgs || ["black"]).includes(bgName) &&
        cell.dY < (nb.dyMax != null ? nb.dyMax : 80)) return "bad";
    if (t.showRecommendBadge &&
        cell.dY >= (t.dyRec != null ? t.dyRec : 80) && cell.dH >= (t.dhRec != null ? t.dhRec : 45)) return "rec";
    return "ok";
  }
  function bgVerdict(bgName) {
    /* R8-09（v1.4.4）：聚合口径 ANY-bad → ALL-bad——全部所选品类均 bad 才挂红标；
     * 新语义「这个背景对你选的所有动物都不推荐」；单选时 ALL=ANY 完全等价（零回归）。 */
    let rec = false, allBad = CC.config.cats.length > 0;
    for (const c of CC.config.cats) {
      const v = cellVerdict(c, bgName);
      if (v !== "bad") allBad = false; // 只要有所选品类非 bad，该背景不挂红标
      if (v === "rec") rec = true;
    }
    if (allBad) return "bad";
    return rec ? "rec" : "ok";
  }

  function build() {
    root = el("div", "panel hidden");

    /* ===== 左列：调节项 ===== */
    const left = el("div", "panel-col");
    const title = el("div", "panel-title", "猫抓乐 · 设置");
    title.addEventListener("click", () => { // 隐藏调试档入口：3s 内连点标题 7 次
      const now = performance.now();
      if (now - titleTapT > 3000) titleTapN = 0;
      titleTapT = now; titleTapN++;
      if (titleTapN >= 7) { titleTapN = 0; toggleDebug(); }
      touchIdle();
    });
    left.appendChild(title);

    // 反馈5：首启引导条（面板左列顶部；首次关闭面板后不再出现）
    // R2-02 修复：补 × 关闭按钮（复用 .guide-bar button 样式），点击即写入 seen 标记并移除
    if (!localStorage.getItem("cc_guide_bar_seen")) {
      const bar = el("div", "guide-bar",
        "调好参数点『开始游戏』；游戏中退出 = 左上角长按 3 秒直达快捷设置"); // R4-07 需求9 文案同步
      const x = el("button", null, "×");
      x.setAttribute("aria-label", "关闭引导");
      x.addEventListener("click", () => {
        localStorage.setItem("cc_guide_bar_seen", "1");
        bar.remove();
        touchIdle();
      });
      bar.appendChild(x);
      left.appendChild(bar);
    }

    // R4-05 需求2：参数范围放开——体积/速度 0.25–6× 步 0.25 默认 1.0；数量 1–20 步 1 默认 3
    left.appendChild(sliderRow("体积", () => CC.config.size, v => CC.config.size = v,
      0.25, 6, 0.25, v => v.toFixed(2) + "×", 1.0));
    left.appendChild(sliderRow("速度", () => CC.config.speed, v => CC.config.speed = v,
      0.25, 6, 0.25, v => v.toFixed(2) + "×", 1.0));
    left.appendChild(sliderRow("数量", () => CC.config.count, v => CC.config.count = Math.round(v),
      1, 20, 1, v => v + " 只", 3));

    // A2 目标种类多选（默认全选、至少保留 1 种）
    const catRow = el("div", "row column");
    catRow.appendChild(el("div", "row-label", "目标种类（至少 1 种）"));
    const catWrap = el("div", "chip-wrap");
    for (const c of CC.CATS) {
      const chip = el("button", "chip" + (CC.config.cats.includes(c) ? " on" : ""), CC.CAT_LABEL[c]);
      chip.dataset.cat = c;
      chip.addEventListener("click", () => {
        const on = CC.config.cats.includes(c);
        if (on && CC.config.cats.length === 1) { chip.classList.add("shake"); setTimeout(() => chip.classList.remove("shake"), 400); return; } // 取消全选拦截
        if (on) {
          CC.config.cats = CC.config.cats.filter(x => x !== c);
          save(); touchIdle(); live(); refreshBgBadges();
        } else {
          CC.config.cats.push(c);
          // R3-01 修复（体验配套）：勾选新增种类即时解码素材，完成后 live() 让预览区立即可见。
          // _loadCat 幂等槽位去重，已解码种类零开销；预览引擎共享 sprites 引用，
          // live() 内 previewEngine.prerender() 即完成预览侧预渲染。
          // R6-02 P1-1：一次切换只触发一次 live()（原 .then(live) 与同步 live() 双触发，
          // 预览引擎重复全量预渲染）；取消勾选分支同样只走一次同步 live()。
          CC.engine._loadCat(c, 3).then(() => live());
          save(); touchIdle();
        }
        chip.className = "chip" + (CC.config.cats.includes(c) ? " on" : "");
      });
      catWrap.appendChild(chip);
    }
    catRow.appendChild(catWrap);
    left.appendChild(catRow);

    // R4 动效：总开关 + 单选
    left.appendChild(switchRow("触摸动效", () => CC.config.fxOn, v => CC.config.fxOn = v));
    const fxRow = el("div", "row column");
    fxRow.appendChild(el("div", "row-label", "动效样式（单选，切换后预览自动演示一次）"));
    const fxWrap = el("div", "chip-wrap");
    for (const t of CC.FX_TYPES) {
      const chip = el("button", "chip" + (CC.config.fxType === t ? " on" : ""), CC.FX_LABEL[t]);
      chip.dataset.fx = t;
      chip.addEventListener("click", () => {
        CC.config.fxType = t;
        fxWrap.querySelectorAll(".chip").forEach(x => x.className = "chip" + (x.dataset.fx === t ? " on" : ""));
        save(); touchIdle();
        // C3 动效单选切换后预览区自动演示一次（F3：预览独立动效实例，渲染到预览画布）
        if (previewEngine && CC._pvFx) CC._pvFx.trigger(t, previewEngine.W / 2, previewEngine.H / 2);
      });
      fxWrap.appendChild(chip);
    }
    fxRow.appendChild(fxWrap);
    left.appendChild(fxRow);

    left.appendChild(switchRow("环境音（嗡鸣）", () => CC.config.sndAmbient, v => {
      CC.config.sndAmbient = v;
      if (!v) CC.audio.stopAll();
      else {
        /* R4-03 缺陷#3：开方向补挂存量——遍历主引擎存活且未 hitT 实体逐只 startHum。
         * startHum 内部幂等（hums 去重）且仅放行飞行类（苍蝇/蜜蜂/蝴蝶），关闭方向不动。 */
        for (const e of CC.engine.entities) {
          if (!e.dead && !e.hitT) CC.audio.startHum(e, "main");
        }
      }
    }));
    left.appendChild(switchRow("命中音", () => CC.config.sndHit, v => CC.config.sndHit = v));
    left.appendChild(switchRow("显示计分（右上角）", () => CC.config.showScore, v => { CC.config.showScore = v; CC.hud.refresh(); }));
    left.appendChild(sliderRow("面板空闲自动返回", () => CC.config.panelIdleSec, v => CC.config.panelIdleSec = Math.round(v),
      60, 600, 30, v => v + "s", 60)); // R2-06：滑块下限 60 与默认值、idleMs 代码下限三者对齐；R4-05 需求2：上限放开至 600s 步 30

    /* ===== 中列：背景 + 预览 ===== */
    const mid = el("div", "panel-col");
    mid.appendChild(el("div", "row-label", "背景（单选）"));
    const bgGrid = el("div", "bg-grid");
    for (const b of CC.BGS) {
      const cell = el("div", "bg-cell" + (CC.config.bg === b ? " sel" : ""));
      cell.dataset.bg = b;
      const th = el("img", "bg-thumb"); th.src = `game/bg/${b}.webp`; th.alt = CC.BG_LABEL[b];
      cell.appendChild(th);
      cell.appendChild(el("div", "bg-name", CC.BG_LABEL[b]));
      const badge = el("div", "bg-badge hidden", "不推荐");
      cell.appendChild(badge);
      cell.addEventListener("click", () => {
        CC.config.bg = b;
        bgGrid.querySelectorAll(".bg-cell").forEach(x => x.className = "bg-cell" + (x.dataset.bg === b ? " sel" : ""));
        save(); touchIdle(); live();
      });
      bgGrid.appendChild(cell);
    }
    mid.appendChild(bgGrid);
    mid.appendChild(el("div", "row-label", "实时预览"));
    const pv = el("div", "preview-wrap");
    const pvBg = el("canvas", "pv-bg");
    const pvCv = el("canvas", "pv-cv");
    pv.appendChild(pvBg); pv.appendChild(pvCv);
    pv.appendChild(el("div", "pv-placeholder", "素材加载中…")); // 反馈5：素材并行加载期占位，assetsReady() 移除
    pv.addEventListener("click", ev => { // C3 点触手动触发演示（F3：预览独立实例）
      const r = pv.getBoundingClientRect();
      if (CC._pvFx) CC._pvFx.trigger(CC.config.fxType,
        (ev.clientX - r.left) / r.width * previewEngine.W,
        (ev.clientY - r.top) / r.height * previewEngine.H);
      touchIdle();
    });
    mid.appendChild(pv);

    /* ===== 右列：操作 ===== */
    const right = el("div", "panel-col actions");
    const help = el("button", "btn-secondary", "操作说明");
    help.addEventListener("click", () => { CC.guide.show(true); touchIdle(); });
    right.appendChild(help);
    const start = el("button", "btn-primary", "开始游戏");
    start.addEventListener("click", () => { close(); });
    right.appendChild(start);
    const exit = el("button", "btn-danger", "退出 App");
    exit.addEventListener("click", () => {
      touchIdle();
      const ov = el("div", "confirm-overlay");
      const box = el("div", "confirm-box");
      box.appendChild(el("div", "confirm-text", "确认退出 App 吗？"));
      const yes = el("button", "btn-danger", "确认退出");
      const no = el("button", "btn-secondary", "取消");
      yes.addEventListener("click", () => { save(); window.CatShell && CatShell.exitApp(); }); // R4-08：LockTask 调用移除
      no.addEventListener("click", () => { ov.remove(); touchIdle(); });
      box.appendChild(yes); box.appendChild(no);
      ov.appendChild(box); root.appendChild(ov);
    });
    right.appendChild(exit);
    right.appendChild(el("div", "panel-hint", "离开面板任意路径均自动保存当前设置"));

    root.appendChild(left); root.appendChild(mid); root.appendChild(right);
    root.appendChild(el("div", "idle-countdown")); // R12：空闲倒计时条（最后 10s 渐变收窄）
    document.body.appendChild(root);
  }

  function refreshBgBadges() {
    if (!root) return; // R9：面板未构建时不刷新（boot 早期调用防护）
    // R6-05：三档简化为 bad/ok（+可配置 rec）；R6-04：weak 琥珀档与 lowvis 置灰体系一并下线
    root.querySelectorAll(".bg-cell").forEach(cell => {
      const v = bgVerdict(cell.dataset.bg);
      const badge = cell.querySelector(".bg-badge");
      if (v === "ok") { badge.className = "bg-badge hidden"; return; }
      badge.className = "bg-badge" + (v === "rec" ? " rec" : "");
      badge.textContent = v === "rec" ? "推荐" : "不推荐";
    });
  }

  /* 实时预览视窗：同一 Engine 类、同一参数源（C3） */
  function live() {
    if (!previewEngine) return;
    previewEngine.prerender();
    previewEngine.syncCount();
    CC.engine.setBackground(CC.config.bg); // 主引擎跟随
    previewEngine.setBackground(CC.config.bg);
    syncPvFxPalette(); // F3 预览动效双色板跟随
    refreshBgBadges();
  }

  function initPreview() {
    const pvBg = $(".pv-bg"), pvCv = $(".pv-cv");
    const wrap = pvCv.parentElement;
    const wCss = wrap.clientWidth, hCss = wrap.clientHeight; // 16:9 由 CSS 保证
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [pvBg, pvCv]) { c.width = wCss * dpr; c.height = hCss * dpr; }
    /* R4-04 缺陷#8：预览逻辑视窗对齐主引擎——widthDp=主引擎逻辑宽，高按 16:9 折算，
     * dpr=画布物理宽/widthDp（原硬编码 400×225，宽屏设备上预览动物视觉占比与游戏不一致） */
    const widthDp = CC.engine.W, heightDp = Math.round(widthDp * 9 / 16);
    previewEngine = new CC.Engine({
      bgCanvas: pvBg, spriteCanvas: pvCv,
      widthDp, heightDp, dpr: wCss * dpr / widthDp, isPreview: true
    });
    previewEngine.manifest = CC.engine.manifest;
    previewEngine.sprites = CC.engine.sprites; // 复用已解码位图
    CC._pvEngine = previewEngine;
    // F3 预览视窗独立轻量动效实例（与主画布 CC.effects 隔离，draw 路由到预览 ctx）
    CC._pvFx = CC.createEffects();
    CC._pvFx.init();
    syncPvFxPalette();
    previewEngine.prerender();
    for (let i = 0; i < Math.min(3, CC.config.count); i++) previewEngine.spawn();
    previewEngine.setBackground(CC.config.bg); // R2-03① 修复：首开即加载当前背景（原 pv-bg 恒黑，live() 才补）
  }

  /* F3 预览动效双色板跟随当前背景明度（D4 同口径） */
  function syncPvFxPalette() {
    if (!CC._pvFx || !CC.engine.manifest) return;
    const b = (CC.engine.manifest.backgrounds || []).find(x => x.name === CC.config.bg);
    if (b) CC._pvFx.setPaletteByBgMeanY(b.meanY);
  }

  /* 调试档 */
  function toggleDebug() {
    if (debugOpen) { $(".debug-panel").remove(); debugOpen = false; root.classList.remove("debug-dock"); return; }
    debugOpen = true;
    root.classList.add("debug-dock"); // R2-13：面板整体上移避让底部抽屉
    const d = el("div", "debug-panel");
    d.appendChild(el("div", "panel-title", "调试档（隐藏）"));
    const numRow = (label, key, min, max, step) => sliderRow(label,
      () => CC.debug[key], v => { CC.debug[key] = v; saveDebug(); }, min, max, step, v => "" + v, CC.DEFAULTS.debug[key]);
    d.appendChild(numRow("受惊半径 dp", "startleR", 50, 400, 10));
    d.appendChild(numRow("受惊速度倍率", "startleMul", 1, 4, 0.25));
    d.appendChild(numRow("受惊时长 ms", "startleMs", 200, 3000, 100));
    d.appendChild(numRow("面积否决阈值 mm²", "areaThreshMm2", 150, 250, 10));
    d.appendChild(numRow("连续大面积帧数", "areaConsecFrames", 1, 10, 1));
    d.appendChild(numRow("标定窗口 N", "calibWindowN", 20, 60, 5));
    d.appendChild(numRow("强制降级级别", "forceDegrade", 0, 3, 1));
    d.appendChild(switchRow("直线匀速测试模式", () => CC.debug.lineTest, v => { CC.debug.lineTest = v; saveDebug(); CC.engine._lineTestEnt = null; CC.engine.syncCount(); }));
    const st = el("pre", "debug-state");
    d.appendChild(st);
    const refresh = () => {
      if (!debugOpen) return;
      st.textContent = JSON.stringify({
        guard: CC.guard.state(),
        perf: CC.engine.perfStats(),
        fx: CC.effects.stats(),
        effectiveCount: CC.engine.effectiveCount(),
        speed: CC.engine.sampleSpeed(),
        imgFails: CC.imgFailCount || 0 // R3：素材加载失败计数（超时 / onerror）
      }, null, 1);
      setTimeout(refresh, 1000);
    };
    refresh();
    root.appendChild(d);
  }

  /* C2 空闲自动保存返回 + R12：首启不计时、最后 10s 倒计时条（4px 绿条，250ms 刷新）
   * R2-06 修复：代码下限/滑块下限/默认值三者对齐为 60s（原代码吞成 120s 与默认 60 矛盾） */
  let idleCountdownInt = null, idleDeadline = 0;
  const idleMs = () => Math.max(60, CC.config.panelIdleSec) * 1000;
  function isFirstBoot() { return !localStorage.getItem("cc_first_boot_done"); } // R12
  function clearIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (idleCountdownInt) { clearInterval(idleCountdownInt); idleCountdownInt = null; }
    const bar = root && root.querySelector(".idle-countdown");
    if (bar) { bar.style.width = "0"; bar.style.display = "none"; } // R2-04：复位 display
  }
  function touchIdle() {
    if (!root || root.classList.contains("hidden")) return; // R4-07：面板未打开时不武装空闲定时器（快捷浮层场景防护）
    clearIdle();
    if (isFirstBoot()) return; // R12：首启不自动关闭，留足阅读引导时间
    const ms = idleMs();
    idleDeadline = performance.now() + ms;
    idleTimer = setTimeout(() => { save(); close(); }, ms);
    idleCountdownInt = setInterval(() => {
      const bar = root && root.querySelector(".idle-countdown");
      if (!bar) return;
      const remain = idleDeadline - performance.now();
      // R2-04 修复：最后 10s 解除 display:none 显示绿条（原 CSS display:none 无任何代码解除）
      if (remain <= 10000) {
        bar.style.display = "block";
        bar.style.width = Math.max(0, remain / 100) + "%"; // 最后 10s 100%→0
      } else {
        bar.style.display = "none";
        bar.style.width = "0";
      }
    }, 250);
  }
  function armIdle() { root.addEventListener("pointerdown", touchIdle, { passive: true }); touchIdle(); }

  function open() {
    // R3-07 修复：panelIdleSec 归一并落盘——历史存储值可能 <60（旧版滑块下限 15 遗留），
    // 与 idleMs 下限 max(60,·) 不一致（标签显示 30s 实际按 60s 计时）；
    // 面板打开即归一，滑块标签显示与真实计时同源。
    if (CC.config.panelIdleSec < 60) { CC.config.panelIdleSec = 60; save(); }
    // F3b(v1.1 收尾)：root 初始带 hidden(display:none)，须先显示再 initPreview，
    // 否则 wrap.clientWidth=0 导致预览画布 0×0（headless 实测 cvW=0/cvH=0 捕获）。
    const reused = !!root; // R5-02：复用已构建 DOM 时需真值→DOM 全量回刷
    if (!root) build();
    // R5-02 修复：open() 复用分支「真值→DOM」全量回刷（build() 只在首建时写值）。
    // 覆盖裁判列全的 11 项：体积/速度/数量/空闲 4 滑块（input.value + 数字回显）、
    // 目标种类 chips（on 态；R6-04 lowvis 置灰态已下线）、动效样式 chips（on）、触摸动效/环境音/命中音/显示计分
    // 4 开关、背景格 sel——快捷浮层等面板外写入路径改过的真值，回主菜单即正确呈现。
    if (reused) {
      syncers.forEach(fn => fn());
      root.querySelectorAll(".chip[data-cat]").forEach(ch => {
        ch.className = "chip" + (CC.config.cats.includes(ch.dataset.cat) ? " on" : "");
      });
      root.querySelectorAll(".chip[data-fx]").forEach(ch => {
        ch.className = "chip" + (CC.config.fxType === ch.dataset.fx ? " on" : "");
      });
      root.querySelectorAll(".bg-cell").forEach(cell => {
        cell.className = "bg-cell" + (CC.config.bg === cell.dataset.bg ? " sel" : "");
      });
      refreshBgBadges(); // R6-05：角标随真值重算（取代原 refreshLowvis 置灰回刷）
    }
    // R2-02 修复：同会话关→开复用已构建 DOM 时，已见引导条须移除（原仅 build() 判断一次，关开必复现）
    if (localStorage.getItem("cc_guide_bar_seen")) {
      const gb = root.querySelector(".guide-bar"); if (gb) gb.remove();
    }
    // 面板打开即真值呈现
    root.classList.remove("hidden");
    if (!previewEngine) initPreview();
    CC.engine.setPaused(true);
    // R4-08 需求6：LockTask 调用整体移除（R17 语义由手势排除 rects + 沉浸重夺承接，MainActivity 侧）
    if (window.CatShell && CatShell.setGestureExclusion) CatShell.setGestureExclusion(false); // R4-09：面板打开恢复系统手势
    armIdle();
    refreshBgBadges();
  }

  async function close() { // 任何离开路径都保存（C2 面板状态即真值）
    save();
    clearIdle();
    if (root) root.classList.add("hidden");
    // R3-01 修复（P1 主修复）：close 是所有离场路径（开始游戏 / 空闲自动返回）唯一收口，
    // 在 prerender 前补齐全部勾选种类的素材解码——会话内新勾种类此前无任何 _loadCat 路径，
    // 未解码种类 catForSpawn 池空 → spawn 返 null → 场内 0 只动物且会话内永不自愈。
    // _loadCat 幂等且槽位去重（_loadJobs 在飞任务登记），重复调用零风险。
    await Promise.all(CC.config.cats.map(c => CC.engine._loadCat(c, 3)));
    CC.engine.setPaused(false);
    CC.engine.prerender();
    CC.engine.syncCount();
    CC.engine.setBackground(CC.config.bg); // R16：engine 内 bgName 守卫，未变更时零开销
    CC.hud.refresh();
    // R4-08 需求6：LockTask 调用整体移除；进游戏提示退出方法横幅（顶部居中 4s 淡出、「不再提示」写本地标记）
    if (CC.exitBanner) CC.exitBanner.show();
    if (window.CatShell && CatShell.setGestureExclusion) CatShell.setGestureExclusion(true); // R4-09：进入游戏态启用手势排除
    localStorage.setItem("cc_first_boot_done", "1"); // R12：首启流程结束，此后启用空闲倒计时
    localStorage.setItem("cc_guide_bar_seen", "1"); // 反馈5：引导条只看一次
  }

  /* 反馈5：素材并行加载完成回调（main.js boot），移除预览占位 */
  function assetsReady() {
    if (!root) return;
    const ph = root.querySelector(".pv-placeholder");
    if (ph) ph.remove();
    // R2-03② 修复：素材就绪后补预渲染+数量对齐（首启 initPreview 的 spawn 因 sprites 为空全部落空；
    // sprites 为共享引用，此时已解码完成可立即预渲染）
    if (previewEngine) { previewEngine.prerender(); previewEngine.syncCount(); }
  }

  /* R2-11 修复：面板打开时 resize 同步重设预览画布与引擎参数（原只重设主画布，预览拉伸变形） */
  function resizePreview() {
    if (!root || !previewEngine) return;
    const pvBg = $(".pv-bg"), pvCv = $(".pv-cv");
    const wrap = pvCv.parentElement;
    const wCss = wrap.clientWidth, hCss = wrap.clientHeight; // 16:9 由 CSS 保证
    if (!wCss || !hCss) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [pvBg, pvCv]) { c.width = wCss * dpr; c.height = hCss * dpr; }
    // R4-04 缺陷#8：逻辑视窗跟随主引擎（旋转后 CC.engine.W 变化须同步），dpr 按物理宽重算
    previewEngine.W = CC.engine.W;
    previewEngine.H = Math.round(previewEngine.W * 9 / 16);
    previewEngine.dpr = wCss * dpr / previewEngine.W;
    previewEngine._paintBg();
    previewEngine.prerender();
  }

  return { open, close, assetsReady, resizePreview, isOpen: () => root && !root.classList.contains("hidden") };
})();

/* ---------- B5 首次启动引导层（沿用 C1 高对比中性配色、≥48dp 触控目标） ---------- */
CC.guide = (function () {
  let root;
  function build() {
    root = document.createElement("div");
    root.className = "guide hidden";
    root.innerHTML = `
      <div class="guide-box">
        <div class="panel-title">给猫玩之前，请花 10 秒</div>
        <div class="guide-item"><b>如何退出游戏（只有你能做到）</b><br>
        1. 左上角热区<b>定点长按 3 秒</b>（不要移动）<br>
        2. <b>直达快捷设置浮层</b>（无需拖动滑块）<br>
        3. 浮层内可快速调节、返回主菜单或退出 App</div>
        <div class="guide-item"><b>使用建议</b><br>
        · 建议贴膜（钢化膜）后再给猫玩，防抓伤屏幕<br>
        · 游戏为全屏沉浸模式；误触呼出系统栏会自动收回（≤1 秒），游戏进度不受影响<br>
        · 猫爪拍屏只会触发动效，不会打开任何界面</div>
        <button class="btn-primary" id="guide-ok">已知晓</button>
      </div>`;
    document.body.appendChild(root);
    root.querySelector("#guide-ok").addEventListener("click", () => {
      root.classList.add("hidden");
      CC.store.save("cc_guide_seen", { v: 1 });
    });
  }
  return {
    maybeShow() { if (!localStorage.getItem("cc_guide_seen")) this.show(); },
    show(fromPanel) { if (!root) build(); root.classList.remove("hidden"); },
    isOpen: () => root && !root.classList.contains("hidden")
  };
})();

/* ---------- HUD：计分（E6 不可交互显示元素，默认隐藏，右上角避开左上热区） ---------- */
CC.hud = (function () {
  let el;
  return {
    init() {
      el = document.createElement("div");
      el.id = "hud-score";
      document.body.appendChild(el);
      this.refresh();
    },
    refresh() {
      el.style.display = CC.config.showScore ? "block" : "none";
      el.textContent = "得分 " + (CC.engine ? CC.engine.score : 0);
    }
  };
})();


/* ---------- R4-07 需求9：游戏内快捷设置浮层（左上角长按 3 秒直达，替代 B4 验证滑块） ----------
 * 范围（PM 最小可用集）：体积/速度/数量 3 滑块（R4-05 新范围）+ 目标种类 chips + 触摸动效总开关；
 * 不放：背景/动效样式/声音/计分/空闲时长/操作说明/调试档（仍回主菜单）。
 * 三按钮：继续游戏（复用 panel.close 的保存+素材补齐+prerender+syncCount 语义）/
 * 返回主菜单（CC.panel.open，含预览与空闲倒计时）/ 退出游戏（二次确认→exitApp）。
 * 浮层期 setPaused(true)、不设空闲倒计时；游戏侧触摸早退守卫在 main.js 扩展至本浮层。
 * show() 时重建内容（box 重建），保证与主面板双向状态连续（真值呈现）。 */
CC.quick = (function () {
  let root = null;
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const save = () => CC.store.save("cc_config", CC.config);

  /* 简化调节滑块：步进吸附+数字回显（无重置钮、无空闲/预览联动——生效收口于「继续游戏」） */
  function qSlider(label, get, set, min, max, step, fmt) {
    const row = el("div", "row");
    row.appendChild(el("div", "row-label", label));
    const wrap = el("div", "slider-wrap");
    const inp = el("input"); inp.type = "range";
    inp.min = min; inp.max = max; inp.step = step; inp.value = get();
    const val = el("span", "slider-val", fmt(get()));
    inp.addEventListener("input", () => {
      let v = Math.round(parseFloat(inp.value) / step) * step; // 步进吸附
      v = Math.min(max, Math.max(min, v));
      set(v); val.textContent = fmt(v); save(); // 面板状态即真值：修改即时保存
    });
    wrap.appendChild(inp); wrap.appendChild(val);
    row.appendChild(wrap);
    return row;
  }

  function buildBox() {
    const box = el("div", "quick-box");
    box.appendChild(el("div", "panel-title", "快捷设置"));
    // R4-05 新范围三滑块
    box.appendChild(qSlider("体积", () => CC.config.size, v => CC.config.size = v,
      0.25, 6, 0.25, v => v.toFixed(2) + "×"));
    box.appendChild(qSlider("速度", () => CC.config.speed, v => CC.config.speed = v,
      0.25, 6, 0.25, v => v.toFixed(2) + "×"));
    box.appendChild(qSlider("数量", () => CC.config.count, v => CC.config.count = Math.round(v),
      1, 20, 1, v => v + " 只"));
    // 目标种类 chips（至少保留 1 种，与主面板同语义）
    const catRow = el("div", "row column");
    catRow.appendChild(el("div", "row-label", "目标种类（至少 1 种）"));
    const catWrap = el("div", "chip-wrap");
    for (const c of CC.CATS) {
      const chip = el("button", "chip" + (CC.config.cats.includes(c) ? " on" : ""), CC.CAT_LABEL[c]);
      chip.dataset.cat = c;
      chip.addEventListener("click", () => {
        const on = CC.config.cats.includes(c);
        if (on && CC.config.cats.length === 1) { chip.classList.add("shake"); setTimeout(() => chip.classList.remove("shake"), 400); return; }
        if (on) CC.config.cats = CC.config.cats.filter(x => x !== c);
        else {
          CC.config.cats.push(c);
          CC.engine._loadCat(c, 3); // 新勾种类即时解码（幂等槽位去重；「继续游戏」统一 await 补齐）
        }
        chip.className = "chip" + (CC.config.cats.includes(c) ? " on" : "");
        save();
      });
      catWrap.appendChild(chip);
    }
    catRow.appendChild(catWrap);
    box.appendChild(catRow);
    // 触摸动效总开关
    const fxRow = el("div", "row");
    fxRow.appendChild(el("div", "row-label", "触摸动效"));
    const fxBtn = el("button", "switch" + (CC.config.fxOn ? " on" : ""), CC.config.fxOn ? "开" : "关");
    fxBtn.addEventListener("click", () => {
      CC.config.fxOn = !CC.config.fxOn;
      fxBtn.className = "switch" + (CC.config.fxOn ? " on" : "");
      fxBtn.textContent = CC.config.fxOn ? "开" : "关";
      save();
    });
    fxRow.appendChild(fxBtn);
    box.appendChild(fxRow);
    // 三按钮
    const btns = el("div", "quick-btns");
    const go = el("button", "btn-primary", "继续游戏");
    go.addEventListener("click", continueGame);
    const menu = el("button", "btn-secondary", "返回主菜单");
    menu.addEventListener("click", () => { hide(); CC.panel.open(); });
    const exit = el("button", "btn-danger", "退出游戏");
    exit.addEventListener("click", () => {
      // 沿用主面板退出确认弹窗样式（.confirm-overlay/.confirm-box）
      const ov = el("div", "confirm-overlay");
      const cbox = el("div", "confirm-box");
      cbox.appendChild(el("div", "confirm-text", "确认退出 App 吗？"));
      const yes = el("button", "btn-danger", "确认退出");
      const no = el("button", "btn-secondary", "取消");
      yes.addEventListener("click", () => { save(); window.CatShell && CatShell.exitApp(); }); // R4-08：无 LockTask 清理
      no.addEventListener("click", () => ov.remove());
      cbox.appendChild(yes); cbox.appendChild(no);
      ov.appendChild(cbox); root.appendChild(ov);
    });
    btns.appendChild(go); btns.appendChild(menu); btns.appendChild(exit);
    box.appendChild(btns);
    return box;
  }

  /* 「继续游戏」：复用 close() 语义——保存 + 勾选种类素材补齐 + prerender + syncCount（修改即时生效） */
  async function continueGame() {
    save();
    hide();
    await Promise.all(CC.config.cats.map(c => CC.engine._loadCat(c, 3))); // _loadCat 幂等，重复调用零风险
    CC.engine.setPaused(false);
    CC.engine.prerender();
    CC.engine.syncCount();
    CC.engine.setBackground(CC.config.bg);
    CC.hud.refresh();
    if (window.CatShell && CatShell.setGestureExclusion) CatShell.setGestureExclusion(true); // R4-09：回游戏态启用手势排除
  }

  function show() {
    if (!root) {
      root = el("div", "quick hidden");
      document.body.appendChild(root);
    }
    root.innerHTML = ""; // 重建内容 = 打开即真值呈现（与主面板双向状态连续）
    root.appendChild(buildBox());
    root.classList.remove("hidden");
    CC.engine.setPaused(true); // 浮层期暂停（与主面板一致）；不设空闲倒计时
    if (window.CatShell && CatShell.setGestureExclusion) CatShell.setGestureExclusion(false); // R4-09：浮层打开恢复系统手势
  }
  function hide() { if (root) root.classList.add("hidden"); }

  return { show, hide, isOpen: () => root && !root.classList.contains("hidden") };
})();

/* ---------- R4-08 需求6：进游戏退出提示横幅 ----------
 * 每次从主面板进游戏（panel.close 收口）顶部居中显示「退出：左上角长按 3 秒」，4s 自动淡出；
 * 容器 pointer-events:none 不拦截任何触摸（「不再提示」按钮单独放开）；避开左上热区与右上计分；
 * 「不再提示」写本地标记 cc_exit_banner_off，清除应用数据后恢复。 */
CC.exitBanner = (function () {
  let banner = null, timer = null;
  function dismiss() {
    if (!banner) return;
    banner.classList.add("fade");
    setTimeout(() => { if (banner) banner.style.display = "none"; }, 400);
  }
  return {
    show() {
      if (localStorage.getItem("cc_exit_banner_off")) return; // 已点「不再提示」
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "exit-banner";
        const txt = document.createElement("span");
        txt.textContent = "退出：左上角长按 3 秒";
        const off = document.createElement("button");
        off.type = "button";
        off.textContent = "不再提示";
        off.addEventListener("click", () => {
          localStorage.setItem("cc_exit_banner_off", "1");
          dismiss();
        });
        banner.appendChild(txt); banner.appendChild(off);
        document.body.appendChild(banner);
      }
      banner.classList.remove("fade");
      banner.style.display = "flex";
      if (timer) clearTimeout(timer);
      timer = setTimeout(dismiss, 4000); // 4 秒自动淡出
    }
  };
})();
