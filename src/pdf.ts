import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ImageCrop, SelectedPage, SourceFile, SourceImage, SourcePdf } from "./types";

const DEFAULT_COMPRESS_MAX_EDGE = 1600;
const DEFAULT_COMPRESS_QUALITY = 0.72;

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

export async function getPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.mjs",
        import.meta.url,
      ).toString();
      return pdfjs;
    });
  }

  return pdfjsPromise;
}

export async function getPageCount(arrayBuffer: ArrayBuffer) {
  const pdfjs = await getPdfJs();
  const document = await pdfjs.getDocument({ data: arrayBuffer.slice(0) }).promise;
  const count = document.numPages;
  await document.destroy();
  return count;
}

export async function loadPreviewDocument(source: SourcePdf): Promise<PDFDocumentProxy> {
  const pdfjs = await getPdfJs();
  return pdfjs.getDocument({ data: source.arrayBuffer.slice(0) }).promise;
}

async function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas export failed"));
    }, type, quality);
  });
}

export async function compressImagePdf(
  source: SourcePdf,
  options: { maxEdge?: number; quality?: number } = {},
) {
  const maxEdge = options.maxEdge ?? DEFAULT_COMPRESS_MAX_EDGE;
  const quality = options.quality ?? DEFAULT_COMPRESS_QUALITY;
  const pdfjs = await getPdfJs();
  const sourceDoc = await pdfjs.getDocument({ data: source.arrayBuffer.slice(0) }).promise;
  const outputPdf = await PDFDocument.create();

  try {
    for (let pageNumber = 1; pageNumber <= sourceDoc.numPages; pageNumber += 1) {
      const sourcePage = await sourceDoc.getPage(pageNumber);
      const baseViewport = sourcePage.getViewport({ scale: 1 });
      const renderScale = Math.min(2, maxEdge / Math.max(baseViewport.width, baseViewport.height));
      const viewport = sourcePage.getViewport({ scale: renderScale });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas unavailable");

      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await sourcePage.render({ canvasContext: context, viewport }).promise;

      const imageBlob = await canvasToBlob(canvas, "image/jpeg", quality);
      const image = await outputPdf.embedJpg(await imageBlob.arrayBuffer());
      const outputPage = outputPdf.addPage([baseViewport.width, baseViewport.height]);
      outputPage.drawImage(image, {
        x: 0,
        y: 0,
        width: baseViewport.width,
        height: baseViewport.height,
      });
      sourcePage.cleanup();
    }
  } finally {
    await sourceDoc.destroy();
  }

  const bytes = await outputPdf.save();
  return new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" });
}

function isFullCrop(source: SourceImage) {
  return (
    source.crop.x === 0 &&
    source.crop.y === 0 &&
    source.crop.width === source.imageSize.width &&
    source.crop.height === source.imageSize.height
  );
}

function parseHexColor(value: string) {
  const hex = value.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return rgb(0, 0, 0);
  const red = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const green = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(hex.slice(4, 6), 16) / 255;
  return rgb(red, green, blue);
}

async function createCroppedImage(source: SourceImage): Promise<{ bytes: ArrayBuffer; mimeType: "image/jpeg" | "image/png" }> {
  if (isFullCrop(source)) {
    return { bytes: source.arrayBuffer.slice(0), mimeType: source.mimeType };
  }

  const crop = clampCrop(source.crop, source.imageSize.width, source.imageSize.height);
  const bitmap = await createImageBitmap(new Blob([source.arrayBuffer.slice(0)], { type: source.mimeType }));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.width));
  canvas.height = Math.max(1, Math.round(crop.height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");

  context.drawImage(
    bitmap,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  bitmap.close();

  const blob = await canvasToBlob(canvas, "image/png");

  return { bytes: await blob.arrayBuffer(), mimeType: "image/png" };
}

function clampCrop(crop: ImageCrop, width: number, height: number): ImageCrop {
  const x = Math.min(Math.max(0, crop.x), width - 1);
  const y = Math.min(Math.max(0, crop.y), height - 1);
  return {
    x,
    y,
    width: Math.min(Math.max(1, crop.width), width - x),
    height: Math.min(Math.max(1, crop.height), height - y),
  };
}

export async function buildMergedPdf(
  sourceFiles: SourceFile[],
  selectedPages: SelectedPage[],
) {
  const outputPdf = await PDFDocument.create();
  const sourceDocs = new Map<string, PDFDocument>();
  const sourcesById = new Map(sourceFiles.map((source) => [source.id, source]));
  const textFonts = {
    Helvetica: await outputPdf.embedFont(StandardFonts.Helvetica),
    TimesRoman: await outputPdf.embedFont(StandardFonts.TimesRoman),
    Courier: await outputPdf.embedFont(StandardFonts.Courier),
  };

  for (const source of sourceFiles) {
    if (source.kind !== "pdf") continue;
    const doc = await PDFDocument.load(source.arrayBuffer.slice(0), {
      ignoreEncryption: true,
    });
    sourceDocs.set(source.id, doc);
  }

  for (const selected of selectedPages) {
    const source = sourcesById.get(selected.sourceFileId);
    if (!source) continue;

    if (source.kind === "pdf") {
      const sourceDoc = sourceDocs.get(source.id);
      if (!sourceDoc) continue;
      const [page] = await outputPdf.copyPages(sourceDoc, [selected.pageIndex]);
      outputPdf.addPage(page);
      continue;
    }

    const cropped = await createCroppedImage(source);
    const image =
      cropped.mimeType === "image/png"
        ? await outputPdf.embedPng(cropped.bytes)
        : await outputPdf.embedJpg(cropped.bytes);
    const page = outputPdf.addPage([source.pageSize.width, source.pageSize.height]);

    page.drawImage(image, {
      x: source.placement.x,
      y: source.placement.y,
      width: source.placement.width,
      height: source.placement.height,
    });

    source.texts.forEach((item) => {
      item.text.split("\n").forEach((line, index) => {
        page.drawText(line, {
          x: item.x,
          y: item.y - index * item.fontSize * 1.25,
          size: item.fontSize,
          font: textFonts[item.fontFamily],
          color: parseHexColor(item.color),
        });
      });
    });
  }

  const bytes = await outputPdf.save();
  return new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" });
}
