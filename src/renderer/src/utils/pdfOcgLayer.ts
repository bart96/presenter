/**
 * PDF OCG (Optional Content Group) Layer Utilities
 *
 * Uses pdf-lib's low-level API to embed annotations as a named,
 * toggleable layer inside the PDF. Any compliant PDF viewer
 * (Acrobat, Preview, Evince, etc.) can toggle the layer on/off.
 *
 * Layer name convention: `Annotations (<musicianName>)`
 */
import { PDFDocument, PDFName, PDFString, PDFArray, PDFDict, PDFRef, PDFOperator, PDFStream, rgb, StandardFonts } from 'pdf-lib';
import type { AnnotationEntry } from '@/components/pdf/PdfAnnotationToolbar';

/** Info about a single OCG layer found in a PDF */
export interface OcgLayerInfo {
  /** Display name from the OCG dict */
  name: string;
  /** Whether the layer is currently in the ON array (visible) */
  visible: boolean;
}

/** Get the intrinsic page width (in PDF points) for page 1. Returns 612 as fallback. */
export async function getPdfPageWidth(pdfBytes: ArrayBuffer): Promise<number> {
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes);
    if (pdfDoc.getPageCount() === 0) return 612;
    const { width } = pdfDoc.getPage(0).getSize();
    return width || 612;
  } catch {
    return 612;
  }
}

/** Build a deterministic OCG layer name */
export function layerName(musicianName: string): string {
  return musicianName || 'default';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseHexColor(hex: string) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return rgb(r, g, b);
}

/** Format a number with max 4 decimals, avoiding "-0" */
function n(v: number): string {
  const s = Number(v.toFixed(4));
  return String(s === 0 ? 0 : s);
}

// ─── Build content stream operators for one page's annotations ───────────────

function buildPageStream(
  anns: AnnotationEntry[],
  pw: number,
  ph: number,
  fonts: { regular: string; bold: string; italic: string; boldItalic: string },
): string {
  const ops: string[] = [];

  for (const ann of anns) {
    if (ann.tool === 'draw' && ann.points && ann.points.length > 1) {
      const c = parseHexColor(ann.color);
      ops.push('q');
      ops.push(`${n(c.red)} ${n(c.green)} ${n(c.blue)} RG`);
      ops.push(`${n(ann.lineWidth)} w`);
      ops.push('1 J 1 j'); // round cap & join
      const first = ann.points[0];
      ops.push(`${n((first.x / 100) * pw)} ${n(ph - (first.y / 100) * ph)} m`);
      for (let i = 1; i < ann.points.length; i++) {
        const p = ann.points[i];
        ops.push(`${n((p.x / 100) * pw)} ${n(ph - (p.y / 100) * ph)} l`);
      }
      ops.push('S');
      ops.push('Q');
    } else if (ann.tool === 'highlight' && ann.rect) {
      const c = parseHexColor(ann.color);
      const opacity = ann.opacity ?? 0.25;
      const x = (ann.rect.x / 100) * pw;
      const y = ph - ((ann.rect.y + ann.rect.height) / 100) * ph;
      const w = (ann.rect.width / 100) * pw;
      const h = (ann.rect.height / 100) * ph;
      ops.push('q');
      // Use graphics state for opacity (via inline gs is not allowed,
      // but we can use 'rg' for fill color and approximate via transparency group)
      // For simplicity, we'll set the fill color and draw.
      // True opacity requires an ExtGState resource — we handle this below.
      ops.push(`/GS_A${Math.round(opacity * 100)} gs`);
      ops.push(`${n(c.red)} ${n(c.green)} ${n(c.blue)} rg`);
      ops.push(`${n(x)} ${n(y)} ${n(w)} ${n(h)} re f`);
      ops.push('Q');
    } else if (ann.tool === 'text' && ann.position && ann.text) {
      const c = parseHexColor(ann.color);
      const size = ann.fontSize || 14;
      const tx = (ann.position.x / 100) * pw;
      const ty = ph - (ann.position.y / 100) * ph;
      let fontKey = fonts.regular;
      if (ann.fontBold && ann.fontItalic) fontKey = fonts.boldItalic;
      else if (ann.fontBold) fontKey = fonts.bold;
      else if (ann.fontItalic) fontKey = fonts.italic;

      ops.push('q');
      ops.push('BT');
      ops.push(`/${fontKey} ${n(size)} Tf`);
      ops.push(`${n(c.red)} ${n(c.green)} ${n(c.blue)} rg`);
      ops.push(`${n(tx)} ${n(ty)} Td`);
      // Escape special PDF string chars
      const escaped = ann.text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
      ops.push(`(${escaped}) Tj`);
      ops.push('ET');

      // Underline
      if (ann.fontUnderline) {
        const approxWidth = size * 0.5 * ann.text.length; // rough approximation
        const underlineY = ty - 2;
        ops.push(`${n(c.red)} ${n(c.green)} ${n(c.blue)} RG`);
        ops.push(`${n(Math.max(0.5, size / 14))} w`);
        ops.push(`${n(tx)} ${n(underlineY)} m ${n(tx + approxWidth)} ${n(underlineY)} l S`);
      }
      ops.push('Q');
    }
  }

  return ops.join('\n');
}

