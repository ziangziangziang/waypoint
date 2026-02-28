import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyThinkingChunk,
  createThinkingStreamState,
  toDisplayContent,
  toFinalContent,
} from './agentThinkingContent'

test('reasoning then answer content yields wrapped think block', () => {
  let state = createThinkingStreamState()
  state = applyThinkingChunk(state, { reasoning: 'I will inspect text.' })
  state = applyThinkingChunk(state, { content: 'It says hello.' })

  assert.equal(toDisplayContent(state), '<think>I will inspect text.</think>\n\nIt says hello.')
  assert.equal(toFinalContent(state), '<think>I will inspect text.</think>\n\nIt says hello.')
})

test('multiple reasoning and content chunks preserve order', () => {
  let state = createThinkingStreamState()
  state = applyThinkingChunk(state, { reasoning: 'Step 1. ' })
  state = applyThinkingChunk(state, { reasoning: 'Step 2. ' })
  state = applyThinkingChunk(state, { content: 'Answer ' })
  state = applyThinkingChunk(state, { content: 'final.' })

  assert.equal(toFinalContent(state), '<think>Step 1. Step 2. </think>\n\nAnswer final.')
})

test('reasoning without content closes at finalize', () => {
  let state = createThinkingStreamState()
  state = applyThinkingChunk(state, { reasoning: 'Only internal chain.' })

  assert.equal(toDisplayContent(state), '<think>Only internal chain.')
  assert.equal(toFinalContent(state), '<think>Only internal chain.</think>')
})

test('no reasoning and no tags remains plain content', () => {
  let state = createThinkingStreamState()
  state = applyThinkingChunk(state, { content: 'Plain output' })

  assert.equal(toDisplayContent(state), 'Plain output')
  assert.equal(toFinalContent(state), 'Plain output')
})

test('literal think tags in content pass through unchanged', () => {
  let state = createThinkingStreamState()
  state = applyThinkingChunk(state, { content: '<think>raw</think>\n\nanswer' })

  assert.equal(toFinalContent(state), '<think>raw</think>\n\nanswer')
})
