import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const base = new URL('../../', import.meta.url).pathname;
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function boot({ offline = false, username = 'admin', password = 'admin123' } = {}) {
  const html = readFileSync(`${base}/dist/index.html`, 'utf8')
    .replace(/<script type="module"[^>]*><\/script>/g, '')
    .replace(/<link rel="stylesheet"[^>]*>/g, '');
  const asset = readFileSync(`${base}/dist/index.html`, 'utf8').match(/assets\/(index-[\w-]+\.js)/)[1];
  const bundle = readFileSync(`${base}/dist/assets/${asset}`, 'utf8');
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (error) => { if (!/Not implemented/.test(String(error.message))) errors.push(error.message); });
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost:8080/', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  /**
   * jsdom تا نسخه‌ی ۲۹ متدهای Blob.text/arrayBuffer را پیاده نکرده است (نسخه‌ی ۳۰ دارد، اما
   * Node کمتر از ۲۲.۲۲ را نمی‌پذیرد). برنامه از file.text() برای واردکردنِ CSV/پشتیبان
   * استفاده می‌کند؛ این پُر‌کننده همان رفتارِ مرورگر را می‌دهد تا تست‌ها روی هر نسخه‌ای بگذرند.
   */
  if (typeof window.Blob.prototype.text !== 'function') {
    const read = (blob, as) => new Promise((resolve, reject) => {
      const reader = new window.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      if (as === 'text') reader.readAsText(blob); else reader.readAsArrayBuffer(blob);
    });
    window.Blob.prototype.text = function text() { return read(this, 'text'); };
    window.Blob.prototype.arrayBuffer = function arrayBuffer() { return read(this, 'buffer'); };
  }
  window.fetch = offline ? () => Promise.reject(new Error('offline')) : (input, init) => fetch(new URL(String(input), 'http://localhost:8080/'), init);
  window.localStorage.clear();
  const script = window.document.createElement('script');
  script.textContent = bundle;
  window.document.body.appendChild(script);
  await wait(700);
  const doc = window.document;
  doc.querySelector('#landing-login')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(150);
  const u = doc.querySelector('#username'); const p = doc.querySelector('#password');
  if (u) u.value = username;
  if (p) p.value = password;
  doc.querySelector('#login-form')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(1400);
  return { window, doc, errors };
}

export const goModule = async (doc, window, id) => {
  doc.querySelector(`[data-module="${id}"]`)?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(900);
};

export function createChecker() {
  const state = { failures: 0 };
  const check = (name, condition, detail = '') => {
    if (!condition) state.failures += 1;
    console.log(`  ${condition ? '✓' : '✗'} ${name}${detail ? ` ${detail}` : ''}`);
  };
  return { check, state };
}
