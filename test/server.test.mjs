import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.mjs';

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
  const orderBody = (overrides = {}) => ({ requestId: crypto.randomUUID(), campus: 'chenglong', stationId: 'demo-cl', zone: '东苑', handoff: '东苑楼下测试点', pickupCode: 'TEST-1234', qty: 1, size: 'small', speed: 'normal', slot: 'today-evening', ...overrides });
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
  assert.equal(accepted.handoff, '东苑楼下测试点');
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
