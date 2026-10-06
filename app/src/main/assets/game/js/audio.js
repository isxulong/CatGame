/* audio.js — WebAudio 程序音效（零素材、全离线）：环境嗡鸣（按目标个体）+ 命中音。
 * E4：「嗡鸣戛然而止」= 被命中目标个体的环境音停止，非全局停顿。 */
window.CC = window.CC || {};

CC.audio = (function () {
  let ctx = null;
  const hums = new Map(); // "ns:entityId" -> {osc, gain, lfo}（R2-05 加固：按引擎命名空间隔离，杜绝跨引擎 id 相撞误杀）
  const keyOf = (ns, id) => (ns || "main") + ":" + id;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
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
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.value = ent.cat === "butterfly" ? 120 : ent.cat === "bee" ? 170 : 210;
    lfo.frequency.value = ent.cat === "butterfly" ? 4 : 13;
    lfoGain.gain.value = 18;
    lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
    gain.gain.value = 0.0;
    gain.gain.linearRampToValueAtTime(0.035, ctx.currentTime + 0.4);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); lfo.start();
    hums.set(k, { osc, gain, lfo });
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

  /* 命中音：短促拍击噪声（默认关）；环境音开启时的「戛然而止」由 stopHum 承担 */
  function hit() {
    if (!CC.config.sndHit || !ensure()) return;
    const dur = 0.09;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 900; f.Q.value = 0.8;
    const g = ctx.createGain(); g.gain.value = 0.25;
    src.connect(f); f.connect(g); g.connect(ctx.destination);
    src.start();
  }

  return { startHum, stopHum, stopAll, hit, humCount };
})();
