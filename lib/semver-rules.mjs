/* ============================================================
 * 版本相关规则(M1 / M6 / M7 / M17)的唯一实现
 * ============================================================
 * 这三条规则以前在两处各写一遍:CLI 走 manifest-check.mjs(用真
 * semver),会话内 package= 走 registry-check.mjs(用一套手写的迷你
 * SemVer)。迷你版只认完整三段版本号,把 ">=0.1 <0.2"、"1.x"、
 * "1.2.0 - 2.0.0" 这些完全合法的 npm 范围判成"不可识别"→ error,
 * 于是同一个包在两条路径上会拿到相反的结论,而且合格插件被判不合格。
 *
 * 现在统一到真 semver,并且只此一份:两条路径调同一个函数,再想漂
 * 也漂不了(tests/cross-path.test.mjs 是这条约束的闸门)。
 *
 * 判定口径:一律带 includePrerelease —— 目标运行时本身就长期是
 * 0.1.3-alpha.1 这种预发布版,不带这个选项 semver 会把它排除在
 * 任何范围之外,得出"谁都不兼容"的荒谬结论。
 * ============================================================ */
import semver from 'semver'
import {
  ENGINES_GATE_SINCE,
  PEER_GATE_SINCE,
  WORKSPACE_PEER_RANGES,
  isGatedPeer,
  isIdentityCore,
  isRuntimeVersioned,
  nextMajorFloor,
} from './contract.mjs'

const OPTIONS = { includePrerelease: true }

/**
 * 目标运行时上,宿主是否会因 peer 不匹配直接把插件停用。
 * 0.2 起 app-boot 带 evaluatePluginCompatibility;0.1 的 app-boot 没有这个
 * 函数(实测 0.1.5-rc.2)。锚点与后果见 contract.mjs 的「DSH 0.2 的 peer 硬拦」。
 * @param {string | undefined} runtime - 目标 DSH 运行时版本。
 * @returns {boolean}
 */
export function hostBlocksPeerMismatch(runtime) {
  if (runtime === undefined || runtime === '' || semver.valid(runtime) === null) return false
  return semver.gte(runtime, PEER_GATE_SINCE, OPTIONS)
}

/**
 * 目标运行时上,宿主是否读 `engines.dsh`。读的话它就是唯一裁判,dsh peer 全不看。
 * 0.2.1 起;0.2.0 的 app-boot 根本不碰 engines 字段(实测 0.2.0-rc.2)。
 * 锚点与各种写法的实测结果见 contract.mjs 的「DSH 0.2.1 起 engines.dsh 是唯一裁判」。
 * @param {string | undefined} runtime - 目标 DSH 运行时版本。
 * @returns {boolean}
 */
export function hostReadsEnginesDsh(runtime) {
  if (runtime === undefined || runtime === '' || semver.valid(runtime) === null) return false
  return semver.gte(runtime, ENGINES_GATE_SINCE, OPTIONS)
}

/**
 * 按上游 unmetRequirements 的读法取 `engines.dsh`,逐字照抄它的三道检查:
 * `Object.hasOwn` 取自有属性、`engines` 必须是普通对象(null 与数组都不算)、
 * `engines.dsh` 必须是字符串。形状不对时上游**抛错**,而 preflight 把抛错
 * 也算拒绝,所以这里把两种形状问题分开报,措辞才能说准后果。
 * @param {object} manifest - package.json / registry 版本文档。
 * @returns {{ state: 'absent' | 'malformed-engines' | 'malformed-range' } | { state: 'declared', range: string }}
 */
export function readEnginesDsh(manifest) {
  if (!Object.hasOwn(manifest, 'engines')) return { state: 'absent' }
  const engines = manifest.engines
  if (typeof engines !== 'object' || engines === null || Array.isArray(engines)) {
    return { state: 'malformed-engines' }
  }
  if (!Object.hasOwn(engines, 'dsh')) return { state: 'absent' }
  if (typeof engines.dsh !== 'string') return { state: 'malformed-range' }
  return { state: 'declared', range: engines.dsh }
}

