import type { Permission } from './auth.js';

/** وضعیت‌های استاندارد چرخه‌ی عمر هر سند در سیستم */
export type WorkflowStatus = 'پیش‌نویس' | 'ارسال‌شده' | 'بررسی‌شده' | 'تأیید‌شده' | 'قطعی' | 'ردشده';

export type WorkflowAction = 'submit' | 'review' | 'approve' | 'post' | 'reject' | 'return' | 'reopen';

export type Transition = { action: WorkflowAction; to: WorkflowStatus; label: string; permission: Permission };

/**
 * جدول انتقال وضعیت‌ها.
 * هر انتقال مشخص می‌کند چه عملی با چه دسترسی‌ای سند را به کدام وضعیت می‌برد.
 * برای تغییر فرآیند سازمان، فقط همین جدول کافی است.
 */
export const transitions: Record<WorkflowStatus, Transition[]> = {
  'پیش‌نویس': [
    { action: 'submit', to: 'ارسال‌شده', label: 'ارسال برای بررسی', permission: 'events.write' },
  ],
  'ارسال‌شده': [
    { action: 'review', to: 'بررسی‌شده', label: 'بررسی و کنترل', permission: 'accounting.read' },
    { action: 'reject', to: 'ردشده', label: 'رد درخواست', permission: 'accounting.read' },
  ],
  'بررسی‌شده': [
    { action: 'approve', to: 'تأیید‌شده', label: 'تأیید', permission: 'accounting.write' },
    { action: 'return', to: 'پیش‌نویس', label: 'بازگشت به تهیه‌کننده', permission: 'accounting.write' },
  ],
  'تأیید‌شده': [
    { action: 'post', to: 'قطعی', label: 'قطعی و صدور سند', permission: 'accounting.write' },
    { action: 'reject', to: 'ردشده', label: 'رد نهایی', permission: 'accounting.write' },
  ],
  'قطعی': [],
  'ردشده': [
    { action: 'reopen', to: 'پیش‌نویس', label: 'بازگشایی', permission: 'events.write' },
  ],
};

export const isWorkflowStatus = (value: unknown): value is WorkflowStatus =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(transitions, value);

/** انتقال‌های مجاز از وضعیت فعلی */
export const availableTransitions = (status: WorkflowStatus): Transition[] => transitions[status] ?? [];

export const findTransition = (status: WorkflowStatus, action: string): Transition | undefined =>
  availableTransitions(status).find((transition) => transition.action === action);

/** وضعیت‌هایی که هنوز کار لازم دارند و در کارتابل نمایش داده می‌شوند */
export const openStatuses: WorkflowStatus[] = ['پیش‌نویس', 'ارسال‌شده', 'بررسی‌شده', 'تأیید‌شده'];

export const isOpen = (status: WorkflowStatus): boolean => openStatuses.includes(status);
