const { chromium } = require('playwright');

(async () => {
  console.log('[1/5] Starting browser with DNS override...');
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--start-maximized',
      '--host-resolver-rules=MAP shop.trueteamcommunity.dpdns.org 172.67.176.173',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  try {
    console.log('[2/5] Opening shop.trueteamcommunity.dpdns.org ...');
    await page.goto('https://shop.trueteamcommunity.dpdns.org/', { waitUntil: 'networkidle', timeout: 20000 });

    // Banner
    const banner = await page.evaluate(() => {
      const b = document.getElementById('shopBanner');
      return b ? { found: true, h: getComputedStyle(b).height, pos: getComputedStyle(b).position } : { found: false };
    });
    console.log('[3/5] Banner:', banner.found ? '✅ ' + banner.h + ' ' + banner.pos : '❌');

    // Topbar
    const topbar = await page.evaluate(() => ({
      title: document.querySelector('.topbar-title')?.textContent || null,
      sellerBtn: document.getElementById('sellerBtn')?.textContent?.trim() || null,
      logo: !!document.getElementById('logoDisplay'),
    }));
    console.log('    Topbar:', topbar.title ? '✅ ' + topbar.title : '❌', '| Seller:', topbar.sellerBtn ? '✅' : '❌', '| Logo:', topbar.logo ? '✅' : '❌');

    // Products
    const prod = await page.evaluate(() => ({
      grid: !!document.getElementById('productGrid'),
      tabs: document.getElementById('catTabs')?.children.length || 0,
      empty: !!document.getElementById('emptyState'),
    }));
    console.log('[4/5] Grid:', prod.grid ? '✅' : '❌', '| Tabs:', prod.tabs, '| Empty:', prod.empty ? '✅' : '❌');

    // Modal
    await page.click('#sellerBtn');
    await page.waitForTimeout(300);
    const modal = await page.evaluate(() => ({
      open: document.getElementById('sellerModal')?.classList.contains('open') || false,
      loginForm: !document.getElementById('sellerLoginForm')?.classList.contains('hidden'),
      title: document.getElementById('modalTitle')?.textContent || null,
      email: !!document.getElementById('sellerEmail'),
      pass: !!document.getElementById('sellerPass'),
      sections: document.querySelectorAll('.seller-section').length,
      paySection: !!document.getElementById('paymentSection'),
    }));
    console.log('    Modal:', modal.open ? '✅' : '❌', '| Login:', modal.loginForm ? '✅' : '❌', '| Title:', modal.title);
    console.log('    Inputs:', modal.email && modal.pass ? '✅' : '❌', '| Sections:', modal.sections, '| Payment:', modal.paySection ? '✅' : '❌');

    // Payment
    const pay = await page.evaluate(() => ({
      bankName: document.getElementById('bankName')?.textContent || null,
      bankAccount: document.getElementById('bankAccount')?.textContent || null,
      copyBtns: document.querySelectorAll('.copy-btn').length,
    }));
    console.log('    Bank:', pay.bankName || '—', '| Copy btns:', pay.copyBtns);

    // JS functions
    const funcs = await page.evaluate(() => {
      const names = ['toast','api','loadShopConfig','loadProducts','renderProducts','openSellerModal','closeSellerModal','doSellerLogin','doSellerLogout','addSellerProduct','filterCategory'];
      return names.filter(n => typeof window[n] === 'function').length + '/' + names.length;
    });
    console.log('[5/5] JS functions:', funcs);

    // Errors
    console.log('\n══════════════════════════════════════');
    const jsErrors = pageErrors.filter(e => !e.includes('localStorage'));
    if (jsErrors.length) { console.log('❌ Page errors:', jsErrors); } else { console.log('✅ No JS errors'); }
    if (consoleErrors.length) { console.log('⚠️ Console errors:', consoleErrors.length); } else { console.log('✅ No console errors'); }

    const pass = banner.found && topbar.sellerBtn && prod.grid && modal.open && jsErrors.length === 0;
    console.log(pass ? '\n✅ ALL CHECKS PASSED — LIVE SITE WORKS!' : '\n❌ SOME CHECKS FAILED');
    console.log('══════════════════════════════════════\n');

    console.log('Browser open for inspection. Closing in 8s...');
    await page.waitForTimeout(8000);

  } catch (err) {
    console.error('\n❌ ERROR:', err.message);
  } finally {
    await browser.close();
    console.log('[DONE]');
  }
})();
