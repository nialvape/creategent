import { ElevenLabsClient } from 'elevenlabs'
import { withRetry } from '@/lib/retry'
import type { AudioProvider, GenerationResult } from '@/types/provider'

export class ElevenLabsAdapter implements AudioProvider {
  private client: ElevenLabsClient

  constructor(apiKey: string) {
    this.client = new ElevenLabsClient({ apiKey })
  }

  async generateSpeech(params: {
    text: string
    voiceId: string
    modelId?: string
    maxAttempts?: number
  }): Promise<GenerationResult<Buffer>> {
    const audioStream = await withRetry(
      () => this.client.textToSpeech.convert(params.voiceId, {
        text: params.text,
        model_id: params.modelId ?? 'eleven_multilingual_v2',
        output_format: 'mp3_44100_128',
      }),
      params.maxAttempts ?? 3
    )

    const chunks: Buffer[] = []
    for await (const chunk of audioStream) {
      chunks.push(Buffer.from(chunk))
    }
    const data = Buffer.concat(chunks)

    // ElevenLabs charges ~$0.30 per 1k characters
    const cost = (params.text.length / 1000) * 0.30

    return {
      data,
      cost,
      model: params.modelId ?? 'eleven_multilingual_v2',
      provider: 'elevenlabs',
    }
  }

  async listVoices(): Promise<Array<{ id: string; name: string; preview_url?: string }>> {
    const response = await this.client.voices.getAll()
    return (response.voices ?? []).map((v) => ({
      id: v.voice_id,
      name: v.name ?? v.voice_id,
      preview_url: v.preview_url ?? undefined,
    }))
  }
}
