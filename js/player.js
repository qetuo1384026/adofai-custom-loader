/**
 * ADOFAI 播放器
 * 负责自动播放、交互判定、音频同步、判定模式与无敌模式
 *
 * 判定窗口（参考原游戏）：
 *   - 宽判 (Wide):    ±150ms
 *   - 标判 (Standard): ±100ms
 *   - 严判 (Strict):   ±60ms
 */

const JUDGMENT_MODES = {
  wide: { name: '宽判', window: 0.150, perfectWindow: 0.080 },
  standard: { name: '标判', window: 0.100, perfectWindow: 0.050 },
  strict: { name: '严判', window: 0.060, perfectWindow: 0.030 }
};

class AdofaiPlayer {
  constructor(renderer) {
    this.renderer = renderer;
    this.level = null;
    this.audio = null;
    this.audioCtx = null;
    this.audioSource = null;
    this.audioBuffer = null;

    this.isPlaying = false;
    this.isPaused = false;
    this.isAutoplay = false;

    this.currentTileIndex = 0;
    this.progress = 0;      // 当前瓷砖内进度 0~1
    this.startTime = 0;     // 音频开始时间（performance.now）
    this.pausedAt = 0;
    this.audioStartTime = 0;

    this.judgmentMode = 'standard';
    this.invincible = false;

    this.hitTiles = new Set();
    this.missTiles = new Set();
    this.combo = 0;
    this.maxCombo = 0;
    this.hitCount = 0;
    this.missCount = 0;
    this.perfectCount = 0;

    this.onStateChange = null;   // 状态变化回调
    this.onTileHit = null;       // 击中回调
    this.onTileMiss = null;      // miss 回调
    this.onComplete = null;      // 完成回调

    this._lastFrameTime = 0;
    this._animationId = null;
    this._hitsoundQueue = [];
  }

  setLevel(level) {
    this.level = level;
    this.renderer.setLevel(level);
    this.reset();
  }

  setJudgmentMode(mode) {
    if (JUDGMENT_MODES[mode]) {
      this.judgmentMode = mode;
      if (this.onStateChange) this.onStateChange();
    }
  }

  setInvincible(v) {
    this.invincible = v;
    if (this.onStateChange) this.onStateChange();
  }

  setAutoplay(v) {
    this.isAutoplay = v;
    if (this.onStateChange) this.onStateChange();
  }

  reset() {
    this.stop();
    this.currentTileIndex = 0;
    this.progress = 0;
    this.hitTiles.clear();
    this.missTiles.clear();
    this.combo = 0;
    this.maxCombo = 0;
    this.hitCount = 0;
    this.missCount = 0;
    this.perfectCount = 0;
    if (this.renderer) {
      this.renderer.currentTileIndex = 0;
      this.renderer.progress = 0;
    }
  }

