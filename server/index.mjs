import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const campusZones = {
  chenglong: ['东苑', '西苑'],
  shizishan: ['博学苑', '重德苑', '聚贤苑', '尚美苑', '务实苑']
};
const stations = [
  { id: 'demo-cl', campus: 'chenglong', name: '成龙虚构测试点', verified: false, acceptingRealOrders: false },
  { id: 'demo-sz', campus: 'shizishan', name: '狮子山虚构测试点', verified: false, acceptingRealOrders: false }
];
const fixtures = [
  ['student-a', '学生甲（测试）', 'student', 'chenglong', 1],
  ['student-b', '学生乙（测试）', 'student', 'shizishan', 1],
  ['runner-cl-1', '成龙代取员甲（测试）', 'courier', 'chenglong', 1],
  ['runner-cl-2', '成龙代取员乙（待审核）', 'courier', 'chenglong', 0],
  ['runner-sz-1', '狮子山代取员甲（测试）', 'courier', 'shizishan', 1],
  ['manager-cl', '成龙主管（测试）', 'manager', 'chenglong', 1],
  ['admin', '总管理员（测试）', 'admin', null, 1]
];
const publicColumns = 'id, student_id, campus, station_id, zone, qty, size, speed, slot, amount_cents, payment_status, status, courier_id, created_at, updated_at';

