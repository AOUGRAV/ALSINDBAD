import { normalizeInvoiceText } from './invoice';
import { invoiceLineTotal, invoiceVatPercent, maxInvoiceItems, type InvoiceItem } from './purchases';

export type OcrWord = { text: string; line: string; left: number; top: number; width: number; height: number };
export type OcrRegion = { left: number; top: number; right: number; bottom: number };
type Column = 'name' | 'quantity' | 'quantity-alt' | 'quantity-contrast' | 'unit' | 'price' | 'net' | 'vat' | 'gross';
type ReadColumn = (region: OcrRegion, kind: Column, latin: boolean) => Promise<OcrWord[]>;

export function ocrWords(tsv: string) {
  return tsv.split('\n').flatMap(line => {
    const [level, page, block, paragraph, row, , x, y, w, h, , text] = line.split('\t');
    if (level !== '5' || !text) return [];
    return [{ text: normalizeInvoiceText(text).trim(), line: [page, block, paragraph, row].join('/'),
      left: Number(x), top: Number(y), width: Number(w), height: Number(h) }];
  });
}

const middleX = (word: OcrWord) => word.left + word.width / 2;
const middleY = (word: OcrWord) => word.top + word.height / 2;

function verticalRules({ data, width }: ImageData, top: number, bottom: number) {
  const rules: number[] = [];
  for (let x = 0; x < width; x += 1) {
    let marked = 0;
    for (let y = top; y < bottom; y += 2) {
      const index = (y * width + x) * 4;
      if (data[index] - Math.min(data[index + 1], data[index + 2]) > 26) marked++;
    }
    if (marked * 2 < (bottom - top) * 0.45) continue;
    if (rules.length && x - rules[rules.length - 1] <= Math.ceil(width * 0.003)) rules[rules.length - 1] = x;
    else rules.push(x);
  }
  return rules;
}

function findColumns(pixels: ImageData, words: OcrWord[]) {
  const description = words.find(word => /^(?:description|الوصف|البيان|الصنف)$/i.test(word.text));
  if (!description) return;
  const near = words.filter(word => Math.abs(middleY(word) - middleY(description)) < description.height * 2);
  const qty = near.find(word => /^(?:qty\.?|quantity|الكمية)$/i.test(word.text));
  const total = near.find(word => /^total$/i.test(word.text) && middleX(word) > middleX(description));
  if ((!qty && !near.some(word => /^packing$/i.test(word.text))) || !total ||
    !near.some(word => /^price$/i.test(word.text) && word.left > total.left &&
    word.left - total.left < pixels.width * 0.05)) return;
  const width = pixels.width;
  const top = Math.round(Math.max(description.top + description.height, qty ? qty.top + qty.height : 0) +
    description.height * (qty ? 0.4 : 0.85));
  const rules = verticalRules(pixels, top + Math.round(description.height), Math.min(pixels.height, top + Math.round(pixels.height * 0.19)));
  const leftOf = (x: number) => rules.findLast(rule => rule < x);
  const rightOf = (x: number) => rules.find(rule => rule > x);
  const nameStart = leftOf(middleX(description));
  const nameEnd = rightOf(middleX(description));
  const qtyEnd = qty ? rightOf(middleX(qty)) : nameEnd === undefined ? undefined : rightOf(nameEnd + width * 0.015);
  const netStart = leftOf(middleX(total));
  const netEnd = rightOf(middleX(total));
  if (nameStart === undefined || nameEnd === undefined || qtyEnd === undefined || netStart === undefined ||
    netEnd === undefined || !(nameStart < nameEnd && nameEnd < qtyEnd && qtyEnd < netStart)) return;
  const size = qtyEnd - nameEnd;
  if (size < width * 0.025 || size > width * 0.12 || netStart - qtyEnd < size * 1.6) return;
  const unitEnd = rules.find(rule => rule > qtyEnd + size * 0.6) ?? qtyEnd + size;
  const unitPriceEnd = unitEnd <= qtyEnd + size * 1.45
    ? rules.find(rule => rule > unitEnd + size * 0.55)
    : unitEnd;
  if (unitPriceEnd === undefined || unitPriceEnd > netStart || unitPriceEnd < qtyEnd + size * 1.5) return;
  const unitBoundary = unitEnd === unitPriceEnd ? Math.round((qtyEnd + unitPriceEnd) / 2) : unitEnd;
  // Use aligned words to limit the scan to the occupied part of the table.
  const lineCenters = words.filter(word => word.top >= top && word.top < top + pixels.height * 0.48 &&
    ((middleX(word) > nameEnd && middleX(word) < qtyEnd) || middleX(word) > netStart) &&
    /\d{2,}/.test(word.text)).map(middleY).sort((a, b) => a - b);
  let end = lineCenters[0];
  if (end === undefined || end - top > description.height * 6) return;
  for (const y of lineCenters.slice(1)) {
    if (y - end > description.height * 7) break;
    end = y;
  }
  const bottom = Math.min(pixels.height, Math.round(end + description.height * 3.5));
  const region = (left: number, right: number): OcrRegion => ({ left, right, top, bottom });
  const vatWord = near.find(word => /^(?:vat(?:amt)?\.?|الضريبة|ضريبة)$/i.test(word.text) && middleX(word) > netEnd);
  const grossWord = near.find(word => /^(?:amount|الإجمالي)$/i.test(word.text) && middleX(word) > netEnd);
  const afterNet = (word: OcrWord | undefined) => {
    const left = word && leftOf(middleX(word));
    const right = word && rightOf(middleX(word));
    return left !== undefined && right !== undefined ? region(left, right) : undefined;
  };
  return {
    name: region(nameStart, nameEnd), quantity: region(nameEnd, qtyEnd), unit: region(qtyEnd, unitBoundary),
    price: region(unitBoundary, unitPriceEnd), net: region(netStart, netEnd), vat: afterNet(vatWord), gross: afterNet(grossWord),
    rowHeight: description.height, latin: /^description$/i.test(description.text),
  };
}

