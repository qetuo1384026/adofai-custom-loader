/**
 * ADOFAI 播放器（逻辑层，不负责渲染）
 *
 * 判定窗口（对齐原游戏）：
 *   宽判 Wide    ±150ms
 *   标判 Standard ±100ms
 *   严判 Strict   ±60ms
 *
 * 时间来源：performance.now() 单调时钟；加载音频时以音频时钟为起点对齐。
 */
(function () {
  'use strict';

  const JUDGMENT_MODES = {
    wide: { key: 'wide', name: '宽判', window: 0.150, perfect: 0.075, color: '#7fd7ff' },
    standard: { key: 'standard', name: '标判', window: 0.100, perfect: 0.050, color: '#8affc0' },
    strict: { key: 'strict', name: '严判', window: 0.060, perfect: 0.030, color: '#ffd166' }
  };

  class AdofaiPlayer {
    constructor(renderer) {
      this.renderer = renderer;
      this.level = null;

      this.mode = 'standard';
      this.invincible = false;
      this.autoplay = false;

      this.isPlaying = false;
      this.pausedAt = 0;
      this.startPerf = 0;

      this.currentTileIndex = 0;
      this.progress = 0;

      this.hitTiles = new Set();
      this.missTiles = new Set();
      this.combo = 0;
      this.maxCombo = 0;
      this.hits = 0;
      this.perfects = 0;
      this.misses = 0;

      this.audioCtx = null;
      this.audioBuffer = null;
      this.audioSrc = null;

      this._raf = 0;
      this._lastPerf = 0;
      this._autoCursor = 0;
      this._missCursor = 0;

      this.onStateChange = null;
      this.onJudge = null;
      this.onComplete = null;
    }

    /* ---------------- 配置 ---------------- */

    setLevel(level) {
      this.stop();
      this.level = level;
      this.renderer.setLevel(level);
      this.reset();
    }

    reset() {
      this.isPlaying = false;
      this.pausedAt = 0;
      this.currentTileIndex = 0;
      this.progress = 0;
      this.hitTiles.clear();
      this.missTiles.clear();
      this.combo = 0;
      this.maxCombo = 0;
      this.hits = 0;
      this.perfects = 0;
      this.misses = 0;
      this._autoCursor = 0;
      this._missCursor = 0;
      this.renderer.currentTileIndex = 0;
      this.renderer.progress = 0;
      this.renderer.isPlaying = false;
      this._emit();
    }

    setMode(mode) {
      if (!JUDGMENT_MODES[mode]) return;
      this.mode = mode;
      this._emit();
    }

    setInvincible(v) {
      this.invincible = !!v;
      this._emit();
    }

    setAutoplay(v) {
      this.autoplay = !!v;
      this._emit();
    }

    /* ---------------- 音频 ---------------- */

    async loadAudio(file) {
      try {
        if (!this.audioCtx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          this.audioCtx = new AC();
        }
        const buf = await file.arrayBuffer();
        this.audioBuffer = await this.audioCtx.decodeAudioData(buf);
        return true;
      } catch (e) {
        console.warn('[ADOFAI] 音频解码失败:', e);
        this.audioBuffer = null;
        return false;
      }
    }

    async resumeAudioContext() {
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        try { await this.audioCtx.resume(); } catch (e) {}
      }
    }

    _startAudio(offset) {
      if (!this.audioCtx || !this.audioBuffer) return;
      this._stopAudio();
      this.audioSrc = this.audioCtx.createBufferSource();
      this.audioSrc.buffer = this.audioBuffer;
      this.audioSrc.connect(this.audioCtx.destination);
      try { this.audioSrc.start(0, Math.max(0, offset)); } catch (e) {}
    }

    _stopAudio() {
      if (this.audioSrc) {
        try { this.audioSrc.stop(); } catch (e) {}
        try { this.audioSrc.disconnect(); } catch (e) {}
        this.audioSrc = null;
      }
    }

    /* ---------------- 时钟 ---------------- */

    getTime() {
      if (!this.isPlaying) return this.pausedAt;
      return Math.max(0, (performance.now() - this.startPerf) / 1000);
    }

    /* ---------------- 播放控制 ---------------- */

    play() {
      if (!this.level || this.level.tiles.length === 0) return;
      if (this.isPlaying) return;

      // 播完后再次播放则从头开始
      if (this.pausedAt >= this.level.duration + 0.3) {
        this.pausedAt = 0;
        this.currentTileIndex = 0;
        this.hitTiles.clear();
        this.missTiles.clear();
        this.combo = 0;
        this.hits = 0;
        this.perfects = 0;
        this.misses = 0;
        this._autoCursor = 0;
        this._missCursor = 0;
      }

      this.isPlaying = true;
      this.startPerf = performance.now() - this.pausedAt * 1000;
      this._lastPerf = performance.now();
      this.renderer.isPlaying = true;

      this.resumeAudioContext();
      this._startAudio(this.pausedAt);

      cancelAnimationFrame(this._raf);
      this._loop();
      this._emit();
    }

    pause() {
      if (!this.isPlaying) return;
      this.pausedAt = this.getTime();
      this.isPlaying = false;
      this.renderer.isPlaying = false;
      this._stopAudio();
      cancelAnimationFrame(this._raf);
      this._emit();
    }

    toggle() {
      if (this.isPlaying) this.pause();
      else this.play();
    }

    stop() {
      this.isPlaying = false;
      this.pausedAt = 0;
      this.renderer.isPlaying = false;
      this._stopAudio();
      cancelAnimationFrame(this._raf);
      this._emit();
    }

    /* ---------------- 主循环（仅逻辑） ---------------- */

    _loop = () => {
      if (!this.isPlaying) return;
      const now = performance.now();
      const dt = Math.min(0.1, (now - this._lastPerf) / 1000);
      this._lastPerf = now;

      const t = this.getTime();
      this._advance(t);

      this.renderer.currentTileIndex = this.currentTileIndex;
      this.renderer.progress = this.progress;

      if (t >= this.level.duration + 0.25) {
        this._finish();
        return;
      }
      this._raf = requestAnimationFrame(this._loop);
    };

    _advance(t) {
      const timings = this.level.timings;
      const n = timings.length;
      if (n === 0) return;

      const mode = JUDGMENT_MODES[this.mode];

      // 自动播放
      if (this.autoplay) {
        while (this._autoCursor < n && timings[this._autoCursor] <= t + 1e-6) {
          const i = this._autoCursor;
          if (!this.hitTiles.has(i)) this._hit(i, true);
          this._autoCursor++;
        }
      } else {
        // 超过判定窗口仍未击中 => Miss
        while (this._missCursor < n && t > timings[this._missCursor] + mode.window) {
          const i = this._missCursor;
          if (!this.hitTiles.has(i) && !this.missTiles.has(i)) this._miss(i);
          this._missCursor++;
        }
      }

      // 当前瓷砖索引
      let idx = this.currentTileIndex;
      while (idx + 1 < n && t >= timings[idx + 1]) idx++;
      this.currentTileIndex = Math.min(idx, n - 1);

      // 瓷砖内进度
      const startT = timings[this.currentTileIndex];
      const endT = this.currentTileIndex + 1 < n
        ? timings[this.currentTileIndex + 1]
        : Math.max(startT + 0.001, this.level.duration);
      const dur = endT - startT;
      this.progress = dur > 0 ? Math.max(0, Math.min(1, (t - startT) / dur)) : 0;
    }

    /* ---------------- 判定 ---------------- */

    hit() {
      if (!this.isPlaying || this.autoplay || !this.level) return;
      const t = this.getTime();
      const timings = this.level.timings;
      const n = timings.length;
      const mode = JUDGMENT_MODES[this.mode];

      let best = -1;
      let bestDiff = Infinity;
      const lo = Math.max(0, this._missCursor - 1);
      const hi = Math.min(n, this.currentTileIndex + 2);

      for (let i = lo; i < hi; i++) {
        if (this.hitTiles.has(i) || this.missTiles.has(i)) continue;
        const d = Math.abs(t - timings[i]);
        if (d < bestDiff) { bestDiff = d; best = i; }
      }

      if (best < 0) return;
      // 过早按（还没进入窗口）仍允许，但对过远的无效
      if (bestDiff > mode.window) return;

      this._hit(best, bestDiff <= mode.perfect);
    }

    _hit(index, perfect) {
      if (this.hitTiles.has(index)) return;
      this.hitTiles.add(index);
      this.hits++;
      if (perfect) this.perfects++;
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;

      const mode = JUDGMENT_MODES[this.mode];
      const color = perfect ? '#8affc0' : '#ffd166';
      this.renderer.addHitEffect(index, perfect, color);
      this.renderer.showJudgment(perfect ? 'PERFECT' : 'GOOD', color);
      if (this.onJudge) this.onJudge(perfect ? 'PERFECT' : 'GOOD', color, this.combo);
    }

    _miss(index) {
      this.missTiles.add(index);
      if (this.invincible) {
        // 无敌模式：不打断连击、不增加 Miss 计数
        this.renderer.showJudgment('无敌', '#7fd7ff');
        return;
      }
      this.misses++;
      this.combo = 0;
      this.renderer.showJudgment('MISS', '#ff5b6e');
      if (this.onJudge) this.onJudge('MISS', '#ff5b6e', 0);
    }

    _finish() {
      this.isPlaying = false;
      this.renderer.isPlaying = false;
      this._stopAudio();
      cancelAnimationFrame(this._raf);
      this.renderer.showJudgment('COMPLETE', '#debb7b');
      if (this.onComplete) this.onComplete(this.getStats());
      this._emit();
    }

    /* ---------------- 统计 ---------------- */

    getStats() {
      const total = this.level ? this.level.tiles.length : 0;
      const judged = this.hits + this.misses;
      return {
        total,
        hits: this.hits,
        perfects: this.perfects,
        misses: this.misses,
        combo: this.combo,
        maxCombo: this.maxCombo,
        accuracy: judged > 0 ? (this.hits / judged) * 100 : 100,
        progress: this.level && this.level.duration > 0
          ? Math.min(100, this.getTime() / this.level.duration * 100) : 0,
        time: this.getTime(),
        duration: this.level ? this.level.duration : 0,
        mode: this.mode,
        modeName: JUDGMENT_MODES[this.mode].name
      };
    }

    _emit() {
      if (this.onStateChange) this.onStateChange();
    }
  }

  window.AdofaiPlayer = AdofaiPlayer;
  window.JUDGMENT_MODES = JUDGMENT_MODES;
})();
