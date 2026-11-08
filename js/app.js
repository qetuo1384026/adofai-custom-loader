/**
 * ADOFAI 自制谱加载器 - 主应用
 * 整合解析器、数据模型、渲染器、播放器、编辑器
 */

(function () {
  'use strict';

  // ===== 全局状态 =====
  let renderer, player, editor;
  let currentLevel = null;
  let currentFileName = '';

  // ===== DOM 引用 =====
  const $ = (id) => document.getElementById(id);

  const canvas = $('gameCanvas');
  const fileInput = $('fileInput');
  const audioInput = $('audioInput');
  const loadBtn = $('loadBtn');
  const playBtn = $('playBtn');
  const pauseBtn = $('pauseBtn');
  const stopBtn = $('stopBtn');
  const autoplayToggle = $('autoplayToggle');
  const invincibleToggle = $('invincibleToggle');
  const judgmentSelect = $('judgmentSelect');
  const tileInfo = $('tileInfo');
  const statsPanel = $('statsPanel');
  const angleButtons = $('angleButtons');
  const statusBar = $('statusBar');
  const saveBtn = $('saveBtn');
  const zoomInBtn = $('zoomInBtn');
  const zoomOutBtn = $('zoomOutBtn');

  // ===== 初始化 =====
  function init() {
    renderer = new AdofaiRenderer(canvas);
    player = new AdofaiPlayer(renderer);
    editor = new AdofaiEditor(player, renderer);

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    setupEventListeners();
    setupAngleButtons();

    player.onStateChange = updateUI;
    player.onTileHit = (idx, perfect) => {
      showStatus(`击中 #${idx} ${perfect ? 'Perfect!' : 'Good!'}  Combo: ${player.combo}`);
    };
    player.onTileMiss = (idx) => {
      showStatus(`Miss #${idx}`, true);
    };
    player.onComplete = () => {
      showStatus('谱面完成！');
      updateStats();
    };

    editor.onChange = () => {
      updateTileInfo();
      showStatus('谱面已修改');
    };

    // 启动空闲渲染循环
    idleRender();
  }

  function resizeCanvas() {
    const container = canvas.parentElement;
    renderer.resize(container.clientWidth, container.clientHeight);
  }

  function idleRender() {
    if (!player.isPlaying) {
      renderer.isPlaying = false;
      renderer.currentTileIndex = player.currentTileIndex;
      renderer.progress = player.progress;
      renderer.render(performance.now() / 1000);
    }
    requestAnimationFrame(idleRender);
  }

  // ===== 事件监听 =====
  function setupEventListeners() {
    loadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileLoad);
    audioInput.addEventListener('change', handleAudioLoad);

    playBtn.addEventListener('click', () => {
      if (currentLevel) player.play();
    });
    pauseBtn.addEventListener('click', () => player.pause());
    stopBtn.addEventListener('click', () => { player.stop(); player.reset(); updateUI(); });

    autoplayToggle.addEventListener('change', (e) => {
      player.setAutoplay(e.target.checked);
    });
    invincibleToggle.addEventListener('change', (e) => {
      player.setInvincible(e.target.checked);
    });
    judgmentSelect.addEventListener('change', (e) => {
      player.setJudgmentMode(e.target.value);
    });

    saveBtn.addEventListener('click', saveLevel);

    zoomInBtn.addEventListener('click', () => {
      renderer.zoom = Math.min(3, renderer.zoom * 1.2);
      if (editor.selectedTile >= 0) renderer.centerOnTile(editor.selectedTile);
    });
    zoomOutBtn.addEventListener('click', () => {
      renderer.zoom = Math.max(0.2, renderer.zoom / 1.2);
      if (editor.selectedTile >= 0) renderer.centerOnTile(editor.selectedTile);
    });

    // 编辑操作按钮
    $('insertTileBtn').addEventListener('click', () => {
      if (!currentLevel) return;
      const curAngle = editor.selectedTile >= 0 ? currentLevel.angleData[editor.selectedTile] : 0;
      if (editor.insertTile(curAngle)) updateTileInfo();
    });
    $('nudgeLeftBtn').addEventListener('click', () => {
      if (editor.nudgeAngle(-15)) updateTileInfo();
    });
    $('nudgeRightBtn').addEventListener('click', () => {
      if (editor.nudgeAngle(15)) updateTileInfo();
    });
    $('deleteTileBtn').addEventListener('click', () => {
      if (editor.deleteTile()) updateTileInfo();
    });

    // 键盘输入
    window.addEventListener('keydown', handleKeyDown);

    // 鼠标点击瓷砖
    canvas.addEventListener('click', handleCanvasClick);

    // 播放时的击中按键
    canvas.addEventListener('click', () => {
      if (player.isPlaying && !player.isAutoplay) {
        player.hit();
      }
    });
  }

  function handleKeyDown(e) {
    // 播放中：空格/回车击中
    if (player.isPlaying && !player.isAutoplay) {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        player.hit();
        return;
      }
    }

    // 播放控制
    if (e.code === 'Space' && !player.isPlaying) {
      if (currentLevel) {
        e.preventDefault();
        player.play();
      }
      return;
    }

    // 编辑模式快捷键
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    if (e.key === 'ArrowRight') { editor.selectNext(); updateTileInfo(); }
    else if (e.key === 'ArrowLeft') { editor.selectPrev(); updateTileInfo(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (editor.deleteTile()) updateTileInfo();
    }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'c') { editor.copyTile(); showStatus('已复制瓷砖'); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'v') { if (editor.pasteTile()) updateTileInfo(); }
    else if (e.key === '+' || e.key === '=') { editor.nudgeAngle(15); updateTileInfo(); }
    else if (e.key === '-' || e.key === '_') { editor.nudgeAngle(-15); updateTileInfo(); }
  }

  function handleCanvasClick(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const idx = renderer.getTileAt(x, y);
    if (idx >= 0) {
      editor.selectTile(idx);
      updateTileInfo();
    }
  }

  // ===== 角度按钮 =====
  function setupAngleButtons() {
    editor.anglePresets.forEach((preset) => {
      const btn = document.createElement('button');
      btn.className = 'angle-btn';
      btn.textContent = preset.label;
      btn.title = `${preset.name || preset.label} (${preset.value}°)`;
      btn.addEventListener('click', (e) => {
        if (e.shiftKey) {
          editor.insertTile(preset.value);
        } else {
          editor.modifyAngle(preset.value);
        }
        updateTileInfo();
      });
      angleButtons.appendChild(btn);
    });

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '点击修改当前瓷砖角度 | Shift+点击 在当前瓷砖后插入';
    angleButtons.appendChild(hint);
  }

  // ===== 文件加载 =====
  async function handleFileLoad(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const level = new AdofaiLevel(text);
      currentLevel = level;
      currentFileName = file.name;
      editor.setLevel(level);
      player.setLevel(level);
      updateUI();
      updateTileInfo();
      showStatus(`已加载: ${file.name} (${level.tileCount} 个瓷砖)`);
    } catch (err) {
      showStatus(`加载失败: ${err.message}`, true);
      console.error(err);
    }
  }

  async function handleAudioLoad(e) {
    const file = e.target.files[0];
    if (!file) return;
    const ok = await player.loadAudio(file);
    showStatus(ok ? `音频已加载: ${file.name}` : '音频加载失败', !ok);
  }

  // ===== 保存 =====
  function saveLevel() {
    if (!currentLevel) return;
    const json = currentLevel.export();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentFileName || 'level.adofai';
    a.click();
    URL.revokeObjectURL(url);
    showStatus('已保存谱面文件');
  }

  // ===== UI 更新 =====
  function updateUI() {
    playBtn.disabled = !currentLevel || player.isPlaying;
    pauseBtn.disabled = !player.isPlaying;
    stopBtn.disabled = !currentLevel;
    updateStats();
  }

  function updateTileInfo() {
    const info = editor.getSelectedInfo();
    if (!info) {
      tileInfo.innerHTML = '<div class="muted">未选中瓷砖</div>';
      return;
    }
    tileInfo.innerHTML = `
      <div><strong>瓷砖 #${info.index}</strong></div>
      <div>方向角: ${info.direction}°</div>
      <div>相对角度: ${info.angle.toFixed(1)}°</div>
      <div>拍数: ${info.beats.toFixed(3)}</div>
      <div>位置: (${info.position[0].toFixed(2)}, ${info.position[1].toFixed(2)})</div>
      <div>事件数: ${info.actionsCount}</div>
    `;
  }

  function updateStats() {
    const s = player.getStats();
    statsPanel.innerHTML = `
      <div>总数: ${s.total}</div>
      <div>击中: ${s.hits} (Perfect: ${s.perfect})</div>
      <div>Miss: ${s.misses}</div>
      <div>Combo: ${s.combo} / 最高 ${s.maxCombo}</div>
      <div>准确率: ${s.accuracy.toFixed(1)}%</div>
      <div>判定: ${JUDGMENT_MODES[player.judgmentMode].name} ${player.invincible ? '| 无敌' : ''} ${player.isAutoplay ? '| 自动' : ''}</div>
    `;
  }

  function showStatus(msg, isError) {
    statusBar.textContent = msg;
    statusBar.className = 'status-bar' + (isError ? ' error' : '');
    setTimeout(() => {
      if (statusBar.textContent === msg) statusBar.textContent = '';
    }, 3000);
  }

  // ===== 启动 =====
  window.addEventListener('DOMContentLoaded', init);
})();
