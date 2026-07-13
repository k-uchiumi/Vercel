'use client';

/**
 * check.mareinterno.com — POSレジ打ち風レシート印刷機能
 *
 * 実装指示書（第2弾: check-mareinterno_print_spec.md）準拠。
 * すべてクライアントサイド完結。サーバー側（route.ts）には一切依存しない。
 *
 * 印刷先: SII URL Print Agent (Android + Chrome) → SII MP-B20 (58mm感熱・Bluetooth)
 * 公式仕様: 「SII URL Print Agent for AndroidTM and iOS アプリケーションプログラマーズガイド Rev.01」
 *   https://www.sii-ps.com/common/URLPRNAgent_Android_iOS_JA_01.pdf
 *   - URLスキーム: siiprintagent://1.0/print?query1=value1&query2=value2...
 *   - Format=pdf 必須 / Data=Base64エンコード済みPDF 必須 / BtKeepConnect=always 必須(2段出力の接続維持)
 *   - Androidのデータサイズ目安: 全体約200KB、PDF(Base64化前)約150KB、紙送り方向最大500mm
 * MP-B20仕様（https://www.sii.co.jp/sps/product/unit/mp-b20/ 仕様一覧より）:
 *   - ドット構成(dots/line) = 384, ドット密度 = 8 dots/mm → 印字幅 48mm（384 / 8 = 48）
 */

// ============================================================
// 定数
// ============================================================

const CANVAS_WIDTH_PX = 384; // MP-B20 ドット構成(dots/line)と1:1
const DOTS_PER_MM = 8; // MP-B20 ドット密度
const GRID_COLS = 32; // 半角32桁 / 全角16文字 グリッド
const PDF_SIZE_WARN_BYTES = 150 * 1024; // Android向けPDFサイズ上限目安（Base64化前）

const RECEIPT_FONT_FAMILY = 'BIZ UDGothic';
const RECEIPT_FONT_FALLBACK = '"MS Gothic", monospace';
const RECEIPT_FONT_CSS_URL =
  'https://fonts.googleapis.com/css2?family=BIZ+UDGothic:wght@400;700&display=swap';

const POS_MODE_STORAGE_KEY = 'check_mareinterno_pos_mode';
const RECEIPT_RESULT_STORAGE_KEY = 'check_mareinterno_receipt_result';

const COUPON_INQUIRY_URL =
  'https://mareinterno.com/inquiry/?utm_source=receipt&utm_medium=offline&utm_campaign=20260715_kouryukai';

// ============================================================
// 診断結果 → レシート入力の最小インターフェース
// ============================================================

export interface ReceiptCheckResult {
  score: number;
  details: {
    all_ga4_ids: string[];
    all_gtm_ids: string[];
    is_sgtm: boolean;
    has_obfuscated_loader?: boolean;
    has_cmp: boolean;
    visited_url: string;
    capi_data?: {
      meta: { is_detected: boolean };
      google: { is_detected: boolean };
      tiktok: { is_detected: boolean };
      line: { is_detected: boolean };
    };
  };
}

// ============================================================
// POSモード（?pos=1 / ?pos=0 → localStorage フラグ）
// ============================================================

export function syncPosModeFromQuery(searchParams: URLSearchParams): boolean {
  const pos = searchParams.get('pos');
  if (typeof window === 'undefined') return false;
  if (pos === '1') {
    window.localStorage.setItem(POS_MODE_STORAGE_KEY, '1');
    return true;
  }
  if (pos === '0') {
    window.localStorage.removeItem(POS_MODE_STORAGE_KEY);
    return false;
  }
  return window.localStorage.getItem(POS_MODE_STORAGE_KEY) === '1';
}

export function isPosModeEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(POS_MODE_STORAGE_KEY) === '1';
}

// ============================================================
// 診断結果の一時保存（印刷→コールバック復帰後も結果画面を維持するため）
// ============================================================

export function saveResultForReceipt(result: ReceiptCheckResult): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(RECEIPT_RESULT_STORAGE_KEY, JSON.stringify(result));
  } catch {
    // sessionStorage不可の環境では無視（印刷フロー継続は不可になるが致命的ではない）
  }
}

export function loadSavedResultForReceipt(): ReceiptCheckResult | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(RECEIPT_RESULT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ReceiptCheckResult) : null;
  } catch {
    return null;
  }
}

export function clearSavedResultForReceipt(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(RECEIPT_RESULT_STORAGE_KEY);
}

// ============================================================
// 全角/半角グリッド計算ユーティリティ
// ============================================================

function unitWidth(str: string): number {
  let w = 0;
  for (const ch of Array.from(str)) {
    const code = ch.codePointAt(0) ?? 0;
    const isHalfWidth =
      (code >= 0x20 && code <= 0x7e) || // ASCII
      (code >= 0xff61 && code <= 0xff9f) || // 半角カナ + 半角句読点
      code === 0x00a5; // ¥ (半角円記号)
    w += isHalfWidth ? 1 : 2;
  }
  return w;
}

