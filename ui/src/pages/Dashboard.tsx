import { useEffect, useState } from 'react'
import { 
  Activity, 
  Clock, 
  Zap, 
  AlertTriangle, 
  TrendingUp,
  RefreshCw,
  Server
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
  type Provider
} from '@/api/client'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
} from 'recharts'

export function Dashboard() {
  const [stats, setStats] = useState<StatsAggregation | null>(null)
  const [latency, setLatency] = useState<LatencyDistribution | null>(null)
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null)
  const [providers, setProviders] = useState<Provider[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [timeWindow, setTimeWindow] = useState('24h')

  const loadData = async () => {
    setIsLoading(true)
    try {
      const [statsData, latencyData, tokenData, providersData] = await Promise.all([
        getStats(timeWindow),
        getLatencyDistribution(timeWindow),
        getTokenUsage(timeWindow),
        listProviderCatalog(),
      ])
      setStats(statsData)
      setLatency(latencyData)
      setTokenUsage(tokenData)
      setProviders(providersData)
    } catch (error) {
      console.error('Failed to load dashboard data:', error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 30000)
    return () => clearInterval(interval)
  }, [timeWindow])

  const errorRate = stats && stats.total > 0 
    ? ((stats.errors / stats.total) * 100).toFixed(1) 
    : '0.0'

  // Transform histogram data for Recharts
  const histogramData = latency?.histogram 
    ? Object.entries(latency.histogram).map(([bucket, count]) => ({
        bucket,
        count,
        percentage: latency.count > 0 ? Math.round((count / latency.count) * 100) : 0,
      }))
    : []

  // Transform token usage by day for chart
  const tokenChartData = tokenUsage?.byDay ?? []
  const totalProviderModels = providers.reduce((sum, provider) => sum + provider.models.length, 0)
  const enabledProviderModels = providers.reduce(
    (sum, provider) => sum + provider.models.filter((model) => model.enabled !== false).length,
    0
  )

  return (
    <div className="flex-1 flex flex-col h-screen min-h-0">
      {/* Header */}
      <header className="sticky top-0 z-20 h-14 border-b border-border bg-background/95 backdrop-blur flex items-center px-6 gap-4 shrink-0">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-primary" />
          <h2 className="font-mono font-semibold text-sm uppercase tracking-wider">Dashboard</h2>
        </div>
        <div className="flex-1" />
        
        {/* Time Window Selector */}
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
        
        <Button
          variant="outline"
          size="sm"
          onClick={loadData}
          disabled={isLoading}
        >
          <RefreshCw className={cn('w-3 h-3 mr-2', isLoading && 'animate-spin')} />
          Refresh
        </Button>
      </header>

      {/* Dashboard Content */}
      <div className="flex-1 min-h-0 p-6 space-y-6 overflow-auto">
        {/* Metrics Grid */}
        <div className="grid grid-cols-4 gap-4">
          <MetricCard
            label="Total Requests"
            value={stats?.total ?? 0}
            icon={Zap}
            loading={isLoading}
          />
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

        {/* Charts Row */}
        <div className="grid grid-cols-2 gap-6">
          {/* Latency Distribution Chart */}
          <div className="panel">
            <div className="panel-header">
              <Clock className="w-4 h-4 text-muted-foreground" />
              <span className="panel-title">Latency Distribution</span>
            </div>
            <div className="p-4">
              {/* Percentiles */}
              <div className="grid grid-cols-4 gap-4 mb-6">
                <PercentileCard label="P50" value={latency?.p50} />
                <PercentileCard label="P95" value={latency?.p95} />
                <PercentileCard label="P99" value={latency?.p99} />
                <PercentileCard label="Max" value={latency?.max} />
              </div>
              
              {/* Histogram Chart */}
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
                      />
                      <Bar 
                        dataKey="count" 
                        fill="hsl(var(--primary))" 
                        radius={[2, 2, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
                  No latency data available
                </div>
              )}
            </div>
          </div>

          {/* Token Usage Chart */}
          <div className="panel">
            <div className="panel-header">
              <TrendingUp className="w-4 h-4 text-muted-foreground" />
              <span className="panel-title">Token Usage Over Time</span>
            </div>
            <div className="p-4">
              {/* Summary */}
              <div className="grid grid-cols-3 gap-4 mb-6">
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

              {/* Area Chart */}
              {tokenChartData.length > 0 ? (
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={tokenChartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="tokenGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis 
                        dataKey="date" 
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
                      />
                      <Area 
                        type="monotone"
                        dataKey="tokens" 
                        stroke="hsl(var(--primary))" 
                        fillOpacity={1}
                        fill="url(#tokenGradient)"
                      />
                    </AreaChart>
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

        {/* Model Performance */}
        {stats?.byModel && Object.keys(stats.byModel).length > 0 && (
          <div className="panel">
            <div className="panel-header">
              <Zap className="w-4 h-4 text-muted-foreground" />
              <span className="panel-title">Performance by Model</span>
            </div>
            <div className="p-4">
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart 
                    data={Object.entries(stats.byModel).map(([model, data]) => ({
                      model: model.length > 20 ? model.slice(0, 17) + '...' : model,
                      requests: data.count,
                      latency: Math.round(data.avgLatencyMs),
                      tokens: data.tokens,
                    }))}
                    margin={{ top: 20, right: 30, left: 20, bottom: 60 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis 
                      dataKey="model" 
                      tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                      angle={-45}
                      textAnchor="end"
                      height={60}
                    />
                    <YAxis 
                      yAxisId="left"
                      tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                      orientation="left"
                    />
                    <YAxis 
                      yAxisId="right"
                      tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                      orientation="right"
                    />
                    <Tooltip 
                      contentStyle={{ 
                        background: 'hsl(var(--background))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '4px',
                        fontSize: '12px',
                      }}
                    />
                    <Line 
                      yAxisId="left"
                      type="monotone" 
                      dataKey="requests" 
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                      dot={{ fill: 'hsl(var(--primary))', r: 4 }}
                      name="Requests"
                    />
                    <Line 
                      yAxisId="right"
                      type="monotone" 
                      dataKey="latency" 
                      stroke="hsl(var(--warning))"
                      strokeWidth={2}
                      dot={{ fill: 'hsl(var(--warning))', r: 4 }}
                      name="Latency (ms)"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}

        {/* Providers + Models */}
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
    <div className={cn(
      'metric-card',
      variant === 'warning' && 'border-warning/50'
    )}>
      <div className="flex items-center gap-2">
        <Icon className={cn(
          'w-4 h-4',
          variant === 'warning' ? 'text-warning' : 'text-muted-foreground'
        )} />
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

function PercentileCard({ label, value }: { label: string; value?: number }) {
  return (
    <div className="text-center">
      <p className="text-2xs font-mono uppercase text-muted-foreground">{label}</p>
      <p className="text-2xl font-mono font-semibold tabular-nums">
        {value ?? '-'}
        {value !== undefined && <span className="text-sm text-muted-foreground ml-1">ms</span>}
      </p>
    </div>
  )
}
