/**
 * ADOFAI 关卡数据模型
 * 负责计算瓷砖的相对角度（节拍数）、坐标位置、Twirl 状态
 *
 * 算法基于 ADOFAI-JS 官方库的 parseAngle / calculateTilePositions 实现
 */

(function () {
  const { normalizeAngle, resolveAngleOffset } = window.AdofaiParser;

/**
 * 计算单个瓷砖的相对角度（即需要旋转多少拍）
 * @param {number[]} agd - angleData 数组
 * @param {number} i - 当前瓷砖索引
 * @param {{value: number}} angleDir - 角度方向状态（初始 180）
 * @param {number} isTwirl - 当前 twirl 奇偶性（0 或 1）
 * @returns {number} 相对角度（拍数 = angle / 180）
 */
function parseAngle(agd, i, angleDir, isTwirl) {
  let prev = 0;
  if (i === 0) angleDir.value = 180;

  const offset = resolveAngleOffset(agd[i]);
  if (offset !== null) {
    // 偏移角（555/666/777/888）
    const prevDir = normalizeAngle(angleDir.value - 180);
    const actualDir = normalizeAngle(prevDir + offset);
    const delta = normalizeAngle(angleDir.value - actualDir);
    prev = isTwirl === 0 ? delta : normalizeAngle(360 - delta);
    if (prev === 0) prev = 360;
    angleDir.value = normalizeAngle(actualDir + 180);
  } else if (agd[i] === 999) {
    // midspin：延续上一个方向
    let minus = 1;
    while (i - minus >= 0 && agd[i - minus] === 999) minus++;
    const realAngle = i - minus >= 0 ? agd[i - minus] : 0;
    angleDir.value = normalizeAngle(realAngle + (minus - 1) * 180);
    if (isNaN(angleDir.value)) angleDir.value = 0;
    prev = 0;
  } else {
    // 普通绝对角度
    const delta = normalizeAngle(angleDir.value - agd[i]);
    prev = isTwirl === 0 ? delta : normalizeAngle(360 - delta);
    if (prev === 0) prev = 360;
    angleDir.value = normalizeAngle(agd[i] + 180);
  }
  return prev;
}

/**
 * 创建瓷砖数组
 * @param {object} level - 解析后的关卡数据
 * @returns {object[]} 瓷砖数组
 */
function createTiles(level) {
  const angleData = level.angleData;
  const xLength = angleData.length;
  const tiles = new Array(xLength);

  // 按 floor 分组 actions
  const actionsByFloor = new Map();
  const decorationsByFloor = new Map();

  for (const a of level.actions || []) {
    if (a.eventType === 'AddDecoration' || a.eventType === 'AddText' ||
        a.eventType === 'AddObject' || a.eventType === 'AddParticle') {
      const list = decorationsByFloor.get(a.floor) || [];
      list.push(a);
      decorationsByFloor.set(a.floor, list);
    } else {
      const list = actionsByFloor.get(a.floor) || [];
      list.push(a);
      actionsByFloor.set(a.floor, list);
    }
  }
  for (const d of level.decorations || []) {
    const list = decorationsByFloor.get(d.floor) || [];
    list.push(d);
    decorationsByFloor.set(d.floor, list);
  }

  const angleDir = { value: 180 };
  let twirl = 0;

  for (let i = 0; i < xLength; i++) {
    const floorActions = actionsByFloor.get(i) || [];
    const floorDecos = decorationsByFloor.get(i) || [];

    // Twirl 事件翻转方向
    for (const a of floorActions) {
      if (a.eventType === 'Twirl') twirl++;
    }

    const angle = parseAngle(angleData, i, angleDir, twirl % 2);
    tiles[i] = {
      index: i,
      direction: angleData[i],      // 原始角度值
      angle: angle,                  // 相对角度（拍数 = angle/180）
      beats: angle / 180,            // 拍数
      actions: floorActions,
      decorations: floorDecos,
      twirl: twirl,
      position: [0, 0],
      isMidspin: angleData[i] === 999
    };
  }

  return tiles;
}

/**
 * 计算所有瓷砖的坐标位置
 * @param {object} level
 * @param {object[]} tiles
 * @returns {number[][]} 每个瓷砖的 [x, y] 坐标（含终点）
 */
function calculateTilePositions(level, tiles) {
  const angleData = level.angleData;
  const totalTiles = tiles.length;
  const positions = [];
  const startPos = [0, 0];

  // PositionTrack 事件偏移
  const positionTrackMap = new Map();
  for (const a of level.actions || []) {
    if (a.eventType === 'PositionTrack' && a.positionOffset) {
      if (a.editorOnly !== true && a.editorOnly !== 'Enabled') {
        positionTrackMap.set(a.floor, a);
      }
    }
  }

  // 解析浮动角度（处理偏移和 midspin）
  const floats = new Array(totalTiles);
  for (let i = 0; i < totalTiles; i++) {
    const offset = resolveAngleOffset(angleData[i]);
    if (offset !== null) {
      floats[i] = (i > 0 ? floats[i - 1] : 0) + offset;
    } else {
      floats[i] = angleData[i];
    }
  }
  for (let i = 0; i < totalTiles; i++) {
    if (floats[i] === 999) {
      let minus = 1;
      while (i - minus >= 0 && floats[i - minus] === 999) minus++;
      const realAngle = i - minus >= 0 ? floats[i - minus] : 0;
      floats[i] = realAngle + (minus - 1) * 180;
    }
  }

  for (let i = 0; i <= totalTiles; i++) {
    const posTrack = positionTrackMap.get(i);
    if (posTrack && posTrack.positionOffset) {
      startPos[0] += posTrack.positionOffset[0];
      startPos[1] += posTrack.positionOffset[1];
    }
    const tempPos = [startPos[0], startPos[1]];
    positions.push(tempPos);
    if (tiles[i]) {
      tiles[i].position = tempPos;
    }
    if (i < totalTiles) {
      const rad = floats[i] * Math.PI / 180;
      startPos[0] += Math.cos(rad);
      startPos[1] += Math.sin(rad);
    }
  }

  return positions;
}

/**
 * 计算每个瓷砖的时间点（秒），基于 BPM 和 SetSpeed 事件
 * @param {object} level
 * @param {object[]} tiles
 * @returns {number[]} 每个瓷砖的时间戳（秒）
 */
function calculateTileTimings(level, tiles) {
  const bpm = level.settings.bpm || 100;
  const baseBeatDuration = 60 / bpm; // 一拍的秒数

  // 收集 SetSpeed 事件
  const speedEvents = new Map();
  for (const a of level.actions || []) {
    if (a.eventType === 'SetSpeed') {
      speedEvents.set(a.floor, a);
    }
  }

  const timings = new Array(tiles.length);
  let currentTime = 0;
  let currentSpeed = 1;

  for (let i = 0; i < tiles.length; i++) {
    // 检查 SetSpeed
    const speedEvt = speedEvents.get(i);
    if (speedEvt) {
      if (speedEvt.speedType === 'Bpm' || speedEvt.speedType === 'Multiplier') {
        currentSpeed = parseFloat(speedEvt.speed) || 1;
      }
    }

    timings[i] = currentTime;

    // 下一个瓷砖的时间增量 = 拍数 * 每拍秒数 / 速度
    if (i < tiles.length - 1) {
      const beats = tiles[i].beats;
      const duration = beats * baseBeatDuration / currentSpeed;
      currentTime += duration;
    }
  }

  return timings;
}

/**
 * Level 类：封装完整关卡数据
 */
class AdofaiLevel {
  constructor(rawInput) {
    if (typeof rawInput === 'string' || (rawInput && typeof rawInput === 'object' && !rawInput.angleData)) {
      this.parsed = window.AdofaiParser.parseLevel(rawInput);
    } else {
      this.parsed = rawInput;
    }
    this.settings = this.parsed.settings;
    this.angleData = this.parsed.angleData;
    this.actions = this.parsed.actions;
    this.decorations = this.parsed.decorations;
    this.tiles = [];
    this.positions = [];
    this.timings = [];
    this.rebuild();
  }

  /**
   * 重新构建瓷砖、位置、时间
   */
  rebuild() {
    this.tiles = createTiles(this.parsed);
    this.positions = calculateTilePositions(this.parsed, this.tiles);
    this.timings = calculateTileTimings(this.parsed, this.tiles);
  }

  /**
   * 获取瓷砖数量
   */
  get tileCount() {
    return this.tiles.length;
  }

  /**
   * 获取总时长（秒）
   */
  get duration() {
    if (this.timings.length === 0) return 0;
    const last = this.timings[this.timings.length - 1];
    const lastTile = this.tiles[this.tiles.length - 1];
    if (!lastTile) return last;
    const bpm = this.settings.bpm || 100;
    return last + (lastTile.beats * 60 / bpm);
  }

  /**
   * 在指定索引插入瓷砖
   */
  insertTile(index, direction) {
    this.angleData.splice(index, 0, direction);
    this._shiftActions(index, 1);
    this.rebuild();
  }

  /**
   * 删除指定索引瓷砖
   */
  deleteTile(index) {
    if (index < 0 || index >= this.angleData.length) return;
    this.angleData.splice(index, 1);
    this._shiftActions(index, -1);
    this.rebuild();
  }

  /**
   * 修改瓷砖角度
   */
  setTileDirection(index, direction) {
    if (index < 0 || index >= this.angleData.length) return;
    this.angleData[index] = direction;
    this.rebuild();
  }

  /**
   * 导出为 .adofai JSON
   */
  export() {
    return window.AdofaiParser.exportLevel({
      settings: this.settings,
      angleData: this.angleData,
      actions: this.actions,
      decorations: this.decorations
    });
  }

  /**
   * 内部：插入/删除瓷砖时调整 actions 的 floor 索引
   */
  _shiftActions(atIndex, delta) {
    const shift = (arr) => {
      for (const a of arr) {
        if (a.floor >= atIndex) {
          a.floor = Math.max(0, a.floor + delta);
        }
      }
    };
    shift(this.actions);
    shift(this.decorations);
  }
}

window.AdofaiLevel = AdofaiLevel;
window.AdofaiModel = {
  parseAngle,
  createTiles,
  calculateTilePositions,
  calculateTileTimings
};
})();
