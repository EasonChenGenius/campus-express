import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../miniprogram/utils/display.js', import.meta.url), 'utf8');
const module = { exports: {} };
vm.runInNewContext(source, { module, Date });
const { progressSteps } = module.exports;

test('小程序订单进度按当前状态显示，完成后全部标记为已走过', () => {
  const pending = progressSteps({ status: 'pending' });
  assert.equal(pending[0].state, 'current');
  assert.equal(pending[1].state, 'waiting');
  const delivering = progressSteps({ status: 'delivering' });
  assert.equal(delivering[2].state, 'done');
  assert.equal(delivering[3].state, 'current');
  assert.ok(progressSteps({ status: 'completed' }).every(step => step.state === 'done'));
});

test('异常、取消和关闭订单不显示仍在配送的未来步骤', () => {
  const issue = progressSteps({ status: 'exception', exception: { previous_status: 'picked' } });
  assert.deepEqual(Array.from(issue, step => step.key), ['pending', 'assigned', 'picked', 'exception']);
  assert.equal(issue.at(-1).title, '异常待核实');
  const cancelled = progressSteps({ status: 'cancelled' });
  assert.deepEqual(Array.from(cancelled, step => step.key), ['pending', 'cancelled']);
  assert.equal(progressSteps({ status: 'closed', lastResolution: { previous_status: 'delivering' } }).at(-1).title, '异常已关闭');
});
