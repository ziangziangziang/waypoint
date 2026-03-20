import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDashboardTokenChartData, buildDashboardTokenMetadata } from './dashboardTokenUsage'

test('dashboard token chart rows use total tokens only', () => {
  const rows = buildDashboardTokenChartData({
    window: '24h',
    totalTokens: 300,
    totalInputTokens: 120,
    totalOutputTokens: 180,
    totalRequests: 2,
    avgTokensPerRequest: 150,
    tokenEstimatedCount: 1,
    tokenEstimatedRate: 0.5,
    splitUnknownCount: 1,
    splitUnknownRate: 0.5,
    bucketGranularity: 'hour',
    bucketTimeZone: 'America/Chicago',
    byDay: [
      {
        date: '2026-03-17T12:00',
        count: 2,
        tokens: 300,
        estimated: 1,
        inputTokens: 120,
        outputTokens: 180,
        splitUnknown: 1,
      },
    ],
  })

  assert.deepEqual(rows, [
    {
      date: '2026-03-17T12:00',
      count: 2,
      tokens: 300,
      estimated: 1,
    },
  ])
})

test('dashboard token metadata keeps non-split status messaging', () => {
  const metadata = buildDashboardTokenMetadata(
    {
      window: '7d',
      totalTokens: 500,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRequests: 5,
      avgTokensPerRequest: 100,
      tokenEstimatedCount: 2,
      tokenEstimatedRate: 0.4,
      bucketGranularity: 'day',
      bucketTimeZone: 'UTC',
      byDay: [],
    },
    'America/Chicago',
  )

  assert.deepEqual(metadata, {
    estimatedCount: 2,
    estimatedRate: 0.4,
    granularityLabel: 'daily',
    timeZoneLabel: 'UTC',
  })
})