function padEndUnits(str: string, target: number): string {
  const w = unitWidth(str);
  return w >= target ? str : str + ' '.repeat(target - w);
}

function padStartUnits(str: string, target: number): string {
  const w = unitWidth(str);
  return w >= target ? str : ' '.repeat(target - w) + str;
}

function centerUnits(str: string, target: number = GRID_COLS): string {
  const w = unitWidth(str);
  if (w >= target) return str;
  const totalPad = target - w;
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return ' '.repeat(left) + str + ' '.repeat(right);
}

function itemLine(name: string, qty: string, amount: string): string {
  // 品名24 + 数量3 + 金額5 = 32
  return padEndUnits(name, 24) + padStartUnits(qty, 3) + padStartUnits(amount, 5);
}

function amountLine(label: string, amount: string, amountCol = 10): string {
  return padEndUnits(label, GRID_COLS - amountCol) + padStartUnits(amount, amountCol);
}

const RULE_THIN = '-'.repeat(GRID_COLS);
const RULE_THICK = '='.repeat(GRID_COLS);

// ============================================================
// 描画行モデル
// ============================================================

type ReceiptLine =
  | { type: 'text'; text: string }
  | { type: 'qr'; data: string; sizePx: number };

// ============================================================
// 明細行マッピング（診断結果 → 明細）
// ============================================================

interface DetailCheck {
  label: string; // 領収書上の項目名
  prefix: string; // ✅ 時の接頭辞（[診断] / [優良]）
  detected: boolean;
}

function buildDetailChecks(result: ReceiptCheckResult): DetailCheck[] {
  const { details } = result;
  const hasGa4 = !!(details.all_ga4_ids && details.all_ga4_ids.length > 0);
  const hasGtm = !!(details.all_gtm_ids && details.all_gtm_ids.length > 0);
  const hasSgtm = !!(details.is_sgtm || details.has_obfuscated_loader);
  const hasCmp = !!details.has_cmp;
  const hasCapi = !!(
    details.capi_data &&
    (details.capi_data.meta.is_detected ||
      details.capi_data.google.is_detected ||
      details.capi_data.tiktok.is_detected ||
      details.capi_data.line.is_detected)
  );

  return [
    { label: 'GA4ﾀｸﾞ設定', prefix: '[診断]', detected: hasGa4 },
    { label: 'GTMｺﾝﾃﾅ検知', prefix: '[診断]', detected: hasGtm },
    { label: 'ｻｰﾊﾞｰｻｲﾄﾞ計測', prefix: '[優良]', detected: hasSgtm },
    { label: '同意管理(CMP)', prefix: '[診断]', detected: hasCmp },
    { label: 'ｺﾝﾊﾞｰｼﾞｮﾝAPI', prefix: '[優良]', detected: hasCapi },
  ];
}

function buildDetailLines(checks: DetailCheck[]): string[] {
  return checks.map((c) =>
    c.detected ? itemLine(`${c.prefix} ${c.label}`, '1', '¥0') : `[警告] ${c.label} ﾐｾｯﾃｲ`
  );
}

function formatDomain(visitedUrl: string): string {
  try {
    return new URL(visitedUrl).hostname;
  } catch {
    return visitedUrl || '(不明)';
  }
}

function formatNowJst(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayMap: Record<string, string> = {
    Sun: '日', Mon: '月', Tue: '火', Wed: '水', Thu: '木', Fri: '金', Sat: '土',
  };
  const weekdayRaw = get('weekday');
  const weekday = weekdayMap[weekdayRaw] || weekdayRaw;

  return `${get('year')}年 ${get('month')}月${get('day')}日(${weekday}) ${get('hour')}:${get('minute')}`;
}

// ============================================================
// 1枚目: 診断レシート
// ============================================================

export function buildReceiptLines(result: ReceiptCheckResult): ReceiptLine[] {
  const checks = buildDetailChecks(result);
  const detailLines = buildDetailLines(checks);
  const miles = result.score * 25;
  const domain = formatDomain(result.details.visited_url);

  const lines: string[] = [
    centerUnits('＊領　収　書＊'),
    centerUnits('mare interno 合同会社'),
    centerUnits('第１回全会員ビジネス交流会店'),
    RULE_THIN,
    formatNowJst(),
    'ﾚｼﾞ:01 担当:内海',
    `会員: ${domain} 様`,
    RULE_THICK,
    ...detailLines,
    RULE_THIN,
    amountLine('小計', '¥0'),
    amountLine('(内消費税等10%対象', '¥0)'),
    amountLine('合計', '¥0'),
    RULE_THIN,
    amountLine('お預かり (名刺)', '1枚'),
    amountLine('お釣り   (笑顔)', '¥0'),
    RULE_THICK,
    centerUnits('[ mare interno 会員マイル ]'),
    amountLine('今回付与ﾏｲﾙ', `+${miles} Mile`),
    amountLine('現在の累計ﾏｲﾙ', `${miles} Mile`),
    RULE_THIN,
    centerUnits('お買い上げありがとうございました'),
    centerUnits('またのご来店をお待ちしております'),
  ];

  return lines.map((text) => ({ type: 'text', text }));
}

