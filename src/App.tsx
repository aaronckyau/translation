import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { captureAudio, createAudioPipeline, type AudioPipeline, type AudioSource } from './audio';
import { mergeCaption, parseServerEvent, type AppConfig, type Caption, type SessionPhase } from '../shared/protocol';
import { exportSrt } from '../shared/subtitles';
import { appPath } from './paths';

type IconName = 'wave' | 'play' | 'stop' | 'screen' | 'meeting' | 'mic' | 'arrow' | 'popout' | 'download' | 'check' | 'close' | 'help';
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    wave: <path d="M4 14v-4m4 8V6m4 15V3m4 15V6m4 8v-4" />,
    play: <path d="m9 5 11 7-11 7Z" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    screen: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4m-3-8 6-3-6-3Z" /></>,
    meeting: <><rect x="3" y="5" width="13" height="14" rx="2" /><path d="m16 9 5-3v12l-5-3" /></>,
    mic: <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    popout: <><rect x="3" y="3" width="18" height="18" rx="3" /><rect x="11" y="12" width="8" height="6" rx="1" /></>,
    download: <path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" />,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 8.5a2.5 2.5 0 1 1 4 2.5c-1 .5-1.5 1-1.5 2M12 16v.1" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function elapsed(seconds: number): string { return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`; }
interface Resources { streams: MediaStream[]; socket: WebSocket | null; pipeline: AudioPipeline | null; startingPipeline: boolean }
const modes: Array<{ id: AudioSource; name: string; detail: string; icon: IconName }> = [
  { id: 'video', name: '網上影片', detail: 'YouTube、網頁版會議', icon: 'screen' },
  { id: 'meeting', name: '桌面會議', detail: 'Zoom、Teams 系統音訊', icon: 'meeting' },
  { id: 'microphone', name: '麥克風', detail: '現場英文語音', icon: 'mic' },
];

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState('');
  const [source, setSource] = useState<AudioSource>('video');
  const [includeMic, setIncludeMic] = useState(false);
  const [phase, setPhase] = useState<SessionPhase | 'idle'>('idle');
  const [status, setStatus] = useState('準備好就開始');
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [interim, setInterim] = useState('');
  const [preview, setPreview] = useState<{ english: string; chinese: string } | null>(null);
  const [error, setError] = useState('');
  const [bilingual, setBilingual] = useState(true);
  const [fontSize, setFontSize] = useState(30);
  const [usage, setUsage] = useState({ audioSeconds: 0, estimatedUsd: 0 });
  const [level, setLevel] = useState(0);
  const [quiet, setQuiet] = useState(false);
  const [help, setHelp] = useState(false);
  const [accessCode, setAccessCode] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const [openingPip, setOpeningPip] = useState(false);
  const resourceRef = useRef<Resources | null>(null);
  const generationRef = useRef(0);
  const intentionalStop = useRef(false);
  const stopRef = useRef<() => void>(() => {});
  const transcriptContainer = useRef<HTMLDivElement | null>(null);
  const helpModal = useRef<HTMLElement | null>(null);
  const autoScroll = useRef(true);
  const active = ['connecting', 'live', 'reconnecting', 'finishing'].includes(phase);
  const canCapture = !!navigator.mediaDevices && window.isSecureContext;
  const pipAvailable = !!window.documentPictureInPicture;
  const latest = [...captions].reverse().find(c => c.translationState === 'done');
  const pending = captions.some(c => c.translationState === 'pending');

  async function refreshConfig(signal?: AbortSignal) {
    try {
      const response = await fetch(appPath('api/config'), { signal });
      if (!response.ok) throw new Error();
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || !('configured' in value) || typeof value.configured !== 'boolean' || !('authenticated' in value) || typeof value.authenticated !== 'boolean') throw new Error();
      setConfig(value as AppConfig);
      setConfigError('');
    } catch {
      if (!signal?.aborted) setConfigError('無法連接服務。請確認服務已啟動，再重試。');
    }
  }
  useEffect(() => {
    const abort = new AbortController();
    void refreshConfig(abort.signal);
    return () => { abort.abort(); generationRef.current++; void release(true); };
  }, []);
  useEffect(() => {
    const container = transcriptContainer.current;
    if (captions.length && autoScroll.current && container) container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, [captions]);
  useEffect(() => {
    if (!help) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHelp(false);
      if (event.key === 'Tab') {
        const buttons = helpModal.current?.querySelectorAll<HTMLButtonElement>('button');
        const first = buttons?.[0];
        const last = buttons?.[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [help]);
  useEffect(() => () => { pipWindow?.close(); }, [pipWindow]);

  async function release(closeSocket: boolean) {
    const resource = resourceRef.current;
    if (!resource) return;
    resourceRef.current = null;
    if (closeSocket) resource.socket?.close();
    await resource.pipeline?.stop();
    resource.streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    setLevel(0);
  }

  async function start() {
    if (active || !config?.configured || !config.authenticated) return;
    const generation = ++generationRef.current;
    intentionalStop.current = false;
    setError(''); setPhase('connecting'); setStatus('請選擇聲音來源'); setQuiet(false);
    let streams: MediaStream[] = [];
    try {
      // The browser picker must open directly from the user's click.
      streams = await captureAudio(source, source !== 'microphone' && includeMic);
      if (generation !== generationRef.current) { streams.forEach(s => s.getTracks().forEach(t => t.stop())); return; }
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${appPath('api/live')}`);
      const resource: Resources = { streams, socket, pipeline: null, startingPipeline: false };
      resourceRef.current = resource;
      setCaptions([]); setInterim(''); setPreview(null); setUsage({ audioSeconds: 0, estimatedUsd: 0 }); autoScroll.current = true;
      let lastVoice = Date.now();
      let speechActive = false;
      let silentSamples = 0;
      const connectTimeout = setTimeout(() => {
        if (generation !== generationRef.current || resource.pipeline) return;
        setError('翻譯連線逾時，請稍後重試。');
        void stop(true);
      }, 20_000);
      streams.forEach(s => s.getTracks().forEach(t => t.addEventListener('ended', () => {
        if (generation === generationRef.current && !intentionalStop.current) stopRef.current();
      }, { once: true })));
      socket.onmessage = event => {
        if (generation !== generationRef.current) return;
        let message;
        try { message = parseServerEvent(JSON.parse(String(event.data))); } catch { return; }
        if (!message) return;
        switch (message.type) {
          case 'status':
            setPhase(message.phase); setStatus(message.message);
            if (message.phase === 'live' && !resource.pipeline && !resource.startingPipeline && !intentionalStop.current) {
              resource.startingPipeline = true;
              void createAudioPipeline(streams, (buffer, rms) => {
                if (generation !== generationRef.current || socket.readyState !== WebSocket.OPEN) return;
                if (socket.bufferedAmount > 320_000) { setError('網絡速度跟不上音訊傳送，請重新開始。'); void stop(true); return; }
                socket.send(buffer);
                setLevel(Math.min(1, rms * 8));
                const durationMs = buffer.byteLength / 32;
                if (rms > 0.007) { lastVoice = Date.now(); silentSamples = 0; speechActive = true; setQuiet(false); }
                else {
                  silentSamples += durationMs;
                  if (speechActive && silentSamples > 650) { socket.send(JSON.stringify({ type: 'flush' })); speechActive = false; }
                  if (Date.now() - lastVoice > 10_000) setQuiet(true);
                }
              }).then(pipeline => {
                clearTimeout(connectTimeout);
                if (generation !== generationRef.current || intentionalStop.current || resourceRef.current !== resource) void pipeline.stop();
                else resource.pipeline = pipeline;
              }).catch(() => { setError('無法啟動收音，請檢查瀏覽器權限後重試。'); void stop(true); });
            }
            if (message.phase === 'finishing') { intentionalStop.current = true; void resource.pipeline?.stop(); streams.forEach(s => s.getTracks().forEach(t => t.stop())); }
            if (message.phase === 'stopped') { intentionalStop.current = true; clearTimeout(connectTimeout); void release(false); setInterim(''); setPreview(null); }
            break;
          case 'interim': setInterim(message.english); break;
          case 'preview': setPreview(message.chinese ? { english: message.english, chinese: message.chinese } : null); break;
          case 'caption': setCaptions(current => mergeCaption(current, message.caption)); break;
          case 'usage': setUsage({ audioSeconds: message.audioSeconds, estimatedUsd: message.estimatedUsd }); break;
          case 'error': setError(message.message); if (message.fatal) { intentionalStop.current = true; setPreview(null); void release(false); } break;
        }
      };
      socket.onclose = () => {
        clearTimeout(connectTimeout);
        if (generation !== generationRef.current) return;
        setPreview(null);
        if (!intentionalStop.current) setError('翻譯連線中斷。請檢查網絡、Gemini 設定及服務用量後重新開始。');
        intentionalStop.current = true;
        void release(false); setPhase('stopped'); setStatus('翻譯已停止'); setInterim('');
        setCaptions(current => current.map(c => c.translationState === 'pending' ? { ...c, translationState: 'error' } : c));
      };
      socket.onerror = () => { if (generation === generationRef.current) setError('無法連接翻譯服務，請稍後再試。'); };
    } catch (caught) {
      streams.forEach(s => s.getTracks().forEach(t => t.stop()));
      if (generation !== generationRef.current) return;
      setError(caught instanceof Error ? caught.message : '無法開始收音，請重新再試。');
      setPhase('idle'); setStatus('準備好就開始');
      void release(true);
    }
  }

  async function stop(force = false) {
    const resource = resourceRef.current;
    intentionalStop.current = true;
    if (force || !resource?.pipeline) {
      generationRef.current++;
      await release(true); setPhase('stopped'); setStatus('翻譯已停止'); setInterim(''); setPreview(null);
      setCaptions(current => current.map(c => c.translationState === 'pending' ? { ...c, translationState: 'error' } : c));
      return;
    }
    setPhase('finishing'); setStatus('正在完成最後幾句字幕…');
    await resource.pipeline.stop();
    resource.streams.forEach(s => s.getTracks().forEach(t => t.stop()));
    setLevel(0);
    if (resource.socket?.readyState === WebSocket.OPEN) resource.socket.send(JSON.stringify({ type: 'stop' }));
    else { await release(true); setPhase('stopped'); }
  }
  stopRef.current = () => { void stop(); };

  async function openPip() {
    if (!pipAvailable || openingPip) return;
    setOpeningPip(true);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    try {
      const api = window.documentPictureInPicture;
      if (!api) return;
      const request = api.requestWindow({ width: 720, height: 240 }).then(pip => {
        if (expired) pip.close();
        return pip;
      });
      const pip = await Promise.race([
        request,
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => { expired = true; reject(new Error('timeout')); }, 5000); }),
      ]);
      document.querySelectorAll('style, link[rel="stylesheet"]').forEach(node => pip.document.head.appendChild(node.cloneNode(true)));
      pip.document.title = '聲譯 · 浮動字幕';
      pip.document.documentElement.lang = 'zh-Hant';
      pip.document.body.className = 'pip-body';
      pip.addEventListener('pagehide', () => setPipWindow(null), { once: true });
      setPipWindow(pip);
    } catch { setError('此瀏覽器未能開啟浮動字幕。請用獨立的電腦版 Chrome／Edge 開啟此網站後再試。'); }
    finally { if (timeout) clearTimeout(timeout); setOpeningPip(false); }
  }
  async function login(event: FormEvent) {
    event.preventDefault(); setLoggingIn(true); setError('');
    try {
      const response = await fetch(appPath('api/login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: accessCode }) });
      if (!response.ok) { const value = await response.json() as { message: string }; throw new Error(value.message); }
      setAccessCode(''); await refreshConfig();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '登入失敗，請重試。'); }
    finally { setLoggingIn(false); }
  }
  function download() {
    const blob = new Blob(['\uFEFF', exportSrt(captions, bilingual)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `聲譯-${new Date().toISOString().replace(/[:.]/g, '-')}.srt`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const subtitle = (
    <div className={`subtitle-content ${pipWindow ? 'has-pip' : ''}`} style={{ '--subtitle-size': `${fontSize}px` } as CSSProperties}>
      <p className={`chinese ${preview || latest ? '' : 'placeholder'}`}>{preview?.chinese || latest?.chinese || (active ? '聆聽中，中文字幕即將出現…' : '你的中文字幕，會在這裡出現。')}</p>
      {bilingual && <p className="english" lang="en">{interim || preview?.english || latest?.english || (active ? 'Waiting for speech…' : '開始播放英文內容，我們會為你即時翻譯。')}</p>}
      {preview ? <span className="translating">即時預覽 · 會隨語句更新</span> : pending && <span className="translating">正在翻譯下一句<span className="dots">…</span></span>}
    </div>
  );

  return <>
    <header className="topbar"><a className="brand" href={appPath('')} aria-label="聲譯首頁"><span className="brand-icon"><Icon name="wave" size={25} /></span><span>聲譯<span className="brand-caption">讓理解，跟上聲音。</span></span></a><div className="top-actions"><span className="browser-label">瀏覽器開啟 · 免安裝</span><button className="text-button" onClick={() => setHelp(true)}><Icon name="help" size={18} />使用說明</button></div></header>
    <main>
      <section className="hero"><div><div className="eyebrow"><span className="tiny-dot" />即時英文語音翻譯</div><h1>聽見英文。<br /><span>看懂每一句。</span></h1><p className="hero-description">影片、會議、現場對話。讓繁體中文字幕，<br className="desktop-break" />陪你跟上正在發生的內容。</p></div><div className="language-card" aria-label="英文翻譯為繁體中文"><div><span className="language-code">EN</span><span>英文語音</span></div><span className="language-arrow"><Icon name="arrow" size={26} /></span><div><span className="language-code zh">繁中</span><span>即時字幕</span></div><span className="language-note">聆聽 · 翻譯 · 理解</span></div></section>

      {configError && <div className="notice error-notice" role="alert">{configError}<button onClick={() => void refreshConfig()}>重試</button></div>}
      {config && !config.configured && <div className="notice setup-notice"><div className="notice-symbol">i</div><div><strong>翻譯服務尚未設定</strong><p>管理員完成 Gemini 連線設定後即可使用。</p></div><button className="text-button" onClick={() => void refreshConfig()}>重新檢查</button></div>}
      {!canCapture && <div className="notice error-notice" role="alert">此環境未提供收音功能，請在電腦版 Chrome／Edge 的 HTTPS 網站或 localhost 開啟。</div>}
      {error && <div className="notice error-notice" role="alert"><span>{error}</span><button className="icon-button" aria-label="關閉訊息" onClick={() => setError('')}><Icon name="close" size={18} /></button></div>}
      {config?.requiresAccessCode && !config.authenticated && <form className="login-form" onSubmit={event => void login(event)}><label htmlFor="access-code">輸入管理員提供的使用密碼</label><div><input id="access-code" type="password" autoComplete="current-password" value={accessCode} onChange={e => setAccessCode(e.target.value)} required maxLength={200} /><button className="primary-button" disabled={loggingIn}>{loggingIn ? '登入中…' : '登入'}</button></div></form>}

      <div className="workspace">
        <section className="translator" aria-label="即時字幕">
          <div className="subtitle-screen"><div className="screen-top"><span className={`live-label ${phase === 'live' ? 'is-live' : ''}`}><span className="tiny-dot" />{phase === 'live' ? '即時翻譯中' : phase === 'reconnecting' ? '更新連線中' : '字幕預覽'}</span><span className="screen-time">{elapsed(usage.audioSeconds)}</span></div>{subtitle}<div className="screen-bottom"><span className="sound-bars" aria-hidden="true">{Array.from({ length: 16 }, (_, i) => <i key={i} style={{ height: `${4 + level * (8 + ((i * 13) % 23))}px` }} />)}</span><span>{active ? quiet ? '暫未偵測到語音，請確認來源正在播放' : status : '開啟聲音，字幕隨之而來'}</span></div></div>
          <div className="subtitle-toolbar"><label className="toggle"><input type="checkbox" checked={bilingual} onChange={e => setBilingual(e.target.checked)} /><span className="toggle-track" />中英雙語</label><label className="font-control"><span>字體</span><input type="range" min="22" max="46" value={fontSize} onChange={e => setFontSize(Number(e.target.value))} aria-label="字幕字體大小" /><span className="font-preview">Aa</span></label><button className="secondary-button" onClick={() => void openPip()} disabled={!pipAvailable || !!pipWindow || openingPip} title={pipAvailable ? '開啟置頂字幕視窗' : '浮動字幕需要支援的電腦版 Chrome／Edge'}><Icon name="popout" size={18} />{openingPip ? '正在開啟…' : pipWindow ? '浮動字幕已開啟' : '浮動字幕'}</button></div>
          {!pipAvailable && <p className="browser-note">目前瀏覽器未提供浮動字幕視窗，可在桌面版 Chrome／Edge 試用。</p>}
          <section className="transcript"><div className="section-heading"><div><h2>字幕紀錄 <span className="count">{captions.length}</span></h2><p>每一句，都可以回看。</p></div><button className="text-button" onClick={download} disabled={!captions.length || active}><Icon name="download" size={17} />下載字幕</button></div><div className="transcript-scroll" ref={transcriptContainer} onScroll={e => { const target = e.currentTarget; autoScroll.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80; }}>
            {!captions.length ? <div className="empty-transcript"><span className="empty-icon"><Icon name="wave" size={23} /></span><div><strong>這裡會留下你的字幕紀錄</strong><p>開始翻譯後，英文原文及中文翻譯會逐句顯示。</p></div></div> : captions.map(caption => <article className="caption-row" key={caption.id}><time>{elapsed(caption.startMs / 1000)}</time><div><p className={caption.translationState === 'done' ? '' : 'caption-status'}>{caption.translationState === 'done' ? caption.chinese : caption.translationState === 'error' ? '此句翻譯失敗，已保留英文原文。' : '翻譯中…'}</p>{bilingual && <p className="caption-english" lang="en">{caption.english}</p>}</div></article>)}</div>{!!captions.length && !active && <p className="retention-note">字幕只保留在本次網頁中。重新開始或重新整理前，請先下載。</p>}</section>
        </section>

        <aside className="control-panel"><div className="panel-heading"><span className="step-number">01</span><div><h2>選擇聲音來源</h2><p>你想翻譯哪裡的英文？</p></div></div><div className="source-options" role="radiogroup" aria-label="聲音來源">{modes.map(mode => <button key={mode.id} role="radio" aria-checked={source === mode.id} className={`source-option ${source === mode.id ? 'selected' : ''}`} disabled={active} onClick={() => setSource(mode.id)}><span className="source-icon"><Icon name={mode.icon} size={21} /></span><span><strong>{mode.name}</strong><small>{mode.detail}</small></span><span className="radio-dot">{source === mode.id && <span />}</span></button>)}</div>
          <div className="source-hint"><Icon name={source === 'microphone' ? 'mic' : 'check'} size={17} /><p>{source === 'video' ? '選擇播放英文的分頁，記得勾選「分享分頁音訊」。' : source === 'meeting' ? 'Windows 請選擇整個螢幕，勾選「分享系統音訊」。其他系統建議使用網頁版會議。' : '允許使用麥克風，並靠近英文聲音來源。'}</p></div>
          {source !== 'microphone' && <label className="mic-checkbox"><input type="checkbox" disabled={active} checked={includeMic} onChange={e => setIncludeMic(e.target.checked)} />同時收錄我的麥克風</label>}
          <div className="panel-divider" /><div className="panel-heading"><span className="step-number">02</span><div><h2>開始，讓字幕跟上</h2><p>授權分享後，收音及翻譯才會開始。</p></div></div>
          {active ? <button className="stop-button" disabled={phase === 'finishing'} onClick={() => void stop()}><Icon name="stop" size={18} />{phase === 'finishing' ? '完成最後字幕中…' : phase === 'connecting' ? '取消連接' : '停止翻譯'}</button> : <button className="primary-button start-button" disabled={!config?.configured || !config?.authenticated || !canCapture} onClick={() => void start()}><Icon name="play" size={19} />開始翻譯<Icon name="arrow" size={19} /></button>}
          <p className="permission-note">停止分享即停止收音。畫面影像不會傳送至翻譯服務。</p><div className="usage-card"><div><span>本次使用</span><strong>{elapsed(usage.audioSeconds)}</strong></div><div><span>預估 API 費用</span><strong>US${usage.estimatedUsd.toFixed(3)}</strong></div></div><p className="cost-note">僅供參考，按預設模型費率估算；實際以帳戶帳單為準。</p>
        </aside>
      </div>
      <section className="features"><div><span className="feature-symbol">✦</span><span><strong>跟著聲音，即時理解</strong><small>字幕稍遲於語音，延遲視網絡及內容而定。</small></span></div><div><Icon name="popout" size={21} /><span><strong>視窗切換，字幕仍在</strong><small>開啟浮動字幕，繼續看影片或參與會議。</small></span></div><div><Icon name="download" size={21} /><span><strong>需要時，再回看</strong><small>停止後下載 SRT 字幕，保留重點內容。</small></span></div></section>
    </main><footer><span>聲譯 <span className="footer-dot">·</span> 讓語言少一點距離。</span><span>音訊交由 Gemini 處理 · 伺服器不保存錄音及字幕</span></footer>
    {pipWindow && createPortal(<div className="pip-layout"><div className="pip-top"><span><Icon name="wave" size={16} />聲譯</span><span>{active ? '即時字幕' : '已停止'}</span></div>{subtitle}</div>, pipWindow.document.body)}
    {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><section className="help-modal" ref={helpModal} role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={event => event.stopPropagation()}><div className="section-heading"><h2 id="help-title">開始使用聲譯</h2><button className="icon-button" aria-label="關閉說明" autoFocus onClick={() => setHelp(false)}><Icon name="close" /></button></div><ol><li><strong>播放英文內容</strong><p>在另一個分頁開啟影片，或加入 Zoom／Teams 會議。</p></li><li><strong>選擇來源並分享聲音</strong><p>網頁版會議請選「網上影片」；桌面版會議請選「桌面會議」。分享時一定要勾選音訊。</p></li><li><strong>開啟浮動字幕</strong><p>在支援的桌面瀏覽器中，字幕視窗會保持置頂。遇到全螢幕顯示問題，請改用一般視窗。</p></li><li><strong>停止及下載</strong><p>按停止後，等最後幾句完成，再下載字幕。時間戳記按收音時間估算，並非影片原始時間軸。</p></li></ol><p className="help-note">建議使用 Windows＋最新電腦版 Chrome／Edge。系統音訊及浮動視窗支援會因瀏覽器與裝置而異。字幕需要網絡連線，可能出現翻譯錯誤。</p><button className="primary-button" onClick={() => setHelp(false)}>開始使用</button></section></div>}
  </>;
}
