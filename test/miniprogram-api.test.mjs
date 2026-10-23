import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../miniprogram/utils/api.js', import.meta.url), 'utf8');

function harness(respond) {
  const storage = new Map(), calls = [], launches = [];
  const app = {
    globalData: { token: 'a'.repeat(64), user: { role: 'student' } },
    setSession(token, user) { this.globalData = { token, user }; },
    clearSession() { this.globalData = { token: '', user: null }; }
  };
  const wx = {
    request(options) { calls.push(options); respond(options); },
    getStorageSync(key) { return storage.get(key); },
    setStorageSync(key, value) { storage.set(key, value); },
    removeStorageSync(key) { storage.delete(key); },
    reLaunch(options) { launches.push(options); }
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, wx, getApp: () => app, Date, Math, Promise, Error, JSON, encodeURIComponent });
  return { api: module.exports, storage, calls, launches, app };
}

test('小程序断网后使用同一请求编号重试，成功后清除待提交草稿', async () => {
  let attempts = 0;
  const h = harness(options => {
    attempts += 1;
    if (attempts === 1) options.fail({});
    else options.success({ statusCode: 201, data: { id: 'demo-order' } });
  });
  const draft = { campus: 'chenglong', stationId: 'demo-cl', zone: '东苑', pickupCode: 'TEST-123456', qty: 1, size: 'small', speed: 'normal', slot: '2026-10-23T09:00:00+08:00' };
  await assert.rejects(h.api.submitOrder(draft), error => error.code === 'NETWORK_ERROR');
  assert.equal(h.api.pendingDraft().draft.pickupCode, 'TEST-123456');
  await h.api.submitOrder(draft);
  assert.equal(h.calls[0].data.requestId, h.calls[1].data.requestId);
  assert.equal(h.api.pendingDraft(), null);
});

test('时段已满返回 409 后清除不可重试草稿', async () => {
  const h = harness(options => options.success({ statusCode: 409, data: { code: 'CONFLICT', error: '该时段已约满' } }));
  const draft = { campus: 'chenglong', stationId: 'demo-cl', zone: '东苑', pickupCode: 'TEST-123456', qty: 1, size: 'small', speed: 'normal', slot: '2026-10-24T09:00:00+08:00' };
  await assert.rejects(h.api.submitOrder(draft), error => error.status === 409);
  assert.equal(h.api.pendingDraft(), null);
});

test('小程序遇 401 清除身份并返回选择页；危险接口模式停止操作', async () => {
  const h = harness(options => options.success({ statusCode: 401, data: { code: 'UNAUTHORIZED', error: '登录失效' } }));
  await assert.rejects(h.api.request('/api/orders'), error => error.code === 'UNAUTHORIZED');
  assert.equal(h.app.globalData.token, '');
  assert.equal(h.launches[0].url, '/pages/login/index');

  const unsafe = harness(options => options.success({ statusCode: 200, data: { mode: 'PUBLIC', apiContract: 4 } }));
  await assert.rejects(unsafe.api.checkDemo(), error => error.code === 'UNSAFE_MODE');
});

test('客户端只识别虚构取件码，服务端仍负责最终校验', () => {
  const h = harness(() => {});
  assert.equal(h.api.demoCode('test-5-2-0042'), 'TEST-5-2-0042');
  assert.equal(h.api.demoCode('123456'), null);
  assert.equal(h.api.demoCode('TEST-HELLO'), null);
});
