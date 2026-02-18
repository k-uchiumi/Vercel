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

                    // Intelligent column detection due to misalignment history
                    let scoreIdx = 2; // Default Column C
                    let msgIdx = 3;   // Default Column D
                    let detIdx = 4;   // Default Column E

                    if (cachedRow.length > 7 && !isNaN(Number(cachedRow[6]))) {
                        scoreIdx = 6; msgIdx = 7; detIdx = 8; // Shifted Structure
                    } else if (cachedRow.length > 5 && !isNaN(Number(cachedRow[4]))) {
                        scoreIdx = 4; msgIdx = 5; detIdx = 6; // Partial Shift
                    }

                    let details = {};
                    try {
                        const detailsRaw = cachedRow[detIdx] || "{}";
                        details = JSON.parse(detailsRaw);
                    } catch (e) { console.error('Failed to parse cached details', e); }

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

            let isSgtm = false;
            let containerSignalsFound = false;
            const ga4IdsFromContainers: string[] = [];
            const uaIdsFromContainers: string[] = [];

            // --- Deep Scan of GTM Container (Score 4 Criteria) ---
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

                        // Strict same-root-domain signal checking
                        const firstPartyPattern = new RegExp(`[a-zA-Z0-9.-]+\\.${rootDomainEscaped}`, 'i');
                        if (firstPartyPattern.test(gtmJs)) {
                            const subdomains = gtmJs.match(new RegExp(`[a-zA-Z0-9.-]+\\.${rootDomainEscaped}`, 'gi')) || [];
                            for (const sub of subdomains) {
                                if (sub !== hostname) {
                                    containerSignalsFound = true;
                                    break;
                                }
                            }
                        }

                        if (gtmJs.includes('server_container_url') || gtmJs.includes('/g/collect')) {
                            // Check if it's actually configured with a URL, not just a keyword
                            const sGtmValuePattern = new RegExp(`server_container_url["']?\\s*[:,]\\s*["']([^"']+)["']`, 'i');
                            const collectValuePattern = new RegExp(`["']?([^"']+)["']?\\/g\\/collect`, 'i');

                            const sGtmMatch = gtmJs.match(sGtmValuePattern);
                            const collectMatch = gtmJs.match(collectValuePattern);

                            if (sGtmMatch) {
                                const urlPart = sGtmMatch[1];
                                if (urlPart.includes(rootDomain) && !urlPart.includes(hostname)) {
                                    containerSignalsFound = true;
                                }
                            }
                            if (collectMatch) {
                                const urlPart = collectMatch[1];
                                if (urlPart.includes(rootDomain) && !urlPart.includes(hostname) && !urlPart.includes('google-analytics.com')) {
                                    containerSignalsFound = true;
                                }
                            }
                        }
                    }
                } catch (e) { }
                if (containerSignalsFound) break;
            }

            // --- Decision Logic ---
            const hasGa4Direct = ga4MatchesHtml.length > 0;
            const hasGa4Gtm = ga4IdsFromContainers.length > 0;
            const hasGtm = uniqueGtmIds.length > 0;
            const allGa4Ids = Array.from(new Set([...ga4MatchesHtml, ...ga4IdsFromContainers]));
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

            // --- Universal Analytics Warning ---
            if (hasUa) {
                statusMessage += "\nUAのタグが残っています。もしくはUAの計測IDでGA4を計測しています";
            }

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
                        gtm_id: uniqueGtmIds[0] || null,
                        ua_id: allUaIds[0] || null,
                        is_sgtm: isSgtm
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
                    gtm_id: uniqueGtmIds[0] || null,
                    ua_id: allUaIds[0] || null,
                    is_sgtm: isSgtm,
                    visited_url: targetUrl
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

