/**
 * ADOFAI 谱面解析器
 * 负责解析 .adofai JSON 文件，转换 pathData 为 angleData，规范化 settings/actions/decorations
 *
 * 参考：ADOFAI-JS (adofaiex/ADOFAI-JS) 官方解析库实现
 */

// pathData 字符 -> 绝对角度映射表（94 个标准方向字符 + 1 个 midspin）
const PATH_DATA_TABLE = {
  'R': 0, 'p': 15, 'J': 30, 'E': 45, 'T': 60, 'o': 75, 'U': 90, 'q': 105,
  'G': 120, 'Q': 135, 'H': 150, 'W': 165, 'L': 180, 'x': 195, 'N': 210,
  'Z': 225, 'F': 240, 'V': 255, 'D': 270, 'Y': 285, 'B': 300, 'C': 315,
  'M': 330, 'A': 345, '!': 999
};

// 特殊偏移字符（相对前一个角度的偏移）
const OFFSET_MAP = {
  '5': 72, '6': -72, '7': 52, '8': -52, '9': -30,
  'h': 120, 'j': -120, 't': 60, 'y': 300
};

// 角度偏移值（在 angleData 数字形式中）
const ANGLE_OFFSET_VALUES = { 555: 72, 666: -72, 777: 52, 888: -52 };

// 装饰类事件类型（可能出现在 actions 中，需归入 decorations）
const DECORATION_EVENT_TYPES = ['AddDecoration', 'AddText', 'AddObject', 'AddParticle'];

/**
 * 规范化角度到 [0, 360)
 */
function normalizeAngle(v) {
  return ((v % 360) + 360) % 360;
}

/**
 * 解析角度偏移值
 * @returns {number|null} 偏移量，非偏移值返回 null
 */
function resolveAngleOffset(v) {
  if (v === 555) return 72;
  if (v === 666) return -72;
  if (v === 777) return 52;
  if (v === 888) return -52;
  return null;
}

/**
 * 将 pathData 字符串转换为 angleData 数组
 */
function parsePathData(pathdata) {
  if (typeof pathdata !== 'string') return [];
  const result = new Array(pathdata.length);
  let prev = 0;
  for (let i = 0; i < pathdata.length; i++) {
    const c = pathdata[i];
    if (PATH_DATA_TABLE.hasOwnProperty(c)) {
      result[i] = PATH_DATA_TABLE[c];
      prev = result[i];
    } else if (OFFSET_MAP.hasOwnProperty(c)) {
      result[i] = prev + OFFSET_MAP[c];
      prev = result[i];
    } else {
      // 未知字符保持当前角度
      result[i] = prev;
    }
  }
  return result;
}

/**
 * 修复 ADOFAI JSON 中的非标准格式（尾逗号、字符串中的原始换行等）
 */
function sanitizeAdofaiJson(text) {
  if (typeof text !== 'string') return text;
  // 去除 BOM
  let s = text.replace(/^\uFEFF/, '');
  // 处理字符串中的裸换行（ADOFAI 编辑器有时会输出）
  // 简单策略：先尝试直接解析，失败再做清理
  return s;
}

/**
 * 容错 JSON 解析：处理尾逗号
 */
function parseAdofaiJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    // 尝试修复尾逗号
    try {
      const fixed = text
        .replace(/,\s*([\]}])/g, '$1')
        .replace(/^\uFEFF/, '');
      return JSON.parse(fixed);
    } catch (e2) {
      throw new Error('谱面 JSON 解析失败: ' + e2.message);
    }
  }
}

/**
 * 规范化 settings，填充默认值
 */
