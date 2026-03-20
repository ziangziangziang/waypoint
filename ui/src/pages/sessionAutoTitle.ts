import type { SessionListItem } from '../api/client'

export interface DeferredAutoTitleCandidate {
  sessionId: string
  seedText: string
}

export interface AutoTitleSessionResponse {
  name: string
  titleStatus?: 'pending' | 'generated' | 'manual' | 'failed'
  titleUpdatedAt?: string
}

export const DEFAULT_SESSION_NAME_PATTERN = /^Session\s+\d{1,2}\/\d{1,2}\/\d{2,4}$/

export function isDefaultSessionName(sessionName: string): boolean {
  return DEFAULT_SESSION_NAME_PATTERN.test(sessionName)
}

export function createDeferredAutoTitleCandidate(
  sessionId: string | null,
  sessionName: string,
  seedText: string
): DeferredAutoTitleCandidate | null {
  const trimmed = seedText.trim()
  if (!sessionId || !trimmed || !isDefaultSessionName(sessionName)) {
    return null
  }
  return {
    sessionId,
    seedText: trimmed,
  }
}

export function applyAutoTitleToSessions(
  sessions: SessionListItem[],
  sessionId: string,
  response: AutoTitleSessionResponse
): SessionListItem[] {
  return sessions.map((item) =>
    item.id === sessionId
      ? {
          ...item,
          name: response.name,
          titleStatus: response.titleStatus,
          titleUpdatedAt: response.titleUpdatedAt,
        }
      : item
  )
}

interface FlushDeferredAutoTitleArgs {
  sessionId: string
  sessionName: string
  model?: string
  queuedCandidate: DeferredAutoTitleCandidate | null
  generatingSessionId: string | null
  autoTitleSession: (
    sessionId: string,
    payload: { model?: string; seedText?: string }
  ) => Promise<AutoTitleSessionResponse>
  onGenerationChange: (sessionId: string | null) => void
  onResolved: (response: AutoTitleSessionResponse) => void
  clearQueuedCandidate: () => void
  onError?: (error: unknown) => void
}

export async function flushDeferredAutoTitle({
  sessionId,
  sessionName,
  model,
  queuedCandidate,
  generatingSessionId,
  autoTitleSession,
  onGenerationChange,
  onResolved,
  clearQueuedCandidate,
  onError,
}: FlushDeferredAutoTitleArgs): Promise<boolean> {
  if (!queuedCandidate || queuedCandidate.sessionId !== sessionId) {
    return false
  }
  if (generatingSessionId === sessionId) {
    return false
  }
  if (!isDefaultSessionName(sessionName)) {
    clearQueuedCandidate()
    return false
  }

  clearQueuedCandidate()
  onGenerationChange(sessionId)
  try {
    const response = await autoTitleSession(sessionId, {
      model,
      seedText: queuedCandidate.seedText,
    })
    onResolved(response)
    return true
  } catch (error) {
    onError?.(error)
    return false
  } finally {
    onGenerationChange(null)
  }
}
