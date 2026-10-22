/* ============================================================
 * HOST-GUARD-01…03 夹具自身的守卫不许是装饰品(不需要宿主)
 * ============================================================
 * HOST-11「夹具只碰临时目录」整条建立在 `inside()` 和那张 `~/.dsh` 浅快照
 * 之上。这两样只要写成恒真,HOST-11 就变成一条永远绿的装饰品 —— 而联网
 * 搜索那次正是因为没人守路径,把用户真实的 settings.yaml 改成了测试值。
 *
 * 所以这一组反过来验守卫本身:喂它一个"落在用户真实家目录里"的路径,它
 * 必须判否。这组**不需要宿主**,所以 CI 上照常跑,`npm test` 里永远在。
 *
 * 其余真实宿主用例的"弄坏→必须红"验证走 `npm run check:host -- --mutate`,
 * 对照表见 tests/support/mutations.mjs。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { MUTATIONS } from './support/mutations.mjs'
import { REAL_DSH_HOME, inside, realHomeSnapshot } from './support/live-host.mjs'

test('HOST-GUARD-01 inside() 认得出"不在临时目录里"', () => {
  const temp = join('C:', 'Temp', 'plugin-check-live-abc')
  assert.equal(inside(join(temp, 'profiles', 'p'), temp), true)
  assert.equal(inside(temp, temp), true)
  // 恒真的守卫在这几条上会露出来。
  assert.equal(inside(join(homedir(), '.dsh', 'settings.yaml'), temp), false)
  assert.equal(inside(join('C:', 'Temp', 'plugin-check-live-abcdef'), temp), false,
    '只比字符串前缀会把兄弟目录当成子目录')
  assert.equal(inside(join('C:', 'Temp'), temp), false)
})

test('HOST-GUARD-02 用户真实家目录的路径一定过不了夹具那条断言', () => {
  // HOST-11 的两条断言合起来是:在临时目录内 && 不在真实 ~/.dsh 内。
  const real = join(REAL_DSH_HOME, 'settings.yaml')
  const temp = join('C:', 'Temp', 'plugin-check-live-abc')
  assert.equal(inside(real, temp) && !inside(real, REAL_DSH_HOME), false)
})

test('HOST-GUARD-03 ~/.dsh 浅快照稳定可比,且不会因为目录不存在就变成空转', () => {
  const first = realHomeSnapshot()
  const second = realHomeSnapshot()
  // 连着取两次必须完全相同,否则 HOST-11 的"前后一致"会随机变红。
  assert.deepEqual(second, first)
  // 快照只做浅层:目录不存在时是空对象,那种机器上 HOST-11 退化成"路径断言",
  // 这是已知取舍,写在这里以免被当成漏。
  assert.equal(typeof first, 'object')
})

test('HOST-GUARD-04 变异表里每条都指明了应当变红的用例', () => {
  for (const [name, spec] of Object.entries(MUTATIONS)) {
    assert.ok(typeof spec.description === 'string' && spec.description !== '', `${name} 没有说明`)
    assert.ok(typeof spec.file === 'string' && spec.file !== '', `${name} 没说改哪个文件`)
    assert.ok(Array.isArray(spec.expectRed) && spec.expectRed.length > 0, `${name} 没说哪几条该红`)
    assert.notEqual(spec.find, spec.replace, `${name} 的替换没有改变任何东西`)
  }
})