/**
 * 目标运行时上,dsh peer 还算不算数。
 * 只有「宿主不读 engines.dsh」或「清单里没有 engines.dsh」时 peer 才是裁判;
 * 形状不对的 engines 会让宿主在读 peer 之前就拒掉整行,所以那种情况下
 * peer 同样不是裁判。
 * @param {object} manifest
 * @param {string | undefined} runtime
 * @returns {boolean}
 */
export function peersDecideCompatibility(manifest, runtime) {
  if (!hostReadsEnginesDsh(runtime)) return true
  return readEnginesDsh(manifest).state === 'absent'
}

/**
 * 这个 peer 范围的上界是否够高 —— 覆盖到下一个大版本就算够。
 *
 * 判法不是看字符串,是问 semver 一个具体问题:「从目标运行时到下一个大版本
 * 之间的全部版本,这个范围都收不收?」收 → 上界够(含没写上界的开区间);
 * 不收 → 上界卡在某个 0.x 小版本上。口径与理由见 contract.mjs 的
 * 「dsh peer 的上界口径」。
 * @param {string} range - 已确认合法的 SemVer 范围。
 * @param {string} runtime - 已确认合法的目标 DSH 运行时版本。
 * @returns {boolean}
 */
export function coversNextMajor(range, runtime) {
  return semver.subset(`>=${runtime} <${nextMajorFloor(runtime)}`, range, OPTIONS)
}

/**
 * 版本是否落在范围内。
 * @param {string} version - 具体版本。
 * @param {string} range - SemVer 范围。
 * @returns {boolean | null} 范围不合法时返回 null(保持既有对外契约)。
 */
export function versionSatisfies(version, range) {
  if (semver.valid(version) === null) return null
  if (semver.validRange(range, OPTIONS) === null) return null
  return semver.satisfies(version, range, OPTIONS)
}

/**
 * M1:name 与 version 的基本合法性。
 * @param {object} manifest - package.json / registry 版本文档。
 * @returns {Array<{level: string, rule: string, message: string}>}
 */
export function checkIdentity(manifest) {
  const findings = []
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    findings.push({ level: 'error', rule: 'M1-manifest', message: 'name 缺失' })
  }
  if (typeof manifest.version !== 'string' || semver.valid(manifest.version) === null) {
    findings.push({ level: 'error', rule: 'M1-manifest', message: 'version 不是合法 SemVer' })
  } else if (semver.prerelease(manifest.version) !== null) {
    findings.push({
      level: 'warning',
      rule: 'M1-manifest',
      message: `version ${manifest.version} 是预发布版;`
        + `市场受控安装只认稳定的精确版(上游 stableExactVersion),npm latest 若停在预发布版,`
        + `用户端拿不到一键安装按钮,只会看到手动命令。预发布请发在 next 之类的 dist-tag 上`,
    })
  }
  return findings
}

/**
 * M6:dsh.engine 声明的目标运行时范围。
 *
 * **这是插件圈自己的约定字段,上游任何版本都不读它**(0.2.1 读的是
 * `engines.dsh`,完全是另一个字段,由 M17 判)。保留 M6 的理由只有一个:
 * 它是作者写下来的"我打算支持哪些运行时",体检据此判断声明与 --runtime
 * 是否自相矛盾。所以 M6 的后果永远只是"声明不一致",不是"装了打不开" ——
 * 别把它的措辞写成宿主会拦。
 * @param {object} manifest
 * @param {string | undefined} runtime - 目标 DSH 运行时;未给时只判范围合法性。
 * @returns {Array<{level: string, rule: string, message: string}>}
 */
export function checkEngine(manifest, runtime) {
  const engine = typeof manifest.dsh?.engine === 'string' ? manifest.dsh.engine : undefined
  if (engine === undefined) {
    return [{
      level: 'warning',
      rule: 'M6-engine',
      message: 'dsh.engine 未声明(目标 DSH 运行时 SemVer 范围,如 ">=0.1.0-rc.8 <0.3.0-0");'
        + '这是插件自己的约定字段,上游从不读取 —— 宿主读的是 dsh peer,'
        + `DSH ${ENGINES_GATE_SINCE} 起若声明了 engines.dsh 则只读它(见 M17);`
        + '声明 dsh.engine 只是为了让体检能判断你的意图与目标运行时是否相容',
    }]
  }
  if (semver.validRange(engine, OPTIONS) === null) {
    return [{ level: 'error', rule: 'M6-engine', message: `dsh.engine 不是合法 SemVer 范围: ${engine}` }]
  }
  if (runtime !== undefined && runtime !== '' && !semver.satisfies(runtime, engine, OPTIONS)) {
    return [{ level: 'error', rule: 'M6-engine', message: `dsh.engine "${engine}" 不覆盖目标运行时 ${runtime}` }]
  }
  return []
}

