/* ============================================================
 * 上游契约基线
 * ============================================================
 * 这个工具的每条规则都不是写法偏好,而是照着某个上游版本的真实
 * 行为写下的判定。上游一变,规则可能要跟着变,也可能完全不用变
 * —— 区别只有"回去看一眼"才知道。所以把「照着哪个版本核对的」
 * 做成机器可读的一份数据,跟着每次体检结果一起输出;目标运行时
 * 落在核对过的范围之外时明确说"没核对过",而不是假装照样有效。
 *
 * 每条规则锚在上游哪个文件/行:见 docs/CHECKS.md。
 * 上游升级后的逐条复核流程:见同一文档末尾「上游变动后怎么复核」。
 * ============================================================ */

/** 上游契约基线:最近一次逐条核对上游代码时的事实快照。 */
export const CONTRACT = {
  /** 最近一次逐条核对上游代码的日期。 */
  verifiedAt: '2026-10-20',
  /** 核对时上游各包的版本;规则的判定口径照着这些版本的代码写。 */
  upstream: {
    'dsh-plugin-desktop': '2.0.18',
    'dsh-community-market': '0.1.0-dev.0',
    '@deepseek-ai/cordis': '4.0.5',
    '@deepseek-ai/dsh-tools': '0.2.1-rc.2',
    pnpm: '11.8.0',
  },
  /** 实际核对过的 DSH 运行时版本。 */
  runtimes: ['0.1.0-rc.8', '0.1.3-alpha.1', '0.1.5-rc.2', '0.2.0-rc.2', '0.2.1-rc.2'],
  /** 核对过的运行时区间;超出只代表未核对,不代表不可用。 */
  runtimeRange: '>=0.1.0-rc.8 <0.3.0-0',
}

/** 一行人读的基线摘要,供 CLI 抬头与会话内结果展示。 */
export function contractLine() {
  const { upstream } = CONTRACT
  return `契约基线 ${CONTRACT.verifiedAt} · desktop ${upstream['dsh-plugin-desktop']}`
    + ` / market ${upstream['dsh-community-market']}`
    + ` · 已核对运行时 ${CONTRACT.runtimes.join('、')}`
}

/**
 * 目标运行时是否在核对过的范围内。
 * 不做区间数学:只认"确实核对过的那几个版本",别的一律如实说
 * 没核对过 —— 这条提示的价值就在于不替上游的未知变动打包票。
 * @param {string | undefined} runtime - 目标 DSH 运行时版本。
 * @returns {Array<{level: 'warning', rule: string, message: string}>}
 */
export function checkContractBaseline(runtime) {
  if (runtime === undefined || runtime === '') return []
  if (CONTRACT.runtimes.includes(runtime)) return []
  return [{
    level: 'warning',
    rule: 'C0-contract',
    message: `目标运行时 ${runtime} 不在本工具核对过的版本里`
      + `(已核对 ${CONTRACT.runtimes.join('、')},核对日期 ${CONTRACT.verifiedAt});`
      + `规则仍按 ${CONTRACT.runtimeRange} 的上游行为判定,上游若已改动,结论可能过时或过严。`
      + `复核清单见 docs/CHECKS.md`,
  }]
}

/**
 * 安装期生命周期脚本。曾经是市场硬红线,核对下来现在不是了。
 * 上游 dsh-community-market 0.1.0-dev.0 的 npm 验证器已不再看
 * scripts;受控安装是 `pnpm add --save-exact --registry=…`,没有
 * --ignore-scripts,而 Profile 也没有配 onlyBuiltDependencies 允许
 * 名单。两种结局都不好,但都不是"上架被拒",所以降为 warning:
 *  - 脚本真执行 → 安装即在用户机器上跑任意代码;
 *  - 脚本被包管理器默认策略拦下 → 依赖脚本产物的插件装完即坏。
 */
export const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

/** M2 的措辞:两条安装路径行为不同,分开说清楚。 */
export function lifecycleMessage(script) {
  if (script === 'prepare') {
    return 'prepare 脚本:从 npm tarball 安装时不执行,从 github: 源安装时执行;'
      + '同一个包两条安装路径行为不一致,构建请改用 prepack'
  }
  return `${script} 脚本:宿主受控安装是 pnpm add(未加 --ignore-scripts),`
    + `要么在用户机器上执行任意代码,要么被包管理器默认策略拦下、脚本产物缺失导致插件装完即坏;`
    + `构建请改用 prepack`
}

/* ============================================================
 * 上游谓词的本地副本
 * ============================================================
 * 下面几个判定逐字照抄上游,注释里标出锚点。照抄而不是"按理解重写"
 * 是有意的:上游改了这几行,diff 才看得出来我们跟着漂了没有。
 * ============================================================ */

/**
 * 携带身份语义的核心包:cordis 上下文与 dsh 服务在宿主/插件各持一份时
 * Symbol 不等,注册对不上。schemastery、cosmokit 等纯工具库不在此列,
 * 插件可以正常依赖。
 */
export const CORE_SCOPE = '@deepseek-ai/'