// ============================================================
// 2枚目: クーポン券（QR合成）
// ============================================================

export function buildCouponLines(): ReceiptLine[] {
  const lines: ReceiptLine[] = [
    { type: 'text', text: RULE_THICK },
    { type: 'text', text: centerUnits('★特別御優待券★') },
    { type: 'text', text: centerUnits('無料オンライン個別診断') },
    { type: 'text', text: RULE_THIN },
    { type: 'text', text: '本券1枚で､専門ｴﾝｼﾞﾆｱによる' },
    { type: 'text', text: '｢詳細Web診断&改善ﾛｰﾄﾞﾏｯﾌﾟ提案｣' },
    { type: 'text', text: 'を無料でご利用いただけます｡' },
    { type: 'text', text: '' },
    { type: 'text', text: centerUnits('▼ご予約･お問い合わせはQRから▼') },
    { type: 'text', text: '' },
    { type: 'qr', data: COUPON_INQUIRY_URL, sizePx: 160 },
    { type: 'text', text: '' },
    { type: 'text', text: '※本券は有効期限なし' },
    { type: 'text', text: '　レシートをお持ちの方有効' },
    { type: 'text', text: '※他ｷｬﾝﾍﾟｰﾝとの併用不可' },
    { type: 'text', text: RULE_THICK },
  ];
  return lines;
}

// ============================================================
// フォント読み込み（document.fonts.ready を待つ）
// ============================================================

let fontLoadPromise: Promise<void> | null = null;

function ensureReceiptFontLoaded(): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  if (fontLoadPromise) return fontLoadPromise;

  fontLoadPromise = (async () => {
    const linkId = 'receipt-font-biz-udgothic';
    if (!document.getElementById(linkId)) {
      const link = document.createElement('link');
      link.id = linkId;
      link.rel = 'stylesheet';
      link.href = RECEIPT_FONT_CSS_URL;
      document.head.appendChild(link);
    }
    try {
      await Promise.all([
        document.fonts.load(`400 20px "${RECEIPT_FONT_FAMILY}"`),
        document.fonts.load(`700 20px "${RECEIPT_FONT_FAMILY}"`),
      ]);
    } catch {
      // フォント取得に失敗してもフォールバック(monospace)で継続する
    }
    try {
      await document.fonts.ready;
    } catch {
      // ready未対応環境は無視
    }
  })();

  return fontLoadPromise;
}

// ============================================================
// Canvas描画
// ============================================================

function pickFontSizePx(
  ctx: CanvasRenderingContext2D,
  fontFamily: string,
  targetWidthPx: number,
  sampleLines: string[]
): number {
  const testStr = 'あ'.repeat(GRID_COLS / 2); // 全角16文字 = 32ユニット相当のテスト文字列
  let fontSize = 22;
  ctx.font = `${fontSize}px "${fontFamily}", ${RECEIPT_FONT_FALLBACK}`;
  const measured = ctx.measureText(testStr).width;
  if (measured > 0) {
    fontSize = Math.floor(fontSize * (targetWidthPx / measured));
  }
  fontSize = Math.max(10, Math.min(fontSize, 28));

  // 全角文字のみの較正だと、半角カナ・濁点付き文字を含む実際の行で
  // 実測幅がズレて右端がはみ出すことがあるため、実際の行内容で再検証して縮小する。
  for (let iter = 0; iter < 6; iter++) {
    ctx.font = `${fontSize}px "${fontFamily}", ${RECEIPT_FONT_FALLBACK}`;
    let maxLineWidth = 0;
    for (const line of sampleLines) {
      const w = ctx.measureText(line).width;
      if (w > maxLineWidth) maxLineWidth = w;
    }
    if (maxLineWidth <= targetWidthPx || fontSize <= 10) break;
    const shrunk = Math.floor(fontSize * (targetWidthPx / maxLineWidth)) - 1;
    fontSize = Math.max(10, shrunk);
  }

  return fontSize;
}

