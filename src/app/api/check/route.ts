import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'edge';

// --- Web Crypto and Fetch based Google Sheets API implementation ---
async function getGoogleAccessToken(clientEmail: string, privateKey: string, scope: string): Promise<string> {
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";

  let pemContents = privateKey.trim();
  if (pemContents.startsWith(pemHeader)) {
    pemContents = pemContents.substring(pemHeader.length);
  }
  if (pemContents.endsWith(pemFooter)) {
    pemContents = pemContents.substring(0, pemContents.length - pemFooter.length);
  }
  pemContents = pemContents.replace(/\s+/g, '');

  const binaryDerString = atob(pemContents);
  const binaryDer = new Uint8Array(binaryDerString.length);
  for (let i = 0; i < binaryDerString.length; i++) {
    binaryDer[i] = binaryDerString.charCodeAt(i);
  }

  const importedKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: { name: "SHA-256" },
    },
    false,
    ["sign"]
  );

  const header = {
    alg: "RS256",
    typ: "JWT"
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientEmail,
    scope: scope,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };

  const base64url = (source: string | ArrayBuffer): string => {
    let binary = "";
    if (typeof source === "string") {
      binary = btoa(unescape(encodeURIComponent(source)));
    } else {
      const bytes = new Uint8Array(source);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      binary = btoa(binary);
    }
    return binary.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const tokenInput = `${encodedHeader}.${encodedPayload}`;

  const encoder = new TextEncoder();
  const data = encoder.encode(tokenInput);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    importedKey,
    data
  );

  const encodedSignature = base64url(signature);
  const jwt = `${tokenInput}.${encodedSignature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to get OAuth token: ${response.status} ${errText}`);
  }

  const tokenData = await response.json() as { access_token: string };
  return tokenData.access_token;
}

async function getSpreadsheetValues(accessToken: string, spreadsheetId: string, range: string) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const response = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json"
    }
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google Sheets GET error: ${response.status} ${err}`);
  }
  return await response.json() as { values?: any[][] };
}

async function appendSpreadsheetValues(accessToken: string, spreadsheetId: string, range: string, values: any[][]) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      values: values
    })
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google Sheets APPEND error: ${response.status} ${err}`);
  }
  return await response.json();
}

// ============================================================
// SSRF Protection
//
// 実行環境はCloudflare Pages Functions（Workers/edge runtime）のため、
// Node.jsのdns/netモジュールや「解決済みIPに直接TCP接続する」ことはできない。
// そのため以下の多層防御で対応する：
//   1) スキーム制限（http/https以外を拒否）
//   2) ホスト名がIPリテラルの場合は直接レンジ判定（10進数/16進数/8進数表記の
//      正規化はWHATWG URLパーサーが自動で行うため、URL().hostnameを見れば良い）
//   3) localhost等の既知の内部ホスト名を拒否
//   4) ホスト名の場合はDNS over HTTPS（Cloudflareの1.1.1.1）で事前に名前解決し、
//      解決されたIPがプライベート/予約範囲でないか検証してからfetchする
//   5) redirectは`redirect: 'manual'`で自前ループし、リダイレクト先URLにも
//      毎回1)〜4)を適用する（最大5回）
//   6) AbortControllerで全体に10秒のタイムアウトを設定する
//
// 既知の残課題：4)のDNS事前チェックとfetch本体の間には理論上、DNS rebinding
// （TOCTOU）の窓が残る。fetchを特定の検証済みIPにピン留めする手段がedge
// runtimeには存在しないため、これはプラットフォーム制約として残る。
// ============================================================

const SSRF_ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const SSRF_BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'localhost.localdomain',
    'ip6-localhost',
    'ip6-loopback',
    'metadata.google.internal',
]);
const SSRF_BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];
const SSRF_MAX_REDIRECTS = 5;
const SSRF_FETCH_TIMEOUT_MS = 10_000;

function ssrfIpv4ToInt(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
        if (!/^\d{1,3}$/.test(p)) return null;
        const v = Number(p);
        if (v < 0 || v > 255) return null;
        n = (n << 8) | v;
    }
    return n >>> 0;
}

function ssrfInRangeV4(n: number, base: string, bits: number): boolean {
    const b = ssrfIpv4ToInt(base);
    if (b === null) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (b & mask);
}

