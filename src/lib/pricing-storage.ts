import { supabase } from './storage';
import { pricingSheetSchema, type PricingSheet } from './pricing';

const fields = 'id,name,version,updated_at,document';

export async function loadPricingSheets() {
  const { data, error } = await supabase().from('pricing_sheets').select(fields).order('updated_at', { ascending: false });
  if (error) throw error;
  return pricingSheetSchema.array().parse(data);
}

export async function savePricingSheet(value: PricingSheet, expected: string | null) {
  const row = pricingSheetSchema.parse({ ...value, version: crypto.randomUUID(), updated_at: new Date().toISOString() });
  const table = supabase().from('pricing_sheets');
  const query = expected === null ? table.insert(row) : table.update({
    name: row.name, version: row.version, updated_at: row.updated_at, document: row.document,
  }).eq('id', row.id).eq('version', expected);
  const { data, error } = await query.select(fields).maybeSingle();
  if (error) throw error;
  return data ? pricingSheetSchema.parse(data) : null;
}
