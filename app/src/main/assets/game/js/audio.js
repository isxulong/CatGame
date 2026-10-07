/* audio.js — WebAudio 程序音效（零素材、全离线）：环境嗡鸣（按目标个体）+ 命中音。
 * E4：「嗡鸣戛然而止」= 被命中目标个体的环境音停止，非全局停顿。
 * R6-06：嗡鸣链路重写——osc → lowpass（800–1200Hz，暂定 1000）→ 个体增益（0.012）
 *   → humBus → 动态压缩（-18dB / 4:1，限制多只叠加总响度）→ master → destination；
 *   响度红线：嗡鸣叠加总增益 ≤ 命中音峰值 × 1/4（压缩器兜底，参数全部入 CC.config.tuning）。
 * R6-07：命中音增益 0.25 → 0.7，时长 90ms → 135ms，指数衰减包络（120–150ms）。 */
window.CC = window.CC || {};

CC.audio = (function () {
  let ctx = null;
  let humBus = null, comp = null, master = null; // R6-06：嗡鸣总线 + 压缩 + 主增益（懒建，随 ctx 一次性装配）
  const hums = new Map(); // "ns:entityId" -> {osc, gain, lfo, lp}（R2-05 加固：按引擎命名空间隔离，杜绝跨引擎 id 相撞误杀）
  const keyOf = (ns, id) => (ns || "main") + ":" + id;

  function T() { return (CC.config && CC.config.tuning) || {}; }

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      // R6-06：装配 hum → humBus → compressor → master → destination 固定链路
      const t = T();
      humBus = ctx.createGain();
      humBus.gain.value = t.humBusGain != null ? t.humBusGain : 1.0;
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = t.compThresholdDb != null ? t.compThresholdDb : -18;
      comp.ratio.value = t.compRatio != null ? t.compRatio : 4;
      master = ctx.createGain();
      master.gain.value = 1.0;
      humBus.connect(comp); comp.connect(master); master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  /* 环境音：飞行类（苍蝇/蜜蜂/蝴蝶）每个存活目标一个低频嗡鸣振荡器 */
  function startHum(ent, ns) {
    if (!CC.config.sndAmbient) return;
    if (!["housefly", "bee", "butterfly"].includes(ent.cat)) return;
    const k = keyOf(ns, ent.id);
    if (hums.has(k) || !ensure()) return;
    const t = T();
    const osc = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();           // R6-06：低通柔化锯齿波毛刺
    const gain = ctx.createGain();
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.value = ent.cat === "butterfly" ? 120 : ent.cat === "bee" ? 170 : 210;
    lp.type = "lowpass";
    lp.frequency.value = t.humLowpassHz != null ? t.humLowpassHz : 1000; // R6-06：800–1200Hz 暂定 1000
    lfo.frequency.value = ent.cat === "butterfly" ? 4 : 13;
    lfoGain.gain.value = 18;
    lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
    const target = t.humGain != null ? t.humGain : 0.012; // R6-06：0.01–0.015 暂定 0.012
    gain.gain.value = 0.0;
    gain.gain.linearRampToValueAtTime(target, ctx.currentTime + 0.4);
    osc.connect(lp); lp.connect(gain); gain.connect(humBus); // R6-06：经总线 + 压缩，不直连 destination
    osc.start(); lfo.start();
    hums.set(k, { osc, gain, lfo, lp });
  }

  /* 命中：该目标个体嗡鸣戛然而止（E4） */
  function stopHum(entId, ns) {
    const k = keyOf(ns, entId);
    const h = hums.get(k);
    if (!h) return;
    try {
      h.gain.gain.cancelScheduledValues(ctx.currentTime);
      h.gain.gain.setValueAtTime(h.gain.gain.value, ctx.currentTime);
      h.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.03);
      h.osc.stop(ctx.currentTime + 0.05); h.lfo.stop(ctx.currentTime + 0.05);
    } catch (e) {}
    hums.delete(k);
  }

  function stopAll() {
    for (const k of Array.from(hums.keys())) {
      const h = hums.get(k);
      try {
        h.gain.gain.cancelScheduledValues(ctx.currentTime);
        h.gain.gain.setValueAtTime(h.gain.gain.value, ctx.currentTime);
        h.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.03);
        h.osc.stop(ctx.currentTime + 0.05); h.lfo.stop(ctx.currentTime + 0.05);
      } catch (e) {}
      hums.delete(k);
    }
  }

  /* R2-05 回归验证用只读统计：按命名空间计存活嗡鸣数 */
  function humCount(ns) {
    if (!ns) return hums.size;
    let n = 0;
    for (const k of hums.keys()) if (k.startsWith(ns + ":")) n++;
    return n;
  }

  /* 命中音：短促拍击噪声（默认关）；环境音开启时的「戛然而止」由 stopHum 承担
   * R6-07：增益 0.7（0.6–0.8）、时长 135ms（120–150）、指数衰减包络 */
  function hit() {
    if (!CC.config.sndHit || !ensure()) return;
    const t = T();
    const dur = (t.hitDurMs != null ? t.hitDurMs : 135) / 1000;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-4 * i / d.length); // R6-07：指数衰减
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 900; f.Q.value = 0.8;
    const g = ctx.createGain(); g.gain.value = t.hitGain != null ? t.hitGain : 0.7; // R6-07：0.6–0.8 暂定 0.7
    src.connect(f); f.connect(g); g.connect(ctx.destination);
    src.start();
  }

  return { startHum, stopHum, stopAll, hit, humCount };
})();
