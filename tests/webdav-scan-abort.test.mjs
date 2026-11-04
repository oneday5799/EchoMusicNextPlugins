// End-to-end abort-chain reproduction against the real entry.ts: a scan whose
// in-flight PROPFIND is cancelled by flat.abort must stop immediately and keep
// the songs collected before the abort, so flat.page can serve them.
// Run through the repo test script, which registers the echo:plugin-sdk hook.
import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

// Register the echo:plugin-sdk resolution hook directly: under full-suite
// parallelism the runner's --import propagation can race this file's dynamic
// import, so the hook must be in place before entry.ts is imported.
register('./helpers/echo-sdk-hooks.mjs', import.meta.url);

class FakeOperation {
  constructor() {
    this.state = 0;
    this.result = undefined;
    this.errorCode = '';
    this.errorMessage = '';
    this.listeners = [];
    this.cancelRequested = false;
  }

  get completed() {
    const op = this;
    return {
      connect(callback) {
        op.listeners.push(callback);
      },
      disconnect(callback) {
        const index = op.listeners.indexOf(callback);
        if (index >= 0) op.listeners.splice(index, 1);
      },
    };
  }

  settle(state, result, message) {
    if (this.state >= 2) return;
    this.state = state;
    if (state === 2) this.result = result;
    if (message) this.errorMessage = message;
    for (const listener of [...this.listeners]) listener();
    this.listeners.length = 0;
  }

  resolve(result) {
    this.settle(2, result);
  }

  reject(message) {
    this.settle(3, undefined, message);
  }

  cancel() {
    if (this.state >= 2) return;
    this.cancelRequested = true;
    this.settle(4, undefined, 'Operation canceled');
  }
}

const ROOT_XML = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/a.mp3</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1024</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/sub/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;

function waitFor(predicate, timeoutMs = 2000, stepMs = 5) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      let ok = false;
      try {
        ok = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (ok) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('waitFor timeout'));
        return;
      }
      setTimeout(check, stepMs);
    };
    check();
  });
}

test('扫描中止：取消在途请求、保留部分结果、flat.page 可读', async () => {
  const { activate, deactivate } = await import('../plugins/webdav-music/src/entry.ts');

  const commands = new Map();
  const store = new Map();
  const published = [];
  let stuckOperation = null;

  const ctx = {
    io: {
      readValue(key) {
        const op = new FakeOperation();
        op.resolve(store.has(key) ? store.get(key) : undefined);
        return op;
      },
      writeValue(key, value) {
        const op = new FakeOperation();
        store.set(key, value);
        op.resolve(undefined);
        return op;
      },
      removeValue(key) {
        const op = new FakeOperation();
        store.delete(key);
        op.resolve(undefined);
        return op;
      },
    },
    net: {
      request(request) {
        const op = new FakeOperation();
        if (request.method === 'PROPFIND' && /\/sub\/?$/.test(request.url)) {
          // Second directory hangs until cancelled, like a throttled server.
          stuckOperation = op;
          return op;
        }
        if (request.method === 'PROPFIND') {
          op.resolve({ status: 207, data: ROOT_XML });
          return op;
        }
        op.reject(`Unexpected request ${request.method} ${request.url}`);
        return op;
      },
    },
    setTimer(id, intervalMs, repeat, callback) {
      const handle = setTimeout(callback, Math.max(0, intervalMs));
      return {
        dispose() {
          clearTimeout(handle);
        },
      };
    },
    ui: {
      setState(values) {
        published.push(values);
      },
      registerPage() {
        return null;
      },
      registerSettings() {
        return null;
      },
      registerSidebarItem() {
        return null;
      },
    },
    player: {
      audioSource: {
        registerResolver() {
          return null;
        },
      },
    },
    lyrics: {
      registerResolver() {
        return null;
      },
    },
    tasks: {
      registerTask() {
        return null;
      },
    },
    registerCommand(id, handler) {
      commands.set(id, handler);
    },
  };

  store.set('settings', {
    libraries: [
      {
        id: 'lib1',
        name: '测试库',
        serverUrl: 'http://webdav.local',
        username: 'user',
        password: 'pass',
        rootPath: '/',
      },
    ],
    activeLibraryId: 'lib1',
  });

  await activate(ctx);
  try {
    assert.deepEqual(await commands.get('flat.load')({ libraryId: 'lib1', force: true }), {
      started: true,
    });
    await waitFor(() => published.some((entry) => entry.flatScan && entry.flatScan.found >= 1));
    assert.ok(stuckOperation, '第二个目录的请求应仍在途中');

    assert.deepEqual(commands.get('flat.abort')({}), { ok: true });
    assert.equal(stuckOperation.cancelRequested, true, '停止应立即取消在途请求');

    await waitFor(() => {
      const latest = published[published.length - 1];
      return latest.flatScan && latest.flatScan.aborted;
    });
    const finalState = published[published.length - 1].flatScan;
    assert.equal(finalState.running, false);
    assert.equal(finalState.count >= 1, true, '中止状态应携带已扫到的数量');

    const page = await commands.get('flat.page')({ libraryId: 'lib1', offset: 0, limit: 100 });
    assert.equal(page.ready, true, '中止后 flat.page 应能读到部分结果');
    assert.equal(page.total >= 1, true);
  } finally {
    await deactivate();
  }
});
