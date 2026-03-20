import { useEffect, useMemo, useRef, useState } from 'react'
import { Gauge, Loader2, Play, RefreshCw, MessageSquareText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  BenchmarkCapabilityMatrix,
  BenchmarkExampleSummary,
  BenchmarkRunEvent,
  BenchmarkRunRecord,
  BenchmarkRunSummary,
  getBenchmarkRun,
  listBenchmarkCapabilities,
  listBenchmarkExamples,
  listBenchmarkRuns,
  listModels,
  startBenchmarkRun,
  type Model,
} from '@/api/client'

type RunStatus = 'running' | 'completed' | 'failed'

type ModelLeaderboardRow = {
  model: string
  runCount: number
  scenarioCount: number
  avgPassRate: number
  avgP95LatencyMs: number
  totalTokens: number
  totalFailovers: number
}

type ShowcaseExchange = {
  id: string
  timestamp?: string
  mode: string
  model: string
  scenarioInput: string
  requestPath: string
  statusCode: number
  contentType: string
  endpointName?: string
  upstreamModel?: string
  toolTrace: Array<{
    kind: 'tool_call' | 'tool_result'
    toolName: string
    toolCallId?: string
    argumentsText?: string
    contentText?: string
  }>
  requestPayload: unknown
  responsePayload: unknown
}

const SUITES = ['showcase', 'smoke', 'proxy', 'agent', 'pool_smoke', 'omni_call_smoke', 'capabilities']
const PROFILES = ['local', 'ci']

