export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < maxAttempts - 1) {
        const delay = baseDelayMs * 2 ** attempt + Math.random() * 200
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }
  throw lastErr
}
