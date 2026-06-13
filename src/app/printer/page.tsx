'use client';

import { useState, useRef } from 'react';
import styles from '../page.module.css';

export default function PrinterPage() {
    const [status, setStatus] = useState<'idle' | 'searching' | 'connecting' | 'connected' | 'error'>('idle');
    const [currentDevice, setCurrentDevice] = useState<any>(null);
    const [server, setServer] = useState<any>(null);
    const [service, setService] = useState<any>(null);
    const [characteristic, setCharacteristic] = useState<any>(null);
    const [logs, setLogs] = useState<string[]>([]);
    
    const SERVICE_UUID = 'e7811271-d73f-49f0-8757-990927b2bc10';
    const CHARACTERISTIC_UUID = 'bef8d6c9-9c21-4c9e-b632-bd581100031c';

    const addLog = (msg: string) => {
        setLogs(prev => [new Date().toLocaleTimeString() + ': ' + msg, ...prev.slice(0, 19)]);
    };

    // Step 1: Device Search
    const searchDevice = async () => {
        try {
            setStatus('searching');
            addLog('1. デバイス検索中...');
            const device = await (navigator as any).bluetooth.requestDevice({
                filters: [{ namePrefix: 'MP-B20' }],
                optionalServices: [SERVICE_UUID, '000018f0-0000-1000-8000-00805f9b34fb']
            });
            setCurrentDevice(device);
            addLog(`-> 発見: ${device.name}`);
            setStatus('idle');
        } catch (e: any) {
            addLog(`ERR: ${e.message}`);
            setStatus('error');
        }
    };

    // Step 2: GATT Connect
    const connectGatt = async () => {
        if (!currentDevice) return;
        try {
            setStatus('connecting');
            addLog('2. GATTサーバーに接続試行...');
            const server = await currentDevice.gatt.connect();
            setServer(server);
            addLog('-> GATT接続成功！');
            setStatus('idle');
        } catch (e: any) {
            addLog(`ERR: ${e.message}`);
            setStatus('error');
        }
    };

    // Step 3: Service Discovery
    const discoverService = async () => {
        if (!server) return;
        try {
            addLog('3. プライマリサービス取得中...');
            const s = await server.getPrimaryService(SERVICE_UUID);
            setService(s);
            addLog('-> サービス取得成功！');
        } catch (e: any) {
            addLog(`ERR: ${e.message}`);
        }
    };

    // Step 4: Characteristic Find
    const findCharacteristic = async () => {
        if (!service) return;
        try {
            addLog('4. 特性(Characteristic)取得中...');
            const c = await service.getCharacteristic(CHARACTERISTIC_UUID);
            setCharacteristic(c);
            addLog('-> 特性取得成功！READY');
        } catch (e: any) {
            addLog(`ERR: ${e.message}`);
        }
    };

    const printTest = async () => {
        if (!characteristic) return;
        try {
            addLog('5. 印刷データ送信中...');
            const encoder = new TextEncoder();
            const data = encoder.encode('\x1B@' + 'DIAGNOSTIC PRINT\n' + new Date().toLocaleTimeString() + '\n\n\n\n');
            
            // Chunk write
            const CHUNK_SIZE = 20;
            for (let i = 0; i < data.length; i += CHUNK_SIZE) {
                const chunk = data.slice(i, i + CHUNK_SIZE);
                await characteristic.writeValue(chunk);
            }
            addLog('-> 送信完了！');
        } catch (e: any) {
            addLog(`ERR: ${e.message}`);
        }
    };

    const resetAll = () => {
        if (currentDevice?.gatt?.connected) {
            currentDevice.gatt.disconnect();
        }
        setCurrentDevice(null);
        setServer(null);
        setService(null);
        setCharacteristic(null);
        setStatus('idle');
        setLogs([]);
        addLog('リセットしました。');
    };

    return (
        <main className={styles.main} style={{ background: '#1a1a1a', color: '#fff', padding: '20px', minHeight: '100vh' }}>
            <h1 style={{ color: '#ffcc00', borderBottom: '2px solid #ffcc00', paddingBottom: '10px' }}>Step-by-Step Diagnostic</h1>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginTop: '20px' }}>
                
                <section style={{ padding: '15px', background: '#333', borderRadius: '8px' }}>
                    <h3 style={{ marginTop: 0 }}>Step 1: 検索</h3>
                    <button onClick={searchDevice} style={{ width: '100%', padding: '10px', background: currentDevice ? '#555' : '#007bff', color: '#fff', border: 'none' }}>
                        {currentDevice ? `OK: ${currentDevice.name}` : 'デバイスを探す'}
                    </button>
                </section>

                <section style={{ padding: '15px', background: '#333', borderRadius: '8px', opacity: currentDevice ? 1 : 0.5 }}>
                    <h3 style={{ marginTop: 0 }}>Step 2: 接続</h3>
                    <button onClick={connectGatt} disabled={!currentDevice} style={{ width: '100%', padding: '10px', background: server ? '#555' : '#28a745', color: '#fff', border: 'none' }}>
                        {server ? 'OK: Connected' : 'GATT接続を実行'}
                    </button>
                </section>

                <section style={{ padding: '15px', background: '#333', borderRadius: '8px', opacity: server ? 1 : 0.5 }}>
                    <h3 style={{ marginTop: 0 }}>Step 3: サービス発見</h3>
                    <button onClick={discoverService} disabled={!server} style={{ width: '100%', padding: '10px', background: service ? '#555' : '#6f42c1', color: '#fff', border: 'none' }}>
                        {service ? 'OK: Service Found' : 'サービスを特定'}
                    </button>
                </section>

                <section style={{ padding: '15px', background: '#333', borderRadius: '8px', opacity: service ? 1 : 0.5 }}>
                    <h3 style={{ marginTop: 0 }}>Step 4: 特性取得</h3>
                    <button onClick={findCharacteristic} disabled={!service} style={{ width: '100%', padding: '10px', background: characteristic ? '#555' : '#e83e8c', color: '#fff', border: 'none' }}>
                        {characteristic ? 'OK: Ready to Print' : '書き込み口を特定'}
                    </button>
                </section>

                {characteristic && (
                    <button onClick={printTest} style={{ padding: '20px', background: '#ffcc00', color: '#000', fontWeight: 'bold', fontSize: '1.2rem', border: 'none' }}>
                        FINAL: 印刷実行
                    </button>
                )}

                <button onClick={resetAll} style={{ marginTop: '10px', padding: '10px', background: 'transparent', border: '1px solid #ff4444', color: '#ff4444' }}>
                    すべてリセット
                </button>
            </div>

            <div style={{ marginTop: '20px', background: '#000', padding: '10px', fontFamily: 'monospace', fontSize: '0.8rem', height: '150px', overflowY: 'auto' }}>
                <div style={{ color: '#aaa', marginBottom: '5px' }}>-- Logs --</div>
                {logs.map((log, i) => <div key={i}>{log}</div>)}
            </div>

            <div style={{ marginTop: '20px', fontSize: '0.8rem', color: '#aaa', lineHeight: '1.5' }}>
                <strong>【重要確認事項】</strong><br/>
                ・Androidの「位置情報(GPS)」はONですか？<br/>
                ・プリンター側が「iOSモード(BLE)」になっていますか？<br/>
                  (ランプが青点滅ならOK。緑ならClassic接続モードの可能性があります)
            </div>
        </main>
    );
}
