import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiClient, sessionPath, segment, type Schema } from '../api/client';
import { useConnection } from '../connections/context';
import { ErrorNotice } from './common';
import { useBlobUrl } from './blob-url';
import { MediaDialog } from './media-viewer';
import type { Size } from './media-viewport';
import { imageFilename, inputImageBlob } from './image-input';
import { Button } from './ui/button';

interface OpenImage {
  blob: Blob;
  size: Size;
  title: string;
  trigger: HTMLElement;
}
const ImageViewerContext = createContext<((image: OpenImage) => void) | undefined>(undefined);

/** Own the open image above message rows so snapshot reconciliation does not close it. */
export function ImageViewerProvider({
  children,
  onReturnFocus,
}: {
  children: ReactNode;
  onReturnFocus: () => void;
}) {
  const [selected, setSelected] = useState<OpenImage>();
  const trigger = useRef<HTMLElement>(null);
  const open = useCallback((image: OpenImage) => {
    trigger.current = image.trigger;
    setSelected(image);
  }, []);
  // The viewer retains its own URL while an optimistic thumbnail is replaced by saved history.
  const url = useBlobUrl(selected?.blob);
  return (
    <ImageViewerContext.Provider value={open}>
      {children}
      <MediaDialog
        kind="image"
        open={Boolean(selected)}
        onOpenChange={(value) => {
          if (!value) setSelected(undefined);
        }}
        image={selected && url ? { url, size: selected.size, title: selected.title } : undefined}
        download={selected ? imageFilename(selected.blob.type) : undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
          else onReturnFocus();
          trigger.current = null;
        }}
      />
    </ImageViewerContext.Provider>
  );
}

function ImagePreview({
  blob,
  title = 'Conversation attachment',
  label = 'View image',
}: {
  blob: Blob;
  title?: string;
  label?: string;
}) {
  const open = useContext(ImageViewerContext);
  const url = useBlobUrl(blob);
  const [loaded, setLoaded] = useState<{ url: string; size: Size }>();
  const [failed, setFailed] = useState<string>();
  if (!open) throw new Error('Image previews require ImageViewerProvider.');
  if (!url) return <p className="muted small">Loading image…</p>;
  if (blob.type === 'application/octet-stream' || failed === url)
    return (
      <div className="attachment-unavailable">
        <p className="muted">Image preview unavailable for this format.</p>
        <Button asChild variant="ghost" size="sm">
          <a href={url} download={imageFilename(blob.type)}>
            Download image
          </a>
        </Button>
      </div>
    );
  const size = loaded?.url === url ? loaded.size : undefined;
  return (
    <button
      type="button"
      className="attachment"
      aria-label={label}
      disabled={!size}
      onClick={(event) => {
        if (size) open({ blob, size, title, trigger: event.currentTarget });
      }}
    >
      <img
        src={url}
        alt={title}
        loading="lazy"
        onLoad={(event) => {
          const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
          if (width > 0 && height > 0) setLoaded({ url, size: { width, height } });
          else setFailed(url);
        }}
        onError={() => setFailed(url)}
      />
    </button>
  );
}

export function InlineAttachment({ image, index }: { image: Schema['ImageInput']; index: number }) {
  const decoded = useMemo(() => {
    try {
      return { blob: inputImageBlob(image) };
    } catch {
      return { error: new Error('This image could not be decoded for preview.') };
    }
  }, [image]);
  return decoded.blob ? (
    <ImagePreview
      blob={decoded.blob}
      title={`Submitted image ${index + 1}`}
      label={`View image ${index + 1}`}
    />
  ) : (
    <ErrorNotice error={decoded.error} />
  );
}

async function imageBlob(api: ApiClient, id: string, hash: string, signal: AbortSignal) {
  const blob = await api.blob(sessionPath(id) + '/blobs/' + segment(hash), undefined, signal);
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'].includes(blob.type))
    throw new Error('The server returned an unsupported image type.');
  return blob;
}

export function Attachment({
  sessionId,
  hash,
}: {
  sessionId: string;
  hash?: string | null | undefined;
}) {
  const { api, connection } = useConnection();
  const image = useQuery({
    queryKey: [connection?.id, connection?.authority, 'attachment', sessionId, hash],
    queryFn: ({ signal }) => {
      if (!api || !hash) throw new Error('This image is unavailable.');
      return imageBlob(api, sessionId, hash, signal);
    },
    enabled: Boolean(api && hash),
    // Failed reads recover with the connection; immutable images need no refetch.
    staleTime: (query) => (query.state.data ? 'static' : Infinity),
    gcTime: 0,
    retry: false,
  });
  if (!image.data && image.error) return <ErrorNotice error={image.error} />;
  if (!image.data)
    return (
      <p className="muted small">{hash ? 'Loading image…' : 'Image bytes are unavailable.'}</p>
    );
  return <ImagePreview blob={image.data} />;
}
