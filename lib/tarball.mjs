/* ============================================================
 * npm tarball 单文件读取(零依赖)
 * ============================================================
 * registry 的版本清单里没有包内文件内容,而 M4/M5 这类规则必须
 * 读到 cordis.patch.yml 本身 —— 曾有插件把补丁行的 name 写成
 * cordis 插件名而非包名,清单看不出任何异常,装上却让整棵插件树
 * 加载失败。会话内体检没有 npm 子进程可用,因此这里直接取
 * dist.tarball,用 node:zlib 解 gzip 后自行走 tar 头,只取需要的
 * 那一个文件。
 * ============================================================ */
import { gunzipSync } from 'node:zlib'

const BLOCK = 512
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20_000

const readString = (buffer, offset, length) => {
  const slice = buffer.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

/** tar 头里的数值字段是补零的八进制字符串;空字段按 0 处理。 */
const readOctal = (buffer, offset, length) => {
  const raw = readString(buffer, offset, length).trim()
  if (raw === '') return 0
  const value = Number.parseInt(raw, 8)
  return Number.isFinite(value) ? value : 0
}

/**
 * 遍历 tar,返回首个匹配的条目内容。
 * 处理 ustar 的 prefix 拼接与 pax(typeflag 'x')的路径覆盖,
 * 因此长路径与非 ASCII 路径同样可取。
 * @param {Buffer} tar - 解压后的 tar 字节。
 * @param {(path: string) => boolean} match - 路径判定(已剥掉顶层 package/)。
 * @returns {string | undefined}
 */
export function readTarEntry(tar, match) {
  let offset = 0
  let paxPath
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every(byte => byte === 0)) break
    const name = readString(header, 0, 100)
    const size = readOctal(header, 124, 12)
    const typeflag = readString(header, 156, 1)
    const prefix = readString(header, 345, 155)
    const dataOffset = offset + BLOCK
    const padded = Math.ceil(size / BLOCK) * BLOCK
    if (typeflag === 'x' || typeflag === 'X') {
      // pax 扩展头:形如 "<len> path=<value>\n",覆盖紧随其后的条目路径。
      const record = tar.subarray(dataOffset, dataOffset + size).toString('utf8')
      const found = /(?:^|\n)\d+ path=([^\n]*)\n/u.exec(record)
      paxPath = found === null ? undefined : found[1]
      offset = dataOffset + padded
      continue
    }
    const full = paxPath ?? (prefix === '' ? name : `${prefix}/${name}`)
    paxPath = undefined
    if (typeflag === '' || typeflag === '0') {
      // npm 打包约定顶层统一为 package/。
      const relative = full.replace(/^[^/]+\//u, '')
      if (match(relative)) return tar.subarray(dataOffset, dataOffset + size).toString('utf8')
    }
    offset = dataOffset + padded
  }
  return undefined
}

/**
 * 下载并解出 tarball 中的一个文件。
 * 任何取不到的情形都以 { error } 返回,由调用方降级成提示而不是判定
 * 插件不合格 —— 网络问题不是插件的过错。
 * @param {string} url - registry 的 dist.tarball。
 * @param {(path: string) => boolean} match
 * @param {{ maxBytes?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ content?: string } | { error: string }>}
 */
export async function fetchTarEntry(url, match, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return { error: `下载 tarball 失败(HTTP ${response.status})` }
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > maxBytes) return { error: `tarball 超过 ${Math.round(maxBytes / 1024 / 1024)}MB,跳过包内检查` }
    const raw = Buffer.from(await response.arrayBuffer())
    if (raw.length > maxBytes) return { error: `tarball 超过 ${Math.round(maxBytes / 1024 / 1024)}MB,跳过包内检查` }
    return { content: readTarEntry(gunzipSync(raw), match) }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    return { error: cause?.name === 'AbortError' ? '下载 tarball 超时' : `读取 tarball 失败: ${reason}` }
  } finally {
    clearTimeout(timer)
  }
}
