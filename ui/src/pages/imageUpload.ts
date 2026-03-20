export const MAX_UPLOAD_IMAGE_WIDTH = 720
export const MAX_UPLOAD_IMAGE_HEIGHT = 1280

export interface ImageDimensions {
  width: number
  height: number
}

export interface ResizedImageDimensions extends ImageDimensions {
  resized: boolean
}

export function calculateContainedImageSize(
  width: number,
  height: number,
  maxWidth: number = MAX_UPLOAD_IMAGE_WIDTH,
  maxHeight: number = MAX_UPLOAD_IMAGE_HEIGHT,
): ResizedImageDimensions {
  if (width <= 0 || height <= 0) {
    return { width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)), resized: false }
  }

  const needsResize = width > maxWidth || height > maxHeight
  if (!needsResize) {
    return { width, height, resized: false }
  }

  const scale = Math.min(maxWidth / width, maxHeight / height)
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    resized: true,
  }
}

export async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(reader.result as string)
    reader.readAsDataURL(file)
  })
}

export async function compressImageFileForUpload(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = objectUrl
    await image.decode()

    const target = calculateContainedImageSize(image.width, image.height)
    if (!target.resized) {
      return await fileToDataUrl(file)
    }

    const canvas = document.createElement('canvas')
    canvas.width = target.width
    canvas.height = target.height
    const context = canvas.getContext('2d')
    if (!context) {
      return await fileToDataUrl(file)
    }

    context.drawImage(image, 0, 0, target.width, target.height)
    const mimeType = file.type === 'image/jpeg' || file.type === 'image/png' ? file.type : 'image/png'
    return canvas.toDataURL(mimeType, mimeType === 'image/jpeg' ? 0.9 : undefined)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
