# 变更记录

本文件按版本倒序记录对外可见的改动。发版前请核对三者一致：`package.json`
的 `version`、标签名去掉 `v` 前缀、下方最新小节的标题版本号。

## [未发布]

### 新增

- `M14-publish-target`(warning):要声明 `publishConfig.registry` 且为 https URL。
  **不断言**具体是哪个源——发到公共 npm 是合法选择;钉死某个 Registry 是各仓库
  `scripts/validate-release.mjs` 的事。
- `M15-market-i18n`(warning):`tokenscowork.displayName` / `summary` 两个 locale
  都要非空,且 `en-US` 不能与 `zh-CN` 逐字相同——复制中文能过非空检查,英文
  locale 下等于没填。
- `M16-license-file`(warning):声明了 `license` 就要有许可证正文文件。LICENSE 被
  npm 无条件打进 tarball,所以 `--package` 的解包目录里也判。

## [0.4.2] - 2026-09-24

### 新增

- `M13-tests`(warning）：仓库要有可跑的测试——`scripts.test` 非 `npm init`
  占位命令，且目录里确有测试文件（找 `test/`、`tests/`、`__tests__/`、`spec/`
  及源码内 `*.test.*` / `*.spec.*`）。只在能看到工作区的路径上跑：`--package`
  的解包目录和会话内 `package=` 模式都不判，因为 `tests/` 不进 tarball。

## [0.4.1] - 2026-09-24

### 新增

- 市场元数据双语字段 `tokenscowork.displayName` / `summary`，显示名和简介在
  中英文 locale 下分别取对应文案。市场从已发布的包里读这些字段，所以英文文
  案从本版起才会在市场生效。
- 检查与发布工作流：`checks.yml` 跑分支与 PR 的检查，`publish-npm.yml` 只吃
  `v*` 标签，发布前自带同一份检查矩阵，并拒绝覆盖源上已存在的版本。
- MIT 许可证正文（此前只有 `package.json` 里的 `license` 字段）。

### 变更

- `publishConfig.registry` 指向私有源 `https://npm.tokensapi.ai/`，不再依赖
  机器上的默认源。

## [0.4.0] - 2026-09-10

首个发布到私有源的版本（手工发布）。此前版本的改动见提交历史。

[未发布]: https://github.com/TokensAPI/tokens_DshPluginCheck_code/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/TokensAPI/tokens_DshPluginCheck_code/releases/tag/v0.4.2
[0.4.1]: https://github.com/TokensAPI/tokens_DshPluginCheck_code/releases/tag/v0.4.1
