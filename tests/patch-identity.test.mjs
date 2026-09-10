import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkPatchContent, extractPatchRows } from '../lib/patch-rows.mjs'

const ids = (content, packageName = '@x/p') =>
  checkPatchContent(packageName, content).findings.filter(f => f.rule === 'M11-row-identity')

test('M11:同层 id 重复 —— 装上即让用户整个 Desktop 起不来', () => {
  const findings = ids(`- insert:
    - id: dup
      name: '@x/p'
    - id: dup
      name: '@x/p/other'
`)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].level, 'error')
  assert.match(findings[0].message, /duplicate loader entry id/u)
})

test('M11:id 含 ":" 破坏加载树寻址', () => {
  const findings = ids(`- insert:
    - id: 'a:b'
      name: '@x/p'
`)
  assert.equal(findings.length, 1)
  assert.match(findings[0].message, /EntryTree\.sep|层级分隔符/u)
})

test('M11:占用宿主保留 id 与保留包名', () => {
  for (const id of ['settings', 'web-runtime', 'desktop-webserver', 'community-market', 'dsh-market']) {
    const findings = ids(`- insert:
    - id: ${id}
      name: '@x/p'
`)
    assert.equal(findings.length, 1, `id=${id}`)
  }
  const byName = checkPatchContent('', `- insert:
    - id: mine
      name: dsh-community-market
`).findings.filter(f => f.rule === 'M11-row-identity')
  assert.equal(byName.length, 1)
})

test('M11:唯一性按层判,父子同名 id 不算冲突(与 assertUniqueEntryIds 同构)', () => {
  const findings = ids(`- insert:
    - id: same
      group: true
      config:
        - id: same
          name: '@x/p'
`)
  assert.deepEqual(findings, [])
})

test('M11:group 内部的重复照样查得到', () => {
  const findings = ids(`- insert:
    - id: outer
      group: true
      config:
        - id: inner
          name: '@x/p'
        - id: inner
          name: '@x/p/two'
`)
  assert.equal(findings.length, 1)
})

test('M11:合法补丁零发现', () => {
  const findings = ids(`- insert:
    - id: x-p-main
      name: '@x/p'
    - id: x-p-side
      name: '@x/p/side'
`)
  assert.deepEqual(findings, [])
})

test('宿主自己的 !!js 惯用法必须解析得出行(0.3.4 判成"补丁不是合法 YAML")', () => {
  // 逐条照抄宿主自带 bundle 补丁里的真实写法:
  //   root: !!js dshHomePath('sessions')      (dsh-base:113)
  //   disabled: !!js process.platform === 'win32'  (dsh-base:222)
  //   policy: !!js "…三元表达式…"             (dsh-base:233)
  const result = extractPatchRows(`- insert:
    - id: session
      name: '@deepseek-ai/cordis-plugin-session'
      config:
        root: !!js dshHomePath('sessions')
    - id: shell-win
      name: '@deepseek-ai/cordis-plugin-shell'
      disabled: !!js process.platform !== 'win32'
      config:
        policy: !!js "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"
        mode: !!js process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'
`)
  assert.deepEqual(result.problems, [])
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[0].dynamicConfig, true)
  assert.equal(result.rows[1].dynamicConfig, true)
})

test('!!js/function 与单叹号标签同样宽容', () => {
  for (const tag of ['!!js/function', '!env', '!!js']) {
    const result = extractPatchRows(`- insert:
    - id: dyn
      name: '@x/p'
      config:
        value: ${tag} "whatever"
`)
    assert.deepEqual(result.problems, [], `tag=${tag}`)
    assert.equal(result.rows.length, 1, `tag=${tag}`)
    assert.equal(result.rows[0].dynamicConfig, true, `tag=${tag}`)
  }
})

test('YAML 锚点自引用不会把体检工具自己搞成栈溢出', () => {
  const result = extractPatchRows(`- insert:
    - id: loop
      name: '@x/p'
      config: &cycle
        self: *cycle
`)
  assert.deepEqual(result.problems, [])
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].dynamicConfig, false)
})
