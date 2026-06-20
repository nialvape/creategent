export interface PlatformSpec {
  name: string
  formats: {
    feed?: { width: number; height: number; aspectRatio: string }
    story?: { width: number; height: number; aspectRatio: string }
    reel?: { width: number; height: number; aspectRatio: string; maxDuration: number }
    short?: { width: number; height: number; aspectRatio: string; maxDuration: number }
  }
  maxVideoDuration?: number
  captionLimit?: number
  hashtagLimit?: number
}

export const PLATFORM_SPECS: Record<string, PlatformSpec> = {
  instagram: {
    name: 'Instagram',
    formats: {
      feed: { width: 1080, height: 1080, aspectRatio: '1:1' },
      story: { width: 1080, height: 1920, aspectRatio: '9:16' },
      reel: { width: 1080, height: 1920, aspectRatio: '9:16', maxDuration: 90 },
    },
    captionLimit: 2200,
    hashtagLimit: 30,
  },
  tiktok: {
    name: 'TikTok',
    formats: {
      short: { width: 1080, height: 1920, aspectRatio: '9:16', maxDuration: 180 },
    },
    captionLimit: 2200,
    hashtagLimit: 10,
  },
  youtube: {
    name: 'YouTube',
    formats: {
      feed: { width: 1920, height: 1080, aspectRatio: '16:9' },
      short: { width: 1080, height: 1920, aspectRatio: '9:16', maxDuration: 60 },
    },
    captionLimit: 5000,
  },
  x: {
    name: 'X (Twitter)',
    formats: {
      feed: { width: 1200, height: 675, aspectRatio: '16:9' },
    },
    captionLimit: 280,
    hashtagLimit: 2,
  },
  linkedin: {
    name: 'LinkedIn',
    formats: {
      feed: { width: 1200, height: 627, aspectRatio: '1.91:1' },
    },
    captionLimit: 3000,
    hashtagLimit: 5,
  },
  facebook: {
    name: 'Facebook',
    formats: {
      feed: { width: 1200, height: 630, aspectRatio: '1.91:1' },
      reel: { width: 1080, height: 1920, aspectRatio: '9:16', maxDuration: 90 },
    },
    captionLimit: 63206,
    hashtagLimit: 10,
  },
}

export function getPlatformSpec(platform: string): PlatformSpec | undefined {
  return PLATFORM_SPECS[platform.toLowerCase()]
}
