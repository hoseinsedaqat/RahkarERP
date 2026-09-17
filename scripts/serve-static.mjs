/**
 * سرویس‌دهنده‌ی ساده برای نسخه‌ی نمایشیِ ایستا (فقط فایل)
 * ---------------------------------------------------------------------
 * استفاده:  node scripts/serve-static.mjs <پوشه> <پورت>
 * مثال:     node scripts/serve-static.mjs dist-demo 8082
 *
 * این سرویس اندازه‌ی فایل، پشتیبانی از دریافتِ بخشی و پاسخ به درخواستِ HEAD
 * را می‌فرستد تا دریافت فایل‌ها در مرورگرهای مختلف پایدار باشد.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const root = process.argv[2] ?? 'dist-demo';
const port = Number(process.argv[3] ?? 8082);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
};

createServer((request, response) => {
  const safe = normalize(decodeURIComponent((request.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, safe);
  if (!file.startsWith(root)) { response.writeHead(403).end('ممنوع'); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  let status = 200;
  if (!existsSync(file)) {
    // نشانیِ ناشناس: صفحه‌ی «پیدا نشد» با کدِ وضعیتِ واقعیِ ۴۰۴
    const notFound = join(root, '404.html');
    file = existsSync(notFound) ? notFound : join(root, 'index.html');
    status = 404;
  }
  if (!existsSync(file)) { response.writeHead(404).end('یافت نشد'); return; }

  const extension = extname(file);
  const stats = statSync(file);
  const headers = {
    'Content-Type': types[extension] ?? 'application/octet-stream',
    'Content-Length': String(stats.size),
    'Accept-Ranges': 'bytes',
    'Last-Modified': stats.mtime.toUTCString(),
    'Cache-Control': 'no-cache',
  };
  // درخواستِ HEAD: برنامه‌های دانلود نخست آن را می‌فرستند تا اندازه را بفهمند
  if (request.method === 'HEAD') { response.writeHead(status, headers).end(); return; }

  const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? '').trim());
  if (range) {
    const total = stats.size;
    let start = range[1] ? Number(range[1]) : 0;
    let end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    if (range[1] === '') { start = Math.max(0, total - Number(range[2] ?? 0)); end = total - 1; }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      response.writeHead(416, { ...headers, 'Content-Range': `bytes */${total}` }).end();
      return;
    }
    response.writeHead(206, { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${total}` });
    createReadStream(file, { start, end }).pipe(response);
    return;
  }

  response.writeHead(status, headers);
  createReadStream(file).pipe(response);
}).listen(port, '0.0.0.0', () => console.log(`نسخه‌ی نمایشی روی http://0.0.0.0:${port} آماده است (پوشه: ${root})`));
