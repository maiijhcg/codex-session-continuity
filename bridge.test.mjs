import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {DesktopBridge} from './bridge.mjs';

function frame(message) {
  const body = Buffer.isBuffer(message) ? message : Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  writes = [];
  write(bytes, callback) {
    this.writes.push(JSON.parse(bytes.subarray(4).toString()));
    this.emit('write', this.writes.at(-1), callback);
    return true;
  }
  destroy() {
    if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit('close')); }
    return this;
  }
}

function fakeBridge(t, options = {}) {
  const socket = new FakeSocket();
  const bridge = new DesktopBridge('test-only', 'source-thread', {...options, createConnection: () => socket});
  t.after(() => bridge.close());
  return {socket, bridge};
}

async function loopback(t, onMessage) {
  const sockets = new Set();
  let connections = 0;
  const server = net.createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
        const size = buffer.readUInt32LE();
        const message = JSON.parse(buffer.subarray(4, size + 4).toString());
        buffer = buffer.subarray(size + 4);
        onMessage(socket, message);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return {pipe: {host: '127.0.0.1', port: server.address().port}, get connections() { return connections; }};
}

test('concurrent requests await one connection and decode fragmented/coalesced frames out of order', async t => {
  const socket = new FakeSocket();
  let connections = 0;
  const bridge = new DesktopBridge('test-only', 'source', {createConnection: () => { connections++; return socket; }});
  t.after(() => bridge.close());
  const connected = bridge.connect();
  assert.equal(bridge.connect(), connected);
  const first = bridge.request('one', {});
  const second = bridge.request('two', {});
  assert.equal(socket.writes.length, 0);
  socket.on('write', () => {
    if (socket.writes.length !== 2) return;
    const [one, two] = socket.writes;
    const bytes = Buffer.concat([
      frame({method: 'notification'}),
      frame({id: two.id, result: '二'}),
      frame({id: one.id, result: '一'})
    ]);
    for (let offset = 0; offset < bytes.length; offset += 3) socket.emit('data', bytes.subarray(offset, offset + 3));
  });
  socket.emit('connect');
  assert.deepEqual(await Promise.all([first, second]), ['一', '二']);
  assert.equal(connections, 1);
  assert.equal(bridge.pending.size, 0);
});

test('loopback transport rejects every pending request on invalid JSON without an uncaught exception', async t => {
  let received = 0;
  const server = await loopback(t, socket => {
    if (++received === 2) socket.write(frame(Buffer.from('{broken')));
  });
  const bridge = new DesktopBridge(server.pipe, 'source');
  t.after(() => bridge.close());
  const results = await Promise.allSettled([bridge.request('one', {}), bridge.request('two', {})]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'DESKTOP_PROTOCOL_ERROR');
    assert.equal(result.reason.ambiguous, true);
    assert.match(result.reason.message, /invalid JSON/);
  }
  assert.equal(server.connections, 1);
  assert.equal(bridge.pending.size, 0);
  assert.equal(bridge.connection, null);
});

test('loopback rejects zero and oversized advertised frames before buffering payload', async t => {
  for (const size of [0, 8388609]) {
    const server = await loopback(t, socket => {
      const header = Buffer.alloc(4);
      header.writeUInt32LE(size);
      socket.write(header);
    });
    const bridge = new DesktopBridge(server.pipe, 'source');
    t.after(() => bridge.close());
    await assert.rejects(bridge.request('test', {}), error => error.code === 'DESKTOP_PROTOCOL_ERROR' && error.message.includes('1..8388608'));
    assert.equal(bridge.pending.size, 0);
  }
});

