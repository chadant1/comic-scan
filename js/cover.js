// "No barcode?" fallback: read the cover's title and issue number on the phone (Tesseract.js).

let workerPromise = null;

function waitForTesseract(ms = 20000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function check() {
      if (window.Tesseract) return resolve(window.Tesseract);
      if (Date.now() - t0 > ms) return reject(new Error('The text reader could not be downloaded. Check your connection.'));
      setTimeout(check, 150);
    })();
  });
}

function worker() {
  if (!workerPromise) {
    workerPromise = waitForTesseract().then(T => T.createWorker('eng')).catch(e => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

const STOP = new Set(['marvel', 'dc', 'comics', 'comic', 'image', 'presents', 'the', 'and', 'of', 'direct', 'edition', 'variant', 'cover', 'approved', 'by', 'code', 'authority', 'cents', 'us', 'can', 'no', 'vol', 'volume', 'issue', 'price']);

/** Returns { series, number, raw } best guesses from a canvas holding the cover. */
export async function readCover(canvas) {
  const w = await worker();
  await w.setParameters({ tessedit_pageseg_mode: '11' });
  const { data } = await w.recognize(canvas);
  const raw = data.text || '';
  // Issue number: "#300", "No. 300", "No 3"
  const nm = /(?:#|\bno\.?)\s*(\d{1,4})\b/i.exec(raw);
  // Title: the biggest confident words in the top 45% of the cover.
  const H = canvas.height;
  const words = (data.words || [])
    .filter(x => x.confidence > 55 && /^[A-Za-z][A-Za-z'’\-]{1,}$/.test(x.text) && x.bbox.y0 < H * 0.45 && !STOP.has(x.text.toLowerCase()))
    .map(x => ({ t: x.text, h: x.bbox.y1 - x.bbox.y0, y: x.bbox.y0, x: x.bbox.x0 }));
  words.sort((a, b) => b.h - a.h);
  const big = words.slice(0, 4).sort((a, b) => a.y - b.y || a.x - b.x).map(x => x.t);
  return { series: big.join(' '), number: nm ? nm[1] : '', raw };
}
