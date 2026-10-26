import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../miniprogram/pages/student/index.js', import.meta.url), 'utf8');

test('时段冲突刷新可选时段时保留学生已填的虚构取件码和苑区', async () => {
  let page, catalogReads = 0;
  const oldSlot = { value: 'old-slot', label: '旧时段', remaining: 1 };
  const newSlot = { value: 'new-slot', label: '新时段', remaining: 1 };
  const api = {
    requireRole: () => ({ role: 'student', campus: 'chenglong' }), pendingDraft: () => null,
    request: async path => path === '/api/courier-applications/me' ? { status: 'none' } : {
      stations: [{ id: 'demo-cl', name: '成龙虚构测试点', campus: 'chenglong' }],
      campusZones: { chenglong: ['东苑', '西苑'] }, campusBuildings: { chenglong: { '东苑': ['东1'], '西苑': [] } },
      slots: ++catalogReads === 1 ? [oldSlot, newSlot] : [newSlot]
    },
    demoCode: value => value,
    submitOrder: async () => { const error = Error('该时段已约满'); error.status = 409; throw error; }
  };
  vm.runInNewContext(source, {
    Page: config => { page = { ...config, data: { ...config.data }, setData(values) { Object.assign(this.data, values); } }; },
    require: path => path.includes('display') ? { campus: { chenglong: '成龙校区' } } : api,
    wx: { navigateTo() {}, reLaunch() {} }, Promise
  });
  await page.onShow();
  page.changePicker({ currentTarget: { dataset: { field: 'zoneIndex' } }, detail: { value: '1' } });
  page.changeCode({ currentTarget: { dataset: { index: 0 } }, detail: { value: 'TEST-123456' } });
  await page.submit();
  assert.equal(page.data.pickupCodes[0], 'TEST-123456');
  assert.equal(page.data.zones[page.data.zoneIndex], '西苑');
  assert.equal(page.data.slots[page.data.slotIndex].value, 'new-slot');
  assert.equal(page.data.error, '该时段已约满');
});

test('小程序件数变化后增减取件码输入格，保留已有值', async () => {
  let page;
  vm.runInNewContext(source, {
    Page: config => { page = { ...config, data: { ...config.data }, setData(values) { Object.assign(this.data, values); } }; },
    require: path => path.includes('display') ? { campus: {} } : {},
    wx: {}, Promise
  });
  page.changeCode({ currentTarget: { dataset: { index: 0 } }, detail: { value: 'TEST-123456' } });
  page.changePicker({ currentTarget: { dataset: { field: 'qtyIndex' } }, detail: { value: '2' } });
  assert.equal(page.data.pickupCodes.length, 3);
  assert.equal(page.data.pickupCodes[0], 'TEST-123456');
  page.changePicker({ currentTarget: { dataset: { field: 'qtyIndex' } }, detail: { value: '0' } });
  assert.equal(page.data.pickupCodes.length, 1);
});
