'use client';
import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { preparePhoto, MAX_PHOTO_BYTES } from '../model/photo';

export type Picked = { data: ArrayBuffer; contentType: string };

/** Camera on phones (`capture`), file chooser on desktops. The result is raw bytes ready for the device queue. */
export function PhotoPicker({
  label,
  error,
  onPick,
}: {
  label: string;
  error?: string;
  onPick: (p: Picked | null) => void;
}) {
  const t = useTranslations('courier');
  const id = useId();
  const [preview, setPreview] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const shown = error ?? problem ?? undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        aria-invalid={shown ? true : undefined}
        aria-describedby={shown ? `${id}-err` : undefined}
        className="min-h-12 text-sm file:mr-3 file:min-h-10 file:rounded-md file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-white"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          setProblem(null);
          if (!f) {
            setPreview(null);
            onPick(null);
            return;
          }
          const p = await preparePhoto(f);
          if (p.data.byteLength > MAX_PHOTO_BYTES) {
            setProblem(t('photoTooBig'));
            onPick(null);
            return;
          }
          setPreview(URL.createObjectURL(new Blob([p.data], { type: p.contentType })));
          onPick(p);
        }}
      />
      {preview && (
        <img
          src={preview}
          alt={t('photoPreview')}
          className="h-32 w-32 rounded-md border object-cover"
        />
      )}
      {shown && (
        <p id={`${id}-err`} role="alert" className="text-xs font-medium text-red-700">
          {shown}
        </p>
      )}
    </div>
  );
}
