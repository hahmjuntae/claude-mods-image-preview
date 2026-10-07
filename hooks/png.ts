export type Rgba = { width: number; height: number; data: Uint8Array }

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const MAX_PIXELS = 16_000_000

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
]

type Huffman = { table: Int32Array; bits: number }

type Header = {
  width: number
  height: number
  depth: number
  colorType: number
  interlace: number
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b)
}

export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (!isPng(bytes) || bytes.length < 24) throw new Error('not a PNG')

  return { width: u32(bytes, 16), height: u32(bytes, 20) }
}

export function decodePng(bytes: Uint8Array): Rgba {
  if (!isPng(bytes)) throw new Error('not a PNG')

  let header: Header | undefined
  let palette: Uint8Array | undefined
  let transparency: Uint8Array | undefined
  const idat: Uint8Array[] = []
  let pos = 8

  while (pos + 8 <= bytes.length) {
    const length = u32(bytes, pos)
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
    const body = bytes.subarray(pos + 8, pos + 8 + length)
    pos += 12 + length

    if (type === 'IHDR') {
      header = {
        width: u32(body, 0),
        height: u32(body, 4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12],
      }
    } else if (type === 'PLTE') {
      palette = body
    } else if (type === 'tRNS') {
      transparency = body
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
  }

  if (!header) throw new Error('PNG without IHDR')

  const { width, height, depth, colorType, interlace } = header
  const channels = CHANNELS[colorType]

  if (!channels) throw new Error(`PNG color type ${colorType}`)
  if (width === 0 || height === 0 || width * height > MAX_PIXELS) throw new Error('PNG too large')
  if (colorType === 3 && !palette) throw new Error('PNG without PLTE')

  const bitsPerPixel = channels * depth
  const stride = Math.max(1, bitsPerPixel >> 3)
  const passes = interlace === 1 ? ADAM7 : [[0, 0, 1, 1]]
  const sizes = passes.map(([x0, y0, dx, dy]) => [passLength(width, x0, dx), passLength(height, y0, dy)])
  const rawLength = sizes.reduce((sum, [w, h]) => sum + (w && h ? h * (1 + Math.ceil((w * bitsPerPixel) / 8)) : 0), 0)
  const raw = inflate(concat(idat).subarray(2), rawLength)
  const out = new Uint8Array(width * height * 4)
  const sample = makeSampler(colorType, depth, palette, transparency)
  let offset = 0

  passes.forEach(([x0, y0, dx, dy], index) => {
    const [pw, ph] = sizes[index]

    if (!pw || !ph) return

    const rowBytes = Math.ceil((pw * bitsPerPixel) / 8)
    let previous: Uint8Array = new Uint8Array(rowBytes)

    for (let y = 0; y < ph; y++) {
      const filter = raw[offset]
      const row = raw.subarray(offset + 1, offset + 1 + rowBytes)
      offset += 1 + rowBytes
      unfilter(filter, row, previous, stride)

      for (let x = 0; x < pw; x++) {
        sample(row, x, out, ((y0 + y * dy) * width + x0 + x * dx) * 4)
      }

      previous = row
    }
  })

  return { width, height, data: out }
}

function passLength(size: number, start: number, step: number): number {
  return size > start ? Math.ceil((size - start) / step) : 0
}

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0

  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }

  return out
}

function unfilter(filter: number, row: Uint8Array, previous: Uint8Array, stride: number): void {
  const length = row.length

  if (filter === 1) {
    for (let i = stride; i < length; i++) row[i] = (row[i] + row[i - stride]) & 255
  } else if (filter === 2) {
    for (let i = 0; i < length; i++) row[i] = (row[i] + previous[i]) & 255
  } else if (filter === 3) {
    for (let i = 0; i < length; i++) {
      const left = i >= stride ? row[i - stride] : 0
      row[i] = (row[i] + ((left + previous[i]) >> 1)) & 255
    }
  } else if (filter === 4) {
    for (let i = 0; i < length; i++) {
      const a = i >= stride ? row[i - stride] : 0
      const b = previous[i]
      const c = i >= stride ? previous[i - stride] : 0
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
    }
  } else if (filter !== 0) {
    throw new Error(`PNG filter ${filter}`)
  }
}

