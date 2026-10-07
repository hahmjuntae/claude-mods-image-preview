import { expect, test } from 'claude-code/testing'

import { fromBase64 } from '../hooks/base64'
import { downsample, fitBox, markCells, markHex, markId, quadrantCells } from '../hooks/thumb'

const DEFAULT_COLOR = 0x01000000

function words(cells: string): number[] {
  return [...new Uint32Array(fromBase64(cells).buffer)]
}

test('fits a wide image to the column limit', () => {
  expect(fitBox(1600, 400, 24, 6)).toEqual({ columns: 24, rows: 3, pxWidth: 24, pxHeight: 6 })
})

test('fits a tall image to the row limit', () => {
  expect(fitBox(400, 1600, 24, 6)).toEqual({ columns: 3, rows: 6, pxWidth: 3, pxHeight: 12 })
})

test('keeps an upper half block when the split is between the pixel rows', () => {
  const image = {
    width: 2,
    height: 2,
    data: Uint8Array.of(255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255),
  }

  expect(words(quadrantCells(image))).toEqual([0x2580, 0xff0000, 0x0000ff])
})

test('splits a cell into left and right halves', () => {
  const image = {
    width: 2,
    height: 2,
    data: Uint8Array.of(255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 255, 255),
  }

  expect(words(quadrantCells(image))).toEqual([0x258c, 0xff0000, 0x0000ff])
})

test('draws a lone corner pixel with a quadrant glyph', () => {
  const image = {
    width: 2,
    height: 2,
    data: Uint8Array.of(0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255),
  }

  expect(words(quadrantCells(image))).toEqual([0x2597, 0xffffff, 0x000000])
})

test('leaves transparent pixels to the terminal background', () => {
  const image = {
    width: 6,
    height: 2,
    data: Uint8Array.of(
      255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ),
  }

  expect(words(quadrantCells(image))).toEqual([
    0x2580, 0xff0000, DEFAULT_COLOR,
    0x2596, 0x00ff00, DEFAULT_COLOR,
    0x20, DEFAULT_COLOR, DEFAULT_COLOR,
  ])
})

test('draws an odd last pixel row over the background', () => {
  const image = { width: 2, height: 1, data: Uint8Array.of(1, 2, 3, 255, 1, 2, 3, 255) }

  expect(words(quadrantCells(image))).toEqual([0x2580, 0x010203, DEFAULT_COLOR])
})

test('averages a block of pixels weighted by alpha', () => {
  const image = {
    width: 2,
    height: 1,
    data: Uint8Array.of(200, 100, 0, 255, 0, 0, 0, 0),
  }

  expect([...downsample(image, 1, 1).data]).toEqual([200, 100, 0, 128])
})

test('encodes the overlay id and row geometry into marker cells', () => {
  const cells = words(markCells(0xbeef1, 2, 3))

  expect(cells.slice(0, 3)).toEqual([0x2802, 0xaa_bb_ee, 0xee_ff_11])
  expect(cells[3 * 2 * 2]).toBe(0x2800 + ((2 << 4) | 2))
})

test('names overlay links with five hex digits', () => {
  expect(markHex(markId('/tmp/a.png'))).toMatch(/^[0-9a-f]{5}$/)
})
