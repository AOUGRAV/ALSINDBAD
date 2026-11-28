import type { Cell, Worksheet } from 'exceljs';
import { downloadBlob } from './download-report';
import { calculatePricing, pricingRate, toPounds, type PricingSheet } from './pricing';

const pounds = '"£"#,##0.00;[Red]-"£"#,##0.00;"£"0.00';
const riyals = '"SAR "#,##0.00;[Red]-"SAR "#,##0.00;"SAR "0.00';
const number = '#,##0.###';
const ink = 'FF303638';
const methods = ['Quantity', 'Purchase value'];
const pricingHeader = 14;
const expenseHeader = 5;
const reservedRows = 25;
const englishUnit: Record<string, string> = {'كرتون': 'Carton', 'درزن': 'Dozen', 'بالة': 'Bale', 'حبة': 'Piece', 'قطعة': 'Piece', 'علبة': 'Box', 'طبلية': 'Pallet', 'كيس': 'Bag', 'كيلو': 'kg'};

function paint(cell: Cell, color: string) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: {argb: color} };
}
function title(sheet: Worksheet, row: number, last: string, text: string, headline = false) {
  sheet.mergeCells(`A${row}:${last}${row}`);
  const cell = sheet.getCell(`A${row}`);
  cell.value = text;
  cell.font = {name: 'Arial', size: headline ? 18 : 11, bold: headline, color: {argb: ink}};
  cell.alignment = {vertical: 'middle', wrapText: true};
  sheet.getRow(row).height = headline ? 33 : 30;
}
function headings(sheet: Worksheet, row: number, labels: string[]) {
  sheet.getRow(row).values = labels;
  sheet.getRow(row).height = 33;
  sheet.getRow(row).eachCell(cell => {
    paint(cell, ink);
    cell.font = {name: 'Arial', bold: true, size: 10, color: {argb: 'FFFFFFFF'}};
    cell.alignment = {vertical: 'middle', wrapText: true};
  });
}
function bodyRow(sheet: Worksheet, row: number, columns: number, inputs: number[]) {
  sheet.getRow(row).height = 30;
  for (let index = 1; index <= columns; index++) {
    const cell = sheet.getCell(row, index);
    const editable = inputs.includes(index);
    paint(cell, editable ? 'FFFFF5DB' : row % 2 ? 'FFFAF8F4' : 'FFFFFFFF');
    cell.font = {name: 'Arial', size: 10, color: {argb: editable ? 'FF194777' : ink}};
    cell.alignment = {vertical: 'middle', wrapText: true};
    cell.border = {bottom: {style: 'hair', color: {argb: 'FFE6E0D5'}}};
  }
}
function list(cell: Cell, options: string[]) {
  cell.dataValidation = {type: 'list', allowBlank: true, formulae: [`"${options.join(',')}"`], showErrorMessage: true, error: 'Choose a value from the list.'};
}
function numeric(cell: Cell, min: number, whole = false) {
  cell.dataValidation = {type: whole ? 'whole' : 'decimal', operator: 'between', allowBlank: true,
    formulae: [min, whole ? 100_000 : 1_000_000_000_000], showErrorMessage: true, error: 'Enter a valid non-negative number.'};
}
function computed(cell: Cell, formula: string, result: number | string | null, format?: string) {
  cell.value = {formula, result: result ?? ''};
  if (format) cell.numFmt = format;
}

