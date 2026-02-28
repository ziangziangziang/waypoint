import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMessageContent } from './messageContentParser'

test('parses standard think block', () => {
  const parts = parseMessageContent('<think>analyze</think>\n\nanswer')
  assert.deepEqual(parts, [
    { type: 'thinking', content: 'analyze' },
    { type: 'text', content: 'answer' },
  ])
})

test('parses missing opening tag before closing think tag', () => {
  const parts = parseMessageContent('analysis text</think>\n\nanswer')
  assert.deepEqual(parts, [
    { type: 'thinking', content: 'analysis text' },
    { type: 'text', content: 'answer' },
  ])
})

test('parses unclosed think tag during streaming', () => {
  const parts = parseMessageContent('<think>still thinking')
  assert.deepEqual(parts, [
    { type: 'thinking', content: 'still thinking' },
  ])
})

test('parses whitespace-tolerant think tags', () => {
  const parts = parseMessageContent('<think > spaced </ think >\n\nok')
  assert.deepEqual(parts, [
    { type: 'thinking', content: 'spaced' },
    { type: 'text', content: 'ok' },
  ])
})

test('plain text remains text segment', () => {
  const parts = parseMessageContent('just answer')
  assert.deepEqual(parts, [
    { type: 'text', content: 'just answer' },
  ])
})
