/**
 * Settings Store
 * 
 * Manages user preferences with localStorage persistence.
 */

export type ImageSize = '256x256' | '512x512' | '1024x1024' | '1024x1792' | '1792x1024'

export interface UserSettings {
  defaultImageSize: ImageSize
  // Future settings can be added here
}

const STORAGE_KEY = 'waypoint-settings'

const DEFAULT_SETTINGS: UserSettings = {
  defaultImageSize: '1024x1024',
}

// Available image size options
export const IMAGE_SIZE_OPTIONS: { value: ImageSize; label: string; aspect: string }[] = [
  { value: '256x256', label: '256×256', aspect: '1:1' },
  { value: '512x512', label: '512×512', aspect: '1:1' },
  { value: '1024x1024', label: '1024×1024', aspect: '1:1' },
  { value: '1024x1792', label: '1024×1792', aspect: '9:16 (Portrait)' },
  { value: '1792x1024', label: '1792×1024', aspect: '16:9 (Landscape)' },
]

export function loadSettings(): UserSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      return { ...DEFAULT_SETTINGS, ...parsed }
    }
  } catch (error) {
    console.error('Failed to load settings:', error)
  }
  return DEFAULT_SETTINGS
}

export function saveSettings(settings: UserSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch (error) {
    console.error('Failed to save settings:', error)
  }
}

export function updateSetting<K extends keyof UserSettings>(
  key: K,
  value: UserSettings[K]
): UserSettings {
  const settings = loadSettings()
  settings[key] = value
  saveSettings(settings)
  return settings
}