  /**
   * 加载音频文件
   */
  async loadAudio(file) {
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      const arrayBuffer = await file.arrayBuffer();
      this.audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);
      return true;
    } catch (e) {
      console.warn('音频加载失败:', e);
      return false;
    }
  }

  /**
   * 开始播放
   */
  play() {
    if (!this.level || this.level.tiles.length === 0) return;
    if (this.isPlaying) return;

    this.isPlaying = true;
    this.isPaused = false;
    this._lastFrameTime = performance.now();

    // 播放音频
    if (this.audioBuffer) {
      this._playAudio();
    }

    this._loop();
    if (this.onStateChange) this.onStateChange();
  }

  _playAudio() {
    if (!this.audioCtx || !this.audioBuffer) return;
    try {
      if (this.audioSource) {
        this.audioSource.stop();
      }
    } catch (e) {}
    this.audioSource = this.audioCtx.createBufferSource();
    this.audioSource.buffer = this.audioBuffer;
    this.audioSource.connect(this.audioCtx.destination);
    const offset = Math.max(0, this.getPlaybackTime());
    this.audioSource.start(0, offset);
    this.audioStartTime = this.audioCtx.currentTime - offset;
  }

  pause() {
    if (!this.isPlaying) return;
    this.isPaused = true;
    this.isPlaying = false;
    this.pausedAt = this.getPlaybackTime();
    if (this.audioSource) {
      try { this.audioSource.stop(); } catch (e) {}
      this.audioSource = null;
    }
    cancelAnimationFrame(this._animationId);
    if (this.onStateChange) this.onStateChange();
  }

  stop() {
    this.isPlaying = false;
    this.isPaused = false;
    if (this.audioSource) {
      try { this.audioSource.stop(); } catch (e) {}
      this.audioSource = null;
    }
    cancelAnimationFrame(this._animationId);
  }

  /**
   * 获取当前播放时间（秒）
   */
  getPlaybackTime() {
    if (this.isPlaying && this.audioCtx && this.audioStartTime != null) {
      return this.audioCtx.currentTime - this.audioStartTime;
    }
    return this.pausedAt || 0;
  }

  /**
   * 主循环
   */
  _loop = () => {
    if (!this.isPlaying) return;

    const now = performance.now();
    const dt = (now - this._lastFrameTime) / 1000;
    this._lastFrameTime = now;

    const currentTime = this.getPlaybackTime();
    this._updateByTime(currentTime);

    // 自动播放模式：自动击中所有瓷砖
    if (this.isAutoplay) {
      this._autoplayUpdate(currentTime);
    }

    this.renderer.isPlaying = this.isPlaying;
    this.renderer.currentTileIndex = this.currentTileIndex;
    this.renderer.progress = this.progress;
    this.renderer.render(now / 1000);

    this._animationId = requestAnimationFrame(this._loop);
  };

  /**
   * 根据当前时间更新瓷砖进度
   */
  _updateByTime(currentTime) {
    const timings = this.level.timings;
    if (!timings || timings.length === 0) return;

    // 找到当前时间所在的瓷砖
    let idx = 0;
    for (let i = 0; i < timings.length; i++) {
      if (currentTime >= timings[i]) {
        idx = i;
      } else {
        break;
      }
    }

    // 自动前进未击中的瓷砖（非自动播放模式下，未击中的瓷砖会在超过窗口后判定 miss）
    if (idx > this.currentTileIndex) {
      for (let i = this.currentTileIndex; i < idx; i++) {
        if (!this.hitTiles.has(i) && !this.missTiles.has(i)) {
          this._registerMiss(i);
        }
      }
    }

    this.currentTileIndex = Math.min(idx, timings.length - 1);

    // 计算当前瓷砖内的进度
    const tile = this.level.tiles[this.currentTileIndex];
    if (tile) {
      const tileStart = timings[this.currentTileIndex];
      const tileEnd = this.currentTileIndex < timings.length - 1
        ? timings[this.currentTileIndex + 1]
        : tileStart + tile.beats * 60 / (this.level.settings.bpm || 100);
      const duration = tileEnd - tileStart;
      this.progress = duration > 0 ? Math.min(1, (currentTime - tileStart) / duration) : 0;
    }

    // 相机跟随
    if (this.renderer.level) {
      this.renderer.centerOnTile(this.currentTileIndex);
    }

    // 检查是否完成
    if (currentTime >= this.level.duration) {
      this._finish();
    }
  }

  /**
   * 自动播放：在每个瓷砖的精确时间点自动击中
   */
  _autoplayUpdate(currentTime) {
    const timings = this.level.timings;
    for (let i = 0; i < timings.length; i++) {
      if (Math.abs(currentTime - timings[i]) < 0.016 && !this.hitTiles.has(i)) {
        this._registerHit(i, true);
      }
    }
  }

  /**
   * 玩家输入：尝试击中当前瓷砖
   */
  hit() {
    if (!this.isPlaying || this.isAutoplay) return;

    const timings = this.level.timings;
    const currentTime = this.getPlaybackTime();
    const mode = JUDGMENT_MODES[this.judgmentMode];
    const window = mode.window;

    // 找到最接近当前时间的未击中瓷砖
    let bestIdx = -1;
    let bestDiff = Infinity;
    for (let i = Math.max(0, this.currentTileIndex - 1); i < Math.min(timings.length, this.currentTileIndex + 2); i++) {
      if (this.hitTiles.has(i) || this.missTiles.has(i)) continue;
      const diff = Math.abs(currentTime - timings[i]);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) return;

    if (bestDiff <= window) {
      const perfect = bestDiff <= mode.perfectWindow;
      this._registerHit(bestIdx, perfect);
    }
    // 超出窗口的输入不做处理（原游戏中过早/过晚的按键不计入）
  }

  /**
   * 注册击中
   */
  _registerHit(index, perfect) {
    if (this.hitTiles.has(index)) return;
    this.hitTiles.add(index);
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.hitCount++;
    if (perfect) this.perfectCount++;
    this.renderer.flashHit();
    if (this.onTileHit) this.onTileHit(index, perfect, this.combo);
  }

  /**
   * 注册 miss
   */
  _registerMiss(index) {
    if (this.invincible) {
      // 无敌模式：不算 miss，但也不计入 combo
      this.missTiles.add(index);
      return;
    }
    if (this.missTiles.has(index)) return;
    this.missTiles.add(index);
    this.combo = 0;
    this.missCount++;
    if (this.onTileMiss) this.onTileMiss(index);
  }

  _finish() {
    this.isPlaying = false;
    if (this.audioSource) {
      try { this.audioSource.stop(); } catch (e) {}
      this.audioSource = null;
    }
    cancelAnimationFrame(this._animationId);
    if (this.onComplete) this.onComplete();
    if (this.onStateChange) this.onStateChange();
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      total: this.level ? this.level.tiles.length : 0,
      hits: this.hitCount,
      misses: this.missCount,
      perfect: this.perfectCount,
      combo: this.combo,
      maxCombo: this.maxCombo,
      accuracy: this.hitCount + this.missCount > 0
        ? (this.hitCount / (this.hitCount + this.missCount) * 100) : 0
    };
  }
}

window.AdofaiPlayer = AdofaiPlayer;
window.JUDGMENT_MODES = JUDGMENT_MODES;
