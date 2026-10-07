import { toBase64 } from './base64'
import type { Rgba } from './png'

export type Fit = { columns: number; rows: number; pxWidth: number; pxHeight: number }

const DEFAULT_COLOR = 0x01000000
const OPAQUE = 128
// 사분면 마스크별 전경 글리프, 비트는 왼위 1 오른위 2 왼아래 4 오른아래 8
const QUADRANT = [
  0x20, 0x2598, 0x259d, 0x2580, 0x2596, 0x258c, 0x259e, 0x259b,
  0x2597, 0x259a, 0x2590, 0x259c, 0x2584, 0x2599, 0x259f, 0x2588,
]
// 동률이면 앞선 분할을 고르므로 반블록 ▀ 우선
const SPLITS = [0b0011, 0b0101, 0b1001, 0b0001, 0b0010, 0b0100, 0b1000]

export function fitBox(width: number, height: number, maxColumns: number, maxRows: number): Fit {
  const scale = Math.min(maxColumns / width, (maxRows * 2) / height)
  const pxWidth = Math.max(1, Math.min(maxColumns, Math.round(width * scale)))
  const pxHeight = Math.max(1, Math.min(maxRows * 2, Math.round(height * scale)))

  return { columns: pxWidth, rows: Math.ceil(pxHeight / 2), pxWidth, pxHeight }
}

export function downsample(image: Rgba, width: number, height: number): Rgba {
  const { width: sourceWidth, height: sourceHeight, data } = image
  const out = new Uint8Array(width * height * 4)

  for (let ty = 0; ty < height; ty++) {
    const y0 = Math.floor((ty * sourceHeight) / height)
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * sourceHeight) / height))

    for (let tx = 0; tx < width; tx++) {
      const x0 = Math.floor((tx * sourceWidth) / width)
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * sourceWidth) / width))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * sourceWidth + x) * 4
          const alpha = data[i + 3]
          r += data[i] * alpha
          g += data[i + 1] * alpha
          b += data[i + 2] * alpha
          a += alpha
          count++
        }
      }

      const o = (ty * width + tx) * 4

      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }

      out[o + 3] = Math.round(a / count)
    }
  }

  return { width, height, data: out }
}

// 셀마다 2x2 픽셀을 오차 제곱합이 가장 작은 두 색 분할로 근사해 반블록보다 가로 해상도 2배
export function quadrantCells(image: Rgba): string {
  const { width, height, data } = image
  const columns = Math.ceil(width / 2)
  const rows = Math.ceil(height / 2)
  const words = new Uint32Array(columns * rows * 3)
  const quad: (number | undefined)[] = [0, 0, 0, 0]

  const pixel = (x: number, y: number) => {
    if (x >= width || y >= height) return undefined

    const i = (y * width + x) * 4

    return data[i + 3] < OPAQUE ? undefined : i
  }

  const mean = (mask: number) => {
    let r = 0
    let g = 0
    let b = 0
    let count = 0

    for (let bit = 0; bit < 4; bit++) {
      const i = quad[bit]

      if (!(mask & (1 << bit)) || i === undefined) continue

      r += data[i]
      g += data[i + 1]
      b += data[i + 2]
      count++
    }

    return [r / count, g / count, b / count]
  }

  const pack = ([r, g, b]: number[]) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)

  const error = (mask: number, fg: number[], bg: number[]) => {
    let sum = 0

    for (let bit = 0; bit < 4; bit++) {
      const i = quad[bit] as number
      const c = mask & (1 << bit) ? fg : bg
      sum += (data[i] - c[0]) ** 2 + (data[i + 1] - c[1]) ** 2 + (data[i + 2] - c[2]) ** 2
    }

    return sum
  }

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      quad[0] = pixel(cx * 2, cy * 2)
      quad[1] = pixel(cx * 2 + 1, cy * 2)
      quad[2] = pixel(cx * 2, cy * 2 + 1)
      quad[3] = pixel(cx * 2 + 1, cy * 2 + 1)

      const opaque = quad.reduce<number>((mask, i, bit) => (i === undefined ? mask : mask | (1 << bit)), 0)
      const w = (cy * columns + cx) * 3

      if (opaque === 0) {
        words[w] = QUADRANT[0]
        words[w + 1] = DEFAULT_COLOR
        words[w + 2] = DEFAULT_COLOR
        continue
      }

      // 투명 픽셀은 터미널 배경에 맡기므로 불투명 픽셀만 전경 한 색
      if (opaque !== 0b1111) {
        words[w] = QUADRANT[opaque]
        words[w + 1] = pack(mean(opaque))
        words[w + 2] = DEFAULT_COLOR
        continue
      }

      let best = { mask: 0, fg: [0, 0, 0], bg: [0, 0, 0], error: Infinity }

      for (const mask of SPLITS) {
        const fg = mean(mask)
        const bg = mean(~mask & 0b1111)
        const sum = error(mask, fg, bg)

        if (sum < best.error) best = { mask, fg, bg, error: sum }
      }

      words[w] = QUADRANT[best.mask]
      words[w + 1] = pack(best.fg)
      words[w + 2] = pack(best.bg)
    }
  }

  return toBase64(new Uint8Array(words.buffer))
}

const MARK_FIRST = 0x2800
const MARK_MAGIC = 0xa
const MARK_STEP = 17
const MARK_MAX_ROWS = 16

export function markId(path: string): number {
  let hash = 0x811c9dc5

  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193) >>> 0

  return hash & 0xfffff
}

export function markHex(id: number): string {
  return id.toString(16).padStart(5, '0')
}

export function markCells(id: number, columns: number, rows: number): string {
  if (rows > MARK_MAX_ROWS) throw new Error(`marker rows over ${MARK_MAX_ROWS}`)

  const n = [MARK_MAGIC, (id >> 16) & 15, (id >> 12) & 15, (id >> 8) & 15, (id >> 4) & 15, id & 15].map(v => v * MARK_STEP)
  const fg = (n[0] << 16) | (n[1] << 8) | n[2]
  const bg = (n[3] << 16) | (n[4] << 8) | n[5]
  const words = new Uint32Array(columns * rows * 3)

  for (let row = 0; row < rows; row++) {
    for (let x = 0; x < columns; x++) {
      const w = (row * columns + x) * 3
      words[w] = MARK_FIRST + ((row << 4) | (rows - 1))
      words[w + 1] = fg
      words[w + 2] = bg
    }
  }

  return toBase64(new Uint8Array(words.buffer))
}
