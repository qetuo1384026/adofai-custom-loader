/**
 * 兼容性测试：批量解析真实风格的自制谱 fixture
 * 验证：瓷砖数量、相对角度/拍数/坐标/时间均为有限数值，导出后可再解析
 */
global.window = {};
require('../js/parser.js');
require('../js/level.js');

const fs = require('fs');
const path = require('path');
const { AdofaiParser, AdofaiLevel } = global.window;

const dir = path.join(__dirname, 'fixtures');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.adofai'));

let pass = 0;
let fail = 0;

function check(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

const finite = (v) => typeof v === 'number' && isFinite(v);

console.log('=== 兼容性测试 ===\n');

for (const file of files) {
  const raw = fs.readFileSync(path.join(dir, file), 'utf8');
  console.log(`▸ ${file}`);
  try {
    const parsed = AdofaiParser.parseLevel(raw);
    check(parsed.angleData.length > 0, `${file}: 解析出 ${parsed.angleData.length} 个角度`);

    const level = new AdofaiLevel(parsed);
    check(level.tileCount === parsed.angleData.length, `${file}: 瓷砖数 ${level.tileCount} 与角度数一致`);

    let allFinite = true;
    let hasBadAngle = false;
    for (const t of level.tiles) {
      if (!finite(t.angle) || !finite(t.beats)) allFinite = false;
      if (t.beats < 0) hasBadAngle = true;
    }
    check(allFinite, `${file}: 所有瓷砖角度/拍数为有限值`);
    check(!hasBadAngle, `${file}: 无负拍数`);

    for (let i = 0; i < level.positions.length; i++) {
      if (!finite(level.positions[i][0]) || !finite(level.positions[i][1])) { allFinite = false; break; }
    }
    check(allFinite, `${file}: 所有坐标有限`);

    check(level.timings.every(finite), `${file}: 所有时间戳有限`);
    check(level.timings[0] === 0, `${file}: 首格时间从 0 开始`);

    let ordered = true;
    for (let i = 1; i < level.timings.length; i++) {
      if (!(level.timings[i] >= level.timings[i - 1])) ordered = false;
    }
    check(ordered, `${file}: 时间戳单调递增`);

    check(finite(level.duration) && level.duration > 0, `${file}: 总时长 ${level.duration.toFixed(2)}s`);

    const exported = level.export();
    const again = AdofaiParser.parseLevel(exported);
    check(again.angleData.length === level.tileCount, `${file}: 导出后可重新解析`);

    console.log('');
  } catch (e) {
    fail++;
    console.error(`  ✗ ${file}: 异常 ${e.message}\n`);
  }
}

console.log(`=== 兼容性结果: ${pass} 通过, ${fail} 失败 (${files.length} 个谱面) ===`);
process.exit(fail > 0 ? 1 : 0);
