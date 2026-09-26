import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

async function chromeExecutable() {
  const candidates = [process.env.CHROME_PATH, ...(process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ] : process.platform === 'win32' ? [
    path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')] : []),
  ] : ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'])];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next installed location. */ }
  }
  throw new Error('Google Chrome was not found. Set CHROME_PATH to its executable.');
}

/** Leave native downloads intact: overriding them crashes Chrome 153 with restored download history. */
export async function launchInteractiveChrome(profile) {
  const chromeProcess = spawn(await chromeExecutable(), [
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--window-size=1440,1000',
    // Match the previous test profile's keychain settings, avoiding an OS credential prompt.
    '--password-store=basic', '--use-mock-keychain', '--disable-background-mode', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise(resolve => chromeProcess.once('exit', resolve));
  let stopPromise;
  const waitForExit = async milliseconds => {
    let timer;
    const finished = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]);
    clearTimeout(timer); return finished;
  };
  const stop = () => stopPromise ??= (async () => {
    if (!chromeProcess.pid || chromeProcess.exitCode !== null || chromeProcess.signalCode !== null) return;
    // Give Browser.close time to flush the persistent profile before considering signals.
    if (await waitForExit(3000)) return;
    chromeProcess.kill('SIGTERM');
    if (await waitForExit(3000)) return;
    chromeProcess.kill('SIGKILL');
    await exited;
  })();
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let stderr = '';
      const timer = setTimeout(() => reject(new Error('Chrome did not expose its debugging endpoint within 15 seconds.')), 15000);
      chromeProcess.once('error', error => { clearTimeout(timer); reject(error); });
      chromeProcess.once('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited during startup (${code}). ${stderr.slice(-1500)}`)); });
      chromeProcess.stderr.on('data', chunk => {
        stderr = (stderr + chunk).slice(-8192);
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, isLocal: true, timeout: 15000 });
    browser.once('disconnected', () => { void stop(); });
    const context = browser.contexts()[0];
    const disconnect = context.close.bind(context);
    let closePromise;
    // CDP normally disconnects without stopping the external browser. This helper owns that chromeProcess.
    context.close = options => closePromise ??= (async () => {
      if (browser.isConnected()) {
        let timer;
        await Promise.race([
          browser.newBrowserCDPSession().then(session => session.send('Browser.close')).catch(() => {}),
          new Promise(resolve => { timer = setTimeout(resolve, 3000); }),
        ]);
        clearTimeout(timer);
      }
      await stop();
      await disconnect(options);
    })();
    return context;
  } catch (error) { await stop(); throw error; }
}