export async function pricingWorkbook(record: PricingSheet) {
  const {default: ExcelJS} = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ALSINDBAD';
  workbook.calcProperties.fullCalcOnLoad = true;
  const {document} = record;
  const totals = calculatePricing(document);
  const firstProduct = pricingHeader + 1, lastProduct = pricingHeader + document.items.length + reservedRows;
  const firstExpense = expenseHeader + 1, lastExpense = expenseHeader + document.expenses.length + reservedRows;
  const productRange = (letter: string) => `${letter}${firstProduct}:${letter}${lastProduct}`;
  const expenseRange = (letter: string) => `Expenses!${letter}${firstExpense}:${letter}${lastExpense}`;
  const pricing = workbook.addWorksheet('Pricing', {views: [{state: 'frozen', xSplit: 1, ySplit: pricingHeader, topLeftCell: `B${firstProduct}`, showGridLines: false}]});
  const expenses = workbook.addWorksheet('Expenses', {views: [{state: 'frozen', ySplit: expenseHeader, showGridLines: false}]});
  for (const sheet of [pricing, expenses]) {
    sheet.pageSetup = {paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0};
    sheet.headerFooter.oddFooter = '&LALSINDBAD&C&P / &N';
  }
  pricing.columns = [42, 36, 17, 12, 23, 18, 15, 16, 16, 16, 15, 16, 16, 13, 17, 19].map(width => ({width}));
  expenses.columns = [44, 16, 15, 17, 20, 19, 14].map(width => ({width}));
  title(pricing, 1, 'H', 'ALSINDBAD  |  Pricing & profit', true);
  title(pricing, 2, 'H', record.name);
  title(pricing, 3, 'H', 'Edit the shaded cells. Use the Expenses sheet for freight, customs and UK costs.');
  title(pricing, 12, 'H', 'Expected results assume all priced units sell. Use purchase cost net of any recoverable tax and sale prices excluding VAT.');
  title(pricing, 13, 'H', `Add products in the ${reservedRows} prepared rows below. Clear both product names to exclude a line.`);
  const summary: Array<{label: string; formula: string; value: number | null}> = [
    {label: 'Goods cost', formula: `SUM(${productRange('H')})`, value: totals.goods},
    {label: 'Expenses', formula: `SUM(${expenseRange('E')})`, value: totals.expenses},
    {label: 'Total landed cost', formula: 'B5+B6', value: totals.cost},
    {label: 'Expected sales (priced items)', formula: `IF(COUNT(${productRange('L')})=0,"",SUM(${productRange('L')}))`, value: totals.priced ? totals.revenue : null},
    {label: 'Expected profit (priced items)', formula: `IF(OR(B8="",F8>0),"",SUM(${productRange('M')}))`, value: totals.priced && !totals.unallocated ? totals.profit : null},
  ];
  pricing.getCell('A4').value = 'Summary'; pricing.getCell('B4').value = 'GBP'; pricing.getCell('C4').value = 'SAR equivalent';
  for (const [i, row] of summary.entries()) {
    const index = i + 5;
    pricing.getCell(`A${index}`).value = row.label;
    computed(pricing.getCell(`B${index}`), row.formula, row.value, pounds);
    computed(pricing.getCell(`C${index}`), `IF(B${index}="","",B${index}*$F$6)`, row.value === null ? null : row.value * pricingRate, riyals);
  }
  pricing.getCell('A10').value = 'Margin on priced sales';
  computed(pricing.getCell('B10'), 'IF(OR(B9="",B8=0),"",B9/B8)', totals.unallocated ? null : totals.margin, '0.0%');
  pricing.getCell('A11').value = 'Products without prices';
  computed(pricing.getCell('B11'), `COUNTIF(${productRange('P')},"Enter price")`, document.items.length - totals.priced);
  pricing.getCell('E5').value = 'Allocation method';
  pricing.getCell('F5').value = document.allocation === 'value' ? methods[1] : methods[0];
  list(pricing.getCell('F5'), methods);
  paint(pricing.getCell('F5'), 'FFFFF5DB');
  pricing.getCell('F5').alignment = {wrapText: true, vertical: 'middle'};
  pricing.getCell('E6').value = 'SAR per GBP'; pricing.getCell('F6').value = pricingRate;
  pricing.getCell('E7').value = 'Valid purchase quantity';
  computed(pricing.getCell('F7'), `SUMPRODUCT(ISNUMBER(${productRange('H')})*IFERROR(1*${productRange('D')},0))`, document.items.reduce((sum, item) => sum + item.quantity, 0), number);
  pricing.getCell('E8').value = 'Unallocated expenses';
  computed(pricing.getCell('F8'), 'IF(IF(F5="Purchase value",B5,F7)>0,0,B6)', totals.unallocated, pounds);
  pricing.getCell('E9').value = 'Invalid product rows';
  computed(pricing.getCell('F9'), `COUNTIF(${productRange('P')},"Check inputs")`, 0);
  pricing.getCell('E10').value = 'Invalid expense rows';
  computed(pricing.getCell('F10'), `COUNTIF(${expenseRange('G')},"Check inputs")`, 0);
  for (const address of ['A4','B4','C4','A7','B7','C7','A9','B9','C9']) pricing.getCell(address).font = {name: 'Arial', bold: true, color: {argb: ink}};
  for (let row = 5; row <= 10; row++) {
    pricing.getCell(`E${row}`).alignment = {wrapText: true, vertical: 'middle'};
    pricing.getRow(row).height = 24;
  }

  headings(pricing, pricingHeader, ['Product (English)', 'المنتج (العربي)', 'Purchase unit', 'Quantity', 'Purchase / unit (£)', 'Sale units / purchase unit', 'Sale / unit (£)', 'Goods cost (£)', 'Allocated expenses (£)', 'Landed / sale unit (£)', 'Profit / sale unit (£)', 'Expected sales (£)', 'Expected profit (£)', 'Margin', 'Landed / sale unit (SAR)', 'Status']);
  pricing.autoFilter = `A${pricingHeader}:P${lastProduct}`;
  for (let r = firstProduct; r <= lastProduct; r++) {
    const i = r - firstProduct;
    const item = document.items[i], result = totals.rows[i];
    if (item) {
      const unit = Object.hasOwn(englishUnit, item.unit) ? englishUnit[item.unit] : item.unit;
      pricing.getRow(r).values = [item.english, item.name, unit, item.quantity, item.purchase, item.pack, item.sale];
    }
    bodyRow(pricing, r, 16, [1,2,3,4,5,6,7]);
    if (item) {
      pricing.getRow(r).height = Math.max(30, Math.ceil(Math.max(item.english.length / 34, item.name.length / 31)) * 13 + 7);
    }
    const cell = (letter: string) => pricing.getCell(`${letter}${r}`);
    cell('B').alignment = {readingOrder: 'rtl', horizontal: 'right', vertical: 'middle', wrapText: true};
    cell('D').numFmt = number; cell('E').numFmt = pounds; cell('G').numFmt = pounds;
    numeric(cell('D'), 0.001); numeric(cell('E'), 0); numeric(cell('F'), 1, true); numeric(cell('G'), 0);
    const named = `OR(A${r}<>"",B${r}<>"")`;
    const pack = `IF(F${r}="",1,F${r})`;
    const valid = `AND(${named},ISNUMBER(D${r}),D${r}>0,ISNUMBER(E${r}),E${r}>=0,OR(F${r}="",AND(ISNUMBER(F${r}),N(F${r})>=1,MOD(N(F${r}),1)=0)))`;
    const canPrice = `AND(ISNUMBER(J${r}),ISNUMBER(G${r}),G${r}>=0)`;
    computed(cell('H'), `IF(${valid},D${r}*E${r},"")`, item ? item.quantity * item.purchase : null, pounds);
    computed(cell('I'), `IF(H${r}="","",IF($F$5="Purchase value",IF($B$5>0,$B$6*H${r}/$B$5,0),IF($F$7>0,$B$6*D${r}/$F$7,0)))`, result?.share ?? null, pounds);
    computed(cell('J'), `IF(H${r}="","",(E${r}+I${r}/D${r})/${pack})`, result?.landed ?? null, pounds);
    computed(cell('K'), `IF(AND(${canPrice},$F$8=0),G${r}-J${r},"")`, totals.unallocated ? null : result?.profit ?? null, pounds);
    computed(cell('L'), `IF(${canPrice},G${r}*D${r}*${pack},"")`, result?.revenue ?? null, pounds);
    computed(cell('M'), `IF(K${r}="","",K${r}*D${r}*${pack})`, totals.unallocated ? null : result?.totalProfit ?? null, pounds);
    computed(cell('N'), `IF(OR(K${r}="",G${r}=0),"",K${r}/G${r})`, totals.unallocated ? null : result?.margin ?? null, '0.0%');
    computed(cell('O'), `IF(J${r}="","",J${r}*$F$6)`, result ? result.landed * pricingRate : null, riyals);
    const status = !item ? '' : item.sale === null ? 'Enter price' : totals.unallocated ? 'Review expenses' :
      Math.abs(result.profit ?? 0) < .005 ? 'Break-even' : (result.profit ?? 0) < 0 ? 'Loss' : 'Profit';
    computed(cell('P'), `IF(NOT(${named}),"",IF(OR(J${r}="",AND(G${r}<>"",NOT(${canPrice}))),"Check inputs",IF(G${r}="","Enter price",IF($F$8>0,"Review expenses",IF(ROUND(K${r},2)=0,"Break-even",IF(K${r}<0,"Loss","Profit"))))))`, status);
  }

  title(expenses, 1, 'G', 'ALSINDBAD  |  Container expenses', true);
  title(expenses, 2, 'G', 'Enter each expense once in its original currency. GBP and SAR totals update automatically.');
  expenses.getCell('A3').value = 'Total expenses';
  computed(expenses.getCell('E3'), `SUM(E${firstExpense}:E${lastExpense})`, totals.expenses, pounds);
  computed(expenses.getCell('F3'), 'E3*Pricing!$F$6', totals.expenses * pricingRate, riyals);
  expenses.getCell('A3').font = {name: 'Arial', bold: true, color: {argb: ink}};
  headings(expenses, expenseHeader, ['Expense', 'Stage', 'Currency', 'Amount', 'Equivalent (£)', 'Equivalent (SAR)', 'Status']);
  expenses.autoFilter = `A${expenseHeader}:G${lastExpense}`;
  for (let r = firstExpense; r <= lastExpense; r++) {
    const expense = document.expenses[r - firstExpense];
    if (expense) expenses.getRow(r).values = [expense.label, expense.stage, expense.currency, expense.amount];
    else expenses.getCell(`C${r}`).value = 'GBP';
    bodyRow(expenses, r, 7, [1,2,3,4]);
    if (expense) {
      expenses.getRow(r).height = Math.max(30, Math.ceil(expense.label.length / 37) * 13 + 7);
      if (/\p{Script=Arabic}/u.test(expense.label)) expenses.getCell(`A${r}`).alignment = {readingOrder: 'rtl', horizontal: 'right', vertical: 'middle', wrapText: true};
    }
    list(expenses.getCell(`B${r}`), ['UK', 'Shipping', 'Jeddah']);
    list(expenses.getCell(`C${r}`), ['GBP', 'SAR']);
    numeric(expenses.getCell(`D${r}`), 0);
    expenses.getCell(`D${r}`).numFmt = '#,##0.00';
    const gbp = expense ? toPounds(expense.amount, expense.currency) : null;
    computed(expenses.getCell(`E${r}`), `IF(AND(A${r}<>"",ISNUMBER(D${r}),D${r}>=0,OR(C${r}="GBP",C${r}="SAR")),IF(C${r}="SAR",D${r}/Pricing!$F$6,D${r}),"")`, gbp, pounds);
    computed(expenses.getCell(`F${r}`), `IF(E${r}="","",E${r}*Pricing!$F$6)`, gbp === null ? null : gbp * pricingRate, riyals);
    computed(expenses.getCell(`G${r}`), `IF(AND(A${r}="",D${r}=""),"",IF(ISNUMBER(E${r}),"","Check inputs"))`, '');
  }
  return workbook;
}

export async function downloadPricingExcel(record: PricingSheet) {
  const workbook = await pricingWorkbook(record);
  const bytes = await workbook.xlsx.writeBuffer();
  const name = record.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 100);
  downloadBlob(new Blob([new Uint8Array(bytes)], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}), `ALSINDBAD-Pricing-${name}.xlsx`);
}
