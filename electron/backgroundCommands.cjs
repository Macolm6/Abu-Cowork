'use strict';

/**
 * In-memory table of the background commands each conversation started:
 * status, exit code and the tail of their combined stdout/stderr. Nothing is
 * written to disk; a restart starts with an empty table.
 */

const CHANGED_EVENT = 'background-commands://changed';
// Characters of decoded output kept per command, counted as JS string length.
const OUTPUT_BUFFER_MAX_CHARS = 1024 * 1024;
// Writes are joined into segments of at most this many characters.
const OUTPUT_SEGMENT_MAX_CHARS = 4096;
const SETTLED_ROWS_PER_CONVERSATION = 20;
const SETTLED_ROWS_TOTAL = 100;
const ID_PATTERN = /^[0-9a-f]{8}$/;

function requireDependency(deps, name, check) {
  if (!(name in deps) || deps[name] === undefined || !check(deps[name])) {
    throw new TypeError(`createBackgroundCommands: missing or invalid dependency "${name}"`);
  }
  return deps[name];
}

function requireString(value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`background command: ${label} must be a non-empty string`);
  }
  return value;
}

function isUtf8DecodeError(error) {
  return error instanceof TypeError && error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA';
}

/**
 * One stream's decoder: strict UTF-8 until the first invalid byte, then the
 * console code page (or lenient UTF-8 when the code page is unknown) for the
 * rest of the stream. Bytes the strict decoder still holds for an unfinished
 * character are kept so the switch re-reads them with the new decoder.
 * The chunk that holds the first invalid byte is decoded whole with the new
 * decoder, as decodeCommandOutput decodes a whole stream.
 * `legacyEncoding()` names the code page and is called only at that switch.
 */
