import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { type Dataset, type Entry, type Product, type Container, type Load } from './domain';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
let client: SupabaseClient | null = null;
export const configured = Boolean(url && key);
export function supabase() {
  if (!url || !key) throw new Error('Supabase is not configured');
  return client ??= createClient(url, key);
}
export async function loadData(): Promise<Dataset> {
  const membership = await supabase().rpc('is_workspace_member');
  if (membership.error) throw membership.error;
  if (!membership.data) throw new Error('الحساب غير مصرّح له بدخول مساحة العمل / Account is not authorized');
  const names = ['entries', 'products', 'containers', 'loads'] as const;
  // Explicit pagination avoids Supabase's default 1,000-row cap changing balances.
  const result = await Promise.all(names.map(async name => {
    const rows: unknown[] = [];
    for (let from = 0; ; from += 500) {
      const { data, error } = await supabase().from(name).select('*').order('created_at').order('id').range(from, from + 499);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 500) return rows;
    }
  }));
  return Object.fromEntries(names.map((name, i) => [name, result[i]])) as Dataset;
}
export async function saveEntry(entry: Entry) {
  const { error } = await supabase().rpc('record_entry', { payload: entry });
  if (error) throw error;
}
export async function saveProduct(product: Product) {
  const { data: { user } } = await supabase().auth.getUser();
  if (!user) throw new Error('انتهت الجلسة / Session expired');
  const { id, name, category, unit, expiry } = product;
  const { error } = await supabase().from('products').insert({ id, owner_id: user.id, name, category, unit, expiry });
  if (error) throw error;
}
export async function saveContainer(container: Container) {
  const { data: { user } } = await supabase().auth.getUser();
  if (!user) throw new Error('انتهت الجلسة / Session expired');
  const { id, name, destination, booking } = container;
  const { error } = await supabase().from('containers').insert({ id, owner_id: user.id, name, destination, booking });
  if (error) throw error;
}
export async function saveLoad(load: Load) {
  const { error } = await supabase().rpc('record_load', { payload: load });
  if (error) throw error;
}
export async function advanceContainer(container: Container) {
  const { error } = await supabase().rpc('advance_container', { target: container.id, expected: container.status });
  if (error) throw error;
}
export async function uploadReceipt(file: File, entryId: string) {
  if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('الفاتورة: JPG/PNG/WebP/PDF، بحد أقصى 5MB / Invalid receipt');
  const { data: { user } } = await supabase().auth.getUser();
  if (!user) throw new Error('انتهت الجلسة / Session expired');
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[file.type];
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const path = `${user.id}/${entryId}-${hash}.${extension}`;
  const { error } = await supabase().storage.from('receipts').upload(path, file);
  if (error && (!('statusCode' in error) || String(error.statusCode) !== '409')) throw error;
  return path;
}
export async function downloadReceipt(path: string) {
  const { data, error } = await supabase().storage.from('receipts').download(path);
  if (error) throw error;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(data);
  link.download = 'ALSINDBAD-' + path.split('/').at(-1);
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
