const api = require('../../utils/api');
const { decorate } = require('../../utils/display');

Page({
  data: { orders: [], loading: false, empty: true, error: '' },
  onShow() {
    if (api.requireRole('student')) this.refresh();
  },
  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const orders = await api.request('/api/orders');
      this.setData({ orders: orders.map(decorate), empty: orders.length === 0 });
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
