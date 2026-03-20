import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { promises as fs } from 'fs'
import Fastify from 'fastify'
import { registerStatsRoutes } from '../src/routes/stats'
import { appendStats } from '../src/storage/statsRepository'
import type { RequestStats } from '../src/types'
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

function buildStat(overrides: Partial<RequestStats>): RequestStats {
  return {
    requestId: overrides.requestId ?? `req-${Math.random().toString(36).slice(2)}`,
    timestamp: overrides.timestamp ?? new Date(),
    route: overrides.route ?? '/v1/chat/completions',
    method: overrides.method ?? 'POST',
    publicModel: overrides.publicModel ?? 'gpt-4o-mini',
    endpointId: overrides.endpointId ?? 'ep-default',
    endpointName: overrides.endpointName ?? 'default',
    upstreamModel: overrides.upstreamModel ?? 'upstream',
    requestBytes: overrides.requestBytes ?? 128,
    responseBytes: overrides.responseBytes ?? 512,
    latencyMs: overrides.latencyMs ?? 150,
    statusCode: overrides.statusCode ?? 200,
    errorType: overrides.errorType,
    totalTokens: overrides.totalTokens ?? 100,
    promptTokens: overrides.promptTokens === undefined ? 50 : overrides.promptTokens,
    completionTokens: overrides.completionTokens === undefined ? 50 : overrides.completionTokens,
  }
}

test('stats routes honor exact 1h window across aggregate/latency/tokens', async () => {
  const baseDir = await makeWorkspaceTempDir('waypoint-stats-test-')
  const paths = makePaths(baseDir)
  const app = Fastify()
  await registerStatsRoutes(app, paths)

  const now = Date.now()
  await appendStats(
    paths,
    buildStat({ requestId: 'old', timestamp: new Date(now - 2 * 60 * 60 * 1000), endpointId: 'ep-1', totalTokens: 40 })
  )
  await appendStats(
    paths,
    buildStat({ requestId: 'recent', timestamp: new Date(now - 10 * 60 * 1000), endpointId: 'ep-1', totalTokens: 80 })
  )

  const statsRes = await app.inject({ method: 'GET', url: '/admin/stats?window=1h' })
  assert.equal(statsRes.statusCode, 200)
  const statsJson = statsRes.json() as {
    window: string
    total: number
    byEndpoint: Record<string, { count: number; errors: number }>
  }
  assert.equal(statsJson.window, '1h')
  assert.equal(statsJson.total, 1)

  const latencyRes = await app.inject({ method: 'GET', url: '/admin/stats/latency?window=1h' })
  assert.equal(latencyRes.statusCode, 200)
  const latencyJson = latencyRes.json() as { window: string; count: number }
  assert.equal(latencyJson.window, '1h')
  assert.equal(latencyJson.count, 1)

  const tokenRes = await app.inject({ method: 'GET', url: '/admin/stats/tokens?window=1h' })
  assert.equal(tokenRes.statusCode, 200)
  const tokenJson = tokenRes.json() as {
    window: string
    totalRequests: number
    bucketGranularity: string
    totalInputTokens: number
    totalOutputTokens: number
    splitUnknownCount: number
    splitUnknownRate: number
  }
  assert.equal(tokenJson.window, '1h')
  assert.equal(tokenJson.totalRequests, 1)
  assert.equal(tokenJson.bucketGranularity, 'hour')
  assert.equal(tokenJson.totalInputTokens, 50)
  assert.equal(tokenJson.totalOutputTokens, 50)
  assert.equal(tokenJson.splitUnknownCount, 0)
  assert.equal(tokenJson.splitUnknownRate, 0)

  await app.close()
})

test('latency route returns normalized empty payload shape', async () => {
  const baseDir = await makeWorkspaceTempDir('waypoint-stats-test-')
  const paths = makePaths(baseDir)
  const app = Fastify()
  await registerStatsRoutes(app, paths)

  const res = await app.inject({ method: 'GET', url: '/admin/stats/latency?window=1h' })
  assert.equal(res.statusCode, 200)

  const json = res.json() as {
    count: number
    min: number | null
    max: number | null
    avg: number | null
    p50: number | null
    p95: number | null
    p99: number | null
    histogram: Record<string, number>
  }

  assert.equal(json.count, 0)
  assert.equal(json.min, null)
  assert.equal(json.max, null)
  assert.equal(json.avg, null)
  assert.equal(json.p50, null)
  assert.equal(json.p95, null)
  assert.equal(json.p99, null)
  assert.deepEqual(json.histogram, {})

  await app.close()
})

