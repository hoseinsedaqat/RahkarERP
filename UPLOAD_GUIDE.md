<div dir="rtl">

# راهنمای انتشار و آپلود «راهکار»

این راهنما سه سناریوی رایج را پوشش می‌دهد: انتشار نسخه‌ی نمایشی روی **Netlify**،
انتشار کد روی **GitHub** و ساخت **بسته‌ی نصبی ویندوز**.

> 📖 توضیح کامل پروژه، ماژول‌ها و روش‌های نصب در [`README.md`](README.md) آمده است.

---

## روش ۱ — انتشار نسخه‌ی نمایشی روی Netlify (ساده‌ترین راه)

نسخه‌ی نمایشی، خروجیِ **بدون سرور** است؛ داده‌ها فقط در مرورگرِ بازدیدکننده می‌مانند.

### الف) با رابط Netlify (بدون خط فرمان)

۱. خروجی را بسازید:

```bash
npm install
npm run build:demo        # خروجی در پوشه‌ی dist (شامل .nojekyll و 404.html)
```

۲. به [app.netlify.com/drop](https://app.netlify.com/drop) بروید و پوشه‌ی `dist` را داخل صفحه بکشید.
۳. Netlify یک نشانی می‌سازد؛ از `Site configuration → Change site name` نام دلخواه بگذارید.

### ب) با اتصال به مخزن GitHub (انتشار خودکار)

۱. در Netlify یک سایت جدید از مخزن بسازید و این تنظیمات را وارد کنید:

| تنظیم | مقدار |
| --- | --- |
| Build command | `npm run build:demo` |
| Publish directory | `dist` |
| Node version | `20` یا `22` (در `Environment variables`) |

۲. با هر push روی شاخه‌ی مقصد، سایت به‌طور خودکار دوباره ساخته و منتشر می‌شود.

🌐 نسخه‌ی نمایشیِ فعلی: **https://rahkar-erp.netlify.app**

کاربرانِ نمایشی: `admin / admin123` · `hesabdari / 1234` · `foroosh / 1234` · `anbar / 1234`

### ج) تست محلیِ همان نسخه

```bash
npm run build:demo:local                     # خروجی در dist-demo
node scripts/serve-static.mjs dist-demo 8081 # سپس http://localhost:8081
```

---

## روش ۲ — انتشار کد روی GitHub

```bash
git clone https://github.com/h03einsedaqat/erpv2.git
cd erpv2

git checkout -b my-feature        # شاخه‌ی کاری خودتان
# … تغییرات …
npm run typecheck && npm test     # بررسی‌ها سبز باشند
git add -A
git commit -m "توضیح تغییر"
git push origin my-feature        # سپس روی GitHub Pull Request بسازید
```

اسکریپت یک‌دستگری هم وجود دارد (کامیت + push + ساخت PR با `gh`):

```bash
BRANCH=نام-شاخه BASE=main bash scripts/publish.sh
```

---

## روش ۳ — بسته‌ی نصبی ویندوز (برای مشتری بدون گیت)

```bash
npm run build
npm run package:win        # خروجی: dist-win/راهکار/
```

پوشه‌ی `dist-win/راهکار` را زیپ کنید و در اختیار کاربر بگذارید.
روی رایانه‌ی مقصد فقط **Node.js نسخه‌ی ۲۰.۱۹ به بالا** لازم است؛ کاربر کافی است
روی `راه‌اندازی.bat` دوبار کلیک کند تا وابستگی‌ها نصب و برنامه اجرا شود.

---

## روش ۴ — اجرای واقعی روی سرور (چندنفره)

نسخه‌ی نمایشی سرور ندارد؛ برای استفاده‌ی واقعیِ تیم، برنامه را روی سرور اجرا کنید:

```bash
git clone https://github.com/h03einsedaqat/erpv2.git
cd erpv2
npm install
cp .env.example .env       # سپس PORT، JWT_SECRET و CORS_ORIGIN را تنظیم کنید
npm start                  # http://localhost:8080
```

یا با داکر:

```bash
docker compose up -d
```

برای اجرای دائمی با systemd، پشت پروکسی HTTPS و اتصال PostgreSQL به
[`docs/راهنما-نصب.md`](docs/راهنما-نصب.md) مراجعه کنید.

---

## اگر چیزی کار نکرد

| مشکل | راه‌حل |
| --- | --- |
| سایت بالا نمی‌آید | مطمئن شوید Publish directory روی `dist` است و Build command دقیقاً `npm run build:demo` |
| صفحه سفید است | کش مرورگر را خالی کنید؛ فایل `assets/index-*.js` باید کنار `index.html` در `dist` باشد |
| خطای ۴۰۴ در نشانی‌های داخلی | فایل `404.html` باید در خروجی باشد (اسکریپت `prepare-pages` آن را می‌سازد) |
| `npm install` خطا می‌دهد | Node.js را به نسخه‌ی `20.19+` یا `22.12+` ارتقا دهید و `npm cache clean --force` بزنید |
| پورت ۸۰۸۰ اشغال است | در `.env` مقدار `PORT` را عوض کنید |

</div>
