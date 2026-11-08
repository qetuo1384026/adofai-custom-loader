/**
 * ADOFAI 自制谱加载器 - 主应用
 * 单一渲染循环；解析/编辑/播放/判定全部整合
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  let renderer = null;
  let player = null;
  let editor = null;
  let level = null;
  let fileName = '';

  let lastFrame = performance.now();

  /* ---------------- 启动 ---------------- */

  function init() {
    const canvas = $('gameCanvas');
    renderer = new AdofaiRenderer(canvas);
    player = new AdofaiPlayer(renderer);
    editor = new AdofaiEditor(player, renderer);

    sizeCanvas();
    window.addEventListener('resize', sizeCanvas);

    player.onStateChange = syncUI;
    player.onJudge = (text, color, combo) => {
      // 判定文本由渲染器绘制，这里只更新连击
      updateHud();
    };
    player.onComplete = (stats) => {
      toast(`谱面完成 · 准确率 ${stats.accuracy.toFixed(1)}% · 最高连击 ${stats.maxCombo}`);
    };

    editor.onChange = () => {
      refreshTilePanel();
      toast('谱面已修改');
    };

    bindToolbar();
    bindAngleBrush();
    bindEditButtons();
    bindCanvas();
    bindKeyboard();
    setupDragDrop();

    requestAnimationFrame(frame);
    syncUI();
    refreshTilePanel();
    updateHud();
  }

  function sizeCanvas() {
    const box = renderer.canvas.parentElement;
    renderer.resize(box.clientWidth, box.clientHeight);
  }

  /* ---------------- 渲染循环 ---------------- */

  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;

    renderer.update(dt);
    renderer.render();

    // 播放进度 / HUD 低频刷新
    if (player.isPlaying && now - (frame._lastHud || 0) > 120) {
      frame._lastHud = now;
      updateHud();
    }

    requestAnimationFrame(frame);
  }

  /* ---------------- 文件加载 ---------------- */

  async function loadFromText(text, name) {
    try {
      const lvl = new AdofaiLevel(text);
      if (lvl.tileCount === 0) throw new Error('谱面中没有瓷砖数据（pathData / angleData 为空）');
      level = lvl;
      fileName = name || 'level.adofai';
      editor.setLevel(level);
      player.setLevel(level);
      refreshTilePanel();
      updateHud();
      syncUI();
      toast(`已加载 ${fileName} · ${lvl.tileCount} 格 · BPM ${lvl.settings.bpm}`);
    } catch (err) {
      console.error(err);
      toast('加载失败：' + err.message, true);
    }
  }

  async function loadFile(file) {
    if (!file) return;
    const text = await file.text();
    await loadFromText(text, file.name);
  }

  /* ---------------- 工具栏 ---------------- */

  function bindToolbar() {
    $('loadBtn').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => {
      loadFile(e.target.files[0]);
      e.target.value = '';
    });

    $('demoBtn').addEventListener('click', async () => {
      try {
        const res = await fetch('samples/sample-level.adofai');
        if (!res.ok) throw new Error('演示谱面读取失败');
        await loadFromText(await res.text(), 'sample-level.adofai');
      } catch (err) {
        toast(err.message, true);
      }
    });

    $('audioBtn').addEventListener('click', () => $('audioInput').click());
    $('audioInput').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const ok = await player.loadAudio(f);
      toast(ok ? `音频已加载：${f.name}` : '音频解码失败', !ok);
      e.target.value = '';
    });

    $('saveBtn').addEventListener('click', () => {
      if (!level) return toast('请先加载谱面', true);
      const json = level.export();
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName || 'level.adofai';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('谱面已导出');
    });

    $('playBtn').addEventListener('click', () => player.play());
    $('pauseBtn').addEventListener('click', () => player.pause());
    $('stopBtn').addEventListener('click', () => { player.stop(); player.reset(); updateHud(); });
    $('resetBtn').addEventListener('click', () => { player.stop(); player.reset(); updateHud(); toast('已重置'); });

    $('autoplayToggle').addEventListener('change', (e) => player.setAutoplay(e.target.checked));
    $('invincibleToggle').addEventListener('change', (e) => player.setInvincible(e.target.checked));
    $('judgmentSelect').addEventListener('change', (e) => player.setMode(e.target.value));

    $('zoomInBtn').addEventListener('click', () => { renderer.setZoom(renderer.zoomTarget * 1.2); });
    $('zoomOutBtn').addEventListener('click', () => { renderer.setZoom(renderer.zoomTarget / 1.2); });
    $('gridToggle').addEventListener('change', (e) => { renderer.showGrid = e.target.checked; });
  }

  /* ---------------- 角度画笔 ---------------- */

  function bindAngleBrush() {
    const presets = [
      { label: 'R', value: 0, name: '右' },
      { label: 'E', value: 45, name: '右下' },
      { label: 'U', value: 90, name: '下' },
      { label: 'Q', value: 135, name: '左下' },
      { label: 'L', value: 180, name: '左' },
      { label: 'Z', value: 225, name: '左上' },
      { label: 'D', value: 270, name: '上' },
      { label: 'C', value: 315, name: '右上' },
      { label: '!', value: 999, name: 'Midspin' }
    ];

    const box = $('angleBrush');
    presets.forEach((p) => {
      const b = document.createElement('button');
      b.className = 'brush-btn' + (p.value === 999 ? ' midspin' : '');
      b.textContent = p.label;
      b.title = `${p.name}（${p.value === 999 ? 'Midspin' : p.value + '°'}）｜点击应用，Shift+点击在其后插入`;
      b.addEventListener('click', (e) => {
        if (!level) return;
        if (e.shiftKey) editor.insertTile(p.value);
        else {
          if (editor.selectedTile < 0) editor.selectTile(Math.max(0, player.currentTileIndex));
          editor.modifyAngle(p.value);
        }
        refreshTilePanel();
      });
      box.appendChild(b);
    });
  }

  function bindEditButtons() {
    $('insertBtn').addEventListener('click', () => {
      if (!level) return;
      if (editor.selectedTile < 0) editor.selectTile(0);
      const a = level.angleData[editor.selectedTile];
      editor.insertTile(a);
      refreshTilePanel();
    });
    $('deleteBtn').addEventListener('click', () => { editor.deleteTile(); refreshTilePanel(); });
    $('prevBtn').addEventListener('click', () => { editor.selectPrev(); refreshTilePanel(); });
    $('nextBtn').addEventListener('click', () => { editor.selectNext(); refreshTilePanel(); });
    $('nudgeLBtn').addEventListener('click', () => { editor.nudgeAngle(-15); refreshTilePanel(); });
    $('nudgeRBtn').addEventListener('click', () => { editor.nudgeAngle(15); refreshTilePanel(); });
    $('copyBtn').addEventListener('click', () => { editor.copyTile(); toast('已复制当前瓷砖'); });
    $('pasteBtn').addEventListener('click', () => { if (editor.pasteTile()) { refreshTilePanel(); toast('已粘贴'); } });
  }

  /* ---------------- 画布交互 ---------------- */

  function bindCanvas() {
    const canvas = renderer.canvas;
    let drag = null;

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2) return;
      drag = { x: e.clientX, y: e.clientY, camX: renderer.cam.x, camY: renderer.cam.y, moved: false };
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved) {
        const c = Math.cos(-renderer.rot), s = Math.sin(-renderer.rot);
        const wx = (dx * c - dy * s) / renderer.scale;
        const wy = (dx * s + dy * c) / renderer.scale;
        renderer.cam.x = drag.camX - wx;
        renderer.cam.y = drag.camY + wy;
        renderer.camInit = true;
      }
    });

    window.addEventListener('mouseup', (e) => {
      const wasDrag = drag && drag.moved;
      drag = null;
      if (wasDrag) return;
      if (e.target !== canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (player.isPlaying && !player.autoplay) {
        player.hit();
        return;
      }
      // 选中瓷砖（编辑模式）
      const idx = renderer.getTileAt(x, y);
      if (idx >= 0) {
        editor.selectTile(idx);
        refreshTilePanel();
      }
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      renderer.setZoom(renderer.zoomTarget * (e.deltaY > 0 ? 0.9 : 1.1));
    }, { passive: false });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* ---------------- 键盘 ---------------- */

  function bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (player.isPlaying && !player.autoplay) player.hit();
        else player.toggle();
        syncUI();
        return;
      }
      if (e.key === 'Enter' && player.isPlaying && !player.autoplay) {
        e.preventDefault();
        player.hit();
        return;
      }

      switch (e.key) {
        case 'ArrowRight': editor.selectNext(); refreshTilePanel(); break;
        case 'ArrowLeft': editor.selectPrev(); refreshTilePanel(); break;
        case 'Delete':
        case 'Backspace': e.preventDefault(); editor.deleteTile(); refreshTilePanel(); break;
        case '+':
        case '=': editor.nudgeAngle(15); refreshTilePanel(); break;
        case '-':
        case '_': editor.nudgeAngle(-15); refreshTilePanel(); break;
        default:
          if ((e.ctrlKey || e.metaKey) && e.key === 'c') { editor.copyTile(); toast('已复制'); }
          if ((e.ctrlKey || e.metaKey) && e.key === 'v') { editor.pasteTile(); refreshTilePanel(); }
      }
    });
  }

  /* ---------------- 拖拽加载 ---------------- */

  function setupDragDrop() {
    const wrap = $('canvasWrap');
    ['dragenter', 'dragover'].forEach((ev) => {
      wrap.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.add('dropping'); });
    });
    ['dragleave', 'drop'].forEach((ev) => {
      wrap.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.remove('dropping'); });
    });
    wrap.addEventListener('drop', async (e) => {
      const f = e.dataTransfer.files[0];
      if (!f) return;
      if (/\.adofai$/i.test(f.name) || /\.json$/i.test(f.name)) loadFile(f);
      else if (/audio\//.test(f.type)) {
        const ok = await player.loadAudio(f);
        toast(ok ? `音频已加载：${f.name}` : '音频解码失败', !ok);
      } else toast('请拖入 .adofai 谱面或音频文件', true);
    });
  }

  /* ---------------- 面板 / HUD ---------------- */

  function syncUI() {
    const has = !!level;
    $('playBtn').disabled = !has || player.isPlaying;
    $('pauseBtn').disabled = !player.isPlaying;
    $('stopBtn').disabled = !has;
    $('saveBtn').disabled = !has;
    $('judgmentSelect').value = player.mode;
    $('autoplayToggle').checked = player.autoplay;
    $('invincibleToggle').checked = player.invincible;
    const badge = $('modeBadge');
    badge.textContent = JUDGMENT_MODES[player.mode].name;
    badge.style.color = JUDGMENT_MODES[player.mode].color;
    updateHud();
  }

  function updateHud() {
    const s = player.getStats();
    const bar = $('progressFill');
    if (bar) bar.style.width = s.progress.toFixed(2) + '%';
    const tEl = $('timeText');
    if (tEl) tEl.textContent = `${fmt(s.time)} / ${fmt(s.duration)}`;
    const cEl = $('comboText');
    if (cEl) cEl.textContent = s.combo;
    const aEl = $('accText');
    if (aEl) aEl.textContent = s.accuracy.toFixed(1) + '%';

    $('statsPanel').innerHTML = `
      <div class="stat-row"><span>总格数</span><b>${s.total}</b></div>
      <div class="stat-row"><span>击中</span><b>${s.hits}</b></div>
      <div class="stat-row"><span>Perfect</span><b>${s.perfects}</b></div>
      <div class="stat-row"><span>Miss</span><b>${s.misses}</b></div>
      <div class="stat-row"><span>连击</span><b>${s.combo} / ${s.maxCombo}</b></div>
      <div class="stat-row"><span>准确率</span><b>${s.accuracy.toFixed(1)}%</b></div>
      <div class="stat-row"><span>判定</span><b style="color:${JUDGMENT_MODES[s.mode].color}">${s.modeName}${player.invincible ? ' · 无敌' : ''}${player.autoplay ? ' · 自动' : ''}</b></div>
    `;
  }

  function fmt(t) {
    if (!isFinite(t)) return '0:00.0';
    const m = Math.floor(t / 60);
    const sec = t - m * 60;
    return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
  }

  function refreshTilePanel() {
    const box = $('tilePanel');
    const info = editor.getSelectedInfo();
    if (!info) {
      box.innerHTML = '<div class="muted">未选中瓷砖 · 点击轨道上的方块选择</div>';
    } else {
      box.innerHTML = `
        <div class="tile-head">瓷砖 <b>#${info.index}</b> / ${level ? level.tileCount : 0}</div>
        <div class="stat-row"><span>方向角</span><b>${info.direction}°</b></div>
        <div class="stat-row"><span>相对角度</span><b>${info.angle.toFixed(1)}°</b></div>
        <div class="stat-row"><span>拍数</span><b>${info.beats.toFixed(3)}</b></div>
        <div class="stat-row"><span>坐标</span><b>${info.position[0].toFixed(2)}, ${info.position[1].toFixed(2)}</b></div>
        <div class="stat-row"><span>事件</span><b>${info.actionsCount}</b></div>
      `;
    }
    updateHud();
  }

  let toastTimer = null;
  function toast(msg, isError) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
  }

  window.addEventListener('DOMContentLoaded', init);

  // 便于调试与自动化测试
  window.__app = {
    get renderer() { return renderer; },
    get player() { return player; },
    get editor() { return editor; },
    get level() { return level; },
    loadFromText,
    loadFile
  };
})();