export function Benchmark() {
  const [runs, setRuns] = useState<BenchmarkRunSummary[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [examples, setExamples] = useState<BenchmarkExampleSummary[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedRun, setSelectedRun] = useState<BenchmarkRunRecord | null>(null)
  const [events, setEvents] = useState<BenchmarkRunEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [suite, setSuite] = useState('showcase')
  const [profile, setProfile] = useState('local')
  const [scenarioPath, setScenarioPath] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedExampleId, setSelectedExampleId] = useState('')
  const [showRaw, setShowRaw] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modelLeaderboard, setModelLeaderboard] = useState<ModelLeaderboardRow[]>([])
  const [capabilityMatrix, setCapabilityMatrix] = useState<BenchmarkCapabilityMatrix | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

  const loadRuns = async () => {
    try {
      const response = await listBenchmarkRuns()
      setRuns(response.data)
      if (!selectedRunId && response.data.length > 0) {
        setSelectedRunId(response.data[0].id)
      }
    } catch (err) {
      console.error('Failed to load benchmark runs:', err)
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const loadCapabilities = async () => {
    try {
      const response = await listBenchmarkCapabilities(7)
      setCapabilityMatrix(response)
    } catch (err) {
      console.error('Failed to load benchmark capabilities:', err)
    }
  }

  const loadModels = async () => {
    try {
      const response = await listModels()
      setModels(response.data)
    } catch (err) {
      console.error('Failed to load models:', err)
    }
  }

  const loadExamples = async (suiteName: string) => {
    try {
      const response = await listBenchmarkExamples(suiteName)
      setExamples(response.data)
      setSelectedExampleId((current) => {
        if (response.data.some((example) => example.id === current)) return current
        return response.data[0]?.id ?? ''
      })
    } catch (err) {
      console.error('Failed to load benchmark examples:', err)
      setExamples([])
      setSelectedExampleId('')
    }
  }

  useEffect(() => {
    void loadRuns()
    void loadModels()
    void loadCapabilities()
    void loadExamples(suite)
    const timer = setInterval(() => {
      void loadRuns()
      void loadCapabilities()
    }, 5000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    void loadExamples(suite)
  }, [suite])

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRun(null)
      setEvents([])
      return
    }

    const loadRun = async () => {
      try {
        const run = await getBenchmarkRun(selectedRunId)
        setSelectedRun(run)
        setEvents((run.events ?? []).slice(-500))
      } catch (err) {
        console.error('Failed to load benchmark run:', err)
      }
    }

    void loadRun()
    const pollTimer = setInterval(() => {
      void loadRun()
    }, 2500)

    eventSourceRef.current?.close()
    eventSourceRef.current = null

    const selectedSummary = runs.find((run) => run.id === selectedRunId)
    if (selectedSummary?.status === 'running') {
      const source = new EventSource(`/admin/benchmarks/runs/${encodeURIComponent(selectedRunId)}/events`)
      source.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as BenchmarkRunEvent
          setEvents((prev) => [...prev, event].slice(-500))
        } catch {
          // Ignore malformed events.
        }
      }
      source.onerror = () => {
        source.close()
      }
      eventSourceRef.current = source
    }

    return () => {
      clearInterval(pollTimer)
      eventSourceRef.current?.close()
      eventSourceRef.current = null
    }
  }, [selectedRunId, runs])

  useEffect(() => {
    const buildLeaderboard = async () => {
      const completedRunIds = runs
        .filter((run) => run.status === 'completed')
        .slice(0, 20)
        .map((run) => run.id)
      const details = await Promise.all(
        completedRunIds.map(async (id) => {
          try {
            return await getBenchmarkRun(id)
          } catch {
            return null
          }
        })
      )
      const rows = aggregateModelLeaderboard(details.filter((item): item is BenchmarkRunRecord => item !== null))
      setModelLeaderboard(rows)
    }
    void buildLeaderboard()
  }, [runs])

  const startRun = async () => {
    setStarting(true)
    setError(null)
    try {
      const executionMode = suite === 'showcase' ? 'showcase' : 'diagnostic'
      const run = await startBenchmarkRun({
        suite,
        exampleId: suite === 'showcase' && selectedExampleId ? selectedExampleId : undefined,
        profile,
        scenarioPath: scenarioPath.trim() || undefined,
        modelOverride: selectedModel || undefined,
        executionMode,
        updateCapCache: suite === 'capabilities',
        capTtlDays: 7,
      })
      setSelectedRunId(run.id)
      await loadRuns()
      await loadCapabilities()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  const progress = useMemo(() => {
    const total = selectedRun?.progress?.totalScenarios ?? 0
    const complete = selectedRun?.progress?.completedScenarios ?? 0
    const percent = total > 0 ? Math.min(100, Math.round((complete / total) * 100)) : 0
    return { total, complete, percent }
  }, [selectedRun])

  const activeExample = useMemo(() => {
    const reportDetails = selectedRun?.report?.scenarioDetails ?? []
    const fromRun = reportDetails.find((detail) => detail.id === selectedExampleId)?.example ?? reportDetails[0]?.example
    if (fromRun) return fromRun
    return examples.find((example) => example.id === selectedExampleId) ?? examples[0] ?? null
  }, [examples, selectedExampleId, selectedRun])

  const activeScenarioDetail = useMemo(() => {
    const details = selectedRun?.report?.scenarioDetails ?? []
    if (details.length === 0) return null
    return details.find((detail) => detail.id === selectedExampleId) ?? details[0]
  }, [selectedExampleId, selectedRun])

  const liveTrace = useMemo<ShowcaseExchange[]>(() => {
    const traceEvents = events.filter((event) => event.type === 'exchange' && event.exchange)
    if (traceEvents.length > 0) {
      return traceEvents.map((event, index) => ({
        id: `${event.timestamp}-${index}`,
        timestamp: event.timestamp,
        mode: event.exchange?.mode ?? 'unknown',
        model: event.exchange?.model ?? 'unknown',
        scenarioInput: event.exchange?.scenarioInput ?? '',
        requestPath: event.exchange?.requestPath ?? '',
        statusCode: event.exchange?.statusCode ?? 0,
        contentType: event.exchange?.contentType ?? '',
        endpointName: event.exchange?.endpointName,
        upstreamModel: event.exchange?.upstreamModel,
        toolTrace: event.exchange?.toolTrace ?? [],
        requestPayload: showRaw ? event.exchange?.requestRaw : event.exchange?.requestSanitized,
        responsePayload: showRaw ? event.exchange?.responseRaw : event.exchange?.responseSanitized,
      }))
    }

    return (activeScenarioDetail?.exchanges ?? []).map((exchange, index) => ({
      id: `${activeScenarioDetail?.id ?? 'detail'}-${index}`,
      timestamp: exchange.timestamp,
      mode: exchange.mode,
      model: exchange.model,
      scenarioInput: activeScenarioDetail?.example?.inputPreview ?? '',
      requestPath: exchange.requestPath,
      statusCode: exchange.statusCode,
      contentType: exchange.contentType,
      endpointName: exchange.endpointName,
      upstreamModel: exchange.upstreamModel,
      toolTrace: exchange.toolTrace,
      requestPayload: exchange.requestSanitized,
      responsePayload: exchange.responseSanitized,
    }))
  }, [activeScenarioDetail, events, showRaw])

  return (
    <div className="flex-1 flex flex-col h-full min-h-0">
      <header className="sticky top-0 z-20 h-14 border-b border-border bg-background/95 backdrop-blur flex items-center px-6 gap-4 shrink-0">
        <div className="flex items-center gap-2">
          <Gauge className="w-4 h-4 text-primary" />
          <h2 className="font-mono font-semibold text-sm uppercase tracking-wider">Benchmark</h2>
        </div>
        <div className="text-xs text-muted-foreground font-mono">Live examples first, diagnostics second</div>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => { void loadRuns(); void loadModels(); void loadExamples(suite) }} disabled={loading}>
          <RefreshCw className={cn('w-3 h-3 mr-2', loading && 'animate-spin')} />
          Refresh
        </Button>
      </header>

      <div className="flex-1 min-h-0 grid grid-cols-[320px_1fr] gap-0">
        <aside className="border-r border-border p-4 space-y-4 overflow-auto">
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">Run Example</span>
            </div>
            <div className="p-3 space-y-3">
              <label className="text-xs text-muted-foreground block">
                Benchmark Path
                <select
                  className="mt-1 w-full bg-input border border-border rounded px-2 py-1 text-sm font-mono"
                  value={suite}
                  onChange={(event) => setSuite(event.target.value)}
                >
                  {SUITES.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </label>

              {suite === 'showcase' && (
                <label className="text-xs text-muted-foreground block">
                  Example
                  <select
                    className="mt-1 w-full bg-input border border-border rounded px-2 py-1 text-sm font-mono"
                    value={selectedExampleId}
                    onChange={(event) => setSelectedExampleId(event.target.value)}
                  >
                    {examples.map((example) => (
                      <option key={example.id} value={example.id}>{example.title}</option>
                    ))}
                    {examples.length === 0 && <option value="">No examples</option>}
                  </select>
                </label>
              )}

              <label className="text-xs text-muted-foreground block">
                Profile
                <select
                  className="mt-1 w-full bg-input border border-border rounded px-2 py-1 text-sm font-mono"
                  value={profile}
                  onChange={(event) => setProfile(event.target.value)}
                >
                  {PROFILES.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </label>

              <label className="text-xs text-muted-foreground block">
                Model Override
                <select
                  className="mt-1 w-full bg-input border border-border rounded px-2 py-1 text-sm font-mono"
                  value={selectedModel}
                  onChange={(event) => setSelectedModel(event.target.value)}
                >
                  <option value="">(auto)</option>
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>{model.id}</option>
                  ))}
                </select>
              </label>

              <label className="text-xs text-muted-foreground block">
                Custom Scenario File
                <input
                  className="mt-1 w-full bg-input border border-border rounded px-2 py-1 text-sm font-mono"
                  value={scenarioPath}
                  onChange={(event) => setScenarioPath(event.target.value)}
                  placeholder="optional"
                />
              </label>

              <p className="text-2xs text-muted-foreground">
                {suite === 'showcase'
                  ? 'Showcase runs a single visible replay so the user can inspect the exact exchange.'
                  : 'Diagnostic suites keep the older benchmark behavior and capability matrix.'}
              </p>

              <Button className="w-full" onClick={startRun} disabled={starting || (suite === 'showcase' && !selectedExampleId)}>
                {starting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
                Start
              </Button>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">Runs</span>
            </div>
            <div className="max-h-[56vh] overflow-auto divide-y divide-border">
              {runs.map((run) => (
                <button
                  key={run.id}
                  className={cn(
                    'w-full text-left px-3 py-2 hover:bg-secondary/50 transition-colors',
                    selectedRunId === run.id && 'bg-secondary'
                  )}
                  onClick={() => setSelectedRunId(run.id)}
                >
                  <p className="text-xs font-mono truncate">{run.id}</p>
                  <p className="text-2xs text-muted-foreground">{run.suite ?? 'custom'}{run.exampleId ? ` • ${run.exampleId}` : ''}</p>
                  <p className={cn('text-2xs uppercase font-mono', statusClass(run.status))}>{run.status}</p>
                </button>
              ))}
              {runs.length === 0 && (
                <div className="px-3 py-4 text-xs text-muted-foreground">No benchmark runs yet.</div>
              )}
            </div>
          </div>
        </aside>

        <section className="min-h-0 overflow-auto p-6 space-y-6">
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">Progress</span>
              <span className="text-2xs text-muted-foreground ml-auto">
                {progress.complete}/{progress.total}
              </span>
            </div>
            <div className="p-4 space-y-2">
              <div className="w-full h-2 rounded bg-secondary overflow-hidden">
                <div className="h-full bg-primary transition-all duration-300" style={{ width: `${progress.percent}%` }} />
              </div>
              <p className="text-xs text-muted-foreground font-mono">
                {selectedRun?.progress?.currentScenarioId
                  ? `Current: ${selectedRun.progress.currentScenarioId}`
                  : 'Idle'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div className="panel min-h-[320px]">
              <div className="panel-header">
                <span className="panel-title">What This Demonstrates</span>
              </div>
              <div className="p-4 space-y-3 text-sm">
                {activeExample ? (
                  <>
                    <div>
                      <p className="text-2xs uppercase text-muted-foreground mb-1">Title</p>
                      <p className="font-medium">{activeExample.title}</p>
                    </div>
                    <div>
                      <p className="text-2xs uppercase text-muted-foreground mb-1">Goal</p>
                      <p>{activeExample.userVisibleGoal}</p>
                    </div>
                    <div>
                      <p className="text-2xs uppercase text-muted-foreground mb-1">Input</p>
                      <pre className="text-xs font-mono whitespace-pre-wrap break-words">{activeExample.inputPreview}</pre>
                    </div>
                    <div>
                      <p className="text-2xs uppercase text-muted-foreground mb-1">Success</p>
                      <p>{activeExample.successCriteria}</p>
                    </div>
                    <div>
                      <p className="text-2xs uppercase text-muted-foreground mb-1">Expected Highlights</p>
                      <div className="flex flex-wrap gap-2">
                        {activeExample.expectedHighlights.map((item) => (
                          <span key={item} className="rounded border border-border px-2 py-1 text-2xs font-mono text-muted-foreground">{item}</span>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No showcase example selected.</p>
                )}
              </div>
            </div>

            <div className="panel min-h-[320px]">
              <div className="panel-header">
                <span className="panel-title">Verdict</span>
              </div>
              <div className="p-4 space-y-3 text-sm">
                {activeScenarioDetail ? (
                  <>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={cn(
                        'rounded border px-2 py-1 text-2xs font-mono',
                        activeScenarioDetail.status === 'passed'
                          ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
                          : activeScenarioDetail.status === 'skipped'
                            ? 'border-amber-500/40 text-amber-300 bg-amber-500/10'
                            : 'border-red-500/40 text-red-300 bg-red-500/10'
                      )}>
                        {activeScenarioDetail.status}
                      </span>
                      <span className="text-2xs font-mono text-muted-foreground">{activeScenarioDetail.model}</span>
                    </div>
                    <div>
                      <p className="text-2xs uppercase text-muted-foreground mb-1">Reason</p>
                      <p>{activeScenarioDetail.verdict}</p>
                    </div>
                    <div>
                      <p className="text-2xs uppercase text-muted-foreground mb-1">Final Response</p>
                      <pre className="text-xs font-mono whitespace-pre-wrap break-words">{activeScenarioDetail.finalResponsePreview || 'n/a'}</pre>
                    </div>
                    <div>
                      <p className="text-2xs uppercase text-muted-foreground mb-1">Tools Used</p>
                      <p className="text-xs font-mono">{activeScenarioDetail.usedToolNames.length > 0 ? activeScenarioDetail.usedToolNames.join(', ') : 'none'}</p>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Run an example to capture a verdict.</p>
                )}
              </div>
            </div>
          </div>

          <div className="panel min-h-[420px]">
            <div className="panel-header">
              <MessageSquareText className="w-4 h-4 text-muted-foreground" />
              <span className="panel-title">Live Show</span>
              <button
                className="ml-auto text-2xs px-2 py-1 rounded bg-secondary hover:bg-secondary/80"
                onClick={() => setShowRaw((prev) => !prev)}
              >
                {showRaw ? 'Raw' : 'Sanitized'}
              </button>
            </div>
            <div className="p-4 space-y-3 max-h-[640px] overflow-auto">
              {liveTrace.map((exchange) => (
                <TraceCard key={exchange.id} exchange={exchange} />
              ))}
              {liveTrace.length === 0 && (
                <p className="text-xs text-muted-foreground">No request/response trace yet.</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div className="panel min-h-[320px]">
              <div className="panel-header">
                <span className="panel-title">Model Leaderboard (Diagnostics)</span>
              </div>
              <div className="p-4 overflow-auto max-h-[360px]">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left py-1">Model</th>
                      <th className="text-right py-1">Runs</th>
                      <th className="text-right py-1">Scenarios</th>
                      <th className="text-right py-1">Pass</th>
                      <th className="text-right py-1">P95</th>
                      <th className="text-right py-1">Tokens</th>
                      <th className="text-right py-1">Failovers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelLeaderboard.map((row) => (
                      <tr key={row.model} className="border-t border-border/40">
                        <td className="py-1 pr-2 font-mono">{row.model}</td>
                        <td className="py-1 text-right">{row.runCount}</td>
                        <td className="py-1 text-right">{row.scenarioCount}</td>
                        <td className="py-1 text-right">{`${Math.round(row.avgPassRate * 100)}%`}</td>
                        <td className="py-1 text-right">{`${Math.round(row.avgP95LatencyMs)}ms`}</td>
                        <td className="py-1 text-right">{row.totalTokens}</td>
                        <td className="py-1 text-right">{row.totalFailovers}</td>
                      </tr>
                    ))}
                    {modelLeaderboard.length === 0 && (
                      <tr>
                        <td colSpan={7} className="py-3 text-center text-muted-foreground">
                          No model history available yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="panel min-h-[320px]">
              <div className="panel-header">
                <span className="panel-title">Capabilities (Diagnostics)</span>
                <span className="text-2xs text-muted-foreground ml-auto">
                  TTL {capabilityMatrix?.ttlDays ?? 7}d
                </span>
              </div>
              <div className="p-4 overflow-auto max-h-[360px]">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left py-1">Model</th>
                      <th className="text-left py-1">Freshness</th>
                      <th className="text-left py-1">Chat</th>
                      <th className="text-left py-1">Tools</th>
                      <th className="text-left py-1">Embed</th>
                      <th className="text-left py-1">Image</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(capabilityMatrix?.models ?? []).map((model) => (
                      <tr key={model.model} className="border-t border-border/40">
                        <td className="py-1 pr-2 font-mono">{model.model}</td>
                        <td className={cn('py-1', model.freshness === 'fresh' ? 'text-success' : 'text-warning')}>
                          {model.freshness}
                        </td>
                        <td className="py-1">{model.findings.chat_basic.status}</td>
                        <td className="py-1">{model.findings.chat_tool_calls.status}</td>
                        <td className="py-1">{model.findings.embeddings.status}</td>
                        <td className="py-1">{model.findings.images_generation.status}</td>
                      </tr>
                    ))}
                    {(capabilityMatrix?.models.length ?? 0) === 0 && (
                      <tr>
                        <td colSpan={6} className="py-3 text-center text-muted-foreground">
                          No capability snapshots yet. Run suite "capabilities" to populate cache.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function TraceCard({ exchange }: { exchange: ShowcaseExchange }) {
  return (
    <div className="border border-border rounded-md p-3 space-y-3">
      <div className="flex items-center gap-2 flex-wrap text-2xs text-muted-foreground font-mono">
        <span>{exchange.timestamp ?? 'saved-trace'}</span>
        <span>•</span>
        <span>{exchange.mode}</span>
        <span>•</span>
        <span>{exchange.model}</span>
        {exchange.endpointName && (
          <>
            <span>•</span>
            <span>{exchange.endpointName}</span>
          </>
        )}
      </div>

      <div className="bg-secondary/30 rounded p-2">
        <p className="text-2xs uppercase text-muted-foreground mb-1">Scenario Input</p>
        <pre className="text-2xs font-mono whitespace-pre-wrap break-words">{exchange.scenarioInput}</pre>
      </div>

      <div className="bg-secondary/30 rounded p-2">
        <p className="text-2xs uppercase text-muted-foreground mb-1">Wire Request {exchange.requestPath}</p>
        <pre className="text-2xs font-mono whitespace-pre-wrap break-words">{safeStringify(exchange.requestPayload)}</pre>
      </div>

      {exchange.toolTrace.length > 0 && (
        <div className="bg-secondary/30 rounded p-2 space-y-2">
          <p className="text-2xs uppercase text-muted-foreground">Tool Trace</p>
          {exchange.toolTrace.map((step, index) => (
            <div key={`${step.kind}-${step.toolName}-${index}`} className="border border-border/60 rounded p-2">
              <p className="text-2xs font-mono text-muted-foreground">{step.kind} • {step.toolName}</p>
              {step.argumentsText && <pre className="text-2xs font-mono whitespace-pre-wrap break-words mt-1">{step.argumentsText}</pre>}
              {step.contentText && <pre className="text-2xs font-mono whitespace-pre-wrap break-words mt-1">{step.contentText}</pre>}
            </div>
          ))}
        </div>
      )}

      <div className="bg-secondary/30 rounded p-2">
        <p className="text-2xs uppercase text-muted-foreground mb-1">
          Response {exchange.statusCode} ({exchange.contentType || 'unknown'})
        </p>
        <pre className="text-2xs font-mono whitespace-pre-wrap break-words">{safeStringify(exchange.responsePayload)}</pre>
      </div>
    </div>
  )
}

function aggregateModelLeaderboard(runs: BenchmarkRunRecord[]): ModelLeaderboardRow[] {
  const byModel = new Map<string, {
    runIds: Set<string>
    scenarios: number
    passRateSum: number
    p95Sum: number
    tokens: number
    failovers: number
  }>()

  for (const run of runs) {
    const results = run.report?.results ?? []
    for (const result of results) {
      if (result.status === 'skipped') continue
      const model = String(result.model ?? '')
      if (!model) continue
      const current = byModel.get(model) ?? {
        runIds: new Set<string>(),
        scenarios: 0,
        passRateSum: 0,
        p95Sum: 0,
        tokens: 0,
        failovers: 0,
      }
      current.runIds.add(run.id)
      current.scenarios += 1
      current.passRateSum += Number(result.passRate ?? 0)
      current.p95Sum += Number(result.p95LatencyMs ?? 0)
      current.tokens += Number(result.totalTokens ?? 0)
      current.failovers += Number(result.failovers ?? 0)
      byModel.set(model, current)
    }
  }

  return Array.from(byModel.entries()).map(([model, value]) => ({
    model,
    runCount: value.runIds.size,
    scenarioCount: value.scenarios,
    avgPassRate: value.scenarios > 0 ? value.passRateSum / value.scenarios : 0,
    avgP95LatencyMs: value.scenarios > 0 ? value.p95Sum / value.scenarios : 0,
    totalTokens: value.tokens,
    totalFailovers: value.failovers,
  })).sort((a, b) => {
    if (b.avgPassRate !== a.avgPassRate) return b.avgPassRate - a.avgPassRate
    return a.avgP95LatencyMs - b.avgP95LatencyMs
  })
}

function safeStringify(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}

function statusClass(status: RunStatus): string {
  if (status === 'completed') return 'text-success'
  if (status === 'failed') return 'text-destructive'
  return 'text-warning'
}
