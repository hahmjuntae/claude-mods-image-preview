import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { ideCommand, viewerCommands } from '../hooks/open'
import { VECTORS } from './vectors'

type Answers = { ide?: boolean; lock?: boolean }

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 16,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 15 },
  view: {},
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true, startedAt: 0, context: { window: 200000 } } as const
const IMAGES = '/t/claude/proj/test-session/images'
const PASTED = `${IMAGES}/1.png`
const WINDOWS = { TERM: 'xterm-256color', TEMP: '/t', OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me' }

function engineBeneath(on: On, draft: { text: string }, answers: Answers): { opened: unknown[]; runs: string[][] } {
  const opened: unknown[] = []
  const runs: string[][] = []
  const png = VECTORS.find(vector => vector.name === 'rgb8.png') ?? VECTORS[0]
  const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 100, mtimeMs: 0, isLink: false })
  // 엔진이 테스트에서도 경로를 드라이브 문자가 붙은 절대 경로로 바꿔 넘기는 기준
  const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

  on('prompt.read', () => ({ value: { text: draft.text, cursor: draft.text.length } }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.list', ($, e) => {
    if (posix(e.path) === '/t') return { value: [entry('claude', 'dir')] }
    if (posix(e.path) === '/t/claude') return { value: [entry('proj', 'dir')] }
    if (posix(e.path) === IMAGES) return { value: [entry('1.png', 'file')] }

    return { value: [] }
  })
  on('fs.exists', ($, e) => ({ value: posix(e.path) === IMAGES || (Boolean(answers.lock) && e.path.endsWith('.lock')) }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 100, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: { base64: png.png } }))
  on('mcp.call', ($, e) => {
    if (!answers.ide) return { deny: 'no connected MCP tool "openFile" on a server named "ide"' }

    opened.push(e.args)

    return { value: { content: [{ type: 'text' as const, text: 'OK' }], isError: false } }
  })
  on('process.run', ($, e) => {
    runs.push([...e.argv])

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return { opened, runs }
}

test('quotes every PowerShell argument of the IDE call', () => {
  const argv = ideCommand('63124', "C:\\Users\\o'neil/.claude/ide/63124.lock", 'C:/tmp/1.png')

  expect(argv.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command'])
  expect(argv[4]).toEndWith(" '63124' 'C:\\Users\\o''neil/.claude/ide/63124.lock' 'C:/tmp/1.png'")
  expect(argv[4]).not.toContain('"')
})

test('opens the system viewer with the platform command', () => {
  expect(viewerCommands('C:/tmp/1.png', true)).toEqual([['explorer', 'C:\\tmp\\1.png']])
  expect(viewerCommands('/tmp/1.png', false)).toEqual([['xdg-open', '/tmp/1.png'], ['open', '/tmp/1.png']])
})

test('opens each pasted image once in the connected IDE without taking the focus', { options: { open: 'ide' } }, async ($, on) => {
  const clock = mock.clock(on)
  const draft = { text: '[Image #1] 이거 봐줘' }
  mock.env(on, { TERM: 'xterm-256color', TEMP: '/t' })
  const { opened, runs } = engineBeneath(on, draft, { ide: true })

  await $.session.start(START)
  await clock.advance(300 * 12)

  expect(opened).toEqual([{ filePath: PASTED, preview: true, makeFrontmost: false }])
  expect(runs).toHaveLength(0)

  const band = await $.ui.mount({ plugin: 'mods-image-preview', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })

  expect(await band.find({ type: 'Text', text: 'in IDE' })).toBeDefined()
  expect(await band.find({ type: 'Button', key: 'open-1' })).toBeDefined()
  expect(await band.find({ type: 'Raster' })).toBeUndefined()
})

test('reaches the IDE terminal server through PowerShell when the engine has no IDE tool', { options: { open: 'ide' } }, async ($, on) => {
  const clock = mock.clock(on)
  const draft = { text: '[Image #1]' }
  mock.env(on, { ...WINDOWS, CLAUDE_CODE_SSE_PORT: '63124' })
  const { runs } = engineBeneath(on, draft, { lock: true })

  await $.session.start(START)
  await clock.advance(300 * 12)

  const powershell = runs.filter(argv => argv[0] === 'powershell')

  expect(powershell).toHaveLength(1)
  expect(powershell[0][4]).toEndWith(` '63124' 'C:\\Users\\me/.claude/ide/63124.lock' '${PASTED}'`)
})

test('opens the original in the system viewer when its number is pressed', async ($, on) => {
  const clock = mock.clock(on)
  const draft = { text: '[Image #1]' }
  mock.env(on, WINDOWS)
  const { runs } = engineBeneath(on, draft, {})

  await $.session.start(START)
  await clock.advance(300 * 12)

  expect(runs.filter(argv => argv[0] === 'explorer')).toHaveLength(0)

  const band = await $.ui.mount({ plugin: 'mods-image-preview', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })

  expect(await band.find({ type: 'Raster' })).toBeDefined()

  await band.press({ key: 'open-1' })

  expect(runs.filter(argv => argv[0] === 'explorer')).toEqual([['explorer', PASTED.replace(/\//g, '\\')]])
})

test('leaves pasted images closed by default', async ($, on) => {
  const clock = mock.clock(on)
  const draft = { text: '[Image #1]' }
  mock.env(on, { TERM: 'xterm-256color', TEMP: '/t' })
  const { opened } = engineBeneath(on, draft, { ide: true })

  await $.session.start(START)
  await clock.advance(300 * 12)

  expect(opened).toHaveLength(0)
})
