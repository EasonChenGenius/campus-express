import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareOrderRequest, clearOrderRequest } from '../web/order-request.js';

test('网页断网重试同一表单沿用请求编号，改动表单才生成新编号', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  let counter = 0;
  const next = () => `demo-request-${++counter}`;
  const draft = { campus: 'chenglong', pickupCode: 'TEST-123456' };
  const first = prepareOrderRequest(storage, 'student-a', draft, next);
  assert.equal(prepareOrderRequest(storage, 'student-a', draft, next), first);
  assert.notEqual(prepareOrderRequest(storage, 'student-a', { ...draft, pickupCode: 'TEST-654321' }, next), first);
  clearOrderRequest(storage, 'student-a');
  assert.equal(values.has('student-a'), false);
});

test('网页存储不可用时仍可在当前页面安全重试', () => {
  const storage = { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); }, removeItem: () => { throw Error('blocked'); } };
  const first = prepareOrderRequest(storage, 'blocked-test', { pickupCode: 'TEST-123456' }, () => 'demo-first');
  assert.equal(prepareOrderRequest(storage, 'blocked-test', { pickupCode: 'TEST-123456' }, () => 'demo-second'), first);
  clearOrderRequest(storage, 'blocked-test');
});
