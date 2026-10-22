import { parseDemoPickupCode } from './pickup-code.js';

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const campusName = { chenglong: '成龙校区', shizishan: '狮子山校区' };
const statusName = { pending: '待接单', assigned: '已接单', picked: '已取件', delivering: '配送中', delivered: '待学生确认', completed: '已完成', cancelled: '已取消' };
const actionName = { demo_order_created: '创建测试订单', accept: '代取员接单', assign: '人工派单', progress_picked: '已取件', progress_delivering: '开始配送', progress_delivered: '已交接', confirm: '学生确认', cancel: '学生取消', courier_approved: '代取员审核通过', courier_suspended: '代取员暂停' };
let token = '', me = null, catalog = null, couriers = [];

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  } catch {
    throw new Error('无法连接本地服务。请双击项目中的“启动校园快取通.command”，然后刷新页面。');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
async function perform(work, success) { try { await work(); message(success); await refresh(); return true; } catch (error) { message(error.message, true); return false; } }

async function login() {
  const entered = await perform(async () => {
    const result = await api('/api/demo/login', { method: 'POST', body: JSON.stringify({ accountId: $('account').value }) });
    token = result.token; me = result.user; $('workspace').hidden = false;
    $('who').textContent = me.name;
    $('scope').textContent = me.role === 'admin' ? '可查看双校区测试订单' : `仅限${campusName[me.campus]}测试数据`;
    $('student-create').hidden = me.role !== 'student';
    $('admin-tools').hidden = !['admin', 'manager'].includes(me.role);
    $('audit-panel').hidden = !['admin', 'manager'].includes(me.role);
    $('orders-title').textContent = me.role === 'student' ? '我的订单' : me.role === 'courier' ? '本校区待接单与我的任务' : '订单管理';
    $('orders-help').textContent = me.role === 'courier' ? '接单前仅下发任务摘要；成功接单后才显示虚构取件码和交接点。' : '服务端保存并校验每一步状态。';
  }, '已切换测试身份');
  if (entered) $('workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function orderActions(o) {
  if (me.role === 'student') {
    if (o.status === 'pending') return `<button class="secondary" data-id="${o.id}" data-action="cancel">取消</button>`;
    if (o.status === 'delivered') return `<button data-id="${o.id}" data-action="confirm">确认收货</button>`;
  }
  if (me.role === 'courier') {
    if (o.status === 'pending') return `<button data-id="${o.id}" data-action="accept">接单</button>`;
    if (o.courier_id === me.id) {
      const next = { assigned: 'picked', picked: 'delivering', delivering: 'delivered' }[o.status];
      if (next) return `<button data-id="${o.id}" data-action="progress" data-next="${next}">${{ picked: '确认取件', delivering: '开始配送', delivered: '确认交接' }[next]}</button>`;
    }
  }
  if (['admin', 'manager'].includes(me.role) && o.status === 'pending') {
    const eligible = couriers.filter(c => c.approved && c.campus === o.campus);
    return eligible.length ? `<select aria-label="选择代取员" data-select="${o.id}">${eligible.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')}</select><button data-id="${o.id}" data-action="assign">人工派单</button>` : '<span class="meta">本校区没有已审核代取员</span>';
  }
  return '';
}
function orderCard(o) {
  const privateDetails = o.handoff ? `<p>当面交接位置：${escapeHtml(o.handoff)}</p>` : '<p>接单后可查看当面交接位置</p>';
  const code = o.pickup_code ? `<p>虚构取件码：<strong>${escapeHtml(o.pickup_code)}</strong></p>` : '';
  return `<article class="card"><div class="card-head"><strong>📦 ${escapeHtml(campusName[o.campus])} · ${escapeHtml(o.zone)}</strong><span class="tag">${escapeHtml(statusName[o.status] || o.status)}</span></div>
    <p>测试点：${escapeHtml(catalog.stations.find(s => s.id === o.station_id)?.name || o.station_id)} · ${o.qty} 件 · ${escapeHtml(o.slot === 'today-evening' ? '今日傍晚' : '明日中午')}</p>${privateDetails}${code}
    <p class="meta">订单 ${escapeHtml(o.id.slice(0, 8))} · ${escapeHtml(new Date(o.created_at).toLocaleString('zh-CN'))} · ${o.courier_id ? `代取员 ${escapeHtml(o.courier_id)}` : '尚未指派'}</p>
    <div class="card-foot"><strong>模拟报价 ¥${(o.amount_cents / 100).toFixed(2)} · 未支付</strong><div class="actions">${orderActions(o)}</div></div></article>`;
}
async function refresh() {
  if (!me) return;
  catalog = await api('/api/catalog');
  const orders = await api('/api/orders');
  if (me.role === 'student') {
    $('campus').value = campusName[me.campus];
    $('station').innerHTML = catalog.stations.filter(s => s.campus === me.campus).map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    const previous = $('zone').value;
    $('zone').innerHTML = catalog.campusZones[me.campus].map(z => `<option value="${escapeHtml(z)}">${escapeHtml(z)}</option>`).join('');
    if (catalog.campusZones[me.campus].includes(previous)) $('zone').value = previous;
    updateHandoffPreview();
  }
  if (['admin', 'manager'].includes(me.role)) {
    couriers = await api('/api/couriers');
    $('couriers').innerHTML = couriers.map(c => `<div class="card card-head"><span><strong>${escapeHtml(c.name)}</strong><br><span class="meta">${escapeHtml(campusName[c.campus])} · ${c.approved ? '已审核' : '待审核'}</span></span><button class="${c.approved ? 'danger' : ''}" data-courier="${escapeHtml(c.id)}" data-approved="${c.approved ? 'false' : 'true'}">${c.approved ? '暂停资格' : '审核通过'}</button></div>`).join('');
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
  const body = { requestId: crypto.randomUUID(), campus: me.campus, stationId: $('station').value, zone: $('zone').value, pickupCode: code.value, qty: Number($('qty').value), size: $('size').value, speed: $('speed').value, slot: $('slot').value };
  await perform(async () => { await api('/api/orders', { method: 'POST', body: JSON.stringify(body) }); $('order-form').reset(); }, '测试订单已创建；没有付款或真实配送');
}
async function handleClick(event) {
  const button = event.target.closest('button');
  if (!button) return;
  const { id, action, next, courier, approved } = button.dataset;
  if (courier) return perform(() => api(`/api/couriers/${courier}/approval`, { method: 'POST', body: JSON.stringify({ approved: approved === 'true' }) }), '审核状态已更新');
  if (!id || !action) return;
  let body;
  if (action === 'assign') body = { courierId: document.querySelector(`[data-select="${id}"]`).value };
  if (action === 'progress') body = { status: next };
  await perform(() => api(`/api/orders/${id}/${action}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : { body: '{}' }) }), '订单状态已更新');
}
async function init() {
  try {
    const accounts = await api('/api/demo/accounts');
    $('account').innerHTML = accounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join('');
    $('login').disabled = accounts.length === 0;
  } catch (error) { message(error.message, true); }
  $('login').addEventListener('click', login);
  $('refresh').addEventListener('click', () => perform(refresh, '数据已刷新'));
  $('order-form').addEventListener('submit', createOrder);
  $('zone').addEventListener('change', updateHandoffPreview);
  $('workspace').addEventListener('click', handleClick);
}
init();

function updateHandoffPreview() {
  $('handoff-preview').textContent = `${$('zone').value}楼下公共入口（测试）`;
}
