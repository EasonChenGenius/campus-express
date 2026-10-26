const api = require('../../utils/api');
const { decorate } = require('../../utils/display');
const { startVisibleRefresh, stopVisibleRefresh } = require('../../utils/visible-refresh');

Page({
  data: { orders: [], loading: false, empty: true, error: '', lastUpdated: '' },
  onShow() {
    if (api.requireRole('student')) { this.refresh(); startVisibleRefresh(this, this.refresh); }
  },
  onHide() { stopVisibleRefresh(this); },
  onUnload() { stopVisibleRefresh(this); },
  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const orders = await api.request('/api/orders');
      this.setData({ orders: orders.map(decorate), empty: orders.length === 0, lastUpdated: new Date().toLocaleTimeString('zh-CN') });
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ loading: false });
    }
  },
  openOrder(event) {
    wx.navigateTo({ url: '/pages/order/index?id=' + event.currentTarget.dataset.id });
  },
  openCreate() { wx.navigateBack({ delta: 1 }); }
});
