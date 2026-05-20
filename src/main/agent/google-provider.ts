import {
  ProviderError,
  StreamResult,
  type ContentPart,
  type ProviderEntry,
  type StreamEvent,
  type StreamOptions,
  type StreamResponse,
  type Tool,
  type ToolCall,
  type ToolChoice,
  type ToolResultContent
} from '@prestyj/ai'
import { randomUUID } from 'crypto'
import { z } from 'zod'

export const GOOGLE_PROVIDER = 'google'
export const GEMINI_FLASH_MODEL = 'gemini-3.5-flash'
export const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

type JsonObject = Record<string, unknown>

type GeminiRole = 'user' | 'model'

interface GeminiTextPart {
  text: string
  thought?: boolean
  thoughtSignature?: string
  thought_signature?: string
}

interface GeminiInlineDataPart {
  inlineData: {
    mimeType: string
    data: string
  }
}

interface GeminiFunctionCallPart {
  functionCall: {
    id?: string
    name: string
    args?: JsonObject
  }
  thoughtSignature?: string
  thought_signature?: string
}

interface GeminiFunctionResponsePart {
  functionResponse: {
    id?: string
    name: string
    response: JsonObject
  }
}

type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart

interface GeminiContent {
  role?: GeminiRole
  parts: GeminiPart[]
}

interface GeminiTool {
  functionDeclarations: Array<{
    name: string
    description?: string
    parameters?: JsonObject
  }>
}

interface GeminiGenerationConfig {
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  thinkingConfig?: {
    includeThoughts?: boolean
    thinkingBudget?: number
    thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
  }
}

interface GeminiGenerateContentRequest {
  contents: GeminiContent[]
  systemInstruction?: GeminiContent
  tools?: GeminiTool[]
  toolConfig?: {
    functionCallingConfig: {
      mode: 'AUTO' | 'NONE' | 'ANY'
      allowedFunctionNames?: string[]
    }
  }
  generationConfig?: GeminiGenerationConfig
}

interface GeminiCandidate {
  content?: GeminiContent
  finishReason?: string
}

interface GeminiUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  cachedContentTokenCount?: number
}

interface GeminiGenerateResponse {
  candidates?: GeminiCandidate[]
  usageMetadata?: GeminiUsageMetadata
}

interface ParsedSseEvent {
  event?: string
  data: string
}

interface GeminiSignedToolCall extends ToolCall {
  thoughtSignature?: string
}

function isJsonObject(value: unknown): value is JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function stringifyToolContent(content: Exclude<ToolResultContent, string>): string {
  return content
    .map((part) => (part.type === 'text' ? part.text : `[image ${part.mediaType}]`))
    .join('\n')
}

function readThoughtSignature(value: unknown): string | undefined {
  if (!isJsonObject(value)) return undefined
  const camel = value.thoughtSignature
  if (typeof camel === 'string' && camel.length > 0) return camel
  const snake = value.thought_signature
  return typeof snake === 'string' && snake.length > 0 ? snake : undefined
}

