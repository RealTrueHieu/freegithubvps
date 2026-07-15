
	/* ── State ── */
	var shopToken = localStorage.getItem('shopToken') || '';
	var allProducts = [];
	var currentCat = 'all';
	var API = '/api/';

	/* ── Toast ── */
	function toast(msg, err) {
	  var c = document.getElementById('toastBox');
	  var t = document.createElement('div');
	  t.className = 'toast' + (err ? ' toast-err' : '');
	  t.textContent = msg;
	  c.appendChild(t);
	  setTimeout(function(){ t.remove(); }, 3000);
	}

	/* ── Fetch helper ── */
	function api(path, data, method) {
	  var opts = { method: method || 'POST', headers: {} };
	  if (data && !(data instanceof FormData)) {
	    opts.headers['Content-Type'] = 'application/json';
	    opts.body = JSON.stringify(Object.assign({}, data, shopToken ? { shopToken: shopToken } : {}));
	  } else if (data instanceof FormData) {
	    if (shopToken) opts.headers['shopToken'] = shopToken;
    opts.body = data;
	  }
	  return fetch(API + path, opts).then(function(r) {
	    var ct = r.headers.get('content-type') || '';
	    if (!ct.includes('json')) return r.text().then(function(t){ throw new Error(t || 'HTTP ' + r.status); });
	    return r.json();
	  }).then(function(j) { if (j.error) throw new Error(j.error); return j; });
	}

	/* ── Load Shop Config (public) ── */
	function loadShopConfig() {
	  fetch(API + 'config').then(function(r){ return r.json(); }).then(function(d) {
	    if (d.bannerText) {
	      var txt = d.bannerText;
	      var track = document.getElementById('bannerTrack');
	      track.innerHTML = '<span>' + txt + '</span><span>' + txt + '</span><span>' + txt + '</span><span>' + txt + '</span>';
	    }
	    if (d.logoUrl) {
	      var ld = document.getElementById('logoDisplay');
	      ld.outerHTML = '<img class="logo-img" id="logoDisplay" src="' + d.logoUrl + '?_t=' + Date.now() + '" onerror="this.outerHTML=&#39;<div class=logo-placeholder>T</div>&#39;" />';
	    }
	    if (d.qrUrl) {
	      var qb = document.getElementById('qrBox');
	      qb.innerHTML = '<img src="' + d.qrUrl + '?_t=' + Date.now() + '" /><div class="qr-label">Quét QR để thanh toán</div>';
	      document.getElementById('paymentSection').classList.remove('hidden');
	    }
	    if (d.bankName) document.getElementById('bankName').textContent = d.bankName;
	    if (d.bankAccount) document.getElementById('bankAccount').textContent = d.bankAccount;
	    if (d.bankHolder) document.getElementById('bankHolder').textContent = d.bankHolder;
	    if (d.bankName || d.bankAccount) document.getElementById('paymentSection').classList.remove('hidden');
	  }).catch(function(){});
	}

	/* ── Load Products (public) ── */
	function loadProducts() {
	  api('products', null, 'GET').then(function(d) {
	    allProducts = d.products || [];
	    renderProducts();
	    renderCategories();
	  }).catch(function(e) {
	    document.getElementById('emptyState').classList.remove('hidden');
	  });
	}

	function renderCategories() {
	  var cats = {};
	  allProducts.forEach(function(p) {
	    var c = (p.category || 'general').toLowerCase();
	    cats[c] = (cats[c] || 0) + 1;
	  });
	  var tabs = document.getElementById('catTabs');
	  tabs.innerHTML = '<div class="cat-tab active" data-cat="all" onclick="filterCategory('all',this)">Tất cả (' + allProducts.length + ')</div>';
	  Object.keys(cats).forEach(function(c) {
	    tabs.innerHTML += '<div class="cat-tab" data-cat="' + c + '" onclick="filterCategory('' + c + '',this)">' + c + ' (' + cats[c] + ')</div>';
	  });
	}

	function filterCategory(cat, el) {
	  currentCat = cat;
	  document.querySelectorAll('.cat-tab').forEach(function(t){ t.classList.remove('active'); });
	  if (el) el.classList.add('active');
	  renderProducts();
	}

	function renderProducts() {
	  var grid = document.getElementById('productGrid');
	  var empty = document.getElementById('emptyState');
	  var filtered = currentCat === 'all' ? allProducts : allProducts.filter(function(p){ return (p.category || 'general').toLowerCase() === currentCat; });
	  document.getElementById('productCount').textContent = '(' + filtered.length + ' sản phẩm)';
	  if (filtered.length === 0) {
	    grid.innerHTML = '';
	    empty.classList.remove('hidden');
	    return;
	  }
	  empty.classList.add('hidden');
	  grid.innerHTML = filtered.map(function(p, i) {
	    var priceText = p.price > 0 ? formatPrice(p.price) : 'Miễn phí';
	    var priceClass = p.price > 0 ? '' : ' free';
	    var imgHtml = p.image_url ? '<img class="product-img" src="' + p.image_url + '" loading="lazy"/>' : '<div class="product-img-placeholder">📦</div>';
	    var catText = p.category || 'general';
	    return '<div class="product-card" style="animation-delay:' + (i * 0.05) + 's">' + imgHtml + '<div class="product-info"><div class="product-name">' + escHtml(p.name) + '</div><div class="product-desc">' + escHtml(p.description || '') + '</div><div class="product-bottom"><div class="product-price' + priceClass + '">' + priceText + '</div><div class="product-cat">' + escHtml(catText) + '</div></div></div></div>';
	  }).join('');
	}

	function formatPrice(n) {
	  return new Intl.NumberFormat('vi-VN').format(n) + 'đ';
	}

	function escHtml(s) {
	  var d = document.createElement('div');
	  d.textContent = s;
	  return d.innerHTML;
	}

	function copyText(id) {
	  var el = document.getElementById(id);
	  if (!el) return;
	  navigator.clipboard.writeText(el.textContent).then(function(){ toast('Đã copy!'); }).catch(function(){});
	}

	/* ── Seller Modal ── */
	function openSellerModal() {
	  document.getElementById('sellerModal').classList.add('open');
	  if (shopToken) {
	    showSellerDashboard();
	  } else {
	    document.getElementById('sellerLoginForm').classList.remove('hidden');
	    document.getElementById('sellerDashboard').classList.add('hidden');
	    document.getElementById('modalTitle').textContent = '🔐 Seller Sign In';
	  }
	}

	function closeSellerModal() {
	  document.getElementById('sellerModal').classList.remove('open');
	}

	function doSellerLogin() {
	  var email = document.getElementById('sellerEmail').value.trim();
	  var pass = document.getElementById('sellerPass').value;
	  if (!email || !pass) return toast('Nhập email và mật khẩu', true);
	  api('login', { email: email, password: pass }).then(function(d) {
	    shopToken = d.shopToken;
	    localStorage.setItem('shopToken', shopToken);
	    showSellerDashboard();
	    toast('Đăng nhập thành công!');
	  }).catch(function(e) { toast(e.message, true); });
	}

	function showSellerDashboard() {
	  document.getElementById('sellerLoginForm').classList.add('hidden');
	  document.getElementById('sellerDashboard').classList.remove('hidden');
	  document.getElementById('modalTitle').textContent = '🏪 Seller Dashboard';
	  loadSellerSettings();
	  loadSellerProducts();
	}

	function doSellerLogout() {
	  shopToken = '';
	  localStorage.removeItem('shopToken');
	  document.getElementById('sellerLoginForm').classList.remove('hidden');
	  document.getElementById('sellerDashboard').classList.add('hidden');
	  document.getElementById('modalTitle').textContent = '🔐 Seller Sign In';
	  toast('Đã đăng xuất');
	}

	/* ── Seller: Load Settings ── */
	function loadSellerSettings() {
	  api('config', {}).then(function(d) {
	    document.getElementById('sBannerText').value = d.bannerText || '';
	    document.getElementById('sBankName').value = d.bankName || '';
	    document.getElementById('sBankAccount').value = d.bankAccount || '';
	    document.getElementById('sBankHolder').value = d.bankHolder || '';
	    if (d.hasLogo) {
	      document.getElementById('sLogoPreview').classList.remove('hidden');
	      document.getElementById('sLogoImg').src = '/r2/shop-logo.png?_t=' + Date.now();
	    }
	    if (d.hasQr) {
	      document.getElementById('sQrPreview').classList.remove('hidden');
	      document.getElementById('sQrImg').src = '/r2/shop-qr.png?_t=' + Date.now();
	    }
	  }).catch(function(e) { toast(e.message, true); });
	}

	function saveSellerSettings() {
	  api('save-bank-info', {
	    bannerText: document.getElementById('sBannerText').value.trim(),
	    bankName: document.getElementById('sBankName').value.trim(),
	    bankAccount: document.getElementById('sBankAccount').value.trim(),
	    bankHolder: document.getElementById('sBankHolder').value.trim(),
	  }).then(function() {
	    toast('Đã lưu cài đặt!');
	    loadShopConfig();
	  }).catch(function(e) { toast(e.message, true); });
	}

	/* ── Seller: Upload Logo ── */
	function uploadSellerLogo() {
	  var file = document.getElementById('sLogoFile').files[0];
	  if (!file) return toast('Chọn file logo', true);
	  var fd = new FormData(); fd.append('file', file);
	  fetch(API + 'upload-logo', { method: 'POST', headers: { shopToken: shopToken }, body: fd })
	  .then(function(r) { return r.json(); }).then(function(j) {
	    if (j.error) throw new Error(j.error);
	    toast('Logo đã upload!');
	    loadSellerSettings();
	    loadShopConfig();
	  }).catch(function(e) { toast(e.message, true); });
	}

	/* ── Seller: Upload QR ── */
	function uploadSellerQr() {
	  var file = document.getElementById('sQrFile').files[0];
	  if (!file) return toast('Chọn file QR', true);
	  var fd = new FormData(); fd.append('file', file);
	  fetch(API + 'upload-qr', { method: 'POST', headers: { shopToken: shopToken }, body: fd })
	  .then(function(r) { return r.json(); }).then(function(j) {
	    if (j.error) throw new Error(j.error);
	    toast('QR đã upload!');
	    loadSellerSettings();
	    loadShopConfig();
	  }).catch(function(e) { toast(e.message, true); });
	}

	/* ── Seller: Add Product ── */
	function addSellerProduct() {
	  var name = document.getElementById('sProductName').value.trim();
	  var desc = document.getElementById('sProductDesc').value.trim();
	  var price = parseInt(document.getElementById('sProductPrice').value) || 0;
	  var cat = document.getElementById('sProductCat').value.trim() || 'general';
	  var file = document.getElementById('sProductImg').files[0];
	  if (!name) return toast('Nhập tên sản phẩm', true);

	  var doAdd = function(imageUrl) {
	    api('add-product', { name: name, description: desc, price: price, category: cat, imageUrl: imageUrl || '' }).then(function() {
	      toast('Đã thêm sản phẩm!');
	      document.getElementById('sProductName').value = '';
	      document.getElementById('sProductDesc').value = '';
	      document.getElementById('sProductPrice').value = '';
	      document.getElementById('sProductCat').value = '';
      document.getElementById('sProductImg').value = '';
      loadSellerProducts();
      loadProducts();
    }).catch(function(e) { toast(e.message, true); });
	  };

	  if (file) {
	    var fd = new FormData(); fd.append('file', file);
	    fetch(API + 'upload-product-image', { method: 'POST', headers: { shopToken: shopToken }, body: fd })
    .then(function(r) { return r.json(); }).then(function(j) {
      if (j.error) throw new Error(j.error);
      doAdd(j.url);
    }).catch(function(e) { toast(e.message, true); });
	  } else {
	    doAdd('');
	  }
	}

	/* ── Seller: Load Products ── */
	function loadSellerProducts() {
	  api('products', null, 'GET').then(function(d) {
	    var list = document.getElementById('sellerProductList');
	    var prods = d.products || [];
	    if (prods.length === 0) {
      list.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:0.78rem;padding:16px;">Chưa có sản phẩm</div>';
      return;
    }
    list.innerHTML = prods.map(function(p) {
      var imgTag = p.image_url ? '<img src="' + p.image_url + '"/>' : '<div style="width:40px;height:40px;background:var(--surface2);border-radius:var(--radius);display:flex;align-items:center;justify-content:center;">📦</div>';
      return '<div class="seller-product-item">' + imgTag + '<div class="sp-info"><div class="sp-name">' + escHtml(p.name) + '</div><div class="sp-price">' + (p.price > 0 ? formatPrice(p.price) : 'Miễn phí') + '</div></div><button class="btn btn-red btn-sm" onclick="deleteSellerProduct('' + p.id + '')">🗑️</button></div>';
    }).join('');
  }).catch(function(){});
	}

	function deleteSellerProduct(id) {
	  if (!confirm('Xóa sản phẩm này?')) return;
	  api('delete-product', { productId: id }).then(function() {
	    toast('Đã xóa sản phẩm!');
	    loadSellerProducts();
	    loadProducts();
	  }).catch(function(e) { toast(e.message, true); });
	}

	/* ── Init ── */
	(function init() {
	  var banner = document.getElementById('shopBanner');
	  if (banner) document.body.classList.add('banner-on');
	  loadShopConfig();
	  loadProducts();
	  if (shopToken) {
	    api('config', {}).then(function(){}).catch(function() {
      shopToken = '';
      localStorage.removeItem('shopToken');
    });
	  }
	})();
	