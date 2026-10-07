export type Mode = 'blocks' | 'pixels' | 'overlay'

export type Preview = {
  n: number
  width?: number
  height?: number
  thumb?: string
  thumbWidth?: number
  thumbHeight?: number
  file?: string
  id?: number
  note?: string
  isPending?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'mods-image-preview': { previews: Preview[]; mode: Mode }
  }
}
