export interface ThinkingStreamState {
  regularContent: string
  reasoningContent: string
  hasReasoning: boolean
  reasoningClosed: boolean
}

export function createThinkingStreamState(): ThinkingStreamState {
  return {
    regularContent: '',
    reasoningContent: '',
    hasReasoning: false,
    reasoningClosed: false,
  }
}

export function applyThinkingChunk(
  state: ThinkingStreamState,
  chunk: { content?: string; reasoning?: string }
): ThinkingStreamState {
  const next: ThinkingStreamState = { ...state }

  if (chunk.reasoning) {
    if (!next.hasReasoning) {
      next.hasReasoning = true
      next.reasoningContent = chunk.reasoning
    } else {
      next.reasoningContent += chunk.reasoning
    }
  }

  if (chunk.content) {
    if (next.hasReasoning && !next.reasoningClosed && next.reasoningContent) {
      next.reasoningClosed = true
    }
    next.regularContent += chunk.content
  }

  return next
}

export function toDisplayContent(state: ThinkingStreamState): string {
  if (!state.hasReasoning) {
    return state.regularContent
  }
  const closingTag = state.reasoningClosed ? '</think>' : ''
  const answerBody = state.regularContent ? `\n\n${state.regularContent}` : ''
  return `<think>${state.reasoningContent}${closingTag}${answerBody}`
}

export function toFinalContent(state: ThinkingStreamState): string {
  if (!state.hasReasoning) {
    return state.regularContent
  }
  const answerBody = state.regularContent ? `\n\n${state.regularContent}` : ''
  return `<think>${state.reasoningContent}</think>${answerBody}`
}
