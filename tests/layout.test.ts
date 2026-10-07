import { expect, test } from 'claude-code/testing'

import { planBand } from '../hooks/layout'

const MEDIUM: [number, number] = [24, 6]

test('frames thumbnails when the band has room', () => {
  const plan = planBand([{ n: 1, width: 1600, height: 400 }], 16, 120, MEDIUM)

  expect(plan.isCompact).toBe(false)
  expect(plan.tiles[0].fit).toEqual({ columns: 24, rows: 3, pxWidth: 24, pxHeight: 6 })
})

test('fits a tall image into a three row band without a frame', () => {
  const plan = planBand([{ n: 1, width: 1164, height: 1178 }], 3, 120, MEDIUM)

  expect(plan.isCompact).toBe(true)
  expect(plan.tiles[0].fit?.rows).toBeLessThanOrEqual(3)
})

test('drops the frame when it would shrink the image below its size', () => {
  const plan = planBand([{ n: 1, width: 300, height: 300 }], 5, 120, MEDIUM)

  expect(plan.isCompact).toBe(true)
  expect(plan.tiles[0].fit?.rows).toBe(5)
})

test('keeps the frame once the full size fits with it', () => {
  const plan = planBand([{ n: 1, width: 300, height: 300 }], 9, 120, MEDIUM)

  expect(plan.isCompact).toBe(false)
  expect(plan.tiles[0].fit?.rows).toBe(6)
})

test('splits the width between several thumbnails', () => {
  const list = [1, 2, 3].map(n => ({ n, width: 1600, height: 400 }))
  const plan = planBand(list, 16, 40, MEDIUM)

  for (const tile of plan.tiles) expect(tile.fit?.columns).toBeLessThanOrEqual(10)
})

test('leaves a pending image without a fit', () => {
  expect(planBand([{ n: 4 }], 16, 120, MEDIUM).tiles[0].fit).toBeUndefined()
})
