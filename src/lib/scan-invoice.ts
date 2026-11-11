import { extractInvoiceFields, extractInvoiceItems, extractScannedInvoiceTotal, readSaudiInvoiceQr, type InvoiceSuggestion } from './invoice';
import { maxInvoiceItems, type InvoiceItem } from './purchases';
import { receiptExtension } from './receipt';
import { ocrWords, readScannedTable } from './scanned-table';

type InvoiceWorker = Awaited<ReturnType<typeof import('tesseract.js').createWorker>>;

function cropCanvas(image: HTMLCanvasElement, x: number, y: number, width: number, height: number, scale = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image processing is unavailable');
  context.drawImage(image, x, y, width, height, 0, 0, canvas.width, canvas.height);
  return { canvas, context };
}

function supplierBounds(tsv: string, supplier: string, pageHeight: number) {
  const words = tsv.split('\n').map(line => line.split('\t')).filter(row => row[0] === '5');
  const name = supplier.split(' ');
  const first = words.findIndex((word, index) => Number(word[7]) < pageHeight * 0.12 &&
    name.every((part, offset) => words[index + offset]?.[11] === part && words[index + offset][4] === word[4]));
  if (first < 0) return;
  const boxes = words.slice(first, first + name.length).map(word => word.slice(6, 10).map(Number));
  const left = Math.max(0, Math.min(...boxes.map(box => box[0])) - 5);
  const top = Math.max(0, Math.min(...boxes.map(box => box[1])) - 5);
  const right = Math.max(...boxes.map(box => box[0] + box[2])) + 8;
  const bottom = Math.max(...boxes.map(box => box[1] + box[3])) + 5;
  return { left, top, right, bottom };
}

async function startWorker(onProgress: (progress: number) => void) {
  const { createWorker } = await import('tesseract.js');
  return new Promise<InvoiceWorker>((resolve, reject) => {
    let failed = false;
    const timer = setTimeout(() => fail(new Error('The invoice reader did not start')), 45_000);
    function fail(error: unknown) {
      clearTimeout(timer);
      failed = true;
      reject(error);
    }
    void createWorker(['ara', 'eng'], 1, {
      workerPath: '/ocr-assets/worker.min.js',
      corePath: '/ocr-assets/core',
      langPath: '/ocr-assets/lang',
      workerBlobURL: false,
      logger: ({ status, progress }) => onProgress(status === 'recognizing text' ? 35 + Math.round(progress * 60) : 15),
      errorHandler: fail,
    }).then(async worker => {
      clearTimeout(timer);
      if (failed) await worker.terminate();
      else resolve(worker);
    }).catch(fail);
  });
}

