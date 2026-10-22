import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.mjs';
import { parseDemoPickupCode } from '../web/pickup-code.js';
import { availableSlots } from '../server/slots.mjs';

test('预约仅开放白天到傍晚的一小时时段，过期和夜间不可提交', async t => {
  const { request, login, orderBody } = await setup(t);
  const student = await login('student-a');
  const catalog = await request('/api/catalog', student);
  assert.ok(catalog.body.slots.length > 0);
  assert.ok(catalog.body.slots.every(s => /T(09|1[0-8]):00:00\+08:00$/.test(s.value)));
  assert.ok(catalog.body.slots.every(s => Date.parse(s.value) > Date.now()));
  assert.equal((await request('/api/orders', student, 'POST', orderBody({ slot: catalog.body.slots[0].value }))).status, 201);
  for (const slot of ['today-evening', '2026-10-23T22:00:00+08:00', '2020-01-01T09:00:00+08:00']) {
    assert.equal((await request('/api/orders', student, 'POST', orderBody({ slot }))).status, 400);
  }
});

async function setup(t) {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, token, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const login = async accountId => (await request('/api/demo/login', null, 'POST', { accountId })).body.token;
  const orderBody = (overrides = {}) => ({ requestId: crypto.randomUUID(), campus: 'chenglong', stationId: 'demo-cl', zone: '东苑', pickupCode: 'TEST-1234', qty: 1, size: 'small', speed: 'normal', slot: availableSlots()[0].value, ...overrides });
  return { request, login, orderBody };
}

test('订单归属、校区隔离、敏感字段和服务端计价', async t => {
  const { request, login, orderBody } = await setup(t);
  const [studentA, studentB, courierCL, courierSZ, unapproved, admin] = await Promise.all(['student-a', 'student-b', 'runner-cl-1', 'runner-sz-1', 'runner-cl-2', 'admin'].map(login));
  const input = orderBody({ amount_cents: 1, payment_status: 'paid', status: 'completed' });
  const created = await request('/api/orders', studentA, 'POST', input);
  assert.equal(created.status, 201);
  assert.equal(created.body.amount_cents, 300);
  assert.equal(created.body.payment_status, 'demo_not_paid');
  assert.equal(created.body.status, 'pending');
  const id = created.body.id;
  const replay = await request('/api/orders', studentA, 'POST', input);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, id);
  assert.equal((await request('/api/orders', studentB)).body.length, 0);
  assert.equal((await request(`/api/orders/${id}`, studentB)).status, 404);
  assert.equal((await request('/api/orders', courierSZ)).body.length, 0);
  assert.equal((await request('/api/orders', unapproved)).status, 403);
  const task = (await request('/api/orders', courierCL)).body[0];
  assert.equal(task.id, id);
  assert.equal(task.pickup_code, undefined);
  assert.equal(task.handoff, undefined);
  assert.equal(task.student_id, undefined);
  assert.equal((await request('/api/orders', admin)).body[0].pickup_code, undefined);
  assert.equal((await request('/api/audit', admin)).body[0].action, 'demo_order_created');
});

test('20 个接单请求只有一次成功，状态流转与审计记录正确', async t => {
  const { request, login, orderBody } = await setup(t);
  const [student, courier, admin] = await Promise.all(['student-a', 'runner-cl-1', 'admin'].map(login));
  const { body: order } = await request('/api/orders', student, 'POST', orderBody());
  const results = await Promise.all(Array.from({ length: 20 }, () => request(`/api/orders/${order.id}/accept`, courier, 'POST')));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 409).length, 19);
  assert.equal((await request(`/api/orders/${order.id}/assign`, admin, 'POST', { courierId: 'runner-cl-1' })).status, 409);
  const accepted = (await request(`/api/orders/${order.id}`, courier)).body;
  assert.equal(accepted.pickup_code, 'TEST-1234');
  assert.equal(accepted.handoff, '东苑楼下公共入口（测试）');
  assert.equal((await request(`/api/orders/${order.id}/progress`, courier, 'POST', { status: 'delivered' })).status, 409);
  for (const status of ['picked', 'delivering', 'delivered']) assert.equal((await request(`/api/orders/${order.id}/progress`, courier, 'POST', { status })).status, 200);
  assert.equal((await request(`/api/orders/${order.id}/confirm`, student, 'POST')).body.status, 'completed');
  assert.equal((await request(`/api/orders/${order.id}/confirm`, student, 'POST')).status, 409);
  const logs = (await request('/api/audit', admin)).body;
  assert.equal(logs.length, 6);
  assert.equal(JSON.stringify(logs).includes('TEST-1234'), false);
});