function numberOptions(text: string, decimal: boolean) {
  const compact = text.replace(/,(?=\d{3}\b)/g, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,3})?$/.test(compact)) return [];
  const value = Number(compact);
  if (!Number.isFinite(value) || value > 1_000_000_000) return [];
  return decimal && !compact.includes('.') && compact.length >= 4 ? [value / 100, value] : [value];
}

export async function readScannedTable(pixels: ImageData, words: OcrWord[], read: ReadColumn): Promise<InvoiceItem[]> {
  const columns = findColumns(pixels, words);
  if (!columns) return [];
  const readColumn = (region: OcrRegion, kind: Column) => read(region, kind, columns.latin);
  const units = (await readColumn(columns.unit, 'unit')).filter(word => /^[\p{L}][\p{L}.\/-]{0,29}$/u.test(word.text))
    .sort((a, b) => middleY(a) - middleY(b));
  if (!units.length || units.length > maxInvoiceItems) return [];
  const descriptions = await readColumn(columns.name, 'name');
  const quantities = await readColumn(columns.quantity, 'quantity');
  const otherQuantities = await readColumn(columns.quantity, 'quantity-alt');
  const contrastedQuantities = await readColumn(columns.quantity, 'quantity-contrast');
  const nets = await readColumn(columns.net, 'net');
  const prices = await readColumn(columns.price, 'price');
  const tax = columns.vat ? await readColumn(columns.vat, 'vat') : [];
  const gross = columns.gross ? await readColumn(columns.gross, 'gross') : [];
  const tolerance = columns.rowHeight * 1.65;
  const values = (column: OcrWord[], row: OcrWord) => {
    const nearest = column.filter(word => Math.abs(middleY(word) - middleY(row)) < tolerance)
      .sort((a, b) => Math.abs(middleY(a) - middleY(row)) - Math.abs(middleY(b) - middleY(row)))[0];
    return nearest ? numberOptions(nearest.text, column.some(word => /[.,]\d{2}$/.test(word.text))) : [];
  };
  const commonQuantities = units.map(row => values(quantities, row)[0]);
  return units.flatMap((row, index) => {
    const previous = units[index - 1];
    const start = previous ? middleY(previous) + (middleY(row) - middleY(previous)) * 0.33 : columns.name.top;
    const words = descriptions.filter(word => middleY(word) >= start && middleY(word) < middleY(row) + columns.rowHeight * 0.4);
    const byLine = new Map<string, OcrWord[]>();
    for (const word of words) {
      const line = byLine.get(word.line) ?? [];
      line.push(word);
      byLine.set(word.line, line);
    }
    const name = [...byLine.values()].map(line => line.map(word => word.text).join(' ').replace(/^[|=[\s]+/, '').trim())
      .sort((a, b) => (b.match(/\p{L}/gu)?.length ?? 0) - (a.match(/\p{L}/gu)?.length ?? 0))[0];
    if (!name || !/\p{L}/u.test(name) || name.length > 140) return [];
    const primary = values(quantities, row);
    const alternative = [...values(otherQuantities, row), ...values(contrastedQuantities, row)];
    const qty = [...new Set([...primary, ...alternative])].filter(value => value > 0 && value <= 100_000_000);
    const linePrice = values(nets, row).map(value => Math.round(value * 100));
    const unitPrice = values(prices, row).map(value => Math.round(value * 100));
    const vat = values(tax, row);
    const inclusive = values(gross, row);
    const taxChecked = inclusive.flatMap(total => vat.filter(value => value <= total && value >= total * 0.01 &&
      (Math.abs(value - (total - value) * invoiceVatPercent / 100) <= 0.011 || linePrice.includes(Math.round((total - value) * 100))))
      .map(value => Math.round((total - value) * 100)));
    const verified = [...taxChecked, ...linePrice].find(amount => qty.some(quantity =>
      unitPrice.some(price => invoiceLineTotal({ quantity, unit_price: price }) === amount)));
    if (!qty.length || (!unitPrice.length && !linePrice.length && !taxChecked.length)) return [];
    const corroboratedQty = qty.find(value => verified !== undefined && unitPrice.some(price =>
      invoiceLineTotal({ quantity: value, unit_price: price }) === verified));
    const repeatedQty = alternative.find(value => commonQuantities.some((candidate, rowIndex) => rowIndex !== index && candidate === value));
    const repeatedPrimary = commonQuantities.some((candidate, rowIndex) => rowIndex !== index && candidate === primary[0]);
    const quantity = corroboratedQty ?? (repeatedPrimary ? primary[0] : repeatedQty) ?? qty[0];
    const cents = verified ?? taxChecked[0] ?? linePrice[0];
    const price = cents === undefined ? unitPrice[0] : Math.round(cents / quantity);
    if (invoiceLineTotal({ quantity, unit_price: price }) === null) return [];
    return [{ name, quantity, unit: row.text, unit_price: price }];
  });
}