export async function scanInvoice(file: File, onProgress: (progress: number) => void, includeItems = false) {
  const extension = receiptExtension(file);
  let worker: InvoiceWorker | undefined;
  let qr: InvoiceSuggestion = {};
  let scannedTotal: string | undefined;
  let scannedSupplier: string | null | undefined;
  const recognize = async (image: HTMLCanvasElement, firstPage: boolean, lastPage: boolean) => {
    if (!qr.total) {
      const { default: jsQR } = await import('jsqr');
      const pixels = image.getContext('2d')?.getImageData(0, 0, image.width, image.height);
      const code = pixels && jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' });
      if (code) qr = readSaudiInvoiceQr(code.data);
    }
    worker ??= await startWorker(onProgress);
    const { PSM } = await import('tesseract.js');
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
    const scale = Math.min(1, 1400 / Math.max(image.width, image.height));
    const overview = cropCanvas(image, 0, 0, image.width, image.height, scale).canvas;
    const overviewHeight = overview.height;
    let raw: string;
    let tsv: string | undefined;
    try {
      const { data } = await worker.recognize(overview, {}, { text: true, tsv: firstPage || includeItems });
      raw = data.text;
      tsv = data.tsv ?? undefined;
    }
    finally { overview.width = 0; overview.height = 0; }

    const fields = extractInvoiceFields(raw);
    const inferredSupplier = firstPage && !qr.supplier && fields.supplier && !extractInvoiceFields(raw, false).supplier;
    if (inferredSupplier && !includeItems) scannedSupplier = null;
    const bounds = inferredSupplier && tsv && fields.supplier && supplierBounds(tsv, fields.supplier, overviewHeight);
    if (bounds && fields.supplier) {
      const { left, top, right, bottom } = bounds;
      const { canvas } = cropCanvas(image, left / scale, top / scale, (right - left) / scale, (bottom - top) / scale);
      try {
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
        const { data } = await worker.recognize(canvas);
        const clearer = extractInvoiceFields(data.text).supplier;
        const sameLetterhead = clearer && clearer.split(' ').slice(1).join(' ') === fields.supplier.split(' ').slice(1).join(' ');
        if (includeItems ? sameLetterhead && data.confidence >= 80 : clearer === fields.supplier && data.confidence >= 85) {
          scannedSupplier = clearer;
        }
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
      }
    }
    if (lastPage && !qr.total && !fields.total && /(?:\bVAT\b|القيمة\s+المضافة)/i.test(raw) && image.height > 1400) {
      // Read the totals at higher resolution. Contrasting the colored labels
      // separately retains faint amounts that disappear under the same filter.
      const { canvas, context } = cropCanvas(image, image.width * 0.48, image.height * 0.86, image.width * 0.5, image.height * 0.13, 1.35);
      try {
        const printed = (await worker.recognize(canvas)).data.text;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        for (let offset = 0; offset < pixels.data.length; offset += 4) {
          const green = (pixels.data[offset + 1] - 226) * 2 + 255;
          pixels.data[offset] = pixels.data[offset + 1] = pixels.data[offset + 2] = green;
        }
        context.putImageData(pixels, 0, 0);
        const labels = (await worker.recognize(canvas)).data.text;
        scannedTotal = extractScannedInvoiceTotal(printed, labels) ?? extractScannedInvoiceTotal(raw, labels);
      } finally { canvas.width = 0; canvas.height = 0; }
    }
    let items = includeItems ? extractInvoiceItems(raw) : [];
    if (includeItems && tsv && !items.length) {
      const pixels = image.getContext('2d')?.getImageData(0, 0, image.width, image.height);
      const engine = worker;
      const words = ocrWords(tsv).map(word => ({ ...word, left: word.left / scale, top: word.top / scale,
        width: word.width / scale, height: word.height / scale }));
      if (pixels) {
        let latin = false;
        items = await readScannedTable(pixels, words, async (region, kind, latinColumns) => {
          if (latinColumns && !latin) {
            await engine.reinitialize('eng');
            await engine.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
            latin = true;
          }
          const alternate = kind === 'quantity-alt';
          const contrast = kind === 'quantity-contrast';
          const left = Math.max(0, region.left + (contrast ? -3 : kind === 'quantity' || alternate ? 0 : 2));
          const top = region.top + (alternate || contrast ? 7 : 0);
          const factor = kind === 'name' ? 1.1 : alternate ? 1.5 : contrast ? 2.6 : 2;
          const right = region.right - (contrast ? 8 : 6);
          const { canvas, context } = cropCanvas(image, left, top, right - left, region.bottom - top, factor);
          try {
            if (contrast) {
              const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
              for (let offset = 0; offset < pixels.data.length; offset += 4) {
                const red = (pixels.data[offset] - 240) * 3 + 255;
                pixels.data[offset] = pixels.data[offset + 1] = pixels.data[offset + 2] = red;
              }
              context.putImageData(pixels, 0, 0);
            }
            const numeric = kind !== 'name' && kind !== 'unit';
            const whitelist = numeric ? '0123456789.,٠١٢٣٤٥٦٧٨٩٫٬' :
              kind === 'unit' && latin ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' : '';
            await engine.setParameters({ tessedit_char_whitelist: whitelist });
            const { data } = await engine.recognize(canvas, {}, { text: true, tsv: true });
            return ocrWords(data.tsv ?? '').map(word => ({ ...word, top: top + word.top / factor, height: word.height / factor }));
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
        }).catch(() => []).finally(async () => {
          if (latin && !lastPage) await engine.reinitialize('ara+eng');
          await engine.setParameters({ tessedit_char_whitelist: '' });
        });
      }
    }
    return { text: raw, items };
  };

  const pageTexts: string[] = [];
  const pageItems: InvoiceItem[] = [];
  let pagesRead = 1;
  let pageCount = 1;
  try {
    if (extension === 'pdf') {
      const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
      GlobalWorkerOptions.workerSrc = '/ocr-assets/pdf.worker.min.mjs';
      const documentTask = getDocument({
        data: new Uint8Array(await file.arrayBuffer()),
        maxImageSize: 16_000_000,
      });
      try {
        const pdf = await documentTask.promise;
        pageCount = pdf.numPages;
        // Totals usually appear on the last page. Read it along with the header and the next page.
        const indices = [...new Set([1, Math.min(2, pageCount), pageCount])];
        pagesRead = indices.length;
        for (const index of indices) {
          const page = await pdf.getPage(index);
          try {
            const content = await page.getTextContent();
            let lines = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
            const fields = extractInvoiceFields(lines);
            let items = includeItems ? extractInvoiceItems(lines) : [];
            if (lines.length < 40 && !Object.values(fields).some(Boolean)) {
              const original = page.getViewport({ scale: 1 });
              const viewport = page.getViewport({ scale: Math.min(3, 2550 / Math.max(original.width, original.height)) });
              const canvas = document.createElement('canvas');
              canvas.width = Math.ceil(viewport.width);
              canvas.height = Math.ceil(viewport.height);
              try {
                await page.render({ canvas, viewport }).promise;
                const scanned = await recognize(canvas, index === 1, index === pageCount);
                lines = scanned.text;
                items = scanned.items;
              } finally { canvas.width = 0; canvas.height = 0; }
            }
            pageTexts.push(lines);
            pageItems.push(...items);
          } finally { page.cleanup(); }
        }
      } finally { await documentTask.destroy(); }
    } else {
      const url = URL.createObjectURL(file);
      const image = new Image();
      try {
        image.src = url;
        await image.decode();
        const scale = Math.min(1, 2200 / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Image processing is unavailable');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        try {
          const scanned = await recognize(canvas, true, true);
          pageTexts.push(scanned.text);
          pageItems.push(...scanned.items);
        }
        finally { canvas.width = 0; canvas.height = 0; }
      } finally { URL.revokeObjectURL(url); }
    }
    const readable = pageTexts.join('\n').trim();
    const fields = { ...extractInvoiceFields(readable), ...qr };
    if (!qr.supplier && scannedSupplier !== undefined) fields.supplier = scannedSupplier ?? undefined;
    fields.total ??= scannedTotal;
    const items = pageItems.slice(0, maxInvoiceItems);
    onProgress(100);
    return {
      fields,
      items,
      text: readable.slice(0, 8000), pagesRead, pageCount,
    };
  } finally { await worker?.terminate(); }
}
