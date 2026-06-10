import { PDFDocument } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { SelectedPage, SourcePdf } from "./types";

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

export async function buildMergedPdf(
  sourcePdfs: SourcePdf[],
  selectedPages: SelectedPage[],
) {
  const outputPdf = await PDFDocument.create();
  const sourceDocs = new Map<string, PDFDocument>();

  for (const source of sourcePdfs) {
    const doc = await PDFDocument.load(source.arrayBuffer.slice(0), {
      ignoreEncryption: true,
    });
    sourceDocs.set(source.id, doc);
  }

  for (const selected of selectedPages) {
    const sourceDoc = sourceDocs.get(selected.sourcePdfId);
    if (!sourceDoc) continue;
    const [page] = await outputPdf.copyPages(sourceDoc, [selected.pageIndex]);
    outputPdf.addPage(page);
  }

  const bytes = await outputPdf.save();
  return new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" });
}
