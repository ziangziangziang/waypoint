export type PeekEmbeddedMedia = {
  path: string
  source: 'request' | 'response'
  mime: string
  kind: 'image' | 'audio' | 'binary'
  url: string
  origin: 'b64_json' | 'data_url'
  sizeHint: number
}

type MediaSource = PeekEmbeddedMedia['source']

const DATA_URL_RE = /^data:([^;,]+)(?:;[^,]*)?,(.*)$/i

export function extractEmbeddedMedia(source: MediaSource, value: unknown): PeekEmbeddedMedia[] {
  const results: PeekEmbeddedMedia[] = []
  const seen = new Set<string>()
  walkValue(value, source, '$', results, seen)
  return results
}

export function redactEmbeddedMedia(value: unknown): unknown {
  return redactValue(value)
}

function walkValue(
  value: unknown,
  source: MediaSource,
  path: string,
  results: PeekEmbeddedMedia[],
  seen: Set<string>,
): void {
  if (typeof value === 'string') {
    const parsed = parseDataUrl(value)
    if (parsed) {
      pushMedia(results, seen, {
        path,
        source,
        mime: parsed.mime,
        kind: kindFromMime(parsed.mime),
        url: value,
        origin: 'data_url',
        sizeHint: parsed.payload.length,
      })
    }
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => walkValue(item, source, `${path}[${index}]`, results, seen))
    return
  }

  if (!value || typeof value !== 'object') {
    return
  }

  const record = value as Record<string, unknown>
  const b64Json = typeof record.b64_json === 'string' ? record.b64_json : null
  const siblingDataUrl = findSiblingDataUrl(record)
  if (b64Json) {
    const mime = siblingDataUrl?.mime ?? inferMime(record) ?? 'image/png'
    pushMedia(results, seen, {
      path: `${path}.b64_json`,
      source,
      mime,
      kind: kindFromMime(mime),
      url: siblingDataUrl?.url ?? `data:${mime};base64,${b64Json}`,
      origin: 'b64_json',
      sizeHint: b64Json.length,
    })
  }

  for (const [key, child] of Object.entries(record)) {
    if (b64Json && siblingDataUrl?.url === child && (key === 'url' || key === 'image_url' || key === 'audio_url')) {
      continue
    }
    walkValue(child, source, `${path}.${key}`, results, seen)
  }
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const parsed = parseDataUrl(value)
    if (!parsed) return value
    return `[data URL omitted: ${parsed.mime}, ${parsed.payload.length} chars]`
  }
  if (Array.isArray(value)) {
    return value.map(redactValue)
  }
  if (!value || typeof value !== 'object') {
    return value
  }

  const record = value as Record<string, unknown>
  const next: Record<string, unknown> = {}
  const inferredMime = inferMime(record) ?? findSiblingDataUrl(record)?.mime ?? 'image/png'
  for (const [key, child] of Object.entries(record)) {
    if (key === 'b64_json' && typeof child === 'string') {
      next[key] = `[base64 media omitted: ${inferredMime}, ${child.length} chars]`
      continue
    }
    next[key] = redactValue(child)
  }
  return next
}

function pushMedia(results: PeekEmbeddedMedia[], seen: Set<string>, media: PeekEmbeddedMedia) {
  const key = `${media.source}:${media.path}:${media.url}`
  if (seen.has(key)) return
  seen.add(key)
  results.push(media)
}

function findSiblingDataUrl(record: Record<string, unknown>): { mime: string; payload: string; url: string } | null {
  for (const key of ['url', 'image_url', 'audio_url']) {
    const value = record[key]
    if (typeof value !== 'string') continue
    const parsed = parseDataUrl(value)
    if (parsed) return { ...parsed, url: value }
  }
  return null
}

function inferMime(record: Record<string, unknown>): string | null {
  for (const key of ['mime', 'mime_type', 'content_type', 'media_type']) {
    const value = record[key]
    if (typeof value === 'string' && value.includes('/')) {
      return value
    }
  }
  return null
}

function parseDataUrl(value: string): { mime: string; payload: string } | null {
  const match = value.match(DATA_URL_RE)
  if (!match) return null
  return {
    mime: match[1].trim().toLowerCase(),
    payload: match[2],
  }
}

function kindFromMime(mime: string): PeekEmbeddedMedia['kind'] {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  return 'binary'
}
