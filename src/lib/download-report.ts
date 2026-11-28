import type { DetailReport, ExportTable } from './detail-reports';

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Leave time for Safari to begin reading the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function reportWorkbook(report: DetailReport) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ALSINDBAD';
  workbook.created = new Date();
  for (const table of [report.summary, ...report.tables]) {
    const count = table.columns.length;
    const sheet = workbook.addWorksheet(table.title.slice(0, 31), {
      views: [{ rightToLeft: report.lang === 'ar', state: 'frozen', ySplit: 5 }],
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:5',
        margins: { left: .3, right: .3, top: .45, bottom: .45, header: .2, footer: .2 } },
    });
    sheet.columns = table.columns.map(column => ({ width: column.width }));
    sheet.mergeCells(1, 1, 1, count);
    sheet.getCell(1, 1).value = 'ALSINDBAD  |  ' + report.title;
    sheet.getRow(1).height = 38;
    sheet.mergeCells(2, 1, 2, count);
    sheet.getCell(2, 1).value = report.subtitle;
    sheet.getRow(2).height = 30;
    sheet.mergeCells(3, 1, 3, count);
    sheet.getCell(3, 1).value = '1 GBP = 5 SAR';
    sheet.getRow(3).height = 26;
    sheet.mergeCells(4, 1, 4, count);
    sheet.getCell(4, 1).value = table.title;
    sheet.getRow(4).height = 30;
    const header = sheet.addRow(table.columns.map(column => column.title));
    header.height = 34;
    header.eachCell((cell, column) => {
      cell.font = { name: 'Arial', bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF303436' } };
      const direction = table.columns[column - 1]?.direction;
      cell.alignment = { vertical: 'middle', horizontal: direction === 'ltr' ? 'left' : report.lang === 'ar' ? 'right' : 'left', readingOrder: direction, wrapText: true };
    });
    for (const [index, values] of table.rows.entries()) {
      const row = sheet.addRow(values);
      const lines = Math.max(...values.map((value, column) => typeof value === 'string' ? value.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / (table.columns[column].width * .8))), 0) : 1));
      row.height = Math.max(31, lines * 16 + 10);
      row.eachCell({ includeEmpty: true }, (cell, column) => {
        cell.font = { name: 'Arial', size: 11, color: { argb: 'FF303436' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index % 2 ? 'FFF4F2ED' : 'FFFFFFFF' } };
        const direction = table.columns[column - 1]?.direction;
        cell.alignment = { vertical: 'middle', horizontal: typeof cell.value === 'number' ? 'right' : direction === 'ltr' ? 'left' : report.lang === 'ar' ? 'right' : 'left', readingOrder: direction, wrapText: true };
        const format = table.columns[column - 1]?.format;
        if (format) cell.numFmt = format === 'quantity' ? '#,##0.###;[Red](#,##0.###);"—"' : '#,##0.00;[Red](#,##0.00);"—"';
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFE3E0D9' } } };
      });
    }
    if (!table.rows.length) {
      sheet.mergeCells(6, 1, 6, count);
      sheet.getCell(6, 1).value = report.lang === 'ar' ? 'لا توجد سجلات' : 'No records';
      sheet.getRow(6).height = 32;
    } else sheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: table.rows.length + 5, column: count } };
    for (const index of [1, 2, 3, 4]) {
      const cell = sheet.getCell(index, 1);
      cell.font = { name: 'Arial', size: index === 1 ? 18 : index === 4 ? 13 : 11, bold: index === 1 || index === 4, color: { argb: index === 3 ? 'FF6D6A63' : 'FF303436' } };
      cell.alignment = { vertical: 'middle', horizontal: report.lang === 'ar' ? 'right' : 'left', wrapText: true };
    }
    sheet.headerFooter.oddFooter = '&LALSINDBAD&C&P / &N&R&D';
  }
  return workbook;
}

export async function downloadReportExcel(report: DetailReport) {
  const workbook = await reportWorkbook(report);
  const bytes = await workbook.xlsx.writeBuffer();
  downloadBlob(new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), report.filename + '.xlsx');
}

let fonts: Promise<string[]> | undefined;
function loadFonts() {
  return fonts ??= Promise.all(['Regular', 'Bold'].map(async weight => {
    const response = await fetch(`/export-assets/Amiri-${weight}.ttf`);
    if (!response.ok) throw new Error('تعذر تحميل خط التصدير / Export font could not be loaded');
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  })).catch(problem => { fonts = undefined; throw problem; });
}

