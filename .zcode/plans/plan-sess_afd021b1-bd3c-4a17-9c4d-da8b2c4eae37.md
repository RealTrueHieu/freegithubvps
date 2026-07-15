# Kế hoạch: Tách biệt Deploy VPS & Shop

## Tổng quan
- **Main page**: 2 tab riêng biệt — Tab "Deploy" (tạo máy VPS) và Tab "Shop" (quảng cáo, logo, bank info)
- **shop.trueteamcommunity.dpdns.org**: Seller quản lý nội dung shop (upload logo, QR code, bank info) — lưu R2
- **Admin**: Thêm quyền set role `seller` cho user

---

## Bước 1: Sửa Main Page — Thêm Tab Deploy / Shop

### UI thay đổi
- Thêm segmented control (tab bar) ngay dưới header: **[ Deploy ] [ Shop ]**
- **Tab Deploy**: Giống main page hiện tại (bỏ shop card, bỏ credits display)
- **Tab Shop**: 
  - Banner quảng cáo chạy ngang (tách biệt với banner top)
  - Logo shop (lấy từ R2: `shop-logo.png`)
  - Thông tin ngân hàng: STK, ngân hàng, chủ tk (lấy từ KV config)
  - QR Code (lấy từ R2: `shop-qr.png`)
  - Credits balance (chỉ hiển thị, ko mua bán)

### Backend API mới
- `/api/shop-config` — GET: trả về config shop (logo URL, QR URL, bank info từ KV+R2)
- Lưu config vào KV: `config:shop_bank_name`, `config:shop_bank_account`, `config:shop_bank_holder`

---

## Bước 2: Tạo Seller Subdomain + Shop Dashboard

### wrangler.toml
```toml
routes = [
  { pattern = "trueteamcommunity.dpdns.org/*", zone_name = "dpdns.org" },
  { pattern = "admin.trueteamcommunity.dpdns.org/*", zone_name = "dpdns.org" },
  { pattern = "shop.trueteamcommunity.dpdns.org/*", zone_name = "dpdns.org" }
]
```

### worker.js fetch handler
- `shop.` subdomain → serve `SHOP_HTML` + `/api/shop/*` routing

### SHOP_HTML (giao diện seller)
- **Login**: email + password → check role = seller hoặc owner
- **Dashboard sau login**:
  1. **Logo**: Upload ảnh → lưu xuống R2 bucket `shop-logo.png`
  2. **QR Code**: Upload ảnh → lưu xuống R2 bucket `shop-qr.png`
  3. **Bank Info**: Form nhập (tên ngân hàng, số tài khoản, chủ tài khoản)
  4. **Preview**: Xem trước Shop tab sẽ hiển thị như thế nào

### API Shop Backend
- `/api/shop/login` — check role seller/owner, tạo session
- `/api/shop/upload-logo` — upload file → R2
- `/api/shop/upload-qr` — upload file → R2
- `/api/shop/save-bank-info` — lưu vào KV
- `/api/shop/config` — GET config hiện tại

---

## Bước 3: Admin — Role Management

- Users tab: Thêm cột Role (user/seller/owner) — data `role` đã có sẵn
- Nút "Set Seller" → gọi `/api/admin/set-role`
- API mới: `POST /api/admin/set-role` { email, role }

---

## Bước 4: Xoá Shop Card cũ & Credits khỏi User Page

- Xoá shopCard HTML, JS shop functions khỏi HTML_CONTENT
- Xoá `/api/buy-extension` khỏi user API routing (giữ backend function cho seller dùng)
- Xoá credits display khỏi auth flow

---

## Thứ tự làm

1. Cập nhật wrangler.toml route + fetch handler routing
2. Thêm admin set-role API + UI
3. Xoá shop card cũ, credits hiển thị
4. Thêm tab Deploy/Shop trên main page
5. Tạo SHOP_HTML + seller API
6. Xử lý upload R2 cho logo + QR
7. Deploy

## Files thay đổi
- `src/worker.js` — Routing, Admin, Main page tabs, SHOP_HTML, Shop API
- `wrangler.toml` — Thêm route shop.
