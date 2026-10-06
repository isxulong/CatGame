/* engine.js — Canvas 2D 双层画布引擎。
 * v2 §8：背景层只绘一次、精灵层每帧清绘；初始化按体积档预渲染离屏精灵；
 * 禁 shadowBlur；降级触发器 E2：3s<30fps 逐级（粒子减半→砍粒子→降同屏上限）、
 * 10s≥45fps 滞回恢复、每级最小驻留 30s、调试档强制降帧开关。
 * 玩法 §7/A5：5 种行为模式、触边钳制反弹（≥24dp 安全带）、受惊机制、
 * 边缘入场 + 0.5s 免命中、拍中消耗 0.5–2s 后补充。
 * A3 速度验收：引擎内逐帧路径长度采样（±10% 容差）——sampleSpeed() 为权威数据源。 */
window.CC = window.CC || {};

/* R2-03 配套：跨引擎共享背景图缓存——主/预览双引擎同名背景只请求+解码一次（守 R19 零重复 decode 口径）。
 * 失败条目即时剔除、不留毒缓存，与 R2-09「失败允许重试」配合。 */
const bgCache = new Map(); // name -> Promise<Image|null>
function loadBgShared(name) {
  if (!bgCache.has(name)) {
    bgCache.set(name, new Promise(res => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => { bgCache.delete(name); res(null); };
      im.src = `game/bg/${name}.webp`;
    }));
  }
  return bgCache.get(name);
}

