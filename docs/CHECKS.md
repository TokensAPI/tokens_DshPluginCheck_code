# 校验逻辑与上游契约

这份文档说明 `@tokensapi/dsh-plugin-check` **每一条规则在判什么、判到什么程度、
为什么这么判、锚在上游哪一段代码**,以及**上游变了之后怎么逐条复核**。

规则不是写法偏好。每一条都对应「插件装进用户的 TokensCowork 之后会出什么事」的
一条具体路径,而那条路径由宿主/市场的代码决定 —— 所以本文档给每条规则都标了
上游锚点(文件 + 符号),复核时照着看一遍就知道该不该改。

---

## 0. 契约基线(先看这个)

规则是**照着某个上游版本的行为**写的。基线写在 `lib/contract.mjs`,并随每次体检
结果一起输出(CLI 抬头一行、`--json` 的 `contract` 字段、会话内工具结果的
`contract` 字段)。

| 项 | 值 |
| --- | --- |
| 核对日期 | 2026-09-10 |
| `dsh-plugin-desktop` | 2.0.5 |
| `dsh-community-market` | 0.1.0-dev.0 |
| `@deepseek-ai/cordis` | 4.0.2 |
| `@deepseek-ai/dsh-tools` | 0.1.3-alpha.1 |
| 受控安装的包管理器 | pnpm 11.8.0 |
| 已核对的 DSH 运行时 | `0.1.0-rc.8`、`0.1.3-alpha.1` |
| 核对过的运行时区间 | `>=0.1.0-rc.8 <0.2.0` |

`--runtime` 传了核对范围之外的版本时,会多出一条 **C0-contract** warning:明确
告诉你「这个版本没核对过,结论可能过时或过严」,而不是假装照样有效。

