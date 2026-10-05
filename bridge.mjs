import net from 'node:net';
import {randomUUID} from 'node:crypto';

const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

// Recognize only the product's exact, pre-delivery rejection. Timeouts, lost
// responses and other tool errors remain uncertain and must never be replayed.
export function isNoActiveTurnRejection(message, targetId) {
  if (typeof message !== 'string' || typeof targetId !== 'string') return false;
  const expected = `Cannot steer conversation ${targetId} without an active turn id`;
  if (message === expected) return true;
  try {
    const items = JSON.parse(message);
    return Array.isArray(items) && items.length === 1
      && ['inputText','text'].includes(items[0]?.type) && items[0].text === expected;
  } catch { return false; }
}

export function isAppRequestValidationRejection(error) {
  // Verified in the desktop dispatcher: this exact -32602 response is sent
  // before callTool is invoked. Other RPC/tool failures are not safe to replay.
  return error?.code === 'DESKTOP_RPC_ERROR' && error.rpcCode === -32602
    && error.rpcMethod === 'tools/call' && error.message === 'Invalid app tool request';
}

export function isStoredAppRequestValidationRejection(handoff, failure = {}) {
  if(handoff?.error!=='Invalid app tool request')return false;
  // Pre-26.924-compatible versions saved only the unique dispatcher text.
  // New records retain typed evidence; never discard a contrary RPC code.
  if(Object.keys(failure).length===0)return true;
  return failure.token===handoff.token && failure.toolRequestRejected===true
    && isAppRequestValidationRejection(failure);
}

function bridgeError(code, message, cause) {
  const error = new Error(message, cause ? {cause} : undefined);
  error.code = code;
  return error;
}

