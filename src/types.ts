export type SourcePdf = {
  id: string;
  kind: "pdf";
  name: string;
  size: number;
  arrayBuffer: ArrayBuffer;
  pageCount: number;
};

export type PageSize = {
  width: number;
  height: number;
};

export type ImagePlacement = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SourceImage = {
  id: string;
  kind: "image";
  name: string;
  size: number;
  arrayBuffer: ArrayBuffer;
  mimeType: "image/jpeg" | "image/png";
  objectUrl: string;
  imageSize: PageSize;
  pageSize: PageSize;
  placement: ImagePlacement;
  pageCount: 1;
};

export type SourceFile = SourcePdf | SourceImage;

export type SelectedPage = {
  id: string;
  sourceFileId: string;
  sourceFileName: string;
  sourceKind: SourceFile["kind"];
  pageIndex: number;
  pageNumber: number;
};

export type PdfError = {
  id: string;
  message: string;
};