/**
 * M17:`engines.dsh` —— DSH 0.2.1 起宿主唯一看的兼容声明。
 *
 * 判级口径与 M7 对齐:**会被目标运行时的宿主当场拦下就是 error**
 * (docs/CHECKS.md §7),拦不下但埋了隐患是 warning。
 *  - 目标运行时 ≥ 0.2.1:这个字段说了算,写坏/不覆盖一律 error。
 *  - 目标运行时 < 0.2.1:宿主根本不读它,所以同样的写法只是 warning ——
 *    但一定要说一句,因为用户一升级到 0.7 它立刻变成唯一裁判。
 *  - 一旦声明了它,**0.2.1 以上的宿主就不看 dsh peer 了**;反过来 0.2.0 及
 *    以下只看 peer。两条产品线结论相反,所以只要出现这个字段就提示一次。
 * @param {object} manifest
 * @param {string | undefined} runtime - 目标 DSH 运行时;未给时只判形状与范围合法性。
 * @returns {Array<{level: string, rule: string, message: string}>}
 */
export function checkEnginesDsh(manifest, runtime) {
  const declaration = readEnginesDsh(manifest)
  if (declaration.state === 'absent') return []
  const gated = hostReadsEnginesDsh(runtime)
  const level = gated ? 'error' : 'warning'
  // 形状不对:上游直接抛,preflight 把抛错也算拒绝,整行停用。
  if (declaration.state !== 'declared') {
    const field = declaration.state === 'malformed-engines' ? 'engines 不是对象' : 'engines.dsh 不是字符串'
    return [{
      level,
      rule: 'M17-engines-dsh',
      message: `${field};DSH ${ENGINES_GATE_SINCE} 起宿主读这个字段来判兼容,`
        + `形状不对会在校验阶段抛错,整行按"its declared dsh requirements cannot be validated"停用`
        + (gated ? '' : `(目标运行时 ${runtime} 还不读这个字段,所以当下不拦,升级到 0.2.1 以上立刻生效)`),
    }]
  }
  const { range } = declaration
  const findings = [{
    level: 'warning',
    rule: 'M17-engines-dsh',
    message: `声明了 engines.dsh "${range}":DSH ${ENGINES_GATE_SINCE} 起宿主**只按它判**、`
      + `dsh peer 完全不看;而 0.2.0 及以下的宿主完全不读它、只看 dsh peer。`
      + `同一个包装在 0.6 和 0.7 上会走两条判定,市场插件要两处都写对`,
  }]
  // 上游的 satisfies():空范围直接算不满足,workspace: 的"就是当前运行时"
  // 等价**只对 peer 成立**,写进 engines.dsh 会按 semver 判,一样算不满足。
  if (range.trim() === '') {
    findings.push({
      level,
      rule: 'M17-engines-dsh',
      message: `engines.dsh 是空字符串;宿主把空范围直接判为不满足,`
        + `DSH ${ENGINES_GATE_SINCE} 起这个插件启动时就会被停用,请写出真实范围`,
    })
    return findings
  }
  if (semver.validRange(range, OPTIONS) === null) {
    const workspace = WORKSPACE_PEER_RANGES.has(range)
    findings.push({
      level,
      rule: 'M17-engines-dsh',
      message: workspace
        ? `engines.dsh "${range}" 是 monorepo 内部写法;宿主只对 **peer** 认这种"就是当前运行时"的`
          + `等价,写进 engines.dsh 会按 SemVer 判定、一律算不满足,插件启动时被停用,请写成真实范围`
        : `engines.dsh 不是合法 SemVer 范围: ${range};宿主按 SemVer 判定,不合法即算不满足`,
    })
    return findings
  }
  if (runtime !== undefined && runtime !== '' && !semver.satisfies(runtime, range, OPTIONS)) {
    findings.push({
      level,
      rule: 'M17-engines-dsh',
      message: `engines.dsh "${range}" 不含目标运行时 ${runtime};`
        + (gated
          ? `宿主在启动时就按这个范围把插件的 Loader 行停用,用户装了也打不开,`
            + `而原因只打在 Desktop 的标准错误输出里、日志文件里看不到。`
            + `放宽范围重新发布,或在该 Profile 上用 dsh plugin allow-version 按精确版本豁免`
          : `目标运行时 ${runtime} 的宿主不读这个字段,所以当下不拦;`
            + `但 DSH ${ENGINES_GATE_SINCE} 以上的宿主只看它,届时此插件会被停用`),
    })
  }
  return findings
}

