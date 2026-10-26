const api = require('../../utils/api');
const { campus } = require('../../utils/display');

Page({
  data: {
    campusName: '', stations: [], zones: [], buildingsByZone: {}, buildings: [], stationIndex: 0, zoneIndex: 0, buildingIndex: 0,
    qtyOptions: [1, 2, 3], qtyIndex: 0,
    sizeOptions: ['小件', '大件'], sizeIndex: 0,
    speedOptions: ['普通', '加急'], speedIndex: 0,
    slots: [], slotOptions: [], slotIndex: 0,
    pickupCodes: [''], handoff: '', busy: false, error: '', pendingHint: false,
    applicationStatus: 'none', applicationText: '正在读取申请状态…'
  },
  async onShow() { await Promise.all([this.loadCatalog(), this.loadApplication()]); },
  async loadApplication() {
    try {
      const application = await api.request('/api/courier-applications/me');
      const text = { none: '尚未申请。提交后由本校区主管审核，审核前不能接单。', pending: '等待本校区主管审核，暂不能接单。', approved: '虚构申请已通过。切换测试身份后选择“申请代取员（测试）”；首次默认下线。', rejected: '申请未通过，可重新提交虚构申请。' };
      this.setData({ applicationStatus: application.status, applicationText: text[application.status] || '状态暂不可用，请稍后刷新。' });
    } catch (error) { this.setData({ applicationText: error.message }); }
  },
  async applyCourier() {
    if (this.data.busy || !['none', 'rejected'].includes(this.data.applicationStatus)) return;
    this.setData({ busy: true, error: '' });
    try {
      await api.request('/api/courier-applications', { method: 'POST', body: {} });
      await this.loadApplication();
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ busy: false }); }
  },
  async loadCatalog(preserveInput = false) {
    const user = api.requireRole('student');
    if (!user) return;
    this.setData({ campusName: campus[user.campus], error: '' });
    try {
      const catalog = await api.request('/api/catalog');
      const stations = catalog.stations.filter(s => s.campus === user.campus);
      const zones = catalog.campusZones[user.campus] || [];
      const slots = catalog.slots || [];
      const pending = api.pendingDraft();
      const draft = preserveInput ? {
        campus: user.campus, stationId: this.data.stations[this.data.stationIndex]?.id,
        zone: this.data.zones[this.data.zoneIndex], building: this.data.buildings[this.data.buildingIndex],
        qty: this.data.qtyOptions[this.data.qtyIndex], size: this.data.sizeIndex ? 'large' : 'small',
        speed: this.data.speedIndex ? 'urgent' : 'normal', slot: this.data.slots[this.data.slotIndex]?.value,
        pickupCodes: this.data.pickupCodes
      } : pending && pending.draft.campus === user.campus ? pending.draft : null;
      const zoneIndex = draft ? Math.max(0, zones.indexOf(draft.zone)) : 0;
      const buildingsByZone = catalog.campusBuildings?.[user.campus] || {};
      const buildings = buildingsByZone[zones[zoneIndex]] || [];
      const buildingIndex = draft ? Math.max(0, buildings.indexOf(draft.building)) : 0;
      this.setData({
        stations, zones, buildingsByZone, buildings, buildingIndex, slots, slotOptions: slots.map(item => item.label + ' · 剩余 ' + item.remaining + ' 个名额'), zoneIndex,
        stationIndex: draft ? Math.max(0, stations.findIndex(s => s.id === draft.stationId)) : 0,
        qtyIndex: draft ? Math.max(0, [1, 2, 3].indexOf(draft.qty)) : 0,
        sizeIndex: draft && draft.size === 'large' ? 1 : 0,
        speedIndex: draft && draft.speed === 'urgent' ? 1 : 0,
        slotIndex: draft ? Math.max(0, slots.findIndex(item => item.value === draft.slot)) : 0,
        pickupCodes: draft ? Array.from({ length: draft.qty || 1 }, (_, index) => (draft.pickupCodes || [draft.pickupCode || ''])[index] || '') : [''],
        handoff: zones[zoneIndex] ? zones[zoneIndex] + (buildings[buildingIndex] || '') + '楼下公共入口（演示位置，待核实）' : '',
        pendingHint: !preserveInput && Boolean(draft)
      });
    } catch (error) {
      this.setData({ error: error.message });
    }
  },
  changePicker(event) {
    const field = event.currentTarget.dataset.field;
    const index = Number(event.detail.value);
    this.setData({ [field]: index, error: '' });
    if (field === 'qtyIndex') {
      const codes = this.data.pickupCodes.slice(0, this.data.qtyOptions[index]);
      while (codes.length < this.data.qtyOptions[index]) codes.push('');
      this.setData({ pickupCodes: codes });
    }
    if (field === 'zoneIndex') {
      const zone = this.data.zones[index];
      const buildings = this.data.buildingsByZone[zone] || [];
      this.setData({ buildings, buildingIndex: 0, handoff: zone + (buildings[0] || '') + '楼下公共入口（演示位置，待核实）' });
    }
    if (field === 'buildingIndex') this.setData({ handoff: this.data.zones[this.data.zoneIndex] + this.data.buildings[index] + '楼下公共入口（演示位置，待核实）' });
  },
  changeCode(event) {
    const codes = this.data.pickupCodes.slice();
    codes[Number(event.currentTarget.dataset.index)] = event.detail.value;
    this.setData({ pickupCodes: codes, error: '' });
  },
  async submit() {
    if (this.data.busy) return;
    const user = api.requireRole('student');
    if (!user) return;
    const pickupCodes = this.data.pickupCodes.map(code => api.demoCode(code));
    if (pickupCodes.length !== this.data.qtyOptions[this.data.qtyIndex] || pickupCodes.some(code => !code)) return this.setData({ error: '每件包裹都需填写一个虚构 TEST- 取件码。' });
    if (!this.data.stations.length || !this.data.zones.length || !this.data.slots.length) return this.setData({ error: '当前没有可预约的测试站点、苑区或时段。' });
    const draft = {
      campus: user.campus,
      stationId: this.data.stations[this.data.stationIndex].id,
      zone: this.data.zones[this.data.zoneIndex],
      building: this.data.buildings[this.data.buildingIndex] || null,
      pickupCodes,
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
      if (error.status === 409) await this.loadCatalog(true);
      this.setData({ error: error.message, pendingHint: error.code === 'NETWORK_ERROR' || this.data.pendingHint });
    } finally {
      this.setData({ busy: false });
    }
  },
  openOrders() { wx.navigateTo({ url: '/pages/orders/index' }); },
  async switchAccount() { try { await api.logout(); } catch {} wx.reLaunch({ url: '/pages/login/index' }); }
});
