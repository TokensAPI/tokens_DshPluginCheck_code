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
| CLI `dsh-plugin-check [目录]` | 本地工作区文件 | M1–M13 + S1–S4(完整) |
| CLI `--package <name@ver>` | `npm pack` 下载并解包的目录 | M1–M13 + S1–S4(除 M13,解包目录里没有 `tests/`) |
| 会话内 `plugin_check(path=…)` | 本地工作区文件 | M1–M13 |
| 会话内 `plugin_check(package=…)` | registry 版本清单 + tarball 里抽出的 `cordis.patch.yml` | M1–M13(除 M10、M13) |

会话内不跑冒烟:冒烟要装依赖、起子进程、执行被测插件代码,这些不能发生在用户的
Cowork 宿主进程里。所以会话内的结论只覆盖清单侧,输出里的 `note` 会如实说明这
一点,不冒充完整体检。

### 同源:两条路径不允许对同一个包给出不同结论

- **只看清单就能判的规则只有一份实现** —— `lib/manifest-check.mjs` 的
  `checkManifestFields`,注册表路径的 `checkPublishedManifest` 就是它的直接调用。
  版本类判定进一步收在 `lib/semver-rules.mjs`,`dsh.client` 收在
  `lib/client-check.mjs`,路径/包名/保留 id 这些谓词收在 `lib/contract.mjs`。
- **M4/M5/M11 的补丁内容部分也只有一份** —— `lib/patch-rows.mjs` 的
  `checkPatchContent`,两边只是取文件的方式不同(读盘 vs 解 tarball)。
- `tests/cross-path.test.mjs` 是这条约束的闸门:同一份清单喂给两条路径,
  逐条比对 `level:rule`,不一致直接红。

这些都是踩过坑之后收的。0.3.x 时两边各写各的:会话内看不到 M5,把「装上即崩」的
插件判成合格;注册表侧还自带一套手写迷你 SemVer,把 `>=1.2`、`1.x`、`1.2.0 - 2.0.0`
这些完全合法的 npm 范围判成「不可识别」→ error,合格插件被判不合格。

**允许的差异只有要看工作区才能判的那两条:M10-secrets 和 M13-tests**。registry
路径根本没有工作区,而 `tests/` 按惯例被 `files` 白名单挡在 tarball 之外,连解包目录
里都没有。这是有意的取舍,不是漏 —— 反过来说,**这两条不报不等于合格**,只说明这条
路径看不见。

---

## 2. 清单规则(M 系列)

判定实现:`lib/manifest-check.mjs` 的 `checkManifestFields` —— **两条路径共用这一份**
(见 §1)。版本范围一律用真 `semver`,并且一律带 `includePrerelease`:目标运行时本身
长期是 `0.1.3-alpha.1` 这种预发布版,不带这个选项 semver 会把它排除在任何范围之外,
得出「谁都不兼容」的荒谬结论。

### M1-manifest — 清单本身可用

- **error**:`package.json` 不存在 / 不是合法 JSON / `name` 缺失 / `version` 不是
  合法 SemVer。
- **error**:`name` 不满足市场的包名约束(小写字母或数字开头,只含 `a-z 0-9 . _ -`,
  可带一层 `@scope`,总长 ≤214),或落在上游黑名单(`dsh-plugin-desktop`、
  `dsh-plugin-desktop-beta`、`dsh-community-market`、`@deepseek-ai/dsh-desktop-app`)。
  这两类包无论内容多干净都装不进市场 —— 验证器在看清单内容之前就拒了。
  **上游锚点**:`install/service.ts:26` 的 `PACKAGE_NAME_PATTERN`、
  `desktop-plugins.ts:193` 的 `safePackageName`、`BLOCKED_PRODUCT_PACKAGES`。
- **warning**:`version` 是预发布版(如 `0.2.0-beta.1`)。
- **warning**:声明了 `dsh.profile` 或 `dsh.moduleFallback` —— 这两个是宿主/Profile
  侧字段,插件包声明它没有作用,多半是从 Profile 的 `package.json` 误抄过来的。
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
- **error**:`dsh.bundle.patch` 的**路径形状**不满足上游 `safeBundlePatch` —— 绝对路径
  (`/abs/patch.yml`)、越出包根(`../outside/patch.yml`)、含反斜杠(`dist\patch.yml`)、
  空路径段(`./a//b.yml`)、段内含冒号(`./c:/patch.yml`)、含 NUL、超过 512 字节。
  这一条 0.3.x 时是**放行**的:这类包能装、能跑、体检全绿,但市场受控安装的验证器
  一律拒绝 —— 用户端永远看不到一键安装按钮,只会看到手动安装命令。
