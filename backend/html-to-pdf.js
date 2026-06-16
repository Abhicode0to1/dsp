// One-shot HTML→PDF converter using the Playwright chromium that's already
// installed for the load-test suite. Reads the HTML report next to itself,
// writes a sibling PDF, then exits.
const path = require('path');
const { chromium } = require('@playwright/test');

(async () => {
  const htmlPath = path.resolve(__dirname, '..', 'dsp-daily-report-2026-05-27.html');
  const pdfPath  = path.resolve(__dirname, '..', 'dsp-daily-report-2026-05-27.pdf');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'networkidle' });
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '18mm', right: '16mm', bottom: '22mm', left: '16mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `
      <div style="width:100%;font-size:9px;color:#9ca3af;padding:0 16mm;display:flex;justify-content:space-between;">
        <span>DSP Engineering Report · 27 May 2026</span>
        <span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>
      </div>`,
  });
  await browser.close();
  console.log('PDF written to:', pdfPath);
})().catch(err => { console.error(err); process.exit(1); });
