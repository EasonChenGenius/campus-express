# 微信小程序界面参考（仅借鉴设计）

检索日期：2026-10-23。这里展示公开 GitHub 项目，**没有把外部代码或截图复制进本仓库**。未来正式小程序优先沿用本项目的业务与权限规则，再选择组件风格；不要照搬他人的支付、登录或后台实现。

| 项目 | 可借鉴之处 | 使用判断 |
|---|---|---|
| [TDesign 小程序零售模板（A）](https://github.com/Tencent/tdesign-miniprogram-starter-retail) | 首页卡片层级、订单列表与清晰的主操作布局。 | 仓库采用 MIT；本项目只按业务重新设计页面，不直接引入整套商城。 |
| [NTU 快递帮](https://github.com/fypklanfanqie/Campus-Economy-Mini-Program) | 与校园代取场景接近；README 展示玻璃拟态、状态标签、骑手任务和后台。下方是其仓库原有截图。 | [LICENSE](https://github.com/fypklanfanqie/Campus-Economy-Mini-Program/blob/main/LICENSE) 明确附加商业使用限制；仅看设计，不复制代码或资产。 |
| [Vant Weapp](https://github.com/youzan/vant-weapp) | 适合订单卡片、表单、步骤条、弹窗和状态反馈，组件成熟，便于保持学生与代取员页面统一。 | 仓库标注 MIT；正式采用前仍需核对具体版本与许可证。 |
| [WeUI 小程序组件库](https://github.com/wechat-miniprogram/weui-miniprogram) | 适合微信习惯的登录表单、确认弹窗、列表和空状态，可作为基础交互规范。 | 仓库标注 MIT；视觉相对朴素，可用本项目配色定制。 |
| [Apron Design 小程序](https://github.com/apron-design/miniprogram) | 统一的设计 token、栅格、Steps 和 Timeline，适合订单进度与后台概览。 | 仓库标注 MIT；需要在微信开发者工具中实际体验后再决定是否采用。 |

## NTU 快递帮仓库截图

![NTU 快递帮截图 1](https://raw.githubusercontent.com/fypklanfanqie/Campus-Economy-Mini-Program/main/screenshots/shot-1.png)

![NTU 快递帮截图 3](https://raw.githubusercontent.com/fypklanfanqie/Campus-Economy-Mini-Program/main/screenshots/shot-3.png)

## 本项目的设计方向

已选定 **A 的布局＋C 的颜色**：借鉴 TDesign 的信息层级、卡片列表和主操作位置；用原创的浅薰衣草、雾蓝与薄荷色建立柔和冷色氛围，深色文字保持可读。C 项目仅作视觉参考，**不复制代码、截图或其他资产**。学生侧按取件信息、包裹信息、预约交接三段填写；代取员侧区分任务池与我的任务；管理员仍在网页后台。演示界面始终显示“虚构数据、未付款”，不能造成正式服务已开放的印象。
