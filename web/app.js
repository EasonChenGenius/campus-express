import { parseDemoPickupCode } from './pickup-code.js';

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const campusName = { chenglong: '成龙校区', shizishan: '狮子山校区' };
const statusName = { pending: '待接单', assigned: '已接单', picked: '已取件', delivering: '配送中', delivered: '待学生确认', exception: '待处理异常', completed: '已完成', cancelled: '已取消', closed: '异常已关闭' };
const reasonName = { pickup_failed: '取件失败', damaged: '包裹破损', student_unavailable: '学生暂无法交接', other: '其他异常' };
const resolutionName = { resume: '核实后恢复原进度', retry: '确认尚未取件，重新开放接单', close: '人工关闭异常订单' };
const actionName = { demo_order_created: '创建测试订单', accept: '代取员接单', assign: '人工派单', progress_picked: '已取件', progress_delivering: '开始配送', progress_delivered: '已交接', confirm: '学生确认', cancel: '学生取消', courier_approved: '代取员审核通过', courier_suspended: '代取员暂停', courier_online: '代取员上线', courier_offline: '代取员下线', courier_capacity_updated: '调整接单上限', exception_reported: '异常上报', exception_resume: '异常恢复', exception_retry: '重新开放接单', exception_close: '关闭异常订单' };
const slotName = value => /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\+08:00$/.test(value) ? `${value.slice(5, 10)} ${value.slice(11, 16)}–${String(Number(value.slice(11, 13)) + 1).padStart(2, '0')}:00` : ({ 'today-evening': '旧版：今日傍晚', 'tomorrow-noon': '旧版：明日中午' }[value] || value);
let token = '', me = null, catalog = null, couriers = [], availability = null;

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  } catch {
    throw new Error('无法连接本地服务。请双击项目中的“启动校园快取通.command”，然后刷新页面。');
  }
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || '请求失败'); error.status = response.status; throw error; }
  return data;
}
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function authMessage(text, error = false) { $('auth-message').textContent = text; $('auth-message').classList.toggle('error', error); }
async function perform(work, success) { try { await work(); message(success); await refresh(); return true; } catch (error) { if (error.status === 409) await refresh().catch(() => {}); message(error.message, true); return false; } }

