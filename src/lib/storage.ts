import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { type Dataset, type Entry, type Container, type ContainerDraft, type InvoiceLoadDraft, type LoadDraft } from './domain';
import { receiptExtension } from './receipt';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
let client: SupabaseClient | null = null;
const unspecifiedPayee = '—';

// Older ledger records require a stored party even for expenses with no payee.
const entryPayload = (entry: Entry) => entry.kind === 'expense' && !entry.party ? { ...entry, party: unspecifiedPayee } : entry;
const readEntry = (entry: Entry) => entry.kind === 'expense' && entry.party === unspecifiedPayee ? { ...entry, party: '' } : entry;

export const configured = Boolean(url && key);
export function supabase() {
  if (!url || !key) throw new Error('Supabase is not configured');
  return client ??= createClient(url, key);
}
export async function loadData(): Promise<Dataset> {
  const { data, error } = await supabase().rpc('workspace_snapshot');
  if (error) throw error;
  if (!data) throw new Error('الحساب غير مصرّح له بدخول مساحة العمل / Account is not authorized');
  const snapshot = data as Dataset;
  return { ...snapshot, entries: snapshot.entries.map(readEntry),
    history: snapshot.history.map(item => ({ ...item, previous: readEntry(item.previous) })) };
}
export async function saveEntry(entry: Entry) {
  const { error } = await supabase().rpc('record_entry', { payload: entryPayload(entry) });
  if (error) throw error;
}
export async function reviseEntry(original: Entry, reason: string, replacement: Entry | null) {
  const { error } = await supabase().rpc('revise_entry', {
    target: original.id, expected: original.revision, reason, payload: replacement ? entryPayload(replacement) : null,
  });
  if (error) throw error;
}
export async function saveContainerManifest(container: ContainerDraft, lines: InvoiceLoadDraft[], expected?: number) {
  const { error } = await supabase().rpc('save_container_manifest', { payload: container, lines, expected: expected ?? null });
  if (error) throw error;
}
export async function saveLoad(load: LoadDraft) {
  const { error } = await supabase().rpc('record_load', { payload: load });
  if (error) throw error;
}
export async function advanceContainer(container: Container) {
  const { error } = await supabase().rpc('advance_container', { target: container.id, expected: container.status });
  if (error) throw error;
}
export async function uploadReceipt(file: File, entryId: string) {
  const extension = receiptExtension(file);
  const { data: { user } } = await supabase().auth.getUser();
  if (!user) throw new Error('انتهت الجلسة / Session expired');
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