- **warning**:会话内体检取不到 tarball(离线/超时/过大)—— 如实标注「补丁行本次
  未检查」,绝不因网络问题把插件判成不合格。
- **判什么**:宿主靠 `dsh.bundle.patch` 把插件挂进 cordis 加载树。取不到补丁,插件
  根本挂不上。
- **上游锚点**:`dsh-community-market/src/install/service.ts:268` → `safeBundlePatch()`
  (`lib/contract.mjs` 里逐字照抄),在 `createNpmRegistryVerifier` 里强制;宿主侧
  `dsh-plugin-desktop/src/profile.ts` 的 `DESKTOP_PATCH_PATH` 与 `profile-checkpoint.ts`
  里的 `cordis.patch.yml` 条目。

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

- **error**:核心 peer 的范围不是合法 SemVer 范围。范围口径是全部
  `isIdentityCore` 的包 —— `@deepseek-ai/cordis`、`@deepseek-ai/cordis-*`、
  `@deepseek-ai/dsh*`。0.3.x 时过滤写的是 `startsWith('@deepseek-ai/dsh')`,
  于是把 `@deepseek-ai/cordis` 的范围写成 `not-a-range` **完全不报** —— 偏偏
  cordis 正是 S2 冒烟真正要装的那个包,范围写坏下一步必然装不出来。
- **warning**:给了 `--runtime` 而 peer 范围不含它。
- **「是否含目标运行时」只对 `@deepseek-ai/dsh*` 判**:核心包里只有它跟着 DSH 运行时
  版本走,`@deepseek-ai/cordis` 自成一条 4.x 版本线。拿 `"4.0.1 || 4.0.2"` 去比对运行时
  `0.1.3-alpha.1` 是范畴错误,不是插件的问题(本工具自己的清单就是这个形状)。
  区分写在 `lib/contract.mjs` 的 `isRuntimeVersioned`。
- **为什么只是 warning**:范围不含目标运行时,不代表当场就崩 —— 它预示的是宿主升级
  之后的接口错配。判死会挡住「暂时还能跑、只是没来得及放宽范围」的插件。

### M8-node-engines / M9-license

- **warning**:`engines.node` 未声明(宿主跑在 Node 22+)、`license` 未声明。
- **warning**:`engines.node` 声明了但不是合法范围,或与宿主的
  `^22.19.0 || >=24.0.0` **无交集** —— 包管理器会在安装阶段报 unsupported engine。
- 都是发布卫生问题,不影响能不能装,所以都不判死。

### M10-secrets — 别把凭据发上去

- **error**:`files` 白名单里出现疑似凭据文件(`.env*`、`id_rsa`、`*.pem`、`*.p12`、`*.key`)。
- **warning**:目录里有 `.env` / `id_rsa` **且**没有用 `files` 收口 —— `npm pack` 很可能
  把它带上。
- 只有目录体检能做后半条(要看文件系统);会话内 `package=` 模式看不到工作区。

### M11-row-identity — 补丁行的 id 会崩掉整个 Desktop

- **error**:同一层里 `id` 重复;`id` 含 `:`;`id` 撞宿主保留行 id
  (`settings`、`web-runtime`、`desktop-webserver`、`community-market`、`dsh-market`);
  行 `name` 撞宿主保留包名(`dsh-community-market`、`dshmarket`)。
- **判什么**:这一条查的不是「插件自己能不能跑」,而是「装上之后用户的 Desktop
  还起不起得来」。三种写法各自对应一个宿主硬失败:

  | 写法 | 宿主真实行为 | 上游锚点 |
  | --- | --- | --- |
  | 同层 `id` 重复 | `TypeError: duplicate loader entry id: <id>`;Desktop 还有一道前置检查先抛 `duplicate loader entry id "<id>" in the composed profile` | `vendor/loader/src/config/group.ts:64`;`dsh-plugin-desktop/src/profile.ts:633-646`(在 `:949` 对**合成后**的整份行集调用) |
  | `id` 含 `:` | `EntryTree.sep === ':'`,嵌套行的寻址被破坏 | `vendor/loader/src/config/tree.ts:8` |
  | 撞保留身份 | 行被静默剥离,并让整个 Market provider 以 `conflicting Market provider Loader identity was removed` 失败;`settings` / `web-runtime` 则直接抛错 | `profile.ts:122-129, 704-750, 913, 955-958, 977-979`;`desktop-market.ts:28-39` |

