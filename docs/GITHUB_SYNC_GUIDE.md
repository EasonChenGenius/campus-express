# 从零开始：Base44 → GitHub 自动同步

## 当前状态（2026-10-19）

- GitHub 账号：`EasonChenGenius`。
- Base44 应用：校园快取通，ID `6ad5df9cb5d27854baffa1a7`。
- 现有 Base44 项目 `git_remote_source=s3`，说明尚未通过 GitHub 同步。
- GitHub 现有仓库不属于这个项目，因此不要把这个项目插入不相关的已有仓库。
- 2026-10-19 实测：Base44 `list_directory` 返回 `PREMIUM_REQUIRED`，明确提示直接访问源码的 sandbox-bridge 需要 Builder 或以上套餐。浏览器打开编辑器后需 Google 通行密钥验证，尚未进入 GitHub 同步设置；因此**未配置、未验证源码同步**。
- 已建立 `https://github.com/EasonChenGenius/campus-express` 私有仓库。仓库中的文件是本地 V0.2 归档，不是 Base44 自动导出的源码。

## 2026-10-21 决策与持续维护

项目负责人选择**暂不升级 Base44**，但继续更新 GitHub。已设置每日检查：只对本地 V0.2 演示、文档和配置的真实、安全变更更新本私有仓库；无变更不提交。这个流程不能获取 Base44 免费套餐下受限的在线源码，也不会自动捕获在 Base44 编辑器里做的修改。若在线应用有变化，须另外提供可审查的内容或日后取得源码访问能力，再决定如何并入仓库。不得把手动归档称为 2-Way Sync。

## 自动同步推荐做法（真正的 Base44 源码）

1. 由账号持有人完成 Base44 浏览器登录的通行密钥验证，再打开编辑器：<https://app.base44.com/apps/6ad5df9cb5d27854baffa1a7/editor/preview>。
2. 在顶部找到 GitHub 图标（可能在 Dashboard 或应用设置内），点击 `Connect to GitHub`。
3. 如果界面提示需要 Builder 套餐，先决定是否升级（按结算页面实际价格为准）。
4. 通过 GitHub 的 OAuth 页面授权 Base44 Builder。不要把你的 GitHub 密码或 Token 发给任何人。
5. 若 Base44 允许连接已有仓库，选择现有私有仓库 `EasonChenGenius/campus-express`；先备份并比对同名文件。若只允许 Base44 创建新仓库，不要创建第二个同名仓库或覆盖现有归档，先制定迁移合并方案。
6. 选择/开启 `2-Way Sync`（如界面提供），等待第一次完整同步并确认 GitHub 中出现真实应用源码。
7. 之后修改 Base44 页面或逻辑，检查 GitHub 中新出现的 commit；GitHub 对默认分支的修改应谨慎，通过 PR 进行。
8. 将本整理包的 `README.md`、`docs/`、`CHANGELOG.md` 等**按实际需要并入仓库**。如果 Base44 已自动生成同名文件，先比对，不能直接覆盖。`demos/` 是独立演示，不要混淆真实源码。

官方介绍：<https://base44.com/blog/base44-github-integration>。

## 如果不升级 Builder

1. 使用已创建的私有仓库：<https://github.com/EasonChenGenius/campus-express>。
2. 本 ZIP 中的文档与独立演示文件作为“阶段性归档”。
3. 注意：**这并非 Base44 在线应用源码同步**，以后也不会自动保存 Base44 的修改。
4. 等具备代码导出或 GitHub 同步能力时，再迁移真正源码和数据模型。

## 每个版本如何记录

- 小改动：同步的 GitHub `commit`（提交记录）自动保存。
- 阶段性更新：把 `CHANGELOG.md` 的未发布变更写入 `v0.3.0` 等章节。
- 重要验收通过后：在 GitHub 建 Tag / Release。**需要额外操作，2-Way Sync 不保证自动创建 Tag/Release。**
- 真实运营数据和密钥永远不放在仓库；发布网站或小程序要走独立审核流程。
