import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, randomInt, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseDemoPickupCode } from '../web/pickup-code.js';
import { availableSlots, validSlot } from './slots.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const campusZones = {
  chenglong: ['东苑', '西苑'],
  shizishan: ['博学苑', '重德苑', '聚贤苑', '尚美苑', '务实苑']
};
// 用户提供的待核实范围；西苑及狮子山楼号尚未确认。
const campusBuildings = { chenglong: { '东苑': Array.from({ length: 13 }, (_, i) => `东${i + 1}`), '西苑': [] }, shizishan: {} };
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
const publicColumns = 'id, student_id, campus, station_id, zone, building, qty, size, speed, slot, amount_cents, payment_status, status, courier_id, created_at, updated_at';

export function createApp({ dbPath = join(root, 'data', 'campus-express.sqlite'), sessionClock = () => Date.now(), runtimeMode = process.env.NODE_ENV || 'development' } = {}) {
  if (!['development', 'test'].includes(runtimeMode)) throw Error('本机演示服务禁止在正式环境启动；请先完成可信身份与试用安全验收');
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, campus TEXT, approved INTEGER NOT NULL, online INTEGER NOT NULL DEFAULT 1, max_active INTEGER NOT NULL DEFAULT 2);
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, student_id TEXT NOT NULL REFERENCES users(id),
      campus TEXT NOT NULL, station_id TEXT NOT NULL, zone TEXT NOT NULL, building TEXT, handoff TEXT NOT NULL,
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
  db.exec(`CREATE TABLE IF NOT EXISTS demo_credentials (
    phone TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
    password_hash TEXT NOT NULL, failed_count INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS demo_codes (
    phone TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL, sent_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(phone,purpose)
  );
  CREATE TABLE IF NOT EXISTS courier_applications (
    student_id TEXT PRIMARY KEY REFERENCES users(id), campus TEXT NOT NULL,
    status TEXT NOT NULL, courier_id TEXT REFERENCES users(id),
    created_at TEXT NOT NULL, reviewed_at TEXT, reviewed_by TEXT REFERENCES users(id)
  );`);
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
  if (!userColumns.has('online')) db.exec('ALTER TABLE users ADD COLUMN online INTEGER NOT NULL DEFAULT 1');
  if (!userColumns.has('max_active')) db.exec('ALTER TABLE users ADD COLUMN max_active INTEGER NOT NULL DEFAULT 2');
  const orderColumns = new Set(db.prepare('PRAGMA table_info(orders)').all().map(c => c.name));
  if (!orderColumns.has('building')) db.exec('ALTER TABLE orders ADD COLUMN building TEXT');
  if (!orderColumns.has('pickup_codes')) db.exec('ALTER TABLE orders ADD COLUMN pickup_codes TEXT');
  if (!orderColumns.has('handoff_code_hash')) db.exec('ALTER TABLE orders ADD COLUMN handoff_code_hash TEXT');
  if (!orderColumns.has('handoff_code_issued_at')) db.exec('ALTER TABLE orders ADD COLUMN handoff_code_issued_at INTEGER');
  if (!orderColumns.has('handoff_code_attempts')) db.exec('ALTER TABLE orders ADD COLUMN handoff_code_attempts INTEGER NOT NULL DEFAULT 0');
  // Handoff codes are keyed to this local demo process. After restart, require the student to issue a fresh code.
  db.exec("UPDATE orders SET handoff_code_hash=NULL,handoff_code_issued_at=NULL,handoff_code_attempts=0 WHERE status='delivering'");
  const seed = db.prepare('INSERT OR IGNORE INTO users (id,name,role,campus,approved) VALUES (?,?,?,?,?)');
  for (const user of fixtures) seed.run(...user);
  const sessions = new Map();
  const sessionLifetimeMs = 30 * 60 * 1000;
  const codeKey = randomBytes(32);
  const validDemoPhone = phone => typeof phone === 'string' && /^TEST-1[3-9]\d{9}$/.test(phone);
  const validPassword = value => typeof value === 'string' && value.length >= 10 && value.length <= 72 && !/\s/.test(value);
  const passwordHash = value => { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(value,salt,64).toString('hex'); };
  const passwordMatches = (value, stored) => { const [salt,hex] = stored.split(':'); const candidate = scryptSync(value,salt,64); return timingSafeEqual(candidate,Buffer.from(hex,'hex')); };
  const codeHash = (phone,purpose,code) => createHmac('sha256',codeKey).update(`${phone}:${purpose}:${code}`).digest('hex');
  const handoffCodeHash = (orderId,code) => createHmac('sha256',codeKey).update(`handoff:${orderId}:${code}`).digest('hex');
  const issueSession = user => {
    const token = randomBytes(32).toString('hex'), expiresAt = sessionClock() + sessionLifetimeMs;
    sessions.set(token,{ userId: user.id, expiresAt });
    return { token, user, expiresAt: new Date(expiresAt).toISOString() };
  };
  const revokeUserSessions = userId => { for (const [token,session] of sessions) if (session.userId === userId) sessions.delete(token); };
  const consumeCode = (phone,purpose,code) => {
    const row = db.prepare('SELECT * FROM demo_codes WHERE phone=? AND purpose=?').get(phone,purpose);
    if (!row || row.expires_at <= sessionClock()) fail(400,'演示验证码已失效，请重新获取');
    if (row.attempts >= 5) fail(429,'尝试次数过多，请重新获取演示验证码');
    if (typeof code !== 'string' || !/^\d{6}$/.test(code) || !timingSafeEqual(Buffer.from(row.code_hash,'hex'),Buffer.from(codeHash(phone,purpose,code),'hex'))) {
      db.prepare('UPDATE demo_codes SET attempts=attempts+1 WHERE phone=? AND purpose=?').run(phone,purpose);
      fail(400,'演示验证码不正确');
    }
    db.prepare('DELETE FROM demo_codes WHERE phone=? AND purpose=?').run(phone,purpose);
  };
  const sessionUser = token => {
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= sessionClock()) { sessions.delete(token); return null; }
    return session.userId;
  };
  const getUser = id => db.prepare('SELECT id,name,role,campus,approved,online,max_active FROM users WHERE id=?').get(id);
  const getOrder = id => db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  const storedCodes = order => order.pickup_codes ? JSON.parse(order.pickup_codes) : [order.pickup_code];
  const submittedCodes = body => {
    const input = Array.isArray(body.pickupCodes) ? body.pickupCodes : body.qty === 1 && typeof body.pickupCode === 'string' ? [body.pickupCode] : null;
    if (!input || input.length !== body.qty || body.qty < 1 || body.qty > 3) fail(400, '取件码数量必须与包裹件数一致');
    const codes = input.map(value => parseDemoPickupCode(value)?.value);
    if (codes.some(value => !value)) fail(400, '每件包裹都需填写 TEST- 开头的虚构取件码');
    return codes;
  };
  const audit = (actor, action, orderId = null, targetId = null) =>
    db.prepare('INSERT INTO audit_logs(at,actor_id,action,order_id,target_id) VALUES (?,?,?,?,?)')
      .run(new Date().toISOString(), actor, action, orderId, targetId);
  const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
  const errorCode = status => ({ 400: 'VALIDATION_ERROR', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'TOO_MANY_REQUESTS' }[status] || 'INTERNAL_ERROR');
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
      delete base.building;
      return base;
    }
    if (user.id === order.student_id || user.id === order.courier_id) {
      base.handoff = order.handoff;
      base.pickup_code = order.pickup_code;
      base.pickup_codes = storedCodes(order);
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
        if (req.method !== 'GET' || !['/', '/file-entry.js', '/app.js', '/style.css', '/form.css', '/theme.css', '/pickup-code.js', '/order-request.js', '/assets/sichuan-normal-university-logos.png'].includes(url.pathname)) fail(404, '页面不存在');
        const path = join(root, 'web', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        const content = await readFile(path);
        res.writeHead(200, { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : url.pathname.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'" });
        res.end(content); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/capabilities') return send(res, 200, { version: '0.8.0', apiContract: 11, mode: 'LOCAL_DEMO_ONLY', realOrders: false, realPayment: false, realAuthentication: false, realSms: false, closedPilotReady: false });
      if (req.method === 'GET' && url.pathname === '/api/demo/accounts') {
        const added = db.prepare("SELECT u.id,u.name,u.role,u.campus FROM courier_applications a JOIN users u ON u.id=a.courier_id WHERE a.status='approved'").all();
        return send(res, 200, [...fixtures.map(([id, name, role, campus]) => ({ id, name, role, campus })), ...added]);
      }
      if (req.method === 'POST' && url.pathname === '/api/demo/send-code') {
        const { phone, purpose } = await bodyOf(req);
        if (!validDemoPhone(phone) || !['register','reset'].includes(purpose)) fail(400,'只能使用 TEST- 开头的演示号码');
        const existing = db.prepare('SELECT user_id FROM demo_credentials WHERE phone=?').get(phone);
        if (purpose === 'register' && existing) fail(409,'该演示号码已注册，请直接登录');
        if (purpose === 'reset' && !existing) fail(404,'该演示号码尚未注册');
        const previous = db.prepare('SELECT sent_at FROM demo_codes WHERE phone=? AND purpose=?').get(phone,purpose);
        if (previous && sessionClock() - previous.sent_at < 60_000) fail(429,'请等待 60 秒后再次获取演示验证码');
        const code = String(randomInt(100000,1000000));
        db.prepare('INSERT INTO demo_codes(phone,purpose,code_hash,expires_at,sent_at,attempts) VALUES (?,?,?,?,?,0) ON CONFLICT(phone,purpose) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,sent_at=excluded.sent_at,attempts=0')
          .run(phone,purpose,codeHash(phone,purpose,code),sessionClock()+300_000,sessionClock());
        return send(res, 200, { demoCode: code, expiresInSeconds: 300, delivery: 'ON_PAGE_ONLY' });
      }
      if (req.method === 'POST' && url.pathname === '/api/demo/register') {
        const { phone, code, password, campus } = await bodyOf(req);
        if (!validDemoPhone(phone) || !campusZones[campus]) fail(400,'演示号码或校区无效');
        if (!validPassword(password)) fail(400,'演示密码须为 10–72 个非空白字符');
        if (db.prepare('SELECT 1 FROM demo_credentials WHERE phone=?').get(phone)) fail(409,'该演示号码已注册');
        consumeCode(phone,'register',code);
        db.exec('BEGIN IMMEDIATE');
        let user;
        try {
          const userId = `demo-student-${randomUUID()}`;
          db.prepare('INSERT INTO users(id,name,role,campus,approved) VALUES (?,?,?,?,1)').run(userId,'学生账号（演示）','student',campus);
          db.prepare('INSERT INTO demo_credentials(phone,user_id,password_hash) VALUES (?,?,?)').run(phone,userId,passwordHash(password));
          user = getUser(userId);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        audit(user.id,'demo_student_registered');
        return send(res, 201, issueSession(user));
      }
      if (req.method === 'POST' && url.pathname === '/api/demo/password-login') {
        const { phone, password } = await bodyOf(req);
        if (!validDemoPhone(phone) || !validPassword(password)) fail(401,'演示号码或密码不正确');
        const credential = db.prepare('SELECT * FROM demo_credentials WHERE phone=?').get(phone);
        if (!credential) fail(401,'演示号码或密码不正确');
        if (credential.locked_until > sessionClock()) fail(429,'演示账号暂时锁定，请稍后重试或找回密码');
        if (!passwordMatches(password,credential.password_hash)) {
          const failed = credential.failed_count + 1;
          db.prepare('UPDATE demo_credentials SET failed_count=?,locked_until=? WHERE phone=?').run(failed,failed >= 5 ? sessionClock()+900_000 : 0,phone);
          fail(401,'演示号码或密码不正确');
        }
        db.prepare('UPDATE demo_credentials SET failed_count=0,locked_until=0 WHERE phone=?').run(phone);
        return send(res, 200, issueSession(getUser(credential.user_id)));
      }
      if (req.method === 'POST' && url.pathname === '/api/demo/reset-password') {
        const { phone, code, password } = await bodyOf(req);
        if (!validDemoPhone(phone) || !validPassword(password)) fail(400,'演示号码或新密码无效');
        const credential = db.prepare('SELECT user_id FROM demo_credentials WHERE phone=?').get(phone);
        if (!credential) fail(404,'该演示号码尚未注册');
        consumeCode(phone,'reset',code);
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE demo_credentials SET password_hash=?,failed_count=0,locked_until=0 WHERE phone=?').run(passwordHash(password),phone);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        revokeUserSessions(credential.user_id);
        audit(credential.user_id,'demo_password_reset');
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/demo/login') {
        const { accountId } = await bodyOf(req);
        const user = getUser(accountId);
        if (!user) fail(404, '测试账号不存在');
        return send(res, 200, issueSession(user));
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
      if (url.pathname === '/api/courier-applications/me') {
        requireRole(user, 'student');
        if (req.method !== 'GET') fail(405, '不支持的操作');
        const application = db.prepare('SELECT campus,status,courier_id,created_at,reviewed_at FROM courier_applications WHERE student_id=?').get(user.id);
        return send(res, 200, application || { status: 'none' });
      }
      if (url.pathname === '/api/courier-applications' && req.method === 'POST') {
        requireRole(user, 'student');
        await bodyOf(req);
        db.exec('BEGIN IMMEDIATE');
        try {
          const previous = db.prepare('SELECT status FROM courier_applications WHERE student_id=?').get(user.id);
          if (previous?.status === 'pending') fail(409, '申请正在等待本校区主管审核');
          if (previous?.status === 'approved') fail(409, '申请已通过，请使用代取员测试身份进入');
          db.prepare("INSERT INTO courier_applications(student_id,campus,status,created_at) VALUES (?,?,'pending',?) ON CONFLICT(student_id) DO UPDATE SET status='pending',courier_id=NULL,created_at=excluded.created_at,reviewed_at=NULL,reviewed_by=NULL")
            .run(user.id,user.campus,now());
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        audit(user.id, 'courier_application_submitted', null, user.id);
        return send(res, 201, { status: 'pending', campus: user.campus });
      }
      if (url.pathname === '/api/courier-applications' && req.method === 'GET') {
        requireRole(user, 'admin', 'manager');
        const rows = user.role === 'admin'
          ? db.prepare('SELECT student_id,campus,status,created_at,reviewed_at FROM courier_applications ORDER BY created_at DESC').all()
          : db.prepare('SELECT student_id,campus,status,created_at,reviewed_at FROM courier_applications WHERE campus=? ORDER BY created_at DESC').all(user.campus);
        return send(res, 200, rows);
      }
      const review = url.pathname.match(/^\/api\/courier-applications\/([a-z0-9-]+)\/review$/);
      if (req.method === 'POST' && review) {
        requireRole(user, 'admin', 'manager');
        const { approved } = await bodyOf(req);
        if (typeof approved !== 'boolean') fail(400, '审核结果无效');
        let courierId = null, application;
        db.exec('BEGIN IMMEDIATE');
        try {
          application = db.prepare('SELECT * FROM courier_applications WHERE student_id=?').get(review[1]);
          if (!application || (user.role === 'manager' && application.campus !== user.campus)) fail(404, '申请不存在');
          if (application.status !== 'pending') fail(409, '申请状态已变化，请刷新');
          if (approved) {
            courierId = `demo-courier-${randomUUID()}`;
            db.prepare("INSERT INTO users(id,name,role,campus,approved,online) VALUES (?,'申请代取员（测试）','courier',?,1,0)").run(courierId,application.campus);
          }
          db.prepare('UPDATE courier_applications SET status=?,courier_id=?,reviewed_at=?,reviewed_by=? WHERE student_id=? AND status=?')
            .run(approved ? 'approved' : 'rejected',courierId,now(),user.id,application.student_id,'pending');
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        audit(user.id, approved ? 'courier_application_approved' : 'courier_application_rejected', null, application.student_id);
        return send(res, 200, { status: approved ? 'approved' : 'rejected', campus: application.campus, courier_id: courierId });
      }
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
      if (req.method === 'GET' && url.pathname === '/api/catalog') return send(res, 200, { campusZones, campusBuildings, stations, slots: user.campus ? slotAvailability(user.campus).filter(slot => slot.remaining > 0) : availableSlots() });
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
        const pickupCodes = submittedCodes(b);
        let responseStatus, responseOrder;
        db.exec('BEGIN IMMEDIATE');
        try {
          const existing = db.prepare('SELECT * FROM orders WHERE student_id=? AND request_id=?').get(user.id, b.requestId);
          if (existing) {
            const sameRequest = existing.campus === b.campus && existing.station_id === b.stationId
              && existing.zone === b.zone && existing.building === (b.building || null) && JSON.stringify(storedCodes(existing)) === JSON.stringify(pickupCodes)
              && existing.qty === b.qty && existing.size === b.size && existing.speed === b.speed && existing.slot === b.slot
              && !Object.hasOwn(b, 'handoff');
            if (!sameRequest) fail(409, '该请求编号已用于其他订单内容，请刷新后重试');
            responseStatus = 200;
            responseOrder = existing;
          } else {
            const station = stations.find(s => s.id === b.stationId && s.campus === user.campus);
            if (!station || b.campus !== user.campus || !campusZones[user.campus].includes(b.zone)) fail(400, '校区、苑区或测试站点无效');
            const buildings = campusBuildings[user.campus]?.[b.zone] || [];
            if (buildings.length ? !buildings.includes(b.building) : b.building != null && b.building !== '') fail(400, '楼栋无效；东苑仅支持东1—东13，其他苑区楼号尚未核实');
            if (!Number.isInteger(b.qty) || b.qty < 1 || b.qty > 3 || !['small', 'large'].includes(b.size) || !['normal', 'urgent'].includes(b.speed)) fail(400, '包裹参数无效');
            if (!validSlot(b.slot)) fail(400, '请选择未过期的白天或傍晚一小时时段（09:00–19:00）');
            if (Object.hasOwn(b, 'handoff')) fail(400, '见面位置由宿舍苑区自动确定，无需填写地址');
            const handoff = `${b.zone}${b.building || ''}楼下公共入口（演示位置，待核实）`;
            if (bookedCount(user.campus,b.slot) >= slotLimit(user.campus,b.slot)) fail(409, '该时段已约满，请刷新后选择其他时段');
            const id = randomUUID(), at = now(), amount = (b.size === 'large' ? 500 : 300) + (b.qty - 1) * 100 + (b.speed === 'urgent' ? 200 : 0);
            db.prepare(`INSERT INTO orders (id,request_id,student_id,campus,station_id,zone,building,handoff,pickup_code,pickup_codes,qty,size,speed,slot,amount_cents,payment_status,status,courier_id,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'demo_not_paid','pending',NULL,?,?)`).run(id,b.requestId,user.id,user.campus,station.id,b.zone,b.building || null,handoff,pickupCodes[0],JSON.stringify(pickupCodes),b.qty,b.size,b.speed,b.slot,amount,at,at);
            audit(user.id, 'demo_order_created', id);
            responseStatus = 201;
            responseOrder = getOrder(id);
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return send(res, responseStatus, view(responseOrder, user));
      }
      const orderMatch = url.pathname.match(/^\/api\/orders\/([a-f0-9-]{36})(?:\/(accept|assign|progress|confirm|cancel|exception|resolve|handoff-code))?$/);
      if (orderMatch) {
        const [, id, action] = orderMatch;
        const o = getOrder(id);
        if (!o || !canSee(o, user)) fail(404, '订单不存在');
        if (req.method === 'GET' && !action) return send(res, 200, view(o, user));
        if (req.method !== 'POST' || !action) fail(405, '不支持的操作');
        if (action === 'handoff-code') {
          requireRole(user, 'student');
          if (o.student_id !== user.id) fail(404, '订单不存在');
          if (o.status !== 'delivering') fail(409, '配送开始后才能生成交接码');
          if (o.handoff_code_issued_at && sessionClock() - o.handoff_code_issued_at < 30_000) fail(429, '请等待 30 秒后再生成新交接码');
          const code = String(randomInt(100000, 1000000));
          const changed = db.prepare("UPDATE orders SET handoff_code_hash=?,handoff_code_issued_at=?,handoff_code_attempts=0 WHERE id=? AND status='delivering' AND student_id=?")
            .run(handoffCodeHash(id,code),sessionClock(),id,user.id);
          if (!changed.changes) fail(409, '订单状态已变化，请刷新后重试');
          audit(user.id, 'demo_handoff_code_issued', id);
          return send(res, 200, { demoHandoffCode: code, expiresInSeconds: 300, delivery: 'ON_PAGE_ONLY' });
        }
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
          const { status, handoffCode } = await bodyOf(req);
          const previous = { picked: 'assigned', delivering: 'picked', delivered: 'delivering' }[status];
          if (!previous) fail(400, '状态无效');
          if (status === 'delivered') {
            db.exec('BEGIN IMMEDIATE');
            try {
              const current = getOrder(id);
              if (current.status !== 'delivering' || current.courier_id !== user.id) fail(409, '订单状态已变化，请刷新后重试');
              if (!current.handoff_code_hash || !current.handoff_code_issued_at || sessionClock() - current.handoff_code_issued_at >= 300_000) fail(409, '请学生重新生成交接码');
              if (current.handoff_code_attempts >= 5) fail(429, '交接码尝试次数过多，请学生重新生成');
              if (typeof handoffCode !== 'string' || !/^\d{6}$/.test(handoffCode) || !timingSafeEqual(Buffer.from(current.handoff_code_hash,'hex'),Buffer.from(handoffCodeHash(id,handoffCode),'hex'))) {
                db.prepare('UPDATE orders SET handoff_code_attempts=handoff_code_attempts+1 WHERE id=?').run(id);
                db.exec('COMMIT');
                fail(400, '交接码不正确，请与学生当面核对');
              }
              result = db.prepare("UPDATE orders SET status='delivered',handoff_code_hash=NULL,handoff_code_issued_at=NULL,handoff_code_attempts=0,updated_at=? WHERE id=? AND status='delivering' AND courier_id=?").run(now(),id,user.id);
              if (!result.changes) fail(409, '订单状态已变化，请刷新后重试');
              db.exec('COMMIT');
            } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
          } else result = db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=? AND status=? AND courier_id=?').run(status,now(),id,previous,user.id);
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
  createApp().server.listen(port, host, () => console.log(`校园快取通 V0.8.0 本地演示：http://${host}:${port}`));
}
