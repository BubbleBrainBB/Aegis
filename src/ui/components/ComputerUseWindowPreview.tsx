import { useEffect, useRef, useState } from 'react';
import type { ComputerUseLiveFrame } from '../../shared/computer-use';

/** The saved frame appears immediately and stays available when native capture is unavailable. */
export function ComputerUseWindowPreview({ frame, onDimensions }: {
  frame: ComputerUseLiveFrame;
  onDimensions?: (width: number, height: number) => void;
}) {
  const media = frame.media;
  const sha = media?.sha256;
  const sessionId = media?.sessionId;
  const [still, setStill] = useState<{ sessionId: string; sha: string; url: string } | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const windowId = media ? frame.previewWindowId : undefined;
  useEffect(() => {
    let mounted = true;
    if (sessionId && sha) {
      void window.electron.readComputerUseArtifact(sessionId, sha).then(url => {
        if (mounted && url) setStill({ sessionId, sha, url });
      }).catch(() => {});
    }
    return () => { mounted = false; };
  }, [sessionId, sha]);

  useEffect(() => {
    const element = video.current;
    if (!element || !windowId || !Number.isSafeInteger(windowId) || windowId < 1) return;
    let disposed = false;
    let stream: MediaStream | undefined;
    const stop = () => {
      stream?.getTracks().forEach(track => track.stop());
      element.srcObject = null;
    };
    const ended = () => { setPlayingId(null); stop(); };
    element.onplaying = () => { if (!disposed) setPlayingId(windowId); };
    element.onerror = ended;
    // Electron accepts the native CGWindowID directly. Never fall back to an entire display.
    const constraints = { mandatory: {
      chromeMediaSource: 'desktop', chromeMediaSourceId: `window:${windowId}:0`,
      maxFrameRate: 15, maxWidth: 960, maxHeight: 960,
    } } as MediaTrackConstraints;
    void navigator.mediaDevices?.getUserMedia({ audio: false, video: constraints }).then(async source => {
      stream = source;
      if (disposed) { source.getTracks().forEach(track => track.stop()); return; }
      source.getVideoTracks()[0]?.addEventListener('ended', ended, { once: true });
      element.srcObject = source;
      await element.play();
    }).catch(() => { if (!disposed) ended(); });
    return () => {
      disposed = true;
      element.onplaying = null;
      element.onerror = null;
      stream?.getVideoTracks()[0]?.removeEventListener('ended', ended);
      stop();
      setPlayingId(null);
    };
  }, [windowId, sessionId]);

  useEffect(() => {
    const element = video.current;
    if (!element || !onDimensions) return;
    const resized = () => onDimensions(element.videoWidth, element.videoHeight);
    element.addEventListener('resize', resized);
    return () => element.removeEventListener('resize', resized);
  }, [onDimensions]);
  const live = windowId !== undefined && playingId === windowId;
  const image = still && still.sessionId === sessionId && still.sha === sha ? still.url : null;
  return <>
    <video ref={video} hidden={!live} aria-label="Computer Use preview" autoPlay muted playsInline disablePictureInPicture />
    {!live && image && <img src={image} alt="Computer Use preview" draggable={false} onLoad={e => onDimensions?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />}
  </>;
}