test('跨校区派单和真实数据输入被拒绝，学生可取消待接单', async t => {
  const { request, login, orderBody } = await setup(t);
  const [student, courierSZ, manager, admin] = await Promise.all(['student-a', 'runner-sz-1', 'manager-cl', 'admin'].map(login));
  assert.equal((await request('/api/orders', student, 'POST', orderBody({ pickupCode: '123456' }))).status, 400);
  assert.equal((await request('/api/orders', student, 'POST', orderBody({ handoff: '东苑3栋真实房间' }))).status, 400);
  assert.equal((await request('/api/orders', student, 'POST', orderBody({ campus: 'shizishan', stationId: 'demo-sz' }))).status, 400);
  const { body: order } = await request('/api/orders', student, 'POST', orderBody());
  assert.equal((await request(`/api/orders/${order.id}/accept`, courierSZ, 'POST')).status, 404);
  assert.equal((await request(`/api/orders/${order.id}/assign`, manager, 'POST', { courierId: 'runner-sz-1' })).status, 400);
  assert.equal((await request(`/api/orders/${order.id}/cancel`, student, 'POST')).body.status, 'cancelled');
  assert.equal((await request(`/api/orders/${order.id}/assign`, admin, 'POST', { courierId: 'runner-cl-1' })).status, 409);
  assert.equal((await request('/api/capabilities', null)).body.realPayment, false);
});

test('取件码识别常见形态但只接受虚构测试码', async t => {
  const { request, login, orderBody } = await setup(t);
  const student = await login('student-a');
  for (const [code, kind] of [['TEST-123456', 'digits'], ['TEST-5-2-0042', 'shelf'], ['test-9vk518', 'mixed']]) {
    assert.equal(parseDemoPickupCode(code).kind, kind);
    const created = await request('/api/orders', student, 'POST', orderBody({ pickupCode: code }));
    assert.equal(created.status, 201);
    assert.equal(created.body.pickup_code, code.toUpperCase());
  }
  for (const code of ['5-2-0042', '9VK518', 'TEST-', 'TEST-5-2-42', 'TEST-HELLO']) {
    assert.equal(parseDemoPickupCode(code), null);
    assert.equal((await request('/api/orders', student, 'POST', orderBody({ pickupCode: code }))).status, 400);
  }
});

test('相同请求编号只重试同一订单内容，错误响应提供稳定代码', async t => {
  const { request, login, orderBody } = await setup(t);
  const student = await login('student-a');
  const body = orderBody({ pickupCode: 'test-123456' });
  const created = await request('/api/orders', student, 'POST', body);
  assert.equal(created.status, 201);
  assert.equal((await request('/api/orders', student, 'POST', { ...body, pickupCode: 'TEST-123456' })).body.id, created.body.id);
  const changed = await request('/api/orders', student, 'POST', { ...body, zone: '西苑' });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'CONFLICT');
  assert.equal((await request('/api/orders', student)).body.length, 1);
  const unauthorized = await request('/api/orders', '0'.repeat(64));
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.code, 'UNAUTHORIZED');
  const capabilities = await request('/api/capabilities');
  assert.equal(capabilities.body.version, '0.4.2');
  assert.equal(capabilities.body.apiContract, 2);
  assert.equal(capabilities.body.closedPilotReady, false);
});

test('两个校区完整测试订单流，20 个不同代取员请求只有一人接单', async t => {
  const { request, login, orderBody } = await setup(t);
  const [studentCL, studentSZ, courierCL1, courierCL2, courierSZ, manager] =
    await Promise.all(['student-a', 'student-b', 'runner-cl-1', 'runner-cl-2', 'runner-sz-1', 'manager-cl'].map(login));
  assert.equal((await request('/api/couriers/runner-cl-2/approval', manager, 'POST', { approved: true })).status, 200);
  const cl = (await request('/api/orders', studentCL, 'POST', orderBody())).body;
  const preClaim = (await request('/api/orders/' + cl.id, courierCL2)).body;
  assert.equal(preClaim.pickup_code, undefined);
  assert.equal(preClaim.handoff, undefined);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    request('/api/orders/' + cl.id + '/accept', i % 2 ? courierCL1 : courierCL2, 'POST')));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  const winner = results.find(r => r.status === 200).body.courier_id === 'runner-cl-1' ? courierCL1 : courierCL2;
  for (const status of ['picked', 'delivering', 'delivered'])
    assert.equal((await request('/api/orders/' + cl.id + '/progress', winner, 'POST', { status })).status, 200);
  assert.equal((await request('/api/orders/' + cl.id + '/confirm', studentCL, 'POST')).body.status, 'completed');

  const sz = (await request('/api/orders', studentSZ, 'POST', orderBody({
    campus: 'shizishan', stationId: 'demo-sz', zone: '博学苑'
  }))).body;
  assert.equal((await request('/api/orders/' + sz.id, courierCL1)).status, 404);
  assert.equal((await request('/api/orders/' + sz.id + '/accept', courierSZ, 'POST')).status, 200);
  for (const status of ['picked', 'delivering', 'delivered'])
    assert.equal((await request('/api/orders/' + sz.id + '/progress', courierSZ, 'POST', { status })).status, 200);
  assert.equal((await request('/api/orders/' + sz.id + '/confirm', studentSZ, 'POST')).body.status, 'completed');
});
