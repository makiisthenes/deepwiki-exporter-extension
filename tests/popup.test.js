const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const popupSource = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

async function exportPage(initialVersion) {
  let version = initialVersion;
  let injections = 0;
  const requests = [];
  const downloads = [];
  const blobs = [];
  const elements = new Map();
  const document = {
    addEventListener(event, callback) { callback(); },
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, { style: {}, addEventListener(event, callback) { this[event] = callback; } });
      }
      return elements.get(id);
    }
  };
  const chrome = {
    runtime: { getManifest: () => manifest },
    scripting: {
      async executeScript(options) {
        if (options.files) {
          injections++;
          version = manifest.version;
          return [];
        }
        return [{ result: version }];
      }
    },
    tabs: {
      async query() { return [{ id: 1, url: 'https://app.devin.ai/org/example/wiki/owner/repo' }]; },
      async sendMessage(tabId, message) {
        requests.push(message);
        assert.equal(version, manifest.version);
        assert.equal(message.action, 'deepwikiExporterRequest');
        assert.equal(message.request.action, 'convertToMarkdown');
        return { success: true, markdown: '```mermaid\nflowchart TD\nA --> B\n```', markdownTitle: 'Example' };
      }
    },
    downloads: { download(options) { downloads.push(options); } }
  };
  vm.runInNewContext(popupSource, {
    document, chrome, Blob, console,
    URL: class extends URL { static createObjectURL(blob) { blobs.push(blob); return 'blob:export'; } }
  });
  await elements.get('convertBtn').click();
  assert.equal(elements.get('status').className, 'success', elements.get('status').textContent);
  assert.equal(downloads.length, 1);
  assert.match(await blobs[0].text(), /A --> B/);
  assert.equal(requests.length, 1);
  return injections;
}

test('Old responsive content script is updated before downloading', async () => {
  assert.equal(await exportPage(undefined), 1);
});

test('Current content script is not injected again', async () => {
  assert.equal(await exportPage(manifest.version), 0);
});

test('Reinjection replaces the modern listener while legacy listeners ignore the new envelope', () => {
  const listeners = new Set();
  let legacyReplies = 0;
  const legacy = request => { if (request.action === 'convertToMarkdown') legacyReplies++; };
  listeners.add(legacy);
  const chrome = { runtime: {
    onMessage: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
    sendMessage() {}
  } };
  const context = vm.createContext({
    chrome, console, window: { location: { href: 'https://app.devin.ai/' } },
    document: { readyState: 'loading', addEventListener() {} }
  });
  vm.runInContext(contentSource, context);
  vm.runInContext(contentSource, context);
  assert.equal(context.deepwikiExporterVersion, manifest.version);
  assert.equal(listeners.size, 2);
  for (const listener of listeners) {
    listener({ action: 'deepwikiExporterRequest', request: { action: 'tabActivated' } }, {}, () => {});
  }
  assert.equal(legacyReplies, 0);
});