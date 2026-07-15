const { chromium } = require('playwright');

(async () => {
  console.log('[1/6] Mở browser (non-headless)...');
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // Thu thập console messages
  const consoleLogs = [];
  const consoleErrors = [];
  page.on('console', msg => {
    const text = msg.text();
    consoleLogs.push(`[${msg.type()}] ${text}`);
    if (msg.type() === 'error') consoleErrors.push(text);
  });

  // Thu thập page errors (uncaught exceptions)
  const pageErrors = [];
  page.on('pageerror', err => {
    pageErrors.push(err.message);
  });

  try {
    // Step 1: Mở trang admin
    console.log('[2/6] Mở https://admin.trueteamcommunity.dpdns.org ...');
    await page.goto('https://admin.trueteamcommunity.dpdns.org', { waitUntil: 'networkidle', timeout: 15000 });

    // Step 2: Kiểm tra adminLogin function có tồn tại không
    console.log('[3/6] Kiểm tra adminLogin() function...');
    const fnExists = await page.evaluate(() => typeof window.adminLogin === 'function');
    console.log(`    → adminLogin() defined: ${fnExists ? '✅ YES' : '❌ NO'}`);

    // Step 3: Kiểm tra btn-accent CSS có applied không
    console.log('[4/6] Kiểm tra btn-accent CSS...');
    const btnStyles = await page.evaluate(() => {
      const btn = document.querySelector('#loginCard .btn-accent');
      if (!btn) return { found: false };
      const cs = getComputedStyle(btn);
      return {
        found: true,
        background: cs.backgroundColor,
        color: cs.color,
        fontWeight: cs.fontWeight,
        display: cs.display,
        width: cs.width,
        disabled: btn.disabled
      };
    });
    console.log(`    → Button found: ${btnStyles.found ? '✅' : '❌'}`);
    if (btnStyles.found) {
      console.log(`    → background: ${btnStyles.background}`);
      console.log(`    → color: ${btnStyles.color}`);
      console.log(`    → font-weight: ${btnStyles.fontWeight}`);
      console.log(`    → width: ${btnStyles.width}`);
    }

    // Step 4: Kiểm tra có SyntaxError nào trong page không
    console.log('[5/6] Kiểm tra JavaScript errors...');
    if (pageErrors.length > 0) {
      console.log(`    ❌ Page errors (${pageErrors.length}):`);
      pageErrors.forEach(e => console.log(`       - ${e}`));
    } else {
      console.log('    ✅ Không có page errors');
    }
    if (consoleErrors.length > 0) {
      console.log(`    ⚠️ Console errors (${consoleErrors.length}):`);
      consoleErrors.forEach(e => console.log(`       - ${e}`));
    } else {
      console.log('    ✅ Không có console errors');
    }

    // Step 5: Thử login
    console.log('[6/6] Thử login với admin123...');
    await page.fill('#adminEmailInput', '');
    await page.fill('#adminPassInput', 'admin123');

    // Click Sign In và chờ response
    const [response] = await Promise.all([
      page.waitForResponse(resp => resp.url().includes('/api/'), { timeout: 10000 }),
      page.click('#loginCard .btn-accent')
    ]);

    console.log(`    → API response status: ${response.status()}`);
    const body = await response.json().catch(() => null);
    console.log(`    → API response body: ${JSON.stringify(body)}`);

    // Kiểm tra Dashboard có hiện không
    await page.waitForTimeout(1000);
    const dashboardVisible = await page.evaluate(() => {
      const dash = document.getElementById('dashboard');
      return dash && !dash.classList.contains('hidden');
    });
    console.log(`    → Dashboard visible: ${dashboardVisible ? '✅ YES' : '❌ NO'}`);

    // Giữ browser mở 3s để user xem
    console.log('\n══════════════════════════════════════');
    console.log('Browser đang mở — xem kết quả trên màn hình.');
    console.log('Browser sẽ tự đóng sau 5 giây...');
    console.log('══════════════════════════════════════');
    await page.waitForTimeout(5000);

  } catch (err) {
    console.error('\n❌ LỖI:', err.message);
  } finally {
    await browser.close();
    console.log('[DONE] Browser đã đóng.');
  }
})();
