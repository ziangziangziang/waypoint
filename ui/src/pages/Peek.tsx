import { useEffect, useMemo, useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { sankey, sankeyLinkHorizontal } from 'd3-sankey'
import {
  getCaptureCalendar,
  getCaptureConfig,
  getCaptureRecord,
  listCaptureRecords,
  updateCaptureConfig,
  type CaptureCalendarDaySummary,
  type CaptureRecordDetail,
  type CaptureRecordSummary,
  type CaptureTimelineEntry,
} from '@/api/client'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { extractEmbeddedMedia, redactEmbeddedMedia, type PeekEmbeddedMedia } from './peekMedia'

type PeekTab = 'overview' | 'timeline' | 'request' | 'response' | 'media'

const DAY_PAGE_SIZE = 50
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function Peek() {
  const [config, setConfig] = useState<{ enabled: boolean; retentionDays: number; maxBytes: number } | null>(null)
  const [latestRecords, setLatestRecords] = useState<CaptureRecordSummary[]>([])
  const [dayRecords, setDayRecords] = useState<CaptureRecordSummary[]>([])
  const [dayTotal, setDayTotal] = useState(0)
  const [calendarDays, setCalendarDays] = useState<CaptureCalendarDaySummary[]>([])
  const [month, setMonth] = useState<string>('')
  const [selectedDate, setSelectedDate] = useState<string>('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<CaptureRecordDetail | null>(null)
  const [dayOffset, setDayOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<PeekTab>('overview')
  const [error, setError] = useState<string | null>(null)
  const [tokenFlowOpen, setTokenFlowOpen] = useState(false)

  const refreshOverview = async () => {
    setLoading(true)
    setError(null)
    try {
      const [cfg, latest] = await Promise.all([
        getCaptureConfig(),
        listCaptureRecords({ limit: 5 }),
      ])
      setConfig(cfg)
      setLatestRecords(latest.data)
      const fallbackDate = latest.data[0]?.timestamp.slice(0, 10) ?? new Date().toISOString().slice(0, 10)
      const fallbackMonth = fallbackDate.slice(0, 7)
      setMonth((current) => current || fallbackMonth)
      setSelectedDate((current) => current || fallbackDate)
      setSelectedId((current) => current ?? latest.data[0]?.id ?? null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refreshOverview()
  }, [])

  useEffect(() => {
    if (!month) return
    void getCaptureCalendar(month)
      .then((calendar) => setCalendarDays(calendar.days))
      .catch((err) => setError((err as Error).message))
  }, [month])

  useEffect(() => {
    if (!selectedDate) return
    void listCaptureRecords({ date: selectedDate, limit: DAY_PAGE_SIZE, offset: dayOffset })
      .then((result) => {
        setDayRecords(result.data)
        setDayTotal(result.total)
        setSelectedId((current) => {
          if (current && result.data.some((item) => item.id === current)) return current
          if (current && latestRecords.some((item) => item.id === current)) return current
          return result.data[0]?.id ?? latestRecords[0]?.id ?? null
        })
      })
      .catch((err) => setError((err as Error).message))
  }, [selectedDate, dayOffset, latestRecords])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    void getCaptureRecord(selectedId)
      .then(setDetail)
      .catch((err) => setError((err as Error).message))
  }, [selectedId])

  useEffect(() => {
    setTokenFlowOpen(false)
  }, [selectedId])

  const mediaArtifacts = useMemo(() => detail?.artifacts ?? [], [detail])
  const requestEmbeddedMedia = useMemo(
    () => extractEmbeddedMedia('request', detail?.request.body ?? null),
    [detail],
  )
  const responseEmbeddedMedia = useMemo(
    () => extractEmbeddedMedia('response', detail?.response.body ?? null),
    [detail],
  )
  const embeddedMedia = useMemo(
    () => [...requestEmbeddedMedia, ...responseEmbeddedMedia],
    [requestEmbeddedMedia, responseEmbeddedMedia],
  )
  const requestTimeline = useMemo(() => detail?.analysis.requestTimeline ?? [], [detail])
  const responseTimeline = useMemo(() => detail?.analysis.responseTimeline ?? [], [detail])
  const calendarGrid = useMemo(() => buildCalendarGrid(month, calendarDays), [month, calendarDays])
  const tokenFlow = detail?.analysis.tokenFlow

  const toggleCapture = async () => {
    if (!config) return
    const next = await updateCaptureConfig({ enabled: !config.enabled })
    setConfig(next)
    await refreshOverview()
  }

  const selectDate = (date: string) => {
    setSelectedDate(date)
    setDayOffset(0)
  }

  return (
    <>
      <div className="flex-1 flex flex-col h-full min-h-0">
        <header className="sticky top-0 z-20 shrink-0 h-14 border-b border-border bg-background/95 backdrop-blur px-4 flex items-center gap-3">
        <h2 className="font-mono font-semibold text-sm uppercase tracking-wider">Peek</h2>
        <span className="text-xs text-muted-foreground font-mono">Calendar browse + ordered capture timelines (UTC)</span>
        <div className="flex-1" />
        <Button size="sm" variant={config?.enabled ? 'default' : 'outline'} onClick={toggleCapture} disabled={!config}>
          Capture {config?.enabled ? 'On' : 'Off'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void refreshOverview()} disabled={loading}>
          Refresh
        </Button>
      </header>

      <div className="flex-1 min-h-0 overflow-hidden flex">
        <aside className="w-[26rem] shrink-0 border-r border-border overflow-y-auto p-3 space-y-4">
          <Section title="Calendar">
            <div className="flex items-center justify-between gap-2">
              <Button size="sm" variant="outline" onClick={() => setMonth(prevMonth(month))} disabled={!month}>Prev</Button>
              <div className="text-sm font-mono">{month || '---- --'}</div>
              <Button size="sm" variant="outline" onClick={() => setMonth(nextMonth(month))} disabled={!month}>Next</Button>
            </div>
            <div className="grid grid-cols-7 gap-1 text-[11px] font-mono text-muted-foreground">
              {WEEKDAY_LABELS.map((label) => (
                <div key={label} className="px-1 py-1 text-center">{label}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {calendarGrid.map((cell) => (
                <button
                  key={cell.key}
                  type="button"
                  disabled={!cell.date}
                  onClick={() => cell.date && selectDate(cell.date)}
                  className={cn(
                    'min-h-[3.5rem] rounded border px-1 py-1 text-left',
                    !cell.inMonth && 'opacity-40',
                    cell.date === selectedDate ? 'border-primary bg-primary/10' : 'border-border hover:bg-secondary/40',
                    !cell.date && 'cursor-default opacity-0'
                  )}
                >
                  {cell.date && (
                    <>
                      <div className="text-[11px] font-mono">{cell.day}</div>
                      <div className="text-sm font-semibold leading-none mt-2">{cell.count}</div>
                    </>
                  )}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Latest 5">
            {latestRecords.length === 0 && <EmptyState label="No captured requests yet." />}
            {latestRecords.map((record) => (
              <RecordButton key={record.id} record={record} selected={selectedId === record.id} onSelect={setSelectedId} />
            ))}
          </Section>

          <Section title={selectedDate ? `Selected Day ${selectedDate}` : 'Selected Day'}>
            <div className="flex items-center justify-between text-xs font-mono text-muted-foreground">
              <span>{dayTotal} captures</span>
              <span>{dayOffset + 1}-{Math.min(dayOffset + DAY_PAGE_SIZE, dayTotal || 0)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button size="sm" variant="outline" onClick={() => setDayOffset((current) => Math.max(0, current - DAY_PAGE_SIZE))} disabled={dayOffset === 0}>
                Newer
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDayOffset((current) => current + DAY_PAGE_SIZE)} disabled={dayOffset + DAY_PAGE_SIZE >= dayTotal}>
                Older
              </Button>
            </div>
            {dayRecords.length === 0 && <EmptyState label="No captures for this day." />}
            {dayRecords.map((record) => (
              <RecordButton key={record.id} record={record} selected={selectedId === record.id} onSelect={setSelectedId} />
            ))}
          </Section>
        </aside>

        <section className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <div className="border-b border-border px-4 py-2 flex gap-2">
            {(['overview', 'timeline', 'request', 'response', 'media'] as PeekTab[]).map((item) => (
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
              <div className="space-y-4 text-sm font-mono">
                <div>ID: {detail.id}</div>
                <div>Route: {detail.method} {detail.route}</div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span>Status:</span>
                  <Badge className={statusTone(detail.statusCode)}>{detail.statusCode}</Badge>
                  <Badge className={routeTone(detail.route)}>{routeType(detail.route)}</Badge>
                  <Badge className={responseTone(detail)}>{responseType(detail)}</Badge>
                </div>
                <div>Latency: {detail.latencyMs}ms</div>
                <div>Model: {detail.routing.publicModel || 'unknown'}</div>
                <div>Endpoint: {detail.routing.endpointName || detail.routing.endpointId || 'n/a'}</div>
                <div>Upstream: {detail.routing.upstreamModel || 'n/a'}</div>
                <Section title="Token Flow">
                  {tokenFlow ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono">Input: {formatCount(tokenFlow.totals.inputTokens)}</span>
                        <span className="font-mono">Output: {formatCount(tokenFlow.totals.outputTokens)}</span>
                        <span className="font-mono">Total: {formatCount(tokenFlow.totals.totalTokens)}</span>
                        <Badge className={tokenFlow.method === 'exact_totals_estimated_categories' ? 'border-emerald-400/40 text-emerald-300 bg-emerald-500/10' : 'border-amber-400/40 text-amber-300 bg-amber-500/10'}>
                          {tokenFlow.method === 'exact_totals_estimated_categories' ? 'Exact totals' : tokenFlow.method === 'estimated_only' ? 'Estimated' : 'Unavailable'}
                        </Badge>
                        {tokenFlow.eligible && (
                          <Button size="sm" variant="outline" onClick={() => setTokenFlowOpen(true)}>
                            Open Sankey
                          </Button>
                        )}
                      </div>
                      {!tokenFlow.eligible && (
                        <div className="text-xs text-muted-foreground">{tokenFlow.reason || 'Token flow unavailable for this capture.'}</div>
                      )}
                    </div>
                  ) : (
                    <EmptyState label="Token flow analysis unavailable." />
                  )}
                </Section>
                <Section title="Secondary Metadata">
                  <div className="space-y-2">
                    <MetadataList title="AGENTS / Guardrail Hints" items={detail.analysis.agentsMdHints} />
                    <MetadataList title="MCP Tool Descriptions" items={detail.analysis.mcpToolDescriptions} />
                    <MetadataList title="Raw Sections" items={detail.analysis.rawSections} mono />
                  </div>
                </Section>
              </div>
            )}
            {detail && tab === 'timeline' && (
              <div className="space-y-4">
                <Section title="Request Timeline">
                  {requestTimeline.length === 0 && <EmptyState label="No request timeline items." />}
                  {requestTimeline.map((entry) => <TimelineEntryCard key={`req-${entry.index}`} entry={entry} />)}
                </Section>
                <Section title="Response Timeline">
                  {responseTimeline.length === 0 && (
                    <EmptyState
                      label={isMissingLegacyStreamCapture(detail) ? 'Stream response missing from capture.' : 'No response timeline items.'}
                    />
                  )}
                  {responseTimeline.map((entry) => <TimelineEntryCard key={`res-${entry.index}`} entry={entry} />)}
                </Section>
              </div>
            )}
            {detail && tab === 'request' && (
              <div className="space-y-4">
                <Section title="Detected Media">
                  <EmbeddedMediaList items={requestEmbeddedMedia} emptyLabel="No inline media detected in request body." />
                </Section>
                <Section title="Raw Request Body">
                  <pre className="text-xs overflow-auto">{JSON.stringify(redactEmbeddedMedia(detail.request.body ?? null), null, 2)}</pre>
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
                <Section title="Detected Media">
                  <EmbeddedMediaList items={responseEmbeddedMedia} emptyLabel="No inline media detected in response body." />
                </Section>
                <Section title="Raw Response Body">
                  <pre className="text-xs overflow-auto">{JSON.stringify(redactEmbeddedMedia(detail.response.body ?? null), null, 2)}</pre>
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
                {mediaArtifacts.length === 0 && embeddedMedia.length === 0 && (
                  <div className="text-sm text-muted-foreground">No media artifacts.</div>
                )}
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
                {embeddedMedia.length > 0 && (
                  <Section title="Embedded Base64 / Data URLs">
                    <EmbeddedMediaList items={embeddedMedia} emptyLabel="No embedded media detected." />
                  </Section>
                )}
              </div>
            )}
          </div>
        </section>
        </div>
      </div>
      <TokenFlowDialog
        open={tokenFlowOpen}
        onOpenChange={setTokenFlowOpen}
        captureId={detail?.id}
        model={detail?.routing.publicModel}
        tokenFlow={tokenFlow}
      />
    </>
  )
}

type TokenFlowData = NonNullable<CaptureRecordDetail['analysis']['tokenFlow']>

function TokenFlowDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  captureId?: string
  model?: string
  tokenFlow?: TokenFlowData
}) {
  const { tokenFlow } = props
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(96vw,1100px)] max-h-[88vh] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-4 shadow-2xl overflow-y-auto">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="space-y-1">
              <Dialog.Title className="text-sm font-mono uppercase tracking-wider">Token Flow Sankey</Dialog.Title>
              <div className="text-xs text-muted-foreground font-mono">
                Capture: {props.captureId || 'n/a'} {props.model ? `• ${props.model}` : ''}
              </div>
            </div>
            <Dialog.Close asChild>
              <Button variant="outline" size="sm">Close</Button>
            </Dialog.Close>
          </div>
          {!tokenFlow && <EmptyState label="Token flow analysis unavailable." />}
          {tokenFlow && !tokenFlow.eligible && (
            <div className="rounded border border-border p-3 text-sm text-muted-foreground">
              {tokenFlow.reason || 'Token flow unavailable for this capture.'}
            </div>
          )}
          {tokenFlow?.eligible && (
            <TokenFlowSankey
              tokenFlow={tokenFlow}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function TokenFlowSankey(props: { tokenFlow: TokenFlowData }) {
  const width = 980
  const height = 420
  const graph = useMemo(() => {
    const tokenFlow = props.tokenFlow
    const nodes: Array<{ id: string; name: string; side: 'neutral' | 'input' | 'output' }> = [
      { id: 'total', name: 'Total Tokens', side: 'neutral' },
      { id: 'input', name: 'Input Tokens', side: 'input' },
      { id: 'output', name: 'Output Tokens', side: 'output' },
    ]
    const links: Array<{ source: string; target: string; value: number }> = []
    const inputTotal = Math.max(0, tokenFlow.totals.inputTokens ?? 0)
    const outputTotal = Math.max(0, tokenFlow.totals.outputTokens ?? 0)
    links.push({ source: 'total', target: 'input', value: inputTotal })
    links.push({ source: 'total', target: 'output', value: outputTotal })

    for (const category of tokenFlow.input) {
      if (category.tokens <= 0) continue
      const id = `input:${category.key}`
      nodes.push({ id, name: category.label, side: 'input' })
      links.push({ source: 'input', target: id, value: category.tokens })
    }
    for (const category of tokenFlow.output) {
      if (category.tokens <= 0) continue
      const id = `output:${category.key}`
      nodes.push({ id, name: category.label, side: 'output' })
      links.push({ source: 'output', target: id, value: category.tokens })
    }

    const layout = sankey()
      .nodeId((node: { id: string }) => node.id)
      .nodeWidth(16)
      .nodePadding(12)
      .extent([[12, 12], [width - 12, height - 12]])
    return layout({
      nodes: nodes.map((node) => ({ ...node })),
      links: links.map((link) => ({ ...link })),
    })
  }, [props.tokenFlow])

  const inputTotal = Math.max(0, props.tokenFlow.totals.inputTokens ?? 0)
  const outputTotal = Math.max(0, props.tokenFlow.totals.outputTokens ?? 0)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
        <Badge className={props.tokenFlow.method === 'exact_totals_estimated_categories' ? 'border-emerald-400/40 text-emerald-300 bg-emerald-500/10' : 'border-amber-400/40 text-amber-300 bg-amber-500/10'}>
          {props.tokenFlow.method === 'exact_totals_estimated_categories' ? 'Exact totals' : 'Estimated totals'}
        </Badge>
        <span>Input: {formatCount(props.tokenFlow.totals.inputTokens)}</span>
        <span>Output: {formatCount(props.tokenFlow.totals.outputTokens)}</span>
        <span>Total: {formatCount(props.tokenFlow.totals.totalTokens)}</span>
      </div>
      <div className="overflow-x-auto rounded border border-border p-2">
        <svg width={width} height={height} role="img" aria-label="Token flow sankey chart">
          <g fill="none" strokeOpacity={0.35}>
            {graph.links.map((link: any, index: number) => {
              const sourceId = String((link.source as { id?: string }).id ?? '')
              const sourceTotal = sourceId === 'input' ? inputTotal : sourceId === 'output' ? outputTotal : Math.max(0, props.tokenFlow.totals.totalTokens ?? 0)
              const percentage = sourceTotal > 0 ? (link.value / sourceTotal) * 100 : 0
              return (
                <path
                  key={`link-${index}`}
                  d={sankeyLinkHorizontal()(link) ?? ''}
                  stroke={sourceId.startsWith('input') ? '#38bdf8' : sourceId.startsWith('output') ? '#f97316' : '#94a3b8'}
                  strokeWidth={Math.max(1, link.width ?? 1)}
                >
                  <title>{`${sourceId || 'source'} -> ${String((link.target as { id?: string }).id ?? 'target')}: ${link.value.toLocaleString()} tokens (${percentage.toFixed(1)}%)`}</title>
                </path>
              )
            })}
          </g>
          <g>
            {graph.nodes.map((node: any, index: number) => {
              const nodeHeight = Math.max(1, (node.y1 ?? 0) - (node.y0 ?? 0))
              const tokens = Math.round(Number(node.value ?? 0))
              const sideTotal = node.id.startsWith('input:') ? inputTotal : node.id.startsWith('output:') ? outputTotal : Math.max(0, props.tokenFlow.totals.totalTokens ?? 0)
              const percentage = sideTotal > 0 ? (tokens / sideTotal) * 100 : 0
              const isRightColumn = (node.x1 ?? 0) > width * 0.72
              const labelX = isRightColumn ? (node.x0 ?? 0) - 6 : (node.x1 ?? 0) + 6
              const labelAnchor = isRightColumn ? 'end' : 'start'
              return (
                <g key={`node-${index}`}>
                  <rect
                    x={node.x0}
                    y={node.y0}
                    width={Math.max(1, (node.x1 ?? 0) - (node.x0 ?? 0))}
                    height={nodeHeight}
                    fill={node.id.startsWith('input') ? '#0ea5e9' : node.id.startsWith('output') ? '#f97316' : '#64748b'}
                    rx={2}
                    ry={2}
                  >
                    <title>{`${node.name}: ${tokens.toLocaleString()} tokens (${percentage.toFixed(1)}%)`}</title>
                  </rect>
                  <text
                    x={labelX}
                    y={((node.y0 ?? 0) + (node.y1 ?? 0)) / 2}
                    dominantBaseline="middle"
                    textAnchor={labelAnchor}
                    fontSize={11}
                    fill="hsl(var(--foreground))"
                  >
                    {node.name} ({tokens.toLocaleString()})
                  </text>
                </g>
              )
            })}
          </g>
        </svg>
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="rounded border border-border p-2">
          <div className="font-mono uppercase tracking-wider text-muted-foreground mb-1">Input Categories</div>
          {props.tokenFlow.input.map((item) => (
            <div key={item.key} className="flex justify-between gap-2 font-mono">
              <span>{item.label}</span>
              <span>{item.tokens.toLocaleString()}</span>
            </div>
          ))}
        </div>
        <div className="rounded border border-border p-2">
          <div className="font-mono uppercase tracking-wider text-muted-foreground mb-1">Output Categories</div>
          {props.tokenFlow.output.map((item) => (
            <div key={item.key} className="flex justify-between gap-2 font-mono">
              <span>{item.label}</span>
              <span>{item.tokens.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded border border-border p-2 text-xs text-muted-foreground">
        <div>Unattributed categories include rounding residue, multimodal payload portions, and structures without direct text attribution.</div>
        {(props.tokenFlow.notes ?? []).map((note, idx) => (
          <div key={idx}>{note}</div>
        ))}
      </div>
    </div>
  )
}

function RecordButton(props: {
  record: CaptureRecordSummary
  selected: boolean
  onSelect: (id: string) => void
}) {
  const { record, selected, onSelect } = props
  return (
    <button
      className={cn(
        'w-full text-left rounded border px-3 py-2 space-y-1',
        selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary/40'
      )}
      onClick={() => onSelect(record.id)}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Badge className={statusTone(record.statusCode)}>{record.statusCode}</Badge>
        <span className="text-xs font-mono text-muted-foreground">{new Date(record.timestamp).toLocaleTimeString()}</span>
      </div>
      <div className="text-xs font-mono text-muted-foreground truncate">{record.method} {record.route}</div>
      <div className="text-sm font-mono truncate">{record.model || 'unknown-model'}</div>
      <div className="text-xs text-muted-foreground">{record.latencyMs}ms</div>
    </button>
  )
}

function TimelineEntryCard(props: { entry: CaptureTimelineEntry }) {
  const { entry } = props
  return (
    <div className={cn('rounded border p-2 space-y-2', roleCardTone(entry.role), kindCardTone(entry.kind))}>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge className={directionTone(entry.direction)}>{entry.direction}</Badge>
        <Badge className={kindTone(entry.kind)}>{entry.kind}</Badge>
        {entry.role && <Badge className={roleBadgeTone(entry.role)}>{entry.role}</Badge>}
        <span className="text-[11px] font-mono text-muted-foreground">#{entry.index}</span>
        <span className="text-[11px] font-mono text-muted-foreground">{entry.sourcePath}</span>
      </div>
      {entry.name && <div className="text-xs font-mono">{entry.name}</div>}
      {entry.content && <ExpandableText content={entry.content} />}
      {entry.arguments && (
        <div className="rounded border border-sky-400/30 bg-sky-500/10 p-2">
          <div className="text-[11px] uppercase tracking-wider font-mono text-sky-200 mb-1">Arguments</div>
          <ExpandableText content={entry.arguments} />
        </div>
      )}
      {entry.toolCallId && <div className="text-[11px] font-mono text-muted-foreground">tool_call_id: {entry.toolCallId}</div>}
      {entry.metadata && !entry.arguments && !entry.content && (
        <ExpandableText content={JSON.stringify(entry.metadata, null, 2)} />
      )}
    </div>
  )
}

function MetadataList(props: { title: string; items: string[]; mono?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider font-mono text-muted-foreground mb-1">{props.title}</div>
      {props.items.length === 0 ? (
        <EmptyState label={`No ${props.title.toLowerCase()}.`} />
      ) : (
        <div className="space-y-2">
          {props.items.map((item, index) => (
            <pre key={index} className={cn('whitespace-pre-wrap text-xs', props.mono && 'font-mono')}>
              {item}
            </pre>
          ))}
        </div>
      )}
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

function EmptyState(props: { label: string }) {
  return <div className="text-xs text-muted-foreground">{props.label}</div>
}

function ExpandableText(props: { content: string }) {
  const isLong = props.content.length > 700 || props.content.includes('\n')
  if (!isLong) {
    return <pre className="whitespace-pre-wrap text-xs">{props.content}</pre>
  }
  return (
    <details className="group">
      <summary className="cursor-pointer text-xs font-mono text-muted-foreground">
        Show full text ({props.content.length} chars)
      </summary>
      <pre className="whitespace-pre-wrap text-xs mt-2">{props.content}</pre>
    </details>
  )
}

function EmbeddedMediaList(props: { items: PeekEmbeddedMedia[]; emptyLabel: string }) {
  if (props.items.length === 0) {
    return <EmptyState label={props.emptyLabel} />
  }
  return (
    <div className="space-y-3">
      {props.items.map((item) => (
        <EmbeddedMediaCard key={`${item.source}:${item.path}:${item.url.slice(0, 32)}`} item={item} />
      ))}
    </div>
  )
}

function EmbeddedMediaCard(props: { item: PeekEmbeddedMedia }) {
  const { item } = props
  return (
    <div className="rounded border border-border p-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-muted-foreground">
        <Badge className={item.source === 'request' ? 'border-blue-400/40 text-blue-300 bg-blue-500/10' : 'border-teal-400/40 text-teal-300 bg-teal-500/10'}>
          {item.source}
        </Badge>
        <span>{item.path}</span>
        <span>{item.origin}</span>
        <span>{item.mime}</span>
        <span>{item.sizeHint} chars</span>
      </div>
      {item.kind === 'image' ? (
        <img src={item.url} alt={item.path} className="max-h-72 rounded border border-border" />
      ) : item.kind === 'audio' ? (
        <audio controls src={item.url} className="w-full" />
      ) : (
        <a href={item.url} target="_blank" rel="noreferrer" className="text-xs text-primary underline">
          Open embedded media
        </a>
      )}
    </div>
  )
}

function buildCalendarGrid(month: string, days: CaptureCalendarDaySummary[]) {
  if (!month) return [] as Array<{ key: string; date: string | null; day: number | null; count: number; inMonth: boolean }>
  const [year, monthIndex] = month.split('-').map(Number)
  const first = new Date(Date.UTC(year, monthIndex - 1, 1))
  const startWeekday = first.getUTCDay()
  const totalDays = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate()
  const countByDate = new Map(days.map((day) => [day.date, day.count]))
  const cells: Array<{ key: string; date: string | null; day: number | null; count: number; inMonth: boolean }> = []

  for (let i = 0; i < startWeekday; i += 1) {
    cells.push({ key: `empty-start-${i}`, date: null, day: null, count: 0, inMonth: false })
  }
  for (let day = 1; day <= totalDays; day += 1) {
    const date = `${month}-${String(day).padStart(2, '0')}`
    cells.push({
      key: date,
      date,
      day,
      count: countByDate.get(date) ?? 0,
      inMonth: true,
    })
  }
  while (cells.length % 7 !== 0) {
    cells.push({ key: `empty-end-${cells.length}`, date: null, day: null, count: 0, inMonth: false })
  }
  return cells
}

function prevMonth(month: string): string {
  if (!month) return new Date().toISOString().slice(0, 7)
  const [year, mon] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, mon - 2, 1))
  return date.toISOString().slice(0, 7)
}

function nextMonth(month: string): string {
  if (!month) return new Date().toISOString().slice(0, 7)
  const [year, mon] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, mon, 1))
  return date.toISOString().slice(0, 7)
}

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a'
  return value.toLocaleString()
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

function isMissingLegacyStreamCapture(detail: CaptureRecordDetail): boolean {
  const request = detail.request.body as Record<string, unknown> | null
  const response = detail.response.body as Record<string, unknown> | null
  return request?.stream === true && (detail.analysis.responseTimeline?.length ?? 0) === 0 && !response
}

function roleBadgeTone(role: CaptureTimelineEntry['role']) {
  if (role === 'system') return 'border-amber-400/40 text-amber-300 bg-amber-500/10'
  if (role === 'user') return 'border-blue-400/40 text-blue-300 bg-blue-500/10'
  if (role === 'assistant') return 'border-emerald-400/40 text-emerald-300 bg-emerald-500/10'
  if (role === 'tool') return 'border-violet-400/40 text-violet-300 bg-violet-500/10'
  if (role === 'developer') return 'border-fuchsia-400/40 text-fuchsia-300 bg-fuchsia-500/10'
  return 'border-border text-muted-foreground'
}

function roleCardTone(role: CaptureTimelineEntry['role']) {
  if (role === 'system') return 'border-amber-400/30 bg-amber-500/5'
  if (role === 'user') return 'border-blue-400/30 bg-blue-500/5'
  if (role === 'assistant') return 'border-emerald-400/30 bg-emerald-500/5'
  if (role === 'tool') return 'border-violet-400/30 bg-violet-500/5'
  if (role === 'developer') return 'border-fuchsia-400/30 bg-fuchsia-500/5'
  return ''
}

function kindTone(kind: CaptureTimelineEntry['kind']) {
  if (kind === 'tool_call') return 'border-sky-400/40 text-sky-300 bg-sky-500/10'
  if (kind === 'tool_result') return 'border-violet-400/40 text-violet-300 bg-violet-500/10'
  if (kind === 'reasoning') return 'border-indigo-400/40 text-indigo-300 bg-indigo-500/10'
  if (kind === 'instructions') return 'border-amber-400/40 text-amber-300 bg-amber-500/10'
  if (kind === 'stream_preview') return 'border-cyan-400/40 text-cyan-300 bg-cyan-500/10'
  if (kind === 'error') return 'border-red-400/40 text-red-300 bg-red-500/10'
  if (kind === 'tool_definition') return 'border-orange-400/40 text-orange-300 bg-orange-500/10'
  return 'border-border text-muted-foreground'
}

function kindCardTone(kind: CaptureTimelineEntry['kind']) {
  if (kind === 'reasoning') return 'bg-indigo-500/5'
  if (kind === 'tool_call') return 'bg-sky-500/5'
  if (kind === 'tool_result') return 'bg-violet-500/5'
  if (kind === 'error') return 'bg-red-500/5'
  return ''
}

function directionTone(direction: CaptureTimelineEntry['direction']) {
  return direction === 'request'
    ? 'border-slate-400/40 text-slate-200 bg-slate-500/10'
    : 'border-teal-400/40 text-teal-300 bg-teal-500/10'
}