function collectOpacities(annotations: AnnotationEntry[]): number[] {
  const set = new Set<number>();
  for (const ann of annotations) {
    if (ann.tool === 'highlight') {
      set.add(Math.round((ann.opacity ?? 0.25) * 100));
    }
  }
  return Array.from(set);
}

// ─── Public: Save annotations as a named OCG layer ───────────────────────────

export async function saveAnnotationLayer(pdfBytes: ArrayBuffer, annotations: AnnotationEntry[], musician: string): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const ctx = pdfDoc.context;

  // First, remove any existing layer with the same name
  removeLayerInternal(pdfDoc, layerName(musician));

  // ── 1. Create OCG (Optional Content Group) ─────────────────────────────────
  const ocgName = layerName(musician);
  const ocgDict = ctx.obj({
    Type: 'OCG',
    Name: PDFString.of(ocgName),
  });
  const ocgRef = ctx.register(ocgDict);

  // ── 2. Register OCG in the document catalog ────────────────────────────────
  const catalog = pdfDoc.catalog;
  const existingOCProps = catalog.get(PDFName.of('OCProperties'));
  if (existingOCProps) {
    const ocProps = existingOCProps as PDFDict;
    const ocgsArray = ocProps.get(PDFName.of('OCGs'));
    if (ocgsArray instanceof PDFArray) ocgsArray.push(ocgRef);
    const dDict = ocProps.get(PDFName.of('D'));
    if (dDict instanceof PDFDict) {
      const onArray = dDict.get(PDFName.of('ON'));
      if (onArray instanceof PDFArray) onArray.push(ocgRef);
      const orderArray = dDict.get(PDFName.of('Order'));
      if (orderArray instanceof PDFArray) orderArray.push(ocgRef);
    }
  } else {
    const ocProps = ctx.obj({
      OCGs: [ocgRef],
      D: ctx.obj({
        Name: PDFString.of('Default'),
        ON: [ocgRef],
        Order: [ocgRef],
      }),
    });
    catalog.set(PDFName.of('OCProperties'), ocProps);
  }

  // ── 3. Store annotation JSON as document metadata (always, even for empty) ─
  const metadataKey = `PresenterAnnotations_${musician.replace(/\W/g, '_')}`;
  const infoDict = pdfDoc.catalog.get(PDFName.of('PieceInfo')) as PDFDict | undefined;
  const pieceInfo = infoDict ?? (ctx.obj({}) as unknown as PDFDict);
  const appDict = ctx.obj({
    LastModified: PDFString.of(new Date().toISOString()),
    Private: PDFString.of(JSON.stringify(annotations)),
  });
  (pieceInfo as any).set(PDFName.of(metadataKey), appDict);
  if (!infoDict) {
    catalog.set(PDFName.of('PieceInfo'), pieceInfo);
  }

  if (musician) pdfDoc.setAuthor(musician);

  // If there are no visual annotations, we're done — the layer exists but is empty
  if (annotations.length === 0) {
    return pdfDoc.save();
  }

  // ── 4. Embed fonts ─────────────────────────────────────────────────────────
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const fontBoldItalic = await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique);
  const fontNames = { regular: 'F_AR', bold: 'F_AB', italic: 'F_AI', boldItalic: 'F_ABI' };

  // ── 5. Create ExtGState resources for opacity ──────────────────────────────
  const opacities = collectOpacities(annotations);
  const gsRefs: Record<string, PDFRef> = {};
  for (const op of opacities) {
    const gsDict = ctx.obj({ Type: 'ExtGState', ca: op / 100 });
    gsRefs[`GS_A${op}`] = ctx.register(gsDict);
  }

  // ── 6. For each page with annotations, create a Form XObject ───────────────
  const pageGroups = new Map<number, AnnotationEntry[]>();
  for (const ann of annotations) {
    const existing = pageGroups.get(ann.page) ?? [];
    existing.push(ann);
    pageGroups.set(ann.page, existing);
  }

  for (const [pageNum, pageAnns] of pageGroups.entries()) {
    const pageIdx = pageNum - 1;
    if (pageIdx < 0 || pageIdx >= pdfDoc.getPageCount()) continue;
    const page = pdfDoc.getPage(pageIdx);
    const { width: pw, height: ph } = page.getSize();

    const streamContent = buildPageStream(pageAnns, pw, ph, fontNames);

    const fontDictEntries: Record<string, PDFRef> = {};
    fontDictEntries[fontNames.regular] = (fontRegular as any).ref;
    fontDictEntries[fontNames.bold] = (fontBold as any).ref;
    fontDictEntries[fontNames.italic] = (fontItalic as any).ref;
    fontDictEntries[fontNames.boldItalic] = (fontBoldItalic as any).ref;
    const fontDict = ctx.obj(fontDictEntries);

    const extGStateEntries: Record<string, PDFRef> = {};
    for (const [name, ref] of Object.entries(gsRefs)) extGStateEntries[name] = ref;
    const extGStateDict = Object.keys(extGStateEntries).length > 0 ? ctx.obj(extGStateEntries) : undefined;

    // A Transparency Group is required for fill-alpha (ca) in ExtGState to be
    // honoured by PDF viewers and pdfjs.  Without /Group the alpha channel is
    // effectively ignored and highlights render as fully opaque.
    const transparencyGroup = ctx.obj({ Type: 'Group', S: 'Transparency', CS: 'DeviceRGB', I: false, K: false });
    const formDictData: Record<string, any> = {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, pw, ph],
      OC: ocgRef,
      Group: transparencyGroup,
      Resources: extGStateDict ? ctx.obj({ Font: fontDict, ExtGState: extGStateDict }) : ctx.obj({ Font: fontDict }),
    };
    const formDict = ctx.obj(formDictData as any);
    const formStream = ctx.stream(streamContent, formDict as any);
    const formRef = ctx.register(formStream);

    const resources = page.node.Resources();
    if (!resources) continue;
    let xobjectDict = resources.get(PDFName.of('XObject')) as PDFDict | undefined;
    if (!xobjectDict) {
      xobjectDict = ctx.obj({}) as unknown as PDFDict;
      resources.set(PDFName.of('XObject'), xobjectDict);
    }

    const xobjName = `AnnotLayer_${musician.replace(/\W/g, '_')}_P${pageNum}`;
    (xobjectDict as any).set(PDFName.of(xobjName), formRef);
    page.pushOperators(PDFOperator.of('Do' as any, [PDFName.of(xobjName)]));
  }

  return pdfDoc.save();
}