async function renderLinesToCanvas(lines: ReceiptLine[]): Promise<HTMLCanvasElement> {
  await ensureReceiptFontLoaded();

  const marginX = 12; // 半角カナ等の実測幅ズレに備えた安全マージン(旧8pxから拡大)
  const marginY = 16;
  const usableWidth = CANVAS_WIDTH_PX - marginX * 2;

  // フォントサイズ決定用の一時canvas
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d')!;
  const textLines = lines.filter((l): l is { type: 'text'; text: string } => l.type === 'text').map((l) => l.text);
  const fontSizePx = pickFontSizePx(measureCtx, RECEIPT_FONT_FAMILY, usableWidth, textLines);
  const lineHeightPx = Math.round(fontSizePx * 1.4);

  // QR画像を事前生成（サイズを高さ計算に反映するため）
  const qrCanvases = new Map<number, HTMLCanvasElement>();
  const QRCodeLib = (await import('qrcode')).default;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === 'qr') {
      const qrCanvas = document.createElement('canvas');
      await QRCodeLib.toCanvas(qrCanvas, line.data, {
        width: line.sizePx,
        margin: 2,
        errorCorrectionLevel: 'M',
      });
      qrCanvases.set(i, qrCanvas);
    }
  }

  // 総高さ計算
  let totalHeight = marginY * 2;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === 'text') {
      totalHeight += lineHeightPx;
    } else {
      const qrCanvas = qrCanvases.get(i)!;
      totalHeight += qrCanvas.height + lineHeightPx * 0.5;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH_PX;
  canvas.height = Math.ceil(totalHeight);

  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'top';
  ctx.font = `${fontSizePx}px "${RECEIPT_FONT_FAMILY}", ${RECEIPT_FONT_FALLBACK}`;

  let y = marginY;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === 'text') {
      ctx.fillText(line.text, marginX, y);
      y += lineHeightPx;
    } else {
      const qrCanvas = qrCanvases.get(i)!;
      const x = Math.round((canvas.width - qrCanvas.width) / 2);
      ctx.drawImage(qrCanvas, x, y);
      y += qrCanvas.height + lineHeightPx * 0.5;
    }
  }

  return canvas;
}

// ============================================================
// Canvas → 画像PDF（Base64）
// ============================================================

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

async function canvasToPdfBase64(canvas: HTMLCanvasElement, label: string): Promise<string> {
  const { jsPDF } = await import('jspdf');

  const widthMm = CANVAS_WIDTH_PX / DOTS_PER_MM; // 48mm（MP-B20印字幅と1:1）
  const heightMm = canvas.height / DOTS_PER_MM;

  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: [widthMm, heightMm],
    compress: true,
  });

  const pngDataUrl = canvas.toDataURL('image/png');
  pdf.addImage(pngDataUrl, 'PNG', 0, 0, widthMm, heightMm);

  const arrayBuffer = pdf.output('arraybuffer') as ArrayBuffer;
  const sizeBytes = arrayBuffer.byteLength;
  if (sizeBytes > PDF_SIZE_WARN_BYTES) {
    // eslint-disable-next-line no-console
    console.warn(
      `[receiptPrinter] ${label} PDFサイズが目安(150KB)を超過: ${(sizeBytes / 1024).toFixed(1)}KB`
    );
  }

  return arrayBufferToBase64(arrayBuffer);
}

// ============================================================
// SII URL Print Agent 呼び出しURL構築
// ============================================================

function buildSiiPrintUrl(pdfBase64: string, callbackSuccessUrl: string, callbackFailUrl: string): string {
  const params =
    `CallbackSuccess=${encodeURIComponent(callbackSuccessUrl)}` +
    `&CallbackFail=${encodeURIComponent(callbackFailUrl)}` +
    `&BtKeepConnect=always` +
    `&Format=pdf` +
    `&Data=${encodeURIComponent(pdfBase64)}` +
    `&ErrorDialog=yes` +
    `&SelectOnError=no` +
    `&PaperWidth=58`;

  return `siiprintagent://1.0/print?${params}`;
}

// ============================================================
// 公開API: 1枚目 / 2枚目それぞれの印刷URLを構築
// ============================================================

export async function buildReceiptPrintUrl(
  result: ReceiptCheckResult,
  callbackSuccessUrl: string,
  callbackFailUrl: string
): Promise<string> {
  const lines = buildReceiptLines(result);
  const canvas = await renderLinesToCanvas(lines);
  const pdfBase64 = await canvasToPdfBase64(canvas, '診断レシート(1枚目)');
  return buildSiiPrintUrl(pdfBase64, callbackSuccessUrl, callbackFailUrl);
}

export async function buildCouponPrintUrl(
  callbackSuccessUrl: string,
  callbackFailUrl: string
): Promise<string> {
  const lines = buildCouponLines();
  const canvas = await renderLinesToCanvas(lines);
  const pdfBase64 = await canvasToPdfBase64(canvas, 'クーポン券(2枚目)');
  return buildSiiPrintUrl(pdfBase64, callbackSuccessUrl, callbackFailUrl);
}

export function firePrint(url: string): void {
  if (typeof window === 'undefined') return;
  window.location.href = url;
}
