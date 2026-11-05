/**
 * Bilingual learning helper — Host half.
 *
 * The browser half cannot reach the Host translator service directly, so this
 * half owns one small JSON endpoint on the same Web origin the GUI is served
 * from. `POST /dsh-en-translation/translate` turns one message's text into the
 * target language through `ctx.translator` (an anonymous Bing/Google endpoint by
 * default, so no account, key, or model usage is involved), and
 * `GET /dsh-en-translation/health` reports whether that service is mounted.
 *
 * A short-lived `POST /dsh-en-translation/debug` sink writes client beacons to a
 * temp file while DEBUG is true; it exists so the plugin can be exercised
 * without browser control and is a no-op in normal operation.
 *
 * @module @local/dsh-en-translation
 */
import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Hard dependency: the Web carrier owns the route table this half registers into. */
export const inject = ['webServer'];

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/dsh-en-translation';
/** Temp file receiving development beacons from the browser half. */
const DEBUG_FILE = join(tmpdir(), 'dsh-en-translation-debug.jsonl');
/** Maximum accepted request body, in bytes. */
const MAX_BODY_BYTES = 256 * 1024;
/** Maximum source characters translated by one call. */
const MAX_TEXT_CHARS = 20000;
/** Chunk size kept well below the translator's `maxTextChars` default (4000). */
const CHUNK_CHARS = 3000;
/** Per-request deadline for one whole translation (all chunks). */
const REQUEST_TIMEOUT_MS = 60000;
/** Development beacon sink switch. */
const DEBUG = false;
/** Maximum number of debug lines accepted per Host process. */
const DEBUG_LINE_LIMIT = 400;

/** Error carrying a stable code for the browser half. */
class PluginError extends Error {
  /**
   * @param {string} code stable machine-readable code.
   * @param {string} message human-readable description.
   */
  constructor(code, message) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
  }
}

