/**
 * ADOFAI 播放器（逻辑层）
 *
 * 判定窗口（对齐原游戏）：
 *   宽判 Wide    ±150ms
 *   标判 Standard ±100ms
 *   严判 Strict   ±60ms
 *
 * 音画同步策略：
 *   加载音频后以 AudioContext 播放头为主时钟（chartTime = audioTime - offset），
 *   视觉严格跟随音频，避免长时间播放产生漂移；
 *   无音频或音频延迟启动时退回 performance.now 单调时钟。
 *   settings.offset（毫秒）参与映射：chartTime 0 对应音频 offset 处。
 */
(function () {
  'use strict';

  const JUDGMENT_MODES = {
    wide: { key: 'wide', name: '宽判', window: 0.150, perfect: 0.075, color: '#7fd7ff' },
    standard: { key: 'standard', name: '标判', window: 0.100, perfect: 0.050, color: '#8affc0' },
    strict: { key: 'strict', name: '严判', window: 0.060, perfect: 0.030, color: '#ffd166' }
  };

  /** 纯函数时钟工具（可在 Node 中单测） */
  const AdofaiAudioClock = {
    offsetSec(settings) {
      const v = parseFloat(settings && settings.offset);
      return isFinite(v) ? v / 1000 : 0;
    },
    chartTimeFromPerf(startPerf, perfNow) {
      return Math.max(0, (perfNow - startPerf) / 1000);
    },
    chartTimeFromAudio(ctxNow, ctxStart, seek, offsetSec) {
      return Math.max(0, (ctxNow - ctxStart) + seek - offsetSec);
    },
    /**
     * 从暂停点开始播放时的音频调度方案
     * @returns {{seek:number, delay:number, audioClockUsable:boolean}}
     */
    schedule(pausedAt, offsetSec) {
      const audioTime = pausedAt + offsetSec;
      if (audioTime >= 0) return { seek: audioTime, delay: 0, audioClockUsable: true };
      return { seek: 0, delay: -audioTime, audioClockUsable: false };
    }
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

      this.clockMode = 'perf';        // 'audio' | 'perf'
      this.audioSeek = 0;
      this.audioStartCtx = 0;
      this.audioStarted = false;
      this._lastCtxTime = -1;
      this._stallFrames = 0;
      this._lastChartTime = 0;

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
      this.audioName = '';
      this.manualOffsetMs = 0;      // 手动音频偏移（正 = 音频延后）
      this._pendingSwitchAt = 0;    // 延迟启动音频后，切换到音频时钟的 AudioContext 时间点

      this._raf = 0;
      this._lastPerf = 0;
      this._autoCursor = 0;
      this._missCursor = 0;

      this.onStateChange = null;
      this.onJudge = null;
      this.onComplete = null;
      this.onAudioChange = null;
      this.onOffsetChange = null;
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
      this._lastChartTime = 0;
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
      if (this.autoplay) this._syncAutoCursor();
      this._emit();
    }

    /**
     * 有效音频偏移（秒）= 谱面 settings.offset - 手动偏移
     * 手动偏移为正 => 音频延后；为负 => 音频提前
     */
    getOffsetSec() {
      const settingsOffset = AdofaiAudioClock.offsetSec(this.level && this.level.settings);
      return settingsOffset - this.manualOffsetMs / 1000;
    }

    /** 设置手动音频偏移（毫秒，-5000 ~ +5000），播放中立即生效 */
    setManualOffsetMs(ms) {
      let v = Number(ms);
      if (!isFinite(v)) v = 0;
      v = Math.round(Math.max(-5000, Math.min(5000, v)));
      if (v === this.manualOffsetMs) return v;

      // 记录旧偏移下当前谱面时间，用于保持播放连续
      const keepTime = this.isPlaying ? this.getTime() : null;
      this.manualOffsetMs = v;
      if (this.onOffsetChange) this.onOffsetChange(v);
      if (this.isPlaying && keepTime != null) this._reanchorForOffset(keepTime);
      return v;
    }

    /**
     * 播放中调整偏移：保持谱面时间连续，把偏移差值转移到音频播放位置
     * （正偏移 => 音频向后回退，负偏移 => 音频向前跳过）
     */
    _reanchorForOffset(keepTime) {
      if (!this.hasAudio || !this.audioCtx) return; // 无音频时由 performance 时钟驱动，无需重锚
      const audioTime = keepTime + this.getOffsetSec();
      const duration = this.audioBuffer ? this.audioBuffer.duration : Infinity;

      this._stopAudio();
      if (audioTime >= duration - 0.02) {
        this.clockMode = 'perf';
        this.startPerf = performance.now() - keepTime * 1000;
        this._pendingSwitchAt = 0;
        return;
      }
      if (audioTime >= 0) {
        this._startAudio(audioTime, 0);
        this.clockMode = 'audio';
      } else {
        // 音频需要延后启动：先用 performance 时钟，到点再切回音频时钟
        this._startAudio(0, -audioTime);
        this.clockMode = 'perf';
        this.startPerf = performance.now() - keepTime * 1000;
      }
      this._syncAutoCursor();
    }

    get hasAudio() { return !!(this.audioCtx && this.audioBuffer); }

    /* ---------------- 音频 ---------------- */

    _ensureCtx() {
      if (!this.audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.audioCtx = new AC();
      }
      return this.audioCtx;
    }

    async loadAudio(file) {
      const ctx = this._ensureCtx();
      if (!ctx) return false;
      try {
        const buf = await file.arrayBuffer();
        const decoded = await ctx.decodeAudioData(buf);
        this.audioBuffer = decoded;
        this.audioName = file.name || 'audio';
        if (this.onAudioChange) this.onAudioChange(this.audioName, decoded.duration);
        this._emit();
        return true;
      } catch (e) {
        console.warn('[ADOFAI] 音频解码失败:', e);
        this.audioBuffer = null;
        this.audioName = '';
        if (this.onAudioChange) this.onAudioChange('');
        return false;
      }
    }

    clearAudio() {
      this._stopAudio();
      this.audioBuffer = null;
      this.audioName = '';
      if (this.onAudioChange) this.onAudioChange('');
      this._emit();
    }

    /** 从 URL 加载音频（用于与谱面同目录的音频自动匹配） */
    async loadAudioUrl(url) {
      const ctx = this._ensureCtx();
      if (!ctx) return false;
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) return false;
        const buf = await res.arrayBuffer();
        const decoded = await ctx.decodeAudioData(buf);
        this.audioBuffer = decoded;
        this.audioName = url.split('/').pop() || url;
        if (this.onAudioChange) this.onAudioChange(this.audioName, decoded.duration);
        this._emit();
        return true;
      } catch (e) {
        return false;
      }
    }

    async resumeAudioContext() {
      if (!this.audioCtx) return;
      if (this.audioCtx.state === 'suspended') {
        try { await this.audioCtx.resume(); } catch (e) {}
      }
    }

    _startAudio(seek, delay) {
      if (!this.audioCtx || !this.audioBuffer) return;
      this._stopAudio();
      const src = this.audioCtx.createBufferSource();
      src.buffer = this.audioBuffer;
      src.connect(this.audioCtx.destination);
      try {
        const d = Math.max(0, delay || 0);
        const startAt = this.audioCtx.currentTime + d;
        src.start(startAt, Math.max(0, seek || 0));
        this.audioSrc = src;
        this.audioSeek = Math.max(0, seek || 0);
        this.audioStartCtx = startAt;
        this.audioStarted = d === 0;
        this._pendingSwitchAt = d > 0 ? startAt : 0;
        this._lastCtxTime = -1;
        this._stallFrames = 0;
      } catch (e) {
        this.audioSrc = null;
        this.audioStarted = false;
        this._pendingSwitchAt = 0;
      }
    }

    _stopAudio() {
      if (this.audioSrc) {
        try { this.audioSrc.stop(); } catch (e) {}
        try { this.audioSrc.disconnect(); } catch (e) {}
        this.audioSrc = null;
      }
      this.audioStarted = false;
      this._pendingSwitchAt = 0;
    }

    /* ---------------- 时钟 ---------------- */

    getTime() {
      if (!this.isPlaying) return this.pausedAt;
      if (this.clockMode === 'audio' && this.audioCtx && this.audioStarted) {
        return AdofaiAudioClock.chartTimeFromAudio(
          this.audioCtx.currentTime, this.audioStartCtx, this.audioSeek, this.getOffsetSec()
        );
      }
      return AdofaiAudioClock.chartTimeFromPerf(this.startPerf, performance.now());
    }

    /** 诊断：返回两种时钟的漂移（毫秒），用于自动化验证音画同步 */
    getClockInfo() {
      const perfTime = AdofaiAudioClock.chartTimeFromPerf(this.startPerf, performance.now());
      let audioTime = null;
      if (this.audioCtx && this.audioStarted) {
        audioTime = AdofaiAudioClock.chartTimeFromAudio(
          this.audioCtx.currentTime, this.audioStartCtx, this.audioSeek, this.getOffsetSec()
        );
      }
      return {
        mode: this.clockMode,
        pendingAudio: !!this._pendingSwitchAt,
        chartTime: this.getTime(),
        perfTime,
        audioTime,
        driftMs: audioTime == null ? null : (audioTime - perfTime) * 1000,
        offsetMs: this.getOffsetSec() * 1000,
        manualOffsetMs: this.manualOffsetMs,
        audioDuration: this.audioBuffer ? this.audioBuffer.duration : null,
        ctxState: this.audioCtx ? this.audioCtx.state : 'none'
      };
    }

    _fallbackToPerf() {
      const t = this._lastChartTime || 0;
      this.clockMode = 'perf';
      this.startPerf = performance.now() - t * 1000;
      this._stallFrames = 0;
    }

    /* ---------------- 播放控制 ---------------- */

    play() {
      if (!this.level || this.level.tiles.length === 0) return;
      if (this.isPlaying) return;

      // 播完后再次播放 => 从头开始
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

      const offsetSec = this.getOffsetSec();
      const plan = AdofaiAudioClock.schedule(this.pausedAt, offsetSec);

      this.isPlaying = true;
      this.startPerf = performance.now() - this.pausedAt * 1000;
      this._lastPerf = performance.now();
      this._lastChartTime = this.pausedAt;
      this.renderer.isPlaying = true;

      this.clockMode = (this.hasAudio && plan.audioClockUsable) ? 'audio' : 'perf';
      this.resumeAudioContext();
      this._startAudio(plan.seek, plan.delay);

      if (this.autoplay) this._syncAutoCursor();

      cancelAnimationFrame(this._raf);
      this._loop();
      this._emit();
    }

    pause() {
      if (!this.isPlaying) return;
      this.pausedAt = this.getTime();
      this.isPlaying = false;
      this.clockMode = 'perf';
      this.renderer.isPlaying = false;
      this._stopAudio();
      cancelAnimationFrame(this._raf);
      this._emit();
    }

    toggle() { this.isPlaying ? this.pause() : this.play(); }

    stop() {
      this.isPlaying = false;
      this.pausedAt = 0;
      this.clockMode = 'perf';
      this.renderer.isPlaying = false;
      this._stopAudio();
      cancelAnimationFrame(this._raf);
      this._emit();
    }

    seek(t) {
      if (!this.level) return;
      const wasPlaying = this.isPlaying;
      const target = Math.max(0, Math.min(t, this.level.duration));
      this.isPlaying = false;
      this._stopAudio();
      cancelAnimationFrame(this._raf);
      this.pausedAt = target;
      this.currentTileIndex = Math.min(
        this.level.tiles.length - 1,
        this._indexAtTime(target)
      );
      // 重置判定状态（跳转后重新开始判定）
      this.hitTiles.clear();
      this.missTiles.clear();
      this.combo = 0;
      this._autoCursor = this.currentTileIndex + 1;
      this._missCursor = this.currentTileIndex;
      this.renderer.currentTileIndex = this.currentTileIndex;
      if (wasPlaying) this.play();
      else this._emit();
    }

    _indexAtTime(t) {
      const timings = this.level.timings;
      let idx = 0;
      while (idx + 1 < timings.length && t >= timings[idx + 1]) idx++;
      return idx;
    }

    /* ---------------- 主循环（仅逻辑） ---------------- */

    _loop = () => {
      if (!this.isPlaying) return;
      const now = performance.now();
      const dt = Math.min(0.1, (now - this._lastPerf) / 1000);
      this._lastPerf = now;

      // 音频延迟启动到点后，从 performance 时钟切换到音频主时钟
      if (this.clockMode === 'perf' && this._pendingSwitchAt && this.audioCtx) {
        if (this.audioCtx.currentTime >= this._pendingSwitchAt) {
          this.audioStarted = true;
          this.clockMode = 'audio';
          this._pendingSwitchAt = 0;
          this._lastCtxTime = -1;
          this._stallFrames = 0;
        }
      }

      // 音频时钟卡住 / 播完 => 回退
      if (this.clockMode === 'audio' && this.audioCtx) {
        const ctxNow = this.audioCtx.currentTime;
        if (ctxNow === this._lastCtxTime) this._stallFrames++;
        else this._stallFrames = 0;
        this._lastCtxTime = ctxNow;

        const endTime = this.audioBuffer ? this.audioBuffer.duration : Infinity;
        const audioTime = ctxNow - this.audioStartCtx + this.audioSeek;
        if (this._stallFrames > 45 || audioTime >= endTime - 0.02) {
          this._fallbackToPerf();
        }
      }

      const t = this.getTime();
      this._lastChartTime = t;
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

      if (this.autoplay) {
        while (this._autoCursor < n && timings[this._autoCursor] <= t + 1e-6) {
          const i = this._autoCursor;
          if (!this.hitTiles.has(i) && !this.missTiles.has(i)) this._hit(i, true);
          this._autoCursor++;
        }
      } else {
        while (this._missCursor < n && t > timings[this._missCursor] + mode.window) {
          const i = this._missCursor;
          if (!this.hitTiles.has(i) && !this.missTiles.has(i)) this._miss(i);
          this._missCursor++;
        }
      }

      let idx = this.currentTileIndex;
      while (idx + 1 < n && t >= timings[idx + 1]) idx++;
      this.currentTileIndex = Math.min(idx, n - 1);

      const startT = timings[this.currentTileIndex];
      const endT = this.currentTileIndex + 1 < n
        ? timings[this.currentTileIndex + 1]
        : Math.max(startT + 0.001, this.level.duration);
      const dur = endT - startT;
      this.progress = dur > 0 ? Math.max(0, Math.min(1, (t - startT) / dur)) : 0;
    }

    _syncAutoCursor() {
      const timings = this.level ? this.level.timings : null;
      if (!timings) return;
      const t = this.getTime();
      let i = 0;
      while (i < timings.length && timings[i] <= t + 1e-6) i++;
      this._autoCursor = i;
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

      if (best < 0 || bestDiff > mode.window) return;
      this._hit(best, bestDiff <= mode.perfect);
    }

    _hit(index, perfect) {
      if (this.hitTiles.has(index)) return;
      this.hitTiles.add(index);
      this.hits++;
      if (perfect) this.perfects++;
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;

      const color = perfect ? '#8affc0' : '#ffd166';
      this.renderer.addHitEffect(index, perfect, color);
      this.renderer.showJudgment(perfect ? 'PERFECT' : 'GOOD', color);
      if (this.onJudge) this.onJudge(perfect ? 'PERFECT' : 'GOOD', color, this.combo);
    }

    _miss(index) {
      this.missTiles.add(index);
      if (this.invincible) {
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
      this.clockMode = 'perf';
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
        modeName: JUDGMENT_MODES[this.mode].name,
        hasAudio: this.hasAudio,
        audioName: this.audioName
      };
    }

    _emit() {
      if (this.onStateChange) this.onStateChange();
    }
  }

  window.AdofaiPlayer = AdofaiPlayer;
  window.JUDGMENT_MODES = JUDGMENT_MODES;
  window.AdofaiAudioClock = AdofaiAudioClock;
})();