- **为什么必须是 error**:市场安装路径装完**从不重新解析** `cordis.patch.yml`
  (`install/service.ts:626-665` 只比对版本号,而且**没有回滚**)。所以这类包一路绿灯
  装上,下次开机才炸 —— 到那时用户面对的是一个打不开的 Cowork,而不是一个坏掉的插件。
- **唯一性按「层」判**,与上游 `assertUniqueEntryIds` 同构:它每递归一层新建一个 Set,
  所以父层与子层的同名 `id` 不算冲突。`group: true` 行的 `config` 数组会递归进去。
- **查不到的部分(如实说明)**:跨插件的 id 冲突、以及与宿主自身行集的冲突,需要完整
  的宿主行清单;那要求本工具跟宿主行集同步演进,成本与收益不匹配。这里只查已知保留 id。
- **顶层的「修改」操作不参与判定**:形如 `- id: web-runtime` + `config:`(没有 `insert:`)
  的顶层条目是**按 id 修改一条已存在的行**,不是新增。宿主自己的
  `dsh-plugin-desktop/cordis.patch.yml` 就这么用,判它反而是误伤。

### M12-client — `dsh.client` 声明错会拖垮别的插件

- **error**:`dsh.client` 不是对象;`platform` 缺失或不是字符串;`inject` / `external`
  不是字符串数组;`external` 条目不是精确的裸包根(scope 名恰好两段、非 scope 名不含
  `/`)或含本包自身;`immediately` 不是布尔值;声明了 `dsh.client` 却没有
  `exports["./client"]`,或它不是字符串 / 不是带字符串 `default` 的对象。
- **warning**:`platform !== 'web'` —— 宿主只把 `platform === 'web'` 的行当作前端模块,
  其他取值等于这段声明不会生效。
- **为什么是 error 而不是「你自己的事」**:宿主的 client-modules 在**构造期同步**解析
  所有已加载包的 `dsh.client`,一份声明写坏会抛出并让整个 client-modules fiber FAIL ——
  受害的不止这个插件,而是同一宿主里所有需要前端模块的插件。
- **字段全集**就是 `{ platform, inject?, external?, immediately? }`,未知键被忽略。
- **上游锚点**:`packages/client/modules/src/index.ts` → `parseDshClient`(`:200-221`)、
  `exactPackageSpecifier`(`:192-198`)、`clientExportOf`(`:224-234`)、
  自引用检查(`:454-461`)、`platform === 'web'` 过滤(`:756`)、
  缺 `./client` 的抛出(`:760-763`)。
- 没有 `dsh.client` 的插件(绝大多数)完全不产生任何发现。

### M13-tests — 仓库要有测试

- **warning**:`scripts.test` 未声明,或仍是 `npm init` 留下的 `no test specified`
  占位命令 —— 存在但跑起来必然失败,等同于没有。
- **warning**:`scripts.test` 已声明,但目录里找不到任何测试文件。找 `test/`、
  `tests/`、`__tests__/`、`spec/` 四个常见目录,以及源码里的 `*.test.*` /
  `*.spec.*`(下探两层,跳过 `node_modules` 和点开头目录)。目录位置不强制,
  但两者都要有:只有命令没有用例,CI 绿灯是空的。
- 判 **warning** 不判 error:有没有测试不影响这个包能不能装进宿主,跟 M8/M9
  同级。判 error 会把大量能正常工作的插件挡在市场门外,与 §6 的级别定义冲突。
- 只在能看到工作区的路径上跑,理由见 §1。

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

   > 这条到 0.4.0 才真正做到。0.3.x 时宽容标签只注册了 `'!'` 前缀,而 js-yaml 的
   > multi type 查找是**对解析后的完整标签串做前缀匹配**:`!env FOO` 解析成 `!env`
   > (命中),`!!js foo` 解析成 `tag:yaml.org,2002:js`(**不命中**)。于是宿主**唯一**的
   > 动态配置写法反而被判成「补丁不是合法 YAML」→ M4-bundle error —— 而宿主自带的
   > 6 份 `cordis.patch.yml` 有 5 份在用它(如 dsh-base 的
   > `root: !!js dshHomePath('sessions')`),照抄宿主惯用法的插件因此被判不合格。
   > 现在两个前缀都注册(`'!'` 与 `'tag:yaml.org,2002:js'`,后者同时覆盖裸 `!!js`
   > 与 `!!js/function`),并拿这 6 份真实补丁做过回归:全部 `problems === []`、行数 > 0。
   > 标签定义见 `deepseek-harness/scripts/cordis-yaml.ts`。
4. **`inject` 声明的服务没注入** —— 插件声明了依赖服务而冒烟环境里没有,cordis 会
   正常停车等待。这是预期行为,不算失败。