function toSystemAndContents(messages: StreamOptions['messages']): {
  systemInstruction?: GeminiContent
  contents: GeminiContent[]
} {
  let systemText = ''
  const contents: GeminiContent[] = []
  const toolNamesById = new Map<string, string>()

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemText = systemText ? `${systemText}\n\n${msg.content}` : msg.content
      continue
    }

    if (msg.role === 'user') {
      contents.push({
        role: 'user',
        parts:
          typeof msg.content === 'string'
            ? [{ text: msg.content }]
            : msg.content.map((part): GeminiPart => {
                if (part.type === 'text') return { text: part.text }
                return { inlineData: { mimeType: part.mediaType, data: part.data } }
              })
      })
      continue
    }

    if (msg.role === 'assistant') {
      const parts: GeminiPart[] = []
      if (typeof msg.content === 'string') {
        if (msg.content) parts.push({ text: msg.content })
      } else {
        for (const part of msg.content) {
          if (part.type === 'text' && part.text) {
            parts.push({ text: part.text })
          } else if (part.type === 'thinking' && part.text) {
            parts.push({ text: part.text, thought: true })
          } else if (part.type === 'tool_call') {
            const signedPart = part as GeminiSignedToolCall
            toolNamesById.set(part.id, part.name)
            parts.push({
              functionCall: { id: part.id, name: part.name, args: part.args },
              ...(signedPart.thoughtSignature
                ? { thoughtSignature: signedPart.thoughtSignature }
                : {})
            })
          }
        }
      }
      if (parts.length > 0) contents.push({ role: 'model', parts })
      continue
    }

    if (msg.role === 'tool') {
      const parts: GeminiPart[] = []
      for (const result of msg.content) {
        const name = toolNamesById.get(result.toolCallId) ?? result.toolCallId
        const content =
          typeof result.content === 'string' ? result.content : stringifyToolContent(result.content)
        parts.push({
          functionResponse: {
            id: result.toolCallId,
            name,
            response: {
              content,
              ...(result.isError ? { isError: true } : {})
            }
          }
        })
      }
      if (parts.length > 0) contents.push({ role: 'user', parts })
    }
  }

  return {
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    contents
  }
}

function mergeUnionSchema(target: JsonObject, branches: unknown[]): void {
  const objectBranches = branches.filter(isJsonObject)
  if (objectBranches.length === 0) return

  const properties: JsonObject = {}
  const requiredCounts = new Map<string, number>()

  for (const branch of objectBranches) {
    if (isJsonObject(branch.properties)) {
      for (const [key, value] of Object.entries(branch.properties)) {
        properties[key] = value
      }
    }

    if (Array.isArray(branch.required)) {
      for (const key of branch.required) {
        if (typeof key === 'string') requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1)
      }
    }
  }

  if (Object.keys(properties).length > 0) {
    target.properties = { ...(isJsonObject(target.properties) ? target.properties : {}), ...properties }
  }

  if (typeof target.type !== 'string') target.type = 'object'

  const required = [...requiredCounts.entries()]
    .filter(([, count]) => count === objectBranches.length)
    .map(([key]) => key)
  if (required.length > 0) target.required = required
  else target.required = undefined
}

function hasSchemaShape(value: JsonObject): boolean {
  return (
    typeof value.type === 'string' ||
    Array.isArray(value.type) ||
    Array.isArray(value.enum) ||
    isJsonObject(value.properties) ||
    isJsonObject(value.items) ||
    Array.isArray(value.items) ||
    typeof value.description === 'string'
  )
}

function stripUnsupportedSchemaFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripUnsupportedSchemaFields(item)
    return
  }
  if (!isJsonObject(value)) return

  const unionBranches = Array.isArray(value.anyOf)
    ? value.anyOf
    : Array.isArray(value.oneOf)
      ? value.oneOf
      : undefined
  if (unionBranches) mergeUnionSchema(value, unionBranches)

  for (const key of [
    '$schema',
    '$id',
    '$defs',
    'definitions',
    'additionalProperties',
    'propertyNames',
    'unevaluatedProperties',
    'default',
    'examples',
    'example',
    'title',
    'const',
    'anyOf',
    'oneOf',
    'allOf',
    'not',
    'format',
    'pattern',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minItems',
    'maxItems',
    'uniqueItems',
    'multipleOf'
  ]) {
    delete value[key]
  }

  if (Array.isArray(value.type)) {
    const firstNonNullType = value.type.find((item) => item !== 'null')
    value.type = typeof firstNonNullType === 'string' ? firstNonNullType : 'string'
  }

  if (isJsonObject(value.properties)) {
    for (const [key, child] of Object.entries(value.properties)) {
      if (isJsonObject(child) && Object.keys(child).length === 0) {
        value.properties[key] = { type: 'string' }
        continue
      }
      stripUnsupportedSchemaFields(child)
      if (isJsonObject(child) && Object.keys(child).length === 0) {
        value.properties[key] = { type: 'string' }
      }
    }
  }

  if (isJsonObject(value.items)) {
    if (Object.keys(value.items).length === 0) {
      value.items = { type: 'string' }
    } else {
      stripUnsupportedSchemaFields(value.items)
      if (isJsonObject(value.items) && Object.keys(value.items).length === 0) {
        value.items = { type: 'string' }
      }
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'properties' || key === 'items') continue
    stripUnsupportedSchemaFields(child)
  }

  if (!hasSchemaShape(value) && Object.keys(value).length === 0) value.type = 'string'
}