function createStreamDecoder(legacyEncoding) {
  // ignoreBOM keeps a leading BOM in the decoded text, so the byte length of
  // that text is exactly the bytes consumed; the BOM is removed below.
  let strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let fallback = null;
  let held = Buffer.alloc(0);
  let atStart = true;

  function withoutLeadingBom(text) {
    if (!atStart || text === '') return text;
    atStart = false;
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  function switchToFallback(pending) {
    strict = null;
    fallback = new TextDecoder(legacyEncoding() ?? 'utf-8');
    held = Buffer.alloc(0);
    atStart = false;
    return fallback.decode(pending, { stream: true });
  }

  return {
    write(chunk) {
      if (fallback) return fallback.decode(chunk, { stream: true });
      const pending = Buffer.concat([held, chunk]);
      try {
        const text = strict.decode(chunk, { stream: true });
        held = pending.subarray(Buffer.byteLength(text, 'utf8'));
        return withoutLeadingBom(text);
      } catch (error) {
        if (!isUtf8DecodeError(error)) throw error;
        return switchToFallback(pending);
      }
    },
    end() {
      if (fallback) return fallback.decode();
      try {
        return withoutLeadingBom(strict.decode());
      } catch (error) {
        if (!isUtf8DecodeError(error)) throw error;
        return switchToFallback(held) + fallback.decode();
      }
    },
  };
}

/** Keeps the last OUTPUT_BUFFER_MAX_CHARS characters as `{ start, text }` segments. */
function createOutputBuffer() {
  const segments = [];
  let firstOffset = 0;
  let written = 0;
  let kept = 0;

  function dropFromHead(excess) {
    while (excess > 0) {
      const head = segments[0];
      if (head.text.length <= excess) {
        segments.shift();
        excess -= head.text.length;
        kept -= head.text.length;
        continue;
      }
      let cut = excess;
      // Never keep the low half of a surrogate pair without its high half.
      const code = head.text.charCodeAt(cut);
      if (code >= 0xdc00 && code <= 0xdfff) cut += 1;
      head.text = head.text.slice(cut);
      head.start += cut;
      kept -= cut;
      excess = 0;
      if (head.text === '') segments.shift();
    }
    firstOffset = segments.length > 0 ? segments[0].start : written;
  }

  return {
    append(text) {
      if (text === '') return;
      // Small writes join the last segment, so the segment count stays bounded
      // and dropping from the head never moves a long array.
      const tail = segments[segments.length - 1];
      if (tail && tail.text.length + text.length <= OUTPUT_SEGMENT_MAX_CHARS) {
        tail.text += text;
      } else {
        segments.push({ start: written, text });
      }
      written += text.length;
      kept += text.length;
      if (kept > OUTPUT_BUFFER_MAX_CHARS) dropFromHead(kept - OUTPUT_BUFFER_MAX_CHARS);
    },
    read(since) {
      if (!Number.isInteger(since) || since < 0 || since > written) {
        throw new RangeError(`background command output: position ${since} is outside 0..${written}`);
      }
      const gap = since < firstOffset;
      const from = gap ? firstOffset : since;
      const parts = [];
      for (const segment of segments) {
        const end = segment.start + segment.text.length;
        if (end <= from) continue;
        parts.push(segment.start >= from ? segment.text : segment.text.slice(from - segment.start));
      }
      return { text: parts.join(''), next: written, gap };
    },
    segmentCount() {
      return segments.length;
    },
  };
}

function isSettled(status) {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

function createBackgroundCommands(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createBackgroundCommands: dependencies are required');
  }
  const emit = requireDependency(deps, 'emit', (value) => typeof value === 'function');
  const now = requireDependency(deps, 'now', (value) => typeof value === 'function');
  const randomId = requireDependency(deps, 'randomId', (value) => typeof value === 'function');
  const askLegacyEncoding = requireDependency(deps, 'legacyEncoding', (value) => typeof value === 'function');
  // Asking for the code page can be slow (Windows runs chcp.com), so it is
  // asked once, when the first stream meets invalid UTF-8.
  let legacyEncodingLabel;
  function legacyEncoding() {
    if (legacyEncodingLabel !== undefined) return legacyEncodingLabel;
    const label = askLegacyEncoding();
    if (label !== null && typeof label !== 'string') {
      throw new TypeError('background command: legacyEncoding() must return an encoding label or null');
    }
    // An unsupported label throws a RangeError here.
    if (label !== null) new TextDecoder(label);
    legacyEncodingLabel = label;
    return label;
  }

  const records = new Map();
  let settleSequence = 0;

  function changed(conversationId) {
    emit(CHANGED_EVENT, { conversationId });
  }

  function newId() {
    const bytes = randomId(4);
    const hex = Buffer.isBuffer(bytes) ? bytes.toString('hex') : '';
    if (!ID_PATTERN.test(hex)) {
      throw new TypeError('background command: randomId(4) must return 4 random bytes');
    }
    const id = `bg-${hex}`;
    if (records.has(id)) throw new Error(`background command id ${id} is already in use`);
    return id;
  }

  function owned(conversationId, id) {
    requireString(conversationId, 'conversationId');
    const record = records.get(id);
    if (!record) throw new Error(`background command ${id} does not exist`);
    if (record.conversationId !== conversationId) {
      throw new Error(`background command ${id} does not belong to conversation ${conversationId}`);
    }
    return record;
  }

  function existing(id) {
    const record = records.get(id);
    if (!record) throw new Error(`background command ${id} does not exist`);
    return record;
  }

  function toRow(record) {
    return {
      id: record.id,
      command: record.command,
      cwd: record.cwd,
      status: record.status,
      exitCode: record.exitCode,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
    };
  }

  function dropOldestSettled(candidates, limit) {
    const settled = candidates
      .filter((record) => isSettled(record.status))
      .sort((a, b) => a.settleOrder - b.settleOrder);
    const dropped = settled.slice(0, Math.max(0, settled.length - limit));
    for (const record of dropped) records.delete(record.id);
    return dropped;
  }

  function enforceLimits(conversationId) {
    const all = [...records.values()];
    dropOldestSettled(
      all.filter((record) => record.conversationId === conversationId),
      SETTLED_ROWS_PER_CONVERSATION,
    );
    const droppedElsewhere = new Set(
      dropOldestSettled([...records.values()], SETTLED_ROWS_TOTAL)
        .map((record) => record.conversationId)
        .filter((owner) => owner !== conversationId),
    );
    for (const owner of droppedElsewhere) changed(owner);
  }

  function settle(record, code) {
    if (!records.has(record.id) || isSettled(record.status)) return;
    for (const decoder of [record.stdoutDecoder, record.stderrDecoder]) {
      record.output.append(decoder.end());
    }
    const exitCode = typeof code === 'number' ? code : null;
    record.exitCode = exitCode;
    record.finishedAt = now();
    record.status = record.stopRequested ? 'stopped' : exitCode === 0 ? 'completed' : 'failed';
    record.settleOrder = settleSequence++;
    changed(record.conversationId);
    enforceLimits(record.conversationId);
  }

  function register({ conversationId, command, cwd } = {}) {
    requireString(conversationId, 'conversationId');
    requireString(command, 'command');
    if (cwd !== undefined && cwd !== null && typeof cwd !== 'string') {
      throw new TypeError('background command: cwd must be a string when given');
    }
    const record = {
      id: newId(),
      conversationId,
      command,
      cwd: cwd ?? null,
      startedAt: now(),
      finishedAt: null,
      status: 'running',
      exitCode: null,
      stopRequested: false,
      stop: null,
      settleOrder: null,
      output: createOutputBuffer(),
      stdoutDecoder: createStreamDecoder(legacyEncoding),
      stderrDecoder: createStreamDecoder(legacyEncoding),
    };
    records.set(record.id, record);
    changed(conversationId);

    function attach({ child, stop } = {}) {
      if (record.stop) throw new Error(`background command ${record.id} is already attached`);
      if (!child || typeof child.once !== 'function' || !child.stdout || !child.stderr) {
        throw new TypeError('background command attach: child must have stdout, stderr and a close event');
      }
      if (typeof stop !== 'function') {
        throw new TypeError('background command attach: stop must be a function');
      }
      record.stop = stop;
      child.stdout.on('data', (chunk) => {
        if (records.has(record.id)) record.output.append(record.stdoutDecoder.write(chunk));
      });
      child.stderr.on('data', (chunk) => {
        if (records.has(record.id)) record.output.append(record.stderrDecoder.write(chunk));
      });
      child.once('close', (code) => settle(record, code));
    }

    return { id: record.id, attach };
  }

  function list(conversationId) {
    requireString(conversationId, 'conversationId');
    return [...records.values()]
      .filter((record) => record.conversationId === conversationId)
      .map(toRow);
  }

  function read(conversationId, id, since) {
    const record = owned(conversationId, id);
    const { text, next, gap } = record.output.read(since);
    return { text, next, gap, status: record.status, exitCode: record.exitCode };
  }

  function requestStop(conversationId, id) {
    const record = owned(conversationId, id);
    if (isSettled(record.status)) return 'already-finished';
    if (record.status === 'stopping') return 'requested';
    if (!record.stop) throw new Error(`background command ${id} has no process attached`);
    record.stopRequested = true;
    record.status = 'stopping';
    changed(record.conversationId);
    record.stop();
    return 'requested';
  }

  function markStopRequested(id) {
    const record = existing(id);
    if (record.status !== 'running') return;
    record.stopRequested = true;
    record.status = 'stopping';
    changed(record.conversationId);
  }

  function clear(conversationId) {
    requireString(conversationId, 'conversationId');
    let removed = false;
    for (const record of [...records.values()]) {
      if (record.conversationId === conversationId && isSettled(record.status)) {
        records.delete(record.id);
        removed = true;
      }
    }
    if (removed) changed(conversationId);
  }

  function stopConversation(conversationId) {
    requireString(conversationId, 'conversationId');
    const rows = [...records.values()].filter((record) => record.conversationId === conversationId);
    if (rows.length === 0) return;
    // Rows leave only after every process was told to stop, so a stop that
    // throws leaves the remaining commands listed and stoppable.
    for (const record of rows) {
      if (record.status === 'running' && record.stop) {
        record.stopRequested = true;
        record.stop();
      }
    }
    for (const record of rows) records.delete(record.id);
    changed(conversationId);
  }

  function discard(id) {
    const record = existing(id);
    records.delete(id);
    changed(record.conversationId);
  }

  function runningCount(conversationId) {
    if (conversationId !== undefined) requireString(conversationId, 'conversationId');
    let count = 0;
    for (const record of records.values()) {
      if (conversationId !== undefined && record.conversationId !== conversationId) continue;
      if (!isSettled(record.status)) count += 1;
    }
    return count;
  }

  return {
    register,
    list,
    read,
    requestStop,
    markStopRequested,
    clear,
    stopConversation,
    discard,
    runningCount,
  };
}

module.exports = {
  createBackgroundCommands,
  BACKGROUND_COMMANDS_CHANGED_EVENT: CHANGED_EVENT,
  OUTPUT_BUFFER_MAX_CHARS,
  OUTPUT_SEGMENT_MAX_CHARS,
  createOutputBuffer,
  SETTLED_ROWS_PER_CONVERSATION,
  SETTLED_ROWS_TOTAL,
};
