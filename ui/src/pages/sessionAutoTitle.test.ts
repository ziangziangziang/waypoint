import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyAutoTitleToSessions,
  createDeferredAutoTitleCandidate,
  flushDeferredAutoTitle,
  isDefaultSessionName,
} from './sessionAutoTitle'

test('recognizes default session names', () => {
  assert.equal(isDefaultSessionName('Session 3/17/2026'), true)
  assert.equal(isDefaultSessionName('Trip planning'), false)
})

test('creates deferred title candidate only for default sessions with text', () => {
  assert.deepEqual(
    createDeferredAutoTitleCandidate('session-1', 'Session 3/17/2026', '  hello world  '),
    { sessionId: 'session-1', seedText: 'hello world' }
  )
  assert.equal(createDeferredAutoTitleCandidate('session-1', 'Trip planning', 'hello world'), null)
  assert.equal(createDeferredAutoTitleCandidate('session-1', 'Session 3/17/2026', '   '), null)
  assert.equal(createDeferredAutoTitleCandidate(null, 'Session 3/17/2026', 'hello world'), null)
})

test('flushDeferredAutoTitle runs once and updates status lifecycle', async () => {
  const generationStates: Array<string | null> = []
  const resolved: Array<{ name: string }> = []
  let cleared = 0
  const calls: Array<{ sessionId: string; model?: string; seedText?: string }> = []

  const didRun = await flushDeferredAutoTitle({
    sessionId: 'session-1',
    sessionName: 'Session 3/17/2026',
    model: 'gpt-test',
    queuedCandidate: { sessionId: 'session-1', seedText: 'hello world' },
    generatingSessionId: null,
    autoTitleSession: async (sessionId, payload) => {
      calls.push({ sessionId, ...payload })
      return { name: 'Hello world summary', titleStatus: 'generated' }
    },
    onGenerationChange: (sessionId) => generationStates.push(sessionId),
    onResolved: (response) => resolved.push({ name: response.name }),
    clearQueuedCandidate: () => {
      cleared += 1
    },
  })

  assert.equal(didRun, true)
  assert.deepEqual(calls, [
    { sessionId: 'session-1', model: 'gpt-test', seedText: 'hello world' },
  ])
  assert.deepEqual(generationStates, ['session-1', null])
  assert.deepEqual(resolved, [{ name: 'Hello world summary' }])
  assert.equal(cleared, 1)
})

test('flushDeferredAutoTitle skips duplicate or stale candidates', async () => {
  let called = false

  const staleRun = await flushDeferredAutoTitle({
    sessionId: 'session-1',
    sessionName: 'Session 3/17/2026',
    queuedCandidate: { sessionId: 'session-2', seedText: 'hello world' },
    generatingSessionId: null,
    autoTitleSession: async () => {
      called = true
      return { name: 'unused' }
    },
    onGenerationChange: () => undefined,
    onResolved: () => undefined,
    clearQueuedCandidate: () => undefined,
  })

  const duplicateRun = await flushDeferredAutoTitle({
    sessionId: 'session-1',
    sessionName: 'Session 3/17/2026',
    queuedCandidate: { sessionId: 'session-1', seedText: 'hello world' },
    generatingSessionId: 'session-1',
    autoTitleSession: async () => {
      called = true
      return { name: 'unused' }
    },
    onGenerationChange: () => undefined,
    onResolved: () => undefined,
    clearQueuedCandidate: () => undefined,
  })

  assert.equal(staleRun, false)
  assert.equal(duplicateRun, false)
  assert.equal(called, false)
})

test('flushDeferredAutoTitle clears status on failure and non-default names do not retry', async () => {
  const generationStates: Array<string | null> = []
  let cleared = 0
  const errors: unknown[] = []

  const failedRun = await flushDeferredAutoTitle({
    sessionId: 'session-1',
    sessionName: 'Session 3/17/2026',
    queuedCandidate: { sessionId: 'session-1', seedText: 'hello world' },
    generatingSessionId: null,
    autoTitleSession: async () => {
      throw new Error('boom')
    },
    onGenerationChange: (sessionId) => generationStates.push(sessionId),
    onResolved: () => undefined,
    clearQueuedCandidate: () => {
      cleared += 1
    },
    onError: (error) => errors.push(error),
  })

  assert.equal(failedRun, false)
  assert.deepEqual(generationStates, ['session-1', null])
  assert.equal(cleared, 1)
  assert.equal(errors.length, 1)

  const sessions = applyAutoTitleToSessions(
    [{ id: 'session-1', name: 'Session 3/17/2026', messageCount: 1, createdAt: '', updatedAt: '' }],
    'session-1',
    { name: 'Trip planning', titleStatus: 'generated', titleUpdatedAt: 'now' }
  )
  assert.equal(
    createDeferredAutoTitleCandidate('session-1', sessions[0].name, 'another message'),
    null
  )
})