test('reconnect discards partial framing and ignores retired socket data/close/error events', async t => {
  const sockets = [new FakeSocket(), new FakeSocket()];
  let index = 0;
  const bridge = new DesktopBridge('test-only', 'source', {createConnection: () => sockets[index++]});
  t.after(() => bridge.close());
  const [oldSocket, newSocket] = sockets;
  oldSocket.on('write', request => {
    oldSocket.emit('data', frame({id: request.id, result: 'old'}).subarray(0, 7));
    oldSocket.destroy();
  });
  const first = bridge.request('one', {});
  oldSocket.emit('connect');
  await assert.rejects(first, {code: 'DESKTOP_DISCONNECTED'});
  assert.equal(bridge.pending.size, 0);

  const second = bridge.request('two', {});
  newSocket.on('write', request => {
    oldSocket.emit('close');
    oldSocket.emit('error', new Error('late old error'));
    oldSocket.emit('data', frame({id: request.id, result: 'wrong'}));
    newSocket.emit('data', frame({id: request.id, result: 'fresh'}));
  });
  newSocket.emit('connect');
  assert.equal(await second, 'fresh');
  assert.equal(bridge.socket, newSocket);
  assert.equal(index, 2);
});

test('connect has a deadline shared by callers and does not retry on its own', async t => {
  const {socket, bridge} = fakeBridge(t, {connectTimeout: 25});
  const first = bridge.connect();
  const second = bridge.connect();
  assert.equal(first, second);
  await assert.rejects(first, {code: 'DESKTOP_CONNECT_TIMEOUT'});
  assert.equal(socket.destroyed, true);
  assert.equal(socket.writes.length, 0);
  assert.equal(bridge.pending.size, 0);
  assert.equal(bridge.connection, null);
});

test('connection error before connect and explicit close settle connecting callers', async t => {
  for (const event of ['error', 'close']) {
    const {socket, bridge} = fakeBridge(t);
    const pending = bridge.connect();
    if (event === 'error') socket.emit('error', new Error('connect failed'));
    else bridge.close();
    await assert.rejects(pending, {code: event === 'error' ? 'DESKTOP_CONNECTION_ERROR' : 'DESKTOP_CLOSED'});
    assert.equal(socket.destroyed, true);
    socket.emit('connect'); // A late connect must not make the closed bridge live.
    assert.equal(bridge.connection, null);
  }
});

test('peer end rejects pending requests immediately, including a partial header', async t => {
  const server = await loopback(t, socket => socket.end(Buffer.from([12, 0])));
  const bridge = new DesktopBridge(server.pipe, 'source');
  t.after(() => bridge.close());
  await assert.rejects(bridge.request('test', {}), error => error.code === 'DESKTOP_DISCONNECTED' && error.ambiguous);
  assert.equal(bridge.pending.size, 0);
});

test('invalid JSON values and responses missing result/error produce explicit protocol failures', async t => {
  for (const value of [null, [], {id: 1}]) {
    const {socket, bridge} = fakeBridge(t);
    socket.on('write', () => socket.emit('data', frame(value)));
    const pending = bridge.request('test', {});
    socket.emit('connect');
    await assert.rejects(pending, {code: 'DESKTOP_PROTOCOL_ERROR'});
    assert.equal(bridge.pending.size, 0);
  }
});

test('a known RPC error rejects only its request and later requests still work', async t => {
  const {socket, bridge} = fakeBridge(t);
  socket.on('write', request => socket.emit('data', frame(request.method === 'bad'
    ? {id: request.id, error: {code: -32000, message: 'Known failure'}}
    : {id: request.id, result: true})));
  const pending = bridge.request('bad', {});
  socket.emit('connect');
  await assert.rejects(pending, {code: 'DESKTOP_RPC_ERROR', message: 'Known failure'});
  assert.equal(await bridge.request('good', {}), true);
});

test('request timeout is ambiguous and late responses cannot complete another request', async t => {
  const {socket, bridge} = fakeBridge(t);
  const pending = bridge.request('slow', {}, 25);
  socket.emit('connect');
  await assert.rejects(pending, error => error.code === 'DESKTOP_REQUEST_TIMEOUT' && error.ambiguous);
  assert.equal(socket.writes.length, 1);
  const lateId = socket.writes[0].id;
  socket.on('write', request => {
    socket.emit('data', frame({id: lateId, result: 'late'}));
    socket.emit('data', frame({id: request.id, result: 'current'}));
  });
  assert.equal(await bridge.request('next', {}), 'current');
  assert.equal(bridge.pending.size, 0);
});

