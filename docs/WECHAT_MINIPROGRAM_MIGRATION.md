# 从网页原型迁移到正式微信小程序

状态：技术方案，尚未实施；**目前没有正式微信小程序和真实支付。**

## 目标架构

小程序分别提供学生端与代取员端；管理员使用受保护的网页后台。三端调用同一套位于中国境内、支持审计和备份的后端 API。后端管理用户、校区、站点、订单、派单、支付、退款和日志；数据库与密钥仅在服务端。Base44 用于验证页面与流程，正式环境不依赖浏览器 localStorage。

## 迁移顺序

1. **确认业务边界**：核对校区站点、合作授权、交接规则、经营主体与隐私告知，保持站点关闭和收款关闭。
2. **冻结数据契约**：从 Base44 源码/实体导出可获授权的结构（不导出真实订单）；定义 `users`、`campuses`、`stations`、`orders`、`order_secrets`、`assignments`、`payments`、`refunds`、`audit_logs`。金额用整数分，取件码分表加密且设保留期。
3. **先建后端**：微信登录凭证在服务器换取用户身份；角色与校区授权、站点开放状态、价格和订单状态均由服务器判定。接单使用数据库条件更新或事务，保证单笔订单只能分给一人。
4. **实现小程序页面**：按学生下单/我的订单、代取员本校区任务/履约、管理员后台分批迁移。页面只发送必要字段，订单列表在接单前不下发取件码或完整联系方式。
5. **支付最后接入**：完成小程序认证、商户权限及 AppID 绑定后，服务端按订单生成预支付单；支付结果只能由已验证的微信支付通知和主动查单更新，处理幂等、退款与日对账。前端点击“支付成功”不等于已收款。
6. **验收与灰度**：先使用虚构数据做角色、跨校区、弱网、并发与异常场景测试；获得站点授权和发布审核后，再小范围试点。真实支付与正式运营须另行确认。

## 最小接口清单

- `POST /auth/wechat`、`GET /me`
- `GET /campuses`、`GET /stations?campus_id=...`、`GET /dorm-areas?campus_id=...`
- `POST /orders`、`GET /orders/mine`、`POST /orders/{id}/cancel`
- `GET /courier/tasks`、`POST /orders/{id}/accept`、`POST /orders/{id}/progress`
- `GET /admin/orders`、`POST /admin/orders/{id}/assign`、`POST /admin/couriers/{id}/approve`
- 支付准备、微信通知、查单、退款与对账接口在资质具备后单独实现。

参考：[微信支付小程序接入准备](https://pay.wechatpay.cn/doc/v3/merchant/4015459512)、[JSAPI/小程序下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791856)、[小程序调起支付](https://pay.wechatpay.cn/doc/v3/merchant/4012791898)。具体资质与审核要求以上线时官方文档为准。
