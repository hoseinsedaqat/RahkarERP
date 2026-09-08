/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** آیا این ساخت، نسخه‌ی نمایشیِ بدون سرور است (GitHub Pages) */
  readonly VITE_DEMO?: string;
  /** نشانیِ backend در صورت جدا بودن از فرانت‌اند */
  readonly VITE_API_BASE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
