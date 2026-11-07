import { extractInvoiceFields } from './invoice';
import { receiptExtension } from './receipt';

type InvoiceWorker = Awaited<ReturnType<typeof import('tesseract.js').createWorker>>;

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
      logger: ({ status, progress }) => onProgress(status === 'recognizing text' ? 35 + Math.round(progress * 65) : 15),
      errorHandler: fail,
    }).then(async worker => {
      clearTimeout(timer);
      if (failed) await worker.terminate();
      else resolve(worker);
    }).catch(fail);
  });
}

export async function scanInvoice(file: File, onProgress: (progress: number) => void) {
  const extension = receiptExtension(file);
  let worker: InvoiceWorker | undefined;
  const recognize = async (image: File | HTMLCanvasElement) => {
    worker ??= await startWorker(onProgress);
    const { data } = await worker.recognize(image);
    return data.text;
  };

  let text = '';
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
            if (lines.length < 40) {
              const original = page.getViewport({ scale: 1 });
              const viewport = page.getViewport({ scale: Math.min(3, 2000 / Math.max(original.width, original.height)) });
              const canvas = document.createElement('canvas');
              canvas.width = Math.ceil(viewport.width);
              canvas.height = Math.ceil(viewport.height);
              try {
                await page.render({ canvas, viewport }).promise;
                lines = await recognize(canvas);
              } finally { canvas.width = 0; canvas.height = 0; }
            }
            text += lines + '\n';
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
        try { text = await recognize(canvas); }
        finally { canvas.width = 0; canvas.height = 0; }
      } finally { URL.revokeObjectURL(url); }
    }
    const readable = text.trim();
    return { fields: extractInvoiceFields(readable), text: readable.slice(0, 8000), pagesRead, pageCount };
  } finally { await worker?.terminate(); }
}