/**
 * 是否为带身份语义的核心包(M3 / M7 共用)。
 * 曾经 manifest-check 与 registry-check 各存一份,这里合并为一处。
 * @param {string} name - npm 包名。
 * @returns {boolean}
 */
export function isIdentityCore(name) {
  return name === `${CORE_SCOPE}cordis`
    || name.startsWith(`${CORE_SCOPE}cordis-`)
    || name.startsWith(`${CORE_SCOPE}dsh`)
}

/**
 * 是否与 DSH 运行时**同一条版本线**。
 *
 * 这条区分不能省:核心包里只有 @deepseek-ai/dsh* 跟着 DSH 运行时版本
 * 走(0.1.3-alpha.1 这类),而 @deepseek-ai/cordis 自成一条 4.x 线 ——
 * 拿 "4.0.1 || 4.0.2" 去比对运行时 0.1.3-alpha.1,得到的"不含目标运行时"
 * 是范畴错误,而不是插件的问题(本包自己的清单就是这个形状)。
 * 所以 M7 的**范围合法性**覆盖全部核心包,**是否含目标运行时**只对这条线判。
 * @param {string} name - npm 包名。
 * @returns {boolean}
 */
export function isRuntimeVersioned(name) {
  return name.startsWith(`${CORE_SCOPE}dsh`)
}

/* ============================================================
 * DSH 0.2 的 peer 硬拦(M7 判级的依据)
 * ============================================================
 * 0.2 起宿主在启动时就按 peerDependencies 决定一个插件能不能加载:
 * app-boot 的 evaluatePluginCompatibility(deepseek-harness
 * packages/boot/app-boot/src/plugin-compatibility.ts:61-88)只看名字是
 * @deepseek-ai/dsh 或 @deepseek-ai/dsh-* 的 peer(:75),带
 * includePrerelease 比对运行时自己的版本(:77),不满足就由
 * compatibility-preflight.ts:103-130 把这一行 disabled = true,原因只走
 * DenialReporter 打到 Desktop 的标准错误输出 —— 用户只看到"插件装了却没有"。
 * 豁免是 Profile 目录里的 compatibility.json(dsh plugin allow-version)。
 *
 * 0.1 的 app-boot 里没有这个函数(实测 0.1.5-rc.2),所以同一条
 * "peer 不含目标运行时"在 0.1 上只是未来隐患,在 0.2 上是当场失效。
 * M7 的判级因此跟着目标运行时分支,见 semver-rules.mjs。
 * ============================================================ */

/** 首个带 peer 硬拦的 DSH 运行时;写 rc.0 是为了把 0.2.0 的所有预发布版都算进去。 */
export const PEER_GATE_SINCE = '0.2.0-rc.0'

/* ============================================================
 * DSH 0.2.1 起 `engines.dsh` 是唯一裁判(M17 判级的依据)
 * ============================================================
 * 0.2.1 把同一个函数改成**两段**(plugin-compatibility.ts 的
 * unmetRequirements,文件抬头那行注释就写明了口径:
 * "Evaluate plugin dsh requirements (`engines.dsh`, else dsh peers)"):
 *   1. 清单里只要有 `engines.dsh`,就只按它判,**dsh peer 全部不看**;
 *   2. 没有 `engines.dsh` 才退回逐个比对 dsh peer(0.2.0 的老路)。
 *
 * 要命的几处细节,都在真实宿主上逐个试过(见 docs/CHECKS.md §2 M17):
 *  - 字段是 `engines.dsh`,**不是**插件圈里自己写的 `dsh.engine` ——
 *    上游从来不读后者,我们的 M6 判的是自家约定,两者不要混。
 *  - `workspace:^ ~ *` 的"就是当前运行时"等价**只对 peer 成立**;写进
 *    `engines.dsh` 会走 semver 判定,直接算不满足(0.2.1 的 JSDoc 明说
 *    "including any workspace: `engines.dsh`, are unmet")。
 *  - 空字符串同样算不满足(satisfies() 里的 `range.trim() !== ''`)。
 *  - `engines` 不是对象、或 `engines.dsh` 不是字符串时,上游直接抛;
 *    compatibility-preflight.ts 的 denial() 把抛出来的也当拒绝,理由是
 *    "its declared dsh requirements cannot be validated" —— 一样是停用。
 *
 * 0.2.0 的 app-boot 完全不读 `engines` 这个字段(实测 0.2.0-rc.2:上面
 * 每种写法都放行),所以同一份清单在两条产品线上会得到**相反**的结论:
 * 市场插件要同时装在 0.6 和 0.7 上,两处都得写对。
 * ============================================================ */

/**
 * 首个按 `engines.dsh` 判定的 DSH 运行时。
 * 同 PEER_GATE_SINCE 写 rc.0:把 0.2.1 的预发布版都算进去(实际核对的是
 * 0.2.1-rc.2,这是上游这条线目前唯一发出来的预发布版)。
 */
export const ENGINES_GATE_SINCE = '0.2.1-rc.0'