---

## 5. 上游变动后怎么复核

上游一个版本升上去,这个检查器**可能要改,也可能完全不用改**。别猜,照下表看一遍
就有答案。每格里的锚点都是本次(2026-09-10)实际读过的代码位置。

| 规则 | 去看什么 | 什么情况下必须改 |
| --- | --- | --- |
| M1 | market `src/install/service.ts` → `stableExactVersion`、`PACKAGE_NAME_PATTERN`(`:26`);`desktop-plugins.ts:193` → `safePackageName`、`BLOCKED_PRODUCT_PACKAGES` | 稳定版要求放宽/收紧 → 调级别与措辞;包名约束或黑名单变化 → 同步 `lib/contract.mjs` |
| M2 | 同上 → `createNpmRegistryVerifier` 是否重新检查 `scripts`;`installOptions()` 是否加了 `--ignore-scripts`;Profile 的 `pnpm-workspace.yaml` 是否配了 `onlyBuiltDependencies` | 验证器重新拒绝脚本 → 升回 error;安装加了 `--ignore-scripts` → 改措辞 |
| M3 | `@deepseek-ai/cordis` 主版本、dsh 服务注册方式 | 身份对齐机制改变 → 重新划 `isIdentityCore` 的范围 |
| M4 | market `src/install/service.ts:268` → `safeBundlePatch`(本仓逐字照抄在 `lib/contract.mjs`);`dsh-plugin-desktop/src/profile.ts` 的补丁路径 | 谓词改一个字 → 同步照抄,否则我们放行的包上游照拒 |
| M5 | `dsh-plugin-desktop/src/module-resolution.ts` → `selectedOverlayCandidate` / `PackageOverlayNotFoundError` | 行 `name` 的解析语义变化 → 这条必须跟着改 |
| M6 | 全仓搜 `dsh.engine` 有没有被真正读取 | 一旦上游开始强制 → 「未声明」从 warning 升 error |
| M7 | 宿主提供的 `@deepseek-ai/dsh*` 版本;`@deepseek-ai/cordis` 是否并入同一条版本线 | 版本变了只需更新 `CONTRACT.runtimes`;版本线合并 → 改 `isRuntimeVersioned` |
| M8/M9 | 宿主 `engines.node`(现为 `^22.19.0 \|\| >=24.0.0`,记在 `HOST_NODE_ENGINES`)、上架元数据要求 | 宿主 Node 区间变化 → 同步常量 |
| M10 | 无上游依赖(发布卫生) | 基本不用改 |
| M11 | `vendor/loader/src/config/group.ts:64`(duplicate id 抛出)、`tree.ts:8`(`EntryTree.sep`)、`dsh-plugin-desktop/src/profile.ts:633-646` → `assertUniqueEntryIds`、`desktop-market.ts:28-39` → `DESKTOP_MARKET_IDENTITIES` | 分隔符或保留 id 集合变化 → 同步 `RESERVED_ROW_IDS` / `RESERVED_ROW_NAMES`;唯一性作用域改成全局 → 改 `checkRowIdentity` 的按层逻辑 |
| M12 | `packages/client/modules/src/index.ts:200-221` → `parseDshClient`;`:192-198` → `exactPackageSpecifier`;`:224-234` → `clientExportOf` | 字段全集或接受形状变化 → 同步 `lib/client-check.mjs` |
| S1–S4 | cordis 的 `new Context()` / `ctx.plugin()` API | cordis 主版本升级 → 复核 `RUNNER_SOURCE` |

另外一条**没有对应规则、但复核时值得看一眼**的:`scripts/verify-cordis-config.ts` 要求
「补丁引用的包名必须在自己的 `dependencies` 里」。这条**故意不照搬** —— 它是 monorepo
内部约束,而第三方插件的核心包必须走 `peerDependencies`(M3),照搬会与 M3 直接打架、
制造假报。

复核完成后,请一并更新 `lib/contract.mjs` 里的 `verifiedAt`、`upstream`、`runtimes`
和 `runtimeRange`,再 bump 版本发布 —— 这样用户从输出的基线一行就能看出「这套结论
是照着哪个上游核对的」。

---

## 6. 判定级别的含义

- **error** — 装进用户的 Cowork 会坏(启动失败、挂不上、装不出来)。修好再发。
- **warning** — 现在能用,但预示未来断裂,或者拿不到受控安装这类更好的路径。
- **info** — 只是过程说明(比如冒烟通过了几行)。

`--strict` 会把 warning 也计入失败,退出码 1。默认只有 error 才失败。
