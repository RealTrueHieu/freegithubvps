// ============================================================
// TrueTeam Cloud — Cloudflare Worker (rework 2026-09-18)
// Entry gon: router + serve frontend. Logic API nam o:
//   src/modes.js, src/lib/*, src/api/{user,admin,shop}.js
// Frontend (da Viet hoa) nam o frontend/pages/*.
// ============================================================

import COMMUNITY_ART from '../frontend/assets/community-art.webp';
import MAIN_HEAD from '../frontend/pages/main-head.html';
import CONSOLE_SHELL from '../frontend/pages/console-shell.html';
import MAIN_APP_JS from '../frontend/pages/main-app.txt';
import ADMIN_HTML from '../frontend/pages/admin.html';
import SHOP_HTML from '../frontend/pages/shop.html';

import { handleAPI } from './api/user.js';
import { handleAdminAPI } from './api/admin.js';
import { handleShopAPI } from './api/shop.js';
import { cleanupExpiredMachines } from './lib/db.js';
import { isPublicMediaKey, publicMediaType } from './lib/r2media.js';

// Web chinh = <head>+CSS (main-head, ket thuc bang <body>)
//   + body (console-shell) + JS (main-app) + dong html.
const MAIN_HTML =
  MAIN_HEAD + CONSOLE_SHELL + '<script>' + MAIN_APP_JS + '</script></body></html>';

function jsonResponse(data, corsHeaders, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function apiErrorResponse(err, corsHeaders) {
  const message = (err && err.message) ? err.message : 'Loi khong xac dinh';
  const status = message === 'Unauthorized' ? 401 : 400;
  return jsonResponse({ error: message }, corsHeaders, status);
}

export default {
  // Cron Trigger: tu dong xoa may het han (chay moi 30 phut)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupExpiredMachines(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const hostname = url.hostname;
    const isAdminSubdomain = hostname.startsWith('admin.');
    const isShopSubdomain = hostname.startsWith('shop.');

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === '/assets/community-art.webp') {
      return new Response(COMMUNITY_ART, {
        headers: {
          'Content-Type': 'image/webp',
          'Cache-Control': 'public, max-age=604800, immutable',
        },
      });
    }

    // R2 file proxy: /r2/<key> -> TOKENS_R2
    if (url.pathname.startsWith('/r2/')) {
      const key = url.pathname.slice('/r2/'.length);
      if (!key || !isPublicMediaKey(key)) return new Response('Not found', { status: 404 });
      const obj = await env.TOKENS_R2.get(key).catch(() => null);
      if (!obj) return new Response('Not found', { status: 404 });
      const headers = {
        'Content-Type': publicMediaType(key, obj.httpMetadata?.contentType),
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        ...corsHeaders,
      };
      if (obj.httpEtag) headers.ETag = obj.httpEtag;
      return new Response(obj.body, { headers });
    }

    // Shop subdomain: API + HTML.
    // (Khong rewrite blind: path da co prefix /api/shop/ thi giu nguyen.)
    if (isShopSubdomain && url.pathname.startsWith('/api/')) {
      try {
        const apiPath = url.pathname.startsWith('/api/shop/')
          ? url.pathname
          : url.pathname.replace('/api/', '/api/shop/');
        const result = await handleShopAPI(apiPath, request, env);
        return jsonResponse(result, corsHeaders);
      } catch (err) {
        return apiErrorResponse(err, corsHeaders);
      }
    }
    if (isShopSubdomain) {
      return new Response(SHOP_HTML, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    // Admin API: /api/admin/*, hoac /api/* tren host admin.* (co guard double-prefix).
    if (url.pathname.startsWith('/api/admin/') || (isAdminSubdomain && url.pathname.startsWith('/api/'))) {
      try {
        const apiPath = isAdminSubdomain && !url.pathname.startsWith('/api/admin/')
          ? url.pathname.replace('/api/', '/api/admin/')
          : url.pathname;
        const result = await handleAdminAPI(apiPath, request, env);
        return jsonResponse(result, corsHeaders);
      } catch (err) {
        return apiErrorResponse(err, corsHeaders);
      }
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        const result = await handleAPI(url.pathname, request, env);
        return jsonResponse(result, corsHeaders);
      } catch (err) {
        return apiErrorResponse(err, corsHeaders);
      }
    }

    if (url.pathname === '/admin' || isAdminSubdomain) {
      return new Response(ADMIN_HTML, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    return new Response(MAIN_HTML, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' },
    });
  },
};
