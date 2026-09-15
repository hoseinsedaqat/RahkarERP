import { defineConfig } from 'vite';

/**
 * پایه‌ی مسیرها به‌صورت پیش‌فرض نسبی است تا خروجی روی هر مسیری
 * (ریشه دامنه یا زیرمسیر مثل example.com/erp) بدون تغییر کار کند.
 * برای استقرار روی مسیر ثابت، BASE_PATH را تنظیم کنید.
 */
const base = process.env.BASE_PATH ?? './';
/** در توسعه، درخواست‌های /api به backend محلی پروکسی می‌شوند تا نیازی به CORS نباشد. */
const apiTarget = process.env.API_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  base,
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT ?? 5173),
    // اجازه‌ی دسترسی از دامنه‌های پیش‌نمایش و تونل‌ها
    allowedHosts: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: Number(process.env.PREVIEW_PORT ?? 4173),
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
