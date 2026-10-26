// Developer Tools only. Never point this demo client at a public server.
const BASE_URL = 'http://127.0.0.1:3000';
const PENDING_KEY = 'campus-express-demo-pending-order-v1';

function apiError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function request(path, options = {}) {
  const { method = 'GET', body, auth = true } = options;
  const app = getApp();
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + path,
      method,
      data: body,
      timeout: 8000,
      header: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(auth && app.globalData.token ? { authorization: 'Bearer ' + app.globalData.token } : {})
      },
      success(response) {
        const data = response.data || {};
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(data);
        if (response.statusCode === 401 && auth) {
          app.clearSession();
          wx.reLaunch({ url: '/pages/login/index' });
        }
        reject(apiError(data.error || '请求失败，请稍后重试', data.code || 'HTTP_ERROR', response.statusCode));
      },
      fail() {
        reject(apiError('网络连接失败。请检查本机演示服务，保持表单不变后重试。', 'NETWORK_ERROR', 0));
      }
    });
  });
}

async function checkDemo() {
  const capabilities = await request('/api/capabilities', { auth: false });
  if (capabilities.mode !== 'LOCAL_DEMO_ONLY' || capabilities.apiContract !== 9 || capabilities.realOrders || capabilities.realPayment || capabilities.realAuthentication || capabilities.realSms) {
    throw apiError('接口模式不匹配；演示小程序已停止操作。', 'UNSAFE_MODE', 0);
  }
  return capabilities;
}

async function login(accountId) {
  const result = await request('/api/demo/login', { method: 'POST', body: { accountId }, auth: false });
  getApp().setSession(result.token, result.user);
  return result.user;
}

async function logout() {
  try {
    if (getApp().globalData.token) await request('/api/session/logout', { method: 'POST' });
  } finally {
    wx.removeStorageSync(PENDING_KEY);
    getApp().clearSession();
  }
}

function requireRole(role) {
  const user = getApp().globalData.user;
  if (!user || (role && user.role !== role)) {
    wx.reLaunch({ url: '/pages/login/index' });
    return null;
  }
  return user;
}

function demoCode(input) {
  const value = String(input || '').trim().toUpperCase().replace(/[－—–]/g, '-');
  if (!value.startsWith('TEST-')) return null;
  const code = value.slice(5);
  if (/^\d{1,3}-[1-9]-\d{4}$/.test(code) || /^\d{4,12}$/.test(code)
    || (/^[A-Z0-9]{4,12}$/.test(code) && /[A-Z]/.test(code) && /\d/.test(code))) return value;
  return null;
}

function draftFingerprint(draft) {
  return JSON.stringify([draft.campus, draft.stationId, draft.zone, draft.building, draft.pickupCode,
    draft.qty, draft.size, draft.speed, draft.slot]);
}

function pendingDraft() {
  const value = wx.getStorageSync(PENDING_KEY);
  return value && value.draft && value.requestId ? value : null;
}

function createRequestId() {
  return 'demo-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

async function submitOrder(draft) {
  const old = pendingDraft();
  const fingerprint = draftFingerprint(draft);
  const requestId = old && old.fingerprint === fingerprint ? old.requestId : createRequestId();
  wx.setStorageSync(PENDING_KEY, { fingerprint, requestId, draft });
  try {
    const order = await request('/api/orders', { method: 'POST', body: { ...draft, requestId } });
    wx.removeStorageSync(PENDING_KEY);
    return order;
  } catch (error) {
    if (error.status === 409) wx.removeStorageSync(PENDING_KEY);
    throw error;
  }
}

function action(id, name, body = {}) {
  return request('/api/orders/' + encodeURIComponent(id) + '/' + name, { method: 'POST', body });
}

module.exports = {
  request, checkDemo, login, logout, requireRole, demoCode, pendingDraft, submitOrder, action
};
