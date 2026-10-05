import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {openDB} from './core.mjs';
import {buildSearchQuery, openSearchDB, searchHistory} from './search.mjs';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const archiveRoot = path.join(os.tmpdir(), 'continuity-search-fixture');

function memoryDB(t) {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE events(session TEXT,generation INTEGER,offset INTEGER,line INTEGER,time TEXT,kind TEXT,role TEXT,text TEXT,PRIMARY KEY(session,generation,offset)); " +
    "CREATE INDEX events_session ON events(session,line); " +
    "CREATE VIRTUAL TABLE search_index USING fts5(text,session UNINDEXED,location UNINDEXED,tokenize='trigram');");
  t.after(() => db.close());
  return db;
}

function insert(db, text, {session = 'session-a', generation = 0, index = 1} = {}) {
  const line = index + 10;
  const offset = index * 101;
  const time = String(index).padStart(6, '0');
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)').run(session, generation, offset, line, time, 'message', 'user', text);
  db.prepare('INSERT INTO search_index(text,session,location) VALUES(?,?,?)').run(text, session, generation + ':' + line + ':' + offset);
}

function legacy(db, query, session) {
  const sql = 'SELECT session,generation,line,offset,time,role,substr(text,max(1,instr(lower(text),lower(?))-120),600) excerpt ' +
    'FROM events WHERE instr(lower(text),lower(?))>0' + (session === undefined ? '' : ' AND session=?') + ' ORDER BY time DESC LIMIT 20';
  return db.prepare(sql).all(query, query, ...(session === undefined ? [] : [session])).map(row => ({
    ...row, raw: path.join(archiveRoot, 'archive', row.session, 'raw-' + row.generation + '.jsonl')
  }));
}

function compare(db, query, session) {
  assert.deepEqual(searchHistory(db, query, {session, root: archiveRoot}), legacy(db, query, session), 'legacy mismatch for ' + JSON.stringify(query));
}

test('FTS literal substring results preserve legacy Chinese, English, Unicode and punctuation semantics', t => {
  const db = memoryDB(t);
  const texts = [
    '原文驗證：保留決策，不要自動刪除。',
    'An ALPHA first choice; alphabet is longer.',
    'literal " OR * " and text:abc NEAR(foo bar) % _',
    'SQL-looking text: x\' OR 1=1; DROP TABLE events; --',
    'ÄBC äbc AİB ai̇b ıab IAB Σςσ Straße ſab',
    'ab prefix 😀😃😄 suffix 😀😃',
    'line one\n\nline two\t tabs',
    'nul-prefix\0abc and 中文原文 after nul',
    'three   spaces and C:\\project\\abc',
    'one --session token',
    'later repeated 保留決策 ALpha'
  ];
  texts.forEach((text, index) => insert(db, text, {index: index + 1, session: index % 2 ? 'session-b' : 'session-a', generation: index % 3}));
  const queries = [
    '原', '決策', '保留決策', 'alpha', 'ALPH', 'alphabet', '" OR * "', 'text:abc',
    "x' OR 1=1", 'DROP TABLE events;', 'NEAR(foo bar)', '% _', 'ÄBC', 'äbc',
    'AİB', 'ai̇b', 'ıab', 'iab', 'Σςσ', 'Straße', 'ſab', 'sab',
    '😀', '😀😃', '😀😃😄', '\n\nl', '\t t', '   ', 'abc', '中文原文',
    'prefix\0abc', 'C:\\project', '--session', 'nonexistent phrase'
  ];
  for (const query of queries) {
    compare(db, query);
    compare(db, query, 'session-a');
  }
  assert.equal(db.prepare('SELECT count(*) n FROM events').get().n, texts.length);
});

test('Unicode case folding remains the original SQLite lower behavior after FTS candidate matching', t => {
  const db = memoryDB(t);
  ['ÄBC', 'äbc', 'AbC', 'abc', 'ſab', 'sab', 'Σab', 'σab'].forEach((text, index) => insert(db, text, {index: index + 1}));
  // FTS folds non-ASCII case, while the existing SQL predicate only folds ASCII.
  assert.equal(db.prepare('SELECT count(*) n FROM search_index WHERE search_index MATCH ?').get('"äbc"').n, 2);
  assert.equal(searchHistory(db, 'äbc', {root: archiveRoot}).length, 1);
  for (const query of ['ÄBC', 'äbc', 'abc', 'ſab', 'sab', 'Σab', 'σab']) compare(db, query);
});

test('trigram routing counts Unicode code points and safely falls back for short/NUL phrases', () => {
  for (const query of ['中', '中文', 'ab', '😀', '😀😃', 'a\0b']) assert.equal(buildSearchQuery(query).usesFts, false, query);
  for (const query of ['中文原', 'abc', '😀😃😄', '😀ab', '   ']) assert.equal(buildSearchQuery(query).usesFts, true, query);
  const injection = '" OR text:* NEAR(x y) "';
  const statement = buildSearchQuery(injection);
  assert.equal(statement.params[1], '"' + injection.replaceAll('"', '""') + '"');
  assert.equal(statement.sql.includes(injection), false);
  assert.throws(() => buildSearchQuery(''), /search phrase/);
  assert.throws(() => buildSearchQuery('abc', {session: ''}), /session ID/);
});

