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
                const cachedRow = rows.find((rowList: any[]) => {
                    const rowUrl = (rowList[1] || "").replace(/\/$/, "");
                    return rowUrl === normalizedUrl;
                });

                if (cachedRow) {
                    console.log('Cache Hit for:', normalizedUrl);
                    let details = {};
                    try {
                        details = JSON.parse(cachedRow[4]);
                    } catch (e) { console.error('Failed to parse cached details', e); }

                    return NextResponse.json({
                        score: Number(cachedRow[2]),
                        message: cachedRow[3],
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
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                redirect: 'follow',
            });

            if (!fetchRes.ok) {
                return NextResponse.json({ message: `Failed to fetch URL: ${fetchRes.statusText}` }, { status: fetchRes.status });
            }

            const html = await fetchRes.text();
            const ga4Regex = /G-[A-Z0-9]{10,}/g;
            const gtmRegex = /GTM-[A-Z0-9]{6,}/g;

            const ga4Matches = html.match(ga4Regex);
            const hasGa4 = !!ga4Matches && ga4Matches.length > 0;
            const ga4Id = hasGa4 ? ga4Matches[0] : null;

            let hasGtm = false;
            let gtmId = null;
            const gtmMatches = html.match(gtmRegex);

            if (gtmMatches && gtmMatches.length > 0) {
                hasGtm = true;
                gtmId = gtmMatches[0];
            } else {
                const base64Pattern = /[a-zA-Z0-9+/]{20,}/g;
                const potentialBase64 = html.match(base64Pattern) || [];
                for (const str of potentialBase64) {
                    try {
                        const decoded = atob(str);
                        if (decoded.includes('GTM-')) {
                            const deepMatch = decoded.match(/GTM-[A-Z0-9]{6,}/);
                            if (deepMatch) {
                                hasGtm = true;
                                gtmId = deepMatch[0];
                                break;
                            }
                        }
                    } catch (e) { }
                }
            }

            let isSgtm = false;
            const hostname = new URL(targetUrl).hostname;
            const rootDomain = hostname.split('.').slice(-2).join('.');

            const scriptSrcRegex = /<script[^>]+src=["']([^"']+)["'][^>]*>/gi;
            let match;
            const scriptSrcs: string[] = [];
            while ((match = scriptSrcRegex.exec(html)) !== null) {
                scriptSrcs.push(match[1]);
            }

            const htmlText = html.toLowerCase();
            const stapeSignals = ['stape', 'server_container_url', 'bi.js', 'loader.js'];
            let sameOriginScriptFound = false;

            for (const src of scriptSrcs) {
                if (src.includes('googletagmanager.com/gtm.js')) continue;
                if (src.includes('google-analytics.com/analytics.js')) continue;

                let absoluteSrc = src;
                if (src.startsWith('/')) {
                    absoluteSrc = `${new URL(targetUrl).origin}${src}`;
                } else if (!src.startsWith('http')) {
                    absoluteSrc = `${new URL(targetUrl).origin}/${src}`;
                }

                try {
                    const srcUrl = new URL(absoluteSrc);
                    if (srcUrl.hostname.includes(rootDomain)) {
                        if (srcUrl.searchParams.has('id') || srcUrl.searchParams.has('st') || srcUrl.pathname.includes('gtm') || srcUrl.pathname.match(/\/[a-zA-Z0-9]{8,}\.js/)) {
                            sameOriginScriptFound = true;
                        }
                    }
                } catch (e) { }
            }

            if (stapeSignals.some(sig => htmlText.includes(sig))) {
                isSgtm = true;
            }
            if (gtmId && !gtmMatches) {
                isSgtm = true;
            }
            if (!hasGa4 && !hasGtm && sameOriginScriptFound) {
                isSgtm = true;
            }

            let score = 2;
            let statusMessage = "GA4の導入が検出されませんでした。";

            if (isSgtm) {
                score = 4;
                statusMessage = "高度な/サーバーサイド実装の可能性があります（直接のIDはありませんが、プロキシの兆候があります）。";
            } else if (hasGa4 || hasGtm) {
                score = 3;
                statusMessage = "標準的なGA4またはGTMの導入が検出されました。\nSafariからの流入で40%機会損失している可能性があります。";
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
                        has_ga4: hasGa4, has_gtm: hasGtm, ga4_id: ga4Id, gtm_id: gtmId, is_sgtm: isSgtm
                    });

                    await sheets.spreadsheets.values.append({
                        spreadsheetId,
                        range: 'ga4checkpro!A:E',
                        valueInputOption: 'USER_ENTERED',
                        requestBody: {
                            values: [
                                [timestamp, targetUrl, score, statusMessage, detailsJson]
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
        console.error('Fatal API Error:', error);
        return NextResponse.json({ message: 'Internal Server Error' }, { status: 500 });
    }
}