export class DesktopBridge {
  constructor(pipe, threadId, {connectTimeout = 10000, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES, createConnection = options => net.createConnection(options)} = {}) {
    if (!Number.isFinite(connectTimeout) || connectTimeout <= 0) throw new RangeError('connectTimeout must be positive');
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 0xffffffff) throw new RangeError('maxFrameBytes must fit a positive uint32');
    this.pipe = pipe;
    this.threadId = threadId;
    this.connectTimeout = connectTimeout;
    this.maxFrameBytes = maxFrameBytes;
    this.createConnection = createConnection;
    this.seq = 0;
    this.pending = new Map();
    this.connection = null;
    this.socket = null;
    this.tools = null;
  }

  connect() {
    // A socket exists while it is still connecting. All callers must await the
    // same promise before writing, including callers arriving during a reconnect.
    if (this.connection && !this.connection.closed && !this.connection.socket.destroyed) return this.connection.promise;
    if (this.connection && !this.connection.closed) this.disconnect(this.connection, bridgeError('DESKTOP_DISCONNECTED', 'Desktop disconnected'));
    let socket;
    try { socket = this.createConnection(this.pipe); }
    catch (cause) { return Promise.reject(bridgeError('DESKTOP_CONNECT_ERROR', 'Desktop connection failed: ' + cause.message, cause)); }
    const connection = {socket, closed: false, connected: false, header: Buffer.alloc(4), headerBytes: 0, frame: null, frameBytes: 0};
    connection.promise = new Promise((resolve, reject) => { connection.resolve = resolve; connection.reject = reject; });
    this.connection = connection;
    this.socket = socket;
    connection.timer = setTimeout(() => this.disconnect(connection, bridgeError('DESKTOP_CONNECT_TIMEOUT', 'Desktop connection timed out after ' + this.connectTimeout + 'ms')), this.connectTimeout);
    socket.once('connect', () => {
      if (connection.closed) return;
      connection.connected = true;
      clearTimeout(connection.timer);
      connection.resolve();
    });
    socket.on('data', chunk => this.receive(connection, chunk));
    socket.on('error', cause => this.disconnect(connection, bridgeError('DESKTOP_CONNECTION_ERROR', 'Desktop connection error: ' + cause.message, cause)));
    socket.once('end', () => this.disconnect(connection, bridgeError('DESKTOP_DISCONNECTED', 'Desktop disconnected')));
    socket.once('close', () => this.disconnect(connection, bridgeError('DESKTOP_DISCONNECTED', 'Desktop disconnected')));
    return connection.promise;
  }

  disconnect(connection, error) {
    if (connection.closed) return;
    connection.closed = true;
    clearTimeout(connection.timer);
    if (!connection.connected) connection.reject(error);
    // Framing state belongs to one socket. Late events from a retired socket
    // cannot clear or consume bytes belonging to a newer connection.
    connection.frame = null;
    connection.headerBytes = connection.frameBytes = 0;
    if (this.connection === connection) {
      this.connection = null;
      this.socket = null;
      this.tools = null;
    }
    for (const [id, pending] of this.pending) {
      if (pending.connection !== connection) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      const failure = bridgeError(error.code, error.message + '; request outcome may be unknown: ' + pending.method, error);
      failure.ambiguous = true;
      pending.reject(failure);
    }
    connection.socket.destroy();
  }

  receive(connection, chunk) {
    if (connection.closed || this.connection !== connection) return;
    let offset = 0;
    while (offset < chunk.length && !connection.closed) {
      if (connection.headerBytes < 4) {
        const count = Math.min(4 - connection.headerBytes, chunk.length - offset);
        chunk.copy(connection.header, connection.headerBytes, offset, offset + count);
        connection.headerBytes += count;
        offset += count;
        if (connection.headerBytes < 4) return;
        const length = connection.header.readUInt32LE();
        if (!length || length > this.maxFrameBytes) {
          this.disconnect(connection, bridgeError('DESKTOP_PROTOCOL_ERROR', 'Desktop frame length ' + length + ' is outside 1..' + this.maxFrameBytes + ' bytes'));
          return;
        }
        connection.frame = Buffer.allocUnsafe(length);
      }
      const count = Math.min(connection.frame.length - connection.frameBytes, chunk.length - offset);
      chunk.copy(connection.frame, connection.frameBytes, offset, offset + count);
      connection.frameBytes += count;
      offset += count;
      if (connection.frameBytes < connection.frame.length) return;
      let message;
      try { message = JSON.parse(connection.frame.toString('utf8')); }
      catch (cause) {
        this.disconnect(connection, bridgeError('DESKTOP_PROTOCOL_ERROR', 'Desktop sent an invalid JSON frame', cause));
        return;
      }
      connection.headerBytes = connection.frameBytes = 0;
      connection.frame = null;
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        this.disconnect(connection, bridgeError('DESKTOP_PROTOCOL_ERROR', 'Desktop JSON frame must contain an object'));
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending || pending.connection !== connection) continue; // notification or a late response
      if (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')) {
        this.disconnect(connection, bridgeError('DESKTOP_PROTOCOL_ERROR', 'Desktop response is missing result/error'));
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error=bridgeError('DESKTOP_RPC_ERROR', typeof message.error.message === 'string' ? message.error.message : JSON.stringify(message.error));
        error.rpcCode=message.error.code;error.rpcMethod=pending.method;
        pending.reject(error);
      }
      else pending.resolve(message.result);
    }
  }

  async request(method, params, timeout = 30000, {beforeDispatch, onDispatch} = {}) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError('Request timeout must be positive');
    if (beforeDispatch !== undefined && typeof beforeDispatch !== 'function') throw new TypeError('beforeDispatch must be a function');
    if (onDispatch !== undefined && typeof onDispatch !== 'function') throw new TypeError('onDispatch must be a function');
    const id = ++this.seq;
    // Validate/serialize before connecting or registering a pending request.
    const body = Buffer.from(JSON.stringify({jsonrpc: '2.0', id, method, params}));
    if (body.length > this.maxFrameBytes) throw bridgeError('DESKTOP_FRAME_TOO_LARGE', 'Desktop request frame exceeds ' + this.maxFrameBytes + ' bytes');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    await this.connect();
    const connection = this.connection;
    if (!connection?.connected || connection.closed || connection.socket.destroyed) throw bridgeError('DESKTOP_DISCONNECTED', 'Desktop disconnected before request was sent');
    // Guard after the final await: catalog lookup or a reconnect can outlive a
    // soft trigger or the user's pause command. Guard failures have sent no
    // request and must remain distinguishable from an uncertain write.
    if (beforeDispatch) beforeDispatch();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = bridgeError('DESKTOP_REQUEST_TIMEOUT', 'Ambiguous request timeout: ' + method);
        error.ambiguous = true;
        reject(error);
      }, timeout);
      this.pending.set(id, {resolve, reject, timer, connection, method});
      try {
        const bytes = Buffer.concat([header, body]);
        try {
          connection.socket.write(bytes, cause => {
            if (cause) this.disconnect(connection, bridgeError('DESKTOP_WRITE_ERROR', 'Desktop request write failed: ' + cause.message, cause));
          });
        } finally {
          // A synchronous write exception also has an uncertain outcome. Set
          // the marker after the write attempt, before any rejection handler
          // resumes, while all earlier failures remain definitely unsent.
          if (onDispatch) onDispatch();
        }
      } catch (cause) {
        this.disconnect(connection, bridgeError('DESKTOP_WRITE_ERROR', 'Desktop request write failed: ' + cause.message, cause));
      }
    });
  }

  async catalog() { return (await this.request('tools/list', {threadStartKind: 'all'})).tools; }

  async call(tool, args, timeout = 30000, beforeDispatch) {
    let toolDispatched = false;
    try {
      if (tool === 'send_message_to_thread' && args?.threadId === this.threadId) {
        throw bridgeError('DESKTOP_SELF_STEER_FORBIDDEN', '交接通知須由不同的管理主任務發送；不能把目標任務當成呼叫者。');
      }
      if (!this.tools) this.tools = await this.catalog();
      const spec = this.tools.find(t => t.name === tool);
      if (!spec) throw new Error('Missing desktop capability ' + tool);
      // App 26.924 requires the caller surface in addition to its task ID.
      // Continuity exclusively manages verified local Codex parent tasks.
      const result = await this.request('tools/call', {arguments: args, callerSource: 'codex', callId: 'continuity-' + randomUUID(), namespace: spec.namespace, threadId: this.threadId, tool, turnId: 'continuity-' + randomUUID()}, timeout,
        {beforeDispatch, onDispatch:() => { toolDispatched = true; }});
      if (!result.success) throw bridgeError('DESKTOP_TOOL_REJECTED', JSON.stringify(result.contentItems));
      const content = result.contentItems.filter(c => c.type === 'inputText').map(c => c.text).join('\n');
      try { return JSON.parse(content); }
      catch { return {text: content}; }
    } catch(error) {
      error.requestDispatched=toolDispatched;
      error.toolRequestRejected=isAppRequestValidationRejection(error);
      error.toolDispatched=toolDispatched && !error.toolRequestRejected;
      throw error;
    }
  }

  close() {
    if (this.connection) this.disconnect(this.connection, bridgeError('DESKTOP_CLOSED', 'Desktop bridge closed'));
  }
}
