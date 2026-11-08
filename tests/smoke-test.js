/**
 * 烟雾测试 - 验证解析器、数据模型核心逻辑
 * 在 Node.js 环境下运行（模拟浏览器全局）
 */

// 模拟浏览器环境
global.window = {};

// 加载模块
require('../js/parser.js');
require('../js/level.js');

const { AdofaiParser, AdofaiLevel, AdofaiModel } = global.window;

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

console.log('=== ADOFAI 自制谱加载器 烟雾测试 ===\n');

// 测试 1: pathData 解析
console.log('1. pathData 解析');
const pathResult = AdofaiParser.parsePathData('REJW');
assert(Array.isArray(pathResult), '返回数组');
assert(pathResult[0] === 0, 'R -> 0°');
assert(pathResult[1] === 45, 'E -> 45°');
assert(pathResult[2] === 30, 'J -> 30°');
assert(pathResult[3] === 165, 'W -> 165°');

// 测试 2: midspin 字符
console.log('\n2. Midspin 字符');
const midspinResult = AdofaiParser.parsePathData('R!R');
assert(midspinResult[1] === 999, '! -> 999');

// 测试 3: 偏移字符
console.log('\n3. 偏移字符 (5/6/7/8/9/h/j/t/y)');
const offsetResult = AdofaiParser.parsePathData('R5');
assert(offsetResult[1] === 72, '5 -> +72 偏移 (0+72=72)');
const offsetResult2 = AdofaiParser.parsePathData('R6');
assert(offsetResult2[1] === -72, '6 -> -72 偏移 (0-72=-72)');

// 测试 4: 完整关卡解析
console.log('\n4. 完整关卡解析');
const sampleData = {
  settings: { bpm: 120, song: 'Test' },
  angleData: [180, 90, 0, 270],
  actions: [{ floor: 0, eventType: 'SetSpeed', speed: 1 }],
  decorations: []
};
const parsed = AdofaiParser.parseLevel(sampleData);
assert(parsed.angleData.length === 4, 'angleData 长度正确');
assert(parsed.settings.bpm === 120, 'BPM 正确');
assert(parsed.settings.song === 'Test', '歌曲名正确');
assert(parsed.actions.length === 1, 'actions 数量正确');

// 测试 5: angleData 优先于 pathData
console.log('\n5. angleData 与 pathData 共存');
const bothData = {
  settings: { bpm: 100 },
  angleData: [0, 0, 0],
  pathData: 'REJ',
  actions: [],
  decorations: []
};
const parsedBoth = AdofaiParser.parseLevel(bothData);
assert(parsedBoth.angleData[0] === 0 && parsedBoth.angleData[1] === 0, '优先使用 angleData ([0,0,0])');

// 测试 6: 瓷砖计算 - 相对角度
console.log('\n6. 瓷砖相对角度计算');
const levelData = {
  settings: { bpm: 120 },
  angleData: [180, 90, 0, 270],
  actions: [],
  decorations: []
};
const level = new AdofaiLevel(levelData);
assert(level.tileCount === 4, '瓷砖数量 = 4');
// 第一个瓷砖方向 180，angleDir 初始 180，delta = 180-180 = 0 -> 360
assert(level.tiles[0].angle === 360, '第1个瓷砖相对角度 = 360 (2拍)');
assert(level.tiles[0].beats === 2, '第1个瓷砖拍数 = 2');

// 测试 7: 位置计算
console.log('\n7. 瓷砖位置计算');
assert(level.positions.length === 5, '位置数量 = 瓷砖数+1 (含终点)');
assert(level.positions[0][0] === 0 && level.positions[0][1] === 0, '起点 (0,0)');

// 测试 8: 时间计算
console.log('\n8. 瓷砖时间计算');
assert(level.timings.length === 4, '时间数组长度正确');
assert(Math.abs(level.timings[0] - 0) < 0.001, '第1个瓷砖时间 = 0');
// 第1个瓷砖拍数=2, BPM=120 -> 每拍0.5秒 -> 2拍=1秒
assert(Math.abs(level.timings[1] - 1) < 0.001, '第2个瓷砖时间 = 1秒');

// 测试 9: Twirl 翻转
console.log('\n9. Twirl 翻转');
const twirlData = {
  settings: { bpm: 120 },
  angleData: [180, 90, 0],
  actions: [{ floor: 1, eventType: 'Twirl' }],
  decorations: []
};
const twirlLevel = new AdofaiLevel(twirlData);
assert(twirlLevel.tiles[1].twirl === 1, '第2个瓷砖 twirl 计数 = 1');

// 测试 10: midspin 处理
console.log('\n10. Midspin 瓷砖');
const midspinData = {
  settings: { bpm: 120 },
  angleData: [180, 999, 90],
  actions: [],
  decorations: []
};
const midspinLevel = new AdofaiLevel(midspinData);
assert(midspinLevel.tiles[1].isMidspin === true, '第2个瓷砖标记为 midspin');
assert(midspinLevel.tiles[1].angle === 0, 'midspin 相对角度 = 0 (不增加拍数)');

// 测试 11: 插入瓷砖
console.log('\n11. 插入瓷砖');
const editData = {
  settings: { bpm: 120 },
  angleData: [180, 90],
  actions: [],
  decorations: []
};
const editLevel = new AdofaiLevel(editData);
editLevel.insertTile(1, 270);
assert(editLevel.tileCount === 3, '插入后瓷砖数 = 3');
assert(editLevel.angleData[1] === 270, '插入的瓷砖角度 = 270');

// 测试 12: 删除瓷砖
console.log('\n12. 删除瓷砖');
editLevel.deleteTile(1);
assert(editLevel.tileCount === 2, '删除后瓷砖数 = 2');
assert(editLevel.angleData[1] === 90, '删除后第2个瓷砖角度 = 90');

// 测试 13: 修改瓷砖角度
console.log('\n13. 修改瓷砖角度');
editLevel.setTileDirection(0, 45);
assert(editLevel.angleData[0] === 45, '修改后第1个瓷砖角度 = 45');

// 测试 14: 导出
console.log('\n14. 导出谱面');
const exported = editLevel.export();
assert(typeof exported === 'string', '导出为字符串');
const reParsed = AdofaiParser.parseLevel(exported);
assert(reParsed.angleData[0] === 45, '导出后可重新解析，角度正确');

// 测试 15: JSON 容错（尾逗号）
console.log('\n15. JSON 容错解析');
const badJson = '{"angleData":[180,90,], "settings":{"bpm":100,}, "actions":[], "decorations":[]}';
const fixed = AdofaiParser.parseAdofaiJson(badJson);
assert(Array.isArray(fixed.angleData), '尾逗号 JSON 可解析');

// 测试 16: decorations 事件归入
console.log('\n16. 装饰事件自动归类');
const decoData = {
  settings: { bpm: 100 },
  angleData: [0],
  actions: [{ floor: 0, eventType: 'AddDecoration', decorationImage: 'test.png' }],
  decorations: []
};
const decoParsed = AdofaiParser.parseLevel(decoData);
assert(decoParsed.decorations.length === 1, 'AddDecoration 自动归入 decorations');
assert(decoParsed.actions.length === 0, 'actions 中不含装饰事件');

console.log(`\n=== 测试结果: ${passed} 通过, ${failed} 失败 ===`);
process.exit(failed > 0 ? 1 : 0);
