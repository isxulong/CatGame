/* data.js — 常量、配置默认值、品类参数表（v2.1 A1/A3 附录留档值） */
window.CC = window.CC || {};

CC.CATS = ["housefly", "butterfly", "bee", "mouse", "goldfish", "ladybug"];
CC.CAT_LABEL = { housefly: "苍蝇", butterfly: "蝴蝶", bee: "蜜蜂", mouse: "老鼠", goldfish: "金鱼", ladybug: "瓢虫" };

/* A1 品类基准宽度 dp（M0 素材入库后按真实比例目检敲定，已留档 manifest.base_width_dp）
 * R4-06 需求5：大小差异收敛基准表（与 manifest.base_width_dp 两处同步改；1.0× 最大/最小比 66/38≈1.74≤1.8，排序不变） */
CC.BASE_WIDTH_DP = { ladybug: 38, housefly: 40, bee: 44, butterfly: 50, mouse: 62, goldfish: 66 };

/* A3 品类基础速度表 dp/s（暂定值，M1 调优后留档；验收 = 引擎内逐帧路径长度采样 ±10%） */
CC.BASE_SPEED_DPS = { housefly: 260, butterfly: 120, bee: 220, mouse: 300, goldfish: 140, ladybug: 90 };

CC.BGS = ["wood", "grass", "tile", "carpet", "desk", "black"];
CC.BG_LABEL = { wood: "木地板", grass: "草地", tile: "瓷砖", carpet: "地毯", desk: "浅色桌面", black: "纯黑" };

CC.FX_TYPES = ["ripple", "paw", "stars", "particles"];
CC.FX_LABEL = { ripple: "涟漪扩散", paw: "爪印", stars: "星星迸发", particles: "粒子四散" };

/* R9 背景角标数据源：F7 终裁结果（替代已过期的 dY 预筛 manifest.prescreen——预筛 36 组 25 组
 * 不推荐与终裁矛盾）。真不推荐 3 组挂红角标；边缘可用 1 组弱化样式（R4-11 收窄：移除苍蝇×黑）。 */
CC.F7_VERDICT = {
  notRecommended: [["housefly", "wood"], ["housefly", "carpet"], ["bee", "carpet"]],
  marginal: [["mouse", "carpet"]]
};

/* R4-11 需求1配套：深色背景名单与低可见度品类（黑背景下苍蝇 chip 置灰提示，仅提示不禁选） */
CC.DARK_BGS = ["black"];
CC.LOWVIS_CATS = ["housefly"];

/* R4/R5/B1 安全与判定常量（默认值，全部可在隐藏调试档覆盖 —— 配置化判定模块 B1） */
CC.DEFAULTS = {
  config: {                       // 主人设置（面板状态即真值 C2）
    size: 1.0,                    // 体积倍率 0.25–6 步进 0.25（R4-05）
    speed: 1.0,                   // 速度倍率 0.25–6 步进 0.25（R4-05）
    count: 3,                     // 同屏数量 1–20（R4-05）
    cats: ["butterfly"],          // R4-12 需求0：默认仅蝴蝶（A2 多选至少 1；store.load 合并语义保证老配置不改写）
    bg: "desk",  // R4-12 需求0：默认背景=浅色桌面（desk，manifest meanY 190.3 最亮木纹款）；仅首装/清数据生效
    fxOn: true, fxType: "ripple", // R4 总开关 + 单选
    sndAmbient: false,            // 环境音（默认关）
    sndHit: false,                // 命中音（默认关）
    showScore: false,             // 计分默认隐藏（E6 不可交互显示元素）
    panelIdleSec: 60              // C2 面板空闲自动保存返回（暂定值，面板内可调）
  },
  debug: {                        // 隐藏调试档（B1/A5/E2 全参数配置化）
    startleR: 150,                // A5 受惊半径 dp（暂定）
    startleMul: 2.0,              // A5 受惊速度倍率（暂定）
    startleMs: 1000,              // A5 1s 后线性恢复
    areaThreshMm2: 250,           // R6：阈值上提 250mm²（原 200 落在人类用力按压范围 227mm² 内），真机校准后留档
    areaConsecFrames: 3,          // B1 连续多帧大面积才否决
    minorMajorRatio: 0.8,         // 椭圆面积换算 minor=major*ratio
    calibWindowN: 20,             // B3 标定缺失检测窗口 N≥20（偏严格：全恒定才判缺失）
    maxPointers: 5,               // R4 同时触点 >5 判猫掌
    moveRetriggerDp: 48,          // D5 滑动触点每移动 ≥48dp 触发一次动效（暂定）
    maxFxInstances: 5,            // D5 同屏动效实例上限
    degradeLowFps: 30, degradeLowSec: 3,   // E2 连续 3s <30fps 逐级降级
    degradeHighFps: 45, degradeHighSec: 10,// E2 恢复需连续 10s ≥45fps
    degradeDwellSec: 30,          // E2 每级最小驻留 30s
    forceDegrade: 0,              // E2 调试档强制降帧开关 0=关 1..3=强制级别
    lineTest: false               // A3 直线匀速测试模式（交叉验证用）
  }
};

CC.store = {
  load(key, def) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return JSON.parse(JSON.stringify(def));
      return Object.assign(JSON.parse(JSON.stringify(def)), JSON.parse(raw));
    } catch (e) { return JSON.parse(JSON.stringify(def)); }
  },
  save(key, obj) { try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {} }
};