test('joining FTS locations handles independent rowids, sessions and multiple generations', t => {
  const db = memoryDB(t);
  // This row deliberately shifts all FTS rowids and has no corresponding event.
  db.prepare('INSERT INTO search_index(text,session,location) VALUES(?,?,?)').run('shared-needle', 'orphan', '0:1:0');
  insert(db, 'shared-needle zero', {session: 'a', generation: 0, index: 1});
  insert(db, 'shared-needle one', {session: 'a', generation: 1, index: 1});
  insert(db, 'shared-needle two', {session: 'b', generation: 0, index: 1});
  compare(db, 'shared-needle');
  compare(db, 'shared-needle', 'a');
  compare(db, 'shared-needle', "' OR 1=1 --");
  assert.equal(searchHistory(db, 'shared-needle', {root: archiveRoot}).length, 3);
});

test('excerpt uses original-text Unicode coordinates with a late match and fixed 600-character output', t => {
  const db = memoryDB(t);
  const prefix = '😀繁體 '.repeat(300);
  insert(db, prefix + 'Needle中文原文' + '後文 '.repeat(400));
  compare(db, 'needle');
  compare(db, '中文原文');
  const [row] = searchHistory(db, '中文原文', {root: archiveRoot});
  assert.equal(Array.from(row.excerpt).length, 600);
  assert.ok(row.excerpt.includes('Needle中文原文'));
  assert.deepEqual(Object.keys(row), ['session', 'generation', 'line', 'offset', 'time', 'role', 'excerpt', 'raw']);
});

test('results retain newest-first ordering, session isolation and the 20-result limit', t => {
  const db = memoryDB(t);
  for (let index = 1; index <= 45; index++) insert(db, 'repeated phrase ' + index, {session: index % 2 ? 'a' : 'b', index});
  compare(db, 'repeated phrase');
  compare(db, 'repeated phrase', 'b');
  const rows = searchHistory(db, 'repeated phrase', {root: archiveRoot});
  assert.equal(rows.length, 20);
  assert.equal(rows[0].time, '000045');
  assert.equal(rows[19].time, '000026');
});

test('EXPLAIN proves MATCH drives indexed event lookup with and without session filters', t => {
  const db = memoryDB(t);
  insert(db, 'original searchable phrase');
  for (const session of [undefined, 'session-a']) {
    const statement = buildSearchQuery('searchable phrase', {session});
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + statement.sql).all(...statement.params).map(row => row.detail);
    assert.ok(plan.some(detail => /SCAN f VIRTUAL TABLE INDEX.*:M/.test(detail)), JSON.stringify(plan));
    assert.ok(plan.some(detail => /SEARCH e USING INDEX sqlite_autoindex_events_1 \(session=\? AND generation=\? AND offset=\?\)/.test(detail)), JSON.stringify(plan));
    assert.ok(!plan.some(detail => /^SCAN e\b/.test(detail)), JSON.stringify(plan));
    t.diagnostic((session ? 'session: ' : 'all: ') + plan.join(' | '));
  }
  assert.equal(buildSearchQuery('原文').usesFts, false);
});

function cli(root, ...args) {
  return spawnSync(process.execPath, [path.join(projectRoot, 'cli.mjs'), ...args], {
    env: {...process.env, SESSION_CONTINUITY_TEST_ROOT: root}, encoding: 'utf8', windowsHide: true
  });
}

test('status, pause, resume, release and help do not create/open an index database', () => {
  // Retained test evidence; no cleanup/deletion of user files.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-cli-test-'));
  fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify({pid: process.pid, updatedAt: new Date().toISOString()}));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({holdThreadId: 'old', keep: true}));
  for (const command of ['status', 'pause', 'status', 'resume', 'release', 'help']) {
    const result = cli(root, command);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(root, 'index.sqlite')), false);
    if (command === 'status') {
      const status = JSON.parse(result.stdout);
      assert.equal(status.processAlive, true);
      assert.equal(status.heartbeatFresh, true);
      assert.equal(status.paused, fs.existsSync(path.join(root, 'PAUSED')));
    }
  }
  assert.equal(fs.existsSync(path.join(root, 'PAUSED')), false);
  assert.ok(fs.readdirSync(root).some(name => name.startsWith('PAUSED.history-')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'config.json'))), {holdThreadId: null, keep: true});
});

test('search opens the existing database read-only and CLI preserves its JSON result schema', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-search-cli-'));
  const fixture = openDB(root);
  insert(fixture, '原文可搜尋 --session literal', {session: 'wanted'});
  insert(fixture, '另一段原文可搜尋', {session: 'other', index: 2});
  fixture.close();
  const db = openSearchDB(root);
  try {
    assert.throws(() => db.exec('CREATE TABLE forbidden_write(x)'), /readonly/i);
    assert.equal(searchHistory(db, '原文可搜尋', {session: 'wanted', root}).length, 1);
  } finally { db.close(); }
  const result = cli(root, 'search', '原文可搜尋', '--session', 'wanted');
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session, 'wanted');
  assert.equal(rows[0].raw, path.join(root, 'archive', 'wanted', 'raw-0.jsonl'));
  const literalOption = cli(root, 'search', '--session');
  assert.equal(literalOption.status, 0, literalOption.stderr);
  assert.equal(JSON.parse(literalOption.stdout).length, 1);
});

test('invalid search arguments and a missing database fail without creating an empty index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-search-error-'));
  for (const args of [
    ['search'],
    ['search', 'abc', '--session'],
    ['search', 'abc', '--session', ''],
    ['search', 'abc', '--bogus', 'x'],
    ['search', 'abc']
  ]) {
    const result = cli(root, ...args);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.trim());
    assert.equal(fs.existsSync(path.join(root, 'index.sqlite')), false);
  }
});
