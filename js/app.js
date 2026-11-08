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
    player.onAudioChange = () => updateAudioStatus();

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
    startDemoFromQuery();
  }

  /** 支持 ?demo=sync|sample 直接载入示例（含音频/自动播放），便于验证 */
  function startDemoFromQuery() {
    const params = new URLSearchParams(location.search);
    const demo = params.get('demo');
    if (!demo) return;
    const autoplay = params.get('autoplay') === '1';
    if (autoplay) player.setAutoplay(true);
    const map = { sync: 'samples/sync-demo.adofai', sample: 'samples/sample-level.adofai' };
    const url = map[demo] || (demo.endsWith('.adofai') ? demo : null);
    if (!url) return;
    loadUrl(url)
      .then((ok) => {
        if (ok && autoplay) player.play();
      })
      .catch((err) => toast(err.message, true));
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

  /* ---------------- 文件工具 ---------------- */

  const AUDIO_EXTS = ['ogg', 'mp3', 'wav', 'm4a', 'flac', 'aac', 'webm'];
  const filePathMap = new WeakMap();

  function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }
  function isChartFile(f) {
    const e = extOf(f.name);
    return e === 'adofai' || e === 'json';
  }
  function isAudioFile(f) {
    return AUDIO_EXTS.includes(extOf(f.name)) || /^audio\//.test(f.type || '');
  }
  function baseName(name) {
    return (name || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  }
  function normKey(s) {
    return (s || '').toString().toLowerCase().replace(/[\s_\-·.,()\[\]【】（）]+/g, '');
  }
  function relPathOf(f) {
    return f.webkitRelativePath || filePathMap.get(f) || '';
  }

  /**
   * 音频匹配打分：settings.song > 谱面同名 > audio/song/bgm/music 关键字 > ogg 优先
   */
  function scoreAudio(file, wantSong, chartName) {
    const n = normKey(baseName(file.name));
    let s = 0;
    if (wantSong) {
      if (n === wantSong) s += 100;
      else if (n.includes(wantSong) || wantSong.includes(n)) s += 55;
    }
    if (chartName) {
      if (n === chartName) s += 80;
      else if (n.includes(chartName) || chartName.includes(n)) s += 40;
    }
    if (/^(audio|song|bgm|music|soundtrack)$/.test(n)) s += 25;
    if (/\.ogg$/i.test(file.name)) s += 6;
    return s;
  }

  function pickAudioFile(files, settings, chartName) {
    const audios = files.filter(isAudioFile);
    if (audios.length === 0) return null;
    const want = normKey(settings && settings.song);
    const cn = normKey(baseName(chartName));
    let best = null, bestScore = 0;
    for (const f of audios) {
      const sc = scoreAudio(f, want, cn);
      if (sc > bestScore) { bestScore = sc; best = f; }
    }
    if (best && bestScore > 0) return best;
    return audios.length === 1 ? audios[0] : null;
  }

  function pickChartFile(files, hintName) {
    const charts = files.filter(isChartFile);
    if (charts.length === 0) return null;
    if (hintName) {
      const exact = charts.find(f => f.name === hintName);
      if (exact) return exact;
    }
    charts.sort((a, b) =>
      relPathOf(a).split(/[\\/]/).length - relPathOf(b).split(/[\\/]/).length ||
      a.name.length - b.name.length
    );
    return charts[0];
  }

  /* ---------------- 文件加载 ---------------- */

  async function loadFromText(text, name, opts = {}) {
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

      // 谱面 + 音频联动：优先匹配同批文件，其次尝试同目录同名音频
      const audioFiles = opts.audioFiles || [];
      const picked = pickAudioFile(audioFiles, lvl.settings, fileName);
      let audioLoaded = false;
      if (opts.audioUrl) {
        audioLoaded = await player.loadAudioUrl(opts.audioUrl);
      } else if (picked) {
        audioLoaded = await loadAudioFile(picked, { silent: true });
      } else {
        audioLoaded = await trySiblingAudio(opts.baseDir, lvl.settings, fileName);
      }
      if (!audioLoaded) player.clearAudio();
      updateAudioStatus();

      toast(`已加载 ${fileName} · ${lvl.tileCount} 格 · BPM ${lvl.settings.bpm}` +
        (audioLoaded ? ' · 音频已自动匹配' : ' · 未找到音频'));
      return true;
    } catch (err) {
      console.error(err);
      toast('加载失败：' + err.message, true);
      return false;
    }
  }

  async function loadAudioFile(file, opts = {}) {
    const ok = await player.loadAudio(file);
    if (!ok) toast('音频解码失败：' + file.name, true);
    else if (!opts.silent) toast(`音频已加载：${file.name}`);
    updateAudioStatus();
    return ok;
  }

  /** 尝试加载与谱面同目录、同名的音频（仅 http(s) 环境） */
  async function trySiblingAudio(baseDir, settings, chartName) {
    if (!/^https?:$/.test(location.protocol)) return false;
    const dir = (baseDir || '').replace(/\/+$/, '');
    const song = settings && settings.song ? String(settings.song).trim() : '';
    const chartBase = baseName(chartName);
    const names = [];
    if (song) names.push(song);
    if (chartBase && chartBase !== song) names.push(chartBase);
    const exts = ['ogg', 'mp3', 'wav', 'm4a'];
    for (const n of names) {
      for (const ext of exts) {
        const url = (dir ? dir + '/' : '') + n + '.' + ext;
        if (await player.loadAudioUrl(url)) return true;
      }
    }
    return false;
  }

  /** 从 URL 加载谱面（用于演示 / 自动化验证） */
  async function loadUrl(chartUrl, opts = {}) {
    const res = await fetch(chartUrl);
    if (!res.ok) throw new Error('谱面读取失败：' + chartUrl);
    const dir = chartUrl.includes('/') ? chartUrl.slice(0, chartUrl.lastIndexOf('/')) : '';
    return loadFromText(await res.text(), chartUrl.split('/').pop(), {
      baseDir: dir,
      audioUrl: opts.audioUrl
    });
  }

  /** 统一处理文件/文件夹选择结果 */
  async function handleFiles(input, opts = {}) {
    const files = Array.from(input || []);
    if (files.length === 0) return;
    const charts = files.filter(isChartFile);
    const audios = files.filter(isAudioFile);

    if (charts.length === 0) {
      if (audios.length > 0) { await loadAudioFile(audios[0]); return; }
      toast('未找到 .adofai 谱面或音频文件', true);
      return;
    }

    const chart = pickChartFile(charts, opts.chartName);
    const path = relPathOf(chart);
    const baseDir = opts.baseDir !== undefined
      ? opts.baseDir
      : (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

    let text;
    try { text = await chart.text(); } catch (e) { toast('读取谱面失败：' + chart.name, true); return; }
    await loadFromText(text, chart.name, { audioFiles: audios, baseDir });
  }

  async function loadFile(file) {
    if (!file) return;
    await handleFiles([file]);
  }

  /** 读取拖拽目录（递归） */
  function readAllEntries(reader) {
    return new Promise((resolve) => {
      const out = [];
      const next = () => reader.readEntries((entries) => {
        if (entries.length === 0) return resolve(out);
        out.push(...entries);
        next();
      }, () => resolve(out));
      next();
    });
  }

  async function walkEntry(entry, prefix, out) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      filePathMap.set(file, prefix ? prefix + '/' + file.name : file.name);
      out.push(file);
    } else if (entry.isDirectory) {
      const entries = await readAllEntries(entry.createReader());
      const path = prefix ? prefix + '/' + entry.name : entry.name;
      for (const e of entries) await walkEntry(e, path, out);
    }
  }

  async function filesFromDataTransfer(dt) {
    const items = dt.items ? Array.from(dt.items) : [];
    const entries = items
      .map(it => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
      .filter(Boolean);
    if (entries.length > 0) {
      const out = [];
      for (const e of entries) await walkEntry(e, '', out);
      if (out.length > 0) return out;
    }
    return Array.from(dt.files || []);
  }

  function updateAudioStatus() {
    const el = $('audioStatus');
    if (!el) return;
    if (player.hasAudio) {
      el.textContent = `音频 · ${player.audioName || '已加载'}`;
      el.className = 'audio-status ok';
      el.title = '播放时以音频播放头为主时钟，确保音画同步';
    } else {
      el.textContent = '无音频';
      el.className = 'audio-status none';
      el.title = '未匹配到音频，可手动加载 ogg/mp3/wav';
    }
  }

  /* ---------------- 工具栏 ---------------- */

  function bindToolbar() {
    $('loadBtn').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', async (e) => {
      await handleFiles(e.target.files);
      e.target.value = '';
    });

    $('folderBtn').addEventListener('click', () => $('folderInput').click());
    $('folderInput').addEventListener('change', async (e) => {
      await handleFiles(e.target.files);
      e.target.value = '';
    });

    $('demoBtn').addEventListener('click', async () => {
      try {
        await loadUrl('samples/sample-level.adofai');
      } catch (err) {
        toast(err.message, true);
      }
    });

    $('audioBtn').addEventListener('click', () => $('audioInput').click());
    $('audioInput').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (f) await loadAudioFile(f);
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
      const files = await filesFromDataTransfer(e.dataTransfer);
      if (files.length === 0) return;
      await handleFiles(files);
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
    updateAudioStatus();
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

    const clockEl = $('clockText');
    if (clockEl) {
      if (player.isPlaying && player.hasAudio) {
        const info = player.getClockInfo();
        if (info.mode === 'audio' && info.driftMs != null) {
          const drift = info.driftMs;
          clockEl.textContent = '同步 ' + (drift >= 0 ? '+' : '') + drift.toFixed(1) + 'ms';
          clockEl.className = 'clock ok';
        } else {
          clockEl.textContent = '同步 回退';
          clockEl.className = 'clock warn';
        }
      } else {
        clockEl.textContent = '同步 —';
        clockEl.className = 'clock';
      }
    }

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
    get fileName() { return fileName; },
    loadFromText,
    loadFile,
    loadUrl,
    handleFiles,
    pickAudioFile,
    loadAudioFile,
    updateAudioStatus
  };
})();