function ssrfIsPrivateIPv4(ip: string): boolean {
    const n = ssrfIpv4ToInt(ip);
    if (n === null) return false;
    return (
        ssrfInRangeV4(n, '0.0.0.0', 8) ||
        ssrfInRangeV4(n, '10.0.0.0', 8) ||
        ssrfInRangeV4(n, '100.64.0.0', 10) ||
        ssrfInRangeV4(n, '127.0.0.0', 8) ||
        ssrfInRangeV4(n, '169.254.0.0', 16) || // link-local, incl. cloud metadata 169.254.169.254
        ssrfInRangeV4(n, '172.16.0.0', 12) ||
        ssrfInRangeV4(n, '192.0.0.0', 24) ||
        ssrfInRangeV4(n, '192.0.2.0', 24) ||
        ssrfInRangeV4(n, '192.168.0.0', 16) ||
        ssrfInRangeV4(n, '198.18.0.0', 15) ||
        ssrfInRangeV4(n, '198.51.100.0', 24) ||
        ssrfInRangeV4(n, '203.0.113.0', 24) ||
        ssrfInRangeV4(n, '224.0.0.0', 4) || // multicast
        ssrfInRangeV4(n, '240.0.0.0', 4)    // reserved + broadcast
    );
}

function ssrfParseIPv6(host: string): number[] | null {
    let h = host.toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    const v4Match = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4Match) {
        const v4 = v4Match[1];
        const octets = v4.split('.').map(Number);
        if (octets.some((o) => o < 0 || o > 255 || isNaN(o))) return null;
        const hex = `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
        h = h.slice(0, h.length - v4.length) + hex;
    }
    if (!h.includes(':')) return null;
    const parts = h.split('::');
    if (parts.length > 2) return null;
    const head = parts[0] ? parts[0].split(':').filter(Boolean) : [];
    const tail = parts.length === 2 && parts[1] ? parts[1].split(':').filter(Boolean) : [];
    let groups: string[];
    if (parts.length === 2) {
        const missing = 8 - head.length - tail.length;
        if (missing < 0) return null;
        groups = [...head, ...Array(missing).fill('0'), ...tail];
    } else {
        groups = head;
    }
    if (groups.length !== 8) return null;
    const nums = groups.map((g) => parseInt(g, 16));
    if (nums.some((n) => isNaN(n) || n < 0 || n > 0xffff)) return null;
    return nums;
}

function ssrfIsPrivateIPv6(host: string): boolean {
    const g = ssrfParseIPv6(host);
    if (!g) return false;
    const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
    if (g.every((x) => x === 0)) return true; // ::
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1
    if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
        // ::ffff:0:0/96 IPv4-mapped -> IPv4アドレスとして再検証
        const a = (g6 >> 8) & 0xff, b = g6 & 0xff, c = (g7 >> 8) & 0xff, d = g7 & 0xff;
        if (ssrfIsPrivateIPv4(`${a}.${b}.${c}.${d}`)) return true;
    }
    return false;
}

function ssrfIsBlockedIpLiteral(hostname: string): boolean {
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
        return ssrfIsPrivateIPv6(hostname);
    }
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
        return ssrfIsPrivateIPv4(hostname);
    }
    if (hostname.includes(':')) {
        return ssrfIsPrivateIPv6(hostname);
    }
    return false;
}

function ssrfIsBlockedHostname(hostname: string): boolean {
    const h = hostname.toLowerCase();
    if (SSRF_BLOCKED_HOSTNAMES.has(h)) return true;
    return SSRF_BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

async function ssrfResolveHostnameIPs(hostname: string, signal: AbortSignal): Promise<string[]> {
    const ips: string[] = [];
    for (const type of ['A', 'AAAA']) {
        try {
            const res = await fetch(
                `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
                { headers: { Accept: 'application/dns-json' }, signal }
            );
            if (res.ok) {
                const data: any = await res.json();
                for (const ans of data.Answer || []) {
                    if ((ans.type === 1 || ans.type === 28) && typeof ans.data === 'string') {
                        ips.push(ans.data);
                    }
                }
            }
        } catch (e) {
            // DoH lookup failure for this record type: treated as no results below
        }
    }
    return ips;
}

