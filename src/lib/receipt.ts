const types = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
} as const;
export const receiptAccept = Object.keys(types).join(',');

export function receiptExtension(file: File) {
  const extension = types[file.type as keyof typeof types];
  if (!extension || !file.size || file.size > 5 * 1024 * 1024) {
    throw new Error('اختر فاتورة JPG أو PNG أو WebP أو PDF حتى 5 MB. / Select a JPG, PNG, WebP, or PDF up to 5 MB.');
  }
  return extension;
}
