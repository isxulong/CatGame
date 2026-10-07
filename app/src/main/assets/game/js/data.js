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

/* R6-05：F7_VERDICT 静态名单整体下线——匹配档位改为按规则动态计算。
 * 规则语义（清单裁决 5）：「不推荐」只能由 dY 直接命中，dH（色相差）与高纹理标记仅辅助收紧；
 * 输入数据（36 组 dY/dH/纹理标记）离线预计算写入 manifest.match，运行时只读表 + 算术判定
 *（运行时零图像处理架构不动摇）。阈值为真机校准项，集中 CC.config.tuning.match 可调。
 * R7-01（终裁 B 案）：新增近黑专项分支——bg ∈ nearBlack.bgs 且 dY < nearBlack.dyMax → 不推荐，
 * 修复苍蝇×纯黑（dY=67.8）落入 (dyAux, dyMax) 真空带不挂标的缺陷；名单化配置，后续近黑背景只改配置。 */
CC.MATCH_RULE_VER = "R6-05.v2";

/* R6-04：DARK_BGS / LOWVIS_CATS 置灰提示体系整体下线（与动态「不推荐」徽标不得并存）。
 * 苍蝇×纯黑由 R6-05 动态规则判定挂红底「不推荐」徽标（同位置/样式/尺寸），仅提示不禁选。 */

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
    panelIdleSec: 60,             // C2 面板空闲自动保存返回（暂定值，面板内可调）
    /* R6 真机校准项集中区（清单第四章阈值表；调参不改代码、不碰面板语义）。
     * 全部为暂定值，真机目检/听感校准后在此改值留档，第四章同步修订。 */
    tuning: {
      /* R6-06 环境声（清单阈值表暂定值） */
      humGain: 0.012,             // 环境声单体增益（区间 0.01–0.015，初始 0.012）
      humLowpassHz: 1000,         // 环境声低通频率（区间 800–1200Hz，调听后定）
      humBusGain: 1.0,            // 环境声总线增益（DynamicsCompressor 前）
      compThresholdDb: -18,       // 总线压缩器阈值
      compRatio: 4,               // 总线压缩器压缩比
      /* R6-07 命中音 */
      hitGain: 0.7,               // 命中音峰值增益（区间 0.6–0.8，初始 0.7；相对响度参照线 ≥4:1 叠加口径）
      hitDurMs: 135,              // 命中音时长（区间 120–150ms，指数衰减包络）
      /* R6-09 真实感浮动（裁决 1：品类内个体方差，spawn 定终身，均值锚定用户设定值） */
      varSizeAmp: 0.10,           // 体积个体浮动幅度 ±10%（clamp 0.85–1.15）
      varSpeedAmp: 0.15,          // 速度个体浮动幅度 ±15%（clamp 0.85–1.15）
      spdCompPerSize: 0.5,        // 速体负相关：sizeMul 每偏 +1% → spdMul 补 -0.5%
      spdCompMax: 0.05,           // 速体负相关补偿总量上限 ±5%
      /* R6-05 匹配度规则阈值（语义：「不推荐」只能由 dY 直接命中，dH/纹理仅辅助收紧） */
      match: {
        dyMain: 40,               // 主分支：dY < 40 → 不推荐
        dyAux: 60, dhAux: 30,     // 辅助分支一：dY < 60 且 dH < 30° → 不推荐
        dyTex: 50, dhTex: 45,     // 辅助分支二：高纹理 且 dY < 50 且 dH < 45° → 不推荐
        dyRec: 80, dhRec: 45,     // 推荐档：dY ≥ 80 且 dH ≥ 45°（默认不挂标）
        highTextureBgs: ["grass", "carpet"], // 高纹理背景名单（静态属性）
        /* R7-01（终裁 B 案）近黑专项分支：bg ∈ bgs 且 dY < dyMax → 不推荐。
         * dY 直接命中、bg 名单仅收紧，与既有高纹理辅助分支同构，不违反裁决 5；
         * 名单化——后续新增近黑背景只改本配置，dyMain/dyAux/dyTex/dH 各阈值一律不动。 */
        nearBlack: { bgs: ["black"], dyMax: 80 },
        showRecommendBadge: false // 「推荐」绿标为可配置项，默认关
      }
    }
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
    maxFxInstances: 8,            // R6-08（裁决 7）：同屏动效实例上限 5→8，溢出策略改为回收最旧实例（effects.js）
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
