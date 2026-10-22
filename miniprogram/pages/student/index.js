const api = require('../../utils/api');
const { campus } = require('../../utils/display');

Page({
  data: {
    campusName: '', stations: [], zones: [], stationIndex: 0, zoneIndex: 0,
    qtyOptions: [1, 2, 3], qtyIndex: 0,
    sizeOptions: ['小件', '大件'], sizeIndex: 0,
    speedOptions: ['普通', '加急'], speedIndex: 0,
    slots: [], slotOptions: [], slotIndex: 0,
    pickupCode: '', handoff: '', busy: false, error: '', pendingHint: false
  },
  async onShow() {
    const user = api.requireRole('student');
    if (!user) return;
    this.setData({ campusName: campus[user.campus], error: '' });
    try {
      const catalog = await api.request('/api/catalog');
      const stations = catalog.stations.filter(s => s.campus === user.campus);
      const zones = catalog.campusZones[user.campus] || [];
      const slots = catalog.slots || [];
      const pending = api.pendingDraft();
      const draft = pending && pending.draft.campus === user.campus ? pending.draft : null;
      const zoneIndex = draft ? Math.max(0, zones.indexOf(draft.zone)) : 0;
      this.setData({
        stations, zones, slots, slotOptions: slots.map(item => item.label), zoneIndex,
        stationIndex: draft ? Math.max(0, stations.findIndex(s => s.id === draft.stationId)) : 0,
        qtyIndex: draft ? Math.max(0, [1, 2, 3].indexOf(draft.qty)) : 0,
        sizeIndex: draft && draft.size === 'large' ? 1 : 0,
        speedIndex: draft && draft.speed === 'urgent' ? 1 : 0,
        slotIndex: draft ? Math.max(0, slots.findIndex(item => item.value === draft.slot)) : 0,
        pickupCode: draft ? draft.pickupCode : '',
        handoff: zones[zoneIndex] ? zones[zoneIndex] + '楼下公共入口（测试）' : '',
        pendingHint: Boolean(draft)
      });
    } catch (error) {
      this.setData({ error: error.message });
    }
  },
  changePicker(event) {
    const field = event.currentTarget.dataset.field;
    const index = Number(event.detail.value);
    this.setData({ [field]: index, error: '' });
    if (field === 'zoneIndex') this.setData({ handoff: this.data.zones[index] + '楼下公共入口（测试）' });
  },
  changeCode(event) {
    this.setData({ pickupCode: event.detail.value, error: '' });
  },
  async submit() {
    if (this.data.busy) return;
    const user = api.requireRole('student');
    if (!user) return;
    const pickupCode = api.demoCode(this.data.pickupCode);
    if (!pickupCode) return this.setData({ error: '仅可输入虚构测试码，例如 TEST-123456、TEST-5-2-0042 或 TEST-9VK518。' });
    if (!this.data.stations.length || !this.data.zones.length || !this.data.slots.length) return this.setData({ error: '当前没有可预约的测试站点、苑区或时段。' });
    const draft = {
      campus: user.campus,
      stationId: this.data.stations[this.data.stationIndex].id,
      zone: this.data.zones[this.data.zoneIndex],
      pickupCode,
      qty: this.data.qtyOptions[this.data.qtyIndex],
      size: this.data.sizeIndex ? 'large' : 'small',
      speed: this.data.speedIndex ? 'urgent' : 'normal',
      slot: this.data.slots[this.data.slotIndex].value
    };
    this.setData({ busy: true, error: '' });
    try {
      const order = await api.submitOrder(draft);
      this.setData({ pendingHint: false });
      wx.navigateTo({ url: '/pages/order/index?id=' + order.id });
    } catch (error) {
      this.setData({ error: error.message, pendingHint: error.code === 'NETWORK_ERROR' || this.data.pendingHint });
    } finally {
      this.setData({ busy: false });
    }
  },
  openOrders() { wx.navigateTo({ url: '/pages/orders/index' }); },
  switchAccount() { getApp().clearSession(); wx.reLaunch({ url: '/pages/login/index' }); }
});