type SsrfValidation = { ok: true; url: URL } | { ok: false; reason: string };

async function ssrfValidateUrl(rawUrl: string, signal: AbortSignal): Promise<SsrfValidation> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch (e) {
        return { ok: false, reason: 'invalid_url' };
    }
    if (!SSRF_ALLOWED_SCHEMES.has(parsed.protocol)) {
        return { ok: false, reason: 'blocked_scheme' };
    }
    const hostname = parsed.hostname; // IPv6は"[...]"付きで返る
    if (ssrfIsBlockedIpLiteral(hostname)) {
        return { ok: false, reason: 'blocked_ip_literal' };
    }
    if (ssrfIsBlockedHostname(hostname)) {
        return { ok: false, reason: 'blocked_hostname' };
    }
    const isLiteralIp =
        /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) || (hostname.startsWith('[') && hostname.endsWith(']'));
    if (!isLiteralIp) {
        const ips = await ssrfResolveHostnameIPs(hostname, signal);
        if (ips.length === 0) {
            return { ok: false, reason: 'dns_resolution_failed' };
        }
        for (const ip of ips) {
            const blocked = ip.includes(':') ? ssrfIsPrivateIPv6(ip) : ssrfIsPrivateIPv4(ip);
            if (blocked) {
                return { ok: false, reason: 'blocked_resolved_ip' };
            }
        }
    }
    return { ok: true, url: parsed };
}

type SsrfFetchResult =
    | { ok: true; response: Response; finalUrl: string }
    | { ok: false; reason: string; status: number };

