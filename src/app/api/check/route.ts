import { NextResponse } from 'next/server';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { url } = body;

        if (!url) {
            return NextResponse.json({ message: 'URL is required' }, { status: 400 });
        }

        // Ensure URL has protocol
        let targetUrl = url.trim();
        if (!targetUrl.startsWith('http')) {
            targetUrl = `https://${targetUrl}`;
        }

        // Normalize URL for cache check AND fetch (Use Origin Only)
        // This strips path, query params, hash
        try {
            const urlObj = new URL(targetUrl);
            targetUrl = urlObj.origin; // e.g. https://example.com
        } catch (e) {
            // If invalid URL, keep as is (will fail fetch later) or return error now
            return NextResponse.json({ message: 'Invalid URL format' }, { status: 400 });
        }

        const normalizedUrl = targetUrl; // Algorithm uses origin for everything now

        // --- URL Caching (Check Google Sheet) ---
        try {
            if (process.env.GOOGLE_SHEETS_CLIENT_EMAIL && process.env.GOOGLE_SHEETS_PRIVATE_KEY && process.env.GOOGLE_SHEET_ID) {
                const { google } = require('googleapis');
                // Robust Private Key Handling for Vercel/Environments
                let privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY || '';
                // Remove potential quotes wrapped around the key
                if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
                    privateKey = privateKey.substring(1, privateKey.length - 1);
                }
                // Handle both literal newlines and escaped \n
                privateKey = privateKey.replace(/\\n/g, '\n');

                const auth = new google.auth.GoogleAuth({
                    credentials: {
                        client_email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
                        private_key: privateKey,
                    },
                    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
                });
                const sheets = google.sheets({ version: 'v4', auth });

                // Fetch existing URLs in Column B (Index 1) and other data
                const response = await sheets.spreadsheets.values.get({
                    spreadsheetId: process.env.GOOGLE_SHEET_ID,
                    range: 'ga4checkpro!A:E', // Fetch cols A to E (Timestamp, URL, Score, Message, Details)
                });

                const rows = response.data.values || [];

                // Find if URL exists
                // Row format: [Timestamp, URL, Score, Message, Details]
                const cachedRow = rows.find((row: any[]) => {
                    const rowUrl = (row[1] || "").replace(/\/$/, "");
                    return rowUrl === normalizedUrl;
                });

                if (cachedRow) {
                    console.log('Cache Hit for:', normalizedUrl);
                    // Return cached result
                    // cachedRow[4] is DetailsJSON
                    let details = {};
                    try {
                        details = JSON.parse(cachedRow[4]);
                    } catch (e) { console.error('Failed to parse cached details', e); }

                    return NextResponse.json({
                        score: Number(cachedRow[2]),
                        message: cachedRow[3],
                        details: {
                            ...details,
                            visited_url: cachedRow[1] // Use stored URL
                        }
                    });
                }
            }
        } catch (e: any) {
            console.error('Cache check failed:', e?.message);
            // Verify cache check failure doesn't block analysis
        }
        // ------------------------



        try {
            const response = await fetch(targetUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                redirect: 'follow',
            });

            if (!response.ok) {
                return NextResponse.json({ message: `Failed to fetch URL: ${response.statusText}` }, { status: response.status });
            }

            const html = await response.text();

            // Detection Logic
            const ga4Regex = /G-[A-Z0-9]{10,}/g;
            const gtmRegex = /GTM-[A-Z0-9]{6,}/g;

            // Check for direct GA4 (G-XXXXXXXXXX)
            const ga4Matches = html.match(ga4Regex);
            const hasGa4 = !!ga4Matches && ga4Matches.length > 0;
            const ga4Id = hasGa4 ? ga4Matches[0] : null;

            // Check for GTM (GTM-XXXXXX)
            let hasGtm = false;
            let gtmId = null;
            const gtmMatches = html.match(gtmRegex);

            if (gtmMatches && gtmMatches.length > 0) {
                hasGtm = true;
                gtmId = gtmMatches[0];
            } else {
                // Try to detect obfuscated GTM ID (Base64 encoded GTM-XXXX)
                // Common pattern in Stape: id=GTM-XXXX encoded in base64
                // Look for base64 strings that decode to "id=GTM-" or just "GTM-"
                const base64Pattern = /[a-zA-Z0-9+/]{20,}/g;
                const potentialBase64 = html.match(base64Pattern) || [];

                for (const str of potentialBase64) {
                    try {
                        const decoded = atob(str);
                        if (decoded.includes('GTM-')) {
                            // Extract GTM-XXX from decoded string
                            const deepMatch = decoded.match(/GTM-[A-Z0-9]{6,}/);
                            if (deepMatch) {
                                hasGtm = true; // Still counts as GTM, but maybe advanced? User said 4/5 for obscured.
                                // Actually, if it's obscured, it's likely a custom loader.
                                // But let's treat it as a strong signal for sGTM/Custom Loader if direct GTM is missing.
                                gtmId = deepMatch[0];
                                break;
                            }
                        }
                    } catch (e) {
                        // ignore invalid base64
                    }
                }
            }

            // Check for sGTM / Custom Loader indicators
            let isSgtm = false;
            const hostname = new URL(targetUrl).hostname;
            const rootDomain = hostname.split('.').slice(-2).join('.');

            // Regex for script tags to check srcs
            const scriptSrcRegex = /<script[^>]+src=["']([^"']+)["'][^>]*>/gi;
            let match;
            const scriptSrcs: string[] = [];
            while ((match = scriptSrcRegex.exec(html)) !== null) {
                scriptSrcs.push(match[1]);
            }

            // Check signals in HTML text (inline scripts)
            const htmlText = html.toLowerCase();
            const stapeSignals = [
                'stape', 'server_container_url', 'bi.js', 'loader.js'
            ];

            // Should detect if there is a script loaded from same origin that looks suspicious
            // AND we found no standard GTM/GA4

            let sameOriginScriptFound = false;

            for (const src of scriptSrcs) {
                // Skip standard
                if (src.includes('googletagmanager.com/gtm.js')) continue;
                if (src.includes('google-analytics.com/analytics.js')) continue;

                // Resolve relative URLs to absolute
                let absoluteSrc = src;
                if (src.startsWith('/')) {
                    absoluteSrc = `${new URL(targetUrl).origin}${src}`;
                } else if (!src.startsWith('http')) {
                    // relative without / ?
                    absoluteSrc = `${new URL(targetUrl).origin}/${src}`;
                }

                try {
                    const srcUrl = new URL(absoluteSrc);
                    // Check if it's same origin (or subdomain)
                    if (srcUrl.hostname.includes(rootDomain)) {
                        // Check for suspicious query params often used by loaders
                        // e.g. ?id=..., ?st=...
                        if (srcUrl.searchParams.has('id') || srcUrl.searchParams.has('st') || srcUrl.pathname.includes('gtm') || srcUrl.pathname.match(/\/[a-zA-Z0-9]{8,}\.js/)) {
                            // Random 8+ char js filename on same origin *could* be a loader
                            sameOriginScriptFound = true;
                        }
                    }
                } catch (e) { }
            }

            if (stapeSignals.some(sig => htmlText.includes(sig))) {
                isSgtm = true;
            }

            // Refined Logic for sGTM / Custom Loader
            // If we found a hidden GTM ID (decoded) -> likely sGTM/Custom Loader
            // If we found same origin scripts looking like loaders AND no standard GTM

            // If ID was found via Base64, consider it sGTM/Advanced
            if (gtmId && !gtmMatches) {
                isSgtm = true;
            }

            if (!hasGa4 && !hasGtm && sameOriginScriptFound) {
                isSgtm = true;
            }


            // Explicit scoring logic
            let score = 2; // Default: GA4 Not Introduced
            let statusMessage = "GA4の導入が検出されませんでした。";

            if (isSgtm) {
                // Prioritize sGTM/Advanced score even if GTM ID is found (often they exist together)
                score = 4;
                statusMessage = "高度な/サーバーサイド実装の可能性があります（直接のIDはありませんが、プロキシの兆候があります）。";
            } else if (hasGa4 || hasGtm) {
                score = 3;
                statusMessage = "標準的なGA4またはGTMの導入が検出されました。\nSafariからの流入で40%機会損失している可能性があります。";
            }

            // --- Logging to Google Sheets ---
            try {
                if (process.env.GOOGLE_SHEETS_CLIENT_EMAIL && process.env.GOOGLE_SHEETS_PRIVATE_KEY && process.env.GOOGLE_SHEET_ID) {
                    const { google } = require('googleapis');

                    // Robust Private Key Handling for Vercel/Environments
                    let privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY || '';
                    if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
                        privateKey = privateKey.substring(1, privateKey.length - 1);
                    }
                    privateKey = privateKey.replace(/\\n/g, '\n');

                    const auth = new google.auth.GoogleAuth({
                        credentials: {
                            client_email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
                            private_key: privateKey,
                        },
                        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
                    });

                    const sheets = google.sheets({ version: 'v4', auth });

                    const timestamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
                    const detailsJson = JSON.stringify({
                        has_ga4: hasGa4, has_gtm: hasGtm, ga4_id: ga4Id, gtm_id: gtmId, is_sgtm: isSgtm
                    });

                    await sheets.spreadsheets.values.append({
                        spreadsheetId: process.env.GOOGLE_SHEET_ID,
                        range: 'ga4checkpro!A:E', // Range A:E (No IP)
                        valueInputOption: 'USER_ENTERED',
                        requestBody: {
                            values: [
                                [timestamp, targetUrl, score, statusMessage, detailsJson] // No IP logged
                            ],
                        },
                    });
                }
            } catch (logError: any) {
                console.error('Google Sheets Logging Error:', {
                    message: logError.message,
                    code: logError.code,
                    details: logError.response?.data
                });
                // Do not fail the request if logging fails
            }
            // --------------------------------

            return NextResponse.json({
                score,
                details: {
                    has_ga4: hasGa4,
                    has_gtm: hasGtm,
                    ga4_id: ga4Id,
                    gtm_id: gtmId,
                    is_sgtm: isSgtm,
                    visited_url: targetUrl
                },
                message: statusMessage
            });

        } catch (error: any) {
            return NextResponse.json({ message: `Error fetching URL: ${error.message}` }, { status: 500 });
        }

    } catch (error) {
        return NextResponse.json({ message: 'Internal Server Error' }, { status: 500 });
    }
}
