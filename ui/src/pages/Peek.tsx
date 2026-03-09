import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  getCaptureConfig,
  updateCaptureConfig,
  listCaptureRecords,
  getCaptureRecord,
  type CaptureRecordDetail,
  type CaptureRecordSummary,
} from '@/api/client'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type PeekTab = 'overview' | 'parts' | 'request' | 'response' | 'media'

export function Peek() {
  const [config, setConfig] = useState<{ enabled: boolean; retentionDays: number; maxBytes: number } | null>(null)
  const [records, setRecords] = useState<CaptureRecordSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<CaptureRecordDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<PeekTab>('overview')
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const [cfg, list] = await Promise.all([getCaptureConfig(), listCaptureRecords(5)])
      setConfig(cfg)
      setRecords(list.data)
      const preferredId = selectedId && list.data.some((item) => item.id === selectedId)
        ? selectedId
        : list.data[0]?.id ?? null
      setSelectedId(preferredId)
      if (preferredId) {
        setDetail(await getCaptureRecord(preferredId))
      } else {
        setDetail(null)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    void getCaptureRecord(selectedId)
      .then(setDetail)
      .catch((err) => setError((err as Error).message))
  }, [selectedId])

  const mediaArtifacts = useMemo(() => detail?.artifacts ?? [], [detail])

  const toggleCapture = async () => {
    if (!config) return
    const next = await updateCaptureConfig({ enabled: !config.enabled })
    setConfig(next)
    await refresh()
  }

  return (
    <div className="flex-1 flex flex-col h-full min-h-0">
      <header className="sticky top-0 z-20 shrink-0 h-14 border-b border-border bg-background/95 backdrop-blur px-4 flex items-center gap-3">
        <h2 className="font-mono font-semibold text-sm uppercase tracking-wider">Peek</h2>
        <span className="text-xs text-muted-foreground font-mono">Latest 5 captured /v1 requests</span>
        <div className="flex-1" />
        <Button size="sm" variant={config?.enabled ? 'default' : 'outline'} onClick={toggleCapture} disabled={!config}>
          Capture {config?.enabled ? 'On' : 'Off'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </Button>
      </header>

      <div className="flex-1 min-h-0 overflow-hidden flex">
        <aside className="w-80 border-r border-border overflow-y-auto p-3 space-y-2">
          {records.length === 0 && (
            <div className="text-sm text-muted-foreground">No captured requests yet.</div>
          )}
          {records.map((record) => (
            <button
              key={record.id}
              className={cn(
                'w-full text-left rounded border px-3 py-2',
                selectedId === record.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary/40'
              )}
              onClick={() => setSelectedId(record.id)}
            >
              <div className="text-xs font-mono text-muted-foreground">{record.method} {record.route}</div>
              <div className="text-sm font-mono truncate">{record.model || 'unknown-model'}</div>
              <div className="text-xs text-muted-foreground">
                {record.statusCode} • {record.latencyMs}ms • {new Date(record.timestamp).toLocaleTimeString()}
              </div>
            </button>
          ))}
        </aside>

        <section className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <div className="border-b border-border px-4 py-2 flex gap-2">
            {(['overview', 'parts', 'request', 'response', 'media'] as PeekTab[]).map((item) => (
              <button
                key={item}
                className={cn(
                  'px-2 py-1 text-xs font-mono rounded border',
                  tab === item ? 'border-primary text-primary' : 'border-border text-muted-foreground'
                )}
                onClick={() => setTab(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            {error && <div className="text-sm text-destructive mb-3">{error}</div>}
            {!detail && <div className="text-sm text-muted-foreground">Select a capture to inspect.</div>}
            {detail && tab === 'overview' && (
              <div className="space-y-2 text-sm font-mono">
                <div>ID: {detail.id}</div>
                <div>Route: {detail.method} {detail.route}</div>
                <div className="flex items-center gap-2">
                  <span>Status:</span>
                  <Badge className={statusTone(detail.statusCode)}>{detail.statusCode}</Badge>
                  <Badge className={routeTone(detail.route)}>{routeType(detail.route)}</Badge>
                  <Badge className={responseTone(detail)}> {responseType(detail)} </Badge>
                </div>
                <div>Latency: {detail.latencyMs}ms</div>
                <div>Model: {detail.routing.publicModel || 'unknown'}</div>
                <div>Endpoint: {detail.routing.endpointName || detail.routing.endpointId || 'n/a'}</div>
                <div>Upstream: {detail.routing.upstreamModel || 'n/a'}</div>
              </div>
            )}
            {detail && tab === 'parts' && (
              <div className="space-y-4 text-sm">
                <Section title="System">
                  {detail.analysis.systemMessages.map((line, i) => <pre key={i} className="whitespace-pre-wrap text-xs">{line}</pre>)}
                </Section>
                <Section title="AGENTS / Guardrail Hints">
                  {detail.analysis.agentsMdHints.map((line, i) => <pre key={i} className="whitespace-pre-wrap text-xs">{line}</pre>)}
                </Section>
                <Section title="MCP Tool Descriptions">
                  {detail.analysis.mcpToolDescriptions.map((line, i) => <pre key={i} className="whitespace-pre-wrap text-xs">{line}</pre>)}
                </Section>
                <Section title="Raw Sections">
                  {detail.analysis.rawSections.map((line, i) => <div key={i} className="text-xs font-mono">{line}</div>)}
                </Section>
              </div>
            )}
            {detail && tab === 'request' && (
              <div className="space-y-4">
                <Section title="Raw Request Body">
                  <pre className="text-xs overflow-auto">{JSON.stringify(detail.request.body ?? null, null, 2)}</pre>
                </Section>
                <Section title="Derived (normalized/preview)">
                  <pre className="text-xs overflow-auto">{JSON.stringify(detail.request.derived ?? null, null, 2)}</pre>
                </Section>
                <Section title="Headers">
                  <pre className="text-xs overflow-auto">{JSON.stringify(detail.request.headers ?? {}, null, 2)}</pre>
                </Section>
              </div>
            )}
            {detail && tab === 'response' && (
              <div className="space-y-4">
                <Section title="Raw Response Body">
                  <pre className="text-xs overflow-auto">{JSON.stringify(detail.response.body ?? null, null, 2)}</pre>
                </Section>
                <Section title="Headers">
                  <pre className="text-xs overflow-auto">{JSON.stringify(detail.response.headers ?? {}, null, 2)}</pre>
                </Section>
                <Section title="Error">
                  <pre className="text-xs overflow-auto">{JSON.stringify(detail.response.error ?? null, null, 2)}</pre>
                </Section>
              </div>
            )}
            {detail && tab === 'media' && (
              <div className="space-y-3">
                {mediaArtifacts.length === 0 && <div className="text-sm text-muted-foreground">No media artifacts.</div>}
                {mediaArtifacts.map((artifact) => (
                  <div key={artifact.hash} className="rounded border border-border p-2">
                    <div className="text-xs font-mono mb-2">{artifact.kind} • {artifact.mime} • {artifact.bytes} bytes</div>
                    {artifact.kind === 'image' ? (
                      <img
                        src={artifact.blobRef}
                        alt={artifact.hash}
                        className="max-h-72 rounded border border-border"
                      />
                    ) : (
                      <a href={artifact.blobRef} target="_blank" rel="noreferrer" className="text-xs text-primary underline">
                        Open blob
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wider font-mono text-muted-foreground mb-1">{props.title}</h3>
      <div className="rounded border border-border p-2 space-y-2">{props.children}</div>
    </div>
  )
}

function Badge(props: { className: string; children: ReactNode }) {
  return <span className={cn('inline-flex items-center rounded border px-2 py-0.5 text-xs font-mono', props.className)}>{props.children}</span>
}

function routeType(route: string): string {
  if (route.includes('/chat/completions')) return 'chat'
  if (route.includes('/responses')) return 'responses'
  if (route.includes('/embeddings')) return 'embeddings'
  if (route.includes('/images/')) return 'images'
  if (route.includes('/audio/')) return 'audio'
  return 'other'
}

function routeTone(route: string): string {
  const type = routeType(route)
  if (type === 'chat') return 'border-blue-400/40 text-blue-300 bg-blue-500/10'
  if (type === 'responses') return 'border-cyan-400/40 text-cyan-300 bg-cyan-500/10'
  if (type === 'embeddings') return 'border-emerald-400/40 text-emerald-300 bg-emerald-500/10'
  if (type === 'images') return 'border-amber-400/40 text-amber-300 bg-amber-500/10'
  if (type === 'audio') return 'border-violet-400/40 text-violet-300 bg-violet-500/10'
  return 'border-border text-muted-foreground'
}

function statusTone(statusCode: number): string {
  if (statusCode >= 500) return 'border-red-400/40 text-red-300 bg-red-500/10'
  if (statusCode >= 400) return 'border-orange-400/40 text-orange-300 bg-orange-500/10'
  if (statusCode >= 300) return 'border-yellow-400/40 text-yellow-300 bg-yellow-500/10'
  return 'border-green-400/40 text-green-300 bg-green-500/10'
}

function responseType(detail: CaptureRecordDetail): string {
  const body = detail.response.body as Record<string, unknown> | null
  if (detail.statusCode >= 400) return 'error'
  if (body && typeof body === 'object' && body.$type === 'stream') return 'stream'
  return 'json'
}

function responseTone(detail: CaptureRecordDetail): string {
  const type = responseType(detail)
  if (type === 'error') return 'border-red-400/40 text-red-300 bg-red-500/10'
  if (type === 'stream') return 'border-sky-400/40 text-sky-300 bg-sky-500/10'
  return 'border-teal-400/40 text-teal-300 bg-teal-500/10'
}
