import { currencies, type Currency } from './domain';
import { invoiceItemSchema, invoiceLineTotal, invoiceVatPercent, maxInvoiceItems, type InvoiceItem } from './purchases';

export type InvoiceSuggestion = { date?: string; total?: string; currency?: Currency; number?: string; supplier?: string };

export function normalizeInvoiceText(text: string) {
  return text.normalize('NFKC')
    .replace(/[٠-٩۰-۹]/g, digit => String(digit.charCodeAt(0) - (digit <= '٩' ? 0x660 : 0x6f0)))
    .replace(/[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\u0640\u064b-\u065f]/g, '')
    .replace(/ی/g, 'ي').replace(/٫/g, '.').replace(/٬/g, ',');
}

function parseMoney(value: string) {
  const compact = value.trim().replace(/\s*([.,])\s*/g, '$1').replace(/\s(?=\d{3}\b)/g, '');
  if (!/^\d+(?:[.,]\d+)*$/.test(compact)) return undefined;
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

function detectCurrency(text: string, includeSymbols = true): Currency | undefined {
  const explicit = currencies.filter(currency => new RegExp('\\b' + currency + '\\b', 'i').test(text));
  if (explicit.length) return only(explicit);
  return only<Currency>([
    /ريال\s*سعودي|ر\s*[.]\s*س|﷼|\bsaudi\s*riyals?\b/i.test(text) ? 'SAR' : undefined,
    includeSymbols && /US\s*\$/i.test(text) ? 'USD' : undefined,
    includeSymbols && /£/.test(text) ? 'GBP' : undefined,
    includeSymbols && /€/.test(text) ? 'EUR' : undefined,
  ]);
}

export function extractInvoiceFields(source: string, useLetterhead = true): InvoiceSuggestion {
  const text = normalizeInvoiceText(source);
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const strongTotal = /^(?:grand\s*total|invoice\s*total|total\s*(?:amount|incl\.?\s*vat)|الإجمالي\s*(?:النهائي|شامل\s*الضريبة)|إجمالي\s*(?:الفاتورة|المبلغ)|المبلغ\s*الإجمالي|صافي\s*المبلغ)(?=\s|[:：]|$)/i;
  const simpleTotal = /^(?:total|الإجمالي|الاجمالي|المجموع)(?=\s|[:：]|$)/i;
  const totals = (label: RegExp) => lines.flatMap((line, i) => {
    const prefix = line.match(label)?.[0];
    if (!prefix || /subtotal|sub-total|before|excluding|excl\.?|amount\s*due|balance\s*due|total\s*due|قبل\s*الضريبة|غير\s*شامل|المستحق/i.test(line)) return [];
    const trailing = line.slice(prefix.length).trim();
    const value = /\d/.test(trailing) ? trailing : trailing.replace(/^[:：\s]+/, '') ? trailing : (lines[i + 1] ?? '');
    // Reject lines containing multiple numbers, which could be columns or a tax breakdown.
    const numbers = value.match(/\d+(?:\s*[.,]\s*\d+|[ \u00a0]\d{3}(?!\d))*/g) ?? [];
    return numbers.length === 1 ? [{ amount: parseMoney(numbers[0]), currency: detectCurrency(value) }] : [];
  });
  const labeled = totals(strongTotal);
  const candidates = labeled.length ? labeled : totals(simpleTotal);
  const dateLines = lines.filter(line => /^(?:(?:invoice\s*)?date|تاريخ\s*(?:الفاتورة|الإصدار|الاصدار)?)(?=\s|[:：]|\d|$)/i.test(line));
  const numbers = lines.map(line => line.match(/(?:^|\s)(?:invoice\s*(?:number|no\b\.?|#)|رقم\s*الفاتورة)\s*[:#：-]?\s*([A-Za-z0-9][A-Za-z0-9/_-]{0,39})(?=\s*(?:$|[|\u0600-\u06ff]))/i)?.[1]);
  const suppliers = lines.map(line => line.match(/^(?:supplier|vendor|seller|المورد|البائع)\s*[:：]\s*(.{2,120})$/i)?.[1]);
  // Some invoices print the seller's letterhead without a field label.
  const letterhead = lines.slice(0, 5).map(line =>
    line.match(/^([A-Z][A-Z &.'-]{2,95}\s(?:COMPANY|CO\.?|LLC|LTD\.?|ESTABLISHMENT))(?=\s+[^\x00-\x7F]|\s+[A-Za-z]*[a-z]|\s*$)/)?.[1]);
  return {
    total: only(candidates.map(candidate => candidate.amount)),
    currency: only(candidates.map(candidate => candidate.currency)) ?? detectCurrency(text, false),
    date: only(dateLines.map(parseDate)),
    number: only(numbers),
    supplier: only(suppliers) ?? (useLetterhead && !suppliers.some(Boolean) ? only(letterhead) : undefined),
  };
}

const descriptionHeader = /\b(?:description|product|item)\b|(?:الصنف|المنتج|البيان|الوصف)/i;
const quantityHeader = /\b(?:qty\.?|quantity)\b|الكمية/i;
const unitPriceHeader = /\b(?:u(?:nit)?\.?\s*price|price per unit)\b|سعر\s*الوحدة/i;

export function extractInvoiceItems(source: string): InvoiceItem[] {
  const lines = normalizeInvoiceText(source).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const header = lines.findIndex(line => descriptionHeader.test(line) && quantityHeader.test(line) && unitPriceHeader.test(line));
  if (header === -1) return [];

  const items: InvoiceItem[] = [];
  const row = /^(.+?)\s+(\d+(?:[.,]\d{1,3})?)\s+([\p{L}][\p{L}.\/-]{0,29})\s+(\d[\d.,]*)\s+(\d[\d.,]*)$/u;
  for (const line of lines.slice(header + 1)) {
    if (/^(?:sub[ -]?total|(?:grand |invoice )?total|vat|tax|الإجمالي|اجمالي|المجموع|الضريبة)(?=\s|:|$)/i.test(line)) break;
    const match = line.replace(/\s*\|\s*/g, ' ').trim().match(row);
    if (!match) return [];
    const [, name, quantity, unit, price, printed] = match;
    const unitPrice = parseMoney(price) ?? (/^0(?:[.,]0{1,2})?$/.test(price) ? '0' : undefined);
    const linePrice = parseMoney(printed) ?? (/^0(?:[.,]0{1,2})?$/.test(printed) ? '0' : undefined);
    if (unitPrice === undefined || linePrice === undefined) return [];
    const item = invoiceItemSchema.safeParse({
      name, quantity: Number(quantity.replace(',', '.')), unit, unit_price: Math.round(Number(unitPrice) * 100),
    });
    if (!item.success || invoiceLineTotal(item.data) !== Math.round(Number(linePrice) * 100)) return [];
    items.push(item.data);
    if (items.length > maxInvoiceItems) return [];
  }
  return items;
}

export function readSaudiInvoiceQr(payload: string): InvoiceSuggestion {
  try {
    if (payload.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return {};
    const bytes = atob(payload);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const tags: string[] = [];
    let offset = 0;
    // The first five TLV fields precede any binary signature fields.
    for (let tag = 1; tag <= 5; tag++) {
      const length = bytes.charCodeAt(offset + 1);
      if (bytes.charCodeAt(offset) !== tag || !length || offset + 2 + length > bytes.length) return {};
      tags.push(decoder.decode(Uint8Array.from(bytes.slice(offset + 2, offset + 2 + length), char => char.charCodeAt(0))).trim());
      offset += 2 + length;
    }
    const [supplier, vatNumber, timestamp, gross, tax] = tags;
    const date = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(timestamp) && Number.isFinite(Date.parse(timestamp)) ? parseDate(timestamp.slice(0, 10)) : undefined;
    const total = /^\d+(?:\.\d{1,2})?$/.test(gross) ? parseMoney(gross) : undefined;
    if (!supplier || supplier.length > 120 || /[\u0000-\u001f]/.test(supplier) || !/^3\d{13}3$/.test(vatNumber) ||
      !date || !total || !/^\d+(?:\.\d{1,2})?$/.test(tax) || Number(tax) > Number(total)) return {};
    return { supplier, total, date, currency: 'SAR' };
  } catch {
    return {};
  }
}

export function extractScannedInvoiceTotal(printed: string, labels: string): string | undefined {
  const footer = normalizeInvoiceText(labels);
  const subtotalLabel = /(?:total taxable amount\s*\(?\s*excluding\s*vat|total\s*\(?\s*excluding\s*vat)/i.exec(footer);
  const vatLabel = /total\s+vat\s+amount/i.exec(footer);
  const grossLabel = /total\s+amount\s+due/i.exec(footer);
  if (!subtotalLabel || !vatLabel || !grossLabel || subtotalLabel.index >= vatLabel.index ||
    vatLabel.index >= grossLabel.index || /balance\s+due|amount\s+paid|payments?\s+received/i.test(footer)) return;

  const amounts = Array.from(normalizeInvoiceText(printed)
    .matchAll(/(?<![\d.,])\d+(?:[,\u00a0]\d{3})*\.\s*\d{2}(?![\d.,])/g),
  match => parseMoney(match[0])).filter((amount): amount is string => amount !== undefined);
  if (amounts.length < 3) return;
  const [subtotal, vat, gross] = amounts.slice(-3).map(Number);
  if (!(gross > subtotal && subtotal > vat)) return;
  const reconciles = Math.round((subtotal + vat) * 100) === Math.round(gross * 100);
  // Allow small differences caused by rounding VAT separately on each line.
  const vatMatches = Math.abs(vat - (gross - vat) * invoiceVatPercent / 100) <= 0.05 &&
    Math.abs(subtotal - (gross - vat)) / subtotal <= 0.005;
  if (reconciles || vatMatches) return gross.toFixed(2);
}
