const api = require('../../utils/api');
const { campus, decorate } = require('../../utils/display');

Page({
  data: { campusName: '', pool: [], mine: [], availability: null, canAccept: false, loading: false, busyId: '', busy: false, error: '' },
  onShow() {
    const user = api.requireRole('courier');
    if (!user) return;
    this.setData({ campusName: campus[user.campus] });
    this.refresh();
  },
  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const user = api.requireRole('courier');
      if (!user) return;
      const availability = await api.request('/api/couriers/me/availability');
      this.setData({ availability, canAccept: availability.approved && availability.online && availability.activeCount < availability.maxActive });
      const orders = await api.request('/api/orders');
      this.setData({
        pool: orders.filter(o => o.status === 'pending').map(decorate),
        mine: orders.filter(o => o.courier_id === user.id).map(decorate)
      });
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ loading: false });
    }
  },
  async toggleAvailability() {
    if (this.data.busy || !this.data.availability) return;
    this.setData({ busy: true, error: '' });
    try {
      await api.request('/api/couriers/me/availability', { method: 'POST', body: { online: !this.data.availability.online } });
      await this.refresh();
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ busy: false }); }
  },
  async accept(event) {
    const id = event.currentTarget.dataset.id;
    if (this.data.busyId || !this.data.canAccept) return;
    this.setData({ busyId: id, busy: true, error: '' });
    try {
      await api.action(id, 'accept');
      await this.refresh();
      wx.navigateTo({ url: '/pages/order/index?id=' + id });
    } catch (error) {
      if (error.status === 409) await this.refresh();
      this.setData({ error: error.message });
    } finally {
      this.setData({ busyId: '', busy: false });
    }
  },
  openOrder(event) {
    wx.navigateTo({ url: '/pages/order/index?id=' + event.currentTarget.dataset.id });
  },
  async switchAccount() { try { await api.logout(); } catch {} wx.reLaunch({ url: '/pages/login/index' }); }
});
