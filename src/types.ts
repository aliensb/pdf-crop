export type SourcePdf = {
  id: string;
  name: string;
  size: number;
  arrayBuffer: ArrayBuffer;
  pageCount: number;
};

export type SelectedPage = {
  id: string;
  sourcePdfId: string;
  sourcePdfName: string;
  pageIndex: number;
  pageNumber: number;
};

export type PdfError = {
  id: string;
  message: string;
};