test('close rejects all pending requests and invalid payloads never open a socket', async t => {
  const {socket, bridge} = fakeBridge(t);
  const first = bridge.request('one', {});
  const second = bridge.request('two', {});
  socket.emit('connect');
  await Promise.resolve();
  bridge.close();
  const results = await Promise.allSettled([first, second]);
  for (const result of results) assert.equal(result.reason.code, 'DESKTOP_CLOSED');
  assert.equal(bridge.pending.size, 0);

  let attempted = 0;
  const unopened = new DesktopBridge('test-only', 'source', {maxFrameBytes: 128, createConnection: () => { attempted++; throw new Error('must not connect'); }});
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(unopened.request('cycle', cycle), /circular/i);
  await assert.rejects(unopened.request('big', {text: 'x'.repeat(256)}), {code: 'DESKTOP_FRAME_TOO_LARGE'});
  assert.equal(attempted, 0);
  assert.equal(unopened.pending.size, 0);
});

test('synchronous and asynchronous write failures reject pending requests without leaks', async t => {
  for (const mode of ['throw', 'callback']) {
    const {socket, bridge} = fakeBridge(t);
    socket.on('write', (_request, callback) => {
      const error = new Error('test write failure');
      if (mode === 'throw') throw error;
      queueMicrotask(() => callback(error));
    });
    const pending = bridge.request('test', {});
    socket.emit('connect');
    await assert.rejects(pending, error => error.code === 'DESKTOP_WRITE_ERROR' && error.ambiguous);
    assert.equal(bridge.pending.size, 0);
    assert.equal(socket.destroyed, true);
  }
});

test('tool calls retain the desktop request/response schema and cache the catalog per connection', async t => {
  let catalogs = 0;
  let calls = 0;
  const server = await loopback(t, (socket, request) => {
    assert.equal(request.jsonrpc, '2.0');
    if (request.method === 'tools/list') {
      catalogs++;
      assert.equal(request.params.threadStartKind, 'all');
      socket.write(frame({id: request.id, result: {tools: [{name: 'test_echo', namespace: 'test_namespace'}]}}));
    } else {
      calls++;
      assert.equal(request.method, 'tools/call');
      assert.equal(request.params.threadId, 'source-thread');
      assert.equal(request.params.callerSource, 'codex');
      assert.equal(request.params.namespace, 'test_namespace');
      assert.equal(request.params.tool, 'test_echo');
      assert.match(request.params.callId, /^continuity-/);
      socket.write(frame({id: request.id, result: {success: true, contentItems: [{type: 'inputText', text: JSON.stringify(request.params.arguments)}]}}));
    }
  });
  const bridge = new DesktopBridge(server.pipe, 'source-thread');
  t.after(() => bridge.close());
  assert.deepEqual(await bridge.call('test_echo', {text: '原文'}), {text: '原文'});
  assert.deepEqual(await bridge.call('test_echo', {count: 2}), {count: 2});
  assert.equal(catalogs, 1);
  assert.equal(calls, 2);
  await assert.rejects(bridge.call('missing_test_tool', {}), /Missing desktop capability/);
  bridge.close();
  assert.equal(bridge.tools, null);
});

const testTools = [{name:'send_message_to_thread', namespace:'test_namespace'}];
const toolSuccess = {success:true, contentItems:[{type:'inputText', text:'{"ok":true}'}]};

test('App 26.924 callerSource envelope is accepted while the old shape is rejected before invocation',async t=>{
  let invoked=0;
  const server=await loopback(t,(socket,request)=>{
    if(request.method==='tools/list'){socket.write(frame({id:request.id,result:{tools:testTools}}));return;}
    if(request.params?.callerSource!=='codex'){
      socket.write(frame({id:request.id,error:{code:-32602,message:'Invalid app tool request'}}));return;
    }
    invoked++;socket.write(frame({id:request.id,result:toolSuccess}));
  });
  const bridge=new DesktopBridge(server.pipe,'manager');t.after(()=>bridge.close());
  await assert.rejects(bridge.request('tools/call',{threadId:'manager',tool:'send_message_to_thread',arguments:{}}),e=>e.rpcCode===-32602&&e.rpcMethod==='tools/call');
  assert.equal(invoked,0);
  assert.deepEqual(await bridge.call('send_message_to_thread',{threadId:'target',prompt:'isolated fixture'}),{ok:true});
  assert.equal(invoked,1);
});

