/**
 * 音画同步时钟单测
 * 验证 player.js 中纯函数时钟 AdofaiAudioClock 的 offset / seek / 延迟逻辑
 */

global.window = {};
require('../js/player.js');

const { AdofaiAudioClock } = global.window;

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

function near(a, b, eps) {
  return Math.abs(a - b) <= (eps || 1e-9);
}

console.log('=== ADOFAI 音画同步时钟测试 ===\n');

// 1. offset 解析
console.log('1. settings.offset 解析');
assert(near(AdofaiAudioClock.offsetSec({ offset: 250 }), 0.25), 'offset 250ms -> 0.25s');
assert(near(AdofaiAudioClock.offsetSec({ offset: -300 }), -0.3), 'offset -300ms -> -0.3s');
assert(near(AdofaiAudioClock.offsetSec({ offset: '120' }), 0.12), '字符串 offset 也能解析');
assert(near(AdofaiAudioClock.offsetSec({}), 0), '缺失 offset -> 0');
assert(near(AdofaiAudioClock.offsetSec(null), 0), 'null settings -> 0');
assert(near(AdofaiAudioClock.offsetSec({ offset: 'abc' }), 0), '非法 offset -> 0');

// 2. performance 时钟
console.log('\n2. performance 单调时钟');
assert(near(AdofaiAudioClock.chartTimeFromPerf(1000, 3000), 2), '2 秒间隔 -> 2.0');
assert(near(AdofaiAudioClock.chartTimeFromPerf(1000, 1000), 0), '同一时刻 -> 0');
assert(near(AdofaiAudioClock.chartTimeFromPerf(1000, 900), 0), '早于起点钳制为 0');

// 3. 音频时钟
console.log('\n3. AudioContext 播放头时钟');
assert(near(AdofaiAudioClock.chartTimeFromAudio(10, 10, 0, 0), 0), '起始播放 head 同步 -> 0');
assert(near(AdofaiAudioClock.chartTimeFromAudio(12, 10, 0, 0), 2), '播放 2 秒 -> 2.0');
assert(near(AdofaiAudioClock.chartTimeFromAudio(12, 10, 5, 0), 7), 'seek 5 秒后 -> 7.0');
assert(near(AdofaiAudioClock.chartTimeFromAudio(12, 10, 0, 0.25), 1.75), 'offset 0.25s 提前 -> 1.75');
assert(near(AdofaiAudioClock.chartTimeFromAudio(10, 10, 0, 0.5), 0), 'offset 造成负值钳制为 0');

// 4. 播放调度
console.log('\n4. 播放调度 schedule()');
const s1 = AdofaiAudioClock.schedule(3, 0);
assert(near(s1.seek, 3) && s1.delay === 0 && s1.audioClockUsable, '从 3s 续播：音频 seek 3、无延迟、可用音频时钟');

const s2 = AdofaiAudioClock.schedule(1, 2);
assert(near(s2.seek, 3) && s2.delay === 0 && s2.audioClockUsable, 'offset +2s：音频 seek 3');

const s3 = AdofaiAudioClock.schedule(0, -0.5);
assert(near(s3.seek, 0) && near(s3.delay, 0.5) && !s3.audioClockUsable,
  'offset -0.5s：音频延迟 0.5s 启动，暂不可用音频时钟');

const s4 = AdofaiAudioClock.schedule(0, 0);
assert(near(s4.seek, 0) && s4.delay === 0 && s4.audioClockUsable, '从头播放：立即启动音频时钟');

// 5. 一致性：音频时钟与 perf 时钟在理想条件下应等价
console.log('\n5. 双时钟一致性');
const startCtx = 20;
const startPerf = 5000;
const offset = 0.3;
let maxDrift = 0;
for (let ms = 0; ms <= 10000; ms += 250) {
  const ctxNow = startCtx + ms / 1000 + 0.0002; // 音频回调约 0.2ms 抖动
  const perfNow = startPerf + ms;
  const audioT = AdofaiAudioClock.chartTimeFromAudio(ctxNow, startCtx, 0, offset);
  const perfT = AdofaiAudioClock.chartTimeFromPerf(startPerf, perfNow) - 0;
  // 音频时钟已扣除 offset，因此预期 audioT = max(0, perfT - offset)
  const drift = Math.abs(audioT - Math.max(0, perfT - offset)) * 1000;
  if (drift > maxDrift) maxDrift = drift;
}
assert(maxDrift < 1, `10 秒内双时钟漂移 ${maxDrift.toFixed(3)}ms < 1ms`);

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
