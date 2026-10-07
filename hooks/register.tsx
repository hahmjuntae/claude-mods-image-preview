import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mode, Preview } from '../types'
import { fromBase64 } from './base64'
import { decodePng, isPng, pngSize } from './png'
import { downsample, fitBox, halfBlockCells, markCells, markHex, markId } from './thumb'

const previews = atom({ plugin: 'image-preview', key: 'previews' } as const, [] as Preview[])
const mode = atom({ plugin: 'image-preview', key: 'mode' } as const, 'blocks' as Mode)

const POLL_MS = 300
const PENDING_TICKS = 10
const MAX_READ_BYTES = 4 * 1024 * 1024
const TOKEN = /\[Image #(\d+)\]/g
const IMAGE_FILE = /^(\d+)\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i
const WEB_IMAGE = /\.(png|jpe?g|gif|webp)$/i
const CLAUDE_TEMP = /^claude(-\d+)?$/
const ALT_DENY = /\balt\b/i
const SIZES: Record<string, [number, number]> = { small: [16, 4], medium: [24, 6], large: [40, 10] }

type Picture = { bytes: Uint8Array; path: string }

let located: { sessionId: string; dir: string } | undefined
let bandRequestId: string | undefined
let isPolling = false
const attempts = new Map<number, number>()
const probed = new Set<number>()

export const register: Register = (on, options) => {
  const box: [number, number] = SIZES[String(options.size)] ?? [24, 6]
  const renderer = String(options.renderer)

  on('session.start', async ($, e, next) => {
    const chosen = await chooseMode($, renderer)
    await update($, mode, () => chosen)
    await update($, previews, () => [])
    if (chosen === 'marks') await pruneLinks($)
    // 이미지 붙여넣기는 prompt.edit 를 거치지 않아 초안 폴링으로 우회
    $.clock.every(POLL_MS, () => {
      void poll($, box)
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, previews, () => [])

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)

    const list = await read($, previews)

    if (list.length === 0) return next(e)

    const current = await read($, mode)
    const { Box, Image, Raster, Text } = $.ui.resolve(e)
    bandRequestId = e.requestId

    return (
      <Box flexDirection="row" flexWrap="wrap" alignItems="flex-end" columnGap={1}>
        {list.map(preview => (
          <Box key={`tile-${preview.n}`} flexDirection="column" alignItems="center" borderStyle="round" borderDimColor>
            {preview.columns === 0 ? (
              <Text dimColor>{preview.note ?? '...'}</Text>
            ) : current === 'pixels' && preview.file ? (
              <Image
                key={`image-${preview.n}`}
                source={{ file: preview.file, format: 'png' }}
                columns={preview.columns}
                rows={preview.rows}
                alt={`Image #${preview.n}`}
              />
            ) : (
              <Raster key={`raster-${preview.n}`} columns={preview.columns} rows={preview.rows} cells={preview.cells ?? ''} />
            )}
            <Text dimColor>#{preview.n}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}

async function poll($: EngineInterface, box: [number, number]): Promise<void> {
  if (isPolling) return

  isPolling = true

  try {
    const { text } = await $.prompt.read()
    const wanted = [...new Set([...text.matchAll(TOKEN)].map(match => Number(match[1])))]
    const current = await read($, previews)
    const chosen = await read($, mode)
    const shown = current.map(preview => preview.n)
    const isSettled =
      current.every(preview => !preview.isPending) &&
      wanted.length === shown.length &&
      wanted.every((n, i) => n === shown[i])

    if (isSettled) {
      if (chosen === 'pixels') await probePixels($, current)

      return
    }

    for (const n of attempts.keys()) if (!wanted.includes(n)) attempts.delete(n)

    const nextPreviews: Preview[] = []

    for (const n of wanted) {
      const known = current.find(preview => preview.n === n)
      nextPreviews.push(known && !known.isPending ? known : await loadPreview($, n, box, chosen))
    }

    await update($, previews, () => nextPreviews)
  } finally {
    isPolling = false
  }
}

async function loadPreview($: EngineInterface, n: number, box: [number, number], chosen: Mode): Promise<Preview> {
  const [maxColumns, maxRows] = box
  const file = await findImage($, n)

  if (!file) {
    const tries = (attempts.get(n) ?? 0) + 1
    attempts.set(n, tries)

    return tries < PENDING_TICKS ? { n, columns: 0, rows: 0, isPending: true } : { n, columns: 0, rows: 0, note: '미리보기 없음' }
  }

  try {
    const picture = await readPicture($, file, maxColumns * 4)

    if (chosen === 'marks') {
      const source = WEB_IMAGE.test(file) ? file : picture.path
      const id = markId(source)

      if (await linkForOverlay($, source, id)) {
        const { width, height } = pngSize(picture.bytes)
        const fit = fitBox(width, height, maxColumns, maxRows)

        return { n, columns: fit.columns, rows: fit.rows, cells: markCells(id, fit.columns, fit.rows) }
      }
    }

    const image = decodePng(picture.bytes)
    const fit = fitBox(image.width, image.height, maxColumns, maxRows)
    const cells = halfBlockCells(downsample(image, fit.pxWidth, fit.pxHeight))

    return { n, columns: fit.columns, rows: fit.rows, cells, file: chosen === 'pixels' ? picture.path : undefined }
  } catch {
    return { n, columns: 0, rows: 0, note: '미리보기 불가' }
  }
}

// 엔진이 kitty 그래픽 질의에 응답이 없으면 alt 를 그리므로 반블록 폴백 근거
async function probePixels($: EngineInterface, list: Preview[]): Promise<void> {
  const target = list.find(preview => preview.file && !probed.has(preview.n))

  if (!target?.file || !bandRequestId) return

  const { deny } = await $.ui.blit({
    requestId: bandRequestId,
    key: `image-${target.n}`,
    source: { file: target.file, format: 'png' },
  })

  if (deny === undefined) {
    probed.add(target.n)
  } else if (ALT_DENY.test(deny)) {
    probed.add(target.n)
    await update($, mode, () => 'blocks')
  }
}

async function linkForOverlay($: EngineInterface, source: string, id: number): Promise<boolean> {
  const dir = await overlayDir($)

  if (!dir) return false

  const made = await $.process.run(['mkdir', '-p', dir])

  if (made.exitCode !== 0) return false

  const { exitCode } = await $.process.run(['ln', '-sfn', source, `${dir}/${markHex(id)}`])

  return exitCode === 0
}

async function pruneLinks($: EngineInterface): Promise<void> {
  const dir = await overlayDir($)

  if (dir && (await $.fs.exists(dir))) await $.process.run(['find', dir, '-type', 'l', '-mmin', '+1440', '-delete'])
}

async function overlayDir($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME')

  return home ? `${home}/.claude/image-preview` : undefined
}

async function readPicture($: EngineInterface, file: string, edge: number): Promise<Picture> {
  const { size } = await $.fs.stat(file)

  if (size <= MAX_READ_BYTES) {
    const bytes = fromBase64((await $.fs.read(file, { as: 'bytes' })).base64)

    if (isPng(bytes)) return { bytes, path: file }
  }

  // PNG 가 아니거나 읽기 상한 초과 시 macOS sips 축소본 폴백
  const out = `${file.replace(/[\\/]images[\\/][^\\/]+$/, '')}/image-preview/${file.replace(/^.*[\\/]/, '')}.png`
  await $.fs.write(out, '')
  const { exitCode } = await $.process.run(['sips', '-s', 'format', 'png', '-Z', String(edge), file, '--out', out])

  if (exitCode !== 0) throw new Error('sips failed')

  return { bytes: fromBase64((await $.fs.read(out, { as: 'bytes' })).base64), path: out }
}

async function findImage($: EngineInterface, n: number): Promise<string | undefined> {
  const dir = await imagesDir($)

  if (!dir) return undefined

  const entry = (await $.fs.list(dir)).find(item => item.kind === 'file' && Number(IMAGE_FILE.exec(item.name)?.[1]) === n)

  return entry ? `${dir}/${entry.name}` : undefined
}

// 엔진이 붙여넣기 즉시 이미지를 쓰는 <temp>/claude-<uid>/<project>/<session>/images 기준
async function imagesDir($: EngineInterface): Promise<string | undefined> {
  const sessionId = await $.session.id()

  if (located?.sessionId === sessionId) return located.dir

  for (const root of await tempRoots($)) {
    for (const project of await childDirs($, root)) {
      const dir = `${root}/${project}/${sessionId}/images`

      if (await $.fs.exists(dir)) {
        located = { sessionId, dir }

        return dir
      }
    }
  }

  return undefined
}

async function tempRoots($: EngineInterface): Promise<string[]> {
  const override = await $.env.get('CLAUDE_CODE_TMPDIR')
  const parents = [override, '/tmp', '/private/tmp', await $.env.get('TMPDIR'), await $.env.get('TEMP')]
  const roots = override ? [override] : []

  for (const parent of parents) {
    if (!parent) continue

    const base = parent.replace(/[\\/]+$/, '')

    for (const name of await childDirs($, base)) if (CLAUDE_TEMP.test(name)) roots.push(`${base}/${name}`)
  }

  return [...new Set(roots)]
}

async function childDirs($: EngineInterface, path: string): Promise<string[]> {
  try {
    return (await $.fs.list(path)).filter(item => item.kind === 'dir').map(item => item.name)
  } catch {
    return []
  }
}

async function chooseMode($: EngineInterface, renderer: string): Promise<Mode> {
  if (renderer === 'blocks' || renderer === 'pixels') return renderer
  if (renderer === 'asterisk' || (await $.env.get('ASTERISK_APP_TERMINAL')) === '1') return 'marks'

  return (await drawsPixels($)) ? 'pixels' : 'blocks'
}

async function drawsPixels($: EngineInterface): Promise<boolean> {
  if ((await $.env.get('TMUX')) || (await $.env.get('STY')) || (await $.env.get('SSH_CONNECTION'))) return false

  const term = await $.env.get('TERM')
  const program = await $.env.get('TERM_PROGRAM')

  return term === 'xterm-kitty' || term === 'xterm-ghostty' || program === 'ghostty' || Boolean(await $.env.get('KITTY_WINDOW_ID'))
}