// ─── Public: Read annotations from a PDF's embedded metadata ─────────────────

export async function readAnnotationLayer(pdfBytes: ArrayBuffer, musician: string): Promise<AnnotationEntry[]> {
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pieceInfo = pdfDoc.catalog.get(PDFName.of('PieceInfo')) as PDFDict | undefined;
    if (!pieceInfo) return [];

    // Try the given name first (new format: plain name)
    const metadataKey = `PresenterAnnotations_${musician.replace(/\W/g, '_')}`;
    const appDict = (pieceInfo as any).get(PDFName.of(metadataKey)) as PDFDict | undefined;

    if (!appDict) return [];
    const privateData = (appDict as any).get(PDFName.of('Private'));
    if (!privateData) return [];
    const jsonStr = privateData instanceof PDFString ? privateData.decodeText() : String(privateData);
    return JSON.parse(jsonStr) as AnnotationEntry[];
  } catch {
    return [];
  }
}

// ─── Public: Check if a PDF has an annotation layer for this musician ─────────

export async function hasAnnotationLayer(pdfBytes: ArrayBuffer, musician: string): Promise<boolean> {
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes);
    return findOcgRef(pdfDoc, layerName(musician)) !== null;
  } catch {
    return false;
  }
}

// ─── Public: Remove annotation layer from PDF ────────────────────────────────

export async function removeAnnotationLayer(pdfBytes: ArrayBuffer, musician: string): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  removeLayerInternal(pdfDoc, layerName(musician));

  // Also remove metadata
  const metadataKey = `PresenterAnnotations_${musician.replace(/\W/g, '_')}`;
  const pieceInfo = pdfDoc.catalog.get(PDFName.of('PieceInfo')) as PDFDict | undefined;
  if (pieceInfo) {
    (pieceInfo as any).delete(PDFName.of(metadataKey));
  }

  return pdfDoc.save();
}