/**
 * Read a bounded UTF-8 request body.
 * @param {import('node:http').IncomingMessage} req incoming request.
 * @returns {Promise<string>} decoded body.
 */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new PluginError('REQUEST_TOO_LARGE', `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Send one JSON response.
 * @param {import('node:http').ServerResponse} res response to complete.
 * @param {number} status HTTP status code.
 * @param {unknown} payload JSON-serializable payload.
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/**
 * Reject cross-origin callers: the endpoint exists for this GUI only.
 * @param {import('node:http').IncomingMessage} req incoming request.
 * @param {string} origin advertised Web origin.
 * @returns {boolean} whether the request may proceed.
 */
function originAllowed(req, origin) {
  const requestOrigin = req.headers.origin;
  if (requestOrigin === undefined || requestOrigin === '') return true;
  if (requestOrigin === origin) return true;
  try {
    return new URL(requestOrigin).host === new URL(origin).host;
  } catch {
    return false;
  }
}

/**
 * Normalize the row configuration.
 * @param {unknown} config Loader row config.
 * @returns {{ targetLanguage: string, provider: string | undefined }} resolved settings.
 */
function readConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {};
  const targetLanguage = typeof source.targetLanguage === 'string' && source.targetLanguage.length > 0 ? source.targetLanguage : 'en';
  const provider = typeof source.provider === 'string' && source.provider.length > 0 ? source.provider : undefined;
  return { targetLanguage, provider };
}

/**
 * Split one long text into provider-sized chunks on paragraph boundaries.
 * @param {string} text source text.
 * @returns {string[]} non-empty chunks.
 */
function splitText(text) {
  const chunks = [];
  let buffer = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    const piece = paragraph.trim();
    if (piece.length === 0) continue;
    if (piece.length > CHUNK_CHARS) {
      if (buffer.length > 0) {
        chunks.push(buffer);
        buffer = '';
      }
      for (let start = 0; start < piece.length; start += CHUNK_CHARS) chunks.push(piece.slice(start, start + CHUNK_CHARS));
      continue;
    }
    const candidate = buffer.length === 0 ? piece : `${buffer}\n\n${piece}`;
    if (candidate.length > CHUNK_CHARS && buffer.length > 0) {
      chunks.push(buffer);
      buffer = piece;
    } else {
      buffer = candidate;
    }
  }
  if (buffer.length > 0) chunks.push(buffer);
  return chunks;
}

/**
 * Translate one message, chunk by chunk, through the Host translator service.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {{ targetLanguage: string, provider: string | undefined }} settings resolved settings.
 * @param {string} text source text.
 * @param {string | undefined} sessionId active Session for paid providers (`deepseek-account` / `deepseek-official`); omitted for anonymous providers.
 * @param {AbortSignal} signal cancellation for the whole call.
 * @returns {Promise<{ translation: string, chunks: number }>} translated text.
 */
async function translateText(ctx, settings, text, sessionId, signal) {
  const translator = ctx.get('translator');
  if (translator === undefined || translator === null) {
    throw new PluginError('TRANSLATOR_UNAVAILABLE', 'The Host translator service is not mounted, so translation is unavailable.');
  }
  const chunks = splitText(text);
  if (chunks.length === 0) throw new PluginError('EMPTY_TEXT', 'There is no text to translate.');
  if (chunks.length > 40) throw new PluginError('TEXT_TOO_LONG', 'This message is too long to translate in one request.');
  const translated = [];
  for (const chunk of chunks) {
    const request = { text: chunk, targetLanguage: settings.targetLanguage };
    if (settings.provider !== undefined) request.provider = settings.provider;
    // Paid providers durably key their work on a Session; anonymous ones ignore it.
    if (sessionId !== undefined) request.sessionId = sessionId;
    let spec;
    try {
      spec = translator.resolve(request);
    } catch (error) {
      throw new PluginError('RESOLVE_FAILED', `Cannot resolve a translation route: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      translated.push(await translator.translate(spec, signal));
    } catch (error) {
      if (signal.aborted) throw error;
      throw new PluginError('TRANSLATE_FAILED', `Translation request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { translation: translated.join('\n\n'), chunks: chunks.length };
}

/**
 * Host plugin body: register the translation endpoints on the Web carrier.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {unknown} config Loader row config.
 */
export function apply(ctx, config) {
  const settings = readConfig(config);
  let debugLines = 0;

  const origin = () => {
    try {
      return ctx.webServer.getOrigin();
    } catch {
      return 'http://127.0.0.1';
    }
  };

  /**
   * Append one client beacon while the debug sink is enabled.
   * @param {unknown} payload beacon payload.
   */
  const recordDebug = async (payload) => {
    if (!DEBUG) return;
    if (debugLines >= DEBUG_LINE_LIMIT) return;
    debugLines += 1;
    const line = `${JSON.stringify({ time: new Date().toISOString(), ...(payload !== null && typeof payload === 'object' ? payload : { payload }) })}\n`;
    try {
      await appendFile(DEBUG_FILE, line, 'utf8');
    } catch {
      // Diagnostics must never break the feature.
    }
  };

  ctx.effect(() => {
    const disposeHealth = ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/health`,
      handler: async (req, res) => {
        if (!originAllowed(req, origin())) return sendJson(res, 403, { ok: false, error: { code: 'ORIGIN_REJECTED', message: 'Cross-origin callers are not allowed.' } });
        const translator = ctx.get('translator');
        let providers = [];
        if (translator !== undefined && translator !== null && typeof translator.availableProviders === 'function') {
          try {
            const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(2000) : undefined;
            providers = [...(await translator.availableProviders(signal))];
          } catch {
            providers = [];
          }
        }
        sendJson(res, 200, {
          ok: true,
          translator: translator !== undefined && translator !== null,
          providers,
          targetLanguage: settings.targetLanguage,
          provider: settings.provider ?? null,
          origin: origin(),
          debug: DEBUG,
        });
      },
    });

    const disposeTranslate = ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/translate`,
      handler: async (req, res) => {
        if (!originAllowed(req, origin())) return sendJson(res, 403, { ok: false, error: { code: 'ORIGIN_REJECTED', message: 'Cross-origin callers are not allowed.' } });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } });
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch (error) {
          const code = error instanceof PluginError ? error.code : 'INVALID_JSON';
          return sendJson(res, code === 'REQUEST_TOO_LARGE' ? 413 : 400, { ok: false, error: { code, message: error instanceof Error ? error.message : 'Cannot read the request body.' } });
        }
        const text = payload !== null && typeof payload === 'object' && typeof payload.text === 'string' ? payload.text.trim() : '';
        if (text.length === 0) return sendJson(res, 400, { ok: false, error: { code: 'EMPTY_TEXT', message: 'Nothing to translate.' } });
        if (text.length > MAX_TEXT_CHARS) return sendJson(res, 413, { ok: false, error: { code: 'TEXT_TOO_LONG', message: `Text exceeds ${MAX_TEXT_CHARS} characters.` } });
        const sessionId = payload !== null && typeof payload === 'object' && typeof payload.sessionId === 'string' && payload.sessionId.length > 0 ? payload.sessionId : undefined;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('Translation deadline exceeded.')), REQUEST_TIMEOUT_MS);
        const closed = () => controller.abort(new Error('Client disconnected.'));
        req.once('close', closed);
        try {
          const started = Date.now();
          const result = await translateText(ctx, settings, text, sessionId, controller.signal);
          const elapsedMs = Date.now() - started;
          void recordDebug({ event: 'host-translated', chars: text.length, chunks: result.chunks, elapsedMs });
          sendJson(res, 200, { ok: true, translation: result.translation, targetLanguage: settings.targetLanguage, chunks: result.chunks, elapsedMs });
        } catch (error) {
          // `readBody` consumes the request through its async iterator, which
          // destroys the IncomingMessage, so `req.destroyed` cannot tell us
          // whether the client is still listening. The response object can.
          if (res.destroyed || res.writableEnded) return;
          const code = error instanceof PluginError ? error.code : 'TRANSLATE_FAILED';
          const message = error instanceof Error ? error.message : 'Translation failed.';
          void recordDebug({ event: 'host-error', code, message });
          sendJson(res, 502, { ok: false, error: { code, message } });
        } finally {
          clearTimeout(timer);
          req.off('close', closed);
        }
      },
    });

    const disposeDebug = ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/debug`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } });
        let payload = null;
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          return sendJson(res, 400, { ok: false, error: { code: 'INVALID_JSON', message: 'Cannot read the request body.' } });
        }
        void recordDebug(payload);
        sendJson(res, 200, { ok: true });
      },
    });

    return () => {
      disposeHealth();
      disposeTranslate();
      disposeDebug();
    };
  }, 'en-translation: routes');
}
