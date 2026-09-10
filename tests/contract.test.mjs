import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTRACT, contractLine, checkContractBaseline, LIFECYCLE_SCRIPTS, lifecycleMessage } from '../lib/contract.mjs'

test('基线声明齐备:核对日期、上游版本、已核对运行时', () => {
  assert.match(CONTRACT.verifiedAt, /^\d{4}-\d{2}-\d{2}$/u)
  for (const key of ['dsh-plugin-desktop', 'dsh-community-market', '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools']) {
    assert.equal(typeof CONTRACT.upstream[key], 'string', `缺少上游版本: ${key}`)
  }
  assert.ok(CONTRACT.runtimes.length > 0)
  assert.match(contractLine(), /契约基线/u)
})

test('核对过的运行时不提示,没核对过的给 C0 warning', () => {
  for (const runtime of CONTRACT.runtimes) assert.deepEqual(checkContractBaseline(runtime), [])
  assert.deepEqual(checkContractBaseline(undefined), [])
  const findings = checkContractBaseline('9.9.9')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].rule, 'C0-contract')
  assert.equal(findings[0].level, 'warning')
})

test('生命周期措辞按脚本分开:prepare 说两条安装路径不一致', () => {
  assert.deepEqual(LIFECYCLE_SCRIPTS, ['preinstall', 'install', 'postinstall', 'prepare'])
  assert.match(lifecycleMessage('prepare'), /github:/u)
  assert.match(lifecycleMessage('postinstall'), /prepack/u)
})
