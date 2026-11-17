'use client';
import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

export function Button({
  variant = 'primary',
  className,
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
}) {
  const styles = {
    primary: 'bg-slate-900 text-white hover:bg-slate-700 disabled:bg-slate-400',
    secondary:
      'bg-white text-slate-900 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
    danger: 'bg-red-700 text-white hover:bg-red-600 disabled:bg-red-300',
    ghost: 'text-slate-700 hover:bg-slate-100',
  }[variant];
  return (
    <button
      type="button"
      {...p}
      className={cx(
        'inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed',
        styles,
        className,
      )}
    />
  );
}

type FieldProps = { label: string; error?: string; hint?: string; className?: string };

export function TextField({
  label,
  error,
  hint,
  className,
  id,
  ...p
}: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const fid = id ?? auto;
  const errId = `${fid}-err`;
  const hintId = `${fid}-hint`;
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={fid} className="text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        id={fid}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [error ? errId : '', hint ? hintId : ''].filter(Boolean).join(' ') || undefined
        }
        {...p}
        className={cx(
          'min-h-10 rounded-md border bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600',
          error ? 'border-red-600' : 'border-slate-300',
        )}
      />
      {hint && !error && (
        <p id={hintId} className="text-xs text-slate-600">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} role="alert" className="text-xs font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export function SelectField({
  label,
  error,
  className,
  id,
  children,
  ...p
}: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={fid} className="text-sm font-medium text-slate-800">
        {label}
      </label>
      <select
        id={fid}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fid}-err` : undefined}
        {...p}
        className={cx(
          'min-h-10 rounded-md border bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600',
          error ? 'border-red-600' : 'border-slate-300',
        )}
      >
        {children}
      </select>
      {error && (
        <p id={`${fid}-err`} role="alert" className="text-xs font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export function Alert({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'info' | 'success';
  children: ReactNode;
}) {
  const t = {
    error: 'border-red-300 bg-red-50 text-red-900',
    info: 'border-blue-300 bg-blue-50 text-blue-900',
    success: 'border-green-300 bg-green-50 text-green-900',
  }[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx('rounded-md border px-3 py-2 text-sm', t)}
    >
      {children}
    </div>
  );
}

/** Native <dialog>: focus is trapped, Esc closes, focus returns to the opener. All of it for free, with the keyboard. */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={onClose}
      className="w-[min(32rem,calc(100vw-2rem))] rounded-lg p-0 shadow-xl backdrop:bg-black/40"
    >
      {open && (
        <div className="flex flex-col gap-4 p-5">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

const STATUS_TONE: Record<string, string> = {
  created: 'bg-slate-200 text-slate-900',
  assigned: 'bg-blue-100 text-blue-900',
  picked_up: 'bg-indigo-100 text-indigo-900',
  delivered: 'bg-green-100 text-green-900',
  failed_attempt: 'bg-amber-100 text-amber-900',
  returning: 'bg-orange-100 text-orange-900',
  returned: 'bg-stone-200 text-stone-900',
  cancelled: 'bg-red-100 text-red-900',
};
export const Badge = ({ status, children }: { status: string; children: ReactNode }) => (
  <span
    className={cx(
      'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
      STATUS_TONE[status] ?? 'bg-slate-200',
    )}
    data-status={status}
  >
    {children}
  </span>
);

export const Spinner = ({ label }: { label: string }) => (
  <p role="status" className="text-sm text-slate-600">
    {label}
  </p>
);
