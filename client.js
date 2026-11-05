/**
 * Bilingual learning helper — browser half.
 *
 * Contributes one row under every chat question and every finalized answer: a
 * compact `EN` button that reveals the full English translation of that exact
 * message, so the original and its translation stay aligned while reading.
 *
 * Placement uses the sanctioned extension point for a Chat row: two Conversation
 * Definitions (one for `user/message`, one for `assistant/message`) publish a
 * Node whose kind is rendered by this plugin's own `conversation.chat.node`
 * entry. The row is anchored on the message's own sequence number, which places
 * it immediately after that message's shipped row.
 *
 * Text reaches the Host translator service through a small same-origin JSON
 * endpoint owned by `index.js` — the browser half cannot call a Host service
 * directly.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-bilingual-helper',
  factory(require) {
    /** React runtime from the browser module table. */
    const React = require('react');
    /** Element factory shorthand. */
    const h = React.createElement;

    /** Client locale namespace owned by this plugin. */
    const NS = 'dsh-en-translation';
    /** Renderer dispatch key registered in `conversation.chat.node`. */
    const RENDER_KIND = 'en-translation';
    /** Conversation Definition registry keys. */
    const DEFINITION_KINDS = {
      question: 'en-translation-question',
      answer: 'en-translation-answer',
    };
    /** Host endpoints owned by this bundle's Host half. */
    const TRANSLATE_ENDPOINT = '/dsh-en-translation/translate';
    /** Development beacon sink; the Host half owns this route. */
    const DEBUG_ENDPOINT = '/dsh-en-translation/debug';
    /**
     * Development switch. When true the row posts short JSON beacons about its
     * own lifecycle to `/dsh-en-translation/debug` (the Host half appends them to
     * a temp file) — the mechanism used to verify the row without browser
     * control. Off in normal use: nothing leaves the page except a translation
     * the user explicitly asked for.
     */
    const DEBUG = false;
    /** Per-request deadline on the browser side. */
    const REQUEST_TIMEOUT_MS = 90000;
    /** Module-level translation cache so collapsing and re-expanding is instant. */
    const translationCache = new Map();
    /** Beacon cap per page load. */
    let beaconBudget = 120;

    /** Locale dictionaries for the visible UI text. */
    const DICTIONARIES = {
      en: {
        'action.translate': 'English translation',
        'action.hide': 'Hide translation',
        'action.loading': 'Translating…',
        'action.retry': 'Retry',
        'panel.title': 'English',
        'panel.question': 'Question',
        'panel.answer': 'Answer',
        'panel.noChinese': 'This message already appears to be in English.',
        'panel.failed': 'Translation failed',
        'tip.translate': 'Show the full English translation of this message',
        'tip.hide': 'Hide the English translation',
      },
      zh: {
        'action.translate': '英文翻译',
        'action.hide': '收起翻译',
        'action.loading': '翻译中…',
        'action.retry': '重试',
        'panel.title': '英文',
        'panel.question': '提问',
        'panel.answer': '回答',
        'panel.noChinese': '这条消息看起来已经是英文了。',
        'panel.failed': '翻译失败',
        'tip.translate': '展开这条消息的完整英文翻译',
        'tip.hide': '收起英文翻译',
      },
    };

    /** Stylesheet for this plugin's row, inserted once by `apply`. */
    const CSS = `
.dshEnTrans_row{display:flex;flex-direction:column;align-items:stretch;gap:6px;width:100%;margin:2px 0 4px;box-sizing:border-box}
.dshEnTrans_actions{display:flex;justify-content:flex-start}
.dshEnTrans_row[data-role="question"] .dshEnTrans_actions{justify-content:flex-end}
.dshEnTrans_button{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:background .12s ease,color .12s ease,border-color .12s ease}
.dshEnTrans_button:hover{background:color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dshEnTrans_button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshEnTrans_button[data-phase="loading"]{cursor:progress;opacity:.75}
.dshEnTrans_badge{font-size:10px;font-weight:600;letter-spacing:.02em;padding:1px 4px;border-radius:4px;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent);color:var(--dsw-alias-brand-primary)}
.dshEnTrans_panel{box-sizing:border-box;max-width:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px}
.dshEnTrans_head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.dshEnTrans_title{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.dshEnTrans_meta{font-size:11px;color:var(--dsw-alias-state-idle-primary)}
.dshEnTrans_body{font-size:14px;line-height:1.65;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;max-height:65vh;overflow-y:auto;overscroll-behavior:contain}
.dshEnTrans_error{font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.dshEnTrans_note{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
`;

    /** Matches any CJK ideograph, kana, or hangul syllable. */
    const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

    /**
     * Post one development beacon to the Host sink.
     * @param {string} event short event name.
     * @param {Record<string, unknown>} [detail] JSON-serializable detail.
     */
    function beacon(event, detail) {
      if (!DEBUG || beaconBudget <= 0) return;
      beaconBudget -= 1;
      try {
        void fetch(DEBUG_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event, detail: trimDetail(detail) }),
          keepalive: true,
        }).catch(() => {});
      } catch {
        // Diagnostics must never break the feature.
      }
    }

    /**
     * Keep beacon payloads small and JSON-safe.
     * @param {unknown} detail raw detail.
     * @returns {unknown} bounded detail.
     */
    function trimDetail(detail) {
      if (detail === null || typeof detail !== 'object') return detail ?? null;
      const out = {};
      for (const [key, value] of Object.entries(detail)) {
        if (typeof value === 'string') out[key] = value.length > 240 ? `${value.slice(0, 240)}…` : value;
        else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
        else if (Array.isArray(value)) out[key] = value.slice(0, 40);
        else if (typeof value === 'object') out[key] = trimDetail(value);
      }
      return out;
    }

    /**
     * Describe an error for display and diagnostics.
     * @param {unknown} error thrown value.
     * @returns {string} message text.
     */
    function messageOf(error) {
      if (error instanceof Error && error.message.length > 0) return error.message;
      const text = String(error);
      return text.length > 0 ? text : 'Unknown error';
    }

    /**
     * Collect the plain text of one message's content blocks.
     * @param {unknown} content message content blocks.
     * @returns {string} joined text.
     */
    function collectText(content) {
      if (!Array.isArray(content)) return '';
      const parts = [];
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) parts.push(block.text.trim());
      }
      return parts.join('\n\n').trim();
    }

    /**
     * Split text into prose and fenced-code segments so code is never translated.
     * @param {string} text message text.
     * @returns {Array<{ code: boolean, text: string }>} ordered segments.
     */
    function splitFences(text) {
      const segments = [];
      const fence = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2|$)/g;
      let cursor = 0;
      let match;
      while ((match = fence.exec(text)) !== null) {
        if (match.index > cursor) segments.push({ code: false, text: text.slice(cursor, match.index) });
        segments.push({ code: true, text: match[0] });
        cursor = match.index + match[0].length;
      }
      if (cursor < text.length) segments.push({ code: false, text: text.slice(cursor) });
      return segments.filter((segment) => segment.text.length > 0);
    }

    /**
     * Stable cache key for one message text.
     * @param {string} text message text.
     * @returns {string} cache key.
     */
    function cacheKey(text) {
      let hash = 5381;
      for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
      return `${text.length}:${hash.toString(36)}`;
    }

    /**
     * Read one cached translation.
     * @param {string} text message text.
     * @returns {string | undefined} cached translation.
     */
    function readCache(text) {
      return translationCache.get(cacheKey(text));
    }

    /**
     * Store one translation in the page-local cache.
     * @param {string} text message text.
     * @param {string} translation translated text.
     */
    function writeCache(text, translation) {
      if (translationCache.size > 200) translationCache.clear();
      translationCache.set(cacheKey(text), translation);
    }

    /**
     * Translate each prose segment through the Host endpoint, keeping code intact.
     * @param {string} text message text.
     * @param {string | undefined} sessionId owning Session id, required by paid routes.
     * @param {AbortSignal} [signal] cancellation.
     * @returns {Promise<string>} translated message text.
     */
    async function translateMessage(text, sessionId, signal) {
      const segments = splitFences(text);
      const output = [];
      for (const segment of segments) {
        if (segment.code) {
          output.push(segment.text);
          continue;
        }
        const prose = segment.text.trim();
        if (prose.length === 0) {
          output.push(segment.text);
          continue;
        }
        output.push(await requestTranslation(prose, sessionId, signal));
      }
      return output.join('\n\n').trim();
    }

    /**
     * Call the Host translation endpoint for one prose fragment.
     * @param {string} text prose text.
     * @param {string | undefined} sessionId owning Session id, required by paid routes.
     * @param {AbortSignal} [signal] cancellation.
     * @returns {Promise<string>} translated text.
     */
    async function requestTranslation(text, sessionId, signal) {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
      let timer;
      let relay;
      if (controller !== undefined) {
        timer = setTimeout(() => controller.abort(new Error('Translation timed out.')), REQUEST_TIMEOUT_MS);
        if (signal !== undefined) {
          relay = () => controller.abort(signal.reason);
          if (signal.aborted) relay();
          else signal.addEventListener('abort', relay, { once: true });
        }
      }
      const activeSignal = controller?.signal ?? signal;
      try {
        const response = await fetch(TRANSLATE_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(sessionId === undefined ? { text } : { text, sessionId }),
          signal: activeSignal,
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload === null || payload.ok !== true) {
          const detail = payload?.error;
          const suffix = detail?.code ? ` (${detail.code})` : '';
          throw new Error(`${detail?.message ?? `Translation endpoint returned HTTP ${response.status}.`}${suffix}`);
        }
        if (typeof payload.translation !== 'string' || payload.translation.length === 0) throw new Error('The translation endpoint returned no text.');
        return payload.translation;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (relay !== undefined && signal !== undefined) signal.removeEventListener('abort', relay);
      }
    }

    /**
     * One translation row under a chat message.
     * @param {Record<string, unknown>} props slot props.
     * @returns {import('react').ReactElement} row element.
     */
    function TranslationRow(props) {
      const translate = typeof props.t === 'function' ? props.t : (key) => key;
      const node = props.node !== null && typeof props.node === 'object' ? props.node : {};
      const data = node.data !== null && typeof node.data === 'object' ? node.data : {};
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      const role = data.role === 'answer' ? 'answer' : 'question';
      // The Chat renderer receives the owning Session through standard props; paid
      // translation routes require it, anonymous ones simply ignore it.
      const sessionId = typeof props.sessionId === 'string' && props.sessionId.length > 0 ? props.sessionId : undefined;
      const rootRef = React.useRef(null);
      const abortRef = React.useRef(null);
      const mountedRef = React.useRef(true);
      const [phase, setPhase] = React.useState('idle');
      const [translation, setTranslation] = React.useState('');
      const [error, setError] = React.useState('');
      const [note, setNote] = React.useState('');

      React.useEffect(() => {
        mountedRef.current = true;
        beacon('row-mount', {
          role,
          chars: text.length,
          anchorSeq: typeof node.anchorSeq === 'number' ? node.anchorSeq : null,
        });
        return () => {
          mountedRef.current = false;
          abortRef.current?.abort();
          abortRef.current = null;
        };
        // Mount-only diagnostics; the row's identity never changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      React.useEffect(() => {
        setPhase('idle');
        setTranslation('');
        setError('');
        setNote('');
      }, [text]);

      const run = React.useCallback(async () => {
        if (text.length === 0) {
          setPhase('open');
          setTranslation('');
          setNote(translate('panel.noChinese'));
          return;
        }
        const cached = readCache(text);
        if (cached !== undefined) {
          setPhase('open');
          setTranslation(cached);
          setError('');
          setNote('');
          return;
        }
        if (!CJK_PATTERN.test(text)) {
          setPhase('open');
          setTranslation(text);
          setError('');
          setNote(translate('panel.noChinese'));
          return;
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        abortRef.current = controller;
        setPhase('loading');
        setError('');
        setNote('');
        const started = Date.now();
        try {
          const result = await translateMessage(text, sessionId, controller?.signal ?? undefined);
          if (!mountedRef.current) return;
          writeCache(text, result);
          setTranslation(result);
          setPhase('open');
          beacon('row-translated', { role, chars: text.length, outChars: result.length, elapsedMs: Date.now() - started });
        } catch (failure) {
          if (!mountedRef.current) return;
          // A collapse or unmount cancels the request on purpose; show nothing.
          if (controller !== null && controller.signal.aborted && abortRef.current === null) return;
          setError(messageOf(failure));
          setPhase('error');
          beacon('row-translate-failed', { role, message: messageOf(failure) });
        } finally {
          abortRef.current = null;
        }
      }, [text, translate, role, sessionId]);

      const onToggle = React.useCallback(() => {
        if (phase === 'loading') return;
        if (phase === 'open' || phase === 'error') {
          abortRef.current?.abort();
          abortRef.current = null;
          setPhase('idle');
          return;
        }
        void run();
      }, [phase, run]);

      const expanded = phase === 'open' || phase === 'error' || phase === 'loading';
      const label = phase === 'loading'
        ? translate('action.loading')
        : phase === 'open'
          ? translate('action.hide')
          : phase === 'error'
            ? translate('action.retry')
            : translate('action.translate');

      const children = [
        h('div', { key: 'actions', className: 'dshEnTrans_actions' },
          h('button', {
            type: 'button',
            className: 'dshEnTrans_button',
            'data-role': role,
            'data-phase': phase,
            'aria-expanded': expanded ? 'true' : 'false',
            title: expanded ? translate('tip.hide') : translate('tip.translate'),
            onClick: onToggle,
          },
            h('span', { key: 'badge', className: 'dshEnTrans_badge', 'aria-hidden': 'true' }, 'EN'),
            h('span', { key: 'label', className: 'dshEnTrans_label' }, label),
          ),
        ),
      ];

      if (phase === 'open' || phase === 'error' || phase === 'loading') {
        const bodyChildren = [];
        if (phase === 'loading') bodyChildren.push(h('div', { key: 'loading', className: 'dshEnTrans_note' }, translate('action.loading')));
        if (phase === 'error') bodyChildren.push(h('div', { key: 'error', className: 'dshEnTrans_error', role: 'alert' }, `${translate('panel.failed')}: ${error}`));
        if (phase === 'open' && note.length > 0) bodyChildren.push(h('div', { key: 'note', className: 'dshEnTrans_note' }, note));
        if (phase === 'open' && translation.length > 0) bodyChildren.push(h('div', { key: 'body', className: 'dshEnTrans_body' }, translation));
        children.push(h('div', { key: 'panel', className: 'dshEnTrans_panel', role: 'note' },
          h('div', { key: 'head', className: 'dshEnTrans_head' },
            h('span', { key: 'title', className: 'dshEnTrans_title' }, translate('panel.title')),
            h('span', { key: 'meta', className: 'dshEnTrans_meta' }, role === 'answer' ? translate('panel.answer') : translate('panel.question')),
          ),
          bodyChildren,
        ));
      }

      return h('div', {
        ref: rootRef,
        className: 'dshEnTrans_row',
        'data-role': role,
        'data-dsh-en-translation': 'row',
      }, children);
    }

    /**
     * Build one Conversation Definition that publishes a translation row for one
     * message direction.
     * @param {'question' | 'answer'} role message direction.
     * @returns {Record<string, unknown>} Conversation Definition.
     */
    function makeDefinition(role) {
      const definitionKind = DEFINITION_KINDS[role];
      const isQuestion = role === 'question';

      /**
       * Read the message text and identity out of one surface event.
       *
       * A message with no CJK characters is already English; it gets no row, so
       * the reading flow only carries buttons where there is something to learn.
       * @param {unknown} event Session-like event.
       * @returns {{ id: string, text: string } | null} message facts.
       */
      const readMessage = (event) => {
        if (event === null || typeof event !== 'object') return null;
        const data = event.data !== null && typeof event.data === 'object' ? event.data : null;
        if (data === null) return null;
        if (isQuestion) {
          const source = data.source !== null && typeof data.source === 'object' ? data.source : null;
          if (source !== null && source.kind !== undefined && source.kind !== 'user') return null;
          const text = collectText(data.content);
          if (text.length === 0) return null;
          if (!CJK_PATTERN.test(text)) return null;
          return { id: String(data.id), text };
        }
        const message = data.message !== null && typeof data.message === 'object' ? data.message : null;
        if (message === null) return null;
        const text = collectText(message.content);
        if (text.length === 0) return null;
        if (!CJK_PATTERN.test(text)) return null;
        return { id: String(message.id), text };
      };

      return {
        kind: definitionKind,
        target: 'chat',
        match(event) {
          try {
            if (event === null || typeof event !== 'object') return null;
            const expectedType = isQuestion ? 'user/message' : 'assistant/message';
            if (event.type !== expectedType) return null;
            if (event.surfaceOp !== 'append') return null;
            const facts = readMessage(event);
            if (facts === null) return null;
            return { id: facts.id, role: 'start' };
          } catch (failure) {
            beacon('definition-match-failed', { role, message: messageOf(failure) });
            return null;
          }
        },
        start(_context, match) {
          const facts = readMessage(match?.event);
          if (facts === null) return null;
          return { role, text: facts.text, messageId: facts.id, seq: match.event.seq };
        },
        update(context) {
          return context.state;
        },
        buildViewNode(context) {
          try {
            const state = context?.state;
            if (state === null || state === undefined || typeof state.text !== 'string' || state.text.length === 0) return null;
            const location = context.start?.location ?? context.matches?.[0]?.location ?? { kind: 'unresolved' };
            return {
              key: context.key,
              kind: RENDER_KIND,
              id: context.id,
              target: 'chat',
              anchorSeq: state.seq,
              location,
              visibility: 'visible',
              groupTree: 'turn',
              data: { role, text: state.text, messageId: state.messageId },
            };
          } catch (failure) {
            beacon('definition-build-failed', { role, message: messageOf(failure) });
            return null;
          }
        },
      };
    }

    /**
     * Register styles, locale dictionaries, the two Conversation Definitions, and
     * the row renderer; all through effects so unloading removes them.
     * @param {Record<string, unknown>} ctx restricted client context.
     */
    function apply(ctx) {
      beacon('plugin-applied', { version: '1.0.0' });

      const locale = ctx.locale ?? ctx.get('locale');
      if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
        ctx.effect(() => locale.register(NS, DICTIONARIES), 'en-translation: dictionaries');
      } else {
        beacon('plugin-no-locale', {});
      }

      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.plugin = '@local/dsh-bilingual-helper';
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'en-translation: styles');

      const slotOptions = { name: 'conversation.chat.node', key: RENDER_KIND };
      if (locale !== undefined && locale !== null) slotOptions.locale = NS;
      ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(slotOptions, TranslationRow));
      beacon('plugin-slot-registered', { key: RENDER_KIND });

      const uiConversation = ctx.uiConversation ?? ctx.get('uiConversation');
      const registry = uiConversation?.events;
      if (registry === undefined || registry === null || typeof registry.register !== 'function') {
        beacon('plugin-no-conversation-registry', { keys: Object.keys(uiConversation ?? {}) });
        return;
      }
      ctx.effect(() => {
        const disposers = [];
        for (const role of ['question', 'answer']) {
          try {
            disposers.push(registry.register(makeDefinition(role)));
            beacon('plugin-definition-registered', { role });
          } catch (failure) {
            beacon('plugin-definition-failed', { role, message: messageOf(failure) });
          }
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              // A registry teardown is already partially done.
            }
          }
        };
      }, 'en-translation: definitions');
    }

    return {
      inject: ['slots', 'locale', 'uiConversation'],
      apply,
    };
  },
});