// ─── Public: Rename an annotation layer ──────────────────────────────────────

/**
 * Rename an annotation layer by changing its OCG Name and migrating the
 * PieceInfo metadata to the new key.
 * @param pdfBytes  Raw PDF bytes
 * @param oldMusician  Current musician key (the part inside "Annotations (…)")
 * @param newMusician  New musician key
 */
export async function renameAnnotationLayer(pdfBytes: ArrayBuffer, oldMusician: string, newMusician: string): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const ctx = pdfDoc.context;
  const oldName = layerName(oldMusician);
  const newName = layerName(newMusician);

  // ── Rename the OCG dict entry ──────────────────────────────────────────────
  const ocgRef = findOcgRef(pdfDoc, oldName);
  if (ocgRef) {
    const dict = ctx.lookup(ocgRef);
    if (dict instanceof PDFDict) {
      dict.set(PDFName.of('Name'), PDFString.of(newName));
    }
  }

  // ── Migrate PieceInfo metadata key ────────────────────────────────────────
  const oldMetaKey = `PresenterAnnotations_${oldMusician.replace(/\W/g, '_')}`;
  const newMetaKey = `PresenterAnnotations_${newMusician.replace(/\W/g, '_')}`;
  const pieceInfo = pdfDoc.catalog.get(PDFName.of('PieceInfo')) as PDFDict | undefined;
  if (pieceInfo) {
    const appDict = (pieceInfo as any).get(PDFName.of(oldMetaKey));
    if (appDict) {
      (pieceInfo as any).set(PDFName.of(newMetaKey), appDict);
      (pieceInfo as any).delete(PDFName.of(oldMetaKey));
    }
  }

  // ── Update XObject names on pages (cosmetic — viewers don't care) ─────────
  // The XObject key names are internal only; the visible tie is through OCG ref.
  // No need to rename them — they still reference the same OCG ref.

  return pdfDoc.save();
}

// ─── Public: List all OCG layers in a PDF ────────────────────────────────────

export async function listOcgLayers(pdfBytes: ArrayBuffer): Promise<OcgLayerInfo[]> {
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const ocProps = pdfDoc.catalog.get(PDFName.of('OCProperties')) as PDFDict | undefined;
    if (!ocProps) return [];

    const ocgsArray = ocProps.get(PDFName.of('OCGs'));
    if (!(ocgsArray instanceof PDFArray)) return [];

    // Collect the refs that are in the ON / OFF arrays
    const dDict = ocProps.get(PDFName.of('D')) as PDFDict | undefined;
    const offRefs = new Set<number>();
    if (dDict) {
      const offArray = dDict.get(PDFName.of('OFF'));
      if (offArray instanceof PDFArray) {
        for (let i = 0; i < offArray.size(); i++) {
          const r = offArray.get(i);
          if (r instanceof PDFRef) offRefs.add(r.objectNumber);
        }
      }
    }

    const layers: OcgLayerInfo[] = [];
    for (let i = 0; i < ocgsArray.size(); i++) {
      const ref = ocgsArray.get(i);
      if (!(ref instanceof PDFRef)) continue;
      const dict = pdfDoc.context.lookup(ref);
      if (!(dict instanceof PDFDict)) continue;
      const nameObj = dict.get(PDFName.of('Name'));
      if (!(nameObj instanceof PDFString)) continue;
      layers.push({
        name: nameObj.decodeText(),
        visible: !offRefs.has(ref.objectNumber),
      });
    }
    return layers;
  } catch {
    return [];
  }
}

// ─── Public: Toggle a named OCG layer on or off ──────────────────────────────

