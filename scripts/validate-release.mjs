// 发布前身份校验:标签、版本、仓库和 Registry 必须都是预期的那一个。
// 逻辑导出给 tests/release.test.mjs 断言,不需要真的发布一次才能验证。
import { readFileSync } from 'node:fs'
import semver from 'semver'

export const EXPECTED_REPOSITORY = 'TokensAPI/tokens_DshPluginCheck_code'
export const EXPECTED_REGISTRY = 'https://npm.tokensapi.ai/'

// 解析成 owner/repo 再比对,不用子串包含判断:否则 fork 或同名前缀的仓库会被误判为本仓库。
export function parseRepository(url) {
  if (typeof url !== 'string') return undefined
  const cleaned = url.replace(/^git\+/u, '').replace(/\.git$/u, '')
  const match = /^(?:https?:\/\/[^/]+\/|git@[^:]+:)([^/]+)\/([^/]+)$/u.exec(cleaned)
  return match ? `${match[1]}/${match[2]}` : undefined
}

export function validateRelease(tag, manifest) {
  const problems = []
  const version = manifest?.version

  if (typeof tag !== 'string' || !tag.startsWith('v')) problems.push(`标签必须形如 v<version>,收到 ${tag}`)
  else if (tag.slice(1) !== version) problems.push(`标签 ${tag} 与 package.json 版本 ${version} 不一致`)

  if (!semver.valid(version)) problems.push(`版本号不是合法 semver: ${version}`)
  else if (semver.prerelease(version)) problems.push(`预发布版本不走这条发布路径: ${version}`)

  const repository = parseRepository(manifest?.repository?.url)
  if (repository !== EXPECTED_REPOSITORY) problems.push(`仓库身份不符,期望 ${EXPECTED_REPOSITORY},解析到 ${repository}`)

  const registry = manifest?.publishConfig?.registry
  if (registry !== EXPECTED_REGISTRY) problems.push(`publishConfig.registry 必须是 ${EXPECTED_REGISTRY},收到 ${registry}`)

  return problems
}

if (import.meta.filename === process.argv[1]) {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const problems = validateRelease(process.argv[2], manifest)
  if (problems.length) {
    for (const problem of problems) console.error(`发布校验失败: ${problem}`)
    process.exit(1)
  }
  console.log(`发布校验通过: ${manifest.name}@${manifest.version} ← ${process.argv[2]}`)
}
