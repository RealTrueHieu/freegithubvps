const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  console.log('[1/7] Starting browser...');
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => {
    pageErrors.push(err.message);
  });

  try {
    // Extract SHOP_HTML from worker.js source
    console.log('[2/7] Extracting SHOP_HTML from worker.js...');
    const src = fs.readFileSync(path.join(__dirname, 'src', 'worker.js'), 'utf-8');
    const startMarker = "const SHOP_HTML = `";
    const startIdx = src.indexOf(startMarker);
    if (startIdx === -1) throw new Error('SHOP_HTML not found in worker.js');

    // Find the matching closing backtick + semicolon
    let htmlStart = startIdx + startMarker.length;
    let depth = 0;
    let endIdx = -1;
    for (let i = htmlStart; i < src.length; i++) {
      if (src[i] === '`' && src[i - 1] !== '\\') {
        endIdx = i;
        break;
      }
    }
    if (endIdx === -1) throw new Error('Could not find end of SHOP_HTML');

    const shopHtml = src.substring(htmlStart, endIdx);
    console.log('    SHOP_HTML extracted: ' + shopHtml.length + ' chars');

    // Load the HTML into the browser
    console.log('[3/7] Loading shop HTML into browser...');
    await page.setContent(shopHtml, { waitUntil: 'networkidle', timeout: 15000 });
    console.log('    HTML loaded successfully');

    // Step 1: Check banner
    console.log('[4/7] Checking banner...');
    const banner = await page.evaluate(() => {
      const b = document.getElementById('shopBanner');
      if (!b) return { found: false };
      const cs = getComputedStyle(b);
      return {
        found: true,
        height: cs.height,
        position: cs.position,
        zIndex: cs.zIndex,
        display: cs.display,
        overflow: cs.overflow,
      };
    });
    console.log('    Banner found:', banner.found ? '✅ YES' : '❌ NO');
    if (banner.found) {
      console.log('      Height:', banner.height, '| Position:', banner.position, '| z-index:', banner.zIndex);
    }

    // Step 2: Check topbar
    console.log('[5/7] Checking topbar (logo + title + seller button)...');
    const topbar = await page.evaluate(() => {
      const title = document.querySelector('.topbar-title');
      const sub = document.querySelector('.topbar-sub');
      const sellerBtn = document.getElementById('sellerBtn');
      const logo = document.getElementById('logoDisplay');
      return {
        title: title ? title.textContent : null,
        subtitle: sub ? sub.textContent : null,
        sellerBtnFound: !!sellerBtn,
        sellerBtnText: sellerBtn ? sellerBtn.textContent.trim() : null,
        logoFound: !!logo,
      };
    });
    console.log('    Title:', topbar.title ? '✅ ' + topbar.title : '❌ NOT FOUND');
    console.log('    Subtitle:', topbar.subtitle ? '✅ ' + topbar.subtitle : '❌ NOT FOUND');
    console.log('    Logo:', topbar.logoFound ? '✅ YES' : '❌ NO');
    console.log('    Seller button:', topbar.sellerBtnFound ? '✅ ' + topbar.sellerBtnText : '❌ NO');

    // Step 3: Check hero
    const hero = await page.evaluate(() => {
      const badge = document.querySelector('.hero-badge');
      const h1 = document.querySelector('.hero h1');
      const p = document.querySelector('.hero p');
      return {
        badge: badge ? badge.textContent.trim() : null,
        title: h1 ? h1.textContent.trim() : null,
        desc: p ? p.textContent.trim() : null,
      };
    });
    console.log('    Hero badge:', hero.badge ? '✅ ' + hero.badge : '❌ NO');
    console.log('    Hero title:', hero.title ? '✅' : '❌ NO');

    // Step 4: Check product grid & category tabs
    console.log('[6/7] Checking product grid & categories...');
    const products = await page.evaluate(() => {
      const grid = document.getElementById('productGrid');
      const tabs = document.getElementById('catTabs');
      const count = document.getElementById('productCount');
      const empty = document.getElementById('emptyState');
      return {
        gridFound: !!grid,
        tabsFound: !!tabs,
        tabCount: tabs ? tabs.children.length : 0,
        productCount: grid ? grid.children.length : 0,
        countText: count ? count.textContent : null,
        emptyStateFound: !!empty,
      };
    });
    console.log('    Product grid:', products.gridFound ? '✅ YES' : '❌ NO');
    console.log('    Category tabs:', products.tabCount >= 1 ? '✅ ' + products.tabCount + ' tabs' : '❌ 0 tabs');
    console.log('    Empty state:', products.emptyStateFound ? '✅ YES' : '❌ NO');

    // Step 5: Check seller modal
    console.log('[7/7] Testing seller modal...');
    await page.click('#sellerBtn');
    await page.waitForTimeout(300);
    const modal = await page.evaluate(() => {
      const overlay = document.getElementById('sellerModal');
      const loginForm = document.getElementById('sellerLoginForm');
      const dashboard = document.getElementById('sellerDashboard');
      const modalTitle = document.getElementById('modalTitle');
      const emailInput = document.getElementById('sellerEmail');
      const passInput = document.getElementById('sellerPass');
      const sellerSections = document.querySelectorAll('.seller-section');
      return {
        isOpen: overlay ? overlay.classList.contains('open') : false,
        loginFormVisible: loginForm ? !loginForm.classList.contains('hidden') : false,
        dashboardHidden: dashboard ? dashboard.classList.contains('hidden') : true,
        title: modalTitle ? modalTitle.textContent : null,
        emailInputFound: !!emailInput,
        passInputFound: !!passInput,
        sellerSectionCount: sellerSections.length,
      };
    });
    console.log('    Modal opens:', modal.isOpen ? '✅ YES' : '❌ NO');
    console.log('    Login form visible:', modal.loginFormVisible ? '✅ YES' : '❌ NO');
    console.log('    Dashboard hidden:', modal.dashboardHidden ? '✅ YES' : '❌ NO');
    console.log('    Modal title:', modal.title ? '✅ ' + modal.title : '❌ NO');
    console.log('    Email input:', modal.emailInputFound ? '✅ YES' : '❌ NO');
    console.log('    Password input:', modal.passInputFound ? '✅ YES' : '❌ NO');
    console.log('    Seller sections:', modal.sellerSectionCount >= 5 ? '✅ ' + modal.sellerSectionCount + ' sections' : '❌ ' + modal.sellerSectionCount);

    // Step 6: Check payment section
    const payment = await page.evaluate(() => {
      const section = document.getElementById('paymentSection');
      const bankName = document.getElementById('bankName');
      const bankAccount = document.getElementById('bankAccount');
      const bankHolder = document.getElementById('bankHolder');
      const copyBtns = document.querySelectorAll('.copy-btn');
      return {
        sectionFound: !!section,
        bankName: bankName ? bankName.textContent : null,
        bankAccount: bankAccount ? bankAccount.textContent : null,
        bankHolder: bankHolder ? bankHolder.textContent : null,
        copyBtnCount: copyBtns.length,
      };
    });
    console.log('    Payment section:', payment.sectionFound ? '✅ YES' : '❌ NO');
    console.log('    Copy buttons:', payment.copyBtnCount >= 3 ? '✅ ' + payment.copyBtnCount : '❌ ' + payment.copyBtnCount);

    // Step 7: Check JavaScript functions exist
    const funcs = await page.evaluate(() => {
      return {
        toast: typeof toast === 'function',
        api: typeof api === 'function',
        loadShopConfig: typeof loadShopConfig === 'function',
        loadProducts: typeof loadProducts === 'function',
        renderProducts: typeof renderProducts === 'function',
        openSellerModal: typeof openSellerModal === 'function',
        closeSellerModal: typeof closeSellerModal === 'function',
        doSellerLogin: typeof doSellerLogin === 'function',
        doSellerLogout: typeof doSellerLogout === 'function',
        addSellerProduct: typeof addSellerProduct === 'function',
        filterCategory: typeof filterCategory === 'function',
      };
    });
    const funcCount = Object.values(funcs).filter(Boolean).length;
    console.log('    JS functions:', funcCount + '/' + Object.keys(funcs).length + ' defined',
      funcCount === Object.keys(funcs).length ? '✅' : '⚠️');

    // ── Summary ──
    console.log('\n══════════════════════════════════════');
    if (pageErrors.length > 0) {
      console.log('❌ PAGE ERRORS (' + pageErrors.length + '):');
      pageErrors.forEach(e => console.log('   ' + e));
    } else {
      console.log('✅ No page errors (SyntaxError, ReferenceError, etc.)');
    }
    if (consoleErrors.length > 0) {
      console.log('⚠️  CONSOLE ERRORS (' + consoleErrors.length + '):');
      consoleErrors.forEach(e => console.log('   ' + e));
    } else {
      console.log('✅ No console errors');
    }

    const allPassed = banner.found && topbar.sellerBtnFound && hero.badge && products.gridFound && modal.isOpen && pageErrors.length === 0;
    console.log('\n' + (allPassed ? '✅ ALL DOM CHECKS PASSED' : '❌ SOME CHECKS FAILED'));
    console.log('══════════════════════════════════════');

    console.log('\nBrowser open for visual inspection. Closing in 5s...');
    await page.waitForTimeout(5000);

  } catch (err) {
    console.error('\n❌ ERROR:', err.message);
  } finally {
    await browser.close();
    console.log('[DONE] Browser closed.');
  }
})();
