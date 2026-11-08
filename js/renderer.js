/**
 * ADOFAI 风格渲染器
 * 还原原版视觉：霓虹轨道、旋转瓷砖、火/冰双行星、旋转跟随镜头、判定特效
 */
(function () {
  'use strict';

  const TAU = Math.PI * 2;

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function wrapAngle(a) {
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
  }
  function lerpAngle(a, b, t) { return a + wrapAngle(b - a) * t; }

  class AdofaiRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.level = null;

      this.viewWidth = 800;
      this.viewHeight = 600;
      this.zoom = 1;
      this.zoomTarget = 1;
      this.scale = 60;            // 每世界单位的像素数（含 zoom）

      this.cam = { x: 0, y: 0 };
      this.rot = 0;
      this.camInit = false;

      this.currentTileIndex = 0;
      this.progress = 0;
      this.isPlaying = false;
      this.selectedTile = -1;

      this.time = 0;
      this.hitFlash = 0;
      this.effects = [];
      this.judgment = null;

      this.showGrid = true;
      this.trackColor = '#debb7b';
      this.colors = {
        fire: '#ff5b3d',
        ice: '#4cd7ff',
        tileFill: '#121626',
        tileFillPast: '#0b0d16',
        tileEdge: '#4b4560',
        track: '#debb7b',
        trackBright: '#f6dda9'
      };

      // 轨道贴图（程序化无缝生成；若 assets/track-texture.png 存在则优先使用）
      this.trackPattern = null;
      this._trackTexture = null;
      this._planetTrail = { fire: [], ice: [] };
      this._buildTrackTexture();
      this._loadTrackTextureImage();
    }

    /* ---------------- 轨道贴图 ---------------- */

    /**
     * 程序化生成无缝霓虹轨道纹理（256×96）
     * 横向（沿轨道流向）重复，纵向（轨道宽度）呈明暗立体带
     */
    _buildTrackTexture() {
      const W = 256, H = 96;
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      const g = cv.getContext('2d');

      // 轨道截面明暗：边缘暗、中线亮，形成圆润金属带
      const band = g.createLinearGradient(0, 0, 0, H);
      band.addColorStop(0, 'rgba(222,187,123,0.10)');
      band.addColorStop(0.20, 'rgba(246,221,169,0.50)');
      band.addColorStop(0.50, 'rgba(255,244,214,0.86)');
      band.addColorStop(0.80, 'rgba(246,221,169,0.50)');
      band.addColorStop(1, 'rgba(222,187,123,0.10)');
      g.fillStyle = band;
      g.fillRect(0, 0, W, H);

      // 沿流向的横向流光条纹（首尾透明，保证无缝拼接）
      for (let x = 0; x < W; x += 32) {
        const stripe = g.createLinearGradient(x, 0, x + 24, 0);
        stripe.addColorStop(0, 'rgba(255,255,255,0)');
        stripe.addColorStop(0.55, 'rgba(255,255,255,0.34)');
        stripe.addColorStop(0.82, 'rgba(255,250,230,0.10)');
        stripe.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = stripe;
        g.fillRect(x, 2, 28, H - 4);
      }

      // 中线高光
      const core = g.createLinearGradient(0, 0, 0, H);
      core.addColorStop(0.40, 'rgba(255,255,255,0)');
      core.addColorStop(0.50, 'rgba(255,255,255,0.78)');
      core.addColorStop(0.60, 'rgba(255,255,255,0)');
      g.fillStyle = core;
      g.fillRect(0, 0, W, H);

      // 细颗粒，避免大面积死板
      for (let i = 0; i < 120; i++) {
        const px = Math.random() * W;
        const py = Math.random() * H;
        g.fillStyle = `rgba(255,255,255,${0.04 + Math.random() * 0.08})`;
        g.fillRect(px, py, 1.5, 1);
      }

      this._trackTexture = cv;
      this.trackPattern = this.ctx.createPattern(cv, 'repeat');
    }

    /** 若存在外部贴图则覆盖程序化纹理（缺失时静默回退） */
    _loadTrackTextureImage() {
      const img = new Image();
      img.onload = () => {
        try {
          this.trackPattern = this.ctx.createPattern(img, 'repeat');
        } catch (e) { /* 保留程序化纹理 */ }
      };
      img.onerror = () => { /* 无外部贴图，使用程序化纹理 */ };
      img.src = 'assets/track-texture.png';
    }

    /**
     * 用贴图填充一段轨道带（沿线段方向对齐，纹理横跨轨道宽度）
     */
    _fillTrackBand(sx, sy, ex, ey, width) {
      const ctx = this.ctx;
      const dx = ex - sx, dy = ey - sy;
      const len = Math.hypot(dx, dy);
      if (len < 0.6) return;
      const ang = Math.atan2(dy, dx);
      const pat = this.trackPattern;

      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(ang);
      if (pat && typeof DOMMatrix !== 'undefined') {
        try {
          const k = width / 96; // 纹理高度映射到轨道宽度
          pat.setTransform(new DOMMatrix().translate(this.time * 26, 0).scale(k, k));
        } catch (e) { /* 忽略纹理变换失败 */ }
      }
      ctx.fillStyle = pat || 'rgba(246,221,169,0.55)';
      ctx.fillRect(0, -width / 2, len, width);
      ctx.restore();
    }

    /* ---------------- 基础尺寸 / 坐标 ---------------- */

    resize(width, height) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.canvas.style.width = width + 'px';
      this.canvas.style.height = height + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.viewWidth = width;
      this.viewHeight = height;
      this._recalcScale();
    }

    _recalcScale() {
      const base = Math.min(this.viewWidth, this.viewHeight) / 9;
      this.scale = base * this.zoom;
    }

    setLevel(level) {
      this.level = level;
      this.currentTileIndex = 0;
      this.progress = 0;
      this.selectedTile = -1;
      this.effects = [];
      this.judgment = null;
      this._planetTrail = { fire: [], ice: [] };
      this.camInit = false;
      this._updateCameraTarget();
      const t = this._camTarget;
      if (t) { this.cam.x = t.x; this.cam.y = t.y; this.rot = t.rot; this.camInit = true; }
    }

    worldToScreen(wx, wy) {
      const dx = wx - this.cam.x;
      const dy = -(wy - this.cam.y);
      const c = Math.cos(this.rot), s = Math.sin(this.rot);
      return [
        this.viewWidth / 2 + (dx * c - dy * s) * this.scale,
        this.viewHeight / 2 + (dx * s + dy * c) * this.scale
      ];
    }

    screenToWorld(sx, sy) {
      const rx = (sx - this.viewWidth / 2) / this.scale;
      const ry = (sy - this.viewHeight / 2) / this.scale;
      const c = Math.cos(-this.rot), s = Math.sin(-this.rot);
      const dx = rx * c - ry * s;
      const dy = rx * s + ry * c;
      return [this.cam.x + dx, this.cam.y - dy];
    }

    worldRadius() {
      return Math.hypot(this.viewWidth, this.viewHeight) / (2 * this.scale);
    }

    setZoom(z) {
      this.zoomTarget = clamp(z, 0.25, 4);
    }

    /* ---------------- 瓷砖方向信息 ---------------- */

    getTileDirs(i) {
      if (!this.level) return { inDir: 0, outDir: 0, mid: 0, delta: 0 };
      const pos = this.level.positions;
      const p = pos[i] || [0, 0];
      let inDir = null, outDir = null;

      if (i > 0 && pos[i - 1]) {
        const q = pos[i - 1];
        const dx = p[0] - q[0], dy = p[1] - q[1];
        if (dx !== 0 || dy !== 0) inDir = Math.atan2(dy, dx);
      }
      if (pos[i + 1]) {
        const q = pos[i + 1];
        const dx = q[0] - p[0], dy = q[1] - p[1];
        if (dx !== 0 || dy !== 0) outDir = Math.atan2(dy, dx);
      }
      if (inDir === null && outDir === null) inDir = outDir = 0;
      else if (inDir === null) inDir = outDir;
      else if (outDir === null) outDir = inDir;

      const delta = wrapAngle(outDir - inDir);
      return { inDir, outDir, mid: inDir + delta / 2, delta };
    }

    /* ---------------- 镜头 ---------------- */

    _updateCameraTarget() {
      if (!this.level || this.level.tiles.length === 0) { this._camTarget = null; return; }
      const n = this.level.tiles.length;
      const i = clamp(this.currentTileIndex, 0, n - 1);
      const cur = this.level.positions[i] || [0, 0];
      const dirs = this.getTileDirs(i);

      const sx = Math.cos(dirs.inDir), sy = Math.sin(dirs.inDir);
      const lookAhead = 0.55;
      const targetX = cur[0] + sx * lookAhead;
      const targetY = cur[1] + sy * lookAhead;

      // 屏幕坐标系 y 翻转：让行进方向朝上
      const screenAngle = Math.atan2(-sy, sx);
      const rotTarget = -Math.PI / 2 - screenAngle;

      this._camTarget = { x: targetX, y: targetY, rot: rotTarget };
    }

    _smoothCamera(dt) {
      this._updateCameraTarget();
      const t = this._camTarget;
      if (!t) return;

      const kPos = 1 - Math.exp(-dt * 7);
      const kRot = 1 - Math.exp(-dt * 9);

      if (!this.camInit) {
        this.cam.x = t.x; this.cam.y = t.y; this.rot = t.rot; this.camInit = true;
        return;
      }
      this.cam.x = lerp(this.cam.x, t.x, kPos);
      this.cam.y = lerp(this.cam.y, t.y, kPos);
      this.rot = lerpAngle(this.rot, t.rot, kRot);
    }

    /* ---------------- 每帧更新 ---------------- */

    update(dt) {
      this.time += dt;
      this.zoom = lerp(this.zoom, this.zoomTarget, 1 - Math.exp(-dt * 8));
      this._recalcScale();
      this._smoothCamera(dt);

      for (const e of this.effects) { e.life -= dt / e.duration; }
      this.effects = this.effects.filter(e => e.life > 0);

      if (this.judgment) {
        this.judgment.life -= dt / 0.55;
        if (this.judgment.life <= 0) this.judgment = null;
      }
      if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt * 3);
    }

    /* ---------------- 绘制 ---------------- */

    render() {
      const ctx = this.ctx;
      this._drawBackground();

      if (!this.level || this.level.tiles.length === 0) {
        this._drawEmpty();
        return;
      }

      if (this.showGrid) this._drawGrid();
      this._drawTrack();
      this._drawTiles();
      if (this.isPlaying) this._drawPlanets();
      this._drawEffects();
      this._drawJudgment();
      this._drawHud();

      if (this.hitFlash > 0) {
        ctx.fillStyle = `rgba(255,255,255,${this.hitFlash * 0.10})`;
        ctx.fillRect(0, 0, this.viewWidth, this.viewHeight);
      }
    }

    _drawBackground() {
      const ctx = this.ctx, w = this.viewWidth, h = this.viewHeight;
      const g = ctx.createRadialGradient(w / 2, h * 0.55, 0, w / 2, h * 0.55, Math.max(w, h) * 0.8);
      g.addColorStop(0, '#141830');
      g.addColorStop(0.45, '#0a0c18');
      g.addColorStop(1, '#020307');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    _drawEmpty() {
      const ctx = this.ctx;
      ctx.fillStyle = 'rgba(222,187,123,0.6)';
      ctx.font = '600 16px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('拖入 .adofai 谱面文件，或点击左上角「加载谱面」', this.viewWidth / 2, this.viewHeight / 2 - 10);
      ctx.font = '13px "Segoe UI", sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText('支持 pathData / angleData 全部主流自制谱格式', this.viewWidth / 2, this.viewHeight / 2 + 18);
    }

    _drawGrid() {
      const ctx = this.ctx;
      const R = Math.min(30, this.worldRadius() * 1.1);
      const x0 = Math.floor(this.cam.x - R), x1 = Math.ceil(this.cam.x + R);
      const y0 = Math.floor(this.cam.y - R), y1 = Math.ceil(this.cam.y + R);

      ctx.strokeStyle = 'rgba(255,255,255,0.045)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) {
        const a = this.worldToScreen(x, y0), b = this.worldToScreen(x, y1);
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      }
      for (let y = y0; y <= y1; y++) {
        const a = this.worldToScreen(x0, y), b = this.worldToScreen(x1, y);
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
    }

    _drawTrack() {
      const ctx = this.ctx;
      const pos = this.level.positions;
      const n = this.level.tiles.length;
      const R = this.worldRadius() * 1.3;
      const cur = clamp(this.currentTileIndex, 0, n - 1);
      const lw = 0.30 * this.scale;

      const near = (p) => {
        const dx = p[0] - this.cam.x, dy = p[1] - this.cam.y;
        return dx * dx + dy * dy < R * R;
      };
      const visible = (i) => {
        const a = pos[i], b = pos[i + 1];
        return !!(a && b && (near(a) || near(b)));
      };

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // 1) 轨道承托底：深色宽底，衬托贴图亮度
      ctx.strokeStyle = 'rgba(20,18,36,0.88)';
      ctx.lineWidth = lw * 1.52;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (!visible(i)) continue;
        const sa = this.worldToScreen(pos[i][0], pos[i][1]);
        const sb = this.worldToScreen(pos[i + 1][0], pos[i + 1][1]);
        ctx.moveTo(sa[0], sa[1]);
        ctx.lineTo(sb[0], sb[1]);
      }
      ctx.stroke();

      // 2) 贴图轨道带：逐段沿流向填充，纹理横跨轨道宽度
      for (let i = 0; i < n; i++) {
        if (!visible(i)) continue;
        const sa = this.worldToScreen(pos[i][0], pos[i][1]);
        const sb = this.worldToScreen(pos[i + 1][0], pos[i + 1][1]);
        this._fillTrackBand(sa[0], sa[1], sb[0], sb[1], lw);
      }

      // 3) 尚未到达的轨道整体压暗
      ctx.strokeStyle = 'rgba(5,7,16,0.55)';
      ctx.lineWidth = lw * 1.0;
      ctx.beginPath();
      for (let i = cur; i < n; i++) {
        if (!visible(i)) continue;
        const sa = this.worldToScreen(pos[i][0], pos[i][1]);
        const sb = this.worldToScreen(pos[i + 1][0], pos[i + 1][1]);
        ctx.moveTo(sa[0], sa[1]);
        ctx.lineTo(sb[0], sb[1]);
      }
      ctx.stroke();

      // 4) 已走过部分：中线流光 + 辉光
      ctx.save();
      ctx.shadowColor = 'rgba(255,236,190,0.9)';
      ctx.shadowBlur = 0.24 * this.scale;
      ctx.strokeStyle = this.colors.trackBright;
      ctx.lineWidth = lw * 0.42;
      ctx.beginPath();
      for (let i = 0; i < cur; i++) {
        if (!visible(i)) continue;
        const sa = this.worldToScreen(pos[i][0], pos[i][1]);
        const sb = this.worldToScreen(pos[i + 1][0], pos[i + 1][1]);
        ctx.moveTo(sa[0], sa[1]);
        ctx.lineTo(sb[0], sb[1]);
      }
      ctx.stroke();
      ctx.restore();
    }

    _roundPoly(ctx, pts, r) {
      const n = pts.length;
      // 计算每个角的内缩点
      const inner = pts.map((p, i) => {
        const prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
        const v1 = [prev[0] - p[0], prev[1] - p[1]];
        const v2 = [next[0] - p[0], next[1] - p[1]];
        const l1 = Math.hypot(v1[0], v1[1]) || 1;
        const l2 = Math.hypot(v2[0], v2[1]) || 1;
        const rr = Math.min(r, l1 * 0.5, l2 * 0.5);
        return {
          in1: [p[0] + v1[0] / l1 * rr, p[1] + v1[1] / l1 * rr],
          in2: [p[0] + v2[0] / l2 * rr, p[1] + v2[1] / l2 * rr],
          p
        };
      });
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const cur = inner[i], nxt = inner[(i + 1) % n];
        if (i === 0) ctx.moveTo(cur.in2[0], cur.in2[1]);
        else ctx.lineTo(cur.in2[0], cur.in2[1]);
        // 圆角
        const c = inner[(i + 1) % n].p;
        ctx.quadraticCurveTo(c[0], c[1], nxt.in1[0], nxt.in1[1]);
      }
      ctx.closePath();
    }

    _drawTiles() {
      const ctx = this.ctx;
      const tiles = this.level.tiles;
      const R = this.worldRadius() * 1.3;
      const cur = clamp(this.currentTileIndex, 0, tiles.length - 1);
      const half = 0.40;
      const radiusPx = 0.10 * this.scale;

      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        const p = t.position;
        const dx = p[0] - this.cam.x, dy = p[1] - this.cam.y;
        if (dx * dx + dy * dy > R * R) continue;

        const dirs = this.getTileDirs(i);
        const cMid = Math.cos(dirs.mid), sMid = Math.sin(dirs.mid);
        const cornersWorld = [[-half, -half], [half, -half], [half, half], [-half, half]]
          .map(([u, v]) => this.worldToScreen(p[0] + u * cMid - v * sMid, p[1] + u * sMid + v * cMid));

        const isCur = i === cur && this.isPlaying;
        const isSel = i === this.selectedTile;
        const isPast = this.isPlaying && i < cur;

        if (t.isMidspin) {
          const [sx, sy] = this.worldToScreen(p[0], p[1]);
          const r = half * this.scale;
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, TAU);
          ctx.fillStyle = isCur ? '#ffd166' : (isPast ? this.colors.tileFillPast : this.colors.tileFill);
          ctx.fill();
          ctx.strokeStyle = isCur ? '#fff' : this.colors.tileEdge;
          ctx.lineWidth = isCur ? 2.5 : 1.5;
          ctx.stroke();
        } else if (isCur) {
          // 当前瓷砖：发光高亮
          ctx.save();
          ctx.shadowColor = 'rgba(255,255,255,0.85)';
          ctx.shadowBlur = 0.35 * this.scale;
          this._roundPoly(ctx, cornersWorld, radiusPx);
          ctx.fillStyle = '#f6e6c8';
          ctx.fill();
          ctx.restore();

          this._roundPoly(ctx, cornersWorld, radiusPx);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.stroke();
        } else {
          this._roundPoly(ctx, cornersWorld, radiusPx);
          ctx.fillStyle = isPast ? this.colors.tileFillPast : this.colors.tileFill;
          ctx.fill();
          ctx.strokeStyle = isPast ? '#2a2b3a' : this.colors.tileEdge;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }

        if (isSel) {
          ctx.save();
          ctx.setLineDash([6, 4]);
          ctx.strokeStyle = '#4cd7ff';
          ctx.lineWidth = 2;
          this._roundPoly(ctx, cornersWorld, radiusPx);
          ctx.stroke();
          ctx.restore();
        }
      }

      // 终点标记
      const endPos = this.level.positions[tiles.length];
      if (endPos) {
        const [sx, sy] = this.worldToScreen(endPos[0], endPos[1]);
        ctx.beginPath();
        ctx.arc(sx, sy, 0.13 * this.scale, 0, TAU);
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fill();
      }
    }

    _drawPlanets() {
      const ctx = this.ctx;
      const tiles = this.level.tiles;
      const i = clamp(this.currentTileIndex, 0, tiles.length - 1);
      const p = tiles[i].position;
      const dirs = this.getTileDirs(i);
      const axis = dirs.inDir + Math.PI / 2 + this.progress * dirs.delta;
      const orbitR = 0.42;
      const planetR = 0.23;

      const [sx, sy] = this.worldToScreen(p[0], p[1]);
      const orbitPx = orbitR * this.scale;

      // 轨道环：静态底环 + 旋转虚线环
      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, orbitPx, 0, TAU);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(sx, sy, orbitPx, 0, TAU);
      ctx.setLineDash([7, 9]);
      ctx.lineDashOffset = -this.time * 34;
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();

      const wx1 = p[0] + Math.cos(axis) * orbitR;
      const wy1 = p[1] + Math.sin(axis) * orbitR;
      const wx2 = p[0] - Math.cos(axis) * orbitR;
      const wy2 = p[1] - Math.sin(axis) * orbitR;

      const p1 = this.worldToScreen(wx1, wy1);
      const p2 = this.worldToScreen(wx2, wy2);

      // 拖尾（世界坐标记录，避免镜头旋转造成拖影错位）
      this._updateTrail('fire', wx1, wy1, planetR);
      this._updateTrail('ice', wx2, wy2, planetR);
      this._drawTrail('fire', this.colors.fire);
      this._drawTrail('ice', this.colors.ice);

      this._drawPlanet(p1[0], p1[1], planetR * this.scale, this.colors.fire, 0);
      this._drawPlanet(p2[0], p2[1], planetR * this.scale, this.colors.ice, Math.PI);
    }

    _updateTrail(key, wx, wy, r) {
      const list = this._planetTrail[key];
      const last = list[list.length - 1];
      if (!last || Math.hypot(wx - last.x, wy - last.y) > 0.012) {
        list.push({ x: wx, y: wy, t: this.time, r });
        if (list.length > 16) list.shift();
      }
      while (list.length && this.time - list[0].t > 0.20) list.shift();
    }

    _drawTrail(key, color) {
      const ctx = this.ctx;
      const list = this._planetTrail[key];
      if (list.length < 2) return;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (let i = 0; i < list.length - 1; i++) {
        const a = list[i], b = list[i + 1];
        const k = clamp(1 - (this.time - a.t) / 0.20, 0, 1);
        if (k <= 0) continue;
        const sa = this.worldToScreen(a.x, a.y);
        const sb = this.worldToScreen(b.x, b.y);
        ctx.strokeStyle = this._alpha(color, k * 0.26);
        ctx.lineWidth = Math.max(1, a.r * this.scale * 0.62 * k);
        ctx.beginPath();
        ctx.moveTo(sa[0], sa[1]);
        ctx.lineTo(sb[0], sb[1]);
        ctx.stroke();
      }
      ctx.restore();
    }

    _drawPlanet(x, y, r, color, phase) {
      const ctx = this.ctx;
      const pulse = 1 + Math.sin(this.time * 6 + phase) * 0.05;
      const rr = r * pulse;

      // 外层辉光（叠加混合）
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const glow = ctx.createRadialGradient(x, y, rr * 0.2, x, y, rr * 3.6);
      glow.addColorStop(0, this._alpha(color, 0.55));
      glow.addColorStop(0.32, this._alpha(color, 0.26));
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, rr * 3.6, 0, TAU);
      ctx.fill();
      ctx.restore();

      // 本体：偏左上的光源渐变
      const body = ctx.createRadialGradient(x - rr * 0.36, y - rr * 0.38, rr * 0.08, x, y, rr);
      body.addColorStop(0, '#ffffff');
      body.addColorStop(0.30, this._alpha(color, 0.96));
      body.addColorStop(0.78, color);
      body.addColorStop(1, this._alpha(color, 0.70));
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, TAU);
      ctx.fill();

      // 外圈描边
      ctx.beginPath();
      ctx.arc(x, y, rr * 1.06, 0, TAU);
      ctx.strokeStyle = this._alpha(color, 0.55);
      ctx.lineWidth = Math.max(1, rr * 0.07);
      ctx.stroke();

      // 左上边缘高光弧
      ctx.beginPath();
      ctx.arc(x, y, rr * 0.98, Math.PI * 1.02, Math.PI * 1.62);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = Math.max(1, rr * 0.11);
      ctx.stroke();

      // 内核亮点
      const core = ctx.createRadialGradient(x, y, 0, x, y, rr * 0.5);
      core.addColorStop(0, 'rgba(255,255,255,0.95)');
      core.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(x, y, rr * 0.5, 0, TAU);
      ctx.fill();
    }

    _alpha(hex, a) {
      const h = hex.replace('#', '');
      const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
      const r = parseInt(full.slice(0, 2), 16);
      const g = parseInt(full.slice(2, 4), 16);
      const b = parseInt(full.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${a})`;
    }

    addHitEffect(tileIndex, perfect, color) {
      if (!this.level || !this.level.tiles[tileIndex]) return;
      const p = this.level.tiles[tileIndex].position;
      this.effects.push({
        x: p[0], y: p[1], life: 1, duration: 0.45,
        color: color || (perfect ? '#8affc0' : '#ffd166')
      });
      this.hitFlash = perfect ? 0.9 : 0.5;
    }

    _drawEffects() {
      const ctx = this.ctx;
      for (const e of this.effects) {
        const [sx, sy] = this.worldToScreen(e.x, e.y);
        const t = 1 - e.life;
        const r = (0.25 + t * 0.55) * this.scale;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, TAU);
        ctx.strokeStyle = this._alpha(e.color, e.life * 0.9);
        ctx.lineWidth = 3 * e.life + 1;
        ctx.stroke();
      }
    }

    showJudgment(text, color) {
      this.judgment = { text, color, life: 1 };
    }

    _drawJudgment() {
      if (!this.judgment) return;
      const ctx = this.ctx;
      const j = this.judgment;
      const t = 1 - j.life;
      const scaleUp = 1 + t * 0.18;
      const alpha = Math.min(1, j.life * 2.2);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(this.viewWidth / 2, this.viewHeight * 0.22);
      ctx.scale(scaleUp, scaleUp);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 28px "Segoe UI", sans-serif';
      ctx.shadowColor = j.color;
      ctx.shadowBlur = 18;
      ctx.fillStyle = j.color;
      ctx.fillText(j.text, 0, 0);
      ctx.restore();
    }

    getTileAt(sx, sy) {
      if (!this.level) return -1;
      const [wx, wy] = this.screenToWorld(sx, sy);
      let best = -1;
      let bestD = 0.62 * 0.62;
      for (let i = 0; i < this.level.tiles.length; i++) {
        const p = this.level.tiles[i].position;
        const dx = p[0] - wx, dy = p[1] - wy;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    centerOnTile(index) {
      if (!this.level || !this.level.tiles[index]) return;
      this.currentTileIndex = index;
      this.camInit = false;
    }

    _drawHud() {
      const ctx = this.ctx;
      const s = this.level.settings;
      ctx.save();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.globalAlpha = 0.75;
      ctx.font = '600 15px "Segoe UI", sans-serif';
      ctx.fillStyle = '#debb7b';
      ctx.fillText(`${s.artist ? s.artist + ' - ' : ''}${s.song || '未命名'}`, 22, this.viewHeight - 44);
      ctx.font = '12px "Segoe UI", sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(`BPM ${s.bpm}   ·   ${this.level.tiles.length} 格   ·   ${this.currentTileIndex + 1} / ${this.level.tiles.length}`, 22, this.viewHeight - 24);
      ctx.restore();
    }
  }

  window.AdofaiRenderer = AdofaiRenderer;
  window.AdofaiRenderUtils = { lerp, clamp, wrapAngle, lerpAngle };
})();
