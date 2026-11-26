// On-device barcode reading (zxing-cpp compiled to WebAssembly, bundled with the app).
// Reads the comic's UPC *and* its 5-digit add-on (issue number, cover, printing).

let readyPromise = null;

function waitForLib(ms = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function check() {
      if (window.ZXingWASM) return resolve(window.ZXingWASM);
      if (Date.now() - t0 > ms) return reject(new Error('The barcode reader did not load.'));
      setTimeout(check, 100);
    })();
  });
}

export function init() {
  if (!readyPromise) {
    readyPromise = waitForLib().then(Z => {
      const wasmUrl = new URL('../vendor/zxing/zxing_reader.wasm', import.meta.url).href;
      Z.prepareZXingModule({
        overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
        fireImmediately: true,
      });
      return Z;
    }).catch(e => { readyPromise = null; throw e; });
  }
  return readyPromise;
}

const OPTS = {
  formats: ['EAN13', 'UPCA', 'UPCE', 'EAN8'],
  eanAddOnSymbol: 'Read',
  tryHarder: true,
  tryRotate: true,
  maxNumberOfSymbols: 1,
};

/**
 * Turn a raw result into { code, base, addon, isbn }.
 *  code  – what to look up: UPC-A + add-on (17 digits), a plain UPC, or an ISBN
 *  base  – the 12-digit UPC without the add-on
 */
export function normalise(text, extra) {
  let digits = String(text || '').replace(/\D/g, '');
  let addon = null;
  try { addon = JSON.parse(extra || '{}').EanAddOn || null; } catch (e) { /* ignore */ }
  if (addon && digits.endsWith(addon) && digits.length > addon.length + 7) digits = digits.slice(0, -addon.length);
  if (digits.length === 13 && /^97[89]/.test(digits)) return { code: digits, base: digits, addon, isbn: digits };
  if (digits.length === 13 && digits.startsWith('0')) digits = digits.slice(1); // EAN-13 form of a UPC-A
  if (digits.length < 8) return null;
  return { code: addon && addon.length === 5 ? digits + addon : digits, base: digits, addon: addon && addon.length === 5 ? addon : null, isbn: null };
}

/** Read one ImageData (or image Blob). Returns the normalised result or null. */
export async function read(input) {
  const Z = await init();
  const res = await Z.readBarcodes(input, OPTS);
  const r = res.find(x => x.isValid !== false && x.text);
  return r ? normalise(r.text, r.extra) : null;
}

/** Build a full code from a 12-digit UPC and what the user typed (5 add-on digits or just the issue #). */
export function withAddon(base, typed) {
  const d = String(typed || '').replace(/\D/g, '');
  if (d.length === 5) return base + d;
  if (d.length >= 1 && d.length <= 3) return base + d.padStart(3, '0') + '11'; // cover 1, 1st printing
  return null;
}
