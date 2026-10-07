export type Mode = 'blocks' | 'pixels' | 'overlay'

export type Preview = {
  n: number
  columns: number
  rows: number
  cells?: string
  file?: string
  note?: string
  isPending?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'mods-image-preview': { previews: Preview[]; mode: Mode }
  }
}
