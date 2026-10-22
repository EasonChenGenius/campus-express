# 从网页原型迁移到正式微信小程序

状态：V0.4 已有学生/代取员共用的**原生小程序开发演示代码**，只连接本机 Node.js 后端和虚构数据；尚未在微信开发者工具或真机验收，**没有正式微信登录、真实支付或对外试用**。当前接口见 [V0.4 契约](V0.4_API_CONTRACT.md)，试用前门槛见 [准备清单](CLOSED_PILOT_READINESS.md)。

## 目标架构

同一个小程序提供学生和代取员入口；管理员使用受保护的网页后台。正式版本需调用同一套支持审计和备份的后端 API。后端管理用户、校区、站点、订单、派单、支付、退款和日志；数据库与密钥仅在服务端。现有本地原型不依赖 Base44。

## 迁移顺序

1. **确认业务边界**：核对校区站点、合作授权、交接规则、经营主体与隐私告知，保持站点关闭和收款关闭。
2. **冻结数据契约**：以 V0.3 的独立 API 与状态机为起点，定义正式的 `users`、`campuses`、`stations`、`orders`、`order_secrets`、`assignments`、`payments`、`refunds`、`audit_logs`。金额用整数分，取件码分表加密且设保留期。无需等待 Base44 源码。
3. **先建后端**：微信登录凭证在服务器换取用户身份；角色与校区授权、站点开放状态、价格和订单状态均由服务器判定。接单使用数据库条件更新或事务，保证单笔订单只能分给一人。
4. **实现小程序页面**：V0.4 已完成学生下单/我的订单和代取员本校区任务/履约的开发演示代码。管理员仍在网页端。正式试用前需完成可信登录、真机验收和异常业务流程；接单前只下发任务摘要。
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