> 基线只保证「这些规则在这些上游版本上是对的」。上游升级后请走
> [§5 上游变动后怎么复核](#5-上游变动后怎么复核)。

---

## 1. 三条执行路径(判定同源,能做的事不同)

| 入口 | 拿到的是什么 | 跑哪些规则 |
| --- | --- | --- |
| CLI `dsh-plugin-check [目录]` | 本地工作区文件 | M1–M10 + S1–S4(完整) |
| CLI `--package <name@ver>` | `npm pack` 下载并解包的目录 | M1–M10 + S1–S4(完整) |
| 会话内 `plugin_check(path=…)` | 本地工作区文件 | M1–M10 |
| 会话内 `plugin_check(package=…)` | registry 版本清单 + tarball 里抽出的 `cordis.patch.yml` | M1–M10(除 M10 的目录扫描) |

会话内不跑冒烟:冒烟要装依赖、起子进程、执行被测插件代码,这些不能发生在用户的
Cowork 宿主进程里。所以会话内的结论只覆盖清单侧,输出里的 `note` 会如实说明这
一点,不冒充完整体检。

**M4/M5 只有一份实现**(`lib/patch-rows.mjs` 的 `checkPatchContent`),目录体检和
会话内体检共用。这一点是踩过坑之后加的:两边曾经各写各的,会话内看不到 M5,把
「装上即崩」的插件判成了合格。

---

## 2. 清单规则(M 系列)

判定实现:`lib/manifest-check.mjs`(读磁盘)与 `lib/registry-check.mjs`(读 registry
清单)。两份的语义相同,后者不依赖文件系统,因此内置了一个够用的迷你 SemVer。

### M1-manifest — 清单本身可用

- **error**:`package.json` 不存在 / 不是合法 JSON / `name` 缺失 / `version` 不是
  合法 SemVer。
- **warning**:`version` 是预发布版(如 `0.2.0-beta.1`)。
- **为什么只是 warning**:上游市场的 npm 验证器要求 `latest` 是**稳定的精确版**,
  预发布版拿不到一键安装按钮,只会退回手动命令 —— 但插件完全可以把预发布发在
  `next` 之类的 dist-tag 上,让 `latest` 保持稳定。工具看到的是清单里的版本号,
  看不到它会不会被打成 `latest`,所以不越权判死。
- **上游锚点**:`dsh-community-market/src/install/service.ts` → `stableExactVersion()`
  (`valid(v) === v && prerelease(v) === null`),在 `createNpmRegistryVerifier` 里强制。

### M2-lifecycle — 安装期生命周期脚本

- **warning**:声明了 `preinstall` / `install` / `postinstall` / `prepare`。
- **判什么**:受控安装是 `pnpm add --save-exact --registry=…`,**没有**
  `--ignore-scripts`;Profile 的 `pnpm-workspace.yaml` 也没有配
  `onlyBuiltDependencies` 允许名单。于是两种结局,都不好:
  - 脚本真执行 → 安装即在用户机器上跑任意代码;
  - 脚本被包管理器默认策略拦下 → 依赖脚本产物的插件**装完即坏**。

  `prepare` 另说:从 npm tarball 装**不执行**,从 `github:` 源装**执行** —— 同一个
  包两条安装路径行为不一致,本身就是缺陷。构建请改用 `prepack`。
- **为什么是 warning 而不是 error(2026-09-10 改的)**:这条以前是 error,理由是
  「市场受控安装会拒绝」。核对下来这个理由**已经不成立**:上游验证器现在明确接受
  带生命周期脚本的包。它仍然是个真问题,但不再是上架阻断项,所以降级并改了措辞。
- **上游锚点**:`dsh-community-market/src/install/service.ts` → `createNpmRegistryVerifier`
  (只校验 name / 稳定版本 / `dsh.bundle.patch`,不看 `scripts`)、`installOptions()`
  (`--save-exact --registry=…`)、`executeInstall()` 里的 `pnpm add`;测试
  `dsh-community-market/tests/market-install.spec.ts` →
  `'uses npm latest and accepts lifecycle, deprecated, and unrelated repository metadata'`。

### M3-core-peer — 双内核

- **error**:`@deepseek-ai/cordis`、`@deepseek-ai/cordis-*`、`@deepseek-ai/dsh*` 出现在
  `dependencies`。
- **判什么**:这些包携带**身份语义** —— cordis 的 Context 与 dsh 的服务注册靠模块
  实例 identity 对齐。插件自己装一份,宿主一份、插件一份,Symbol 不等,注册对不上,
  典型症状是整个 Cowork 启动失败(不是这个插件坏,是全都起不来)。必须声明为
  `peerDependencies`,由宿主提供唯一实例。
- **不在此列**:`schemastery`、`cosmokit` 等纯工具库没有身份语义,插件可以正常依赖。

### M4-bundle — 补丁存在且可解析

- **error**:`dsh.bundle.patch` 缺失;指向的文件不存在(目录体检)或不在发布内容里
  (会话内体检,常见原因是 `files` 白名单漏了它);补丁不是合法 YAML;补丁没声明
  任何插件行。
- **warning**:会话内体检取不到 tarball(离线/超时/过大)—— 如实标注「补丁行本次
  未检查」,绝不因网络问题把插件判成不合格。
- **判什么**:宿主靠 `dsh.bundle.patch` 把插件挂进 cordis 加载树。取不到补丁,插件
  根本挂不上。
- **上游锚点**:`dsh-community-market/src/install/service.ts` → `safeBundlePatch()`
  (非空、≤512 字节、无 NUL、相对路径、不含反斜杠、路径段不为 `.` / `..` / 不含冒号),
  在 `createNpmRegistryVerifier` 里强制;宿主侧 `dsh-plugin-desktop/src/profile.ts` 的
  `DESKTOP_PATCH_PATH` 与 `profile-checkpoint.ts` 里的 `cordis.patch.yml` 条目。

### M5-row-scope — 补丁行只能挂自己

- **error**:补丁行的 `name` 既不等于本包包名,也不是 `<包名>/子路径`。
- **判什么**:这是**最容易写错、后果最重**的一条。补丁行里:
  - `id` = 加载器条目 id(惯例上取插件自己 `export const name` 的那个 cordis 插件名);
  - `name` = **用于模块解析的 npm 包说明符**。

  把 `name` 写成 cordis 插件名(而不是 npm 包名),宿主会拿着这个名字去 Profile 的
  `node_modules` 找包,找不到就抛 `PackageOverlayNotFoundError` —— 而这个异常发生在
  加载树构建期,**整棵插件树都起不来**,不只是这一个插件。用户看到的是 Cowork 打不开。
- **为什么允许 `<包名>/子路径`**:一个包挂多个入口(`@scope/pkg/worker`)是合法用法。
- **上游锚点**:`dsh-plugin-desktop/src/module-resolution.ts` → `selectedOverlayCandidate()`,
  `PackageOverlayNotFoundError` 在第 360 / 371 / 380 / 492 / 545 行抛出。

### M6-engine — 目标运行时声明

- **warning**:`dsh.engine` 未声明。
- **error**:`dsh.engine` 不是合法 SemVer 范围;或给了 `--runtime` 而该范围不覆盖它。
- **诚实说明**:核对下来,**上游目前没有任何代码读 `dsh.engine`** —— 它是约定,不是
  被强制的契约。所以「未声明」只给 warning。一旦声明了,就按声明判:自己写了范围又
  不覆盖目标运行时,是插件自己的矛盾,判 error 不冤。

### M7-peer-range — peer 范围与运行时的交集

- **error**:`@deepseek-ai/dsh*` 的 peer 范围不合法/不可识别。
- **warning**:给了 `--runtime` 而 peer 范围不含它。
- **为什么只是 warning**:范围不含目标运行时,不代表当场就崩 —— 它预示的是宿主升级
  之后的接口错配。判死会挡住「暂时还能跑、只是没来得及放宽范围」的插件。

### M8-node-engines / M9-license

- **warning**:`engines.node` 未声明(宿主跑在 Node 22+)、`license` 未声明。
- 都是发布卫生问题,不影响能不能装,所以都不判死。

### M10-secrets — 别把凭据发上去

- **error**:`files` 白名单里出现疑似凭据文件(`.env*`、`id_rsa`、`*.pem`、`*.p12`、`*.key`)。
- **warning**:目录里有 `.env` / `id_rsa` **且**没有用 `files` 收口 —— `npm pack` 很可能
  把它带上。
- 只有目录体检能做后半条(要看文件系统);会话内 `package=` 模式看不到工作区。

---

## 3. 隔离冒烟(S 系列,只在 CLI)

实现:`lib/smoke-check.mjs`。在系统临时目录建一次性工作区,全程 `--ignore-scripts`
(被测代码没有机会在检查器进程里跑安装钩子),插件代码只在一次性子进程里运行,
超时即杀。

| 步骤 | 做什么 | 判定 |
| --- | --- | --- |
| **S1-pack** | `npm pack --ignore-scripts` | 打不出包 → error |
| **S2-install** | 按插件自己声明的 peer 范围装出一套真实运行时,插件本体走刚打出的 tgz(等价用户侧受控安装) | 装不出来 → error;例外见 §4 |
| **S3-rows** | 取补丁里 `disabled !== true` 的行 | 没有启用行 → warning(冒烟无事可做) |
| **S4-apply** | 子进程里逐行 `require.resolve` → `import` → `new Context()` → `ctx.plugin(…)` | 任一阶段抛异常 → error,并标出是哪一段 |

S4 之所以要在子进程里做,是因为它**真的执行插件代码**:顶层异常、缺模块、ESM 形状
不对、apply 里抛出,都会在这里现形 —— 这正是「装进用户 Cowork 会在启动链同点崩溃」
的那个点。子进程结果写文件而不是 stdout,避免插件打日志污染判定。

---

## 4. 通用性:为什么这套规则不因插件而异

**规则判的全是「插件与宿主之间的契约」,不是插件的业务行为。** 无论插件是做笔记、
调模型还是控浏览器,它挂进宿主的方式完全一样:一份 `package.json`、一份
`cordis.patch.yml`、一次 `pnpm add`、一次加载树构建。M 系列查的就是这条通路上的
声明,S 系列执行的就是这条通路本身。所以这套规则对所有插件同样适用。

真正会因插件而异的是**业务是否正确**(接口对不对、功能好不好用)—— 那不在体检范围
内,本工具不碰。

体检里唯一「看插件长相」的地方是 S4:它会真的 `import` 并 `apply` 你的插件。为了不
因为插件的正常差异而误判,有**四处刻意不致命**:

1. **网络取不到** —— 会话内取 tarball 失败、CLI 装不上公开源上确实没有的包,都只给
   warning 并如实标注「未检查」,不判不合格。检查环境的限制不该算在插件头上。
2. **宿主内核的私有版本** —— `@deepseek-ai/*` 的内部版本本就不发公开源,S2 会先探测
   一次(`npm view <name>@<range>`),确认是「内核私有版本取不到」才降级为 warning;
   其它包解析不到,仍然是插件自己范围写错,照判 error。
3. **补丁配置含动态表达式** —— `cordis.patch.yml` 可以带 `!!js` 之类的自定义标签。解析
   用的是宽容 schema(未知标签收敛成占位对象),行照常提取,该行的 config 标记为
   不可静态求值,冒烟时**以空配置 apply**,并给一条 warning 说明。不因为看不懂配置
   就拒绝这个插件。
4. **`inject` 声明的服务没注入** —— 插件声明了依赖服务而冒烟环境里没有,cordis 会
   正常停车等待。这是预期行为,不算失败。

---

## 5. 上游变动后怎么复核

上游一个版本升上去,这个检查器**可能要改,也可能完全不用改**。别猜,照下表看一遍
就有答案。每格里的锚点都是本次(2026-09-10)实际读过的代码位置。

| 规则 | 去看什么 | 什么情况下必须改 |
| --- | --- | --- |
| M1 | market `src/install/service.ts` → `stableExactVersion` | 稳定版要求放宽/收紧 → 调级别与措辞 |
| M2 | 同上 → `createNpmRegistryVerifier` 是否重新检查 `scripts`;`installOptions()` 是否加了 `--ignore-scripts`;Profile 的 `pnpm-workspace.yaml` 是否配了 `onlyBuiltDependencies` | 验证器重新拒绝脚本 → 升回 error;安装加了 `--ignore-scripts` → 改措辞 |
| M3 | `@deepseek-ai/cordis` 主版本、dsh 服务注册方式 | 身份对齐机制改变 → 重新划 `isIdentityCore` 的范围 |
| M4 | 同上 → `safeBundlePatch`;`dsh-plugin-desktop/src/profile.ts` 的补丁路径 | 补丁路径形状约束变化 → 同步 |
| M5 | `dsh-plugin-desktop/src/module-resolution.ts` → `selectedOverlayCandidate` / `PackageOverlayNotFoundError` | 行 `name` 的解析语义变化 → 这条必须跟着改 |
| M6 | 全仓搜 `dsh.engine` 有没有被真正读取 | 一旦上游开始强制 → 「未声明」从 warning 升 error |
| M7 | 宿主提供的 `@deepseek-ai/dsh*` 版本 | 无需改代码,更新 `CONTRACT.runtimes` 即可 |
| M8/M9 | 宿主 Node 版本、上架元数据要求 | 要求变化 → 同步措辞 |
| M10 | 无上游依赖(发布卫生) | 基本不用改 |
| S1–S4 | cordis 的 `new Context()` / `ctx.plugin()` API | cordis 主版本升级 → 复核 `RUNNER_SOURCE` |

复核完成后,请一并更新 `lib/contract.mjs` 里的 `verifiedAt`、`upstream`、`runtimes`
和 `runtimeRange`,再 bump 版本发布 —— 这样用户从输出的基线一行就能看出「这套结论
是照着哪个上游核对的」。

---

## 6. 判定级别的含义

- **error** — 装进用户的 Cowork 会坏(启动失败、挂不上、装不出来)。修好再发。
- **warning** — 现在能用,但预示未来断裂,或者拿不到受控安装这类更好的路径。
- **info** — 只是过程说明(比如冒烟通过了几行)。

`--strict` 会把 warning 也计入失败,退出码 1。默认只有 error 才失败。