type Sampler = (row: Uint8Array, x: number, out: Uint8Array, at: number) => void

function makeSampler(colorType: number, depth: number, palette?: Uint8Array, transparency?: Uint8Array): Sampler {
  const max = (1 << depth) - 1
  const read = depth === 16
    ? (row: Uint8Array, i: number) => (row[i * 2] << 8) | row[i * 2 + 1]
    : depth === 8
      ? (row: Uint8Array, i: number) => row[i]
      : (row: Uint8Array, i: number) => (row[(i * depth) >> 3] >> (8 - depth - ((i * depth) & 7))) & max
  const scale = (v: number) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / max))
  const keyGray = transparency && transparency.length >= 2 ? (transparency[0] << 8) | transparency[1] : -1
  const keyRgb = transparency && transparency.length >= 6
    ? [(transparency[0] << 8) | transparency[1], (transparency[2] << 8) | transparency[3], (transparency[4] << 8) | transparency[5]]
    : undefined

  if (colorType === 0) {
    return (row, x, out, at) => {
      const v = read(row, x)
      out[at] = out[at + 1] = out[at + 2] = scale(v)
      out[at + 3] = v === keyGray ? 0 : 255
    }
  }

  if (colorType === 2) {
    return (row, x, out, at) => {
      const r = read(row, x * 3)
      const g = read(row, x * 3 + 1)
      const b = read(row, x * 3 + 2)
      out[at] = scale(r)
      out[at + 1] = scale(g)
      out[at + 2] = scale(b)
      out[at + 3] = keyRgb && r === keyRgb[0] && g === keyRgb[1] && b === keyRgb[2] ? 0 : 255
    }
  }

  if (colorType === 3) {
    const colors = palette as Uint8Array

    return (row, x, out, at) => {
      const index = read(row, x)
      out[at] = colors[index * 3] ?? 0
      out[at + 1] = colors[index * 3 + 1] ?? 0
      out[at + 2] = colors[index * 3 + 2] ?? 0
      out[at + 3] = transparency && index < transparency.length ? transparency[index] : 255
    }
  }

  if (colorType === 4) {
    return (row, x, out, at) => {
      out[at] = out[at + 1] = out[at + 2] = scale(read(row, x * 2))
      out[at + 3] = scale(read(row, x * 2 + 1))
    }
  }

  return (row, x, out, at) => {
    out[at] = scale(read(row, x * 4))
    out[at + 1] = scale(read(row, x * 4 + 1))
    out[at + 2] = scale(read(row, x * 4 + 2))
    out[at + 3] = scale(read(row, x * 4 + 3))
  }
}

