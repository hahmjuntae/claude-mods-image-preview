import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { fromBase64 } from '../hooks/base64'
import { markId, windowKey } from '../hooks/thumb'
import { VECTORS } from './vectors'

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
const SPEC = '/t/claude/proj/test-session/claude-mods-image-preview/overlay.txt'
const WINDOWS = { TERM: 'xterm-256color', TEMP: '/t', OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me' }
const KEY = windowKey(1, markId('test-session'))
const WINDOW = { options: { renderer: 'window', open: 'off' } }

type Engine = { writes: { path: string; text: string }[]; spawned: string[][] }

function engineBeneath(on: On, draft: { text: string }, exitCode: number): Engine {
  const writes: { path: string; text: string }[] = []
  const spawned: string[][] = []
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
  on('fs.exists', ($, e) => ({ value: posix(e.path) === IMAGES || posix(e.path).endsWith('hooks/overlay.ps1') }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 100, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: { base64: png.png } }))
  on('fs.write', ($, e) => {
    writes.push({ path: posix(e.path), text: e.text })

    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])

    return { value: { code: exitCode, signal: null } }
  })

  return { writes, spawned }
}

function cellWords(cells: unknown): number[] {
  return [...new Uint32Array(fromBase64(String(cells)).buffer)]
}

test('draws a solid marker and hands the original to the overlay helper', WINDOW, async ($, on) => {
  const clock = mock.clock(on)
  const draft = { text: '[Image #1]' }
  mock.env(on, WINDOWS)
  const { writes, spawned } = engineBeneath(on, draft, 0)

  await $.session.start(START)
  await clock.advance(300 * 12)

  const spec = writes.filter(write => write.path === SPEC)

  expect(spec.at(-1)?.text).toBe(`${KEY.toString(16).padStart(6, '0')}\t${PASTED}\n`)
  expect(spawned).toHaveLength(1)
  expect(spawned[0].slice(0, 6)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
  expect(spawned[0][6]).toEndWith('hooks/overlay.ps1')
  expect(spawned[0].slice(7)).toEqual(['-Spec', SPEC])

  const band = await $.ui.mount({ plugin: 'mods-image-preview', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const words = cellWords((await band.find({ type: 'Raster' }))?.props.cells)

  expect(words.length).toBeGreaterThan(0)
  for (let i = 0; i < words.length; i += 3) expect(words[i + 2]).toBe(KEY)
})

test('empties the overlay spec when the prompt is sent', WINDOW, async ($, on) => {
  const clock = mock.clock(on)
  const draft = { text: '[Image #1]' }
  mock.env(on, WINDOWS)
  const { writes } = engineBeneath(on, draft, 0)

  await $.session.start(START)
  await clock.advance(300 * 12)
  draft.text = ''
  await $.prompt.submit({ text: '[Image #1]', wait: false, origin: { kind: 'composer' } })

  expect(writes.filter(write => write.path === SPEC).at(-1)?.text).toBe('')
})

test('falls back to blocks when the overlay helper fails', WINDOW, async ($, on) => {
  const clock = mock.clock(on)
  const draft = { text: '[Image #1]' }
  mock.env(on, WINDOWS)
  engineBeneath(on, draft, 1)

  await $.session.start(START)
  await clock.advance(300 * 12)

  const band = await $.ui.mount({ plugin: 'mods-image-preview', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const words = cellWords((await band.find({ type: 'Raster' }))?.props.cells)

  expect(words.some((word, i) => i % 3 === 2 && word !== KEY)).toBe(true)
})

test('keeps blocks outside Windows', WINDOW, async ($, on) => {
  const clock = mock.clock(on)
  const draft = { text: '[Image #1]' }
  mock.env(on, { TERM: 'xterm-256color', TEMP: '/t' })
  const { spawned } = engineBeneath(on, draft, 0)

  await $.session.start(START)
  await clock.advance(300 * 12)

  expect(spawned).toHaveLength(0)
})