/**
 * 宿主硬拦会拿去比对的 peer 名,逐字照抄
 * plugin-compatibility.ts:75 的条件。
 *
 * 跟 isRuntimeVersioned 故意分开:后者是前缀判断,把 `@deepseek-ai/dshfoo`
 * 这种也算进来;宿主要求要么恰好是 `@deepseek-ai/dsh`,要么带连字符。
 * 判"会不会被宿主拦"只认宿主这一条,免得我们报死一个宿主根本不看的 peer。
 * @param {string} name - npm 包名。
 * @returns {boolean}
 */
export function isGatedPeer(name) {
  return name === `${CORE_SCOPE}dsh` || name.startsWith(`${CORE_SCOPE}dsh-`)
}

/**
 * 宿主把这三种写法直接当作"就是当前运行时",一律视为满足
 * (plugin-compatibility.ts:76)。monorepo 内部写法,发到 Registry 的包
 * 装不出这个依赖,所以不拦但要单独提示。
 */
export const WORKSPACE_PEER_RANGES = new Set(['workspace:^', 'workspace:~', 'workspace:*'])

/** 上游 dsh-community-market/src/install/service.ts:26 的 PACKAGE_NAME_PATTERN。 */
export const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

/**
 * 上游 desktop-plugins.ts:193 的 safePackageName(比市场侧多一条 214 长度限制)。
 * @param {unknown} value
 * @returns {boolean}
 */
export function safePackageName(value) {
  return typeof value === 'string' && value.length <= 214 && PACKAGE_NAME_PATTERN.test(value)
}

/**
 * 永远装不进市场的产品包名。
 * 上游 service.ts:34-39 BLOCKED_PRODUCT_PACKAGES + desktop-plugins.ts:48-53
 * IMMUTABLE_BUNDLES 里对第三方有意义的那几个(宿主自身与市场自身)。
 * 2.0.17 起 BLOCKED_PRODUCT_PACKAGES 多了 dsh-desktop-next(上游另一个应用
 * 变体,我们的产品不打包它,但市场照样拒绝这个名字)。
 */
export const BLOCKED_PACKAGE_NAMES = new Set([
  'dsh-plugin-desktop',
  'dsh-plugin-desktop-beta',
  'dsh-desktop-next',
  'dsh-community-market',
  '@deepseek-ai/dsh-desktop-app',
])

/**
 * 上游 dsh-community-market/src/install/service.ts:268 safeBundlePatch,逐字照抄。
 * @param {unknown} value - dsh.bundle.patch 的值。
 * @returns {boolean}
 */
export function safeBundlePatch(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\0')) return false
  const path = value.startsWith('./') ? value.slice(2) : value
  return path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'))
}

/**
 * safeBundlePatch 不通过时,说清楚具体违反了哪一条 —— 只说"不合法"
 * 作者无从下手。
 * @param {string} value - 已确认为非空字符串的 patch 路径。
 * @returns {string | undefined} 违规原因,合法时返回 undefined。
 */
export function bundlePatchProblem(value) {
  if (safeBundlePatch(value)) return undefined
  if (value.length > 512) return '超过 512 字符'
  if (value.includes('\0')) return '含 NUL 字节'
  const path = value.startsWith('./') ? value.slice(2) : value
  if (path.length === 0) return '去掉 "./" 之后为空'
  if (path.startsWith('/')) return '是绝对路径(必须相对于包根)'
  if (path.includes('\\')) return '含反斜杠(必须用 "/" 分隔,Windows 风格路径不接受)'
  const segments = path.split('/')
  if (segments.some(segment => segment.length === 0)) return '含空路径段(如重复的 "//")'
  if (segments.some(segment => segment === '.' || segment === '..')) return '含 "." 或 ".." 路径段(不得越出包根)'
  if (segments.some(segment => segment.includes(':'))) return '路径段含 ":"'
  return '不满足上游 safeBundlePatch'
}

/**
 * 宿主保留的 Loader 行 id。撞上的后果不是"这个插件不生效":
 *  - settings / web-runtime:dsh-plugin-desktop 直接抛错,Desktop 起不来
 *    (profile.ts:955-958、977-979);
 *  - 市场行 id:该行被静默剥离,并让整个 Market provider 以
 *    "conflicting Market provider Loader identity was removed" 失败
 *    (profile.ts:704-750、913)。
 */
export const RESERVED_ROW_IDS = new Set([
  'settings',
  'web-runtime',
  'desktop-webserver',
  // DESKTOP_MARKET_IDENTITIES.{community,dshMarket}.rowId(desktop-market.ts:31,36)
  'community-market',
  'dsh-market',
])

/**
 * 宿主保留的 Loader 行 name(MARKET_PACKAGE_NAMES,desktop-market.ts:32,37)。
 * 补丁行的 name 撞上同样触发 Market provider 失败;不过这类 name 本来就
 * 会先被 M5 拦在"超出本包命名空间"上,这里保留是为了措辞更准确。
 */
export const RESERVED_ROW_NAMES = new Set([
  'dsh-community-market',
  'dshmarket',
])

/** 宿主 dsh-plugin-desktop 2.0.17 的 engines.node。 */
export const HOST_NODE_ENGINES = '^22.19.0 || >=24.0.0'
