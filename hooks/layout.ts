import { fitBox, type Fit } from './thumb'

export type TileInput = { n: number; width?: number; height?: number }

export type TilePlan = { n: number; fit?: Fit }

export type BandPlan = { isCompact: boolean; tiles: TilePlan[] }

const BORDER_ROWS = 2
const LABEL_ROWS = 1
const GAP = 1

// 테두리를 두면 설정 크기보다 작아지는 좁은 밴드는 번호를 옆에 두는 압축 배치 기준
export function planBand(list: TileInput[], maxRows: number, bodyColumns: number, box: [number, number]): BandPlan {
  const [boxColumns, boxRows] = box
  const isCompact = maxRows - BORDER_ROWS - LABEL_ROWS < boxRows
  const rowBudget = isCompact ? Math.max(1, Math.min(boxRows, maxRows)) : boxRows
  const count = Math.max(1, list.length)
  const chrome = isCompact ? 1 + Math.max(...list.map(item => `#${item.n}`.length), 2) : 2
  const perTile = Math.floor((bodyColumns - GAP * (count - 1)) / count) - chrome
  const columnBudget = Math.max(2, Math.min(boxColumns, perTile))

  return {
    isCompact,
    tiles: list.map(item => ({
      n: item.n,
      fit: item.width && item.height ? fitBox(item.width, item.height, columnBudget, rowBudget) : undefined,
    })),
  }
}
