import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateContainedImageSize,
  MAX_UPLOAD_IMAGE_HEIGHT,
  MAX_UPLOAD_IMAGE_WIDTH,
} from './imageUpload'

test('does not resize images already within the upload bounds', () => {
  assert.deepEqual(calculateContainedImageSize(640, 960), {
    width: 640,
    height: 960,
    resized: false,
  })
})

test('resizes portrait images to stay within the upload bounds', () => {
  assert.deepEqual(calculateContainedImageSize(1200, 2400), {
    width: 640,
    height: 1280,
    resized: true,
  })
})

test('resizes landscape images to stay within the upload bounds', () => {
  assert.deepEqual(calculateContainedImageSize(2400, 1200), {
    width: 720,
    height: 360,
    resized: true,
  })
})

test('preserves aspect ratio while fitting the bounding box', () => {
  const resized = calculateContainedImageSize(2000, 1000)
  assert.equal(resized.resized, true)
  assert.ok(resized.width <= MAX_UPLOAD_IMAGE_WIDTH)
  assert.ok(resized.height <= MAX_UPLOAD_IMAGE_HEIGHT)
  assert.ok(Math.abs(resized.width / resized.height - 2) < 0.01)
})
