'use client';

import { useState } from 'react';
import styles from './page.module.css';

interface CheckResult {
  score: number;
  message: string;
  details: {
    has_ga4_direct: boolean;
    has_ga4_gtm: boolean;
    has_gtm: boolean;
    has_ua: boolean;
    ga4_id: string | null;
    gtm_id: string | null;
    ua_id: string | null;
    is_sgtm: boolean;
    visited_url: string;
    capi_data?: {
      meta: { is_detected: boolean; has_event_id: boolean; has_fbp_fbc: boolean };
      google: { is_detected: boolean; has_gcl_au: boolean; has_custom_domain: boolean; has_enhanced: boolean };
      tiktok: { is_detected: boolean; has_external_id: boolean; has_event_id: boolean };
      line: { is_detected: boolean; has_ifa_cl_id: boolean; has_line_id: boolean };
    };
  };
}

declare global {
  interface Window {
    zaraz?: {
      track: (eventName: string, data?: object) => void;
    };
  }
}

export default function Home() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zarazTriggered, setZarazTriggered] = useState(false);

  const handleInput = () => {
    if (!zarazTriggered && url.length === 0) {
      if (typeof window !== 'undefined' && window.zaraz) {
        window.zaraz.track("input_started", { field_id: "target_url" });
        setZarazTriggered(true);
      }
    }
  };

  const handleCheck = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;

    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const res = await fetch('/api/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 429) {
          setError(data.message || '利用制限に達しました。');
        } else {
          setError(data.message || 'エラーが発生しました。もう一度お試しください。');
        }
      } else {
        setResult(data);
      }
    } catch (err) {
      setError('Failed to connect to the server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className={styles.main}>
      <div className={styles.container}>
        <div className={styles.hero}>
          <h1 className={styles.title}>
            サイト健全性チェック
          </h1>
          <p className={styles.subtitle}>
            サイトの導入成熟度を瞬時に分析します。
          </p>
        </div>

        <div className={styles.formContainer}>
          <form onSubmit={handleCheck} className={styles.form}>
            <div className={styles.inputWrapper}>
              <input
                type="text"
                className={`${styles.input} glass`}
                placeholder="ウェブサイトのURLを入力 (例: example.com)"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onInput={handleInput}
              />
            </div>
            <button type="submit" className={styles.button} disabled={loading}>
              {loading ? <div className={styles.loader} /> : '分析する'}
            </button>
          </form>
          <p className={styles.inputDisclaimer}>
            ※トップページの公開タグ情報のみを安全にスキャンします。
          </p>
          {error && (
            <div style={{ textAlign: 'center', marginTop: '1rem' }}>
              <p style={{ color: 'var(--error)', marginBottom: '1rem' }}>{error}</p>
              {(error.includes('利用制限') || error.includes('計測対象外')) && (
                <a href="https://mareinterno.com/inquiry/" target="_blank" rel="noopener noreferrer" className={styles.contactButton} style={{ marginTop: 0 }}>
                  詳細を確認したい場合はこちら
                </a>
              )}
            </div>
          )}
          <p className={styles.formDisclaimer}>
            入力されたURLは診断精度向上および弊社サービス改善の分析（重複判定等）にのみ利用し、第三者へ公開することはありません。
          </p>
        </div>

        {result && (
          <div className={`${styles.resultCard} glass`}>
            <div className={styles.scoreContainer}>
              <div className={styles.scoreLabel}>成熟度スコア</div>
              <div className={styles.scoreValue}>
                {result.score}<span className={styles.scoreMax}>/5</span>
              </div>
            </div>

            <h3 className={styles.statusMessage}>{result.message}</h3>

            <div className={styles.detailsGrid}>
              <div className={styles.detailItem}>
                <div className={styles.detailLabel}>GA4 直接実装</div>
                <div className={`${styles.detailValue} ${result.details.has_ga4_direct ? styles.success : styles.error}`}>
                  {result.details.has_ga4_direct ? '検出' : '未検出'}
                </div>
                {result.details.has_ga4_direct && result.details.ga4_id && <div style={{ fontSize: '0.8rem', opacity: 0.7, marginTop: '0.5rem' }}>{result.details.ga4_id}</div>}
              </div>

              <div className={styles.detailItem}>
                <div className={styles.detailLabel}>GTM コンテナ</div>
                <div className={`${styles.detailValue} ${result.details.has_gtm ? styles.success : styles.error}`}>
                  {result.details.has_gtm ? '検出' : '未検出'}
                </div>
                {result.details.gtm_id && <div style={{ fontSize: '0.8rem', opacity: 0.7, marginTop: '0.5rem' }}>{result.details.gtm_id}</div>}
                {result.details.has_ga4_gtm && <div style={{ fontSize: '0.7rem', opacity: 0.6, marginTop: '0.3rem' }}>GA4タグ内蔵</div>}
              </div>

              <div className={styles.detailItem}>
                <div className={styles.detailLabel}>サーバーサイド / 高度な実装</div>
                <div className={`${styles.detailValue} ${result.details.is_sgtm ? styles.success : styles.error}`}>
                  {result.details.is_sgtm ? '検出 (sGTM/Proxy)' : '未検出'}
                </div>
              </div>

              <div className={styles.detailItem}>
                <div className={styles.detailLabel}>UA (旧アナリティクス)</div>
                <div className={`${styles.detailValue} ${result.details.has_ua ? styles.warning : styles.success}`} style={result.details.has_ua ? { color: 'var(--warning)' } : {}}>
                  {result.details.has_ua ? '残存' : '未検出'}
                </div>
                {result.details.ua_id && <div style={{ fontSize: '0.8rem', opacity: 0.7, marginTop: '0.5rem' }}>{result.details.ua_id}</div>}
              </div>
            </div>

            {result.details.capi_data && (
              <div className={styles.capiContainer} style={{ marginTop: '2rem', paddingTop: '2rem', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                <h4 style={{ marginBottom: '1rem', fontSize: '1rem', color: 'var(--primary-color)' }}>1st Party Data Sender 判定 (CAPI / Server-side)</h4>
                <div className={styles.detailsGrid}>
                  <div className={styles.detailItem}>
                    <div className={styles.detailLabel}>Meta (Facebook)</div>
                    <div className={`${styles.detailValue} ${result.details.capi_data.meta.is_detected ? styles.success : styles.error}`}>
                      {result.details.capi_data.meta.is_detected ? '導入の可能性大' : '未検出'}
                    </div>
                    {result.details.capi_data.meta.has_event_id && <div style={{ fontSize: '0.7rem', opacity: 0.6, marginTop: '0.3rem' }}>Event ID 検出済</div>}
                  </div>
                  <div className={styles.detailItem}>
                    <div className={styles.detailLabel}>Google 広告</div>
                    <div className={`${styles.detailValue} ${result.details.capi_data.google.is_detected ? styles.success : styles.error}`}>
                      {result.details.capi_data.google.is_detected ? '導入の可能性大' : '未検出'}
                    </div>
                    {result.details.capi_data.google.has_custom_domain && <div style={{ fontSize: '0.7rem', opacity: 0.6, marginTop: '0.3rem' }}>計測用独自ドメイン検出済</div>}
                  </div>
                  <div className={styles.detailItem}>
                    <div className={styles.detailLabel}>TikTok</div>
                    <div className={`${styles.detailValue} ${result.details.capi_data.tiktok.is_detected ? styles.success : styles.error}`}>
                      {result.details.capi_data.tiktok.is_detected ? '導入の可能性大' : '未検出'}
                    </div>
                  </div>
                  <div className={styles.detailItem}>
                    <div className={styles.detailLabel}>LINE 広告</div>
                    <div className={`${styles.detailValue} ${result.details.capi_data.line.is_detected ? styles.success : styles.error}`}>
                      {result.details.capi_data.line.is_detected ? '導入の可能性大' : '未検出'}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {result.score === 3 && (
              <p className={styles.itpDisclaimer}>
                ※表示される欠損率はSafari（ITP）等のブラウザ制約による一般的な推定値です。正確な影響範囲の特定には管理画面の診断が必要です。
              </p>
            )}

            <a href="https://mareinterno.com/inquiry/" target="_blank" rel="noopener noreferrer" className={styles.contactButton}>
              詳細を確認したい場合はこちら
            </a>

            <p className={styles.resultDisclaimer}>
              本診断は公開タグの検知に基づく簡易的なものです。サイト構造や設定により、実際の導入状況と異なる判定が出る場合があります。
            </p>
          </div>
        )}
      </div>

      <footer className={styles.footer}>
        <p>
          &copy; {new Date().getFullYear()} <a href="https://mareinterno.com" target="_blank" rel="noopener noreferrer">mare interno LLC.</a>
        </p>
      </footer>
    </main>
  );
}
