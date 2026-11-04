import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';

type Language = 'pt' | 'en';

type YoutubeStatus = {
  connected: boolean;
  channelTitle?: string | null;
  channelThumbnailUrl?: string | null;
};

type YoutubeLive = {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  privacyStatus: string | null;
  duration: string | null;
  videoUrl: string;
};

type ImportJob = {
  id: string;
  videoId: string;
  status: 'running' | 'completed' | 'failed';
  stage?: string;
  progressPercent: number;
  error?: string;
  updatedAt: string;
};

type PlannedClip = { id: string; start: number; duration: number; transcriptPreview: string };
type RenderedClip = { name: string; path: string; sizeBytes: number };
type Recording = {
  id: string;
  sourcePath: string;
  status: string;
  createdAt: string;
  processing?: { phase: string; renderedCuts: number; totalCuts: number; message: string };
  plannedEpisodes: PlannedClip[];
  plannedShorts: PlannedClip[];
  episodes: RenderedClip[];
  shorts: RenderedClip[];
};

const toMediaUrl = (relativePath: string) => `/api/media/${relativePath}`;
const fmtSeconds = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

const getRouteVideoId = () => {
  const match = window.location.pathname.match(/^\/cut\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
};

const translations = {
  pt: {
    languageLabel: 'Idioma',
    language: 'Português',
    brand: 'Eview Studio',
    login: 'Login com YouTube',
    connected: 'Conectado',
    update: 'Atualizar',
    liveList: 'Lives da conta conectada',
    loading: 'Carregando...',
    loginRequired: 'Faça login para ver as lives.',
    openCutPage: 'Abrir página de corte',
    openYoutube: 'Abrir no YouTube',
    openOriginal: 'Live original',
    closePlayer: 'Fechar player',
    importButton: 'Baixar live + planejar episódios e shorts',
    importing: 'Baixando live...',
    regenerateShorts: 'Regenerar plano de shorts',
    regenerateEpisodes: 'Regenerar plano de episódios',
    process: 'Processo',
    processTitle: 'Progresso do processo',
    download: 'Download',
    step: 'Etapa',
    rendered: 'Renderizados',
    clipsPlanned: 'Clipes planejados',
    noPlan: 'O plano aparece após análise de áudio/transcrição.',
    episodesPlanned: 'Episódios planejados',
    shortsPlanned: 'Shorts planejados',
    renderAll: 'Renderizar todos',
    renderSelected: 'Renderizar selecionados',
    preview: 'Pré-visualização',
    renderClip: 'Renderizar corte',
    close: 'Fechar',
    suggestedCut: 'Corte sugerido',
    renderThisCut: 'Renderizar este corte',
    previous: 'Anterior',
    next: 'Próximo',
    inlinePreview: 'Pré-visualização inline',
    generatedClips: 'Clipes gerados',
    noGeneratedClips: 'Os clipes aparecerão aqui assim que o render terminar.',
    episodes: 'Episódios',
    shorts: 'Shorts',
    downloadClip: 'Baixar',
    channel: 'Canal',
    privacy: 'Privacidade',
    duration: 'Duração',
    unknown: 'não informada',
    unknownPrivacy: 'desconhecida',
    originalVideo: 'vídeo original'
  },
  en: {
    languageLabel: 'Language',
    language: 'English',
    brand: 'Eview Studio',
    login: 'Log in with YouTube',
    connected: 'Connected',
    update: 'Refresh',
    liveList: 'Lives from connected account',
    loading: 'Loading...',
    loginRequired: 'Log in to view the lives.',
    openCutPage: 'Open cut page',
    openYoutube: 'Open on YouTube',
    openOriginal: 'Original live',
    closePlayer: 'Close player',
    importButton: 'Download live + plan episodes and shorts',
    importing: 'Downloading live...',
    regenerateShorts: 'Regenerate shorts plan',
    regenerateEpisodes: 'Regenerate episodes plan',
    process: 'Process',
    processTitle: 'Process progress',
    download: 'Download',
    step: 'Stage',
    rendered: 'Rendered',
    clipsPlanned: 'Planned clips',
    noPlan: 'The plan appears after audio/transcript analysis.',
    episodesPlanned: 'Planned episodes',
    shortsPlanned: 'Planned shorts',
    renderAll: 'Render all',
    renderSelected: 'Render selected',
    preview: 'Preview',
    renderClip: 'Render clip',
    close: 'Close',
    suggestedCut: 'Suggested cut',
    renderThisCut: 'Render this cut',
    previous: 'Previous',
    next: 'Next',
    inlinePreview: 'Inline preview',
    generatedClips: 'Generated clips',
    noGeneratedClips: 'Clips will appear here as soon as rendering finishes.',
    episodes: 'Episodes',
    shorts: 'Shorts',
    downloadClip: 'Download',
    channel: 'Channel',
    privacy: 'Privacy',
    duration: 'Duration',
    unknown: 'not available',
    unknownPrivacy: 'unknown',
    originalVideo: 'original video'
  }
} as const;

const phaseMeta: Record<string, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success'; icon: string }> = {
  queued: { label: 'Na fila', tone: 'neutral', icon: '⏳' },
  ingesting: { label: 'Importando live', tone: 'info', icon: '⬇️' },
  'analyzing-transcript': { label: 'Analisando transcrição', tone: 'info', icon: '📝' },
  'detecting-silence': { label: 'Detectando silêncio', tone: 'info', icon: '🔊' },
  'planning-cuts': { label: 'Planejando cortes', tone: 'info', icon: '✂️' },
  planned: { label: 'Plano pronto', tone: 'success', icon: '📋' },
  rendering: { label: 'Renderizando clipes', tone: 'info', icon: '🎬' },
  downloaded: { label: 'Download concluído', tone: 'success', icon: '✅' },
  downloading: { label: 'Baixando live', tone: 'info', icon: '⬇️' },
  completed: { label: 'Concluído', tone: 'success', icon: '✅' },
  failed: { label: 'Falhou', tone: 'warning', icon: '⚠️' },
  running: { label: 'Em andamento', tone: 'info', icon: '▶️' },
  standby: { label: 'Em espera', tone: 'neutral', icon: '◌' },
};

