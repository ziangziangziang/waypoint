import type { TokenUsage } from '../api/client'

export interface DashboardTokenChartRow {
  date: string
  count: number
  tokens: number
  estimated: number
}

export interface DashboardTokenMetadata {
  estimatedCount: number
  estimatedRate: number
  granularityLabel: string
  timeZoneLabel: string
}

export function buildDashboardTokenChartData(tokenUsage: TokenUsage | null | undefined): DashboardTokenChartRow[] {
  return (tokenUsage?.byDay ?? []).map((row) => ({
    date: row.date,
    count: row.count,
    tokens: row.tokens,
    estimated: row.estimated,
  }))
}

export function buildDashboardTokenMetadata(
  tokenUsage: TokenUsage | null | undefined,
  browserTimeZone: string,
): DashboardTokenMetadata {
  return {
    estimatedCount: tokenUsage?.tokenEstimatedCount ?? 0,
    estimatedRate: tokenUsage?.tokenEstimatedRate ?? 0,
    granularityLabel: tokenUsage?.bucketGranularity === 'hour' ? 'hourly' : 'daily',
    timeZoneLabel: tokenUsage?.bucketTimeZone ?? browserTimeZone,
  }
}
