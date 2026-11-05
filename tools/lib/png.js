'use strict'
/**
 * tools/lib/png.js —— 极简 PNG 读写（只为截图裁剪服务）
 *
 * 为什么不用现成库：项目没有 npm 依赖，而截图流水线必须能确定性地
 * "从左上角裁出 W×H"。手写一个只支持 Chrome 截图实际输出的子集
 * （8 位、非隔行、颜色类型 2/6），比引入依赖更容易被审计。
 *
 * 不支持的情况一律抛错，不静默降级——截图尺寸错了必须立刻暴露。
 */
const zlib = require('zlib')

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let CRC_TABLE = null
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE
  CRC_TABLE = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    CRC_TABLE[n] = c
  }
  return CRC_TABLE
}
function crc32(buf) {
  const t = crcTable()
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td), 0)
  return Buffer.concat([len, td, crc])
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** 解码：返回 {width,height,channels,pixels}，pixels 为未过滤的连续像素字节 */
function decode(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('不是 PNG 文件')
  let off = 8, ihdr = null
  const idat = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') ihdr = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (!ihdr) throw new Error('PNG 缺少 IHDR')
  if (!idat.length) throw new Error('PNG 缺少 IDAT')
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4)
  const bitDepth = ihdr[8], colorType = ihdr[9], interlace = ihdr[12]
  if (bitDepth !== 8) throw new Error('仅支持 8 位 PNG，实际 ' + bitDepth)
  if (interlace !== 0) throw new Error('不支持隔行 PNG')
  if (colorType !== 2 && colorType !== 6) throw new Error('仅支持颜色类型 2/6，实际 ' + colorType)
  const channels = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  if (raw.length !== (stride + 1) * height) {
    throw new Error(`PNG 数据长度 ${raw.length} 与 ${width}x${height} 期望 ${(stride + 1) * height} 不符`)
  }
  const pixels = Buffer.alloc(stride * height)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const cur = pixels.subarray(y * stride, (y + 1) * stride)
    src.copy(cur)
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      switch (ft) {
        case 0: break
        case 1: cur[i] = (cur[i] + a) & 0xff; break
        case 2: cur[i] = (cur[i] + b) & 0xff; break
        case 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff; break
        case 4: cur[i] = (cur[i] + paeth(a, b, c)) & 0xff; break
        default: throw new Error('未知 PNG 过滤类型 ' + ft + '（第 ' + y + ' 行）')
      }
    }
    prev = cur
  }
  return { width, height, channels, pixels }
}

/** 编码：把 {width,height,channels,pixels} 写成 PNG（每行用过滤类型 0） */
function encode(img) {
  const { width, height, channels, pixels } = img
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 从左上角裁出 w×h；超出原图范围直接抛错 */
function cropTopLeft(img, w, h) {
  if (w > img.width || h > img.height) {
    throw new Error(`裁剪区域 ${w}x${h} 超出原图 ${img.width}x${img.height}`)
  }
  const ch = img.channels, srcStride = img.width * ch, dstStride = w * ch
  const pixels = Buffer.alloc(dstStride * h)
  for (let y = 0; y < h; y++) {
    img.pixels.copy(pixels, y * dstStride, y * srcStride, y * srcStride + dstStride)
  }
  return { width: w, height: h, channels: ch, pixels }
}

module.exports = { decode, encode, cropTopLeft }
