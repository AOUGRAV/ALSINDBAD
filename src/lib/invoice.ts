import { currencies, type Currency } from './domain';

export type InvoiceSuggestion = { date?: string; total?: string; currency?: Currency; number?: string; supplier?: string };

function normalize(text: string) {
  return text.normalize('NFKC')
    .replace(/[٠-٩۰-۹]/g, digit => String(digit.charCodeAt(0) - (digit <= '٩' ? 0x660 : 0x6f0)))
    .replace(/[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\u0640\u064b-\u065f]/g, '')
    .replace(/ی/g, 'ي').replace(/٫/g, '.').replace(/٬/g, ',');
}

function parseMoney(value: string) {
  const compact = value.trim().replace(/\s/g, '');
  const lastSeparator = Math.max(compact.lastIndexOf('.'), compact.lastIndexOf(','));
  const fraction = compact.length - lastSeparator - 1;
  const decimal = lastSeparator >= 0 && fraction <= 2;
  const major = (decimal ? compact.slice(0, lastSeparator) : compact).replace(/[.,]/g, '');
  const parsed = Number(major + (decimal ? '.' + compact.slice(lastSeparator + 1) : ''));
  return parsed > 0 && parsed <= 1_000_000_000 ? parsed.toFixed(2) : undefined;
}

function parseDate(text: string) {
  const iso = text.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  const local = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  const parts = iso ? [iso[1], iso[2], iso[3]] : local ? [local[3], local[2], local[1]] : null;
  if (!parts || Number(parts[0]) < 2000 || Number(parts[0]) > 2099) return undefined;
  const date = parts.map(part => part.padStart(2, '0')).join('-');
  const parsed = new Date(date + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(date) ? date : undefined;
}

function only<T>(values: Array<T | undefined>) {
  const unique = [...new Set(values.filter((value): value is T => value !== undefined))];
  return unique.length === 1 ? unique[0] : undefined;
}

function detectCurrency(text: string): Currency | undefined {
  const explicit = currencies.filter(currency => new RegExp('\\b' + currency + '\\b', 'i').test(text));
  if (explicit.length) return only(explicit);
  return only<Currency>([
    /ريال\s*سعودي|ر\s*[.]\s*س|﷼/.test(text) ? 'SAR' : undefined,
    /US\s*\$/i.test(text) ? 'USD' : undefined,
    /£/.test(text) ? 'GBP' : undefined,
    /€/.test(text) ? 'EUR' : undefined,
  ]);
}

export function extractInvoiceFields(source: string): InvoiceSuggestion {
  const text = normalize(source);
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const strongTotal = /^(?:grand\s*total|invoice\s*total|total\s*(?:amount|incl\.?\s*vat)|الإجمالي\s*(?:النهائي|شامل\s*الضريبة)|إجمالي\s*(?:الفاتورة|المبلغ)|المبلغ\s*الإجمالي|صافي\s*المبلغ)(?=\s|[:：]|$)/i;
  const simpleTotal = /^(?:total|الإجمالي|الاجمالي|المجموع)(?=\s|[:：]|$)/i;
  const totals = (label: RegExp) => lines.flatMap((line, i) => {
    const prefix = line.match(label)?.[0];
    if (!prefix || /subtotal|sub-total|before|excluding|excl\.?|amount\s*due|balance\s*due|total\s*due|قبل\s*الضريبة|غير\s*شامل|المستحق/i.test(line)) return [];
    const trailing = line.slice(prefix.length).trim();
    const value = /\d/.test(trailing) ? trailing : trailing.replace(/^[:：\s]+/, '') ? trailing : (lines[i + 1] ?? '');
    // Reject lines containing multiple numbers, which could be columns or a tax breakdown.
    const numbers = value.match(/\d+(?:[.,]\d+|[ \u00a0]\d{3}(?!\d))*/g) ?? [];
    return numbers.length === 1 ? [{ amount: parseMoney(numbers[0]), currency: detectCurrency(value) }] : [];
  });
  const labeled = totals(strongTotal);
  const candidates = labeled.length ? labeled : totals(simpleTotal);
  const dateLines = lines.filter(line => /^(?:(?:invoice\s*)?date|تاريخ\s*(?:الفاتورة|الإصدار|الاصدار)?)(?=\s|[:：]|\d|$)/i.test(line));
  const numbers = lines.map(line => line.match(/^(?:invoice\s*(?:no\.?|number|#)|رقم\s*الفاتورة)\s*[:#：-]?\s*([A-Za-z0-9][A-Za-z0-9/_-]{0,39})\s*$/i)?.[1]);
  const suppliers = lines.map(line => line.match(/^(?:supplier|vendor|المورد)\s*[:：]\s*(.{2,120})$/i)?.[1]);
  return {
    total: only(candidates.map(candidate => candidate.amount)),
    currency: only(candidates.map(candidate => candidate.currency)) ?? detectCurrency(text),
    date: only(dateLines.map(parseDate)),
    number: only(numbers),
    supplier: only(suppliers),
  };
}
