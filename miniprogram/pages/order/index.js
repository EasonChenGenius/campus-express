const api = require('../../utils/api');
const { decorate } = require('../../utils/display');
const { startVisibleRefresh, stopVisibleRefresh } = require('../../utils/visible-refresh');

Page({
  data: { order: null, loading: false, busy: false, error: '', role: '', nextStatus: '', nextLabel: '', canCancel: false, canConfirm: false, canProgress: false, canReport: false, lastUpdated: '', reasonOptions: ['取件失败','包裹破损','学生暂无法交接','其他异常'], reasonIndex: 0 },
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
    startVisibleRefresh(this, this.refresh);
  },
  onHide() { stopVisibleRefresh(this); },
  onUnload() { stopVisibleRefresh(this); },
  async refresh() {
    if (!this.orderId) return this.setData({ error: '订单编号缺失。' });
    this.setData({ loading: true, error: '' });
    try {
      const order = decorate(await api.request('/api/orders/' + encodeURIComponent(this.orderId)));
      const next = { assigned: ['picked', '确认取件'], picked: ['delivering', '开始配送'], delivering: ['delivered', '确认交接'] }[order.status];
      this.setData({
        order, nextStatus: next ? next[0] : '', nextLabel: next ? next[1] : '', lastUpdated: new Date().toLocaleTimeString('zh-CN'),
        canCancel: this.data.role === 'student' && order.status === 'pending',
        canConfirm: this.data.role === 'student' && order.status === 'delivered',
        canProgress: this.data.role === 'courier' && Boolean(next),
        canReport: (this.data.role === 'courier' && ['assigned','picked','delivering','delivered'].includes(order.status)) || (this.data.role === 'student' && order.status === 'delivered')
      });
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ loading: false });
    }
  },
  changeReason(event) { this.setData({ reasonIndex: Number(event.detail.value) }); },
  async doAction(event) {
    if (this.data.busy) return;
    const name = event.currentTarget.dataset.action;
    const body = name === 'progress' ? { status: this.data.nextStatus } : name === 'exception' ? { reason: ['pickup_failed','damaged','student_unavailable','other'][this.data.reasonIndex] } : {};
    if (name === 'cancel') {
      const confirmed = await new Promise(resolve => wx.showModal({
        title: '取消测试订单？', content: '只有待接单的订单可以取消。',
        success: result => resolve(result.confirm), fail: () => resolve(false)
      }));
      if (!confirmed) return;
    }
    if (name === 'exception') {
      const confirmed = await new Promise(resolve => wx.showModal({
        title: '上报测试异常？', content: '上报后订单会暂停，等待本校区管理员核实。请不要在演示中填写真实个人信息。',
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
