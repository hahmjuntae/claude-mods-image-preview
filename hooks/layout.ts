import { fitBox, type Fit } from './thumb'

export type TileInput = { n: number; width?: number; height?: number }

export type TilePlan = { n: number; fit?: Fit }

export type BandPlan = { isCompact: boolean; tiles: TilePlan[] }

const BORDER_ROWS = 2
const LABEL_ROWS = 1
const MIN_FRAMED_ROWS = 2
const GAP = 1

// 밴드 높이가 테두리와 번호 줄을 감당하지 못하면 번호를 옆에 두는 압축 배치 기준
export function planBand(list: TileInput[], maxRows: number, bodyColumns: number, box: [number, number]): BandPlan {
  const [boxColumns, boxRows] = box
  const framedRows = Math.min(boxRows, maxRows - BORDER_ROWS - LABEL_ROWS)
  const isCompact = framedRows < MIN_FRAMED_ROWS
  const rowBudget = isCompact ? Math.max(1, Math.min(boxRows, maxRows)) : framedRows
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