/**
 * M7:核心 peer 的范围。
 *
 * 三层判定的口径**故意不同**:
 *  - 范围合法性:全部 isIdentityCore 的包。以前只看 @deepseek-ai/dsh
 *    前缀,@deepseek-ai/cordis 的范围写坏了完全不报,偏偏它正是 S2 冒烟
 *    真正要装的那个包,范围写坏下一步必然装不出来。
 *  - 是否含目标运行时:只对 isRuntimeVersioned 的包。cordis 自成 4.x
 *    版本线,拿它跟运行时 0.1.3-alpha.1 比是范畴错误(详见 contract.mjs)。
 *  - **判 error 还是 warning:看目标运行时会不会硬拦**。DSH 0.2 起宿主启动
 *    时就按这个范围把不匹配的插件行停用(isGatedPeer 的那些 peer),这是
 *    "装进用户的 Cowork 就是坏的",按 docs/CHECKS.md §7 必须判 error;
 *    0.1 没有这道闸,判 warning 的原口径不变。
 *    这条规则的由来:本包 0.4.4 自己就因为 peer 只写到 0.1 而在
 *    TokensCowork 0.6 上被停用,而当时的 M7 只给了一条 warning。
 * @param {object} manifest
 * @param {string | undefined} runtime
 * @returns {Array<{level: string, rule: string, message: string}>}
 */
