/** Downscales big phone photos so they upload fast and stay under the 5 MB limit. Falls back to the original file. */
export async function preparePhoto(
  file: File,
  maxSide = 1600,
  quality = 0.8,
): Promise<{ data: ArrayBuffer; contentType: string }> {
  const original = async () => ({
    data: await file.arrayBuffer(),
    contentType: file.type || 'image/jpeg',
  });
  if (file.size <= 1_500_000 && /^image\/(jpeg|png|webp)$/.test(file.type)) return original();
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
    if (blob) return { data: await blob.arrayBuffer(), contentType: 'image/jpeg' };
  } catch {
    /* fall through */
  }
  return original();
}

export const MAX_PHOTO_BYTES = 5_242_880;