function sanitizeSchema(schema: JsonObject): JsonObject {
  const clone = JSON.parse(JSON.stringify(schema)) as JsonObject
  stripUnsupportedSchemaFields(clone)
  return clone
}

function toGeminiTools(tools: Tool[] | undefined): GeminiTool[] | undefined {
  if (!tools?.length) return undefined
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: sanitizeSchema(tool.rawInputSchema ?? z.toJSONSchema(tool.parameters))
      }))
    }
  ]
}

function toGeminiToolConfig(
  choice: ToolChoice | undefined,
  tools: Tool[] | undefined
): GeminiGenerateContentRequest['toolConfig'] | undefined {
  if (!choice || !tools?.length) return undefined
  if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } }
  if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } }
  if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } }
  return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] } }
}

function isGemini3Model(model: string): boolean {
  return /^gemini-3(?:\.|-|$)/.test(model)
}

function toThinkingLevel(level: NonNullable<StreamOptions['thinking']>): 'low' | 'medium' | 'high' {
  if (level === 'low' || level === 'medium') return level
  return 'high'
}

function toThinkingBudget(level: NonNullable<StreamOptions['thinking']>): number {
  switch (level) {
    case 'low':
      return 1024
    case 'medium':
      return 8192
    case 'high':
    case 'max':
      return 24_576
  }
}

function toThinkingConfig(
  model: string,
  level: StreamOptions['thinking']
): GeminiGenerationConfig['thinkingConfig'] | undefined {
  if (!level) return undefined
  if (isGemini3Model(model)) {
    return { includeThoughts: true, thinkingLevel: toThinkingLevel(level) }
  }
  return { includeThoughts: true, thinkingBudget: toThinkingBudget(level) }
}

function buildGenerateRequest(options: StreamOptions): GeminiGenerateContentRequest {
  const { systemInstruction, contents } = toSystemAndContents(options.messages)
  const tools = toGeminiTools(options.tools)
  const toolConfig = toGeminiToolConfig(options.toolChoice, options.tools)
  const thinkingConfig = toThinkingConfig(options.model, options.thinking)
  const generationConfig: GeminiGenerationConfig = {
    ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
    ...(options.temperature != null && !options.thinking ? { temperature: options.temperature } : {}),
    ...(options.topP != null ? { topP: options.topP } : {}),
    ...(options.stop ? { stopSequences: options.stop } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {})
  }

  return {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(tools ? { tools } : {}),
    ...(toolConfig ? { toolConfig } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {})
  }
}

function getGeminiEndpoint(options: StreamOptions, method: string): URL {
  const baseUrl = (options.baseUrl ?? GEMINI_API_BASE_URL).replace(/\/+$/, '')
  const model = options.model.startsWith('models/') ? options.model.slice('models/'.length) : options.model
  return new URL(`${baseUrl}/models/${encodeURIComponent(model)}:${method}`)
}

