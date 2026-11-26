# ComicScan: scan a comic, see what shops are selling it for

**Free for everyone. No account, no sign-up, no ads.**

Open **https://chadant1.github.io/comic-scan/** on your iPhone in Safari, then tap **Share → Add to Home Screen**.

## What it does

1. **Scan the barcode.** Point the camera at the barcode on the cover. ComicScan reads the main UPC and the **5 small digits** beside it (issue number, cover, printing). Reading happens on your phone, and the picture is never saved or uploaded.
2. **Identify the exact issue.** The comic is looked up in the [Grand Comics Database](https://www.comics.org): series, issue, variant cover, publisher, cover date, cover price, creators and characters.
3. **See what it's selling for right now.** ComicScan checks these shops and lists every copy in stock, cheapest first. Each listing shows its grade (raw grades or CGC/CBCS slabs), the price, and whether it's buy-now, best-offer or an auction bid, with a link to it.
   - Midtown Comics
   - Comic Source (formerly Newkadia)
   - Infinity Flux
   - InStockTrades (trades and hardcovers)

   At the top you get the **cheapest raw copy** and the **cheapest copy at each CGC grade**.
4. **One tap to check more sites:** MyComicShop, Amazon, eBay sold listings, PriceCharting and GoCollect.

No barcode? This happens with older comics. Tap **Read the cover**, or use the **Search** tab (series title + issue #).

**First scan of a new series:** if nobody has scanned that series before, ComicScan asks once for the title printed on the cover. It checks the barcode against GCD's record and remembers the series. After that, every issue and variant of that series is identified automatically for everyone.

## How it's built (all free)

| Piece | Where it runs | Cost |
|---|---|---|
| The app (`index.html`, `js/`, `css/`) | GitHub Pages | free |
| Barcode reader ([zxing-cpp](https://github.com/zxing-cpp/zxing-cpp) WebAssembly, in `vendor/`) | on the phone | free |
| Cover text reader ([Tesseract.js](https://github.com/naptha/tesseract.js)) | on the phone | free |
| The relay (`relay/`, also deployed as **chadant1/comic-scan-relay**) | Cloudflare Workers free plan (100,000 requests/day) | free |
| Comic data | Grand Comics Database public API (CC BY-SA 4.0) | free |

**Why a relay?** Phone browsers don't let a web app read other websites directly. The relay is a small server that fetches the GCD data and the shops' public search pages for the app, and caches the results.

**Updating the relay:** Cloudflare deploys from the **chadant1/comic-scan-relay** repo. Push changes there and Cloudflare redeploys within a minute or two. Keep `relay/` in this repo as a copy.

**MyComicShop** blocks automated price checks from servers, so ComicScan links to it rather than listing its prices.

## Credits

Comic data © [Grand Comics Database](https://www.comics.org) contributors, licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Cover images © their publishers, shown for identification. Prices belong to the shops listed. ComicScan is not affiliated with any publisher, shop or GCD.

Code: MIT License.
