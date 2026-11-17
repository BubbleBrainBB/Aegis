import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, Maximize2, Minimize2, MoreHorizontal, Pause, Play, Volume2, VolumeX } from './icons';
import * as Menu from './ui/dropdown-menu';
import { saveFileCopyAs } from './OpenWithButton';
import './video-preview.css';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

const controlButton =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]';

/** A video that fills its panel, with one quiet control bar pinned underneath. */
const menuItem = 'rounded-md px-2 py-1.5 text-[13px]';
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export function ProjectVideoPreview({ src, name, active, file }: {
  src: string;
  name: string;
  active: boolean;
  /** The file on disk, when "Save video as…" can copy it. */
  file?: { cwd: string | null; path: string };
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    if (!active) videoRef.current?.pause();
  }, [active]);

  // timeupdate fires a few times a second; follow the frame clock while playing.
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() {
      setCurrent(videoRef.current?.currentTime ?? 0);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void frameRef.current?.requestFullscreen().catch(() => {});
  }, []);

  const togglePictureInPicture = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => {});
    else void video.requestPictureInPicture().catch(() => {});
  }, []);

  const canSave = Boolean(file?.cwd) && typeof window.electron.saveFileCopy === 'function';

  const silent = muted || volume === 0;
  const progress = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;

  return (
    <div ref={frameRef} data-video-preview className="flex h-full min-h-0 w-full flex-col">
      <div className="min-h-0 flex-1">
        <video
          ref={videoRef}
          src={src}
          aria-label={name}
          className="h-full w-full object-contain"
          playsInline
          preload="metadata"
          onClick={togglePlay}
          onLoadStart={() => setFailed(false)}
          onError={() => setFailed(true)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
          onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
          onVolumeChange={(event) => { setMuted(event.currentTarget.muted); setVolume(event.currentTarget.volume); }}
          onRateChange={(event) => setSpeed(event.currentTarget.playbackRate)}
        />
      </div>
      {failed && (
        <p role="alert" className="shrink-0 pt-2 text-sm text-[var(--text-muted)]">
          Unable to load or decode this video. Try opening it in your system player.
        </p>
      )}
      <div data-video-controls className="flex h-9 shrink-0 items-center gap-1.5 pt-2">
        <button type="button" className={controlButton} onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <input
          type="range"
          className="video-preview-seek min-w-0 flex-1"
          aria-label="Seek"
          aria-valuetext={`${formatTime(current)} of ${formatTime(duration)}`}
          min={0}
          max={duration || 0}
          step="any"
          value={Math.min(current, duration || 0)}
          disabled={!duration}
          style={{ '--video-progress': `${progress}%` } as CSSProperties}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (videoRef.current) videoRef.current.currentTime = next;
            setCurrent(next);
          }}
        />
        <span className="shrink-0 px-1 text-xs tabular-nums text-[var(--text-secondary)]">
          {formatTime(current)} / {formatTime(duration)}
        </span>
        <div className="video-preview-volume flex shrink-0 items-center">
          <input
            type="range"
            className="video-preview-seek video-preview-volume-slider"
            aria-label="Volume"
            min={0}
            max={1}
            step={0.05}
            value={silent ? 0 : volume}
            style={{ '--video-progress': `${(silent ? 0 : volume) * 100}%` } as CSSProperties}
            onChange={(event) => {
              const video = videoRef.current;
              if (!video) return;
              video.volume = Number(event.target.value);
              video.muted = video.volume === 0;
            }}
          />
          <button
            type="button"
            className={controlButton}
            onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              video.muted = !silent;
              if (!video.muted && video.volume === 0) video.volume = 1;
            }}
            aria-label={silent ? 'Unmute' : 'Mute'}
            title={silent ? 'Unmute' : 'Mute'}
          >
            {silent ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
        </div>
        <Menu.Root>
          <Menu.Trigger asChild>
            <button type="button" className={controlButton} aria-label="Video options" title="Video options">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </Menu.Trigger>
          {/* Inside the player, so the menu still shows while it is full screen. */}
          <Menu.Portal container={frameRef}>
            <Menu.Content side="top" align="end" sideOffset={6} className="min-w-[11rem] p-1">
              {canSave && file ? (
                <>
                  <Menu.Item className={menuItem} onSelect={() => void saveFileCopyAs(file.cwd, file.path)}>Save video as…</Menu.Item>
                  <Menu.Separator />
                </>
              ) : null}
              <Menu.Group>
                <Menu.Label className="px-2 normal-case tracking-normal text-[12px] font-normal">Playback speed</Menu.Label>
                {SPEEDS.map((rate) => (
                  <Menu.Item
                    key={rate}
                    className={menuItem}
                    aria-checked={rate === speed}
                    onSelect={() => { if (videoRef.current) videoRef.current.playbackRate = rate; }}
                  >
                    <span className="flex-1">{rate}×</span>
                    {rate === speed ? <Check className="h-3.5 w-3.5 text-[var(--text-secondary)]" aria-hidden="true" /> : null}
                  </Menu.Item>
                ))}
              </Menu.Group>
              {document.pictureInPictureEnabled ? (
                <Menu.Item className={menuItem} onSelect={togglePictureInPicture}>Picture in picture</Menu.Item>
              ) : null}
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
        <button type="button" className={controlButton} onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} title={fullscreen ? 'Exit full screen' : 'Full screen'}>
          {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