function normalizeGeminiStopReason(reason: string | undefined): StreamResponse['stopReason'] {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'max_tokens'
    case 'STOP':
      return 'stop_sequence'
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

function formatGeminiError(status: number, body: string): string {
  const trimmedBody = body.trim()
  if (!trimmedBody) return `${status} status code (no body)`
  try {
    const parsed = JSON.parse(trimmedBody) as unknown
    if (isJsonObject(parsed) && isJsonObject(parsed.error)) {
      const message = parsed.error.message
      if (typeof message === 'string' && message.length > 0) return `${status}: ${message}`
    }
  } catch {
    // Use the raw body below.
  }
  return `${status}: ${trimmedBody}`
}

function formatGeminiSseParseError(event: ParsedSseEvent, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const body = event.data.trim()
  return body
    ? `Failed to parse Gemini stream event: ${message}. Event data: ${body.slice(0, 1000)}`
    : `Failed to parse Gemini stream event: ${message}`
}

function parseSseEvents(buffer: string): { events: ParsedSseEvent[]; remaining: string } {
  const events: ParsedSseEvent[] = []
  let cursor = 0

  while (true) {
    const next = buffer.indexOf('\n\n', cursor)
    if (next === -1) break
    const raw = buffer.slice(cursor, next)
    cursor = next + 2

    let eventName: string | undefined
    const dataLines: string[] = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart())
    }

    if (dataLines.length > 0) events.push({ event: eventName, data: dataLines.join('\n') })
  }

  return { events, remaining: buffer.slice(cursor) }
}

async function* streamSse(response: Response): AsyncGenerator<GeminiGenerateResponse> {
  if (!response.body) return

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      const parsed = parseSseEvents(buffer)
      buffer = parsed.remaining
      for (const event of parsed.events) {
        if (event.data === '[DONE]') continue
        try {
          yield JSON.parse(event.data) as GeminiGenerateResponse
        } catch (error) {
          throw new ProviderError(GOOGLE_PROVIDER, formatGeminiSseParseError(event, error), { cause: error })
        }
      }
    }

    buffer += decoder.decode().replace(/\r\n/g, '\n')
    const parsed = parseSseEvents(`${buffer}\n\n`)
    for (const event of parsed.events) {
      if (event.data === '[DONE]') continue
      try {
        yield JSON.parse(event.data) as GeminiGenerateResponse
      } catch (error) {
        throw new ProviderError(GOOGLE_PROVIDER, formatGeminiSseParseError(event, error), { cause: error })
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function partsFromResponse(response: GeminiGenerateResponse): GeminiPart[] {
  return response.candidates?.[0]?.content?.parts ?? []
}

function usageFromResponse(response: GeminiGenerateResponse): GeminiUsageMetadata | undefined {
  return response.usageMetadata
}

function finishReasonFromResponse(response: GeminiGenerateResponse): string | undefined {
  return response.candidates?.[0]?.finishReason
}

function readTextPart(part: GeminiPart): { text: string; thought: boolean } | undefined {
  return 'text' in part ? { text: part.text, thought: part.thought === true } : undefined
}

function readFunctionCallPart(
  part: GeminiPart
): { id?: string; name: string; args: JsonObject; thoughtSignature?: string } | undefined {
  const rawCall = (part as { functionCall?: unknown; function_call?: unknown }).functionCall
    ?? (part as { function_call?: unknown }).function_call
  if (!isJsonObject(rawCall) || typeof rawCall.name !== 'string') return undefined
  const id = typeof rawCall.id === 'string' ? rawCall.id : undefined
  const thoughtSignature = readThoughtSignature(part)
  return {
    ...(id ? { id } : {}),
    name: rawCall.name,
    args: isJsonObject(rawCall.args) ? rawCall.args : {},
    ...(thoughtSignature ? { thoughtSignature } : {})
  }
}

function makeToolCallId(index: number, providerId?: string): string {
  return providerId ?? `gemini_call_${index}_${randomUUID().replace(/-/g, '')}`
}

async function fetchGemini(
  url: URL,
  request: GeminiGenerateContentRequest,
  options: StreamOptions
): Promise<Response> {
  if (!options.apiKey) {
    throw new ProviderError(
      GOOGLE_PROVIDER,
      'Missing Gemini API key. Add it in settings or set GEMINI_API_KEY.'
    )
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': options.apiKey
      },
      body: JSON.stringify(request),
      signal: options.signal
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new ProviderError(GOOGLE_PROVIDER, formatGeminiError(response.status, body), {
        statusCode: response.status
      })
    }

    return response
  } catch (error) {
    throw toError(error)
  }
}

