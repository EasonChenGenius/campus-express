import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.mjs';
import { parseDemoPickupCode } from '../web/pickup-code.js';
import { availableSlots } from '../server/slots.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('本机演示服务拒绝正式环境启动', () => {
  assert.throws(() => createApp({ dbPath: ':memory:', runtimeMode: 'production' }), /禁止在正式环境启动/);
});

test('已有 V0.4 本机数据库启动时补齐接单字段和异常表', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'campus-express-migration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'old.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, campus TEXT, approved INTEGER NOT NULL)');
  old.close();
  const app = createApp({ dbPath });
  t.after(() => app.close());
  assert.ok(app.db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'online'));
  assert.ok(app.db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'max_active'));
  assert.ok(app.db.prepare("SELECT name FROM sqlite_master WHERE name='order_exceptions'").get());
  assert.ok(app.db.prepare("SELECT name FROM sqlite_master WHERE name='slot_limits'").get());
  assert.ok(app.db.prepare('PRAGMA table_info(orders)').all().some(c => c.name === 'building'));
});

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

test('东苑楼栋仅接受东1—东13，西苑暂不猜楼号，接单前隐藏具体楼栋', async t => {
  const { request, login, orderBody } = await setup(t);
  const student = await login('student-a');
  const runner = await login('runner-cl-1');
  const catalog = (await request('/api/catalog', student)).body;
  assert.deepEqual(catalog.campusBuildings.chenglong['东苑'], Array.from({ length: 13 }, (_, i) => `东${i + 1}`));
  assert.deepEqual(catalog.campusBuildings.chenglong['西苑'], []);
  for (const building of ['东0', '东14', '西1', '东1-101']) {
    assert.equal((await request('/api/orders', student, 'POST', orderBody({ building }))).status, 400);
  }
  const created = await request('/api/orders', student, 'POST', orderBody({ building: '东13' }));
  assert.equal(created.status, 201);
  assert.equal(created.body.handoff, '东苑东13楼下公共入口（演示位置，待核实）');
  const pending = (await request('/api/orders', runner)).body.find(o => o.id === created.body.id);
  assert.equal(pending.building, undefined);
  assert.equal(pending.handoff, undefined);
  assert.equal((await request(`/api/orders/${created.body.id}/accept`, runner, 'POST')).body.building, '东13');
  assert.equal((await request('/api/orders', student, 'POST', orderBody({ zone: '西苑', building: '西1' }))).status, 400);
  assert.equal((await request('/api/orders', student, 'POST', orderBody({ zone: '西苑', building: null }))).status, 201);
});

test('同校区小时容量在并发下单时不超额，取消释放名额且双校区独立', async t => {
  const { request, login, orderBody } = await setup(t);
  const [studentCL, studentSZ, manager, admin] = await Promise.all(['student-a','student-b','manager-cl','admin'].map(login));
  const slot = (await request('/api/catalog', studentCL)).body.slots[0].value;
  assert.equal((await request('/api/slots/capacity', manager, 'POST', { campus: 'shizishan', slot, capacity: 1 })).status, 403);
  assert.equal((await request('/api/slots/capacity', manager, 'POST', { campus: 'chenglong', slot, capacity: 2 })).status, 200);
  const bodies = Array.from({ length: 10 }, (_, i) => orderBody({ slot, pickupCode: `TEST-${1000+i}` }));
  const results = await Promise.all(bodies.map(body => request('/api/orders', studentCL, 'POST', body)));
  assert.equal(results.filter(r => r.status === 201).length, 2);
  assert.equal(results.filter(r => r.status === 409).length, 8);
  const winner = results.find(r => r.status === 201);
  assert.equal((await request('/api/orders', studentCL, 'POST', bodies[results.indexOf(winner)])).body.id, winner.body.id);
  assert.equal((await request('/api/catalog', studentCL)).body.slots.some(item => item.value === slot), false);
  assert.equal((await request('/api/catalog', studentSZ)).body.slots.some(item => item.value === slot), true);
  assert.equal((await request('/api/slots/capacity', manager, 'POST', { campus: 'chenglong', slot, capacity: 1 })).status, 409);
  assert.equal((await request(`/api/orders/${winner.body.id}/cancel`, studentCL, 'POST')).status, 200);
  assert.equal((await request('/api/catalog', studentCL)).body.slots.find(item => item.value === slot).remaining, 1);
  assert.equal((await request('/api/orders', studentCL, 'POST', orderBody({ slot, pickupCode: 'TEST-9999' }))).status, 201);
  assert.equal((await request('/api/slots/capacity', admin, 'POST', { campus: 'shizishan', slot, capacity: 0 })).status, 200);
  assert.equal((await request('/api/catalog', studentSZ)).body.slots.some(item => item.value === slot), false);
});

