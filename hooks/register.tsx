import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mode, Preview } from '../types'
import { fromBase64, toBase64 } from './base64'
import { planBand } from './layout'
import { ideCommand, viewerCommands } from './open'
import { decodePng, isPng } from './png'
import { downsample, fitBox, markCells, markHex, markId, quadrantCells, type Fit } from './thumb'

const previews = atom({ plugin: 'mods-image-preview', key: 'previews' } as const, [] as Preview[])
const mode = atom({ plugin: 'mods-image-preview', key: 'mode' } as const, 'blocks' as Mode)

const POLL_MS = 300
const PENDING_TICKS = 10
const MAX_READ_BYTES = 4 * 1024 * 1024
const TOKEN = /\[Image #(\d+)\]/g
const IMAGE_FILE = /^(\d+)\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i
const WEB_IMAGE = /\.(png|jpe?g|gif|webp)$/i
const CLAUDE_TEMP = /^claude(-\d+)?$/
const ALT_DENY = /\balt\b/i
const SIZES: Record<string, [number, number]> = { small: [16, 4], medium: [24, 6], large: [40, 10] }
// 렌더 시점 축소 여유분으로 사분면 격자의 2배 해상도 원본 보관
const SOURCE_SCALE = 2
const IDE_TIMEOUT_MS = 10_000
const VIEWER_TIMEOUT_MS = 5_000
const PORT = /^\d{1,5}$/

type Picture = { bytes: Uint8Array; path: string }

let located: { sessionId: string; dir: string } | undefined
let bandRequestId: string | undefined
let isPolling = false
const attempts = new Map<number, number>()
const probed = new Set<number>()
const opened = new Set<string>()

export const register: Register = (on, options) => {
  const box: [number, number] = SIZES[String(options.size)] ?? [24, 6]
  const renderer = String(options.renderer)
  const openMode = String(options.open)

  on('session.start', async ($, e, next) => {
    const chosen = await chooseMode($, renderer)
    await update($, mode, () => chosen)
    await update($, previews, () => [])
    if (chosen === 'overlay') await pruneLinks($)
    // 이미지 붙여넣기는 prompt.edit 를 거치지 않아 초안 폴링으로 우회
    $.clock.every(POLL_MS, () => {
      void poll($, box, openMode)
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
    const { Box, Button, Image, Raster, Text } = $.ui.resolve(e)
    // IDE 탭이 원본을 보여 주는 이미지는 흐린 썸네일 대신 한 줄 표시라 폭 배분에서 제외
    const plan = planBand(
      list.filter(preview => !preview.isInIde),
      e.props.maxRows,
      e.props.bodyColumns,
      box,
    )
    const fits = new Map(plan.tiles.map(tile => [tile.n, tile.fit]))
    bandRequestId = e.requestId

    const picture = (preview: Preview, fit: Fit | undefined) => {
      if (!fit) return <Text dimColor>{preview.note ?? '...'}</Text>

      if (current === 'pixels' && preview.file) {
        return (
          <Image
            key={`image-${preview.n}`}
            source={{ file: preview.file, format: 'png' }}
            columns={fit.columns}
            rows={fit.rows}
            alt={`Image #${preview.n}`}
          />
        )
      }

      const cells =
        current === 'overlay' && preview.id !== undefined
          ? markCells(preview.id, fit.columns, fit.rows)
          : blockCells(preview, fit)

      return <Raster key={`raster-${preview.n}`} columns={fit.columns} rows={fit.rows} cells={cells} />
    }

    // 번호를 누르면 IDE 탭이나 OS 뷰어로 원본 화질 확인
    const label = (preview: Preview) => {
      const { source } = preview

      if (!source) return <Text dimColor>#{preview.n}</Text>

      return <Button key={`open-${preview.n}`} label={`#${preview.n}`} plain dimColor onPress={() => void openOriginal($, source, true)} />
    }

    return (
      <Box flexDirection="row" alignItems="flex-end" columnGap={1}>
        {list.map(preview =>
          preview.isInIde ? (
            <Box key={`tile-${preview.n}`} flexDirection="row" columnGap={1}>
              {label(preview)}
              <Text dimColor>in IDE</Text>
            </Box>
          ) : plan.isCompact ? (
            <Box key={`tile-${preview.n}`} flexDirection="row" columnGap={1}>
              {picture(preview, fits.get(preview.n))}
              {label(preview)}
            </Box>
          ) : (
            <Box key={`tile-${preview.n}`} flexDirection="column" alignItems="center" borderStyle="round" borderDimColor>
              {picture(preview, fits.get(preview.n))}
              {label(preview)}
            </Box>
          ),
        )}
      </Box>
    )
  })
}

function blockCells(preview: Preview, fit: Fit): string {
  if (!preview.thumb || !preview.thumbWidth || !preview.thumbHeight) return ''

  const thumb = { width: preview.thumbWidth, height: preview.thumbHeight, data: fromBase64(preview.thumb) }

  return quadrantCells(downsample(thumb, fit.pxWidth * 2, fit.pxHeight))
}

async function poll($: EngineInterface, box: [number, number], openMode: string): Promise<void> {
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

    for (const { source } of nextPreviews) {
      if (!source || opened.has(source)) continue

      opened.add(source)

      if (openMode === 'off') continue

      void openOriginal($, source, openMode === 'viewer').then(where => {
        if (where !== 'ide') return

        return update($, previews, list => list.map(preview => (preview.source === source ? { ...preview, isInIde: true } : preview)))
      })
    }
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

    return tries < PENDING_TICKS ? { n, isPending: true } : { n, note: 'not found' }
  }

  try {
    const picture = await readPicture($, file, maxColumns * 4)
    const image = decodePng(picture.bytes)
    const fit = fitBox(image.width, image.height, maxColumns, maxRows)
    const thumb = downsample(image, fit.pxWidth * 2 * SOURCE_SCALE, fit.pxHeight * SOURCE_SCALE)
    const preview: Preview = {
      n,
      source: file,
      width: image.width,
      height: image.height,
      thumb: toBase64(thumb.data),
      thumbWidth: thumb.width,
      thumbHeight: thumb.height,
    }

    if (chosen === 'pixels') return { ...preview, file: picture.path }

    if (chosen === 'overlay') {
      const source = WEB_IMAGE.test(file) ? file : picture.path
      const id = markId(source)

      if (await linkForOverlay($, source, id)) return { ...preview, id }
    }

    return preview
  } catch {
    return { n, source: file, note: 'unsupported' }
  }
}

// 엔진이 kitty 그래픽 질의에 응답이 없으면 alt 를 그리므로 블록 폴백 근거
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

  return home ? `${home}/.claude/claude-mods-image-preview` : undefined
}

async function readPicture($: EngineInterface, file: string, edge: number): Promise<Picture> {
  const { size } = await $.fs.stat(file)

  if (size <= MAX_READ_BYTES) {
    const bytes = fromBase64((await $.fs.read(file, { as: 'bytes' })).base64)

    if (isPng(bytes)) return { bytes, path: file }
  }

  // PNG 가 아니거나 읽기 상한 초과 시 OS 별 변환기로 만든 축소 PNG 폴백
  const out = `${file.replace(/[\\/]images[\\/][^\\/]+$/, '')}/claude-mods-image-preview/${file.replace(/^.*[\\/]/, '')}.png`
  await $.fs.write(out, '')

  for (const argv of converters(file, out, edge)) {
    try {
      const { exitCode } = await $.process.run(argv)

      if (exitCode !== 0) continue

      const bytes = fromBase64((await $.fs.read(out, { as: 'bytes' })).base64)

      if (isPng(bytes)) return { bytes, path: out }
    } catch {
      continue
    }
  }

  throw new Error('no converter')
}

function converters(file: string, out: string, edge: number): string[][] {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`
  const resize = `${edge}x${edge}>`
  const script =
    '& { param($in, $out, $edge) Add-Type -AssemblyName System.Drawing; ' +
    '$s = [System.Drawing.Image]::FromFile($in); ' +
    '$k = [Math]::Min(1, $edge / [Math]::Max($s.Width, $s.Height)); ' +
    '$b = New-Object System.Drawing.Bitmap ([int][Math]::Max(1, $s.Width * $k)), ([int][Math]::Max(1, $s.Height * $k)); ' +
    '$g = [System.Drawing.Graphics]::FromImage($b); $g.DrawImage($s, 0, 0, $b.Width, $b.Height); ' +
    '$b.Save($out, [System.Drawing.Imaging.ImageFormat]::Png) }'

  return [
    ['sips', '-s', 'format', 'png', '-Z', String(edge), file, '--out', out],
    ['magick', file, '-resize', resize, out],
    ['convert', file, '-resize', resize, out],
    ['powershell', '-NoProfile', '-NonInteractive', '-Command', `${script} ${quote(file)} ${quote(out)} ${edge}`],
  ]
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

// IDE 편집기 탭은 원본 화질 그대로이고 makeFrontmost 를 끄면 입력 포커스가 프롬프트에 남는 기준
async function openOriginal($: EngineInterface, file: string, useViewer: boolean): Promise<'ide' | 'viewer' | undefined> {
  if (await openInIde($, file)) return 'ide'
  if (useViewer && (await openInViewer($, file))) return 'viewer'

  return undefined
}

async function openInIde($: EngineInterface, file: string): Promise<boolean> {
  try {
    const { isError } = await $.mcp.call('ide', 'openFile', { filePath: file, preview: true, makeFrontmost: false })

    if (!isError) return true
  } catch {
    // 엔진이 IDE 내부 도구를 내주지 않으면 IDE 터미널이 알려 준 서버로 직접 연결하는 폴백
  }

  try {
    const port = await $.env.get('CLAUDE_CODE_SSE_PORT')
    const dir = await claudeDir($)

    if (!port || !PORT.test(port) || !dir || (await $.env.get('OS')) !== 'Windows_NT') return false

    const lock = `${dir}/ide/${port}.lock`

    if (!(await $.fs.exists(lock))) return false

    const { exitCode } = await $.process.run(ideCommand(port, lock, file), { timeoutMs: IDE_TIMEOUT_MS })

    return exitCode === 0
  } catch {
    return false
  }
}

async function openInViewer($: EngineInterface, file: string): Promise<boolean> {
  try {
    const isWindows = (await $.env.get('OS')) === 'Windows_NT'

    for (const argv of viewerCommands(file, isWindows)) {
      try {
        const { exitCode } = await $.process.run(argv, { timeoutMs: VIEWER_TIMEOUT_MS })

        // explorer 는 열기에 성공해도 종료 코드 1 을 돌려주는 기준
        if (exitCode === 0 || isWindows) return true
      } catch {
        continue
      }
    }
  } catch {
    return false
  }

  return false
}

async function claudeDir($: EngineInterface): Promise<string | undefined> {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')

  if (configured) return configured

  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

  return home ? `${home}/.claude` : undefined
}

async function chooseMode($: EngineInterface, renderer: string): Promise<Mode> {
  if (renderer === 'blocks' || renderer === 'pixels' || renderer === 'overlay') return renderer
  if (await advertisesOverlay($)) return 'overlay'

  return (await drawsPixels($)) ? 'pixels' : 'blocks'
}

// 이미 떠 있는 tmux 창은 새 환경 변수를 못 받아 tmux 전역 환경을 함께 확인하는 기준
async function advertisesOverlay($: EngineInterface): Promise<boolean> {
  const isTmux = Boolean(await $.env.get('TMUX'))

  // tmux 안에서 truecolor 가 꺼지면 마커 색이 256색으로 깨지는 문제 방지
  if (isTmux && !(await $.env.get('CLAUDE_CODE_TMUX_TRUECOLOR'))) return false
  if ((await $.env.get('CLAUDE_MODS_IMAGE_OVERLAY')) === '1') return true
  if (!isTmux) return false

  try {
    const { exitCode, stdout } = await $.process.run(['tmux', 'show-environment', '-g', 'CLAUDE_MODS_IMAGE_OVERLAY'])

    return exitCode === 0 && stdout.trim() === 'CLAUDE_MODS_IMAGE_OVERLAY=1'
  } catch {
    return false
  }
}

async function drawsPixels($: EngineInterface): Promise<boolean> {
  if ((await $.env.get('TMUX')) || (await $.env.get('STY')) || (await $.env.get('SSH_CONNECTION'))) return false

  const term = await $.env.get('TERM')
  const program = await $.env.get('TERM_PROGRAM')

  return term === 'xterm-kitty' || term === 'xterm-ghostty' || program === 'ghostty' || Boolean(await $.env.get('KITTY_WINDOW_ID'))
}
