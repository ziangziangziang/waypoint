export interface ParsedMessagePart {
  type: 'text' | 'thinking'
  content: string
}

// Parse content to extract thinking blocks.
// Handles:
// 1) <think>...</think>
// 2) content...</think> (missing opening tag)
// 3) <think>... (unclosed tag during streaming)
// 4) tags with extra whitespace, e.g. <think >, </ think >
export function parseMessageContent(content: string): ParsedMessagePart[] {
  const parts: ParsedMessagePart[] = []
  const openTag = /<\s*think\s*>/i
  const closeTag = /<\s*\/\s*think\s*>/i

  const startsWithOpeningTag = openTag.test(content.trimStart())
  const hasClosingWithoutOpening = !startsWithOpeningTag && closeTag.test(content)

  let processedContent = content
  if (hasClosingWithoutOpening) {
    const closeMatch = closeTag.exec(content)
    if (closeMatch) {
      const closeIndex = closeMatch.index
      const thinkingContent = content.slice(0, closeIndex).trim()
      if (thinkingContent) {
        parts.push({ type: 'thinking', content: thinkingContent })
      }
      processedContent = content.slice(closeIndex + closeMatch[0].length)
    }
  }

  const closedThinkRegex = /<\s*think\s*>([\s\S]*?)<\s*\/\s*think\s*>/gi
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = closedThinkRegex.exec(processedContent)) !== null) {
    if (match.index > lastIndex) {
      const text = processedContent.slice(lastIndex, match.index).trim()
      if (text) {
        parts.push({ type: 'text', content: text })
      }
    }
    parts.push({ type: 'thinking', content: (match[1] ?? '').trim() })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < processedContent.length) {
    const tail = processedContent.slice(lastIndex)
    const unclosedMatch = tail.match(/([\s\S]*?)<\s*think\s*>([\s\S]*)$/i)
    if (unclosedMatch) {
      const textBefore = (unclosedMatch[1] ?? '').trim()
      const thinkingTail = (unclosedMatch[2] ?? '').trim()
      if (textBefore) {
        parts.push({ type: 'text', content: textBefore })
      }
      if (thinkingTail) {
        parts.push({ type: 'thinking', content: thinkingTail })
      }
    } else {
      const text = tail.trim()
      if (text) {
        parts.push({ type: 'text', content: text })
      }
    }
  }

  if (parts.length === 0 && content.trim()) {
    parts.push({ type: 'text', content: content.trim() })
  }

  return parts
}
