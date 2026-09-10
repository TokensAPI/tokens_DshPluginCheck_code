import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkClientDeclaration } from '../lib/client-check.mjs'

const levels = (findings, level) => findings.filter(f => f.level === level).map(f => f.message)

const OK = {
  name: '@x/p',
  exports: { './client': './dist/client.js' },
  dsh: { client: { platform: 'web', inject: ['react'], external: ['@x/other'], immediately: true } },
}

test('没有 dsh.client 的插件(绝大多数)完全不产生噪音', () => {
  assert.deepEqual(checkClientDeclaration({ name: '@x/p' }), [])
})

test('完整合法的声明零发现;exports 对象形态同样接受', () => {
  assert.deepEqual(checkClientDeclaration(OK), [])
  assert.deepEqual(checkClientDeclaration({
    ...OK,
    exports: { './client': { default: './dist/client.js' } },
  }), [])
})

test('dsh.client 不是对象直接判 error(宿主构造期同步抛)', () => {
  assert.equal(levels(checkClientDeclaration({ ...OK, dsh: { client: 'web' } }), 'error').length, 1)
  assert.equal(levels(checkClientDeclaration({ ...OK, dsh: { client: [] } }), 'error').length, 1)
})

test('platform 缺失是 error,非 web 是 warning(声明不会生效)', () => {
  const missing = checkClientDeclaration({ ...OK, dsh: { client: { inject: [] } } })
  assert.equal(levels(missing, 'error').length, 1)
  const desktop = checkClientDeclaration({ ...OK, dsh: { client: { platform: 'desktop' } } })
  assert.deepEqual(levels(desktop, 'error'), [])
  assert.equal(levels(desktop, 'warning').length, 1)
})

test('inject/external 必须是字符串数组', () => {
  for (const field of ['inject', 'external']) {
    const findings = checkClientDeclaration({ ...OK, dsh: { client: { platform: 'web', [field]: 'react' } } })
    assert.equal(levels(findings, 'error').length, 1, field)
    const mixed = checkClientDeclaration({ ...OK, dsh: { client: { platform: 'web', [field]: ['ok', 1] } } })
    assert.equal(levels(mixed, 'error').length, 1, `${field} mixed`)
  }
})

test('external 必须是精确裸包根,且不能是本包自己', () => {
  const bad = checkClientDeclaration({
    ...OK,
    dsh: { client: { platform: 'web', external: ['@x/deep/sub', 'plain/sub', '@onlyscope'] } },
  })
  assert.equal(levels(bad, 'error').length, 3)
  const self = checkClientDeclaration({ ...OK, dsh: { client: { platform: 'web', external: ['@x/p'] } } })
  assert.equal(levels(self, 'error').length, 1)
  assert.match(levels(self, 'error')[0], /自己/u)
})

test('immediately 必须是布尔值', () => {
  const findings = checkClientDeclaration({ ...OK, dsh: { client: { platform: 'web', immediately: 'yes' } } })
  assert.equal(levels(findings, 'error').length, 1)
})

test('声明了 dsh.client 却没有可用的 exports["./client"]', () => {
  const missing = checkClientDeclaration({ name: '@x/p', dsh: { client: { platform: 'web' } } })
  assert.equal(levels(missing, 'error').length, 1)
  const empty = checkClientDeclaration({ ...OK, exports: { '.': './dist/index.js' } })
  assert.equal(levels(empty, 'error').length, 1)
  const malformed = checkClientDeclaration({ ...OK, exports: { './client': { types: './c.d.ts' } } })
  assert.equal(levels(malformed, 'error').length, 1)
})
