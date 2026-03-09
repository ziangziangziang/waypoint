import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { promises as fs } from 'fs'
import {
  createSession,
  addMessage,
  deleteSession,
  getSession,
  resolveSessionsDir,
} from '../src/storage/sessionRepository'
import {
  getCacheStats,
  getMediaPath,
  getMediaRefCount,
  storeMedia,
} from '../src/storage/imageCache'
import type { StoragePaths } from '../src/storage/files'

function makePaths(baseDir: string): StoragePaths {
  return {
    baseDir,
    configPath: path.join(baseDir, 'config.yaml'),
    healthPath: path.join(baseDir, 'health.json'),
    providerHealthPath: path.join(baseDir, 'providers_health.json'),
    requestLogPath: path.join(baseDir, 'request_logs.jsonl'),
    providersPath: path.join(baseDir, 'providers.json'),
    poolsPath: path.join(baseDir, 'pools.json'),
    poolStatePath: path.join(baseDir, 'pool_state.json'),
  }
}

async function makeWorkspaceTempDir(prefix: string): Promise<string> {
  const base = path.join(process.cwd(), 'tmp')
  await fs.mkdir(base, { recursive: true })
  return fs.mkdtemp(path.join(base, prefix))
}

const DATA_URL_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5P6n4AAAAASUVORK5CYII='
const DATA_URL_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAQAAABLbSncAAAADElEQVR42mP8z/CfAQADgwGfWQ36KQAAAABJRU5ErkJggg=='

function toHashFromAdminUrl(url: string): string {
  const match = url.match(/^\/admin\/media\/([a-f0-9]{16})$/)
  if (!match) {
    throw new Error(`Expected /admin/media/<hash> url, got ${url}`)
  }
  return match[1]
}

test('session message persistence normalizes image refs to local cache urls', async () => {
  const baseDir = await makeWorkspaceTempDir('waypoint-session-media-')
  const paths = makePaths(baseDir)

  const session = await createSession(paths, { name: 'Media Session' })
  await addMessage(paths, session.id, {
    role: 'user',
    content: [
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: DATA_URL_A } },
    ],
    images: [DATA_URL_A],
  })

  const loaded = await getSession(paths, session.id)
  assert.ok(loaded)
  assert.equal(loaded?.storageVersion, 2)
  const msg = loaded?.messages[0]
  assert.ok(msg)
  assert.ok(Array.isArray(msg?.images))
  const imageRef = msg?.images?.[0] ?? ''
  assert.match(imageRef, /^\/admin\/media\/[a-f0-9]{16}$/)

  const contentImage = Array.isArray(msg?.content)
    ? msg?.content.find((part) => part.type === 'image_url')
    : null
  assert.ok(contentImage && contentImage.type === 'image_url')
  assert.match(contentImage.image_url.url, /^\/admin\/media\/[a-f0-9]{16}$/)

  const hash = toHashFromAdminUrl(contentImage.image_url.url)
  const mediaPath = await getMediaPath(paths, hash)
  assert.ok(mediaPath)
  const refCount = await getMediaRefCount(paths, hash)
  assert.equal(refCount, 1)
})

test('loading legacy inline-image session lazily migrates to local refs and bumps storageVersion', async () => {
  const baseDir = await makeWorkspaceTempDir('waypoint-session-media-')
  const paths = makePaths(baseDir)

  const sessionId = 'legacy-session'
  const sessionsDir = resolveSessionsDir(paths)
  await fs.mkdir(sessionsDir, { recursive: true })
  const filePath = path.join(sessionsDir, `${sessionId}.json`)
  const now = new Date().toISOString()
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        id: sessionId,
        name: 'Legacy',
        storageVersion: 1,
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: [{ type: 'image_url', image_url: { url: DATA_URL_B } }],
            images: [DATA_URL_B],
            createdAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
      null,
      2
    ),
    'utf8'
  )

  const loaded = await getSession(paths, sessionId)
  assert.ok(loaded)
  assert.equal(loaded?.storageVersion, 2)

  const migratedImage = Array.isArray(loaded?.messages[0]?.content)
    ? loaded?.messages[0]?.content.find((part) => part.type === 'image_url')
    : null
  assert.ok(migratedImage && migratedImage.type === 'image_url')
  assert.match(migratedImage.image_url.url, /^\/admin\/media\/[a-f0-9]{16}$/)

  const reReadRaw = JSON.parse(await fs.readFile(filePath, 'utf8')) as { storageVersion: number }
  assert.equal(reReadRaw.storageVersion, 2)
})

test('eviction preserves referenced media and reports blocked evictions when only referenced remain', async () => {
  const baseDir = await makeWorkspaceTempDir('waypoint-session-media-')
  const paths = makePaths(baseDir)

  const session = await createSession(paths, { name: 'Ref Test' })
  await addMessage(paths, session.id, {
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: DATA_URL_A } }],
    images: [DATA_URL_A],
  })
  await addMessage(paths, session.id, {
    role: 'assistant',
    content: [{ type: 'image_url', image_url: { url: DATA_URL_B } }],
    images: [DATA_URL_B],
  })

  const before = await getCacheStats(paths)
  assert.equal(before.referencedCount, 2)

  // Force cache pressure with tiny limit; unreferenced candidate gets evicted first,
  // then eviction is blocked when only referenced entries remain.
  await storeMedia(paths, Buffer.from('unreferenced-bytes', 'utf8'), {
    maxSizeBytes: 1,
    mimeType: 'image/png',
  })

  const after = await getCacheStats(paths)
  assert.equal(after.referencedCount, 2)
  assert.ok(after.evictionBlockedCount >= 1)

  await deleteSession(paths, session.id)
  const finalStats = await getCacheStats(paths)
  assert.equal(finalStats.referencedCount, 0)
})
