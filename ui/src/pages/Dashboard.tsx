import { useEffect, useState } from 'react'
import {
  Activity,
  Clock,
  Zap,
  AlertTriangle,
  TrendingUp,
  RefreshCw,
  Server,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  getStats,
  getLatencyDistribution,
  getTokenUsage,
  listProviders as listProviderCatalog,
  type StatsAggregation,
  type LatencyDistribution,
  type TokenUsage,
  type Provider,
} from '@/api/client'
import { buildDashboardTokenChartData, buildDashboardTokenMetadata } from './dashboardTokenUsage'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ComposedChart,
  Line,
} from 'recharts'

const MODEL_ROW_DEFAULT_LIMIT = 10

export function Dashboard() {
  const [stats, setStats] = useState<StatsAggregation | null>(null)
  const [latency, setLatency] = useState<LatencyDistribution | null>(null)
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null)
  const [providers, setProviders] = useState<Provider[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [timeWindow, setTimeWindow] = useState('24h')
  const [showAllModels, setShowAllModels] = useState(false)
  const browserTimeZone = typeof Intl !== 'undefined'
    ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    : 'UTC'

  const loadData = async () => {
    setIsLoading(true)
    setLoadError(null)
    try {
      const [statsData, latencyData, tokenData, providersData] = await Promise.all([
        getStats(timeWindow),
        getLatencyDistribution(timeWindow),
        getTokenUsage(timeWindow, { timeZone: browserTimeZone }),
        listProviderCatalog(),
      ])
      setStats(statsData)
      setLatency(latencyData)
      setTokenUsage(tokenData)
      setProviders(providersData)
    } catch (error) {
      console.error('Failed to load dashboard data:', error)
      setLoadError('Failed to load dashboard data. Please retry.')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    setShowAllModels(false)
  }, [timeWindow])

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 30000)
    return () => clearInterval(interval)
  }, [timeWindow])

  const errorRate = stats && stats.total > 0 ? ((stats.errors / stats.total) * 100).toFixed(1) : '0.0'

  const histogramData = latency?.histogram
    ? Object.entries(latency.histogram).map(([bucket, count]) => ({
        bucket,
        count,
        percentage: latency.count > 0 ? Math.round((count / latency.count) * 100) : 0,
      }))
    : []

  const tokenChartData = buildDashboardTokenChartData(tokenUsage)
  const totalProviderModels = providers.reduce((sum, provider) => sum + provider.models.length, 0)
  const enabledProviderModels = providers.reduce(
    (sum, provider) => sum + provider.models.filter((model) => model.enabled !== false).length,
    0
  )

  const modelRows = Object.entries(stats?.byModel ?? {})
    .map(([model, data]) => ({
      model,
      requests: data.count,
      latencyMs: Math.round(data.avgLatencyMs),
      tokens: data.tokens,
    }))
    .sort((a, b) => b.tokens - a.tokens)

  const visibleModelRows = showAllModels ? modelRows : modelRows.slice(0, MODEL_ROW_DEFAULT_LIMIT)
  const maxModelRequests = Math.max(1, ...modelRows.map((row) => row.requests))
  const maxModelLatency = Math.max(1, ...modelRows.map((row) => row.latencyMs))
  const maxModelTokens = Math.max(1, ...modelRows.map((row) => row.tokens))

  const endpointRows = Object.entries(stats?.byEndpoint ?? {})
    .map(([endpoint, data]) => ({
      endpoint,
      requests: data.count,
      errors: data.errors,
      errorRate: data.count > 0 ? (data.errors / data.count) * 100 : 0,
      avgLatencyMs: Math.round(data.avgLatencyMs),
      tokens: data.tokens,
    }))
    .sort((a, b) => {
      if (b.errorRate !== a.errorRate) return b.errorRate - a.errorRate
      return b.requests - a.requests
    })

  const {
    estimatedCount: tokenEstimatedCount,
    estimatedRate: tokenEstimatedRate,
    granularityLabel: tokenGranularityLabel,
    timeZoneLabel: tokenTimeZoneLabel,
  } = buildDashboardTokenMetadata(tokenUsage, browserTimeZone)

  return (
    <div className="flex-1 flex flex-col h-full min-h-0">
      <header className="sticky top-0 z-20 h-14 border-b border-border bg-background/95 backdrop-blur flex items-center px-6 gap-4 shrink-0">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-primary" />
          <h2 className="font-mono font-semibold text-sm uppercase tracking-wider">Dashboard</h2>
        </div>
        <div className="flex-1" />

        <div className="flex items-center gap-1 bg-secondary rounded-md p-1">
          {['1h', '24h', '7d'].map((window) => (
            <button
              key={window}
              onClick={() => setTimeWindow(window)}
              className={cn(
                'px-3 py-1 text-xs font-mono rounded transition-colors',
                timeWindow === window
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {window}
            </button>
          ))}
        </div>

        <Button variant="outline" size="sm" onClick={loadData} disabled={isLoading}>
          <RefreshCw className={cn('w-3 h-3 mr-2', isLoading && 'animate-spin')} />
          Refresh
        </Button>
      </header>

      <div className="flex-1 min-h-0 p-6 space-y-6 overflow-auto">
        {loadError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {loadError}
          </div>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard label="Total Requests" value={stats?.total ?? 0} icon={Zap} loading={isLoading} />
          <MetricCard
            label="Avg Latency"
            value={stats?.avgLatencyMs ?? 0}
            unit="ms"
            icon={Clock}
            loading={isLoading}
          />
          <MetricCard
            label="Error Rate"
            value={errorRate}
            unit="%"
            icon={AlertTriangle}
            loading={isLoading}
            variant={Number(errorRate) > 5 ? 'warning' : 'default'}
          />
          <MetricCard
            label="Tokens/Hour"
            value={stats?.tokensPerHour ?? 0}
            icon={TrendingUp}
            loading={isLoading}
          />
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div className="panel">
            <div className="panel-header">
              <Clock className="w-4 h-4 text-muted-foreground" />
              <span className="panel-title">Latency Distribution</span>
            </div>
            <div className="p-4">
              <div className="grid grid-cols-4 gap-4 mb-6">
                <PercentileCard label="P50" value={latency?.p50} />
                <PercentileCard label="P95" value={latency?.p95} />
                <PercentileCard label="P99" value={latency?.p99} />
                <PercentileCard label="Max" value={latency?.max} />
              </div>

              {histogramData.length > 0 ? (
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={histogramData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis
                        dataKey="bucket"
                        tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                        axisLine={{ stroke: 'hsl(var(--border))' }}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                        axisLine={{ stroke: 'hsl(var(--border))' }}
                      />
                      <Tooltip
                        contentStyle={{
                          background: 'hsl(var(--background))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '4px',
                          fontSize: '12px',
                        }}
                        labelStyle={{ color: 'hsl(var(--foreground))' }}
                        formatter={(value: number, _name, entry: { payload?: { percentage?: number } }) => {
                          const pct = entry?.payload?.percentage ?? 0
                          return [`${value.toLocaleString()} (${pct}%)`, 'Count']
                        }}
                      />
                      <Bar dataKey="count" fill="hsl(var(--primary))" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
                  No latency samples in selected window
                </div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <TrendingUp className="w-4 h-4 text-muted-foreground" />
              <span className="panel-title">Token Usage Over Time</span>
            </div>
            <div className="p-4">
              <div className="grid grid-cols-3 gap-4 mb-3">
                <div className="text-center">
                  <p className="text-2xs font-mono uppercase text-muted-foreground">Total</p>
                  <p className="text-xl font-mono font-semibold tabular-nums">
                    {(tokenUsage?.totalTokens ?? 0).toLocaleString()}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-2xs font-mono uppercase text-muted-foreground">Requests</p>
                  <p className="text-xl font-mono font-semibold tabular-nums">
                    {(tokenUsage?.totalRequests ?? 0).toLocaleString()}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-2xs font-mono uppercase text-muted-foreground">Avg/Req</p>
                  <p className="text-xl font-mono font-semibold tabular-nums">
                    {Math.round(tokenUsage?.avgTokensPerRequest ?? 0).toLocaleString()}
                  </p>
                </div>
              </div>

              <p className="text-2xs text-muted-foreground mb-4">
                Estimated token entries: {tokenEstimatedCount.toLocaleString()} ({(tokenEstimatedRate * 100).toFixed(1)}%)
                {' '}<span className="font-mono uppercase">{tokenGranularityLabel}</span>
                {' '}<span className="font-mono uppercase">({tokenTimeZoneLabel})</span>
              </p>

              {tokenChartData.length > 0 ? (
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={tokenChartData} margin={{ top: 0, right: 6, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                        axisLine={{ stroke: 'hsl(var(--border))' }}
                        tickFormatter={(value: string) => formatTokenBucketLabel(value)}
                      />
                      <YAxis
                        yAxisId="requests"
                        tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                        axisLine={{ stroke: 'hsl(var(--border))' }}
                        allowDecimals={false}
                      />
                      <YAxis
                        yAxisId="tokens"
                        orientation="right"
                        tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                        axisLine={{ stroke: 'hsl(var(--border))' }}
                      />
                      <Tooltip
                        labelFormatter={(value) => formatTokenBucketTooltip(String(value), tokenTimeZoneLabel)}
                        content={({ active, label, payload }) => {
                          if (!active || !payload || payload.length === 0) return null
                          const row = payload[0]?.payload as
                            | { count?: number; tokens?: number; estimated?: number }
                            | undefined
                          return (
                            <div
                              style={{
                                background: 'hsl(var(--background))',
                                border: '1px solid hsl(var(--border))',
                                borderRadius: '4px',
                                fontSize: '12px',
                                padding: '8px',
                              }}
                            >
                              <div className="mb-1 font-mono">{formatTokenBucketTooltip(String(label), tokenTimeZoneLabel)}</div>
                              <div>Requests: {(row?.count ?? 0).toLocaleString()}</div>
                              <div>Total tokens: {(row?.tokens ?? 0).toLocaleString()}</div>
                              <div>Estimated entries: {(row?.estimated ?? 0).toLocaleString()}</div>
                            </div>
                          )
                        }}
                      />
                      <Bar yAxisId="requests" dataKey="count" name="Requests" fill="hsl(var(--muted))" radius={[2, 2, 0, 0]} />
                      <Line yAxisId="tokens" type="monotone" dataKey="tokens" name="Total tokens" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
                  No token usage data available
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <Zap className="w-4 h-4 text-muted-foreground" />
            <span className="panel-title">Performance by Model</span>
            <span className="text-2xs text-muted-foreground ml-auto">Sorted by tokens</span>
          </div>
          <div className="p-4">
            {modelRows.length === 0 ? (
              <div className="text-muted-foreground text-sm">No model-level request data available</div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-2xs font-mono uppercase text-muted-foreground">
                        <th className="py-2 text-left">Model</th>
                        <th className="py-2 text-right">Requests</th>
                        <th className="py-2 text-right">Avg Latency (ms)</th>
                        <th className="py-2 text-right">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleModelRows.map((row) => (
                        <tr key={row.model} className="border-b border-border/50 last:border-0 align-top">
                          <td className="py-2 pr-3" title={row.model}>
                            <div className="max-w-[340px] truncate font-mono text-xs">{row.model}</div>
                          </td>
                          <td className="py-2 pl-3">
                            <div className="flex justify-end">
                              <MiniBar value={row.requests} max={maxModelRequests} text={row.requests.toLocaleString()} />
                            </div>
                          </td>
                          <td className="py-2 pl-3">
                            <div className="flex justify-end">
                              <MiniBar
                                value={row.latencyMs}
                                max={maxModelLatency}
                                text={row.latencyMs.toLocaleString()}
                                tone="warning"
                              />
                            </div>
                          </td>
                          <td className="py-2 pl-3">
                            <div className="flex justify-end">
                              <MiniBar value={row.tokens} max={maxModelTokens} text={row.tokens.toLocaleString()} tone="accent" />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {modelRows.length > MODEL_ROW_DEFAULT_LIMIT && (
                  <div className="mt-3 flex justify-end">
                    <Button variant="outline" size="sm" onClick={() => setShowAllModels((prev) => !prev)}>
                      {showAllModels ? 'Show less' : `Show more (${modelRows.length - MODEL_ROW_DEFAULT_LIMIT})`}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <AlertTriangle className="w-4 h-4 text-muted-foreground" />
            <span className="panel-title">Endpoint Quality</span>
            <span className="text-2xs text-muted-foreground ml-auto">Sorted by error rate</span>
          </div>
          <div className="p-4">
            {endpointRows.length === 0 ? (
              <div className="text-muted-foreground text-sm">No endpoint-level request data available</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-2xs font-mono uppercase text-muted-foreground">
                      <th className="py-2 text-left">Endpoint</th>
                      <th className="py-2 text-right">Requests</th>
                      <th className="py-2 text-right">Errors</th>
                      <th className="py-2 text-right">Error Rate</th>
                      <th className="py-2 text-right">Avg Latency</th>
                      <th className="py-2 text-right">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {endpointRows.map((row) => (
                      <tr key={row.endpoint} className="border-b border-border/50 last:border-0">
                        <td className="py-2 pr-3 font-mono text-xs">{row.endpoint}</td>
                        <td className="py-2 text-right font-mono tabular-nums">{row.requests.toLocaleString()}</td>
                        <td className="py-2 text-right font-mono tabular-nums">{row.errors.toLocaleString()}</td>
                        <td className="py-2 text-right font-mono tabular-nums">{row.errorRate.toFixed(1)}%</td>
                        <td className="py-2 text-right font-mono tabular-nums">{row.avgLatencyMs.toLocaleString()}ms</td>
                        <td className="py-2 text-right font-mono tabular-nums">{row.tokens.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <Server className="w-4 h-4 text-muted-foreground" />
            <span className="panel-title">Providers & Models</span>
            <span className="text-2xs text-muted-foreground ml-auto">
              {providers.length} providers / {totalProviderModels} models
            </span>
          </div>
          <div className="divide-y divide-border">
            {providers.length === 0 && (
              <div className="p-8 text-center text-muted-foreground">
                <p>No providers configured</p>
                <p className="text-xs mt-1">Import providers via CLI: waypoint provider import</p>
              </div>
            )}
            {providers.map((provider) => (
              <div key={provider.id} className="p-4">
                <div className="flex items-center gap-4">
                  <div className={cn('status-dot', provider.enabled ? 'status-dot-live' : 'status-dot-down')} />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{provider.id}</p>
                    <p className="text-xs text-muted-foreground truncate font-mono">{provider.baseUrl}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-mono tabular-nums">
                      {provider.models.filter((model) => model.enabled !== false).length}/{provider.models.length}
                    </p>
                    <p className="text-2xs text-muted-foreground">enabled models</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-mono uppercase px-2 py-0.5 rounded bg-secondary">
                      {provider.protocolRaw ?? provider.protocol}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="px-4 pb-4 pt-2 text-xs text-muted-foreground">
            Enabled models: {enabledProviderModels} / {totalProviderModels}
          </div>
        </div>
      </div>
    </div>
  )
}

function formatTokenBucketLabel(value: string): string {
  return value.includes('T') ? value.slice(11, 16) : value.slice(5)
}

function formatTokenBucketTooltip(value: string, timeZone: string): string {
  const label = value.includes('T') ? `${value.replace('T', ' ')}` : value
  return `${label} (${timeZone})`
}

interface MetricCardProps {
  label: string
  value: number | string
  unit?: string
  icon: React.ElementType
  loading?: boolean
  variant?: 'default' | 'warning'
}

function MetricCard({ label, value, unit, icon: Icon, loading, variant = 'default' }: MetricCardProps) {
  return (
    <div className={cn('metric-card', variant === 'warning' && 'border-warning/50')}>
      <div className="flex items-center gap-2">
        <Icon className={cn('w-4 h-4', variant === 'warning' ? 'text-warning' : 'text-muted-foreground')} />
        <span className="metric-label">{label}</span>
      </div>
      {loading ? (
        <div className="skeleton h-8 w-24 mt-1" />
      ) : (
        <p className="metric-value">
          {typeof value === 'number' ? value.toLocaleString() : value}
          {unit && <span className="metric-unit">{unit}</span>}
        </p>
      )}
    </div>
  )
}

function PercentileCard({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="text-center">
      <p className="text-2xs font-mono uppercase text-muted-foreground">{label}</p>
      <p className="text-2xl font-mono font-semibold tabular-nums">
        {value ?? '-'}
        {value !== null && value !== undefined && <span className="text-sm text-muted-foreground ml-1">ms</span>}
      </p>
    </div>
  )
}

function MiniBar({
  value,
  max,
  text,
  tone = 'default',
}: {
  value: number
  max: number
  text: string
  tone?: 'default' | 'warning' | 'accent'
}) {
  const width = `${Math.max(8, Math.round((value / max) * 100))}%`
  const barClass =
    tone === 'warning'
      ? 'bg-warning/30'
      : tone === 'accent'
      ? 'bg-primary/40'
      : 'bg-secondary-foreground/20'

  return (
    <div className="w-[170px]">
      <div className="relative h-6 rounded bg-secondary/40 overflow-hidden">
        <div className={cn('absolute inset-y-0 left-0 rounded', barClass)} style={{ width }} />
        <div className="relative h-full px-2 flex items-center justify-end font-mono text-xs tabular-nums">{text}</div>
      </div>
    </div>
  )
}
