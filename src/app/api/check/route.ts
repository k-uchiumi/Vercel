import { NextResponse } from 'next/server';
import { google } from 'googleapis';

export const dynamic = 'force-dynamic';

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
                const auth = new google.auth.GoogleAuth({
                    credentials: {
                        client_email: clientEmail,
                        private_key: privateKey,
                    },
                    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
                });
                const sheets = google.sheets({ version: 'v4', auth });

                const response = await sheets.spreadsheets.values.get({
                    spreadsheetId,
                    range: 'ga4checkpro!A:E',
                });

                const rows = response.data.values || [];
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
                            const auth = new google.auth.GoogleAuth({
                                credentials: { client_email: clientEmail, private_key: privateKey },
                                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
                            });
                            const sheets = google.sheets({ version: 'v4', auth });
                            const timestamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
                            await sheets.spreadsheets.values.append({
                                spreadsheetId,
                                range: 'ga4checkpro!A1',
                                valueInputOption: 'USER_ENTERED',
                                requestBody: {
                                    values: [[timestamp, targetUrl, 0, statusMessage, JSON.stringify({ error: '403 Forbidden', is_sgtm: false })]],
                                },
                            });
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
                            html.includes("gtag('consent'") || 
                            html.includes('gtm.init_consent') ||
                            html.includes('/g/collect');
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

            // --- 1st Party Data Sender (CAPI) Detection ---
            const capiData = {
                meta: {
                    has_event_id: html.includes('event_id') || html.includes('eid'),
                    has_fbp_fbc: html.includes('_fbp') || html.includes('_fbc'),
                    is_detected: false
                },
                google: {
                    has_gcl_au: html.includes('_gcl_au'),
                    has_custom_domain: false,
                    has_enhanced: html.includes('hashed_email') || html.includes('em'),
                    is_detected: false
                },
                tiktok: {
                    has_external_id: html.includes('external_id'),
                    has_event_id: html.includes('tt_pixel_id') && html.includes('event_id'),
                    is_detected: false
                },
                line: {
                    has_ifa_cl_id: html.includes('ifa') || html.includes('cl_id'),
                    has_line_id: html.includes('_line_id'),
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

                        // CoMo v2 / gcd signal in GTM
                        if (gtmJs.includes('gcd=') || 
                            gtmJs.includes('gcd:') || 
                            gtmJs.includes('"gcd"') ||
                            gtmJs.includes('gtm.init_consent') ||
                            gtmJs.includes('vtp_migratedToV2') ||
                            gtmJs.includes('consent_mode') ||
                            gtmJs.includes('/g/collect')) {
                            hasComoV2 = true;
                        }

                        // CAPI Signals in GTM
                        if (gtmJs.includes('event_id') || gtmJs.includes('eid')) capiData.meta.has_event_id = true;
                        if (gtmJs.includes('_fbp') || gtmJs.includes('_fbc')) capiData.meta.has_fbp_fbc = true;
                        if (gtmJs.includes('_gcl_au')) capiData.google.has_gcl_au = true;
                        if (gtmJs.includes('hashed_email') || gtmJs.includes('em')) capiData.google.has_enhanced = true;
                        if (gtmJs.includes('external_id')) capiData.tiktok.has_external_id = true;
                        if (gtmJs.includes('tt_pixel_id') && gtmJs.includes('event_id')) capiData.tiktok.has_event_id = true;
                        if (gtmJs.includes('ifa') || gtmJs.includes('cl_id')) capiData.line.has_ifa_cl_id = true;
                        if (gtmJs.includes('_line_id')) capiData.line.has_line_id = true;

                        // Strict same-root-domain signal checking
                        const firstPartyPattern = new RegExp(`[a-zA-Z0-9.-]+\\.${rootDomainEscaped}`, 'i');
                        if (firstPartyPattern.test(gtmJs)) {
                            const subdomains = gtmJs.match(new RegExp(`[a-zA-Z0-9.-]+\\.${rootDomainEscaped}`, 'gi')) || [];
                            for (const sub of subdomains) {
                                if (sub !== hostname) {
                                    containerSignalsFound = true;
                                    capiData.google.has_custom_domain = true;
                                    break;
                                }
                            }
                        }

                        if (gtmJs.includes('server_container_url') || gtmJs.includes('/g/collect')) {
                            const sGtmValuePattern = new RegExp(`server_container_url["']?\\s*[:,]\\s*["']([^"']+)["']`, 'i');
                            const collectValuePattern = new RegExp(`["']?([^"']+)["']?\\/g\\/collect`, 'i');

                            const sGtmMatch = gtmJs.match(sGtmValuePattern);
                            const collectMatch = gtmJs.match(collectValuePattern);

                            if (sGtmMatch) {
                                const urlPart = sGtmMatch[1];
                                if (urlPart.includes(rootDomain) && !urlPart.includes(hostname)) {
                                    containerSignalsFound = true;
                                    capiData.google.has_custom_domain = true;
                                }
                            }
                            if (collectMatch) {
                                const urlPart = collectMatch[1];
                                if (urlPart.includes(rootDomain) && !urlPart.includes(hostname) && !urlPart.includes('google-analytics.com')) {
                                    containerSignalsFound = true;
                                    capiData.google.has_custom_domain = true;
                                }
                            }
                        }
                    }
                } catch (e) { }
                if (containerSignalsFound && capiData.meta.has_event_id && capiData.tiktok.has_event_id) break;
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
                            gtagJs.includes('"gcd"') ||
                            gtagJs.includes('gtm.init_consent') ||
                            gtagJs.includes('vtp_migratedToV2') ||
                            gtagJs.includes('consent_mode') ||
                            gtagJs.includes('/g/collect')) {
                            hasComoV2 = true;
                        }
                        // Also check for CAPI signals in gtag.js
                        if (gtagJs.includes('event_id') || gtagJs.includes('eid')) capiData.meta.has_event_id = true;
                        if (gtagJs.includes('_gcl_au')) capiData.google.has_gcl_au = true;
                    }
                } catch (e) {}
            }
            capiData.meta.is_detected = capiData.meta.has_event_id || (capiData.meta.has_fbp_fbc && containerSignalsFound);
            capiData.google.is_detected = capiData.google.has_custom_domain || (capiData.google.has_gcl_au && capiData.google.has_enhanced);
            capiData.tiktok.is_detected = capiData.tiktok.has_event_id || capiData.tiktok.has_external_id;
            capiData.line.is_detected = capiData.line.has_ifa_cl_id || capiData.line.has_line_id;

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
                    const auth = new google.auth.GoogleAuth({
                        credentials: {
                            client_email: clientEmail,
                            private_key: privateKey,
                        },
                        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
                    });

                    const sheets = google.sheets({ version: 'v4', auth });
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

                    await sheets.spreadsheets.values.append({
                        spreadsheetId,
                        range: 'ga4checkpro!A1',
                        valueInputOption: 'USER_ENTERED',
                        requestBody: {
                            values: [
                                [timestamp, targetUrl, score, statusMessage, detailsJson]
                            ],
                        },
                    });
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