export function createGoogleProviderEntry(): ProviderEntry {
  return {
    stream: (options: StreamOptions) => new StreamResult(runStream(options))
  }
}

async function* runStream(options: StreamOptions): AsyncGenerator<StreamEvent, StreamResponse> {
  const useStreaming = options.streaming !== false
  const method = useStreaming ? 'streamGenerateContent' : 'generateContent'
  const url = getGeminiEndpoint(options, method)
  if (useStreaming) url.searchParams.set('alt', 'sse')

  const request = buildGenerateRequest(options)
  const response = await fetchGemini(url, request, options)

  const contentParts: ContentPart[] = []
  const pendingToolCalls: GeminiSignedToolCall[] = []
  let textAccum = ''
  let thinkingAccum = ''
  let stopReason: StreamResponse['stopReason'] = 'end_turn'
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let toolIndex = 0

  const handleResponse = function* (chunk: GeminiGenerateResponse): Generator<StreamEvent> {
    const usage = usageFromResponse(chunk)
    if (usage) {
      inputTokens = usage.promptTokenCount ?? inputTokens
      outputTokens = usage.candidatesTokenCount ?? outputTokens
      cacheRead = usage.cachedContentTokenCount ?? cacheRead
    }

    const reason = finishReasonFromResponse(chunk)
    if (reason) stopReason = normalizeGeminiStopReason(reason)

    for (const part of partsFromResponse(chunk)) {
      const textPart = readTextPart(part)
      if (textPart) {
        if (textPart.thought) {
          thinkingAccum += textPart.text
          yield { type: 'thinking_delta', text: textPart.text }
        } else {
          textAccum += textPart.text
          yield { type: 'text_delta', text: textPart.text }
        }
        continue
      }

      const functionCall = readFunctionCallPart(part)
      if (functionCall) {
        const id = makeToolCallId(toolIndex, functionCall.id)
        toolIndex += 1
        const argsJson = JSON.stringify(functionCall.args)
        pendingToolCalls.push({
          type: 'tool_call',
          id,
          name: functionCall.name,
          args: functionCall.args,
          ...(functionCall.thoughtSignature
            ? { thoughtSignature: functionCall.thoughtSignature }
            : {})
        })
        yield { type: 'toolcall_delta', id, name: functionCall.name, argsJson }
      }
    }
  }

  try {
    if (useStreaming) {
      for await (const chunk of streamSse(response)) yield* handleResponse(chunk)
    } else {
      yield* handleResponse((await response.json()) as GeminiGenerateResponse)
    }
  } catch (error) {
    throw toError(error)
  }

  if (thinkingAccum) contentParts.push({ type: 'thinking', text: thinkingAccum })
  if (textAccum) contentParts.push({ type: 'text', text: textAccum })

  for (const toolCall of pendingToolCalls) {
    contentParts.push(toolCall)
    yield { type: 'toolcall_done', id: toolCall.id, name: toolCall.name, args: toolCall.args }
  }

  if (pendingToolCalls.length > 0) stopReason = 'tool_use'

  const adjustedInputTokens = Math.max(0, inputTokens - cacheRead)
  const streamResponse: StreamResponse = {
    message: {
      role: 'assistant',
      content: contentParts.length > 0 ? contentParts : textAccum
    },
    stopReason,
    usage: {
      inputTokens: adjustedInputTokens,
      outputTokens,
      ...(cacheRead > 0 ? { cacheRead } : {})
    }
  }

  yield { type: 'done', stopReason }
  return streamResponse
}

function toError(error: unknown): Error {
  if (error instanceof ProviderError) return error
  if (error instanceof Error) return new ProviderError(GOOGLE_PROVIDER, error.message, { cause: error })
  return new ProviderError(GOOGLE_PROVIDER, String(error))
}
