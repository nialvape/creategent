/**
 * Browser-side file upload. Media goes straight from the browser to Supabase
 * Storage through a signed URL, never through an API route, because Vercel
 * rejects a serverless request body over 4.5 MB at the edge — a limit ordinary
 * photos and any video clip exceed.
 */

/**
 * Parses a JSON response, reporting a non-JSON body as what it actually is.
 * Platform-level failures answer with plain text or HTML rather than JSON
 * ("Request Entity Too Large" for an oversized body, an error page for a
 * gateway timeout), and `res.json()` on those reports a parser error that says
 * nothing about the real problem.
 */
export async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(describeNonJson(res, text))
  }
}

function describeNonJson(res: Response, body: string): string {
  if (res.status === 413) {
    return 'File too large — the request exceeded the 4.5 MB limit the host puts on an API request.'
  }
  if (res.status === 504) {
    return 'The request timed out at the host before the server answered.'
  }
  const snippet = body
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
  return `${res.status} ${res.statusText || 'error'}${snippet ? `: ${snippet}` : ''}`
}

/**
 * Uploads one file to the project's bucket and returns its public URL.
 * Two hops: mint a signed URL through the app (auth-gated, tiny body), then PUT
 * the bytes to Supabase.
 */
export async function uploadFile(file: File, projectId: string): Promise<string> {
  const signRes = await fetch('/api/upload/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, projectId }),
  })
  const sign = await readJson<{ signedUrl?: string; url?: string; error?: string }>(signRes)
  if (!signRes.ok || !sign.signedUrl || !sign.url) {
    throw new Error(sign.error ?? `Could not start the upload (${signRes.status})`)
  }

  const put = await fetch(sign.signedUrl, {
    method: 'PUT',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'cache-control': 'max-age=3600',
    },
    body: file,
  })
  if (!put.ok) {
    const detail = (await put.text().catch(() => '')).slice(0, 160)
    throw new Error(`Storage rejected the file (${put.status})${detail ? `: ${detail}` : ''}`)
  }

  return sign.url
}