export function inflate(data: Uint8Array, expected: number): Uint8Array {
  let out = new Uint8Array(Math.max(expected, 1024))
  let length = 0
  let pos = 0
  let bitBuffer = 0
  let bitCount = 0

  const need = (n: number) => {
    while (bitCount < n) {
      bitBuffer |= (pos < data.length ? data[pos] : 0) << bitCount
      pos++
      bitCount += 8
    }
  }
  const bits = (n: number) => {
    need(n)
    const value = bitBuffer & ((1 << n) - 1)
    bitBuffer >>>= n
    bitCount -= n

    return value
  }
  const symbol = (code: Huffman) => {
    need(code.bits)
    const entry = code.table[bitBuffer & ((1 << code.bits) - 1)]

    if (entry < 0) throw new Error('bad Huffman code')

    bitBuffer >>>= entry & 15
    bitCount -= entry & 15

    return entry >> 4
  }
  const reserve = (n: number) => {
    if (length + n <= out.length) return

    const grown = new Uint8Array(Math.max(out.length * 2, length + n))
    grown.set(out.subarray(0, length))
    out = grown
  }

  let isLast = false

  while (!isLast) {
    if (pos > data.length + 4) throw new Error('truncated deflate stream')

    isLast = bits(1) === 1
    const type = bits(2)

    if (type === 0) {
      pos -= bitCount >> 3
      bitBuffer = 0
      bitCount = 0
      const size = data[pos] | (data[pos + 1] << 8)
      pos += 4
      reserve(size)
      out.set(data.subarray(pos, pos + size), length)
      length += size
      pos += size
      continue
    }

    if (type === 3) throw new Error('bad deflate block')

    const [literals, distances] = type === 1 ? fixedTables() : readDynamicTables(bits, symbol)

    for (;;) {
      const value = symbol(literals)

      if (value < 256) {
        reserve(1)
        out[length++] = value
        continue
      }

      if (value === 256) break

      const lengthIndex = value - 257
      const size = LEN_BASE[lengthIndex] + bits(LEN_EXTRA[lengthIndex])
      const distanceIndex = symbol(distances)
      const distance = DIST_BASE[distanceIndex] + bits(DIST_EXTRA[distanceIndex])

      if (distance > length) throw new Error('bad deflate distance')

      reserve(size)

      for (let i = 0; i < size; i++) {
        out[length] = out[length - distance]
        length++
      }
    }
  }

  return out.subarray(0, length)
}

let fixed: [Huffman, Huffman] | undefined

function fixedTables(): [Huffman, Huffman] {
  if (fixed) return fixed

  const literal = new Uint8Array(288)
  literal.fill(8, 0, 144)
  literal.fill(9, 144, 256)
  literal.fill(7, 256, 280)
  literal.fill(8, 280, 288)
  fixed = [buildHuffman(literal), buildHuffman(new Uint8Array(30).fill(5))]

  return fixed
}

function readDynamicTables(bits: (n: number) => number, symbol: (code: Huffman) => number): [Huffman, Huffman] {
  const literalCount = bits(5) + 257
  const distanceCount = bits(5) + 1
  const codeLengthCount = bits(4) + 4
  const codeLengths = new Uint8Array(19)

  for (let i = 0; i < codeLengthCount; i++) codeLengths[CODE_LENGTH_ORDER[i]] = bits(3)

  const codeLengthTable = buildHuffman(codeLengths)
  const lengths = new Uint8Array(literalCount + distanceCount)
  let i = 0

  while (i < lengths.length) {
    const value = symbol(codeLengthTable)

    if (value < 16) {
      lengths[i++] = value
    } else if (value === 16) {
      if (i === 0) throw new Error('bad code length repeat')

      const repeat = 3 + bits(2)
      lengths.fill(lengths[i - 1], i, i + repeat)
      i += repeat
    } else {
      const repeat = value === 17 ? 3 + bits(3) : 11 + bits(7)
      i += repeat
    }
  }

  return [buildHuffman(lengths.subarray(0, literalCount)), buildHuffman(lengths.subarray(literalCount))]
}

function buildHuffman(lengths: Uint8Array): Huffman {
  let maxBits = 1

  for (const length of lengths) if (length > maxBits) maxBits = length

  const counts = new Int32Array(16)

  for (const length of lengths) counts[length]++

  counts[0] = 0
  const nextCode = new Int32Array(16)
  let code = 0

  for (let size = 1; size < 16; size++) {
    code = (code + counts[size - 1]) << 1
    nextCode[size] = code
  }

  const table = new Int32Array(1 << maxBits).fill(-1)

  lengths.forEach((size, value) => {
    if (!size) return

    const assigned = nextCode[size]++
    let reversed = 0

    for (let k = 0; k < size; k++) reversed = (reversed << 1) | ((assigned >> k) & 1)
    for (let at = reversed; at < table.length; at += 1 << size) table[at] = (value << 4) | size
  })

  return { table, bits: maxBits }
}
