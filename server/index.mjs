import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseDemoPickupCode } from '../web/pickup-code.js';
import { availableSlots, validSlot } from './slots.mjs';

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

export function createApp({ dbPath = join(root, 'data', 'campus-express.sqlite'), sessionClock = () => Date.now() } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, campus TEXT, approved INTEGER NOT NULL, online INTEGER NOT NULL DEFAULT 1, max_active INTEGER NOT NULL DEFAULT 2);
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
    );
    CREATE TABLE IF NOT EXISTS order_exceptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id),
      reporter_id TEXT NOT NULL REFERENCES users(id), reason TEXT NOT NULL,
      previous_status TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT, created_at TEXT NOT NULL, resolved_at TEXT,
      resolver_id TEXT REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS order_exceptions_order ON order_exceptions(order_id,status);`);
  db.exec(`CREATE TABLE IF NOT EXISTS slot_limits (
    campus TEXT NOT NULL, slot TEXT NOT NULL, capacity INTEGER NOT NULL,
    PRIMARY KEY(campus,slot)
  );
  CREATE INDEX IF NOT EXISTS orders_campus_slot ON orders(campus,slot,status);`);
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
  if (!userColumns.has('online')) db.exec('ALTER TABLE users ADD COLUMN online INTEGER NOT NULL DEFAULT 1');
  if (!userColumns.has('max_active')) db.exec('ALTER TABLE users ADD COLUMN max_active INTEGER NOT NULL DEFAULT 2');
  const seed = db.prepare('INSERT OR IGNORE INTO users (id,name,role,campus,approved) VALUES (?,?,?,?,?)');
  for (const user of fixtures) seed.run(...user);
  const sessions = new Map();
  const sessionLifetimeMs = 30 * 60 * 1000;
  const sessionUser = token => {
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= sessionClock()) { sessions.delete(token); return null; }
    return session.userId;
  };
  const getUser = id => db.prepare('SELECT id,name,role,campus,approved,online,max_active FROM users WHERE id=?').get(id);
  const getOrder = id => db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  const audit = (actor, action, orderId = null, targetId = null) =>
    db.prepare('INSERT INTO audit_logs(at,actor_id,action,order_id,target_id) VALUES (?,?,?,?,?)')
      .run(new Date().toISOString(), actor, action, orderId, targetId);
  const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
  const errorCode = status => ({ 400: 'VALIDATION_ERROR', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE' }[status] || 'INTERNAL_ERROR');
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
    const issue = db.prepare("SELECT id,reason,previous_status,created_at FROM order_exceptions WHERE order_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(order.id);
    if (issue) base.exception = issue;
    const lastResolution = db.prepare("SELECT reason,previous_status,resolution,created_at,resolved_at FROM order_exceptions WHERE order_id=? AND status='resolved' ORDER BY id DESC LIMIT 1").get(order.id);
    if (lastResolution) base.lastResolution = lastResolution;
    return base;
  };
  const canSee = (o, u) => u.role === 'admin' || (u.role === 'manager' && o.campus === u.campus)
    || (u.role === 'student' && o.student_id === u.id)
    || (u.role === 'courier' && u.approved && o.campus === u.campus && (o.status === 'pending' || o.courier_id === u.id));
  const requireRole = (user, ...roles) => { if (!roles.includes(user.role)) fail(403, '无权执行'); };
  const now = () => new Date().toISOString();
  const activeStatuses = "'assigned','picked','delivering','delivered','exception'";
  const activeCount = id => db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE courier_id=? AND status IN (${activeStatuses})`).get(id).count;
  const bookedCount = (campus, slot) => db.prepare(`SELECT COUNT(*) AS count FROM orders o WHERE campus=? AND slot=? AND (
    status<>'cancelled' OR EXISTS (SELECT 1 FROM order_exceptions e WHERE e.order_id=o.id AND e.resolution='close' AND e.previous_status IN ('picked','delivering','delivered'))
  )`).get(campus,slot).count;
  const slotLimit = (campus, slot) => db.prepare('SELECT capacity FROM slot_limits WHERE campus=? AND slot=?').get(campus,slot)?.capacity ?? 3;
  const slotAvailability = campus => availableSlots().map(slot => {
    const capacity = slotLimit(campus,slot.value), booked = bookedCount(campus,slot.value);
    return { ...slot, capacity, booked, remaining: Math.max(0,capacity-booked) };
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' || !['/', '/file-entry.js', '/app.js', '/style.css', '/form.css', '/pickup-code.js', '/assets/sichuan-normal-university-logos.png'].includes(url.pathname)) fail(404, '页面不存在');
        const path = join(root, 'web', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        const content = await readFile(path);
        res.writeHead(200, { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : url.pathname.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'" });
        res.end(content); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/capabilities') return send(res, 200, { version: '0.5.3', apiContract: 6, mode: 'LOCAL_DEMO_ONLY', realOrders: false, realPayment: false, realAuthentication: false, closedPilotReady: false });
      if (req.method === 'GET' && url.pathname === '/api/demo/accounts') return send(res, 200, fixtures.map(([id, name, role, campus]) => ({ id, name, role, campus })));
      if (req.method === 'POST' && url.pathname === '/api/demo/login') {
        const { accountId } = await bodyOf(req);
        const user = getUser(accountId);
        if (!user) fail(404, '测试账号不存在');
        const token = randomBytes(32).toString('hex');
        const expiresAt = sessionClock() + sessionLifetimeMs;
        sessions.set(token, { userId: user.id, expiresAt });
        return send(res, 200, { token, user, expiresAt: new Date(expiresAt).toISOString() });
      }
      const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      const sessionUserId = token && sessionUser(token);
      const user = sessionUserId && getUser(sessionUserId);
      if (!user) fail(401, '测试身份已失效，请重新选择');
      if (req.method === 'POST' && url.pathname === '/api/session/logout') {
        sessions.delete(token);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/me') return send(res, 200, user);
      if (url.pathname === '/api/couriers/me/availability') {
        requireRole(user, 'courier');
        if (req.method === 'GET') return send(res, 200, { online: Boolean(user.online), approved: Boolean(user.approved), maxActive: user.max_active, activeCount: activeCount(user.id) });
        if (req.method !== 'POST') fail(405, '不支持的操作');
        const { online } = await bodyOf(req);
        if (typeof online !== 'boolean') fail(400, '上线状态无效');
        if (!user.approved && online) fail(403, '代取员尚未审核');
        db.prepare('UPDATE users SET online=? WHERE id=?').run(online ? 1 : 0, user.id);
        audit(user.id, online ? 'courier_online' : 'courier_offline');
        return send(res, 200, { online, approved: Boolean(user.approved), maxActive: user.max_active, activeCount: activeCount(user.id) });
      }
      if (req.method === 'GET' && url.pathname === '/api/catalog') return send(res, 200, { campusZones, stations, slots: user.campus ? slotAvailability(user.campus).filter(slot => slot.remaining > 0) : availableSlots() });
      if (url.pathname === '/api/slots/capacity') {
        requireRole(user, 'admin', 'manager');
        if (req.method === 'GET') {
          const campus = url.searchParams.get('campus') || user.campus;
          if (!campusZones[campus] || (user.role === 'manager' && campus !== user.campus)) fail(403, '无权查看该校区时段');
          return send(res, 200, { campus, slots: slotAvailability(campus) });
        }
        if (req.method !== 'POST') fail(405, '不支持的操作');
        const { campus, slot, capacity } = await bodyOf(req);
        if (!campusZones[campus] || (user.role === 'manager' && campus !== user.campus)) fail(403, '无权设置该校区时段');
        if (!validSlot(slot) || !Number.isInteger(capacity) || capacity < 0 || capacity > 20) fail(400, '时段或容量无效');
        db.exec('BEGIN IMMEDIATE');
        try {
          if (capacity < bookedCount(campus,slot)) fail(409, '容量不能低于已预约数量');
          db.prepare('INSERT INTO slot_limits(campus,slot,capacity) VALUES (?,?,?) ON CONFLICT(campus,slot) DO UPDATE SET capacity=excluded.capacity').run(campus,slot,capacity);
          audit(user.id, 'slot_capacity_updated');
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return send(res, 200, slotAvailability(campus).find(item => item.value === slot));
      }
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
        let responseStatus, responseOrder;
        db.exec('BEGIN IMMEDIATE');
        try {
          const existing = db.prepare('SELECT * FROM orders WHERE student_id=? AND request_id=?').get(user.id, b.requestId);
          if (existing) {
            const sameRequest = existing.campus === b.campus && existing.station_id === b.stationId
              && existing.zone === b.zone && existing.pickup_code === parseDemoPickupCode(b.pickupCode)?.value
              && existing.qty === b.qty && existing.size === b.size && existing.speed === b.speed && existing.slot === b.slot
              && !Object.hasOwn(b, 'handoff');
            if (!sameRequest) fail(409, '该请求编号已用于其他订单内容，请刷新后重试');
            responseStatus = 200;
            responseOrder = existing;
          } else {
            const station = stations.find(s => s.id === b.stationId && s.campus === user.campus);
            if (!station || b.campus !== user.campus || !campusZones[user.campus].includes(b.zone)) fail(400, '校区、苑区或测试站点无效');
            if (!Number.isInteger(b.qty) || b.qty < 1 || b.qty > 3 || !['small', 'large'].includes(b.size) || !['normal', 'urgent'].includes(b.speed)) fail(400, '包裹参数无效');
            if (!validSlot(b.slot)) fail(400, '请选择未过期的白天或傍晚一小时时段（09:00–19:00）');
            if (Object.hasOwn(b, 'handoff')) fail(400, '见面位置由宿舍苑区自动确定，无需填写地址');
            const handoff = `${b.zone}楼下公共入口（测试）`;
            const pickupCode = parseDemoPickupCode(b.pickupCode);
            if (!pickupCode) fail(400, '仅接受 TEST- 开头的虚构码：数字码、货架-层-末四位或字母数字码');
            if (bookedCount(user.campus,b.slot) >= slotLimit(user.campus,b.slot)) fail(409, '该时段已约满，请刷新后选择其他时段');
            const id = randomUUID(), at = now(), amount = (b.size === 'large' ? 500 : 300) + (b.qty - 1) * 100 + (b.speed === 'urgent' ? 200 : 0);
            db.prepare(`INSERT INTO orders (id,request_id,student_id,campus,station_id,zone,handoff,pickup_code,qty,size,speed,slot,amount_cents,payment_status,status,courier_id,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'demo_not_paid','pending',NULL,?,?)`).run(id,b.requestId,user.id,user.campus,station.id,b.zone,handoff,pickupCode.value,b.qty,b.size,b.speed,b.slot,amount,at,at);
            audit(user.id, 'demo_order_created', id);
            responseStatus = 201;
            responseOrder = getOrder(id);
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return send(res, responseStatus, view(responseOrder, user));
      }
      const orderMatch = url.pathname.match(/^\/api\/orders\/([a-f0-9-]{36})(?:\/(accept|assign|progress|confirm|cancel|exception|resolve))?$/);
      if (orderMatch) {
        const [, id, action] = orderMatch;
        const o = getOrder(id);
        if (!o || !canSee(o, user)) fail(404, '订单不存在');
        if (req.method === 'GET' && !action) return send(res, 200, view(o, user));
        if (req.method !== 'POST' || !action) fail(405, '不支持的操作');
        if (action === 'exception') {
          const reporterAllowed = (user.role === 'courier' && o.courier_id === user.id && ['assigned', 'picked', 'delivering', 'delivered'].includes(o.status))
            || (user.role === 'student' && o.student_id === user.id && o.status === 'delivered')
            || (['admin', 'manager'].includes(user.role) && ['assigned', 'picked', 'delivering', 'delivered'].includes(o.status));
          if (!reporterAllowed) fail(403, '当前身份或订单状态不能上报异常');
          const { reason } = await bodyOf(req);
          if (!['pickup_failed', 'damaged', 'student_unavailable', 'other'].includes(reason)) fail(400, '请选择异常类型');
          db.exec('BEGIN IMMEDIATE');
          try {
            const changed = db.prepare("UPDATE orders SET status='exception',updated_at=? WHERE id=? AND status=?").run(now(),id,o.status);
            if (!changed.changes) fail(409, '订单状态已变化，请刷新后重试');
            db.prepare("INSERT INTO order_exceptions(order_id,reporter_id,reason,previous_status,created_at) VALUES (?,?,?,?,?)").run(id,user.id,reason,o.status,now());
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          audit(user.id, 'exception_reported', id);
          return send(res, 200, view(getOrder(id), user));
        }
        if (action === 'resolve') {
          requireRole(user, 'admin', 'manager');
          const { resolution } = await bodyOf(req);
          const issue = db.prepare("SELECT * FROM order_exceptions WHERE order_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(id);
          if (!issue || o.status !== 'exception') fail(409, '没有待处理异常');
          if (!['resume', 'retry', 'close'].includes(resolution)) fail(400, '处理方式无效');
          if (resolution === 'retry' && issue.previous_status !== 'assigned') fail(400, '已取件后不能直接重新开放接单，请先核实包裹去向');
          if (resolution === 'retry' && issue.reason === 'damaged') fail(400, '破损异常不能直接重新开放接单，请先核实包裹状态');
          if (resolution === 'resume' && o.courier_id) {
            const courier = getUser(o.courier_id);
            if (!courier?.approved) fail(409, '原代取员已暂停资格，不能恢复原进度');
          }
          const nextStatus = resolution === 'resume' ? issue.previous_status : resolution === 'retry' ? 'pending' : 'closed';
          db.exec('BEGIN IMMEDIATE');
          try {
            const changed = db.prepare("UPDATE orders SET status=?,courier_id=?,updated_at=? WHERE id=? AND status='exception'").run(nextStatus,resolution === 'retry' ? null : o.courier_id,now(),id);
            if (!changed.changes) fail(409, '订单状态已变化，请刷新后重试');
            db.prepare("UPDATE order_exceptions SET status='resolved',resolution=?,resolved_at=?,resolver_id=? WHERE id=? AND status='open'").run(resolution,now(),user.id,issue.id);
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          audit(user.id, `exception_${resolution}`, id);
          return send(res, 200, view(getOrder(id), user));
        }
        let result, nextAction = action;
        if (action === 'accept') {
          requireRole(user, 'courier');
          if (!user.approved || user.campus !== o.campus) fail(403, '无权接单');
          if (!user.online) fail(409, '请先上线接单');
          if (activeCount(user.id) >= user.max_active) fail(409, '已达到同时处理订单上限');
          result = db.prepare(`UPDATE orders SET status='assigned',courier_id=?,updated_at=? WHERE id=? AND status='pending' AND courier_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE id=? AND approved=1 AND online=1 AND (SELECT COUNT(*) FROM orders WHERE courier_id=? AND status IN (${activeStatuses})) < max_active)`).run(user.id,now(),id,user.id,user.id);
        } else if (action === 'assign') {
          requireRole(user, 'admin', 'manager');
          if (user.role === 'manager' && user.campus !== o.campus) fail(403, '无权跨校区派单');
          const { courierId } = await bodyOf(req);
          const courier = getUser(courierId);
          if (!courier || courier.role !== 'courier' || !courier.approved || courier.campus !== o.campus) fail(400, '代取员未审核或校区不符');
          if (!courier.online || activeCount(courier.id) >= courier.max_active) fail(409, '代取员离线或已达接单上限');
          result = db.prepare(`UPDATE orders SET status='assigned',courier_id=?,updated_at=? WHERE id=? AND status='pending' AND courier_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE id=? AND approved=1 AND online=1 AND (SELECT COUNT(*) FROM orders WHERE courier_id=? AND status IN (${activeStatuses})) < max_active)`).run(courier.id,now(),id,courier.id,courier.id);
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
        const rows = user.role === 'admin' ? db.prepare("SELECT id,name,campus,approved,online,max_active FROM users WHERE role='courier'").all() : db.prepare("SELECT id,name,campus,approved,online,max_active FROM users WHERE role='courier' AND campus=?").all(user.campus);
        rows.forEach(c => { c.active_count = activeCount(c.id); });
        return send(res, 200, rows);
      }
      if (req.method === 'GET' && url.pathname === '/api/operations/queue') {
        requireRole(user, 'admin', 'manager');
        const campusFilter = user.role === 'manager' ? 'AND campus=?' : '';
        const params = user.role === 'manager' ? [user.campus] : [];
        const exceptions = db.prepare(`SELECT * FROM orders WHERE status='exception' ${campusFilter} ORDER BY updated_at ASC`).all(...params).map(o => view(o,user));
        const overdue = db.prepare(`SELECT * FROM orders WHERE status='pending' AND created_at<=? ${campusFilter} ORDER BY created_at ASC`).all(new Date(Date.now()-30*60000).toISOString(),...params).map(o => view(o,user));
        return send(res, 200, { exceptions, overdue });
      }
      const approval = url.pathname.match(/^\/api\/couriers\/([a-z0-9-]+)\/approval$/);
      if (req.method === 'POST' && approval) {
        requireRole(user, 'admin', 'manager');
        const courier = getUser(approval[1]);
        if (!courier || courier.role !== 'courier' || (user.role === 'manager' && user.campus !== courier.campus)) fail(404, '代取员不存在');
        const { approved } = await bodyOf(req);
        if (typeof approved !== 'boolean') fail(400, '审核值无效');
        db.prepare('UPDATE users SET approved=?,online=? WHERE id=?').run(approved ? 1 : 0, approved ? courier.online : 0, courier.id);
        audit(user.id, approved ? 'courier_approved' : 'courier_suspended', null, courier.id);
        return send(res, 200, getUser(courier.id));
      }
      const capacity = url.pathname.match(/^\/api\/couriers\/([a-z0-9-]+)\/capacity$/);
      if (req.method === 'POST' && capacity) {
        requireRole(user, 'admin', 'manager');
        const courier = getUser(capacity[1]);
        if (!courier || courier.role !== 'courier' || (user.role === 'manager' && user.campus !== courier.campus)) fail(404, '代取员不存在');
        const { maxActive } = await bodyOf(req);
        if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 5) fail(400, '同时处理订单上限须为 1–5');
        db.prepare('UPDATE users SET max_active=? WHERE id=?').run(maxActive,courier.id);
        audit(user.id, 'courier_capacity_updated', null, courier.id);
        return send(res, 200, getUser(courier.id));
      }
      if (req.method === 'GET' && url.pathname === '/api/audit') {
        requireRole(user, 'admin', 'manager');
        const rows = user.role === 'admin' ? db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100').all() : db.prepare("SELECT a.* FROM audit_logs a LEFT JOIN orders o ON a.order_id=o.id LEFT JOIN users u ON a.target_id=u.id WHERE o.campus=? OR (a.order_id IS NULL AND u.campus=?) ORDER BY a.id DESC LIMIT 100").all(user.campus,user.campus);
        return send(res, 200, rows);
      }
      fail(404, '接口不存在');
    } catch (e) {
      send(res, e.status || 500, { code: errorCode(e.status || 500), error: e.status ? e.message : '服务器内部错误' });
      if (!e.status) console.error(e);
    }
  });
  return { server, db, close: () => { server.close(); db.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port = 3000, host = '127.0.0.1' } = { port: Number(process.env.PORT || 3000) };
  if (host !== '127.0.0.1') throw Error('本地演示仅允许 127.0.0.1');
  await mkdir(join(root, 'data'), { recursive: true });
  createApp().server.listen(port, host, () => console.log(`校园快取通 V0.5.3 本地演示：http://${host}:${port}`));
}
