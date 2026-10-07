import { toBase64 } from './base64'
import type { Rgba } from './png'

export type Fit = { columns: number; rows: number; pxWidth: number; pxHeight: number }

const DEFAULT_COLOR = 0x01000000
const UPPER_HALF = 0x2580
const LOWER_HALF = 0x2584
const SPACE = 0x20
const OPAQUE = 128

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

export function halfBlockCells(image: Rgba): string {
  const { width, height, data } = image
  const rows = Math.ceil(height / 2)
  const words = new Uint32Array(width * rows * 3)
  const color = (x: number, y: number) => {
    if (y >= height) return undefined

    const i = (y * width + x) * 4

    return data[i + 3] < OPAQUE ? undefined : (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
  }

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < width; cx++) {
      const top = color(cx, cy * 2)
      const bottom = color(cx, cy * 2 + 1)
      const w = (cy * width + cx) * 3

      if (top !== undefined) {
        words[w] = UPPER_HALF
        words[w + 1] = top
        words[w + 2] = bottom ?? DEFAULT_COLOR
      } else if (bottom !== undefined) {
        words[w] = LOWER_HALF
        words[w + 1] = bottom
        words[w + 2] = DEFAULT_COLOR
      } else {
        words[w] = SPACE
        words[w + 1] = DEFAULT_COLOR
        words[w + 2] = DEFAULT_COLOR
      }
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