async function setup(t, options = {}) {
  const app = createApp({ dbPath: ':memory:', ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, token, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const login = async accountId => (await request('/api/demo/login', null, 'POST', { accountId })).body.token;
  const orderBody = (overrides = {}) => ({ requestId: crypto.randomUUID(), campus: 'chenglong', stationId: 'demo-cl', zone: '东苑', building: overrides.zone && overrides.zone !== '东苑' ? null : '东1', pickupCode: 'TEST-1234', qty: 1, size: 'small', speed: 'normal', slot: availableSlots()[0].value, ...overrides });
  return { request, login, orderBody, db: app.db, base };
}

test('本机网页可读取新主题样式', async t => {
  const { base } = await setup(t);
  const response = await fetch(`${base}/theme.css`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/css/);
  assert.match(await response.text(), /\.workspace-nav/);
  const script = await fetch(`${base}/order-request.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /prepareOrderRequest/);
});

test('代取员虚构申请必须由本校区后台审核，通过后默认下线', async t => {
  const { request, login, db } = await setup(t);
  const [studentCL, studentSZ, managerCL, admin, runner] = await Promise.all(['student-a','student-b','manager-cl','admin','runner-cl-1'].map(login));
  assert.equal((await request('/api/courier-applications/me', studentCL)).body.status, 'none');
  assert.equal((await request('/api/courier-applications', runner, 'POST', {})).status, 403);
  assert.equal((await request('/api/courier-applications', studentCL, 'POST', { role: 'admin', approved: true, campus: 'shizishan' })).status, 201);
  assert.equal((await request('/api/courier-applications', studentCL, 'POST', {})).status, 409);
  assert.equal((await request('/api/courier-applications', studentSZ, 'POST', {})).status, 201);
  assert.equal((await request('/api/courier-applications', managerCL)).body.length, 1);
  assert.equal((await request('/api/courier-applications/student-b/review', managerCL, 'POST', { approved: true })).status, 404);
  assert.equal((await request('/api/courier-applications/student-a/review', studentCL, 'POST', { approved: true })).status, 403);
  const reviewed = await Promise.all(Array.from({ length: 2 }, () => request('/api/courier-applications/student-a/review', managerCL, 'POST', { approved: true })));
  assert.equal(reviewed.filter(x => x.status === 200).length, 1);
  assert.equal(reviewed.filter(x => x.status === 409).length, 1);
  const courierId = reviewed.find(x => x.status === 200).body.courier_id;
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE id LIKE 'demo-courier-%'").get().count, 1);
  assert.equal((await request('/api/courier-applications/me', studentCL)).body.status, 'approved');
  assert.ok((await request('/api/demo/accounts')).body.some(x => x.id === courierId));
  const courierToken = await login(courierId);
  const availability = (await request('/api/couriers/me/availability', courierToken)).body;
  assert.equal(availability.approved, true);
  assert.equal(availability.online, false);
  assert.equal((await request('/api/courier-applications/student-b/review', admin, 'POST', { approved: false })).body.status, 'rejected');
  assert.equal((await request('/api/courier-applications', studentSZ, 'POST', {})).status, 201);
});

test('测试会话可主动退出且 30 分钟后自动失效', async t => {
  let clock = Date.UTC(2026, 9, 23, 1);
  const { request, login } = await setup(t, { sessionClock: () => clock });
  const token = await login('student-a');
  assert.equal((await request('/api/me', token)).status, 200);
  assert.equal((await request('/api/session/logout', token, 'POST')).status, 200);
  assert.equal((await request('/api/me', token)).status, 401);
  const second = await login('student-a');
  clock += 30 * 60 * 1000;
  assert.equal((await request('/api/me', second)).status, 401);
  assert.equal((await request('/api/session/logout', second, 'POST')).status, 401);
});

test('演示学生可注册、密码登录、找回密码；服务端固定学生权限并撤销旧会话', async t => {
  const { request, db } = await setup(t);
  const phone = 'TEST-13800000001', password = 'demo-pass-1234';
  assert.equal((await request('/api/demo/send-code', null, 'POST', { phone: '13800000001', purpose: 'register' })).status, 400);
  const issued = await request('/api/demo/send-code', null, 'POST', { phone, purpose: 'register' });
  assert.equal(issued.status, 200);
  assert.equal(issued.body.delivery, 'ON_PAGE_ONLY');
  assert.equal((await request('/api/demo/send-code', null, 'POST', { phone, purpose: 'register' })).status, 429);
  assert.equal((await request('/api/demo/register', null, 'POST', { phone, code: '000000', password, campus: 'chenglong' })).status, 400);
  const registered = await request('/api/demo/register', null, 'POST', { phone, code: issued.body.demoCode, password, campus: 'chenglong', role: 'admin', approved: false });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.user.role, 'student');
  assert.equal(registered.body.user.campus, 'chenglong');
  assert.equal(db.prepare('SELECT password_hash FROM demo_credentials WHERE phone=?').get(phone).password_hash.includes(password), false);
  assert.equal((await request('/api/operations/queue', registered.body.token)).status, 403);
  assert.equal((await request('/api/demo/register', null, 'POST', { phone, code: issued.body.demoCode, password, campus: 'chenglong' })).status, 409);
  assert.equal((await request('/api/demo/password-login', null, 'POST', { phone, password: 'wrong-pass-123' })).status, 401);
  const login = await request('/api/demo/password-login', null, 'POST', { phone, password });
  assert.equal(login.status, 200);
  const resetCode = await request('/api/demo/send-code', null, 'POST', { phone, purpose: 'reset' });
  assert.equal(resetCode.status, 200);
  assert.equal((await request('/api/demo/reset-password', null, 'POST', { phone, code: resetCode.body.demoCode, password: 'new-demo-pass-5678' })).status, 200);
  assert.equal((await request('/api/me', registered.body.token)).status, 401);
  assert.equal((await request('/api/me', login.body.token)).status, 401);
  assert.equal((await request('/api/demo/password-login', null, 'POST', { phone, password })).status, 401);
  assert.equal((await request('/api/demo/password-login', null, 'POST', { phone, password: 'new-demo-pass-5678' })).status, 200);
});

test('演示验证码过期与错误尝试次数由后端限制', async t => {
  let clock = Date.UTC(2026,9,23,1);
  const { request } = await setup(t,{ sessionClock: () => clock });
  const phone = 'TEST-13900000002', password = 'demo-pass-9876';
  const first = await request('/api/demo/send-code', null, 'POST', { phone, purpose: 'register' });
  assert.equal(first.status, 200);
  clock += 300_000;
  assert.equal((await request('/api/demo/register', null, 'POST', { phone, code: first.body.demoCode, password, campus: 'shizishan' })).status, 400);
  const second = await request('/api/demo/send-code', null, 'POST', { phone, purpose: 'register' });
  assert.equal(second.status, 200);
  for (let i=0;i<5;i++) assert.equal((await request('/api/demo/register', null, 'POST', { phone, code: '000000', password, campus: 'shizishan' })).status, 400);
  assert.equal((await request('/api/demo/register', null, 'POST', { phone, code: second.body.demoCode, password, campus: 'shizishan' })).status, 429);
});

test('代取员离线和限单由服务端执行，管理者只可调整本校区代取员', async t => {
  const { request, login, orderBody } = await setup(t);
  const [student, courier, manager, studentSZ] = await Promise.all(['student-a','runner-cl-1','manager-cl','student-b'].map(login));
  const first = (await request('/api/orders', student, 'POST', orderBody())).body;
  const second = (await request('/api/orders', student, 'POST', orderBody({ pickupCode: 'TEST-5678' }))).body;
  assert.equal((await request('/api/couriers/me/availability', courier, 'POST', { online: false })).body.online, false);
  assert.equal((await request(`/api/orders/${first.id}/accept`, courier, 'POST')).status, 409);
  assert.equal((await request('/api/couriers/runner-sz-1/capacity', manager, 'POST', { maxActive: 1 })).status, 404);
  assert.equal((await request('/api/couriers/runner-cl-1/capacity', studentSZ, 'POST', { maxActive: 1 })).status, 403);
  assert.equal((await request('/api/couriers/runner-cl-1/capacity', manager, 'POST', { maxActive: 1 })).status, 200);
  assert.equal((await request('/api/couriers/me/availability', courier, 'POST', { online: true })).body.online, true);
  assert.equal((await request(`/api/orders/${first.id}/accept`, courier, 'POST')).status, 200);
  assert.equal((await request(`/api/orders/${second.id}/accept`, courier, 'POST')).status, 409);
});

test('异常上报、后台待办与处理限制，接单前仍不泄露取件码', async t => {
  const { request, login, orderBody, db } = await setup(t);
  const [student, courier, manager, courierSZ, admin] = await Promise.all(['student-a','runner-cl-1','manager-cl','runner-sz-1','admin'].map(login));
  const first = (await request('/api/orders', student, 'POST', orderBody())).body;
  const waiting = (await request('/api/orders', student, 'POST', orderBody({ pickupCode: 'TEST-5678' }))).body;
  db.prepare('UPDATE orders SET created_at=? WHERE id=?').run(new Date(Date.now()-31*60000).toISOString(),waiting.id);
  assert.equal((await request(`/api/orders/${first.id}/exception`, courierSZ, 'POST', { reason: 'pickup_failed' })).status, 404);
  assert.equal((await request(`/api/orders/${first.id}/accept`, courier, 'POST')).status, 200);
  assert.equal((await request(`/api/orders/${first.id}/exception`, courier, 'POST', { reason: 'pickup_failed' })).body.status, 'exception');
  assert.equal((await request(`/api/orders/${first.id}/exception`, courier, 'POST', { reason: 'other' })).status, 403);
  const queue = (await request('/api/operations/queue', manager)).body;
  assert.equal(queue.exceptions[0].exception.reason, 'pickup_failed');
  assert.equal(queue.overdue[0].id, waiting.id);
  assert.equal((await request('/api/operations/queue', courier)).status, 403);
  assert.equal((await request(`/api/orders/${first.id}/resolve`, manager, 'POST', { resolution: 'retry' })).body.status, 'pending');
  const task = (await request('/api/orders', courier)).body.find(o => o.id === first.id);
  assert.equal(task.pickup_code, undefined);
  assert.equal(task.handoff, undefined);
  assert.equal((await request(`/api/orders/${first.id}/accept`, courier, 'POST')).status, 200);
  assert.equal((await request(`/api/orders/${first.id}/progress`, courier, 'POST', { status: 'picked' })).status, 200);
  assert.equal((await request(`/api/orders/${first.id}/exception`, courier, 'POST', { reason: 'damaged' })).status, 200);
  assert.equal((await request(`/api/orders/${first.id}/resolve`, admin, 'POST', { resolution: 'retry' })).status, 400);
  assert.equal((await request(`/api/orders/${first.id}/resolve`, admin, 'POST', { resolution: 'resume' })).body.status, 'picked');
  assert.equal((await request(`/api/orders/${first.id}/exception`, courier, 'POST', { reason: 'damaged' })).status, 200);
  assert.equal((await request(`/api/orders/${first.id}/resolve`, manager, 'POST', { resolution: 'close' })).body.status, 'closed');
  const studentView = (await request(`/api/orders/${first.id}`, student)).body;
  assert.equal(studentView.status, 'closed');
  assert.equal(studentView.exception, undefined);
  assert.equal(studentView.lastResolution.reason, 'damaged');
  assert.equal(studentView.lastResolution.resolution, 'close');
  const capacity = await request(`/api/slots/capacity?campus=chenglong`, manager);
  assert.equal(capacity.body.slots.find(item => item.value === first.slot).booked, 2);
});

test('破损不能直接重新接单，暂停资格的原代取员不能恢复进度', async t => {
  const { request, login, orderBody } = await setup(t);
  const [student, courier, manager] = await Promise.all(['student-a','runner-cl-1','manager-cl'].map(login));
  const order = (await request('/api/orders', student, 'POST', orderBody())).body;
  assert.equal((await request(`/api/orders/${order.id}/accept`, courier, 'POST')).status, 200);
  assert.equal((await request(`/api/orders/${order.id}/exception`, courier, 'POST', { reason: 'damaged' })).status, 200);
  assert.equal((await request(`/api/orders/${order.id}/resolve`, manager, 'POST', { resolution: 'retry' })).status, 400);
  assert.equal((await request('/api/couriers/runner-cl-1/approval', manager, 'POST', { approved: false })).status, 200);
  assert.equal((await request(`/api/orders/${order.id}/resolve`, manager, 'POST', { resolution: 'resume' })).status, 409);
  assert.equal((await request(`/api/orders/${order.id}/resolve`, manager, 'POST', { resolution: 'close' })).body.status, 'closed');
});

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
  assert.equal(accepted.handoff, '东苑东1楼下公共入口（演示位置，待核实）');
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
  assert.equal(capabilities.body.version, '0.7.1');
  assert.equal(capabilities.body.apiContract, 10);
  assert.equal(capabilities.body.closedPilotReady, false);
});

test('多件包裹必须逐件提供虚构取件码，并在接单前隐藏全部码', async t => {
  const { request, login, orderBody } = await setup(t);
  const [student, courier, admin] = await Promise.all(['student-a', 'runner-cl-1', 'admin'].map(login));
  const body = orderBody({ qty: 2, pickupCodes: ['test-123456', 'TEST-5-2-0042'] });
  assert.equal((await request('/api/orders', student, 'POST', { ...body, pickupCodes: ['TEST-123456'] })).status, 400);
  assert.equal((await request('/api/orders', student, 'POST', { ...body, pickupCodes: ['TEST-123456', 'real-code'] })).status, 400);
  const created = await request('/api/orders', student, 'POST', body);
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.pickup_codes, ['TEST-123456', 'TEST-5-2-0042']);
  assert.equal((await request('/api/orders', student, 'POST', { ...body, pickupCodes: ['TEST-123456', 'TEST-5-2-0042'] })).body.id, created.body.id);
  assert.equal((await request('/api/orders', student, 'POST', { ...body, pickupCodes: ['TEST-123456', 'TEST-9999'] })).status, 409);
  const waiting = (await request(`/api/orders/${created.body.id}`, courier)).body;
  assert.equal(waiting.pickup_codes, undefined);
  assert.equal(waiting.pickup_code, undefined);
  assert.equal((await request(`/api/orders/${created.body.id}`, admin)).body.pickup_codes, undefined);
  const accepted = await request(`/api/orders/${created.body.id}/accept`, courier, 'POST');
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body.pickup_codes, ['TEST-123456', 'TEST-5-2-0042']);
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
