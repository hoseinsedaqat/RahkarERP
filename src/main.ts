import './styles.css';
import './login-modern.css';

/**
 * آدرس پایه‌ی API. مقدار پیش‌فرض نسبی است («» همین origin) تا اپلیکیشن روی هر هاستی
 * (localhost، سرور اختصاصی یا GitHub Pages) بدون تغییر کد کار کند.
 * برای اتصال به backend جداگانه، متغیر VITE_API_BASE را تنظیم کنید.
 */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
let apiOnline = false;
/** نسخه‌ی نمایشیِ بدونِ سرور (GitHub Pages): هیچ درخواستِ شبکه‌ای فرستاده نمی‌شود */
const demoMode = import.meta.env.VITE_DEMO === 'true';

/** کلید نسخه‌دار توکن؛ توکن‌های نسخه‌های قدیمی (غیر JWT) نادیده گرفته می‌شوند */
const tokenKey = 'erp-token-v2';
const refreshKey = 'erp-refresh-v1';
const legacyTokenKeys = ['erp-token'];
/** نشان می‌دهد نشستِ سمت سرور هنوز معتبر است یا برنامه در حالت محلی است */
let serverSession = false;
/** آیا وضعیت نشست در این بارگذاری برنامه بررسی شده است؟ */
let sessionChecked = false;
let sessionExpiredNotified = false;
let authPromptShown = false;

/** حذف توکن‌های قدیمی تا پیام «نشست منقضی شد» بی‌دلیل نمایش داده نشود */
function dropLegacyTokens(): void {
  legacyTokenKeys.forEach((key) => localStorage.removeItem(key));
}

/** توکن نشست جاری؛ در صورت نبود، درخواست‌ها بدون هدر Authorization ارسال می‌شوند */
function authToken(): string | null {
  return localStorage.getItem(tokenKey);
}

/**
 * هدرهای احراز هویتِ یک درخواست.
 * توکن هم در Authorization (استاندارد) و هم در X-Auth-Token فرستاده می‌شود؛ چون
 * بعضی پروکسی‌ها/CDNها (مثلاً پیش‌نمایش‌های ابری و برخی تونل‌ها) هدرِ Authorization را
 * حذف می‌کنند و کاربر با وجودِ ورودِ درست، از همه‌ی مسیرها ۴۰۱ می‌گرفت. سرور هر دو
 * (و کوکیِ HttpOnly که خودش می‌گذارد) را می‌پذیرد؛ بنابراین اتصال به زیرساخت وابسته نیست.
 */
function authHeaders(token: string | null = authToken()): Record<string, string> {
  if (!token) return {};
  return { Authorization: `Bearer ${token}`, 'X-Auth-Token': token };
}

/** آیا کاربر با دکمه‌ی خروج از برنامه بیرون رفته است؟ (تا برنامه خودکار برنگرداندش) */
let userLoggedOut = false;

/** زمانِ انقضای توکنِ دسترسی (بر حسب میلی‌ثانیه) */
function tokenExpiresAt(): number {
  const token = authToken();
  const part = token?.split('.')[1];
  if (!part) return 0;
  try {
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * تازه‌سازیِ پیش‌دستانه: پنج دقیقه پیش از پایانِ اعتبار، توکن بی‌صدا نو می‌شود
 * تا کاربر هرگز در میانه‌ی کار با پایانِ نشست روبه‌رو نشود.
 */
const tokenNeedsRefresh = (): boolean => {
  const expiry = tokenExpiresAt();
  return expiry > 0 && expiry - Date.now() < 5 * 60 * 1000;
};

/** به‌روزرسانی نشانگر وضعیت بر اساس اتصال و اعتبار نشست */
/**
 * به‌روزرسانیِ نشانگرِ وضعیتِ اتصال.
 * این تابع فقط متغیرهای حافظه را می‌خواند و هیچ درخواستِ شبکه‌ای نمی‌فرستد،
 * بنابراین می‌توان آن را در هر بار بازسازیِ صفحه صدا زد.
 * نکته‌ی مهم: مقدارِ نمایش‌داده‌شده باید از «آخرین وضعیتِ معلوم» خوانده شود؛
 * پیش از این متنِ نشانگر در قالبِ HTML ثابت بود و با هر بازسازی به
 * «در حال بررسی اتصال» برمی‌گشت و مدام با «متصل به سرور» جابه‌جا می‌شد.
 */
function updateApiChip(): void {
  const chip = document.querySelector<HTMLElement>('#api-chip');
  if (!chip) return;
  if (demoMode) {
    chip.classList.remove('online', 'checking', 'offline');
    chip.classList.add('demo');
    chip.textContent = '● نسخه‌ی نمایشی';
    chip.title = 'بدون سرور: داده‌ها فقط در مرورگرِ شما نگه داشته می‌شوند (برای توضیحات کلیک کنید)';
    return;
  }
  // «در حال بررسی» فقط تا نخستین پاسخِ سرور معنا دارد؛ پس از آن وضعیت قطعی است
  const checking = !sessionChecked;
  chip.classList.toggle('online', apiOnline && serverSession);
  chip.classList.toggle('checking', checking);
  chip.classList.toggle('offline', !apiOnline);

  let label: string;
  let hint: string;
  if (checking) {
    label = '… در حال بررسی اتصال';
    hint = 'در حال بررسی اتصال به سرور';
  } else if (apiOnline && serverSession) {
    label = '● متصل به سرور';
    hint = 'اتصال برقرار است؛ داده‌ها با سرور همگام می‌شوند';
  } else if (apiOnline && session) {
    label = serverRestarted ? '○ سرویس در دسترس نیست' : '○ نیاز به اتصالِ دوباره';
    hint = serverRestarted
      ? 'سرویس راه‌اندازیِ دوباره شده یا پایگاهِ داده‌اش در دسترس نیست؛ برای ادامه دوباره وارد شوید'
      : 'نشست برقرار نیست؛ برای ورودِ دوباره کلیک کنید';
  } else if (apiOnline) {
    label = '● سرور آماده است';
    hint = 'سرور در دسترس است؛ وارد شوید تا داده‌ها همگام شوند';
  } else {
    label = '○ حالت آفلاین';
    hint = 'سرور در دسترس نیست؛ تا برقراریِ ارتباط، تغییرات روی سرور ذخیره نمی‌شوند';
  }
  chip.textContent = label;
  chip.title = hint;
}

/**
 * بررسی اعتبار توکن ذخیره‌شده هنگام بارگذاری برنامه.
 * پیش از این، بعد از تازه‌کردن صفحه نشست معتبر به‌اشتباه «ندارد» نشان داده می‌شد.
 */
async function checkSession(): Promise<void> {
  if (sessionChecked) return;
  sessionChecked = true;
  if (userLoggedOut) { serverSession = false; return; }
  if (!authToken()) {
    // توکن دسترسی نداریم؛ اگر توکن تازه‌سازی داریم، بی‌صدا نشست را برمی‌گردانیم
    if (localStorage.getItem(refreshKey)) {
      const renewed = await refreshSession();
      if (renewed) { hydrateLocalState(); updateApiChip(); void afterSessionEstablished(); return; }
    }
    serverSession = false;
    // سرور در دسترس است ولی هیچ نشستی نداریم؛ کار بدونِ نشست معنا ندارد
    if (session) forceRelogin('برای ادامه‌ی کار وارد حساب کاربری شوید.');
    return;
  }
  const result = await apiFetch('/api/me');
  serverSession = Boolean(result?.ok);
  if (serverSession) {
    void loadOrganizations();
  } else if (result && (result.status === 401 || result.status === 403)) {
    // سرور در دسترس است اما نشستِ ذخیره‌شده را نمی‌پذیرد → ورودِ دوباره
    forceRelogin();
  }
}

/**
 * ارسال درخواست به backend با هدرهای احراز هویت.
 * - نبود سرور یا نبود توکن: سکوت و ادامه در حالت محلی (بدون پیام خطا)
 * - توکن نامعتبر/منقضی: فقط یک‌بار اطلاع‌رسانی و سپس ادامه در حالت محلی
 */
/**
 * پایانِ قطعیِ نشست: سرور در دسترس است اما توکن‌های ذخیره‌شده را نمی‌پذیرد
 * (کلیدِ امضا عوض شده، پایگاه پاک شده، نشست باطل یا منقضی شده است).
 * پیش‌تر برنامه در این حالت به «حالت محلی» می‌رفت و کاربر بی‌خبر با داده‌ی مرورگر
 * کار می‌کرد؛ اکنون نشانه‌های نشست پاک و صفحه‌ی ورود نشان داده می‌شود تا هر
 * ثبتی واقعاً روی سرور انجام شود.
 */
let reloginInProgress = false;
function forceRelogin(message = 'نشست شما پایان یافته است؛ برای ادامه دوباره وارد شوید.'): void {
  if (demoMode || reloginInProgress) return;
  reloginInProgress = true;
  serverSession = false;
  sessionChecked = true;
  localStorage.removeItem(tokenKey);
  localStorage.removeItem(refreshKey);
  localStorage.removeItem('erp-session');
  session = null;
  workspaceLoaded = false;
  workspacePending = {};
  closeAllModals();
  preferLoginScreen = true;
  renderLogin();
  showToast(message);
  window.setTimeout(() => { reloginInProgress = false; }, 1500);
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response | null> {
  // نسخه‌ی نمایشی سرور ندارد؛ برنامه کاملاً محلی کار می‌کند و خطایی نشان داده نمی‌شود
  if (demoMode) return null;
  // پیش از ساختنِ هدرها، اگر توکن رو به پایان است آن را بی‌صدا نو می‌کنیم؛
  // در غیر این صورت درخواست با همان توکنِ کهنه می‌رفت و دوباره ۴۰۱ می‌گرفت
  if (tokenNeedsRefresh() && localStorage.getItem(refreshKey)) await refreshSession();
  const token = authToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined), ...authHeaders(token) };
  if (activeOrganizationId) { headers['X-Organization-Id'] = activeOrganizationId; headers['X-Org-Id'] = activeOrganizationId; }
  try {
    const result = await fetch(`${API_BASE}${path}`, { credentials: 'same-origin', ...init, headers });
    noteServerId(result.headers?.get?.('x-server-id'), result.headers?.get?.('x-secret-id'));
    if (result.status === 401) {
      /**
       * نخست بی‌صدا نشست را تازه می‌کنیم (تک‌پروازی؛ چند درخواستِ هم‌زمان یک تلاش انجام می‌دهند).
       * در صورت موفقیت همان درخواست تکرار می‌شود و کاربر هیچ اختلالی حس نمی‌کند.
       */
      // اگر همین چند لحظه پیش نشست را تازه کرده‌ایم، دوباره تازه نمی‌کنیم تا
      // حلقه‌ی «۴۰۱ ← تازه‌سازی ← ۴۰۱» شکل نگیرد (این حلقه کنسول را پر از ۴۰۱ می‌کرد)
      if (localStorage.getItem(refreshKey) && Date.now() - lastRefreshAt > 4000) {
        const renewed = await refreshSession(true);
        if (renewed) {
          /**
           * نکته‌ی مهم: تازه‌سازی موفق شد، پس نشست زنده است. اگر باز هم همین درخواست
           * ۴۰۱ بدهد، مشکل از دسترسی به همان بخش است (نشست سالم است). بنابراین پاسخ را
           * همان‌طور برمی‌گردانیم و هرگز وضعیت را «عدم اتصال» نمی‌کنیم؛ در غیر این صورت
           * یک درخواستِ ناموفقِ ساده باعث چرخه‌ی «متصل ← عدم اتصال» می‌شد.
           */
          serverSession = true;
          sessionChecked = true;
          updateApiChip();
          return await fetch(`${API_BASE}${path}`, { credentials: 'same-origin', ...init, headers: { ...headers, ...authHeaders() } });
        }
      }
      /**
       * تنها راهِ رسیدن به اینجا این است که خودِ «تازه‌سازیِ نشست» ناموفق بوده باشد؛
       * یعنی نشست واقعاً در دسترس نیست. باز هم کاربر را بیرون نمی‌اندازیم و داده‌هایش
       * را پاک نمی‌کنیم: یک‌بار پیامی آرام نشان می‌دهیم و کار در حالت محلی ادامه می‌یابد.
       * اتصالِ دوباره با یک کلیک روی نشانگرِ وضعیت انجام می‌شود.
       */
      if (token) {
        // توکن داشتیم و سرور آن را نپذیرفت و تازه‌سازی هم ممکن نبود → ورودِ دوباره
        forceRelogin();
      }
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * بررسی سلامت backend.
 * - وضعیت فقط پس از دو نتیجه‌ی پیاپیِ یکسان تغییر می‌کند تا نشانگرِ اتصال مدام قطع و وصل نشود.
 * - هنگامی که کاربر مشغول تایپ یا پنجره‌ای باز است، صفحه بازسازی نمی‌شود تا ورودی او از بین نرود.
 */
let apiStatusStreak = 0;
let pendingDataRender = false;
async function refreshApiStatus(): Promise<void> {
  if (demoMode) { sessionChecked = true; serverSession = false; apiOnline = false; updateApiChip(); return; }
  let online = false;
  try {
    const result = await fetch(`${API_BASE}/api/health`, { cache: 'no-store' });
    online = result.ok;
  } catch {
    online = false;
  }
  apiStatusStreak = online === apiOnline ? apiStatusStreak + 1 : 1;
  if (apiStatusStreak >= 2) apiOnline = online; else if (online) apiOnline = true;
  updateApiChip();

  if (apiOnline) {
    // اگر نشست قطع شده است، هر دور دوباره بررسی می‌شود تا با برگشتنِ سرور خودکار وصل شود
    if (!serverSession) {
      sessionChecked = false;
      serverRestarted = false; // شاید سرویس برگشته باشد؛ از نو می‌سنجیم
    }
    await checkSession();
  }
  if (apiOnline && serverSession && !syncingServerData) {
    syncingServerData = true;
    const changed = await loadServerData().catch(() => false);
    syncingServerData = false;
    if (changed) {
      const busy = document.querySelector('.modal-backdrop') ||
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? '') ? document.activeElement : null);
      if (busy) pendingDataRender = true;
      else render();
    }
  }
}

/** آیا اکنون می‌توان صفحه را بازسازی کرد (کاربر مشغول کاری نیست) */
function canRenderNow(): boolean {
  if (document.querySelector('.modal-backdrop')) return false;
  const active = document.activeElement;
  if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return false;
  return true;
}

/** بررسی دوره‌ایِ وضعیت؛ هنگام پنهان‌بودنِ تب متوقف می‌شود */
function startStatusMonitor(): void {
  const tick = (): void => { if (!document.hidden) void refreshApiStatus(); };
  void refreshApiStatus();
  const timer = window.setInterval(tick, 45_000);
  window.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  window.addEventListener('online', () => void refreshApiStatus());
  window.addEventListener('offline', () => { apiOnline = false; apiStatusStreak = 0; updateApiChip(); });
  window.addEventListener('beforeunload', () => { window.clearInterval(timer); void flushWorkspace(); });
  // بازسازیِ معوق: هر زمان کاربر از فرم خارج شد، صفحه به‌روز می‌شود
  document.addEventListener('focusout', () => {
    if (!pendingDataRender) return;
    /**
     * بلافاصله بازسازی نمی‌کنیم: هنگامِ جابه‌جاییِ focus، عنصرِ فعال لحظه‌ای تغییر می‌کند
     * و ممکن است صفحه درست در میانه‌ی تایپِ کاربر عوض شود (فرم‌های درون صفحه را خالی می‌کرد).
     * کمی صبر می‌کنیم و اگر کاربر در فیلدی مشغول بود، بازسازی به زمانِ بعد موکول می‌شود.
     */
    window.setTimeout(() => {
      if (!pendingDataRender) return;
      const active = document.activeElement;
      if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return;
      if (!canRenderNow()) return;
      pendingDataRender = false;
      render();
    }, 200);
  });
}

type Module = {
  id: string;
  label: string;
  icon: string;
  note: string;
  features: string[];
  kpis: [string, string, string][];
};
type Transaction = { id?: string; title: string; category: string; amount: string; status: string; date: string };
type SavedRecord = Transaction & { id: string; feature: string; owner: string; isDemo?: boolean };
type JournalLine = { accountCode: string; accountTitle: string; debit: number; credit: number };
type Journal = { id: string; number: number; description: string; lines: JournalLine[]; status: string; createdAt: string };
type AccountBalance = { code: string; title: string; debit: number; credit: number; balance: number };
type Account = { id: string; code: string; title: string; level: number };
type TreasuryTransaction = { id: string; transactionType: 'receipt' | 'payment'; accountTitle: string; bankOrCash: string; amount: number; description: string; status: string; createdAt: string; isDemo?: boolean };
type SalesLine = { itemTitle: string; quantity: number; unitPrice: number };
type SalesInvoice = { id: string; invoiceNumber: number; customerName: string; subtotal: number; discount: number; tax: number; total: number; status: string; lines: SalesLine[]; isDemo?: boolean };
type PurchaseOrder = { id: string; orderNumber: number; supplierName: string; itemTitle: string; quantity: number; unitPrice: number; total: number; status: string; isDemo?: boolean };
type InventoryItem = { id: string; sku: string; title: string; unit: string; quantity: number; minimumQuantity: number; unitCost: number; isDemo?: boolean };
type Employee = { id: string; personnelCode: string; fullName: string; department: string; jobTitle: string; baseSalary: number; isActive: boolean; isDemo?: boolean };
type PayrollRun = { id: string; title: string; period: string; grossTotal: number; deductionsTotal: number; netTotal: number; status: string; employeeName: string; isDemo?: boolean };
type FixedAsset = { id: string; assetCode: string; title: string; location: string; acquisitionCost: number; usefulLifeMonths: number; accumulatedDepreciation: number; status: string; isDemo?: boolean };
type ProductionOrder = { id: string; orderNumber: number; productTitle: string; plannedQuantity: number; materialTitle: string; materialCost: number; laborCost: number; overheadCost?: number; totalCost: number; status: string; isDemo?: boolean };
type UserRecord = { id: string; username: string; name: string; role: string; isActive: boolean };

type CrmLead = { id: string; name: string; stage: string; value: number; owner: string; isDemo?: boolean };
type CrmTicket = { id: string; title: string; priority: string; status: string; isDemo?: boolean };
type BudgetLine = { id: string; title: string; planned: number; actual: number; isDemo?: boolean };
type ContactMessage = { id: string; name: string; company: string; email: string; message: string; createdAt: string };

const moduleData: Module[] = [
  ['identity', 'هویت و دسترسی', '◉', 'کاربران، نقش‌ها و امنیت سازمان', ['کاربران و گروه‌ها', 'نقش‌ها و مجوزها', 'ورود و نشست‌ها', 'احراز هویت دومرحله‌ای', 'سیاست رمز عبور', 'لاگ امنیتی'], [['کاربران فعال', '۲۴۸', 'کاربر'], ['نقش‌های سازمانی', '۱۸', 'نقش'], ['ورودهای امروز', '۸۶', 'ورود']]],
  ['organization', 'سازمان', '⌂', 'شرکت، شعب، سال مالی و ساختار سازمانی', ['شرکت‌ها و شعب', 'دوره‌های مالی', 'تقویم و تعطیلات', 'مراکز هزینه', 'پروژه‌ها', 'شماره‌گذاری اسناد'], [['شرکت‌های فعال', '۴', 'شرکت'], ['شعبه‌ها', '۱۲', 'شعبه'], ['دوره مالی جاری', '۱۴۰۵', 'سال']]],
  ['workflow', 'گردش کار', '⟳', 'تأییدها، کارتابل و قوانین فرآیند', ['طراحی گردش کار', 'کارتابل من', 'قوانین تأیید', 'سطوح دسترسی', 'اعلان‌ها', 'SLA و مهلت اقدام'], [['کارهای در انتظار', '۲۴', 'کار'], ['گردش‌های فعال', '۳۶', 'فرآیند'], ['تأخیر امروز', '۳', 'مورد']]],
  ['integration', 'یکپارچه‌سازی', '⇄', 'API، وب‌هوک و ارتباط با سامانه‌ها', ['API و کلیدها', 'وب‌هوک‌ها', 'درگاه بانکی', 'سامانه مالیاتی', 'فایل‌های تبادلی', 'صف پردازش و خطاها'], [['اتصال‌های فعال', '۹', 'اتصال'], ['رویدادهای امروز', '۱,۲۸۴', 'رویداد'], ['خطاهای نیازمند بررسی', '۲', 'خطا']]],
  ['accounting', 'مالی و حسابداری', '▣', 'دفتر کل، اسناد و صورت‌های مالی', ['دفتر کل و معین', 'حساب‌های دریافتنی و پرداختنی', 'اسناد حسابداری', 'بستن دوره مالی', 'مراکز هزینه و درآمد', 'پروژه‌ها', 'صورت‌های مالی', 'مالیات و ارزش افزوده', 'مغایرت بانکی'], [['مانده حساب‌ها', '۲,۴۸۰,۰۰۰,۰۰۰', 'ریال'], ['اسناد این دوره', '۱۲۸', 'سند'], ['دریافتنی سررسیدشده', '۱۲۶,۸۰۰,۰۰۰', 'ریال']]],
  ['treasury', 'خزانه‌داری', '◌', 'مدیریت نقدینگی، بانک و تعهدات', ['دریافت و پرداخت', 'چک‌های دریافتی و پرداختی', 'بانک و صندوق', 'حواله‌ها', 'ضمانت‌نامه‌ها', 'مغایرت بانکی', 'پیش‌بینی نقدینگی'], [['موجودی نقد', '۸۴۵,۲۰۰,۰۰۰', 'ریال'], ['چک‌های باز', '۳۶', 'فقره'], ['تراکنش‌های امروز', '۲۴', 'مورد']]],
  ['sales', 'فروش', '↗', 'از پیش‌فاکتور تا وصول مشتری', ['پیش‌فاکتور', 'سفارش فروش', 'رزرو کالا', 'ارسال کالا', 'فاکتور فروش', 'برگشت از فروش', 'تخفیف و مالیات', 'کمیسیون فروش', 'قیمت‌گذاری مشتریان'], [['فروش ماه جاری', '۸۴۵,۲۰۰,۰۰۰', 'ریال'], ['سفارش‌های باز', '۲۴', 'سفارش'], ['نرخ تبدیل', '۶۸', 'درصد']]],
  ['purchasing', 'خرید و تدارکات', '⌁', 'تأمین کالا و خدمات سازمان', ['درخواست خرید', 'استعلام قیمت', 'مقایسه تأمین‌کنندگان', 'سفارش خرید', 'رسید کالا یا خدمت', 'فاکتور خرید', 'برگشت خرید', 'ارزیابی تأمین‌کنندگان'], [['خرید ماه جاری', '۲۱۷,۴۰۰,۰۰۰', 'ریال'], ['درخواست‌های باز', '۱۸', 'درخواست'], ['تأمین‌کننده فعال', '۸۴', 'مورد']]],
  ['inventory', 'انبار و لجستیک', '□', 'کنترل موجودی و رهگیری کالا', ['کالا و خدمات', 'واحدهای اندازه‌گیری', 'انبارها و موقعیت‌ها', 'رسید و حواله', 'انتقال بین انبارها', 'شمارش موجودی', 'سریال و بچ', 'حداقل موجودی', 'قیمت‌گذاری موجودی', 'رهگیری کالا'], [['ارزش موجودی', '۱,۲۸۰,۰۰۰,۰۰۰', 'ریال'], ['قلم کالا', '۴,۸۲۱', 'قلم'], ['هشدار حداقل موجودی', '۱۲', 'قلم']]],
  ['payroll', 'حقوق و دستمزد', '₽', 'کارکرد، محاسبه و پرداخت حقوق', ['اطلاعات پرسنلی', 'قرارداد و حکم', 'کارکرد و حضور و غیاب', 'اضافه‌کاری و مرخصی', 'بیمه و مالیات', 'وام و مساعده', 'فیش حقوقی', 'فایل‌های بانکی و بیمه‌ای'], [['پرسنل مشمول', '۲۴۸', 'نفر'], ['حقوق دوره جاری', '۶۸۰,۰۰۰,۰۰۰', 'ریال'], ['فیش آماده پرداخت', '۲۳۸', 'فیش']]],
  ['hr', 'منابع انسانی', '♙', 'چرخه عمر کارکنان و سازمان', ['جذب و استخدام', 'پرونده کارکنان', 'ارزیابی عملکرد', 'آموزش', 'ساختار سازمانی', 'مدیریت استعداد', 'مرخصی و مأموریت'], [['کارکنان فعال', '۲۴۸', 'نفر'], ['موقعیت‌های استخدامی', '۷', 'مورد'], ['مرخصی در انتظار', '۱۴', 'درخواست']]],
  ['fixed-assets', 'دارایی ثابت', '◇', 'ثبت، استهلاک و کنترل اموال', ['ثبت دارایی', 'محل استقرار', 'انتقال دارایی', 'تعمیرات', 'استهلاک', 'اسقاط', 'تجدید ارزیابی', 'ارتباط با حسابداری'], [['ارزش دفتری', '۳,۸۴۰,۰۰۰,۰۰۰', 'ریال'], ['دارایی ثبت‌شده', '۱,۲۴۰', 'مورد'], ['استهلاک دوره', '۸۴,۰۰۰,۰۰۰', 'ریال']]],
  ['manufacturing', 'تولید', '⚙', 'برنامه‌ریزی، اجرا و کنترل کیفیت', ['ساختار محصول یا BOM', 'فرمول ساخت', 'برنامه‌ریزی تولید', 'سفارش تولید', 'مصرف مواد', 'محصول نهایی', 'ضایعات', 'بهای تمام‌شده', 'کنترل کیفیت'], [['تولید ماه جاری', '۸۶', 'سفارش'], ['درصد تحقق برنامه', '۸۷', 'درصد'], ['کنترل کیفیت باز', '۹', 'مورد']]],
  ['budget', 'بودجه و کنترل مدیریت', '◫', 'بودجه، انحراف و شاخص‌های عملکرد', ['بودجه درآمد و هزینه', 'بودجه پروژه', 'کنترل انحراف', 'سناریوهای مالی', 'گزارش عملکرد واحدها', 'شاخص‌های کلیدی عملکرد'], [['بودجه مصوب', '۱۲,۸۰۰,۰۰۰,۰۰۰', 'ریال'], ['انحراف هزینه', '۴.۸', 'درصد'], ['شاخص‌های فعال', '۱۸', 'شاخص']]],
  ['crm', 'CRM و خدمات مشتریان', '◎', 'سرنخ، مشتری و خدمات پس از فروش', ['سرنخ فروش', 'فرصت فروش', 'تماس‌ها و پیگیری‌ها', 'قراردادها', 'شکایات', 'تیکت و خدمات پس از فروش', 'باشگاه مشتریان'], [['فرصت‌های فعال', '۶۴', 'فرصت'], ['تیکت باز', '۲۱', 'تیکت'], ['رضایت مشتری', '۹۲', 'درصد']]],
  ['reporting', 'گزارش‌گیری و BI', '▥', 'گزارش‌ساز و تحلیل تاریخی سازمان', ['گزارش‌های عملیاتی', 'گزارش‌های مالی', 'داشبورد مدیریتی', 'نمودار جریان نقدی', 'سودآوری مشتری و محصول', 'گزارش‌ساز بدون کدنویسی', 'خروجی Excel و PDF', 'انبار داده و تحلیل تاریخ'], [['گزارش‌های ذخیره‌شده', '۴۸', 'گزارش'], ['داشبوردهای مدیریتی', '۱۲', 'داشبورد'], ['به‌روزرسانی داده', '۱۰:۲۴', 'امروز']]],
].map(([id, label, icon, note, features, kpis]) => ({ id, label, icon, note, features, kpis } as Module));
const modules: Module[] = [{ id: 'overview', label: 'نمای کلی', icon: '◈', note: 'تصویر زنده عملیات سازمان', features: [], kpis: [] }, ...moduleData];
let activeModule = 'overview';
let query = '';
type Session = { username: string; name: string; role: string; roleId?: string; permissions?: string[]; organization: string };
let session: Session | null = JSON.parse(localStorage.getItem('erp-session') ?? 'null') as Session | null;
/** فضای ذخیره‌سازی هر کاربر جدا است تا با تغییر نقش، داده‌ها عوض شود */
/**
 * کلید ذخیره‌سازیِ سه‌بخشی: کاربر / شرکت / نام داده.
 * با این تفکیک، هر شرکت داده‌ی کاملاً مستقلی دارد.
 */
function scopedKey(key: string): string {
  const owner = (session?.username ?? 'public').trim() || 'public';
  const organization = activeOrganizationId.trim() || 'default';
  return `erp-u:${owner}:${organization}:${key}`;
}
function readKey<T>(key: string, fallback: T): T {
  const scoped = scopedKey(key);
  const owner = (session?.username ?? 'public').trim() || 'public';
  // مهاجرت خودکار از نسخه‌های قبل: ابتدا کلیدِ بدون شرکت، سپس کلید عمومی
  const legacyKeys = [`erp-u:${owner}:default:${key}`, `erp-u:${owner}:${key}`, key];
  if (localStorage.getItem(scoped) === null) {
    for (const legacy of legacyKeys) {
      if (localStorage.getItem(legacy) !== null) { localStorage.setItem(scoped, localStorage.getItem(legacy) as string); break; }
    }
  }
  const raw = localStorage.getItem(scoped);
  if (raw === null) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}
/**
 * ذخیره‌ی داده‌ی یک ماژول.
 * مرورگر فقط یک نسخه‌ی موقت (کش) نگه می‌دارد تا صفحه سریع باز شود؛ نسخه‌ی مرجع
 * روی سرور است و هر تغییر بلافاصله به سرور فرستاده می‌شود (PUT /api/workspace).
 */
const store = (key: string, value: unknown): void => {
  localStorage.setItem(scopedKey(key), JSON.stringify(value));
  queueWorkspaceSync(key, value);
  if (!demoMode && !serverSession && session && !offlineWriteWarned) {
    offlineWriteWarned = true;
    showToast('ارتباط با سرور برقرار نیست؛ این تغییر روی سرور ذخیره نمی‌شود. پس از برقراریِ ارتباط دوباره وارد شوید.');
  }
};
let offlineWriteWarned = false;
/** آیا فضای کاری از سرور بارگذاری شده است؟ (پیش از آن هیچ چیزی به سرور فرستاده نمی‌شود) */
let workspaceLoaded = false;
let workspaceUpdatedAt: string | null = null;
let workspacePending: Record<string, unknown> = {};
let workspaceTimer = 0;
let workspaceFlushing = false;
let workspaceFlushAgain = false;
let workspaceSaveWarned = false;
// حالتِ شرکت‌ها باید پیش از نخستین استفاده از readKey تعریف شود
let activeOrganizationId = localStorage.getItem('erp-organization-id') ?? '';
let organizations: OrganizationSummary[] = [];
let savedRecords: SavedRecord[] = readKey<SavedRecord[]>('erp-records', []);

/** داده‌های نمونه برای کاربری که هنوز داده‌ای ندارد */
function applyLocalDefaults(force = false): void {
// در حالتِ سرور، داده‌ی نمونه فقط یک‌بار و آن هم برای شرکتی که هنوز هیچ داده‌ای روی سرور ندارد ساخته می‌شود
if (!demoMode && !force) return;
if (!fixedAssets.length) { fixedAssets = [{ id: 'demo-asset-1', assetCode: 'FA-0001', title: 'دستگاه CNC مدل X', location: 'سالن تولید', acquisitionCost: 3800000000, usefulLifeMonths: 120, accumulatedDepreciation: 380000000, status: 'فعال', isDemo: true }, { id: 'demo-asset-2', assetCode: 'FA-0002', title: 'لپ‌تاپ واحد مالی', location: 'ساختمان اداری', acquisitionCost: 65000000, usefulLifeMonths: 36, accumulatedDepreciation: 18000000, status: 'فعال', isDemo: true }]; store('erp-assets', fixedAssets); }
if (!productionOrders.length) { productionOrders = [{ id: 'demo-production-1', orderNumber: 301, productTitle: 'محصول A-100', plannedQuantity: 86, materialTitle: 'مواد اولیه فولادی', materialCost: 154800000, laborCost: 32000000, totalCost: 186800000, status: 'در برنامه', isDemo: true }, { id: 'demo-production-2', orderNumber: 300, productTitle: 'محصول B-200', plannedQuantity: 42, materialTitle: 'قطعات مونتاژ', materialCost: 84000000, laborCost: 18000000, totalCost: 102000000, status: 'در حال تولید', isDemo: true }]; store('erp-production', productionOrders); }
if (!employees.length) { employees = [{ id: 'demo-employee-1', personnelCode: '1001', fullName: 'مریم احمدی', department: 'مالی', jobTitle: 'حسابدار ارشد', baseSalary: 180000000, isActive: true, isDemo: true }, { id: 'demo-employee-2', personnelCode: '1002', fullName: 'رضا کریمی', department: 'انبار', jobTitle: 'انباردار', baseSalary: 145000000, isActive: true, isDemo: true }, { id: 'demo-employee-3', personnelCode: '1003', fullName: 'سارا نادری', department: 'فروش', jobTitle: 'کارشناس فروش', baseSalary: 165000000, isActive: true, isDemo: true }]; store('erp-employees', employees); }
if (!payrollRuns.length) { payrollRuns = [{ id: 'demo-payroll-run', title: 'فیش حقوق مرداد', period: 'مرداد ۱۴۰۵', grossTotal: 180000000, deductionsTotal: 18000000, netTotal: 162000000, status: 'پیش‌نویس', employeeName: 'مریم احمدی', isDemo: true }]; store('erp-payroll', payrollRuns); }
if (!users.length) { users = [{ id: 'user-admin', username: 'admin', name: 'حسین صادقی', role: 'مدیر سیستم', isActive: true }, { id: 'user-accounting', username: 'accounting', name: 'مریم احمدی', role: 'حسابدار ارشد', isActive: true }, { id: 'user-warehouse', username: 'warehouse', name: 'رضا کریمی', role: 'انباردار', isActive: true }, { id: 'user-sales', username: 'sales', name: 'سارا نادری', role: 'کارشناس فروش', isActive: false }]; store('erp-users', users); }
if (!crmLeads.length) {
  crmLeads = [
    { id: 'demo-lead-1', name: 'شرکت نوآوران', stage: 'سرنخ جدید', value: 120000000, owner: 'سارا نادری', isDemo: true },
    { id: 'demo-lead-2', name: 'پارس تکنولوژی', stage: 'در حال مذاکره', value: 240000000, owner: 'سارا نادری', isDemo: true },
    { id: 'demo-lead-3', name: 'آفتاب گستر', stage: 'قرارداد نهایی', value: 350000000, owner: 'حسین صادقی', isDemo: true },
  ];
  store('erp-crm-leads', crmLeads);
}
if (!crmTickets.length) {
  crmTickets = [
    { id: 'demo-ticket-1', title: 'درخواست نصب نسخه جدید', priority: 'بالا', status: 'در انتظار', isDemo: true },
    { id: 'demo-ticket-2', title: 'پیگیری تأخیر در تحویل', priority: 'متوسط', status: 'در حال بررسی', isDemo: true },
    { id: 'demo-ticket-3', title: 'تمدید قرارداد خدمات', priority: 'پایین', status: 'در انتظار', isDemo: true },
  ];
  store('erp-crm-tickets', crmTickets);
}
if (!budgetLines.length) {
  budgetLines = [
    { id: 'demo-budget-1', title: 'بودجه فروش سالانه', planned: 12000000000, actual: 9800000000, isDemo: true },
    { id: 'demo-budget-2', title: 'بودجه هزینه‌های عملیاتی', planned: 6400000000, actual: 6900000000, isDemo: true },
    { id: 'demo-budget-3', title: 'بودجه سرمایه‌گذاری و توسعه', planned: 5200000000, actual: 4100000000, isDemo: true },
  ];
  store('erp-budget', budgetLines);
}
if (!purchaseOrders.length) { purchaseOrders = [{ id: 'demo-purchase-218', orderNumber: 218, supplierName: 'تأمین‌کننده سپهر', itemTitle: 'مواد اولیه فولادی', quantity: 120, unitPrice: 180000, total: 21600000, status: 'در انتظار', isDemo: true }, { id: 'demo-purchase-217', orderNumber: 217, supplierName: 'شرکت پخش آریا', itemTitle: 'کارتن بسته‌بندی', quantity: 500, unitPrice: 42000, total: 21000000, status: 'تأیید شده', isDemo: true }]; store('erp-purchases', purchaseOrders); }
if (!inventoryItems.length) { inventoryItems = [{ id: 'demo-item-steel', sku: 'MAT-100', title: 'مواد اولیه فولادی', unit: 'کیلوگرم', quantity: 1280, minimumQuantity: 500, unitCost: 180000, isDemo: true }, { id: 'demo-item-box', sku: 'PKG-200', title: 'کارتن بسته‌بندی', unit: 'عدد', quantity: 420, minimumQuantity: 200, unitCost: 42000, isDemo: true }, { id: 'demo-item-a', sku: 'PRD-100', title: 'محصول A-100', unit: 'عدد', quantity: 86, minimumQuantity: 30, unitCost: 850000, isDemo: true }]; store('erp-inventory', inventoryItems); }
if (!salesInvoices.length) { salesInvoices = [{ id: 'demo-invoice-1042', invoiceNumber: 1042, customerName: 'شرکت پارس', subtotal: 84500000, discount: 0, tax: 0, total: 84500000, status: 'تأیید شده', lines: [{ itemTitle: 'محصول A-100', quantity: 10, unitPrice: 8450000 }], isDemo: true }, { id: 'demo-invoice-1043', invoiceNumber: 1043, customerName: 'شرکت نوآوران', subtotal: 120000000, discount: 5000000, tax: 11500000, total: 126500000, status: 'پیش‌نویس', lines: [{ itemTitle: 'خدمات مشاوره سازمانی', quantity: 1, unitPrice: 120000000 }], isDemo: true }]; store('erp-sales', salesInvoices); }
if (!treasuryTransactions.length) { treasuryTransactions = [{ id: 'demo-treasury-receipt', transactionType: 'receipt', accountTitle: 'شرکت آفتاب', bankOrCash: 'بانک ملت · جاری ۱۲۳۴', amount: 45000000, description: 'دریافت بابت فاکتور فروش ۱۰۴۲', status: 'تأیید شده', createdAt: 'امروز، ۰۹:۳۰', isDemo: true }, { id: 'demo-treasury-payment', transactionType: 'payment', accountTitle: 'تأمین‌کننده سپهر', bankOrCash: 'صندوق مرکزی', amount: 21800000, description: 'پرداخت خرید مواد اولیه', status: 'در انتظار', createdAt: 'امروز، ۰۹:۵۰', isDemo: true }]; store('erp-treasury', treasuryTransactions); }
if (!accounts.length) { accounts = [{ id: 'demo-account-1100', code: '1100', title: 'بانک و صندوق', level: 1 }, { id: 'demo-account-1200', code: '1200', title: 'حساب‌های دریافتنی', level: 1 }, { id: 'demo-account-2000', code: '2000', title: 'بدهی‌ها', level: 1 }, { id: 'demo-account-4000', code: '4000', title: 'درآمد فروش', level: 1 }, { id: 'demo-account-5000', code: '5000', title: 'هزینه‌ها', level: 1 }]; store('erp-accounts', accounts); }
if (!journals.length) {
  journals = [
    { id: 'demo-journal-1001', number: 1001, description: 'ثبت فروش نقدی مشتری پارس', status: 'تأیید شده', createdAt: '2026-08-28T08:30:00Z', lines: [{ accountCode: '1100', accountTitle: 'بانک و صندوق', debit: 84500000, credit: 0 }, { accountCode: '4000', accountTitle: 'درآمد فروش', debit: 0, credit: 84500000 }] },
    { id: 'demo-journal-1002', number: 1002, description: 'ثبت هزینه خرید مواد اولیه', status: 'پیش‌نویس', createdAt: '2026-08-28T09:10:00Z', lines: [{ accountCode: '5000', accountTitle: 'هزینه‌ها', debit: 21800000, credit: 0 }, { accountCode: '2000', accountTitle: 'بدهی‌ها', debit: 0, credit: 21800000 }] },
  ];
  store('erp-journals', journals);
}
if (!savedRecords.length) {
  savedRecords = [
    { id: 'demo-journal-1', feature: 'اسناد حسابداری', title: 'سند افتتاحیه فروردین', category: 'مالی و حسابداری', amount: '۳۲۰,۰۰۰,۰۰۰', status: 'تأیید شده', date: 'امروز، ۰۸:۴۰', owner: 'سیستم آموزشی', isDemo: true },
    { id: 'demo-journal-2', feature: 'حساب‌های دریافتنی و پرداختنی', title: 'ثبت بدهی شرکت سپهر', category: 'مالی و حسابداری', amount: '۷۵,۰۰۰,۰۰۰', status: 'در انتظار', date: 'امروز، ۰۹:۱۵', owner: 'حسین صادقی', isDemo: true },
    { id: 'demo-treasury-1', feature: 'دریافت و پرداخت', title: 'دریافت وجه از شرکت آفتاب', category: 'خزانه‌داری', amount: '۴۵,۰۰۰,۰۰۰', status: 'تأیید شده', date: 'امروز، ۰۹:۳۰', owner: 'حسابداری', isDemo: true },
    { id: 'demo-sales-1', feature: 'فاکتور فروش', title: 'فاکتور فروش مشتری پارس', category: 'فروش', amount: '۸۴,۵۰۰,۰۰۰', status: 'در انتظار', date: 'امروز، ۱۰:۲۴', owner: 'فروش', isDemo: true },
    { id: 'demo-purchase-1', feature: 'سفارش خرید', title: 'سفارش مواد اولیه شماره ۲۱۸', category: 'خرید و تدارکات', amount: '۲۱,۸۰۰,۰۰۰', status: 'در انتظار', date: 'امروز، ۰۹:۵۰', owner: 'تدارکات', isDemo: true },
    { id: 'demo-inventory-1', feature: 'رسید و حواله', title: 'رسید ورود کالای انبار مرکزی', category: 'انبار و لجستیک', amount: '۱۲,۳۰۰,۰۰۰', status: 'تأیید شده', date: 'دیروز، ۱۴:۰۵', owner: 'انباردار', isDemo: true },
    { id: 'demo-payroll-1', feature: 'فیش حقوقی', title: 'فیش حقوق مرداد واحد فروش', category: 'حقوق و دستمزد', amount: '۱۸۰,۰۰۰,۰۰۰', status: 'در انتظار', date: 'دیروز، ۱۲:۱۰', owner: 'منابع انسانی', isDemo: true },
    { id: 'demo-hr-1', feature: 'مرخصی و مأموریت', title: 'درخواست مرخصی مریم احمدی', category: 'منابع انسانی', amount: '۰', status: 'در انتظار', date: 'دیروز، ۱۱:۴۵', owner: 'مریم احمدی', isDemo: true },
    { id: 'demo-assets-1', feature: 'ثبت دارایی', title: 'ثبت لپ‌تاپ واحد مالی', category: 'دارایی ثابت', amount: '۶۵,۰۰۰,۰۰۰', status: 'تأیید شده', date: '۲ روز پیش', owner: 'اموال', isDemo: true },
    { id: 'demo-production-1', feature: 'سفارش تولید', title: 'برنامه تولید محصول A-100', category: 'تولید', amount: '۸۶', status: 'در انتظار', date: '۲ روز پیش', owner: 'برنامه‌ریزی تولید', isDemo: true },
    { id: 'demo-crm-1', feature: 'سرنخ فروش', title: 'سرنخ جدید شرکت نوآوران', category: 'CRM و خدمات مشتریان', amount: '۱۲۰,۰۰۰,۰۰۰', status: 'در انتظار', date: '۲ روز پیش', owner: 'فروش', isDemo: true },
  ];
  store('erp-records', savedRecords);
}
}

function getTransactions(): Transaction[] {
  const initial: Transaction[] = [
    { title: 'فاکتور فروش ۱۰۴۲', category: 'فروش', amount: '۸۴,۵۰۰,۰۰۰', status: 'تایید شده', date: 'امروز، ۱۰:۲۴' },
    { title: 'رسید خرید مواد اولیه', category: 'خرید', amount: '۲۱,۸۰۰,۰۰۰', status: 'در انتظار', date: 'امروز، ۰۹:۵۰' },
    { title: 'دریافت از شرکت آفتاب', category: 'خزانه', amount: '۴۵,۰۰۰,۰۰۰', status: 'تطبیق شده', date: 'دیروز، ۱۶:۱۰' },
  ];
  return [...savedRecords, ...initial];
}
let journals: Journal[] = readKey<Journal[]>('erp-journals', []);
let accounts: Account[] = readKey<Account[]>('erp-accounts', []);
let treasuryTransactions: TreasuryTransaction[] = readKey<TreasuryTransaction[]>('erp-treasury', []);
let salesInvoices: SalesInvoice[] = readKey<SalesInvoice[]>('erp-sales', []);
let purchaseOrders: PurchaseOrder[] = readKey<PurchaseOrder[]>('erp-purchases', []);
let inventoryItems: InventoryItem[] = readKey<InventoryItem[]>('erp-inventory', []);
let users: UserRecord[] = readKey<UserRecord[]>('erp-users', []);
let employees: Employee[] = readKey<Employee[]>('erp-employees', []);
let payrollRuns: PayrollRun[] = readKey<PayrollRun[]>('erp-payroll', []);
let fixedAssets: FixedAsset[] = readKey<FixedAsset[]>('erp-assets', []);
let productionOrders: ProductionOrder[] = readKey<ProductionOrder[]>('erp-production', []);






let crmLeads: CrmLead[] = readKey<CrmLead[]>('erp-crm-leads', []);
let crmTickets: CrmTicket[] = readKey<CrmTicket[]>('erp-crm-tickets', []);
let budgetLines: BudgetLine[] = readKey<BudgetLine[]>('erp-budget', []);
let contactMessages: ContactMessage[] = readKey<ContactMessage[]>('erp-contact', []);
let pricingCycle: 'monthly' | 'yearly' = 'monthly';
applyLocalDefaults();

/* --------------------- نسخه‌ی نمایشیِ بدون سرور (GitHub Pages) --------------------- */

/**
 * نسخه‌ای که روی GitHub Pages منتشر می‌شود هیچ سروری ندارد.
 * در این حالت: هیچ درخواستِ شبکه‌ای ارسال نمی‌شود، ورود با حساب‌های معرفی‌شده
 * انجام می‌گیرد و مجموعه‌ای از داده‌های نمونه بارگذاری می‌شود تا بازدیدکننده
 * دقیقاً همان صفحه‌ای را ببیند که مشتریِ شما خواهد دید.
 */

type DemoUser = { username: string; password: string; name: string; roleId: string; role: string; organization: string };

/** حساب‌های نمایشی؛ هر کدام دسترسیِ واقعیِ همان نقش را دارند (تغییرِ نقش واقعاً دیده می‌شود) */
const demoUsers: DemoUser[] = [
  { username: 'admin', password: 'admin123', name: 'حسین صادقی', roleId: 'admin', role: 'مدیر سیستم', organization: 'گروه صنعتی آریا' },
  { username: 'hesabdari', password: '1234', name: 'مریم احمدی', roleId: 'accountant', role: 'حسابدار', organization: 'گروه صنعتی آریا' },
  { username: 'foroosh', password: '1234', name: 'سارا نادری', roleId: 'sales', role: 'کارشناس فروش', organization: 'گروه صنعتی آریا' },
  { username: 'anbar', password: '1234', name: 'رضا کریمی', roleId: 'warehouse', role: 'انباردار', organization: 'گروه صنعتی آریا' },
];

/**
 * دسترسی‌های هر نقش در نسخه‌ی نمایشی؛ دقیقاً برابر با جدولِ نقش‌های سرور
 * (server/auth.ts) است تا رفتارِ نسخه‌ی نمایشی با نسخه‌ی اصلی یکی باشد.
 */
const demoPermissions: Record<string, string[]> = {
  admin: ['events.read', 'events.write', 'accounting.read', 'accounting.write', 'treasury.read', 'treasury.write', 'sales.read', 'sales.write', 'purchasing.read', 'purchasing.write', 'inventory.read', 'inventory.write', 'payroll.read', 'payroll.write', 'identity.manage', 'audit.read'],
  accountant: ['events.read', 'events.write', 'accounting.read', 'accounting.write', 'treasury.read', 'treasury.write', 'sales.read', 'purchasing.read', 'payroll.read'],
  sales: ['events.read', 'events.write', 'sales.read', 'sales.write', 'inventory.read'],
  warehouse: ['events.read', 'events.write', 'inventory.read', 'inventory.write', 'purchasing.read'],
  viewer: ['events.read', 'accounting.read', 'sales.read', 'inventory.read'],
};

/** ورود در نسخه‌ی نمایشی: بدون شبکه، با نقش و دسترسیِ واقعی */
function demoLogin(username: string, password: string): Session | null {
  const account = demoUsers.find((item) => item.username === username && item.password === password);
  if (!account) return null;
  const permissions = demoPermissions[account.roleId] ?? roleCatalog.find((role) => role.id === account.roleId)?.permissions ?? [];
  return { username: account.username, name: account.name, role: account.role, roleId: account.roleId, permissions, organization: account.organization };
}

/** تاریخِ شمسیِ روز (به علاوه یا منهای چند روز) برای داده‌های نمونه */
function jalaliDay(offsetDays: number): { display: string; sortable: string } {
  const parts = new Intl.DateTimeFormat('en-u-ca-persian', { year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(Date.now() + offsetDays * 86_400_000));
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? '01';
  const sortable = `${value('year')}-${value('month')}-${value('day')}`;
  return { display: sortable.replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]), sortable };
}

/** محاسبه‌ی خلاصه‌ی چک‌ها از روی داده‌ی موجود (در حالتِ بدون سرور) */
function computeChecksSummary(): ChecksSummary {
  const empty = (): { count: number; amount: number } => ({ count: 0, amount: 0 });
  const summary: ChecksSummary = { receivable: empty(), payable: empty(), bounced: empty(), dueSoon: empty() };
  const weekAhead = jalaliDay(7).sortable;
  checks.forEach((check) => {
    const bucket = check.direction === 'پرداختنی' ? summary.payable : summary.receivable;
    bucket.count += 1;
    bucket.amount += check.amount;
    if (check.status === 'برگشتی') { summary.bounced.count += 1; summary.bounced.amount += check.amount; }
    if (check.status === 'در جریان وصول' && check.dueDate <= weekAhead) { summary.dueSoon.count += 1; summary.dueSoon.amount += check.amount; }
  });
  return summary;
}

/**
 * مجموعه داده‌ی نمونه برای نسخه‌ی نمایشی - فقط یک بار برای هر کاربر ساخته می‌شود.
 * رکوردها با isDemo علامت‌گذاری شده‌اند تا بعداً با داده‌ی واقعی اشتباه گرفته نشوند.
 */
function seedDemoData(): void {
  if (!demoMode || localStorage.getItem(scopedKey('erp-demo-seeded'))) return;
  const template = BUSINESS_TEMPLATES.find((item) => item.id === 'manufacturing') ?? BUSINESS_TEMPLATES[0];

  if (!accounts.length) {
    accounts = template.accounts.map((account, index) => ({ id: `demo-account-${index + 1}`, code: account.code, title: account.title, level: 1 }));
    store('erp-accounts', accounts);
  }
  if (!inventoryItems.length) {
    inventoryItems = [
      { id: 'demo-item-1', sku: 'SKU-1001', title: 'ورق فولادی ۲ میل', unit: 'کیلوگرم', quantity: 4250, minimumQuantity: 800, unitCost: 480000, isDemo: true },
      { id: 'demo-item-2', sku: 'SKU-1002', title: 'پروفیل آلومینیوم', unit: 'متر', quantity: 1240, minimumQuantity: 300, unitCost: 320000, isDemo: true },
      { id: 'demo-item-3', sku: 'SKU-2001', title: 'پیچ و مهره صنعتی', unit: 'عدد', quantity: 8650, minimumQuantity: 2000, unitCost: 12500, isDemo: true },
      { id: 'demo-item-4', sku: 'SKU-2002', title: 'بلبرینگ ۶۲۰۴', unit: 'عدد', quantity: 280, minimumQuantity: 120, unitCost: 185000, isDemo: true },
      { id: 'demo-item-5', sku: 'SKU-3001', title: 'رنگ صنعتی اپوکسی', unit: 'کیلوگرم', quantity: 180, minimumQuantity: 60, unitCost: 720000, isDemo: true },
      { id: 'demo-item-6', sku: 'SKU-4001', title: 'محصول نهایی A-100', unit: 'دستگاه', quantity: 86, minimumQuantity: 20, unitCost: 6800000, isDemo: true },
    ];
    store('erp-inventory', inventoryItems);
  }
  if (!salesInvoices.length) {
    salesInvoices = [
      { id: 'demo-sale-1', invoiceNumber: 1047, customerName: 'شرکت آفتاب گستر', subtotal: 1000000000, discount: 20000000, tax: 88200000, total: 1068200000, status: 'تأیید شده', lines: [{ itemTitle: 'محصول نهایی A-100', quantity: 100, unitPrice: 10000000 }], isDemo: true },
      { id: 'demo-sale-2', invoiceNumber: 1046, customerName: 'بازرگانی البرز', subtotal: 640000000, discount: 0, tax: 57600000, total: 697600000, status: 'تأیید شده', lines: [{ itemTitle: 'ورق فولادی ۲ میل', quantity: 1450, unitPrice: 440000 }], isDemo: true },
      { id: 'demo-sale-3', invoiceNumber: 1045, customerName: 'گروه صنعتی پارس', subtotal: 312000000, discount: 12000000, tax: 27000000, total: 327000000, status: 'پیش‌نویس', lines: [{ itemTitle: 'پروفیل آلومینیوم', quantity: 1000, unitPrice: 312000 }], isDemo: true },
      { id: 'demo-sale-4', invoiceNumber: 1044, customerName: 'فروشگاه تهران', subtotal: 185000000, discount: 0, tax: 16650000, total: 201650000, status: 'تأیید شده', lines: [{ itemTitle: 'بلبرینگ ۶۲۰۴', quantity: 1000, unitPrice: 185000 }], isDemo: true },
      { id: 'demo-sale-5', invoiceNumber: 1043, customerName: 'کارخانه سپهر', subtotal: 96000000, discount: 4000000, tax: 8280000, total: 100280000, status: 'پیش‌نویس', lines: [{ itemTitle: 'رنگ صنعتی اپوکسی', quantity: 130, unitPrice: 738000 }], isDemo: true },
    ];
    store('erp-sales', salesInvoices);
  }
  if (!purchaseOrders.length) {
    purchaseOrders = [
      { id: 'demo-purchase-1', orderNumber: 504, supplierName: 'تأمین‌کننده فولاد', itemTitle: 'ورق فولادی ۲ میل', quantity: 3000, unitPrice: 445000, total: 1335000000, status: 'در انتظار', isDemo: true },
      { id: 'demo-purchase-2', orderNumber: 503, supplierName: 'صنعت قطعه', itemTitle: 'بلبرینگ ۶۲۰۴', quantity: 900, unitPrice: 178000, total: 160200000, status: 'تأیید شده', isDemo: true },
      { id: 'demo-purchase-3', orderNumber: 502, supplierName: 'شرکت رنگین', itemTitle: 'رنگ صنعتی اپوکسی', quantity: 220, unitPrice: 690000, total: 151800000, status: 'در انتظار', isDemo: true },
      { id: 'demo-purchase-4', orderNumber: 501, supplierName: 'بازرگانی سپهر', itemTitle: 'پروفیل آلومینیوم', quantity: 1500, unitPrice: 295000, total: 442500000, status: 'تأیید شده', isDemo: true },
    ];
    store('erp-purchases', purchaseOrders);
  }
  if (!treasuryTransactions.length) {
    treasuryTransactions = [
      { id: 'demo-treasury-1', transactionType: 'receipt', accountTitle: 'شرکت آفتاب گستر', bankOrCash: 'بانک ملت', amount: 1068200000, description: 'وصول فاکتور ۱۰۴۷', status: 'تطبیق شده', createdAt: jalaliDay(-2).sortable, isDemo: true },
      { id: 'demo-treasury-2', transactionType: 'payment', accountTitle: 'تأمین‌کننده فولاد', bankOrCash: 'بانک صادرات', amount: 640000000, description: 'پرداخت بابت خرید مواد اولیه', status: 'تطبیق شده', createdAt: jalaliDay(-5).sortable, isDemo: true },
      { id: 'demo-treasury-3', transactionType: 'payment', accountTitle: 'اداره دارایی', bankOrCash: 'بانک ملی', amount: 88200000, description: 'پرداخت مالیات بر ارزش افزوده', status: 'در انتظار', createdAt: jalaliDay(-1).sortable, isDemo: true },
      { id: 'demo-treasury-4', transactionType: 'receipt', accountTitle: 'فروشگاه تهران', bankOrCash: 'صندوق', amount: 201650000, description: 'دریافت نقدی فاکتور ۱۰۴۴', status: 'تطبیق شده', createdAt: jalaliDay(-3).sortable, isDemo: true },
      { id: 'demo-treasury-5', transactionType: 'payment', accountTitle: 'شرکت برق منطقه‌ای', bankOrCash: 'بانک ملت', amount: 74000000, description: 'هزینه انرژی کارگاه', status: 'در انتظار', createdAt: jalaliDay(0).sortable, isDemo: true },
      { id: 'demo-treasury-6', transactionType: 'receipt', accountTitle: 'گروه صنعتی پارس', bankOrCash: 'بانک ملت', amount: 327000000, description: 'پیش‌دریافت فاکتور ۱۰۴۵', status: 'در انتظار', createdAt: jalaliDay(1).sortable, isDemo: true },
    ];
    store('erp-treasury', treasuryTransactions);
  }
  if (!journals.length) {
    journals = [
      { id: 'demo-journal-1', number: 1001, description: 'فروش محصول به شرکت آفتاب گستر', lines: [{ accountCode: '1102', accountTitle: 'بانک - جاری تولید', debit: 1068200000, credit: 0 }, { accountCode: '4101', accountTitle: 'فروش محصولات', debit: 0, credit: 1000000000 }, { accountCode: '2102', accountTitle: 'مالیات بر ارزش افزوده‌ی پرداختنی', debit: 0, credit: 88200000 }], status: 'ثبت‌شده', createdAt: jalaliDay(-2).sortable },
      { id: 'demo-journal-2', number: 1002, description: 'خرید مواد اولیه از تأمین‌کننده فولاد', lines: [{ accountCode: '1201', accountTitle: 'مواد اولیه', debit: 640000000, credit: 0 }, { accountCode: '2102', accountTitle: 'مالیات بر ارزش افزوده‌ی پرداختنی', debit: 57600000, credit: 0 }, { accountCode: '2101', accountTitle: 'تأمین‌کنندگان مواد', debit: 0, credit: 697600000 }], status: 'ثبت‌شده', createdAt: jalaliDay(-5).sortable },
      { id: 'demo-journal-3', number: 1003, description: 'حقوق و دستمزد مرداد ماه', lines: [{ accountCode: '5102', accountTitle: 'دستمزد مستقیم تولید', debit: 180000000, credit: 0 }, { accountCode: '6101', accountTitle: 'هزینه‌های اداری', debit: 95000000, credit: 0 }, { accountCode: '1102', accountTitle: 'بانک - جاری تولید', debit: 0, credit: 275000000 }], status: 'ثبت‌شده', createdAt: jalaliDay(-4).sortable },
      { id: 'demo-journal-4', number: 1004, description: 'مصرف مواد در خط تولید', lines: [{ accountCode: '1202', accountTitle: 'کالای در جریان ساخت', debit: 520000000, credit: 0 }, { accountCode: '1201', accountTitle: 'مواد اولیه', debit: 0, credit: 520000000 }], status: 'ثبت‌شده', createdAt: jalaliDay(-1).sortable },
      { id: 'demo-journal-5', number: 1005, description: 'استهلاک ماهانه ماشین‌آلات', lines: [{ accountCode: '6102', accountTitle: 'استلاک ماشین‌آلات', debit: 38000000, credit: 0 }, { accountCode: '1402', accountTitle: 'استاندارد انباشته‌ی ماشین‌آلات', debit: 0, credit: 38000000 }], status: 'پیش‌نویس', createdAt: jalaliDay(0).sortable },
    ];
    store('erp-journals', journals);
  }
  if (!checks.length) {
    checks = [
      { id: 'demo-check-1', number: '1002', serial: '۲۲/۱۴۰۵', bank: 'صادرات', amount: 95000000, issueDate: jalaliDay(-20).display, dueDate: jalaliDay(4).display, direction: 'دریافتنی', party: 'فروشگاه تهران', status: 'در جریان وصول', description: 'بابت فروش خرده' },
      { id: 'demo-check-2', number: '1003', serial: '۲۳/۱۴۰۵', bank: 'ملت', amount: 327000000, issueDate: jalaliDay(-12).display, dueDate: jalaliDay(21).display, direction: 'دریافتنی', party: 'گروه صنعتی پارس', status: 'در جریان وصول', description: 'بابت فاکتور ۱۰۴۵' },
      { id: 'demo-check-3', number: '2001', serial: '۳۳/۱۴۰۵', bank: 'ملت', amount: 145000000, issueDate: jalaliDay(-15).display, dueDate: jalaliDay(38).display, direction: 'پرداختنی', party: 'تأمین‌کننده فولاد', status: 'در جریان وصول', description: 'بابت خرید مواد' },
      { id: 'demo-check-4', number: '2002', serial: '۳۴/۱۴۰۵', bank: 'تجارت', amount: 74000000, issueDate: jalaliDay(-9).display, dueDate: jalaliDay(2).display, direction: 'پرداختنی', party: 'شرکت برق منطقه‌ای', status: 'پرداخت شده', description: 'هزینه انرژی' },
      { id: 'demo-check-5', number: '1001', serial: '۲۱/۱۴۰۵', bank: 'پاسارگاد', amount: 62000000, issueDate: jalaliDay(-40).display, dueDate: jalaliDay(-12).display, direction: 'دریافتنی', party: 'بازرگانی البرز', status: 'برگشتی', description: 'چک برگشتی - نیازمند پیگیری' },
    ];
    checksSummary = computeChecksSummary();
  }
  if (!savedRecords.length) {
    savedRecords = [
      { id: 'demo-record-1', feature: 'فروش', title: 'فاکتور فروش ۱۰۴۵ - گروه صنعتی پارس', category: 'فروش', amount: '۳۲۷,۰۰۰,۰۰۰', status: 'در انتظار', date: 'امروز، ۰۹:۱۰', owner: 'سارا نادری', isDemo: true },
      { id: 'demo-record-2', feature: 'خرید', title: 'رسید خرید مواد اولیه - تأمین‌کننده فولاد', category: 'خرید', amount: '۱,۳۳۵,۰۰۰,۰۰۰', status: 'در انتظار', date: 'دیروز، ۱۶:۴۰', owner: 'رضا کریمی', isDemo: true },
      { id: 'demo-record-3', feature: 'خزانه', title: 'پرداخت مالیات بر ارزش افزوده', category: 'خزانه', amount: '۸۸,۲۰۰,۰۰۰', status: 'در انتظار', date: 'دیروز، ۱۱:۰۵', owner: 'مریم احمدی', isDemo: true },
    ];
    store('erp-records', savedRecords);
  }
  localStorage.setItem(scopedKey('erp-demo-seeded'), new Date().toISOString());
}

/* ===================== پشتیبانی از PWA (بدون دکمهٔ نصب در رابط) ===================== */

/**
 * کارگر سرویس را برای اجرای مستقل و باز شدن صفحات کش‌شده ثبت می‌کند.
 * هیچ prompt، بنر یا دکمهٔ نصب اختصاصی در رابط نمایش داده نمی‌شود؛
 * مرورگر، گزینهٔ نصب را در رابط استاندارد خودش ارائه می‌کند.
 */
function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (!window.isSecureContext && location.hostname !== 'localhost') return;

  const register = (): void => {
    navigator.serviceWorker
      .register('./sw.js', { updateViaCache: 'none' })
      .then(async (registration) => {
        await registration.update().catch(() => undefined);
        if (registration.waiting) registration.waiting.postMessage('skip-waiting');
      })
      .catch(() => undefined);
  };

  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

/** ظاهر شدنِ تدریجی و ملایمِ بخش‌ها هنگامِ اسکرول (صفحه‌ی اصلی) */
function setupScrollReveal(): void {
  const targets = document.querySelectorAll<HTMLElement>('.reveal');
  if (!targets.length) return;
  if (typeof IntersectionObserver === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    targets.forEach((item) => item.classList.add('in-view'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('in-view');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  targets.forEach((item) => observer.observe(item));
}

/** توضیحِ نسخه‌ی نمایشی برای بازدیدکننده */
function openDemoNotice(): void {
  openModal('demo-modal', 'demo-form', `<h2>نسخه‌ی نمایشیِ آنلاین</h2>
    <p class="modal-hint">این نسخه برای آشنایی با برنامه است و هیچ سروری ندارد؛ همه‌ی داده‌ها فقط در مرورگرِ شما نگه داشته می‌شوند و با پاک‌کردنِ حافظه‌ی مرورگر حذف خواهند شد.</p>
    <div class="status-table">
      <div class="status-row"><span>ذخیره‌سازی</span><strong>مرورگر شما (بدون سرور)</strong></div>
      <div class="status-row"><span>مدیر سیستم</span><strong>admin / admin123</strong></div>
      <div class="status-row"><span>حسابدار</span><strong>hesabdari / 1234</strong></div>
      <div class="status-row"><span>فروش</span><strong>foroosh / 1234</strong></div>
      <div class="status-row"><span>انباردار</span><strong>anbar / 1234</strong></div>
      <div class="status-row"><span>نسخه‌ی واقعی</span><strong>نصب روی ویندوز یا داکر (داده روی دستگاه شما)</strong></div>
    </div>
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="demo-modal">بستن</button></div>`);
}







/**
 * نگاشتِ ماژول‌ها به مجوز مورد نیاز.
 * هر ماژولی که کاربر مجوزش را نداشته باشد، در منو، داشبورد و بدنه‌ی برنامه
 * به‌طور کامل پنهان می‌شود (نه اینکه پیام «دسترسی ندارید» نمایش داده شود).
 */
const modulePermissions: Record<string, string> = {
  identity: 'identity.manage',
  organization: 'identity.manage',
  integration: 'identity.manage',
  workflow: 'events.read',
  accounting: 'accounting.read',
  treasury: 'treasury.read',
  sales: 'sales.read',
  purchasing: 'purchasing.read',
  inventory: 'inventory.read',
  payroll: 'payroll.read',
  hr: 'payroll.read',
  'fixed-assets': 'accounting.read',
  manufacturing: 'inventory.write',
  budget: 'accounting.read',
  crm: 'sales.read',
  reporting: 'accounting.read',
};

/** آیا کاربر جاری به این ماژول دسترسی دارد؟ */
function canAccess(moduleId: string): boolean {
  const permission = modulePermissions[moduleId];
  if (!permission) return true; // ماژول‌های عمومی مانند «نمای کلی»
  const permissions = session?.permissions ?? [];
  if (!permissions.length) return true; // حالت آفلاین یا نشست بدون نقش
  return permissions.includes(permission);
}

/** فهرست ماژول‌های قابل مشاهده برای کاربر جاری */
function visibleModules(): Module[] {
  const list = modules.filter((item) => canAccess(item.id));
  return list.length ? list : modules.slice(0, 1);
}

const money = (value: number): string => value.toLocaleString('fa-IR');
const moduleIdByLabel = new Map(modules.map((item) => [item.label, item.id]));
const moduleLabelById = new Map(modules.map((item) => [item.id, item.label]));







const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character] ?? character);
const currentModule = () => visibleModules().find((item) => item.id === activeModule) ?? visibleModules()[0];

/* ------------------------------- چندشرکتی ------------------------------- */

type OrganizationSummary = {
  id: string; name: string; code: string; currency: string; fiscalYearStartMonth: number;
  role: string; roleTitle: string; isDefault: boolean; isActive?: boolean;
  nationalId?: string; economicCode?: string; address?: string;
  stats?: { journals: number; documents: number; events: number; checks: number; payrollRecords: number; serials: number; boms: number };
};

const activeOrganization = (): OrganizationSummary | undefined =>
  organizations.find((item) => item.id === activeOrganizationId);

/** نام شرکتی که در نوار کناری نمایش داده می‌شود */
const activeOrganizationName = (): string => activeOrganization()?.name ?? (session?.organization ?? 'شرکت پیش‌فرض');

/** بارگذاری فهرست شرکت‌های کاربر */
async function loadOrganizations(): Promise<void> {
  if (!serverSession) return;
  const response = await apiFetch('/api/organizations');
  if (!response?.ok) return;
  const payload = (await response.json().catch(() => null)) as { data?: OrganizationSummary[]; activeId?: string } | null;
  organizations = (payload?.data ?? []).filter((item) => item.isActive !== false);
  if (!organizations.some((item) => item.id === activeOrganizationId)) {
    activeOrganizationId = payload?.activeId ?? organizations[0]?.id ?? '';
    localStorage.setItem('erp-organization-id', activeOrganizationId);
  }
}

/** تغییر شرکت فعال؛ داده‌ها به‌طور کامل از نو بارگذاری می‌شوند */
async function switchOrganization(id: string): Promise<void> {
  const target = organizations.find((item) => item.id === id);
  if (!target || id === activeOrganizationId) { closeModal('organization-modal'); return; }
  const response = await apiFetch('/api/organizations/default', { method: 'POST', body: JSON.stringify({ organizationId: id }) });
  if (!response?.ok) { showToast('تغییر شرکت انجام نشد؛ دوباره تلاش کنید.'); return; }
  activeOrganizationId = id;
  localStorage.setItem('erp-organization-id', id);
  closeModal('organization-modal');
  showToast(`در حال رفتن به «${target.name}»…`);
  // برای اطمینان از تفکیک کامل داده‌ها، همه‌چیز از نو بارگذاری می‌شود
  setTimeout(() => window.location.reload(), 700);
}

/**
 * پس از برقراریِ نشست: شرکت‌ها و داده‌های سرور بارگذاری و صفحه بازسازی می‌شود.
 * این تابع جایگزینِ فراخوانِ شبکه درونِ render شده است.
 */
async function afterSessionEstablished(): Promise<void> {
  await loadOrganizations();
  await loadWorkspace().catch(() => false);
  await loadServerData().catch(() => false);
  if (session) render();
}

/* ------------------------- فضای کاری روی سرور ------------------------- */

/** کلیدهایی که نسخه‌ی مرجعشان روی سرور نگه داشته می‌شود */
const WORKSPACE_KEYS = ['erp-records', 'erp-journals', 'erp-accounts', 'erp-treasury', 'erp-sales', 'erp-purchases', 'erp-inventory', 'erp-users', 'erp-employees', 'erp-payroll', 'erp-assets', 'erp-production', 'erp-crm-leads', 'erp-crm-tickets', 'erp-budget', 'erp-contact', 'erp-credit-limits'] as const;

/**
 * بارگذاریِ فضای کاریِ شرکت از سرور. نسخه‌ی سرور همیشه مرجع است و جای کشِ مرورگر
 * را می‌گیرد. اگر شرکت هنوز هیچ داده‌ای روی سرور ندارد (نخستین اجرا)، داده‌ی نمونه
 * ساخته و همان لحظه روی سرور ذخیره می‌شود تا در همه‌ی مرورگرها یکسان باشد.
 */
async function loadWorkspace(): Promise<boolean> {
  if (demoMode || !serverSession) return false;
  const result = await apiFetch('/api/workspace');
  if (!result?.ok) return false;
  const payload = (await result.json().catch(() => null)) as { entries?: Record<string, unknown>; updatedAt?: string | null } | null;
  if (!payload || typeof payload.entries !== 'object') return false;
  const entries = payload.entries ?? {};
  const serverHasData = Object.keys(entries).length > 0;
  if (serverHasData) {
    // نسخه‌ی سرور مرجع است و جای کشِ مرورگر را می‌گیرد
    for (const key of WORKSPACE_KEYS) {
      if (key in entries) localStorage.setItem(scopedKey(key), JSON.stringify(entries[key]));
      else localStorage.removeItem(scopedKey(key));
    }
  }
  workspaceUpdatedAt = payload.updatedAt ?? null;
  hydrateLocalState();
  workspaceLoaded = true;
  if (!serverHasData) {
    /**
     * نخستین اتصالِ این شرکت: هرچه از قبل در مرورگر بوده (داده‌های نسخه‌های پیشین)
     * به سرور منتقل می‌شود و اگر چیزی نبود، داده‌ی نمونه یک‌بار ساخته می‌شود.
     */
    applyLocalDefaults(true);
    for (const key of WORKSPACE_KEYS) {
      const raw = localStorage.getItem(scopedKey(key));
      if (raw !== null) { try { workspacePending[key] = JSON.parse(raw); } catch { /* نادیده */ } }
    }
    await flushWorkspace();
  }
  return true;
}

/** صف‌بندیِ ذخیره روی سرور (چند تغییرِ پشت‌سرهم در یک درخواست فرستاده می‌شود) */
function queueWorkspaceSync(key: string, value: unknown): void {
  if (demoMode || !serverSession || !workspaceLoaded) return;
  if (!(WORKSPACE_KEYS as readonly string[]).includes(key)) return;
  workspacePending[key] = value;
  window.clearTimeout(workspaceTimer);
  workspaceTimer = window.setTimeout(() => void flushWorkspace(), 400);
}

/** ارسالِ تغییراتِ معوق به سرور؛ اگر ناموفق بود، در دورِ بعد دوباره تلاش می‌شود */
async function flushWorkspace(): Promise<boolean> {
  if (demoMode || !serverSession) return false;
  if (workspaceFlushing) { workspaceFlushAgain = true; return false; }
  const entries = workspacePending;
  if (!Object.keys(entries).length) return true;
  workspacePending = {};
  workspaceFlushing = true;
  try {
    const result = await apiFetch('/api/workspace', { method: 'PUT', body: JSON.stringify({ entries }) });
    if (!result?.ok) {
      // برگرداندنِ تغییرات به صف تا از دست نروند
      workspacePending = { ...entries, ...workspacePending };
      if (result && result.status !== 401 && !workspaceSaveWarned) {
        workspaceSaveWarned = true;
        const body = (await result.json().catch(() => null)) as { error?: string } | null;
        showToast(body?.error ?? 'ذخیره روی سرور انجام نشد؛ دوباره تلاش می‌شود.');
      }
      window.clearTimeout(workspaceTimer);
      workspaceTimer = window.setTimeout(() => void flushWorkspace(), 5000);
      return false;
    }
    workspaceSaveWarned = false;
    const body = (await result.json().catch(() => null)) as { updatedAt?: string } | null;
    if (body?.updatedAt) workspaceUpdatedAt = body.updatedAt;
    return true;
  } catch {
    workspacePending = { ...entries, ...workspacePending };
    window.clearTimeout(workspaceTimer);
    workspaceTimer = window.setTimeout(() => void flushWorkspace(), 5000);
    return false;
  } finally {
    workspaceFlushing = false;
    if (workspaceFlushAgain) { workspaceFlushAgain = false; void flushWorkspace(); }
  }
}

function openOrganizationsModal(): void {
  const rows = organizations.map((item) => `<button type="button" class="organization-row ${item.id === activeOrganizationId ? 'active' : ''}" data-organization="${item.id}">
      <span class="organization-avatar">${escapeHtml(item.name.trim().charAt(0) || 'ش')}</span>
      <span class="organization-meta"><strong>${escapeHtml(item.name)}</strong>
        <small>${escapeHtml(item.code)} · ${escapeHtml(item.roleTitle)} · ${item.stats ? `${money(item.stats.journals)} سند` : 'بدون سند'}</small></span>
      <span class="organization-state">${item.id === activeOrganizationId ? 'فعال' : 'انتخاب'}</span>
    </button>`).join('');
  openModal('organization-modal', 'organization-form', `<h3>شرکت‌ها و کسب‌وکارها</h3>
    <p class="muted">هر شرکت داده‌ی مالی، اسناد، شماره‌گذاری و کاربرانِ کاملاً مستقلِ خود را دارد.</p>
    <div class="organization-list">${rows || '<p class="muted">شرکتی ثبت نشده است.</p>'}</div>
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="organization-modal">بستن</button><button type="button" class="primary-button" id="organization-create">＋ شرکت جدید</button></div>`);
  document.querySelectorAll<HTMLButtonElement>('[data-organization]').forEach((button) =>
    button.addEventListener('click', () => void switchOrganization(button.dataset.organization ?? '')));
  document.querySelector<HTMLButtonElement>('#organization-create')?.addEventListener('click', () => { closeModal('organization-modal'); openOrganizationCreateModal(); });
}

function openOrganizationCreateModal(): void {
  openModal('organization-create-modal', 'organization-create-form', `<h3>شرکت یا کسب‌وکار جدید</h3>
    <p class="muted">اطلاعات پایه را وارد کنید؛ سال مالی، سرفصل‌های حسابداری و کاربران را در ادامه‌ی راهنما می‌سازید.</p>
    <label class="field"><span>نام شرکت <i>*</i></span><input name="name" required placeholder="مثال: فروشگاه البرز" /></label>
    <div class="field-row">
      <label class="field"><span>کد اختصاری <i>*</i></span><input name="code" required maxlength="8" placeholder="ALB" /></label>
      <label class="field"><span>واحد پول</span><input name="currency" value="ریال" /></label>
    </div>
    <div class="field-row">
      <label class="field"><span>شناسه ملی</span><input name="nationalId" inputmode="numeric" /></label>
      <label class="field"><span>کد اقتصادی</span><input name="economicCode" inputmode="numeric" /></label>
    </div>
    <div class="field-row">
      <label class="field"><span>تلفن</span><input name="phone" /></label>
      <label class="field"><span>ماه آغاز سال مالی</span><select name="fiscalYearStartMonth">${Array.from({ length: 12 }, (_, index) => `<option value="${index + 1}">${money(index + 1)}</option>`).join('')}</select></label>
    </div>
    <label class="field"><span>آدرس</span><textarea name="address" rows="2"></textarea></label>
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="organization-create-modal">انصراف</button><button type="submit" class="primary-button">ایجاد و ادامه</button></div>`);
  document.querySelector<HTMLFormElement>('#organization-create-form')?.addEventListener('submit', (event) => void createOrganization(event));
}

async function createOrganization(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const data = new FormData(event.currentTarget as HTMLFormElement);
  const name = String(data.get('name') ?? '').trim();
  const code = String(data.get('code') ?? '').trim().toUpperCase();
  if (!name || !code) { showToast('نام شرکت و کد اختصاری الزامی است.'); return; }
  const payload = {
    name, code, currency: String(data.get('currency') ?? 'ریال').trim() || 'ریال',
    nationalId: String(data.get('nationalId') ?? '').trim(), economicCode: String(data.get('economicCode') ?? '').trim(),
    phone: String(data.get('phone') ?? '').trim(), address: String(data.get('address') ?? '').trim(),
    fiscalYearStartMonth: Number(data.get('fiscalYearStartMonth') ?? 1) || 1,
  };
  const response = await apiFetch('/api/organizations', { method: 'POST', body: JSON.stringify(payload) });
  if (!response?.ok) {
    const body = (await response?.json().catch(() => null)) as { error?: string } | null;
    showToast(body?.error ?? 'ایجاد شرکت ناموفق بود.'); return;
  }
  const created = (await response.json().catch(() => null)) as OrganizationSummary | null;
  if (created) { organizations = [...organizations, created]; }
  closeModal('organization-create-modal');
  showToast(`شرکت «${name}» ایجاد شد.`);
  if (created) { await switchOrganizationForOnboarding(created); }
}

/**
 * شمارنده‌ی بازسازی برای جلوگیری از قفل شدنِ برنامه.
 * اگر به هر دلیلی (داده‌ی خراب، حلقه‌ای ناخواسته در یک ماژول و …) بازسازیِ صفحه
 * در یک حلقه‌ی تنگ بیفتد، مرورگر هنگ می‌کند و هیچ کاری نمی‌شود کرد. این محافظ
 * جلوی حلقه را می‌گیرد و یک پیامِ آرام نشان می‌دهد.
 */
const renderGuard = { stamps: [] as number[], pausedUntil: 0, warned: false };
function renderAllowed(): boolean {
  const now = Date.now();
  if (now < renderGuard.pausedUntil) return false;
  renderGuard.stamps = renderGuard.stamps.filter((stamp) => now - stamp < 2000);
  renderGuard.stamps.push(now);
  // آستانه بالا است تا کارِ عادی هرگز محدود نشود؛ فقط حلقه‌ی واقعی متوقف می‌شود
  if (renderGuard.stamps.length > 60) {
    renderGuard.pausedUntil = now + 1200;
    renderGuard.stamps = [];
    if (!renderGuard.warned) {
      renderGuard.warned = true;
      showToast('برای جلوگیری از کندی، بازسازیِ خودکارِ صفحه چند لحظه متوقف شد. کار شما ادامه دارد.');
    }
    return false;
  }
  return true;
}

/** ویترینِ هر ماژول جداگانه ساخته می‌شود تا خطای یک ماژول کل برنامه را از کار نیندازد */
function safeModuleMarkup(module: { id: string; label: string }): string {
  try {
    return moduleMarkup(module as Parameters<typeof moduleMarkup>[0]);
  } catch (error) {
    console.error('render module failed', module.id, error);
    return `<section class="panel"><div class="panel-heading"><div><h2>نمایشِ این بخش با خطا روبه‌رو شد</h2><p>کارِ شما در بخش‌های دیگر ادامه دارد؛ داده‌ها سالم‌اند.</p></div></div><p class="muted">${escapeHtml(String(error instanceof Error ? error.message : error).slice(0, 160))}</p></section>`;
  }
}

/**
 * اگر خطای پیش‌بینی‌نشده‌ای رخ دهد، برنامه قفل نمی‌ماند و کاربر راهِ بازگشت دارد.
 */
window.addEventListener('error', (event: ErrorEvent) => { console.error('app error', event.message); });
window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => { console.error('promise rejected', event.reason); });

/** پس از خروج یا پایانِ نشست، بازسازی‌های بعدی باید صفحه‌ی ورود را نشان دهند نه صفحه‌ی معرفی */
let preferLoginScreen = false;
/**
 * مسیر ورود علاوه بر hash، یک query مستقل دارد تا خودِ لینک بتواند یک navigation کامل
 * انجام دهد. به این شکل اگر مرورگر رویداد hashchange را در صفحهٔ کش‌شده اجرا نکند،
 * دکمهٔ ورودِ راهنما همچنان قطعاً صفحهٔ ورود را باز می‌کند.
 */
function isLoginRoute(): boolean {
  return window.location.hash === '#login' || new URLSearchParams(window.location.search).get('login') === '1';
}

function loginRouteHref(): string {
  const params = new URLSearchParams(window.location.search);
  params.set('login', '1');
  return `${window.location.pathname}?${params.toString()}#login`;
}

function render(): void {
  if (!session) {
    if (preferLoginScreen || isLoginRoute()) renderLogin();
    else {
      const guideId = moduleGuideIdFromLocation();
      if (guideId) renderModuleGuide(guideId);
      else renderLanding();
    }
    return;
  }
  if (!renderAllowed()) return;
  // ماژولی که کاربر به آن دسترسی ندارد هرگز نمایش داده نمی‌شود
  // فقط زمانی به ماژول نخست برمی‌گردیم که کاربر واقعاً به آن دسترسی ندارد؛
  // هرگز بر اثرِ وضعیتِ گذرا (مثلاً نرسیدنِ مجوزها) ماژول عوض نمی‌شود
  if (!canAccess(activeModule)) {
    const fallback = visibleModules().find((item) => item.id !== activeModule);
    if (fallback && (session?.permissions?.length ?? 0) > 0) activeModule = fallback.id;
  }
  const current = currentModule();
  // پیش از بازسازی، جایگاهِ فیلدِ فعال را به خاطر می‌سپاریم تا تمرکزِ کاربر از بین نرود
  const focused = document.activeElement as HTMLElement | null;
  const focusSelector = focused && ['INPUT', 'TEXTAREA', 'SELECT'].includes(focused.tagName)
    ? `${focused.tagName.toLowerCase()}${focused.id ? `#${focused.id}` : ''}${(focused as HTMLInputElement).name ? `[name="${(focused as HTMLInputElement).name}"]` : ''}`
    : '';
  const caret = focusSelector ? (focused as HTMLInputElement).selectionStart : null;
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">ر</span><div><strong>راهکار</strong><small>مرکز عملیات سازمان</small></div></div><button type="button" class="workspace" id="org-switcher" aria-label="تغییر شرکت"><span class="workspace-dot"></span><div><small>شرکت انتخاب\u200cشده</small><strong id="org-switcher-name">${escapeHtml(activeOrganizationName())}</strong></div><span class="chevron">⌄</span></button><nav class="module-nav" aria-label="ماژول‌ها">${visibleModules().map((item) => `<button class="module-link ${item.id === activeModule ? 'active' : ''}" data-module="${item.id}"><span class="module-icon">${item.icon}</span><span>${item.label}</span></button>`).join('')}</nav><div class="sidebar-bottom"><button class="module-link"><span class="module-icon">?</span><span>مرکز راهنما</span></button><div class="user-card"><div class="avatar">${escapeHtml((session?.name ?? 'کاربر').trim().charAt(0) || 'ک')}</div><div><strong>${escapeHtml(session?.name ?? 'کاربر')}</strong><small>${escapeHtml(session?.role ?? 'بدون نقش')}</small></div><button class="logout-button" id="logout" type="button">خروج</button></div></div></aside><main class="main-content"><header class="topbar"><button class="menu-toggle" id="menu-toggle" type="button" aria-label="نمایش منو">☰</button><div class="breadcrumbs"><span>فضای کاری</span><b>/</b><strong>${current.label}</strong></div><div class="top-actions"><label class="search"><span>⌕</span><input id="search-input" value="${escapeHtml(query)}" placeholder="جست‌وجو در همه‌چیز" /></label><span class="api-chip" id="api-chip" role="status" aria-live="polite"></span><button class="icon-button" id="notifications-button" aria-label="اعلان‌ها">♧<i></i></button><div class="top-datetime"><span id="top-time">--:--</span><span id="top-date">--</span></div></div></header><section class="page-heading"><div><p class="eyebrow">${current.note}</p><h1>${current.label}</h1><p class="muted">داده‌های عملیاتی امروز، یک‌جا و قابل اقدام.</p></div><button class="primary-button" id="new-entry"><span>＋</span> ثبت رویداد جدید</button></section>${activeModule === 'overview' ? overviewMarkup() : safeModuleMarkup(current)}${activeModule === 'overview' ? insightsMarkup() : ''}</main><div class="sidebar-backdrop" id="sidebar-backdrop"></div></div>`;
  updateDashboardClock();
  // نشانگرِ وضعیت بلافاصله آخرین وضعیتِ واقعی را نشان می‌دهد (بدون درخواستِ شبکه‌ای)
  updateApiChip();
  document.querySelector<HTMLButtonElement>('#notifications-button')?.addEventListener('click', openNotifications);
  const shell = document.querySelector<HTMLElement>('.app-shell');
  const closeSidebar = (): void => shell?.classList.remove('sidebar-open');
  document.querySelector<HTMLButtonElement>('#menu-toggle')?.addEventListener('click', () => shell?.classList.toggle('sidebar-open'));
  document.querySelector<HTMLButtonElement>('#org-switcher')?.addEventListener('click', () => {
    if (!serverSession) { showToast('در حالت آفلاین یک شرکت در دسترس است؛ برای چندشرکتی وارد حساب کاربری شوید.'); return; }
    openOrganizationsModal();
  });
  document.querySelector<HTMLElement>('#sidebar-backdrop')?.addEventListener('click', closeSidebar);
  document.querySelectorAll<HTMLButtonElement>('[data-module]').forEach((button) => button.addEventListener('click', () => { activeModule = button.dataset.module ?? 'overview'; query = ''; closeSidebar(); render(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-feature]').forEach((button) => button.addEventListener('click', () => openFeatureForm(button.dataset.feature ?? 'عملیات جدید')));
  document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => button.addEventListener('click', () => updateRecord(button.dataset.action ?? '', button.dataset.id ?? '')));
  document.querySelector<HTMLInputElement>('#search-input')?.addEventListener('input', (event) => { query = (event.target as HTMLInputElement).value; render(); const input = document.querySelector<HTMLInputElement>('#search-input'); input?.focus(); input?.setSelectionRange(query.length, query.length); });
  document.querySelector<HTMLButtonElement>('#new-entry')?.addEventListener('click', () => openFeatureForm('رویداد عمومی'));
  document.querySelector<HTMLButtonElement>('#logout')?.addEventListener('click', logout);
  document.querySelector<HTMLElement>('#api-chip')?.addEventListener('click', () => {
    if (demoMode) { openDemoNotice(); return; }
    // هر کلیک یعنی «دوباره بررسی کن»
    void refreshApiStatus();
    if (apiOnline && serverSession) openConnectionDetails();
    else if (!apiOnline) openConnectionDetails();
    else openServerLogin();
  });
  document.querySelector<HTMLButtonElement>('#load-audit')?.addEventListener('click', () => void loadAudit());
  document.querySelectorAll<HTMLButtonElement>('[data-document-transition]').forEach((button) => button.addEventListener('click', () => void transitionDocument(button.dataset.documentTransition ?? '', button.dataset.action ?? '')));
  document.querySelectorAll<HTMLButtonElement>('[data-document-history]').forEach((button) => button.addEventListener('click', () => showDocumentHistory(button.dataset.documentHistory ?? '')));
  document.querySelectorAll<HTMLButtonElement>('[data-toggle-period]').forEach((button) => button.addEventListener('click', () => void togglePeriod(button.dataset.togglePeriod ?? '', button.dataset.status ?? '')));
  document.querySelectorAll<HTMLFormElement>('[data-cost-center-form]').forEach((form) => form.addEventListener('submit', (event) => void addCostCenter(event)));
  document.querySelectorAll<HTMLButtonElement>('[data-post-journal]').forEach((button) => button.addEventListener('click', () => void postJournalEntry(button.dataset.postJournal ?? '')));
  document.querySelectorAll<HTMLButtonElement>('[data-journal-lines]').forEach((button) => button.addEventListener('click', () => showJournalLines(button.dataset.journalLines ?? '')));
  document.querySelector<HTMLButtonElement>('#connect-server')?.addEventListener('click', openServerLogin);
  document.querySelectorAll<HTMLButtonElement>('[data-costing-method]').forEach((button) =>
    button.addEventListener('click', () => {
      costingMethod = (button.dataset.costingMethod ?? 'wac') as typeof costingMethod;
      render();
      void loadServerData().then(() => render());
    }),
  );
  document.querySelector<HTMLButtonElement>('#stock-movement')?.addEventListener('click', openStockMovementForm);
  document.querySelector<HTMLButtonElement>('#bank-statement')?.addEventListener('click', openBankStatementForm);
  document.querySelector<HTMLButtonElement>('#payroll-calc')?.addEventListener('click', openPayslipForm);
  document.querySelector<HTMLButtonElement>('#check-new')?.addEventListener('click', openCheckForm);
  document.querySelector<HTMLButtonElement>('#export-csv')?.addEventListener('click', exportTablesToCsv);
  document.querySelector<HTMLButtonElement>('#print-report')?.addEventListener('click', () => printCurrentView());
  document.querySelectorAll<HTMLButtonElement>('[data-check-status]').forEach((button) =>
    button.addEventListener('click', () => void updateCheckStatus(button.dataset.checkStatus ?? '', button.dataset.status ?? '')),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-match-statement]').forEach((button) =>
    button.addEventListener('click', () => void matchBankStatement(button.dataset.matchStatement ?? '', button.dataset.entry ?? '')),
  );
  document.querySelector<HTMLButtonElement>('#close-fiscal-year')?.addEventListener('click', () => void closeFiscalYear());
  document.querySelector<HTMLButtonElement>('#new-lead')?.addEventListener('click', openLeadForm);
  document.querySelector<HTMLButtonElement>('#new-ticket')?.addEventListener('click', openTicketForm);
  document.querySelector<HTMLButtonElement>('#new-budget')?.addEventListener('click', openBudgetForm);
  document.querySelectorAll<HTMLButtonElement>('[data-delete-lead]').forEach((button) => button.addEventListener('click', () => deleteLead(button.dataset.deleteLead ?? '')));
  document.querySelectorAll<HTMLButtonElement>('[data-delete-ticket]').forEach((button) => button.addEventListener('click', () => deleteTicket(button.dataset.deleteTicket ?? '')));
  document.querySelectorAll<HTMLButtonElement>('[data-ticket-next]').forEach((button) => button.addEventListener('click', () => nextTicket(button.dataset.ticketNext ?? '')));
  document.querySelectorAll<HTMLButtonElement>('[data-delete-budget]').forEach((button) => button.addEventListener('click', () => deleteBudget(button.dataset.deleteBudget ?? '')));
  document.querySelectorAll<HTMLButtonElement>('[data-export]').forEach((button) => button.addEventListener('click', () => exportReport(button.dataset.export ?? 'events')));
  // ماژول گزارش‌گیری: تب‌ها، کتابخانه‌ی گزارش‌ها و خروجی‌ها
  document.querySelectorAll<HTMLButtonElement>('[data-reporting-tab]').forEach((button) =>
    button.addEventListener('click', () => { reportingTab = (button.dataset.reportingTab ?? 'overview') as typeof reportingTab; render(); }),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-library-report]').forEach((button) =>
    button.addEventListener('click', () => { libraryReport = button.dataset.libraryReport ?? 'sales'; render(); }),
  );
  document.querySelector<HTMLButtonElement>('#library-csv')?.addEventListener('click', () => exportLibraryReport(libraryReport));
  document.querySelector<HTMLButtonElement>('#library-print')?.addEventListener('click', () => printCurrentView());
  document.querySelectorAll<HTMLButtonElement>('[data-task-approve]').forEach((button) => button.addEventListener('click', () => approveTask(button.dataset.taskApprove ?? '')));
  document.querySelectorAll<HTMLButtonElement>('[data-goto-module]').forEach((button) => button.addEventListener('click', () => gotoModule(button.dataset.gotoModule ?? 'overview')));
  // سقف اعتبار مشتریان
  document.querySelector<HTMLFormElement>('#credit-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    saveCreditLimit(String(data.get('customer') ?? ''), Number(data.get('limit') ?? 0));
  });
  document.querySelector<HTMLButtonElement>('#credit-reset')?.addEventListener('click', () => {
    const form = document.querySelector<HTMLFormElement>('#credit-form');
    if (form) form.reset();
    showToast('فرمِ سقف اعتبار پاک شد.');
  });
  document.querySelectorAll<HTMLButtonElement>('[data-credit-remove]').forEach((button) =>
    button.addEventListener('click', () => removeCreditLimit(button.dataset.creditRemove ?? '')),
  );
  // صفِ سامانه‌ی مؤدیان
  if (document.querySelector('.tax-panel')) {
    if (serverSession && !demoMode) void loadTaxSubmissions().then(() => { if (activeModule === 'sales' && Date.now() - taxLoadedAt < 1500) render(); });
    document.querySelector<HTMLButtonElement>('#tax-send-all')?.addEventListener('click', () => void sendAllTaxSubmissions());
    document.querySelector<HTMLButtonElement>('#tax-refresh')?.addEventListener('click', async () => {
      await loadTaxSubmissions();
      render();
      showToast('فهرستِ صورت‌حساب‌ها به‌روزرسانی شد.');
    });
    document.querySelectorAll<HTMLButtonElement>('[data-tax-send]').forEach((button) =>
      button.addEventListener('click', () => void sendTaxSubmission(button.dataset.taxSend ?? '')),
    );
    document.querySelectorAll<HTMLButtonElement>('[data-tax-download]').forEach((button) =>
      button.addEventListener('click', () => {
        const row = taxSubmissions.find((item) => item.id === button.dataset.taxDownload);
        if (row) downloadTaxPayload(row);
      }),
    );
    document.querySelectorAll<HTMLButtonElement>('[data-tax-remove]').forEach((button) =>
      button.addEventListener('click', () => {
        const row = taxSubmissions.find((item) => item.id === button.dataset.taxRemove);
        if (!row) return;
        confirmDialog('حذف از صف', `صورت‌حساب ${row.invoiceNumber} از صفِ مؤدیان حذف شود؟`, () => void removeTaxSubmission(row.id));
      }),
    );
  }
  document.querySelector<HTMLFormElement>('#record-form')?.addEventListener('submit', saveRecord);
  if (document.querySelector('.recurring-panel')) {
    if (serverSession && !demoMode && !recurringEntries.length && !recurringLoaded) {
      recurringLoaded = true;
      void loadRecurring().then(() => { if (activeModule === 'accounting') render(); });
    }
    document.querySelector<HTMLFormElement>('#recurring-form')?.addEventListener('submit', (event) => void saveRecurring(event));
    document.querySelector<HTMLButtonElement>('#recurring-reset')?.addEventListener('click', () => {
      const form = document.querySelector<HTMLFormElement>('#recurring-form');
      if (form) form.reset();
      showToast('فرمِ سند تکرارشونده پاک شد.');
    });
    document.querySelectorAll<HTMLButtonElement>('[data-recurring-run]').forEach((button) =>
      button.addEventListener('click', () => void runRecurring(button.dataset.recurringRun ?? '')),
    );
    document.querySelectorAll<HTMLButtonElement>('[data-recurring-toggle]').forEach((button) =>
      button.addEventListener('click', () => void toggleRecurring(button.dataset.recurringToggle ?? '')),
    );
    document.querySelectorAll<HTMLButtonElement>('[data-recurring-remove]').forEach((button) =>
      button.addEventListener('click', () => void removeRecurring(button.dataset.recurringRemove ?? '')),
    );
  }
  document.querySelector<HTMLFormElement>('#journal-form')?.addEventListener('submit', saveJournal);
  document.querySelector<HTMLButtonElement>('#add-journal-line')?.addEventListener('click', addJournalLine);
  document.querySelector<HTMLButtonElement>('#new-account')?.addEventListener('click', openAccountForm);
  document.querySelector<HTMLButtonElement>('#new-treasury')?.addEventListener('click', openTreasuryForm);
  document.querySelector<HTMLButtonElement>('#new-invoice')?.addEventListener('click', openInvoiceForm);
  document.querySelector<HTMLButtonElement>('#new-purchase')?.addEventListener('click', openPurchaseForm);
  document.querySelectorAll<HTMLButtonElement>('[data-user-toggle]').forEach((button) => button.addEventListener('click', () => toggleUser(button.dataset.userToggle ?? '')));
  document.querySelector<HTMLButtonElement>('#new-payroll')?.addEventListener('click', openPayrollForm);
  document.querySelector<HTMLButtonElement>('#new-asset')?.addEventListener('click', openAssetForm);
  // تب‌های دفتر: تراز آزمایشی و دفتر کل
  document.querySelectorAll<HTMLButtonElement>('[data-report]').forEach((button) =>
    button.addEventListener('click', () => {
      const value = button.dataset.report;
      if (value === 'trial-balance' || value === 'ledger') { ledgerTab = value; render(); }
    }),
  );
  // صورت‌های مالی و مالیات
  if (document.querySelector('.statements-panel')) {
    if (!statementsLoaded) void loadFinancialStatements();
    document.querySelectorAll<HTMLButtonElement>('[data-statement]').forEach((button) =>
      button.addEventListener('click', () => { statementsTab = button.dataset.statement as typeof statementsTab; render(); }),
    );
    document.querySelector<HTMLButtonElement>('#statements-refresh')?.addEventListener('click', () => void loadFinancialStatements());
  }
  // تحلیل بودجه و انحراف
  document.querySelector<HTMLButtonElement>('#budget-analyze')?.addEventListener('click', () => void loadBudgetAnalysis());
  // گزارش‌ساز دلخواه
  if (document.querySelector('.report-builder')) {
    if (!sourcesLoaded) void loadReportSources().then(() => { if (activeModule === 'reporting') render(); });
    document.querySelector<HTMLSelectElement>('#report-source')?.addEventListener('change', (event) => {
      reportDraft = { ...reportDraft, source: (event.currentTarget as HTMLSelectElement).value, columns: [], groupBy: '', sortBy: '' };
      reportResult = null;
      render();
    });
    document.querySelector<HTMLSelectElement>('#report-columns')?.addEventListener('change', (event) => {
      const select = event.currentTarget as HTMLSelectElement;
      reportDraft = { ...reportDraft, columns: [...select.selectedOptions].map((option) => option.value) };
    });
    document.querySelector<HTMLSelectElement>('#report-group')?.addEventListener('change', (event) => {
      reportDraft = { ...reportDraft, groupBy: (event.currentTarget as HTMLSelectElement).value };
      render();
    });
    document.querySelector<HTMLSelectElement>('#report-sort')?.addEventListener('change', (event) => {
      reportDraft = { ...reportDraft, sortBy: (event.currentTarget as HTMLSelectElement).value };
    });
    document.querySelector<HTMLSelectElement>('#report-direction')?.addEventListener('change', (event) => {
      reportDraft = { ...reportDraft, sortDirection: (event.currentTarget as HTMLSelectElement).value as 'asc' | 'desc' };
    });
    document.querySelector<HTMLInputElement>('#report-limit')?.addEventListener('change', (event) => {
      reportDraft = { ...reportDraft, limit: Math.max(1, Math.min(2000, Number((event.currentTarget as HTMLInputElement).value) || 200)) };
    });
    document.querySelector<HTMLButtonElement>('#report-add-filter')?.addEventListener('click', () => {
      const source = currentSource();
      reportDraft = { ...reportDraft, filters: [...reportDraft.filters, { field: source?.fields[0]?.key ?? '', operator: 'contains', value: '' }] };
      render();
    });
    document.querySelectorAll<HTMLButtonElement>('.filter-remove').forEach((button) =>
      button.addEventListener('click', () => {
        const index = Number(button.dataset.index);
        reportDraft = { ...reportDraft, filters: reportDraft.filters.filter((_, position) => position !== index) };
        render();
      }),
    );
    document.querySelectorAll<HTMLElement>('.report-filter[data-index]').forEach((row) => {
      const index = Number((row as HTMLElement).dataset.index);
      row.querySelector('.filter-field')?.addEventListener('change', (event) => {
        reportDraft.filters[index] = { ...reportDraft.filters[index], field: (event.target as HTMLSelectElement).value };
      });
      row.querySelector('.filter-operator')?.addEventListener('change', (event) => {
        reportDraft.filters[index] = { ...reportDraft.filters[index], operator: (event.target as HTMLSelectElement).value as ReportFilter['operator'] };
      });
      row.querySelector('.filter-value')?.addEventListener('input', (event) => {
        reportDraft.filters[index] = { ...reportDraft.filters[index], value: (event.target as HTMLInputElement).value };
      });
      row.querySelector('.filter-value2')?.addEventListener('input', (event) => {
        reportDraft.filters[index] = { ...reportDraft.filters[index], value2: (event.target as HTMLInputElement).value };
      });
    });
    document.querySelector<HTMLButtonElement>('#report-add-aggregate')?.addEventListener('click', () => {
      const source = currentSource();
      const numeric = source?.fields.find((field) => field.type === 'number');
      reportDraft = { ...reportDraft, aggregate: [...reportDraft.aggregate, { field: numeric?.key ?? source?.fields[0]?.key ?? '', kind: 'sum' }] };
      render();
    });
    document.querySelectorAll<HTMLButtonElement>('.aggregate-remove').forEach((button) =>
      button.addEventListener('click', () => {
        const index = Number(button.dataset.aggregate);
        reportDraft = { ...reportDraft, aggregate: reportDraft.aggregate.filter((_, position) => position !== index) };
        render();
      }),
    );
    document.querySelectorAll<HTMLElement>('.report-filter[data-aggregate]').forEach((row) => {
      const index = Number((row as HTMLElement).dataset.aggregate);
      row.querySelector('.aggregate-field')?.addEventListener('change', (event) => {
        reportDraft.aggregate[index] = { ...reportDraft.aggregate[index], field: (event.target as HTMLSelectElement).value };
      });
      row.querySelector('.aggregate-kind')?.addEventListener('change', (event) => {
        reportDraft.aggregate[index] = { ...reportDraft.aggregate[index], kind: (event.target as HTMLSelectElement).value as 'sum' | 'count' | 'avg' | 'min' | 'max' };
      });
    });
    document.querySelector<HTMLButtonElement>('#report-clear-filters')?.addEventListener('click', () => {
      reportDraft = { ...reportDraft, filters: [] };
      render();
      showToast('فیلترها حذف شدند.');
    });
    document.querySelector<HTMLButtonElement>('#report-run')?.addEventListener('click', () => void runReportDraft());
    document.querySelector<HTMLButtonElement>('#report-export')?.addEventListener('click', exportReportCsv);
    document.querySelector<HTMLButtonElement>('#report-print')?.addEventListener('click', () => printCurrentView());
  }
  // رهگیری شماره سریال
  if (document.querySelector('.serial-panel')) {
    if (!serialsLoaded) void loadSerials().then(() => { if (activeModule === 'inventory') render(); });
    document.querySelector<HTMLButtonElement>('#new-serial')?.addEventListener('click', openSerialForm);
    document.querySelector<HTMLInputElement>('#serial-search')?.addEventListener('input', (event) => {
      serialFilter = { ...serialFilter, query: (event.currentTarget as HTMLInputElement).value.trim() };
      const rows = document.querySelectorAll('.serial-panel tbody tr');
      rows.forEach((row) => {
        const text = row.textContent ?? '';
        (row as HTMLElement).hidden = Boolean(serialFilter.query) && !text.includes(serialFilter.query);
      });
    });
    document.querySelector<HTMLSelectElement>('#serial-status')?.addEventListener('change', (event) => {
      serialFilter = { ...serialFilter, status: (event.currentTarget as HTMLSelectElement).value as SerialStatus | '' };
      serialsLoaded = false;
      void loadSerials().then(() => render());
    });
    document.querySelectorAll<HTMLSelectElement>('.serial-action').forEach((select) =>
      select.addEventListener('change', (event) => {
        const status = (event.currentTarget as HTMLSelectElement).value as SerialStatus;
        const id = select.dataset.serial ?? '';
        if (!status || !id) return;
        void changeSerialStatus(id, status);
      }),
    );
  }
  // استهلاک خودکار
  if (document.querySelector('#depreciation-method')) {
    if (!depreciationRunCache) void loadDepreciation().then(() => { if (activeModule === 'fixed-assets') render(); });
    document.querySelector<HTMLSelectElement>('#depreciation-method')?.addEventListener('change', (event) => {
      depreciationMethod = (event.currentTarget as HTMLSelectElement).value as DepreciationMethodId;
      void loadDepreciation().then(() => render());
    });
    document.querySelector<HTMLButtonElement>('#depreciation-calc')?.addEventListener('click', () => void loadDepreciation().then(() => { render(); showToast('استهلاک دوره محاسبه شد.'); }));
    document.querySelector<HTMLButtonElement>('#depreciation-post')?.addEventListener('click', () => void postDepreciation());
  }
  document.querySelector<HTMLButtonElement>('#new-production')?.addEventListener('click', openProductionForm);
  // صورت مواد و بهای تمام‌شده
  if (document.querySelector('#cost-calc') || document.querySelector('#new-bom')) {
    if (!bomsLoaded) void loadBoms().then(() => { if (activeModule === 'manufacturing' || activeModule === 'production') render(); });
    document.querySelector<HTMLButtonElement>('#new-bom')?.addEventListener('click', openBomForm);
    document.querySelector<HTMLButtonElement>('#cost-calc')?.addEventListener('click', () => {
      const bomSelect = document.querySelector<HTMLSelectElement>('#cost-bom');
      costDraft = {
        bomId: bomSelect?.value ?? costDraft.bomId,
        quantity: Math.max(1, Number(document.querySelector<HTMLInputElement>('#cost-quantity')?.value) || 1),
        standardUnitCost: Math.max(0, Number(document.querySelector<HTMLInputElement>('#cost-standard')?.value) || 0),
        overheadRatePerMinute: Math.max(0, Number(document.querySelector<HTMLInputElement>('#cost-overhead')?.value) || 0),
        scrapPercent: costDraft.scrapPercent,
      };
      void calculateProductionCost();
    });
    document.querySelector<HTMLButtonElement>('#cost-post')?.addEventListener('click', () => void postProductionOrder());
  }
  document.querySelectorAll<HTMLButtonElement>('[data-delete-account]').forEach((button) => button.addEventListener('click', () => deleteAccountLocal(button.dataset.deleteAccount ?? '')));
  document.querySelector<HTMLFormElement>('#journal-form')?.addEventListener('input', updateJournalTotals);
  bindBackupPanel();
  bindOrganizationExtras();
  bindDataExchange();
  document.querySelectorAll<HTMLButtonElement>('[data-print-check]').forEach((button) =>
    button.addEventListener('click', () => printCheck(button.dataset.printCheck ?? '')));
  document.querySelectorAll<HTMLButtonElement>('[data-print-invoice]').forEach((button) =>
    button.addEventListener('click', () => {
      const invoice = salesInvoices.find((item) => item.id === (button.dataset.printInvoice ?? ''));
      if (!invoice) { showToast('فاکتور پیدا نشد.'); return; }
      printInvoice({
        number: invoice.invoiceNumber,
        party: invoice.customerName,
        date: new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium' }).format(new Date()),
        total: invoice.total,
        tax: invoice.tax,
        discount: invoice.discount,
        items: invoice.lines.map((line) => ({ title: line.itemTitle, quantity: line.quantity, unitPrice: line.unitPrice, total: line.quantity * line.unitPrice })),
      });
    }));
  document.querySelector<HTMLButtonElement>('#tax-invoice-new')?.addEventListener('click', () => openTaxInvoiceForm());
  document.querySelector<HTMLButtonElement>('#close-modal')?.addEventListener('click', () => closeModal());
  // بازگرداندنِ تمرکز و محلِ کرسر به همان فیلدی که کاربر در آن می‌نوشت
  if (focusSelector) {
    const next = document.querySelector<HTMLElement>(focusSelector);
    if (next) {
      next.focus();
      if (caret !== null && 'setSelectionRange' in next) {
        try { (next as HTMLInputElement).setSelectionRange(caret, caret); } catch { /* نوعِ فیلد پشتیبانی نمی‌کند */ }
      }
    }
  }
}
function updateDashboardClock(): void {
  const now = new Date();
  const timeEl = document.querySelector<HTMLElement>('#top-time');
  const dateEl = document.querySelector<HTMLElement>('#top-date');
  if (timeEl) timeEl.textContent = new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit' }).format(now);
  if (dateEl) dateEl.textContent = new Intl.DateTimeFormat('fa-IR', { weekday: 'short', day: 'numeric', month: 'long' }).format(now);
}


type ModuleGuide = {
  summary: string;
  what: string;
  value: string;
  example: string;
  outcome: string;
  flow: string[];
};

/** توضیح‌های ساده برای آشنایی نخستین کاربر با هر ماژول */
const moduleGuides: Record<string, ModuleGuide> = {
  identity: { summary: 'مشخص می‌کند چه کسی به کدام بخش‌ها دسترسی دارد.', what: 'این بخش برای ساختن حساب کاربری همکاران و تعیین سطح دسترسی آن‌هاست.', value: 'هر شخص فقط اطلاعات و دکمه‌هایی را می‌بیند که برای انجام کارش لازم دارد؛ بنابراین کارها امن‌تر و مرتب‌تر می‌مانند.', example: 'مثلاً انباردار موجودی را می‌بیند، اما امکان تغییر اطلاعات حقوق را ندارد.', outcome: 'تیم با دسترسی روشن و قابل پیگیری کار می‌کند.', flow: ['ساخت حساب همکار', 'انتخاب نقش و دسترسی', 'ورود امن کاربر', 'ثبت فعالیت‌ها'] },
  organization: { summary: 'شناسنامه شرکت، شعبه‌ها و زمان‌بندی مالی را یک‌جا نگه می‌دارد.', what: 'در این بخش مشخص می‌کنید سازمان شما چه شرکت‌ها، شعبه‌ها، پروژه‌ها و دوره‌های مالی دارد.', value: 'همه بخش‌های برنامه از همین اطلاعات مشترک استفاده می‌کنند تا هر گزارش متعلق به شرکت و زمان درست باشد.', example: 'می‌توانید شعبه تهران و شیراز را جدا ببینید، اما در گزارش کل گروه کنار هم داشته باشید.', outcome: 'ساختار سازمان همیشه شفاف و آماده گزارش‌گیری است.', flow: ['تعریف شرکت و شعبه', 'مشخص کردن سال مالی', 'ساخت مراکز هزینه', 'استفاده مشترک همه ماژول‌ها'] },
  workflow: { summary: 'کارها را به ترتیب درست به نفر بعدی می‌رساند.', what: 'گردش کار مسیر انجام یک درخواست را مشخص می‌کند؛ از ثبت درخواست تا تأیید و پایان آن.', value: 'هیچ درخواست مهمی بین پیام‌ها و تماس‌ها گم نمی‌شود و هر نفر می‌داند چه زمانی باید اقدام کند.', example: 'درخواست خرید ابتدا توسط مسئول واحد ثبت می‌شود، سپس مدیر تأیید می‌کند و برای خرید ارسال می‌شود.', outcome: 'مسئول هر گام و وضعیت هر کار همیشه معلوم است.', flow: ['ثبت درخواست', 'ارسال برای مسئول', 'تأیید یا اصلاح', 'ثبت نتیجه و اطلاع‌رسانی'] },
  integration: { summary: 'اطلاعات راهکار را با سامانه‌های دیگر هماهنگ می‌کند.', what: 'این بخش مسیر ارتباط راهکار با بانک، سامانه مالیاتی یا نرم‌افزارهای دیگر سازمان است.', value: 'به‌جای ورود دوباره اطلاعات، داده‌ها یک‌بار ثبت می‌شوند و بین سامانه‌های مجاز جابه‌جا می‌شوند.', example: 'وضعیت یک پرداخت بانکی می‌تواند مستقیم در خزانه‌داری دیده شود.', outcome: 'اطلاعات یکپارچه‌تر و خطاهای ورود دستی کمتر می‌شود.', flow: ['انتخاب سامانه مقصد', 'تنظیم ارتباط امن', 'ارسال یا دریافت اطلاعات', 'بررسی وضعیت و خطاها'] },
  accounting: { summary: 'رویدادهای مالی را به گزارش‌های قابل اعتماد تبدیل می‌کند.', what: 'مالی و حسابداری محل ثبت و مرتب‌سازی همه اتفاق‌های مالی سازمان است؛ مثل فروش، خرید و هزینه‌ها.', value: 'مدیر و حسابدار در هر زمان می‌توانند تصویر روشنی از درآمد، هزینه، بدهی و مانده حساب‌ها داشته باشند.', example: 'وقتی فاکتور فروش ثبت می‌شود، اثر مالی آن در حساب‌ها قابل پیگیری خواهد بود.', outcome: 'گزارش‌های مالی منظم برای تصمیم‌گیری و پایان سال آماده است.', flow: ['ثبت رویداد مالی', 'ساخت یا ثبت سند', 'کنترل بدهکار و بستانکار', 'گزارش‌گیری و بستن دوره'] },
  treasury: { summary: 'ورود و خروج پول، بانک و چک‌ها را کنترل می‌کند.', what: 'خزانه‌داری برای دیدن پول موجود، پرداخت‌ها، دریافت‌ها و تعهدات نزدیک سازمان است.', value: 'پیش از پرداخت یا برنامه‌ریزی خرید، می‌دانید چه مقدار پول در دسترس است و چه مبلغی در راه است.', example: 'می‌توانید ببینید کدام چک‌ها سررسید دارند و چه دریافت‌هایی هنوز انجام نشده‌اند.', outcome: 'تصمیم‌های نقدی با دید روشن‌تر گرفته می‌شوند.', flow: ['ثبت دریافت یا پرداخت', 'انتخاب بانک یا صندوق', 'پیگیری چک و سررسید', 'نمایش مانده و پیش‌بینی'] },
  sales: { summary: 'فروش را از درخواست مشتری تا دریافت وجه دنبال می‌کند.', what: 'این بخش مراحل فروش کالا یا خدمت به مشتری را در یک مسیر ساده نگه می‌دارد.', value: 'تیم فروش می‌داند هر مشتری در چه مرحله‌ای است و چه سفارش یا فاکتوری نیاز به پیگیری دارد.', example: 'برای یک مشتری ابتدا پیش‌فاکتور، سپس سفارش، ارسال کالا و در پایان فاکتور ثبت می‌شود.', outcome: 'فرصت فروش کمتر فراموش می‌شود و وصول مطالبات منظم‌تر است.', flow: ['ثبت درخواست مشتری', 'ساخت پیش‌فاکتور یا سفارش', 'ارسال کالا یا خدمت', 'صدور فاکتور و پیگیری دریافت'] },
  purchasing: { summary: 'خرید کالا و خدمات را شفاف و قابل مقایسه می‌کند.', what: 'خرید و تدارکات مسیر نیاز داخلی تا سفارش دادن به تأمین‌کننده را مدیریت می‌کند.', value: 'قبل از خرید می‌توانید پیشنهادها را مقایسه و هزینه‌ها را کنترل کنید.', example: 'واحد تولید نیاز به مواد اولیه را ثبت می‌کند و مسئول خرید از چند تأمین‌کننده قیمت می‌گیرد.', outcome: 'خریدها با دلیل روشن، تأیید مناسب و سابقه کامل انجام می‌شوند.', flow: ['ثبت نیاز خرید', 'دریافت و مقایسه قیمت', 'تأیید و ثبت سفارش', 'تحویل کالا یا خدمت'] },
  inventory: { summary: 'به شما می‌گوید چه کالایی، کجا و به چه تعداد دارید.', what: 'انبار و لجستیک برای ثبت کالاها و حرکت آن‌ها بین انبار، تولید، فروش و شمارش است.', value: 'از کمبود ناگهانی یا خرید اضافه جلوگیری می‌شود و محل هر کالا قابل پیگیری است.', example: 'با رسید خرید، موجودی زیاد می‌شود و با تحویل سفارش فروش، همان موجودی کم می‌شود.', outcome: 'موجودی واقعی و قابل اعتماد در اختیار تیم است.', flow: ['تعریف کالا و انبار', 'ثبت رسید یا حواله', 'کنترل حداقل موجودی', 'شمارش و گزارش موجودی'] },
  payroll: { summary: 'حقوق هر همکار را با کارکرد و کسورات محاسبه می‌کند.', what: 'حقوق و دستمزد اطلاعات کارکرد، اضافه‌کاری، مرخصی، بیمه و مالیات را برای پرداخت حقوق کنار هم می‌گذارد.', value: 'محاسبه حقوق منظم‌تر می‌شود و هر پرداخت سابقه مشخصی دارد.', example: 'پس از ثبت کارکرد ماهانه، فیش حقوقی هر کارمند آماده بررسی و پرداخت می‌شود.', outcome: 'پرداخت حقوق به‌موقع و با خطای کمتر انجام می‌شود.', flow: ['ثبت اطلاعات پرسنل', 'ثبت کارکرد و تغییرات', 'محاسبه حقوق و کسورات', 'تأیید و پرداخت فیش'] },
  hr: { summary: 'اطلاعات و مسیر همکاری کارکنان را سامان می‌دهد.', what: 'منابع انسانی برای مدیریت اطلاعات کارکنان از جذب تا آموزش، ارزیابی و مرخصی است.', value: 'واحد منابع انسانی به‌جای فایل‌ها و پیگیری‌های پراکنده، یک پرونده روشن برای هر همکار دارد.', example: 'درخواست مرخصی ثبت می‌شود، برای مدیر می‌رود و نتیجه آن در پرونده کارمند می‌ماند.', outcome: 'تجربه کارکنان و تصمیم‌های منابع انسانی بهتر مدیریت می‌شود.', flow: ['جذب یا ثبت همکار', 'تکمیل پرونده و قرارداد', 'مدیریت کارکرد و درخواست‌ها', 'ارزیابی و توسعه'] },
  'fixed-assets': { summary: 'اموال ماندگار سازمان، مانند دستگاه و خودرو را پیگیری می‌کند.', what: 'دارایی ثابت برای ثبت چیزهایی است که سازمان می‌خرد و سال‌ها از آن‌ها استفاده می‌کند؛ مثل ماشین‌آلات، خودرو و تجهیزات.', value: 'می‌دانید هر دارایی کجاست، مسئولش کیست و ارزش آن در طول زمان چقدر تغییر کرده است.', example: 'پس از خرید یک دستگاه، محل استقرار و عمر مفیدش ثبت می‌شود و هزینه استفاده از آن به‌تدریج محاسبه می‌گردد.', outcome: 'فهرست اموال و ارزش مالی آن‌ها همیشه قابل اتکاست.', flow: ['ثبت دارایی جدید', 'تعیین محل و مسئول', 'محاسبه کاهش ارزش دوره‌ای', 'تعمیر، انتقال یا خروج از سازمان'] },
  manufacturing: { summary: 'تبدیل مواد اولیه به محصول را مرحله‌به‌مرحله نشان می‌دهد.', what: 'تولید برای برنامه‌ریزی سفارش‌ها، مواد لازم، اجرای کار و کنترل نتیجه تولید است.', value: 'پیش از شروع کار می‌دانید چه موادی لازم است، چه تعداد باید تولید شود و هزینه تقریبی چقدر است.', example: 'برای ساخت یک محصول، فهرست مواد، مقدار تولید و هزینه نیروی کار ثبت می‌شود.', outcome: 'تولید قابل برنامه‌ریزی‌تر و هزینه‌ها قابل کنترل‌تر می‌شود.', flow: ['تعریف محصول و مواد لازم', 'برنامه‌ریزی سفارش تولید', 'ثبت مصرف و انجام کار', 'کنترل کیفیت و هزینه نهایی'] },
  budget: { summary: 'برنامه مالی سازمان را با عملکرد واقعی مقایسه می‌کند.', what: 'بودجه و کنترل مدیریت برای تعیین برنامه هزینه و درآمد، سپس مقایسه آن با اتفاق‌های واقعی است.', value: 'مدیر زودتر متوجه می‌شود کدام واحد یا پروژه بیش از برنامه هزینه کرده یا از هدف عقب مانده است.', example: 'بودجه تبلیغات را ثبت می‌کنید و در طول ماه، هزینه واقعی را کنار آن می‌بینید.', outcome: 'تصمیم‌ها بر پایه فاصله برنامه و واقعیت گرفته می‌شوند.', flow: ['ثبت هدف و بودجه', 'اتصال هزینه و درآمد واقعی', 'دیدن اختلاف‌ها', 'اصلاح برنامه یا اقدام مدیریتی'] },
  crm: { summary: 'رابطه با مشتری را از اولین تماس تا پشتیبانی نگه می‌دارد.', what: 'CRM همه اطلاعات مشتری، فرصت فروش، پیگیری‌ها و درخواست‌های پشتیبانی را در یک جا جمع می‌کند.', value: 'هیچ تماس یا درخواست مشتری بی‌پاسخ نمی‌ماند و سابقه ارتباط برای همه اعضای تیم روشن است.', example: 'وقتی مشتری تیکت ثبت می‌کند، مسئول رسیدگی، اولویت و وضعیت پاسخ آن مشخص است.', outcome: 'فروش پیگیرتر و تجربه مشتری بهتر می‌شود.', flow: ['ثبت مشتری یا سرنخ', 'پیگیری تماس و فرصت', 'تبدیل به فروش یا قرارداد', 'پاسخ‌گویی و سنجش رضایت'] },
  reporting: { summary: 'داده‌های روزانه را به تصویر قابل فهم برای تصمیم‌گیری تبدیل می‌کند.', what: 'گزارش‌گیری و BI برای دیدن روندها، مقایسه‌ها و پاسخ به پرسش‌های مدیریتی از روی اطلاعات ثبت‌شده است.', value: 'به‌جای جست‌وجو در چند جدول، در یک صفحه می‌بینید چه چیزی رشد کرده، کجا نیاز به توجه دارد و چرا.', example: 'مدیر می‌تواند فروش ماه‌های اخیر، پرداخت‌ها یا وضعیت موجودی را کنار هم بررسی کند.', outcome: 'تصمیم‌ها سریع‌تر و بر پایه داده‌های واقعی گرفته می‌شوند.', flow: ['انتخاب موضوع گزارش', 'فیلتر کردن اطلاعات لازم', 'دیدن جدول و نمودار', 'اشتراک‌گذاری نتیجه با تیم'] },
};

function moduleGuideIdFromLocation(): string | null {
  const match = window.location.hash.match(/^#modules\/([\w-]+)$/);
  const id = match?.[1] ?? '';
  return moduleGuides[id] ? id : null;
}

function publicPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function openModuleGuide(moduleId: string): void {
  if (!moduleGuides[moduleId]) return;
  window.history.pushState({ moduleGuide: moduleId }, '', `${publicPath()}#modules/${moduleId}`);
  renderModuleGuide(moduleId);
}

function returnToLanding(): void {
  window.history.pushState({ landing: true }, '', publicPath());
  renderLanding();
}

function renderModuleGuide(moduleId: string): void {
  const app = document.querySelector<HTMLDivElement>('#app');
  const module = moduleData.find((item) => item.id === moduleId);
  const guide = moduleGuides[moduleId];
  if (!app || !module || !guide) { renderLanding(); return; }
  preferLoginScreen = false;
  closeAllModals();
  const related = moduleData.filter((item) => item.id !== moduleId).slice(0, 4);
  app.innerHTML = `<main class="module-guide-page">
    <header class="guide-nav">
      <button class="guide-brand" id="guide-home" type="button" aria-label="بازگشت به صفحه اصلی"><span class="brand-mark">ر</span><span>راهکار</span></button>
      <div class="guide-nav-actions"><button class="guide-back" id="guide-back" type="button">← همه ماژول‌ها</button><a class="primary-button small guide-login-link" id="guide-login" href="${loginRouteHref()}">ورود به سامانه</a></div>
    </header>
    <section class="guide-hero">
      <div class="guide-hero-copy"><span class="guide-kicker"><i>${module.icon}</i> آشنایی با ماژول</span><h1>${module.label}</h1><p>${guide.summary}</p><div class="guide-hero-note"><span>برای چه کسی مفید است؟</span><strong>${guide.value}</strong></div></div>
      <div class="guide-symbol" aria-hidden="true"><span>${module.icon}</span><i></i><i></i><i></i></div>
    </section>
    <section class="guide-content">
      <article class="guide-card guide-intro"><span class="guide-card-number">۰۱</span><h2>${module.label} چیست؟</h2><p>${guide.what}</p><div class="guide-example"><span>یک مثال ساده</span><p>${guide.example}</p></div></article>
      <article class="guide-card guide-flow-card"><div class="guide-card-heading"><span class="guide-card-number">۰۲</span><div><h2>روند کار به زبان ساده</h2><p>با چند گام روشن، کار از ابتدا تا نتیجه قابل پیگیری است.</p></div></div><ol class="guide-flow">${guide.flow.map((step, index) => `<li><span>${(index + 1).toLocaleString('fa-IR').padStart(2, '۰')}</span><strong>${step}</strong>${index < guide.flow.length - 1 ? '<i aria-hidden="true">←</i>' : ''}</li>`).join('')}</ol></article>
      <article class="guide-card guide-outcome"><span class="guide-card-number">۰۳</span><h2>نتیجه برای سازمان</h2><p>${guide.outcome}</p><ul>${module.features.slice(0, 6).map((feature) => `<li><span>✓</span>${feature}</li>`).join('')}</ul></article>
    </section>
    <section class="guide-more-section"><div><p class="eyebrow">ادامه آشنایی</p><h2>ماژول‌های دیگر را هم ببینید</h2></div><div class="guide-more-grid">${related.map((item) => `<button type="button" class="guide-more-card" data-module-guide="${item.id}"><span>${item.icon}</span><strong>${item.label}</strong><b>←</b></button>`).join('')}</div></section>
    <section class="guide-cta"><div><span>آماده‌اید در عمل ببینید؟</span><h2>همه بخش‌ها در یک محیط هماهنگ کنار هم کار می‌کنند.</h2></div><a class="secondary-button" id="guide-start" href="${loginRouteHref()}">شروع رایگان <span>←</span></a></section>
    <footer class="guide-footer"><span>راهکار · سیستم یکپارچه برنامه‌ریزی سازمان</span><button type="button" id="guide-footer-home">بازگشت به صفحه اصلی</button></footer>
  </main>`;
  window.scrollTo({ top: 0, behavior: 'auto' });
  document.querySelector<HTMLButtonElement>('#guide-home')?.addEventListener('click', returnToLanding);
  document.querySelector<HTMLButtonElement>('#guide-back')?.addEventListener('click', returnToLanding);
  document.querySelector<HTMLButtonElement>('#guide-footer-home')?.addEventListener('click', returnToLanding);
  document.querySelectorAll<HTMLButtonElement>('[data-module-guide]').forEach((button) =>
    button.addEventListener('click', () => openModuleGuide(button.dataset.moduleGuide ?? '')),
  );
}

/** مسیرهای عمومی (راهنمای ماژول و ورود) بدون وابستگی به listener دکمه رندر می‌شوند. */
function renderPublicRoute(): void {
  if (session) return;
  preferLoginScreen = isLoginRoute();
  render();
}
window.addEventListener('popstate', renderPublicRoute);
window.addEventListener('hashchange', renderPublicRoute);

function cashBalanceChartMarkup(): string {
  const ordered = [...treasuryTransactions].sort((a, b) => {
    const aTime = Date.parse(a.createdAt || '') || 0;
    const bTime = Date.parse(b.createdAt || '') || 0;
    return aTime - bTime;
  });
  let balance = 0;
  const values = [0, ...ordered.map((item) => {
    balance += item.transactionType === 'receipt' ? item.amount : -item.amount;
    return balance;
  })].slice(-8);
  while (values.length < 4) values.unshift(values[0] ?? 0);
  const width = 280;
  const height = 64;
  const padding = 7;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(1, maximum - minimum);
  const points = values.map((value, index) => {
    const x = padding + (index * (width - padding * 2)) / Math.max(1, values.length - 1);
    const y = height - padding - ((value - minimum) / range) * (height - padding * 2);
    return { x, y };
  });
  const line = points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  const area = `${padding},${height - padding} ${line} ${width - padding},${height - padding}`;
  return `<div class="cash-chart" role="img" aria-label="روند مانده نقدینگی بر اساس تراکنش‌های ثبت‌شده"><div class="cash-chart-label"><span>روند مانده</span><b>${ordered.length ? `${ordered.length} تراکنش اخیر` : 'بدون تراکنش'}</b></div><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="cash-chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d8d77" stop-opacity=".28"/><stop offset="1" stop-color="#1d8d77" stop-opacity=".02"/></linearGradient></defs><path class="cash-chart-area" d="M ${area} Z"/><polyline class="cash-chart-line" points="${line}"/>${points.map((point, index) => index === points.length - 1 ? `<circle class="cash-chart-dot" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3.5"/>` : '').join('')}</svg></div>`;
}

function renderLanding(): void {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (!app) return;
  preferLoginScreen = false;
  closeAllModals();
  const plans = [
    { name: 'پایه', monthly: 4900000, yearly: 49000000, note: 'برای تیم‌های کوچک و شروع یکپارچه‌سازی', features: ['تا ۵ کاربر', 'مالی و حسابداری پایه', 'فروش و خرید', 'پشتیبانی ایمیلی', 'گزارش‌های استاندارد'], highlight: false, cta: 'شروع دوره آزمایشی' },
    { name: 'حرفه‌ای', monthly: 12900000, yearly: 129000000, note: 'پرطرفدارترین انتخاب شرکت‌های در حال رشد', features: ['تا ۲۵ کاربر', 'تمام ۱۶ ماژول', 'خزانه، انبار و تولید', 'گزارش‌ساز و داشبورد مدیریتی', 'پشتیبانی تلفنی و آنلاین', 'اتصال به API و وب‌هوک'], highlight: true, cta: 'درخواست دمو' },
    { name: 'سازمانی', monthly: 0, yearly: 0, note: 'برای هلدینگ‌ها و سازمان‌های چندشرکتی', features: ['کاربران نامحدود', 'چند شرکت و شعبه', 'گردش کار سفارشی', 'سرور اختصاصی یا ابر خصوصی', 'مدیر موفقیت اختصاصی', 'تطبیق با قوانین مالیاتی'], highlight: false, cta: 'تماس با فروش' },
  ];
  const priceOf = (monthly: number, yearly: number): string => (monthly === 0 ? 'توافقی' : pricingCycle === 'monthly' ? `${money(monthly)} ریال / ماه` : `${money(yearly)} ریال / سال`);
  const heroModules = modules.filter((item) => item.id !== 'overview').slice(0, 8);

  app.innerHTML = `<main class="landing-page">
    <div class="landing-aurora" aria-hidden="true"><span></span><span></span><span></span></div>

    <header class="landing-nav">
      <div class="brand">
        <span class="brand-mark">ر</span>
        <div><strong>راهکار</strong><small>مرکز عملیات سازمان</small></div>
      </div>
      <nav class="nav-center" aria-label="بخش‌های صفحه اصلی">
        <button class="nav-link" data-scroll="features" type="button">ویژگی‌ها</button>
        <button class="nav-link" data-scroll="modules" type="button">ماژول‌ها</button>
        <button class="nav-link" data-scroll="pricing" type="button">قیمت و پلن‌ها</button>
        <button class="nav-link" data-scroll="contact" type="button">ارتباط با ما</button>
      </nav>
      <div class="landing-actions">
        <button class="ghost-button" id="landing-login" type="button">ورود</button>
        <button class="primary-button small" id="landing-start" type="button">شروع رایگان</button>
      </div>
    </header>

    <section class="landing-hero">
      <div class="hero-grid">
        <div class="hero-copy">
          <span class="hero-badge">نسخه ۲۰۲۶ · ERP ابری و یکپارچه</span>
          <h1>تمام عملیات سازمان، از مالی تا تولید، <span class="gradient-text">در یک پلتفرم</span>.</h1>
          <p class="lead">راهکار تمام جریان‌های سازمان را به هم وصل می‌کند: فروش، خرید، انبار، خزانه، حسابداری، منابع انسانی و گزارش‌گیری — با داشبوردی زنده که لحظه‌به‌لحظه از داده‌های واقعی به‌روزرسانی می‌شود.</p>
          <div class="cta-row">
            <button class="primary-button" id="hero-start" type="button">شروع رایگان ۱۴ روزه</button>
            <button class="secondary-button" data-scroll="modules" type="button">مشاهده ماژول‌ها</button>
          </div>
          <ul class="hero-stats">
            <li><strong>۱۶</strong><span>ماژول یکپارچه</span></li>
            <li><strong>۱۲۶+</strong><span>سازمان فعال</span></li>
            <li><strong>۹۹.۹٪</strong><span>دسترس‌پذیری</span></li>
            <li><strong>۲.۴x</strong><span>سرعت اجرای کار</span></li>
          </ul>
        </div>

        <div class="hero-visual" aria-label="نمونه داشبورد راهکار">
          <div class="visual-card main">
            <div class="mini-header"><span>درآمد روزانه</span><strong>+۱۸.۴٪</strong></div>
            <div class="chart-bars">${'<span></span>'.repeat(12)}</div>
            <div class="mini-grid">
              <div><small>درآمد</small><strong>۸۴۵M</strong></div>
              <div><small>خزانه</small><strong>۲.۴B</strong></div>
              <div><small>سفارش باز</small><strong>۲۴</strong></div>
              <div><small>مطالبات</small><strong>۱۲۶M</strong></div>
            </div>
          </div>
          <div class="floating-card card-one"><small>تأیید فاکتور</small><strong>۲۴ مورد</strong></div>
          <div class="floating-card card-two"><small>گزارش BI</small><strong>لحظاتی پیش</strong></div>
        </div>
      </div>

      <div class="hero-chips">
        ${heroModules.map((item) => `<span class="hero-chip"><i>${item.icon}</i>${item.label}</span>`).join('')}
      </div>
    </section>

    <section class="landing-section" id="features">
      <div class="section-title">
        <p class="eyebrow">ویژگی‌های محصول</p>
        <h2>هر آنچه یک سازمان برای کنترل و رشد نیاز دارد</h2>
        <p class="section-sub">از ثبت سند حسابداری تا پیگیری تیکت مشتری، همه‌چیز در یک محیط راست‌چین، سریع و امن.</p>
      </div>
      <div class="bento-grid">
        <article class="bento-card tall">
          <span class="bento-icon">▣</span>
          <h3>هسته‌ی مالی یکپارچه</h3>
          <p>هر رویدادِ فروش، خرید، حقوق، تولید و استهلاک به‌طور خودکار سند حسابداریِ چندردیفه می‌سازد. دفتر کل، معین، تراز آزمایشی، صورت‌های مالی و اظهارنامه‌ی ارزش‌افزوده همیشه با هم هم‌خوان هستند.</p>
          <ul><li>سند خودکار</li><li>دفتر کل و معین</li><li>تراز آزمایشی</li><li>مرکز هزینه</li><li>ارزش افزوده</li></ul>
        </article>
        <article class="bento-card">
          <span class="bento-icon">◈</span>
          <h3>داشبورد زنده</h3>
          <p>شاخص‌ها، کارتابل و رویدادها بر اساس داده‌های واقعی و بدون تأخیر به‌روزرسانی می‌شوند.</p>
        </article>
        <article class="bento-card">
          <span class="bento-icon">↗</span>
          <h3>فروش و CRM</h3>
          <p>سرنخ، فرصت، فاکتور، تیکت و پیگیری مشتری در یک جریان پیوسته و قابل اندازه‌گیری.</p>
        </article>
        <article class="bento-card">
          <span class="bento-icon">□</span>
          <h3>انبار و زنجیره تأمین</h3>
          <p>کنترل موجودی، رسید و حواله، حداقل موجودی و ارزش‌گذاری لحظه‌ای کالا با میانگین موزون یا FIFO.</p>
        </article>
        <article class="bento-card">
          <span class="bento-icon">▥</span>
          <h3>گزارش‌گیری و هوش تجاری</h3>
          <p>نمودارهای تحلیلی، آمار توصیفی، رشد ماهانه و کتابخانه‌ی گزارش‌ها با خروجی Excel و چاپ.</p>
          <ul><li>نمودار SVG</li><li>آمار توصیفی</li><li>خروجی CSV</li></ul>
        </article>
        <article class="bento-card wide">
          <span class="bento-icon">🔒</span>
          <h3>امنیت و کنترل دسترسی</h3>
          <p>نقش‌ها و مجوزهای دقیق، رمزنگاریِ نشست، ثبت رخدادهای حسابرسی و پشتیبان‌گیری و بازگردانی؛ هر کاربر فقط همان چیزی را می‌بیند که مجوز دارد.</p>
          <ul><li>نقش و مجوز</li><li>لاگ حسابرسی</li><li>پشتیبان‌گیری</li><li>کنترل دسترسی</li></ul>
        </article>
      </div>
    </section>

    <section class="landing-section alt" id="modules">
      <div class="section-title">
        <p class="eyebrow">ماژول‌ها</p>
        <h2>۱۶ ماژول آماده، متصل به یک هسته مشترک</h2>
        <p class="section-sub">هر ماژول صفحه، کارتابل، فرم ثبت و گزارش خودش را دارد و رویدادهایش به حسابداری متصل می‌شود.</p>
      </div>
      <div class="module-showcase" role="list">
        ${modules.filter((item) => item.id !== 'overview').map((item, index) => {
          const guide = moduleGuides[item.id];
          return `<button class="showcase-card" data-module-guide="${item.id}" type="button" role="listitem" aria-label="آشنایی با ماژول ${item.label}">
            <span class="showcase-number">${String(index + 1).padStart(2, '۰')}</span>
            <span class="showcase-icon">${item.icon}</span>
            <span class="showcase-content"><strong>${item.label}</strong><small>${guide?.summary ?? item.note}</small></span>
            <span class="showcase-link">آشنایی با ماژول <b>←</b></span>
          </button>`;
        }).join('')}
      </div>
    </section>

    <section class="landing-section" id="install">
      <div class="install-strip reveal">
        <div>
          <p class="eyebrow">نسخهٔ قابل نصب</p>
          <h2>راهکار روی موبایل و دسکتاپ شما هم آماده است</h2>
          <p>با گزینهٔ نصبِ خودِ مرورگر، راهکار را مثل یک برنامهٔ مستقل باز کنید؛ صفحه‌ها و فونت‌ها برای ادامهٔ کار در زمان قطع اینترنت هم آماده می‌مانند.</p>
        </div>
        <span class="install-native-note">⌘ گزینهٔ نصب در منوی مرورگر</span>
      </div>
    </section>

    <section class="landing-section" id="faq">
      <div class="section-head reveal">
        <span class="section-kicker-landing">پرسش‌های پرتکرار</span>
        <h2>پاسخِ کوتاه به پرسش‌های مهم شما</h2>
      </div>
      <div class="faq-layout reveal">
        <aside class="faq-aside">
          <span class="faq-aside-icon">؟</span>
          <p class="eyebrow">شروعی روشن</p>
          <h3>برای شروع لازم نیست متخصص نرم‌افزار باشید.</h3>
          <p>هر بخش با نام‌های ساده طراحی شده است؛ تیم شما می‌تواند قدم‌به‌قدم کار روزانه‌اش را در یک جریان مشخص انجام دهد.</p>
          <div class="faq-contact-card"><span>هنوز پرسشی دارید؟</span><button class="text-button" data-scroll="contact" type="button">با ما در تماس باشید ←</button></div>
        </aside>
        <div class="faq-list">
          <details class="faq-item" open><summary>آیا داده‌های من روی دستگاه خودم می‌ماند؟</summary><div>بله. می‌توانید اطلاعات را در محیط اختصاصی سازمان خود نگه دارید؛ دسترسی کاربران هم با نقش و مجوز کنترل می‌شود.</div></details>
          <details class="faq-item"><summary>چقدر زمان می‌برد تا راه بیفتیم؟</summary><div>شروع کار ساده است: ابتدا شرکت، سال مالی و کاربران را تعریف می‌کنید، سپس اطلاعات اولیه مانند کالاها و مانده‌ها را وارد می‌کنید.</div></details>
          <details class="faq-item"><summary>آیا با سامانه‌ی مودیان و ارزش‌افزوده کار می‌کند؟</summary><div>فاکتورهای فروش برای پیگیری مالیات آماده می‌شوند و وضعیت ارسال و خطاها در یک صف قابل مشاهده است.</div></details>
          <details class="faq-item"><summary>تعداد کاربران محدود است؟</summary><div>هر پلن برای اندازه مشخصی از تیم طراحی شده است؛ با رشد سازمان می‌توانید پلن مناسب‌تری انتخاب کنید.</div></details>
          <details class="faq-item"><summary>پشتیبانی چگونه است؟</summary><div>به‌روزرسانی، پشتیبان‌گیری و امنیت در همه پلن‌ها در نظر گرفته شده و سطح پاسخ‌گویی متناسب با پلن انتخابی شماست.</div></details>
        </div>
      </div>
    </section>

    <section class="landing-section" id="pricing">
      <div class="section-title">
        <p class="eyebrow">قیمت و پلن‌ها</p>
        <h2>پلنی متناسب با اندازه و نیاز سازمان شما</h2>
        <p class="section-sub">همه پلن‌ها شامل به‌روزرسانی، پشتیبان‌گیری و امنیت سازمانی هستند.</p>
        <button class="pricing-toggle" id="pricing-toggle" type="button">
          <span class="${pricingCycle === 'monthly' ? 'active' : ''}">ماهانه</span>
          <span class="${pricingCycle === 'yearly' ? 'active' : ''}">سالانه (۲ ماه تخفیف)</span>
        </button>
      </div>
      <div class="pricing-grid">
        ${plans.map((plan, index) => `<article class="pricing-card ${plan.highlight ? 'highlight' : ''}">
          <div class="pricing-card-top"><span class="plan-index">پلن ${String(index + 1).padStart(2, '۰')}</span>${plan.highlight ? '<span class="pricing-ribbon">پیشنهاد ویژه</span>' : ''}</div>
          <h3>${plan.name}</h3>
          <p class="pricing-note">${plan.note}</p>
          <div class="pricing-price-wrap"><span>هزینه اشتراک</span><p class="pricing-price">${priceOf(plan.monthly, plan.yearly)}</p></div>
          <ul>${plan.features.map((feature) => `<li><span>✓</span>${feature}</li>`).join('')}</ul>
          <button class="${plan.highlight ? 'primary-button' : 'secondary-button'} pricing-cta" data-scroll="contact" type="button">${plan.cta}<span>←</span></button>
        </article>`).join('')}
      </div>
    </section>

    <section class="landing-section alt" id="contact">
      <div class="contact-grid">
        <div class="contact-info">
          <p class="eyebrow">ارتباط با ما</p>
          <h2>۱۳ روز آزمایشی رایگان، بدون نیاز به کارت بانکی</h2>
          <p class="section-sub">فرم را پر کنید تا کارشناس ما با شما تماس بگیرد و نسخه متناسب صنعت شما را معرفی کند.</p>
          <ul class="contact-details">
            <li><span>📍</span><div><strong>دفتر مرکزی</strong><small>تهران، خیابان ولیعصر، برج سازمان، طبقه ۱۴</small></div></li>
            <li><span>☎</span><div><strong>تماس مستقیم</strong><small>۰۲۱-۸۸۰۰۰۰۰۰ · داخلی ۲۱۴</small></div></li>
            <li><span>✉</span><div><strong>ایمیل فروش</strong><small>sales@rahkar-erp.ir</small></div></li>
            <li><span>🕘</span><div><strong>ساعات پاسخگویی</strong><small>شنبه تا چهارشنبه ۹ تا ۱۸ · پنجشنبه ۹ تا ۱۳</small></div></li>
          </ul>
        </div>
        <form class="contact-form" id="contact-form">
          <label>نام و نام خانوادگی<input name="name" required placeholder="مثلاً حسین صادقی" /></label>
          <label>نام سازمان<input name="company" placeholder="مثلاً گروه صنعتی آریا" /></label>
          <label>ایمیل سازمانی<input name="email" type="email" required placeholder="name@company.ir" /></label>
          <label>توضیحات<textarea name="message" rows="4" required placeholder="تعداد کاربران، صنعت و نیاز اصلی خود را بنویسید"></textarea></label>
          <button class="primary-button" type="submit">ارسال درخواست</button>
          <small class="form-note">پیام شما محلی ذخیره می‌شود و پس از اتصال به سرور برای تیم فروش ارسال خواهد شد.</small>
        </form>
      </div>
    </section>

    <footer class="landing-footer">
      <div class="footer-brand">
        <span class="brand-mark">ر</span>
        <div><strong>راهکار</strong><small>سیستم یکپارچه برنامه‌ریزی سازمان</small></div>
      </div>
      <div class="footer-links">
        <div><h4>محصول</h4><button class="footer-link" data-scroll="features" type="button">ویژگی‌ها</button><button class="footer-link" data-scroll="modules" type="button">ماژول‌ها</button><button class="footer-link" data-scroll="pricing" type="button">قیمت‌ها</button></div>
        <div><h4>شرکت</h4><button class="footer-link" data-scroll="contact" type="button">تماس با ما</button><button class="footer-link" data-scroll="contact" type="button">درخواست دمو</button><button class="footer-link" id="footer-login" type="button">ورود به پنل</button></div>
        <div><h4>پشتیبانی</h4><span>۰۲۱-۸۸۰۰۰۰۰۰</span><span>sales@rahkar-erp.ir</span><span>دانشنامه و راهنما</span></div>
      </div>
      <p class="footer-copy">© ۱۴۰۵–۲۰۲۶ راهکار · تمام حقوق محفوظ است.</p>
    </footer>
    <div class="toast" id="toast" role="status"></div>
  </main>`;

  const scrollTo = (id: string) => document.querySelector(`#${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelectorAll<HTMLButtonElement>('[data-scroll]').forEach((button) => button.addEventListener('click', () => scrollTo(button.dataset.scroll ?? 'features')));
  // ظاهر شدنِ تدریجیِ بخش‌ها هنگامِ اسکرول
  setupScrollReveal();
  document.querySelector<HTMLButtonElement>('#landing-login')?.addEventListener('click', renderLogin);
  document.querySelector<HTMLButtonElement>('#footer-login')?.addEventListener('click', renderLogin);
  document.querySelector<HTMLButtonElement>('#landing-start')?.addEventListener('click', renderLogin);
  document.querySelector<HTMLButtonElement>('#hero-start')?.addEventListener('click', renderLogin);
  document.querySelectorAll<HTMLButtonElement>('[data-module-guide]').forEach((button) =>
    button.addEventListener('click', () => openModuleGuide(button.dataset.moduleGuide ?? '')),
  );
  document.querySelector<HTMLButtonElement>('#pricing-toggle')?.addEventListener('click', () => { pricingCycle = pricingCycle === 'monthly' ? 'yearly' : 'monthly'; renderLanding(); scrollTo('pricing'); });
  document.querySelector<HTMLFormElement>('#contact-form')?.addEventListener('submit', saveContact);
}
function renderLogin(): void {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (!app) return;
  closeAllModals();
  const quickAccounts = [
    { username: 'admin', password: 'admin123', title: 'مدیر سیستم', note: 'دسترسی کامل' },
    { username: 'hesabdari', password: '1234', title: 'حسابدار', note: 'مالی' },
    { username: 'foroosh', password: '1234', title: 'فروش', note: 'فروش و CRM' },
    { username: 'anbar', password: '1234', title: 'انباردار', note: 'انبار و خرید' },
  ];
  app.innerHTML = `<main class="login-page-modern">
    <section class="login-left">
      <div class="login-left-content">
        <div class="login-left-header">
          <span class="brand-mark-large" aria-hidden="true"><b>ر</b></span>
          <div><h1>راهکار</h1><small>سیستم یکپارچه عملیات سازمان</small></div>
        </div>
        <p class="login-lead">مالی، فروش، انبار، تولید و منابع انسانی در یک پلتفرم امن و یکپارچه.</p>
        <div class="login-value-props">
          <article><span class="prop-icon">◈</span><div><strong>گردش کار چندمرحله‌ای</strong><small>تأیید، رد و صدور سند حسابداری به‌طور خودکار</small></div></article>
          <article><span class="prop-icon">◉</span><div><strong>گزارش‌های مالی استاندارد</strong><small>ترازنامه، سود و زیان، دفتر کل و معین</small></div></article>
          <article><span class="prop-icon">◆</span><div><strong>کنترل دسترسی بر اساس نقش</strong><small>هر کاربر فقط بخش‌های مجاز خود را می‌بیند</small></div></article>
        </div>
        <div class="login-trusted">
          <p class="eyebrow">مورد اعتماد شرکت‌های ایرانی</p>
          <div class="trust-logos">
            <span class="logo-chip"><i class="logo-mark">آ</i>گروه صنعتی آریا</span>
            <span class="logo-chip"><i class="logo-mark">ص</i>شرکت صادراتی</span>
            <span class="logo-chip"><i class="logo-mark">پ</i>شرکت پذیرایی</span>
          </div>
        </div>
      </div>
    </section>

    <section class="login-right">
      <div class="login-card">
        <div class="login-card-head">
          <span class="brand-mark login-brand-mark" aria-hidden="true"><b>ر</b></span>
          <h2>ورود به سیستم</h2>
          <p>نام کاربری و رمز عبور خود را وارد کنید</p>
        </div>
        ${demoMode ? '<p class="demo-note">این نسخه‌ی نمایشیِ آنلاین است؛ بدون سرور و بدون ثبت‌نام. داده‌ها فقط در مرورگرِ شما می‌مانند.</p>' : ''}

        <form id="login-form" class="login-form-modern" novalidate>
          <div class="form-group">
            <label for="username">نام کاربری</label>
            <div class="input-wrap">
              <span class="input-icon" aria-hidden="true">◍</span>
              <input id="username" name="username" required value="admin" autocomplete="username" placeholder="نام کاربری" class="form-input">
            </div>
          </div>

          <div class="form-group">
            <label for="password">رمز عبور</label>
            <div class="input-wrap">
              <span class="input-icon" aria-hidden="true">◉</span>
              <input id="password" name="password" type="password" required value="admin123" autocomplete="current-password" placeholder="رمز عبور" class="form-input">
              <button type="button" class="password-toggle" id="toggle-password" aria-label="نمایش رمز عبور" aria-pressed="false" title="نمایش رمز عبور"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg></button>
            </div>
          </div>

          <div class="form-row-between">
            <label class="remember"><input type="checkbox" id="remember-me" checked> مرا یاد بسپار</label>
            <a href="#" class="forgot-link">فراموشی رمز عبور</a>
          </div>

          <button class="primary-button login-submit" type="submit">ورود</button>
        </form>

        <div class="google-signin" id="google-signin" hidden></div>

        <div class="login-divider"><span>ورود سریع با حساب نمایشی</span></div>
        <div class="login-quick">
          ${quickAccounts
            .map(
              (account) => `<button type="button" class="quick-user" data-quick-user="${account.username}" data-quick-pass="${account.password}">
                <span class="quick-avatar">${account.title.charAt(0)}</span>
                <span class="quick-text"><strong>${account.title}</strong><small>${account.note}</small></span>
              </button>`,
            )
            .join('')}
        </div>

        <p class="login-foot">ارتباط با سرور رمزنگاری شده است · نسخه ۲.۰</p>
      </div>
      <button type="button" class="back-link" id="login-back">→ بازگشت به صفحه اصلی</button>
    </section>
  </main>`;

  document.querySelector<HTMLFormElement>('#login-form')?.addEventListener('submit', (event) => void login(event, document.querySelector<HTMLInputElement>('#remember-me')?.checked ?? false));
  void setupGoogleSignIn();
  document.querySelector<HTMLButtonElement>('#toggle-password')?.addEventListener('click', togglePasswordVisibility);
  document.querySelector<HTMLButtonElement>('#login-back')?.addEventListener('click', renderLanding);
  document.querySelectorAll<HTMLButtonElement>('[data-quick-user]').forEach((button) =>
    button.addEventListener('click', () => {
      const usernameInput = document.querySelector<HTMLInputElement>('#username');
      const passwordInput = document.querySelector<HTMLInputElement>('#password');
      if (usernameInput) usernameInput.value = button.dataset.quickUser ?? '';
      if (passwordInput) passwordInput.value = button.dataset.quickPass ?? '';
      document.querySelector<HTMLFormElement>('#login-form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }),
  );
}

/**
 * ورود با حساب گوگل (در صورت فعال‌بودن در تنظیماتِ سرور/محیط).
 * اگر کلیدِ گوگل تنظیم نشده باشد، هیچ چیزی نمایش داده نمی‌شود و برنامه
 * دقیقاً مثل قبل کار می‌کند.
 */
let googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

async function fetchAuthConfig(): Promise<void> {
  if (demoMode || googleClientId) return;
  try {
    const result = await fetch(`${API_BASE}/api/auth/config`);
    if (!result.ok) return;
    const config = (await result.json()) as { google?: boolean; googleClientId?: string };
    if (config.google && config.googleClientId) googleClientId = config.googleClientId;
  } catch { /* نبودِ سرور یا تنظیمات: ورود با گوگل غیرفعال می‌ماند */ }
}

type GoogleCredentialResponse = { credential?: string };

function renderGoogleButton(): void {
  const holder = document.querySelector<HTMLDivElement>('#google-signin');
  if (!holder || !googleClientId) return;
  holder.hidden = false;
  holder.innerHTML = '<div id="gsi-button"></div>';
  const api = (window as unknown as { google?: { accounts?: { id?: { initialize: (options: Record<string, unknown>) => void; renderButton: (element: HTMLElement, options: Record<string, unknown>) => void } } } }).google;
  if (!api?.accounts?.id) return;
  api.accounts.id.initialize({
    client_id: googleClientId,
    callback: (response: GoogleCredentialResponse) => void signInWithGoogle(String(response.credential ?? '')),
    locale: 'fa',
  });
  const target = holder.querySelector<HTMLElement>('#gsi-button');
  if (target) api.accounts.id.renderButton(target, { theme: 'outline', size: 'large', width: 320, text: 'signin_with', locale: 'fa' });
}

/** بارگذاریِ کتابخانه‌ی گوگل و نمایشِ دکمه */
async function setupGoogleSignIn(): Promise<void> {
  if (demoMode) return;
  await fetchAuthConfig();
  if (!googleClientId) return;
  const loadScript = (): Promise<void> => new Promise((resolve) => {
    if ((window as unknown as { google?: { accounts?: unknown } }).google?.accounts) { resolve(); return; }
    const existing = document.querySelector<HTMLScriptElement>('#google-gsi');
    if (existing) { existing.addEventListener('load', () => resolve()); return; }
    const script = document.createElement('script');
    script.id = 'google-gsi';
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.appendChild(script);
  });
  await loadScript();
  renderGoogleButton();
}

/** ارسالِ توکنِ گوگل به سرور و دریافتِ نشست */
async function signInWithGoogle(credential: string): Promise<void> {
  if (!credential) { showLoginError('ورود با گوگل انجام نشد؛ دوباره تلاش کنید.'); return; }
  try {
    const result = await fetch(`${API_BASE}/api/auth/google`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    const body = (await result.json().catch(() => ({}))) as { user?: Session; token?: string; refreshToken?: string; error?: string };
    if (!result.ok || !body.user || !body.token || !body.refreshToken) {
      showLoginError(body.error ?? 'ورود با گوگل ممکن نیست. از مدیر سیستم بخواهید حساب شما را فعال کند.');
      return;
    }
    applyServerSession(body.user, body.token, body.refreshToken);
    await loadServerData(true);
    render();
    showToast(`خوش آمدید، ${body.user.name}`);
  } catch {
    showLoginError('ارتباط با سرور برقرار نشد.');
  }
}

async function login(event: SubmitEvent, remember = false): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const username = String(data.get('username') ?? '');
  const password = String(data.get('password') ?? '');
  const submit = form.querySelector<HTMLButtonElement>('.login-submit');
  if (submit) { submit.disabled = true; submit.textContent = 'در حال ورود…'; }
  if (demoMode) {
    // ورودِ بی‌نیاز از سرور با همان نقش‌ها و دسترسی‌های نسخه‌ی اصلی
    const account = demoLogin(username, password);
    if (!account) { resetLoginButton(); showLoginError('در نسخه‌ی نمایشی یکی از کاربرانِ معرفی‌شده در پایین صفحه را انتخاب کنید.'); return; }
    session = account;
    localStorage.setItem('erp-session', JSON.stringify(session));
    serverSession = false;
    sessionChecked = true;
    hydrateLocalState();
    seedDemoData();
    render();
    showToast(`نسخه‌ی نمایشی - ورود با نقشِ «${account.role}»`);
    return;
  }
  try {
    const result = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, remember }),
    });
    if (!result.ok) {
      resetLoginButton();
      /**
       * پیامِ خطا باید علتِ واقعی را بگوید. پیش‌تر هر پاسخِ ناموفقی «نام کاربری یا رمز عبور
       * صحیح نیست» نشان داده می‌شد؛ در حالی که وقتی سرورِ API بالا نیامده و پروکسیِ توسعه
       * (Vite) پاسخِ ۵۰۲/۵۰۰ می‌دهد، کاربر با رمزِ درست هم همین پیام را می‌دید و سردرگم می‌شد.
       */
      const body = (await result.json().catch(() => ({}))) as { error?: string };
      if (result.status === 401) showLoginError(body.error ?? 'نام کاربری یا رمز عبور صحیح نیست.');
      else if (result.status === 429) showLoginError(body.error ?? 'تلاش‌های ورود زیاد بود؛ چند دقیقه دیگر دوباره تلاش کنید.');
      else if (result.status >= 500 || result.status === 404) showLoginError(`سرورِ برنامه در دسترس نیست (کد ${result.status}). مطمئن شوید سرویسِ API اجرا شده است.`);
      else showLoginError(body.error ?? `ورود ناموفق بود (کد ${result.status}).`);
      return;
    }
    const payload = (await result.json()) as { user: Session; token: string; refreshToken: string };
    applyServerSession(payload.user, payload.token, payload.refreshToken);
    void afterSessionEstablished();
    hydrateLocalState();
    render();
  } catch (error) {
    resetLoginButton();
    // بدونِ سرور ورودی انجام نمی‌شود؛ داده‌ها فقط روی سرور نگه داشته می‌شوند
    showLoginError(`ارتباط با سرور برقرار نشد (${(error as Error).message}). مطمئن شوید سرویسِ API اجرا شده است.`);
  }
}

/** ذخیره‌ی نشست سرور شامل توکن دسترسی و تازه‌سازی */
function applyServerSession(user: Session, token: string, refreshToken: string): void {
  authPromptShown = false;
  userLoggedOut = false;
  session = user;
  localStorage.setItem('erp-session', JSON.stringify(user));
  localStorage.setItem(tokenKey, token);
  if (refreshToken) localStorage.setItem(refreshKey, refreshToken);
  serverSession = true;
  sessionChecked = true;
  sessionExpiredNotified = false;
}

/**
 * تلاش برای تازه‌سازی خودکار نشست با توکن بلندمدت.
 * نکته‌ی مهم: اگر چند درخواست هم‌زمان با خطای ۴۰۱ مواجه شوند، همه با هم تازه‌سازی
 * نمی‌کنند؛ فقط یک درخواست انجام می‌شود و بقیه منتظر همان نتیجه می‌مانند
 * (در غیر این صورت استفاده‌ی هم‌زمان از یک توکن به‌عنوان «سرقت» شناسایی می‌شد).
 */
/**
 * کانالِ گفت‌وگو بین تب‌های بازِ برنامه.
 * اگر دو تب هم‌زمان یکی توکنِ تازه‌سازی را مصرف کند، پیش از این یکی به‌عنوان
 * «سرقتِ توکن» شناسایی می‌شد و نشستِ هر دو تب می‌پرید. حالا تب‌ها نشستِ تازه را
 * با هم به اشتراک می‌گذارند و هیچ کدام از کار نمی‌افتند.
 */
const sessionChannel: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('rahkar-session') : null;
sessionChannel?.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; token?: string; refreshToken?: string } | null;
  if (data?.type === 'session' && data.token && data.refreshToken) {
    // فقط وقتی توکنِ دریافتی تازه‌تر است می‌پذیریم تا تبِ عقب‌مانده تبِ جلو را عقب نکشد
    const incomingExpiry = expiryOf(data.token);
    const stored = localStorage.getItem('erp-session');
    const user = session ?? (stored ? (JSON.parse(stored) as Session) : null);
    if (user && !refreshInFlight && incomingExpiry > tokenExpiresAt()) applyServerSession(user, data.token, data.refreshToken);
  }
});
sessionChannel?.addEventListener('messageerror', () => undefined);

/** زمانِ انقضای یک توکنِ خام (برای مقایسه‌ی توکنِ تبِ دیگر) */
function expiryOf(token: string): number {
  const part = token?.split('.')[1];
  if (!part) return 0;
  try {
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch { return 0; }
}

/**
 * شناسه‌ی سرویس و اثرِ کلیدِ امضا در آخرین پاسخ.
 * اگر این دو میانِ دو درخواست عوض شوند، یعنی سرویس عوض شده است (میزبانیِ موقت،
 * چند نمونه یا راه‌اندازیِ دوباره) نه اینکه نشستِ کاربر پایان یافته باشد.
 */
let lastServerId: string | null = null;
let lastSecretId: string | null = null;
let serverRestarted = false;
function noteServerId(server: string | null, secret: string | null): void {
  if (!server && !secret) return;
  if (lastSecretId && secret && secret !== lastSecretId) serverRestarted = true;
  else if (lastServerId && server && server !== lastServerId) serverRestarted = true;
  if (server) lastServerId = server;
  if (secret) lastSecretId = secret;
}

/** آخرین زمانِ تازه‌سازیِ نشست (برای جلوگیری از تازه‌سازیِ پیاپی در حلقه) */
let lastRefreshAt = 0;
let refreshInFlight: Promise<boolean> | null = null;
/**
 * نشست را تازه می‌کند.
 * @param silent تازه‌سازیِ پنهان در میانِ یک درخواست: در این حالت هیچ بارگذاریِ
 *   داده‌ای راه نمی‌افتد؛ در غیر این صورت یک پاسخِ ۴۰۱ِ ساده می‌توانست زنجیره‌ای
 *   از «تازه‌سازی ← بارگذاریِ همه‌ی داده‌ها ← ۴۰۱ِ دوباره» بسازد و برنامه را قفل کند.
 */
function refreshSession(silent = false): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshSessionOnce(silent).finally(() => { refreshInFlight = null; lastRefreshAt = Date.now(); });
  return refreshInFlight;
}

/** اجرای واقعیِ تازه‌سازی نشست (فقط از طریق refreshSession صدا زده می‌شود) */
async function refreshSessionOnce(silent = false): Promise<boolean> {
  // پس از خروجِ دستی، هیچ تلاشی برای بازگشتِ خودکار انجام نمی‌شود
  if (userLoggedOut) return false;
  const refreshToken = localStorage.getItem(refreshKey);
  if (!refreshToken) return false;
  try {
    const result = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (result.status === 401 || result.status === 403) {
      /**
       * یک تلاشِ دوباره و کوتاه: اگر تبِ دیگری همین لحظه نشست را تازه کرده باشد،
       * توکنِ ما ممکن است یک لحظه عقب‌افتاده باشد. با اندکی مکث دوباره امتحان می‌کنیم
       * و فقط در صورت تکرارِ خطا نشست را می‌بندیم.
       */
      await new Promise((resolve) => setTimeout(resolve, 700));
      const retry = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }).catch(() => null);
      if (retry?.ok) {
        const body = (await retry.json()) as { user: Session; token: string; refreshToken: string };
        applyServerSession(body.user, body.token, body.refreshToken);
        return true;
      }
      /**
       * نشستِ سرور در دسترس نیست (سرور راه‌اندازیِ دوباره شده، کلید عوض شده یا نشست
       * واقعاً پایان یافته است). به جای ادامه در «حالت محلی»، صفحه‌ی ورود نشان داده
       * می‌شود تا داده‌ها فقط روی سرور ثبت شوند.
       */
      serverSession = false;
      sessionChecked = true;
      forceRelogin(serverRestarted
        ? 'سرویس راه‌اندازیِ دوباره شده است؛ لطفاً دوباره وارد شوید.'
        : 'نشست شما پایان یافته است؛ برای ادامه دوباره وارد شوید.');
      return false;
    }
    if (!result.ok) return false;
    const payload = (await result.json()) as { user: Session; token: string; refreshToken: string };
    applyServerSession(payload.user, payload.token, payload.refreshToken);
    sessionChannel?.postMessage({ type: 'session', token: payload.token, refreshToken: payload.refreshToken });
      if (!silent) void afterSessionEstablished();
    return true;
  } catch {
    return false;
  }
}

function loginDemo(event: Event): void { event.preventDefault(); session = { username: 'demo', name: 'کاربر نمایشی', role: 'مشاهده‌کننده', organization: 'گروه صنعتی آریا' }; localStorage.setItem('erp-session', JSON.stringify(session)); render(); }
function showLoginError(message: string): void { const old = document.querySelector('.login-error'); old?.remove(); document.querySelector<HTMLFormElement>('#login-form')?.insertAdjacentHTML('afterbegin', `<p class="login-error">${message}</p>`); }
function logout(): void {
  userLoggedOut = true;
  const refresh = localStorage.getItem(refreshKey);
  const token = authToken();
  // ابطالِ نشست در سمت سرور (توکن تازه‌سازی دیگر قابل استفاده نخواهد بود)
  if (refresh && !demoMode) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...authHeaders(token) };
    void fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ refreshToken: refresh }) }).catch(() => undefined);
  }
  session = null;
  serverSession = false;
  sessionChecked = true;
  sessionExpiredNotified = false;
  authPromptShown = false;
  // پاک‌سازیِ همه‌ی نشانه‌های نشست (توکن دسترسی، تازه‌سازی و داده‌ی کاربر)
  localStorage.removeItem('erp-session');
  localStorage.removeItem(tokenKey);
  localStorage.removeItem('erp-token');
  localStorage.removeItem(refreshKey);
  localStorage.removeItem('erp-last-user');
  localStorage.removeItem('erp-organization-id');
  workspaceLoaded = false;
  workspacePending = {};
  hydrateLocalState();
  preferLoginScreen = true;
  renderLogin();
}

type DashboardTask = { id: string; title: string; moduleId: string; module: string; priority: 'فوری' | 'مهم' | 'عادی'; hint: string; amount: number; server?: boolean; status?: string };

/** اسناد دارای گردش کار که روی سرور نگه‌داری می‌شوند */
type ServerDocument = { id: string; number: number; title: string; moduleId: string; amount: number; priority: string; status: string; history: Array<{ at: string; actor: string; action: string; from: string; to: string; comment?: string }>; periodId?: string; costCenterId?: string; createdBy?: string; createdAt: string };
type FiscalPeriod = { id: string; year: number; index: number; title: string; startsOn: string; endsOn: string; status: string };
type CostCenter = { id: string; code: string; title: string; isActive: boolean };
type WorkflowTransition = { action: string; to: string; label: string; permission: string };
type ServerJournalLine = { accountCode: string; accountTitle: string; debit: number; credit: number; costCenter?: string };
type JournalEntry = { id: string; number: number; description: string; sourceType: string; moduleId?: string; lines: ServerJournalLine[]; totalDebit: number; totalCredit: number; status: string; createdBy?: string; createdAt: string; postedAt?: string };
type TrialBalanceRow = { code: string; title: string; debit: number; credit: number; balance: number };
type FinancialSummary = { postedEntries: number; draftEntries: number; totalDebit: number; totalCredit: number; balanced: boolean };

let serverDocuments: ServerDocument[] = [];
let fiscalPeriods: FiscalPeriod[] = [];
let costCenters: CostCenter[] = [];
let workflowTransitions: Record<string, WorkflowTransition[]> = {};
/** اسناد حسابداری صادرشده روی سرور (فاز ۲) */
let journalEntries: JournalEntry[] = [];
let trialBalance: TrialBalanceRow[] = [];
let financialSummary: FinancialSummary | null = null;
let costingMethod: 'wac' | 'fifo' = 'wac';
let inventoryCosting: { method: string; rows: Array<{ itemId: string; itemTitle: string; quantity: number; unitCost: number; value: number }>; totalValue: number } | null = null;
let stockMovements: Array<{ id: string; itemTitle: string; date: string; type: string; quantity: number; unitCost: number; costAmount: number }> = [];
let bankReconciliation: {
  statements: Array<{ id: string; date: string; description: string; amount: number; direction: string; matchedEntryId?: string }>;
  ledger: Array<{ entryId: string; entryNumber: number; amount: number; direction: string; description: string }>;
  matched: Array<{ statement: { id: string; description: string; amount: number; direction: string }; line: { entryNumber: number } }>;
  suggestions: Array<{ statementId: string; entryId: string; amount: number; confidence: number }>;
  unmatchedStatements: Array<{ id: string }>;
} | null = null;
let syncingServerData = false;

/** فهرست زنده‌ی کارهایی که از داده‌های واقعی هر ماژول استخراج می‌شود */
function pendingTasks(): DashboardTask[] {
  const tasks: DashboardTask[] = [];
  savedRecords.filter((record) => record.status !== 'تأیید شده').forEach((record) => {
    tasks.push({ id: record.id, title: record.title, moduleId: moduleIdByLabel.get(record.category) ?? 'overview', module: record.category, priority: 'مهم', hint: `${record.owner} · ${record.date}`, amount: Number(String(record.amount).replace(/[^\d]/g, '')) || 0 });
  });
  purchaseOrders.filter((order) => order.status !== 'تأیید شده').forEach((order) => {
    tasks.push({ id: order.id, title: `سفارش خرید ${order.orderNumber} · ${order.supplierName}`, moduleId: 'purchasing', module: 'خرید و تدارکات', priority: 'فوری', hint: `${order.quantity} × ${money(order.unitPrice)} ریال`, amount: order.total });
  });
  salesInvoices.filter((invoice) => invoice.status !== 'تأیید شده').forEach((invoice) => {
    tasks.push({ id: invoice.id, title: `فاکتور فروش ${invoice.invoiceNumber} · ${invoice.customerName}`, moduleId: 'sales', module: 'فروش', priority: 'مهم', hint: 'منتظر تأیید و صدور سند', amount: invoice.total });
  });
  treasuryTransactions.filter((item) => item.status !== 'تأیید شده').forEach((item) => {
    tasks.push({ id: item.id, title: `${item.transactionType === 'receipt' ? 'دریافت' : 'پرداخت'} · ${item.accountTitle}`, moduleId: 'treasury', module: 'خزانه‌داری', priority: 'عادی', hint: item.bankOrCash, amount: item.amount });
  });
  journals.filter((journal) => journal.status !== 'تأیید شده').forEach((journal) => {
    tasks.push({ id: journal.id, title: `سند حسابداری ${journal.number}`, moduleId: 'accounting', module: 'مالی و حسابداری', priority: 'عادی', hint: journal.description, amount: journal.lines.reduce((sum, line) => sum + line.debit, 0) });
  });
  serverDocuments.filter((document) => !['قطعی', 'ردشده'].includes(document.status)).forEach((document) => {
    const module = modules.find((item) => item.id === document.moduleId);
    tasks.push({
      id: document.id,
      title: `سند ${document.number} · ${document.title}`,
      moduleId: document.moduleId,
      module: module?.label ?? 'عملیات',
      priority: document.priority === 'فوری' ? 'فوری' : document.priority === 'مهم' ? 'مهم' : 'عادی',
      hint: `گردش کار: ${document.status} · ${document.createdBy ?? '—'}`,
      amount: document.amount,
      server: true,
      status: document.status,
    });
  });
  const order = { 'فوری': 0, 'مهم': 1, 'عادی': 2 } as const;
  return tasks.sort((left, right) => order[left.priority] - order[right.priority]);
}

/** تأیید یک کار از هر ماژولی که باشد؛ بلافاصله در داشبورد و کارتابل اثر می‌گذارد */
function approveTask(id: string): void {
  const record = savedRecords.find((item) => item.id === id);
  const order = purchaseOrders.find((item) => item.id === id);
  const invoice = salesInvoices.find((item) => item.id === id);
  const treasury = treasuryTransactions.find((item) => item.id === id);
  const journal = journals.find((item) => item.id === id);
  const ticket = crmTickets.find((item) => item.id === id);
  if (record) record.status = 'تأیید شده';
  if (order) order.status = 'تأیید شده';
  if (invoice) invoice.status = 'تأیید شده';
  if (treasury) treasury.status = 'تأیید شده';
  if (journal) journal.status = 'تأیید شده';
  if (ticket) ticket.status = 'بررسی شد';
  store('erp-records', savedRecords); store('erp-purchases', purchaseOrders); store('erp-sales', salesInvoices);
  store('erp-treasury', treasuryTransactions); store('erp-journals', journals); store('erp-crm-tickets', crmTickets);
  render();
  showToast('وضعیت به «تأیید شده» تغییر کرد و همه‌جا به‌روزرسانی شد.');
}

function gotoModule(moduleId: string): void {
  activeModule = modules.some((item) => item.id === moduleId) ? moduleId : 'overview';
  query = '';
  render();
}

/** کارتابل مشترک که زیر صفحه‌ی هر ماژول نمایش داده می‌شود */
function worklistMarkup(current: Module): string {
  const records = savedRecords.filter((record) => record.category === current.label);
  return `<section class="panel worklist-panel">
    <div class="panel-heading">
      <div><h3>کارتابل ${current.label}</h3><p>هر رکوردی که اینجا ثبت کنید، بلافاصله در داشبورد، گردش کار و گزارش‌ها دیده می‌شود.</p></div>
      <span class="count">${records.length} رکورد</span>
    </div>
    ${records.length ? `<div class="record-list">${records.map((record) => `<div class="record-row"><div><strong>${escapeHtml(record.title)}</strong><small>${escapeHtml(record.feature)} · ${record.date} · ${escapeHtml(record.owner)} ${record.isDemo ? '· داده نمونه آموزشی' : ''}</small></div><b class="record-amount">${escapeHtml(record.amount)} ریال</b><span class="status ${record.status === 'تأیید شده' ? 'approved' : 'pending'}">${record.status}</span><div class="record-actions">${record.status !== 'تأیید شده' ? `<button data-action="approve" data-id="${record.id}">تأیید</button>` : ''}<button data-action="delete" data-id="${record.id}">حذف</button></div></div>`).join('')}</div>` : '<div class="records-empty">هنوز رکوردی ثبت نشده است. روی «ثبت رویداد جدید» بزنید.</div>'}
    ${serverDocuments.filter((document) => document.moduleId === current.id).length ? `<div class="workflow-documents"><h4>اسناد در گردش کار (سرور)</h4>${serverDocuments.filter((document) => document.moduleId === current.id).map((document) => `<div class="document-row"><span class="document-number">${document.number}</span><div><strong>${escapeHtml(document.title)}</strong><small>${escapeHtml(document.status)} · ${document.amount.toLocaleString('fa-IR')} ریال · ${escapeHtml(document.createdBy ?? '—')}</small></div><span class="workflow-actions">${(workflowTransitions[document.status] ?? []).map((transition) => `<button class="workflow-action" data-document-transition="${document.id}" data-action="${transition.action}">${escapeHtml(transition.label)}</button>`).join('')}</span><button class="row-delete" data-document-history="${document.id}" title="نمایش تاریخچه">⋯</button></div>`).join('')}</div>` : ''}
  </section>`;
}

function overviewMarkup(): string {
  const salesTotal = salesInvoices.reduce((sum, invoice) => sum + invoice.total, 0);
  const pendingSales = salesInvoices.filter((invoice) => invoice.status !== 'تأیید شده');
  const receivables = pendingSales.reduce((sum, invoice) => sum + invoice.total, 0);
  const receipts = treasuryTransactions.filter((item) => item.transactionType === 'receipt').reduce((sum, item) => sum + item.amount, 0);
  const payments = treasuryTransactions.filter((item) => item.transactionType === 'payment').reduce((sum, item) => sum + item.amount, 0);
  const cashBalance = receipts - payments;
  const openOrders = purchaseOrders.filter((order) => order.status !== 'تأیید شده').length;
  const inventoryValue = inventoryItems.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
  const tasks = pendingTasks();
  const myRecords = savedRecords.filter((record) => !record.isDemo).length;
  const filtered = getTransactions().filter((item) => `${item.title} ${item.category}`.includes(query));
  const distribution = new Map<string, number>();
  getTransactions().forEach((item) => distribution.set(item.category, (distribution.get(item.category) ?? 0) + 1));
  const maxDistribution = Math.max(1, ...distribution.values());

  return `<section class="metric-grid">
    <article class="metric-card accent">
      <div class="metric-top"><span>مانده نقدینگی</span><span class="trend ${cashBalance >= 0 ? 'up' : 'down'}">${cashBalance >= 0 ? '↑' : '↓'} ${treasuryTransactions.length} تراکنش</span></div>
      <strong>${money(cashBalance)} <small>ریال</small></strong>
      ${cashBalanceChartMarkup()}
      <small class="metric-foot">دریافت ${money(receipts)} · پرداخت ${money(payments)} ریال</small>
    </article>
    <article class="metric-card">
      <div class="metric-top"><span>فروش ثبت‌شده</span><span class="trend up">${salesInvoices.length} فاکتور</span></div>
      <strong>${money(salesTotal)} <small>ریال</small></strong>
      <div class="barline">${'<i></i>'.repeat(10)}</div>
      <small class="metric-foot">${pendingSales.length} فاکتور منتظر تأیید</small>
    </article>
    <article class="metric-card">
      <div class="metric-top"><span>مطالبات جاری</span><span class="trend ${receivables > 0 ? 'down' : 'up'}">${pendingSales.length} پرونده</span></div>
      <strong>${money(receivables)} <small>ریال</small></strong>
      <div class="progress"><span style="width:${Math.min(100, Math.round((receivables / Math.max(1, salesTotal)) * 100))}%"></span></div>
      <small class="metric-foot">${Math.min(100, Math.round((receivables / Math.max(1, salesTotal)) * 100))}٪ از کل فروش</small>
    </article>
    <article class="metric-card">
      <div class="metric-top"><span>سفارش‌های باز</span><span class="neutral">خرید و انبار</span></div>
      <strong>${openOrders} <small>سفارش</small></strong>
      <div class="order-dots">${'<i></i>'.repeat(7)}</div>
      <small class="metric-foot">ارزش موجودی: ${money(inventoryValue)} ریال</small>
    </article>
  </section>

  <section class="content-grid">
    <article class="panel activity-panel">
      <div class="panel-heading">
        <div><h2>آخرین رویدادها</h2><p>${getTransactions().length} رویداد · ${myRecords} مورد ثبت‌شده توسط شما</p></div>
        <span class="count">${filtered.length} نتیجه</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>شرح رویداد</th><th>ماژول</th><th>مبلغ</th><th>وضعیت</th><th>زمان</th></tr></thead>
        <tbody>${filtered.map((item) => `<tr><td><span class="record-dot"></span>${escapeHtml(item.title)}</td><td><span class="category">${item.category}</span></td><td class="amount">${item.amount} ریال</td><td><span class="status ${item.status === 'در انتظار' ? 'pending' : 'approved'}">${item.status}</span></td><td class="muted">${item.date}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">رویدادی پیدا نشد.</td></tr>'}</tbody>
      </table></div>
    </article>

    <aside class="panel tasks-panel">
      <div class="panel-heading">
        <div><h2>کارهای من</h2><p>موارد نیازمند اقدام شما</p></div>
        <span class="count">${tasks.length}</span>
      </div>
      <div class="task-list">
        ${tasks.length ? tasks.map((task) => task.server ? `<div class="task-row server-task">
          <span class="workflow-badge">${escapeHtml(task.status ?? '')}</span>
          <button class="task-body" data-goto-module="${task.moduleId}">
            <strong>${escapeHtml(task.title)}</strong>
            <small>${escapeHtml(task.module)} · ${escapeHtml(task.hint)}</small>
          </button>
          <span class="workflow-actions">${(workflowTransitions[task.status ?? ''] ?? []).map((transition) => `<button class="workflow-action" data-document-transition="${task.id}" data-action="${transition.action}">${escapeHtml(transition.label)}</button>`).join('')}</span>
        </div>` : `<div class="task-row">
          <button class="task-check" data-task-approve="${task.id}" title="تأیید">✓</button>
          <button class="task-body" data-goto-module="${task.moduleId}">
            <strong>${escapeHtml(task.title)}</strong>
            <small>${escapeHtml(task.module)} · ${escapeHtml(task.hint)}</small>
          </button>
          <b class="priority ${task.priority === 'فوری' ? 'high' : task.priority === 'مهم' ? 'medium' : 'low'}">${task.priority}</b>
        </div>`).join('') : '<div class="records-empty">همه‌چیز به‌روز است؛ کار در انتظاری ندارید.</div>'}
      </div>
      <div class="task-footnote">تأیید هر مورد، داشبورد و کارتابل همان ماژول را به‌روزرسانی می‌کند.</div>
    </aside>
  </section>

  <section class="content-grid secondary-grid">
    <article class="panel">
      <div class="panel-heading"><div><h2>توزیع رویدادها</h2><p>بر اساس ماژول و داده‌های واقعی</p></div></div>
      <div class="distribution">
        ${[...distribution.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([label, count]) => `<div class="distribution-row"><span>${escapeHtml(label)}</span><div class="mini-track"><span style="width:${Math.round((count / maxDistribution) * 100)}%"></span></div><b>${count}</b></div>`).join('') || '<div class="records-empty">داده‌ای برای نمایش نیست.</div>'}
      </div>
    </article>
    <article class="panel">
      <div class="panel-heading"><div><h2>وضعیت ماژول‌ها</h2><p>دسترسی سریع با داده‌های زنده</p></div></div>
      <div class="module-quick-grid">
        ${visibleModules().filter((item) => item.id !== 'overview').map((item) => {
          const count = savedRecords.filter((record) => record.category === item.label).length;
          return `<button class="module-quick" data-goto-module="${item.id}"><span class="module-icon">${item.icon}</span><strong>${item.label}</strong><small>${count} رکورد</small></button>`;
        }).join('')}
      </div>
    </article>
  </section>`;
}
function accountingMarkup(): string { const rows: JournalLine[] = [{ accountCode: '1100', accountTitle: 'بانک و صندوق', debit: 0, credit: 0 }, { accountCode: '4000', accountTitle: 'درآمد فروش', debit: 0, credit: 0 }]; return `<section class="accounting-page"><div class="accounting-intro"><div><span class="section-kicker">دفتر روزنامه</span><h2>ثبت سند حسابداری</h2><p>هر سند باید حداقل دو ردیف داشته باشد و جمع بدهکار و بستانکار آن برابر باشد.</p></div><div class="balance-chip"><span>دوره مالی فعال</span><strong>۱۴۰۵ · باز</strong></div></div><form class="journal-form" id="journal-form"><div class="journal-fields"><label>شرح سند<input name="description" required placeholder="مثلاً ثبت فروش نقدی مرداد"></label><label>تاریخ سند<input name="date" type="date" value="2026-08-28" required></label></div><div class="journal-table-wrap"><table class="journal-table"><thead><tr><th>کد حساب</th><th>عنوان حساب</th><th>بدهکار (ریال)</th><th>بستانکار (ریال)</th></tr></thead><tbody id="journal-lines">${rows.map((row) => journalRow(row)).join('')}</tbody></table></div><div class="journal-bottom"><button type="button" class="secondary-button" id="add-journal-line">＋ افزودن ردیف</button><div class="journal-totals"><span>جمع بدهکار <strong id="total-debit">۰</strong></span><span>جمع بستانکار <strong id="total-credit">۰</strong></span></div><button class="primary-button" type="submit">ثبت پیش‌نویس سند</button></div><p class="journal-hint" id="journal-hint">برای نمونه، در ردیف اول مبلغ بدهکار و در ردیف دوم مبلغ بستانکار وارد کنید.</p></form><div class="journal-list panel"><div class="panel-heading"><div><h2>اسناد اخیر</h2><p>نمونه‌های آموزشی و اسناد ثبت‌شده‌ی شما</p></div><span class="count">${journals.length} سند</span></div>${journals.length ? journals.map((journal) => `<div class="journal-record"><div><strong>سند شماره ${journal.number}</strong><small>${escapeHtml(journal.description)} · ${journal.status}</small></div><b>${journal.lines.reduce((sum, line) => sum + line.debit, 0).toLocaleString('fa-IR')} ریال</b></div>`).join('') : '<div class="records-empty">هنوز سندی ثبت نشده است.</div>'}</div></section>`; }
type FinancialStatements = {
  balanceSheet: { assets: Array<{ accountCode: string; accountTitle: string; amount: number }>; liabilities: Array<{ accountCode: string; accountTitle: string; amount: number }>; equity: Array<{ accountCode: string; accountTitle: string; amount: number }>; totalAssets: number; totalLiabilities: number; totalEquity: number; netIncome: number } | null;
  profitLoss: { revenues: Array<{ accountCode: string; accountTitle: string; amount: number }>; expenses: Array<{ accountCode: string; accountTitle: string; amount: number }>; totalRevenue: number; totalExpense: number; netIncome: number } | null;
  vat: { outputVat: number; inputVat: number; payableVat: number; entries: number } | null;
};

let ledgerTab: 'trial-balance' | 'ledger' = 'trial-balance';
let financialStatements: FinancialStatements = { balanceSheet: null, profitLoss: null, vat: null };
let statementsTab: 'balance-sheet' | 'profit-loss' | 'vat' = 'balance-sheet';
let statementsLoaded = false;

/** دریافت صورت‌های مالی از سرور (در صورت اتصال) */
async function loadFinancialStatements(): Promise<void> {
  if (!apiOnline) { showToast('صورت‌های مالی نیازمند اتصال به سرور است.'); return; }
  try {
    const [balance, profit, vat] = await Promise.all([
      apiFetch('/api/accounting/balance-sheet'),
      apiFetch('/api/accounting/profit-loss'),
      apiFetch('/api/accounting/vat'),
    ]);
    const unwrap = async (response: Response | null) => {
      if (!response?.ok) return null;
      const payload = (await response.json()) as { data?: unknown };
      return (payload.data ?? payload) as never;
    };
    financialStatements = {
      balanceSheet: await unwrap(balance),
      profitLoss: await unwrap(profit),
      vat: await unwrap(vat),
    };
    render();
    showToast('صورت‌های مالی به‌روزرسانی شد.');
  } catch {
    showToast('دریافت صورت‌های مالی ناموفق بود.');
  } finally {
    // نشانِ «بارگیری شده» همیشه گذاشته می‌شود تا با هر بازسازی درخواستِ تکراری نرود
    statementsLoaded = true;
  }
}

function statementRows(rows: Array<{ accountCode: string; accountTitle: string; amount: number }> | undefined, empty: string): string {
  if (!rows?.length) return `<tr><td colspan="3" class="empty-cell">${empty}</td></tr>`;
  return rows.map((row) => `<tr><td class="account-code">${escapeHtml(row.accountCode)}</td><td>${escapeHtml(row.accountTitle)}</td><td>${row.amount.toLocaleString('fa-IR')}</td></tr>`).join('');
}

/** پنل صورت‌های مالی: ترازنامه، سود و زیان و مالیات بر ارزش افزوده */
function financialStatementsMarkup(): string {
  const { balanceSheet, profitLoss, vat } = financialStatements;
  return `<section class="panel statements-panel">
    <div class="panel-heading">
      <div><h2>صورت‌های مالی و مالیات</h2><p>ترازنامه، سود و زیان و اظهارنامه‌ی ارزش افزوده بر اساس اسناد ثبت‌شده</p></div>
      <div class="report-tabs">
        <button class="report-tab ${statementsTab === 'balance-sheet' ? 'active' : ''}" data-statement="balance-sheet">ترازنامه</button>
        <button class="report-tab ${statementsTab === 'profit-loss' ? 'active' : ''}" data-statement="profit-loss">سود و زیان</button>
        <button class="report-tab ${statementsTab === 'vat' ? 'active' : ''}" data-statement="vat">ارزش افزوده</button>
      </div>
      <button class="ghost-button" id="statements-refresh">به‌روزرسانی</button>
    </div>

    ${statementsTab === 'balance-sheet' ? `<div class="statements-body">
      ${!balanceSheet ? '<p class="empty-hint">برای دریافت ترازنامه، دکمه‌ی «به‌روزرسانی» را بزنید.</p>' : `<div class="statements-grid">
        <div class="statement-card">
          <h3>دارایی‌ها</h3>
          <div class="table-wrap"><table class="data-table"><tbody>${statementRows(balanceSheet.assets, 'دارایی‌ای ثبت نشده است.')}</tbody>
          <tfoot><tr><td colspan="2"><strong>جمع دارایی‌ها</strong></td><td><strong>${balanceSheet.totalAssets.toLocaleString('fa-IR')}</strong></td></tr></tfoot></table></div>
        </div>
        <div class="statement-card">
          <h3>بدهی‌ها</h3>
          <div class="table-wrap"><table class="data-table"><tbody>${statementRows(balanceSheet.liabilities, 'بدهی‌ای ثبت نشده است.')}</tbody>
          <tfoot><tr><td colspan="2"><strong>جمع بدهی‌ها</strong></td><td><strong>${balanceSheet.totalLiabilities.toLocaleString('fa-IR')}</strong></td></tr></tfoot></table></div>
        </div>
        <div class="statement-card">
          <h3>حقوق صاحبان سهام</h3>
          <div class="table-wrap"><table class="data-table"><tbody>${statementRows(balanceSheet.equity, 'موردی ثبت نشده است.')}</tbody>
          <tfoot><tr><td colspan="2"><strong>جمع حقوق صاحبان سهام</strong></td><td><strong>${balanceSheet.totalEquity.toLocaleString('fa-IR')}</strong></td></tr></tfoot></table></div>
        </div>
      </div>
      <div class="statements-kpis">
        <div><span>سود (زیان) خالص دوره</span><strong class="${balanceSheet.netIncome >= 0 ? 'positive' : 'negative'}">${balanceSheet.netIncome.toLocaleString('fa-IR')}</strong></div>
        <div><span>تراز بودن صورت</span><strong class="${Math.abs(balanceSheet.totalAssets - (balanceSheet.totalLiabilities + balanceSheet.totalEquity)) < 1 ? 'positive' : 'negative'}">${Math.abs(balanceSheet.totalAssets - (balanceSheet.totalLiabilities + balanceSheet.totalEquity)) < 1 ? 'تراز است' : 'ناتراز'}</strong></div>
      </div>`}
    </div>` : ''}

    ${statementsTab === 'profit-loss' ? `<div class="statements-body">
      ${!profitLoss ? '<p class="empty-hint">برای دریافت سود و زیان، دکمه‌ی «به‌روزرسانی» را بزنید.</p>' : `<div class="statements-grid">
        <div class="statement-card">
          <h3>درآمدها</h3>
          <div class="table-wrap"><table class="data-table"><tbody>${statementRows(profitLoss.revenues, 'درآمدی ثبت نشده است.')}</tbody>
          <tfoot><tr><td colspan="2"><strong>جمع درآمدها</strong></td><td><strong>${profitLoss.totalRevenue.toLocaleString('fa-IR')}</strong></td></tr></tfoot></table></div>
        </div>
        <div class="statement-card">
          <h3>هزینه‌ها</h3>
          <div class="table-wrap"><table class="data-table"><tbody>${statementRows(profitLoss.expenses, 'هزینه‌ای ثبت نشده است.')}</tbody>
          <tfoot><tr><td colspan="2"><strong>جمع هزینه‌ها</strong></td><td><strong>${profitLoss.totalExpense.toLocaleString('fa-IR')}</strong></td></tr></tfoot></table></div>
        </div>
      </div>
      <div class="statements-kpis">
        <div><span>سود (زیان) خالص</span><strong class="${profitLoss.netIncome >= 0 ? 'positive' : 'negative'}">${profitLoss.netIncome.toLocaleString('fa-IR')}</strong></div>
        <div><span>حاشیه سود</span><strong>${profitLoss.totalRevenue > 0 ? Math.round((profitLoss.netIncome / profitLoss.totalRevenue) * 100) : 0}%</strong></div>
      </div>`}
    </div>` : ''}

    ${statementsTab === 'vat' ? `<div class="statements-body">
      ${!vat ? '<p class="empty-hint">برای دریافت خلاصه‌ی ارزش افزوده، دکمه‌ی «به‌روزرسانی» را بزنید.</p>' : `<div class="statements-kpis">
        <div><span>ارزش افزوده‌ی فروش (خروجی)</span><strong>${vat.outputVat.toLocaleString('fa-IR')}</strong></div>
        <div><span>ارزش افزوده‌ی خرید (ورودی)</span><strong>${vat.inputVat.toLocaleString('fa-IR')}</strong></div>
        <div><span>مالیات قابل پرداخت</span><strong class="${vat.payableVat >= 0 ? 'negative' : 'positive'}">${vat.payableVat.toLocaleString('fa-IR')}</strong></div>
        <div><span>تعداد ردیف‌های مشمول</span><strong>${vat.entries}</strong></div>
      </div>
      <p class="empty-hint">محاسبه بر اساس حساب‌های ارزش افزوده در اسناد ثبت‌شده انجام می‌شود.</p>`}
    </div>` : ''}
  </section>`;
}

/** ردیف‌های دفتر کل: هر خطِ سند به‌همراه مشخصات سند */
function ledgerEntries(): Array<{ number: number; date: string; description: string; accountCode: string; debit: number; credit: number; status: string }> {
  return journals
    .slice()
    .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
    .flatMap((journal) => journal.lines.map((line) => ({
      number: journal.number,
      date: String(journal.createdAt ?? '').slice(0, 10),
      description: journal.description,
      accountCode: line.accountCode,
      debit: line.debit,
      credit: line.credit,
      status: journal.status,
    })));
}

/** ===================== اسنادِ تکرارشونده ===================== */
let recurringEntries: Array<{
  id: string; title: string; debitAccount: string; debitTitle: string; creditAccount: string;
  creditTitle: string; amount: number; frequency: string; startDate: string; lastRun?: string; runs: number; isActive: boolean;
}> = [];

const frequencyLabels: Record<string, string> = { monthly: 'ماهانه', quarterly: 'سه‌ماهه', yearly: 'سالانه' };

async function loadRecurring(): Promise<void> {
  const result = await apiFetch('/api/accounting/recurring');
  if (!result?.ok) return;
  const rows = (await result.json().catch(() => [])) as typeof recurringEntries;
  recurringEntries = Array.isArray(rows) ? rows : [];
}

async function saveRecurring(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const payload = {
    title: String(data.get('title') ?? '').trim(),
    debitAccount: String(data.get('debitAccount') ?? '').trim(),
    debitTitle: String(data.get('debitTitle') ?? '').trim(),
    creditAccount: String(data.get('creditAccount') ?? '').trim(),
    creditTitle: String(data.get('creditTitle') ?? '').trim(),
    amount: Number(data.get('amount') ?? 0),
    frequency: String(data.get('frequency') ?? 'monthly'),
    startDate: String(data.get('startDate') ?? new Date().toISOString().slice(0, 10)),
  };
  if (!payload.title || !(payload.amount > 0) || !payload.debitAccount || !payload.creditAccount) {
    showToast('عنوان، مبلغ و کدِ دو حساب را کامل کنید.');
    return;
  }
  const result = await apiFetch('/api/accounting/recurring', { method: 'POST', body: JSON.stringify(payload) });
  const body = result ? ((await result.json().catch(() => ({}))) as { error?: string }) : null;
  if (!result?.ok) { showToast(body?.error ?? 'تعریفِ سند تکرارشونده ناموفق بود.'); return; }
  form.reset();
  await loadRecurring();
  render();
  showToast(`سندِ تکرارشونده‌ی «${payload.title}» تعریف شد.`);
}

async function runRecurring(id: string): Promise<void> {
  const result = await apiFetch(`/api/accounting/recurring/${id}/run`, { method: 'POST' });
  const body = result ? ((await result.json().catch(() => ({}))) as { error?: string; number?: number; title?: string }) : null;
  if (!result?.ok) { showToast(body?.error ?? 'صدورِ سند ممکن نیست.'); return; }
  await loadRecurring();
  await loadServerData(true);
  render();
  showToast(`سند شماره ${body?.number} برای «${body?.title ?? ''}» صادر شد.`);
}

async function toggleRecurring(id: string): Promise<void> {
  const result = await apiFetch(`/api/accounting/recurring/${id}/toggle`, { method: 'POST' });
  if (!result?.ok) { showToast('تغییرِ وضعیت ممکن نیست.'); return; }
  await loadRecurring();
  render();
  showToast('وضعیتِ سند تکرارشونده تغییر کرد.');
}

async function removeRecurring(id: string): Promise<void> {
  confirmDialog('حذف سند تکرارشونده', 'این الگو حذف شود؟ سندهای صادرشده‌ی قبلی باقی می‌مانند.', async () => {
    const result = await apiFetch(`/api/accounting/recurring/${id}`, { method: 'DELETE' });
    if (!result?.ok) { showToast('حذف ممکن نیست.'); return; }
    await loadRecurring();
    render();
    showToast('الگوی سند تکرارشونده حذف شد.');
  });
}

function recurringPanelMarkup(): string {
  if (session?.permissions?.length && !session.permissions.includes('accounting.read')) return '';
  const rows = recurringEntries.length
    ? `<div class="recurring-list">${recurringEntries.map((row) => `<div class="recurring-row ${row.isActive ? '' : 'paused'}">
        <div class="recurring-head"><strong>${escapeHtml(row.title)}</strong><span class="status-chip ${row.isActive ? 'ok' : 'warn'}">${row.isActive ? 'فعال' : 'متوقف'} · ${frequencyLabels[row.frequency] ?? row.frequency}</span></div>
        <small>${escapeHtml(row.debitAccount)} ${escapeHtml(row.debitTitle)} ← → ${escapeHtml(row.creditAccount)} ${escapeHtml(row.creditTitle)}</small>
        <div class="recurring-foot">
          <b>${money(row.amount)} ریال</b>
          <span class="recurring-meta">${row.runs} بار صادر شده${row.lastRun ? ` · آخرین: ${new Date(row.lastRun).toLocaleDateString('fa-IR')}` : ''}</span>
          <span class="recurring-actions">
            <button type="button" class="btn-secondary small" data-recurring-run="${row.id}">صدور سند</button>
            <button type="button" class="btn-secondary small" data-recurring-toggle="${row.id}">${row.isActive ? 'توقف' : 'فعال‌سازی'}</button>
            <button type="button" class="btn-secondary small" data-recurring-remove="${row.id}">حذف</button>
          </span>
        </div>
      </div>`).join('')}</div>`
    : '<p class="empty-hint">هنوز سندِ تکرارشونده‌ای تعریف نشده است.</p>';
  return `<section class="panel recurring-panel">
      <div class="panel-heading"><div><h2>اسنادِ تکرارشونده</h2><p>اجاره، استهلاک، حقوقِ ثابت و آبونمان را یک‌بار تعریف کنید؛ هر دوره با یک کلیک سندش صادر می‌شود</p></div><span class="count">${recurringEntries.length} الگو</span></div>
      <form class="recurring-form" id="recurring-form">
        <label>عنوان<input name="title" required placeholder="مثلاً اجاره‌ی ماهانه دفتر"></label>
        <label>حساب بدهکار<input name="debitAccount" required placeholder="۶۱۰۰" inputmode="numeric"></label>
        <label>عنوان بدهکار<input name="debitTitle" placeholder="هزینه اجاره"></label>
        <label>حساب بستانکار<input name="creditAccount" required placeholder="۱۱۰۰" inputmode="numeric"></label>
        <label>عنوان بستانکار<input name="creditTitle" placeholder="بانک و صندوق"></label>
        <label>مبلغ (ریال)<input name="amount" type="number" min="1" step="1" required></label>
        <label>دوره‌ی تکرار<select name="frequency"><option value="monthly">ماهانه</option><option value="quarterly">سه‌ماهه</option><option value="yearly">سالانه</option></select></label>
        <label>تاریخ شروع<input name="startDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
        <div class="modal-actions"><button type="button" class="btn-cancel" id="recurring-reset">انصراف</button><button type="submit" class="primary-button">تعریف الگو</button></div>
      </form>
      ${rows}
    </section>`;
}

/** بستنِ سال مالی: صدورِ سندِ اختتامیه و انتقالِ سود/زیان به حساب سود انباشته */
async function closeFiscalYear(): Promise<void> {
  const select = document.querySelector<HTMLSelectElement>('#close-year');
  const year = Number(select?.value ?? 0);
  if (!year) { showToast('سال مالی انتخاب نشده است.'); return; }
  confirmDialog(
    'بستنِ سال مالی',
    `سال مالی ${year} بسته می‌شود: حساب‌های درآمد و هزینه صفر می‌گردند و خالصِ سود یا زیان به حساب «سود (زیان) انباشته» منتقل می‌شود.`,
    () => void runCloseFiscalYear(year),
  );
}

async function runCloseFiscalYear(year: number): Promise<void> {
  const result = await apiFetch('/api/fiscal-periods/close-year', { method: 'POST', body: JSON.stringify({ year }) });
  const body = result ? ((await result.json().catch(() => ({}))) as { error?: string; number?: number; netIncome?: number; closedPeriods?: number }) : null;
  if (!result?.ok) { showToast(body?.error ?? 'بستنِ سال مالی ناموفق بود.'); return; }
  await loadServerData(true);
  render();
  const tone = (body?.netIncome ?? 0) >= 0 ? 'سود' : 'زیان';
  showToast(`سندِ اختتامیه شماره ${body?.number} صادر شد؛ ${tone} خالص ${money(Math.abs(body?.netIncome ?? 0))} ریال به سود انباشته منتقل شد (${body?.closedPeriods ?? 0} دوره بسته شد).`);
}

function accountingWorkspaceMarkup(): string { const balances = new Map<string, AccountBalance>(); journals.forEach((journal) => journal.lines.forEach((line) => { const old = balances.get(line.accountCode) ?? { code: line.accountCode, title: line.accountTitle, debit: 0, credit: 0, balance: 0 }; old.debit += line.debit; old.credit += line.credit; old.balance = old.debit - old.credit; balances.set(line.accountCode, old); })); const rows = [...balances.values()]; return `${accountingMarkup().replace('</section>', `<section class="ledger-panel panel">
      <div class="report-tabs">
        <button class="report-tab ${ledgerTab === 'trial-balance' ? 'active' : ''}" data-report="trial-balance">تراز آزمایشی</button>
        <button class="report-tab ${ledgerTab === 'ledger' ? 'active' : ''}" data-report="ledger">دفتر کل</button>
        <span class="report-caption">بر اساس اسناد ثبت‌شده</span>
      </div>
      ${ledgerTab === 'trial-balance' ? `<div class="ledger-table-wrap"><table><thead><tr><th>کد</th><th>حساب</th><th>جمع بدهکار</th><th>جمع بستانکار</th><th>مانده</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${row.code}</td><td>${row.title}</td><td>${row.debit.toLocaleString('fa-IR')}</td><td>${row.credit.toLocaleString('fa-IR')}</td><td class="${row.balance >= 0 ? 'positive' : 'negative'}">${Math.abs(row.balance).toLocaleString('fa-IR')} ${row.balance >= 0 ? 'بدهکار' : 'بستانکار'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">برای نمایش گزارش، ابتدا سند ثبت کنید.</td></tr>'}</tbody><tfoot><tr><td colspan="2"><strong>جمع کل</strong></td><td><strong>${rows.reduce((sum, row) => sum + row.debit, 0).toLocaleString('fa-IR')}</strong></td><td><strong>${rows.reduce((sum, row) => sum + row.credit, 0).toLocaleString('fa-IR')}</strong></td><td><strong>${Math.abs(rows.reduce((sum, row) => sum + row.balance, 0)).toLocaleString('fa-IR')}</strong></td></tr></tfoot></table></div>` : `<div class="ledger-table-wrap"><table><thead><tr><th>شماره سند</th><th>تاریخ</th><th>شرح</th><th>کد حساب</th><th>بدهکار</th><th>بستانکار</th><th>وضعیت</th></tr></thead><tbody>${ledgerEntries().map((entry) => `<tr><td>${entry.number}</td><td>${escapeHtml(entry.date)}</td><td>${escapeHtml(entry.description)}</td><td>${escapeHtml(entry.accountCode)}</td><td>${entry.debit.toLocaleString('fa-IR')}</td><td>${entry.credit.toLocaleString('fa-IR')}</td><td>${escapeHtml(entry.status)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">سندی ثبت نشده است.</td></tr>'}</tbody></table></div>`}
    </section><section class="accounts-panel panel"><div class="panel-heading"><div><h2>فهرست حساب‌ها</h2><p>حساب‌های قابل استفاده در سند و عملیات خزانه</p></div><button class="primary-button" id="new-account">＋ حساب جدید</button></div><div class="account-list">${accounts.map((account) => `<div class="account-row"><span class="account-code">${account.code}</span><strong>${escapeHtml(account.title)}</strong><small>سطح ${account.level}</small><button data-delete-account="${account.id}" aria-label="حذف حساب">×</button></div>`).join('')}</div></section><section class="fiscal-panel panel">${fiscalSettingsMarkup()}</section>${financialStatementsMarkup()}<section class="server-ledger-panel panel">${serverLedgerMarkup()}</section>${recurringPanelMarkup()}</section>`)}`; }
function treasuryMarkup(): string { const received = treasuryTransactions.filter((item) => item.transactionType === 'receipt').reduce((sum, item) => sum + item.amount, 0); const paid = treasuryTransactions.filter((item) => item.transactionType === 'payment').reduce((sum, item) => sum + item.amount, 0); return `<section class="treasury-page"><div class="treasury-kpis"><article><span>مانده خالص نقدینگی</span><strong>${(received - paid).toLocaleString('fa-IR')}</strong><small>ریال</small><b class="positive">↑ ۸.۶٪ این ماه</b></article><article><span>دریافت‌های دوره</span><strong>${received.toLocaleString('fa-IR')}</strong><small>ریال</small><b>از بانک و صندوق</b></article><article><span>پرداخت‌های دوره</span><strong>${paid.toLocaleString('fa-IR')}</strong><small>ریال</small><b>در انتظار تطبیق</b></article></div><div class="treasury-toolbar"><div><h2>دفتر خزانه</h2><p>دریافت‌ها و پرداخت‌ها را ثبت و پیگیری کنید.</p></div><button class="primary-button" id="new-treasury">＋ ثبت تراکنش</button></div><div class="panel treasury-list"><div class="panel-heading"><div><h2>آخرین تراکنش‌ها</h2><p>نمونه آموزشی و اطلاعات ثبت‌شده شما</p></div><span class="count">${treasuryTransactions.length} تراکنش</span></div>${treasuryTransactions.map((item) => `<div class="treasury-row"><span class="cash-type ${item.transactionType}">${item.transactionType === 'receipt' ? 'دریافت' : 'پرداخت'}</span><div><strong>${escapeHtml(item.description)}</strong><small>${escapeHtml(item.accountTitle)} · ${escapeHtml(item.bankOrCash)} ${item.isDemo ? '· داده نمونه آموزشی' : ''}</small></div><b>${item.transactionType === 'receipt' ? '+' : '-'} ${item.amount.toLocaleString('fa-IR')} ریال</b><span class="status ${item.status === 'تأیید شده' ? 'approved' : 'pending'}">${item.status}</span></div>`).join('')}</div>${dueRemindersMarkup()}${checksMarkup()}${bankReconciliationMarkup()}</section>`; }
function moduleMarkupLegacy(current: Module): string { if (current.id === 'accounting') return accountingWorkspaceMarkup(); if (current.id === 'treasury') return treasuryMarkup(); const records = savedRecords.filter((record) => record.category === current.label); return `<section class="module-summary"><div class="module-kpis">${current.kpis.map((kpi) => `<article class="module-kpi"><span>${kpi[0]}</span><strong>${kpi[1]}</strong><small>${kpi[2]}</small><div class="kpi-line"></div></article>`).join('')}</div><div class="module-workspace"><div class="workspace-header"><div><h2>عملیات ${current.label}</h2><p>قابلیت‌های زیرماژول به‌صورت مستقل قابل توسعه و اتصال به API هستند.</p></div><span class="module-empty-icon">${current.icon}</span></div><div class="feature-grid">${current.features.map((feature, index) => `<button class="feature-item" data-feature="${escapeHtml(feature)}"><span>${String(index + 1).padStart(2, '0')}</span><strong>${feature}</strong><b>←</b></button>`).join('')}</div>${records.length ? `<div class="records-heading"><h3>کارتابل عملیات</h3><span>${records.length} رکورد · امکان افزودن، تأیید و حذف</span></div><div class="record-list">${records.map((record) => `<div class="record-row"><div><strong>${escapeHtml(record.title)}</strong><small>${record.date} · ${record.owner} ${record.isDemo ? '· داده نمونه آموزشی' : ''}</small></div><span class="status ${record.status === 'تأیید شده' ? 'approved' : 'pending'}">${record.status}</span><div class="record-actions">${record.status !== 'تأیید شده' ? `<button data-action="approve" data-id="${record.id}">تأیید</button>` : ''}<button data-action="delete" data-id="${record.id}">حذف</button></div></div>`).join('')}</div>` : '<div class="records-empty">هنوز عملیاتی در این ماژول ثبت نشده است.</div>'}</div></section>`; }
function journalRow(row: JournalLine): string { return `<tr><td><input name="accountCode" required value="${row.accountCode}" placeholder="۱۱۰۰"></td><td><input name="accountTitle" required value="${row.accountTitle}" placeholder="عنوان حساب"></td><td><input name="debit" type="number" min="0" step="0.01" value="${row.debit || ''}" placeholder="۰"></td><td><input name="credit" type="number" min="0" step="0.01" value="${row.credit || ''}" placeholder="۰"></td></tr>`; }
function addJournalLine(): void { const body = document.querySelector<HTMLTableSectionElement>('#journal-lines'); if (body) { body.insertAdjacentHTML('beforeend', journalRow({ accountCode: '', accountTitle: '', debit: 0, credit: 0 })); updateJournalTotals(); } }
function updateJournalTotals(): void { const form = document.querySelector<HTMLFormElement>('#journal-form'); if (!form) return; const debit = [...form.querySelectorAll<HTMLInputElement>('input[name="debit"]')].reduce((sum, input) => sum + (Number(input.value) || 0), 0); const credit = [...form.querySelectorAll<HTMLInputElement>('input[name="credit"]')].reduce((sum, input) => sum + (Number(input.value) || 0), 0); const debitElement = document.querySelector<HTMLElement>('#total-debit'); const creditElement = document.querySelector<HTMLElement>('#total-credit'); if (debitElement) debitElement.textContent = debit.toLocaleString('fa-IR'); if (creditElement) creditElement.textContent = credit.toLocaleString('fa-IR'); }
async function saveJournal(event: SubmitEvent): Promise<void> { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const data = new FormData(form); const codes = data.getAll('accountCode').map(String); const titles = data.getAll('accountTitle').map(String); const debits = data.getAll('debit').map(Number); const credits = data.getAll('credit').map(Number); const lines = codes.map((accountCode, index) => ({ accountCode, accountTitle: titles[index], debit: debits[index] || 0, credit: credits[index] || 0 })).filter((line) => line.debit || line.credit); const totalDebit = lines.reduce((sum, line) => sum + line.debit, 0); const totalCredit = lines.reduce((sum, line) => sum + line.credit, 0); const hint = document.querySelector<HTMLParagraphElement>('#journal-hint'); if (lines.length < 2 || Math.abs(totalDebit - totalCredit) > 0.001) { if (hint) hint.textContent = `سند نامتوازن است. بدهکار: ${totalDebit.toLocaleString('fa-IR')}، بستانکار: ${totalCredit.toLocaleString('fa-IR')}`; return; } const journal: Journal = { id: crypto.randomUUID(), number: journals.length + 1001, description: String(data.get('description') ?? ''), lines, status: 'پیش‌نویس', createdAt: new Date().toISOString() }; journals = [journal, ...journals]; store('erp-journals', journals); void apiFetch(`/api/accounting/journals`, { method: 'POST', body: JSON.stringify({ description: journal.description, lines }) }).catch(() => undefined); render(); showToast('سند حسابداری متوازن و به‌صورت پیش‌نویس ثبت شد.'); }
/** ===================== یادآوریِ سررسید چک‌ها ===================== */
function dueRemindersMarkup(): string {
  if (session?.permissions?.length && !session.permissions.includes('treasury.read')) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = (iso: string): number => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
    date.setHours(0, 0, 0, 0);
    return Math.round((date.getTime() - today.getTime()) / 86_400_000);
  };
  const pending = checks
    .filter((check) => !['وصول شده', 'پرداخت شده', 'باطل شده'].includes(check.status))
    .map((check) => ({ ...check, remaining: days(check.dueDate) }))
    .filter((check) => Number.isFinite(check.remaining) && check.remaining <= 30)
    .sort((left, right) => left.remaining - right.remaining)
    .slice(0, 8);
  if (!pending.length) return '';
  return `<div class="panel reminders-panel">
      <div class="panel-heading"><div><h2>یادآوریِ سررسیدها</h2><p>چک‌هایی که تا ۳۰ روز آینده سررسید می‌شوند یا سررسیدشان گذشته است</p></div><span class="count">${pending.length} مورد</span></div>
      <div class="reminder-list">
        ${pending.map((check) => {
          const tone = check.remaining < 0 ? 'overdue' : check.remaining <= 7 ? 'soon' : 'later';
          const label = check.remaining < 0 ? `${Math.abs(check.remaining)} روز گذشته` : check.remaining === 0 ? 'امروز' : `${check.remaining} روز مانده`;
          return `<div class="reminder-row ${tone}">
            <span class="reminder-icon">${tone === 'overdue' ? '!' : '◷'}</span>
            <div><strong>${escapeHtml(check.party)}</strong><small>چک ${escapeHtml(check.direction)} · ${escapeHtml(check.bank)} · ${escapeHtml(check.dueDate)}</small></div>
            <b>${money(check.amount)} ریال</b>
            <span class="status-chip ${tone === 'overdue' ? 'warn' : 'ok'}">${label}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

/** ===================== سقف اعتبار مشتریان ===================== */
function saveCreditLimit(customer: string, limit: number): void {
  const name = customer.trim();
  if (!name) { showToast('نام مشتری را وارد کنید.'); return; }
  if (!Number.isFinite(limit) || limit <= 0) { showToast('سقف اعتبار باید عددی مثبت باشد.'); return; }
  creditLimits = { ...creditLimits, [name]: limit };
  store('erp-credit-limits', creditLimits);
  showToast(`سقف اعتبار «${name}» برابر ${money(limit)} ریال ثبت شد.`);
  render();
}
function removeCreditLimit(customer: string): void {
  const next = { ...creditLimits };
  delete next[customer];
  creditLimits = next;
  store('erp-credit-limits', creditLimits);
  showToast(`سقف اعتبار «${customer}» حذف شد.`);
  render();
}
function creditLimitMarkup(): string {
  if (session?.permissions?.length && !session.permissions.includes('sales.read') && !session.permissions.includes('sales.write')) return '';
  const usage = new Map<string, number>();
  salesInvoices.forEach((invoice) => usage.set(invoice.customerName, (usage.get(invoice.customerName) ?? 0) + invoice.total));
  const rows = Object.entries(creditLimits).sort((a, b) => b[1] - a[1]);
  return `<div class="panel credit-panel">
      <div class="panel-heading"><div><h2>سقف اعتبار مشتریان</h2><p>پیش از ثبت فاکتورِ بزرگ، وضعیتِ اعتبار مشتری را ببینید</p></div><span class="count">${rows.length} مشتری</span></div>
      <form class="credit-form" id="credit-form">
        <label>نام مشتری<input name="customer" list="credit-customers" required placeholder="مثلاً شرکت آفتاب"></label>
        <datalist id="credit-customers">${[...usage.keys()].map((name) => `<option value="${escapeHtml(name)}"></option>`).join('')}</datalist>
        <label>سقف اعتبار (ریال)<input name="limit" type="number" min="1" step="1" required placeholder="مثلاً 500000000"></label>
        <div class="modal-actions"><button type="button" class="btn-cancel" id="credit-reset">انصراف</button><button type="submit" class="primary-button">ثبت سقف</button></div>
      </form>
      ${rows.length ? `<div class="credit-list">${rows.map(([name, limit]) => {
        const used = usage.get(name) ?? 0;
        const percent = limit ? Math.round((used / limit) * 100) : 0;
        const tone = percent >= 100 ? 'over' : percent >= 80 ? 'near' : 'ok';
        return `<div class="credit-row">
          <div class="credit-head"><strong>${escapeHtml(name)}</strong><small>مصرف: ${money(used)} از ${money(limit)} ریال</small></div>
          <div class="credit-track"><span class="${tone}" style="width:${Math.min(100, Math.max(2, percent))}%"></span></div>
          <div class="credit-foot"><span class="status-chip ${tone === 'over' ? 'warn' : 'ok'}">${percent}٪ استفاده</span><button type="button" class="btn-secondary small" data-credit-remove="${escapeHtml(name)}">حذف</button></div>
        </div>`;
      }).join('')}</div>` : '<p class="empty-hint">هنوز سقفی تعریف نشده است.</p>'}
    </div>`;
}

/** ===================== صفِ سامانه‌ی مؤدیان (مالیات) ===================== */
type TaxSubmission = {
  id: string; invoiceNumber: string; invoiceType: string; buyerName: string;
  totalBeforeVat: number; totalVat: number; totalAmount: number;
  status: 'در صف' | 'ارسال شد' | 'ناموفق';
  attempts: number; lastError?: string; referenceId?: string;
  payload: string; createdAt: string; sentAt?: string;
};
let taxSubmissions: TaxSubmission[] = [];
let taxConfigured = false;
let taxLoadedAt = 0;

async function loadTaxSubmissions(force = false): Promise<void> {
  if (!apiOnline) return;
  // برای جلوگیری از درخواستِ اضافی، تنها هر چند ثانیه یک‌بار تازه می‌شود (مگر با درخواستِ صریح)
  if (!force && Date.now() - taxLoadedAt < 4000) return;
  taxLoadedAt = Date.now();
  const result = await apiFetch('/api/tax/submissions').catch(() => null);
  if (!result?.ok) return;
  const body = (await result.json().catch(() => ({}))) as { data?: TaxSubmission[]; configured?: boolean };
  taxSubmissions = Array.isArray(body.data) ? body.data : [];
  taxConfigured = Boolean(body.configured);
}

async function sendTaxSubmission(id: string): Promise<void> {
  const result = await apiFetch(`/api/tax/submissions/${id}/send`, { method: 'POST' }).catch(() => null);
  const body = result ? ((await result.json().catch(() => ({}))) as { error?: string; message?: string; referenceId?: string }) : {};
  await loadTaxSubmissions();
  render();
  const failed = !result?.ok || (body as { ok?: boolean }).ok === false;
  if (failed) { showToast(body?.error ?? body?.message ?? 'ارسال به سامانه‌ی مؤدیان ناموفق بود.'); return; }
  showToast(body?.message ?? `صورت‌حساب ارسال شد${body?.referenceId ? ` — شناسه: ${body.referenceId}` : ''}.`);
}

async function sendAllTaxSubmissions(): Promise<void> {
  const result = await apiFetch('/api/tax/submissions/send-all', { method: 'POST' }).catch(() => null);
  const body = result ? ((await result.json().catch(() => ({}))) as { error?: string; sent?: number; failed?: number; total?: number }) : {};
  await loadTaxSubmissions();
  render();
  if (!result?.ok) { showToast(body?.error ?? 'ارسالِ صف ناموفق بود.'); return; }
  if (!body.total) { showToast('صورت‌حسابی در صف نیست.'); return; }
  showToast(`${body.sent ?? 0} صورت‌حساب ارسال شد${body.failed ? ` و ${body.failed} مورد ناموفق ماند` : ''}.`);
}

async function removeTaxSubmission(id: string): Promise<void> {
  const result = await apiFetch(`/api/tax/submissions/${id}`, { method: 'DELETE' }).catch(() => null);
  const body = result ? ((await result.json().catch(() => ({}))) as { error?: string }) : {};
  await loadTaxSubmissions();
  render();
  showToast(result?.ok ? 'صورت‌حساب از صف حذف شد.' : (body?.error ?? 'حذف ممکن نیست.'));
}

function downloadTaxPayload(row: TaxSubmission): void {
  downloadCsvFile(`مودیان-${row.invoiceNumber}.json`, row.payload);
  showToast(`فایلِ صورت‌حساب ${row.invoiceNumber} برای بارگذاریِ دستی آماده شد.`);
}

const taxStatusTone: Record<string, string> = { 'در صف': 'pending', 'ارسال شد': 'ok', 'ناموفق': 'warn' };

function taxQueueMarkup(): string {
  if (session?.permissions?.length && !session.permissions.includes('sales.read') && !session.permissions.includes('sales.write')) return '';
  const queued = taxSubmissions.filter((row) => row.status !== 'ارسال شد').length;
  return `<div class="panel tax-panel">
      <div class="panel-heading"><div><h2>صفِ سامانه‌ی مؤدیان</h2><p>هر فاکتورِ فروش به‌خودی‌خود واردِ این صف می‌شود و با یک کلیک ارسال می‌گردد</p></div><span class="count">${taxSubmissions.length} صورت‌حساب${queued ? ` · ${queued} در صف` : ''}</span></div>
      <div class="tax-status ${taxConfigured ? 'ok' : 'warn'}">
        <strong>${taxConfigured ? 'اتصال تنظیم شده است' : 'اتصال هنوز تنظیم نشده است'}</strong>
        <span>${taxConfigured
          ? 'کلید و شناسه‌ی حافظه‌ی مالیاتی از فایلِ تنظیماتِ سرور خوانده می‌شود.'
          : 'برای ارسالِ واقعی، متغیرهای TAX_API_URL و TAX_API_KEY و TAX_FISCAL_ID و TAX_NATIONAL_ID را در فایل .env پر کنید (راهنما-مودیان.md).'}</span>
      </div>
      <div class="tax-actions">
        <button type="button" class="primary-button" id="tax-send-all"${queued ? '' : ' disabled'}>ارسالِ صف (${queued})</button>
        <button type="button" class="btn-secondary" id="tax-refresh">به‌روزرسانی</button>
      </div>
      ${taxSubmissions.length ? `<div class="tax-list">${taxSubmissions.map((row) => `<div class="tax-row">
          <div class="tax-head"><strong>صورت‌حساب ${escapeHtml(row.invoiceNumber)} · ${escapeHtml(row.buyerName)}</strong>
            <span class="status-chip ${taxStatusTone[row.status] ?? 'pending'}">${escapeHtml(row.status)}</span></div>
          <small>مبلغ: ${money(row.totalAmount)} ریال (مالیات: ${money(row.totalVat)}) · تلاش: ${row.attempts}${row.referenceId ? ` · شناسه: ${escapeHtml(row.referenceId)}` : ''}${row.lastError ? ` · ${escapeHtml(row.lastError)}` : ''}</small>
          <div class="tax-foot">
            ${row.status === 'ارسال شد' ? '' : `<button type="button" class="btn-secondary small" data-tax-send="${row.id}">${row.attempts ? 'تلاشِ دوباره' : 'ارسال'}</button>`}
            <button type="button" class="btn-secondary small" data-tax-download="${row.id}">فایل JSON</button>
            <button type="button" class="btn-secondary small" data-tax-remove="${row.id}">حذف</button>
          </div>
        </div>`).join('')}</div>` : '<p class="empty-hint">هنوز صورت‌حسابی در صف نیست؛ با ثبتِ فاکتورِ فروش، اینجا پر می‌شود.</p>'}
    </div>`;
}

function salesMarkup(): string { const total = salesInvoices.reduce((sum, invoice) => sum + invoice.total, 0); return `<section class="sales-page"><div class="sales-kpis"><article><span>فروش ثبت‌شده</span><strong>${total.toLocaleString('fa-IR')}</strong><small>ریال</small><b>↑ ۸.۲٪ این ماه</b></article><article><span>فاکتورهای این دوره</span><strong>${salesInvoices.length.toLocaleString('fa-IR')}</strong><small>فاکتور</small><b>۲ مورد در انتظار تأیید</b></article><article><span>میانگین فاکتور</span><strong>${Math.round(total / salesInvoices.length).toLocaleString('fa-IR')}</strong><small>ریال</small><b>بر اساس داده‌های دوره</b></article></div><div class="sales-toolbar"><div><h2>فروش و فاکتورها</h2><p>فاکتور را ثبت کنید تا سند درآمد و حساب دریافتنی ساخته شود.</p></div><div class="toolbar-actions"><button class="primary-button" id="new-invoice">＋ ثبت فاکتور</button><button class="ghost-button" id="tax-invoice-new">🧾 صورت‌حساب الکترونیکی</button></div></div><div class="panel invoice-list"><div class="panel-heading"><div><h2>فاکتورهای اخیر</h2><p>داده نمونه آموزشی و فاکتورهای شما</p></div><span class="count">${salesInvoices.length} فاکتور</span></div>${salesInvoices.map((invoice) => `<div class="invoice-row"><span class="invoice-number">#${invoice.invoiceNumber}</span><div><strong>${escapeHtml(invoice.customerName)}</strong><small>${invoice.lines.map((line) => escapeHtml(line.itemTitle)).join('، ')} ${invoice.isDemo ? '· داده نمونه آموزشی' : ''}</small></div><b>${invoice.total.toLocaleString('fa-IR')} ریال</b><span class="status ${invoice.status === 'تأیید شده' ? 'approved' : 'pending'}">${invoice.status}</span><button class="mini-button" data-print-invoice="${invoice.id}" title="چاپ فاکتور">🖨</button></div>`).join('')}</div>${creditLimitMarkup()}${taxQueueMarkup()}</section>`; }
function purchasingMarkup(): string { const total = purchaseOrders.reduce((sum, order) => sum + order.total, 0); return `<section class="sales-page"><div class="sales-kpis"><article><span>ارزش سفارش‌های خرید</span><strong>${total.toLocaleString('fa-IR')}</strong><small>ریال</small><b>تأمین دوره جاری</b></article><article><span>سفارش‌های باز</span><strong>${purchaseOrders.length.toLocaleString('fa-IR')}</strong><small>سفارش</small><b>نیازمند پیگیری</b></article><article><span>تأمین‌کنندگان فعال</span><strong>${new Set(purchaseOrders.map((item) => item.supplierName)).size}</strong><small>تأمین‌کننده</small><b>از داده‌های ثبت‌شده</b></article></div><div class="sales-toolbar"><div><h2>خرید و تدارکات</h2><p>سفارش خرید را ثبت کنید تا موجودی و بدهی حسابداری به‌روزرسانی شود.</p></div><button class="primary-button" id="new-purchase">＋ ثبت سفارش خرید</button></div><div class="panel invoice-list"><div class="panel-heading"><div><h2>سفارش‌های اخیر</h2><p>داده نمونه آموزشی و سفارش‌های شما</p></div><span class="count">${purchaseOrders.length} سفارش</span></div>${purchaseOrders.map((order) => `<div class="invoice-row"><span class="invoice-number">#${order.orderNumber}</span><div><strong>${escapeHtml(order.supplierName)}</strong><small>${escapeHtml(order.itemTitle)} · ${order.quantity.toLocaleString('fa-IR')} عدد ${order.isDemo ? '· داده نمونه آموزشی' : ''}</small></div><b>${order.total.toLocaleString('fa-IR')} ریال</b><span class="status ${order.status === 'تأیید شده' ? 'approved' : 'pending'}">${order.status}</span></div>`).join('')}</div></section>`; }
type SerialStatus = 'موجود در انبار' | 'تخصیص‌یافته' | 'فروخته‌شده' | 'برگشتی' | 'اسقاط';
type SerialRecord = {
  id: string; serial: string; itemId: string; itemTitle: string; warehouse: string;
  status: SerialStatus; documentId?: string; party?: string; note?: string; createdAt: string; updatedAt: string;
};

const serialStatuses: SerialStatus[] = ['موجود در انبار', 'تخصیص‌یافته', 'فروخته‌شده', 'برگشتی', 'اسقاط'];
let serialRecords: SerialRecord[] = [];
let serialsLoaded = false;
let serialFilter = { status: '' as SerialStatus | '', query: '' };

async function loadSerials(): Promise<void> {
  if (!apiOnline || serialsLoaded) { serialsLoaded = true; return; }
  serialsLoaded = true;
  try {
    const query = new URLSearchParams();
    if (serialFilter.status) query.set('status', serialFilter.status);
    if (serialFilter.query) query.set('query', serialFilter.query);
    const result = await apiFetch(`/api/inventory/serials?${query.toString()}`);
    if (!result?.ok) return;
    const payload = (await result.json()) as { data: SerialRecord[] };
    serialRecords = payload.data ?? [];
  } catch { /* حالت آفلاین: فقط داده‌های محلی */ }
}

/** ثبت گروهی سریال با پیشوند و شمارنده */
function saveSerials(event: SubmitEvent): void {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const itemTitle = String(data.get('itemTitle') ?? '').trim();
  const prefix = String(data.get('prefix') ?? '').trim();
  const start = Number(data.get('start'));
  const count = Number(data.get('count'));
  const digits = Math.max(1, Math.min(10, Number(data.get('digits')) || 4));
  const warehouse = String(data.get('warehouse') ?? '').trim() || 'انبار اصلی';
  if (!itemTitle || !prefix || !(count > 0) || !(start >= 0)) { showToast('نام کالا، پیشوند و تعداد معتبر الزامی است.'); return; }
  if (count > 500) { showToast('در هر نوبت حداکثر ۵۰۰ سریال قابل ثبت است.'); return; }

  const generated = Array.from({ length: count }, (_, index) => `${prefix}-${String(start + index).padStart(digits, '0')}`);
  const item = inventoryItems.find((entry) => entry.title === itemTitle);
  const now = new Date().toISOString();
  const existing = new Set(serialRecords.map((row) => `${row.itemId}::${row.serial}`));
  const fresh: SerialRecord[] = generated
    .filter((serial) => !existing.has(`${item?.id ?? itemTitle}::${serial}`))
    .map((serial) => ({ id: crypto.randomUUID(), serial, itemId: item?.id ?? itemTitle, itemTitle, warehouse, status: 'موجود در انبار' as SerialStatus, createdAt: now, updatedAt: now }));
  if (!fresh.length) { showToast('همه‌ی سریال‌های این بازه قبلاً ثبت شده‌اند.'); return; }
  serialRecords = [...fresh, ...serialRecords];
  void apiFetch('/api/inventory/serials', { method: 'POST', body: JSON.stringify({ itemId: item?.id ?? itemTitle, itemTitle, warehouse, serials: generated }) }).catch(() => undefined);
  document.querySelector('#serial-modal')?.remove();
  render();
  showToast(`${fresh.length} شماره سریال برای «${itemTitle}» ثبت شد.`);
}

/** تغییر وضعیت یک سریال (تخصیص، فروش، برگشت، اسقاط) */
async function changeSerialStatus(id: string, status: SerialStatus): Promise<void> {
  const record = serialRecords.find((row) => row.id === id);
  if (!record) return;
  const previous = record.status;
  serialRecords = serialRecords.map((row) => (row.id === id ? { ...row, status, updatedAt: new Date().toISOString() } : row));
  render();
  try {
    const result = await apiFetch('/api/inventory/serials/status', { method: 'POST', body: JSON.stringify({ serialIds: [id], status }) });
    if (!result?.ok) throw new Error('server');
    showToast(`وضعیت ${record.serial} به «${status}» تغییر کرد.`);
  } catch {
    serialRecords = serialRecords.map((row) => (row.id === id ? { ...row, status: previous } : row));
    render();
    showToast('تغییر وضعیت در سرور ثبت نشد؛ تغییر به‌صورت محلی اعمال شد.');
    serialRecords = serialRecords.map((row) => (row.id === id ? { ...row, status } : row));
    render();
  }
}

function serialMarkup(): string {
  const byStatus = serialStatuses.map((status) => ({ status, count: serialRecords.filter((row) => row.status === status).length }));
  const filtered = serialRecords.filter((row) => (!serialFilter.status || row.status === serialFilter.status) && (!serialFilter.query || row.serial.includes(serialFilter.query) || row.itemTitle.includes(serialFilter.query)));
  return `<div class="panel serial-panel">
    <div class="panel-heading">
      <div><h2>رهگیری شماره سریال کالا</h2><p>ثبت گروهی، رهگیری وضعیت هر واحد کالا و ارتباط با مشتری یا سند</p></div>
      <button class="ghost-button" id="new-serial">＋ ثبت گروهی سریال</button>
    </div>
    <div class="serial-kpis">
      <div><span>کل سریال‌ها</span><strong>${serialRecords.length.toLocaleString('fa-IR')}</strong></div>
      ${byStatus.map((item) => `<div><span>${item.status}</span><strong>${item.count.toLocaleString('fa-IR')}</strong></div>`).join('')}
    </div>
    <div class="serial-filters">
      <input id="serial-search" class="form-input" placeholder="جست‌وجوی سریال، کالا یا مشتری" value="${escapeHtml(serialFilter.query)}">
      <select id="serial-status">
        <option value="">همه‌ی وضعیت‌ها</option>
        ${serialStatuses.map((status) => `<option value="${status}" ${status === serialFilter.status ? 'selected' : ''}>${status}</option>`).join('')}
      </select>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>شماره سریال</th><th>کالا</th><th>انبار</th><th>طرف حساب</th><th>وضعیت</th><th>آخرین تغییر</th><th>عملیات</th></tr></thead>
        <tbody>
          ${filtered.length ? filtered.slice(0, 60).map((row) => `<tr>
            <td class="serial-code">${escapeHtml(row.serial)}</td>
            <td>${escapeHtml(row.itemTitle)}</td>
            <td>${escapeHtml(row.warehouse)}</td>
            <td>${escapeHtml(row.party ?? '—')}</td>
            <td><span class="status ${row.status === 'موجود در انبار' ? 'approved' : row.status === 'فروخته‌شده' ? 'pending' : 'rejected'}">${row.status}</span></td>
            <td>${new Date(row.updatedAt).toLocaleDateString('fa-IR')}</td>
            <td>
              <select class="serial-action" data-serial="${row.id}">
                <option value="">تغییر وضعیت…</option>
                ${serialStatuses.filter((status) => status !== row.status).map((status) => `<option value="${status}">${status}</option>`).join('')}
              </select>
            </td>
          </tr>`).join('') : '<tr><td colspan="7" class="empty-cell">هنوز شماره سریالی ثبت نشده است.</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>`;
}

function openSerialForm(): void {
  const items = inventoryItems.slice(0, 12);
  openModal('serial-modal', 'serial-form', `<p class="eyebrow">رهگیری کالا</p><h2>ثبت گروهی شماره سریال</h2>
    <p class="modal-hint">سریال‌ها به‌صورت خودکار با پیشوند و شمارنده ساخته می‌شوند؛ سریال‌های تکراری نادیده گرفته می‌شوند.</p>
    <div class="form-grid">
      <label>کالا
        <select name="itemTitle" required>
          ${items.map((item) => `<option value="${escapeHtml(item.title)}">${escapeHtml(item.title)} (${escapeHtml(item.sku)})</option>`).join('')}
        </select>
      </label>
      <label>انبار<input name="warehouse" value="انبار اصلی" required></label>
      <label>پیشوند سریال<input name="prefix" placeholder="مثلاً SN" required></label>
      <label>شروع شمارنده<input name="start" type="number" min="0" value="1" required></label>
      <label>تعداد<input name="count" type="number" min="1" max="500" value="10" required></label>
      <label>تعداد ارقام<input name="digits" type="number" min="1" max="10" value="4" required></label>
    </div>
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="serial-modal">انصراف</button><button class="primary-button" type="submit">ثبت سریال‌ها</button></div>`);
  document.querySelector<HTMLFormElement>('#serial-form')?.addEventListener('submit', saveSerials);
}

function inventoryMarkup(): string { const value = inventoryItems.reduce((sum, item) => sum + item.quantity * item.unitCost, 0); return `<section class="inventory-page"><div class="treasury-kpis"><article><span>ارزش کل موجودی</span><strong>${value.toLocaleString('fa-IR')}</strong><small>ریال</small><b class="positive">↑ ۵.۴٪ این ماه</b></article><article><span>قلم کالا</span><strong>${inventoryItems.length.toLocaleString('fa-IR')}</strong><small>قلم</small><b>کالا و خدمات فعال</b></article><article><span>هشدار حداقل موجودی</span><strong>${inventoryItems.filter((item) => item.quantity <= item.minimumQuantity).length.toLocaleString('fa-IR')}</strong><small>قلم</small><b>نیازمند سفارش</b></article></div><div class="sales-toolbar"><div><h2>موجودی کالا</h2><p>موجودی بر اساس رسیدهای خرید و عملیات انبار.</p></div><button class="primary-button" data-feature="رسید ورود کالا">＋ ثبت رسید کالا</button></div>${serialMarkup()}
<div class="panel inventory-list"><div class="panel-heading"><div><h2>کارتابل موجودی</h2><p>موجودی نمونه و اقلام ثبت‌شده</p></div><span class="count">${inventoryItems.length} قلم</span></div>${inventoryItems.map((item) => `<div class="inventory-row"><span class="sku">${item.sku}</span><div><strong>${escapeHtml(item.title)}</strong><small>${item.unit} · ${item.isDemo ? 'داده نمونه آموزشی' : 'ثبت‌شده توسط شما'}</small></div><b>${item.quantity.toLocaleString('fa-IR')} ${item.unit}</b><span class="inventory-value">${(item.quantity * item.unitCost).toLocaleString('fa-IR')} ریال</span></div>`).join('')}</div>${inventoryCostingMarkup()}</section>`; }
/** کاتالوگ نقش‌های سمت سرور؛ برای نمایش در ماژول هویت و دسترسی */
const roleCatalog: Array<{ id: string; title: string; permissions: string[] }> = [
  { id: 'admin', title: 'مدیر سیستم', permissions: ['events.write', 'accounting.write', 'treasury.write', 'sales.write', 'purchasing.write', 'inventory.write', 'payroll.write', 'identity.manage', 'audit.read'] },
  { id: 'accountant', title: 'حسابدار', permissions: ['events.write', 'accounting.write', 'treasury.write', 'sales.read', 'purchasing.read', 'payroll.read'] },
  { id: 'sales', title: 'کارشناس فروش', permissions: ['events.write', 'sales.write', 'sales.read', 'inventory.read'] },
  { id: 'warehouse', title: 'انباردار', permissions: ['events.write', 'inventory.write', 'inventory.read', 'purchasing.read'] },
  { id: 'viewer', title: 'ناظر', permissions: ['events.read', 'accounting.read', 'sales.read', 'inventory.read'] },
];

const permissionLabels: Record<string, string> = {
  'events.read': 'مشاهده رویدادها', 'events.write': 'ثبت رویداد',
  'accounting.read': 'مشاهده حسابداری', 'accounting.write': 'ثبت اسناد حسابداری',
  'treasury.read': 'مشاهده خزانه', 'treasury.write': 'ثبت تراکنش خزانه',
  'sales.read': 'مشاهده فروش', 'sales.write': 'ثبت فاکتور فروش',
  'purchasing.read': 'مشاهده خرید', 'purchasing.write': 'ثبت سفارش خرید',
  'inventory.read': 'مشاهده انبار', 'inventory.write': 'گردش انبار',
  'payroll.read': 'مشاهده حقوق', 'payroll.write': 'محاسبه حقوق',
  'identity.manage': 'مدیریت کاربران', 'audit.read': 'مشاهده ردیابی عملیات',
};

const actionLabels: Record<string, string> = {
  'login': 'ورود به سیستم', 'login.failed': 'ورود ناموفق',
  'event.create': 'ثبت رویداد', 'event.delete': 'حذف رویداد',
  'user.create': 'ایجاد کاربر', 'user.activate': 'فعال‌سازی کاربر', 'user.deactivate': 'غیرفعال‌سازی کاربر',
  'journal.create': 'ثبت سند حسابداری', 'account.create': 'ایجاد حساب',
  'treasury.create': 'ثبت تراکنش خزانه', 'invoice.create': 'صدور فاکتور فروش',
  'numbering.reserve': 'دریافت شماره سند',
};

function identityMarkup(): string { return `<section class="access-page"><div class="access-kpis"><article><span>کاربران فعال</span><strong>${users.filter((user) => user.isActive).length}</strong><small>کاربر</small></article><article><span>نقش‌های سازمانی</span><strong>۴</strong><small>نقش</small></article><article><span>ماژول‌های محافظت‌شده</span><strong>۱۶</strong><small>ماژول</small></article></div><div class="panel user-list"><div class="panel-heading"><div><h2>کاربران و نقش‌ها</h2><p>فعال‌سازی کاربر و کنترل دسترسی عملیاتی</p></div><span class="count">RBAC</span></div>${users.map((user) => `<div class="user-row"><div class="avatar">${user.name.charAt(0)}</div><div><strong>${escapeHtml(user.name)}</strong><small>${user.username}</small></div><span class="role-pill">${escapeHtml(user.role)}</span><span class="status ${user.isActive ? 'approved' : 'pending'}">${user.isActive ? 'فعال' : 'غیرفعال'}</span><button class="user-toggle" data-user-toggle="${user.id}">${user.isActive ? 'غیرفعال‌سازی' : 'فعال‌سازی'}</button></div>`).join('')}</div><div class="permission-note"><strong>مدل دسترسی</strong><span>هر نقش مجموعه‌ای از مجوزهاست و دسترسی بر اساس شرکت، شعبه، انبار و عملیات قابل محدودسازی است.</span></div>${sessionPanelMarkup()}${rolesPanelMarkup()}${auditPanelMarkup()}</section>`; }

function sessionPanelMarkup(): string {
  const permissions = session?.permissions ?? [];
  return `<div class="panel session-panel"><div class="panel-heading"><div><h2>نشست جاری</h2><p>اطلاعات کاربر وارد‌شده بر اساس توکن سرور</p></div><span class="count">${escapeHtml(session?.roleId ?? 'local')}</span></div>${serverSession ? '' : '<div class="session-connect"><p>نشست سرور فعال نیست؛ برای ثبتِ داده‌ها روی سرور دوباره وارد شوید.</p><button class="primary-button" id="connect-server">اتصال به سرور</button></div>'}<div class="session-grid"><div><span>کاربر</span><strong>${escapeHtml(session?.name ?? '—')}</strong></div><div><span>نام کاربری</span><strong>${escapeHtml(session?.username ?? '—')}</strong></div><div><span>نقش</span><strong>${escapeHtml(session?.role ?? '—')}</strong></div><div><span>تعداد دسترسی</span><strong>${permissions.length ? String(permissions.length) : 'حالت محلی'}</strong></div></div>${permissions.length ? `<div class="permission-chips">${permissions.map((permission) => `<span class="tag-pill">${escapeHtml(permissionLabels[permission] ?? permission)}</span>`).join('')}</div>` : '<p class="empty-hint">دسترسی‌ها از سرور دریافت نشده‌اند؛ برنامه در حالت محلی اجرا می‌شود.</p>'}</div>`;
}

function rolesPanelMarkup(): string {
  return `<div class="panel roles-panel"><div class="panel-heading"><div><h2>نقش‌ها و دسترسی‌های سیستم</h2><p>مدل RBAC سرور؛ هر نقش مجموعه‌ای از مجوزهاست</p></div><span class="count">${roleCatalog.length} نقش</span></div><table class="data-table"><thead><tr><th>نقش</th><th>تعداد دسترسی</th><th>نمونه دسترسی‌ها</th></tr></thead><tbody>${roleCatalog.map((role) => `<tr><td><strong>${escapeHtml(role.title)}</strong><small>${role.id}</small></td><td>${role.permissions.length}</td><td>${role.permissions.slice(0, 5).map((permission) => `<span class="tag-pill">${escapeHtml(permissionLabels[permission] ?? permission)}</span>`).join('')}</td></tr>`).join('')}</tbody></table></div>`;
}

function auditPanelMarkup(): string {
  return `<div class="panel audit-panel"><div class="panel-heading"><div><h2>ردیابی عملیات</h2><p>ثبت خودکار ورود، ثبت اسناد و تغییرات کاربران روی سرور</p></div><button class="ghost-button" id="load-audit">بارگذاری از سرور</button></div><div id="audit-list" class="audit-list"><p class="empty-hint">برای مشاهده، «بارگذاری از سرور» را بزنید (این بخش فقط برای نقش مدیر سیستم در دسترس است).</p></div></div>`;
}

async function loadAudit(): Promise<void> {
  const container = document.querySelector<HTMLElement>('#audit-list');
  if (!container) return;
  container.innerHTML = '<p class="empty-hint">در حال بارگذاری…</p>';
  const result = await apiFetch('/api/audit?limit=30');
  if (!result || !result.ok) {
    container.innerHTML = '<p class="empty-hint">دریافت ردیابی عملیات ممکن نیست: سرور در دسترس نیست یا نقش شما مجاز نیست.</p>';
    return;
  }
  const payload = (await result.json()) as { data: Array<{ at: string; actor: string; action: string; entity: string; detail?: string }> };
  if (!payload.data.length) { container.innerHTML = '<p class="empty-hint">موردی ثبت نشده است.</p>'; return; }
  const rows = payload.data.map((entry) => `<tr><td>${new Date(entry.at).toLocaleString('fa-IR')}</td><td>${escapeHtml(entry.actor)}</td><td>${escapeHtml(actionLabels[entry.action] ?? entry.action)}</td><td>${escapeHtml(entry.entity)}</td><td>${escapeHtml(entry.detail ?? '—')}</td></tr>`).join('');
  container.innerHTML = `<table class="data-table"><thead><tr><th>زمان</th><th>کاربر</th><th>عملیات</th><th>موجودیت</th><th>توضیح</th></tr></thead><tbody>${rows}</tbody></table>`;
}
/** دریافت اسناد، دوره‌های مالی و مراکز هزینه از سرور؛ true یعنی داده‌ای تغییر کرده است */
/** بارگذاریِ داده‌ها از سرور — با محافظ در برابرِ فراخوانیِ هم‌زمان و پیاپی */
async function loadServerData(force = false): Promise<boolean> {
  if (serverDataInFlight) return serverDataInFlight;
  if (!force && Date.now() - lastServerDataAt < 2000) return false;
  serverDataInFlight = loadServerDataInner().finally(() => {
    serverDataInFlight = null;
    lastServerDataAt = Date.now();
  });
  return serverDataInFlight;
}

let serverDataInFlight: Promise<boolean> | null = null;
let lastServerDataAt = 0;
async function loadServerDataInner(): Promise<boolean> {
  const [documents, periods, centers, flow, journals, balances, summary, costing, movements, reconciliation, payslips, payrollTotalsResult, checkRows, checkTotals, insight] = await Promise.all([
    apiFetch('/api/documents'),
    apiFetch('/api/fiscal-periods'),
    apiFetch('/api/cost-centers'),
    apiFetch('/api/documents/transitions'),
    apiFetch('/api/accounting/entries'),
    apiFetch('/api/accounting/trial-balance'),
    apiFetch('/api/accounting/summary'),
    apiFetch(`/api/inventory/costing?method=${costingMethod}`),
    apiFetch('/api/inventory/movements'),
    apiFetch('/api/treasury/reconciliation'),
    apiFetch('/api/payroll/records'),
    apiFetch('/api/payroll/summary'),
    apiFetch('/api/treasury/checks'),
    apiFetch('/api/treasury/checks/summary'),
    apiFetch('/api/insights/summary'),
  ]);
  if (!documents?.ok && !periods?.ok && !centers?.ok && !flow?.ok && !journals?.ok) return false;
  const before = JSON.stringify([serverDocuments, fiscalPeriods, costCenters, workflowTransitions, journalEntries, trialBalance]);
  if (documents?.ok) serverDocuments = ((await documents.json()) as { data: ServerDocument[] }).data;
  if (periods?.ok) fiscalPeriods = ((await periods.json()) as { data: FiscalPeriod[] }).data;
  if (centers?.ok) costCenters = ((await centers.json()) as { data: CostCenter[] }).data;
  if (flow?.ok) workflowTransitions = ((await flow.json()) as { data: Record<string, WorkflowTransition[]> }).data;
  if (journals?.ok) journalEntries = ((await journals.json()) as { data: JournalEntry[] }).data;
  if (balances?.ok) trialBalance = ((await balances.json()) as { data: TrialBalanceRow[] }).data;
  if (summary?.ok) financialSummary = ((await summary.json()) as FinancialSummary);
  if (costing?.ok) inventoryCosting = ((await costing.json()) as typeof inventoryCosting);
  if (movements?.ok) stockMovements = ((await movements.json()) as typeof stockMovements);
  if (reconciliation?.ok) bankReconciliation = ((await reconciliation.json()) as typeof bankReconciliation);
  if (payslips?.ok) payrollRecords = ((await payslips.json()) as PayrollRecordItem[]);
  if (payrollTotalsResult?.ok) payrollTotals = ((await payrollTotalsResult.json()) as PayrollTotals);
  if (checkRows?.ok) checks = ((await checkRows.json()) as CheckRecordItem[]);
  if (checkTotals?.ok) checksSummary = ((await checkTotals.json()) as ChecksSummary);
  if (insight?.ok) insights = ((await insight.json()) as InsightSummary);
  return before !== JSON.stringify([serverDocuments, fiscalPeriods, costCenters, workflowTransitions, journalEntries, trialBalance]);
}

/** انجام یک انتقال در گردش کار سند */
async function transitionDocument(id: string, action: string): Promise<void> {
  const result = await apiFetch(`/api/documents/${id}/transitions`, { method: 'POST', body: JSON.stringify({ action }) });
  if (!result?.ok) {
    const payload = result ? ((await result.json().catch(() => ({}))) as { error?: string }).error : null;
    showToast(payload ?? 'انجام این انتقال ممکن نیست؛ سرور در دسترس نیست.');
    return;
  }
  const updated = (await result.json().catch(() => ({}))) as { journal?: { number: number } | null; status?: string };
  await loadServerData(true);
  render();
  showToast(updated.journal ? `سند قطعی شد و سند حسابداری شماره ${updated.journal.number} به‌طور خودکار صادر شد.` : 'وضعیت سند در گردش کار به‌روزرسانی شد.');
}

/** قطعی‌کردن یک سند حسابداری پیش‌نویس */
async function postJournalEntry(id: string): Promise<void> {
  const result = await apiFetch(`/api/accounting/entries/${id}/post`, { method: 'POST' });
  if (!result?.ok) { showToast('قطعی‌کردن سند حسابداری ممکن نیست.'); return; }
  await loadServerData(true);
  render();
  showToast('سند حسابداری قطعی شد و وارد تراز آزمایشی شد.');
}

function showDocumentHistory(id: string): void {
  const record = serverDocuments.find((item) => item.id === id);
  if (!record) return;
  const steps = record.history.map((step) => `<div class="history-step"><span>${new Date(step.at).toLocaleString('fa-IR')}</span><strong>${escapeHtml(step.from)} ← ${escapeHtml(step.to)}</strong><small>${escapeHtml(step.actor)} · ${escapeHtml(actionLabels[step.action] ?? step.action)}${step.comment ? ` · ${escapeHtml(step.comment)}` : ''}</small></div>`).join('');
  openModal('document-history-modal', 'document-history-form', `<h2>تاریخچه سند ${record.number}</h2><p class="modal-hint">${escapeHtml(record.title)}</p><div class="history-list">${steps}</div>
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="document-history-modal">بستن</button></div>`);
}

async function addCostCenter(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const body = new FormData(form);
  const code = String(body.get('code') ?? '').trim();
  const title = String(body.get('title') ?? '').trim();
  if (!code || !title) { showToast('کد و عنوان مرکز هزینه را وارد کنید.'); return; }
  const result = await apiFetch('/api/cost-centers', { method: 'POST', body: JSON.stringify({ code, title }) });
  if (!result?.ok) {
    const payload = result ? ((await result.json().catch(() => ({}))) as { error?: string }).error : null;
    showToast(payload ?? 'ثبت مرکز هزینه ناموفق بود.');
    return;
  }
  form.reset();
  await loadServerData(true);
  render();
  showToast('مرکز هزینه جدید ثبت شد.');
}

async function togglePeriod(id: string, status: string): Promise<void> {
  const result = await apiFetch(`/api/fiscal-periods/${id}`, { method: 'PATCH', body: JSON.stringify({ status: status === 'باز' ? 'بسته' : 'باز' }) });
  if (!result?.ok) { showToast('تغییر وضعیت دوره ممکن نیست.'); return; }
  await loadServerData(true);
  render();
  showToast('وضعیت دوره مالی به‌روزرسانی شد.');
}

function fiscalSettingsMarkup(): string {
  // بخش‌هایی که کاربر مجوز آن‌ها را ندارد کلاً نمایش داده نمی‌شوند
  if (session?.permissions?.length && !session.permissions.includes('accounting.read')) return '';
  const periods = fiscalPeriods.length ? `<div class="period-list">${fiscalPeriods.map((period) => `<div class="period-row"><div><strong>${escapeHtml(period.title)}</strong><small>${period.startsOn} تا ${period.endsOn}</small></div><button class="workflow-action period-action" data-toggle-period="${period.id}" data-status="${period.status}">${period.status === 'باز' ? 'بستن دوره' : 'بازگشایی'}</button></div>`).join('')}</div>` : '<p class="empty-hint">دوره‌ای تعریف نشده است.</p>';
  const centers = costCenters.length ? `<div class="cost-center-list">${costCenters.map((center) => `<div class="cost-center-row"><span class="account-code">${escapeHtml(center.code)}</span><strong>${escapeHtml(center.title)}</strong></div>`).join('')}</div>` : '<p class="empty-hint">مرکز هزینه‌ای تعریف نشده است.</p>';
  const years = [...new Set(fiscalPeriods.map((period) => Number(period.year)).filter((year) => Number.isFinite(year)))].sort((a, b) => b - a);
  const openYears = years.filter((year) => fiscalPeriods.some((period) => Number(period.year) === year && period.status === 'باز'));
  return `<div class="panel-heading"><div><h2>سال مالی و مراکز هزینه</h2><p>دوره‌ها و مراکز هزینه از سرور خوانده می‌شوند و به اسناد متصل می‌شوند</p></div>
    <div class="panel-tools">
      ${openYears.length ? `<select id="close-year" class="year-select">${openYears.map((year) => `<option value="${year}">بستن سال ${year}</option>`).join('')}</select><button type="button" class="btn-secondary small fiscal-close-button" id="close-fiscal-year">🔒 بستن سال مالی</button>` : '<span class="count">همه‌ی دوره‌ها بسته‌اند</span>'}
    </div>
    <span class="count">${fiscalPeriods.length} دوره · ${costCenters.length} مرکز</span></div><div class="fiscal-grid"><div><h4>دوره‌های مالی</h4>${periods}</div><div><h4>مراکز هزینه</h4>${centers}<form class="cost-center-form" data-cost-center-form><input name="code" placeholder="کد (مثل CC-1007)" required><input name="title" placeholder="عنوان مرکز هزینه" required><button class="primary-button" type="submit">＋ افزودن مرکز</button></form></div></div>`;
}

/** پنل اسناد حسابداری صادرشده روی سرور و تراز آزمایشی (فاز ۲) */
/* ===================== بهای تمام‌شده‌ی موجودی ===================== */


/* ===================== فاز ۳: حقوق و دستمزد ===================== */

type PayrollCalculation = {
  baseSalary: number;
  allowances: number;
  overtime: number;
  gross: number;
  insuranceEmployee: number;
  insuranceEmployer: number;
  taxableIncome: number;
  incomeTax: number;
  netPay: number;
  employerCost: number;
  eidProvision: number;
  seniorityProvision: number;
};
type PayrollRecordItem = { id: string; period: string; personnelCode: string; fullName: string; result: PayrollCalculation; journalId?: string };
type PayrollTotals = { count: number; gross: number; netPay: number; insuranceEmployee: number; insuranceEmployer: number; incomeTax: number; employerCost: number };
type CheckRecordItem = { id: string; number: string; serial: string; bank: string; amount: number; issueDate: string; dueDate: string; direction: string; party: string; status: string; description?: string };
type ChecksSummary = { receivable: { count: number; amount: number }; payable: { count: number; amount: number }; bounced: { count: number; amount: number }; dueSoon: { count: number; amount: number } };
type InsightSummary = {
  finance: { assets: number; liabilities: number; equity: number; netIncome: number; revenue: number; expense: number; cash: number; receivables: number; inventory: number; payables: number };
  operations: { documents: number; posted: number; pending: number; rejected: number };
  payroll: PayrollTotals;
  checks: ChecksSummary;
};

let payrollPreview: PayrollCalculation | null = null;
let payrollRecords: PayrollRecordItem[] = [];
let payrollTotals: PayrollTotals | null = null;
let checks: CheckRecordItem[] = [];
let checksSummary: ChecksSummary | null = null;
let insights: InsightSummary | null = null;
/** فهرستِ نسخه‌های پشتیبانِ روی سرور (پنلِ پشتیبان‌گیری) */
let backupFiles: Array<{ name: string; at: string; size: number }> = [];
/** سقف اعتبارِ مشتریان (نام مشتری → سقف به ریال) */
let creditLimits: Record<string, number> = readKey<Record<string, number>>('erp-credit-limits', {});
/** آیا فهرستِ اسنادِ تکرارشونده یک‌بار بارگذاری شده است؟ */
let recurringLoaded = false;

function payrollMarkup(): string {
  const canRead = !session?.permissions?.length || session.permissions.includes('payroll.read');
  if (!canRead) return '';
  const preview = payrollPreview;
  return `<div class="panel report-panel">
    <div class="panel-heading"><div><h2>محاسبه حقوق و دستمزد</h2><p>محاسبه طبق قانون کار: بیمه، مالیات پلکانی، عیدی و سنوات</p></div>
      <span class="count">${payrollTotals?.count ?? 0} فیش</span></div>
    <div class="costing-summary">
      <article><span>خالص پرداختی دوره</span><strong>${money(payrollTotals?.netPay ?? 0)}</strong><small>ریال</small></article>
      <article><span>مالیات حقوق</span><strong>${money(payrollTotals?.incomeTax ?? 0)}</strong><small>ریال</small></article>
      <article><span>بیمه سهم کارفرما</span><strong>${money(payrollTotals?.insuranceEmployer ?? 0)}</strong><small>ریال</small></article>
      <article class="accent"><span>هزینه تمام‌شده کارفرما</span><strong>${money(payrollTotals?.employerCost ?? 0)}</strong><small>ریال</small></article>
    </div>
    ${preview ? `<div class="payslip-preview">
      <h3>پیش‌نمایش فیش حقوق</h3>
      <div class="payslip-grid">
        <div><span>حقوق پایه</span><strong>${money(preview.baseSalary)}</strong></div>
        <div><span>مزایای قانونی</span><strong>${money(preview.allowances)}</strong></div>
        <div><span>اضافه‌کاری</span><strong>${money(preview.overtime)}</strong></div>
        <div><span>ناخالص</span><strong>${money(preview.gross)}</strong></div>
        <div><span>بیمه سهم کارمند (۷٪)</span><strong class="negative-amount">${money(preview.insuranceEmployee)}</strong></div>
        <div><span>مالیات حقوق</span><strong class="negative-amount">${money(preview.incomeTax)}</strong></div>
        <div class="total"><span>خالص پرداختی</span><strong>${money(preview.netPay)}</strong></div>
        <div class="total"><span>هزینه کارفرما</span><strong>${money(preview.employerCost)}</strong></div>
      </div>
      <p class="report-note ok">عیدی: ${money(preview.eidProvision)} ریال · سنوات: ${money(preview.seniorityProvision)} ریال</p>
    </div>` : ''}
    ${payrollRecords.length ? `<table class="report-table"><thead><tr><th>دوره</th><th>کارمند</th><th class="num">ناخالص</th><th class="num">مالیات</th><th class="num">خالص</th><th>سند</th></tr></thead><tbody>${payrollRecords
      .map((row) => `<tr><td>${escapeHtml(row.period)}</td><td><strong>${escapeHtml(row.fullName)}</strong><small>${escapeHtml(row.personnelCode)}</small></td><td class="num">${money(row.result.gross)}</td><td class="num">${money(row.result.incomeTax)}</td><td class="num">${money(row.result.netPay)}</td><td>${row.journalId ? '<span class="status approved">صدور شده</span>' : '<span class="status">—</span>'}</td></tr>`)
      .join('')}</tbody></table>` : '<p class="empty-hint">هنوز فیشی ثبت نشده است</p>'}
    <div class="panel-actions-bar"><button class="primary-button small" id="payroll-calc">محاسبه و ثبت فیش</button></div>
  </div>`;
}

/** تبدیل فرم حقوق به ورودی موتور محاسبه */
function payrollPayload(): Record<string, number | string> {
  const form = document.querySelector<HTMLFormElement>('#payroll-form');
  const value = (name: string): number => Number(form?.querySelector<HTMLInputElement>(`[name=${name}]`)?.value ?? 0);
  return {
    baseSalary: value('baseSalary'),
    benefits: value('benefits'),
    childrenCount: value('childrenCount'),
    seniorityYears: value('seniorityYears'),
    overtimeHours: value('overtimeHours'),
    overtimeRate: value('overtimeRate'),
    otherDeductions: value('otherDeductions'),
  };
}

function openPayslipForm(): void {
  openModal('payroll-modal', 'payroll-form', `<p class="eyebrow">حقوق و دستمزد</p><h2>محاسبه و ثبت فیش</h2>
    <p class="modal-hint">با دکمه‌ی «محاسبه» خلاصه فیش را پیش‌نمایش کنید؛ سپس در صورت تأیید ثبت و سند حسابداری صادر می‌شود.</p>
    <div class="form-grid">
      <label>دوره<input name="period" required value="شهریور ۱۴۰۵"></label>
      <label>کد پرسنلی<input name="personnelCode" placeholder="۱۰۰۱"></label>
      <label>نام کارمند<input name="fullName" required placeholder="مریم احمدی"></label>
      <label>حقوق پایه ماهانه (ریال)<input name="baseSalary" type="number" min="0" step="1" required value="120000000"></label>
      <label>تعداد فرزند<input name="childrenCount" type="number" min="0" step="1" value="0"></label>
      <label>سنوات خدمت (سال)<input name="seniorityYears" type="number" min="0" step="1" value="0"></label>
      <label>ساعات اضافه‌کاری<input name="overtimeHours" type="number" min="0" step="1" value="0"></label>
      <label>نرخ اضافه‌کاری (ریال)<input name="overtimeRate" type="number" min="0" step="1" value="0"></label>
      <label>مزایای مشمول بیمه<input name="benefits" type="number" min="0" step="1" value="0"></label>
      <label>کسورات متفرقه<input name="otherDeductions" type="number" min="0" step="1" value="0"></label>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-cancel" data-close="payroll-modal">انصراف</button>
      <button class="ghost-button" type="button" id="payroll-preview">محاسبه</button>
      <button class="primary-button" type="submit">ثبت و صدور سند</button>
    </div>`);
  document.querySelector<HTMLButtonElement>('#payroll-preview')?.addEventListener('click', () => void previewPayroll());
  document.querySelector<HTMLFormElement>('#payroll-form')?.addEventListener('submit', (event) => void savePayslip(event));
}

async function previewPayroll(): Promise<void> {
  const result = await apiFetch('/api/payroll/calculate', { method: 'POST', body: JSON.stringify(payrollPayload()) });
  if (!result?.ok) { showToast('محاسبه انجام نشد'); return; }
  payrollPreview = (await result.json()) as PayrollCalculation;
  closeAnyModal('payroll-modal');
  render();
  showToast(`خالص پرداختی: ${money(payrollPreview.netPay)} ریال`);
}

async function savePayslip(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const payload = {
    period: String(data.get('period') ?? '').trim(),
    personnelCode: String(data.get('personnelCode') ?? '').trim(),
    fullName: String(data.get('fullName') ?? '').trim(),
    payroll: payrollPayload(),
    postJournal: true,
  };
  const result = await apiFetch('/api/payroll/records', { method: 'POST', body: JSON.stringify(payload) });
  if (!result?.ok) {
    const message = result ? (((await result.json().catch(() => ({}))) as { error?: string }).error ?? 'ثبت فیش ناموفق بود') : 'سرور در دسترس نیست';
    showToast(message);
    return;
  }
  const record = (await result.json()) as PayrollRecordItem;
  payrollPreview = record.result;
  closeAnyModal('payroll-modal');
  await loadServerData(true);
  render();
  showToast(`فیش ${record.fullName} ثبت و سند حسابداری صادر شد`);
}

/* ===================== فاز ۳: چک‌ها ===================== */

function checksMarkup(): string {
  if (session?.permissions?.length && !session.permissions.includes('treasury.read')) {
    return '';
  }
  const summary = checksSummary;
  return `<div class="panel report-panel">
    <div class="panel-heading"><div><h2>چک‌های دریافتنی و پرداختنی</h2><p>پیگیری سررسید، وصول، پرداخت و برگشتی‌ها</p></div>
      <span class="count">${checks.length} چک</span></div>
    <div class="recon-summary">
      <article><span>چک‌های دریافتنی</span><strong>${money(summary?.receivable.amount ?? 0)}</strong><small>${summary?.receivable.count ?? 0} فقره</small></article>
      <article><span>چک‌های پرداختنی</span><strong>${money(summary?.payable.amount ?? 0)}</strong><small>${summary?.payable.count ?? 0} فقره</small></article>
      <article class="warn"><span>سررسید یک هفته</span><strong>${money(summary?.dueSoon.amount ?? 0)}</strong><small>${summary?.dueSoon.count ?? 0} فقره</small></article>
      <article class="accent"><span>برگشتی</span><strong>${money(summary?.bounced.amount ?? 0)}</strong><small>${summary?.bounced.count ?? 0} فقره</small></article>
    </div>
    ${checks.length ? `<table class="report-table"><thead><tr><th>شماره</th><th>بانک</th><th>طرف حساب</th><th>نوع</th><th class="num">مبلغ</th><th>سررسید</th><th>وضعیت</th><th></th><th>چاپ</th></tr></thead><tbody>${checks
      .map((row) => {
        const statusClass = row.status === 'وصول شده' || row.status === 'پرداخت شده' ? 'approved' : row.status === 'برگشتی' ? 'rejected' : 'pending';
        return `<tr><td><strong>${escapeHtml(row.number)}</strong><small>${escapeHtml(row.serial)}</small></td><td>${escapeHtml(row.bank)}</td><td>${escapeHtml(row.party)}</td>
          <td>${escapeHtml(row.direction)}</td><td class="num">${money(row.amount)}</td><td>${escapeHtml(row.dueDate)}</td>
          <td><span class="status ${statusClass}">${escapeHtml(row.status)}</span></td>
          <td>${row.status === 'در جریان وصول'
            ? `<button class="mini-button" data-check-status="${row.id}" data-status="${row.direction === 'دریافتنی' ? 'وصول شده' : 'پرداخت شده'}">تأیید</button>
               <button class="mini-button" data-check-status="${row.id}" data-status="برگشتی">برگشتی</button>`
            : `<button class="mini-button" data-check-status="${row.id}" data-status="در جریان وصول">بازگشت</button>`}</td><td><button class="mini-button" data-print-check="${row.id}" title="چاپ چک">🖨</button></td></tr>`;
      })
      .join('')}</tbody></table>` : '<p class="empty-hint">چکی ثبت نشده است</p>'}
    <div class="panel-actions-bar"><button class="primary-button small" id="check-new">ثبت چک جدید</button></div>
  </div>`;
}

function openCheckForm(): void {
  const today = new Date().toISOString().slice(0, 10);
  openModal('check-modal', 'check-form', `<p class="eyebrow">خزانه</p><h2>ثبت چک</h2>
    <div class="form-grid">
      <label>شماره چک<input name="number" required placeholder="۲۱۰۴۵"></label>
      <label>سریال<input name="serial" placeholder="الف/۱۲"></label>
      <label>بانک<input name="bank" required placeholder="ملت"></label>
      <label>نوع<select name="direction"><option value="دریافتنی">دریافتنی</option><option value="پرداختنی">پرداختنی</option></select></label>
      <label>مبلغ (ریال)<input name="amount" type="number" min="1" step="1" required></label>
      <label>طرف حساب<input name="party" required placeholder="شرکت آفتاب"></label>
      <label>تاریخ صدور<input name="issueDate" type="date" required value="${today}"></label>
      <label>تاریخ سررسید<input name="dueDate" type="date" required></label>
    </div>
    <label>شرح<input name="description" placeholder="اختیاری"></label>
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="check-modal">انصراف</button><button class="primary-button" type="submit">ثبت چک</button></div>`);
  document.querySelector<HTMLFormElement>('#check-form')?.addEventListener('submit', (event) => void saveCheck(event));
}

async function saveCheck(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const data = new FormData(event.currentTarget as HTMLFormElement);
  const payload = {
    number: String(data.get('number') ?? '').trim(),
    serial: String(data.get('serial') ?? '').trim(),
    bank: String(data.get('bank') ?? '').trim(),
    direction: String(data.get('direction') ?? 'دریافتنی') as 'دریافتنی' | 'پرداختنی',
    amount: Number(data.get('amount')),
    party: String(data.get('party') ?? '').trim(),
    issueDate: String(data.get('issueDate') ?? ''),
    dueDate: String(data.get('dueDate') ?? ''),
    description: String(data.get('description') ?? '').trim(),
  };
  const result = await apiFetch('/api/treasury/checks', { method: 'POST', body: JSON.stringify(payload) });
  if (!result?.ok) {
    const message = result ? (((await result.json().catch(() => ({}))) as { error?: string }).error ?? 'ثبت چک ناموفق بود') : 'سرور در دسترس نیست';
    showToast(message);
    return;
  }
  closeAnyModal('check-modal');
  await loadServerData(true);
  render();
  showToast('چک ثبت شد');
}

async function updateCheckStatus(id: string, status: string): Promise<void> {
  const result = await apiFetch(`/api/treasury/checks/${id}`, { method: 'POST', body: JSON.stringify({ status }) });
  if (!result?.ok) { showToast('تغییر وضعیت انجام نشد'); return; }
  await loadServerData(true);
  render();
  showToast(`وضعیت چک: ${status}`);
}

/* ===================== فاز ۴: شاخص‌های مدیریتی ===================== */

function insightsMarkup(): string {
  if (!insights) return '';
  const finance = insights.finance;
  const margin = finance.revenue > 0 ? (finance.netIncome / finance.revenue) * 100 : 0;
  return `<div class="panel insights-panel">
    <div class="panel-heading"><div><h2>شاخص‌های کلیدی عملکرد</h2><p>خلاصه وضعیت مالی و عملیاتی در یک نگاه</p></div>
      <div class="panel-actions-bar inline">
        <button class="mini-button" id="export-csv">خروجی اکسل (CSV)</button>
        <button class="mini-button" id="print-report">چاپ / PDF</button>
      </div></div>
    <div class="kpi-grid">
      <article><span>درآمد</span><strong>${money(finance.revenue)}</strong><small>ریال</small></article>
      <article><span>هزینه</span><strong>${money(finance.expense)}</strong><small>ریال</small></article>
      <article class="${finance.netIncome >= 0 ? 'accent' : 'warn'}"><span>سود / زیان خالص</span><strong>${money(Math.abs(finance.netIncome))}</strong><small>${finance.netIncome >= 0 ? 'سود' : 'زیان'} · حاشیه ${margin.toFixed(1)}٪</small></article>
      <article><span>نقد و بانک</span><strong>${money(finance.cash)}</strong><small>ریال</small></article>
      <article><span>دریافتنی</span><strong>${money(finance.receivables)}</strong><small>ریال</small></article>
      <article><span>پرداختنی</span><strong>${money(finance.payables)}</strong><small>ریال</small></article>
      <article><span>اسناد در جریان</span><strong>${insights.operations.pending}</strong><small>از ${insights.operations.documents} سند</small></article>
      <article><span>اسناد قطعی</span><strong>${insights.operations.posted}</strong><small>سند</small></article>
    </div>
  </div>`;
}

/** خروجی اکسل از جدول‌های گزارش */
function exportTablesToCsv(): void {
  const rows: string[] = ['گزارش شاخص‌های کلیدی'];
  if (insights) {
    rows.push('');
    rows.push('شاخص,مبلغ (ریال)');
    rows.push(`درآمد,${insights.finance.revenue}`);
    rows.push(`هزینه,${insights.finance.expense}`);
    rows.push(`سود و زیان,${insights.finance.netIncome}`);
    rows.push(`نقد و بانک,${insights.finance.cash}`);
    rows.push(`دریافتنی,${insights.finance.receivables}`);
    rows.push(`پرداختنی,${insights.finance.payables}`);
    rows.push(`اسناد قطعی,${insights.operations.posted}`);
    rows.push(`اسناد در جریان,${insights.operations.pending}`);
    rows.push(`تعداد فیش حقوق,${insights.payroll.count}`);
    rows.push(`خالص پرداختی حقوق,${insights.payroll.netPay}`);
    rows.push(`چک‌های دریافتنی,${insights.checks.receivable.amount}`);
    rows.push(`چک‌های پرداختنی,${insights.checks.payable.amount}`);
  }
  const download = (name: string, lines: string[]): void => {
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  };
  download(`گزارش-مدیریتی-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  showToast('فایل اکسل (CSV) آماده شد');
}

function inventoryCostingMarkup(): string {
  if (session?.permissions?.length && !session.permissions.includes('inventory.read')) {
    return '';
  }
  const rows = inventoryCosting?.rows ?? [];
  return `<div class="panel report-panel">
    <div class="panel-heading"><div><h2>بهای تمام‌شده‌ی موجودی</h2><p>محاسبه به روش میانگین موزون یا FIFO</p></div>
      <div class="method-switch">
        <button class="method-option ${costingMethod === 'wac' ? 'active' : ''}" data-costing-method="wac">میانگین موزون</button>
        <button class="method-option ${costingMethod === 'fifo' ? 'active' : ''}" data-costing-method="fifo">FIFO</button>
      </div>
    </div>
    <div class="costing-summary">
      <article><span>ارزش کل موجودی</span><strong>${money(inventoryCosting?.totalValue ?? 0)}</strong><small>ریال — روش ${costingMethod === 'wac' ? 'میانگین موزون' : 'FIFO'}</small></article>
      <article><span>تعداد کالا</span><strong>${rows.length}</strong><small>قلم کالا</small></article>
      <article><span>تعداد حرکت‌ها</span><strong>${stockMovements.length}</strong><small>ورود و خروج</small></article>
    </div>
    ${rows.length
      ? `<table class="report-table"><thead><tr><th>کالا</th><th class="num">موجودی</th><th class="num">بهای واحد</th><th class="num">ارزش</th></tr></thead><tbody>${rows
          .map((row) => `<tr><td><strong>${escapeHtml(row.itemTitle)}</strong><small>${escapeHtml(row.itemId)}</small></td><td class="num">${money(row.quantity)}</td><td class="num">${money(Math.round(row.unitCost))}</td><td class="num">${money(row.value)}</td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="empty-hint">هنوز حرکت انباری ثبت نشده است</p>'}
    <div class="panel-actions-bar"><button class="primary-button small" id="stock-movement">ثبت ورود / خروج انبار</button></div>
  </div>`;
}

function openStockMovementForm(): void {
  openModal('stock-modal', 'stock-form', `<p class="eyebrow">انبار</p><h2>ثبت حرکت انبار</h2>
    <p class="modal-hint">برای ورود، بهای واحد را وارد کنید. برای خروج، بهای واحد بر اساس روش انتخابی به‌طور خودکار محاسبه می‌شود.</p>
    <div class="form-grid">
      <label>کد کالا<input name="itemId" required placeholder="RM-100"></label>
      <label>نام کالا<input name="itemTitle" required placeholder="ورق فولاد ۲ میل"></label>
      <label>نوع حرکت<select name="type"><option value="ورود">ورود به انبار</option><option value="خروج">خروج از انبار</option></select></label>
      <label>مقدار<input name="quantity" type="number" min="1" step="1" required></label>
      <label>بهای واحد (ریال)<input name="unitCost" type="number" min="0" step="1" placeholder="فقط برای ورود"></label>
      <label>روش محاسبه<select name="method"><option value="wac" ${costingMethod === 'wac' ? 'selected' : ''}>میانگین موزون</option><option value="fifo" ${costingMethod === 'fifo' ? 'selected' : ''}>FIFO</option></select></label>
    </div>
    <label>شرح<input name="reference" placeholder="اختیاری — شماره رسید یا حواله"></label>
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="stock-modal">انصراف</button><button class="primary-button" type="submit">ثبت حرکت</button></div>`);
  document.querySelector<HTMLFormElement>('#stock-form')?.addEventListener('submit', (event) => void saveStockMovement(event));
}

async function saveStockMovement(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const data = new FormData(event.currentTarget as HTMLFormElement);
  const payload = {
    itemId: String(data.get('itemId') ?? '').trim(),
    itemTitle: String(data.get('itemTitle') ?? '').trim(),
    type: String(data.get('type') ?? 'ورود') as 'ورود' | 'خروج',
    quantity: Number(data.get('quantity')),
    unitCost: data.get('unitCost') ? Number(data.get('unitCost')) : undefined,
    method: String(data.get('method') ?? 'wac') as 'wac' | 'fifo',
    reference: String(data.get('reference') ?? '').trim(),
  };
  const result = await apiFetch('/api/inventory/movements', { method: 'POST', body: JSON.stringify(payload) });
  if (!result?.ok) {
    const message = result ? (((await result.json().catch(() => ({}))) as { error?: string }).error ?? 'ثبت حرکت ناموفق بود') : 'سرور در دسترس نیست';
    showToast(message);
    return;
  }
  const movement = (await result.json()) as { type: string; quantity: number; unitCost: number; costAmount: number };
  closeAnyModal('stock-modal');
  await loadServerData(true);
  render();
  showToast(`${movement.type} ${money(movement.quantity)} واحد با بهای ${money(Math.round(movement.unitCost))} ثبت شد (${money(movement.costAmount)} ریال)`);
}

/* ===================== تطبیق بانکی ===================== */

function bankReconciliationMarkup(): string {
  if (session?.permissions?.length && !session.permissions.includes('treasury.read')) {
    return '';
  }
  const data = bankReconciliation;
  const suggestions = data?.suggestions ?? [];
  return `<div class="panel report-panel">
    <div class="panel-heading"><div><h2>تطبیق بانکی</h2><p>مقایسه‌ی صورت‌حساب بانک با سطرهای حساب بانک در اسناد قطعی</p></div>
      <span class="count">${data ? `${data.matched.length} تطبیق‌یافته` : '—'}</span></div>
    <div class="recon-summary">
      <article><span>صورت‌حساب</span><strong>${data?.statements.length ?? 0}</strong><small>ردیف</small></article>
      <article><span>دفتر بانک</span><strong>${data?.ledger.length ?? 0}</strong><small>سطر سند</small></article>
      <article class="accent"><span>تطبیق‌یافته</span><strong>${data?.matched.length ?? 0}</strong><small>مورد</small></article>
      <article class="warn"><span>تطبیق‌نیافته</span><strong>${data?.unmatchedStatements?.length ?? 0}</strong><small>ردیف</small></article>
    </div>
    ${suggestions.length ? `<p class="report-note ok">${suggestions.length} مورد پیشنهاد تطبیق خودکار بر اساس برابری مبلغ و نزدیکی تاریخ</p>` : ''}
    ${(data?.statements.length ?? 0) > 0
      ? `<table class="report-table"><thead><tr><th>تاریخ</th><th>شرح</th><th>نوع</th><th class="num">مبلغ</th><th>وضعیت</th><th></th></tr></thead><tbody>${(data?.statements ?? [])
          .map((row) => {
            const suggestion = suggestions.find((item) => item.statementId === row.id);
            const match = data?.matched.find((item) => item.statement.id === row.id);
            return `<tr><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.description)}</td><td>${escapeHtml(row.direction)}</td><td class="num">${money(row.amount)}</td>
              <td>${match ? `<span class="status approved">تطبیق‌شده با سند ${match.line.entryNumber}</span>` : suggestion ? '<span class="status pending">پیشنهاد تطبیق</span>' : '<span class="status">تطبیق‌نیافته</span>'}</td>
              <td>${match
                ? `<button class="mini-button" data-match-statement="${row.id}" data-entry="">لغو تطبیق</button>`
                : suggestion
                  ? `<button class="mini-button" data-match-statement="${row.id}" data-entry="${suggestion.entryId}">تطبیق ${Math.round(suggestion.confidence)}٪</button>`
                  : ''}</td></tr>`;
          })
          .join('')}</tbody></table>`
      : '<p class="empty-hint">صورت‌حسابی ثبت نشده است</p>'}
    <div class="panel-actions-bar"><button class="primary-button small" id="bank-statement">ثبت ردیف صورت‌حساب</button></div>
  </div>`;
}

function openBankStatementForm(): void {
  openModal('bank-modal', 'bank-form', `<p class="eyebrow">خزانه</p><h2>ردیف صورت‌حساب بانک</h2>
    <p class="modal-hint">ردیف‌های صورت‌حساب با سطرهای حساب بانک (۱۱۰۰) در اسناد قطعی مقایسه می‌شوند.</p>
    <div class="form-grid">
      <label>تاریخ<input name="date" type="date" required value="${new Date().toISOString().slice(0, 10)}"></label>
      <label>نوع<select name="direction"><option value="دریافت">دریافت (واریز)</option><option value="پرداخت">پرداخت (برداشت)</option></select></label>
      <label>مبلغ (ریال)<input name="amount" type="number" min="1" step="1" required></label>
      <label>شماره پیگیری<input name="reference" placeholder="اختیاری"></label>
    </div>
    <label>شرح<input name="description" required placeholder="مثلاً واریز نقدی مشتری"></label>
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="bank-modal">انصراف</button><button class="primary-button" type="submit">ثبت</button></div>`);
  document.querySelector<HTMLFormElement>('#bank-form')?.addEventListener('submit', (event) => void saveBankStatement(event));
}

async function saveBankStatement(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const data = new FormData(event.currentTarget as HTMLFormElement);
  const payload = {
    date: String(data.get('date') ?? ''),
    direction: String(data.get('direction') ?? 'دریافت') as 'دریافت' | 'پرداخت',
    amount: Number(data.get('amount')),
    reference: String(data.get('reference') ?? '').trim(),
    description: String(data.get('description') ?? '').trim(),
  };
  const result = await apiFetch('/api/treasury/statements', { method: 'POST', body: JSON.stringify(payload) });
  if (!result?.ok) {
    const message = result ? (((await result.json().catch(() => ({}))) as { error?: string }).error ?? 'ثبت ناموفق بود') : 'سرور در دسترس نیست';
    showToast(message);
    return;
  }
  closeAnyModal('bank-modal');
  await loadServerData(true);
  render();
  showToast('ردیف صورت‌حساب ثبت شد');
}

async function matchBankStatement(statementId: string, entryId: string): Promise<void> {
  const result = await apiFetch('/api/treasury/reconciliation', { method: 'POST', body: JSON.stringify({ statementId, entryId: entryId || null }) });
  if (!result?.ok) { showToast('تطبیق انجام نشد'); return; }
  await loadServerData(true);
  render();
  showToast(entryId ? 'تطبیق با سند حسابداری ثبت شد' : 'تطبیق لغو شد');
}

function serverLedgerMarkup(): string {
  const summary = financialSummary
    ? `<div class="ledger-summary"><div><span>اسناد قطعی</span><strong>${financialSummary.postedEntries}</strong></div><div><span>پیش‌نویس</span><strong>${financialSummary.draftEntries}</strong></div><div><span>جمع بدهکار</span><strong>${financialSummary.totalDebit.toLocaleString('fa-IR')}</strong></div><div><span>جمع بستانکار</span><strong>${financialSummary.totalCredit.toLocaleString('fa-IR')}</strong></div><div><span>توازن</span><strong class="${financialSummary.balanced ? 'positive' : 'negative'}">${financialSummary.balanced ? 'متوازن ✓' : 'نامتوازن'}</strong></div></div>`
    : '';
  const entries = journalEntries.length
    ? `<div class="entry-list">${journalEntries.map((entry) => `<div class="entry-row">
        <span class="document-number">${entry.number}</span>
        <div><strong>${escapeHtml(entry.description)}</strong><small>منبع: ${escapeHtml(entry.sourceType)} · ${escapeHtml(entry.createdBy ?? '—')} · ${entry.totalDebit.toLocaleString('fa-IR')} / ${entry.totalCredit.toLocaleString('fa-IR')}</small></div>
        <span class="workflow-badge">${escapeHtml(entry.status)}</span>
        ${entry.status === 'پیش‌نویس' ? `<button class="workflow-action" data-post-journal="${entry.id}">قطعی‌کردن</button>` : ''}
        <button class="row-delete" data-journal-lines="${entry.id}" title="نمایش سطرها">⋯</button>
      </div>`).join('')}</div>`
    : '<p class="empty-hint">هنوز سندی صادر نشده است. با قطعی‌کردن یک سند در گردش کار، سند حسابداری آن خودکار صادر می‌شود.</p>';
  const balances = trialBalance.length
    ? `<table class="data-table"><thead><tr><th>کد</th><th>حساب</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th></tr></thead><tbody>${trialBalance.map((row) => `<tr><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.title)}</td><td>${row.debit.toLocaleString('fa-IR')}</td><td>${row.credit.toLocaleString('fa-IR')}</td><td class="${row.balance >= 0 ? 'positive' : 'negative'}">${Math.abs(row.balance).toLocaleString('fa-IR')} ${row.balance >= 0 ? 'بدهکار' : 'بستانکار'}</td></tr>`).join('')}</tbody></table>`
    : '<p class="empty-hint">برای نمایش تراز آزمایشی، یک سند حسابداری را قطعی کنید.</p>';
  return `<div class="panel-heading"><div><h2>دفتر روزنامه و تراز آزمایشی (سرور)</h2><p>اسناد به‌صورت خودکار و متوازن از عملیات‌ها صادر می‌شوند</p></div><span class="count">${journalEntries.length} سند</span></div>${summary}<h4 class="ledger-caption">اسناد صادرشده</h4>${entries}<h4 class="ledger-caption">تراز آزمایشی</h4>${balances}`;
}

function showJournalLines(id: string): void {
  const entry = journalEntries.find((item) => item.id === id);
  if (!entry) return;
  const rows = entry.lines.map((line) => `<tr><td>${escapeHtml(line.accountCode)}</td><td>${escapeHtml(line.accountTitle)}</td><td>${line.debit.toLocaleString('fa-IR')}</td><td>${line.credit.toLocaleString('fa-IR')}</td><td>${escapeHtml(line.costCenter ?? '—')}</td></tr>`).join('');
  openModal('journal-lines-modal', 'journal-lines-form', `<h2>سند حسابداری ${entry.number}</h2><p class="modal-hint">${escapeHtml(entry.description)}</p><table class="data-table"><thead><tr><th>کد</th><th>حساب</th><th>بدهکار</th><th>بستانکار</th><th>مرکز هزینه</th></tr></thead><tbody>${rows}</tbody></table><p class="modal-hint">جمع بدهکار: ${entry.totalDebit.toLocaleString('fa-IR')} · جمع بستانکار: ${entry.totalCredit.toLocaleString('fa-IR')}</p>
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="journal-lines-modal">بستن</button></div>`);
}

/** پنجره‌ی اتصال به سرور: بدون خروج از برنامه، نشست سرور را برقرار می‌کند */
/** بارگذاری دوباره‌ی داده‌های محلی متناسب با کاربر فعلی */
function hydrateLocalState(): void {
  savedRecords = readKey<SavedRecord[]>('erp-records', []);
  journals = readKey<Journal[]>('erp-journals', []);
  accounts = readKey<Account[]>('erp-accounts', []);
  treasuryTransactions = readKey<TreasuryTransaction[]>('erp-treasury', []);
  salesInvoices = readKey<SalesInvoice[]>('erp-sales', []);
  purchaseOrders = readKey<PurchaseOrder[]>('erp-purchases', []);
  inventoryItems = readKey<InventoryItem[]>('erp-inventory', []);
  users = readKey<UserRecord[]>('erp-users', []);
  employees = readKey<Employee[]>('erp-employees', []);
  payrollRuns = readKey<PayrollRun[]>('erp-payroll', []);
  fixedAssets = readKey<FixedAsset[]>('erp-assets', []);
  productionOrders = readKey<ProductionOrder[]>('erp-production', []);
  crmLeads = readKey<CrmLead[]>('erp-crm-leads', []);
  crmTickets = readKey<CrmTicket[]>('erp-crm-tickets', []);
  budgetLines = readKey<BudgetLine[]>('erp-budget', []);
  contactMessages = readKey<ContactMessage[]>('erp-contact', []);
  applyLocalDefaults();
}


/** پنجره‌ی تأییدِ زیبا (جایگزین window.confirm) */
function confirmDialog(title: string, message: string, onConfirm: () => void): void {
  openModal('confirm-modal', 'confirm-form', `<h2>${escapeHtml(title)}</h2>
    <p class="modal-hint">${escapeHtml(message)}</p>
    <div class="modal-actions">
      <button type="button" class="btn-cancel" data-close="confirm-modal">بستن</button>
      <button type="button" class="primary-button" id="confirm-accept">تأیید</button>
    </div>`);
  document.querySelector<HTMLButtonElement>('#confirm-accept')?.addEventListener('click', () => {
    closeModal('confirm-modal');
    onConfirm();
  });
}

/** اعلان‌های سیستم: سررسید چک‌ها، هشدارهای بودجه، موجودی کم و اسناد پیش‌نویس */
function notificationsMarkup(): string {
  const today = new Date();
  const soon = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  const items: Array<{ title: string; detail: string; level: 'critical' | 'warning' | 'info' }> = [];

  checks
    .filter((check) => check.status === 'در جریان وصول' && new Date(check.dueDate) <= soon)
    .forEach((check) => items.push({
      title: `سررسید چک ${check.number}`,
      detail: `${check.direction} · ${check.bank} · ${check.amount.toLocaleString('fa-IR')} ریال · ${check.dueDate}`,
      level: new Date(check.dueDate) < today ? 'critical' : 'warning',
    }));

  const analysis = budgetAnalysis ?? localBudgetAnalysis();
  analysis.alerts.forEach((alert) => items.push({ title: `بودجه: ${alert.title}`, detail: alert.message, level: alert.severity }));

  inventoryItems
    .filter((item) => item.quantity <= item.minimumQuantity)
    .forEach((item) => items.push({
      title: `موجودی کم: ${item.title}`,
      detail: `موجودی ${item.quantity} ${item.unit} · حداقل ${item.minimumQuantity}`,
      level: 'warning',
    }));

  const pending = journals.filter((journal) => journal.status === 'پیش‌نویس');
  if (pending.length) items.push({ title: 'اسناد پیش‌نویس', detail: `${pending.length} سند هنوز قطعی نشده است`, level: 'info' });

  return `<div class="notification-list">
    ${items.length ? items.map((item) => `<div class="notification-item ${item.level}">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.detail)}</span>
    </div>`).join('') : '<p class="empty-hint">اعلانی وجود ندارد؛ همه‌چیز به‌روز است.</p>'}
  </div>`;
}

function openNotifications(): void {
  openModal('notifications-modal', 'notifications-form', `<h2>اعلان‌ها</h2>
    <p class="modal-hint">موارد نیازمند توجه بر اساس داده‌های واقعی شما</p>
    ${notificationsMarkup()}
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="notifications-modal">بستن</button></div>`);
}

function openConnectionDetails(): void {
  const rows: Array<[string, string]> = [
    ['وضعیت', '● متصل به سرور'],
    ['نشانی سرور', API_BASE || 'همان میزبان فعلی (مسیر نسبی)'],
    ['کاربر', session ? `${session.name} (${session.username})` : '—'],
    ['سازمان', session?.organization ?? '—'],
    ['نقش', session?.role ?? '—'],
    ['ذخیره‌سازی محلی', 'فعال — داده‌ها در صورت قطع شبکه در مرورگر می‌مانند'],
  ];
  const table = rows.map(([label, value]) => `<div class="status-row"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  openModal('connection-modal', 'connection-form', `<h2>وضعیت اتصال</h2>
    <p class="modal-hint">نشست شما با سرور برقرار است و داده‌ها به‌صورت خودکار همگام می‌شوند. در صورت انقضای توکن، نشست بدون نیاز به ورودِ دوباره تازه می‌شود.</p>
    <div class="status-table">${table}</div>
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="connection-modal">بستن</button><button type="button" class="primary-button" id="connection-refresh">تازه‌سازی نشست</button></div>`);
  document.querySelector<HTMLButtonElement>('#connection-refresh')?.addEventListener('click', () => {
    void refreshSession().then((ok) => {
      updateApiChip();
      showToast(ok ? 'نشست با موفقیت تازه شد.' : 'تازه‌سازی ناموفق بود؛ دوباره وارد شوید.');
      if (ok) render();
      closeModal('connection-modal');
    });
  });
}

function openServerLogin(): void {
  document.querySelector('#server-login-modal')?.remove();
  openModal('server-login-modal', 'server-login-form', `<h2>اتصال به سرور</h2>
    <p class="modal-hint">با وارد کردن نام کاربری و رمز عبور، نشست با سرور برقرار می‌شود و داده‌ها از سرور بارگذاری می‌گردند.</p>
    <label>نام کاربری<input name="username" required autocomplete="username" value="${escapeHtml(session?.username ?? '')}"></label>
    <label>رمز عبور<input name="password" type="password" required autocomplete="current-password"></label>
    <p class="server-login-error" id="server-login-error" hidden></p>
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="server-login-modal">انصراف</button><button class="primary-button" type="submit">اتصال</button></div>`);
  document.querySelector<HTMLFormElement>('#server-login-form')?.addEventListener('submit', (event) => void connectToServer(event));
}

async function connectToServer(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const username = String(data.get('username') ?? '').trim();
  const password = String(data.get('password') ?? '');
  const errorBox = document.querySelector<HTMLElement>('#server-login-error');
  try {
    // ورود مستقیم (بدون apiFetch) تا به توکنِ کهنه وابسته نباشد
    const result = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!result?.ok) {
      const payload = result ? ((await result.json().catch(() => ({}))) as { error?: string }).error : null;
      if (errorBox) { errorBox.hidden = false; errorBox.textContent = payload ?? 'اتصال به سرور ناموفق بود.'; }
      return;
    }
    const payload = (await result.json()) as { user: Session; token: string; refreshToken: string };
    applyServerSession(payload.user, payload.token, payload.refreshToken);
    void afterSessionEstablished();
    document.querySelector('#server-login-modal')?.remove();
    hydrateLocalState();
    await loadServerData(true);
    render();
    showToast(`اتصال برقرار شد: ${payload.user.name} — ${payload.user.role}`);
  } catch (error) {
    if (errorBox) { errorBox.hidden = false; errorBox.textContent = `سرور در دسترس نیست (${(error as Error).message}).`; }
  }
}

function workflowMarkup(): string { const pending = [...savedRecords.filter((record) => record.status === 'در انتظار'), ...purchaseOrders.filter((order) => order.status === 'در انتظار').map((order) => ({ id: order.id, title: `سفارش خرید ${order.orderNumber}`, category: 'خرید و تدارکات', owner: order.supplierName, status: order.status, date: 'امروز' }))]; return `<section class="workflow-page"><div class="workflow-banner"><div><span class="section-kicker">کارتابل من</span><h2>موارد منتظر تأیید</h2><p>با تأیید هر مورد، عملیات از مرحله پیش‌نویس عبور می‌کند.</p></div><strong>${pending.length}<small>مورد باز</small></strong></div><div class="panel workflow-list">${pending.map((item) => `<div class="workflow-row"><span class="workflow-stage">در انتظار</span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.category)} · ${escapeHtml(item.owner)} · ${item.date}</small></div><button data-action="approve" data-id="${item.id}">تأیید و ادامه</button></div>`).join('') || '<div class="records-empty">کارتابل شما خالی است.</div>'}</div></section>`; }
function hrMarkup(): string { return `<section class="people-page"><div class="people-kpis"><article><span>کارکنان فعال</span><strong>${employees.filter((employee) => employee.isActive).length}</strong><small>نفر</small></article><article><span>حقوق ناخالص دوره</span><strong>${payrollRuns.reduce((sum, run) => sum + run.grossTotal, 0).toLocaleString('fa-IR')}</strong><small>ریال</small></article><article><span>فیش‌های آماده بررسی</span><strong>${payrollRuns.length}</strong><small>فیش</small></article></div><div class="people-toolbar"><div><h2>منابع انسانی و حقوق</h2><p>پرونده کارکنان و محاسبه حقوق را از همین میزکار مدیریت کنید.</p></div><button class="primary-button" id="new-payroll">＋ محاسبه حقوق</button></div><div class="people-columns"><div class="panel employee-list"><div class="panel-heading"><div><h2>کارکنان</h2><p>داده نمونه آموزشی کارکنان سازمان</p></div></div>${employees.map((employee) => `<div class="employee-row"><div class="avatar">${employee.fullName.charAt(0)}</div><div><strong>${escapeHtml(employee.fullName)}</strong><small>${employee.personnelCode} · ${escapeHtml(employee.jobTitle)} · ${escapeHtml(employee.department)}</small></div><b>${employee.baseSalary.toLocaleString('fa-IR')} ریال</b><span class="status ${employee.isActive ? 'approved' : 'pending'}">${employee.isActive ? 'فعال' : 'غیرفعال'}</span></div>`).join('')}</div><div class="panel payslip-list"><div class="panel-heading"><div><h2>فیش‌های حقوق</h2><p>هزینه حقوق به حسابداری متصل است</p></div></div>${payrollRuns.map((run) => `<div class="payslip-row"><div><strong>${escapeHtml(run.title)}</strong><small>${escapeHtml(run.employeeName)} · ${run.period} ${run.isDemo ? '· داده نمونه آموزشی' : ''}</small></div><span class="status pending">${run.status}</span><b>${run.netTotal.toLocaleString('fa-IR')} ریال</b></div>`).join('')}</div></div></section>`; }
type DepreciationMethodId = 'straight-line' | 'declining' | 'sum-of-years';
type DepreciationLine = {
  assetId: string; assetCode: string; title: string; acquisitionCost: number; depreciableBase: number;
  elapsedMonths: number; remainingMonths: number; monthlyAmount: number; periodAmount: number;
  accumulatedBefore: number; accumulatedAfter: number; bookValueBefore: number; bookValueAfter: number; finished: boolean;
};
type DepreciationRun = {
  method: DepreciationMethodId; methodTitle: string; periodLabel: string;
  totalMonthly: number; totalAccumulated: number; totalBookValue: number; assetCount: number; finishedCount: number;
  lines: DepreciationLine[];
  journal: { description: string; lines: Array<{ accountCode: string; accountTitle: string; debit: number; credit: number }> };
};

const depreciationMethods: Array<{ id: DepreciationMethodId; title: string; note: string }> = [
  { id: 'straight-line', title: 'خط مستقیم', note: 'تقسیم یکنواخت بهای قابل استهلاک بر عمر مفید' },
  { id: 'declining', title: 'نزولی', note: 'درصد ثابت از مانده‌ی دفتری؛ استهلاک سال‌های نخست بیشتر است' },
  { id: 'sum-of-years', title: 'مجموع سنوات', note: 'سهم هر سال بر اساس سنوات باقیمانده؛ الگوی متداول مالیاتی' },
];

let depreciationMethod: DepreciationMethodId = 'straight-line';
let depreciationRunCache: DepreciationRun | null = null;

/** محاسبه‌ی محلی استهلاک (برای حالت آفلاین؛ همان منطق موتور سرور) */
function localDepreciationRun(method: DepreciationMethodId = depreciationMethod): DepreciationRun {
  const base = (asset: FixedAsset) => Math.max(0, asset.acquisitionCost);
  const life = (asset: FixedAsset) => (asset.usefulLifeMonths > 0 ? asset.usefulLifeMonths : 1);
  const monthAmount = (asset: FixedAsset, index: number): number => {
    const value = base(asset);
    if (value <= 0) return 0;
    const months = life(asset);
    if (method === 'straight-line') return value / months;
    if (method === 'declining') {
      const yearlyRate = Math.min(0.95, 2 / Math.max(1, months / 12));
      const monthlyRate = yearlyRate / 12;
      const opening = value * (1 - monthlyRate) ** (index - 1);
      return index >= months ? Math.max(opening * monthlyRate, opening) : opening * monthlyRate;
    }
    const total = (months * (months + 1)) / 2;
    return (value * (months - index + 1)) / total;
  };

  const lines: DepreciationLine[] = fixedAssets.map((asset) => {
    const value = base(asset);
    const months = life(asset);
    const straightMonthly = value / months;
    const accumulatedBefore = Math.min(value, Math.max(0, asset.accumulatedDepreciation));
    const elapsed = straightMonthly > 0 ? Math.min(months, Math.round(accumulatedBefore / straightMonthly)) : 0;
    const remainingMonths = Math.max(0, months - elapsed);
    const bookValueBefore = Math.max(0, asset.acquisitionCost - accumulatedBefore);
    const finished = remainingMonths <= 0 || accumulatedBefore >= value - 1;
    const raw = finished ? 0 : monthAmount(asset, elapsed + 1);
    const periodAmount = Math.round(Math.min(raw, Math.max(0, value - accumulatedBefore)));
    const accumulatedAfter = accumulatedBefore + periodAmount;
    return {
      assetId: asset.id, assetCode: asset.assetCode, title: asset.title, acquisitionCost: Math.round(asset.acquisitionCost),
      depreciableBase: Math.round(value), elapsedMonths: elapsed, remainingMonths,
      monthlyAmount: Math.round(raw), periodAmount,
      accumulatedBefore: Math.round(accumulatedBefore), accumulatedAfter: Math.round(accumulatedAfter),
      bookValueBefore: Math.round(bookValueBefore), bookValueAfter: Math.round(Math.max(0, bookValueBefore - periodAmount)),
      finished,
    };
  });

  const totalMonthly = lines.reduce((sum, line) => sum + line.periodAmount, 0);
  return {
    method, methodTitle: depreciationMethods.find((item) => item.id === method)?.title ?? 'خط مستقیم',
    periodLabel: 'دوره جاری',
    totalMonthly,
    totalAccumulated: lines.reduce((sum, line) => sum + line.accumulatedAfter, 0),
    totalBookValue: lines.reduce((sum, line) => sum + line.bookValueAfter, 0),
    assetCount: lines.length, finishedCount: lines.filter((line) => line.finished).length,
    lines,
    journal: totalMonthly > 0
      ? {
          description: `سند استهلاک دوره جاری (${depreciationMethods.find((item) => item.id === method)?.title ?? ''})`,
          lines: [
            { accountCode: '6200', accountTitle: 'هزینه استهلاک', debit: totalMonthly, credit: 0 },
            { accountCode: '1501', accountTitle: 'استهلاک انباشته', debit: 0, credit: totalMonthly },
          ],
        }
      : { description: '', lines: [] },
  };
}

/** دریافت محاسبه از سرور (در صورت دسترسی) و در غیر این صورت محاسبه‌ی محلی */
async function loadDepreciation(): Promise<DepreciationRun> {
  if (apiOnline) {
    try {
      const result = await apiFetch('/api/fixed-assets/depreciation', {
        method: 'POST',
        body: JSON.stringify({ assets: fixedAssets.map((asset) => ({ ...asset, salvageValue: 0 })), method: depreciationMethod, periodLabel: 'دوره جاری' }),
      });
      if (result?.ok) {
        const payload = (await result.json()) as DepreciationRun & { data?: DepreciationRun };
        depreciationRunCache = payload.data ?? payload;
        return depreciationRunCache;
      }
    } catch { /* ادامه با محاسبه‌ی محلی */ }
  }
  const local = localDepreciationRun();
  depreciationRunCache = local;
  return local;
}

/** صدور سند حسابداری از خطوط آماده (محلی + همگام‌سازی با سرور) */
async function postJournal(description: string, lines: Array<{ accountCode: string; accountTitle: string; debit: number; credit: number }>): Promise<boolean> {
  const journal: Journal = {
    id: crypto.randomUUID(),
    number: journals.length + 1001,
    description,
    lines,
    status: 'پیش‌نویس',
    createdAt: new Date().toISOString(),
  };
  journals = [journal, ...journals];
  store('erp-journals', journals);
  try {
    const result = await apiFetch('/api/accounting/journals', { method: 'POST', body: JSON.stringify({ description, lines }) });
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}

/** ثبت استهلاک دوره: به‌روزرسانی دارایی‌ها و صدور سند حسابداری */
async function postDepreciation(): Promise<void> {
  const run = depreciationRunCache ?? localDepreciationRun();
  if (run.totalMonthly <= 0) { showToast('مبلغ استهلاک این دوره صفر است.'); return; }
  // به‌روزرسانی استهلاک انباشته‌ی هر دارایی
  const byId = new Map(run.lines.map((line) => [line.assetId, line]));
  fixedAssets = fixedAssets.map((asset) => {
    const line = byId.get(asset.id);
    return line ? { ...asset, accumulatedDepreciation: line.accumulatedAfter, status: line.finished ? 'مستهلک‌شده' : asset.status } : asset;
  });
  store('erp-assets', fixedAssets);
  // صدور سند حسابداری (سرور در صورت دسترسی، در غیر این صورت دفتر محلی)
  const issued = await postJournal(run.journal.description, run.journal.lines.map((line) => ({ accountCode: line.accountCode, accountTitle: line.accountTitle, debit: line.debit, credit: line.credit })));
  depreciationRunCache = localDepreciationRun();
  render();
  showToast(issued
    ? `استهلاک ${run.totalMonthly.toLocaleString('fa-IR')} ریال ثبت و سند آن صادر شد.`
    : `استهلاک ${run.totalMonthly.toLocaleString('fa-IR')} ریال در دارایی‌ها ثبت شد (سند به‌صورت محلی صادر شد).`);
}

function assetMarkup(): string {
  const value = fixedAssets.reduce((sum, asset) => sum + asset.acquisitionCost - asset.accumulatedDepreciation, 0);
  const run = depreciationRunCache ?? localDepreciationRun();
  return `<section class="people-page">
    <div class="people-kpis">
      <article><span>ارزش دفتری خالص</span><strong>${value.toLocaleString('fa-IR')}</strong><small>ریال</small></article>
      <article><span>دارایی‌های فعال</span><strong>${fixedAssets.length}</strong><small>مورد</small></article>
      <article><span>استهلاک دوره</span><strong>${run.totalMonthly.toLocaleString('fa-IR')}</strong><small>ریال ماهانه</small></article>
    </div>
    <div class="people-toolbar"><div><h2>دارایی ثابت</h2><p>ثبت، محل استقرار، استهلاک و کنترل اموال سازمان.</p></div><button class="primary-button" id="new-asset">＋ ثبت دارایی</button></div>

    <div class="panel depreciation-panel">
      <div class="panel-heading">
        <div><h2>استهلاک خودکار</h2><p>محاسبه‌ی دوره‌ای استهلاک و صدور سند حسابداری به‌طور خودکار</p></div>
        <span class="count">${run.methodTitle}</span>
      </div>
      <div class="depreciation-controls">
        <label>روش استهلاک
          <select id="depreciation-method">
            ${depreciationMethods.map((method) => `<option value="${method.id}" ${method.id === depreciationMethod ? 'selected' : ''}>${method.title} — ${method.note}</option>`).join('')}
          </select>
        </label>
        <button class="ghost-button" id="depreciation-calc">محاسبه‌ی دوره</button>
        <button class="primary-button" id="depreciation-post">صدور سند استهلاک (${run.totalMonthly.toLocaleString('fa-IR')} ریال)</button>
      </div>
      <div class="depreciation-summary">
        <div><span>جمع استهلاک دوره</span><strong>${run.totalMonthly.toLocaleString('fa-IR')} ریال</strong></div>
        <div><span>استهلاک انباشته پس از دوره</span><strong>${run.totalAccumulated.toLocaleString('fa-IR')} ریال</strong></div>
        <div><span>ارزش دفتری پس از دوره</span><strong>${run.totalBookValue.toLocaleString('fa-IR')} ریال</strong></div>
        <div><span>دارایی‌های پایان‌یافته</span><strong>${run.finishedCount} از ${run.assetCount}</strong></div>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>کد</th><th>دارایی</th><th>بهای تمام‌شده</th><th>عمر (ماه)</th><th>سپری‌شده</th><th>استهلاک دوره</th><th>انباشته</th><th>ارزش دفتری</th><th>وضعیت</th></tr></thead>
          <tbody>
            ${run.lines.map((line) => `<tr>
              <td>${escapeHtml(line.assetCode)}</td>
              <td>${escapeHtml(line.title)}</td>
              <td>${line.acquisitionCost.toLocaleString('fa-IR')}</td>
              <td>${line.elapsedMonths + line.remainingMonths}</td>
              <td>${line.elapsedMonths}</td>
              <td><strong>${line.periodAmount.toLocaleString('fa-IR')}</strong></td>
              <td>${line.accumulatedAfter.toLocaleString('fa-IR')}</td>
              <td>${line.bookValueAfter.toLocaleString('fa-IR')}</td>
              <td><span class="status ${line.finished ? 'rejected' : 'approved'}">${line.finished ? 'مستهلک‌شده' : 'در جریان'}</span></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel employee-list"><div class="panel-heading"><div><h2>دفتر دارایی‌ها</h2><p>داده نمونه آموزشی و دارایی‌های ثبت‌شده</p></div><span class="count">${fixedAssets.length} دارایی</span></div>${fixedAssets.map((asset) => `<div class="employee-row"><span class="sku">${asset.assetCode}</span><div><strong>${escapeHtml(asset.title)}</strong><small>${escapeHtml(asset.location)} · عمر مفید ${asset.usefulLifeMonths} ماه · استهلاک انباشته ${asset.accumulatedDepreciation.toLocaleString('fa-IR')} ریال${asset.isDemo ? ' · داده نمونه آموزشی' : ''}</small></div><b>${(asset.acquisitionCost - asset.accumulatedDepreciation).toLocaleString('fa-IR')} ریال</b><span class="status approved">${asset.status}</span></div>`).join('')}</div></section>`;
}

type BomComponent = { itemId?: string; title: string; quantity: number; unit: string; unitCost: number; scrapPercent?: number };
type BomRecord = {
  id: string; code: string; product: string; outputQuantity: number; components: BomComponent[];
  laborMinutes: number; laborRatePerMinute: number; overheadPerUnit: number; note?: string; createdAt: string; estimatedUnitCost?: number;
};
type ProductionCost = {
  bomCode: string; product: string; quantity: number; materialCost: number; laborCost: number; overheadCost: number;
  totalCost: number; unitCost: number; standardUnitCost: number; variance: number; variancePercent: number;
  materials: Array<{ title: string; unit: string; unitCost: number; requiredQuantity: number; perUnitQuantity: number; cost: number; scrapPercent: number }>;
  laborMinutes: number;
  journal: { description: string; lines: Array<{ accountCode: string; accountTitle: string; debit: number; credit: number }> };
};

let bomRecords: BomRecord[] = [];
let bomsLoaded = false;
let lastProductionCost: ProductionCost | null = null;
let costDraft = { bomId: '', quantity: 100, standardUnitCost: 0, overheadRatePerMinute: 0, scrapPercent: 0 };

/**
 * بارگیریِ صورت‌های مواد.
 * نکته‌ی مهم: نشانِ «بارگیری شده» باید پیش از هر خروجِ زودهنگام (از جمله حالتِ
 * آفلاین) گذاشته شود؛ در غیر این صورت هر بازسازیِ صفحه دوباره این تابع را صدا
 * می‌زد، و چون پایانِ آن بازسازیِ دوباره است، یک حلقه‌ی بی‌پایان ساخته می‌شد
 * (همان قفل شدنِ ماژولِ تولید در نسخه‌ی بدون سرور).
 */
async function loadBoms(): Promise<void> {
  if (bomsLoaded) return;
  bomsLoaded = true;
  if (!apiOnline) return;
  try {
    const result = await apiFetch('/api/manufacturing/boms');
    if (!result?.ok) return;
    const payload = (await result.json()) as { data: BomRecord[] };
    bomRecords = payload.data ?? [];
  } catch { /* حالت آفلاین */ }
}

async function saveBom(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const titles = data.getAll('componentTitle').map(String);
  const quantities = data.getAll('componentQuantity').map(Number);
  const units = data.getAll('componentUnit').map(String);
  const costs = data.getAll('componentCost').map(Number);
  const scraps = data.getAll('componentScrap').map(Number);
  const components: BomComponent[] = titles
    .map((title, index) => ({ title: title.trim(), quantity: quantities[index] || 0, unit: units[index] || 'عدد', unitCost: costs[index] || 0, scrapPercent: scraps[index] || 0 }))
    .filter((component) => component.title && component.quantity > 0);
  const product = String(data.get('product') ?? '').trim();
  const outputQuantity = Number(data.get('outputQuantity'));
  if (!product || outputQuantity <= 0 || !components.length) { showToast('نام محصول، مقدار خروجی و حداقل یک ماده الزامی است.'); return; }
  const record: BomRecord = {
    id: crypto.randomUUID(), code: `BOM-${String(bomRecords.length + 1).padStart(4, '0')}`, product, outputQuantity, components,
    laborMinutes: Number(data.get('laborMinutes')) || 0,
    laborRatePerMinute: Number(data.get('laborRatePerMinute')) || 0,
    overheadPerUnit: Number(data.get('overheadPerUnit')) || 0,
    note: String(data.get('note') ?? '').trim(), createdAt: new Date().toISOString(),
  };
  bomRecords = [record, ...bomRecords];
  void apiFetch('/api/manufacturing/boms', { method: 'POST', body: JSON.stringify({ product, outputQuantity, components, laborMinutes: record.laborMinutes, laborRatePerMinute: record.laborRatePerMinute, overheadPerUnit: record.overheadPerUnit, note: record.note }) }).catch(() => undefined);
  document.querySelector('#bom-modal')?.remove();
  render();
  showToast('صورت مواد (BOM) ثبت شد.');
}

/** محاسبه‌ی بهای تمام‌شده: از سرور در صورت اتصال، در غیر این صورت محلی */
async function calculateProductionCost(): Promise<void> {
  const bom = bomRecords.find((item) => item.id === costDraft.bomId) ?? bomRecords[0];
  if (!bom) { showToast('ابتدا یک صورت مواد (BOM) ثبت کنید.'); return; }
  costDraft = { ...costDraft, bomId: bom.id };
  if (apiOnline) {
    try {
      const result = await apiFetch('/api/manufacturing/cost', {
        method: 'POST',
        body: JSON.stringify({ bomId: bom.id, bom, quantity: costDraft.quantity, standardUnitCost: costDraft.standardUnitCost, overheadRatePerMinute: costDraft.overheadRatePerMinute, scrapPercent: costDraft.scrapPercent }),
      });
      if (result?.ok) {
        const payload = (await result.json()) as ProductionCost & { data?: ProductionCost };
        lastProductionCost = payload.data ?? payload;
        render();
        showToast('بهای تمام‌شده محاسبه شد.');
        return;
      }
    } catch { /* ادامه با محاسبه‌ی محلی */ }
  }
  lastProductionCost = localProductionCost(bom, costDraft.quantity, costDraft.standardUnitCost, costDraft.overheadRatePerMinute, costDraft.scrapPercent);
  render();
  showToast('بهای تمام‌شده به‌صورت محلی محاسبه شد.');
}

function localProductionCost(bom: BomRecord, quantity: number, standardUnitCost = 0, overheadRatePerMinute = 0, globalScrap = 0): ProductionCost {
  const runs = quantity / (bom.outputQuantity || 1);
  const materials = bom.components.map((component) => {
    const scrap = Math.max(component.scrapPercent ?? 0, globalScrap);
    const perUnitQuantity = component.quantity * (1 + scrap / 100);
    const requiredQuantity = perUnitQuantity * runs;
    return {
      title: component.title, unit: component.unit, unitCost: component.unitCost,
      requiredQuantity: Number(requiredQuantity.toFixed(3)), perUnitQuantity: Number(perUnitQuantity.toFixed(3)),
      cost: Math.round(requiredQuantity * component.unitCost), scrapPercent: scrap,
    };
  });
  const materialCost = materials.reduce((sum, line) => sum + line.cost, 0);
  const laborMinutes = Math.round(bom.laborMinutes * runs);
  const laborCost = Math.round(laborMinutes * bom.laborRatePerMinute);
  const overheadCost = Math.round(quantity * bom.overheadPerUnit + laborMinutes * overheadRatePerMinute);
  const totalCost = materialCost + laborCost + overheadCost;
  const unitCost = quantity > 0 ? totalCost / quantity : 0;
  return {
    bomCode: bom.code, product: bom.product, quantity, materialCost, laborCost, overheadCost,
    totalCost: Math.round(totalCost), unitCost: Math.round(unitCost), standardUnitCost,
    variance: Math.round((unitCost - standardUnitCost) * quantity),
    variancePercent: standardUnitCost > 0 ? Number((((unitCost - standardUnitCost) / standardUnitCost) * 100).toFixed(2)) : 0,
    materials, laborMinutes,
    journal: {
      description: `بهای تمام‌شده تولید ${bom.product} — ${quantity} واحد`,
      lines: [
        { accountCode: '1400', accountTitle: 'کالای در جریان ساخت', debit: Math.round(totalCost), credit: 0 },
        { accountCode: '1300', accountTitle: 'موجودی مواد و کالا', debit: 0, credit: materialCost },
        { accountCode: '6100', accountTitle: 'حقوق و دستمزد', debit: 0, credit: laborCost },
        { accountCode: '6000', accountTitle: 'سربار تولید', debit: 0, credit: overheadCost },
      ].filter((line) => line.debit > 0 || line.credit > 0),
    },
  };
}

/** ثبت سفارش تولید بر اساس بهای محاسبه‌شده */
async function postProductionOrder(): Promise<void> {
  const cost = lastProductionCost ?? (bomRecords[0] ? localProductionCost(bomRecords[0], costDraft.quantity) : null);
  if (!cost || cost.totalCost <= 0) { showToast('ابتدا بهای تمام‌شده را محاسبه کنید.'); return; }
  const order: ProductionOrder = {
    id: crypto.randomUUID(), orderNumber: productionOrders.length + 1,
    productTitle: cost.product, plannedQuantity: cost.quantity,
    materialTitle: cost.materials.map((line) => line.title).join(' + ') || '—',
    materialCost: cost.materialCost, laborCost: cost.laborCost, overheadCost: cost.overheadCost,
    totalCost: cost.totalCost, status: 'برنامه‌ریزی‌شده',
  };
  productionOrders = [order, ...productionOrders];
  store('erp-production', productionOrders);
  const issued = await postJournal(cost.journal.description, cost.journal.lines.map((line) => ({ accountCode: line.accountCode, accountTitle: line.accountTitle, debit: line.debit, credit: line.credit })));
  render();
  showToast(issued
    ? `سفارش تولید ثبت و سند بهای تمام‌شده (${cost.totalCost.toLocaleString('fa-IR')} ریال) صادر شد.`
    : `سفارش تولید ثبت شد و سند آن به‌صورت محلی صادر شد (${cost.totalCost.toLocaleString('fa-IR')} ریال).`);
}

function bomMarkup(): string {
  const cost = lastProductionCost;
  return `<div class="panel bom-panel">
    <div class="panel-heading">
      <div><h2>صورت مواد و بهای تمام‌شده (BOM)</h2><p>مواد، دستمزد و سربار؛ محاسبه‌ی بهای هر واحد و صدور سند تولید</p></div>
      <button class="ghost-button" id="new-bom">＋ صورت مواد جدید</button>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>کد</th><th>محصول</th><th>خروجی هر دوره</th><th>مواد</th><th>دستمزد (دقیقه)</th><th>سربار هر واحد</th><th>بهای برآوردی واحد</th></tr></thead>
        <tbody>
          ${bomRecords.length ? bomRecords.map((bom) => `<tr><td>${escapeHtml(bom.code)}</td><td>${escapeHtml(bom.product)}</td><td>${bom.outputQuantity}</td><td>${bom.components.length} قلم</td><td>${bom.laborMinutes}</td><td>${bom.overheadPerUnit.toLocaleString('fa-IR')}</td><td><strong>${(bom.estimatedUnitCost ?? localProductionCost(bom, bom.outputQuantity).unitCost).toLocaleString('fa-IR')}</strong></td></tr>`).join('') : '<tr><td colspan="7" class="empty-cell">هنوز صورت موادی ثبت نشده است.</td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="cost-controls">
      <label>صورت مواد
        <select id="cost-bom">${bomRecords.map((bom) => `<option value="${bom.id}" ${bom.id === costDraft.bomId ? 'selected' : ''}>${escapeHtml(bom.product)} (${escapeHtml(bom.code)})</option>`).join('') || '<option value="">—</option>'}</select>
      </label>
      <label>تعداد تولید<input id="cost-quantity" type="number" min="1" value="${costDraft.quantity}"></label>
      <label>بهای استاندارد واحد<input id="cost-standard" type="number" min="0" value="${costDraft.standardUnitCost}"></label>
      <label>سربار هر دقیقه<input id="cost-overhead" type="number" min="0" value="${costDraft.overheadRatePerMinute}"></label>
      <button class="primary-button" id="cost-calc">محاسبه‌ی بهای تمام‌شده</button>
    </div>
    ${cost ? `<div class="cost-result">
      <div class="cost-summary">
        <div><span>مواد مستقیم</span><strong>${cost.materialCost.toLocaleString('fa-IR')}</strong></div>
        <div><span>دستمزد مستقیم</span><strong>${cost.laborCost.toLocaleString('fa-IR')}</strong></div>
        <div><span>سربار تولید</span><strong>${cost.overheadCost.toLocaleString('fa-IR')}</strong></div>
        <div><span>بهای هر واحد</span><strong>${cost.unitCost.toLocaleString('fa-IR')}</strong></div>
        <div><span>جمع کل (${cost.quantity} واحد)</span><strong>${cost.totalCost.toLocaleString('fa-IR')}</strong></div>
        <div><span>انحراف از استاندارد</span><strong class="${cost.variance > 0 ? 'negative' : 'positive'}">${cost.variancePercent}%</strong></div>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>ماده/قطعه</th><th>مقدار هر واحد</th><th>مقدار کل</th><th>واحد</th><th>ضایعات</th><th>بهای واحد</th><th>جمع</th></tr></thead>
          <tbody>${cost.materials.map((line) => `<tr><td>${escapeHtml(line.title)}</td><td>${line.perUnitQuantity}</td><td>${line.requiredQuantity}</td><td>${escapeHtml(line.unit)}</td><td>${line.scrapPercent}%</td><td>${line.unitCost.toLocaleString('fa-IR')}</td><td><strong>${line.cost.toLocaleString('fa-IR')}</strong></td></tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="modal-actions"><button type="button" class="primary-button" id="cost-post">ثبت سفارش تولید و صدور سند</button></div>
    </div>` : ''}
  </div>`;
}

function productionMarkup(): string { const totalCost = productionOrders.reduce((sum, order) => sum + order.totalCost, 0); return `<section class="people-page"><div class="people-kpis"><article><span>بهای تمام‌شده برنامه‌ریزی‌شده</span><strong>${totalCost.toLocaleString('fa-IR')}</strong><small>ریال</small></article><article><span>سفارش‌های تولید</span><strong>${productionOrders.length}</strong><small>سفارش</small></article><article><span>تولید برنامه‌ریزی‌شده</span><strong>${productionOrders.reduce((sum, order) => sum + order.plannedQuantity, 0).toLocaleString('fa-IR')}</strong><small>واحد</small></article></div><div class="people-toolbar"><div><h2>برنامه‌ریزی تولید</h2><p>BOM، مصرف مواد، نیروی کار و بهای تمام‌شده را پیگیری کنید.</p></div><button class="primary-button" id="new-production">＋ سفارش تولید</button></div>${bomMarkup()}
<div class="panel payslip-list"><div class="panel-heading"><div><h2>سفارش‌های تولید</h2><p>داده نمونه آموزشی و سفارش‌های شما</p></div><span class="count">${productionOrders.length} سفارش</span></div>${productionOrders.map((order) => `<div class="payslip-row"><span class="invoice-number">#${order.orderNumber}</span><div><strong>${escapeHtml(order.productTitle)}</strong><small>${escapeHtml(order.materialTitle)} · ${order.plannedQuantity.toLocaleString('fa-IR')} واحد ${order.isDemo ? '· داده نمونه آموزشی' : ''}</small></div><b>${order.totalCost.toLocaleString('fa-IR')} ریال</b><span class="status pending">${order.status}</span></div>`).join('')}</div></section>`; }
/** پنل پشتیبان‌گیری و بازگردانی (ویژه‌ی مدیر) */
function backupPanelMarkup(): string {
  const canManage = !session?.permissions?.length || session.permissions.includes('identity.manage');
  if (!canManage) return '';
  return `<section class="panel backup-panel">
      <div class="panel-heading"><div><h2>پشتیبان‌گیری و بازگردانی</h2><p>یک فایل از همه‌ی شرکت‌ها و داده‌ها بگیرید و هر زمان لازم بود برگردانید</p></div><span class="count">ایمن</span></div>
      <div class="backup-actions">
        <button type="button" class="primary-button backup-download-button" id="backup-download">⬇ دریافت نسخه‌ی پشتیبان</button>
        <button type="button" class="btn-secondary backup-restore-button" id="backup-restore">⬆ بازگردانی از فایل</button>
        <input type="file" id="backup-file" accept="application/json,.json" hidden />
      </div>
      <p class="muted small">فایل پشتیبان شامل همه‌ی شرکت‌ها، اسناد حسابداری، چک‌ها، حقوق و کاربران است. پیش از بازگردانی، از وضعیت فعلی یک نسخه‌ی امن در سرور نگه داشته می‌شود.</p>
      <div class="backup-auto">
        <div class="backup-auto-head">
          <div><strong>پشتیبان‌گیریِ خودکار</strong><small>با تنظیمِ BACKUP_INTERVAL_HOURS در فایل .env، سرور به‌طور دوره‌ای نسخه می‌گیرد</small></div>
          <button type="button" class="btn-secondary backup-now-button" id="backup-now">⟳ همین حالا نسخه بگیر</button>
        </div>
        <div id="backup-list" class="backup-list">${backupFiles.length ? backupFiles.map((file) => `<div class="backup-row"><span>${escapeHtml(file.name)}</span><small>${new Date(file.at).toLocaleString('fa-IR')}</small><button type="button" class="btn-secondary small backup-file-button" data-backup-file="${escapeHtml(file.name)}">⬇ دریافت</button></div>`).join('') : '<p class="muted small">نسخه‌ی خودکاری روی سرور ثبت نشده است. با دکمه‌ی بالا یک نسخه بسازید (در صورت اتصال به سرور).</p>'}</div>
      </div>
    </section>`;
}

function bindBackupPanel(): void {
  document.querySelector<HTMLButtonElement>('#backup-download')?.addEventListener('click', () => void downloadBackup());
  document.querySelector<HTMLButtonElement>('#backup-now')?.addEventListener('click', () => void createServerBackup());
  document.querySelectorAll<HTMLButtonElement>('[data-backup-file]').forEach((button) =>
    button.addEventListener('click', () => void downloadServerBackup(button.dataset.backupFile ?? '')),
  );
  if (serverSession && !demoMode && Date.now() - backupListLoadedAt > 30_000) void loadBackupList();
  document.querySelector<HTMLButtonElement>('#backup-restore')?.addEventListener('click', () => {
    if (!serverSession) { showToast('بازگردانی روی سرور در حالت آفلاین ممکن نیست.'); return; }
    showToast('فایل پشتیبان (JSON) را انتخاب کنید.');
    document.querySelector<HTMLInputElement>('#backup-file')?.click();
  });
  document.querySelector<HTMLInputElement>('#backup-file')?.addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void restoreBackup(file);
  });
}

/** بارگذاریِ فهرستِ نسخه‌های پشتیبانِ سرور */
let backupListLoadedAt = 0;
async function loadBackupList(): Promise<void> {
  backupListLoadedAt = Date.now();
  const result = await apiFetch('/api/backup/list');
  if (!result?.ok) return;
  const list = (await result.json().catch(() => [])) as Array<{ name: string; at: string; size: number }>;
  backupFiles = Array.isArray(list) ? list : [];
  const holder = document.querySelector<HTMLElement>('#backup-list');
  if (!holder) { if (activeModule === 'organization') render(); return; }
  holder.innerHTML = backupFiles.length
    ? backupFiles.map((file) => `<div class="backup-row"><span>${escapeHtml(file.name)}</span><small>${new Date(file.at).toLocaleString('fa-IR')}</small><button type="button" class="btn-secondary small backup-file-button" data-backup-file="${escapeHtml(file.name)}">⬇ دریافت</button></div>`).join('')
    : '<p class="muted small">نسخه‌ی خودکاری روی سرور ثبت نشده است. با دکمه‌ی بالا یک نسخه بسازید.</p>';
  document.querySelectorAll<HTMLButtonElement>('[data-backup-file]').forEach((button) =>
    button.addEventListener('click', () => void downloadServerBackup(button.dataset.backupFile ?? '')),
  );
}

/** ساختِ نسخه‌ی پشتیبان روی سرور در همین لحظه */
async function createServerBackup(): Promise<void> {
  const result = await apiFetch('/api/backup/now', { method: 'POST' });
  const body = result?.ok ? ((await result.json().catch(() => ({}))) as { file?: string }) : null;
  if (!result?.ok || !body?.file) { showToast('ساختِ نسخه روی سرور ممکن نیست. از دکمه‌ی «دریافت نسخه‌ی پشتیبان» استفاده کنید.'); return; }
  showToast(`نسخه‌ی پشتیبان با نام ${body.file} روی سرور ذخیره شد.`);
  await loadBackupList();
}

/** دریافتِ یکی از نسخه‌های روی سرور */
async function downloadServerBackup(name: string): Promise<void> {
  if (!name) return;
  const result = await apiFetch(`/api/backup/file/${encodeURIComponent(name)}`);
  if (!result?.ok) { showToast('دریافتِ این نسخه ممکن نیست.'); return; }
  const blob = await result.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
  showToast('نسخه‌ی پشتیبان دریافت شد.');
}

/** دریافت فایل پشتیبان: از سرور در صورت اتصال، وگرنه از داده‌های محلی */
async function downloadBackup(): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 10);
  const localSnapshot: Record<string, unknown> = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key && (key.startsWith('erp-') || key.startsWith('erp-u:'))) {
      try { localSnapshot[key] = JSON.parse(localStorage.getItem(key) as string); } catch { /* رد می‌شود */ }
    }
  }
  const response = await apiFetch('/api/backup');
  let payload: unknown = { format: 'aria-erp-backup', version: 1, exportedAt: new Date().toISOString(), offline: true, localStorage: localSnapshot };
  let name = `aria-backup-local-${stamp}.json`;
  if (response?.ok) {
    payload = await response.json().catch(() => payload);
    name = `aria-backup-${stamp}.json`;
  }
  const text = JSON.stringify(payload, null, 2);
  const link = document.createElement('a');
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  } catch {
    // مرورگرهای قدیمی یا محیط‌های محدود: از نشانیِ داده‌ای استفاده می‌شود
    link.href = `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
    link.click();
  }
  link.download = name;
  showToast(response?.ok ? 'نسخه‌ی پشتیبانِ همه‌ی شرکت‌ها دریافت شد.' : 'نسخه‌ی پشتیبان محلی دریافت شد (اتصال به سرور برقرار نبود).');
}

/** بازگردانی فایل پشتیبان روی سرور */
async function restoreBackup(file: File): Promise<void> {
  let parsed: unknown;
  try { parsed = JSON.parse(await file.text()); } catch { showToast('فایل انتخابی یک فایل پشتیبان معتبر نیست.'); return; }
  const summary = (parsed as { data?: { journals?: unknown[] } })?.data?.journals?.length
    ?? (parsed as { journals?: unknown[] })?.journals?.length ?? 0;
  confirmDialog('بازگردانی نسخه‌ی پشتیبان', `داده‌های فعلی با محتوای فایل جایگزین می‌شوند (${money(Number(summary))} سند حسابداری). ادامه می‌دهید؟`, async () => {
    const response = await apiFetch('/api/backup/restore', { method: 'POST', body: JSON.stringify(parsed) });
    if (!response?.ok) {
      const body = (await response?.json().catch(() => null)) as { error?: string } | null;
      showToast(body?.error ?? 'بازگردانی ناموفق بود.'); return;
    }
    showToast('بازگردانی با موفقیت انجام شد؛ برنامه دوباره بارگذاری می‌شود.');
    setTimeout(() => window.location.reload(), 1200);
  });
}

/** شرکت‌های واقعیِ کاربر در ماژول سازمان */
function organizationCompaniesMarkup(): string {
  const rows = organizations.length
    ? organizations.map((organization) => `<div class="record-row"><div><strong>${escapeHtml(organization.name)}</strong><small>کد ${escapeHtml(organization.code)} · ${escapeHtml(organization.roleTitle)}${organization.stats ? ` · ${money(organization.stats.journals)} سند` : ''}</small></div><span class="status ${organization.id === activeOrganizationId ? 'approved' : 'pending'}">${organization.id === activeOrganizationId ? 'در حال کار' : 'قابل انتخاب'}</span></div>`).join('')
    : '<p class="empty-hint">در حالت آفلاین یک شرکتِ محلی در دسترس است. برای مدیریت چند شرکت وارد حساب کاربری شوید.</p>';
  return `<div class="panel"><div class="panel-heading"><div><h2>شرکت‌ها و واحدها</h2><p>هر شرکت داده‌ی مالی و شماره‌گذاری مستقل دارد</p></div><button type="button" class="primary-button" id="org-manage">مدیریت شرکت‌ها</button></div>${rows}</div>`;
}

/** دوره‌های مالیِ واقعیِ شرکت فعال */
function organizationPeriodsMarkup(): string {
  const rows = fiscalPeriods.length
    ? fiscalPeriods.map((period) => `<div class="workflow-row"><span class="workflow-stage">${escapeHtml(period.status)}</span><div><strong>${escapeHtml(period.title)}</strong><small>${escapeHtml(period.startsOn)} تا ${escapeHtml(period.endsOn)}</small></div><button class="workflow-action" data-period-details="${period.id}">نمایش جزئیات</button><button class="workflow-action" data-toggle-period="${period.id}" data-status="${period.status}">${period.status === 'باز' ? 'بستن دوره' : 'بازگشایی'}</button></div>`).join('')
    : '<p class="empty-hint">برای این شرکت هنوز دوره‌ی مالی تعریف نشده است.</p>';
  return `<div class="panel"><div class="panel-heading"><div><h2>دوره‌های مالی</h2><p>وضعیت دوره‌ها و انتقال داده‌ها</p></div>${serverSession ? '<button type="button" class="primary-button" id="org-add-period">＋ دوره‌ی مالی جدید</button>' : ''}</div>${rows}</div>`;
}

/** جزئیات یک دوره‌ی مالی */
function showPeriodDetails(id: string): void {
  const period = fiscalPeriods.find((item) => item.id === id);
  if (!period) { showToast('دوره‌ی مالی پیدا نشد.'); return; }
  const entries = journalEntries.filter((entry) => (entry.createdAt ?? '').slice(0, 10) >= period.startsOn && (entry.createdAt ?? '').slice(0, 10) <= period.endsOn);
  openModal('period-modal', 'period-form', `<h3>${escapeHtml(period.title)}</h3>
    <div class="detail-grid">
      <div><span>وضعیت</span><strong>${escapeHtml(period.status)}</strong></div>
      <div><span>از تاریخ</span><strong>${escapeHtml(period.startsOn)}</strong></div>
      <div><span>تا تاریخ</span><strong>${escapeHtml(period.endsOn)}</strong></div>
      <div><span>سال / دوره</span><strong>${money(period.year)} / ${money(period.index)}</strong></div>
      <div><span>اسناد ثبت‌شده</span><strong>${money(entries.length)} سند</strong></div>
      <div><span>جمع مبالغ</span><strong>${money(entries.reduce((sum, entry) => sum + (entry.totalDebit ?? 0), 0))}</strong></div>
    </div>
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="period-modal">بستن</button></div>`);
}

/** فرم ایجاد دوره‌ی مالی برای شرکت فعال */
function openPeriodForm(): void {
  const year = 1405;
  openModal('period-create-modal', 'period-create-form', `<h3>دوره‌ی مالی جدید</h3>
    <p class="muted">این دوره فقط برای «${escapeHtml(activeOrganizationName())}» تعریف می‌شود.</p>
    <div class="field-row">
      <label class="field"><span>سال مالی <i>*</i></span><input name="year" required inputmode="numeric" value="${year}" /></label>
      <label class="field"><span>شماره دوره <i>*</i></span><input name="index" required inputmode="numeric" value="1" /></label>
    </div>
    <label class="field"><span>عنوان دوره <i>*</i></span><input name="title" required value="سال مالی ${year}" /></label>
    <div class="field-row">
      <label class="field"><span>تاریخ شروع <i>*</i></span><input name="startsOn" required value="${year}-01-01" /></label>
      <label class="field"><span>تاریخ پایان <i>*</i></span><input name="endsOn" required value="${year}-12-29" /></label>
    </div>
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="period-create-modal">انصراف</button><button type="submit" class="primary-button">ایجاد دوره</button></div>`);
  document.querySelector<HTMLFormElement>('#period-create-form')?.addEventListener('submit', (event) => void createPeriodFromForm(event));
}

async function createPeriodFromForm(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const data = new FormData(event.currentTarget as HTMLFormElement);
  const year = Number(data.get('year') ?? 0);
  const index = Number(data.get('index') ?? 0);
  const title = String(data.get('title') ?? '').trim();
  const startsOn = String(data.get('startsOn') ?? '').trim();
  const endsOn = String(data.get('endsOn') ?? '').trim();
  if (!year || !index || !title || !startsOn || !endsOn) { showToast('همه‌ی فیلدهای دوره‌ی مالی الزامی است.'); return; }
  const response = await apiFetch('/api/fiscal-periods', { method: 'POST', body: JSON.stringify({ year, index, title, startsOn, endsOn }) });
  if (!response?.ok) {
    const body = (await response?.json().catch(() => null)) as { error?: string } | null;
    showToast(body?.error ?? 'ایجاد دوره ناموفق بود.'); return;
  }
  closeModal('period-create-modal');
  showToast('دوره‌ی مالی جدید ایجاد شد.');
  void loadServerData().then(() => { if (session) render(); });
}

function bindOrganizationExtras(): void {
  document.querySelector<HTMLButtonElement>('#org-manage')?.addEventListener('click', () => {
    if (!serverSession) { showToast('مدیریت چندشرکتی نیازمند ورود به حساب کاربری است.'); return; }
    openOrganizationsModal();
  });
  document.querySelector<HTMLButtonElement>('#org-add-period')?.addEventListener('click', () => openPeriodForm());
  document.querySelectorAll<HTMLButtonElement>('[data-period-details]').forEach((button) =>
    button.addEventListener('click', () => showPeriodDetails(button.dataset.periodDetails ?? '')));
}

function organizationMarkup(): string { const companies = [{ name: 'گروه صنعتی آریا', type: 'شرکت اصلی', status: 'فعال' }, { name: 'آریا پخش', type: 'شرکت تابعه', status: 'فعال' }, { name: 'آریا خدمات', type: 'واحد خدمات', status: 'در حال توسعه' }]; const branches = [{ city: 'تهران', manager: 'سینا نادری', headcount: 48 }, { city: 'شیراز', manager: 'حسن رستمی', headcount: 18 }, { city: 'اصفهان', manager: 'زهرا شکیب', headcount: 22 }]; const periods = [{ label: 'سال مالی ۱۴۰۵', phase: 'باز', status: 'approved' }, { label: 'دوره ۱', phase: 'در حال اجرا', status: 'pending' }, { label: 'دوره ۲', phase: 'آماده', status: 'approved' }]; return `<section class="module-summary"><div class="module-kpis"><article class="module-kpi"><span>شرکت‌های فعال</span><strong>۳</strong><small>واحد</small></article><article class="module-kpi"><span>شعبه‌ها</span><strong>۱۲</strong><small>محل</small></article><article class="module-kpi"><span>سال مالی</span><strong>۱۴۰۵</strong><small>باز</small></article></div><div class="module-workspace"><div class="workspace-header"><div><h2>سازمان و ساختار شرکت</h2><p>ساختار شرکتی، شعبه‌ها و دوره‌های مالی را از اینجا مدیریت کنید.</p></div><span class="module-empty-icon">⌂</span></div><div class="feature-grid">${['شرکت‌ها و شعب', 'دوره‌های مالی', 'تقویم و تعطیلات', 'پروژه‌ها', 'مرکز هزینه', 'شماره‌گذاری اسناد'].map((feature, index) => `<button class="feature-item" data-feature="${escapeHtml(feature)}"><span>${String(index + 1).padStart(2, '0')}</span><strong>${feature}</strong><b>←</b></button>`).join('')}</div>${organizationCompaniesMarkup()}<div class="panel"><div class="panel-heading"><div><h2>شعبه‌ها</h2><p>لیست شعبه‌های فعال</p></div></div>${branches.map((branch) => `<div class="invoice-row"><span class="invoice-number">${branch.city}</span><div><strong>${escapeHtml(branch.manager)}</strong><small>کارکنان: ${branch.headcount}</small></div><b>شعبه فعال</b></div>`).join('')}</div>${organizationPeriodsMarkup()}</div>${dataExchangeMarkup()}${backupPanelMarkup()}</section>`; }
function integrationMarkup(): string { const apis = [{ name: 'درگاه پرداخت بانک ملی', status: 'فعال', protocol: 'REST / OAuth 2.0' }, { name: 'پورتال مالیاتی', status: 'در حالت تست', protocol: 'SOAP / Webhook' }, { name: 'سیستم CRM', status: 'فعال', protocol: 'GraphQL' }, { name: 'نرم‌افزار انبار', status: 'غیرفعال', protocol: 'API Key' }]; return `<section class="module-summary"><div class="module-kpis"><article class="module-kpi"><span>اتصال‌های فعال</span><strong>۹</strong><small>اتصال</small></article><article class="module-kpi"><span>رویدادهای امروز</span><strong>۱,۲۸۴</strong><small>رویداد</small></article><article class="module-kpi"><span>خطاهای بررسی</span><strong>۲</strong><small>مورد</small></article></div><div class="module-workspace"><div class="workspace-header"><div><h2>یکپارچه‌سازی و API</h2><p>روابط با بانک، مالیات، CRM و سامانه‌های بیرونی را کنترل کنید.</p></div><span class="module-empty-icon">⇄</span></div><div class="feature-grid">${['API و کلیدها', 'وب‌هوک‌ها', 'درگاه بانکی', 'سامانه مالیاتی', 'فایل‌های تبادلی', 'صف پردازش و خطاها'].map((feature, index) => `<button class="feature-item" data-feature="${escapeHtml(feature)}"><span>${String(index + 1).padStart(2, '0')}</span><strong>${feature}</strong><b>←</b></button>`).join('')}</div><div class="panel"><div class="panel-heading"><div><h2>اتصالات فعال</h2><p>وضعیت سرویس‌ها و پروتکل‌های آنها</p></div></div>${apis.map((api) => `<div class="record-row"><div><strong>${escapeHtml(api.name)}</strong><small>${escapeHtml(api.protocol)}</small></div><span class="status ${api.status === 'فعال' ? 'approved' : api.status === 'در حالت تست' ? 'pending' : 'pending'}">${api.status}</span></div>`).join('')}</div></div></section>`; }

type BudgetAnalysis = {
  totalPlanned: number; totalActual: number; totalVariance: number; totalVariancePercent: number; executionPercent: number;
  lines: Array<{ id: string; title: string; accountCode: string; costCenter: string; period: string; kind: 'هزینه' | 'درآمد'; planned: number; actual: number; variance: number; variancePercent: number; executionPercent: number; status: 'مطلوب' | 'هشدار' | 'بحرانی'; note: string }>;
  alerts: Array<{ title: string; message: string; severity: 'warning' | 'critical' }>;
  byCostCenter: Array<{ costCenter: string; planned: number; actual: number; variance: number; executionPercent: number }>;
};

let budgetAnalysis: BudgetAnalysis | null = null;

/** تحلیل محلیِ بودجه (برای حالت آفلاین) */
function localBudgetAnalysis(): BudgetAnalysis {
  const lines = budgetLines.map((line) => {
    const planned = Math.max(0, line.planned);
    const actual = line.actual;
    const variance = actual - planned;
    const variancePercent = planned > 0 ? Number(((variance / planned) * 100).toFixed(1)) : 0;
    const executionPercent = planned > 0 ? Number(((actual / planned) * 100).toFixed(1)) : 0;
    const status: 'مطلوب' | 'هشدار' | 'بحرانی' = executionPercent >= 100 ? 'بحرانی' : executionPercent >= 90 ? 'هشدار' : 'مطلوب';
    return {
      id: line.id, title: line.title, accountCode: '', costCenter: 'عمومی', period: '', kind: 'هزینه' as const,
      planned, actual, variance, variancePercent, executionPercent, status,
      note: status === 'بحرانی' ? 'هزینه از سقف مصوب عبور کرده است' : status === 'هشدار' ? 'نزدیک به سقف بودجه' : 'در محدوده‌ی برنامه',
    };
  });
  const totalPlanned = lines.reduce((sum, line) => sum + line.planned, 0);
  const totalActual = lines.reduce((sum, line) => sum + line.actual, 0);
  const centers = new Map<string, { planned: number; actual: number }>();
  for (const line of lines) {
    const current = centers.get('عمومی') ?? { planned: 0, actual: 0 };
    current.planned += line.planned; current.actual += line.actual;
    centers.set('عمومی', current);
  }
  return {
    totalPlanned, totalActual, totalVariance: totalActual - totalPlanned,
    totalVariancePercent: totalPlanned > 0 ? Number((((totalActual - totalPlanned) / totalPlanned) * 100).toFixed(1)) : 0,
    executionPercent: totalPlanned > 0 ? Number(((totalActual / totalPlanned) * 100).toFixed(1)) : 0,
    lines,
    alerts: lines.filter((line) => line.status !== 'مطلوب').map((line) => ({ title: line.title, message: `${line.note} — تحقق ${line.executionPercent}%`, severity: line.status === 'بحرانی' ? 'critical' as const : 'warning' as const })),
    byCostCenter: [...centers.entries()].map(([costCenter, value]) => ({ costCenter, planned: value.planned, actual: value.actual, variance: value.actual - value.planned, executionPercent: value.planned > 0 ? Number(((value.actual / value.planned) * 100).toFixed(1)) : 0 })),
  };
}

/** دریافت تحلیل بودجه از سرور (با تطبیق عملکرد واقعی از دفتر کل) */
async function loadBudgetAnalysis(): Promise<void> {
  if (!apiOnline) { budgetAnalysis = localBudgetAnalysis(); render(); showToast('تحلیل بودجه به‌صورت محلی انجام شد.'); return; }
  try {
    const result = await apiFetch('/api/budget/analysis', {
      method: 'POST',
      body: JSON.stringify({ lines: budgetLines.map((line) => ({ id: line.id, title: line.title, planned: line.planned, actual: line.actual, kind: 'هزینه' })), fromAccounts: false }),
    });
    if (!result?.ok) throw new Error('server');
    const payload = (await result.json()) as BudgetAnalysis & { data?: BudgetAnalysis };
    budgetAnalysis = payload.data ?? payload;
    render();
    showToast('تحلیل بودجه به‌روزرسانی شد.');
  } catch {
    budgetAnalysis = localBudgetAnalysis();
    render();
    showToast('تحلیل بودجه به‌صورت محلی انجام شد.');
  }
}

function budgetAnalysisMarkup(): string {
  const analysis = budgetAnalysis ?? localBudgetAnalysis();
  const statusClass = (status: string) => (status === 'بحرانی' ? 'rejected' : status === 'هشدار' ? 'pending' : 'approved');
  return `<div class="panel budget-analysis">
    <div class="panel-heading">
      <div><h2>تحلیل بودجه و انحراف</h2><p>مقایسه‌ی مصوب با عملکرد واقعی، درصد تحقق و هشدارهای مدیریتی</p></div>
      <button class="ghost-button" id="budget-analyze">به‌روزرسانی تحلیل</button>
    </div>

    <div class="budget-kpis">
      <div><span>جمع مصوب</span><strong>${analysis.totalPlanned.toLocaleString('fa-IR')}</strong><small>ریال</small></div>
      <div><span>جمع تحقق‌یافته</span><strong>${analysis.totalActual.toLocaleString('fa-IR')}</strong><small>ریال</small></div>
      <div><span>انحراف کل</span><strong class="${analysis.totalVariance > 0 ? 'negative' : 'positive'}">${analysis.totalVariance.toLocaleString('fa-IR')}</strong><small>${analysis.totalVariancePercent}%</small></div>
      <div><span>درصد تحقق</span><strong>${analysis.executionPercent}%</strong><small>کل بودجه</small></div>
    </div>

    ${analysis.alerts.length ? `<div class="budget-alerts">${analysis.alerts.slice(0, 6).map((alert) => `<div class="budget-alert ${alert.severity}"><strong>${escapeHtml(alert.title)}</strong><span>${escapeHtml(alert.message)}</span></div>`).join('')}</div>` : ''}

    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>ردیف بودجه</th><th>مرکز هزینه</th><th>مصوب</th><th>تحقق‌یافته</th><th>انحراف</th><th>درصد انحراف</th><th>درصد تحقق</th><th>وضعیت</th></tr></thead>
        <tbody>
          ${analysis.lines.map((line) => `<tr>
            <td>${escapeHtml(line.title)}</td>
            <td>${escapeHtml(line.costCenter)}</td>
            <td>${line.planned.toLocaleString('fa-IR')}</td>
            <td>${line.actual.toLocaleString('fa-IR')}</td>
            <td class="${line.variance > 0 ? 'negative' : 'positive'}">${line.variance.toLocaleString('fa-IR')}</td>
            <td>${line.variancePercent}%</td>
            <td>
              <div class="budget-bar"><span style="width:${Math.min(100, Math.max(0, line.executionPercent))}%"></span></div>
              <small>${line.executionPercent}%</small>
            </td>
            <td><span class="status ${statusClass(line.status)}">${line.status}</span></td>
          </tr>`).join('') || '<tr><td colspan="8" class="empty-cell">ردیفی برای تحلیل وجود ندارد.</td></tr>'}
        </tbody>
      </table>
    </div>

    ${analysis.byCostCenter.length > 1 ? `<div class="budget-centers">
      <h3>خلاصه بر اساس مرکز هزینه</h3>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>مرکز هزینه</th><th>مصوب</th><th>تحقق‌یافته</th><th>انحراف</th><th>درصد تحقق</th></tr></thead>
        <tbody>${analysis.byCostCenter.map((center) => `<tr><td>${escapeHtml(center.costCenter)}</td><td>${center.planned.toLocaleString('fa-IR')}</td><td>${center.actual.toLocaleString('fa-IR')}</td><td class="${center.variance > 0 ? 'negative' : 'positive'}">${center.variance.toLocaleString('fa-IR')}</td><td>${center.executionPercent}%</td></tr>`).join('')}</tbody>
      </table></div>
    </div>` : ''}
  </div>`;
}

function budgetMarkup(): string {
  const planned = budgetLines.reduce((sum, row) => sum + row.planned, 0);
  const actual = budgetLines.reduce((sum, row) => sum + row.actual, 0);
  const variance = planned ? ((actual - planned) / planned) * 100 : 0;
  const progress = (row: BudgetLine) => Math.min(100, Math.round((row.actual / Math.max(1, row.planned)) * 100));

  return `<section class="module-portal">
    ${budgetAnalysisMarkup()}
    <div class="workspace-header">
      <div>
        <span class="section-kicker">بودجه و کنترل مدیریت</span>
        <h2>برنامه، تحقق و انحراف بودجه</h2>
        <p>هر ردیف بودجه به‌صورت زنده با عملکرد واقعی مقایسه می‌شود و درصد تحقق نمایش داده می‌شود.</p>
      </div>
      <div class="header-actions">
        <span class="portal-badge">◫</span>
        <button class="primary-button" id="new-budget" type="button"><span>＋</span> ردیف بودجه جدید</button>
      </div>
    </div>

    <div class="module-kpis">
      <article class="module-kpi"><span>بودجه مصوب</span><strong>${money(planned)}</strong><small>ریال</small></article>
      <article class="module-kpi"><span>عملکرد تحقق‌یافته</span><strong>${money(actual)}</strong><small>ریال</small></article>
      <article class="module-kpi"><span>انحراف کل</span><strong>${Math.abs(variance).toFixed(1)}٪</strong><small>${variance >= 0 ? 'بیش‌از برنامه' : 'کمتر از برنامه'}</small></article>
    </div>

    <div class="module-workspace-grid">
      <div class="panel">
        <div class="panel-heading">
          <div><h3>ردیف‌های بودجه</h3><p>${budgetLines.length} ردیف · امکان افزودن و حذف</p></div>
        </div>
        <div class="budget-list">
          ${budgetLines.map((row) => {
            const rowVariance = row.planned ? ((row.actual - row.planned) / row.planned) * 100 : 0;
            return `<div class="budget-row">
              <div class="budget-main">
                <strong>${escapeHtml(row.title)}</strong>
                <small>برنامه: ${money(row.planned)} · تحقق: ${money(row.actual)} ریال${row.isDemo ? ' · داده نمونه آموزشی' : ''}</small>
                <div class="mini-track"><span style="width:${progress(row)}%"></span></div>
              </div>
              <b class="${rowVariance >= 0 ? 'positive' : 'negative'}">${Math.abs(rowVariance).toFixed(1)}٪</b>
              <button class="row-delete" data-delete-budget="${row.id}" title="حذف">×</button>
            </div>`;
          }).join('')}
        </div>
      </div>

      <div class="panel">
        <div class="panel-heading"><div><h3>نرخ تحقق واحدها</h3><p>بر اساس داده‌های واقعی ثبت‌شده</p></div></div>
        <div class="chart-stack">
          ${[['فروش', salesInvoices.length], ['خرید', purchaseOrders.length], ['خزانه', treasuryTransactions.length], ['انبار', inventoryItems.length], ['حقوق', payrollRuns.length]].map(([label, count]) => {
            const value = Math.min(100, Number(count) * 20);
            return `<div class="mini-progress"><div class="mini-progress-header"><span>${label}</span><b>${count} رکورد</b></div><div class="mini-track"><span style="width:${value}%"></span></div></div>`;
          }).join('')}
        </div>
      </div>
    </div>
  </section>`;
}

function crmMarkup(): string {
  const openLeads = crmLeads.filter((lead) => lead.stage !== 'قرارداد نهایی');
  const pipeline = openLeads.reduce((sum, lead) => sum + lead.value, 0);
  const openTickets = crmTickets.filter((ticket) => ticket.status !== 'بررسی شد').length;
  const wonValue = crmLeads.filter((lead) => lead.stage === 'قرارداد نهایی').reduce((sum, lead) => sum + lead.value, 0);

  return `<section class="module-portal">
    <div class="workspace-header">
      <div>
        <span class="section-kicker">CRM و خدمات مشتریان</span>
        <h2>سرنخ، فرصت و پشتیبانی در یک جریان</h2>
        <p>اضافه کردن سرنخ و تیکت کاملاً پویا است و بلافاصله در شاخص‌ها و داشبورد اثر می‌گذارد.</p>
      </div>
      <div class="header-actions">
        <span class="portal-badge">◎</span>
        <button class="secondary-button" id="new-ticket" type="button">＋ تیکت پشتیبانی</button>
        <button class="primary-button" id="new-lead" type="button"><span>＋</span> سرنخ جدید</button>
      </div>
    </div>

    <div class="module-kpis">
      <article class="module-kpi"><span>سرنخ‌های فعال</span><strong>${openLeads.length}</strong><small>مورد</small></article>
      <article class="module-kpi"><span>ارزش خط لوله فروش</span><strong>${money(pipeline)}</strong><small>ریال</small></article>
      <article class="module-kpi"><span>تیکت‌های باز</span><strong>${openTickets}</strong><small>تیکت</small></article>
      <article class="module-kpi"><span>قراردادهای نهایی</span><strong>${money(wonValue)}</strong><small>ریال</small></article>
    </div>

    <div class="module-workspace-grid">
      <div class="panel">
        <div class="panel-heading"><div><h3>سرنخ‌ها و فرصت‌ها</h3><p>${crmLeads.length} مورد · امکان حذف</p></div></div>
        <div class="lead-list">
          ${crmLeads.map((lead) => `<div class="lead-row">
            <span class="tag-pill ${lead.stage === 'قرارداد نهایی' ? 'success' : lead.stage === 'در حال مذاکره' ? 'warning' : 'neutral'}">${escapeHtml(lead.stage)}</span>
            <div><strong>${escapeHtml(lead.name)}</strong><small>مسئول: ${escapeHtml(lead.owner)}${lead.isDemo ? ' · داده نمونه آموزشی' : ''}</small></div>
            <b class="positive">${money(lead.value)} ریال</b>
            <button class="row-delete" data-delete-lead="${lead.id}" title="حذف">×</button>
          </div>`).join('') || '<div class="records-empty">سرنخی ثبت نشده است.</div>'}
        </div>
      </div>

      <div class="panel">
        <div class="panel-heading"><div><h3>تیکت‌های خدمات</h3><p>تغییر وضعیت تا بسته‌شدن</p></div></div>
        <div class="ticket-list">
          ${crmTickets.map((ticket) => `<div class="ticket-row">
            <div><strong>${escapeHtml(ticket.title)}</strong><small>اولویت ${escapeHtml(ticket.priority)} · ${escapeHtml(ticket.status)}</small></div>
            <span class="status ${ticket.status === 'بررسی شد' ? 'approved' : 'pending'}">${escapeHtml(ticket.status)}</span>
            <button class="mini-button" data-ticket-next="${ticket.id}">تغییر وضعیت</button>
            <button class="row-delete" data-delete-ticket="${ticket.id}" title="حذف">×</button>
          </div>`).join('') || '<div class="records-empty">تیکتی ثبت نشده است.</div>'}
        </div>
      </div>
    </div>
  </section>`;
}

type ReportSource = { id: string; title: string; fields: Array<{ key: string; title: string; type: 'text' | 'number' | 'date' }> };
type ReportFilter = { field: string; operator: 'equals' | 'contains' | 'greater' | 'less' | 'between'; value: string; value2?: string };
type ReportDraft = {
  source: string; columns: string[]; filters: ReportFilter[]; groupBy: string;
  aggregate: Array<{ field: string; kind: 'sum' | 'count' | 'avg' | 'min' | 'max' }>;
  sortBy: string; sortDirection: 'asc' | 'desc'; limit: number;
};
type ReportResult = { source: string; sourceTitle: string; columns: string[]; rows: Array<Record<string, string | number>>; totals: Record<string, number>; rowCount: number };

let reportSources: ReportSource[] = [];
let sourcesLoaded = false;
let reportResult: ReportResult | null = null;
let reportDraft: ReportDraft = { source: 'journals', columns: [], filters: [], groupBy: '', aggregate: [{ field: 'totalDebit', kind: 'sum' }], sortBy: '', sortDirection: 'desc', limit: 200 };

const reportOperators: Array<{ id: ReportFilter['operator']; title: string }> = [
  { id: 'equals', title: 'برابر با' }, { id: 'contains', title: 'شامل' },
  { id: 'greater', title: 'بزرگ‌تر از' }, { id: 'less', title: 'کوچک‌تر از' }, { id: 'between', title: 'بین (بازه)' },
];
const aggregateKinds: Array<{ id: 'sum' | 'count' | 'avg' | 'min' | 'max'; title: string }> = [
  { id: 'sum', title: 'جمع' }, { id: 'count', title: 'تعداد' }, { id: 'avg', title: 'میانگین' }, { id: 'min', title: 'کمینه' }, { id: 'max', title: 'بیشینه' },
];

async function loadReportSources(): Promise<void> {
  if (!apiOnline || sourcesLoaded) { sourcesLoaded = true; return; }
  sourcesLoaded = true;
  try {
    const result = await apiFetch('/api/reports/sources');
    if (!result?.ok) return;
    const payload = (await result.json()) as { data: ReportSource[] };
    reportSources = payload.data ?? [];
    if (reportSources.length && !reportSources.some((source) => source.id === reportDraft.source)) reportDraft = { ...reportDraft, source: reportSources[0].id };
  } catch { /* حالت آفلاین */ }
}

async function runReportDraft(): Promise<void> {
  if (!apiOnline) { showToast('گزارش‌ساز برای اجرا به اتصال سرور نیاز دارد.'); return; }
  try {
    const result = await apiFetch('/api/reports/run', {
      method: 'POST',
      body: JSON.stringify({
        source: reportDraft.source,
        columns: reportDraft.columns,
        filters: reportDraft.filters.filter((filter) => filter.field && filter.value !== ''),
        groupBy: reportDraft.groupBy || undefined,
        aggregate: reportDraft.groupBy ? reportDraft.aggregate : undefined,
        sortBy: reportDraft.sortBy || undefined,
        sortDirection: reportDraft.sortDirection,
        limit: reportDraft.limit,
      }),
    });
    if (!result?.ok) { showToast('اجرای گزارش ناموفق بود.'); return; }
    const payload = (await result.json()) as ReportResult & { data?: ReportResult };
    reportResult = payload.data ?? payload;
    render();
    showToast(`گزارش با ${reportResult.rows?.length ?? 0} ردیف ساخته شد.`);
  } catch { showToast('ارتباط با سرور برقرار نشد.'); }
}

function currentSource(): ReportSource | null {
  return reportSources.find((source) => source.id === reportDraft.source) ?? reportSources[0] ?? null;
}

function reportBuilderMarkup(): string {
  const source = currentSource();
  const result = reportResult;
  return `<div class="panel report-builder">
    <div class="panel-heading">
      <div><h2>گزارش‌ساز دلخواه</h2><p>انتخاب منبع، ستون‌ها، فیلترها و گروه‌بندی؛ خروجی قابل چاپ و اکسل</p></div>
      <span class="count">${source?.title ?? '—'}</span>
    </div>

    <div class="report-controls">
      <label>منبع داده
        <select id="report-source">
          ${reportSources.map((item) => `<option value="${item.id}" ${item.id === reportDraft.source ? 'selected' : ''}>${escapeHtml(item.title)}</option>`).join('') || '<option value="">—</option>'}
        </select>
      </label>
      <label>ستون‌ها
        <select id="report-columns" multiple size="4">
          ${(source?.fields ?? []).map((field) => `<option value="${field.key}" ${!reportDraft.columns.length || reportDraft.columns.includes(field.key) ? 'selected' : ''}>${escapeHtml(field.title)}</option>`).join('')}
        </select>
      </label>
      <label>گروه‌بندی بر اساس
        <select id="report-group">
          <option value="">بدون گروه‌بندی</option>
          ${(source?.fields ?? []).map((field) => `<option value="${field.key}" ${field.key === reportDraft.groupBy ? 'selected' : ''}>${escapeHtml(field.title)}</option>`).join('')}
        </select>
      </label>
      <label>مرتب‌سازی
        <select id="report-sort">
          <option value="">بدون مرتب‌سازی</option>
          ${(source?.fields ?? []).map((field) => `<option value="${field.key}" ${field.key === reportDraft.sortBy ? 'selected' : ''}>${escapeHtml(field.title)}</option>`).join('')}
        </select>
      </label>
      <label>جهت مرتب‌سازی
        <select id="report-direction">
          <option value="desc" ${reportDraft.sortDirection === 'desc' ? 'selected' : ''}>نزولی</option>
          <option value="asc" ${reportDraft.sortDirection === 'asc' ? 'selected' : ''}>صعودی</option>
        </select>
      </label>
      <label>حداکثر ردیف<input id="report-limit" type="number" min="1" max="2000" value="${reportDraft.limit}"></label>
    </div>

    <div class="report-filters">
      <div class="report-filters-head">
        <div><strong>فیلترها</strong><small class="filter-hint">مقدار را به فارسی یا انگلیسی بنویسید؛ نیم‌فاصله و تفاوت «ی/ک» نادیده گرفته می‌شود</small></div>
        <div class="report-filter-actions">
          <button class="ghost-button" id="report-add-filter" type="button">＋ افزودن فیلتر</button>
          ${reportDraft.filters.length ? '<button class="ghost-button" id="report-clear-filters" type="button">حذف فیلترها</button>' : ''}
        </div>
      </div>
      <div id="report-filter-list">
        ${reportDraft.filters.length ? reportDraft.filters.map((filter, index) => `<div class="report-filter" data-index="${index}">
          <select class="filter-field">${(source?.fields ?? []).map((field) => `<option value="${field.key}" ${field.key === filter.field ? 'selected' : ''}>${escapeHtml(field.title)}</option>`).join('')}</select>
          <select class="filter-operator">${reportOperators.map((operator) => `<option value="${operator.id}" ${operator.id === filter.operator ? 'selected' : ''}>${operator.title}</option>`).join('')}</select>
          <input class="filter-value" value="${escapeHtml(String(filter.value))}" placeholder="مقدار">
          <input class="filter-value2" value="${escapeHtml(String(filter.value2 ?? ''))}" placeholder="مقدار دوم">
          <button type="button" class="icon-button filter-remove" data-index="${index}">×</button>
        </div>`).join('') : '<p class="modal-hint">فیلتری تعریف نشده است؛ همه‌ی ردیف‌ها نمایش داده می‌شوند.</p>'}
      </div>
    </div>

    ${reportDraft.groupBy ? `<div class="report-aggregate">
      <div class="report-filters-head"><strong>جمع‌بندی گروه‌ها</strong><button class="ghost-button" id="report-add-aggregate" type="button">＋ افزودن</button></div>
      ${reportDraft.aggregate.map((aggregate, index) => `<div class="report-filter" data-aggregate="${index}">
        <select class="aggregate-field">${(source?.fields ?? []).map((field) => `<option value="${field.key}" ${field.key === aggregate.field ? 'selected' : ''}>${escapeHtml(field.title)}</option>`).join('')}</select>
        <select class="aggregate-kind">${aggregateKinds.map((kind) => `<option value="${kind.id}" ${kind.id === aggregate.kind ? 'selected' : ''}>${kind.title}</option>`).join('')}</select>
        <button type="button" class="icon-button aggregate-remove" data-aggregate="${index}">×</button>
      </div>`).join('')}
    </div>` : ''}

    <div class="modal-actions">
      <button type="button" class="primary-button" id="report-run">اجرای گزارش</button>
      ${result ? `<button type="button" class="ghost-button" id="report-export">خروجی اکسل (CSV)</button><button type="button" class="ghost-button" id="report-print">چاپ / PDF</button>` : ''}
    </div>

    ${result ? `<div class="report-output">
      <div class="report-meta"><span>منبع: ${escapeHtml(result.sourceTitle ?? '')}</span><span>${result.rowCount} ردیف</span></div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>${result.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>
          <tbody>
            ${result.rows.slice(0, 200).map((row) => `<tr>${result.columns.map((column) => {
              const value = row[column];
              return `<td>${typeof value === 'number' ? value.toLocaleString('fa-IR') : escapeHtml(String(value ?? ''))}</td>`;
            }).join('')}</tr>`).join('') || `<tr><td class="empty-cell" colspan="${result.columns.length}">
              هیچ ردیفی با این تنظیمات یافت نشد.<br>
              <small>اگر فیلتر گذاشته‌اید، مقدار آن را ساده‌تر کنید یا فیلترها را حذف کنید.</small>
            </td></tr>`}
          </tbody>
          <tfoot><tr>${result.columns.map((column) => `<td>${result.totals[column] !== undefined ? result.totals[column].toLocaleString('fa-IR') : ''}</td>`).join('')}</tr></tfoot>
        </table>
      </div>
    </div>` : ''}
  </div>`;
}

function exportReportCsv(): void {
  if (!reportResult) return;
  const header = reportResult.columns.join(',');
  const body = reportResult.rows.map((row) => reportResult!.columns.map((column) => {
    const value = row[column] ?? '';
    const text = String(value).replace(/"/g, '\"\"');
    return typeof value === 'number' ? String(value) : '"' + text + '"';
  }).join(',')).join('\n');
  const blob = new Blob(['\ufeff' + header + '\n' + body], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `گزارش-${reportResult.sourceTitle || 'دلخواه'}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast('خروجی اکسل گزارش آماده شد.');
}

/* ===================== ماژول گزارش‌گیری و هوش تجاری ===================== */

type ReportingTab = 'overview' | 'analytics' | 'charts' | 'library' | 'builder';
let reportingTab: ReportingTab = 'overview';
let libraryReport = 'sales';

const chartPalette = ['#1c7a6d', '#3aa6c9', '#e5a13a', '#c0392b', '#7f5fd0', '#2f9e8f', '#d4703f', '#557c9b'];

const persianMonth = (date: Date): string => new Intl.DateTimeFormat('fa-IR', { month: 'long' }).format(date);

/** نمایش کوتاهِ مبالغ بزرگ (هزار / میلیون / میلیارد) */
function compactMoney(value: number): string {
  const abs = Math.abs(value);
  const digits = (input: number, fraction = 1): string => input.toLocaleString('fa-IR', { maximumFractionDigits: fraction });
  if (abs >= 1_000_000_000) return `${digits(value / 1_000_000_000)} میلیارد`;
  if (abs >= 1_000_000) return `${digits(value / 1_000_000)} میلیون`;
  if (abs >= 1_000) return `${digits(value / 1_000, 0)} هزار`;
  return digits(value, 0);
}

type DatasetStats = { count: number; sum: number; mean: number; median: number; min: number; max: number; stdev: number; cv: number };

/** آمار توصیفی یک مجموعه داده */
function statsOf(values: number[]): DatasetStats {
  const list = values.filter((value) => Number.isFinite(value));
  if (!list.length) return { count: 0, sum: 0, mean: 0, median: 0, min: 0, max: 0, stdev: 0, cv: 0 };
  const sorted = [...list].sort((a, b) => a - b);
  const sum = list.reduce((total, value) => total + value, 0);
  const mean = sum / list.length;
  const variance = list.reduce((total, value) => total + (value - mean) ** 2, 0) / list.length;
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const stdev = Math.sqrt(variance);
  return { count: list.length, sum, mean, median, min: sorted[0], max: sorted[sorted.length - 1], stdev, cv: mean ? (stdev / mean) * 100 : 0 };
}

/** ضریب همبستگی پیرسونِ دو سری داده */
function correlation(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length < 2) return 0;
  const meanA = a.slice(0, length).reduce((t, v) => t + v, 0) / length;
  const meanB = b.slice(0, length).reduce((t, v) => t + v, 0) / length;
  let numerator = 0; let denA = 0; let denB = 0;
  for (let i = 0; i < length; i += 1) {
    const da = a[i] - meanA; const db = b[i] - meanB;
    numerator += da * db; denA += da * da; denB += db * db;
  }
  const denominator = Math.sqrt(denA * denB);
  return denominator ? numerator / denominator : 0;
}

type MonthlyTrend = { labels: string[]; revenue: number[]; expense: number[]; cashIn: number[]; cashOut: number[] };

/** شش ماهِ گذشته: درآمد، هزینه، دریافت و پرداخت نقد — از اسناد واقعی */
function monthlyTrend(): MonthlyTrend {
  const now = new Date();
  const labels: string[] = [];
  const revenue: number[] = []; const expense: number[] = []; const cashIn: number[] = []; const cashOut: number[] = [];
  for (let offset = 5; offset >= 0; offset -= 1) {
    const cursor = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    labels.push(persianMonth(cursor));
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const inMonth = (iso: string): boolean => {
      if (!iso) return false;
      const date = new Date(iso);
      return date.getFullYear() === year && date.getMonth() === month;
    };
    let rev = 0; let exp = 0;
    journals.forEach((journal) => {
      if (!inMonth(journal.createdAt ?? '')) return;
      journal.lines.forEach((line) => {
        const code = String(line.accountCode ?? '');
        if (code.startsWith('4')) rev += line.credit ?? 0;
        if (code.startsWith('5') || code.startsWith('6')) exp += line.debit ?? 0;
      });
    });
    revenue.push(rev);
    expense.push(exp);
    cashIn.push(treasuryTransactions.filter((row) => row.transactionType === 'receipt' && inMonth(row.createdAt ?? '')).reduce((total, row) => total + row.amount, 0));
    cashOut.push(treasuryTransactions.filter((row) => row.transactionType === 'payment' && inMonth(row.createdAt ?? '')).reduce((total, row) => total + row.amount, 0));
  }
  return { labels, revenue, expense, cashIn, cashOut };
}

/** درآمد و هزینه‌ی کل بر اساس اسناد حسابداری */
function totalsFromJournals(): { revenue: number; expense: number; profit: number } {
  let revenue = 0; let expense = 0;
  journals.forEach((journal) => journal.lines.forEach((line) => {
    const code = String(line.accountCode ?? '');
    if (code.startsWith('4')) revenue += line.credit ?? 0;
    if (code.startsWith('5') || code.startsWith('6')) expense += line.debit ?? 0;
  }));
  return { revenue, expense, profit: revenue - expense };
}

type ChartSeries = { label: string; values: number[]; color: string };

/** اسپارک‌لاینِ کوچک داخل کارت‌های شاخص */
function sparklineSvg(values: number[], color: string, width = 160, height = 44): string {
  if (values.length < 2) return '';
  const max = Math.max(...values);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values.map((value, index) => [index * step, height - 6 - ((value - min) / span) * (height - 14)]);
  const path = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><path d="${path} L${width},${height} L0,${height} Z" fill="${color}" opacity=".13"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** نمودار خطی - ناحیه‌ای برای مقایسه‌ی چند سری در طول زمان */
function lineChartSvg(series: ChartSeries[], labels: string[], height = 280): string {
  const width = 760; const padX = 62; const padTop = 22; const padBottom = 34;
  const innerW = width - padX * 2; const innerH = height - padTop - padBottom;
  const max = Math.max(1, ...series.flatMap((item) => item.values));
  const stepX = labels.length > 1 ? innerW / (labels.length - 1) : 0;
  const yOf = (value: number): number => padTop + innerH - (value / max) * innerH;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((fraction) => {
      const y = padTop + innerH * fraction;
      return `<line x1="${padX}" x2="${width - padX}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e8efed" stroke-width="1"/><text x="${padX - 10}" y="${(y + 4).toFixed(1)}" font-size="10.5" fill="#8ba39c" text-anchor="end">${compactMoney(max * (1 - fraction))}</text>`;
    })
    .join('');
  const paths = series
    .map((item) => {
      const points = item.values.map((value, index) => [padX + index * stepX, yOf(value)]);
      const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
      const area = `${line} L${(padX + (item.values.length - 1) * stepX).toFixed(1)},${padTop + innerH} L${padX},${padTop + innerH} Z`;
      const dots = points.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.6" fill="#fff" stroke="${item.color}" stroke-width="2.2"/>`).join('');
      return `<path d="${area}" fill="${item.color}" opacity=".10"/><path d="${line}" fill="none" stroke="${item.color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>${dots}`;
    })
    .join('');
  const axis = labels.map((label, index) => `<text x="${(padX + index * stepX).toFixed(1)}" y="${height - 10}" font-size="11" fill="#6f8a83" text-anchor="middle">${escapeHtml(label)}</text>`).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="نمودار روند">${grid}${paths}${axis}</svg>`;
}

/** نمودار ستونیِ گروهی */
function groupedBarChartSvg(labels: string[], series: ChartSeries[], height = 280): string {
  const width = 760; const padX = 62; const padTop = 22; const padBottom = 34;
  const innerW = width - padX * 2; const innerH = height - padTop - padBottom;
  const max = Math.max(1, ...series.flatMap((item) => item.values));
  const groupWidth = innerW / Math.max(1, labels.length);
  const barWidth = Math.max(8, Math.min(26, (groupWidth - 18) / series.length));
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((fraction) => {
      const y = padTop + innerH * fraction;
      return `<line x1="${padX}" x2="${width - padX}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e8efed" stroke-width="1"/><text x="${padX - 10}" y="${(y + 4).toFixed(1)}" font-size="10.5" fill="#8ba39c" text-anchor="end">${compactMoney(max * (1 - fraction))}</text>`;
    })
    .join('');
  const bars = labels
    .map((label, index) => {
      const groupStart = padX + index * groupWidth;
      const columns = series
        .map((item, position) => {
          const value = item.values[index] ?? 0;
          const barHeight = (value / max) * innerH;
          const x = groupStart + (groupWidth - barWidth * series.length) / 2 + position * barWidth;
          const y = padTop + innerH - barHeight;
          return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(2, barHeight).toFixed(1)}" rx="5" fill="${item.color}" opacity=".92"><title>${escapeHtml(item.label)}: ${money(value)} ریال</title></rect>`;
        })
        .join('');
      return `${columns}<text x="${(groupStart + groupWidth / 2).toFixed(1)}" y="${height - 10}" font-size="11" fill="#6f8a83" text-anchor="middle">${escapeHtml(label)}</text>`;
    })
    .join('');
  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="نمودار ستونی">${grid}${bars}</svg>`;
}

/** نمودار دایره‌ای (دونات) با راهنمای رنگ‌ها */
function donutChartSvg(segments: Array<{ label: string; value: number; color: string }>): string {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (!total) return '<p class="empty-hint">داده‌ای برای نمایش وجود ندارد.</p>';
  const size = 210; const radius = 80; const center = size / 2; const thickness = 26;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const arcs = segments
    .filter((segment) => segment.value > 0)
    .map((segment) => {
      const dash = (segment.value / total) * circumference;
      const arc = `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${segment.color}" stroke-width="${thickness}" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${center} ${center})"><title>${escapeHtml(segment.label)}: ${money(segment.value)} ریال</title></circle>`;
      offset += dash;
      return arc;
    })
    .join('');
  const legend = segments
    .filter((segment) => segment.value > 0)
    .map((segment) => `<li><i style="background:${segment.color}"></i><span>${escapeHtml(segment.label)}</span><b>${compactMoney(segment.value)}</b><small>${Math.round((segment.value / total) * 100)}٪</small></li>`)
    .join('');
  return `<div class="donut-wrap"><svg class="donut-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="نمودار دایره‌ای">${arcs}<text x="${center}" y="${center - 2}" text-anchor="middle" font-size="12" fill="#7d948d">مجموع</text><text x="${center}" y="${center + 20}" text-anchor="middle" font-size="15" font-weight="700" fill="#173b3a">${compactMoney(total)}</text></svg><ul class="chart-legend">${legend}</ul></div>`;
}

/** میله‌های افقی (برای رتبه‌بندی) */
function rankBars(rows: Array<{ label: string; value: number; hint?: string }>, color = '#1c7a6d'): string {
  if (!rows.length) return '<p class="empty-hint">داده‌ای برای نمایش وجود ندارد.</p>';
  const max = Math.max(1, ...rows.map((row) => row.value));
  return `<div class="rank-bars">${rows
    .map((row) => `<div class="rank-row"><div class="rank-head"><span>${escapeHtml(row.label)}</span><b>${money(row.value)}${row.hint ? ` <small>${escapeHtml(row.hint)}</small>` : ''}</b></div><div class="rank-track"><span style="width:${Math.max(3, Math.round((row.value / max) * 100))}%;background:${color}"></span></div></div>`)
    .join('')}</div>`;
}

/** جدولِ زنده‌ی یک گزارش از کتابخانه */
function libraryTable(kind: string): string {
  if (kind === 'sales') {
    return `<table class="data-table"><thead><tr><th>شماره</th><th>مشتری</th><th>مبلغ (ریال)</th><th>مالیات</th><th>وضعیت</th></tr></thead><tbody>${salesInvoices.length ? salesInvoices.map((invoice) => `<tr><td>${invoice.invoiceNumber}</td><td>${escapeHtml(invoice.customerName)}</td><td>${money(invoice.total)}</td><td>${money(invoice.tax)}</td><td>${escapeHtml(invoice.status)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty-hint">فاکتوری ثبت نشده است</td></tr>'}</tbody></table>`;
  }
  if (kind === 'purchase') {
    return `<table class="data-table"><thead><tr><th>شماره</th><th>تأمین‌کننده</th><th>کالا</th><th>مبلغ (ریال)</th><th>وضعیت</th></tr></thead><tbody>${purchaseOrders.length ? purchaseOrders.map((order) => `<tr><td>${order.orderNumber}</td><td>${escapeHtml(order.supplierName)}</td><td>${escapeHtml(order.itemTitle)}</td><td>${money(order.total)}</td><td>${escapeHtml(order.status)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty-hint">سفارشی ثبت نشده است</td></tr>'}</tbody></table>`;
  }
  if (kind === 'inventory') {
    return `<table class="data-table"><thead><tr><th>کد</th><th>کالا</th><th>موجودی</th><th>حداقل</th><th>ارزش (ریال)</th><th>وضعیت</th></tr></thead><tbody>${inventoryItems.length ? inventoryItems.map((item) => `<tr><td>${escapeHtml(item.sku)}</td><td>${escapeHtml(item.title)}</td><td>${money(item.quantity)} ${escapeHtml(item.unit)}</td><td>${money(item.minimumQuantity)}</td><td>${money(item.quantity * item.unitCost)}</td><td>${item.quantity <= item.minimumQuantity ? '<span class="status-chip warn">نیاز به تأمین</span>' : '<span class="status-chip ok">کافی</span>'}</td></tr>`).join('') : '<tr><td colspan="6" class="empty-hint">کالایی ثبت نشده است</td></tr>'}</tbody></table>`;
  }
  if (kind === 'checks') {
    return `<table class="data-table"><thead><tr><th>شماره</th><th>طرف حساب</th><th>بانک</th><th>مبلغ (ریال)</th><th>سررسید</th><th>وضعیت</th></tr></thead><tbody>${checks.length ? checks.map((check) => `<tr><td>${escapeHtml(check.number)}</td><td>${escapeHtml(check.party)}</td><td>${escapeHtml(check.bank)}</td><td>${money(check.amount)}</td><td>${escapeHtml(check.dueDate)}</td><td>${escapeHtml(check.status)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty-hint">چکی ثبت نشده است</td></tr>'}</tbody></table>`;
  }
  if (kind === 'payroll') {
    return `<table class="data-table"><thead><tr><th>کارمند</th><th>دوره</th><th>ناخالص</th><th>کسورات</th><th>خالص (ریال)</th><th>وضعیت</th></tr></thead><tbody>${payrollRuns.length ? payrollRuns.map((run) => `<tr><td>${escapeHtml(run.employeeName)}</td><td>${escapeHtml(run.period)}</td><td>${money(run.grossTotal)}</td><td>${money(run.deductionsTotal)}</td><td>${money(run.netTotal)}</td><td>${escapeHtml(run.status)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty-hint">فیشی ثبت نشده است</td></tr>'}</tbody></table>`;
  }
  if (kind === 'budget') {
    return `<table class="data-table"><thead><tr><th>ردیف بودجه</th><th>مصوب</th><th>عملکرد</th><th>انحراف</th><th>درصد تحقق</th></tr></thead><tbody>${budgetLines.length ? budgetLines.map((line) => { const deviation = line.actual - line.planned; const percent = line.planned ? Math.round((line.actual / line.planned) * 100) : 0; return `<tr><td>${escapeHtml(line.title)}</td><td>${money(line.planned)}</td><td>${money(line.actual)}</td><td class="${deviation > 0 ? 'negative' : 'positive'}">${money(Math.abs(deviation))}</td><td>${percent}٪</td></tr>`; }).join('') : '<tr><td colspan="5" class="empty-hint">ردیف بودجه‌ای ثبت نشده است</td></tr>'}</tbody></table>`;
  }
  if (kind === 'crm') {
    return `<table class="data-table"><thead><tr><th>مشتری / سرنخ</th><th>مرحله</th><th>ارزش (ریال)</th><th>مسئول</th></tr></thead><tbody>${crmLeads.length ? crmLeads.map((lead) => `<tr><td>${escapeHtml(lead.name)}</td><td>${escapeHtml(lead.stage)}</td><td>${money(lead.value)}</td><td>${escapeHtml(lead.owner)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty-hint">سرنخی ثبت نشده است</td></tr>'}</tbody></table>`;
  }
  if (kind === 'production') {
    return `<table class="data-table"><thead><tr><th>شماره</th><th>محصول</th><th>مقدار</th><th>بهای تمام‌شده (ریال)</th><th>وضعیت</th></tr></thead><tbody>${productionOrders.length ? productionOrders.map((order) => `<tr><td>${order.orderNumber}</td><td>${escapeHtml(order.productTitle)}</td><td>${money(order.plannedQuantity)}</td><td>${money(order.totalCost)}</td><td>${escapeHtml(order.status)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty-hint">سفارش تولیدی ثبت نشده است</td></tr>'}</tbody></table>`;
  }
  // تراز آزمایشی
  const balances = new Map<string, { code: string; title: string; debit: number; credit: number }>();
  journals.forEach((journal) => journal.lines.forEach((line) => {
    const current = balances.get(line.accountCode) ?? { code: line.accountCode, title: line.accountTitle, debit: 0, credit: 0 };
    current.debit += line.debit ?? 0; current.credit += line.credit ?? 0;
    balances.set(line.accountCode, current);
  }));
  const rows = [...balances.values()].sort((a, b) => a.code.localeCompare(b.code));
  return `<table class="data-table"><thead><tr><th>کد</th><th>حساب</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th></tr></thead><tbody>${rows.length ? rows.map((row) => `<tr><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.title)}</td><td>${money(row.debit)}</td><td>${money(row.credit)}</td><td class="${row.debit - row.credit >= 0 ? 'positive' : 'negative'}">${money(Math.abs(row.debit - row.credit))}</td></tr>`).join('') : '<tr><td colspan="5" class="empty-hint">سند حسابداری ثبت نشده است</td></tr>'}</tbody></table>`;
}

const libraryReports: Array<{ key: string; title: string; icon: string; detail: string }> = [
  { key: 'sales', title: 'گزارش فروش', icon: '↗', detail: 'فاکتورها به تفکیک مشتری و وضعیت' },
  { key: 'purchase', title: 'گزارش خرید', icon: '⌁', detail: 'سفارش‌های خرید و تأمین‌کنندگان' },
  { key: 'inventory', title: 'گزارش موجودی', icon: '□', detail: 'موجودی، حداقل و ارزش ریالی کالاها' },
  { key: 'checks', title: 'گزارش چک‌ها', icon: '◌', detail: 'سررسیدها و وضعیت وصول یا پرداخت' },
  { key: 'payroll', title: 'گزارش حقوق', icon: '₽', detail: 'ناخالص، کسورات و خالص پرداختی' },
  { key: 'budget', title: 'بودجه و انحراف', icon: '◫', detail: 'مقایسه‌ی مصوب با عملکرد واقعی' },
  { key: 'crm', title: 'خط لوله فروش', icon: '◎', detail: 'سرنخ‌ها بر اساس مرحله و ارزش' },
  { key: 'production', title: 'گزارش تولید', icon: '⚙', detail: 'سفارش‌های تولید و بهای تمام‌شده' },
  { key: 'trial', title: 'تراز آزمایشی', icon: '▣', detail: 'مانده‌ی همه‌ی حساب‌های دفتر کل' },
];

/** خروجی CSVِ گزارشِ انتخابیِ کتابخانه */
function exportLibraryReport(kind: string): void {
  const meta = libraryReports.find((report) => report.key === kind);
  const name = meta?.title ?? 'گزارش';
  if (kind === 'sales') downloadCsv('گزارش-فروش.csv', ['شماره فاکتور', 'مشتری', 'مبلغ', 'مالیات', 'وضعیت'], salesInvoices.map((invoice) => [invoice.invoiceNumber, invoice.customerName, invoice.total, invoice.tax, invoice.status]));
  else if (kind === 'purchase') downloadCsv('گزارش-خرید.csv', ['شماره', 'تأمین‌کننده', 'کالا', 'مبلغ', 'وضعیت'], purchaseOrders.map((order) => [order.orderNumber, order.supplierName, order.itemTitle, order.total, order.status]));
  else if (kind === 'inventory') downloadCsv('گزارش-موجودی.csv', ['کد', 'کالا', 'موجودی', 'واحد', 'حداقل', 'ارزش'], inventoryItems.map((item) => [item.sku, item.title, item.quantity, item.unit, item.minimumQuantity, item.quantity * item.unitCost]));
  else if (kind === 'checks') downloadCsv('گزارش-چک‌ها.csv', ['شماره', 'طرف حساب', 'بانک', 'مبلغ', 'تاریخ صدور', 'سررسید', 'نوع', 'وضعیت'], checks.map((check) => [check.number, check.party, check.bank, check.amount, check.issueDate, check.dueDate, check.direction, check.status]));
  else if (kind === 'payroll') downloadCsv('گزارش-حقوق.csv', ['کارمند', 'دوره', 'ناخالص', 'کسورات', 'خالص', 'وضعیت'], payrollRuns.map((run) => [run.employeeName, run.period, run.grossTotal, run.deductionsTotal, run.netTotal, run.status]));
  else if (kind === 'budget') downloadCsv('گزارش-بودجه.csv', ['ردیف', 'مصوب', 'عملکرد', 'انحراف'], budgetLines.map((line) => [line.title, line.planned, line.actual, line.actual - line.planned]));
  else if (kind === 'crm') downloadCsv('گزارش-سرنخ‌ها.csv', ['مشتری', 'مرحله', 'ارزش', 'مسئول'], crmLeads.map((lead) => [lead.name, lead.stage, lead.value, lead.owner]));
  else if (kind === 'production') downloadCsv('گزارش-تولید.csv', ['شماره', 'محصول', 'مقدار', 'مواد', 'دستمزد', 'سربار', 'بهای تمام‌شده', 'وضعیت'], productionOrders.map((order) => [order.orderNumber, order.productTitle, order.plannedQuantity, order.materialCost, order.laborCost, order.overheadCost ?? 0, order.totalCost, order.status]));
  else {
    const balances = new Map<string, { code: string; title: string; debit: number; credit: number }>();
    journals.forEach((journal) => journal.lines.forEach((line) => {
      const current = balances.get(line.accountCode) ?? { code: line.accountCode, title: line.accountTitle, debit: 0, credit: 0 };
      current.debit += line.debit ?? 0; current.credit += line.credit ?? 0;
      balances.set(line.accountCode, current);
    }));
    downloadCsv('تراز-آزمایشی.csv', ['کد حساب', 'عنوان حساب', 'بدهکار', 'بستانکار', 'مانده'], [...balances.values()].map((row) => [row.code, row.title, row.debit, row.credit, row.debit - row.credit]));
  }
  showToast(`خروجی «${name}» ساخته شد و دانلود گردید.`);
}

/** کارت شاخص با روند و درصد تغییر */
function reportKpiCard(label: string, value: number, series: number[], color: string, hint = ''): string {
  const previous = series.length > 1 ? series[series.length - 2] : 0;
  const current = series.length ? series[series.length - 1] : 0;
  const delta = previous ? ((current - previous) / Math.abs(previous)) * 100 : 0;
  const tone = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  return `<article class="report-kpi">
    <span class="report-kpi-label">${escapeHtml(label)}</span>
    <strong class="report-kpi-value">${money(value)}<small>ریال</small></strong>
    ${hint ? `<span class="report-kpi-hint">${escapeHtml(hint)}</span>` : ''}
    ${sparklineSvg(series, color)}
    ${series.length > 1 ? `<span class="report-kpi-delta ${tone}">${delta > 0 ? '▲' : delta < 0 ? '▼' : '■'} ${Math.abs(delta).toLocaleString('fa-IR', { maximumFractionDigits: 1 })}٪ نسبت به ماه قبل</span>` : ''}
  </article>`;
}

function reportingOverview(): string {
  const { revenue, expense, profit } = totalsFromJournals();
  const trend = monthlyTrend();
  const cashIn = trend.cashIn.reduce((total, value) => total + value, 0);
  const cashOut = trend.cashOut.reduce((total, value) => total + value, 0);
  const inventoryValue = inventoryItems.reduce((total, item) => total + item.quantity * item.unitCost, 0);
  const payrollNet = payrollRuns.reduce((total, run) => total + run.netTotal, 0);
  const customers = new Map<string, number>();
  salesInvoices.forEach((invoice) => customers.set(invoice.customerName, (customers.get(invoice.customerName) ?? 0) + invoice.total));
  const topCustomers = [...customers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, value]) => ({ label, value }));
  const topItems = [...inventoryItems].sort((a, b) => b.quantity * b.unitCost - a.quantity * a.unitCost).slice(0, 5).map((item) => ({ label: item.title, value: item.quantity * item.unitCost, hint: `${money(item.quantity)} ${item.unit}` }));
  const expenseGroups = new Map<string, number>();
  journals.forEach((journal) => journal.lines.forEach((line) => {
    const code = String(line.accountCode ?? '');
    if (!code.startsWith('5') && !code.startsWith('6')) return;
    const key = code.startsWith('5') ? 'بهای تمام‌شده' : code.startsWith('61') ? 'حقوق و دستمزد' : code.startsWith('62') ? 'استهلاک' : 'سایر هزینه‌ها';
    expenseGroups.set(key, (expenseGroups.get(key) ?? 0) + (line.debit ?? 0));
  }));
  const donutSegments = [...expenseGroups.entries()].map(([label, value], index) => ({ label, value, color: chartPalette[index % chartPalette.length] }));
  const dueChecks = [...checks].sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))).slice(0, 6);

  return `<div class="reporting-grid">
    <div class="report-kpis">
      ${reportKpiCard('درآمد فروش', revenue, trend.revenue, chartPalette[0], `${salesInvoices.length} فاکتور فروش`)}
      ${reportKpiCard('هزینه‌ها', expense, trend.expense, chartPalette[3], `${journals.length} سند حسابداری`)}
      ${reportKpiCard('سود (زیان) خالص', profit, trend.revenue.map((value, index) => value - (trend.expense[index] ?? 0)), chartPalette[1], 'درآمد منهای هزینه')}
      ${reportKpiCard('دریافت‌های نقد', cashIn, trend.cashIn, chartPalette[5], 'شش ماه گذشته')}
      ${reportKpiCard('پرداخت‌های نقد', cashOut, trend.cashOut, chartPalette[2], 'شش ماه گذشته')}
      ${reportKpiCard('ارزش موجودی کالا', inventoryValue, [], chartPalette[4], `${inventoryItems.length} قلم کالا`)}
    </div>

    <section class="panel chart-panel wide">
      <div class="panel-heading"><div><h2>روند درآمد و هزینه</h2><p>شش ماه گذشته بر اساس اسناد قطعیِ دفتر کل</p></div>
        <div class="chart-inline-legend"><span><i style="background:${chartPalette[0]}"></i>درآمد</span><span><i style="background:${chartPalette[3]}"></i>هزینه</span></div>
      </div>
      ${lineChartSvg([{ label: 'درآمد', values: trend.revenue, color: chartPalette[0] }, { label: 'هزینه', values: trend.expense, color: chartPalette[3] }], trend.labels)}
    </section>

    <section class="panel chart-panel">
      <div class="panel-heading"><div><h2>ترکیب هزینه‌ها</h2><p>سهم هر گروه از کل هزینه‌ها</p></div></div>
      ${donutChartSvg(donutSegments)}
    </section>

    <section class="panel chart-panel">
      <div class="panel-heading"><div><h2>ارزشمندترین کالاها</h2><p>بر اساس ارزش ریالی موجودی</p></div></div>
      ${rankBars(topItems, chartPalette[0])}
    </section>

    <section class="panel chart-panel">
      <div class="panel-heading"><div><h2>برترین مشتریان</h2><p>جمع مبلغ فاکتورهای فروش</p></div></div>
      ${rankBars(topCustomers, chartPalette[1])}
    </section>

    <section class="panel chart-panel">
      <div class="panel-heading"><div><h2>حقوق و دستمزد</h2><p>خالص پرداختیِ دوره‌های ثبت‌شده</p></div><span class="count">${payrollRuns.length} فیش</span></div>
      <div class="stat-rows"><div><span>خالص پرداختی کل</span><b>${money(payrollNet)} ریال</b></div><div><span>میانگین هر فیش</span><b>${money(payrollRuns.length ? Math.round(payrollNet / payrollRuns.length) : 0)} ریال</b></div></div>
    </section>

    <section class="panel chart-panel wide">
      <div class="panel-heading"><div><h2>نزدیک‌ترین سررسیدهای چک</h2><p>چک‌های دریافتنی و پرداختنی بر اساس تاریخ سررسید</p></div></div>
      <table class="data-table"><thead><tr><th>شماره</th><th>طرف حساب</th><th>مبلغ (ریال)</th><th>سررسید</th><th>نوع</th><th>وضعیت</th></tr></thead><tbody>
        ${dueChecks.length ? dueChecks.map((check) => `<tr><td>${escapeHtml(check.number)}</td><td>${escapeHtml(check.party)}</td><td>${money(check.amount)}</td><td>${escapeHtml(check.dueDate)}</td><td>${escapeHtml(check.direction)}</td><td>${escapeHtml(check.status)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty-hint">چکی ثبت نشده است</td></tr>'}
      </tbody></table>
    </section>
  </div>`;
}

function reportingAnalytics(): string {
  const trend = monthlyTrend();
  const datasets: Array<{ title: string; values: number[]; unit: string }> = [
    { title: 'فاکتورهای فروش', values: salesInvoices.map((invoice) => invoice.total), unit: 'ریال' },
    { title: 'سفارش‌های خرید', values: purchaseOrders.map((order) => order.total), unit: 'ریال' },
    { title: 'فیش‌های حقوق', values: payrollRuns.map((run) => run.netTotal), unit: 'ریال' },
    { title: 'تراکنش‌های خزانه', values: treasuryTransactions.map((row) => row.amount), unit: 'ریال' },
  ];
  const histogram = (() => {
    const values = salesInvoices.map((invoice) => invoice.total);
    if (values.length < 2) return '';
    const bins = 6;
    const max = Math.max(...values);
    const step = max / bins || 1;
    const counts = Array.from({ length: bins }, () => 0);
    values.forEach((value) => { counts[Math.min(bins - 1, Math.floor(value / step))] += 1; });
    const labels = counts.map((_, index) => `${compactMoney(index * step)}`);
    return groupedBarChartSvg(labels, [{ label: 'تعداد فاکتور', values: counts, color: chartPalette[0] }], 240);
  })();
  const correlationValue = correlation(trend.revenue, trend.expense);

  return `<div class="reporting-grid">
    <section class="panel chart-panel wide">
      <div class="panel-heading"><div><h2>آمار توصیفی داده‌ها</h2><p>شاخص‌های پراکندگی و مرکزی برای تصمیم‌گیری دقیق‌تر</p></div></div>
      <div class="stats-grid">
        ${datasets.map((dataset) => {
          const stats = statsOf(dataset.values);
          return `<article class="stats-card"><h3>${escapeHtml(dataset.title)}</h3>
            <div class="stat-rows">
              <div><span>تعداد</span><b>${money(stats.count)}</b></div>
              <div><span>مجموع</span><b>${money(stats.sum)} ${dataset.unit}</b></div>
              <div><span>میانگین</span><b>${money(Math.round(stats.mean))} ${dataset.unit}</b></div>
              <div><span>میانه</span><b>${money(Math.round(stats.median))} ${dataset.unit}</b></div>
              <div><span>کمینه</span><b>${money(stats.min)} ${dataset.unit}</b></div>
              <div><span>بیشینه</span><b>${money(stats.max)} ${dataset.unit}</b></div>
              <div><span>انحراف معیار</span><b>${money(Math.round(stats.stdev))}</b></div>
              <div><span>ضریب تغییرات</span><b>${stats.cv.toLocaleString('fa-IR', { maximumFractionDigits: 1 })}٪</b></div>
            </div>
          </article>`;
        }).join('')}
      </div>
    </section>

    <section class="panel chart-panel wide">
      <div class="panel-heading"><div><h2>توزیع مبالغ فاکتورهای فروش</h2><p>تعداد فاکتورها در هر بازه‌ی مبلغی</p></div></div>
      ${histogram || '<p class="empty-hint">برای ترسیم نمودار حداقل دو فاکتور لازم است.</p>'}
    </section>

    <section class="panel chart-panel wide">
      <div class="panel-heading"><div><h2>رشد ماهانه</h2><p>تغییر هر شاخص نسبت به ماه پیش از آن</p></div>
        <span class="count">همبستگی درآمد و هزینه: ${correlationValue.toLocaleString('fa-IR', { maximumFractionDigits: 2 })}</span></div>
      <table class="data-table"><thead><tr><th>ماه</th><th>درآمد</th><th>تغییر</th><th>هزینه</th><th>تغییر</th><th>خالص نقد</th><th>تغییر</th></tr></thead><tbody>
        ${trend.labels.map((label, index) => {
          const percent = (current: number, previous: number): string => {
            if (!previous) return '—';
            const change = ((current - previous) / Math.abs(previous)) * 100;
            return `<span class="${change >= 0 ? 'positive' : 'negative'}">${change >= 0 ? '+' : ''}${change.toLocaleString('fa-IR', { maximumFractionDigits: 1 })}٪</span>`;
          };
          const net = trend.cashIn[index] - trend.cashOut[index];
          return `<tr><td>${escapeHtml(label)}</td><td>${money(trend.revenue[index])}</td><td>${percent(trend.revenue[index], trend.revenue[index - 1] ?? 0)}</td><td>${money(trend.expense[index])}</td><td>${percent(trend.expense[index], trend.expense[index - 1] ?? 0)}</td><td>${money(net)}</td><td>${percent(net, (trend.cashIn[index - 1] ?? 0) - (trend.cashOut[index - 1] ?? 0))}</td></tr>`;
        }).join('')}
      </tbody></table>
    </section>
  </div>`;
}

function reportingCharts(): string {
  const trend = monthlyTrend();
  const netCash = trend.cashIn.map((value, index) => value - (trend.cashOut[index] ?? 0));
  const cumulative: number[] = [];
  netCash.reduce((total, value, index) => { cumulative[index] = total + value; return cumulative[index]; }, 0);
  const statusGroups = new Map<string, number>();
  checks.forEach((check) => statusGroups.set(check.status, (statusGroups.get(check.status) ?? 0) + check.amount));
  const checkSegments = [...statusGroups.entries()].map(([label, value], index) => ({ label, value, color: chartPalette[index % chartPalette.length] }));
  const stageGroups = new Map<string, number>();
  crmLeads.forEach((lead) => stageGroups.set(lead.stage, (stageGroups.get(lead.stage) ?? 0) + lead.value));
  const stageSegments = [...stageGroups.entries()].map(([label, value], index) => ({ label, value, color: chartPalette[(index + 2) % chartPalette.length] }));
  const itemBars = [...inventoryItems].sort((a, b) => b.quantity * b.unitCost - a.quantity * a.unitCost).slice(0, 8).map((item) => ({ label: item.title, value: item.quantity * item.unitCost }));

  return `<div class="reporting-grid">
    <section class="panel chart-panel wide">
      <div class="panel-heading"><div><h2>درآمد در برابر هزینه</h2><p>مقایسه‌ی ماهانه</p></div>
        <div class="chart-inline-legend"><span><i style="background:${chartPalette[0]}"></i>درآمد</span><span><i style="background:${chartPalette[3]}"></i>هزینه</span></div></div>
      ${groupedBarChartSvg(trend.labels, [{ label: 'درآمد', values: trend.revenue, color: chartPalette[0] }, { label: 'هزینه', values: trend.expense, color: chartPalette[3] }])}
    </section>

    <section class="panel chart-panel wide">
      <div class="panel-heading"><div><h2>جریان نقد تجمعی</h2><p>مانده‌ی انباشته‌ی دریافت‌ها منهای پرداخت‌ها</p></div></div>
      ${lineChartSvg([{ label: 'جریان نقد', values: cumulative, color: chartPalette[1] }], trend.labels, 260)}
    </section>

    <section class="panel chart-panel">
      <div class="panel-heading"><div><h2>وضعیت چک‌ها</h2><p>بر اساس مبلغ</p></div></div>
      ${donutChartSvg(checkSegments)}
    </section>

    <section class="panel chart-panel">
      <div class="panel-heading"><div><h2>خط لوله فروش</h2><p>ارزش سرنخ‌ها در هر مرحله</p></div></div>
      ${donutChartSvg(stageSegments)}
    </section>

    <section class="panel chart-panel wide">
      <div class="panel-heading"><div><h2>ارزش موجودی به تفکیک کالا</h2><p>هشت قلمِ باارزش‌تر</p></div></div>
      ${groupedBarChartSvg(itemBars.map((row) => row.label), [{ label: 'ارزش موجودی', values: itemBars.map((row) => row.value), color: chartPalette[4] }], 260)}
    </section>
  </div>`;
}

function reportingLibrary(): string {
  const active = libraryReports.find((report) => report.key === libraryReport) ?? libraryReports[0];
  return `<div class="reporting-grid">
    <div class="library-grid">
      ${libraryReports.map((report) => `<button type="button" class="library-card ${report.key === libraryReport ? 'active' : ''}" data-library-report="${report.key}">
        <span class="library-icon">${report.icon}</span>
        <strong>${escapeHtml(report.title)}</strong>
        <small>${escapeHtml(report.detail)}</small>
      </button>`).join('')}
    </div>
    <section class="panel chart-panel wide">
      <div class="panel-heading"><div><h2>${escapeHtml(active.title)}</h2><p>${escapeHtml(active.detail)}</p></div>
        <div class="panel-tools">
          <button type="button" class="secondary-button small" id="library-csv">⬇ خروجی CSV</button>
          <button type="button" class="secondary-button small" id="library-print">🖨 چاپ گزارش</button>
        </div>
      </div>
      ${libraryTable(active.key)}
    </section>
  </div>`;
}

function reportingMarkup(): string {
  const tabs: Array<[ReportingTab, string, string]> = [
    ['overview', 'نمای کلی', '◈'],
    ['analytics', 'تحلیل آماری', '∑'],
    ['charts', 'نمودارها', '▤'],
    ['library', 'کتابخانه گزارش‌ها', '▦'],
    ['builder', 'گزارش‌ساز', '⚙'],
  ];
  const body = reportingTab === 'analytics' ? reportingAnalytics()
    : reportingTab === 'charts' ? reportingCharts()
    : reportingTab === 'library' ? reportingLibrary()
    : reportingTab === 'builder' ? `<div class="reporting-grid"><section class="panel chart-panel wide"><div class="panel-heading"><div><h2>گزارش‌ساز دلخواه</h2><p>منبع، ستون‌ها، فیلترها و جمع‌ها را خودتان انتخاب کنید</p></div></div>${reportBuilderMarkup()}</section></div>`
    : reportingOverview();

  return `<section class="module-portal reporting-portal">
    <div class="workspace-header">
      <div>
        <span class="section-kicker">گزارش‌گیری و هوش تجاری</span>
        <h2>تحلیلِ زنده‌ی عملکردِ سازمان</h2>
        <p>همه‌ی نمودارها و اعداد، مستقیماً از داده‌های ثبت‌شده در ماژول‌ها محاسبه می‌شوند.</p>
      </div>
      <span class="portal-badge">▥</span>
    </div>
    <div class="report-tabs" role="tablist">
      ${tabs.map(([key, label, icon]) => `<button type="button" role="tab" class="report-tab ${reportingTab === key ? 'active' : ''}" data-reporting-tab="${key}"><span>${icon}</span>${label}</button>`).join('')}
    </div>
    ${body}
  </section>`;
}

function moduleMarkup(current: Module): string { return moduleBody(current) + worklistMarkup(current); }
function moduleBody(current: Module): string { if (!canAccess(current.id)) return moduleBody(visibleModules()[0]); if (current.id === 'accounting') return accountingWorkspaceMarkup(); if (current.id === 'treasury') return treasuryMarkup(); if (current.id === 'sales') return salesMarkup(); if (current.id === 'purchasing') return purchasingMarkup(); if (current.id === 'inventory') return inventoryMarkup(); if (current.id === 'identity') return identityMarkup(); if (current.id === 'organization') return organizationMarkup(); if (current.id === 'workflow') return workflowMarkup(); if (current.id === 'integration') return integrationMarkup(); if (current.id === 'hr' || current.id === 'payroll') return hrMarkup() + payrollMarkup(); if (current.id === 'fixed-assets') return assetMarkup(); if (current.id === 'manufacturing') return productionMarkup(); if (current.id === 'budget') return budgetMarkup(); if (current.id === 'crm') return crmMarkup(); if (current.id === 'reporting') return reportingMarkup(); const records = savedRecords.filter((record) => record.category === current.label); return `<section class="module-summary"><div class="module-kpis">${current.kpis.map((kpi) => `<article class="module-kpi"><span>${kpi[0]}</span><strong>${kpi[1]}</strong><small>${kpi[2]}</small><div class="kpi-line"></div></article>`).join('')}</div><div class="module-workspace"><div class="workspace-header"><div><h2>عملیات ${current.label}</h2><p>قابلیت‌های زیرماژول به‌صورت مستقل قابل توسعه و اتصال به API هستند.</p></div><span class="module-empty-icon">${current.icon}</span></div><div class="feature-grid">${current.features.map((feature, index) => `<button class="feature-item" data-feature="${escapeHtml(feature)}"><span>${String(index + 1).padStart(2, '0')}</span><strong>${feature}</strong><b>←</b></button>`).join('')}</div>${records.length ? `<div class="records-heading"><h3>کارتابل عملیات</h3><span>${records.length} رکورد · امکان افزودن، تأیید و حذف</span></div><div class="record-list">${records.map((record) => `<div class="record-row"><div><strong>${escapeHtml(record.title)}</strong><small>${record.date} · ${record.owner} ${record.isDemo ? '· داده نمونه آموزشی' : ''}</small></div><span class="status ${record.status === 'تأیید شده' ? 'approved' : 'pending'}">${record.status}</span><div class="record-actions">${record.status !== 'تأیید شده' ? `<button data-action="approve" data-id="${record.id}">تأیید</button>` : ''}<button data-action="delete" data-id="${record.id}">حذف</button></div></div>`).join('')}</div>` : '<div class="records-empty">هنوز عملیاتی در این ماژول ثبت نشده است.</div>'}</div></section>`; }
/**
 * نمایش اعلانِ کشویی.
 * اعلان همیشه به body متصل است (بیرون از محتوای بازسازی‌شونده) تا با
 * هر بار رسمِ دوباره‌ی صفحه پیام از بین نرود.
 */
let toastTimer: number | undefined;
function showToast(message: string): void {
  let toast = document.querySelector<HTMLDivElement>('body > #toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  if (toastTimer) window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('visible');
  toastTimer = window.setTimeout(() => toast?.classList.remove('visible'), 3200);
}
function openFeatureForm(feature: string): void {
  const current = currentModule();
  openModal('record-modal', 'record-form', `<p class="eyebrow">ثبت عملیات در ${current.label}</p><h2>${escapeHtml(feature)}</h2>
    <p class="modal-hint">اطلاعات را وارد کنید تا در کارتابل شما ثبت شود.</p>
    <label>شرح عملیات<input name="title" required value="${escapeHtml(feature)}" /></label>
    <div class="form-grid">
      <label>مبلغ / مقدار<input name="amount" inputmode="numeric" placeholder="مثلاً ۱۰۰۰۰۰۰" /></label>
      <label>اولویت<select name="priority"><option>متوسط</option><option>بالا</option><option>پایین</option></select></label>
    </div>
    <label>یادداشت<textarea name="note" placeholder="توضیحات تکمیلی"></textarea></label>
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="record-modal">انصراف</button><button class="primary-button" type="submit">ثبت و ارسال برای تأیید</button></div>`);
  document.querySelector<HTMLFormElement>('#record-form')?.addEventListener('submit', saveRecord);
}
function openAccountForm(): void {
  openModal('account-modal', 'account-form', `<p class="eyebrow">دفتر حساب‌ها</p><h2>افزودن حساب جدید</h2><label>کد حساب<input name="code" required pattern="[0-9]{3,10}" placeholder="مثلاً ۶۱۰۰"></label><label>عنوان حساب<input name="title" required placeholder="مثلاً هزینه تبلیغات"></label><div class="form-actions"><button type="button" class="btn-cancel" data-close="account-modal">انصراف</button><button class="primary-button" type="submit">ذخیره حساب</button></div>`);
  document.querySelector<HTMLFormElement>('#account-form')?.addEventListener('submit', (event) => void saveAccount(event));
}
function saveAccount(event: SubmitEvent): void { event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); const code = String(data.get('code') ?? '').trim(); const title = String(data.get('title') ?? '').trim(); if (!/^\d{3,10}$/.test(code) || !title || accounts.some((account) => account.code === code)) { showToast('کد حساب معتبر یا یکتا نیست.'); return; } const account = { id: crypto.randomUUID(), code, title, level: 1 }; accounts = [...accounts, account].sort((left, right) => left.code.localeCompare(right.code)); store('erp-accounts', accounts); void apiFetch(`/api/accounting/accounts`, { method: 'POST', body: JSON.stringify({ code, title }) }).catch(() => undefined); document.querySelector('#account-modal')?.remove(); render(); showToast('حساب جدید ذخیره شد.'); }
function deleteAccountLocal(id: string): void {
  const account = accounts.find((item) => item.id === id);
  if (!account) return;
  confirmDialog('حذف حساب', `حساب «${account.title}» حذف شود؟`, () => {
    accounts = accounts.filter((item) => item.id !== id);
    store('erp-accounts', accounts);
    void apiFetch(`/api/accounting/accounts/${id}`, { method: 'DELETE' }).catch(() => undefined);
    render();
    showToast('حساب حذف شد.');
  });
}
function toggleUser(id: string): void { const user = users.find((item) => item.id === id); if (!user) return; if (user.username === 'admin') { showToast('حساب مدیر ارشد همیشه فعال می‌ماند و قابل غیرفعال‌سازی نیست.'); return; } user.isActive = !user.isActive; store('erp-users', users); void apiFetch(`/api/identity/users/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: user.isActive }) }).catch(() => undefined); render(); showToast(user.isActive ? 'کاربر فعال شد.' : 'کاربر غیرفعال شد.'); }
function openTreasuryForm(): void {
  openModal('treasury-modal', 'treasury-form', `<p class="eyebrow">دفتر خزانه</p><h2>ثبت دریافت یا پرداخت</h2><label>نوع تراکنش<select name="transactionType"><option value="receipt">دریافت</option><option value="payment">پرداخت</option></select></label><label>طرف حساب<input name="accountTitle" required placeholder="مثلاً شرکت آفتاب"></label><label>بانک یا صندوق<input name="bankOrCash" required placeholder="مثلاً بانک ملت"></label><label>مبلغ (ریال)<input name="amount" type="number" min="1" required placeholder="مثلاً ۴۵۰۰۰۰۰۰"></label><label>شرح<input name="description" required placeholder="دریافت بابت فاکتور فروش"></label><div class="form-actions"><button type="button" class="btn-cancel" data-close="treasury-modal">انصراف</button><button class="primary-button" type="submit">ثبت تراکنش</button></div>`);
  document.querySelector<HTMLFormElement>('#treasury-form')?.addEventListener('submit', (event) => void saveTreasury(event));
}
/**
 * اگر سرور درخواستی را نپذیرد (مثلاً دوره‌ی مالی بسته باشد)، پیامِ آن با احترام
 * به کاربر نشان داده می‌شود؛ داده‌ی محلی دست‌نخورده می‌ماند تا کار متوقف نشود.
 */
async function warnIfRejected(result: Response | null, fallback = 'ثبت روی سرور انجام نشد؛ دوباره تلاش کنید.'): Promise<void> {
  if (!result || result.ok) return;
  const body = (await result.json().catch(() => null)) as { error?: string } | null;
  showToast(body?.error ?? fallback);
}

function saveTreasury(event: SubmitEvent): void { event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); const item: TreasuryTransaction = { id: crypto.randomUUID(), transactionType: (String(data.get('transactionType')) === 'payment' ? 'payment' : 'receipt'), accountTitle: String(data.get('accountTitle') ?? '').trim(), bankOrCash: String(data.get('bankOrCash') ?? '').trim(), amount: Number(data.get('amount')), description: String(data.get('description') ?? '').trim(), status: 'در انتظار', createdAt: new Date().toISOString() }; if (!item.accountTitle || !item.bankOrCash || !item.description || item.amount <= 0) { showToast('همه فیلدهای تراکنش را کامل کنید.'); return; } const bankLine: JournalLine = { accountCode: '1100', accountTitle: 'بانک و صندوق', debit: item.transactionType === 'receipt' ? item.amount : 0, credit: item.transactionType === 'payment' ? item.amount : 0 }; const counterLine: JournalLine = { accountCode: item.transactionType === 'receipt' ? '1200' : '2000', accountTitle: item.transactionType === 'receipt' ? 'حساب‌های دریافتنی' : 'بدهی‌ها', debit: item.transactionType === 'payment' ? item.amount : 0, credit: item.transactionType === 'receipt' ? item.amount : 0 }; const journal: Journal = { id: crypto.randomUUID(), number: journals.length + 1001, description: item.description, lines: [bankLine, counterLine], status: 'پیش‌نویس', createdAt: item.createdAt }; journals = [journal, ...journals]; store('erp-journals', journals); treasuryTransactions = [item, ...treasuryTransactions]; store('erp-treasury', treasuryTransactions); void apiFetch(`/api/treasury`, { method: 'POST', body: JSON.stringify({ transactionType: item.transactionType, accountTitle: item.accountTitle, bankOrCash: item.bankOrCash, amount: item.amount, description: item.description }) })
    .then((result) => void warnIfRejected(result))
    .catch(() => undefined); document.querySelector('#treasury-modal')?.remove(); render(); showToast('تراکنش خزانه ثبت شد و سند حسابداری آن ساخته شد.'); }
function openInvoiceForm(): void {
  openModal('invoice-modal', 'invoice-form', `<p class="eyebrow">چرخه فروش</p><h2>ثبت فاکتور فروش</h2><label>نام مشتری<input name="customerName" required placeholder="مثلاً شرکت پارس"></label><label>شرح کالا یا خدمت<input name="itemTitle" required placeholder="مثلاً محصول A-100"></label><label>تعداد<input name="quantity" type="number" min="0.001" step="0.001" value="1" required></label><label>قیمت واحد (ریال)<input name="unitPrice" type="number" min="1" required placeholder="مثلاً ۸۴۵۰۰۰۰"></label><label>تخفیف (ریال)<input name="discount" type="number" min="0" value="0"></label><label>مالیات (ریال)<input name="tax" type="number" min="0" value="0"></label><div class="form-actions"><button type="button" class="btn-cancel" data-close="invoice-modal">انصراف</button><button class="primary-button" type="submit">ثبت فاکتور</button></div>`);
  document.querySelector<HTMLFormElement>('#invoice-form')?.addEventListener('submit', (event) => void saveInvoice(event));
}
function saveInvoice(event: SubmitEvent): void { event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); const line = { itemTitle: String(data.get('itemTitle') ?? '').trim(), quantity: Number(data.get('quantity')), unitPrice: Number(data.get('unitPrice')) }; const subtotal = line.quantity * line.unitPrice; const discount = Number(data.get('discount')) || 0; const tax = Number(data.get('tax')) || 0; const total = subtotal - discount + tax; if (!String(data.get('customerName') ?? '').trim() || !line.itemTitle || line.quantity <= 0 || line.unitPrice <= 0 || total <= 0) { showToast('اطلاعات فاکتور معتبر نیست.'); return; } const invoice: SalesInvoice = { id: crypto.randomUUID(), invoiceNumber: Math.max(1042, ...salesInvoices.map((item) => item.invoiceNumber)) + 1, customerName: String(data.get('customerName')).trim(), subtotal, discount, tax, total, status: 'پیش‌نویس', lines: [line] }; salesInvoices = [invoice, ...salesInvoices]; store('erp-sales', salesInvoices); const journal: Journal = { id: crypto.randomUUID(), number: journals.length + 1001, description: `فاکتور فروش ${invoice.invoiceNumber}`, lines: [{ accountCode: '1200', accountTitle: 'حساب‌های دریافتنی', debit: total, credit: 0 }, { accountCode: '4000', accountTitle: 'درآمد فروش', debit: 0, credit: total }], status: 'پیش‌نویس', createdAt: new Date().toISOString() }; journals = [journal, ...journals]; store('erp-journals', journals); void apiFetch(`/api/sales/invoices`, { method: 'POST', body: JSON.stringify({ customerName: invoice.customerName, discount, tax, lines: invoice.lines }) })
  .then((result) => void warnIfRejected(result))
  .then(() => loadTaxSubmissions(true))
  .catch(() => undefined); document.querySelector('#invoice-modal')?.remove(); render();
  const limit = creditLimits[invoice.customerName];
  const consumed = salesInvoices.filter((item) => item.customerName === invoice.customerName).reduce((sum, item) => sum + item.total, 0);
  if (limit && consumed > limit) {
    showToast(`فاکتور ثبت شد؛ اما مجموعِ فروشِ «${invoice.customerName}» (${money(consumed)} ریال) از سقف اعتبار (${money(limit)} ریال) فراتر رفت.`);
  } else if (limit && consumed > limit * 0.8) {
    showToast(`فاکتور ثبت شد. مشتری به سقف اعتبار نزدیک شده است (${Math.round((consumed / limit) * 100)}٪).`);
  } else {
    showToast('فاکتور ثبت شد و سند درآمد/دریافتنی آن ساخته شد.');
  }
}
function openPurchaseForm(): void {
  openModal('purchase-modal', 'purchase-form', `<p class="eyebrow">چرخه تأمین</p><h2>ثبت سفارش خرید</h2><label>نام تأمین‌کننده<input name="supplierName" required placeholder="مثلاً تأمین‌کننده سپهر"></label><label>کالا یا خدمت<input name="itemTitle" required placeholder="مثلاً مواد اولیه فولادی"></label><label>تعداد<input name="quantity" type="number" min="0.001" step="0.001" required></label><label>قیمت واحد (ریال)<input name="unitPrice" type="number" min="1" required></label><div class="form-actions"><button type="button" class="btn-cancel" data-close="purchase-modal">انصراف</button><button class="primary-button" type="submit">ثبت سفارش خرید</button></div>`);
  document.querySelector<HTMLFormElement>('#purchase-form')?.addEventListener('submit', (event) => void savePurchase(event));
}
function openPayrollForm(): void {
  openModal('payroll-modal', 'payroll-form', `<p class="eyebrow">محاسبه حقوق</p><h2>ثبت فیش حقوقی</h2><label>کارمند<select name="employeeId">${employees.filter((employee) => employee.isActive).map((employee) => `<option value="${employee.id}">${escapeHtml(employee.fullName)} · ${employee.baseSalary.toLocaleString('fa-IR')} ریال</option>`).join('')}</select></label><label>دوره حقوق<input name="period" required value="مرداد ۱۴۰۵"></label><label>اضافه‌کاری (ریال)<input name="overtime" type="number" min="0" value="0"></label><label>کسورات (ریال)<input name="deductions" type="number" min="0" value="0"></label><div class="form-actions"><button type="button" class="btn-cancel" data-close="payroll-modal">انصراف</button><button class="primary-button" type="submit">محاسبه و ثبت فیش</button></div>`);
  document.querySelector<HTMLFormElement>('#payroll-form')?.addEventListener('submit', (event) => void savePayroll(event));
}
function savePayroll(event: SubmitEvent): void { event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); const employee = employees.find((item) => item.id === data.get('employeeId')); const period = String(data.get('period') ?? '').trim(); const overtime = Number(data.get('overtime')) || 0; const deductions = Number(data.get('deductions')) || 0; if (!employee || !period || overtime < 0 || deductions < 0 || employee.baseSalary + overtime - deductions <= 0) { showToast('اطلاعات حقوق معتبر نیست.'); return; } const run: PayrollRun = { id: crypto.randomUUID(), title: `فیش حقوق ${period}`, period, grossTotal: employee.baseSalary + overtime, deductionsTotal: deductions, netTotal: employee.baseSalary + overtime - deductions, status: 'پیش‌نویس', employeeName: employee.fullName }; payrollRuns = [run, ...payrollRuns]; store('erp-payroll', payrollRuns); void apiFetch(`/api/payroll/runs`, { method: 'POST', body: JSON.stringify({ period, employeeId: employee.id, overtime, deductions }) }).catch(() => undefined); document.querySelector('#payroll-modal')?.remove(); render(); showToast('فیش حقوق ثبت شد و هزینه حقوق به حسابداری ارسال شد.'); }
function openAssetForm(): void {
  openModal('asset-modal', 'asset-form', `<p class="eyebrow">دفتر اموال</p><h2>ثبت دارایی ثابت</h2><label>عنوان دارایی<input name="title" required placeholder="مثلاً لپ‌تاپ واحد مالی"></label><label>محل استقرار<input name="location" required placeholder="مثلاً ساختمان اداری"></label><label>بهای خرید (ریال)<input name="acquisitionCost" type="number" min="1" required></label><label>عمر مفید (ماه)<input name="usefulLifeMonths" type="number" min="1" value="36" required></label><div class="form-actions"><button type="button" class="btn-cancel" data-close="asset-modal">انصراف</button><button class="primary-button" type="submit">ثبت دارایی</button></div>`);
  document.querySelector<HTMLFormElement>('#asset-form')?.addEventListener('submit', (event) => void saveAsset(event));
}
function saveAsset(event: SubmitEvent): void { event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); const title = String(data.get('title') ?? '').trim(); const location = String(data.get('location') ?? '').trim(); const acquisitionCost = Number(data.get('acquisitionCost')); const usefulLifeMonths = Number(data.get('usefulLifeMonths')); if (!title || !location || acquisitionCost <= 0 || usefulLifeMonths <= 0) { showToast('اطلاعات دارایی معتبر نیست.'); return; } const asset: FixedAsset = { id: crypto.randomUUID(), assetCode: `FA-${String(fixedAssets.length + 1).padStart(4, '0')}`, title, location, acquisitionCost, usefulLifeMonths, accumulatedDepreciation: 0, status: 'فعال' }; fixedAssets = [asset, ...fixedAssets]; store('erp-assets', fixedAssets); void apiFetch(`/api/fixed-assets`, { method: 'POST', body: JSON.stringify({ title, location, acquisitionCost, usefulLifeMonths }) }).catch(() => undefined); document.querySelector('#asset-modal')?.remove(); render(); showToast('دارایی ثبت شد.'); }
function openBomForm(): void {
  openModal('bom-modal', 'bom-form', `<p class="eyebrow">صورت مواد (BOM)</p><h2>تعریف صورت مواد و دستور ساخت</h2>
    <div class="form-grid">
      <label>محصول<input name="product" required placeholder="مثلاً محصول A-100"></label>
      <label>تعداد خروجی هر دوره<input name="outputQuantity" type="number" min="1" value="100" required></label>
    </div>
    <fieldset class="bom-components">
      <legend>مواد و قطعات مصرفی</legend>
      ${[0, 1, 2].map(() => `<div class="bom-row">
        <input name="componentTitle" placeholder="نام ماده/قطعه">
        <input name="componentQuantity" type="number" min="0" step="any" placeholder="مقدار">
        <input name="componentUnit" placeholder="واحد" value="عدد">
        <input name="componentCost" type="number" min="0" placeholder="بهای واحد">
        <input name="componentScrap" type="number" min="0" max="100" placeholder="ضایعات ٪">
      </div>`).join('')}
    </fieldset>
    <div class="form-grid">
      <label>دستمزد مستقیم (دقیقه برای هر دوره)<input name="laborMinutes" type="number" min="0" value="0"></label>
      <label>نرخ دستمزد هر دقیقه (ریال)<input name="laborRatePerMinute" type="number" min="0" value="0"></label>
      <label>سربار هر واحد (ریال)<input name="overheadPerUnit" type="number" min="0" value="0"></label>
      <label>یادداشت<input name="note" placeholder="توضیح دستور ساخت"></label>
    </div>
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="bom-modal">انصراف</button><button class="primary-button" type="submit">ثبت صورت مواد</button></div>`);
  document.querySelector<HTMLFormElement>('#bom-form')?.addEventListener('submit', (event) => void saveBom(event));
}

function openProductionForm(): void {
  openModal('production-modal', 'production-form', `<p class="eyebrow">برنامه‌ریزی تولید</p><h2>ثبت سفارش تولید</h2><label>محصول نهایی<input name="productTitle" required placeholder="مثلاً محصول A-100"></label><label>تعداد برنامه‌ریزی‌شده<input name="plannedQuantity" type="number" min="1" required></label><label>ماده اولیه<input name="materialTitle" required placeholder="مثلاً مواد اولیه فولادی"></label><label>مقدار ماده<input name="materialQuantity" type="number" min="1" required></label><label>هزینه واحد ماده (ریال)<input name="unitCost" type="number" min="0" required></label><label>هزینه نیروی کار (ریال)<input name="laborCost" type="number" min="0" value="0" required></label><div class="form-actions"><button type="button" class="btn-cancel" data-close="production-modal">انصراف</button><button class="primary-button" type="submit">ثبت سفارش تولید</button></div>`);
  document.querySelector<HTMLFormElement>('#production-form')?.addEventListener('submit', (event) => void saveProduction(event));
}
function saveProduction(event: SubmitEvent): void { event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); const productTitle = String(data.get('productTitle') ?? '').trim(); const plannedQuantity = Number(data.get('plannedQuantity')); const materialTitle = String(data.get('materialTitle') ?? '').trim(); const materialQuantity = Number(data.get('materialQuantity')); const unitCost = Number(data.get('unitCost')); const laborCost = Number(data.get('laborCost')) || 0; if (!productTitle || !materialTitle || plannedQuantity <= 0 || materialQuantity <= 0 || unitCost < 0 || laborCost < 0) { showToast('اطلاعات سفارش تولید معتبر نیست.'); return; } const order: ProductionOrder = { id: crypto.randomUUID(), orderNumber: Math.max(300, ...productionOrders.map((item) => item.orderNumber)) + 1, productTitle, plannedQuantity, materialTitle, materialCost: materialQuantity * unitCost, laborCost, totalCost: materialQuantity * unitCost + laborCost, status: 'در برنامه' }; productionOrders = [order, ...productionOrders]; store('erp-production', productionOrders); void apiFetch(`/api/manufacturing/orders`, { method: 'POST', body: JSON.stringify({ productTitle, plannedQuantity, materialTitle, materialQuantity, unitCost, laborCost }) }).catch(() => undefined); document.querySelector('#production-modal')?.remove(); render(); showToast('سفارش تولید ثبت شد.'); }
function savePurchase(event: SubmitEvent): void { event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); const itemTitle = String(data.get('itemTitle') ?? '').trim(); const supplierName = String(data.get('supplierName') ?? '').trim(); const quantity = Number(data.get('quantity')); const unitPrice = Number(data.get('unitPrice')); if (!supplierName || !itemTitle || quantity <= 0 || unitPrice <= 0) { showToast('اطلاعات سفارش خرید معتبر نیست.'); return; } const order: PurchaseOrder = { id: crypto.randomUUID(), orderNumber: Math.max(217, ...purchaseOrders.map((item) => item.orderNumber)) + 1, supplierName, itemTitle, quantity, unitPrice, total: quantity * unitPrice, status: 'پیش‌نویس' }; purchaseOrders = [order, ...purchaseOrders]; store('erp-purchases', purchaseOrders); const existing = inventoryItems.find((item) => item.title === itemTitle); if (existing) existing.quantity += quantity; else inventoryItems = [{ id: crypto.randomUUID(), sku: `NEW-${order.orderNumber}`, title: itemTitle, unit: 'عدد', quantity, minimumQuantity: 0, unitCost: unitPrice }, ...inventoryItems]; store('erp-inventory', inventoryItems); void apiFetch(`/api/purchasing/orders`, { method: 'POST', body: JSON.stringify({ supplierName, itemTitle, quantity, unitPrice }) }).catch(() => undefined); document.querySelector('#purchase-modal')?.remove(); render(); showToast('سفارش خرید ثبت شد و موجودی به‌روزرسانی شد.'); }
function saveRecord(event: SubmitEvent): void {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const current = currentModule();
  const record: SavedRecord = { id: crypto.randomUUID(), feature: current.label, title: String(data.get('title') ?? ''), category: current.label, amount: String(data.get('amount') ?? '') || '۰', status: 'در انتظار', date: 'همین حالا', owner: 'حسین صادقی' };
  savedRecords = [record, ...savedRecords];
  store('erp-records', savedRecords);
  void apiFetch(`/api/events`, { method: 'POST', body: JSON.stringify(record) }).catch(() => undefined);
  closeModal();
  render();
  showToast('عملیات ثبت شد و به کارتابل تأیید ارسال گردید.');
}
function closeModal(id = 'record-modal'): void { document.querySelector(`#${id}`)?.remove(); }
function updateRecord(action: string, id: string): void { const record = savedRecords.find((item) => item.id === id); const order = purchaseOrders.find((item) => item.id === id); if (!record && !order) return; if (action === 'approve') { if (record) record.status = 'تأیید شده'; if (order) order.status = 'تأیید شده'; } if (action === 'delete') { savedRecords = savedRecords.filter((item) => item.id !== id); purchaseOrders = purchaseOrders.filter((item) => item.id !== id); } store('erp-records', savedRecords); store('erp-purchases', purchaseOrders); render(); showToast(action === 'approve' ? 'عملیات تأیید و نهایی شد.' : 'عملیات حذف شد.'); }

dropLegacyTokens();
render();
// پایشِ ملایمِ وضعیت اتصال (دیگر در هر بازسازی درخواست ارسال نمی‌شود)
startStatusMonitor();
registerServiceWorker();

function closeAnyModal(id: string): void { document.querySelector(`#${id}`)?.remove(); }

/** بستنِ همه‌ی پنجره‌های باز (هنگام خروج یا رفتن به صفحه‌ی دیگر) */
function closeAllModals(): void {
  document.querySelectorAll<HTMLElement>('.modal-backdrop').forEach((node) => node.remove());
}

/**
 * ساختِ پنجره‌ی بازشو.
 * پنجره به body (و نه #app) افزوده می‌شود تا هیچ بازسازیِ صفحه‌ای
 * آن را ناگهان نبندد و اطلاعاتِ در حالِ ورودِ کاربر از بین نرود.
 */
function openModal(id: string, formId: string, markup: string): void {
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="${id}"><form class="record-modal" id="${formId}"><button type="button" class="modal-close" data-close="${id}" aria-label="بستن">×</button><div class="modal-body">${markup}</div></form></div>`);
  document.querySelectorAll<HTMLButtonElement>(`[data-close="${id}"]`).forEach((button) => button.addEventListener('click', () => closeAnyModal(id)));
  document.querySelector<HTMLInputElement>(`#${formId} input`)?.focus();
}

function openLeadForm(): void {
  openModal('lead-modal', 'lead-form', `<p class="eyebrow">CRM</p><h2>سرنخ فروش جدید</h2>
    <label>نام مشتری یا شرکت<input name="name" required placeholder="مثلاً شرکت نوآوران" /></label>
    <label>مرحله<select name="stage"><option>سرنخ جدید</option><option>در حال مذاکره</option><option>ارسال پیش‌فاکتور</option><option>قرارداد نهایی</option></select></label>
    <label>ارزش تقریبی (ریال)<input name="value" inputmode="numeric" required placeholder="مثلاً 120000000" /></label>
    <label>مسئول پیگیری<input name="owner" value="سارا نادری" /></label>
    <div class="form-actions"><button type="button" class="btn-cancel" data-close="lead-modal">انصراف</button><button class="primary-button" type="submit">ثبت سرنخ</button></div>`);
  document.querySelector<HTMLFormElement>('#lead-form')?.addEventListener('submit', saveLead);
}

function saveLead(event: SubmitEvent): void {
  event.preventDefault();
  const data = new FormData(event.currentTarget as HTMLFormElement);
  const lead: CrmLead = { id: crypto.randomUUID(), name: String(data.get('name') ?? '').trim(), stage: String(data.get('stage') ?? 'سرنخ جدید'), value: Number(data.get('value')) || 0, owner: String(data.get('owner') ?? '').trim() || 'تیم فروش' };
  if (!lead.name || lead.value <= 0) { showToast('نام مشتری و ارزش فرصت الزامی است.'); return; }
  crmLeads = [lead, ...crmLeads];
  store('erp-crm-leads', crmLeads);
  closeAnyModal('lead-modal');
  render();
  showToast('سرنخ جدید ثبت شد و وارد خط لوله فروش گردید.');
}

function deleteLead(id: string): void {
  crmLeads = crmLeads.filter((lead) => lead.id !== id);
  store('erp-crm-leads', crmLeads);
  render();
  showToast('سرنخ حذف شد.');
}

function openTicketForm(): void {
  openModal('ticket-modal', 'ticket-form', `<p class="eyebrow">خدمات مشتریان</p><h2>تیکت پشتیبانی جدید</h2>
    <label>موضوع<input name="title" required placeholder="مثلاً پیگیری تأخیر ارسال" /></label>
    <label>اولویت<select name="priority"><option>بالا</option><option selected>متوسط</option><option>پایین</option></select></label>
    <div class="form-actions"><button type="button" class="btn-cancel" data-close="ticket-modal">انصراف</button><button class="primary-button" type="submit">ثبت تیکت</button></div>`);
  document.querySelector<HTMLFormElement>('#ticket-form')?.addEventListener('submit', saveTicket);
}

function saveTicket(event: SubmitEvent): void {
  event.preventDefault();
  const data = new FormData(event.currentTarget as HTMLFormElement);
  const ticket: CrmTicket = { id: crypto.randomUUID(), title: String(data.get('title') ?? '').trim(), priority: String(data.get('priority') ?? 'متوسط'), status: 'در انتظار' };
  if (!ticket.title) { showToast('موضوع تیکت الزامی است.'); return; }
  crmTickets = [ticket, ...crmTickets];
  store('erp-crm-tickets', crmTickets);
  closeAnyModal('ticket-modal');
  render();
  showToast('تیکت ثبت شد و در صف پشتیبانی قرار گرفت.');
}

function nextTicket(id: string): void {
  const ticket = crmTickets.find((item) => item.id === id);
  if (!ticket) return;
  const flow = ['در انتظار', 'در حال بررسی', 'بررسی شد'];
  ticket.status = flow[Math.min(flow.length - 1, flow.indexOf(ticket.status) + 1)] ?? 'بررسی شد';
  store('erp-crm-tickets', crmTickets);
  render();
  showToast(`وضعیت تیکت به «${ticket.status}» تغییر کرد.`);
}

function deleteTicket(id: string): void {
  crmTickets = crmTickets.filter((ticket) => ticket.id !== id);
  store('erp-crm-tickets', crmTickets);
  render();
  showToast('تیکت حذف شد.');
}

function openBudgetForm(): void {
  openModal('budget-modal', 'budget-form', `<p class="eyebrow">بودجه و کنترل مدیریت</p><h2>ردیف بودجه جدید</h2>
    <label>عنوان ردیف<input name="title" required placeholder="مثلاً بودجه بازاریابی دیجیتال" /></label>
    <label>مبلغ مصوب (ریال)<input name="planned" inputmode="numeric" required placeholder="مثلاً 2000000000" /></label>
    <label>مبلغ تحقق‌یافته (ریال)<input name="actual" inputmode="numeric" placeholder="مثلاً 850000000" /></label>
    <div class="form-actions"><button type="button" class="btn-cancel" data-close="budget-modal">انصراف</button><button class="primary-button" type="submit">ذخیره ردیف</button></div>`);
  document.querySelector<HTMLFormElement>('#budget-form')?.addEventListener('submit', saveBudget);
}

function saveBudget(event: SubmitEvent): void {
  event.preventDefault();
  const data = new FormData(event.currentTarget as HTMLFormElement);
  const row: BudgetLine = { id: crypto.randomUUID(), title: String(data.get('title') ?? '').trim(), planned: Number(data.get('planned')) || 0, actual: Number(data.get('actual')) || 0 };
  if (!row.title || row.planned <= 0) { showToast('عنوان و مبلغ مصوب الزامی است.'); return; }
  budgetLines = [row, ...budgetLines];
  store('erp-budget', budgetLines);
  closeAnyModal('budget-modal');
  render();
  showToast('ردیف بودجه ثبت شد.');
}

function deleteBudget(id: string): void {
  budgetLines = budgetLines.filter((row) => row.id !== id);
  store('erp-budget', budgetLines);
  render();
  showToast('ردیف بودجه حذف شد.');
}

function downloadCsv(fileName: string, headers: string[], rows: Array<Array<string | number>>): void {
  const escape = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
  const csv = `﻿${[headers, ...rows].map((row) => row.map(escape).join(',')).join('\n')}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function exportReport(kind: string): void {
  if (kind === 'trial-balance') {
    const balances = new Map<string, { code: string; title: string; debit: number; credit: number }>();
    journals.forEach((journal) => journal.lines.forEach((line) => {
      const current = balances.get(line.accountCode) ?? { code: line.accountCode, title: line.accountTitle, debit: 0, credit: 0 };
      current.debit += line.debit; current.credit += line.credit; balances.set(line.accountCode, current);
    }));
    downloadCsv('trial-balance.csv', ['کد حساب', 'عنوان حساب', 'بدهکار', 'بستانکار', 'مانده'], [...balances.values()].map((row) => [row.code, row.title, row.debit, row.credit, row.debit - row.credit]));
  } else if (kind === 'sales') {
    downloadCsv('sales-report.csv', ['شماره فاکتور', 'مشتری', 'مبلغ', 'وضعیت'], salesInvoices.map((invoice) => [invoice.invoiceNumber, invoice.customerName, invoice.total, invoice.status]));
  } else if (kind === 'treasury') {
    downloadCsv('treasury-report.csv', ['نوع', 'طرف حساب', 'بانک/صندوق', 'مبلغ', 'وضعیت', 'شرح'], treasuryTransactions.map((item) => [item.transactionType === 'receipt' ? 'دریافت' : 'پرداخت', item.accountTitle, item.bankOrCash, item.amount, item.status, item.description]));
  } else if (kind === 'inventory') {
    downloadCsv('inventory-report.csv', ['کد', 'کالا', 'موجودی', 'واحد', 'ارزش'], inventoryItems.map((item) => [item.sku, item.title, item.quantity, item.unit, item.quantity * item.unitCost]));
  } else if (kind === 'payroll') {
    downloadCsv('payroll-report.csv', ['عنوان', 'دوره', 'ناخالص', 'کسورات', 'خالص', 'وضعیت'], payrollRuns.map((run) => [run.title, run.period, run.grossTotal, run.deductionsTotal, run.netTotal, run.status]));
  } else {
    downloadCsv('events-report.csv', ['شرح', 'ماژول', 'مبلغ', 'وضعیت', 'زمان'], getTransactions().map((item) => [item.title, item.category, item.amount, item.status, item.date]));
  }
  showToast('خروجی CSV ساخته شد و دانلود گردید.');
}

function saveContact(event: SubmitEvent): void {
  event.preventDefault();
  const data = new FormData(event.currentTarget as HTMLFormElement);
  const message: ContactMessage = { id: crypto.randomUUID(), name: String(data.get('name') ?? '').trim(), company: String(data.get('company') ?? '').trim(), email: String(data.get('email') ?? '').trim(), message: String(data.get('message') ?? '').trim(), createdAt: new Date().toISOString() };
  if (!message.name || !message.email || !message.message) { showToast('نام، ایمیل و متن پیام الزامی است.'); return; }
  contactMessages = [message, ...contactMessages];
  store('erp-contact', contactMessages);
  (event.currentTarget as HTMLFormElement).reset();
  showToast('پیام شما ثبت شد؛ تیم فروش طی یک روز کاری پاسخ می‌دهد.');
}

function resetLoginButton(): void {
  const submit = document.querySelector<HTMLButtonElement>('.login-submit');
  if (submit) { submit.disabled = false; submit.innerHTML = 'ورود به پنل <span>\u2190</span>'; }
}

/** آیکون‌های چشم (پنهان/آشکار) برای دکمه‌ی نمایش رمز عبور */
const eyeIcon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const eyeOffIcon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7c1.2 0 2.3.2 3.3.6"/><path d="M19.5 15.2c1.6-1.6 2.5-3.2 2.5-3.2s-3.6-7-10-7c-.6 0-1.2 0-1.7.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/></svg>';

/**
 * نمایش/پنهان‌سازی رمز عبور در فرم ورود.
 * علاوه بر تغییر نوعِ فیلد، آیکون و برچسبِ دسترسی‌پذیری دکمه هم به‌روز می‌شود
 * تا کاربر دقیقاً بداند رمز در حال حاضر آشکار است یا پنهان.
 */
function togglePasswordVisibility(): void {
  const input = document.querySelector<HTMLInputElement>('#password');
  const button = document.querySelector<HTMLButtonElement>('#toggle-password');
  if (!input) return;
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  if (button) {
    button.innerHTML = visible ? eyeOffIcon : eyeIcon;
    button.setAttribute('aria-pressed', String(visible));
    button.setAttribute('aria-label', visible ? 'پنهان کردن رمز عبور' : 'نمایش رمز عبور');
    button.title = visible ? 'پنهان کردن رمز عبور' : 'نمایش رمز عبور';
  }
  input.focus();
}

/* --------------------- راهنمای راه‌اندازی و قالب‌های آماده --------------------- */

/** قالب آماده‌ی کسب‌وکار: سرفصل‌های حسابداری پیشنهادی متناسب با هر صنف */
type BusinessTemplate = {
  id: string;
  title: string;
  summary: string;
  icon: string;
  accounts: Array<{ code: string; title: string }>;
};

const BUSINESS_TEMPLATES: BusinessTemplate[] = [
  {
    id: 'retail', title: 'فروشگاه و خرده‌فروشی', icon: '🏪',
    summary: 'خرید و فروش کالا، صندوق فروشگاهی و کنترل موجودی روزانه',
    accounts: [
      { code: '1101', title: 'صندوق فروشگاه' }, { code: '1102', title: 'بانک - جاری فروشگاه' },
      { code: '1103', title: 'کارت‌خوان و درگاه پرداخت' }, { code: '1201', title: 'موجودی کالا' },
      { code: '2101', title: 'تأمین‌کنندگان' }, { code: '2102', title: 'مالیات بر ارزش افزوده‌ی پرداختنی' },
      { code: '4101', title: 'فروش کالا' }, { code: '4102', title: 'تخفیفات فروش' }, { code: '4103', title: 'برگشت از فروش' },
      { code: '5101', title: 'بهای تمام‌شده‌ی کالای فروش‌رفته' }, { code: '6101', title: 'اجاره محل' },
      { code: '6102', title: 'حقوق و دستمزد پرسنل فروش' }, { code: '6103', title: 'هزینه‌ی حمل و بسته‌بندی' },
      { code: '6104', title: 'آب، برق و گاز فروشگاه' }, { code: '6105', title: 'تبلیغات و بازاریابی' },
    ],
  },
  {
    id: 'manufacturing', title: 'تولیدی کوچک و کارگاه', icon: '🏭',
    summary: 'مواد اولیه، بهای تمام‌شده، کالای در جریان ساخت و سربار تولید',
    accounts: [
      { code: '1101', title: 'صندوق' }, { code: '1102', title: 'بانک - جاری تولید' },
      { code: '1201', title: 'مواد اولیه' }, { code: '1202', title: 'کالای در جریان ساخت' }, { code: '1203', title: 'کالای ساخته‌شده' },
      { code: '1401', title: 'ماشین‌آلات و تجهیزات تولید' }, { code: '1402', title: 'استاندارد انباشته‌ی ماشین‌آلات' },
      { code: '2101', title: 'تأمین‌کنندگان مواد' }, { code: '2102', title: 'مالیات بر ارزش افزوده‌ی پرداختنی' },
      { code: '4101', title: 'فروش محصولات' }, { code: '5101', title: 'مواد مستقیم مصرفی' },
      { code: '5102', title: 'دستمزد مستقیم تولید' }, { code: '5103', title: 'سربار ساخت' },
      { code: '6101', title: 'هزینه‌های اداری' }, { code: '6102', title: 'استلاک ماشین‌آلات' },
      { code: '6103', title: 'تعمیر و نگهداری' }, { code: '6104', title: 'هزینه‌ی انرژی کارگاه' },
    ],
  },
  {
    id: 'services', title: 'شرکت خدماتی و مشاوره', icon: '💼',
    summary: 'پروژه‌های خدماتی، پیش‌دریافت قرارداد و هزینه‌های نیروی انسانی',
    accounts: [
      { code: '1101', title: 'صندوق' }, { code: '1102', title: 'بانک - جاری شرکت' },
      { code: '1301', title: 'پیش‌پرداخت‌ها و سپرده‌ها' }, { code: '1302', title: 'کار در جریان (پروژه‌ها)' },
      { code: '1401', title: 'تجهیزات اداری و رایانه‌ای' }, { code: '2101', title: 'پیش‌دریافت از مشتریان' },
      { code: '2102', title: 'مالیات بر ارزش افزوده‌ی پرداختنی' }, { code: '2103', title: 'مالیات تکلیفی' },
      { code: '4101', title: 'درآمد خدمات و مشاوره' }, { code: '4102', title: 'درآمد پشتیبانی و نگهداری' },
      { code: '6101', title: 'حقوق و دستمزد کارکنان' }, { code: '6102', title: 'اجاره دفتر' },
      { code: '6103', title: 'ماشین و رفت‌وآمد' }, { code: '6104', title: 'نرم‌افزار و اشتراک‌ها' },
      { code: '6105', title: 'بازاریابی و تبلیغات' },
    ],
  },
  {
    id: 'contracting', title: 'پیمانکاری و پروژه‌های عمرانی', icon: '🏗',
    summary: 'پیمان‌های در جریان، صورت‌وضعیت، ضمانت‌نامه و مالیات تکلیفی',
    accounts: [
      { code: '1101', title: 'صندوق کارگاه' }, { code: '1102', title: 'بانک - جاری پیمان' },
      { code: '1201', title: 'مصالح و مصرفی پروژه' }, { code: '1301', title: 'پیمان‌های در جریان' },
      { code: '1302', title: 'پیش‌پرداخت به پیمانکاران جزء' }, { code: '1303', title: 'سپرده و ضمانت‌نامه‌ها' },
      { code: '1401', title: 'ماشین‌آلات عمرانی' }, { code: '1402', title: 'استاندارد انباشته‌ی ماشین‌آلات عمرانی' },
      { code: '2101', title: 'پیش‌دریافت از کارفرما' }, { code: '2102', title: 'حساب‌های پرداختنی پیمانکاران' },
      { code: '2103', title: 'مالیات تکلیفی پرداختنی' }, { code: '2104', title: 'مالیات بر ارزش افزوده‌ی پرداختنی' },
      { code: '4101', title: 'درآمد پیمانکاری' }, { code: '4102', title: 'صورت‌وضعیت‌های تأییدشده' },
      { code: '5101', title: 'بهای تمام‌شده‌ی پیمان' }, { code: '5102', title: 'دستمزد مستقیم کارگاه' },
      { code: '5103', title: 'اجاره ماشین‌آلات' }, { code: '6101', title: 'هزینه‌های عمومی و اداری' },
      { code: '6102', title: 'بیمه و ایمنی کارگاه' },
    ],
  },
];

let wizardOrganization: OrganizationSummary | null = null;
let wizardStep = 0;
let wizardTemplateId = '';

const wizardSteps = ['قالب کسب‌وکار', 'سال مالی', 'سرفصل‌های حسابداری', 'کاربران', 'پایان'];

/** رفتن به شرکتِ تازه‌ساخته بدون بارگذاریِ مجدد، برای ادامه‌ی راهنما */
function switchOrganizationForOnboarding(organization: OrganizationSummary): void {
  wizardOrganization = organization;
  wizardStep = 0;
  wizardTemplateId = '';
  activeOrganizationId = organization.id;
  localStorage.setItem('erp-organization-id', organization.id);
  openOnboardingWizard();
}

function openOnboardingWizard(): void {
  openModal('wizard-modal', 'wizard-form', wizardMarkup());
  bindWizard();
}

function wizardMarkup(): string {
  const template = BUSINESS_TEMPLATES.find((item) => item.id === wizardTemplateId);
  const steps = `<ol class="wizard-steps">${wizardSteps.map((label, index) => `<li class="${index === wizardStep ? 'active' : ''} ${index < wizardStep ? 'done' : ''}"><span>${money(index + 1)}</span>${label}</li>`).join('')}</ol>`;
  let body = '';
  if (wizardStep === 0) {
    body = `<p class="muted">نوع کسب‌وکار را انتخاب کنید؛ سرفصل‌های حسابداری متناسب با آن آماده می‌شود.</p>
      <div class="template-grid">${BUSINESS_TEMPLATES.map((item) => `<button type="button" class="template-card ${item.id === wizardTemplateId ? 'active' : ''}" data-template="${item.id}"><span class="template-icon">${item.icon}</span><strong>${item.title}</strong><small>${item.summary}</small></button>`).join('')}</div>`;
  } else if (wizardStep === 1) {
    body = `<p class="muted">نخستین سال مالی شرکت را تعریف کنید. بعداً دوره‌های بیشتری اضافه می‌شود.</p>
      <div class="field-row">
        <label class="field"><span>سال مالی <i>*</i></span><input name="year" required inputmode="numeric" value="1405" /></label>
        <label class="field"><span>ماه آغاز <i>*</i></span><select name="startMonth">${Array.from({ length: 12 }, (_, index) => `<option value="${index + 1}" ${index === 0 ? 'selected' : ''}>${money(index + 1)}</option>`).join('')}</select></label>
      </div>
      <div class="field-row">
        <label class="field"><span>تاریخ شروع <i>*</i></span><input name="startsOn" required value="1405-01-01" /></label>
        <label class="field"><span>تاریخ پایان <i>*</i></span><input name="endsOn" required value="1405-12-29" /></label>
      </div>
      <label class="field"><span>عنوان دوره <i>*</i></span><input name="title" required value="سال مالی ${wizardOrganization?.name ?? 'جدید'}" /></label>`;
  } else if (wizardStep === 2 && template) {
    body = `<p class="muted">${money(template.accounts.length)} سرفصلِ پیشنهادیِ «${template.title}» در این شرکت ایجاد می‌شود. می‌توانید بعداً آن‌ها را ویرایش کنید.</p>
      <div class="template-accounts">${template.accounts.map((account) => `<div class="template-account"><code>${account.code}</code><span>${account.title}</span></div>`).join('')}</div>`;
  } else if (wizardStep === 3) {
    body = `<p class="muted">همکارانتان را به این شرکت اضافه کنید. می‌توانید این مرحله را رد کنید و بعداً انجام دهید.</p>
      <div class="field-row">
        <label class="field"><span>نام کاربری</span><input name="username" placeholder="hesabdari" /></label>
        <label class="field"><span>نقش در این شرکت</span><select name="role"><option value="accountant">حسابدار</option><option value="sales">فروش</option><option value="warehouse">انباردار</option><option value="viewer">مشاهده‌گر</option><option value="admin">مدیر شرکت</option></select></label>
      </div>
      <p class="muted">کاربر باید از پیش در سامانه تعریف شده باشد (از بخش «هویت و دسترسی»).</p>`;
  } else {
    body = `<div class="wizard-summary">
        <p>شرکت <strong>${escapeHtml(wizardOrganization?.name ?? '')}</strong> با موفقیت راه‌اندازی شد.</p>
        <ul>
          <li>قالب کسب‌وکار: <strong>${escapeHtml(template?.title ?? 'انتخاب نشده')}</strong></li>
          <li>سال مالی: <strong>تعریف‌شده</strong></li>
          <li>سرفصل‌های حسابداری: <strong>${template ? money(template.accounts.length) : '۰'}</strong> سرفصل</li>
        </ul>
        <p class="muted">اکنون می‌توانید ثبت اسناد، فروش، خرید و گزارش‌گیری را در این شرکت آغاز کنید.</p>
      </div>`;
  }
  const isLast = wizardStep === wizardSteps.length - 1;
  return `<h3>راهنمای راه‌اندازی ${wizardOrganization ? `— ${escapeHtml(wizardOrganization.name)}` : ''}</h3>
    ${steps}
    <div class="wizard-body">${body}</div>
    <div class="modal-actions">
      <button type="button" class="btn-cancel" id="wizard-back">${wizardStep === 0 ? 'انصراف' : 'مرحله‌ی قبل'}</button>
      <button type="button" class="primary-button" id="wizard-next">${isLast ? 'پایان و ورود به شرکت' : (wizardStep === 3 ? 'ذخیره و بعدی' : 'مرحله‌ی بعد')}</button>
    </div>`;
}

function bindWizard(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-template]').forEach((button) =>
    button.addEventListener('click', () => {
      wizardTemplateId = button.dataset.template ?? '';
      document.querySelectorAll<HTMLButtonElement>('[data-template]').forEach((item) => item.classList.toggle('active', item.dataset.template === wizardTemplateId));
    }));
  document.querySelector<HTMLButtonElement>('#wizard-back')?.addEventListener('click', () => {
    if (wizardStep === 0) { closeModal('wizard-modal'); showToast('راهنما بسته شد؛ هر زمان بخواهید می‌توانید تنظیمات را ادامه دهید.'); return; }
    wizardStep -= 1;
    refreshWizard();
  });
  document.querySelector<HTMLButtonElement>('#wizard-next')?.addEventListener('click', () => void advanceWizard());
}

function refreshWizard(): void {
  const form = document.querySelector<HTMLFormElement>('#wizard-form');
  if (!form) return;
  form.innerHTML = wizardMarkup().replace(/^[\s\S]*?<div class="modal-body">/, '').replace(/<\/form>$/, '');
  const modalBody = form.querySelector('.modal-body');
  if (modalBody) modalBody.innerHTML = wizardMarkup();
  bindWizard();
}

/** ذخیره‌ی مرحله‌ی جاری و رفتن به مرحله‌ی بعد */
async function advanceWizard(): Promise<void> {
  const form = document.querySelector<HTMLFormElement>('#wizard-form');
  const data = form ? new FormData(form) : new FormData();
  if (wizardStep === 0) {
    if (!wizardTemplateId) { showToast('یک قالب کسب‌وکار انتخاب کنید.'); return; }
  } else if (wizardStep === 1) {
    const year = Number(data.get('year') ?? 0);
    const title = String(data.get('title') ?? '').trim();
    const startsOn = String(data.get('startsOn') ?? '').trim();
    const endsOn = String(data.get('endsOn') ?? '').trim();
    if (!year || !title || !startsOn || !endsOn) { showToast('اطلاعات سال مالی را کامل کنید.'); return; }
    const response = await apiFetch('/api/fiscal-periods', {
      method: 'POST',
      body: JSON.stringify({ year, index: 1, title, startsOn, endsOn }),
    });
    if (!response?.ok) {
      const body = (await response?.json().catch(() => null)) as { error?: string } | null;
      showToast(body?.error ?? 'ثبت سال مالی ناموفق بود.'); return;
    }
    showToast('سال مالی شرکت ثبت شد.');
  } else if (wizardStep === 2) {
    const template = BUSINESS_TEMPLATES.find((item) => item.id === wizardTemplateId);
    if (template) {
      accounts = readKey<Account[]>('erp-accounts', []);
      const existing = new Set(accounts.map((account) => account.code));
      const added = template.accounts.filter((account) => !existing.has(account.code));
      accounts = [...accounts, ...added.map((account) => ({ id: crypto.randomUUID(), code: account.code, title: account.title, level: 1 }))]
        .sort((left, right) => left.code.localeCompare(right.code));
      store('erp-accounts', accounts);
      showToast(`${money(added.length)} سرفصل حسابداری ایجاد شد.`);
    }
  } else if (wizardStep === 3) {
    const username = String(data.get('username') ?? '').trim();
    const role = String(data.get('role') ?? 'viewer');
    if (username && wizardOrganization) {
      const response = await apiFetch(`/api/organizations/${wizardOrganization.id}/members`, {
        method: 'POST', body: JSON.stringify({ username, role }),
      });
      if (!response?.ok) {
        const body = (await response?.json().catch(() => null)) as { error?: string } | null;
        showToast(body?.error ?? 'افزودن کاربر ناموفق بود.'); return;
      }
      showToast(`کاربر «${username}» به این شرکت اضافه شد.`);
    }
  } else {
    closeModal('wizard-modal');
    showToast('راه‌اندازی شرکت کامل شد.');
    setTimeout(() => window.location.reload(), 700);
    return;
  }
  wizardStep = Math.min(wizardSteps.length - 1, wizardStep + 1);
  refreshWizard();
}

/* --------------------- مرکز تبادل داده (اکسل / CSV) --------------------- */

/** تعریفِ هر نوع داده‌ی قابل ورود/خروج */
type ImportKind = 'accounts' | 'inventory' | 'customers';

type ImportDefinition = {
  kind: ImportKind;
  title: string;
  description: string;
  /** نام ستون‌ها به فارسی به همراه کلیدهای جایگزین برای تشخیصِ خودکار */
  fields: Array<{ key: string; label: string; aliases: string[]; required?: boolean; numeric?: boolean }>;
};

const IMPORT_DEFINITIONS: ImportDefinition[] = [
  {
    kind: 'accounts', title: 'سرفصل‌های حسابداری',
    description: 'فهرست حساب‌ها با کد و عنوان (کد باید یکتا باشد)',
    fields: [
      { key: 'code', label: 'کد حساب', aliases: ['code', 'کد حساب', 'کد', 'شماره حساب'], required: true },
      { key: 'title', label: 'عنوان حساب', aliases: ['title', 'عنوان حساب', 'عنوان', 'نام حساب'], required: true },
    ],
  },
  {
    kind: 'inventory', title: 'کالاها و اقلام انبار',
    description: 'موجودی، واحد و بهای هر کالا',
    fields: [
      { key: 'sku', label: 'کد کالا', aliases: ['sku', 'کد کالا', 'کد', 'بارکد'], required: true },
      { key: 'title', label: 'نام کالا', aliases: ['title', 'نام کالا', 'نام', 'شرح'], required: true },
      { key: 'unit', label: 'واحد', aliases: ['unit', 'واحد', 'واحد اندازه‌گیری'] },
      { key: 'quantity', label: 'موجودی', aliases: ['quantity', 'موجودی', 'تعداد'], numeric: true },
      { key: 'minimumQuantity', label: 'حداقل موجودی', aliases: ['minimumQuantity', 'حداقل موجودی', 'نقطه سفارش'], numeric: true },
      { key: 'unitCost', label: 'بهای واحد', aliases: ['unitCost', 'بهای واحد', 'قیمت', 'قیمت واحد'], numeric: true },
    ],
  },
  {
    kind: 'customers', title: 'مشتریان و سرنخ‌ها',
    description: 'نام مشتری، مرحله و ارزش تقریبی',
    fields: [
      { key: 'name', label: 'نام مشتری', aliases: ['name', 'نام مشتری', 'نام', 'مشتری'], required: true },
      { key: 'stage', label: 'مرحله', aliases: ['stage', 'مرحله', 'وضعیت'] },
      { key: 'value', label: 'ارزش تقریبی', aliases: ['value', 'ارزش', 'مبلغ', 'ارزش تقریبی'], numeric: true },
      { key: 'owner', label: 'مسئول پیگیری', aliases: ['owner', 'مسئول', 'مسئول پیگیری', 'کارشناس'] },
    ],
  },
];

/** تجزیه‌ی امنِ CSV (پشتیبانی از , و ؛ و نقل‌قول و BOM) */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    if (quoted) {
      if (char === '"' && clean[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',' || char === ';') { row.push(cell); cell = ''; continue; }
    if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += char;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((item) => item.some((value) => String(value).trim().length));
}

/** نرمال‌سازیِ عنوان ستون برای تطبیق با نام‌های فارسی و انگلیسی */
const normalizeHeader = (value: string): string =>
  String(value ?? '').replace(/[\u064B-\u065F\u200B-\u200F]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** تطبیقِ خودکارِ ستون‌های فایل با فیلدهای مقصد */
function mapColumns(headers: string[], definition: ImportDefinition): Record<string, number> {
  const mapping: Record<string, number> = {};
  const normalized = headers.map(normalizeHeader);
  for (const field of definition.fields) {
    const aliases = [field.key.toLowerCase(), field.label, ...field.aliases].map(normalizeHeader);
    const exact = normalized.findIndex((header) => aliases.includes(header));
    if (exact >= 0) { mapping[field.key] = exact; continue; }
    const partial = normalized.findIndex((header) => header && aliases.some((alias) => header.includes(alias) || alias.includes(header)));
    if (partial >= 0) mapping[field.key] = partial;
  }
  return mapping;
}

const parseNumber = (value: string): number => {
  const digits = String(value ?? '').replace(/[^\d.\-]/g, '').replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : 0;
};

type ImportPreviewRow = { values: Record<string, string>; errors: string[]; ok: boolean };
let importState: { definition: ImportDefinition; mapping: Record<string, number>; rows: ImportPreviewRow[]; fileName: string } | null = null;

/** نمایش پنل تبادل داده در ماژول سازمان */
function dataExchangeMarkup(): string {
  const canManage = !session?.permissions?.length || session.permissions.includes('identity.manage');
  if (!canManage) return '';
  const cards = IMPORT_DEFINITIONS.map((definition) => `<div class="exchange-card">
      <div><strong>${definition.title}</strong><small>${definition.description}</small></div>
      <div class="exchange-actions">
        <button type="button" class="ghost-button" data-template="${definition.kind}">⬇ قالب نمونه</button>
        <button type="button" class="ghost-button" data-export-kind="${definition.kind}">⬆ خروجی از داده‌ها</button>
        <button type="button" class="primary-button" data-import="${definition.kind}">⬇ ورود از فایل</button>
      </div>
    </div>`).join('');
  return `<section class="panel exchange-panel">
      <div class="panel-heading"><div><h2>تبادل داده با اکسل</h2><p>قالب را بگیرید، در اکسل پر کنید و دوباره وارد کنید؛ داده‌های قدیمی‌تان بدون تایپ دوباره می‌آیند</p></div><span class="count">CSV / Excel</span></div>
      <div class="exchange-list">${cards}</div>
      <p class="muted small">فایل‌های <bdi>CSV</bdi> و <bdi>TXT</bdi> مستقیماً پذیرفته می‌شوند. اگر فایل شما <bdi>XLSX</bdi> است، در اکسل آن را با «ذخیره به عنوان → CSV UTF-8» ذخیره کنید. ستون‌ها به‌طور خودکار با نام‌های فارسی تطبیق داده می‌شوند.</p>
      <input type="file" id="import-file" accept=".csv,.txt,text/csv,text/plain" hidden />
    </section>`;
}

function bindDataExchange(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-template]').forEach((button) =>
    button.addEventListener('click', () => downloadImportTemplate(button.dataset.template as ImportKind)));
  document.querySelectorAll<HTMLButtonElement>('[data-export-kind]').forEach((button) =>
    button.addEventListener('click', () => exportKindToCsv(button.dataset.exportKind as ImportKind)));
  document.querySelectorAll<HTMLButtonElement>('[data-import]').forEach((button) =>
    button.addEventListener('click', () => {
      const kind = button.dataset.import as ImportKind;
      const input = document.querySelector<HTMLInputElement>('#import-file');
      if (!input) return;
      input.dataset.kind = kind;
      input.value = '';
      showToast('فایلِ CSV را انتخاب کنید.');
      input.click();
    }));
  document.querySelector<HTMLInputElement>('#import-file')?.addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    const kind = (input.dataset.kind ?? 'accounts') as ImportKind;
    input.value = '';
    if (file) void prepareImport(file, kind);
  });
}

/** تبدیلِ رکوردها به CSV با BOM برای باز شدنِ درست در اکسل */
function toCsv(columns: Array<{ key: string; label: string }>, rows: Array<Record<string, unknown>>): string {
  const escape = (value: unknown): string => {
    const text = String(value ?? '');
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return '﻿' + [columns.map((column) => column.label).join(','), ...rows.map((row) => columns.map((column) => escape(row[column.key])).join(','))].join('\n');
}

function downloadCsvFile(name: string, content: string): void {
  const link = document.createElement('a');
  try {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8;' }));
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  } catch {
    link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(content)}`;
    link.click();
  }
  link.download = name;
}

function downloadImportTemplate(kind: ImportKind): void {
  const definition = IMPORT_DEFINITIONS.find((item) => item.kind === kind);
  if (!definition) return;
  const columns = definition.fields.map((field) => ({ key: field.key, label: field.label }));
  const sample: Record<ImportKind, Array<Record<string, unknown>>> = {
    accounts: [{ code: '1101', title: 'صندوق' }, { code: '1102', title: 'بانک ملی - جاری' }],
    inventory: [{ sku: 'K-1001', title: 'ورق فولادی ۲ میل', unit: 'کیلوگرم', quantity: 1200, minimumQuantity: 200, unitCost: 42000 }],
    customers: [{ name: 'شرکت آفتاب', stage: 'مشتری', value: 45000000, owner: 'رضا کریمی' }],
  };
  downloadCsvFile(`قالب-${definition.title}.csv`, toCsv(columns, sample[kind]));
  showToast(`قالب «${definition.title}» دریافت شد؛ آن را در اکسل پر کنید.`);
}

function exportKindToCsv(kind: ImportKind): void {
  const definition = IMPORT_DEFINITIONS.find((item) => item.kind === kind);
  if (!definition) return;
  const columns = definition.fields.map((field) => ({ key: field.key, label: field.label }));
  let rows: Array<Record<string, unknown>> = [];
  if (kind === 'accounts') rows = accounts.map((account) => ({ code: account.code, title: account.title }));
  else if (kind === 'inventory') rows = inventoryItems.map((item) => ({ ...item }));
  else rows = crmLeads.map((lead) => ({ ...lead }));
  if (!rows.length) { showToast('داده‌ای برای خروجی گرفتن وجود ندارد.'); return; }
  downloadCsvFile(`داده‌های-${definition.title}.csv`, toCsv(columns, rows));
  showToast(`خروجیِ ${money(rows.length)} ردیف دریافت شد.`);
}

/** خواندن فایل و ساختِ پیش‌نمایشِ ورود */
async function prepareImport(file: File, kind: ImportKind): Promise<void> {
  const definition = IMPORT_DEFINITIONS.find((item) => item.kind === kind);
  if (!definition) return;
  if (/\.xlsx$|\.xls$/i.test(file.name)) {
    showToast('فرمت XLSX مستقیماً پشتیبانی نمی‌شود؛ فایل را در اکسل با «CSV UTF-8» ذخیره کنید.');
    return;
  }
  const text = await file.text().catch(() => '');
  const rows = parseCsv(text);
  if (rows.length < 2) { showToast('فایل باید شامل یک سطرِ عنوان و حداقل یک ردیف داده باشد.'); return; }
  const mapping = mapColumns(rows[0], definition);
  const missing = definition.fields.filter((field) => field.required && mapping[field.key] === undefined);
  if (missing.length) {
    showToast(`ستون‌های ضروری یافت نشد: ${missing.map((field) => field.label).join('، ')}`);
    return;
  }
  const preview: ImportPreviewRow[] = rows.slice(1).map((row) => {
    const values: Record<string, string> = {};
    const errors: string[] = [];
    for (const field of definition.fields) {
      const index = mapping[field.key];
      const value = index === undefined ? '' : String(row[index] ?? '').trim();
      values[field.key] = value;
      if (field.required && !value) errors.push(`${field.label} خالی است`);
      if (field.numeric && value && !Number.isFinite(parseNumber(value))) errors.push(`${field.label} عددی نیست`);
    }
    return { values, errors, ok: errors.length === 0 };
  });
  importState = { definition, mapping, rows: preview, fileName: file.name };
  openImportPreview();
}

function openImportPreview(): void {
  const state = importState;
  if (!state) return;
  const okCount = state.rows.filter((row) => row.ok).length;
  const columns = state.definition.fields.map((field) => `<th>${escapeHtml(field.label)}</th>`).join('');
  const body = state.rows.slice(0, 50).map((row) => `<tr class="${row.ok ? '' : 'row-error'}">
      <td>${row.ok ? '✓' : '!'}</td>${state.definition.fields.map((field) => `<td>${escapeHtml(row.values[field.key] ?? '')}</td>`).join('')}
      <td class="error-cell">${escapeHtml(row.errors.join('، '))}</td></tr>`).join('');
  openModal('import-modal', 'import-form', `<h3>پیش‌نمایشِ ورود داده — ${escapeHtml(state.definition.title)}</h3>
    <p class="muted">فایل: ${escapeHtml(state.fileName)} · ${money(state.rows.length)} ردیف · ${money(okCount)} ردیف معتبر</p>
    <div class="import-preview"><table><thead><tr><th></th>${columns}<th>خطا</th></tr></thead><tbody>${body}</tbody></table></div>
    ${state.rows.length > 50 ? '<p class="muted small">تنها ۵۰ ردیفِ نخست نمایش داده شده؛ همه‌ی ردیف‌های معتبر وارد می‌شوند.</p>' : ''}
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="import-modal">انصراف</button><button type="button" class="primary-button" id="import-confirm">ورودِ ${money(okCount)} ردیف معتبر</button></div>`);
  document.querySelector<HTMLButtonElement>('#import-confirm')?.addEventListener('click', () => {
    const message = applyImport();
    closeModal('import-modal');
    showToast(message);
    render();
  });
}

/** اعمالِ ورود داده‌ها */
function applyImport(): string {
  const state = importState;
  if (!state) return 'داده‌ای برای ورود وجود ندارد.';
  const rows = state.rows.filter((row) => row.ok);
  if (!rows.length) return 'هیچ ردیف معتبری یافت نشد.';
  if (state.definition.kind === 'accounts') {
    const existing = new Set(accounts.map((account) => account.code));
    let added = 0;
    for (const row of rows) {
      const code = String(row.values.code ?? '').trim();
      const title = String(row.values.title ?? '').trim();
      if (!code || !title || existing.has(code)) continue;
      existing.add(code);
      accounts = [...accounts, { id: crypto.randomUUID(), code, title, level: 1 }].sort((left, right) => left.code.localeCompare(right.code));
      added += 1;
    }
    store('erp-accounts', accounts);
    return `${money(added)} سرفصلِ حسابداری اضافه شد.`;
  }
  if (state.definition.kind === 'inventory') {
    const existing = new Set(inventoryItems.map((item) => item.sku));
    let added = 0;
    let updated = 0;
    for (const row of rows) {
      const sku = String(row.values.sku ?? '').trim();
      const title = String(row.values.title ?? '').trim();
      if (!sku || !title) continue;
      const quantity = parseNumber(row.values.quantity ?? '0');
      const minimumQuantity = parseNumber(row.values.minimumQuantity ?? '0');
      const unitCost = parseNumber(row.values.unitCost ?? '0');
      const existing_item = inventoryItems.find((item) => item.sku === sku);
      if (existing_item) {
        existing_item.title = title;
        existing_item.unit = String(row.values.unit ?? existing_item.unit).trim() || existing_item.unit;
        if (row.values.quantity) existing_item.quantity = quantity;
        if (row.values.minimumQuantity) existing_item.minimumQuantity = minimumQuantity;
        if (row.values.unitCost) existing_item.unitCost = unitCost;
        updated += 1;
      } else {
        inventoryItems = [...inventoryItems, { id: sku, sku, title, unit: String(row.values.unit ?? 'عدد').trim() || 'عدد', quantity, minimumQuantity, unitCost }];
        existing.add(sku);
        added += 1;
      }
    }
    store('erp-inventory', inventoryItems);
    return `${money(added)} کالا اضافه و ${money(updated)} کالا به‌روزرسانی شد.`;
  }
  const existing = new Set(crmLeads.map((lead) => lead.name));
  let added = 0;
  for (const row of rows) {
    const name = String(row.values.name ?? '').trim();
    if (!name || existing.has(name)) continue;
    existing.add(name);
    crmLeads = [...crmLeads, {
      id: crypto.randomUUID(), name,
      stage: String(row.values.stage ?? 'سرنخ').trim() || 'سرنخ',
      value: parseNumber(row.values.value ?? '0'),
      owner: String(row.values.owner ?? session?.name ?? '').trim(),
    }];
    added += 1;
  }
  store('erp-crm-leads', crmLeads);
  return `${money(added)} مشتری/سرنخ اضافه شد.`;
}

/* ------------------- چاپِ رسمی: چک، فاکتور و صورت‌حساب ------------------- */

type PrintDocument = {
  title: string;
  subtitle: string;
  /** شماره‌ی سند */
  number: string;
  date: string;
  party: string;
  /** مبلغ به عدد */
  amount: number;
  /** مبلغ به حرف */
  amountWords?: string;
  description?: string;
  rows?: Array<{ label: string; value: string }>;
  table?: { columns: string[]; rows: string[][]; footer?: string[] };
  kind: 'check' | 'invoice' | 'report';
};

/** تبدیلِ عدد به حروف فارسی (برای چاپ روی چک و فاکتور) */
const persianOnes = ['', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه', 'ده', 'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'شانزده', 'هفده', 'هجده', 'نوزده'];
const persianTens = ['', '', 'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'هفتاد', 'هشتاد', 'نود'];
const persianHundreds = ['', 'یکصد', 'دویست', 'سیصد', 'چهارصد', 'پانصد', 'ششصد', 'هفتصد', 'هشتصد', 'نهصد'];
const persianScales = ['', 'هزار', 'میلیون', 'میلیارد', 'تریلیون'];

function threeDigitsToWords(value: number): string {
  const parts: string[] = [];
  const hundred = Math.floor(value / 100);
  const rest = value % 100;
  if (hundred) parts.push(persianHundreds[hundred]);
  if (rest < 20) { if (rest) parts.push(persianOnes[rest]); }
  else {
    const ten = Math.floor(rest / 10);
    const one = rest % 10;
    if (ten) parts.push(persianTens[ten]);
    if (one) parts.push(persianOnes[one]);
  }
  return parts.join(' و ');
}

function numberToPersianWords(input: number): string {
  const raw = Math.round(Math.abs(Number(input) || 0));
  // عددهای نامعتبر (NaN یا بی‌نهایت) نباید باعث حلقه‌ی بی‌انتها و قفل شدنِ برنامه شوند
  const value = Number.isFinite(raw) ? Math.min(raw, 999_999_999_999) : 0;
  if (!value) return 'صفر';
  const groups: string[] = [];
  let remaining = value;
  let scale = 0;
  while (remaining > 0) {
    const group = remaining % 1000;
    if (group) {
      const words = threeDigitsToWords(group);
      groups.unshift(`${words}${persianScales[scale] ? ` ${persianScales[scale]}` : ''}`);
    }
    remaining = Math.floor(remaining / 1000);
    scale += 1;
  }
  return groups.join(' و ');
}

/** ساختِ برگه‌ی چاپِ استاندارد و ارسال آن به چاپگر (امکانِ ذخیره‌ی PDF) */

/** استخراجِ امنِ متن از یک عنصر */
const nodeText = (node: Element | null | undefined): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

/**
 * چاپِ سراسری: از نمای فعلی (شاخص‌ها و جدولِ اصلی) یک برگه‌ی رسمی می‌سازد.
 * با این کار خروجیِ PDF هر صفحه تمیز و قابل ارائه است.
 */
function printCurrentView(): void {
  const module_ = currentModule();
  const table = document.querySelector<HTMLTableElement>('#app table');
  let tableData: PrintDocument['table'] | undefined;
  if (table) {
    const columns = [...table.querySelectorAll('thead th')].map((cell) => nodeText(cell)).filter(Boolean);
    const rows = [...table.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => nodeText(cell)));
    const footer = [...(table.querySelectorAll('tfoot td') ?? [])].map((cell) => nodeText(cell));
    if (columns.length && rows.length) tableData = { columns, rows, footer: footer.length ? footer : undefined };
  }
  const kpis = [...document.querySelectorAll('#app .module-kpi, #app .kpi-grid article, #app .insights-panel article')]
    .slice(0, 8)
    .map((card) => ({ label: nodeText(card.querySelector('span')), value: `${nodeText(card.querySelector('strong'))} ${nodeText(card.querySelector('small'))}`.trim() }))
    .filter((item) => item.label || item.value);

  printDocument({
    kind: 'report',
    title: module_.label,
    subtitle: module_.note,
    number: new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short' }).format(new Date()),
    date: new Intl.DateTimeFormat('fa-IR', { dateStyle: 'long' }).format(new Date()),
    party: activeOrganizationName(),
    amount: 0,
    rows: kpis,
    table: tableData,
  });
}

function printDocument(document_: PrintDocument): void {
  const host = document.querySelector<HTMLElement>('#print-area') ?? (() => {
    const area = document.createElement('div');
    area.id = 'print-area';
    area.className = 'print-area';
    window.document.body.appendChild(area);
    return area;
  })();

  const rows = document_.rows?.map((row) => `<div class="print-row"><span>${escapeHtml(row.label)}</span><b>${escapeHtml(row.value)}</b></div>`).join('') ?? '';
  const table = document_.table
    ? `<table class="print-table"><thead><tr>${document_.table.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>
        <tbody>${document_.table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
        ${document_.table.footer ? `<tfoot><tr>${document_.table.footer.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr></tfoot>` : ''}</table>`
    : '';

  host.innerHTML = `<div class="print-sheet">
      <header class="print-head">
        <div class="print-org"><strong>${escapeHtml(activeOrganizationName())}</strong><span>${escapeHtml(activeOrganization()?.code ?? '')}</span></div>
        <div class="print-title"><h1>${escapeHtml(document_.title)}</h1><span>${escapeHtml(document_.subtitle)}</span></div>
        <div class="print-meta"><div><span>شماره</span><b>${escapeHtml(document_.number)}</b></div><div><span>تاریخ</span><b>${escapeHtml(document_.date)}</b></div></div>
      </header>
      <div class="print-party"><span>طرف حساب</span><b>${escapeHtml(document_.party)}</b></div>
      ${table}
      <div class="print-rows">${rows}</div>
      <div class="print-amount">
        <div><span>مبلغ به عدد (ریال)</span><b>${escapeHtml(money(document_.amount))}</b></div>
        <div><span>مبلغ به حروف</span><b>${escapeHtml(document_.amountWords ?? numberToPersianWords(document_.amount))} ریال</b></div>
      </div>
      ${document_.description ? `<p class="print-note">${escapeHtml(document_.description)}</p>` : ''}
      <footer class="print-foot">
        <div><span>امضا و مهر</span></div>
        <div><span>تحویل‌گیرنده</span></div>
      </footer>
      <p class="print-stamp">چاپ‌شده در «راهکار» — ${escapeHtml(new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date()))}</p>
    </div>`;

  window.document.body.classList.add('printing-sheet');
  showToast('پنجره‌ی چاپ باز می‌شود؛ برای PDF «ذخیره به صورت PDF» را انتخاب کنید.');
  window.setTimeout(() => {
    window.print();
    window.setTimeout(() => window.document.body.classList.remove('printing-sheet'), 500);
  }, 60);
}

/** چاپِ چک با قالبِ رسمی */
function printCheck(id: string): void {
  const check = checks.find((item) => item.id === id);
  if (!check) { showToast('چک پیدا نشد.'); return; }
  printDocument({
    kind: 'check',
    title: `چک ${check.direction === 'دریافتنی' ? 'دریافتنی' : 'پرداختنی'}`,
    subtitle: `بانک ${check.bank}`,
    number: check.number,
    date: check.dueDate,
    party: check.party,
    amount: check.amount,
    description: check.description ?? '',
    rows: [
      { label: 'شماره سریال', value: check.serial || '—' },
      { label: 'تاریخ صدور', value: check.issueDate },
      { label: 'تاریخ سررسید', value: check.dueDate },
      { label: 'وضعیت', value: check.status },
    ],
  });
}

/** چاپِ فاکتور فروش */
function printInvoice(invoice: { number?: string | number; party?: string; date: string; total: number; items?: Array<{ title: string; quantity: number; unitPrice: number; total: number }>; tax?: number; discount?: number }): void {
  const table = invoice.items?.length
    ? {
        columns: ['ردیف', 'شرح', 'تعداد', 'قیمت واحد', 'مبلغ'],
        rows: invoice.items.map((item, index) => [
          money(index + 1), item.title, money(item.quantity), money(item.unitPrice), money(item.total),
        ]),
        footer: ['', 'جمع کل', '', '', money(invoice.total)],
      }
    : undefined;
  printDocument({
    kind: 'invoice',
    title: 'فاکتور فروش',
    subtitle: 'صورت‌حساب مشتری',
    number: String(invoice.number ?? '—'),
    date: invoice.date,
    party: invoice.party ?? 'مشتری',
    amount: invoice.total,
    table,
    rows: [
      ...(invoice.tax ? [{ label: 'مالیات بر ارزش افزوده', value: money(invoice.tax) }] : []),
      ...(invoice.discount ? [{ label: 'تخفیف', value: money(invoice.discount) }] : []),
    ],
  });
}

/* ------------------- صورت‌حساب الکترونیکی (سامانه مودیان) ------------------- */

/**
 * ساختارِ صورت‌حساب الکترونیکی مطابق با الگوی اعلامیِ سازمان امور مالیاتی.
 * خروجیِ JSON برای بارگذاری در سامانه‌ی مودیان آماده می‌شود.
 * نکته: ارسالِ واقعی نیازمندِ «شناسه‌ی یکتای حافظه‌ی مالیاتی» و گواهیِ امضاست که
 * باید از کارپوشه‌ی مودیان دریافت و در تنظیمات ثبت شود.
 */
type TaxInvoiceItem = {
  /** شناسه کالا/خدمت */
  sstid?: string;
  title: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  discount?: number;
  vatRate: number;
};

type TaxInvoice = {
  /** شماره‌ی منحصربه‌فردِ مالیاتی (در صورت صدور توسط سامانه) */
  taxId?: string;
  invoiceNumber: string;
  issueDate: string;
  invoiceType: 'فروش' | 'فروش صادراتی' | 'برگشت از فروش';
  seller: { nationalId: string; name: string; economicCode?: string; address?: string };
  buyer: { nationalId: string; name: string; economicCode?: string; address?: string };
  items: TaxInvoiceItem[];
  /** مجموع قبل از مالیات */
  totalBeforeVat: number;
  /** مجموع مالیات بر ارزش افزوده */
  totalVat: number;
  /** مبلغ نهایی قابل پرداخت */
  totalAmount: number;
};

/** محاسبه‌ی جمع‌ها و مالیات بر پایه‌ی نرخِ ردیف‌ها */
function buildTaxInvoice(input: Omit<TaxInvoice, 'totalBeforeVat' | 'totalVat' | 'totalAmount'>): TaxInvoice {
  let totalBeforeVat = 0;
  let totalVat = 0;
  for (const item of input.items) {
    const base = Math.round(item.quantity * item.unitPrice - (item.discount ?? 0));
    totalBeforeVat += base;
    totalVat += Math.round((base * item.vatRate) / 100);
  }
  return {
    ...input,
    totalBeforeVat: Math.round(totalBeforeVat),
    totalVat: Math.round(totalVat),
    totalAmount: Math.round(totalBeforeVat + totalVat),
  };
}

/** خروجیِ JSON برای سامانه‌ی مودیان */
function exportTaxInvoice(invoice: TaxInvoice): void {
  const payload = {
    format: 'aria-tax-invoice',
    version: 1,
    exportedAt: new Date().toISOString(),
    organization: { name: activeOrganizationName(), code: activeOrganization()?.code ?? '' },
    invoice,
  };
  downloadCsvFile(`صورت-حساب-${invoice.invoiceNumber}.json`, JSON.stringify(payload, null, 2));
  showToast('فایل صورت‌حساب الکترونیکی آماده شد؛ آن را در کارپوشه‌ی مودیان بارگذاری کنید.');
}

/** نمایش و چاپِ صورت‌حساب با قالب رسمی شامل ارزش افزوده */
function printTaxInvoice(invoice: TaxInvoice): void {
  printDocument({
    kind: 'invoice',
    title: 'صورت‌حساب الکترونیکی فروش',
    subtitle: `نوع: ${invoice.invoiceType}`,
    number: invoice.invoiceNumber,
    date: invoice.issueDate,
    party: invoice.buyer.name,
    amount: invoice.totalAmount,
    table: {
      columns: ['ردیف', 'شرح کالا/خدمت', 'تعداد', 'واحد', 'قیمت واحد', 'مبلغ', 'مالیات'],
      rows: invoice.items.map((item, index) => {
        const base = Math.round(item.quantity * item.unitPrice - (item.discount ?? 0));
        const vat = Math.round((base * item.vatRate) / 100);
        return [money(index + 1), item.title, money(item.quantity), item.unit, money(item.unitPrice), money(base), money(vat)];
      }),
      footer: ['', 'جمع کل', '', '', '', money(invoice.totalBeforeVat), money(invoice.totalVat)],
    },
    rows: [
      { label: 'شناسه ملی فروشنده', value: invoice.seller.nationalId || '—' },
      { label: 'شناسه ملی خریدار', value: invoice.buyer.nationalId || '—' },
      { label: 'کد اقتصادی فروشنده', value: invoice.seller.economicCode || '—' },
      { label: 'شماره منحصربه‌فرد مالیاتی', value: invoice.taxId || 'صدور از سامانه در انتظار است' },
      { label: 'مبلغ قبل از مالیات', value: money(invoice.totalBeforeVat) },
      { label: 'مالیات بر ارزش افزوده', value: money(invoice.totalVat) },
      { label: 'مبلغ قابل پرداخت', value: money(invoice.totalAmount) },
    ],
  });
}

/** فرم ساخت صورت‌حساب الکترونیکی از روی یک فاکتور فروش */
function openTaxInvoiceForm(): void {
  const options = salesInvoices.length
    ? salesInvoices.map((invoice) => `<option value="${escapeHtml(invoice.id)}">${escapeHtml(String(invoice.invoiceNumber ?? ''))} — ${escapeHtml(invoice.customerName)} — ${money(invoice.total)}</option>`).join('')
    : '<option value="">فاکتوری ثبت نشده است</option>';
  openModal('tax-invoice-modal', 'tax-invoice-form', `<h3>صدور صورت‌حساب الکترونیکی</h3>
    <p class="muted">اطلاعات مالیاتیِ طرفِ حساب را تکمیل کنید؛ خروجی برای بارگذاری در سامانه‌ی مودیان آماده می‌شود.</p>
    <label class="field"><span>فاکتور مبنا</span><select name="invoiceId">${options}</select></label>
    <div class="field-row">
      <label class="field"><span>شماره صورت‌حساب <i>*</i></span><input name="invoiceNumber" required placeholder="INV-1405-001" /></label>
      <label class="field"><span>تاریخ صدور <i>*</i></span><input name="issueDate" required value="${new Date().toISOString().slice(0, 10)}" /></label>
    </div>
    <label class="field"><span>نوع صورت‌حساب</span><select name="invoiceType"><option>فروش</option><option>فروش صادراتی</option><option>برگشت از فروش</option></select></label>
    <div class="field-row">
      <label class="field"><span>شناسه ملی خریدار <i>*</i></span><input name="buyerNationalId" required inputmode="numeric" /></label>
      <label class="field"><span>نام خریدار <i>*</i></span><input name="buyerName" required /></label>
    </div>
    <label class="field"><span>نرخ ارزش افزوده (درصد)</span><input name="vatRate" inputmode="numeric" value="10" /></label>
    <div class="modal-actions"><button type="button" class="btn-cancel" data-close="tax-invoice-modal">انصراف</button><button type="submit" class="primary-button">ساخت صورت‌حساب</button></div>`);
  document.querySelector<HTMLFormElement>('#tax-invoice-form')?.addEventListener('submit', (event) => void submitTaxInvoice(event));
}

async function submitTaxInvoice(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const data = new FormData(event.currentTarget as HTMLFormElement);
  const invoiceNumber = String(data.get('invoiceNumber') ?? '').trim();
  const issueDate = String(data.get('issueDate') ?? '').trim();
  const buyerName = String(data.get('buyerName') ?? '').trim();
  const buyerNationalId = String(data.get('buyerNationalId') ?? '').trim();
  if (!invoiceNumber || !issueDate || !buyerName || !buyerNationalId) { showToast('اطلاعات ضروری را کامل کنید.'); return; }
  const source = salesInvoices.find((invoice) => invoice.id === String(data.get('invoiceId') ?? ''));
  const vatRate = Number(data.get('vatRate') ?? 10) || 0;
  const organization = activeOrganization();
  const invoice = buildTaxInvoice({
    invoiceNumber,
    issueDate,
    invoiceType: String(data.get('invoiceType') ?? 'فروش') as TaxInvoice['invoiceType'],
    seller: {
      nationalId: organization?.nationalId ?? '',
      name: activeOrganizationName(),
      economicCode: organization?.economicCode ?? '',
      address: organization?.address ?? '',
    },
    buyer: { nationalId: buyerNationalId, name: buyerName },
    items: (source?.lines ?? []).length
      ? (source?.lines ?? []).map((line) => ({
          title: line.itemTitle, quantity: line.quantity, unit: 'عدد', unitPrice: line.unitPrice, vatRate,
        }))
      : [{ title: source ? `فروش به ${source.customerName}` : 'خدمات/کالا', quantity: 1, unit: 'عدد', unitPrice: source?.total ?? 0, vatRate }],
  });
  closeModal('tax-invoice-modal');
  printTaxInvoice(invoice);
  exportTaxInvoice(invoice);
}