CC.Engine = class {
  /**
   * @param {Object} o {bgCanvas, spriteCanvas, widthDp, heightDp, dpr, isPreview}
   */
  constructor(o) {
    this.bgCanvas = o.bgCanvas; this.cv = o.spriteCanvas;
    this.ctx = this.cv.getContext("2d");
    this.W = o.widthDp; this.H = o.heightDp; this.dpr = o.dpr;
    this.isPreview = !!o.isPreview;
    this.audioNs = this.isPreview ? "pv" : "main"; // R2-05 加固：嗡鸣按引擎命名空间隔离
    this.entities = [];
    this.nextId = 1;
    this.sprites = {};        // cat -> [{body, wing, wPx, hPx, ratio}]
    this.shadowImg = null;
    this.bgImg = null;
    this.score = 0;
    this.degradeLevel = 0;    // 0 无 / 1 粒子减半 / 2 砍粒子 / 3 降同屏上限
    this._lowSince = 0; this._highSince = 0; this._levelAt = 0;
    this._frames = [];        // rAF 帧间隔采样（性能自采 E1）
    this._respawnQueue = [];  // {at, cat}
    this._lineTestEnt = null;
    this._paused = false;
    this._makeShadow();
  }

  setPaused(v) { this._paused = !!v; }
  isPaused() { return this._paused; }

  /* ---------- 素材 ---------- */
  _makeShadow() {
    // D2 预渲染椭圆软阴影（径向渐变位图，不碰 shadowBlur）
    const c = document.createElement("canvas"); c.width = 128; c.height = 64;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(64, 32, 2, 64, 32, 62);
    grad.addColorStop(0, "rgba(0,0,0,0.42)"); grad.addColorStop(1, "rgba(0,0,0,0)");
    g.save(); g.scale(1, 0.5); g.translate(0, 32);
    g.fillStyle = grad; g.fillRect(0, -32, 128, 128); g.restore();
    this.shadowImg = c;
  }

  async loadManifest() {
    // WebView file:// 下 fetch 被 CORS 拦截（allowFileAccessFromFileURLs 对 targetSdk30+ 无效），
    // manifest 以 JS 文件内嵌（manifest.js），fetch 仅作浏览器调试回退。
    if (window.CC_MANIFEST) { this.manifest = window.CC_MANIFEST; return this.manifest; }
    const r = await fetch("game/manifest.json");
    this.manifest = await r.json();
    return this.manifest;
  }

  /* 冷启动：先解码默认背景 + 首批 3 目标各 1 变体即入画，其余惰性解码（v2 §8）。
   * F2(v1.1)：首批 1 变体入画后，后台惰性补齐至 3 变体（fire-and-forget，
   * 不打断冷启动口径）；逐变体解码完成即写入槽位并增量预渲染，spawn 立即可参与随机。
   * R19 修复：原「slice(3) 惰性 1 变体 + 全量补齐 3 变体」两并发循环存在竞态重复 decode，
   * 合并为单循环按槽位去重（_loadJobs 在飞任务登记，同槽位复用同一 Promise）。 */
  async loadInitial(onBg) {
    await this.setBackground(CC.config.bg, onBg);
    const first = CC.config.cats.slice(0, 3);
    await Promise.all(first.map(c => this._loadCat(c, 1)));
    for (const c of CC.config.cats) this._loadCat(c, 3); // R19 合并循环：惰性补齐至 3 变体（不 await，槽位去重）
  }

  /* F2：取消 early-return 短路，允许增量填充——空槽位才发起解码，
   * 已存在槽位不重载；每个变体落地后立即增量预渲染。
   * R19：在飞任务按槽位登记去重，杜绝并发循环对同一变体重复 decode。 */
  async _loadCat(cat, variantCount) {
    const n = variantCount || 3;
    if (!this.sprites[cat]) this.sprites[cat] = [];
    const list = this.sprites[cat];
    if (!this._loadJobs) this._loadJobs = {};
    const jobs = [];
    for (let i = 1; i <= n; i++) {
      if (list[i - 1]) continue;
      const key = cat + ":" + i;
      if (this._loadJobs[key]) { jobs.push(this._loadJobs[key]); continue; } // R19 槽位去重
      const job = this._loadSprite(cat, i).then(s => {
        list[i - 1] = s;
        this._prerenderVariant(cat, i - 1);
        delete this._loadJobs[key];
      });
      this._loadJobs[key] = job;
      jobs.push(job);
    }
    await Promise.all(jobs);
  }

  _loadSprite(cat, idx) {
    // 翅膀层为 M0 管线离线预生成的独立位图（{cat}_{i}_wing.webp），
    // 避免运行时 getImageData——WebView file:// 下 canvas 被污染会抛 SecurityError。
    const loadImg = src => new Promise(res => {
      const im = new Image();
      let settled = false;
      const fail = () => { // R3 修复：加载失败/超时统一走失败路径并计数（进调试档），不再零容错永久挂起
        if (settled) return; settled = true;
        CC.imgFailCount = (CC.imgFailCount || 0) + 1;
        CC.perfLog("img-fail", { src });
        res(null);
      };
      im.onload = () => { if (!settled) { settled = true; res(im); } };
      im.onerror = fail;
      setTimeout(fail, 3000); // R3：3s 超时走失败路径
      im.src = src;
    });
    return (async () => {
      const body = await loadImg(`game/sprites/${cat}_${idx}.webp`);
      if (!body) return { body: document.createElement("canvas"), wing: null, ratio: 1 };
      const wing = ["housefly", "bee", "butterfly"].includes(cat)
        ? await loadImg(`game/sprites/${cat}_${idx}_wing.webp`) : null;
      return { body, wing, ratio: body.naturalHeight / body.naturalWidth };
    })();
  }

  async setBackground(name, onDone) {
    // R16 修复：背景未变化时跳过重载（此前滑块每次 input 全量重载背景图导致调参闪烁）
    if (this.bgName === name && this.bgImg) { if (onDone) onDone(); return; }
    // R2-14 修复：同名背景在途去重（原守卫要求 bgImg 真值，在途期同名连发穿透重复请求）
    if (this._bgInFlight === name) { this._bgOnDone = onDone; return; }
    this.bgName = name;
    this._bgInFlight = name;
    loadBgShared(name).then(im => {
      if (!im) {
        // R2-09 修复：加载失败清 bgName 允许重试（原失败后 bgName 已是新名、守卫恒跳过，会话内卡死旧背景）
        if (this._bgInFlight === name) this._bgInFlight = null;
        if (this.bgName === name) this.bgName = null;
        CC.perfLog("bg-fail", { name });
        return;
      }
      if (this._bgInFlight === name) this._bgInFlight = null;
      if (this.bgName !== name) return; // 已有更新请求接管，丢弃迟到结果
      this.bgImg = im; this._paintBg();
      const b = (this.manifest.backgrounds || []).find(x => x.name === name);
      if (b) {
        CC.effects.setPaletteByBgMeanY(b.meanY); // D4 自适应双色板
        if (CC.hotzoneMark) CC.hotzoneMark.setBrightness(b.meanY); // R5 角标明度自适应
      }
      if (onDone) onDone();
      if (this._bgOnDone) { const f = this._bgOnDone; this._bgOnDone = null; f(); }
    });
  }

  _paintBg() {
    const c = this.bgCanvas, g = c.getContext("2d");
    if (!this.bgImg) { g.fillStyle = "#222"; g.fillRect(0, 0, c.width, c.height); return; }
    // R3 等比缩放居中裁剪不拉伸
    const s = Math.max(c.width / this.bgImg.width, c.height / this.bgImg.height);
    const w = this.bgImg.width * s, h = this.bgImg.height * s;
    g.drawImage(this.bgImg, (c.width - w) / 2, (c.height - h) / 2, w, h);
  }

  /* 体积档变化 → 重新预渲染离屏精灵（v2 §8 初始化按体积档预渲染）。
   * F2： sprites 列表可能稀疏（补齐中），逐槽位预渲染并跳过空槽。 */
  prerender() {
    this._pr = {};
    for (const cat of CC.CATS) {
      const list = this.sprites[cat]; if (!list) continue;
      for (let i = 0; i < list.length; i++) this._prerenderVariant(cat, i);
    }
  }

  /* 单变体预渲染（F2 增量路径与全量 prerender 共用） */
  _prerenderVariant(cat, i) {
    const s = (this.sprites[cat] || [])[i]; if (!s) return;
    const mult = CC.config.size;
    const wDp = CC.BASE_WIDTH_DP[cat] * mult;
    const wPx = Math.max(2, Math.round(wDp * this.dpr));
    const hPx = Math.max(2, Math.round(wDp * s.ratio * this.dpr)); // R14 修复：hPx 补乘 dpr（此前离屏高度减半再拉伸，dpr≥2 纵向模糊）
    const body = document.createElement("canvas"); body.width = wPx; body.height = hPx;
    body.getContext("2d").drawImage(s.body, 0, 0, wPx, hPx);
    let wing = null;
    if (s.wing) {
      wing = document.createElement("canvas"); wing.width = wPx; wing.height = hPx;
      wing.getContext("2d").drawImage(s.wing, 0, 0, wPx, hPx);
    }
    if (!this._pr) this._pr = {};
    if (!this._pr[cat]) this._pr[cat] = [];
    this._pr[cat][i] = { body, wing, wDp, hDp: wDp * s.ratio };
  }

  /* ---------- 实体 ---------- */
  catForSpawn() {
    // F2：稀疏数组需确认至少一个可用变体
    const pool = CC.config.cats.filter(c => this._pr && this._pr[c] && this._pr[c].some(Boolean));
    // R3-01 可选加固：池空留诊断日志（主修复在 panel.close() 离场收口处兜底补齐加载）
    if (!pool.length) { CC.perfLog("spawn-pool-empty", { cats: CC.config.cats.slice() }); return null; }
    return pool[Math.floor(Math.random() * pool.length)]; // A2 数量在所选种类中随机分配
  }

  effectiveCount() { // E2 降级态语义：实际同屏 = min(设定, 降级上限)
    const cap = this.degradeLevel >= 3 ? 4 : 99;
    return Math.min(CC.config.count, cap);
  }

  spawn(cat) {
    cat = cat || this.catForSpawn(); if (!cat) return null;
    // F2：补齐期稀疏数组过滤空槽后再随机（R1 进场随机选用）
    // R4-02：vi 记录原始（可稀疏）数组的槽位下标——先取可用槽位下标再随机，
    // 不 filter 后按下标记位（过滤后位置会在补齐期错位，裁判修正③）
    const list = this._pr[cat] || [];
    const idxs = [];
    for (let i = 0; i < list.length; i++) if (list[i]) idxs.push(i);
    if (!idxs.length) return null;
    const vi = idxs[Math.floor(Math.random() * idxs.length)];
    // 边缘入场：从屏幕边缘随机点入场（A5）
    const side = Math.floor(Math.random() * 4);
    const m = CC.SAFE_BELT;
    let x, y;
    if (side === 0) { x = m; y = m + Math.random() * (this.H - 2 * m); }
    else if (side === 1) { x = this.W - m; y = m + Math.random() * (this.H - 2 * m); }
    else if (side === 2) { y = m; x = m + Math.random() * (this.W - 2 * m); }
    else { y = this.H - m; x = m + Math.random() * (this.W - 2 * m); }
    const a = Math.atan2(this.H / 2 - y + (Math.random() - 0.5) * this.H * 0.6,
                         this.W / 2 - x + (Math.random() - 0.5) * this.W * 0.6);
    const e = {
      id: this.nextId++, cat, vi,
      x, y, vx: Math.cos(a), vy: Math.sin(a),
      speedMul: 1,                 // 受惊临时倍率
      startleUntil: 0, startleFrom: 0,
      bornAt: performance.now(),   // A5 入场 0.5s 免命中
      state: "move", stateT: 0, turnAt: 1 + Math.random() * 2,
      phase: Math.random() * 6.28, dead: false, hitT: 0,
      pathAcc: 0, sampleWin: []    // A3 速度采样
    };
    this.entities.push(e);
    if (!this.isPreview) CC.audio.startHum(e, this.audioNs); // R15：预览引擎 spawn 静音，嗡鸣只属主引擎实体
    return e;
  }

  /* R4-02：实体不再固化变体对象引用——渲染/命中按 e.vi 动态解析 _pr[e.cat][e.vi]，
   * 体积档变化触发 prerender 后存量实体尺寸即时生效；空槽（补齐期稀疏）回退首个可用变体。 */
  variantOf(e) {
    const list = this._pr && this._pr[e.cat];
    if (!list) return null;
    return list[e.vi] || list.find(Boolean) || null;
  }

  syncCount() {
    const want = CC.debug.lineTest ? 1 : this.effectiveCount();
    // R2-01 修复：先剔除已不在勾选集的存活实体（原只按数量对齐，取消勾选种类永不退出游戏）；
    // lineTest 调试模式（want=1、强制 housefly）跳过种类过滤
    if (!CC.debug.lineTest) {
      for (const e of this.entities) {
        if (!e.dead && !CC.config.cats.includes(e.cat)) {
          e.dead = true;
          if (!this.isPreview) CC.audio.stopHum(e.id, this.audioNs); // R2-05：预览引擎不碰主引擎嗡鸣
        }
      }
      /* R4-01 缺陷#7 构成再平衡（裁判修正①：必须置于 !lineTest 守卫内，与 R2-01 同守卫）。
       * missing = 勾选且有预渲染但场内 0 存活的种类；逐个 spawn(cat) 定向补：
       * alive≥want 时先从存活最多的种类腾位（每种至少留 1），腾不出位（每种恰 1 只）则先超编、
       * 交由下方数量对齐按先入先处死收口；剩余缺口走随机池。 */
      const hasVariants = c => this._pr && this._pr[c] && this._pr[c].some(Boolean);
      let alive = this.entities.filter(e => !e.dead);
      const missing = CC.config.cats.filter(c => hasVariants(c) && !alive.some(e => e.cat === c));
      for (const cat of missing) {
        if (alive.length >= want) {
          const byCat = {};
          for (const e of alive) byCat[e.cat] = (byCat[e.cat] || 0) + 1;
          let victimCat = null, maxN = 1;
          for (const c of Object.keys(byCat)) if (byCat[c] > maxN) { maxN = byCat[c]; victimCat = c; }
          if (victimCat) {
            const v = alive.find(e => e.cat === victimCat);
            v.dead = true;
            if (!this.isPreview) CC.audio.stopHum(v.id, this.audioNs);
            alive = this.entities.filter(e => !e.dead);
          }
        }
        this.spawn(cat); // 定向补（有预渲染，spawn 必成功）
        alive = this.entities.filter(e => !e.dead);
      }
    }
    const alive2 = this.entities.filter(e => !e.dead);
    for (let i = alive2.length; i < want; i++) this.spawn();
    if (alive2.length > want) {
      for (let i = 0; i < alive2.length - want; i++) {
        alive2[i].dead = true;
        // R15 修复：处死实体时停嗡鸣（此前振荡器只增不减泄漏）
        // R2-05 修复：加 isPreview 守卫（预览引擎处死不再误停主引擎同 id 实体嗡鸣）
        if (!this.isPreview) CC.audio.stopHum(alive2[i].id, this.audioNs);
      }
    }
    if (CC.debug.lineTest && !this._lineTestEnt) {
      const e = this.entities.find(x => !x.dead);
      // R4-02 裁判修正②：lineTest 分支原 e.v 直写同步改为写 e.vi=0（调试路径下渲染按槽位解析）
      if (e) { e.cat = "housefly"; if ((this._pr.housefly || [])[0]) e.vi = 0;
        e.x = CC.SAFE_BELT; e.y = this.H / 2; e.vx = 1; e.vy = 0; e.lineTest = true; this._lineTestEnt = e; }
    }
  }

  /* ---------- 行为（§7 五模式 + A5 受惊） ---------- */
  _behave(e, dt, now) {
    const startled = now < e.startleUntil;
    if (e.lineTest) { e.vx = 1; e.vy = 0; return; }
    e.stateT += dt;
    const R = Math.random;
    switch (e.cat) {
      case "housefly": // 快速折线急停
        if (e.state === "move" && e.stateT > 0.3 + R() * 0.5) { e.state = "pause"; e.stateT = 0; }
        else if (e.state === "pause" && e.stateT > 0.15 + R() * 0.35) {
          e.state = "move"; e.stateT = 0;
          const a = R() * 6.28; e.vx = Math.cos(a); e.vy = Math.sin(a);
        }
        break;
      case "butterfly": // 慢速飘忽悬停
        if (e.state === "move" && e.stateT > 1.5 + R() * 2) { e.state = "hover"; e.stateT = 0; }
        else if (e.state === "hover" && e.stateT > 0.8 + R() * 1.2) { e.state = "move"; e.stateT = 0; }
        if (e.state === "move") {
          const a = Math.atan2(e.vy, e.vx) + Math.sin(now / 700 + e.phase) * 0.06 + (R() - 0.5) * 0.08;
          e.vx = Math.cos(a); e.vy = Math.sin(a);
        }
        break;
      case "bee": // 介于苍蝇与蝴蝶：中速折线
        if (e.stateT > 0.6 + R() * 0.8) {
          e.stateT = 0; const a = Math.atan2(e.vy, e.vx) + (R() - 0.5) * 2.2;
          e.vx = Math.cos(a); e.vy = Math.sin(a);
        }
        break;
      case "mouse": { // 贴边（≥24dp 安全带）疾走
        const m = CC.SAFE_BELT + 30;
        const dl = e.x - m, dr = this.W - m - e.x, dtp = e.y - m, db = this.H - m - e.y;
        const min = Math.min(dl, dr, dtp, db);
        let tx, ty;
        if (min === dl || min === dr) { tx = 0; ty = e.vy >= 0 ? 1 : -1; }
        else { tx = e.vx >= 0 ? 1 : -1; ty = 0; }
        if (e.stateT > 1 + R() * 1.5 && R() < 0.3) { tx = -tx; ty = -ty; e.stateT = 0; }
        // 未贴边时先走向最近边
        if (min > 24) {
          if (min === dl) { tx = -1; ty = 0; } else if (min === dr) { tx = 1; ty = 0; }
          else if (min === dtp) { tx = 0; ty = -1; } else { tx = 0; ty = 1; }
        }
        e.vx = tx; e.vy = ty;
        break;
      }
      case "goldfish": { // 平滑曲线（贝塞尔感：正弦扰动转向）
        const a = Math.atan2(e.vy, e.vx) + Math.sin(now / 900 + e.phase) * 0.035;
        e.vx = Math.cos(a); e.vy = Math.sin(a);
        break;
      }
      case "ladybug": // 慢速直线偶尔转向
        if (e.stateT > 2 + R() * 3) {
          e.stateT = 0; const a = Math.atan2(e.vy, e.vx) + (R() - 0.5) * 1.5;
          e.vx = Math.cos(a); e.vy = Math.sin(a);
        }
        break;
    }
  }

  /* 受惊（A5）：150dp 半径内目标 2× 速度逃离 1s 后线性恢复 */
  startle(x, y) {
    const now = performance.now();
    const r = CC.debug.startleR;
    for (const e of this.entities) {
      if (e.dead) continue;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < r) {
        const a = Math.atan2(e.y - y, e.x - x) + (Math.random() - 0.5) * 0.6;
        e.vx = Math.cos(a); e.vy = Math.sin(a);
        e.startleFrom = now; e.startleUntil = now + CC.debug.startleMs;
      }
    }
  }

  /* A4 碰撞：精灵 alpha 有效区内接椭圆（~80% 主体轮廓）；单触点最多命中 1 个（取重叠最大） */
  hitTest(x, y) {
    const now = performance.now();
    let best = null, bestScore = -1;
    for (const e of this.entities) {
      if (e.dead || e.hitT) continue;
      if (now - e.bornAt < 500) continue;          // A5 入场 0.5s 免命中
      const v = this.variantOf(e);                // R4-02：按槽位动态解析（空槽回退首个可用）
      if (!v) continue;
      const rx = v.wDp * 0.4, ry = v.hDp * 0.4;   // 内接椭圆 ≈ 主体 80%
      const dx = (x - e.x) / rx, dy = (y - e.y) / ry;
      const q = dx * dx + dy * dy;
      if (q <= 1) {
        const overlap = 1 - q;                    // 越靠中心重叠越大
        if (overlap > bestScore) { bestScore = overlap; best = e; }
      }
    }
    return best;
  }

  onHit(e) {
    e.hitT = performance.now();                   // 0.3s 弹跳消失动画起点
    this.score++;
    CC.audio.stopHum(e.id, this.audioNs);         // E4 个体嗡鸣戛然而止
    CC.audio.hit();
    // §7 补充仅针对拍中消耗：0.5–2s 内补充（期间同屏少 1 属预期 A5）
    // R3-02 修复：补充队列不带原 cat——兑现时传 null 走 catForSpawn 按当前勾选池随机
    //（原按被拍原猫兑现，取消勾选/整组换种类后构成粘性、回勾种类不随消耗迁移）
    this._respawnQueue.push({ at: performance.now() + 500 + Math.random() * 1500 });
  }

  /* ---------- 降级触发器（E2） ---------- */
  particleCap() {
    if (CC.debug.forceDegrade >= 2 || this.degradeLevel >= 2) return 0;
    if (CC.debug.forceDegrade === 1 || this.degradeLevel === 1) return 25; // 粒子减半
    return 50;
  }

  _degradeTick(now, fpsLowOK, fpsHighOK) {
    const forced = CC.debug.forceDegrade;
    if (forced > 0) { this.degradeLevel = forced; return; }
    if (this.degradeLevel < 3 && !fpsLowOK) {
      if (!this._lowSince) this._lowSince = now;
      if (now - this._lowSince >= CC.debug.degradeLowSec * 1000 &&
          now - this._levelAt >= CC.debug.degradeDwellSec * 1000) {
        this.degradeLevel++; this._levelAt = now; this._lowSince = 0;
        CC.perfLog("degrade", { level: this.degradeLevel, dir: "down" });
        this.syncCount();
      }
    } else this._lowSince = 0;
    if (this.degradeLevel > 0 && fpsHighOK) {
      if (!this._highSince) this._highSince = now;
      if (now - this._highSince >= CC.debug.degradeHighSec * 1000 &&
          now - this._levelAt >= CC.debug.degradeDwellSec * 1000) {
        this.degradeLevel--; this._levelAt = now; this._highSince = 0;
        CC.perfLog("degrade", { level: this.degradeLevel, dir: "up" });
        this.syncCount();
      }
    } else this._highSince = 0;
  }

  /* ---------- 主循环 ---------- */
  frame(now, dt) {
    // 帧率自采（E1：min/avg/p95 帧间隔）
    this._frames.push(dt * 1000);
    if (this._frames.length > 600) this._frames.shift();
    const win3 = this._frames.slice(-180), win10 = this._frames.slice(-600);
    const avg = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
    const fpsLowOK = win3.length < 60 || (1000 / avg(win3)) >= CC.debug.degradeLowFps;
    const fpsHighOK = win10.length >= 300 && (1000 / avg(win10)) >= CC.debug.degradeHighFps;
    if (!this.isPreview) this._degradeTick(now, fpsLowOK, fpsHighOK);

    // 补充队列
    for (let i = this._respawnQueue.length - 1; i >= 0; i--) {
      if (now >= this._respawnQueue[i].at) {
        this._respawnQueue.splice(i, 1);
        // R3-02：传 null 走 catForSpawn 当前勾选池随机（拍中补充按勾选池迁移构成）
        if (this.entities.filter(e => !e.dead && !e.hitT).length < this.effectiveCount()) this.spawn(null);
      }
    }

    const baseMul = CC.config.speed;
    for (const e of this.entities) {
      if (e.dead) continue;
      if (e.hitT) { if (now - e.hitT > 300) e.dead = true; continue; }
      this._behave(e, dt, now);
      // A5 受惊速度 2×，1s 后线性恢复
      let mul = baseMul;
      if (now < e.startleUntil + 300) {
        const k = now < e.startleUntil ? 1 : Math.max(0, 1 - (now - e.startleUntil) / 300);
        mul = baseMul * (1 + (CC.debug.startleMul - 1) * k);
      }
      let sp = CC.BASE_SPEED_DPS[e.cat] * mul;
      if (e.state === "pause" || e.state === "hover") sp *= e.cat === "housefly" ? 0 : 0.15;
      const dx = e.vx * sp * dt, dy = e.vy * sp * dt;
      e.x += dx; e.y += dy;
      // A3 逐帧路径长度采样（急停/悬停帧标记 moving=false，采样按移动时间计速）
      e.pathAcc += Math.hypot(dx, dy);
      e.sampleWin.push({ t: now, acc: e.pathAcc, moving: sp > 1 });
      while (e.sampleWin.length && now - e.sampleWin[0].t > 3000) e.sampleWin.shift();
      // 触边钳制 + 随机反弹转向（§7：目标物不得完全离场，≥24dp 安全带）
      const m = CC.SAFE_BELT;
      if (e.x < m) { e.x = m; e.vx = Math.abs(e.vx); this._jitter(e); }
      if (e.x > this.W - m) { e.x = this.W - m; e.vx = -Math.abs(e.vx); this._jitter(e); }
      if (e.y < m) { e.y = m; e.vy = Math.abs(e.vy); this._jitter(e); }
      if (e.y > this.H - m) { e.y = this.H - m; e.vy = -Math.abs(e.vy); this._jitter(e); }
    }
    for (let i = this.entities.length - 1; i >= 0; i--) if (this.entities[i].dead) this.entities.splice(i, 1);
  }

  _jitter(e) {
    if (e.cat === "mouse") return; // 老鼠贴边转向由行为层处理
    const a = Math.atan2(e.vy, e.vx) + (Math.random() - 0.5) * 1.2;
    e.vx = Math.cos(a); e.vy = Math.sin(a);
  }

  render(now) {
    const ctx = this.ctx, dpr = this.dpr;
    ctx.clearRect(0, 0, this.cv.width, this.cv.height);
    for (const e of this.entities) {
      if (e.dead) continue;
      const v = this.variantOf(e);                // R4-02：按槽位动态解析（空槽回退首个可用）
      if (!v) continue;
      const x = e.x * dpr, y = e.y * dpr;
      const w = v.wDp * dpr, h = v.hDp * dpr;
      // D2 接触阴影：尺寸/透明度随体积档缩放，全局光源左上 45° → 阴影偏移右下
      const shW = w * 0.9, shH = w * 0.45;
      ctx.globalAlpha = 0.5 + 0.1 * Math.sin(now / 400 + e.phase); // 阴影脉动
      ctx.drawImage(this.shadowImg, x - shW / 2 + w * 0.06, y + h * 0.28, shW, shH);
      ctx.globalAlpha = 1;
      ctx.save();
      ctx.translate(x, y);
      // D2 随运动方向水平镜像翻转 + ±15° 内朝向旋转
      const ang = Math.atan2(e.vy, e.vx);
      let rot = Math.max(-15, Math.min(15, ang * 180 / Math.PI * 0.2)) * Math.PI / 180;
      if (e.vx < 0) ctx.scale(-1, 1);
      ctx.rotate(rot);
      // R1 伪动画：squash-stretch + 摆动
      const sq = 1 + 0.045 * Math.sin(now / 130 + e.phase);
      ctx.scale(sq, 1 / sq); // R20 修复：恢复半周期纵向拉伸（原三元式 sq>1 时纵向恒 1，压缩/回弹只剩半周期）
      // A4/D3 命中弹跳 scale 1→1.2→0 ease-out（0.3s）
      if (e.hitT) {
        const t = Math.min(1, (now - e.hitT) / 300);
        const s = t < 0.4 ? 1 + 0.2 * (t / 0.4) : 1.2 * Math.pow(1 - (t - 0.4) / 0.6, 2);
        ctx.scale(Math.max(0.01, s), Math.max(0.01, s));
        ctx.globalAlpha = Math.max(0, 1 - t);
      }
      ctx.drawImage(v.body, -w / 2, -h / 2, w, h);
      // R1 翅膀类独立图层 rotate/scale 振荡
      if (v.wing) {
        // R4-10：扇翅频率 per-cat 表（蝴蝶 6、蜜蜂 19 维持不变、苍蝇 12 次/秒）
        const FLAP_FREQ = { butterfly: 6, bee: 19, housefly: 12 };
        const freq = FLAP_FREQ[e.cat] || 19;
        const wa = Math.sin(now / 1000 * freq * 6.28 + e.phase);
        ctx.save();
        ctx.rotate(wa * 8 * Math.PI / 180);
        ctx.scale(1, 1 - 0.18 * Math.abs(wa));
        ctx.drawImage(v.wing, -w / 2, -h / 2, w, h);
        ctx.restore();
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  /* A3 权威速度采样：最近 ≤2s 窗口逐帧路径长度 / 移动时间 → dp/s（急停悬停帧不计时；含受惊期则标注） */
  sampleSpeed() {
    const now = performance.now();
    return this.entities.filter(e => !e.dead && !e.hitT).map(e => {
      const w = e.sampleWin.filter(p => now - p.t <= 2000);
      if (w.length < 10) return { id: e.id, cat: e.cat, dps: null };
      let dist = 0, moveT = 0;
      for (let k = 1; k < w.length; k++) {
        if (!w[k].moving) continue;
        dist += w[k].acc - w[k - 1].acc;
        moveT += w[k].t - w[k - 1].t;
      }
      const dt = moveT / 1000;
      return { id: e.id, cat: e.cat, dps: dt > 0.1 ? dist / dt : null,
               expected: CC.BASE_SPEED_DPS[e.cat] * CC.config.speed,
               startled: now < e.startleUntil + 300 };
    });
  }

  perfStats() { // E1 rAF 自采 min/avg/p95 帧间隔
    const a = this._frames.slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const p95 = a[Math.floor(a.length * 0.95)];
    return { frames: a.length, minMs: a[0], avgMs: a.reduce((s, v) => s + v, 0) / a.length,
             p95Ms: p95, degradeLevel: this.degradeLevel };
  }
};

CC.SAFE_BELT = 24; // §7/R5 贴边安全带 ≥24dp
CC.perfLog = (tag, obj) => { try { console.log("[CC-PERF]", tag, JSON.stringify(obj)); } catch (e) {} };