export function checkPeerRanges(manifest, runtime) {
  const findings = []
  // 0.2.1 起清单里有 engines.dsh 就只按它判,dsh peer 一个都不看 —— 这时候
  // 把 peer 不匹配判成 error 是**假阳性**:宿主根本不会因为它拦。但也不能
  // 闷掉,因为 0.2.0 及以下的宿主只看 peer,同一个包在 0.6 上照样被停用。
  const peersDecide = peersDecideCompatibility(manifest, runtime)
  const gated = hostBlocksPeerMismatch(runtime)
  const outdatedHosts = '但 0.2.0 及以下的宿主不读 engines.dsh、只看 dsh peer,'
    + '这个范围在那些宿主上仍会让插件被停用'
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!isIdentityCore(name)) continue
    const text = String(range)
    // 这个 peer 在**目标运行时**上会不会被宿主比对:要同时满足"宿主有这道闸"、
    // "peer 还是裁判(没被 engines.dsh 顶掉)"、"名字是宿主会看的那一类"。
    const compared = gated && peersDecide && isGatedPeer(name)
    // peer 被 engines.dsh 顶掉时,拦不住的只是**这个**运行时;0.2.0 及以下的
    // 宿主只看 peer,同一个范围在那里照样把插件停用,所以降级为 warning 并说清。
    const overridden = gated && !peersDecide && isGatedPeer(name)
    // 宿主把 workspace:^ / ~ / * 当作"就是当前运行时",所以这三种写法不会被
    // 拦;但发到 Registry 的包装不出这个依赖,仍要说一句。只对被硬拦的 peer
    // 走这条等价:cordis 不参与硬拦,它写成 workspace: 就是真装不出来。
    if ((compared || overridden) && WORKSPACE_PEER_RANGES.has(text)) {
      findings.push({
        level: 'warning',
        rule: 'M7-peer-range',
        message: `peer ${name}@"${text}" 是 monorepo 内部写法;`
          + `宿主把它当作"就是当前运行时"所以不会拦,但发到 Registry 之后这个依赖装不出来,请写成真实范围`,
      })
      continue
    }
    // 空范围:semver 把 "" 当作"任何版本都满足",宿主却直接判不兼容
    // (plugin-compatibility.ts 的 unmetRequirements → satisfies() 里 range.trim() !== '')。
    // 不单独拎出来,就会放行一个上游必拦的包。
    if ((compared || overridden) && text.trim() === '') {
      findings.push({
        level: compared ? 'error' : 'warning',
        rule: 'M7-peer-range',
        message: `peer ${name} 的范围是空字符串;宿主把空范围直接判为不兼容,`
          + (compared
            ? `DSH ${PEER_GATE_SINCE} 起这个插件启动时就会被停用,请写出真实范围`
            : `目标运行时 ${runtime} 上按 engines.dsh 判、不看它,${outdatedHosts},请写出真实范围`),
      })
      continue
    }
    if (semver.validRange(text, OPTIONS) === null) {
      findings.push({ level: 'error', rule: 'M7-peer-range', message: `peer ${name} 的范围不合法: ${text}` })
      continue
    }
    if (!isRuntimeVersioned(name)) continue
    if (runtime === undefined || runtime === '') continue
    if (semver.satisfies(runtime, text, OPTIONS)) {
      // 范围覆盖了当前运行时,所以当下没人被拦 —— 但上界卡在某个 0.x 小版本上
      // 的声明会在下一次内核小版本升级时把这个插件挡在加载前,而那次升级多半
      // 什么都没破坏。口径与理由见 contract.mjs 的「dsh peer 的上界口径」。
      if (isGatedPeer(name) && semver.valid(runtime) !== null && !coversNextMajor(text, runtime)) {
        findings.push({
          level: 'warning',
          rule: 'M7-peer-range',
          message: `peer ${name}@"${text}" 的上界低于下一个大版本(${nextMajorFloor(runtime)});`
            + `内核下次升小版本时宿主会按这个范围把插件停用,即使那次升级其实没破坏任何契约,`
            + `届时只能为改一行声明重发一版。把上界放宽到 "<${nextMajorFloor(runtime)}",`
            + `下界保留你真实验证过的最低内核;兼容性由真实宿主契约用例守,不靠上界猜`,
        })
      }
      continue
    }
    if (compared) {
      findings.push({
        level: 'error',
        rule: 'M7-peer-range',
        message: `peer ${name}@"${text}" 不含目标运行时 ${runtime};`
          + `DSH ${PEER_GATE_SINCE} 起宿主在启动时就按这个范围把插件的 Loader 行停用,`
          + `用户装了也打不开,而原因只打在 Desktop 的标准错误输出里、日志文件里看不到。`
          + `放宽范围重新发布,或在该 Profile 上用 dsh plugin allow-version 按精确版本豁免`,
      })
      continue
    }
    if (overridden) {
      findings.push({
        level: 'warning',
        rule: 'M7-peer-range',
        message: `peer ${name}@"${text}" 不含目标运行时 ${runtime};`
          + `该运行时上宿主按 engines.dsh 判定、不看 dsh peer,所以这里不拦,${outdatedHosts}`,
      })
      continue
    }
    findings.push({
      level: 'warning',
      rule: 'M7-peer-range',
      message: `peer ${name}@"${text}" 不含目标运行时 ${runtime};宿主升级后此插件可能在运行时断裂(接口错配类故障)`,
    })
  }
  return findings
}

/**
 * 四条一起跑,供两条执行路径直接复用。
 * @param {object} manifest
 * @param {string | undefined} runtime
 * @returns {Array<{level: string, rule: string, message: string}>}
 */
export function checkVersionRules(manifest, runtime) {
  return [
    ...checkIdentity(manifest),
    ...checkEngine(manifest, runtime),
    ...checkEnginesDsh(manifest, runtime),
    ...checkPeerRanges(manifest, runtime),
  ]
}