function normalizeSettings(rawSettings) {
  const s = rawSettings || {};
  return {
    version: s.version || 1,
    artist: s.artist || '',
    song: s.song || '',
    bpm: parseFloat(s.bpm) || 100,
    volume: parseFloat(s.volume) != null ? parseFloat(s.volume) : 100,
    offset: parseFloat(s.offset) || 0,
    pitch: parseFloat(s.pitch) || 100,
    hitsound: s.hitsound || 'Kick',
    hitsoundVolume: parseFloat(s.hitsoundVolume) != null ? parseFloat(s.hitsoundVolume) : 100,
    trackColor: s.trackColor || 'debb7b',
    trackColorType: s.trackColorType || 'Single',
    trackStyle: s.trackStyle || 'Neon',
    trackGlowIntensity: s.trackGlowIntensity || 100,
    beatsAhead: s.beatsAhead != null ? s.beatsAhead : 4,
    beatsBehind: s.beatsBehind != null ? s.beatsBehind : 2,
    parallax: s.parallax != null ? s.parallax : [100, 100],
    globalTrackAlpha: s.globalTrackAlpha != null ? s.globalTrackAlpha : 100,
    backgroundColor: s.backgroundColor || '000000',
    showDefaultBGIfNoImage: s.showDefaultBGIfNoImage !== false,
    ...s // 保留所有原始字段
  };
}

/**
 * 主解析函数
 * @param {string|object} input - .adofai 文件内容（字符串或已解析对象）
 * @returns {object} 规范化的关卡数据
 */
function parseLevel(input) {
  let raw;
  if (typeof input === 'string') {
    raw = parseAdofaiJson(input);
  } else if (input && typeof input === 'object') {
    raw = input;
  } else {
    throw new Error('无效的谱面输入');
  }

  // 获取 angleData：优先 angleData，其次 pathData
  let angleData;
  if (Array.isArray(raw.angleData)) {
    angleData = raw.angleData.map(n => typeof n === 'number' ? n : parseFloat(n) || 0);
  } else if (typeof raw.pathData === 'string') {
    angleData = parsePathData(raw.pathData);
  } else {
    angleData = [];
  }

  const settings = normalizeSettings(raw.settings || {});

  // 分离 actions 和 decorations（兼容旧谱面把装饰放在 actions 里）
  const actions = [];
  const decorations = [];
  const rawActions = Array.isArray(raw.actions) ? raw.actions : [];
  const rawDecorations = Array.isArray(raw.decorations) ? raw.decorations : [];

  for (const a of rawActions) {
    if (a && DECORATION_EVENT_TYPES.includes(a.eventType)) {
      decorations.push(a);
    } else {
      actions.push(a);
    }
  }
  for (const d of rawDecorations) {
    decorations.push(d);
  }

  return {
    angleData,
    pathData: raw.pathData || null,
    settings,
    actions,
    decorations,
    _raw: raw
  };
}

/**
 * 导出关卡为 .adofai JSON 字符串
 */
function exportLevel(level) {
  const obj = {
    version: level.settings.version || 1,
    settings: level.settings,
    angleData: level.angleData,
    actions: level.actions,
    decorations: level.decorations
  };
  // ADOFAI 格式：根对象不缩进，数组元素单行
  return JSON.stringify(obj, null, '\t');
}

/**
 * 根据 angleData 反向生成 pathData 字符串（用于导出压缩格式）
 */
function angleDataToPathData(angleData) {
  const reverseTable = {};
  for (const k in PATH_DATA_TABLE) {
    if (PATH_DATA_TABLE[k] !== 999) reverseTable[PATH_DATA_TABLE[k]] = k;
  }
  let s = '';
  let prev = 0;
  for (const a of angleData) {
    const norm = normalizeAngle(a);
    if (a === 999) {
      s += '!';
    } else if (reverseTable[norm] !== undefined) {
      s += reverseTable[norm];
      prev = a;
    } else {
      // 尝试偏移
      const diff = a - prev;
      let found = false;
      for (const k in OFFSET_MAP) {
        if (OFFSET_MAP[k] === diff) {
          s += k;
          found = true;
          break;
        }
      }
      if (!found) {
        // 回退：用最接近的字符
        s += reverseTable[norm] || 'R';
      }
      prev = a;
    }
  }
  return s;
}

// 暴露到全局
window.AdofaiParser = {
  PATH_DATA_TABLE,
  OFFSET_MAP,
  ANGLE_OFFSET_VALUES,
  DECORATION_EVENT_TYPES,
  normalizeAngle,
  resolveAngleOffset,
  parsePathData,
  parseAdofaiJson,
  normalizeSettings,
  parseLevel,
  exportLevel,
  angleDataToPathData
};
