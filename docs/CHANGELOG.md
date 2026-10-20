# 变更记录

本文件按版本倒序记录对外可见的改动。发版前请核对三者一致：`package.json`
的 `version`、标签名去掉 `v` 前缀、下方最新小节的标题版本号。

## [未发布]

## [0.4.6] - 2026-10-20

### 修复

- **兼容 DSH 0.2.1(TokensCowork 0.7):`engines.dsh` 现在是宿主唯一看的兼容声明**。
  0.2.1 把 app-boot 的判定改成两段 —— 清单里只要有 `engines.dsh`,就只按它判、
  **dsh peer 一个都不看**;没有才退回比对 peer。0.4.5 只认 peer,于是在 0.2.1 上两个方向
  都判错:`engines.dsh` 没覆盖运行时时**一声不响放行**(宿主其实会在启动时把整行停用,
  用户装了也打不开),`engines.dsh` 覆盖了而 peer 过时时**判 error**(宿主其实放行)。
  新增 **M17-engines-dsh** 按宿主实际行为判:不覆盖目标运行时、空范围、`workspace:*`
  (那套"就是当前运行时"的等价**只对 peer 成立**)、`engines` 不是对象或 `engines.dsh`
  不是字符串(上游直接抛,preflight 把抛错也当拒绝)一律判 error;目标运行时 < 0.2.1 时
  同样的写法降为 warning,因为那些宿主根本不读这个字段。M7 相应地在 `engines.dsh` 顶掉
  peer 时把 peer 判定降级为 warning,但**仍然报**,因为 0.2.0 及以下的宿主只看 peer,
  同一个范围在 0.6 上照样把插件停用。
- **M6-engine 的措辞不再暗示上游会读 `dsh.engine`**:上游任何版本都不读它,它是插件圈
  自己的约定;0.2.1 读的 `engines.dsh` 是另一个字段。两者写混正是会出事的地方,所以
  README、`docs/CHECKS.md` 与规则措辞都把这件事分开讲清。

### 新增

- **`tests/host-truth.test.mjs`:拿宿主自己验自己**。M6/M7/M17 是把上游 app-boot 的判定
  照抄一份下来的,照抄的东西会漂、而且漂了没人知道(0.4.5 就是这么判错的)。这组用例
  直接从真实 staged 宿主 import 上游的 `evaluatePluginCompatibility`,拿同一批清单与我们的
  判级逐条对拍:宿主拦 ⇔ 我们报 error。同时钉住判定结果里未满足项的字段名
  (0.2.0 叫 `peers`,**0.2.1 改名 `requirements`**,只读一个名字会把"被拦"读成"干净通过")、
  `dsh-tools` 仍导出 `defineTool`、`detectHostRuntime` 在真实宿主上读出的就是宿主版本。
  给 `DSH_TEST_RUNTIME` 指向宿主的 `dsh-plugin-desktop/package.json` 即运行,CI 上没有
  宿主时整组跳过。已在 0.2.1-rc.2 / 0.2.0-rc.2 / 0.1.5-rc.2 三个真实宿主上跑过,零不一致。
  其中 0.1.5-rc.2 上 `evaluatePluginCompatibility` **根本不存在** —— M7 整套判级就建立在
  「0.1 没有这道闸」之上,这个前提过去只是一次性实测写在注释里,现在每跑一次就确认一次。

### 变更

- 契约基线按 desktop 2.0.18 / market 0.1.0-dev.0 / cordis 4.0.5 / dsh-tools 0.2.1-rc.2
  逐条复核(核对日期 2026-10-20),已核对运行时加入 `0.2.1-rc.2` 与 `0.1.5-rc.2`
  (后者是 0.5.x 实际装的运行时,一直没进这份名单,于是 `--runtime 0.1.5-rc.2` 总是多一条
  "没核对过"的 C0 warning;这次在真实宿主上核过了),核对区间不变
  (`>=0.1.0-rc.8 <0.3.0-0`)。复核确认未变的:peer 硬拦的名字过滤与 `workspace:`/空范围
  口径、`compatibility-preflight` 的处置仍是停用、`safeBundlePatch`、
  `PACKAGE_NAME_PATTERN`、`safePackageName`、保留行 id/name、宿主 `engines.node`、
  上游仍然没有任何代码读 `dsh.engine`。
- `@deepseek-ai/cordis` 的 peer 从精确版列表 `4.0.1 || 4.0.2 || 4.0.4` 改为区间
  `>=4.0.1 <4.1.0-0`:0.7 的宿主带的是 cordis **4.0.5**,精确版列表已经漏掉它。宿主不拿
  cordis 比对兼容(只比 `@deepseek-ai/dsh*`),所以这不会让插件被停用,但列表每跟一个
  补丁版就得重发一次 —— 正是本仓自己写在文档里要避免的形状。
- 本包**不声明** `engines.dsh`,仍由 peer 做唯一裁判:声明了它会在 0.6/0.5 上被忽略、
  在 0.7 上变成唯一裁判,平白多一条两条产品线判定相反的分叉。

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

[未发布]: https://github.com/TokensAPI/tokens_DshPluginCheck_code/compare/v0.4.6...HEAD
[0.4.6]: https://github.com/TokensAPI/tokens_DshPluginCheck_code/releases/tag/v0.4.6
[0.4.5]: https://github.com/TokensAPI/tokens_DshPluginCheck_code/releases/tag/v0.4.5
[0.4.4]: https://github.com/TokensAPI/tokens_DshPluginCheck_code/releases/tag/v0.4.4
[0.4.3]: https://github.com/TokensAPI/tokens_DshPluginCheck_code/releases/tag/v0.4.3
[0.4.2]: https://github.com/TokensAPI/tokens_DshPluginCheck_code/releases/tag/v0.4.2
[0.4.1]: https://github.com/TokensAPI/tokens_DshPluginCheck_code/releases/tag/v0.4.1
