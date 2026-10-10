import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
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
  assert.match(validateRelease(manifest.version, manifest)[0], /标签必须形如/u)
  assert.match(validateRelease('v1.0.0-rc.1', {...manifest, version: '1.0.0-rc.1'})[0], /预发布版本/u)
  assert.match(validateRelease(`v${manifest.version}`, {...manifest, repository: {url: 'https://github.com/Someone/other.git'}})[0], /仓库身份不符/u)
  assert.match(validateRelease(`v${manifest.version}`, {...manifest, publishConfig: {registry: 'https://registry.npmjs.org/'}})[0], /publishConfig\.registry/u)
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

test('发布后自动检查准确版本，补查与自动调用共用实现', () => {
  const release = yaml.load(read('publish-npm.yml'))
  const check = yaml.load(read('check-plugin-package.yml'))
  const caller = release.jobs['package-check']
  assert.equal(caller.needs, 'publish')
  assert.equal(caller.uses, './.github/workflows/check-plugin-package.yml')
  assert.equal(caller.with.package, '${{ needs.publish.outputs.package }}')
  assert.equal(caller.with.checker_ref, '${{ github.sha }}')
  assert.equal(caller.secrets.PLUGIN_CHECK_REGISTRY_TOKEN, '${{ secrets.PLUGIN_CHECK_REGISTRY_TOKEN }}')
  assert.equal(check.on.workflow_call.inputs.package.required, true)
  assert.equal(check.on.workflow_call.inputs.checker_ref.required, true)
  assert.equal(check.on.workflow_dispatch.inputs.runtime.required, true)
  assert.equal(check.on.workflow_call.inputs.runtime.default, '')
  assert.equal(check.on.workflow_call.secrets.PLUGIN_CHECK_REGISTRY_TOKEN.required, true)
  assert.doesNotMatch(read('check-plugin-package.yml'), /VERDACCIO_PUBLISH_TOKEN/u)
  const checkout = check.jobs.check.steps.find(step => step.uses?.startsWith('actions/checkout@'))
  assert.equal(checkout.with.repository, EXPECTED_REPOSITORY)
  assert.equal(checkout.with.ref, '${{ steps.source.outputs.commit }}')
  assert.notEqual(check.concurrency.group, release.concurrency.group, '子流程不能与发布父流程争同一个锁')
})

test('发布前确认只读账号，检查失败不会再次发布或覆盖版本', () => {
  const release = yaml.load(read('publish-npm.yml'))
  const steps = release.jobs.publish.steps
  const preflight = steps.findIndex(step => step.env?.NODE_AUTH_TOKEN === '${{ secrets.PLUGIN_CHECK_REGISTRY_TOKEN }}')
  const publish = steps.findIndex(step => step.run?.includes('npm publish'))
  assert.ok(preflight >= 0 && preflight < publish)
  assert.match(steps[preflight].run, /NODE_AUTH_TOKEN:-/u)
  assert.match(steps[preflight].run, /npm whoami/u)
  assert.match(steps[preflight].run, /== market/u)
  const output = steps.find(step => step.id === 'package')
  assert.ok(steps.indexOf(output) > publish)
  assert.match(output.run, /name \+ "@" \+ require\("\.\/package.json"\)\.version/u)
  const check = yaml.load(read('check-plugin-package.yml'))
  assert.doesNotMatch(read('check-plugin-package.yml'), /npm publish|npm unpublish/u)
  const status = check.jobs.check.steps.find(step => step.env?.CHECK_STATUS)
  assert.match(status.run, /exit "\$CHECK_STATUS"/u)
})

test('包检查记录实际产品和检查器提交，拒绝错版本报告并保留跳过原因', () => {
  const check = yaml.load(read('check-plugin-package.yml'))
  const runtime = check.jobs.check.steps.find(step => step.name.endsWith('解析目标产品运行时'))
  assert.match(runtime.run, /product.json\?ref=\$product_commit/u)
  assert.match(runtime.run, /desktop\.runtimeVersion/u)
  const report = check.jobs.check.steps.find(step => step.name.endsWith('展示实际检查结果'))
  assert.equal(report.env.CHECKER_COMMIT, '${{ steps.source.outputs.commit }}')
  assert.match(report.run, /report\.plugin.*report\.version/u)
  assert.match(report.run, /report\.runtime !== process\.env\.TARGET_RUNTIME/u)
  assert.match(report.run, /phase\.skipped/u)
  assert.match(report.run, /report\.ok !== true/u)
})
