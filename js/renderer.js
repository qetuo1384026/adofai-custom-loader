/**
 * ADOFAI 渲染器
 * 基于 Canvas 绘制轨道、瓷砖、双行星系统
 */

class AdofaiRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.level = null;
    this.cameraX = 0;
    this.cameraY = 0;
    this.zoom = 1;
    this.tileSize = 40; // 每个瓷砖的像素大小
    this.planetRadius = 14;
    this.orbitRadius = 26;
    this.currentTileIndex = 0;
    this.progress = 0; // 0~1 当前瓷砖内的进度
    this.isPlaying = false;
    this.selectedTile = -1;
    this.hitFlash = 0; // 击中闪烁计时

    // 行星颜色
    this.fireColor = '#ff6b4a';   // 火（红橙）
    this.iceColor = '#4ac8ff';    // 冰（蓝）
    this.trackColor = '#debb7b';
    this.bgColor = '#0a0a12';
  }

  setLevel(level) {
    this.level = level;
    this.currentTileIndex = 0;
    this.progress = 0;
    this.centerOnTile(0);
  }

  resize(width, height) {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewWidth = width;
    this.viewHeight = height;
  }

  centerOnTile(index) {
    if (!this.level || !this.level.tiles[index]) return;
    const pos = this.level.tiles[index].position;
    this.cameraX = -pos[0] * this.tileSize * this.zoom + this.viewWidth / 2;
    this.cameraY = pos[1] * this.tileSize * this.zoom + this.viewHeight / 2;
  }

  worldToScreen(x, y) {
    return [
      x * this.tileSize * this.zoom + this.cameraX,
      y * this.tileSize * this.zoom + this.cameraY
    ];
  }

  screenToWorld(sx, sy) {
    return [
      (sx - this.cameraX) / (this.tileSize * this.zoom),
      (sy - this.cameraY) / (this.tileSize * this.zoom)
    ];
  }

  /**
   * 主渲染函数
   * @param {number} time - 当前时间（秒）
   */
  render(time) {
    const ctx = this.ctx;
    ctx.fillStyle = this.bgColor;
    ctx.fillRect(0, 0, this.viewWidth, this.viewHeight);

    if (!this.level) {
      this._drawEmptyState();
      return;
    }

    this._drawTrack();
    this._drawTiles(time);
    this._drawPlanets(time);

    if (this.hitFlash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${this.hitFlash * 0.3})`;
      ctx.fillRect(0, 0, this.viewWidth, this.viewHeight);
      this.hitFlash -= 0.05;
    }
  }

  _drawEmptyState() {
    const ctx = this.ctx;
    ctx.fillStyle = '#666';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('请加载一个 .adofai 谱面文件', this.viewWidth / 2, this.viewHeight / 2);
  }

  /**
   * 绘制轨道（连接各瓷砖的线段）
   */
  _drawTrack() {
    const ctx = this.ctx;
    const tiles = this.level.tiles;
    if (tiles.length < 2) return;

    ctx.strokeStyle = this.trackColor;
    ctx.lineWidth = 4 * this.zoom;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.6;

    ctx.beginPath();
    for (let i = 0; i <= tiles.length; i++) {
      const pos = this.level.positions[i] || tiles[i - 1]?.position || [0, 0];
      const [sx, sy] = this.worldToScreen(pos[0], pos[1]);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /**
   * 绘制瓷砖
   */
  _drawTiles(time) {
    const ctx = this.ctx;
    const tiles = this.level.tiles;
    const ts = this.tileSize * this.zoom;

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const [sx, sy] = this.worldToScreen(tile.position[0], tile.position[1]);

      // 跳过屏幕外的瓷砖
      if (sx < -50 || sx > this.viewWidth + 50 || sy < -50 || sy > this.viewHeight + 50) continue;

      const isCurrent = i === this.currentTileIndex;
      const isPast = i < this.currentTileIndex;
      const isSelected = i === this.selectedTile;

      // 瓷砖方块
      const size = ts * 0.7;
      ctx.save();
      ctx.translate(sx, sy);

      if (tile.isMidspin) {
        // midspin 瓷砖：圆形
        ctx.fillStyle = isPast ? '#3a3a4a' : (isCurrent ? '#ffdd55' : '#5a5a7a');
        ctx.beginPath();
        ctx.arc(0, 0, size * 0.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = isPast ? '#2a2a3a' : (isCurrent ? '#ffdd55' : '#4a4a6a');
        ctx.fillRect(-size / 2, -size / 2, size, size);
      }

      // 选中边框
      if (isSelected) {
        ctx.strokeStyle = '#00ff88';
        ctx.lineWidth = 2;
        ctx.strokeRect(-size / 2 - 3, -size / 2 - 3, size + 6, size + 6);
      }

      // 编号
      if (this.zoom > 0.5) {
        ctx.fillStyle = '#fff';
        ctx.font = `${Math.max(8, ts * 0.3)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(i, 0, 0);
      }

      ctx.restore();
    }
  }

  /**
   * 绘制双行星（火与冰）
   */
  _drawPlanets(time) {
    if (!this.isPlaying || this.currentTileIndex >= this.level.tiles.length) return;

    const ctx = this.ctx;
    const tile = this.level.tiles[this.currentTileIndex];
    if (!tile) return;

    const [sx, sy] = this.worldToScreen(tile.position[0], tile.position[1]);
    const orbitR = this.orbitRadius * this.zoom;
    const planetR = this.planetRadius * this.zoom;

    // 行星围绕当前瓷砖旋转
    // angle: 当前进度对应的旋转角度
    // 一拍 = 180度，所以 beats 拍 = beats * 180 度
    const rotAngle = this.progress * tile.angle * (Math.PI / 180);

    // 火行星
    const fireX = sx + Math.cos(rotAngle) * orbitR;
    const fireY = sy + Math.sin(rotAngle) * orbitR;
    this._drawPlanet(fireX, fireY, planetR, this.fireColor);

    // 冰行星（对面）
    const iceX = sx + Math.cos(rotAngle + Math.PI) * orbitR;
    const iceY = sy + Math.sin(rotAngle + Math.PI) * orbitR;
    this._drawPlanet(iceX, iceY, planetR, this.iceColor);

    // 连接线
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(fireX, fireY);
    ctx.lineTo(iceX, iceY);
    ctx.stroke();
  }

  _drawPlanet(x, y, r, color) {
    const ctx = this.ctx;
    // 光晕
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r * 2);
    gradient.addColorStop(0, color);
    gradient.addColorStop(0.5, color + '88');
    gradient.addColorStop(1, 'transparent');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, r * 2, 0, Math.PI * 2);
    ctx.fill();

    // 本体
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * 触发击中闪烁
   */
  flashHit() {
    this.hitFlash = 1;
  }

  /**
   * 获取点击位置对应的瓷砖索引
   */
  getTileAt(screenX, screenY) {
    if (!this.level) return -1;
    const [wx, wy] = this.screenToWorld(screenX, screenY);
    const threshold = 0.5;
    for (let i = 0; i < this.level.tiles.length; i++) {
      const pos = this.level.tiles[i].position;
      const dx = pos[0] - wx;
      const dy = pos[1] - wy;
      if (dx * dx + dy * dy < threshold * threshold) {
        return i;
      }
    }
    return -1;
  }
}

window.AdofaiRenderer = AdofaiRenderer;
