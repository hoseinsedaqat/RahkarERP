/**
 * تست‌های امنیتیِ لایه‌ی احراز هویت و توکن.
 * اجرا: npm test
 */
import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  passwordError,
  permissionsOf,
  signRefreshToken,
  signToken,
  verifyPassword,
  verifyRefreshToken,
  verifyToken,
} from '../../server/auth.js';

const claims = { sub: 'user-1', username: 'admin', displayName: 'مدیر', role: 'admin' as const };

describe('گذرواژه', () => {
  it('هش متفاوت برای هر بار اجرا است (نمک تصادفی)', () => {
    const first = hashPassword('رمزعبور۱۲۳');
    const second = hashPassword('رمزعبور۱۲۳');
    expect(first).not.toBe(second);
    expect(verifyPassword('رمزعبور۱۲۳', first)).toBe(true);
    expect(verifyPassword('رمزعبور۱۲۳', second)).toBe(true);
  });

  it('گذرواژه‌ی اشتباه پذیرفته نمی‌شود', () => {
    const hash = hashPassword('رمزعبور۱۲۳');
    expect(verifyPassword('اشتباه', hash)).toBe(false);
  });

  it('سیاستِ گذرواژه اعمال می‌شود', () => {
    expect(passwordError('123')).not.toBeNull();
    expect(passwordError('abcdefgh')).not.toBeNull(); // بدون عدد
    expect(passwordError('12345678')).not.toBeNull(); // بدون حرف
    expect(passwordError('رمزعبور۱۲')).toBeNull();
  });
});

describe('توکن دسترسی', () => {
  it('توکن معتبر تأیید می‌شود', () => {
    const token = signToken(claims, 3600);
    const payload = verifyToken(token);
    expect(payload?.username).toBe('admin');
    expect(payload?.kind).toBe('access');
  });

  it('توکنِ دست‌کاری‌شده رد می‌شود', () => {
    const token = signToken(claims, 3600);
    const parts = token.split('.');
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify({ sub: 'x', username: 'hacker', role: 'admin', kind: 'access', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.${parts[2]}`;
    expect(verifyToken(forged)).toBeNull();
  });

  it('توکنِ منقضی رد می‌شود', () => {
    const token = signToken(claims, -10);
    expect(verifyToken(token)).toBeNull();
  });

  it('توکن تازه‌سازی به‌جای توکن دسترسی پذیرفته نمی‌شود', () => {
    const refresh = signRefreshToken(claims, 3600);
    expect(verifyToken(refresh)).toBeNull();
  });

  it('توکن تازه‌سازی معتبر تأیید می‌شود', () => {
    const refresh = signRefreshToken(claims, 3600);
    const payload = verifyRefreshToken(refresh);
    expect(payload?.username).toBe('admin');
    expect(payload?.kind).toBe('refresh');
  });
});

describe('دسترسی‌ها', () => {
  it('نقشِ مدیر همه‌ی دسترسی‌های مدیریتی را دارد', () => {
    const permissions = permissionsOf('admin');
    expect(permissions).toContain('identity.manage');
    expect(permissions).toContain('accounting.write');
  });

  it('نقشِ حسابدار دسترسیِ مدیریت کاربران ندارد', () => {
    const permissions = permissionsOf('accountant');
    expect(permissions).not.toContain('identity.manage');
    expect(permissions).toContain('accounting.read');
  });

  it('نقشِ مشاهده‌گر فقط خواندن دارد', () => {
    const permissions = permissionsOf('viewer');
    expect(permissions.every((permission) => permission.endsWith('.read'))).toBe(true);
  });
});