export async function toggleOcgLayer(pdfBytes: ArrayBuffer, layerNameToToggle: string, visible: boolean): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const ocgRef = findOcgRef(pdfDoc, layerNameToToggle);
  if (!ocgRef) return pdfDoc.save();

  const ocProps = pdfDoc.catalog.get(PDFName.of('OCProperties')) as PDFDict | undefined;
  if (!ocProps) return pdfDoc.save();

  const dDict = ocProps.get(PDFName.of('D')) as PDFDict | undefined;
  if (!dDict) return pdfDoc.save();

  const ctx = pdfDoc.context;

  // Ensure ON and OFF arrays exist
  let onArray = dDict.get(PDFName.of('ON')) as PDFArray | undefined;
  let offArray = dDict.get(PDFName.of('OFF')) as PDFArray | undefined;
  if (!onArray) {
    onArray = ctx.obj([]) as unknown as PDFArray;
    dDict.set(PDFName.of('ON'), onArray);
  }
  if (!offArray) {
    offArray = ctx.obj([]) as unknown as PDFArray;
    dDict.set(PDFName.of('OFF'), offArray);
  }

  if (visible) {
    // Move from OFF → ON
    removeRefFromArray(offArray, ocgRef);
    if (!arrayContainsRef(onArray, ocgRef)) onArray.push(ocgRef);
  } else {
    // Move from ON → OFF
    removeRefFromArray(onArray, ocgRef);
    if (!arrayContainsRef(offArray, ocgRef)) offArray.push(ocgRef);
  }

  return pdfDoc.save();
}

// ─── Internal: find an OCG ref by name ───────────────────────────────────────

function findOcgRef(pdfDoc: PDFDocument, name: string): PDFRef | null {
  const ocProps = pdfDoc.catalog.get(PDFName.of('OCProperties')) as PDFDict | undefined;
  if (!ocProps) return null;
  const ocgs = ocProps.get(PDFName.of('OCGs'));
  if (!(ocgs instanceof PDFArray)) return null;

  for (let i = 0; i < ocgs.size(); i++) {
    const ref = ocgs.get(i);
    if (!(ref instanceof PDFRef)) continue;
    const dict = pdfDoc.context.lookup(ref);
    if (!(dict instanceof PDFDict)) continue;
    const nameObj = dict.get(PDFName.of('Name'));
    if (nameObj instanceof PDFString && nameObj.decodeText() === name) {
      return ref;
    }
  }
  return null;
}

// ─── Internal: remove a layer and its content from a PDFDocument ─────────────

function removeLayerInternal(pdfDoc: PDFDocument, name: string): void {
  const ocgRef = findOcgRef(pdfDoc, name);
  if (!ocgRef) return;

  const ctx = pdfDoc.context;

  // Remove from OCProperties arrays
  const ocProps = pdfDoc.catalog.get(PDFName.of('OCProperties')) as PDFDict;
  for (const arrayName of ['OCGs', 'ON', 'OFF', 'Order'] as const) {
    let arr: PDFArray | undefined;
    if (arrayName === 'OCGs') {
      arr = ocProps.get(PDFName.of('OCGs')) as PDFArray | undefined;
    } else {
      const dDict = ocProps.get(PDFName.of('D')) as PDFDict | undefined;
      if (dDict) arr = dDict.get(PDFName.of(arrayName)) as PDFArray | undefined;
    }
    if (arr instanceof PDFArray) {
      removeRefFromArray(arr, ocgRef);
    }
  }

  // Remove Form XObjects that reference this OCG from each page
  const pages = pdfDoc.getPages();
  for (const page of pages) {
    const resources = page.node.Resources();
    if (!resources) continue;
    const xobjectRaw = resources.get(PDFName.of('XObject'));
    if (!xobjectRaw) continue;
    const xobjectDict = (xobjectRaw instanceof PDFRef ? ctx.lookup(xobjectRaw) : xobjectRaw) as PDFDict | undefined;
    if (!(xobjectDict instanceof PDFDict)) continue;

    const keysToRemove: PDFName[] = [];
    const entries = (xobjectDict as any).entries?.() ?? [];
    for (const [key, value] of entries) {
      if (!(key instanceof PDFName)) continue;
      const resolved = value instanceof PDFRef ? ctx.lookup(value) : value;
      // Form XObjects are PDFStream (extends PDFDict), also check plain PDFDict
      if (resolved instanceof PDFDict || resolved instanceof PDFStream) {
        const dict = resolved instanceof PDFStream ? resolved.dict : resolved;
        const oc = dict.get(PDFName.of('OC'));
        if (oc instanceof PDFRef && oc.objectNumber === ocgRef.objectNumber) {
          keysToRemove.push(key);
        }
      }
    }

    for (const key of keysToRemove) {
      (xobjectDict as any).delete(key);
      // Also remove the corresponding "Do" operator from page content streams
      // Note: pdf-lib doesn't provide an easy way to modify existing content streams,
      // but the orphaned "Do" reference to a deleted XObject is harmless — viewers
      // simply skip it. The visual content is gone because the form XObject is removed.
    }
  }
}

