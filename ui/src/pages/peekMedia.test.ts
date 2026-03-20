import test from 'node:test'
import assert from 'node:assert/strict'
import { extractEmbeddedMedia, redactEmbeddedMedia } from './peekMedia'

test('extractEmbeddedMedia treats b64_json payloads as image media', () => {
  const payload = {
    created: 1773782955,
    data: [
      {
        b64_json: 'AQID',
      },
    ],
  }

  const media = extractEmbeddedMedia('response', payload)

  assert.equal(media.length, 1)
  assert.equal(media[0]?.path, '$.data[0].b64_json')
  assert.equal(media[0]?.source, 'response')
  assert.equal(media[0]?.kind, 'image')
  assert.equal(media[0]?.mime, 'image/png')
  assert.equal(media[0]?.url, 'data:image/png;base64,AQID')
})

test('extractEmbeddedMedia prefers sibling data-url mime metadata', () => {
  const payload = {
    data: [
      {
        mime: 'image/webp',
        b64_json: 'BBBB',
        url: 'data:image/webp;base64,BBBB',
      },
    ],
  }

  const media = extractEmbeddedMedia('response', payload)

  assert.equal(media.length, 1)
  assert.equal(media[0]?.mime, 'image/webp')
  assert.equal(media[0]?.url, 'data:image/webp;base64,BBBB')
  assert.equal(media[0]?.origin, 'b64_json')
})

test('redactEmbeddedMedia removes inline binary payloads from pretty json', () => {
  const payload = {
    data: [
      {
        b64_json: 'AQID',
        url: 'data:image/png;base64,AQID',
      },
    ],
  }

  const redacted = redactEmbeddedMedia(payload) as { data: Array<{ b64_json: string; url: string }> }

  assert.match(redacted.data[0]!.b64_json, /^\[base64 media omitted: image\/png, 4 chars\]$/)
  assert.match(redacted.data[0]!.url, /^\[data URL omitted: image\/png, 4 chars\]$/)
})
