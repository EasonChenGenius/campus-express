const campus = { chenglong: '成龙校区', shizishan: '狮子山校区' };
const status = {
  pending: '待接单', assigned: '已接单', picked: '已取件',
  delivering: '配送中', delivered: '待学生确认', exception: '待处理异常', completed: '已完成', cancelled: '已取消', closed: '异常已关闭'
};
const exceptionReason = { pickup_failed: '取件失败', damaged: '包裹破损', student_unavailable: '学生暂无法交接', other: '其他异常' };
const resolutionName = { resume: '核实后恢复原进度', retry: '确认尚未取件，重新开放接单', close: '人工关闭异常订单' };
function slotName(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\+08:00$/.test(value)) return { 'today-evening': '旧版：今日傍晚', 'tomorrow-noon': '旧版：明日中午' }[value] || value;
  return value.slice(5, 10) + ' ' + value.slice(11, 16) + '–' + String(Number(value.slice(11, 13)) + 1).padStart(2, '0') + ':00';
}

const stages = [
  ['pending', '等待接单'], ['assigned', '代取员已接单'], ['picked', '包裹已取出'],
  ['delivering', '正在送往楼下'], ['delivered', '等待学生确认'], ['completed', '订单完成']
];
function progressSteps(order) {
  const interrupted = ['exception', 'closed', 'cancelled'].includes(order.status);
  const last = interrupted ? (order.exception?.previous_status || order.lastResolution?.previous_status || 'pending') : order.status;
  const index = Math.max(0, stages.findIndex(([key]) => key === last));
  const visible = interrupted ? stages.slice(0, index + 1) : stages;
  const result = visible.map(([key, title], step) => ({ key, title, state: interrupted || order.status === 'completed' || step < index ? 'done' : step === index ? 'current' : 'waiting' }));
  if (interrupted) result.push({ key: order.status, title: { exception: '异常待核实', closed: '异常已关闭', cancelled: '订单已取消' }[order.status], state: 'current' });
  return result;
}

function decorate(order) {
  return {
    ...order,
    campusName: campus[order.campus] || order.campus,
    statusName: status[order.status] || order.status,
    progressSteps: progressSteps(order),
    exceptionReason: order.exception ? exceptionReason[order.exception.reason] || order.exception.reason : '',
    lastResolutionText: order.lastResolution ? (exceptionReason[order.lastResolution.reason] || order.lastResolution.reason) + ' → ' + (resolutionName[order.lastResolution.resolution] || order.lastResolution.resolution) : '',
    slotName: slotName(order.slot),
    amountText: (order.amount_cents / 100).toFixed(2),
    shortId: order.id.slice(0, 8),
    createdText: new Date(order.created_at).toLocaleString('zh-CN')
  };
}

module.exports = { campus, status, slotName, progressSteps, decorate };
