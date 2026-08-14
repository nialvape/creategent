import sharp from 'sharp'
import type { ComfyInputFile } from './transport'
import { extensionForMime } from './transport'

/**
 * Turning app-side media into files a ComfyUI graph can load.
 *
 * Every input goes in as base64 inside the job payload, so two things matter:
 * the filename extension (ComfyUI dispatches on it, and a loader node's combo
 * list is rebuilt from the input directory at validation time) and the size
 * (base64 inflates by a third, against a hard body limit on the submit call).
 */

/**
 * Long side an image input is downscaled to before it goes into the payload.
 *
 * Graphs rescale their first frame to their own working resolution before it
 * conditions anything, so every pixel above this is thrown away on the worker —
 * after being base64-inflated and counted against the body limit. A phone photo
 * alone can blow that limit.
 */
export const IMAGE_INPUT_MAX_SIDE = 1536

/** Fetches any URL — including `data:` URIs — as raw bytes. */
async function fetchBytes(url: string, what: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch the ${what} (${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Encodes an image for a graph's loader node: downscaled, flattened onto white
 * and re-encoded as JPEG.
 *
 * JPEG rather than the original PNG because a first frame is preprocessed on
 * the worker anyway — LTX's LTXVPreprocess (node 398:350) runs it through JPEG
 * compression at quality 18 — so holding out for lossless bytes buys nothing
 * and costs an order of magnitude in payload size. EXIF orientation is baked in
 * first, or a portrait photo arrives on its side; alpha is flattened onto white,
 * since JPEG has none and a transparent PNG would otherwise composite as black.
 *
 * An unreadable or exotic format is sent through as-is rather than failing the
 * run; the payload guard on submit explains it if it turns out to be too big.
 */
export async function encodeImageInput(
  url: string,
  name = 'input_image',
  maxSide = IMAGE_INPUT_MAX_SIDE
): Promise<ComfyInputFile> {
  const original = await fetchBytes(url, 'input image')

  try {
    const jpeg = await sharp(original)
      .rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 95, mozjpeg: true })
      .toBuffer()
    return { name: `${name}.jpg`, data: jpeg.toString('base64') }
  } catch (err) {
    console.warn('[comfy] could not downscale an input image, sending it as-is:', err)
    return { name: `${name}.png`, data: original.toString('base64') }
  }
}

/**
 * Encodes any other input — audio, video, a mask, a reference clip — untouched.
 *
 * The extension is taken from the URL when it has one, then from the response's
 * content type, because ComfyUI decides how to read the file from its name
 * alone. Getting it wrong surfaces as a graph validation error ("Value not in
 * list"), not as a decode failure, which is a confusing place to land.
 */
export async function encodeBinaryInput(
  url: string,
  name: string,
  fallbackMime = 'application/octet-stream'
): Promise<ComfyInputFile> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch the input file "${name}" (${res.status})`)
  const bytes = Buffer.from(await res.arrayBuffer())

  const mime = res.headers.get('content-type')?.split(';')[0].trim() || fallbackMime
  const ext = extensionFromUrl(url) ?? extensionForMime(mime)

  return { name: `${name}.${ext}`, data: bytes.toString('base64') }
}

/** Extension from a URL path, ignoring query strings and `data:` URIs. */
function extensionFromUrl(url: string): string | null {
  if (url.startsWith('data:')) return null
  try {
    const path = new URL(url).pathname
    const ext = path.split('.').pop()?.toLowerCase()
    // Guard against a dotless path returning the whole thing.
    return ext && ext !== path && /^[a-z0-9]{2,5}$/.test(ext) ? ext : null
  } catch {
    return null
  }
}
