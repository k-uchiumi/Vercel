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
                    if (details.has_como_v2 === undefined || details.all_ga4_ids === undefined || details.has_obfuscated_loader === undefined || details.has_cmp === undefined) {
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
            const fetchRes = await fetch(targetUrl, {
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
                redirect: 'follow',
            });

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
            
            // If dataLayer is initialized but no standard GTM ID is found directly, or if specific patterns match
            if (hasStape || hasCustomLoaderScript || (hasDataLayerInit && uniqueGtmIds.length === 0)) {
                hasObfuscatedLoader = true;
            }

            // --- CMP (Consent Management Platform) Detection ---
            const cmpPatterns = [
                'cdn.cookieyes.com',
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
            const capiData = {
                meta: {
                    has_fbp_fbc: html.includes('_fbp') || html.includes('_fbc'),
                    is_detected: false
                },
                google: {
                    has_custom_domain: false,
                    is_detected: false
                },
                tiktok: {
                    has_external_id: html.includes('external_id'),
                    has_event_id: false,
                    is_detected: false
                },
                line: {
                    is_detected: isLineTagPresent(html)
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
                        if (gtmJs.includes('_fbp') || gtmJs.includes('_fbc')) capiData.meta.has_fbp_fbc = true;
                        if (gtmJs.includes('external_id')) capiData.tiktok.has_external_id = true;
                        if (gtmJs.includes('tt_pixel_id')) capiData.tiktok.has_event_id = true;
                        if (isLineTagPresent(gtmJs)) capiData.line.is_detected = true;

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
            capiData.meta.is_detected = capiData.meta.has_fbp_fbc && containerSignalsFound;
            capiData.google.is_detected = capiData.google.has_custom_domain;
            capiData.tiktok.is_detected = capiData.tiktok.has_event_id || capiData.tiktok.has_external_id;
            // capiData.line.is_detected is already set via isLineTagPresent() above

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
                        capi_data: capiData
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
                    capi_data: capiData
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