function removeRefFromArray(arr: PDFArray, ref: PDFRef): void {
  // Build a list of indices to remove (reverse order to preserve indices)
  const toRemove: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const item = arr.get(i);
    if (item instanceof PDFRef && item.objectNumber === ref.objectNumber) {
      toRemove.push(i);
    }
  }
  for (const idx of toRemove.reverse()) {
    arr.remove(idx);
  }
}

function arrayContainsRef(arr: PDFArray, ref: PDFRef): boolean {
  for (let i = 0; i < arr.size(); i++) {
    const item = arr.get(i);
    if (item instanceof PDFRef && item.objectNumber === ref.objectNumber) {
      return true;
    }
  }
  return false;
}

// ─── Public: Strip all annotation OCG layer content for clean display ─────────

/**
 * Create a "clean" copy of the PDF with all annotation Form XObjects (`AnnotLayer_*`)
 * removed from every page's resources, and the corresponding OCG entries removed from
 * the catalog's `OCProperties`.
 *
 * Unlike `toggleOcgLayer` (which merely moves refs between ON/OFF arrays but leaves
 * the Form XObjects and `/OC` references intact), this function **physically removes**
 * the content so pdfjs never encounters unknown OCG group references — eliminating
 * the "Optional content group not found: NNR" warning entirely.
 *
 * This is intended **only** for generating a display-copy while annotation canvases
 * are overlaid. The returned bytes should NOT be persisted.
 *
 * @note Non-annotation OCG content (e.g. layers from external PDF editors) is preserved.
 */
export async function stripOcgLayerContent(pdfBytes: ArrayBuffer): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const ctx = pdfDoc.context;

  // Collect all OCG refs that belong to our annotation layers (matched by XObject name prefix)
  const annotOcgRefs = new Set<number>();
  const pages = pdfDoc.getPages();

  for (const page of pages) {
    const resources = page.node.Resources();
    if (!resources) continue;
    const xobjectRaw = resources.get(PDFName.of('XObject'));
    if (!xobjectRaw) continue;
    const xobjectDict = (xobjectRaw instanceof PDFRef ? ctx.lookup(xobjectRaw) : xobjectRaw) as PDFDict | undefined;
    if (!(xobjectDict instanceof PDFDict)) continue;

    const keysToRemove: PDFName[] = [];
    const entries = (xobjectDict as any).entries?.() ?? [];
    for (const [key, value] of entries) {
      if (!(key instanceof PDFName)) continue;
      // Only target our annotation XObjects (named `AnnotLayer_…`)
      if (!key.decodeText().startsWith('AnnotLayer_')) continue;

      const resolved = value instanceof PDFRef ? ctx.lookup(value) : value;
      if (resolved instanceof PDFDict || resolved instanceof PDFStream) {
        const dict = resolved instanceof PDFStream ? resolved.dict : resolved;
        const oc = dict.get(PDFName.of('OC'));
        if (oc instanceof PDFRef) {
          annotOcgRefs.add(oc.objectNumber);
        }
      }
      keysToRemove.push(key);
    }

    for (const key of keysToRemove) {
      (xobjectDict as any).delete(key);
    }
  }

  // Remove the collected OCG refs from OCProperties
  if (annotOcgRefs.size > 0) {
    const ocProps = pdfDoc.catalog.get(PDFName.of('OCProperties')) as PDFDict | undefined;
    if (ocProps) {
      for (const arrayName of ['OCGs'] as const) {
        const arr = ocProps.get(PDFName.of(arrayName)) as PDFArray | undefined;
        if (arr instanceof PDFArray) {
          removeRefsFromArrayByObjectNumbers(arr, annotOcgRefs);
        }
      }
      const dDict = ocProps.get(PDFName.of('D')) as PDFDict | undefined;
      if (dDict) {
        for (const arrayName of ['ON', 'OFF', 'Order'] as const) {
          const arr = dDict.get(PDFName.of(arrayName)) as PDFArray | undefined;
          if (arr instanceof PDFArray) {
            removeRefsFromArrayByObjectNumbers(arr, annotOcgRefs);
          }
        }
      }
    }
  }

  return pdfDoc.save();
}

/** Remove all PDFRef entries whose objectNumber is in the given set. */
function removeRefsFromArrayByObjectNumbers(arr: PDFArray, objectNumbers: Set<number>): void {
  const toRemove: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const item = arr.get(i);
    if (item instanceof PDFRef && objectNumbers.has(item.objectNumber)) {
      toRemove.push(i);
    }
  }
  for (const idx of toRemove.reverse()) {
    arr.remove(idx);
  }
}