const phaseMetaEn: Record<string, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success'; icon: string }> = {
  queued: { label: 'Queued', tone: 'neutral', icon: '⏳' },
  ingesting: { label: 'Importing live', tone: 'info', icon: '⬇️' },
  'analyzing-transcript': { label: 'Analyzing transcript', tone: 'info', icon: '📝' },
  'detecting-silence': { label: 'Detecting silence', tone: 'info', icon: '🔊' },
  'planning-cuts': { label: 'Planning cuts', tone: 'info', icon: '✂️' },
  planned: { label: 'Plan ready', tone: 'success', icon: '📋' },
  rendering: { label: 'Rendering clips', tone: 'info', icon: '🎬' },
  downloaded: { label: 'Download complete', tone: 'success', icon: '✅' },
  downloading: { label: 'Downloading live', tone: 'info', icon: '⬇️' },
  completed: { label: 'Completed', tone: 'success', icon: '✅' },
  failed: { label: 'Failed', tone: 'warning', icon: '⚠️' },
  running: { label: 'In progress', tone: 'info', icon: '▶️' },
  standby: { label: 'On standby', tone: 'neutral', icon: '◌' },
};

const formatPhaseLabel = (phase?: string | null, language: Language = 'pt') =>
  (language === 'en' ? phaseMetaEn[phase ?? '']?.label : phaseMeta[phase ?? '']?.label) ?? (phase ? phase.replace(/-/g, ' ') : (language === 'en' ? 'No status' : 'Sem status'));
const getPhaseTone = (phase?: string | null, language: Language = 'pt') =>
  (language === 'en' ? phaseMetaEn[phase ?? '']?.tone : phaseMeta[phase ?? '']?.tone) ?? 'neutral';
const getMetricTone = (phase?: string | null, language: Language = 'pt') => getPhaseTone(phase, language);

const getDownloadState = (hasImport: ImportJob | undefined, hasRecording: Recording | undefined, language: Language = 'pt') => {
  const labels = {
    processed: language === 'en' ? 'Downloaded and processed' : 'Baixado e processado',
    notStarted: language === 'en' ? 'Not started' : 'Não iniciado',
  };

  if (hasRecording) {
    return { progressPercent: 100, label: labels.processed, tone: 'success' as const };
  }
  if (hasImport) {
    return { progressPercent: hasImport.progressPercent, label: formatPhaseLabel(hasImport.status || hasImport.stage, language), tone: getPhaseTone(hasImport.status || hasImport.stage, language) };
  }
  return { progressPercent: 0, label: labels.notStarted, tone: 'neutral' as const };
};

const getClipStatus = (kind: 'episodes' | 'shorts', clipId: string, recording?: Recording | null, language: Language = 'pt') => {
  const labels = {
    ready: language === 'en' ? 'Ready' : 'Pronto',
    rendered: language === 'en' ? 'Rendered' : 'Renderizado',
  };

  if (!recording) return { label: labels.ready, tone: 'ready' as const };
  const rendered = kind === 'episodes' ? recording.episodes : recording.shorts;
  const isRendered = rendered.some((clip) => clip.name.includes(clipId));
  if (isRendered) return { label: labels.rendered, tone: 'rendered' as const };
  return { label: labels.ready, tone: 'ready' as const };
};

