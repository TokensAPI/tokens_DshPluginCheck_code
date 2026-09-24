# 变更记录

本文件按版本倒序记录对外可见的改动。发版前请核对三者一致：`package.json`
的 `version`、标签名去掉 `v` 前缀、下方最新小节的标题版本号。

## [未发布]

### 新增

- 市场元数据双语字段 `tokenscowork.displayName` / `summary`，显示名和简介在
  中英文 locale 下分别取对应文案。市场从已发布的包里读这些字段，所以要等本
  节发版后才会生效。
- 检查与发布工作流：`checks.yml` 跑分支与 PR 的检查，`publish-npm.yml` 只吃
  `v*` 标签，发布前自带同一份检查矩阵，并拒绝覆盖源上已存在的版本。
- MIT 许可证正文（此前只有 `package.json` 里的 `license` 字段）。

### 变更

- `publishConfig.registry` 指向私有源 `https://npm.tokensapi.ai/`，不再依赖
  机器上的默认源。

## [0.4.0] - 2026-09-10

首个发布到私有源的版本（手工发布）。此前版本的改动见提交历史。
