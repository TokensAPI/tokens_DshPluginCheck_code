# 变更记录

本文件按版本倒序记录对外可见的改动。发版前请核对三者一致：`package.json`
的 `version`、标签名去掉 `v` 前缀、下方最新小节的标题版本号。

## [未发布]

## [0.4.5] - 2026-10-16

### 修复

- **兼容 DSH 0.2(TokensCowork 0.6)**:0.2 起宿主在启动时按 `peerDependencies` 决定插件
  能不能加载,原 peer 只写到 0.1 的两个精确版本,于是 0.4.4 装进 0.6 后被直接停用 ——
  用户装了也打不开,而原因只打在 Desktop 的标准错误输出里。`@deepseek-ai/dsh-tools` 的
  peer 改为区间 `>=0.1.0-rc.8 <0.3.0-0`,`dsh.engine` 同步;区间同时覆盖 0.5.x 的
  0.1.5-rc.2(**原来连它也没覆盖**)和 0.6 的 0.2.0-rc.2,并且 DSH 出 0.2 正式版或后续
  补丁版时不必再发一次,但不替没核对过的 0.3 打包票。`@deepseek-ai/cordis` 补上 4.0.4。
- **M7-peer-range 按宿主实际行为判级**:目标运行时是 0.2 及以上时,`@deepseek-ai/dsh*`
  的 peer 不含该运行时改判 **error**(原先一律 warning,退出码还是 0 —— 本包自己就是这么
  漏过去的);0.1 没有这道闸,判 warning 的口径不变。顺带照抄了宿主的两个边角:
  `workspace:^` / `~` / `*` 宿主当作"就是当前运行时",不判死只提示;空范围 semver
  当作"全都满足"而宿主直接判不兼容,补成 error。
- **M12-client 不再把上游允许的写法报成不合格**:`dsh.client.external` 里
  `<包名>/client` 是裸包名的别名(上游 `stripClientSuffix`),`react-dom/client` 这类
  子路径则是静态模块表的名字;原先两种都判 error。现在包行的两种写法零发现,其余只给
  warning 说明"宿主当它是静态模块表里的名字、不加依赖边",本包自身的自引用仍判 error
  (写成 `<自己>/client` 一样拦住)。同时照抄 2.0.17 的 `exactPackageSpecifier` 新增的
  `:` 排除(`cordis:` 内建、`node:` 模块、URL)。
- **M1 的产品包名黑名单补上 `dsh-desktop-next`**:2.0.17 的
  `BLOCKED_PRODUCT_PACKAGES` 多了这一项,市场照样拒绝这个名字。

### 变更

- 契约基线按 desktop 2.0.17 / market 0.1.0-dev.0 / cordis 4.0.4 / dsh-tools 0.2.0-rc.2
  逐条复核(核对日期 2026-10-16),已核对运行时加入 `0.2.0-rc.2`,核对区间改为
  `>=0.1.0-rc.8 <0.3.0-0`。复核确认未变的:`safeBundlePatch`、`PACKAGE_NAME_PATTERN`、
  `safePackageName`、`stableExactVersion`、保留行 id/name、宿主 `engines.node`、
  `clientExportOf`、受控安装仍是不带 `--ignore-scripts` 的 `pnpm add`、上游仍然没有任何
  代码读 `dsh.engine`。`parseDshClient` 与 `exactPackageSpecifier` 搬到了
  `client/manifest.ts`,文档与注释里的锚点跟着更新。
- 宿主探测失败时的兜底运行时改为 `0.2.0-rc.2`(原 `0.1.3-alpha.1`)。

## [0.4.4] - 2026-10-12

### 新增

- 本插件自身补齐 dsh 插件页的展示元数据：新增并导出 `locale/en.json`、`locale/zh.json`，
  文案与 `tokenscowork` 市场字段一致。dsh 插件页只读 `locale/*.json`，此前标题退回完整
  包名、描述只有中文。测试校验两者一致、中英文不同且文件确实打进 tarball。

## [0.4.3] - 2026-09-24

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

[未发布]: https://github.com/TokensAPI/tokens_DshPluginCheck_code/compare/v0.4.4...HEAD
[0.4.4]: https://github.com/TokensAPI/tokens_DshPluginCheck_code/releases/tag/v0.4.4
[0.4.3]: https://github.com/TokensAPI/tokens_DshPluginCheck_code/releases/tag/v0.4.3
[0.4.2]: https://github.com/TokensAPI/tokens_DshPluginCheck_code/releases/tag/v0.4.2
[0.4.1]: https://github.com/TokensAPI/tokens_DshPluginCheck_code/releases/tag/v0.4.1