test('token usage exposes hourly vs daily bucket granularity', async () => {
  const baseDir = await makeWorkspaceTempDir('waypoint-stats-test-')
  const paths = makePaths(baseDir)
  const app = Fastify()
  await registerStatsRoutes(app, paths)

  const now = Date.now()
  await appendStats(paths, buildStat({ requestId: 'h1', timestamp: new Date(now - 90 * 60 * 1000), totalTokens: 25 }))
  await appendStats(paths, buildStat({ requestId: 'h2', timestamp: new Date(now - 5 * 60 * 1000), totalTokens: 50 }))

  const hourly = await app.inject({ method: 'GET', url: '/admin/stats/tokens?window=24h' })
  assert.equal(hourly.statusCode, 200)
  const hourlyJson = hourly.json() as {
    bucketGranularity: string
    byDay: Array<{ date: string; inputTokens: number; outputTokens: number; splitUnknown: number }>
  }
  assert.equal(hourlyJson.bucketGranularity, 'hour')
  assert.ok(hourlyJson.byDay.every((row) => row.date.includes('T')))
  assert.ok(hourlyJson.byDay.every((row) => typeof row.inputTokens === 'number'))
  assert.ok(hourlyJson.byDay.every((row) => typeof row.outputTokens === 'number'))
  assert.ok(hourlyJson.byDay.every((row) => typeof row.splitUnknown === 'number'))

  const daily = await app.inject({ method: 'GET', url: '/admin/stats/tokens?window=7d' })
  assert.equal(daily.statusCode, 200)
  const dailyJson = daily.json() as {
    bucketGranularity: string
    byDay: Array<{ date: string; inputTokens: number; outputTokens: number; splitUnknown: number }>
  }
  assert.equal(dailyJson.bucketGranularity, 'day')
  assert.ok(dailyJson.byDay.every((row) => !row.date.includes('T')))
  assert.ok(dailyJson.byDay.every((row) => typeof row.inputTokens === 'number'))
  assert.ok(dailyJson.byDay.every((row) => typeof row.outputTokens === 'number'))
  assert.ok(dailyJson.byDay.every((row) => typeof row.splitUnknown === 'number'))

  await app.close()
})

test('token usage marks unknown split when only total tokens are present', async () => {
  const baseDir = await makeWorkspaceTempDir('waypoint-stats-test-')
  const paths = makePaths(baseDir)
  const app = Fastify()
  await registerStatsRoutes(app, paths)

  await appendStats(
    paths,
    buildStat({
      requestId: 'split-unknown',
      timestamp: new Date(),
      totalTokens: 42,
      promptTokens: null,
      completionTokens: null,
    })
  )

  const res = await app.inject({ method: 'GET', url: '/admin/stats/tokens?window=1h' })
  assert.equal(res.statusCode, 200)
  const json = res.json() as {
    totalTokens: number
    totalRequests: number
    totalInputTokens: number
    totalOutputTokens: number
    splitUnknownCount: number
    splitUnknownRate: number
    byDay: Array<{ tokens: number; inputTokens: number; outputTokens: number; splitUnknown: number }>
  }

  assert.equal(json.totalTokens, 42)
  assert.equal(json.totalRequests, 1)
  assert.equal(json.totalInputTokens, 0)
  assert.equal(json.totalOutputTokens, 0)
  assert.equal(json.splitUnknownCount, 1)
  assert.equal(json.splitUnknownRate, 1)
  assert.equal(json.byDay.length, 1)
  assert.equal(json.byDay[0].tokens, 42)
  assert.equal(json.byDay[0].inputTokens, 0)
  assert.equal(json.byDay[0].outputTokens, 0)
  assert.equal(json.byDay[0].splitUnknown, 1)

  await app.close()
})

test('token usage buckets follow requested timezone instead of UTC', async () => {
  const baseDir = await makeWorkspaceTempDir('waypoint-stats-test-')
  const paths = makePaths(baseDir)
  const app = Fastify()
  await registerStatsRoutes(app, paths)

  await appendStats(
    paths,
    buildStat({
      requestId: 'tz-shift',
      timestamp: new Date('2026-01-01T01:30:00.000Z'),
      totalTokens: 42,
    })
  )

  const utcRes = await app.inject({ method: 'GET', url: '/admin/stats/tokens?window=365d&timeZone=UTC' })
  assert.equal(utcRes.statusCode, 200)
  const utcJson = utcRes.json() as {
    bucketTimeZone: string
    byDay: Array<{ date: string }>
  }
  assert.equal(utcJson.bucketTimeZone, 'UTC')

  const localRes = await app.inject({
    method: 'GET',
    url: '/admin/stats/tokens?window=365d&timeZone=America/Chicago',
  })
  assert.equal(localRes.statusCode, 200)
  const localJson = localRes.json() as {
    bucketTimeZone: string
    byDay: Array<{ date: string }>
  }
  assert.equal(localJson.bucketTimeZone, 'America/Chicago')
  assert.notEqual(localJson.byDay[0]?.date, utcJson.byDay[0]?.date)

  await app.close()
})

test('stats aggregate keeps byEndpoint error counts', async () => {
  const baseDir = await makeWorkspaceTempDir('waypoint-stats-test-')
  const paths = makePaths(baseDir)
  const app = Fastify()
  await registerStatsRoutes(app, paths)

  const now = Date.now()
  await appendStats(
    paths,
    buildStat({ requestId: 'ok', timestamp: new Date(now - 2 * 60 * 1000), endpointId: 'ep-chat', statusCode: 200, totalTokens: 90 })
  )
  await appendStats(
    paths,
    buildStat({
      requestId: 'err',
      timestamp: new Date(now - 1 * 60 * 1000),
      endpointId: 'ep-chat',
      statusCode: 500,
      errorType: 'upstream_error',
      totalTokens: 30,
    })
  )

  const res = await app.inject({ method: 'GET', url: '/admin/stats?window=1h' })
  assert.equal(res.statusCode, 200)
  const json = res.json() as {
    byEndpoint: Record<string, { count: number; errors: number }>
  }

  assert.equal(json.byEndpoint['ep-chat'].count, 2)
  assert.equal(json.byEndpoint['ep-chat'].errors, 1)

  await app.close()
})
