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
import { isIdentityCore, isRuntimeVersioned } from './contract.mjs'

const OPTIONS = { includePrerelease: true }

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
      message: 'dsh.engine 未声明(目标 DSH 运行时 SemVer 范围,如 ">=0.1.3-alpha.1 <0.2");'
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
 * 两层判定的口径**故意不同**:
 *  - 范围合法性:全部 isIdentityCore 的包。以前只看 @deepseek-ai/dsh
 *    前缀,@deepseek-ai/cordis 的范围写坏了完全不报,偏偏它正是 S2 冒烟
 *    真正要装的那个包,范围写坏下一步必然装不出来。
 *  - 是否含目标运行时:只对 isRuntimeVersioned 的包。cordis 自成 4.x
 *    版本线,拿它跟运行时 0.1.3-alpha.1 比是范畴错误(详见 contract.mjs)。
 * @param {object} manifest
 * @param {string | undefined} runtime
 * @returns {Array<{level: string, rule: string, message: string}>}
 */
export function checkPeerRanges(manifest, runtime) {
  const findings = []
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!isIdentityCore(name)) continue
    if (semver.validRange(String(range), OPTIONS) === null) {
      findings.push({ level: 'error', rule: 'M7-peer-range', message: `peer ${name} 的范围不合法: ${range}` })
      continue
    }
    if (!isRuntimeVersioned(name)) continue
    if (runtime === undefined || runtime === '') continue
    if (!semver.satisfies(runtime, String(range), OPTIONS)) {
      findings.push({
        level: 'warning',
        rule: 'M7-peer-range',
        message: `peer ${name}@"${range}" 不含目标运行时 ${runtime};宿主升级后此插件可能在运行时断裂(接口错配类故障)`,
      })
    }
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