// SSRF対策込みの安全なfetch。redirectは手動フォローし、リダイレクト先も毎回検証する。
async function ssrfSafeFetch(initialUrl: string, options: RequestInit): Promise<SsrfFetchResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SSRF_FETCH_TIMEOUT_MS);
    try {
        let currentUrl = initialUrl;
        for (let hop = 0; hop <= SSRF_MAX_REDIRECTS; hop++) {
            const check = await ssrfValidateUrl(currentUrl, controller.signal);
            if (!check.ok) {
                return { ok: false, reason: check.reason, status: 400 };
            }
            const res = await fetch(check.url.toString(), { ...options, redirect: 'manual', signal: controller.signal });
            if (res.status >= 300 && res.status < 400) {
                const location = res.headers.get('location');
                if (!location) {
                    return { ok: false, reason: 'redirect_without_location', status: 502 };
                }
                currentUrl = new URL(location, check.url).toString();
                continue;
            }
            return { ok: true, response: res, finalUrl: check.url.toString() };
        }
        return { ok: false, reason: 'too_many_redirects', status: 508 };
    } catch (e: any) {
        if (e?.name === 'AbortError') {
            return { ok: false, reason: 'timeout', status: 504 };
        }
        return { ok: false, reason: e?.message || 'fetch_failed', status: 502 };
    } finally {
        clearTimeout(timeoutId);
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { url } = body;

        if (!url) {
            return NextResponse.json({ message: 'URL is required' }, { status: 400 });
        }

        // --- Environment Variable Check ---
        const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL?.trim();
        const rawPrivateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY;
        const spreadsheetId = process.env.GOOGLE_SHEET_ID?.trim();

        if (!clientEmail || !rawPrivateKey || !spreadsheetId) {
            console.error('Environment variables missing or incomplete:', {
                hasEmail: !!clientEmail,
                hasKey: !!rawPrivateKey,
                hasId: !!spreadsheetId
            });
            // Proceed anyway if only used for logging, or return error if critical
        }

        // Robust Private Key Handling for Vercel/Environments
        let privateKey = rawPrivateKey || '';
        if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
            privateKey = privateKey.substring(1, privateKey.length - 1);
        }
        privateKey = privateKey.replace(/\\n/g, '\n');
        // ---------------------------------

        // Ensure URL has protocol
        let targetUrl = url.trim();
        if (!targetUrl.startsWith('http')) {
            targetUrl = `https://${targetUrl}`;
        }

        // Normalize URL for cache check AND fetch (Use Origin Only)
        try {
            const urlObj = new URL(targetUrl);
            targetUrl = urlObj.origin;
        } catch (e) {
            return NextResponse.json({ message: 'Invalid URL format' }, { status: 400 });
        }

        const normalizedUrl = targetUrl;

        // --- URL Caching (Check Google Sheet) ---
        try {
            if (clientEmail && privateKey && spreadsheetId) {
                const accessToken = await getGoogleAccessToken(
                    clientEmail,
                    privateKey,
                    'https://www.googleapis.com/auth/spreadsheets'
                );
                const data = await getSpreadsheetValues(accessToken, spreadsheetId, 'ga4checkpro!A:E');
                const rows = data.values || [];
                // Find the LATEST row for this URL (last occurrence)
                const cachedRow = [...rows].reverse().find((rowList: any[]) => {
                    const rowUrl = (rowList[1] || "").replace(/\/$/, "");
                    return rowUrl === normalizedUrl;
                });
                if (cachedRow && !url.includes('cache=clear')) {
                    console.log('Cache Hit for:', normalizedUrl);

                    let details: any = {};
                    try {
                        const detIdx = cachedRow.length > 7 && !isNaN(Number(cachedRow[6])) ? 8 : (cachedRow.length > 5 && !isNaN(Number(cachedRow[4])) ? 6 : 4);
                        const detailsRaw = cachedRow[detIdx] || "{}";
                        details = JSON.parse(detailsRaw);
                    } catch (e) { console.error('Failed to parse cached details', e); }

                    // Cache Invalidation for new fields (CoMo v2, All IDs, Obfuscation, CMP)
                    if (details.has_como_v2 === undefined || details.all_ga4_ids === undefined || details.has_obfuscated_loader === undefined || details.has_cmp === undefined || details.logic_version === undefined) {
                        console.log('Cache Invalidation: Missing new fields including has_cmp');
                    } else {
                        // Intelligent column detection due to misalignment history
                        let scoreIdx = 2; // Default Column C
                        let msgIdx = 3;   // Default Column D

                        if (cachedRow.length > 7 && !isNaN(Number(cachedRow[6]))) {
                            scoreIdx = 6; msgIdx = 7;
                        } else if (cachedRow.length > 5 && !isNaN(Number(cachedRow[4]))) {
                            scoreIdx = 4; msgIdx = 5;
                        }

                        return NextResponse.json({
                            score: Number(cachedRow[scoreIdx]),
                            message: cachedRow[msgIdx] || "",
                            details: {
                                ...details,
                                visited_url: cachedRow[1]
                            }
                        });
                    }
                }
            }
        } catch (e: any) {
            console.error('Cache check failed:', e?.message);
        }
        // ------------------------

        try {
            const ssrfResult = await ssrfSafeFetch(targetUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'max-age=0',
                    'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
                    'Sec-Ch-Ua-Mobile': '?0',
                    'Sec-Ch-Ua-Platform': '"Windows"',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1'
                },
            });

            if (!ssrfResult.ok) {
                if (ssrfResult.reason === 'timeout') {
                    return NextResponse.json({ message: 'サイトの応答がタイムアウトしました。時間をおいて再度お試しください。' }, { status: ssrfResult.status });
                }
                if (ssrfResult.reason.startsWith('blocked_') || ssrfResult.reason === 'invalid_url') {
                    return NextResponse.json({ message: '入力いただいたURLは診断対象外です。別のURLをお試しください。' }, { status: ssrfResult.status });
                }
                return NextResponse.json({ message: `Failed to fetch URL: ${ssrfResult.reason}` }, { status: ssrfResult.status });
            }

            const fetchRes = ssrfResult.response;

            if (!fetchRes.ok) {
                if (fetchRes.status === 403) {
                    const statusMessage = `入力いただいたサイトは計測対象外です、詳しくは下記よりお問い合わせください`;

                    // Log to Sheets even for 403
                    try {
                        if (clientEmail && privateKey && spreadsheetId) {
                            const accessToken = await getGoogleAccessToken(
                                clientEmail,
                                privateKey,
                                'https://www.googleapis.com/auth/spreadsheets'
                            );
                            const timestamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
                            await appendSpreadsheetValues(
                                accessToken,
                                spreadsheetId,
                                'ga4checkpro!A1',
                                [[timestamp, targetUrl, 0, statusMessage, JSON.stringify({ error: '403 Forbidden', is_sgtm: false })]]
                            );
                        }
                    } catch (logErr) { }

                    return NextResponse.json({ message: statusMessage }, { status: 403 });
                }
                return NextResponse.json({ message: `Failed to fetch URL: ${fetchRes.statusText}` }, { status: fetchRes.status });
            }

            const html = await fetchRes.text();
            const ga4Regex = /G-[A-Z0-9]{10,}/g;
            const gtmRegex = /GTM-[A-Z0-9]{6,}/g;
            const uaRegex = /UA-[0-9]+-[0-9]+/g;

            // --- Tracking ID Extraction ---
            const ga4MatchesHtml = Array.from(new Set(html.match(ga4Regex) || []));
            const gtmMatchesHtml = Array.from(new Set(html.match(gtmRegex) || []));
            const uaMatchesHtml = Array.from(new Set(html.match(uaRegex) || []));

            // --- Base64 Tracking ID Extraction ---
            const base64Pattern = /[a-zA-Z0-9+/]{20,}/g;
            const potentialBase64 = html.match(base64Pattern) || [];
            const decodedGtmIds: string[] = [];
            for (const str of potentialBase64) {
                try {
                    const decoded = atob(str);
                    const deepGtm = decoded.match(/GTM-[A-Z0-9]{6,}/g);
                    if (deepGtm) decodedGtmIds.push(...deepGtm);
                } catch (e) { }
            }

            const uniqueGtmIds = Array.from(new Set([...gtmMatchesHtml, ...decodedGtmIds]));
            const hostname = new URL(targetUrl).hostname;
            const rootDomain = hostname.split('.').slice(-2).join('.');
            const rootDomainEscaped = rootDomain.replace(/\./g, '\\.');

            let hasComoV2 = html.includes('gcd=') ||
                            html.includes('gcs=') ||
                            html.includes('gtag("consent"') ||
                            html.includes("gtag('consent'");
            let isSgtm = false;
            let hasObfuscatedLoader = false;

            // --- Custom Loader / Obfuscation Detection ---
            // Check for dataLayer init but missing standard GTM, or stape domain, or custom js?id= loaders
            const hasDataLayerInit = html.includes('window.dataLayer') || html.includes('window["dataLayer"]');
            const hasStape = html.includes('.stape.') || html.includes('/stape/');

            // Match custom GTM loader patterns (e.g., fetching a JS file that looks like a tag manager but not from official domains)
            // Example: <script src="https://custom.domain.com/js?id=GTM-XXXXX"></script> where domain is NOT googletagmanager.com
            const customLoaderRegex = /src=["']https?:\/\/(?!www\.googletagmanager\.com)[^"']+\/(gtm\.js|js\?id=|gtag\/js)/i;
            const hasCustomLoaderScript = customLoaderRegex.test(html);

            // 公式googletagmanager.comからのgtag.js配信があれば、dataLayerの存在は説明が付く
            // （GTM不使用・gtag.js単体実装との構造的な誤検知を避けるための除外条件。第3弾修正）
            const hasOfficialGtag = /googletagmanager\.com\/gtag\/js/i.test(html);

            // If dataLayer is initialized but no standard GTM ID is found directly, or if specific patterns match
            if (hasStape || hasCustomLoaderScript || (hasDataLayerInit && uniqueGtmIds.length === 0 && !hasOfficialGtag)) {
                hasObfuscatedLoader = true;
            }

            // --- CMP (Consent Management Platform) Detection ---
            const cmpPatterns = [
                'cdn-cookieyes.com',   // CookieYes (current script domain per official docs)
                'cdn.cookieyes.com',   // CookieYes (legacy/alternate domain, kept for backward compat)
                'cdn.cookielaw.org',   // OneTrust
                'consent.cookiebot.com',
                'app.termly.io',
                'optanon',             // OneTrust alternative
                'didomi.io',
                'usercentrics.eu',
                'consent.trustarc.com',
                'osano.com',
                'iubenda.com'
            ];
            const hasCmp = cmpPatterns.some(pattern => html.includes(pattern));

            let containerSignalsFound = false;
            const ga4IdsFromContainers: string[] = [];
            const uaIdsFromContainers: string[] = [];

            // --- LINE Tag (ltag.js) Detection Patterns ---
            // Verified 2026-07 against LINE Yahoo for Business official docs / base code:
            // - Base code script is delivered from https://d.line-scdn.net (or http://d.line-cdn.net)
            //   at path /n/line_tag/public/release/v1/lt.js
            // - Initialization call is _lt('init', { tagId: '<uuid>' })
            // - tagId follows UUID format (8-4-4-4-12 hex)
            const lineTagScriptRegex = /https?:\/\/d\.line-(?:scdn|cdn)\.net\/n\/line_tag\//i;
            const lineTagInitRegex = /_lt\(\s*['"]init['"]/;
            const lineTagIdRegex = /tagId\s*:\s*['"][0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}['"]/;
            const isLineTagPresent = (text: string) =>
                lineTagScriptRegex.test(text) || lineTagInitRegex.test(text) || lineTagIdRegex.test(text);

            // --- 1st Party Data Sender (CAPI) Detection ---
            // 「確定(detected)」と「推定シグナル(signal)」を内部的に分離する。
            // has_fbp_fbc等の *_signal / has_* 系フィールドは既存互換のため残すが、
            // is_detected（スコアとUIの「導入の可能性大」表示に使われる）は、
            // 実際にCAPI/サーバーサイド送信を示す明確なシグナルがある場合のみtrueにする。
            const capiData = {
                meta: {
                    // _fbp/_fbcはMeta Pixel単体でも一般的に付与されるため、
                    // これ単独ではCAPI(サーバーサイド送信)の確定材料にしない。
                    has_fbp_fbc: html.includes('_fbp') || html.includes('_fbc'),
                    has_meta_signal: html.includes('_fbp') || html.includes('_fbc'),
                    // Meta CAPI固有の通信/設定シグナル（現状のスキャン範囲では未検出のため常にfalse。
                    // 将来、Meta Conversions API Gateway等の固有シグナルを追加検出できるまでの暫定値）。
                    meta_capi_signal: false,
                    is_detected: false
                },
                google: {
                    // server_container_url / *.rootDomain/g/collect のようなサブドメイン型
                    // サーバーコンテナのシグナル。「確実に導入されている」ではなく
                    // 「Google server-side送信のシグナルが検出された」という位置づけ。
                    has_custom_domain: false,
                    is_detected: false
                },
                tiktok: {
                    // external_idは汎用的な文字列のため単独では検出材料にしない。
                    has_external_id: html.includes('external_id'),
                    has_event_id: false,
                    is_detected: false
                },
                line: {
                    // LINE Tagの存在そのもの（表示用）。CAPI/サーバーサイド送信とは別概念。
                    tag_detected: isLineTagPresent(html),
                    // LINE Tag単独ではサーバーサイド/1st Party Data Senderの確定材料にしない
                    // （現状のスキャン範囲ではLINE固有のサーバーサイド送信シグナルは未検出）。
                    is_detected: false
                }
            };

            // --- Deep Scan of GTM Container ---
            for (const id of uniqueGtmIds) {
                try {
                    const gtmRes = await fetch(`https://www.googletagmanager.com/gtm.js?id=${id}`, {
                        headers: { 'User-Agent': 'Mozilla/5.0' },
                        next: { revalidate: 3600 }
                    });
                    if (gtmRes.ok) {
                        const gtmJs = await gtmRes.text();

                        // Look for other IDs inside GTM
                        const innerGa4 = gtmJs.match(/G-[A-Z0-9]{10,}/g) || [];
                        const innerUa = gtmJs.match(/UA-[0-9]+-[0-9]+/g) || [];
                        ga4IdsFromContainers.push(...innerGa4);
                        uaIdsFromContainers.push(...innerUa);

                        // CoMo v2 / gcd signal in GTM (Strict matching)
                        if (gtmJs.includes('gcd=') ||
                            gtmJs.includes('gcd:') ||
                            gtmJs.includes('"gcd"')) {
                            hasComoV2 = true;
                        }

                        // CAPI Signals in GTM (Strict matching)
                        if (gtmJs.includes('_fbp') || gtmJs.includes('_fbc')) {
                            capiData.meta.has_fbp_fbc = true;
                            capiData.meta.has_meta_signal = true;
                        }
                        if (gtmJs.includes('external_id')) capiData.tiktok.has_external_id = true;
                        if (gtmJs.includes('tt_pixel_id')) capiData.tiktok.has_event_id = true;
                        if (isLineTagPresent(gtmJs)) capiData.line.tag_detected = true;

                        // sGTM detect: only flag has_custom_domain if server_container_url or /g/collect
                        // explicitly points to a subdomain of the site's root domain
                        const sGtmUrlPattern = new RegExp(`server_container_url["']?\\s*[:,]\\s*["']https?://([^/"']+)`, 'i');
                        const collectUrlPattern = new RegExp(`https?://([^/"'\\s]+)/g/collect`, 'gi');

                        const sGtmUrlMatch = gtmJs.match(sGtmUrlPattern);
                        if (sGtmUrlMatch) {
                            const urlHost = sGtmUrlMatch[1].toLowerCase().split(':')[0]; // strip port
                            if (urlHost.endsWith('.' + rootDomain) && urlHost !== hostname) {
                                containerSignalsFound = true;
                                capiData.google.has_custom_domain = true;
                            }
                        }

                        const collectMatches = [...gtmJs.matchAll(collectUrlPattern)];
                        for (const m of collectMatches) {
                            const urlHost = m[1].toLowerCase().split(':')[0]; // strip port
                            if (urlHost.endsWith('.' + rootDomain) && urlHost !== hostname) {
                                containerSignalsFound = true;
                                capiData.google.has_custom_domain = true;
                                break;
                            }
                        }
                    }
                } catch (e) { }
                if (containerSignalsFound && capiData.tiktok.has_event_id) break;
            }

            // --- Deep Scan for GA4 Scripts (gtag.js) ---
            const allGa4Ids = Array.from(new Set([...ga4MatchesHtml, ...ga4IdsFromContainers]));
            for (const ga4Id of allGa4Ids) {
                try {
                    const gtagRes = await fetch(`https://www.googletagmanager.com/gtag/js?id=${ga4Id}`, {
                        headers: { 'User-Agent': 'Mozilla/5.0' },
                        next: { revalidate: 3600 }
                    });
                    if (gtagRes.ok) {
                        const gtagJs = await gtagRes.text();
                        if (gtagJs.includes('gcd=') ||
                            gtagJs.includes('gcd:') ||
                            gtagJs.includes('"gcd"')) {
                            hasComoV2 = true;
                        }
                        // (Removed loose check for 'event_id' and '_gcl_au' in gtag.js to prevent false positives)
                    }
                } catch (e) {}
            }
            // Meta: has_fbp_fbc(Pixel単体でも付与されうる)単独ではdetectedにしない。
            // meta_capi_signal(CAPI固有の通信/設定シグナル)が立った場合のみdetectedとする。
            // 現状のスキャン範囲ではmeta_capi_signalを検出できないため、実質的に
            // 誤検出（Pixelのみをサーバーサイド送信と誤認）を防ぐ形になる。
            capiData.meta.is_detected = capiData.meta.meta_capi_signal;
            // Google: サブドメイン型サーバーコンテナのシグナル検出。「確実な導入」ではなく
            // 「signal detected」という位置づけだが、既存の値・挙動は変更しない。
            capiData.google.is_detected = capiData.google.has_custom_domain;
            // TikTok: external_idは汎用的な文字列のため単独では検出材料にしない。
            // TikTok固有のtt_pixel_idシグナルと組み合わさって初めて「可能性あり」とする。
            capiData.tiktok.is_detected = capiData.tiktok.has_event_id && capiData.tiktok.has_external_id;
            // LINE: Tagの存在(tag_detected)と1st Party Data Sender(is_detected)は別概念。
            // 現状のスキャン範囲ではLINE固有のサーバーサイド送信シグナルを検出できないため、
            // Tagが存在してもis_detectedはfalseのままとする（スコアを4に引き上げない）。

            // --- Decision Logic ---
            const hasGa4Direct = ga4MatchesHtml.length > 0;
            const hasGa4Gtm = ga4IdsFromContainers.length > 0;
            const hasGtm = uniqueGtmIds.length > 0;
            const allUaIds = Array.from(new Set([...uaMatchesHtml, ...uaIdsFromContainers]));
            const hasUa = allUaIds.length > 0;

            if (containerSignalsFound) {
                isSgtm = true;
            }

            let score = 2;
            let statusMessage = "GA4の導入が検出されませんでした。";

            if (isSgtm) {
                score = 4;
                statusMessage = "高度な/サーバーサイド実装（sGTM / Google Tag Gateway）が検出されました。計測欠損が最小限に抑えられている可能性があります。";
            } else if (hasGa4Direct || hasGa4Gtm || hasGtm) {
                score = 3;
                statusMessage = "標準的なGA4またはGTMの導入が検出されました。\nSafariからの流入で40%機会損失している可能性があります。";
            }

            // If CAPI is detected for any platform, ensure score is at least 4
            if (capiData.meta.is_detected || capiData.google.is_detected || capiData.tiktok.is_detected || capiData.line.is_detected) {
                if (score < 4) {
                    score = 4;
                    statusMessage = "1st Party Data Sender (CAPI / sGTM) の導入が検出されました。計測欠損が最小限に抑えられている可能性があります。";
                }
            }

            // --- Universal Analytics Warning ---
            if (hasUa) {
                statusMessage += "\nUAのタグが残っています。もしくはUAの計測IDでGA4を計測しています";
            }

            const isComoMisconfigured = hasComoV2 && !hasCmp;

            // --- Logging to Google Sheets ---
            try {
                if (clientEmail && privateKey && spreadsheetId) {
                    const accessToken = await getGoogleAccessToken(
                        clientEmail,
                        privateKey,
                        'https://www.googleapis.com/auth/spreadsheets'
                    );
                    const timestamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
                    const detailsJson = JSON.stringify({
                        has_ga4_direct: hasGa4Direct,
                        has_ga4_gtm: hasGa4Gtm,
                        has_gtm: hasGtm,
                        has_ua: hasUa,
                        ga4_id: allGa4Ids[0] || null,
                        all_ga4_ids: allGa4Ids,
                        gtm_id: uniqueGtmIds[0] || null,
                        all_gtm_ids: uniqueGtmIds,
                        ua_id: allUaIds[0] || null,
                        all_ua_ids: allUaIds,
                        is_sgtm: isSgtm,
                        has_obfuscated_loader: hasObfuscatedLoader,
                        has_cmp: hasCmp,
                        is_como_misconfigured: isComoMisconfigured,
                        has_como_v2: hasComoV2,
                        capi_data: capiData,
                        logic_version: 3
                    });

                    await appendSpreadsheetValues(
                        accessToken,
                        spreadsheetId,
                        'ga4checkpro!A1',
                        [[timestamp, targetUrl, score, statusMessage, detailsJson]]
                    );
                }
            } catch (logError: any) {
                console.error('Google Sheets Logging Error:', logError);
            }
            // --------------------------------

            return NextResponse.json({
                score,
                details: {
                    has_ga4_direct: hasGa4Direct,
                    has_ga4_gtm: hasGa4Gtm,
                    has_gtm: hasGtm,
                    has_ua: hasUa,
                    ga4_id: allGa4Ids[0] || null,
                    all_ga4_ids: allGa4Ids,
                    gtm_id: uniqueGtmIds[0] || null,
                    all_gtm_ids: uniqueGtmIds,
                    ua_id: allUaIds[0] || null,
                    all_ua_ids: allUaIds,
                    is_sgtm: isSgtm,
                    has_obfuscated_loader: hasObfuscatedLoader,
                    has_cmp: hasCmp,
                    is_como_misconfigured: isComoMisconfigured,
                    has_como_v2: hasComoV2,
                    visited_url: targetUrl,
                    capi_data: capiData,
                    logic_version: 3
                },
                message: statusMessage
            });

        } catch (error: any) {
            return NextResponse.json({ message: `Error fetching URL: ${error.message}` }, { status: 500 });
        }

    } catch (error) {
        console.error('Fatal API Error:', error);
        return NextResponse.json({ message: 'Internal Server Error' }, { status: 500 });
    }
}
