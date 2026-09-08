/**
 * چرخشِ توکنِ تازه‌سازی (نشست)
 *
 * هدفِ این تست: نشستِ کاربر در شرایطِ کاملاً عادیِ زندگی واقعی از کار نیفتد،
 * و در عین حال استفاده‌ی غیرمجاز همچنان شناسایی و باطل شود.
 *
 * شرایطِ عادی: چند تبِ باز، تکرارِ درخواست پس از قطعیِ شبکه، دکمه‌ی برگشت/جلو،
 * درخواستی که پیش از تازه‌سازی فرستاده شده و پاسخش دیر رسیده است.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

type Store = typeof import('../../server/store.js');
let store: Store;

beforeAll(async () => {
  // پایگاهِ داده‌ی موقت تا داده‌ی واقعی دست‌نخورده بماند
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'rahkar-auth-'));
  store = await import('../../server/store.js');
});

/** ساختِ یک نشستِ تازه برای کاربرِ آزمون */
function startSession(username = 'auth-test-user') {
  const first = 'token-' + Math.random().toString(36).slice(2);
  store.addRefreshToken({ userId: 'user-1', username, token: first, ttlSeconds: 3600, fingerprint: '1.2.3.4|browser' });
  return first;
}

const rotate = (presented: string, fingerprint: string, graceMs = 15 * 60 * 1000) =>
  store.rotateSessionToken({ presented, fingerprint, ttlSeconds: 3600, issueToken: () => 'next-' + Math.random().toString(36).slice(2), graceMs });

describe('تازه‌سازیِ نشست', () => {
  it('توکنِ مصرف‌نشده را می‌چرخاند و توکنِ تازه می‌دهد', () => {
    const first = startSession();
    const outcome = rotate(first, '1.2.3.4|browser');
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.reused).toBe(false);
      expect(outcome.token).not.toBe(first);
    }
  });

  it('تکرارِ درخواست از همان شبکه در بازه‌ی ارفاق نشست را نمی‌کُشد (تبِ دوم، قطعیِ شبکه)', () => {
    const first = startSession();
    const ok = rotate(first, '1.2.3.4|browser');
    expect(ok.status).toBe('ok');
    // همان توکنِ قدیمی دوباره می‌رسد (تبِ دوم هنوز آن را دارد)
    const again = rotate(first, '1.2.3.4|browser-another-tab');
    expect(again.status).toBe('ok');
    if (again.status === 'ok') expect(again.reused).toBe(true);
  });

  it('درخواست‌های هم‌زمان با یک توکن، نشست را باطل نمی‌کنند', () => {
    const first = startSession();
    const results = Array.from({ length: 5 }, () => rotate(first, '1.2.3.4|browser'));
    expect(results.every((item) => item.status === 'ok')).toBe(true);
  });

  it('توکنی که پیدا نشود پذیرفته نمی‌شود', () => {
    expect(rotate('unknown-token', '1.2.3.4|browser').status).toBe('invalid');
  });

  it('استفاده‌ی کهنه از شبکه‌ی دیگر نشانه‌ی سرقت است و کل نشست باطل می‌شود', () => {
    const first = startSession();
    const rotated = rotate(first, '1.2.3.4|browser');
    expect(rotated.status).toBe('ok');
    if (rotated.status !== 'ok') return;
    // گذرِ زمان را با بازه‌ی ارفاقِ صفر شبیه‌سازی می‌کنیم: توکن کهنه است و از شبکه‌ای دیگر آمده
    const stolen = rotate(first, '9.9.9.9|browser-other', 0);
    expect(stolen.status).toBe('reuse');
    // واکنشِ امنیتی: توکنِ تازه‌ی خودِ کاربر هم دیگر کار نمی‌کند
    expect(rotate(rotated.token, '1.2.3.4|browser', 0).status).not.toBe('ok');
  });

  it('توکنِ کهنه از همان شبکه نشستِ زنده‌ی کاربر را باطل نمی‌کند (فقط همان درخواست رد می‌شود)', () => {
    const first = startSession('auth-test-user-2');
    const rotated = rotate(first, '1.2.3.4|browser');
    expect(rotated.status).toBe('ok');
    if (rotated.status !== 'ok') return;
    const stale = rotate(first, '1.2.3.4|browser', 0);
    expect(stale.status).toBe('invalid');
    // نشستِ جاریِ کاربر همچنان پابرجاست
    expect(rotate(rotated.token, '1.2.3.4|browser').status).toBe('ok');
  });
});