async function clearOldSession() {
  if (!token) return;
  try { await api('/api/session/logout', { method: 'POST' }); } catch {}
  token = ''; me = null;
  $('workspace').hidden = true;
}
function enterSession(result) {
    token = result.token; me = result.user; $('workspace').hidden = false;
    $('workspace').dataset.role = me.role;
    const navigation = me.role === 'student' ? [['student-create', '预约代取'], ['orders-panel', '我的订单']]
      : me.role === 'courier' ? [['orders-panel', '任务池与进度'], ['courier-tools', '接单状态']]
      : [['operations-panel', '异常待办'], ['orders-panel', '订单管理'], ['slot-panel', '时段容量'], ['admin-tools', '代取员审核'], ['audit-panel', '操作记录']];
    $('workspace-nav').innerHTML = navigation.map(([id, label]) => `<a href="#${id}">${label}</a>`).join('');
    $('who').textContent = me.name;
    $('scope').textContent = me.role === 'admin' ? '总管理员 · 双校区测试订单' : `${{ student: '学生', courier: '代取员', manager: '校区主管' }[me.role]} · 仅限${campusName[me.campus]}测试数据`;
    $('student-create').hidden = me.role !== 'student';
    $('admin-tools').hidden = !['admin', 'manager'].includes(me.role);
    $('operations-panel').hidden = !['admin', 'manager'].includes(me.role);
    $('slot-panel').hidden = !['admin', 'manager'].includes(me.role);
    if (['admin', 'manager'].includes(me.role)) {
      $('slot-campus').innerHTML = Object.entries(campusName).filter(([id]) => me.role === 'admin' || id === me.campus).map(([id,label]) => `<option value="${id}">${label}</option>`).join('');
      $('slot-campus').disabled = me.role === 'manager';
    }
    $('courier-tools').hidden = me.role !== 'courier';
    $('audit-panel').hidden = !['admin', 'manager'].includes(me.role);
    $('orders-title').textContent = me.role === 'student' ? '我的订单' : me.role === 'courier' ? '本校区待接单与我的任务' : '订单管理';
    $('orders-help').textContent = me.role === 'courier' ? '接单前仅下发任务摘要；成功接单后才显示虚构取件码和交接点。' : '服务端保存并校验每一步状态。';
}
async function login() {
  const entered = await perform(async () => {
    await clearOldSession();
    enterSession(await api('/api/demo/login', { method: 'POST', body: JSON.stringify({ accountId: $('account').value }) }));
  }, '已切换测试身份');
  if (entered) $('workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function studentAuthSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget, mode = form.id.slice(5), phone = form.elements.namedItem('phone').value.trim().toUpperCase();
  const payload = { phone, password: form.elements.namedItem('password').value };
  if (mode === 'register') { payload.code = form.elements.namedItem('code').value.trim(); payload.campus = form.elements.namedItem('campus').value; }
  if (mode === 'reset') payload.code = form.elements.namedItem('code').value.trim();
  const path = { login: 'password-login', register: 'register', reset: 'reset-password' }[mode];
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    if (mode !== 'reset') await clearOldSession();
    const result = await api(`/api/demo/${path}`, { method: 'POST', body: JSON.stringify(payload) });
    form.reset();
    if (mode === 'reset') {
      await clearOldSession();
      setAuthTab('login');
      authMessage('演示密码已重设，旧登录已失效。请用新密码登录。');
    } else {
      enterSession(result);
      await refresh();
      authMessage(mode === 'register' ? '学生演示账号已创建并登录。' : '学生演示账号已登录。');
      $('workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (error) { authMessage(error.message, true); }
  finally { submit.disabled = false; }
}
function setAuthTab(tab) {
  for (const button of document.querySelectorAll('[data-auth-tab]')) button.classList.toggle('is-active',button.dataset.authTab === tab);
  for (const form of document.querySelectorAll('.auth-form')) form.hidden = form.id !== `auth-${tab}`;
  authMessage('');
}
async function showDemoCode(event) {
  const purpose = event.currentTarget.dataset.codePurpose;
  const form = $(`auth-${purpose}`), phone = form.elements.namedItem('phone').value.trim().toUpperCase();
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await api('/api/demo/send-code', { method: 'POST', body: JSON.stringify({ phone, purpose }) });
    authMessage(`本机演示验证码：${result.demoCode}（5 分钟内有效；没有发送短信）`);
  } catch (error) { authMessage(error.message, true); }
  finally { button.disabled = false; }
}
function orderActions(o) {
  if (['admin', 'manager'].includes(me.role) && o.status === 'exception') {
    return `<button data-id="${o.id}" data-action="resolve" data-resolution="resume">核实后恢复</button>${o.exception?.previous_status === 'assigned' && o.exception.reason !== 'damaged' ? `<button class="secondary" data-id="${o.id}" data-action="resolve" data-resolution="retry">未取件，重新开放接单</button>` : ''}<button class="danger" data-id="${o.id}" data-action="resolve" data-resolution="close">人工关闭</button>`;
  }
  if (['admin', 'manager'].includes(me.role) && ['assigned', 'picked', 'delivering', 'delivered'].includes(o.status)) return exceptionControl(o);
  if (me.role === 'student') {
    if (o.status === 'pending') return `<button class="secondary" data-id="${o.id}" data-action="cancel">取消</button>`;
    if (o.status === 'delivered') return `<button data-id="${o.id}" data-action="confirm">确认收货</button>${exceptionControl(o)}`;
  }
  if (me.role === 'courier') {
    if (o.status === 'pending') return `<button data-id="${o.id}" data-action="accept" ${!availability?.online || availability.activeCount >= availability.maxActive ? 'disabled' : ''}>接单</button>`;
    if (o.courier_id === me.id) {
      const next = { assigned: 'picked', picked: 'delivering', delivering: 'delivered' }[o.status];
      if (next) return `<button data-id="${o.id}" data-action="progress" data-next="${next}">${{ picked: '确认取件', delivering: '开始配送', delivered: '确认交接' }[next]}</button>${exceptionControl(o)}`;
      if (o.status === 'delivered') return exceptionControl(o);
    }
  }
  if (['admin', 'manager'].includes(me.role) && o.status === 'pending') {
    const eligible = couriers.filter(c => c.approved && c.online && c.active_count < c.max_active && c.campus === o.campus);
    return eligible.length ? `<select aria-label="选择代取员" data-select="${o.id}">${eligible.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')}</select><button data-id="${o.id}" data-action="assign">人工派单</button>` : '<span class="meta">本校区没有已审核代取员</span>';
  }
  return '';
}
function exceptionControl(o) {
  return `<select aria-label="异常类型" data-reason-select="${o.id}">${Object.entries(reasonName).map(([value,label]) => `<option value="${value}">${label}</option>`).join('')}</select><button class="secondary" data-id="${o.id}" data-action="exception">上报异常</button>`;
}
function orderCard(o) {
  const privateDetails = o.handoff ? `<p>当面交接位置：${escapeHtml(o.handoff)}</p>` : '<p>接单后可查看当面交接位置</p>';
  const code = o.pickup_code ? `<p>虚构取件码：<strong>${escapeHtml(o.pickup_code)}</strong></p>` : '';
  return `<article class="card order-card" data-status="${escapeHtml(o.status)}"><div class="card-head"><strong>📦 ${escapeHtml(campusName[o.campus])} · ${escapeHtml(o.zone)}${o.building ? ' · ' + escapeHtml(o.building) : ''}</strong><span class="tag">${escapeHtml(statusName[o.status] || o.status)}</span></div>
    <p>测试点：${escapeHtml(catalog.stations.find(s => s.id === o.station_id)?.name || o.station_id)} · ${o.qty} 件 · ${escapeHtml(slotName(o.slot))}</p>${privateDetails}${code}
    ${o.exception ? `<p class="exception-note">异常已暂停履约：${escapeHtml(reasonName[o.exception.reason] || o.exception.reason)}；等待本校区管理员核实。</p>` : ''}${o.lastResolution ? `<p class="meta">最近一次异常处理：${escapeHtml(reasonName[o.lastResolution.reason] || o.lastResolution.reason)} → ${escapeHtml(resolutionName[o.lastResolution.resolution] || o.lastResolution.resolution)} · ${escapeHtml(new Date(o.lastResolution.resolved_at).toLocaleString('zh-CN'))}</p>` : ''}<p class="meta">订单 ${escapeHtml(o.id.slice(0, 8))} · ${escapeHtml(new Date(o.created_at).toLocaleString('zh-CN'))} · ${o.courier_id ? `代取员 ${escapeHtml(o.courier_id)}` : '尚未指派'}</p>
    <div class="card-foot"><strong>模拟报价 ¥${(o.amount_cents / 100).toFixed(2)} · 未支付</strong><div class="actions">${orderActions(o)}</div></div></article>`;
}
async function refresh() {
  if (!me) return;
  catalog = await api('/api/catalog');
  const orders = await api('/api/orders');
  if (me.role === 'courier') {
    availability = await api('/api/couriers/me/availability');
    $('availability').textContent = `${availability.online ? '已上线' : '已下线'} · 同时处理 ${availability.activeCount}/${availability.maxActive} 单${availability.approved ? '' : ' · 尚未审核'}`;
    $('toggle-availability').textContent = availability.online ? '下线，暂停新接单' : '上线接单';
    $('toggle-availability').disabled = !availability.approved && !availability.online;
  }
  if (me.role === 'student') {
    $('campus').value = campusName[me.campus];
    $('station').innerHTML = catalog.stations.filter(s => s.campus === me.campus).map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    const previous = $('zone').value;
    $('zone').innerHTML = catalog.campusZones[me.campus].map(z => `<option value="${escapeHtml(z)}">${escapeHtml(z)}</option>`).join('');
    if (catalog.campusZones[me.campus].includes(previous)) $('zone').value = previous;
    const previousSlot = $('slot').value;
    $('slot').innerHTML = catalog.slots.length ? catalog.slots.map(s => `<option value="${escapeHtml(s.value)}">${escapeHtml(s.label)} · 剩余 ${s.remaining} 个名额</option>`).join('') : '<option value="">暂无可预约时段</option>';
    if (catalog.slots.some(s => s.value === previousSlot)) $('slot').value = previousSlot;
    updateHandoffPreview();
  }
  if (['admin', 'manager'].includes(me.role)) {
    couriers = await api('/api/couriers');
    $('couriers').innerHTML = couriers.map(c => `<div class="card card-head"><span><strong>${escapeHtml(c.name)}</strong><br><span class="meta">${escapeHtml(campusName[c.campus])} · ${c.approved ? '已审核' : '待审核'} · ${c.online ? '在线' : '离线'} · 处理中 ${c.active_count}/${c.max_active}</span></span><div class="actions"><label class="capacity-label">上限 <select aria-label="${escapeHtml(c.name)}接单上限" data-capacity-select="${escapeHtml(c.id)}">${[1,2,3,4,5].map(n => `<option value="${n}" ${c.max_active === n ? 'selected' : ''}>${n} 单</option>`).join('')}</select></label><button class="secondary" data-courier="${escapeHtml(c.id)}" data-capacity="true">保存上限</button><button class="${c.approved ? 'danger' : ''}" data-courier="${escapeHtml(c.id)}" data-approved="${c.approved ? 'false' : 'true'}">${c.approved ? '暂停资格' : '审核通过'}</button></div></div>`).join('');
    const queue = await api('/api/operations/queue');
    $('operations').innerHTML = `<div class="queue-summary">待处理异常 ${queue.exceptions.length} 单 · 超过 30 分钟无人接单 ${queue.overdue.length} 单</div><p class="meta">处理顺序：先确认包裹是否已取出和是否安全，再决定恢复、重新接单或关闭；已取件的异常不可直接重新接单。</p>${queue.exceptions.map(o => `<div class="card"><strong>${escapeHtml(campusName[o.campus])} · ${escapeHtml(o.zone)} · ${escapeHtml(reasonName[o.exception?.reason] || '')}</strong><p class="meta">订单 ${escapeHtml(o.id.slice(0,8))} · 已等待 ${Math.max(0, Math.floor((Date.now() - Date.parse(o.exception?.created_at)) / 60000))} 分钟 · 在下方订单管理中处理</p></div>`).join('')}${queue.overdue.map(o => `<div class="card"><strong>${escapeHtml(campusName[o.campus])} · ${escapeHtml(o.zone)} · 等待接单超时</strong><p class="meta">订单 ${escapeHtml(o.id.slice(0,8))} · 可在下方订单管理中人工派单</p></div>`).join('')}${!queue.exceptions.length && !queue.overdue.length ? '<div class="empty">目前没有后台待办</div>' : ''}`;
    const slotData = await api(`/api/slots/capacity?campus=${encodeURIComponent($('slot-campus').value)}`);
    $('slot-capacities').innerHTML = slotData.slots.map(s => `<div class="card card-head"><span><strong>${escapeHtml(s.label)}</strong><br><span class="meta">已预约 ${s.booked} · 剩余 ${s.remaining}</span></span><div class="actions"><label class="capacity-label">总名额 <input type="number" min="0" max="20" step="1" value="${s.capacity}" data-slot-capacity="${escapeHtml(s.value)}"></label><button class="secondary" data-slot="${escapeHtml(s.value)}">保存</button></div></div>`).join('') || '<div class="empty">今天和明天没有未来时段</div>';
    const logs = await api('/api/audit');
    $('audit').innerHTML = logs.length ? logs.slice(0, 20).map(a => `<div class="audit-line">${escapeHtml(new Date(a.at).toLocaleString('zh-CN'))} · ${escapeHtml(a.actor_id)} · ${escapeHtml(actionName[a.action] || a.action)} ${a.order_id ? '· 订单 ' + escapeHtml(a.order_id.slice(0, 8)) : ''}</div>`).join('') : '<div class="empty">暂无操作记录</div>';
  }
  $('order-count').textContent = `${orders.length} 单`;
  $('metric-total').textContent = orders.length;
  $('metric-pending').textContent = orders.filter(o => o.status === 'pending').length;
  $('metric-complete').textContent = orders.filter(o => o.status === 'completed').length;
  $('orders').innerHTML = orders.length ? orders.map(orderCard).join('') : '<div class="empty">目前没有测试订单</div>';
}
async function createOrder(event) {
  event.preventDefault();
  const code = parseDemoPickupCode($('pickup-code').value);
  if (!code) return message('请输入虚构测试码，例如 TEST-123456、TEST-5-2-0042 或 TEST-9VK518', true);
  const body = { requestId: crypto.randomUUID(), campus: me.campus, stationId: $('station').value, zone: $('zone').value, building: $('building').value || null, pickupCode: code.value, qty: Number($('qty').value), size: $('size').value, speed: $('speed').value, slot: $('slot').value };
  await perform(async () => { await api('/api/orders', { method: 'POST', body: JSON.stringify(body) }); $('order-form').reset(); }, '测试订单已创建；没有付款或真实配送');
}
async function handleClick(event) {
  const button = event.target.closest('button');
  if (!button) return;
  const { id, action, next, courier, approved, capacity, resolution, slot } = button.dataset;
  if (slot) return perform(() => api('/api/slots/capacity', { method: 'POST', body: JSON.stringify({ campus: $('slot-campus').value, slot, capacity: Number(document.querySelector(`[data-slot-capacity="${slot}"]`).value) }) }), '时段容量已更新');
  if (courier && capacity) return perform(() => api(`/api/couriers/${courier}/capacity`, { method: 'POST', body: JSON.stringify({ maxActive: Number(document.querySelector(`[data-capacity-select="${courier}"]`).value) }) }), '接单上限已更新');
  if (courier) return perform(() => api(`/api/couriers/${courier}/approval`, { method: 'POST', body: JSON.stringify({ approved: approved === 'true' }) }), '审核状态已更新');
  if (!id || !action) return;
  let body;
  if (action === 'assign') body = { courierId: document.querySelector(`[data-select="${id}"]`).value };
  if (action === 'progress') body = { status: next };
  if (action === 'exception') body = { reason: document.querySelector(`[data-reason-select="${id}"]`).value };
  if (action === 'resolve') {
    const warning = resolution === 'close' ? '确认已核实包裹去向并人工关闭此测试异常单？关闭后不能继续配送。' : resolution === 'retry' ? '确认代取员尚未取出包裹，并重新开放给本校区接单？' : '确认异常已核实，可以恢复原配送进度？';
    if (!window.confirm(warning)) return;
    body = { resolution };
  }
  await perform(() => api(`/api/orders/${id}/${action}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : { body: '{}' }) }), '订单状态已更新');
}
async function init() {
  try {
    const accounts = await api('/api/demo/accounts');
    $('account').innerHTML = accounts.map(a => `<option value="${escapeHtml(a.id)}" data-role="${escapeHtml(a.role)}">${escapeHtml(a.name)} · ${{ student: '学生', courier: '代取员', manager: '校区主管', admin: '总管理员' }[a.role]}</option>`).join('');
    $('login').disabled = accounts.length === 0;
  } catch (error) { message(error.message, true); }
  $('login').addEventListener('click', login);
  $('account').addEventListener('change', () => {
    const role = $('account').selectedOptions[0]?.dataset.role;
    document.querySelectorAll('.role-card').forEach(card => card.classList.toggle('is-active',card.dataset.role === role || (card.dataset.role === 'manager' && role === 'admin')));
  });
  document.querySelectorAll('.role-card').forEach(card => card.addEventListener('click', () => {
    const option = [...$('account').options].find(item => item.dataset.role === card.dataset.role);
    if (option) { $('account').value = option.value; $('account').dispatchEvent(new Event('change')); }
    $('account').focus();
  }));
  document.querySelectorAll('[data-auth-tab]').forEach(button => button.addEventListener('click', () => setAuthTab(button.dataset.authTab)));
  document.querySelectorAll('.auth-form').forEach(form => form.addEventListener('submit', studentAuthSubmit));
  document.querySelectorAll('[data-code-purpose]').forEach(button => button.addEventListener('click', showDemoCode));
  $('refresh').addEventListener('click', () => perform(refresh, '数据已刷新'));
  $('slot-campus').addEventListener('change', () => perform(refresh, '已切换时段校区'));
  $('toggle-availability').addEventListener('click', () => perform(() => api('/api/couriers/me/availability', { method: 'POST', body: JSON.stringify({ online: !availability.online }) }), '接单状态已更新'));
  $('order-form').addEventListener('submit', createOrder);
  $('zone').addEventListener('change', updateHandoffPreview);
  $('building').addEventListener('change', updateHandoffPreview);
  $('workspace').addEventListener('click', handleClick);
}
init();

function updateHandoffPreview() {
  const zone = $('zone').value;
  const buildings = catalog?.campusBuildings?.[me?.campus]?.[zone] || [];
  const previous = $('building').value;
  $('building').innerHTML = buildings.length ? buildings.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('') : '<option value="">楼号待核实（仅苑区演示）</option>';
  if (buildings.includes(previous)) $('building').value = previous;
  $('building').disabled = !buildings.length;
  $('building-hint').textContent = buildings.length ? '东1—东13 为用户提供的待核实范围。' : '该苑区楼号尚未核实，暂按苑区演示。';
  $('handoff-preview').textContent = `${zone}${$('building').value}楼下公共入口（演示位置，待核实）`;
}
