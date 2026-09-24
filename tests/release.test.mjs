import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateRelease, parseRepository, EXPECTED_REPOSITORY, EXPECTED_REGISTRY } from '../scripts/validate-release.mjs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const read = name => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')

test('市场元数据两种语言都给了非空文案', () => {
  for (const field of ['displayName', 'summary']) {
    for (const locale of ['zh-CN', 'en-US']) {
      const text = manifest.tokenscowork[field][locale]
      assert.equal(typeof text, 'string', `缺少 ${field}.${locale}`)
      assert.ok(text.trim().length > 0, `${field}.${locale} 为空`)
    }
  }
  // 英文不能是中文的复制品,否则市场在 en-US 下等于没翻译。
  assert.notEqual(manifest.tokenscowork.displayName['en-US'], manifest.tokenscowork.displayName['zh-CN'])
  assert.notEqual(manifest.tokenscowork.summary['en-US'], manifest.tokenscowork.summary['zh-CN'])
})

test('publishConfig 指向私有源,不会误发到公共 npm', () => {
  assert.equal(manifest.publishConfig.registry, EXPECTED_REGISTRY)
})

test('仓库 URL 解析成 owner/repo,不用子串包含判断', () => {
  assert.equal(parseRepository('https://github.com/TokensAPI/tokens_DshPluginCheck_code.git'), EXPECTED_REPOSITORY)
  assert.equal(parseRepository('git+https://github.com/TokensAPI/tokens_DshPluginCheck_code.git'), EXPECTED_REPOSITORY)
  assert.equal(parseRepository('git@github.com:TokensAPI/tokens_DshPluginCheck_code.git'), EXPECTED_REPOSITORY)
  assert.equal(parseRepository('https://github.com/Someone/tokens_DshPluginCheck_code_fork'), 'Someone/tokens_DshPluginCheck_code_fork')
  assert.equal(parseRepository(undefined), undefined)
})

test('当前清单与自身版本标签互相匹配', () => {
  assert.deepEqual(validateRelease(`v${manifest.version}`, manifest), [])
})

test('校验器拒绝标签不一致、预发布、错误仓库和错误 Registry', () => {
  assert.match(validateRelease('v9.9.9', manifest)[0], /不一致/u)
  assert.match(validateRelease('0.4.0', manifest)[0], /标签必须形如/u)
  assert.match(validateRelease('v1.0.0-rc.1', {...manifest, version: '1.0.0-rc.1'})[0], /预发布版本/u)
  assert.match(validateRelease('v0.4.0', {...manifest, repository: {url: 'https://github.com/Someone/other.git'}})[0], /仓库身份不符/u)
  assert.match(validateRelease('v0.4.0', {...manifest, publishConfig: {registry: 'https://registry.npmjs.org/'}})[0], /publishConfig\.registry/u)
})

test('检查工作流只吃分支与 PR,不发布', () => {
  const checks = read('checks.yml')
  assert.match(checks, /branches: \['\*\*'\]/u)
  assert.match(checks, /pull_request/u)
  assert.doesNotMatch(checks, /npm publish/u)
})

test('发布工作流:标签是唯一入口,并 gate 在自己跑的检查上', () => {
  const release = read('publish-npm.yml')
  assert.match(release, /tags: \['v\*'\]/u)
  // 手动入口会让同一版本被并行发布,不要加回来。
  assert.doesNotMatch(release, /workflow_dispatch/u)
  // needs: 跨不了工作流文件,所以这份检查矩阵是必需的,删了发布就失去了 gate。
  assert.match(release, /needs: check/u)
  assert.match(release, /node: \[22, 24\]/u)
  assert.match(release, /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/u)
  assert.match(release, /cancel-in-progress: false/u)
})

test('发布步骤 fail-closed:查不确定就不发,且不落到公共 npm', () => {
  const release = read('publish-npm.yml')
  assert.match(release, /\*E404\*/u)
  assert.match(release, /Cannot confirm that/u)
  assert.match(release, /VERDACCIO_PUBLISH_TOKEN/u)
  assert.match(release, /whoami/u)
  assert.doesNotMatch(release, /npm publish .*registry\.npmjs\.org/u)
})
