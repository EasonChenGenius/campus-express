const campus = { chenglong: '成龙校区', shizishan: '狮子山校区' };
const status = {
  pending: '待接单', assigned: '已接单', picked: '已取件',
  delivering: '配送中', delivered: '待学生确认', completed: '已完成', cancelled: '已取消'
};
const slot = { 'today-evening': '今日傍晚', 'tomorrow-noon': '明日中午' };

function decorate(order) {
  return {
    ...order,
    campusName: campus[order.campus] || order.campus,
    statusName: status[order.status] || order.status,
    slotName: slot[order.slot] || order.slot,
    amountText: (order.amount_cents / 100).toFixed(2),
    shortId: order.id.slice(0, 8),
    createdText: new Date(order.created_at).toLocaleString('zh-CN')
  };
}

module.exports = { campus, status, slot, decorate };
