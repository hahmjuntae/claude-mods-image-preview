import { expect, test } from 'claude-code/testing'

import { fromBase64 } from '../hooks/base64'
import { decodePng, isPng, pngSize } from '../hooks/png'
import { VECTORS } from './vectors'

for (const vector of VECTORS) {
  test(`decodes ${vector.name} as ImageMagick does`, () => {
    const image = decodePng(fromBase64(vector.png))
    const expected = fromBase64(vector.rgba)
    let worst = 0

    for (let i = 0; i < expected.length; i++) {
      const isHiddenColor = i % 4 !== 3 && image.data[i - (i % 4) + 3] === 0
      worst = Math.max(worst, Math.abs((isHiddenColor ? 0 : image.data[i]) - expected[i]))
    }

    expect(image.width).toBe(vector.width)
    expect(image.height).toBe(vector.height)
    expect(image.data.length).toBe(expected.length)
    expect(worst).toBeLessThanOrEqual(1)
  })
}

test('reads the size from the header alone', () => {
  const [first] = VECTORS

  expect(pngSize(fromBase64(first.png))).toEqual({ width: first.width, height: first.height })
})

test('rejects bytes that are not a PNG', () => {
  const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70)

  expect(isPng(jpeg)).toBe(false)
  expect(() => decodePng(jpeg)).toThrow('not a PNG')
})
