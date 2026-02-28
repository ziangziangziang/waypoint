import test from 'node:test'
import assert from 'node:assert/strict'
import { buildUserPayload, findNonDataImageUrls, toApiMessage } from './agentPlaygroundPayload'

const DATA_URL_1 = 'data:image/png;base64,AAA'
const DATA_URL_2 = 'data:image/jpeg;base64,BBB'

test('uses inline data URLs for request even when display refs are cached URLs', () => {
  const payload = buildUserPayload({
    callModeEnabled: false,
    text: 'what does the picture say',
    requestImageUrls: [DATA_URL_1],
    displayImageRefs: ['/admin/media/abc123'],
  })

  const apiMessage = toApiMessage({
    role: 'user',
    content: payload.content,
    images: payload.images,
    requestImages: payload.requestImages,
  })

  assert.equal(Array.isArray(apiMessage.content), true)
  const imagePart = (apiMessage.content as Array<{ type: string; image_url?: { url: string } }>)[1]
  assert.equal(imagePart.type, 'image_url')
  assert.equal(imagePart.image_url?.url, DATA_URL_1)
})

test('falls back to inline data URLs for display and request when cache misses', () => {
  const payload = buildUserPayload({
    callModeEnabled: false,
    text: 'describe',
    requestImageUrls: [DATA_URL_1],
  })

  assert.deepEqual(payload.images, [DATA_URL_1])
  assert.deepEqual(payload.requestImages, [DATA_URL_1])
})

test('preserves image ordering across multiple images', () => {
  const payload = buildUserPayload({
    callModeEnabled: false,
    text: '',
    requestImageUrls: [DATA_URL_1, DATA_URL_2],
    displayImageRefs: ['/admin/media/one', '/admin/media/two'],
  })
  const apiMessage = toApiMessage({
    role: 'user',
    content: payload.content,
    images: payload.images,
    requestImages: payload.requestImages,
  })
  const content = apiMessage.content as Array<{ type: string; image_url?: { url: string } }>
  assert.equal(content[0].image_url?.url, DATA_URL_1)
  assert.equal(content[1].image_url?.url, DATA_URL_2)
})

test('call mode keeps audio and uses inline image URL', () => {
  const payload = buildUserPayload({
    callModeEnabled: true,
    text: 'read this',
    requestImageUrls: [DATA_URL_1],
    displayImageRefs: ['/admin/media/cached'],
    audioRef: '/admin/media/audio',
  })

  const apiMessage = toApiMessage({
    role: 'user',
    content: payload.content,
    images: payload.images,
    requestImages: payload.requestImages,
  })

  const content = apiMessage.content as Array<{ type: string; image_url?: { url: string }; input_audio?: { url?: string } }>
  assert.equal(content[0].type, 'input_audio')
  assert.equal(content[0].input_audio?.url, '/admin/media/audio')
  assert.equal(content[1].type, 'image_url')
  assert.equal(content[1].image_url?.url, DATA_URL_1)
  assert.equal(content[2].type, 'text')
})

test('text-only payload does not inject image parts', () => {
  const payload = buildUserPayload({
    callModeEnabled: false,
    text: 'hello world',
    requestImageUrls: [],
  })
  const apiMessage = toApiMessage({
    role: 'user',
    content: payload.content,
    images: payload.images,
    requestImages: payload.requestImages,
  })

  assert.equal(typeof apiMessage.content, 'string')
  assert.equal(apiMessage.content, 'hello world')
})

test('debug detector flags non-data image URLs', () => {
  const apiMessage = toApiMessage({
    role: 'user',
    content: 'hello',
    images: ['/admin/media/abc'],
    requestImages: undefined,
  })

  const invalid = findNonDataImageUrls([apiMessage])
  assert.deepEqual(invalid, ['/admin/media/abc'])
})
