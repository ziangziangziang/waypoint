import type { ChatMessage as ApiChatMessage, ContentPart } from '../api/client'

export interface PayloadMessage {
  role: ApiChatMessage['role']
  content: string | ContentPart[] | null
  images?: string[]
  requestImages?: string[]
}

export interface BuildUserPayloadInput {
  callModeEnabled: boolean
  text: string
  requestImageUrls: string[]
  displayImageRefs?: string[]
  audioRef?: string
}

export interface BuildUserPayloadResult {
  content: string | ContentPart[]
  images?: string[]
  requestImages?: string[]
}

export function buildUserPayload(input: BuildUserPayloadInput): BuildUserPayloadResult {
  const requestImages = input.requestImageUrls.filter(Boolean)
  const displayImages = input.displayImageRefs?.length ? input.displayImageRefs : requestImages
  const trimmedText = input.text.trim()

  const content: string | ContentPart[] = input.callModeEnabled
    ? [
        ...(input.audioRef ? [{ type: 'input_audio' as const, input_audio: { url: input.audioRef } }] : []),
        ...requestImages.map((img) => ({ type: 'image_url' as const, image_url: { url: img } })),
        ...(trimmedText ? [{ type: 'text' as const, text: trimmedText }] : []),
      ]
    : trimmedText

  return {
    content,
    images: displayImages.length > 0 ? displayImages : undefined,
    requestImages: requestImages.length > 0 ? requestImages : undefined,
  }
}

export function toApiMessage(message: PayloadMessage): ApiChatMessage {
  if (Array.isArray(message.content)) {
    return {
      role: message.role,
      content: message.content as unknown as ApiChatMessage['content'],
    }
  }

  const imagesForRequest = message.requestImages ?? message.images
  if (imagesForRequest && imagesForRequest.length > 0) {
    return {
      role: message.role,
      content: [
        ...(typeof message.content === 'string' && message.content
          ? [{ type: 'text' as const, text: message.content }]
          : []),
        ...imagesForRequest.map((img) => ({
          type: 'image_url' as const,
          image_url: { url: img },
        })),
      ],
    }
  }

  return { role: message.role, content: message.content }
}

export function findNonDataImageUrls(messages: ApiChatMessage[]): string[] {
  const urls: string[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue
    }
    for (const part of message.content) {
      if (
        part &&
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'image_url' &&
        'image_url' in part &&
        part.image_url &&
        typeof part.image_url === 'object' &&
        'url' in part.image_url &&
        typeof part.image_url.url === 'string'
      ) {
        const url = part.image_url.url
        if (!url.startsWith('data:image/')) {
          urls.push(url)
        }
      }
    }
  }
  return urls
}
