const api = require('../../utils/api');

Page({
  data: { accounts: [], selected: 0, loading: true, busy: false, error: '', version: '' },
  async onLoad() {
    try {
      const capabilities = await api.checkDemo();
      const accounts = await api.request('/api/demo/accounts', { auth: false });
      this.setData({
        accounts: accounts.filter(account => account.role === 'student' || account.role === 'courier'),
        loading: false,
        version: capabilities.version
      });
    } catch (error) {
      this.setData({ loading: false, error: error.message });
    }
  },
  changeAccount(event) {
    this.setData({ selected: Number(event.detail.value), error: '' });
  },
  async enter() {
    if (this.data.busy || !this.data.accounts.length) return;
    this.setData({ busy: true, error: '' });
    try {
      const account = this.data.accounts[this.data.selected];
      const user = await api.login(account.id);
      wx.reLaunch({ url: user.role === 'student' ? '/pages/student/index' : '/pages/courier/index' });
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ busy: false });
    }
  }
});
