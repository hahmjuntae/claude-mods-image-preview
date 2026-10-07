import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 16,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 15 },
  view: {},
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true, startedAt: 0, context: { window: 200000 } } as const

function engineBeneath(on: On, draft: { text: string }): void {
  on('prompt.read', () => ({ value: { text: draft.text, cursor: draft.text.length } }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })
}

test('draws one tile per pasted image token and clears with the draft', async ($, on) => {
  const clock = mock.clock(on)
  const draft = { text: '[Image #1] 이거 봐줘 [Image #2]' }
  mock.env(on, { TERM: 'xterm-256color' })
  engineBeneath(on, draft)

  await $.session.start(START)
  await clock.advance(300 * 12)

  const band = await $.ui.mount({ plugin: 'mods-image-preview', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })

  expect(await band.find({ type: 'Text', text: '#1' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '#2' })).toBeDefined()
  expect(await band.findAll({ type: 'Text', text: 'not found' })).toHaveLength(2)

  draft.text = ''
  await clock.advance(300)

  const cleared = await $.ui.mount({ plugin: 'mods-image-preview', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })

  expect(await cleared.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  expect(await cleared.find({ type: 'Text', text: '#1' })).toBeUndefined()
})

test('leaves the band to the engine on surfaces that show images themselves', async ($, on) => {
  const clock = mock.clock(on)
  const draft = { text: '[Image #1]' }
  mock.env(on, { TERM: 'xterm-256color' })
  engineBeneath(on, draft)

  await $.session.start(START)
  await clock.advance(300 * 12)

  const band = await $.ui.mount({ plugin: 'mods-image-preview', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })

  expect(await band.find({ type: 'Text', text: 'engine band' })).toBeDefined()
})
