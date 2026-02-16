'use client';

import { useState } from 'react';
import styles from './page.module.css';

interface CheckResult {
  score: number;
  message: string;
  details: {
    has_ga4: boolean;
    has_gtm: boolean;
    ga4_id: string | null;
    gtm_id: string | null;
    is_sgtm: boolean;
    visited_url: string;
  };
}

export default function Home() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

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
            GA4 check <span className="gradient-text">Pro</span>
          </h1>
          <p className={styles.subtitle}>
            Google Analytics 4 の導入成熟度を瞬時に分析します。
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
              />
            </div>
            <button type="submit" className={styles.button} disabled={loading}>
              {loading ? <div className={styles.loader} /> : '分析する'}
            </button>
          </form>
          {error && (
            <div style={{ textAlign: 'center', marginTop: '1rem' }}>
              <p style={{ color: 'var(--error)', marginBottom: '1rem' }}>{error}</p>
              {error.includes('利用制限') && (
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
                <div className={`${styles.detailValue} ${result.details.has_ga4 ? styles.success : styles.error}`}>
                  {result.details.has_ga4 ? '検出' : '未検出'}
                </div>
                {result.details.ga4_id && <div style={{ fontSize: '0.8rem', opacity: 0.7, marginTop: '0.5rem' }}>{result.details.ga4_id}</div>}
              </div>

              <div className={styles.detailItem}>
                <div className={styles.detailLabel}>GTM コンテナ</div>
                <div className={`${styles.detailValue} ${result.details.has_gtm ? styles.success : styles.error}`}>
                  {result.details.has_gtm ? '検出' : '未検出'}
                </div>
                {result.details.gtm_id && <div style={{ fontSize: '0.8rem', opacity: 0.7, marginTop: '0.5rem' }}>{result.details.gtm_id}</div>}
              </div>

              <div className={styles.detailItem}>
                <div className={styles.detailLabel}>サーバーサイド / 高度な実装</div>
                <div className={`${styles.detailValue} ${result.details.is_sgtm ? styles.warning : styles.error}`} style={result.details.is_sgtm ? { color: 'var(--warning)' } : {}}>
                  {result.details.is_sgtm ? '可能性あり (Proxy/sGTM)' : '未検出'}
                </div>
              </div>
            </div>

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
