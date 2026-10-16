/* ============================================================
 * 版本相关规则(M1 / M6 / M7)的唯一实现
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
  PEER_GATE_SINCE,
  WORKSPACE_PEER_RANGES,
  isGatedPeer,
  isIdentityCore,
  isRuntimeVersioned,
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
        + '上游目前不强制读取该字段,但声明之后体检才能判断你与目标运行时是否相容',
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
 *    "装进用户的 Cowork 就是坏的",按 docs/CHECKS.md §6 必须判 error;
 *    0.1 没有这道闸,判 warning 的原口径不变。
 *    这条规则的由来:本包 0.4.4 自己就因为 peer 只写到 0.1 而在
 *    TokensCowork 0.6 上被停用,而当时的 M7 只给了一条 warning。
 * @param {object} manifest
 * @param {string | undefined} runtime
 * @returns {Array<{level: string, rule: string, message: string}>}
 */
export function checkPeerRanges(manifest, runtime) {
  const findings = []
  const gated = hostBlocksPeerMismatch(runtime)
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!isIdentityCore(name)) continue
    const text = String(range)
    const blocking = gated && isGatedPeer(name)
    // 宿主把 workspace:^ / ~ / * 当作"就是当前运行时",所以这三种写法不会被
    // 拦;但发到 Registry 的包装不出这个依赖,仍要说一句。只对被硬拦的 peer
    // 走这条等价:cordis 不参与硬拦,它写成 workspace: 就是真装不出来。
    if (blocking && WORKSPACE_PEER_RANGES.has(text)) {
      findings.push({
        level: 'warning',
        rule: 'M7-peer-range',
        message: `peer ${name}@"${text}" 是 monorepo 内部写法;`
          + `宿主把它当作"就是当前运行时"所以不会拦,但发到 Registry 之后这个依赖装不出来,请写成真实范围`,
      })
      continue
    }
    // 空范围:semver 把 "" 当作"任何版本都满足",宿主却直接判不兼容
    // (plugin-compatibility.ts:77 的 requirement.trim() === '')。
    // 不单独拎出来,就会放行一个上游必拦的包。
    if (blocking && text.trim() === '') {
      findings.push({
        level: 'error',
        rule: 'M7-peer-range',
        message: `peer ${name} 的范围是空字符串;宿主把空范围直接判为不兼容,`
          + `DSH ${PEER_GATE_SINCE} 起这个插件启动时就会被停用,请写出真实范围`,
      })
      continue
    }
    if (semver.validRange(text, OPTIONS) === null) {
      findings.push({ level: 'error', rule: 'M7-peer-range', message: `peer ${name} 的范围不合法: ${text}` })
      continue
    }
    if (!isRuntimeVersioned(name)) continue
    if (runtime === undefined || runtime === '') continue
    if (semver.satisfies(runtime, text, OPTIONS)) continue
    if (blocking) {
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
    findings.push({
      level: 'warning',
      rule: 'M7-peer-range',
      message: `peer ${name}@"${text}" 不含目标运行时 ${runtime};宿主升级后此插件可能在运行时断裂(接口错配类故障)`,
    })
  }
  return findings
}

/**
 * 三条一起跑,供两条执行路径直接复用。
 * @param {object} manifest
 * @param {string | undefined} runtime
 * @returns {Array<{level: string, rule: string, message: string}>}
 */
export function checkVersionRules(manifest, runtime) {
  return [
    ...checkIdentity(manifest),
    ...checkEngine(manifest, runtime),
    ...checkPeerRanges(manifest, runtime),
  ]
}
