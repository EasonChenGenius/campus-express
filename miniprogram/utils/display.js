const campus = { chenglong: '成龙校区', shizishan: '狮子山校区' };
const status = {
  pending: '待接单', assigned: '已接单', picked: '已取件',
  delivering: '配送中', delivered: '待学生确认', completed: '已完成', cancelled: '已取消'
};
function slotName(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\+08:00$/.test(value)) return { 'today-evening': '旧版：今日傍晚', 'tomorrow-noon': '旧版：明日中午' }[value] || value;
  return value.slice(5, 10) + ' ' + value.slice(11, 16) + '–' + String(Number(value.slice(11, 13)) + 1).padStart(2, '0') + ':00';
}

function decorate(order) {
  return {
    ...order,
    campusName: campus[order.campus] || order.campus,
    statusName: status[order.status] || order.status,
    slotName: slotName(order.slot),
    amountText: (order.amount_cents / 100).toFixed(2),
    shortId: order.id.slice(0, 8),
    createdText: new Date(order.created_at).toLocaleString('zh-CN')
  };
}

module.exports = { campus, status, slotName, decorate };
