/**
 * Unit tests for machine-type classification.
 * Run: node test-machine-type.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

async function loadModule() {
  const modPath = path.join(__dirname, 'src', 'machine-type.js');
  if (!fs.existsSync(modPath)) throw new Error('src/machine-type.js missing');
  return import(pathToFileURL(modPath).href);
}

function runCase(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
    return true;
  } catch (err) {
    console.error('  ✗', name);
    console.error('   ', err.message);
    return false;
  }
}

(async () => {
  console.log('Machine type classification tests');
  console.log('================================');
  const {
    inferModeFromRepo,
    inferModeFromUrl,
    classifyMachine,
    MODE_LABELS,
  } = await loadModule();

  let passed = 0;
  let failed = 0;
  const check = (name, fn) => {
    if (runCase(name, fn)) passed += 1;
    else failed += 1;
  };

  check('repo: vps-novnc → vnc', () => {
    assert.strictEqual(inferModeFromRepo('vps-novnc'), 'vnc');
  });
  check('repo: vps-bore → bore', () => {
    assert.strictEqual(inferModeFromRepo('vps-bore'), 'bore');
  });
  check('repo: vps-ngrok → ngrok (covers ngrok_fast)', () => {
    assert.strictEqual(inferModeFromRepo('vps-ngrok'), 'ngrok');
  });
  check('repo: empty → null', () => {
    assert.strictEqual(inferModeFromRepo(''), null);
    assert.strictEqual(inferModeFromRepo(undefined), null);
  });
  check('repo: case-insensitive', () => {
    assert.strictEqual(inferModeFromRepo('VPS-BORE'), 'bore');
    assert.strictEqual(inferModeFromRepo('My-Ngrok-Fork'), 'ngrok');
  });

  check('url: https noVNC link → vnc', () => {
    assert.strictEqual(inferModeFromUrl('https://abc.ngrok-free.app'), 'vnc');
    assert.strictEqual(inferModeFromUrl('http://example.com/vnc.html'), 'vnc');
  });
  check('url: bore.pub:port → bore', () => {
    assert.strictEqual(inferModeFromUrl('bore.pub:12345'), 'bore');
  });
  check('url: *.tcp.*.ngrok.io:port → ngrok', () => {
    assert.strictEqual(inferModeFromUrl('0.tcp.ap.ngrok.io:12345'), 'ngrok');
    assert.strictEqual(inferModeFromUrl('4.tcp.us.ngrok.io:9999'), 'ngrok');
  });
  check('url: bare host:port TCP → bore default', () => {
    assert.strictEqual(inferModeFromUrl('example.com:3389'), 'bore');
  });
  check('url: empty → null', () => {
    assert.strictEqual(inferModeFromUrl(''), null);
  });

  check('classify: prefers repo over url', () => {
    const c = classifyMachine({
      repo: 'vps-ngrok',
      ngrok_url: 'bore.pub:1111', // conflicting on purpose
    });
    assert.strictEqual(c.mode, 'ngrok');
    assert.strictEqual(c.isNgrok, true);
    assert.strictEqual(c.isBore, false);
    assert.strictEqual(c.isRdp, true);
    assert.strictEqual(c.label, MODE_LABELS.ngrok);
  });

  check('classify: falls back to url when repo missing', () => {
    const c = classifyMachine({ ngrok_url: '0.tcp.ap.ngrok.io:5555' });
    assert.strictEqual(c.mode, 'ngrok');
    assert.strictEqual(c.isNgrok, true);
    assert.strictEqual(c.isRdp, true);
  });

  check('classify: bore machine label + defaults', () => {
    const c = classifyMachine({ repo: 'vps-bore', ngrok_url: 'bore.pub:2222' });
    assert.strictEqual(c.mode, 'bore');
    assert.strictEqual(c.label, 'Bore RDP');
    assert.strictEqual(c.defaults.username, 'admin');
    assert.strictEqual(c.defaults.password, 'WindowsRDP2026@');
  });

  check('classify: vnc machine is not RDP', () => {
    const c = classifyMachine({
      repo: 'vps-novnc',
      ngrok_url: 'https://xyz.example/vnc.html',
    });
    assert.strictEqual(c.mode, 'vnc');
    assert.strictEqual(c.isVnc, true);
    assert.strictEqual(c.isRdp, false);
    assert.strictEqual(c.label, 'noVNC');
  });

  check('classify: ngrok must NOT be labeled Bore RDP', () => {
    const c = classifyMachine({
      repo: 'vps-ngrok',
      ngrok_url: '0.tcp.ap.ngrok.io:12345',
    });
    assert.notStrictEqual(c.label, 'Bore RDP');
    assert.strictEqual(c.label, 'Ngrok RDP');
    assert.strictEqual(c.isBore, false);
    assert.strictEqual(c.isNgrok, true);
  });

  check('classify: default mode vnc when no signals', () => {
    const c = classifyMachine({});
    assert.strictEqual(c.mode, 'vnc');
    assert.strictEqual(c.isVnc, true);
  });

  // Regression: old UI used isBore = !isVnc && /:\\d+$/ which mislabeled ngrok
  check('regression: host:port ngrok url with ngrok repo is ngrok not bore', () => {
    const c = classifyMachine({
      repo: 'vps-ngrok',
      ngrok_url: '0.tcp.ap.ngrok.io:18432',
    });
    assert.strictEqual(c.isBore, false);
    assert.strictEqual(c.isNgrok, true);
    assert.strictEqual(c.isRdp, true);
  });

  console.log('================================');
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('ALL TESTS PASSED');
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
