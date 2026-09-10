import { test } from 'node:test'
import assert from 'node:assert/strict'
import semver from 'semver'
import { detectHostRuntime } from '../lib/cowork-plugin.mjs'

/**
 * 宿主运行时探测:会话内 plugin_check 的基准版本必须跟着宿主走,
 * 不能靠硬编码常量 —— 宿主升级后忘了同步常量,体检结论就悄悄失真。
 */
test('优先读 @deepseek-ai/dsh(运行时本体)', () => {
  const fake = spec => {
    if (spec === '@deepseek-ai/dsh/package.json') return { version: '0.1.9-alpha.2' }
    return { version: '0.1.3-alpha.1' }
  }
  assert.equal(detectHostRuntime(fake), '0.1.9-alpha.2')
})

test('dsh 不可解析时退回 dsh-tools', () => {
  const fake = spec => {
    if (spec === '@deepseek-ai/dsh/package.json') throw new Error('not exported')
    return { version: '0.1.3-alpha.1' }
  }
  assert.equal(detectHostRuntime(fake), '0.1.3-alpha.1')
})

test('版本非法或两者都读不到时返回 undefined,交给兜底常量', () => {
  assert.equal(detectHostRuntime(() => ({ version: 'not-a-version' })), undefined)
  assert.equal(detectHostRuntime(() => { throw new Error('boom') }), undefined)
})

test('本仓库环境下默认探测返回合法版本(dsh-tools 在 devDependencies)', () => {
  const detected = detectHostRuntime()
  assert.notEqual(detected, undefined)
  assert.notEqual(semver.valid(detected), null)
})