test('only exact envelope validation rejection is distinguished from an uncertain dispatched tool',async t=>{
  for(const [rpcCode,message,unsent] of [
    [-32602,'Invalid app tool request',true],[-32000,'Invalid app tool request',false],
    [-32602,'Invalid tool arguments',false],[-32000,'Codex app tool request failed',false],
  ]){
    const {socket,bridge}=fakeBridge(t);bridge.tools=testTools;
    socket.on('write',request=>socket.emit('data',frame({id:request.id,error:{code:rpcCode,message}})));
    const pending=bridge.call('send_message_to_thread',{threadId:'target'});socket.emit('connect');
    await assert.rejects(pending,e=>e.rpcCode===rpcCode&&e.requestDispatched===true&&e.toolRequestRejected===unsent&&e.toolDispatched===!unsent);
  }
});

test('a tool-level failure quoting the parser text remains an unknown execution outcome',async t=>{
  const {socket,bridge}=fakeBridge(t);bridge.tools=testTools;
  socket.on('write',r=>socket.emit('data',frame({id:r.id,result:{success:false,contentItems:[{type:'inputText',text:'Invalid app tool request'}]}})));
  const pending=bridge.call('send_message_to_thread',{threadId:'target'});socket.emit('connect');
  await assert.rejects(pending,e=>e.toolDispatched===true&&e.toolRequestRejected===false&&e.code==='DESKTOP_TOOL_REJECTED');
});
function expiredGuard() {
  const error = new Error('Soft trigger expired before dispatch');
  error.code = 'TRIGGER_NO_LONGER_CURRENT';
  throw error;
}

test('catalog completion is followed by a fresh guard and a rejection is definitely unsent', async t => {
  const {socket, bridge} = fakeBridge(t);
  let allowed = true;
  socket.on('write', request => {
    if (request.method === 'tools/list') {
      socket.emit('data', frame({id:request.id, result:{tools:testTools}}));
      allowed = false;
    } else socket.emit('data', frame({id:request.id, result:toolSuccess}));
  });
  const pending = bridge.call('send_message_to_thread', {}, 1000, () => {if (!allowed) expiredGuard();});
  socket.emit('connect');
  await assert.rejects(pending, error => error.code === 'TRIGGER_NO_LONGER_CURRENT' && error.toolDispatched === false);
  assert.deepEqual(socket.writes.map(request => request.method), ['tools/list']);
  assert.equal(bridge.pending.size, 0);
  // The owner can now safely retry a hard request without repeating a mutation.
  assert.deepEqual(await bridge.call('send_message_to_thread', {kind:'hard'}), {ok:true});
  assert.equal(socket.writes.filter(request => request.method === 'tools/call').length, 1);
});

test('a cached catalog does not bypass the guard while the transport is connecting', async t => {
  const {socket, bridge} = fakeBridge(t);
  bridge.tools = testTools;
  let allowed = true;
  const pending = bridge.call('send_message_to_thread', {}, 1000, () => {if (!allowed) expiredGuard();});
  assert.equal(socket.writes.length, 0);
  allowed = false;
  socket.emit('connect');
  await assert.rejects(pending, error => error.toolDispatched === false && error.code === 'TRIGGER_NO_LONGER_CURRENT');
  assert.equal(socket.writes.length, 0);
  assert.equal(bridge.pending.size, 0);
});

test('a catalog connection lost before the tool call must recheck the guard after reconnecting', async t => {
  const sockets = [new FakeSocket(), new FakeSocket()];
  let connectionCount = 0;
  let reconnectStarted;
  const reconnecting = new Promise(resolve => {reconnectStarted = resolve;});
  const bridge = new DesktopBridge('test-only', 'source-thread', {createConnection:() => {
    const socket = sockets[connectionCount++];
    if (connectionCount === 2) reconnectStarted();
    return socket;
  }});
  t.after(() => bridge.close());
  sockets[0].on('write', request => {
    assert.equal(request.method, 'tools/list');
    sockets[0].emit('data', frame({id:request.id, result:{tools:testTools}}));
    sockets[0].emit('end');
  });
  sockets[1].on('write', request => sockets[1].emit('data', frame({id:request.id, result:toolSuccess})));
  let allowed = true;
  const pending = bridge.call('send_message_to_thread', {}, 1000, () => {if (!allowed) expiredGuard();});
  sockets[0].emit('connect');
  await reconnecting;
  allowed = false;
  sockets[1].emit('connect');
  await assert.rejects(pending, error => error.toolDispatched === false && error.code === 'TRIGGER_NO_LONGER_CURRENT');
  assert.equal(connectionCount, 2);
  assert.equal(sockets[1].writes.length, 0);
  assert.equal(bridge.pending.size, 0);
  assert.deepEqual(await bridge.call('send_message_to_thread', {kind:'hard'}), {ok:true});
  assert.equal(sockets[1].writes.length, 1);
});