export async function reportPdf(report: DetailReport) {
  const [{ jsPDF }, { autoTable }, fontData] = await Promise.all([import('jspdf'), import('jspdf-autotable'), loadFonts()]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', putOnlyUsedFonts: true });
  fontData.forEach((font, index) => {
    const name = index ? 'Amiri-Bold.ttf' : 'Amiri-Regular.ttf';
    doc.addFileToVFS(name, font);
    doc.addFont(name, 'Amiri', index ? 'bold' : 'normal');
  });
  doc.setFont('Amiri', 'normal');
  doc.setProperties({ title: report.title, author: 'ALSINDBAD', subject: report.subtitle });
  const rtl = report.lang === 'ar';
  let y = 40;
  function table(data: ExportTable) {
    if (y > 157) { doc.addPage(); y = 40; }
    doc.setFont('Amiri', 'bold').setFontSize(13).setTextColor('#303436');
    doc.text(data.title, rtl ? 283 : 14, y, { align: rtl ? 'right' : 'left' });
    const columns = rtl ? [...data.columns].reverse() : data.columns;
    const formatted = data.rows.map(row => row.map((value, index) => typeof value === 'number' ? new Intl.NumberFormat('en-GB', {
      minimumFractionDigits: data.columns[index].format === 'money' ? 2 : 0,
      maximumFractionDigits: data.columns[index].format === 'quantity' ? 3 : 2,
    }).format(value) : value));
    const rows = formatted.map(row => rtl ? [...row].reverse() : row);
    autoTable(doc, {
      startY: y + 4, margin: { top: 39, bottom: 18, left: 14, right: 14 }, theme: 'plain',
      head: [columns.map(column => column.title)], body: rows.length ? rows : [columns.map((_, i) => i === 0 ? rtl ? 'لا توجد سجلات' : 'No records' : '')],
      styles: { font: 'Amiri', fontSize: 10, cellPadding: 2.5, valign: 'middle', halign: rtl ? 'right' : 'left', overflow: 'linebreak', lineColor: '#E3E0D9', lineWidth: { bottom: .15 } },
      headStyles: { font: 'Amiri', fontStyle: 'bold', fillColor: '#303436', textColor: '#FFFFFF', fontSize: 10 },
      alternateRowStyles: { fillColor: '#F4F2ED' },
      columnStyles: Object.fromEntries(columns.map((column, index) => [index, { cellWidth: 269 * column.width / columns.reduce((sum, col) => sum + col.width, 0), halign: column.format ? 'right' : column.direction === 'ltr' ? 'left' : rtl ? 'right' : 'left' }])),
      rowPageBreak: 'avoid',
      didParseCell: ({ cell }) => {
        // AutoTable defaults to an LTR paragraph. Use logical RTL input for
        // Arabic cells while preserving Latin references and number order.
        cell.styles.textOptions = { isInputVisual: false, isOutputVisual: true,
          isInputRtl: /[\u0600-\u06ff]/.test(cell.text.join(' ')), isOutputRtl: false, isSymmetricSwapping: true };
      },
    });
    y = (doc as typeof doc & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 13;
  }
  table(report.summary);
  for (const data of report.tables) table(data);
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    doc.setFillColor('#F4F2ED').rect(0, 0, 297, 32, 'F');
    doc.setFont('Amiri', 'bold').setFontSize(18).setTextColor('#303436');
    doc.text(report.title, rtl ? 283 : 14, 14, { align: rtl ? 'right' : 'left' });
    doc.setFont('Amiri', 'normal').setFontSize(10);
    doc.text(report.subtitle, rtl ? 283 : 14, 24, { align: rtl ? 'right' : 'left' });
    doc.setDrawColor('#DDD8CD').line(14, 194, 283, 194);
    doc.setFontSize(9).setTextColor('#6D6A63');
    doc.text('ALSINDBAD · 1 GBP = 5 SAR', 14, 201);
    doc.text(`${page} / ${pages}`, 283, 201, { align: 'right' });
  }
  return doc;
}

export async function downloadReportPdf(report: DetailReport) {
  const doc = await reportPdf(report);
  downloadBlob(doc.output('blob'), report.filename + '.pdf');
}
