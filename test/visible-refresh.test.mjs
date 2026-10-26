import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../miniprogram/utils/visible-refresh.js', import.meta.url), 'utf8');
const callbacks = new Map();
let nextId = 0;
const module = { exports: {} };
vm.runInNewContext(source, { module, setInterval: fn => { const id = ++nextId; callbacks.set(id, fn); return id; }, clearInterval: id => callbacks.delete(id) });
const { startVisibleRefresh, stopVisibleRefresh } = module.exports;

test('可见页面定时同步，忙碌时跳过，离开页面后停止', () => {
  const page = { data: { loading: false, busy: false, busyId: '' } };
  let refreshes = 0;
  startVisibleRefresh(page, () => { refreshes += 1; });
  callbacks.get(page._refreshTimer)();
  assert.equal(refreshes, 1);
  page.data.busy = true;
  callbacks.get(page._refreshTimer)();
  assert.equal(refreshes, 1);
  page.data.busy = false;
  page.data.loading = true;
  callbacks.get(page._refreshTimer)();
  assert.equal(refreshes, 1);
  stopVisibleRefresh(page);
  assert.equal(callbacks.size, 0);
});