test('failure reconnecting before a tool write is definitely unsent and permits one later hard dispatch', async t => {
  const firstSocket = new FakeSocket();
  const retrySocket = new FakeSocket();
  let connectionCount = 0;
  const bridge = new DesktopBridge('test-only', 'source-thread', {createConnection:() => {
    connectionCount++;
    if (connectionCount === 1) return firstSocket;
    if (connectionCount === 2) throw new Error('Test reconnect failure before sending');
    return retrySocket;
  }});
  t.after(() => bridge.close());
  firstSocket.on('write', request => {
    firstSocket.emit('data', frame({id:request.id, result:{tools:testTools}}));
    firstSocket.emit('end');
  });
  retrySocket.on('write', request => retrySocket.emit('data', frame({id:request.id, result:toolSuccess})));
  const pending = bridge.call('send_message_to_thread', {kind:'hard'});
  firstSocket.emit('connect');
  await assert.rejects(pending, error => error.code === 'DESKTOP_CONNECT_ERROR' && error.toolDispatched === false);
  assert.equal(firstSocket.writes.filter(request => request.method === 'tools/call').length, 0);
  const retry = bridge.call('send_message_to_thread', {kind:'hard'});
  retrySocket.emit('connect');
  assert.deepEqual(await retry, {ok:true});
  assert.equal(retrySocket.writes.length, 1);
});

test('tool serialization failures before connection are definitely unsent', async () => {
  let connections = 0;
  const bridge = new DesktopBridge('test-only', 'source-thread', {maxFrameBytes:512,
    createConnection:() => {connections++; throw new Error('Must not connect');}});
  bridge.tools = testTools;
  const circular = {}; circular.self = circular;
  await assert.rejects(bridge.call('send_message_to_thread', circular), error => error.toolDispatched === false && /circular/i.test(error.message));
  await assert.rejects(bridge.call('send_message_to_thread', {text:'x'.repeat(1000)}),
    error => error.toolDispatched === false && error.code === 'DESKTOP_FRAME_TOO_LARGE');
  assert.equal(connections, 0);
  assert.equal(bridge.pending.size, 0);
});

test('tool write attempts remain dispatched and uncertain for both synchronous and asynchronous failures', async t => {
  for (const mode of ['throw', 'callback']) {
    const {socket, bridge} = fakeBridge(t);
    bridge.tools = testTools;
    socket.on('write', (_request, callback) => {
      const error = new Error('Test failure after tool write attempt');
      if (mode === 'throw') throw error;
      queueMicrotask(() => callback(error));
    });
    const pending = bridge.call('send_message_to_thread', {});
    socket.emit('connect');
    await assert.rejects(pending, error => error.toolDispatched === true && error.ambiguous && error.code === 'DESKTOP_WRITE_ERROR');
    assert.equal(socket.writes.length, 1);
    assert.equal(bridge.pending.size, 0);
  }
});

test('a catalog RPC failure cannot be confused with a dispatched mutation', async t => {
  const {socket, bridge} = fakeBridge(t);
  socket.on('write', request => socket.emit('data', frame({id:request.id,
    error:{code:-32000, message:'Catalog unavailable'}})));
  const pending = bridge.call('send_message_to_thread', {});
  socket.emit('connect');
  await assert.rejects(pending, error => error.toolDispatched === false && error.code === 'DESKTOP_RPC_ERROR');
  assert.deepEqual(socket.writes.map(request => request.method), ['tools/list']);
  assert.equal(bridge.pending.size, 0);
});
