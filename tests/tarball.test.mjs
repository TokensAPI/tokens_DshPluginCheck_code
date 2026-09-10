import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readTarEntry } from '../lib/tarball.mjs'

const BLOCK = 512

/** 造一个 tar 条目:name 最长 100 字节走 name 字段,更长走 prefix。 */
function entry(path, body, typeflag = '0', prefix = '') {
  const header = Buffer.alloc(BLOCK)
  header.write(path, 0, 100, 'utf8')
  header.write('000644 \0', 100, 8, 'utf8')
  header.write(`${body.length.toString(8).padStart(11, '0')} `, 124, 12, 'utf8')
  header.write(typeflag, 156, 1, 'utf8')
  header.write('ustar\0', 257, 6, 'utf8')
  header.write(prefix, 345, 155, 'utf8')
  const data = Buffer.alloc(Math.ceil(body.length / BLOCK) * BLOCK)
  Buffer.from(body, 'utf8').copy(data)
  return Buffer.concat([header, data])
}

const trailer = Buffer.alloc(BLOCK * 2)

test('读出普通条目并剥掉顶层 package/ 目录', () => {
  const tar = Buffer.concat([
    entry('package/package.json', '{"name":"x"}'),
    entry('package/cordis.patch.yml', '- insert:\n    - id: a\n      name: "@scope/x"\n'),
    trailer,
  ])
  assert.equal(readTarEntry(tar, p => p === 'cordis.patch.yml'), '- insert:\n    - id: a\n      name: "@scope/x"\n')
  assert.equal(readTarEntry(tar, p => p === 'nope.yml'), undefined)
})

test('目录条目不参与匹配', () => {
  const tar = Buffer.concat([entry('package/lib/', '', '5'), entry('package/lib/a.mjs', 'export const a = 1\n'), trailer])
  assert.equal(readTarEntry(tar, p => p === 'lib/'), undefined)
  assert.equal(readTarEntry(tar, p => p === 'lib/a.mjs'), 'export const a = 1\n')
})

test('ustar prefix 拼回长路径', () => {
  const tar = Buffer.concat([entry('cordis.patch.yml', 'ok\n', '0', 'package/deep/dir'), trailer])
  assert.equal(readTarEntry(tar, p => p === 'deep/dir/cordis.patch.yml'), 'ok\n')
})

test('pax 扩展头覆盖后续条目路径', () => {
  const record = '33 path=package/cordis.patch.yml\n'
  assert.equal(record.length, 33)
  const tar = Buffer.concat([
    entry('package/@LongLink', record, 'x'),
    entry('package/short', 'patched\n'),
    trailer,
  ])
  assert.equal(readTarEntry(tar, p => p === 'cordis.patch.yml'), 'patched\n')
})

test('全零块即结束,不越界', () => {
  assert.equal(readTarEntry(trailer, () => true), undefined)
  assert.equal(readTarEntry(Buffer.alloc(0), () => true), undefined)
})