function App() {
  const [language, setLanguage] = useState<Language>('pt');
  const [routeVideoId, setRouteVideoId] = useState<string | null>(getRouteVideoId());
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [selectedPreviewPath, setSelectedPreviewPath] = useState<string | null>(null);
  const [youtubeStatus, setYoutubeStatus] = useState<YoutubeStatus>({ connected: false });
  const [lives, setLives] = useState<YoutubeLive[]>([]);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [importJobs, setImportJobs] = useState<ImportJob[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedEpisodes, setSelectedEpisodes] = useState<string[]>([]);
  const [selectedShorts, setSelectedShorts] = useState<string[]>([]);
  const [sourceSeekSeconds, setSourceSeekSeconds] = useState<number | null>(null);
  const [previewClip, setPreviewClip] = useState<{ kind: 'episodes' | 'shorts'; id: string; start: number; duration: number } | null>(null);
  const [previewProgress, setPreviewProgress] = useState(0);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const t = translations[language];

  useEffect(() => {
    const onPopState = () => setRouteVideoId(getRouteVideoId());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const authFeedback = useMemo(() => {
    const youtube = new URLSearchParams(window.location.search).get('youtube');
    if (youtube === 'connected') return 'Conta YouTube conectada com sucesso.';
    if (youtube === 'error') return 'Falha ao concluir login com YouTube.';
    return null;
  }, []);

  const loadStudioData = async () => {
    setLoading(true);
    setError(null);
    try {
      const statusRes = await fetch('/api/auth/youtube/status');
      if (!statusRes.ok) throw new Error('Falha ao consultar status do YouTube.');
      const statusData = (await statusRes.json()) as YoutubeStatus;
      setYoutubeStatus(statusData);

      if (statusData.connected) {
        const [livesRes, importsRes] = await Promise.all([
          fetch('/api/youtube/lives?limit=24'),
          fetch('/api/youtube/import-jobs'),
        ]);
        if (!livesRes.ok) throw new Error('Falha ao carregar lives.');
        const livesData = (await livesRes.json()) as { data?: YoutubeLive[] };
        setLives(livesData.data ?? []);
        if (importsRes.ok) {
          const importsData = (await importsRes.json()) as { data?: ImportJob[] };
          setImportJobs(importsData.data ?? []);
        } else {
          setImportJobs([]);
        }
      } else {
        setLives([]);
        setImportJobs([]);
      }

      const recordingsRes = await fetch('/api/recordings');
      if (!recordingsRes.ok) throw new Error('Falha ao carregar gravações.');
      const recordingsData = (await recordingsRes.json()) as { data?: Recording[] };
      setRecordings(recordingsData.data ?? []);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Erro ao carregar dados.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadStudioData();
  }, []);

  useEffect(() => {
    const hasRunningImport = importJobs.some((job) => job.status === 'running');
    const hasActiveCut = recordings.some(
      (item) => item.processing?.phase && item.processing.phase !== 'completed',
    );
    if (!hasRunningImport && !hasActiveCut) {
      return;
    }
    const timer = setInterval(() => {
      void loadStudioData();
    }, 10000);
    return () => clearInterval(timer);
  }, [importJobs, recordings]);

  const navigateToCutPage = (videoId: string) => {
    window.history.pushState({}, '', `/cut/${encodeURIComponent(videoId)}`);
    setRouteVideoId(videoId);
  };

  const backToHome = () => {
    window.history.pushState({}, '', '/');
    setRouteVideoId(null);
  };

  const [inlineVideoId, setInlineVideoId] = useState<string | null>(null);

  const openLiveSource = (videoUrl: string) => {
    window.open(videoUrl, '_blank', 'noopener,noreferrer');
  };

  const openOriginalAtTime = (videoId: string, startSeconds: number) => {
    const time = Math.max(0, Math.floor(startSeconds));
    setInlineVideoId(videoId);
    setSourceSeekSeconds(time);
    setFeedback(`Visualizando o trecho do vídeo original em ${fmtSeconds(time)} dentro da plataforma.`);
  };

  const openClipPreview = (kind: 'episodes' | 'shorts', clip: { id: string; start: number; duration: number }) => {
    setPreviewClip({ kind, ...clip });
    setPreviewProgress(0);
    setFeedback(`Pré-visualização do corte ${clip.id} aberta no player do vídeo baixado.`);
  };

  const closeClipPreview = () => {
    setPreviewClip(null);
    setPreviewProgress(0);
    if (previewVideoRef.current) {
      previewVideoRef.current.pause();
      previewVideoRef.current.currentTime = 0;
    }
  };

  const renderManualClip = async (recordingId: string, kind: 'episodes' | 'shorts', clip: { id: string; start: number; duration: number }) => {
    try {
      setError(null);
      setFeedback(null);
      const response = await fetch(`/api/recordings/${encodeURIComponent(recordingId)}/render-clip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, clipId: clip.id, start: clip.start, duration: clip.duration }),
      });
      const body = (await response.json()) as { message?: string };
      if (!response.ok) {
        throw new Error(body.message || 'Falha ao renderizar o corte selecionado.');
      }
      setFeedback(`Corte ${clip.id} renderizado com sucesso.`);
      await loadStudioData();
    } catch (renderError) {
      setError(renderError instanceof Error ? renderError.message : 'Falha ao renderizar corte.');
    }
  };

  const currentLive = routeVideoId ? lives.find((live) => live.videoId === routeVideoId) : null;
  const currentImport = routeVideoId ? importJobs.find((job) => job.videoId === routeVideoId) : null;
  const currentRecording = routeVideoId
    ? recordings.find((item) => item.sourcePath.toLowerCase().includes(routeVideoId.toLowerCase()))
    : null;

  useEffect(() => {
    if (!previewClip || !currentRecording || !previewVideoRef.current) {
      return;
    }

    const video = previewVideoRef.current;
    const handleMetadata = () => {
      video.currentTime = previewClip.start;
      setPreviewProgress(0);
      video.play().catch(() => undefined);
    };

    const handleTimeUpdate = () => {
      const progress = Math.min(100, Math.max(0, ((video.currentTime - previewClip.start) / previewClip.duration) * 100));
      setPreviewProgress(progress);
      if (video.currentTime >= previewClip.start + previewClip.duration) {
        video.pause();
        video.currentTime = previewClip.start;
        setPreviewProgress(0);
      }
    };

    video.addEventListener('loadedmetadata', handleMetadata);
    video.addEventListener('timeupdate', handleTimeUpdate);
    return () => {
      video.removeEventListener('loadedmetadata', handleMetadata);
      video.removeEventListener('timeupdate', handleTimeUpdate);
    };
  }, [previewClip, currentRecording]);

  const toggleSelectedClip = (kind: 'episodes' | 'shorts', clipId: string) => {
    if (kind === 'episodes') {
      setSelectedEpisodes((current) => current.includes(clipId)
        ? current.filter((id) => id !== clipId)
        : [...current, clipId]);
      return;
    }
    setSelectedShorts((current) => current.includes(clipId)
      ? current.filter((id) => id !== clipId)
      : [...current, clipId]);
  };

  const renderSelectedClips = async (kind: 'episodes' | 'shorts') => {
    if (!currentRecording) return;
    const selectedIds = kind === 'episodes' ? selectedEpisodes : selectedShorts;
    if (!selectedIds.length) {
      setError('Selecione ao menos um corte antes de executar os selecionados.');
      return;
    }
    const list = kind === 'episodes' ? currentRecording.plannedEpisodes : currentRecording.plannedShorts;
    const matches = list.filter((clip) => selectedIds.includes(clip.id));
    if (!matches.length) {
      setError('Nenhum corte selecionado foi encontrado no plano atual.');
      return;
    }
    setError(null);
    setFeedback(null);
    for (const clip of matches) {
      await renderManualClip(currentRecording.id, kind, clip);
    }
    setSelectedEpisodes([]);
    setSelectedShorts([]);
  };

  const renderAllPlannedClips = async (kind: 'episodes' | 'shorts') => {
    if (!currentRecording) return;
    const list = kind === 'episodes' ? currentRecording.plannedEpisodes : currentRecording.plannedShorts;
    if (!list.length) {
      setError('Nenhum corte planejado para executar neste grupo.');
      return;
    }
    setError(null);
    setFeedback(null);
    for (const clip of list) {
      await renderManualClip(currentRecording.id, kind, clip);
    }
  };

  const openLiveInline = (videoId: string) => {
    setInlineVideoId((current) => current === videoId ? null : videoId);
    if (inlineVideoId !== videoId) {
      setSourceSeekSeconds(null);
    }
  };

  const closeLiveInline = () => {
    setInlineVideoId(null);
    setSourceSeekSeconds(null);
  };

  const startImport = async (videoId: string) => {
    setError(null);
    setFeedback(null);
    try {
      setImporting(true);
      const response = await fetch(`/api/youtube/lives/${videoId}/import`, { method: 'POST' });
      if (!response.ok) {
        const body = (await response.json()) as { message?: string };
        throw new Error(body.message || 'Falha ao iniciar importação da live.');
      }
      setFeedback('Download iniciado. Você pode acompanhar o progresso nesta página.');
      await loadStudioData();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Falha ao iniciar corte.');
    } finally {
      setImporting(false);
    }
  };

  const regenerateCuts = async (mode: 'all' | 'shorts' | 'episodes' = 'all', resetRender = true) => {
    if (!currentRecording) return;
    setError(null);
    setFeedback(null);
    try {
      const response = await fetch(`/api/recordings/${encodeURIComponent(currentRecording.id)}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, resetRender }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { message?: string };
        throw new Error(body.message || 'Falha ao reagendar os cortes.');
      }
      setFeedback(
        mode === 'all'
          ? 'Cortes reprocessados e enviados ao worker.'
          : `Regeneração de ${mode} iniciada e enviada ao worker.`,
      );
      await loadStudioData();
    } catch (regenerateError) {
      setError(regenerateError instanceof Error ? regenerateError.message : 'Falha ao regenerar os cortes.');
    }
  };

  const renderedClips = useMemo(() => {
    if (!currentRecording) return [];
    return [...currentRecording.episodes, ...currentRecording.shorts];
  }, [currentRecording]);
  const downloadState = useMemo(
    () => getDownloadState(currentImport, currentRecording, language),
    [currentImport, currentRecording, language],
  );
  const selectedClipIndex = useMemo(() => {
    if (!selectedPreviewPath) return -1;
    return renderedClips.findIndex((clip) => clip.path === selectedPreviewPath);
  }, [renderedClips, selectedPreviewPath]);

  useEffect(() => {
    if (!routeVideoId) {
      setSelectedPreviewPath(null);
      return;
    }
    if (!renderedClips.length) {
      setSelectedPreviewPath(null);
      return;
    }
    const selectedStillExists = selectedPreviewPath
      ? renderedClips.some((clip) => clip.path === selectedPreviewPath)
      : false;
    if (!selectedStillExists) {
      setSelectedPreviewPath(renderedClips[0].path);
    }
  }, [routeVideoId, renderedClips, selectedPreviewPath]);

  if (routeVideoId) {
    return (
      <main className="shell">
        <header className="topbar">
          <div className="title-wrap">
            <p className="eyebrow">LIVEFLOW AI</p>
            <h1>Página de corte</h1>
          </div>
          <button className="secondary" onClick={backToHome}>Voltar ao Studio</button>
        </header>

        {feedback ? <p className="feedback ok">{feedback}</p> : null}
        {error ? <p className="feedback error">{error}</p> : null}

        <div className="studio-layout">
          <section className="panel panel-live">
            <div className="panel-header">
              <span className="section-tag">LIVE FEED</span>
              <h2>Live selecionada</h2>
            </div>
          {!currentLive ? (
            <p>Live não encontrada na listagem atual. Atualize o Studio.</p>
          ) : (
            <div className="live-card">
              {currentLive.thumbnailUrl ? (
                inlineVideoId === currentLive.videoId ? (
                  <div className="live-thumb-player-wrap">
                    <div className="player-topbar">
                      <span>{t.openOriginal}</span>
                      <button className="secondary small" type="button" onClick={closeLiveInline}>{t.closePlayer}</button>
                    </div>
                    <iframe
                      className="youtube-embed thumb-embed"
                      src={`https://www.youtube.com/embed/${currentLive.videoId}?rel=0&modestbranding=1${sourceSeekSeconds !== null ? `&start=${sourceSeekSeconds}&autoplay=1` : ''}`}
                      title={currentLive.title}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowFullScreen
                    />
                  </div>
                ) : (
                  <button
                    className="thumb-button"
                    type="button"
                    onClick={() => openLiveInline(currentLive.videoId)}
                    aria-label={`${t.openOriginal} em player inline: ${currentLive.title}`}
                  >
                    <img className="live-thumb" src={currentLive.thumbnailUrl} alt={currentLive.title} />
                  </button>
                )
              ) : null}
              <div className="live-content">
                <h3>{currentLive.title}</h3>
                <p className="live-meta">ID: {currentLive.videoId}</p>
                <p className="live-meta">Privacidade: {currentLive.privacyStatus ?? 'desconhecida'}</p>
                <p className="live-meta">Duração: {currentLive.duration ?? 'não informada'}</p>
                <div className="action-toolbar">
                  <button
                    className="primary action-primary"
                    disabled={importing || currentImport?.status === 'running'}
                    onClick={() => void startImport(routeVideoId)}
                  >
                    {currentImport?.status === 'running'
                      ? t.importing
                      : t.importButton}
                  </button>
                </div>
                <div className="action-grid">
                  <button className="secondary action-secondary" type="button" onClick={() => openLiveSource(currentLive.videoUrl)}>
                  {t.openYoutube}
                  </button>
                  {currentRecording ? (
                    <>
                    <button className="secondary action-secondary" type="button" onClick={() => void regenerateCuts('shorts', true)}>{t.regenerateShorts}</button>
                    <button className="secondary action-secondary" type="button" onClick={() => void regenerateCuts('episodes', true)}>{t.regenerateEpisodes}</button>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </section>

          <section className="panel panel-process">
            <div className="panel-header compact">
              <span className="section-tag">{t.process.toUpperCase()}</span>
              <h2>{t.processTitle}</h2>
              <span className={`status-chip ${getPhaseTone(currentRecording?.processing?.phase ?? currentImport?.status ?? currentImport?.stage ?? 'standby', language)}`}>
                {(phaseMeta[currentRecording?.processing?.phase ?? currentImport?.status ?? currentImport?.stage ?? 'standby']?.icon ?? '◌')} {formatPhaseLabel(currentRecording?.processing?.phase ?? currentImport?.status ?? currentImport?.stage ?? 'standby', language)}
              </span>
            </div>
          <div className="metrics-grid">
            <div className={`metric-card ${downloadState.tone}`}>
              <span>{t.download}</span>
              <strong>{`${downloadState.progressPercent}%`}</strong>
              <small>{downloadState.label}</small>
            </div>
            <div className={`metric-card ${getMetricTone(currentRecording?.processing?.phase ?? currentImport?.stage ?? 'standby', language)}`}>
              <span>{t.step}</span>
              <strong>{formatPhaseLabel(currentRecording?.processing?.phase ?? currentImport?.stage ?? 'standby', language)}</strong>
              <small>{currentRecording?.processing?.message ?? (currentImport?.stage ? formatPhaseLabel(currentImport.stage, language) : 'sem detalhes')}</small>
            </div>
            <div className={`metric-card ${getMetricTone(currentRecording?.processing?.phase ?? 'standby', language)}`}>
              <span>{t.rendered}</span>
              <strong>{currentRecording?.processing ? `${currentRecording.processing.renderedCuts}/${currentRecording.processing.totalCuts}` : '0/0'}</strong>
              <small>{currentRecording?.processing ? 'clipes concluídos' : 'nenhum corte'}</small>
            </div>
          </div>
          <div className="status-legend" aria-label="Legenda de status do processo">
            <span><i className="dot info" />Em progresso</span>
            <span><i className="dot success" />Concluído</span>
            <span><i className="dot warning" />Atenção</span>
          </div>
        </section>

          <section className="panel panel-output">
            <div className="panel-header">
              <span className="section-tag">OUTPUT</span>
              <h2>{t.clipsPlanned}</h2>
            </div>
            {!currentRecording ? (
              <p>{t.noPlan}</p>
            ) : (
              <div className="recording-grid">
                <article className="recording-card surface-blue">
                  <div className="card-header-actions">
                    <h3>{t.episodesPlanned} ({currentRecording.plannedEpisodes.length})</h3>
                    <div className="mini-actions">
                      <button className="secondary small" type="button" onClick={() => void renderAllPlannedClips('episodes')}>
                        {t.renderAll.toUpperCase()}
                      </button>
                      <button className="secondary small" type="button" onClick={() => void renderSelectedClips('episodes')}>
                        {t.renderSelected.toUpperCase()}
                      </button>
                    </div>
                  </div>
                  <ul className="clip-list">
                    {currentRecording.plannedEpisodes.map((clip) => {
                      const selected = selectedEpisodes.includes(clip.id);
                      const state = getClipStatus('episodes', clip.id, currentRecording, language);
                      return (
                        <li key={clip.id}>
                          <div className="planned-clip-row">
                            <div className="planned-clip-main">
                              <div className="clip-headline">
                                <label className="select-toggle">
                                  <input
                                    type="checkbox"
                                    checked={selected}
                                    onChange={() => toggleSelectedClip('episodes', clip.id)}
                                  />
                                  <span>{clip.id}</span>
                                </label>
                                <span className={`clip-badge ${state.tone}`}>{state.label}</span>
                              </div>
                              <div className="split-times">{fmtSeconds(clip.start)} → {fmtSeconds(clip.start + clip.duration)}</div>
                              <div className="clip-duration">Duração: {fmtSeconds(clip.duration)}</div>
                              {clip.transcriptPreview ? <p className="live-meta">{clip.transcriptPreview}</p> : null}
                            </div>
                            <div className="planned-clip-actions">
                              <button className="secondary small" type="button" onClick={() => openClipPreview('episodes', clip)}>
                                {t.preview.toUpperCase()}
                              </button>
                              <button className="render-clip small" type="button" onClick={() => void renderManualClip(currentRecording.id, 'episodes', clip)}>
                                {t.renderClip.toUpperCase()}
                              </button>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </article>
                <article className="recording-card surface-purple">
                  <div className="card-header-actions">
                    <h3>{t.shortsPlanned} ({currentRecording.plannedShorts.length})</h3>
                    <div className="mini-actions">
                      <button className="secondary small" type="button" onClick={() => void renderAllPlannedClips('shorts')}>
                        {t.renderAll.toUpperCase()}
                      </button>
                      <button className="secondary small" type="button" onClick={() => void renderSelectedClips('shorts')}>
                        {t.renderSelected.toUpperCase()}
                      </button>
                    </div>
                  </div>
                  <ul className="clip-list">
                    {currentRecording.plannedShorts.map((clip) => {
                      const selected = selectedShorts.includes(clip.id);
                      const state = getClipStatus('shorts', clip.id, currentRecording, language);
                      return (
                        <li key={clip.id}>
                          <div className="planned-clip-row">
                            <div className="planned-clip-main">
                              <div className="clip-headline">
                                <label className="select-toggle">
                                  <input
                                    type="checkbox"
                                    checked={selected}
                                    onChange={() => toggleSelectedClip('shorts', clip.id)}
                                  />
                                  <span>{clip.id}</span>
                                </label>
                                <span className={`clip-badge ${state.tone}`}>{state.label}</span>
                              </div>
                              <div className="split-times">{fmtSeconds(clip.start)} → {fmtSeconds(clip.start + clip.duration)}</div>
                              <div className="clip-duration">Duração: {fmtSeconds(clip.duration)}</div>
                              {clip.transcriptPreview ? <p className="live-meta">{clip.transcriptPreview}</p> : null}
                            </div>
                            <div className="planned-clip-actions">
                              <button className="secondary small" type="button" onClick={() => openClipPreview('shorts', clip)}>
                                {t.preview.toUpperCase()}
                              </button>
                              <button className="render-clip small" type="button" onClick={() => void renderManualClip(currentRecording.id, 'shorts', clip)}>
                                {t.renderClip.toUpperCase()}
                              </button>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </article>
              </div>
            )}
          </section>
        </div>

        {previewClip && currentRecording ? (
          <div className="clip-preview-modal-backdrop" onClick={closeClipPreview}>
            <div className="clip-preview-modal" onClick={(event) => event.stopPropagation()}>
              <div className="clip-preview-header">
                <div>
                  <span className="section-tag small-tag">{t.preview.toUpperCase()}</span>
                  <h3>{previewClip.kind === 'episodes' ? t.episodes : t.shorts} • {previewClip.id}</h3>
                </div>
                <button className="secondary small" type="button" onClick={closeClipPreview}>{t.close}</button>
              </div>
              <div className="clip-preview-meta">
                <span>{t.suggestedCut}: {fmtSeconds(previewClip.start)} → {fmtSeconds(previewClip.start + previewClip.duration)}</span>
                <span>{t.duration}: {fmtSeconds(previewClip.duration)}</span>
              </div>
              <div className="clip-preview-progress-shell">
                <div className="clip-preview-progress-meta">
                  <span>{t.suggestedCut}</span>
                  <strong>{Math.round(previewProgress)}%</strong>
                </div>
                <div className="clip-preview-progress-track">
                  <div className="clip-preview-progress-bar" style={{ width: `${previewProgress}%` }} />
                </div>
              </div>
              <video
                ref={previewVideoRef}
                className="clip-preview-video"
                controls
                src={toMediaUrl(currentRecording.sourcePath)}
                preload="metadata"
              />
              <button
                className="primary action-primary"
                type="button"
                onClick={() => {
                  void renderManualClip(currentRecording.id, previewClip.kind, previewClip);
                  closeClipPreview();
                }}
              >
                {t.renderThisCut}
              </button>
            </div>
          </div>
        ) : null}

        {currentRecording ? (
          <section className="panel">
            <h2>{t.generatedClips}</h2>
            {selectedPreviewPath ? (
              <div className="inline-preview">
                <div className="inline-preview-toolbar">
                  <p className="live-meta">{t.inlinePreview}</p>
                  <div className="preview-controls">
                    <button
                      className="secondary small"
                      type="button"
                      onClick={() => setSelectedPreviewPath(renderedClips[Math.max(0, selectedClipIndex - 1)]?.path ?? selectedPreviewPath)}
                      disabled={selectedClipIndex <= 0}
                    >
                      {t.previous}
                    </button>
                    <button
                      className="secondary small"
                      type="button"
                      onClick={() => setSelectedPreviewPath(renderedClips[Math.min(renderedClips.length - 1, selectedClipIndex + 1)]?.path ?? selectedPreviewPath)}
                      disabled={selectedClipIndex >= renderedClips.length - 1}
                    >
                      {t.next}
                    </button>
                  </div>
                </div>
                <video
                  key={selectedPreviewPath}
                  className="inline-preview-player"
                  controls
                  preload="metadata"
                  src={toMediaUrl(selectedPreviewPath)}
                />
              </div>
            ) : (
              <p className="live-meta">{t.noGeneratedClips}</p>
            )}
            <div className="recording-grid">
              <article className="recording-card">
                <h3>{t.episodes} ({currentRecording.episodes.length})</h3>
                <ul className="clip-list">
                  {currentRecording.episodes.map((clip) => {
                    const isSelected = selectedPreviewPath === clip.path;
                    return (
                      <li key={clip.path}>
                        <div className={`clip-item${isSelected ? ' selected' : ''}`}>
                          <button
                            className={`clip-link${isSelected ? ' selected' : ''}`}
                            onClick={() => setSelectedPreviewPath(clip.path)}
                            type="button"
                          >
                            {clip.name}
                          </button>
                          <a href={toMediaUrl(clip.path)} download={clip.name}>{t.downloadClip}</a>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </article>
              <article className="recording-card">
                <h3>{t.shorts} ({currentRecording.shorts.length})</h3>
                <ul className="clip-list">
                  {currentRecording.shorts.map((clip) => {
                    const isSelected = selectedPreviewPath === clip.path;
                    return (
                      <li key={clip.path}>
                        <div className={`clip-item${isSelected ? ' selected' : ''}`}>
                          <button
                            className={`clip-link${isSelected ? ' selected' : ''}`}
                            onClick={() => setSelectedPreviewPath(clip.path)}
                            type="button"
                          >
                            {clip.name}
                          </button>
                          <a href={toMediaUrl(clip.path)} download={clip.name}>{t.downloadClip}</a>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </article>
            </div>
          </section>
        ) : null}
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="title-wrap">
        <p className="eyebrow">{t.brand}</p>
        <h1>{t.brand}</h1>
          {youtubeStatus.connected && youtubeStatus.channelTitle ? (
          <p className="channel-label">{t.channel}: {youtubeStatus.channelTitle}</p>
          ) : null}
        </div>
      <div className="topbar-actions">
        <label className="language-selector">
          <span>{t.languageLabel}</span>
          <select value={language} onChange={(event) => setLanguage(event.target.value as Language)}>
            <option value="pt">Português</option>
            <option value="en">English</option>
          </select>
        </label>
        {youtubeStatus.connected ? (
          <div className="connected-wrap">
            {youtubeStatus.channelThumbnailUrl ? (
              <img src={youtubeStatus.channelThumbnailUrl} alt={t.channel} className="channel-thumb" />
            ) : null}
            <span className="connected">{t.connected}</span>
          </div>
        ) : (
          <a className="primary" href="/api/auth/youtube">{t.login}</a>
        )}
      </div>
      </header>

      {authFeedback ? <p className="feedback ok">{authFeedback}</p> : null}
      {error ? <p className="feedback error">{error}</p> : null}

      <section className="panel">
        <div className="panel-header">
          <h2>{t.liveList}</h2>
          <button className="secondary" onClick={() => void loadStudioData()} disabled={loading}>{t.update}</button>
        </div>
        {loading ? (
          <p>{t.loading}</p>
        ) : !youtubeStatus.connected ? (
          <p>{t.loginRequired}</p>
        ) : (
          <div className="live-grid">
            {lives.map((live) => (
              <article key={live.videoId} className="live-card">
                {live.thumbnailUrl ? (
                  inlineVideoId === live.videoId ? (
                    <div className="live-thumb-player-wrap">
                      <div className="player-topbar">
                        <span>Live original</span>
                        <button className="secondary small" type="button" onClick={closeLiveInline}>{t.closePlayer}</button>
                      </div>
                      <iframe
                        className="youtube-embed thumb-embed"
                        src={`https://www.youtube.com/embed/${live.videoId}?rel=0&modestbranding=1${sourceSeekSeconds !== null && inlineVideoId === live.videoId ? `&start=${sourceSeekSeconds}&autoplay=1` : ''}`}
                        title={live.title}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowFullScreen
                      />
                    </div>
                  ) : (
                    <button
                      className="thumb-button"
                      type="button"
                      onClick={() => openLiveInline(live.videoId)}
                      aria-label={`${t.openOriginal} em player inline: ${live.title}`}
                    >
                      <img className="live-thumb" src={live.thumbnailUrl} alt={live.title} />
                    </button>
                  )
                ) : null}
                <div className="live-content">
                  <h3>{live.title}</h3>
                  <p className="live-meta">{live.duration ?? t.unknown}</p>
                  <div className="cut-actions">
                    <button className="primary live-link" onClick={() => navigateToCutPage(live.videoId)}>
                      {t.openCutPage}
                    </button>
                    <button className="secondary small" type="button" onClick={() => openLiveSource(live.videoUrl)}>
                      {t.openYoutube}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
