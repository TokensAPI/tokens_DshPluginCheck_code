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
| 核对日期 | 2026-10-20 |
| `dsh-plugin-desktop` | 2.0.18 |
| `dsh-community-market` | 0.1.0-dev.0 |
| `@deepseek-ai/cordis` | 4.0.5 |
| `@deepseek-ai/dsh-tools` | 0.2.1-rc.2 |
| 受控安装的包管理器 | pnpm 11.8.0 |
| 已核对的 DSH 运行时 | `0.1.0-rc.8`、`0.1.3-alpha.1`、`0.1.5-rc.2`、`0.2.0-rc.2`、`0.2.1-rc.2` |
| 核对过的运行时区间 | `>=0.1.0-rc.8 <0.3.0-0` |

0.1.5-rc.2 / 0.2.0-rc.2 / 0.2.1-rc.2 三份判定不是读源码推的,是**从真实 staged 宿主里
import 上游的 `evaluatePluginCompatibility` 逐条对拍**出来的(0.1.5-rc.2 上这个导出
**根本不存在** —— 这正是 M7「0.1 没有这道闸」的前提,现在由对拍每次确认),对拍脚本固化成了
`tests/host-truth.test.mjs`,连同「把本包装进真实宿主再调一遍」的那组一起由
`npm run check:host` 跑(`DSH_HOST_ROOT` 指向宿主的 `dsh-plugin-desktop` 目录;没有宿主
时逐条报 NOT EXECUTED 并以非 0 退出,见 [§3](#3-真实宿主契约host-01host-guard-04))。
照抄上游谓词这件事本身会漂 —— 0.4.5 就是这么在 DSH 0.2.1 上判错的,所以现在有一道
对拍兜着。

`--runtime` 传了核对范围之外的版本时,会多出一条 **C0-contract** warning:明确
告诉你「这个版本没核对过,结论可能过时或过严」,而不是假装照样有效。

> 基线只保证「这些规则在这些上游版本上是对的」。上游升级后请走
> [§6 上游变动后怎么复核](#6-上游变动后怎么复核)。

---

## 1. 三条执行路径(判定同源,能做的事不同)

| 入口 | 拿到的是什么 | 跑哪些规则 |
| --- | --- | --- |
| CLI `dsh-plugin-check [目录]` | 本地工作区文件 | M1–M17 + S1–S4(完整) |
| CLI `--package <name@ver>` | `npm pack` 下载并解包的目录 | M1–M17 + S1–S4(除 M13,解包目录里没有 `tests/`) |
| 会话内 `plugin_check(path=…)` | 本地工作区文件 | M1–M17 |
| 会话内 `plugin_check(package=…)` | registry 版本清单 + tarball 里抽出的 `cordis.patch.yml` | M1–M17(除 M10、M13、M16) |

M16 在解包目录里照判:`LICENSE` 被 npm 无条件打进 tarball,不受 `files` 白名单影响,
所以「声明了 license 却没有正文」这件事在包里也看得见。

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

**允许的差异只有要看文件才能判的那三条:M10-secrets、M13-tests、M16-license-file**。
registry 路径根本没有文件;M13 还更窄一层,`tests/` 按惯例被 `files` 白名单挡在 tarball
之外,连解包目录里都没有。这是有意的取舍,不是漏 —— 反过来说,**这三条不报不等于
合格**,只说明这条路径看不见。

反向的约束同样成立:**只看清单就能判的新规则必须落在 `checkManifestFields` 里**
(M14、M15 就是这么加的),对拍会自动成立。如果新加一条规则让 `cross-path.test.mjs`
红了,先问它是不是本该共用实现,而不是先去改豁免名单。

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
  `dsh-plugin-desktop-beta`、`dsh-desktop-next`、`dsh-community-market`、
  `@deepseek-ai/dsh-desktop-app`)。这两类包无论内容多干净都装不进市场 ——
  验证器在看清单内容之前就拒了。
  **上游锚点**:`install/service.ts:26` 的 `PACKAGE_NAME_PATTERN`、
  `:34-39` 的 `BLOCKED_PRODUCT_PACKAGES`(2.0.17 起多了 `dsh-desktop-next`)、
  `desktop-plugins.ts:209` 的 `safePackageName`、`:48-53` 的 `IMMUTABLE_BUNDLES`。
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
- **诚实说明**:核对下来,**上游任何版本都没有代码读 `dsh.engine`** —— 它是插件圈自己的
  约定,不是被强制的契约(2.0.18 / DSH 0.2.1-rc.2 复核时仍然如此)。所以「未声明」只给
  warning。一旦声明了,就按声明判:自己写了范围又不覆盖目标运行时,是插件自己的矛盾,
  判 error 不冤 —— 但它的后果只是「声明不一致」,**不是**「装了打不开」。
- **别跟 `engines.dsh` 搞混**:宿主 DSH 0.2.1 起真正会读的字段叫 `engines.dsh`
  (见 M17),跟这里的 `dsh.engine` 是两个字段、两套后果。写对了 `dsh.engine` 不会让
  宿主放行,写坏了 `engines.dsh` 才会让插件装了打不开。

### M7-peer-range — peer 范围与运行时的交集

- **error**:核心 peer 的范围不是合法 SemVer 范围。范围口径是全部
  `isIdentityCore` 的包 —— `@deepseek-ai/cordis`、`@deepseek-ai/cordis-*`、
  `@deepseek-ai/dsh*`。0.3.x 时过滤写的是 `startsWith('@deepseek-ai/dsh')`,
  于是把 `@deepseek-ai/cordis` 的范围写成 `not-a-range` **完全不报** —— 偏偏
  cordis 正是 S2 冒烟真正要装的那个包,范围写坏下一步必然装不出来。
- **error(目标运行时 ≥ 0.2)**:`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer 范围
  不含目标运行时。**DSH 0.2 起这不是隐患,是当场失效**:宿主启动时就按这个范围把插件的
  Loader 行 `disabled = true`,用户装了也打不开,而原因只走 DenialReporter 打到 Desktop
  的标准错误输出、日志文件里看不到。修法是放宽范围重发,或在该 Profile 上用
  `dsh plugin allow-version` 按精确版本豁免(写进 Profile 目录的 `compatibility.json`)。
- **error(目标运行时 ≥ 0.2)**:被硬拦的 peer 范围是空字符串。semver 把 `""` 当作
  「任何版本都满足」,宿主却直接判不兼容 —— 不单独拎出来就会放行一个上游必拦的包。
- **warning(目标运行时 ≥ 0.2)**:被硬拦的 peer 写成 `workspace:^` / `workspace:~` /
  `workspace:*`。宿主把这三种直接当作「就是当前运行时」,所以不会拦;但发到 Registry
  之后这个依赖装不出来,所以仍然提示一句。`@deepseek-ai/cordis` 不走这条等价 ——
  它是 S2 冒烟真正要装的包,写成 `workspace:` 就是真装不出来,照判 error。
- **warning(上界卡在 0.x 小版本上)**:范围**覆盖**了目标运行时,但上界低于下一个大版本
  (如 `>=0.1.0-rc.8 <0.3.0-0`)。当下不拦任何东西 —— 代价是**将来那次没必要的重发**:
  内核升一个小版本,这个插件就被宿主挡在加载前,即使那次升级其实没破坏任何契约。
  判法不看字符串,是问 semver 一个具体问题:「从目标运行时到下一个大版本之间的全部版本,
  这个范围都收不收?」收(含没写上界的开区间)就算合格。实现是
  `lib/semver-rules.mjs` 的 `coversNextMajor`,"下一个大版本"由 `nextMajorFloor` 从目标
  运行时算出来,**不写死 `1.0.0-0`** —— DSH 进了 1.x 之后这条规则要跟着抬到 `2.0.0-0`。
  - **口径的由来(用户 2026-10-22 的决定)**:版本号预测不了兼容性。0.2.0 → 0.2.1 这个
    rc 小版本就把连接中心的网关调用全打坏了,而 0.2.1 → 0.2.2 完全可能什么都不影响。
    所以 dsh peer 只保留**真实验证过的下界**,上界只挡大版本;真正的守门人是
    [§3 真实宿主契约](#3-真实宿主契约host-01host-guard-04)那套用例。"这个运行时没核对过"
    仍然会说,由 C0-contract 负责,不靠 peer 上界堵。
  - **只判 `isGatedPeer` 的那些**:`@deepseek-ai/cordis` 自成 4.x 版本线,拿"下一个大版本"
    去说它的上界是范畴错误。
  - **与"范围不含运行时"不叠加**:那条路径已经有自己的 error/warning,再加一条只是噪音。
  - **M17-engines-dsh 故意没有这条规则**。`engines.dsh` 一旦声明就是 0.2.1+ 宿主的唯一
    裁判,而本工具对它的建议是「不想处理 0.6/0.7 两条判定分叉,就别声明它」——
    对一个劝你别写的字段再加一条"写宽一点"的提示,只会增加噪音。
- **warning(目标运行时 < 0.2)**:给了 `--runtime` 而 peer 范围不含它。0.1 的 app-boot
  里没有 `evaluatePluginCompatibility`(实测 0.1.5-rc.2),不匹配也照样加载,所以这里
  预示的只是宿主升级之后的接口错配,判死会挡住「暂时还能跑、只是没来得及放宽范围」的插件。
- **「是否含目标运行时」只对 `@deepseek-ai/dsh*` 判**:核心包里只有它跟着 DSH 运行时
  版本走,`@deepseek-ai/cordis` 自成一条 4.x 版本线。拿 `"4.0.1 || 4.0.2"` 去比对运行时
  `0.1.3-alpha.1` 是范畴错误,不是插件的问题(本工具自己的清单就是这个形状)。
  区分写在 `lib/contract.mjs` 的 `isRuntimeVersioned`。
- **判「会不会被硬拦」时用的是更窄的 `isGatedPeer`**:宿主要求名字要么恰好是
  `@deepseek-ai/dsh`,要么带连字符;`isRuntimeVersioned` 的前缀判断会把
  `@deepseek-ai/dshfoo` 也算进来,拿它判死等于报死一个宿主根本不看的 peer。
- **这条规则的由来**:本包 0.4.4 自己就因为 peer 只写到 0.1 而在 TokensCowork 0.6 上被
  停用,而当时的 M7 只给一条 warning、退出码还是 0。按 §7「error = 装进用户的 Cowork
  会坏」,这种情况必须判 error。
- **warning(目标运行时 ≥ 0.2.1 且清单声明了 `engines.dsh`)**:这时候 peer **根本不参与
  判定**(见 M17),所以同样的「范围不含运行时」在这个运行时上判 error 就是假阳性 ——
  宿主不会因为它拦。但也不能闷掉:0.2.0 及以下的宿主只看 peer,同一个范围在 0.6 上照样
  把插件停用。所以降级为 warning,并在措辞里把这件事说清。空范围与 `workspace:` 两条
  同理降级,但**一定要报**,否则等于对 0.6 的用户隐瞒。
- **上游锚点**:`packages/boot/app-boot/src/plugin-compatibility.ts` →
  `evaluatePluginCompatibility`(名字过滤、`workspace:` 等价、`includePrerelease` 与空范围
  都在 `unmetRequirements` 里)、`compatibility-preflight.ts` 的 `denial()` → 置
  `disabled`、`profile.ts` → Profile bundle 的同一判定。

### M17-engines-dsh — DSH 0.2.1 起宿主唯一看的兼容声明

0.2.1 把 `evaluatePluginCompatibility` 改成了**两段**,文件抬头那行注释就是口径本身:
`Evaluate plugin dsh requirements (engines.dsh, else dsh peers)`。

1. 清单里只要有 `engines.dsh`,**就只按它判,dsh peer 一个都不看**;
2. 没有 `engines.dsh`,才退回逐个比对 dsh peer(0.2.0 的老路,见 M7)。

而 **0.2.0 的 app-boot 完全不读 `engines` 这个字段**(拿 0.2.0-rc.2 的真实宿主实测:
下面每种写坏的写法它都放行)。于是同一份清单在 0.6 和 0.7 上会得出**相反**的结论。

- **error(目标运行时 ≥ 0.2.1)**:`engines.dsh` 不含目标运行时。后果与 M7 的硬拦一字不差
  —— 启动时整行 `disabled`,用户装了也打不开,原因只在 Desktop 的标准错误输出里。
- **error(目标运行时 ≥ 0.2.1)**:`engines.dsh` 是空字符串。上游的 `satisfies()` 第一个
  条件就是 `range.trim() !== ''`,空范围直接算不满足。
- **error(目标运行时 ≥ 0.2.1)**:`engines.dsh` 写成 `workspace:^` / `workspace:~` /
  `workspace:*`。**这条最容易写错**:那套「就是当前运行时」的等价**只对 peer 成立**,
  写进 `engines.dsh` 会走 SemVer 判定、一律算不满足。上游的 JSDoc 自己写明了
  "including any workspace: `engines.dsh`, are unmet"。
- **error(目标运行时 ≥ 0.2.1)**:`engines` 不是对象,或 `engines.dsh` 不是字符串。上游
  这时**直接抛错**,而 `compatibility-preflight.ts` 的 `denial()` 把抛错也当拒绝,理由写成
  `its declared dsh requirements cannot be validated` —— 后果一样是整行停用。
- **warning(目标运行时 < 0.2.1)**:以上每一条在 0.2.0 及以下都只是 warning,因为那些宿主
  根本不读这个字段。判死会挡住「只在 0.6 上跑、还没来得及适配 0.7」的插件;不报则是在
  用户升级到 0.7 的那一刻突然失效。
- **warning(只要声明了就报一次)**:声明 `engines.dsh` 本身就意味着「0.2.1 以上只看它、
  0.2.0 以下只看 peer」。市场插件所有用户都装最新版、同时装在 0.5/0.6/0.7 上,所以两处
  都得写对。不想处理这件事的插件,**别声明这个字段**,让 peer 做唯一裁判就好 —— 本工具
  自己的清单就是这么写的。
- **上游锚点**:`packages/boot/app-boot/src/plugin-compatibility.ts` → `unmetRequirements`
  (`engines.dsh` 分支、`satisfies()` 的空范围条件)、`evaluatePluginCompatibility` 的
  JSDoc、`compatibility-preflight.ts` → `denial()` 的 catch 分支。判定结果里未满足项的字段
  **0.2.0 叫 `peers`、0.2.1 改名 `requirements`**,读这个结果的代码两个名字都要认,否则会把
  「被拦」读成「干净通过」。
- **这条规则的由来**:本包 0.4.5 只认 peer,在 0.2.1 上两个方向都判错 ——
  `engines.dsh` 没覆盖运行时时一声不响(漏判),`engines.dsh` 覆盖了而 peer 过时时判
  error(假阳性)。两头都钉在 `tests/engines-dsh.test.mjs`,并由
  `tests/host-truth.test.mjs` 跟真实宿主对拍。

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
  不是字符串数组;`external` 含本包自身(写成 `<自己>/client` 一样算);`immediately`
  不是布尔值;声明了 `dsh.client` 却没有 `exports["./client"]`,或它不是字符串 / 不是带
  字符串 `default` 的对象。
- **warning**:`external` 条目既不是裸包根、也不是 `<包名>/client`。上游写明 `external`
  有两种:它命名的那个包行(`<包名>/client` 是裸包名的别名,走 `stripClientSuffix` 归一),
  或者静态模块表里的名字 —— 后者不加依赖边,表里有没有我们在包外面查不到,所以只能提示。
  **0.4.5 之前这条判的是 error**,把上游明确允许的 `<包名>/client`、`react-dom/client`
  这类写法报成了不合格。
- **warning**:`platform !== 'web'` —— 宿主只把 `platform === 'web'` 的行当作前端模块,
  其他取值等于这段声明不会生效。
- **为什么是 error 而不是「你自己的事」**:宿主的 client-modules 在**构造期同步**解析
  所有已加载包的 `dsh.client`,一份声明写坏会抛出并让整个 client-modules fiber FAIL ——
  受害的不止这个插件,而是同一宿主里所有需要前端模块的插件。
- **字段全集**就是 `{ platform, inject?, external?, immediately? }`,未知键被忽略
  (`DshClientManifest`,`packages/util/package-manifest/src/types.ts:81-94`)。
- **上游锚点**(2.0.17 起 `parseDshClient` 与两个谓词搬到了 `client/manifest.ts`):
  `packages/client/modules/src/client/manifest.ts` → `parseDshClient`(`:161-181`)、
  `exactPackageSpecifier`(`:189-195`,非 scope 分支新增了 `:` 排除)、
  `stripClientSuffix`(`:206-208`);`packages/client/modules/src/index.ts` →
  `clientExportOf`(`:195-205`)、`external` 的两种语义与自引用抛出
  (`orderByModuleGraph`,`:490-530`)、`platform === 'web'` 过滤与缺 `./client`
  的抛出(`:841-847`)。
- 没有 `dsh.client` 的插件(绝大多数)完全不产生任何发现。

### M13-tests — 仓库要有测试

- **warning**:`scripts.test` 未声明,或仍是 `npm init` 留下的 `no test specified`
  占位命令 —— 存在但跑起来必然失败,等同于没有。
- **warning**:`scripts.test` 已声明,但目录里找不到任何测试文件。找 `test/`、
  `tests/`、`__tests__/`、`spec/` 四个常见目录,以及源码里的 `*.test.*` /
  `*.spec.*`(下探两层,跳过 `node_modules` 和点开头目录)。目录位置不强制,
  但两者都要有:只有命令没有用例,CI 绿灯是空的。
- 判 **warning** 不判 error:有没有测试不影响这个包能不能装进宿主,跟 M8/M9
  同级。判 error 会把大量能正常工作的插件挡在市场门外,与 §7 的级别定义冲突。
- 只在能看到工作区的路径上跑,理由见 §1。

### M14-publish-target — 发布目标要写死在仓库里

- **warning**:`publishConfig.registry` 未声明。此时 `npm publish` 发到哪里,取决于
  执行那台机器当时的 npm 配置 —— 换一台机器、或者 CI 上少了一行 registry,私有插件
  就这么发到了公共 npm 上,而**版本一旦发出不可撤回**(72 小时外连 unpublish 都不
  给)。写进 `package.json` 才与机器无关。
- **warning**:声明了但不是 https URL。
- **不断言具体是哪个源**。这个检查器是给所有插件作者用的通用标准,发到公共 npm
  是完全合法的选择。要把某个 Registry 钉死,写在各仓库自己的发布校验里
  (本仓库是 `scripts/validate-release.mjs`),那里才知道这个包该发去哪。

### M15-market-i18n — 市场双语文案

- **warning**:`tokenscowork` 未声明,或不是对象。
- **warning**:`tokenscowork.displayName` / `tokenscowork.summary` 缺 `zh-CN` 或
  `en-US`,或者值为空白。
- **warning**:`en-US` 与 `zh-CN` 逐字相同。把中文复制进英文字段能过所有「非空」
  检查,而市场在英文 locale 下显示的仍是中文,等于没填 —— 这是实际发生过的,所以
  单独判一条。
- 市场从**已发布的包**里读这一段(`localizeCatalog`),读不到才回退后台存的文案
  (通常只有中文)。所以改了 `package.json` 不会影响已发布版本,**要等下次发版才
  生效**。

### M16-license-file — 声明了 license 就要有正文

- **warning**:`manifest.license` 有值,但目录里找不到许可证正文(找 `LICENSE`、
  `LICENCE` 及 `.md` / `.txt` 变体)。下游拿到包只看到一个 SPDX 标识,无法确认条款
  全文和版权归属。
- 「一个 license 都没声明」是 M9 的事,这条只管「声明了却没正文」。
- 与 M13 不同,这条在 `--package` 的解包目录里照判:npm 无条件把 LICENSE 打进
  tarball。只有 registry 清单路径看不见文件。

---

## 3. 真实宿主契约(HOST-01…HOST-GUARD-04)

命令:`npm run check:host`。实现:`tests/host-contract.test.mjs`(起宿主)、
`tests/host-truth.test.mjs`(判定对拍)、`tests/host-fixture.test.mjs`(守卫自检),
夹具在 `tests/support/`。

### 为什么本工具自己也需要这一组

本工具的判定是**照抄上游**写下来的,而照抄的东西会漂:0.4.5 就是这么在 DSH 0.2.1 上
两头判错的。更一般地,插件自己的用例一旦把宿主打桩,宿主换了形状就测不出来 ——
DSH 0.2.1 把网关 `peer` 从可选改必填,一个插件因此在四个产品版本上全坏,而它三千多条
打桩用例一路全绿(agent-hub T0043/T0047)。所以这一组**宿主侧一个桩都不打**。

### 跑法与"没执行"

```bash
DSH_HOST_ROOT=<...>/.build/desktop/dsh-plugin-desktop npm run check:host
DSH_HOST_ROOTS="<0.7 的>;<0.6 的>;<0.5 的>" npm run check:host
npm run check:host -- --list-mutations
npm run check:host -- --mutate peer-0.1-only
```

- 对外只认 **`DSH_HOST_ROOT`** —— staged 宿主的 `dsh-plugin-desktop` 目录(T0047 统一
  口径)。0.4.6 及以前的 `DSH_TEST_RUNTIME`(指向宿主的 `package.json`)继续认,内部
  折算成同一个根。
- **没有宿主时逐条打印 NOT EXECUTED 并以非 0 退出**,不伪造通过。`npm test` 里这些用例
  照样在,只是记为未执行、不让仓库 CI 变红:"没跑"和"跑过了"的区别由 `check:host` 的
  退出码负责。仓库 CI 另有一步专门把这份 NOT EXECUTED 清单打出来
  (`continue-on-error`),这样绿色 CI 不会被读成"宿主契约也过了"。
- **0.1 线没有 `evaluatePluginCompatibility`**:HOST-12…14 显式打印 **NOT DECLARED**,
  不当成通过,也不当成失败 —— 那是宿主的事实,HOST-12 还会把它与
  `hostBlocksPeerMismatch` 的判断对拍一遍。

### 它装的是什么、碰的是什么

宿主自带的 launcher 起一个一次性 `$DSH_HOME` profile,bundle 只要 `@deepseek-ai/dsh-base`;
真实加载器按**本包自己的 `cordis.patch.yml`** 把 `@tokensapi/dsh-plugin-check` 挂进去。
装进去的是**本包 `files` 白名单声明的那份文件集**(加 npm 无条件打包的 `LICENSE`),
所以这一组顺带钉住了"发布出去的那份包真的能被宿主加载"。

profile 的 `node_modules` 按 scope 拼:`@deepseek-ai` 指向宿主那一份(运行时包用
module-local Symbol,多一份物理副本就对不上宿主的服务注册),第三方依赖实复制进插件
自己的 `node_modules`。**不能**把宿主的 `node_modules` 整体链到 profile 前面 ——
那样插件会解析到宿主钉住的副本,用例全绿却测的不是待测代码(T0047-A 登录踩过)。

### 只断言插件真正依赖的东西

本插件对宿主的全部依赖就是「注册一个会话内工具」:`dsh-tools` 的 `defineTool`、
`ctx.tools` 的 register / schemas / executionMode / execute、`inject: ['tools']`、
自己那一行补丁、以及 `createRequire` 能从插件自己的位置解析到宿主的运行时包。
它**不订阅会话事件、不发网关调用、不注册 slot**,所以这里没有那几类断言 ——
事件词表大小、endpoint 全清单、宿主内部字段顺序一概不碰,宿主新增什么都算兼容。
形状校验一律交给宿主自己:返回值由宿主按我们声明的 `output.schema` 校验、内容由宿主
调 `output.render` 产出、兼容判定由宿主自己的 `evaluatePluginCompatibility` 下。

| 编号 | 断言的是插件依赖的什么 |
| --- | --- |
| **HOST-01** | 加载器解析到的是本次装进去的那份包(不是宿主自带的副本);插件解析到的 `dsh-tools` 是**宿主**那一份 |
| **HOST-02** | 真实加载器挂起了插件,`ctx.tools.register` 收下了定义(`inject: ['tools']` 生效) |
| **HOST-03** | 宿主投影给模型的 schema 带着插件声明的 `path` / `package` / `version` |
| **HOST-04** | 宿主执行管线真跑一次 `plugin_check(path=…)`,返回值过了宿主的 `output.schema` 校验;被测目标就是它自己装进来那份目录,所以本包在真实宿主上自检也必须全绿 |
| **HOST-05** | 宿主按 `output.render` 产出了模型可见内容,且解得开、带着结论字段 |
| **HOST-06** | 参数互斥的错误被宿主收成 `isError` 结果而不是炸穿管线,且那个错误是**工具自己**抛的(不是 `UNKNOWN_TOOL`) |
| **HOST-07** | `isConcurrencySafe` 在宿主的调度分类里就是 `parallel` |
| **HOST-08** | `detectHostRuntime` 在真实宿主里读出的是宿主自己的版本(没有退回兜底常量) |
| **HOST-09** | 宿主自己的兼容判定放行本包的真实清单;同一份清单加一条谁都满足不了的假 peer 必须被拦(反向对照),未满足项字段名两代都认 |
| **HOST-10** | M8 照抄的宿主 `engines.node` 与宿主真实声明一致(拿的是**装进去那份副本**里的常量) |
| **HOST-11** | 宿主落地的每个路径都在临时 `$DSH_HOME` 内、都不在用户真实 `~/.dsh` 下;启动前后用户 `~/.dsh` 顶层条目的大小与 mtime 完全相同 |
| **HOST-12** | 宿主有没有 `evaluatePluginCompatibility` ⇔ `hostBlocksPeerMismatch` 的判断(M7 整套判级的前提) |
| **HOST-13** | 16 份真实插件写得出来的清单,宿主拦 ⇔ 本工具 M6/M7/M17 报 error,逐条对拍 |
| **HOST-14** | 未满足项的字段名:0.2.0 叫 `peers`,0.2.1 改名 `requirements`,两个都认 |
| **HOST-15** | 插件入口对宿主的唯一值导入 `defineTool` 还在;`detectHostRuntime` 读出宿主版本 |
| **HOST-GUARD-01…04** | 夹具自己的守卫不是恒真(不需要宿主,CI 上照常跑) |

### 夹具绝不碰用户真实的 DSH 家目录

`$DSH_HOME` 一律是 `mkdtemp` 出来的临时目录。HOST-11 不信"我们以为写在临时目录":
探针把宿主实际看到的每个路径回报上来逐个断言,夹具再比对启动前后用户 `~/.dsh` 顶层
条目的大小与 mtime。HOST-GUARD 那组反过来验这条守卫自己 —— 一个恒真的 `inside()`
会让 HOST-11 变成装饰品。规则来自一次真实事故:另一个插件的契约夹具把配置键写错,
它静默回落到真实 `~/.dsh/settings.yaml`,把用户的真实设置改成了测试值。

### 变异验证:每条用例都要能被弄坏

一条契约用例最常见的失效方式不是判错,是**空转** —— 断言的那条路径压根没被执行,
被测代码整段删掉照样绿。所以 `--mutate <名字>` 把被测路径按名字弄坏再装进去,要求
指定的那几条**必须红、且不多不少**;变异表在 `tests/support/mutations.mjs`,每条都是
一次精确的字符串替换并断言只命中一次(替换不到就报错,免得代码改过之后变异静默失效)。

| 变异 | 弄坏什么 | 应当变红 |
| --- | --- | --- |
| `no-register` | 不把工具注册进宿主注册表 | HOST-02…08 |
| `empty-render` | `output.render` 返回空内容 | HOST-05 |
| `frozen-runtime` | 不再探测运行时,一律用兜底常量(0.4.5 的形状) | HOST-08 |
| `stale-node-engines` | M8 照抄的 `engines.node` 漂了 | HOST-10 |
| `peer-0.1-only` | dsh peer 只写到 0.1(本包 0.4.4 的事故) | HOST-02…09,**只在 0.2 起的宿主上** |

最后一条是整组的有效性证明:同一个变异在 0.2.1 与 0.2.0 上让 8 条红,在 **0.1.5 上一条
都不红** —— 门禁拦的是真事故,不是在乱报。`frozen-runtime` 在 0.2.0-rc.2 上看不见
(兜底常量恰好等于那个宿主的版本),这不是空转,正是**为什么**非得对每条产品线各跑
一次:单看 0.6 这一条线,0.4.5 那类判错永远看不出来。

HOST-01 / HOST-09 / HOST-13 没有单独的变异,因为它们自带反向对照:HOST-01 的
解析一旦错到宿主副本上,整个夹具就起不来;HOST-09 的假 peer、HOST-13 里"宿主必拦"
的那几份清单,本身就是证明评估器与判级都不在空转的那一半。

---

## 4. 隔离冒烟(S 系列,只在 CLI)

实现:`lib/smoke-check.mjs`。在系统临时目录建一次性工作区,全程 `--ignore-scripts`
(被测代码没有机会在检查器进程里跑安装钩子),插件代码只在一次性子进程里运行,
超时即杀。

| 步骤 | 做什么 | 判定 |
| --- | --- | --- |
| **S1-pack** | `npm pack --ignore-scripts` | 打不出包 → error |
| **S2-install** | 按插件自己声明的 peer 范围装出一套真实运行时,插件本体走刚打出的 tgz(等价用户侧受控安装) | 装不出来 → error;例外见 §5 |
| **S3-rows** | 取补丁里 `disabled !== true` 的行 | 没有启用行 → warning(冒烟无事可做) |
| **S4-apply** | 子进程里逐行 `require.resolve` → `import` → `new Context()` → `ctx.plugin(…)` | 任一阶段抛异常 → error,并标出是哪一段 |

S4 之所以要在子进程里做,是因为它**真的执行插件代码**:顶层异常、缺模块、ESM 形状
不对、apply 里抛出,都会在这里现形 —— 这正是「装进用户 Cowork 会在启动链同点崩溃」
的那个点。子进程结果写文件而不是 stdout,避免插件打日志污染判定。

---

## 5. 通用性:为什么这套规则不因插件而异

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

## 6. 上游变动后怎么复核

上游一个版本升上去,这个检查器**可能要改,也可能完全不用改**。别猜,照下表看一遍
就有答案。每格里的锚点都是本次(2026-10-20,desktop 2.0.18 / DSH 0.2.1-rc.2)实际
读过的代码位置。

**先跑真实宿主契约,再逐条看表**:
`DSH_HOST_ROOT=<新宿主>/dsh-plugin-desktop npm run check:host`([§3](#3-真实宿主契约host-01host-guard-04))。
它把本包装进新宿主真调一遍,并直接 import 上游的 `evaluatePluginCompatibility` 与我们的
判级对拍 —— M6/M7/M17 漂没漂、宿主的服务形状换没换,一眼就知道,比读源码快也比读
源码可靠。红了再回表里找对应那行。改完用例之后,顺手跑一次
`npm run check:host -- --mutate <名字>`,确认用例没有在新宿主上退化成空转。

| 规则 | 去看什么 | 什么情况下必须改 |
| --- | --- | --- |
| M1 | market `src/install/service.ts` → `stableExactVersion`、`PACKAGE_NAME_PATTERN`(`:26`);`desktop-plugins.ts:193` → `safePackageName`、`BLOCKED_PRODUCT_PACKAGES` | 稳定版要求放宽/收紧 → 调级别与措辞;包名约束或黑名单变化 → 同步 `lib/contract.mjs` |
| M2 | 同上 → `createNpmRegistryVerifier` 是否重新检查 `scripts`;`installOptions()` 是否加了 `--ignore-scripts`;Profile 的 `pnpm-workspace.yaml` 是否配了 `onlyBuiltDependencies` | 验证器重新拒绝脚本 → 升回 error;安装加了 `--ignore-scripts` → 改措辞 |
| M3 | `@deepseek-ai/cordis` 主版本、dsh 服务注册方式 | 身份对齐机制改变 → 重新划 `isIdentityCore` 的范围 |
| M4 | market `src/install/service.ts:268` → `safeBundlePatch`(本仓逐字照抄在 `lib/contract.mjs`);`dsh-plugin-desktop/src/profile.ts` 的补丁路径 | 谓词改一个字 → 同步照抄,否则我们放行的包上游照拒 |
| M5 | `dsh-plugin-desktop/src/module-resolution.ts` → `selectedOverlayCandidate` / `PackageOverlayNotFoundError` | 行 `name` 的解析语义变化 → 这条必须跟着改 |
| M6 | 全仓搜 `dsh.engine` 有没有被真正读取(2.0.18 仍然无人读;上游读的是另一个字段 `engines.dsh`,见 M17) | 一旦上游开始强制 → 「未声明」从 warning 升 error |
| M7 | `app-boot/src/plugin-compatibility.ts` → `evaluatePluginCompatibility` 还在不在、名字过滤与 `workspace:`/空范围的口径有没有变、`compatibility-preflight.ts` 是停用还是改成别的处置;宿主提供的 `@deepseek-ai/dsh*` 版本;`@deepseek-ai/cordis` 是否并入同一条版本线;**DSH 是否进了 1.x** | 硬拦的触发版本变了 → 改 `PEER_GATE_SINCE`;名字过滤变了 → 同步 `isGatedPeer`;处置从「停用」变成别的 → 重判级别与措辞;版本变了只需更新 `CONTRACT.runtimes`;版本线合并 → 改 `isRuntimeVersioned`;上界口径由 `nextMajorFloor` 从目标运行时算出,进 1.x 后自动抬到 `2.0.0-0`,只需复核这条口径是否仍然是用户要的 |
| M17 | 同一个 `plugin-compatibility.ts` → `unmetRequirements` 的两段结构还在不在:`engines.dsh` 是否仍优先于 peer、`satisfies()` 的空范围条件、`workspace:` 等价是否扩大到 `engines.dsh`、形状错误是抛还是忽略;`PluginCompatibility` 里未满足项的字段名 | 优先级反转或字段改名 → 改 `readEnginesDsh` 与 `peersDecideCompatibility`;生效版本变了 → 改 `ENGINES_GATE_SINCE`;`workspace:` 开始对 `engines.dsh` 也等价 → 去掉那条 error;字段再改名 → 对拍用例里两个名字都要认 |
| M8/M9 | 宿主 `engines.node`(现为 `^22.19.0 \|\| >=24.0.0`,记在 `HOST_NODE_ENGINES`)、上架元数据要求 | 宿主 Node 区间变化 → 同步常量 |
| M10 | 无上游依赖(发布卫生) | 基本不用改 |
| M11 | `vendor/loader/src/config/group.ts:64`(duplicate id 抛出)、`tree.ts:8`(`EntryTree.sep`)、`dsh-plugin-desktop/src/profile.ts:633-646` → `assertUniqueEntryIds`、`desktop-market.ts:28-39` → `DESKTOP_MARKET_IDENTITIES` | 分隔符或保留 id 集合变化 → 同步 `RESERVED_ROW_IDS` / `RESERVED_ROW_NAMES`;唯一性作用域改成全局 → 改 `checkRowIdentity` 的按层逻辑 |
| M12 | `packages/client/modules/src/client/manifest.ts:161` → `parseDshClient`;`:189` → `exactPackageSpecifier`;`:206` → `stripClientSuffix`;`index.ts:195` → `clientExportOf`;`index.ts:490-530` → `external` 的两种语义;`packages/util/package-manifest/src/types.ts:81-94` → `DshClientManifest` | 字段全集或接受形状变化 → 同步 `lib/client-check.mjs`;`external` 允许的形状变化 → 跟着调级别(放宽判死会误报合格插件,收紧漏判才会放行坏包) |
| S1–S4 | cordis 的 `new Context()` / `ctx.plugin()` API | cordis 主版本升级 → 复核 `RUNNER_SOURCE` |

另外一条**没有对应规则、但复核时值得看一眼**的:`scripts/verify-cordis-config.ts` 要求
「补丁引用的包名必须在自己的 `dependencies` 里」。这条**故意不照搬** —— 它是 monorepo
内部约束,而第三方插件的核心包必须走 `peerDependencies`(M3),照搬会与 M3 直接打架、
制造假报。

复核完成后,请一并更新 `lib/contract.mjs` 里的 `verifiedAt`、`upstream`、`runtimes`
和 `runtimeRange`,再 bump 版本发布 —— 这样用户从输出的基线一行就能看出「这套结论
是照着哪个上游核对的」。

---

## 7. 判定级别的含义

- **error** — 装进用户的 Cowork 会坏(启动失败、挂不上、装不出来)。修好再发。
- **warning** — 现在能用,但预示未来断裂,或者拿不到受控安装这类更好的路径。
- **info** — 只是过程说明(比如冒烟通过了几行)。

`--strict` 会把 warning 也计入失败,退出码 1。默认只有 error 才失败。