export function createApp({ dbPath = join(root, 'data', 'campus-express.sqlite') } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, campus TEXT, approved INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, student_id TEXT NOT NULL REFERENCES users(id),
      campus TEXT NOT NULL, station_id TEXT NOT NULL, zone TEXT NOT NULL, handoff TEXT NOT NULL,
      pickup_code TEXT NOT NULL, qty INTEGER NOT NULL, size TEXT NOT NULL, speed TEXT NOT NULL,
      slot TEXT NOT NULL, amount_cents INTEGER NOT NULL, payment_status TEXT NOT NULL,
      status TEXT NOT NULL, courier_id TEXT REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(student_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS orders_campus_status ON orders(campus,status);
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_id TEXT NOT NULL,
      action TEXT NOT NULL, order_id TEXT, target_id TEXT
    );`);
  const seed = db.prepare('INSERT OR IGNORE INTO users (id,name,role,campus,approved) VALUES (?,?,?,?,?)');
  for (const user of fixtures) seed.run(...user);
  const sessions = new Map();
  const getUser = id => db.prepare('SELECT id,name,role,campus,approved FROM users WHERE id=?').get(id);
  const getOrder = id => db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  const audit = (actor, action, orderId = null, targetId = null) =>
    db.prepare('INSERT INTO audit_logs(at,actor_id,action,order_id,target_id) VALUES (?,?,?,?,?)')
      .run(new Date().toISOString(), actor, action, orderId, targetId);
  const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
  const send = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  const bodyOf = async req => {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail(415, '只接受 JSON');
    let data = '';
    for await (const chunk of req) { data += chunk; if (data.length > 8192) fail(413, '请求过大'); }
    try { const value = JSON.parse(data); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); return value; }
    catch { fail(400, 'JSON 格式错误'); }
  };
  const view = (order, user) => {
    const base = Object.fromEntries(publicColumns.split(', ').map(k => [k, order[k]]));
    if (user.role === 'courier' && order.courier_id !== user.id) {
      delete base.student_id;
      delete base.courier_id;
      return base;
    }
    if (user.id === order.student_id || user.id === order.courier_id) {
      base.handoff = order.handoff;
      base.pickup_code = order.pickup_code;
    } else if (user.role === 'admin' || user.role === 'manager') {
      base.handoff = order.handoff;
    }
    return base;
  };
  const canSee = (o, u) => u.role === 'admin' || (u.role === 'manager' && o.campus === u.campus)
    || (u.role === 'student' && o.student_id === u.id)
    || (u.role === 'courier' && u.approved && o.campus === u.campus && (o.status === 'pending' || o.courier_id === u.id));
  const requireRole = (user, ...roles) => { if (!roles.includes(user.role)) fail(403, '无权执行'); };
  const now = () => new Date().toISOString();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' || !['/', '/app.js', '/style.css'].includes(url.pathname)) fail(404, '页面不存在');
        const path = join(root, 'web', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        const content = await readFile(path);
        res.writeHead(200, { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'" });
        res.end(content); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/capabilities') return send(res, 200, { version: '0.3.0', mode: 'LOCAL_DEMO_ONLY', realOrders: false, realPayment: false, realAuthentication: false });
      if (req.method === 'GET' && url.pathname === '/api/demo/accounts') return send(res, 200, fixtures.map(([id, name, role, campus]) => ({ id, name, role, campus })));
      if (req.method === 'POST' && url.pathname === '/api/demo/login') {
        const { accountId } = await bodyOf(req);
        const user = getUser(accountId);
        if (!user) fail(404, '测试账号不存在');
        const token = randomBytes(32).toString('hex');
        sessions.set(token, user.id);
        return send(res, 200, { token, user });
      }
      const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      const user = token && getUser(sessions.get(token));
      if (!user) fail(401, '请先选择测试身份');
      if (req.method === 'GET' && url.pathname === '/api/me') return send(res, 200, user);
      if (req.method === 'GET' && url.pathname === '/api/catalog') return send(res, 200, { campusZones, stations });
      if (req.method === 'GET' && url.pathname === '/api/orders') {
        let rows;
        if (user.role === 'student') rows = db.prepare('SELECT * FROM orders WHERE student_id=? ORDER BY created_at DESC').all(user.id);
        else if (user.role === 'courier') {
          if (!user.approved) fail(403, '代取员尚未审核');
          rows = db.prepare("SELECT * FROM orders WHERE campus=? AND (status='pending' OR courier_id=?) ORDER BY created_at DESC").all(user.campus, user.id);
        } else if (user.role === 'manager') rows = db.prepare('SELECT * FROM orders WHERE campus=? ORDER BY created_at DESC').all(user.campus);
        else rows = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
        return send(res, 200, rows.map(row => view(row, user)));
      }
      if (req.method === 'POST' && url.pathname === '/api/orders') {
        requireRole(user, 'student');
        const b = await bodyOf(req);
        if (!/^[a-zA-Z0-9-]{8,64}$/.test(b.requestId || '')) fail(400, '缺少有效请求编号');
        const existing = db.prepare('SELECT * FROM orders WHERE student_id=? AND request_id=?').get(user.id, b.requestId);
        if (existing) return send(res, 200, view(existing, user));
        const station = stations.find(s => s.id === b.stationId && s.campus === user.campus);
        if (!station || b.campus !== user.campus || !campusZones[user.campus].includes(b.zone)) fail(400, '校区、苑区或测试站点无效');
        if (!Number.isInteger(b.qty) || b.qty < 1 || b.qty > 3 || !['small', 'large'].includes(b.size) || !['normal', 'urgent'].includes(b.speed)) fail(400, '包裹参数无效');
        if (!['today-evening', 'tomorrow-noon'].includes(b.slot)) fail(400, '预约时段无效');
        if (typeof b.handoff !== 'string' || b.handoff.length < 2 || b.handoff.length > 60 || !b.handoff.includes(b.zone) || !b.handoff.includes('测试') || /1[3-9]\d{9}|\d{2,4}[- ]?\d{6,8}/.test(b.handoff)) fail(400, '交接点只允许本苑区楼下的虚构测试位置');
        if (typeof b.pickupCode !== 'string' || !/^TEST-[A-Z0-9]{4,12}$/.test(b.pickupCode)) fail(400, '只允许 TEST- 开头的虚构取件码');
        const id = randomUUID(), at = now(), amount = (b.size === 'large' ? 500 : 300) + (b.qty - 1) * 100 + (b.speed === 'urgent' ? 200 : 0);
        db.prepare(`INSERT INTO orders (id,request_id,student_id,campus,station_id,zone,handoff,pickup_code,qty,size,speed,slot,amount_cents,payment_status,status,courier_id,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'demo_not_paid','pending',NULL,?,?)`).run(id,b.requestId,user.id,user.campus,station.id,b.zone,b.handoff,b.pickupCode,b.qty,b.size,b.speed,b.slot,amount,at,at);
        audit(user.id, 'demo_order_created', id);
        return send(res, 201, view(getOrder(id), user));
      }
      const orderMatch = url.pathname.match(/^\/api\/orders\/([a-f0-9-]{36})(?:\/(accept|assign|progress|confirm|cancel))?$/);
      if (orderMatch) {
        const [, id, action] = orderMatch;
        const o = getOrder(id);
        if (!o || !canSee(o, user)) fail(404, '订单不存在');
        if (req.method === 'GET' && !action) return send(res, 200, view(o, user));
        if (req.method !== 'POST' || !action) fail(405, '不支持的操作');
        let result, nextAction = action;
        if (action === 'accept') {
          requireRole(user, 'courier');
          if (!user.approved || user.campus !== o.campus) fail(403, '无权接单');
          result = db.prepare("UPDATE orders SET status='assigned',courier_id=?,updated_at=? WHERE id=? AND status='pending' AND courier_id IS NULL").run(user.id,now(),id);
        } else if (action === 'assign') {
          requireRole(user, 'admin', 'manager');
          if (user.role === 'manager' && user.campus !== o.campus) fail(403, '无权跨校区派单');
          const { courierId } = await bodyOf(req);
          const courier = getUser(courierId);
          if (!courier || courier.role !== 'courier' || !courier.approved || courier.campus !== o.campus) fail(400, '代取员未审核或校区不符');
          result = db.prepare("UPDATE orders SET status='assigned',courier_id=?,updated_at=? WHERE id=? AND status='pending' AND courier_id IS NULL").run(courier.id,now(),id);
        } else if (action === 'progress') {
          requireRole(user, 'courier');
          if (o.courier_id !== user.id || !user.approved) fail(403, '仅本单代取员可更新');
          const { status } = await bodyOf(req);
          const previous = { picked: 'assigned', delivering: 'picked', delivered: 'delivering' }[status];
          if (!previous) fail(400, '状态无效');
          result = db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=? AND status=? AND courier_id=?').run(status,now(),id,previous,user.id);
          nextAction = `progress_${status}`;
        } else if (action === 'confirm') {
          requireRole(user, 'student');
          if (o.student_id !== user.id) fail(403, '仅下单学生可确认');
          result = db.prepare("UPDATE orders SET status='completed',updated_at=? WHERE id=? AND status='delivered' AND student_id=?").run(now(),id,user.id);
        } else if (action === 'cancel') {
          requireRole(user, 'student');
          if (o.student_id !== user.id) fail(403, '仅下单学生可取消');
          result = db.prepare("UPDATE orders SET status='cancelled',updated_at=? WHERE id=? AND status='pending' AND student_id=?").run(now(),id,user.id);
        }
        if (!result?.changes) fail(409, '订单状态已变化，请刷新后重试');
        audit(user.id, nextAction, id);
        return send(res, 200, view(getOrder(id), user));
      }
      if (req.method === 'GET' && url.pathname === '/api/couriers') {
        requireRole(user, 'admin', 'manager');
        const rows = user.role === 'admin' ? db.prepare("SELECT id,name,campus,approved FROM users WHERE role='courier'").all() : db.prepare("SELECT id,name,campus,approved FROM users WHERE role='courier' AND campus=?").all(user.campus);
        return send(res, 200, rows);
      }
      const approval = url.pathname.match(/^\/api\/couriers\/([a-z0-9-]+)\/approval$/);
      if (req.method === 'POST' && approval) {
        requireRole(user, 'admin', 'manager');
        const courier = getUser(approval[1]);
        if (!courier || courier.role !== 'courier' || (user.role === 'manager' && user.campus !== courier.campus)) fail(404, '代取员不存在');
        const { approved } = await bodyOf(req);
        if (typeof approved !== 'boolean') fail(400, '审核值无效');
        db.prepare('UPDATE users SET approved=? WHERE id=?').run(approved ? 1 : 0, courier.id);
        audit(user.id, approved ? 'courier_approved' : 'courier_suspended', null, courier.id);
        return send(res, 200, getUser(courier.id));
      }
      if (req.method === 'GET' && url.pathname === '/api/audit') {
        requireRole(user, 'admin', 'manager');
        const rows = user.role === 'admin' ? db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100').all() : db.prepare("SELECT a.* FROM audit_logs a LEFT JOIN orders o ON a.order_id=o.id LEFT JOIN users u ON a.target_id=u.id WHERE o.campus=? OR (a.order_id IS NULL AND u.campus=?) ORDER BY a.id DESC LIMIT 100").all(user.campus,user.campus);
        return send(res, 200, rows);
      }
      fail(404, '接口不存在');
    } catch (e) {
      send(res, e.status || 500, { error: e.status ? e.message : '服务器内部错误' });
      if (!e.status) console.error(e);
    }
  });
  return { server, db, close: () => { server.close(); db.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port = 3000, host = '127.0.0.1' } = { port: Number(process.env.PORT || 3000) };
  if (host !== '127.0.0.1') throw Error('本地演示仅允许 127.0.0.1');
  await mkdir(join(root, 'data'), { recursive: true });
  createApp().server.listen(port, host, () => console.log(`校园快取通 V0.3 本地演示：http://${host}:${port}`));
}
