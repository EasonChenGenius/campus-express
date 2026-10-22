const api = require('../../utils/api');
const { decorate } = require('../../utils/display');

Page({
  data: { order: null, loading: false, busy: false, error: '', role: '', nextStatus: '', nextLabel: '', canCancel: false, canConfirm: false, canProgress: false },
  onLoad(options) { this.orderId = options.id; },
  onShow() {
    const user = api.requireRole();
    if (!user) return;
    if (user.role !== 'student' && user.role !== 'courier') {
      wx.reLaunch({ url: '/pages/login/index' });
      return;
    }
    this.setData({ role: user.role });
    this.refresh();
  },
  async refresh() {
    if (!this.orderId) return this.setData({ error: '订单编号缺失。' });
    this.setData({ loading: true, error: '' });
    try {
      const order = decorate(await api.request('/api/orders/' + encodeURIComponent(this.orderId)));
      const next = { assigned: ['picked', '确认取件'], picked: ['delivering', '开始配送'], delivering: ['delivered', '确认交接'] }[order.status];
      this.setData({
        order, nextStatus: next ? next[0] : '', nextLabel: next ? next[1] : '',
        canCancel: this.data.role === 'student' && order.status === 'pending',
        canConfirm: this.data.role === 'student' && order.status === 'delivered',
        canProgress: this.data.role === 'courier' && Boolean(next)
      });
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ loading: false });
    }
  },
  async doAction(event) {
    if (this.data.busy) return;
    const name = event.currentTarget.dataset.action;
    const body = name === 'progress' ? { status: this.data.nextStatus } : {};
    if (name === 'cancel') {
      const confirmed = await new Promise(resolve => wx.showModal({
        title: '取消测试订单？', content: '只有待接单的订单可以取消。',
        success: result => resolve(result.confirm), fail: () => resolve(false)
      }));
      if (!confirmed) return;
    }
    this.setData({ busy: true, error: '' });
    try {
      await api.action(this.orderId, name, body);
      await this.refresh();
    } catch (error) {
      if (error.status === 409) await this.refresh();
      this.setData({ error: error.message });
    } finally {
      this.setData({ busy: false });
    }
  }
});
