/**
 * PDF Annotation Toolbar — allows musicians to annotate PDF sheet music.
 * Stores each annotation as an individual row in the database (immediate auto-save).
 * Supports text comments, freehand drawings, highlights, and uploaded SVG icons.
 *
 * Individual annotations are removed via the eraser tool (drag-to-erase).
 * An entire layer can be cleared via the Clear Layer button.
 *
 * Renders per-page canvas overlays that match each PDF page's actual dimensions,
 * so annotations work correctly at any zoom level or scroll position.
 *
 * The canvas overlay is always rendered (read-only) when annotations exist,
 * even when the toolbar is hidden. The toolbar UI only appears in edit mode.
 * The draw tool is selected by default when edit mode is activated.
 */
import {
  useState,
  useRef,
  useCallback,
  useEffect,
  RefObject,
  MouseEvent,
  TouchEvent,
  PointerEvent,
  ChangeEvent,
  CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  IconButton,
  Paper,
  Popover,
  Slider,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import {
  Create as DrawIcon,
  TextFields as TextIcon,
  FormatColorFill as HighlightIcon,
  Delete as DeleteIcon,
  FormatBold as BoldIcon,
  FormatItalic as ItalicIcon,
  FormatUnderlined as UnderlineIcon,
  EmojiSymbols as IconToolIcon,
  AutoFixHigh as EraserIcon,
  Download as DownloadIcon,
  CloudUpload as UploadIcon,
  Settings as SettingsIcon,
} from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { getPdfPageWidth } from '@/utils/pdfOcgExport';
import { exportPdfWithAnnotations, type ExportLayerData } from '@/utils/pdfOcgExport';
import { PdfLayerViewer } from '@/components/pdf/PdfLayerViewer';
import { loadSvgImage, drawSvgIconOnCanvas, ICON_BASE_SIZE } from '@/utils/iconPaths';
import {
  useListAnnotationsQuery,
  useAddAnnotationMutation,
  useClearLayerMutation,
  useDeleteAnnotationMutation,
  useUpdateAnnotationMutation,
  type AnnotationDto,
  type AnnotationData,
} from '@/api/pdfAnnotations.api';
import { useListPdfIconsQuery, useUploadPdfIconMutation, useDeletePdfIconMutation, type PdfIconDto } from '@/api/pdfIcons.api';
import { ANNOTATION_COLORS } from '@/theme';

export type AnnotationTool = 'draw' | 'text' | 'highlight' | 'icon' | 'eraser' | 'none';

/** Layer used when no musician name is set — the shared layer everyone writes to. */
export const DEFAULT_LAYER = 'default';

interface Point {
  x: number;
  y: number;
}

/**
 * Client-side annotation shape used for canvas rendering.
 * This is derived from {@link AnnotationDto} for rendering purposes.
 */
export interface AnnotationEntry {
  id: string;
  tool: AnnotationTool;
  page: number;
  color: string;
  lineWidth: number;
  opacity?: number;
  points?: Point[];
  text?: string;
  position?: Point;
  fontSize?: number;
  fontBold?: boolean;
  fontItalic?: boolean;
  fontUnderline?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  iconFilename?: string;
  iconUrl?: string;
  /** Icon render size in CSS pixels (before zoom scaling). Default: ICON_BASE_SIZE (24). */
  iconSize?: number;
}

/** Convert a DB AnnotationDto to a client AnnotationEntry for rendering */
const dtoToEntry = (dto: AnnotationDto): AnnotationEntry => {
  const data = dto.data ?? {};
  const entry: AnnotationEntry = {
    id: String(dto.id),
    tool: dto.tool as AnnotationTool,
    page: dto.page,
    color: dto.color,
    lineWidth: data.lineWidth ?? 2,
    opacity: dto.opacity,
  };
  if (dto.tool === 'draw' && data.points) {
    entry.points = data.points;
    entry.position = { x: dto.x, y: dto.y };
  } else if (dto.tool === 'text') {
    entry.position = { x: dto.x, y: dto.y };
    entry.text = data.text;
    entry.fontSize = data.fontSize;
    entry.fontBold = data.fontBold;
    entry.fontItalic = data.fontItalic;
    entry.fontUnderline = data.fontUnderline;
  } else if (dto.tool === 'highlight') {
    entry.position = { x: dto.x, y: dto.y };
    entry.rect = { x: dto.x, y: dto.y, width: data.width ?? 0, height: data.height ?? 0 };
  } else if (dto.tool === 'icon') {
    entry.position = { x: dto.x, y: dto.y };
    entry.iconFilename = data.iconFilename;
    entry.iconSize = data.iconSize;
    if (data.iconFilename) {
      entry.iconUrl = `rest/PdfIcons/${encodeURIComponent(data.iconFilename)}`;
    } else if (data.iconId) {
      // Legacy fallback for old annotations that stored numeric iconId
      entry.iconUrl = `rest/PdfIcons/${data.iconId}`;
    }
  }
  return entry;
};

// -- Geometry helpers (eraser hit-testing) --

/** Distance from a point to a line segment (in percentage coordinates) */
const pointToSegmentDist = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

interface PdfAnnotationToolbarProps {
  currentPage: number;
  numPages: number;
  pageWidth: number;
  pageHeight: number;
  pdfUrl: string;
  musicianName: string;
  songNumber: number;
  /** Optional display name of the song — included in the exported PDF filename. */
  songName?: string;
  filename: string;
  containerRef: RefObject<HTMLDivElement>;
  /** When false, only the read-only canvas overlay is rendered (no toolbar UI). */
  editMode?: boolean;
  /** Shared annotation visibility state (lifted to PdfView). */
  showAnnotations: boolean;
  onShowAnnotationsChange: (visible: boolean) => void;
  hiddenLayers: Set<string>;
  onToggleLayerVisibility: (layer: string) => void;
  /**
   * Layer preselected for editing (musician setting). Empty falls back to the musician's
   * own layer. The user can still switch layers in the layer popover for the session.
   */
  defaultLayer?: string;
  /**
   * Called once on mount (and whenever the song/filename changes) with the
   * `refetch` function so that parent components (e.g. MusicianToolbar) can
   * trigger an immediate annotation reload without owning the query themselves.
   */
  onRegisterRefetch?: (refetch: () => void) => void;
}

export const PdfAnnotationToolbar = ({
  currentPage,
  numPages,
  pageWidth,
  pageHeight,
  pdfUrl,
  musicianName,
  songNumber,
  songName,
  filename,
  containerRef,
  editMode = true,
  showAnnotations,
  onShowAnnotationsChange,
  hiddenLayers,
  onToggleLayerVisibility,
  defaultLayer,
  onRegisterRefetch,
}: PdfAnnotationToolbarProps) => {
  const { LL } = useI18nContext();
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  // Start with 'draw' selected so the toolbar is immediately usable on open
  const [tool, setTool] = useState<AnnotationTool>('draw');
  const [color, setColor] = useState('#ff0000');
  const [lineWidth, setLineWidth] = useState(2);
  const [highlightOpacity, setHighlightOpacity] = useState(0.25);
  const [toolOpacity, setToolOpacity] = useState(1.0);
  const [fontSize, setFontSize] = useState(14);
  const [fontBold, setFontBold] = useState(false);
  const [fontItalic, setFontItalic] = useState(false);
  const [fontUnderline, setFontUnderline] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentPoints, setCurrentPoints] = useState<Point[]>([]);
  const [textInput, setTextInput] = useState('');
  const [textPosition, setTextPosition] = useState<Point | null>(null);
  const [highlightStart, setHighlightStart] = useState<Point | null>(null);
  const [highlightCurrent, setHighlightCurrent] = useState<Point | null>(null);
  /** The annotation currently being relocated (text, icon or highlight), if any. */
  const [dragging, setDragging] = useState<{ id: string; tool: AnnotationTool } | null>(null);
  /** Offset between the pointer and the dragged annotation's anchor when the drag started */
  const dragOffsetRef = useRef<Point | null>(null);
  /** Live anchor position of the annotation being dragged (percentage coords) */
  const [dragPos, setDragPos] = useState<Point | null>(null);
  /** ID of the text annotation currently being edited via double-click */
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [selectedIconFilename, setSelectedIconFilename] = useState<string | null>(null);
  const [iconSize, setIconSize] = useState(ICON_BASE_SIZE);
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const [activeDrawPage, setActiveDrawPage] = useState(currentPage);
  const textInputRef = useRef<HTMLInputElement>(null);

  // -- Eraser state: drag-to-erase --
  const [isErasing, setIsErasing] = useState(false);
  /** Track which annotation IDs have already been erased this drag to avoid double-deletes */
  const erasedIdsRef = useRef<Set<string>>(new Set());
  /** Live canvas-space position of the eraser cursor for the on-canvas indicator */
  const [eraserPos, setEraserPos] = useState<{ pageNum: number; x: number; y: number } | null>(null);

  // -- Stylus eraser detection --
  // pointerType === 'pen' and button === 5 (eraser end) signals an eraser stylus
  const [penEraserActive, setPenEraserActive] = useState(false);
  const penEraserActiveRef = useRef(false);
  const previousToolRef = useRef<AnnotationTool>('none');

  /** Guard against duplicate icon placement from simultaneous mouse + touch events */
  const lastIconPlacedRef = useRef(0);

  // -- Layer management --
  const musicianKey = musicianName || DEFAULT_LAYER;
  // The configured layer wins; without one we keep writing to the musician's own layer.
  const preferredLayerKey = defaultLayer?.trim() || musicianKey;
  const [activeLayerKey, setActiveLayerKey] = useState(preferredLayerKey);

  useEffect(() => {
    setActiveLayerKey(preferredLayerKey);
  }, [preferredLayerKey]);

  // Reset to draw tool when entering edit mode; deactivate when leaving
  useEffect(() => {
    if (editMode) {
      setTool('draw');
    } else {
      setTool('none');
      setEditingTextId(null);
      setTextPosition(null);
      setTextInput('');
    }
  }, [editMode]);

  /** Intrinsic PDF page width in points */
  const [pdfPageWidth, setPdfPageWidth] = useState(612);

  // -- RTK Query --
  const [addAnnotation] = useAddAnnotationMutation();
  const [clearLayerMutation] = useClearLayerMutation();
  const [deleteAnnotation] = useDeleteAnnotationMutation();
  const [updateAnnotation] = useUpdateAnnotationMutation();

  const { data: annotationsData, refetch: refetchAnnotations } = useListAnnotationsQuery(
    { songNumber, filename },
    {
      skip: !songNumber || !filename,
      // Poll every 30 seconds so annotations added by other devices appear
      // without requiring a local mutation to trigger a refresh.
      pollingInterval: editMode ? 5000 : 30000,
    },
  );
  const allAnnotations = annotationsData ?? [];

  // Register the refetch function with the parent so external callers (e.g. the
  // floating toolbar) can trigger an immediate reload without owning the query.
  useEffect(() => {
    onRegisterRefetch?.(refetchAnnotations);
  }, [onRegisterRefetch, refetchAnnotations, songNumber, filename]);

  // -- Icon management --
  const { data: iconsData } = useListPdfIconsQuery();
  const icons = (iconsData as PdfIconDto[] | undefined) ?? [];
  const [uploadIcon] = useUploadPdfIconMutation();
  const [deleteIcon] = useDeletePdfIconMutation();
  const [iconPopoverAnchor, setIconPopoverAnchor] = useState<HTMLElement | null>(null);
  /**
   * Bumped whenever an icon image finishes loading for the first time so the
   * canvas render effect re-runs and the freshly-placed icon becomes visible
   * immediately without requiring a second interaction.
   */
  const [iconLoadVersion, setIconLoadVersion] = useState(0);

  // Set default selected icon when icons load
  useEffect(() => {
    if (icons.length > 0 && selectedIconFilename === null) {
      setSelectedIconFilename(icons[0].filename);
    }
  }, [icons, selectedIconFilename]);

  // -- Derive annotations for rendering --
  // In edit mode always show the active layer; in read-only respect hiddenLayers for all layers
  const activeLayerAnnotations: AnnotationEntry[] = allAnnotations
    .filter((a) => a.layer === activeLayerKey && (editMode || !hiddenLayers.has(a.layer)))
    .map(dtoToEntry);

  const bgAnnotations: AnnotationEntry[] = allAnnotations
    .filter((a) => a.layer !== activeLayerKey && !hiddenLayers.has(a.layer))
    .map(dtoToEntry);

  // -- Preload icon images for annotations that reference them --
  const iconImageCache = useRef<Map<string, HTMLImageElement>>(new Map());
  useEffect(() => {
    const allEntries = [...activeLayerAnnotations, ...bgAnnotations];
    for (const entry of allEntries) {
      if (entry.iconUrl && !iconImageCache.current.has(entry.iconUrl)) {
        loadSvgImage(entry.iconUrl).then((img) => {
          iconImageCache.current.set(entry.iconUrl!, img);
          // Trigger a canvas re-render so the newly loaded icon appears immediately
          // without the user having to interact again.
          setIconLoadVersion((v) => v + 1);
        });
      }
    }
  }, [activeLayerAnnotations, bgAnnotations]);

  // -- Load PDF page width --
  useEffect(() => {
    if (!pdfUrl) return;
    let cancelled = false;
    fetch(pdfUrl)
      .then((res) => res.arrayBuffer())
      .then((bytes) => getPdfPageWidth(bytes))
      .then((pw) => {
        if (!cancelled) setPdfPageWidth(pw);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pdfUrl]);

  // -- Coordinate helpers --
  const getCoordsFromClient = useCallback((clientX: number, clientY: number, pageNum: number): Point | null => {
    const canvas = canvasRefs.current.get(pageNum);
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * 100,
      y: ((clientY - rect.top) / rect.height) * 100,
    };
  }, []);

  const getPageFromCanvas = useCallback(
    (canvas: HTMLCanvasElement): number => {
      for (const [pageNum, c] of canvasRefs.current.entries()) {
        if (c === canvas) return pageNum;
      }
      return currentPage;
    },
    [currentPage],
  );

  // -- Auto-save helper --
  const saveAnnotation = useCallback(
    async (params: { tool: string; page: number; x: number; y: number; color: string; opacity: number; data: AnnotationData }) => {
      if (!songNumber || !filename) return;
      try {
        await addAnnotation({
          songNumber,
          filename,
          layer: activeLayerKey,
          ...params,
        }).unwrap();
      } catch (err) {
        console.error('[PdfAnnotation] auto-save failed:', err);
      }
    },
    [songNumber, filename, activeLayerKey, addAnnotation],
  );

  // -- Eraser hit-test --
  const hitTestAnnotation = useCallback(
    (coords: Point, pageNum: number): AnnotationEntry | null => {
      const pageAnns = activeLayerAnnotations.filter((a) => a.page === pageNum);
      // Check in reverse order (top-most first)
      for (let i = pageAnns.length - 1; i >= 0; i--) {
        const ann = pageAnns[i];
        // Tight threshold — the pointer must nearly touch the annotation
        const strokeThreshold = 0.8; // percentage units for strokes/points

        if (ann.tool === 'draw' && ann.points && ann.points.length > 1) {
          for (let j = 1; j < ann.points.length; j++) {
            const p1 = ann.points[j - 1];
            const p2 = ann.points[j];
            const dist = pointToSegmentDist(coords, p1, p2);
            if (dist < strokeThreshold) return ann;
          }
        } else if (ann.tool === 'highlight' && ann.rect) {
          const r = ann.rect;
          if (coords.x >= r.x && coords.x <= r.x + r.width && coords.y >= r.y && coords.y <= r.y + r.height) {
            return ann;
          }
        } else if (ann.tool === 'text' && ann.position && ann.text) {
          const fs = ann.fontSize ?? 14;
          const approxWidth = ann.text.length * fs * 0.06; // rough percentage width
          const approxHeight = fs * 0.12;
          if (
            coords.x >= ann.position.x - 0.3 &&
            coords.x <= ann.position.x + approxWidth + 0.3 &&
            coords.y >= ann.position.y - approxHeight &&
            coords.y <= ann.position.y + 0.3
          ) {
            return ann;
          }
        } else if (ann.tool === 'icon' && ann.position) {
          // Use roughly half the icon size as the hit radius
          const iconPct = ((ann.iconSize ?? ICON_BASE_SIZE) / 2) * 0.08; // approx % radius
          if (Math.abs(coords.x - ann.position.x) < iconPct && Math.abs(coords.y - ann.position.y) < iconPct) {
            return ann;
          }
        }
      }
      return null;
    },
    [activeLayerAnnotations],
  );

  /**
   * Find a relocatable annotation under the pointer for the active tool.
   *
   * Only text, icons and highlights can be moved — a freehand stroke has no single anchor.
   * Restricting the search to the active tool keeps the interaction predictable: the highlight
   * tool grabs highlights, the icon tool grabs icons, and neither steals the other's press.
   * The bounds are a touch more generous than the eraser's so grabbing does not require
   * pixel accuracy on a touch screen.
   */
  const hitTestForMove = useCallback(
    (coords: Point, pageNum: number, activeTool: AnnotationTool): AnnotationEntry | null => {
      if (activeTool !== 'text' && activeTool !== 'icon' && activeTool !== 'highlight') return null;
      const candidates = activeLayerAnnotations.filter((a) => a.tool === activeTool && a.page === pageNum && a.position);
      // Reverse order: the most recently drawn annotation sits on top.
      for (let i = candidates.length - 1; i >= 0; i--) {
        const ann = candidates[i];
        const pos = ann.position!;
        if (ann.tool === 'text' && ann.text) {
          const fs = ann.fontSize ?? 14;
          const approxWidth = ann.text.length * fs * 0.06;
          const approxHeight = fs * 0.12;
          if (coords.x >= pos.x - 1 && coords.x <= pos.x + approxWidth + 1 && coords.y >= pos.y - approxHeight && coords.y <= pos.y + 1) {
            return ann;
          }
        } else if (ann.tool === 'icon') {
          const iconPct = ((ann.iconSize ?? ICON_BASE_SIZE) / 2) * 0.08;
          if (Math.abs(coords.x - pos.x) < iconPct && Math.abs(coords.y - pos.y) < iconPct) return ann;
        } else if (ann.tool === 'highlight' && ann.rect) {
          const r = ann.rect;
          if (coords.x >= r.x && coords.x <= r.x + r.width && coords.y >= r.y && coords.y <= r.y + r.height) return ann;
        }
      }
      return null;
    },
    [activeLayerAnnotations],
  );

  /** Begin relocating `ann`; returns false when it has no anchor to drag by. */
  const beginMove = useCallback((ann: AnnotationEntry, coords: Point): boolean => {
    if (!ann.position) return false;
    setDragging({ id: ann.id, tool: ann.tool });
    dragOffsetRef.current = { x: coords.x - ann.position.x, y: coords.y - ann.position.y };
    setDragPos({ ...ann.position });
    return true;
  }, []);

  /** Persist the dragged annotation's new anchor. Only x/y are sent, so the tool's own
   *  payload (icon file + size, highlight width/height, text + font) is left untouched. */
  const commitMove = useCallback(() => {
    if (dragging && dragPos && songNumber && filename) {
      updateAnnotation({ songNumber, filename, annotationId: Number(dragging.id), x: dragPos.x, y: dragPos.y });
    }
    setDragging(null);
    dragOffsetRef.current = null;
    setDragPos(null);
  }, [dragging, dragPos, songNumber, filename, updateAnnotation]);

  /** Erase annotation at coords if one is hit and not already erased this drag */
  const eraseAtCoords = useCallback(
    (coords: Point, pageNum: number) => {
      const hit = hitTestAnnotation(coords, pageNum);
      if (hit && !erasedIdsRef.current.has(hit.id) && songNumber && filename) {
        erasedIdsRef.current.add(hit.id);
        deleteAnnotation({ songNumber, filename, annotationId: Number(hit.id) });
      }
    },
    [hitTestAnnotation, deleteAnnotation, songNumber, filename],
  );

  // Determine effective tool (stylus eraser overrides)
  const effectiveTool = penEraserActive ? 'eraser' : tool;

  // -- Mouse / Pointer event handlers --
  const handleCanvasMouseDown = useCallback(
    (e: MouseEvent<HTMLCanvasElement>) => {
      const pageNum = getPageFromCanvas(e.currentTarget);
      setActiveDrawPage(pageNum);
      const coords = getCoordsFromClient(e.clientX, e.clientY, pageNum);
      if (!coords) return;

      const activeTool = penEraserActiveRef.current ? 'eraser' : tool;

      // Pressing on an existing text / icon / highlight picks it up instead of creating a
      // new one, so all three relocate the same way.
      const grabbed = hitTestForMove(coords, pageNum, activeTool);
      if (grabbed && beginMove(grabbed, coords)) return;

      if (activeTool === 'eraser') {
        setIsErasing(true);
        erasedIdsRef.current = new Set();
        eraseAtCoords(coords, pageNum);
      } else if (activeTool === 'draw') {
        setIsDrawing(true);
        setCurrentPoints([coords]);
      } else if (activeTool === 'text') {
        // Empty space: cancel any active editing and create a new anchor
        setEditingTextId(null);
        setTextPosition(coords);
        setActiveDrawPage(pageNum);
        // Auto-focus the text input after a short delay so it renders first
        setTimeout(() => textInputRef.current?.focus(), 50);
      } else if (activeTool === 'highlight') {
        setHighlightStart(coords);
        setHighlightCurrent(coords);
      } else if (activeTool === 'icon' && selectedIconFilename) {
        const now = Date.now();
        if (now - lastIconPlacedRef.current < 300) return;
        lastIconPlacedRef.current = now;
        saveAnnotation({
          tool: 'icon',
          page: pageNum,
          x: coords.x,
          y: coords.y,
          color,
          opacity: toolOpacity,
          data: { iconFilename: selectedIconFilename, iconSize },
        });
      }
    },
    [
      tool,
      getCoordsFromClient,
      getPageFromCanvas,
      color,
      selectedIconFilename,
      saveAnnotation,
      eraseAtCoords,
      toolOpacity,
      iconSize,
      hitTestForMove,
      beginMove,
    ],
  );

  const handleCanvasMouseMove = useCallback(
    (e: MouseEvent<HTMLCanvasElement>) => {
      const pageNum = getPageFromCanvas(e.currentTarget);
      const coords = getCoordsFromClient(e.clientX, e.clientY, pageNum);
      if (!coords) return;

      const activeTool = penEraserActiveRef.current ? 'eraser' : tool;

      // Track eraser cursor position for the on-canvas indicator
      if (activeTool === 'eraser') {
        setEraserPos({ pageNum, x: coords.x, y: coords.y });
      } else if (eraserPos !== null) {
        setEraserPos(null);
      }

      if (dragging && dragOffsetRef.current) {
        setDragPos({
          x: coords.x - dragOffsetRef.current.x,
          y: coords.y - dragOffsetRef.current.y,
        });
      } else if (isErasing && activeTool === 'eraser') {
        eraseAtCoords(coords, pageNum);
      } else if (isDrawing && activeTool === 'draw') {
        setCurrentPoints((prev) => [...prev, coords]);
      } else if (activeTool === 'highlight' && highlightStart) {
        setHighlightCurrent(coords);
      }
    },
    [isDrawing, isErasing, dragging, tool, getCoordsFromClient, getPageFromCanvas, highlightStart, eraseAtCoords, eraserPos],
  );

  /** Clear eraser cursor indicator when the pointer leaves a canvas */
  const handleCanvasMouseLeave = useCallback(() => {
    setEraserPos(null);
  }, []);

  const handleCanvasMouseUp = useCallback(
    (e: MouseEvent<HTMLCanvasElement>) => {
      const pageNum = getPageFromCanvas(e.currentTarget);

      // -- Drag release (text / icon / highlight): persist the new position --
      if (dragging) {
        commitMove();
        return;
      }

      if (isErasing) {
        setIsErasing(false);
        erasedIdsRef.current = new Set();
        return;
      }

      if (tool === 'draw' && isDrawing && currentPoints.length > 1) {
        saveAnnotation({
          tool: 'draw',
          page: pageNum,
          x: currentPoints[0].x,
          y: currentPoints[0].y,
          color,
          opacity: toolOpacity,
          data: { points: [...currentPoints], lineWidth },
        });
      } else if (tool === 'highlight' && highlightStart) {
        const coords = getCoordsFromClient(e.clientX, e.clientY, pageNum);
        if (coords) {
          const x = Math.min(highlightStart.x, coords.x);
          const y = Math.min(highlightStart.y, coords.y);
          const width = Math.abs(coords.x - highlightStart.x);
          const height = Math.abs(coords.y - highlightStart.y);
          if (width > 1 && height > 1) {
            saveAnnotation({
              tool: 'highlight',
              page: pageNum,
              x,
              y,
              color,
              opacity: highlightOpacity,
              data: { width, height },
            });
          }
        }
      }
      setIsDrawing(false);
      setCurrentPoints([]);
      setHighlightStart(null);
      setHighlightCurrent(null);
    },
    [
      tool,
      isDrawing,
      isErasing,
      dragging,
      commitMove,
      currentPoints,
      highlightStart,
      color,
      lineWidth,
      highlightOpacity,
      toolOpacity,
      getCoordsFromClient,
      getPageFromCanvas,
      saveAnnotation,
    ],
  );

  // -- Pointer events for stylus eraser detection --
  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      // Detect stylus eraser: pointerType=pen with button 5 (eraser end)
      if (e.pointerType === 'pen' && e.button === 5) {
        penEraserActiveRef.current = true;
        setPenEraserActive(true);
        previousToolRef.current = tool;
        // Switch the toolbar tool indicator to 'eraser'
        setTool('eraser');
      }
    },
    [tool],
  );

  const handlePointerUp = useCallback(() => {
    if (penEraserActiveRef.current) {
      penEraserActiveRef.current = false;
      setPenEraserActive(false);
      setIsErasing(false);
      erasedIdsRef.current = new Set();
      // Restore previous tool; fall back to 'draw' if no tool was active
      const restored = previousToolRef.current === 'none' ? 'draw' : previousToolRef.current;
      setTool(restored);
    }
  }, []);

  // -- Touch event handlers --
  const handleCanvasTouchStart = useCallback(
    (e: TouchEvent<HTMLCanvasElement>) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const touch = e.touches[0];
      const pageNum = getPageFromCanvas(e.currentTarget);
      setActiveDrawPage(pageNum);
      const coords = getCoordsFromClient(touch.clientX, touch.clientY, pageNum);
      if (!coords) return;

      const activeTool = penEraserActiveRef.current ? 'eraser' : tool;

      // Touching an existing text / icon / highlight picks it up — same as the mouse path.
      const grabbed = hitTestForMove(coords, pageNum, activeTool);
      if (grabbed && beginMove(grabbed, coords)) return;

      if (activeTool === 'eraser') {
        setIsErasing(true);
        erasedIdsRef.current = new Set();
        eraseAtCoords(coords, pageNum);
      } else if (activeTool === 'draw') {
        setIsDrawing(true);
        setCurrentPoints([coords]);
      } else if (activeTool === 'text') {
        setEditingTextId(null);
        setTextPosition(coords);
        setActiveDrawPage(pageNum);
        setTimeout(() => textInputRef.current?.focus(), 50);
      } else if (activeTool === 'highlight') {
        setHighlightStart(coords);
        setHighlightCurrent(coords);
      } else if (activeTool === 'icon' && selectedIconFilename) {
        const now = Date.now();
        if (now - lastIconPlacedRef.current < 300) return;
        lastIconPlacedRef.current = now;
        saveAnnotation({
          tool: 'icon',
          page: pageNum,
          x: coords.x,
          y: coords.y,
          color,
          opacity: toolOpacity,
          data: { iconFilename: selectedIconFilename, iconSize },
        });
      }
    },
    [
      tool,
      getCoordsFromClient,
      getPageFromCanvas,
      color,
      selectedIconFilename,
      saveAnnotation,
      eraseAtCoords,
      toolOpacity,
      iconSize,
      hitTestForMove,
      beginMove,
    ],
  );

  const handleCanvasTouchMove = useCallback(
    (e: TouchEvent<HTMLCanvasElement>) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const touch = e.touches[0];
      const pageNum = getPageFromCanvas(e.currentTarget);
      const coords = getCoordsFromClient(touch.clientX, touch.clientY, pageNum);
      if (!coords) return;

      const activeTool = penEraserActiveRef.current ? 'eraser' : tool;

      // Track eraser position for the on-canvas indicator
      if (activeTool === 'eraser') {
        setEraserPos({ pageNum, x: coords.x, y: coords.y });
      }

      if (dragging && dragOffsetRef.current) {
        setDragPos({
          x: coords.x - dragOffsetRef.current.x,
          y: coords.y - dragOffsetRef.current.y,
        });
      } else if (isErasing && activeTool === 'eraser') {
        eraseAtCoords(coords, pageNum);
      } else if (isDrawing && activeTool === 'draw') {
        setCurrentPoints((prev) => [...prev, coords]);
      } else if (activeTool === 'highlight' && highlightStart) {
        setHighlightCurrent(coords);
      }
    },
    [isDrawing, isErasing, dragging, tool, getCoordsFromClient, getPageFromCanvas, highlightStart, eraseAtCoords],
  );

  const handleCanvasTouchEnd = useCallback(() => {
    // -- Drag release (text / icon / highlight): persist the new position --
    if (dragging) {
      commitMove();
      return;
    }

    if (isErasing) {
      setIsErasing(false);
      setEraserPos(null);
      erasedIdsRef.current = new Set();
      return;
    }

    if (tool === 'highlight' && highlightStart && highlightCurrent) {
      const x = Math.min(highlightStart.x, highlightCurrent.x);
      const y = Math.min(highlightStart.y, highlightCurrent.y);
      const width = Math.abs(highlightCurrent.x - highlightStart.x);
      const height = Math.abs(highlightCurrent.y - highlightStart.y);
      if (width > 1 && height > 1) {
        saveAnnotation({
          tool: 'highlight',
          page: activeDrawPage,
          x,
          y,
          color,
          opacity: highlightOpacity,
          data: { width, height },
        });
      }
    } else if (tool === 'draw' && isDrawing && currentPoints.length > 1) {
      saveAnnotation({
        tool: 'draw',
        page: activeDrawPage,
        x: currentPoints[0].x,
        y: currentPoints[0].y,
        color,
        opacity: toolOpacity,
        data: { points: [...currentPoints], lineWidth },
      });
    }
    setIsDrawing(false);
    setCurrentPoints([]);
    setHighlightStart(null);
    setHighlightCurrent(null);
  }, [
    tool,
    isDrawing,
    isErasing,
    dragging,
    commitMove,
    currentPoints,
    highlightStart,
    highlightCurrent,
    activeDrawPage,
    color,
    lineWidth,
    highlightOpacity,
    toolOpacity,
    saveAnnotation,
  ]);

  // -- Text annotation confirmation --
  const handleTextConfirm = useCallback(() => {
    if (!textInput.trim() || !textPosition) return;

    if (editingTextId && songNumber && filename) {
      // Edit mode: update the existing annotation in-place
      updateAnnotation({
        songNumber,
        filename,
        annotationId: Number(editingTextId),
        x: textPosition.x,
        y: textPosition.y,
        color,
        opacity: toolOpacity,
        data: { text: textInput.trim(), fontSize, fontBold, fontItalic, fontUnderline },
      });
      setEditingTextId(null);
    } else {
      // Create mode: add new annotation
      saveAnnotation({
        tool: 'text',
        page: activeDrawPage,
        x: textPosition.x,
        y: textPosition.y,
        color,
        opacity: toolOpacity,
        data: { text: textInput.trim(), fontSize, fontBold, fontItalic, fontUnderline },
      });
    }
    setTextInput('');
    setTextPosition(null);
  }, [
    editingTextId,
    textInput,
    textPosition,
    activeDrawPage,
    color,
    toolOpacity,
    fontSize,
    fontBold,
    fontItalic,
    fontUnderline,
    saveAnnotation,
    updateAnnotation,
    songNumber,
    filename,
  ]);

  /**
   * Double-click on a text annotation: enter edit mode.
   * Populates the text input and all style controls with the annotation's current values.
   */
  const handleCanvasDoubleClick = useCallback(
    (e: MouseEvent<HTMLCanvasElement>) => {
      if (!editMode || tool !== 'text') return;
      const pageNum = getPageFromCanvas(e.currentTarget);
      const coords = getCoordsFromClient(e.clientX, e.clientY, pageNum);
      if (!coords) return;

      const hitText = activeLayerAnnotations
        .filter((a) => a.tool === 'text' && a.page === pageNum && a.position && a.text)
        .reverse()
        .find((ann) => {
          const fs = ann.fontSize ?? 14;
          const approxWidth = ann.text!.length * fs * 0.06;
          const approxHeight = fs * 0.12;
          return (
            coords.x >= ann.position!.x - 1 &&
            coords.x <= ann.position!.x + approxWidth + 1 &&
            coords.y >= ann.position!.y - approxHeight &&
            coords.y <= ann.position!.y + 1
          );
        });

      if (!hitText || !hitText.position) return;

      // Populate all toolbar controls with the annotation's current values
      setEditingTextId(hitText.id);
      setTextInput(hitText.text ?? '');
      setTextPosition({ ...hitText.position });
      setActiveDrawPage(pageNum);
      setColor(hitText.color);
      setToolOpacity(hitText.opacity ?? 1.0);
      setFontSize(hitText.fontSize ?? 14);
      setFontBold(hitText.fontBold ?? false);
      setFontItalic(hitText.fontItalic ?? false);
      setFontUnderline(hitText.fontUnderline ?? false);
      setTimeout(() => textInputRef.current?.focus(), 50);
    },
    [editMode, tool, activeLayerAnnotations, getPageFromCanvas, getCoordsFromClient],
  );

  const handleClearLayer = useCallback(async () => {
    if (!songNumber || !filename) return;
    try {
      await clearLayerMutation({ songNumber, filename, layer: activeLayerKey }).unwrap();
    } catch (err) {
      console.error('[PdfAnnotation] clear failed:', err);
    }
  }, [songNumber, filename, activeLayerKey, clearLayerMutation]);

  // Derive layer names from annotations for fallback selection
  const layerNames = [...new Set(allAnnotations.map((a) => a.layer))];

  const handleLayerDeleted = useCallback(
    (deletedKey: string) => {
      if (deletedKey === activeLayerKey) {
        const remaining = layerNames.filter((l) => l !== deletedKey);
        setActiveLayerKey(remaining.length > 0 ? remaining[0] : preferredLayerKey);
      }
    },
    [activeLayerKey, preferredLayerKey, layerNames],
  );

  const handleLayerCreated = useCallback((newKey: string) => {
    setActiveLayerKey(newKey);
  }, []);

  const handleLayerRenamed = useCallback(
    (oldKey: string, newKey: string) => {
      if (activeLayerKey === oldKey) {
        setActiveLayerKey(newKey);
      }
    },
    [activeLayerKey],
  );

  // -- Icon upload handler --
  const handleIconUpload = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('icon', file);
      try {
        const result = await uploadIcon({ formData }).unwrap();
        if (result.filename) {
          setSelectedIconFilename(result.filename);
        }
      } catch (err) {
        console.error('[PdfAnnotation] icon upload failed:', err);
      }
      e.target.value = '';
    },
    [uploadIcon],
  );

  const handleIconDelete = useCallback(
    async (iconFn: string) => {
      try {
        await deleteIcon({ filename: iconFn }).unwrap();
        if (selectedIconFilename === iconFn) {
          setSelectedIconFilename(icons.length > 1 ? (icons.find((i) => i.filename !== iconFn)?.filename ?? null) : null);
        }
      } catch (err) {
        console.error('[PdfAnnotation] icon delete failed:', err);
      }
    },
    [deleteIcon, selectedIconFilename, icons],
  );

  /** Download PDF with all annotation layers as OCG groups */
  const handleDownloadWithAnnotations = useCallback(async () => {
    if (!pdfUrl || !songNumber || !filename) return;
    try {
      const pdfBytes = await fetch(pdfUrl).then((r) => r.arrayBuffer());
      const layerMap = new Map<string, AnnotationEntry[]>();
      for (const dto of allAnnotations) {
        if (hiddenLayers.has(dto.layer)) continue;
        const entry = dtoToEntry(dto);
        const list = layerMap.get(dto.layer) ?? [];
        list.push(entry);
        layerMap.set(dto.layer, list);
      }
      const exportLayers: ExportLayerData[] = [...layerMap.entries()]
        .filter(([, anns]) => anns.length > 0)
        .map(([layerName, annotations]) => ({ layerName, annotations }));
      const resultBytes = await exportPdfWithAnnotations(pdfBytes, exportLayers);
      const blob = new Blob([resultBytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Build a descriptive filename: "<songNumber> - <songName> - <pdfBase>_annotated.pdf"
      const pdfBase = filename.replace(/\.pdf$/i, '');
      const nameParts: string[] = [`${songNumber}`];
      if (songName) nameParts.push(songName);
      nameParts.push(pdfBase);
      const safeFilename = nameParts.join(' - ').replace(/[/\\?%*:|"<>]/g, '_');
      a.download = `${safeFilename}_annotated.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[PdfAnnotation] download failed:', err);
    }
  }, [pdfUrl, songNumber, filename, allAnnotations, hiddenLayers]);

  // -- Blinking cursor for text tool --
  const [cursorVisible, setCursorVisible] = useState(true);
  useEffect(() => {
    if (tool !== 'text' || !textPosition || !editMode) return;
    const iv = setInterval(() => setCursorVisible((v) => !v), 530);
    return () => clearInterval(iv);
  }, [tool, textPosition, editMode]);

  // -- Render annotations on per-page canvases --
  useEffect(() => {
    for (const [pageNum, canvas] of canvasRefs.current.entries()) {
      if (!canvas) continue;
      const parent = canvas.parentElement;
      if (parent) {
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
      } else {
        canvas.width = pageWidth;
        canvas.height = pageHeight;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      const cw = canvas.width;
      const ch = canvas.height;
      ctx.clearRect(0, 0, cw, ch);
      if (!showAnnotations) continue;

      const scaleFactor = cw / pdfPageWidth;

      // -- Draw background annotations (other visible layers) --
      // In edit mode: reduced opacity; in view mode: full opacity (same as active)
      const bgPageAnns = bgAnnotations.filter((a) => a.page === pageNum);
      if (bgPageAnns.length > 0) {
        ctx.save();
        for (const ann of bgPageAnns) {
          const bgAlpha = editMode ? 0.2 : (ann.opacity ?? 1);
          if (ann.tool === 'draw' && ann.points && ann.points.length > 1) {
            ctx.globalAlpha = bgAlpha;
            ctx.strokeStyle = editMode ? '#999' : ann.color;
            ctx.lineWidth = ann.lineWidth * scaleFactor;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo((ann.points[0].x / 100) * cw, (ann.points[0].y / 100) * ch);
            for (let i = 1; i < ann.points.length; i++) ctx.lineTo((ann.points[i].x / 100) * cw, (ann.points[i].y / 100) * ch);
            ctx.stroke();
            ctx.globalAlpha = 1.0;
          } else if (ann.tool === 'highlight' && ann.rect) {
            ctx.globalAlpha = editMode ? 0.2 : (ann.opacity ?? 0.25);
            ctx.fillStyle = editMode ? '#999' : ann.color;
            ctx.fillRect((ann.rect.x / 100) * cw, (ann.rect.y / 100) * ch, (ann.rect.width / 100) * cw, (ann.rect.height / 100) * ch);
            ctx.globalAlpha = 1.0;
          } else if (ann.tool === 'text' && ann.position && ann.text) {
            ctx.globalAlpha = bgAlpha;
            const b = ann.fontBold ? 'bold ' : '';
            const it = ann.fontItalic ? 'italic ' : '';
            ctx.fillStyle = editMode ? '#999' : ann.color;
            ctx.font = `${b}${it}${(ann.fontSize || 14) * scaleFactor}px sans-serif`;
            ctx.fillText(ann.text, (ann.position.x / 100) * cw, (ann.position.y / 100) * ch);
            ctx.globalAlpha = 1.0;
          } else if (ann.tool === 'icon' && ann.position && ann.iconUrl) {
            ctx.globalAlpha = bgAlpha;
            const img = iconImageCache.current.get(ann.iconUrl);
            if (img) {
              const sz = (ann.iconSize ?? ICON_BASE_SIZE) * scaleFactor;
              drawSvgIconOnCanvas(ctx, img, (ann.position.x / 100) * cw, (ann.position.y / 100) * ch, sz, editMode ? '#999' : ann.color);
            }
            ctx.globalAlpha = 1.0;
          }
        }
        ctx.restore();
      }

      // -- Draw active layer annotations --
      const pageAnns = activeLayerAnnotations.filter((a) => a.page === pageNum);
      for (const ann of pageAnns) {
        const annOpacity = ann.opacity ?? 1;
        // While an annotation is being relocated it follows the pointer and renders semi
        // transparent, so the drop position is obvious before releasing.
        const isBeingDragged = dragging?.id === ann.id && dragPos !== null;
        const livePos = isBeingDragged ? dragPos! : ann.position;
        if (ann.tool === 'draw' && ann.points && ann.points.length > 1) {
          ctx.globalAlpha = annOpacity;
          ctx.strokeStyle = ann.color;
          ctx.lineWidth = ann.lineWidth * scaleFactor;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo((ann.points[0].x / 100) * cw, (ann.points[0].y / 100) * ch);
          for (let i = 1; i < ann.points.length; i++) ctx.lineTo((ann.points[i].x / 100) * cw, (ann.points[i].y / 100) * ch);
          ctx.stroke();
          ctx.globalAlpha = 1.0;
        } else if (ann.tool === 'highlight' && ann.rect) {
          // The rect keeps its size while dragging — only the top-left anchor moves.
          const rectPos = livePos ?? ann.rect;
          ctx.globalAlpha = isBeingDragged ? 0.6 : (ann.opacity ?? 0.25);
          ctx.fillStyle = ann.color;
          ctx.fillRect((rectPos.x / 100) * cw, (rectPos.y / 100) * ch, (ann.rect.width / 100) * cw, (ann.rect.height / 100) * ch);
          ctx.globalAlpha = 1.0;
        } else if (ann.tool === 'text' && ann.position && ann.text) {
          const textPos = livePos ?? ann.position;
          ctx.globalAlpha = isBeingDragged ? 0.6 : annOpacity;
          const b = ann.fontBold ? 'bold ' : '';
          const it = ann.fontItalic ? 'italic ' : '';
          ctx.fillStyle = ann.color;
          ctx.font = `${b}${it}${(ann.fontSize || 14) * scaleFactor}px sans-serif`;
          const tx = (textPos.x / 100) * cw;
          const ty = (textPos.y / 100) * ch;
          ctx.fillText(ann.text, tx, ty);
          if (ann.fontUnderline) {
            const tw = ctx.measureText(ann.text).width;
            ctx.strokeStyle = ann.color;
            ctx.lineWidth = Math.max(1, (ann.fontSize || 14) / 12);
            ctx.beginPath();
            ctx.moveTo(tx, ty + 2);
            ctx.lineTo(tx + tw, ty + 2);
            ctx.stroke();
          }
          ctx.globalAlpha = 1.0;
        } else if (ann.tool === 'icon' && ann.position && ann.iconUrl) {
          const iconPos = livePos ?? ann.position;
          ctx.globalAlpha = isBeingDragged ? 0.6 : annOpacity;
          const img = iconImageCache.current.get(ann.iconUrl);
          if (img) {
            const sz = (ann.iconSize ?? ICON_BASE_SIZE) * scaleFactor;
            drawSvgIconOnCanvas(ctx, img, (iconPos.x / 100) * cw, (iconPos.y / 100) * ch, sz, ann.color);
          }
          ctx.globalAlpha = 1.0;
        }
      }

      // In-progress freehand stroke
      if (editMode && pageNum === activeDrawPage && isDrawing && currentPoints.length > 1) {
        ctx.globalAlpha = toolOpacity;
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth * scaleFactor;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo((currentPoints[0].x / 100) * cw, (currentPoints[0].y / 100) * ch);
        for (let i = 1; i < currentPoints.length; i++) ctx.lineTo((currentPoints[i].x / 100) * cw, (currentPoints[i].y / 100) * ch);
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }

      // In-progress highlight
      if (editMode && pageNum === activeDrawPage && highlightStart && highlightCurrent) {
        const rx = Math.min(highlightStart.x, highlightCurrent.x);
        const ry = Math.min(highlightStart.y, highlightCurrent.y);
        const rw = Math.abs(highlightCurrent.x - highlightStart.x);
        const rh = Math.abs(highlightCurrent.y - highlightStart.y);
        ctx.globalAlpha = highlightOpacity;
        ctx.fillStyle = color;
        ctx.fillRect((rx / 100) * cw, (ry / 100) * ch, (rw / 100) * cw, (rh / 100) * ch);
        ctx.globalAlpha = 1.0;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect((rx / 100) * cw, (ry / 100) * ch, (rw / 100) * cw, (rh / 100) * ch);
        ctx.setLineDash([]);
      }

      // Text cursor + live text preview
      if (editMode && pageNum === activeDrawPage && tool === 'text' && textPosition) {
        const b = fontBold ? 'bold ' : '';
        const it = fontItalic ? 'italic ' : '';
        const fsPx = fontSize * scaleFactor;
        const tx = (textPosition.x / 100) * cw;
        const ty = (textPosition.y / 100) * ch;

        // Draw live text preview (ghost)
        if (textInput) {
          ctx.globalAlpha = 0.5;
          ctx.fillStyle = color;
          ctx.font = `${b}${it}${fsPx}px sans-serif`;
          ctx.fillText(textInput, tx, ty);
          if (fontUnderline) {
            const tw = ctx.measureText(textInput).width;
            ctx.strokeStyle = color;
            ctx.lineWidth = Math.max(1, fontSize / 12);
            ctx.beginPath();
            ctx.moveTo(tx, ty + 2);
            ctx.lineTo(tx + tw, ty + 2);
            ctx.stroke();
          }
          ctx.globalAlpha = 1.0;
        }

        // Blinking cursor
        if (cursorVisible) {
          ctx.font = `${b}${it}${fsPx}px sans-serif`;
          const textW = textInput ? ctx.measureText(textInput).width : 0;
          const cursorX = tx + textW;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.globalAlpha = 0.8;
          ctx.beginPath();
          ctx.moveTo(cursorX, ty - fsPx * 0.8);
          ctx.lineTo(cursorX, ty + fsPx * 0.2);
          ctx.stroke();
          ctx.globalAlpha = 1.0;
        }
      }

      // -- Eraser cursor indicator --
      // Draws a small eraser symbol (circle + inner cross) under the pointer
      // while the eraser tool is active on this page.
      if (editMode && effectiveTool === 'eraser' && eraserPos && eraserPos.pageNum === pageNum) {
        const ex = (eraserPos.x / 100) * cw;
        const ey = (eraserPos.y / 100) * ch;
        const r = 8; // fixed pixel radius for the indicator circle
        ctx.save();
        ctx.globalAlpha = 0.85;
        // Outer circle — white outline for contrast
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(ex, ey, r, 0, Math.PI * 2);
        ctx.stroke();
        // Inner circle — dark ring
        ctx.strokeStyle = '#333333';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(ex, ey, r, 0, Math.PI * 2);
        ctx.stroke();
        // Crosshair lines inside
        ctx.strokeStyle = '#333333';
        ctx.lineWidth = 1;
        const arm = r * 0.5;
        ctx.beginPath();
        ctx.moveTo(ex - arm, ey);
        ctx.lineTo(ex + arm, ey);
        ctx.moveTo(ex, ey - arm);
        ctx.lineTo(ex, ey + arm);
        ctx.stroke();
        ctx.restore();
      }
    }
  }, [
    activeLayerAnnotations,
    bgAnnotations,
    pageWidth,
    pageHeight,
    showAnnotations,
    isDrawing,
    currentPoints,
    color,
    lineWidth,
    highlightOpacity,
    highlightStart,
    highlightCurrent,
    activeDrawPage,
    numPages,
    tool,
    effectiveTool,
    textPosition,
    textInput,
    fontSize,
    fontBold,
    fontItalic,
    fontUnderline,
    pdfPageWidth,
    editMode,
    cursorVisible,
    toolOpacity,
    activeLayerKey,
    dragging,
    dragPos,
    iconLoadVersion,
    eraserPos,
  ]);

  // -- Per-page overlay wrappers --
  const [pageWrappers, setPageWrappers] = useState<Map<number, HTMLElement>>(new Map());

  useEffect(() => {
    const container = containerRef.current;
    if (!container || numPages === 0) return;

    const findAndSetWrappers = () => {
      const pages = container.querySelectorAll('.react-pdf__Page');
      if (pages.length === 0) return false;
      const wrappers = new Map<number, HTMLElement>();
      pages.forEach((pageEl, idx) => {
        const pageNum = idx + 1;
        const el = pageEl as HTMLElement;
        if (el.style.position !== 'relative') el.style.position = 'relative';
        let w = el.querySelector('.annotation-canvas-wrapper') as HTMLElement | null;
        if (!w) {
          w = document.createElement('div');
          w.className = 'annotation-canvas-wrapper';
          w.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5';
          el.appendChild(w);
        }
        wrappers.set(pageNum, w);
      });
      setPageWrappers(wrappers);
      return true;
    };

    findAndSetWrappers();
    const observer = new MutationObserver(findAndSetWrappers);
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [containerRef, numPages, pageWidth, pdfUrl]);

  const cursorStyle = dragging
    ? // Any annotation being relocated shows the move cursor, whichever tool grabbed it.
      'move'
    : effectiveTool === 'draw'
      ? 'crosshair'
      : effectiveTool === 'text'
        ? 'text'
        : effectiveTool === 'highlight'
          ? 'crosshair'
          : effectiveTool === 'icon'
            ? 'copy'
            : effectiveTool === 'eraser'
              ? 'none' // hide the OS cursor — the canvas indicator takes over
              : 'default';

  /** Style for SVG icon previews — apply filter in dark mode for visibility */
  const iconPreviewStyle: CSSProperties = {
    width: 24,
    height: 24,
    objectFit: 'contain',
    filter: isDark ? 'invert(1) hue-rotate(180deg)' : 'none',
  };

  return (
    <>
      {/* -- Canvas overlays — always rendered (read-only when not editing) -- */}
      {Array.from(pageWrappers.entries()).map(([pageNum, wrapper]) =>
        createPortal(
          <canvas
            key={pageNum}
            ref={(el) => {
              if (el) canvasRefs.current.set(pageNum, el);
              else canvasRefs.current.delete(pageNum);
            }}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              pointerEvents: editMode && tool !== 'none' ? 'auto' : 'none',
              cursor: editMode ? cursorStyle : 'default',
              touchAction: 'none',
            }}
            onPointerDown={editMode ? handlePointerDown : undefined}
            onPointerUp={editMode ? handlePointerUp : undefined}
            onMouseDown={editMode ? handleCanvasMouseDown : undefined}
            onMouseMove={editMode ? handleCanvasMouseMove : undefined}
            onMouseUp={editMode ? handleCanvasMouseUp : undefined}
            onMouseLeave={editMode ? handleCanvasMouseLeave : undefined}
            onDoubleClick={editMode ? handleCanvasDoubleClick : undefined}
            onTouchStart={editMode ? handleCanvasTouchStart : undefined}
            onTouchMove={editMode ? handleCanvasTouchMove : undefined}
            onTouchEnd={editMode ? handleCanvasTouchEnd : undefined}
          />,
          wrapper,
        ),
      )}
      {/* -- Toolbar UI — only visible in edit mode -- */}
      {editMode && (
        <Stack
          sx={{
            alignItems: 'center',
            display: 'inline-flex',
          }}
        >
          {/* -- Tool-specific options (secondary bar — above main toolbar) -- */}
          {tool === 'draw' && (
            <Paper elevation={1} sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5, mb: 0.5, borderRadius: 1 }}>
              <Typography variant="caption" sx={{ minWidth: 60 }}>
                {LL.ANNOTATION.DRAW()}
              </Typography>
              <Slider size="small" min={1} max={10} value={lineWidth} onChange={(_, v) => setLineWidth(v as number)} sx={{ width: 100 }} />
              <Typography variant="caption" sx={{ width: 20 }}>
                {lineWidth}
              </Typography>
              <Divider orientation="vertical" flexItem />
              <Typography variant="caption" sx={{ minWidth: 50 }}>
                {LL.ANNOTATION.OPACITY()}
              </Typography>
              <Slider
                size="small"
                min={0.05}
                max={1}
                step={0.05}
                value={toolOpacity}
                onChange={(_, v) => setToolOpacity(v as number)}
                sx={{ width: 80 }}
              />
              <Typography variant="caption" sx={{ width: 30 }}>
                {Math.round(toolOpacity * 100)}%
              </Typography>
            </Paper>
          )}

          {tool === 'text' && (
            <Paper
              elevation={1}
              sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5, px: 1, py: 0.5, mb: 0.5, borderRadius: 1 }}
            >
              <TextField
                size="small"
                placeholder={LL.ANNOTATION.TEXT_PLACEHOLDER()}
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleTextConfirm();
                }}
                inputRef={textInputRef}
                sx={{ flex: 1, minWidth: 120, '& .MuiInputBase-input': { py: 0.5, fontSize: '0.8rem' } }}
              />
              <Button size="small" variant="contained" onClick={handleTextConfirm} disabled={!textInput.trim() || !textPosition}>
                {editingTextId ? LL.COMMON.APPLY() : LL.ANNOTATION.TEXT_ADD()}
              </Button>
              <Divider orientation="vertical" flexItem />
              <Tooltip title={LL.ANNOTATION.BOLD()}>
                <IconButton size="small" onClick={() => setFontBold((v) => !v)} color={fontBold ? 'primary' : 'default'}>
                  <BoldIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title={LL.ANNOTATION.ITALIC()}>
                <IconButton size="small" onClick={() => setFontItalic((v) => !v)} color={fontItalic ? 'primary' : 'default'}>
                  <ItalicIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title={LL.ANNOTATION.UNDERLINE()}>
                <IconButton size="small" onClick={() => setFontUnderline((v) => !v)} color={fontUnderline ? 'primary' : 'default'}>
                  <UnderlineIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
              <Divider orientation="vertical" flexItem />
              <Typography variant="caption" sx={{ minWidth: 50 }}>
                {LL.ANNOTATION.FONT_SIZE()}
              </Typography>
              <Slider size="small" min={8} max={48} value={fontSize} onChange={(_, v) => setFontSize(v as number)} sx={{ width: 80 }} />
              <Typography variant="caption" sx={{ width: 20 }}>
                {fontSize}
              </Typography>
              <Divider orientation="vertical" flexItem />
              <Typography variant="caption" sx={{ minWidth: 50 }}>
                {LL.ANNOTATION.OPACITY()}
              </Typography>
              <Slider
                size="small"
                min={0.05}
                max={1}
                step={0.05}
                value={toolOpacity}
                onChange={(_, v) => setToolOpacity(v as number)}
                sx={{ width: 80 }}
              />
              <Typography variant="caption" sx={{ width: 30 }}>
                {Math.round(toolOpacity * 100)}%
              </Typography>
            </Paper>
          )}

          {tool === 'highlight' && (
            <Paper elevation={1} sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5, mb: 0.5, borderRadius: 1 }}>
              <Typography variant="caption" sx={{ minWidth: 80 }}>
                {LL.ANNOTATION.RECT_OPACITY()}
              </Typography>
              <Slider
                size="small"
                min={0.05}
                max={1}
                step={0.05}
                value={highlightOpacity}
                onChange={(_, v) => setHighlightOpacity(v as number)}
                sx={{ width: 100 }}
              />
              <Typography variant="caption" sx={{ width: 30 }}>
                {Math.round(highlightOpacity * 100)}%
              </Typography>
            </Paper>
          )}

          {tool === 'icon' && (
            <Paper
              elevation={1}
              sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5, px: 1, py: 0.5, mb: 0.5, borderRadius: 1 }}
            >
              <Typography variant="caption" sx={{ mr: 1 }}>
                {LL.ANNOTATION.ICON()}
              </Typography>

              {icons.length === 0 ? (
                <Typography
                  variant="caption"
                  sx={{
                    color: 'text.secondary',
                  }}
                >
                  {LL.ANNOTATION.ICON_NONE()}
                </Typography>
              ) : (
                icons.map((icon) => (
                  <Tooltip key={icon.filename} title={icon.name}>
                    <Box
                      onClick={() => setSelectedIconFilename(icon.filename)}
                      sx={{
                        width: 32,
                        height: 32,
                        border: selectedIconFilename === icon.filename ? '2px solid' : '1px solid',
                        borderColor: selectedIconFilename === icon.filename ? 'primary.main' : 'divider',
                        borderRadius: 0.5,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        p: 0.25,
                        bgcolor: isDark ? 'grey.800' : 'grey.50',
                      }}
                    >
                      <img src={icon.url} alt={icon.name} style={iconPreviewStyle} />
                    </Box>
                  </Tooltip>
                ))
              )}

              <Divider orientation="vertical" flexItem />

              <Tooltip title={LL.ANNOTATION.ICON_MANAGE()}>
                <IconButton size="small" onClick={(e) => setIconPopoverAnchor(e.currentTarget)}>
                  <SettingsIcon fontSize="small" />
                </IconButton>
              </Tooltip>

              <Popover
                open={Boolean(iconPopoverAnchor)}
                anchorEl={iconPopoverAnchor}
                onClose={() => setIconPopoverAnchor(null)}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
              >
                <Stack sx={{ p: 1.5, minWidth: 200, maxWidth: 300 }} spacing={1}>
                  <Typography variant="subtitle2">{LL.ANNOTATION.ICON_MANAGE()}</Typography>
                  {icons.length === 0 ? (
                    <Typography
                      variant="body2"
                      sx={{
                        color: 'text.secondary',
                      }}
                    >
                      {LL.ANNOTATION.ICON_NONE()}
                    </Typography>
                  ) : (
                    icons.map((icon) => (
                      <Stack
                        key={icon.filename}
                        direction="row"
                        spacing={1}
                        sx={{
                          alignItems: 'center',
                        }}
                      >
                        <Box sx={{ bgcolor: isDark ? 'grey.800' : 'grey.50', borderRadius: 0.5, p: 0.25, display: 'flex' }}>
                          <img src={icon.url} alt={icon.name} style={iconPreviewStyle} />
                        </Box>
                        <Typography variant="body2" sx={{ flex: 1 }} noWrap>
                          {icon.name}
                        </Typography>
                        <Tooltip title={LL.ANNOTATION.ICON_DELETE()}>
                          <IconButton size="small" onClick={() => handleIconDelete(icon.filename)}>
                            <DeleteIcon sx={{ fontSize: 14 }} />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    ))
                  )}
                  <Divider />
                  <Button size="small" variant="outlined" component="label" startIcon={<UploadIcon />}>
                    {LL.ANNOTATION.ICON_UPLOAD()}
                    <input type="file" accept=".svg" hidden onChange={handleIconUpload} />
                  </Button>
                </Stack>
              </Popover>

              <Divider orientation="vertical" flexItem />
              <Typography variant="caption" sx={{ minWidth: 40 }}>
                {LL.ANNOTATION.ICON_SIZE()}
              </Typography>
              <Slider
                size="small"
                min={12}
                max={48}
                step={2}
                value={iconSize}
                onChange={(_, v) => setIconSize(v as number)}
                sx={{ width: 80 }}
              />
              <Typography variant="caption" sx={{ width: 30 }}>
                {iconSize}px
              </Typography>
              <Divider orientation="vertical" flexItem />
              <Typography variant="caption" sx={{ minWidth: 50 }}>
                {LL.ANNOTATION.OPACITY()}
              </Typography>
              <Slider
                size="small"
                min={0.05}
                max={1}
                step={0.05}
                value={toolOpacity}
                onChange={(_, v) => setToolOpacity(v as number)}
                sx={{ width: 80 }}
              />
              <Typography variant="caption" sx={{ width: 30 }}>
                {Math.round(toolOpacity * 100)}%
              </Typography>
            </Paper>
          )}

          {tool === 'eraser' && (
            <Paper elevation={1} sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5, mb: 0.5, borderRadius: 1 }}>
              <Typography
                variant="caption"
                sx={{
                  color: 'text.secondary',
                }}
              >
                {LL.ANNOTATION.ERASER_HINT()}
              </Typography>
            </Paper>
          )}

          {/* -- Main toolbar (primary bar) -- */}
          <Paper
            elevation={2}
            sx={{
              display: 'inline-flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 0.5,
              p: 0.5,
              borderRadius: 1,
            }}
          >
            <ToggleButtonGroup size="small" value={tool} exclusive onChange={(_, val) => setTool((val ?? 'none') as AnnotationTool)}>
              <ToggleButton value="draw">
                <Tooltip title={LL.ANNOTATION.DRAW()}>
                  <DrawIcon fontSize="small" />
                </Tooltip>
              </ToggleButton>
              <ToggleButton value="text">
                <Tooltip title={LL.ANNOTATION.TEXT()}>
                  <TextIcon fontSize="small" />
                </Tooltip>
              </ToggleButton>
              <ToggleButton value="highlight">
                <Tooltip title={LL.ANNOTATION.HIGHLIGHT()}>
                  <HighlightIcon fontSize="small" />
                </Tooltip>
              </ToggleButton>
              <ToggleButton value="icon">
                <Tooltip title={LL.ANNOTATION.ICON()}>
                  <IconToolIcon fontSize="small" />
                </Tooltip>
              </ToggleButton>
              <ToggleButton value="eraser">
                <Tooltip title={LL.ANNOTATION.ERASER()}>
                  <EraserIcon fontSize="small" />
                </Tooltip>
              </ToggleButton>
            </ToggleButtonGroup>

            <Divider orientation="vertical" flexItem />

            <Stack direction="row" spacing={0.25}>
              {ANNOTATION_COLORS.map((c) => (
                <Box
                  key={c}
                  onClick={() => setColor(c)}
                  sx={{
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    bgcolor: c,
                    border: c === color ? '2px solid' : '1px solid',
                    borderColor: c === color ? 'primary.main' : 'divider',
                    cursor: 'pointer',
                  }}
                />
              ))}
            </Stack>

            <Divider orientation="vertical" flexItem />

            <Tooltip title={LL.ANNOTATION.CLEAR_LAYER()}>
              <IconButton size="small" onClick={() => setClearConfirmOpen(true)}>
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Tooltip>

            <Divider orientation="vertical" flexItem />

            <PdfLayerViewer
              songNumber={songNumber}
              filename={filename}
              showDelete
              showVisibilityToggle={false}
              selectedLayer={activeLayerKey}
              onLayerSelect={setActiveLayerKey}
              onLayerDeleted={handleLayerDeleted}
              onLayerCreated={handleLayerCreated}
              onLayerRenamed={handleLayerRenamed}
              showAnnotations={showAnnotations}
              onShowAnnotationsChange={onShowAnnotationsChange}
              hiddenLayers={hiddenLayers}
              onToggleLayerVisibility={onToggleLayerVisibility}
            />

            <Chip label={activeLayerKey} size="small" variant="outlined" sx={{ maxWidth: 120, fontSize: '0.7rem' }} />

            <Divider orientation="vertical" flexItem />

            <Tooltip title={LL.ANNOTATION.DOWNLOAD_PDF()}>
              <IconButton size="small" onClick={handleDownloadWithAnnotations}>
                <DownloadIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Paper>
        </Stack>
      )}
      {/* -- Clear confirmation dialog -- */}
      <Dialog open={clearConfirmOpen} onClose={() => setClearConfirmOpen(false)}>
        <DialogTitle>{LL.ANNOTATION.CLEAR_LAYER()}</DialogTitle>
        <DialogContent>
          <DialogContentText>{LL.ANNOTATION.REMOVE_LAYER_CONFIRM()}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setClearConfirmOpen(false)}>{LL.COMMON.CANCEL()}</Button>
          <Button onClick={handleClearLayer} color="error">
            {LL.ANNOTATION.CLEAR_LAYER()}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
