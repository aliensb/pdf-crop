import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Download,
  Edit3,
  Eye,
  FilePlus2,
  GripVertical,
  Loader2,
  RotateCcw,
  Trash2,
  Type,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { buildMergedPdf, getPageCount, loadPreviewDocument } from "./pdf";
import type {
  ImageCrop,
  ImagePlacement,
  ImageTextBox,
  PageSize,
  PdfError,
  SelectedPage,
  SourceFile,
  SourceImage,
  SourcePdf,
} from "./types";

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_TOTAL_SIZE = 200 * 1024 * 1024;
const MAX_TOTAL_PAGES = 300;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const A4_PORTRAIT: PageSize = { width: 595.28, height: 841.89 };
const A4_LANDSCAPE: PageSize = { width: 841.89, height: 595.28 };

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isPdfFile(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function isImageFile(file: File) {
  const name = file.name.toLowerCase();
  return IMAGE_TYPES.has(file.type) || /\.(jpe?g|png|webp)$/.test(name);
}

function createFitPlacement(imageSize: PageSize, pageSize: PageSize): ImagePlacement {
  const scale = Math.min(pageSize.width / imageSize.width, pageSize.height / imageSize.height);
  const width = imageSize.width * scale;
  const height = imageSize.height * scale;

  return {
    x: (pageSize.width - width) / 2,
    y: (pageSize.height - height) / 2,
    width,
    height,
  };
}

async function prepareImageFile(
  file: File,
  arrayBuffer: ArrayBuffer,
): Promise<Pick<SourceImage, "arrayBuffer" | "mimeType" | "objectUrl" | "imageSize" | "pageSize" | "placement" | "crop" | "texts">> {
  const sourceType = file.type || (file.name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");

  if (sourceType === "image/jpeg" || sourceType === "image/png") {
    const mimeType = sourceType;
    const blob = new Blob([arrayBuffer.slice(0)], { type: mimeType });
    const bitmap = await createImageBitmap(blob);
    const imageSize = { width: bitmap.width, height: bitmap.height };
    const pageSize = imageSize.width >= imageSize.height ? A4_LANDSCAPE : A4_PORTRAIT;
    bitmap.close();

    return {
      arrayBuffer,
      mimeType,
      objectUrl: URL.createObjectURL(blob),
      imageSize,
      pageSize,
      placement: createFitPlacement(imageSize, pageSize),
      crop: { x: 0, y: 0, width: imageSize.width, height: imageSize.height },
      texts: [],
    };
  }

  const bitmap = await createImageBitmap(new Blob([arrayBuffer.slice(0)], { type: sourceType }));
  const imageSize = { width: bitmap.width, height: bitmap.height };
  const pageSize = imageSize.width >= imageSize.height ? A4_LANDSCAPE : A4_PORTRAIT;
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((nextBlob) => {
      if (nextBlob) resolve(nextBlob);
      else reject(new Error("Image conversion failed"));
    }, "image/jpeg", 0.92);
  });

  const convertedBuffer = await blob.arrayBuffer();
  return {
    arrayBuffer: convertedBuffer,
    mimeType: "image/jpeg",
    objectUrl: URL.createObjectURL(blob),
    imageSize,
    pageSize,
    placement: createFitPlacement(imageSize, pageSize),
    crop: { x: 0, y: 0, width: imageSize.width, height: imageSize.height },
    texts: [],
  };
}

export function App() {
  const [sourceFiles, setSourceFiles] = useState<SourceFile[]>([]);
  const [selectedPages, setSelectedPages] = useState<SelectedPage[]>([]);
  const [errors, setErrors] = useState<PdfError[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [isBuilding, setIsBuilding] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [editingImageId, setEditingImageId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sourceFilesRef = useRef<SourceFile[]>([]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const totalSize = sourceFiles.reduce((sum, file) => sum + file.size, 0);
  const totalPages = sourceFiles.reduce((sum, file) => sum + file.pageCount, 0);
  const editingImage = sourceFiles.find(
    (source): source is SourceImage => source.id === editingImageId && source.kind === "image",
  );
  const canBuild = selectedPages.length > 0 && !isBuilding;

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    sourceFilesRef.current = sourceFiles;
  }, [sourceFiles]);

  useEffect(() => {
    return () => {
      sourceFilesRef.current.forEach((source) => {
        if (source.kind === "image") URL.revokeObjectURL(source.objectUrl);
      });
    };
  }, []);

  async function importFiles(fileList: FileList | null) {
    if (!fileList?.length) return;
    setIsImporting(true);
    setErrors([]);

    const incoming = Array.from(fileList).filter((file) => {
      if (isPdfFile(file) || isImageFile(file)) return true;
      setErrors((current) => [
        ...current,
        { id: createId("error"), message: `${file.name} 不是支持的 PDF 或图片文件。` },
      ]);
      return false;
    });

    const loaded: SourceFile[] = [];

    for (const file of incoming) {
      if (file.size > MAX_FILE_SIZE) {
        setErrors((current) => [
          ...current,
          { id: createId("error"), message: `${file.name} 超过 50MB，已跳过。` },
        ]);
        continue;
      }

      if (totalSize + loaded.reduce((sum, item) => sum + item.size, 0) + file.size > MAX_TOTAL_SIZE) {
        setErrors((current) => [
          ...current,
          { id: createId("error"), message: `总文件大小超过 200MB，${file.name} 已跳过。` },
        ]);
        continue;
      }

      try {
        const arrayBuffer = await file.arrayBuffer();
        const pageCount = isPdfFile(file) ? await getPageCount(arrayBuffer) : 1;

        if (totalPages + loaded.reduce((sum, item) => sum + item.pageCount, 0) + pageCount > MAX_TOTAL_PAGES) {
          setErrors((current) => [
            ...current,
            { id: createId("error"), message: `总页数超过 300 页，${file.name} 已跳过。` },
          ]);
          continue;
        }

        if (isPdfFile(file)) {
          loaded.push({
            id: createId("pdf"),
            kind: "pdf",
            name: file.name,
            size: file.size,
            arrayBuffer,
            pageCount,
          });
        } else {
          const image = await prepareImageFile(file, arrayBuffer);
          loaded.push({
            id: createId("image"),
            kind: "image",
            name: file.name,
            size: file.size,
            pageCount: 1,
            ...image,
          });
        }
      } catch {
        setErrors((current) => [
          ...current,
          { id: createId("error"), message: `${file.name} 无法读取，可能已加密、损坏或图片格式不受浏览器支持。` },
        ]);
      }
    }

    if (loaded.length) {
      setSourceFiles((current) => [...current, ...loaded]);
      clearPreview();
    }

    setIsImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function togglePage(source: SourceFile, pageIndex: number) {
    setSelectedPages((current) => {
      const existing = current.find(
        (page) => page.sourceFileId === source.id && page.pageIndex === pageIndex,
      );

      if (existing) return current.filter((page) => page.id !== existing.id);

      return [
        ...current,
        {
          id: createId("page"),
          sourceFileId: source.id,
          sourceFileName: source.name,
          sourceKind: source.kind,
          pageIndex,
          pageNumber: pageIndex + 1,
        },
      ];
    });
    clearPreview();
  }

  function removeSourceFile(sourceId: string) {
    if (editingImageId === sourceId) setEditingImageId(null);
    setSourceFiles((current) => {
      const removed = current.find((source) => source.id === sourceId);
      if (removed?.kind === "image") URL.revokeObjectURL(removed.objectUrl);
      return current.filter((source) => source.id !== sourceId);
    });
    setSelectedPages((current) => current.filter((page) => page.sourceFileId !== sourceId));
    clearPreview();
  }

  function removeSelectedPage(pageId: string) {
    setSelectedPages((current) => current.filter((page) => page.id !== pageId));
    clearPreview();
  }

  function updateImageSource(sourceId: string, getSource: (source: SourceImage) => SourceImage) {
    setSourceFiles((current) =>
      current.map((source) =>
        source.id === sourceId && source.kind === "image"
          ? getSource(source)
          : source,
      ),
    );
    clearPreview();
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    setSelectedPages((items) => {
      const oldIndex = items.findIndex((item) => item.id === active.id);
      const newIndex = items.findIndex((item) => item.id === over.id);
      return arrayMove(items, oldIndex, newIndex);
    });
    clearPreview();
  }

  async function createPreview() {
    if (!canBuild) return;
    setIsBuilding(true);
    setErrors([]);

    try {
      const blob = await buildMergedPdf(sourceFiles, selectedPages);
      const url = URL.createObjectURL(blob);
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return url;
      });
    } catch {
      setErrors([{ id: createId("error"), message: "生成 PDF 失败，请检查是否包含受保护页面。" }]);
    } finally {
      setIsBuilding(false);
    }
  }

  function clearPreview() {
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  }

  function clearAll() {
    sourceFiles.forEach((source) => {
      if (source.kind === "image") URL.revokeObjectURL(source.objectUrl);
    });
    setSourceFiles([]);
    setSelectedPages([]);
    setErrors([]);
    setEditingImageId(null);
    clearPreview();
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <h1>PDF 拼接工具</h1>
          <p>上传多个 PDF 或图片，按勾选顺序组合页面，并在导出前调整顺序。</p>
        </div>
        <div className="toolbar">
          <input
            ref={fileInputRef}
            className="hidden-input"
            type="file"
            accept="application/pdf,.pdf,image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            multiple
            onChange={(event) => importFiles(event.target.files)}
          />
          <button className="primary-button" onClick={() => fileInputRef.current?.click()} disabled={isImporting}>
            {isImporting ? <Loader2 className="spin" size={18} /> : <Upload size={18} />}
            上传文件
          </button>
          <button onClick={clearAll} disabled={!sourceFiles.length && !selectedPages.length}>
            <RotateCcw size={18} />
            清空
          </button>
          <button onClick={createPreview} disabled={!canBuild}>
            {isBuilding ? <Loader2 className="spin" size={18} /> : <Eye size={18} />}
            预览新 PDF
          </button>
          <a className={!previewUrl ? "button-link disabled" : "button-link"} href={previewUrl ?? undefined} download="merged.pdf">
            <Download size={18} />
            下载
          </a>
        </div>
      </header>

      {errors.length > 0 && (
        <section className="error-list" aria-live="polite">
          {errors.map((error) => (
            <div key={error.id}>{error.message}</div>
          ))}
        </section>
      )}

      <section className="workspace">
        <aside className="panel file-panel">
          <div className="panel-heading">
            <h2>文件</h2>
            <span>{sourceFiles.length} 个文件</span>
          </div>

          {sourceFiles.length === 0 ? (
            <button className="empty-upload" onClick={() => fileInputRef.current?.click()}>
              <FilePlus2 size={30} />
              <span>选择 PDF 或图片</span>
            </button>
          ) : (
            <div className="file-list">
              {sourceFiles.map((source) => (
                <div className="file-item" key={source.id}>
                  <div>
                    <strong>{source.name}</strong>
                    <span>
                      {source.kind === "pdf" ? `${source.pageCount} 页` : "图片 1 页"} · {formatSize(source.size)}
                    </span>
                  </div>
                  <button aria-label={`移除 ${source.name}`} onClick={() => removeSourceFile(source.id)}>
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="stats">
            <span>总大小 {formatSize(totalSize)}</span>
            <span>总页数 {totalPages}/{MAX_TOTAL_PAGES}</span>
            <span>已选 {selectedPages.length} 页</span>
          </div>
        </aside>

        <section className="panel source-panel">
          <div className="panel-heading">
            <h2>原始页面</h2>
            <span>勾选顺序会进入右侧列表</span>
          </div>
          <div className="source-scroll">
            {sourceFiles.length === 0 ? (
              <EmptyState title="等待上传" text="添加 PDF 或图片后，这里会显示每一页的缩略图。" />
            ) : (
              sourceFiles.map((source) =>
                source.kind === "pdf" ? (
                  <PdfPageGrid
                    key={source.id}
                    source={source}
                    selectedPages={selectedPages}
                    onTogglePage={togglePage}
                  />
                ) : (
                  <ImagePageGrid
                    key={source.id}
                    source={source}
                    selectedPages={selectedPages}
                    onTogglePage={togglePage}
                    onEdit={() => setEditingImageId(source.id)}
                  />
                ),
              )
            )}
          </div>
        </section>

        <aside className="panel output-panel">
          <div className="panel-heading">
            <h2>新 PDF</h2>
            <span>{selectedPages.length} 页</span>
          </div>

          {selectedPages.length === 0 ? (
            <EmptyState title="未选择页面" text="从中间预览区勾选页面后，会按点击顺序显示在这里。" />
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={selectedPages.map((page) => page.id)} strategy={verticalListSortingStrategy}>
                <div className="selected-list">
                  {selectedPages.map((page, index) => (
                    <SortableSelectedPage
                      key={page.id}
                      page={page}
                      index={index}
                      onRemove={() => removeSelectedPage(page.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </aside>
      </section>

      {previewUrl && (
        <section className="preview-panel">
          <div className="panel-heading">
            <h2>生成预览</h2>
            <span>确认后可下载 merged.pdf</span>
          </div>
          <iframe src={previewUrl} title="新 PDF 预览" />
        </section>
      )}

      {editingImage && (
        <ImageEditorModal
          source={editingImage}
          selectedPages={selectedPages}
          onClose={() => setEditingImageId(null)}
          onTogglePage={() => togglePage(editingImage, 0)}
          onUpdate={(getSource) => updateImageSource(editingImage.id, getSource)}
        />
      )}
    </main>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

function PdfPageGrid({
  source,
  selectedPages,
  onTogglePage,
}: {
  source: SourcePdf;
  selectedPages: SelectedPage[];
  onTogglePage: (source: SourcePdf, pageIndex: number) => void;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    loadPreviewDocument(source)
      .then((nextDoc) => {
        if (cancelled) {
          void nextDoc.destroy();
          return;
        }
        setDoc(nextDoc);
      })
      .catch(() => setFailed(true));

    return () => {
      cancelled = true;
      setDoc((current) => {
        if (current) void current.destroy();
        return null;
      });
    };
  }, [source]);

  const selectedByPage = useMemo(() => {
    const map = new Map<number, number>();
    selectedPages.forEach((page, index) => {
      if (page.sourceFileId === source.id) map.set(page.pageIndex, index + 1);
    });
    return map;
  }, [selectedPages, source.id]);

  return (
    <section className="pdf-group">
      <div className="pdf-group-title">
        <strong>{source.name}</strong>
        <span>{source.pageCount} 页</span>
      </div>
      {failed ? (
        <div className="inline-error">无法预览这个 PDF。</div>
      ) : (
        <div className="page-grid">
          {Array.from({ length: source.pageCount }, (_, pageIndex) => (
            <PageThumb
              key={pageIndex}
              doc={doc}
              pageIndex={pageIndex}
              selectedOrder={selectedByPage.get(pageIndex)}
              onToggle={() => onTogglePage(source, pageIndex)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ImagePageGrid({
  source,
  selectedPages,
  onTogglePage,
  onEdit,
}: {
  source: SourceImage;
  selectedPages: SelectedPage[];
  onTogglePage: (source: SourceImage, pageIndex: number) => void;
  onEdit: () => void;
}) {
  const selectedOrder = useMemo(() => {
    const index = selectedPages.findIndex((page) => page.sourceFileId === source.id);
    return index === -1 ? undefined : index + 1;
  }, [selectedPages, source.id]);

  return (
    <section className="pdf-group">
      <div className="pdf-group-title">
        <strong>{source.name}</strong>
        <span>图片 1 页</span>
      </div>
      <div className="page-grid">
        <div className={selectedOrder ? "page-thumb selected image-card" : "page-thumb image-card"}>
          <div className="thumb-canvas image-thumb">
            <div
              className="mini-image-page"
              style={{ aspectRatio: `${source.pageSize.width} / ${source.pageSize.height}` }}
            >
              <ImageCanvasPreview source={source} compact />
            </div>
          </div>
          <div className="thumb-meta">
            <span>图片页</span>
            {selectedOrder && <strong>#{selectedOrder}</strong>}
          </div>
          <div className="image-card-actions">
            <button onClick={() => onTogglePage(source, 0)}>{selectedOrder ? "移出" : "加入"}</button>
            <button onClick={onEdit}>
              <Edit3 size={15} />
              编辑
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ImageEditorModal({
  source,
  selectedPages,
  onClose,
  onTogglePage,
  onUpdate,
}: {
  source: SourceImage;
  selectedPages: SelectedPage[];
  onClose: () => void;
  onTogglePage: () => void;
  onUpdate: (getSource: (source: SourceImage) => SourceImage) => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<
    | {
        kind: "image";
        pointerId: number;
        startX: number;
        startY: number;
        placement: ImagePlacement;
      }
    | {
        kind: "text";
        pointerId: number;
        textId: string;
        startX: number;
        startY: number;
        x: number;
        y: number;
      }
    | null
  >(null);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(source.texts[0]?.id ?? null);
  const selectedText = source.texts.find((text) => text.id === selectedTextId) ?? null;
  const selectedOrder = useMemo(() => {
    const index = selectedPages.findIndex((page) => page.sourceFileId === source.id);
    return index === -1 ? undefined : index + 1;
  }, [selectedPages, source.id]);
  const fitPlacement = useMemo(
    () => createFitPlacement(source.imageSize, source.pageSize),
    [source.imageSize, source.pageSize],
  );
  const zoom = Math.round((source.placement.width / fitPlacement.width) * 100);

  function updateSource(getSource: (source: SourceImage) => SourceImage) {
    onUpdate(getSource);
  }

  function setPlacement(placement: ImagePlacement) {
    updateSource((current) => ({ ...current, placement }));
  }

  function setCrop(crop: ImageCrop) {
    updateSource((current) => ({ ...current, crop: clampCrop(crop, current.imageSize) }));
  }

  function resizeFromZoom(nextZoom: number) {
    updateSource((current) => {
      const nextWidth = fitPlacement.width * (nextZoom / 100);
      const nextHeight = fitPlacement.height * (nextZoom / 100);
      const centerX = current.placement.x + current.placement.width / 2;
      const centerY = current.placement.y + current.placement.height / 2;

      return {
        ...current,
        placement: {
          x: centerX - nextWidth / 2,
          y: centerY - nextHeight / 2,
          width: nextWidth,
          height: nextHeight,
        },
      };
    });
  }

  function applyPreset(preset: "fit" | "fill" | "center" | "top" | "bottom" | "left" | "right") {
    if (preset === "fit") {
      setPlacement(fitPlacement);
      return;
    }

    updateSource((current) => {
      const placement = current.placement;
      const page = current.pageSize;

      if (preset === "fill") {
        const scale = Math.max(page.width / current.imageSize.width, page.height / current.imageSize.height);
        const width = current.imageSize.width * scale;
        const height = current.imageSize.height * scale;
        return {
          ...current,
          placement: {
            x: (page.width - width) / 2,
            y: (page.height - height) / 2,
            width,
            height,
          },
        };
      }

      const next = { ...placement };
      if (preset === "center") {
        next.x = (page.width - placement.width) / 2;
        next.y = (page.height - placement.height) / 2;
      }
      if (preset === "top") next.y = page.height - placement.height;
      if (preset === "bottom") next.y = 0;
      if (preset === "left") next.x = 0;
      if (preset === "right") next.x = page.width - placement.width;
      return { ...current, placement: next };
    });
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    dragRef.current = {
      kind: "image",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      placement: source.placement,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function dragImage(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!drag || drag.kind !== "image" || drag.pointerId !== event.pointerId || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    const dx = ((event.clientX - drag.startX) / rect.width) * source.pageSize.width;
    const dy = ((event.clientY - drag.startY) / rect.height) * source.pageSize.height;

    setPlacement({
      ...drag.placement,
      x: drag.placement.x + dx,
      y: drag.placement.y - dy,
    });
  }

  function stopDrag(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }

  function addText() {
    const id = createId("text");
    const nextText: ImageTextBox = {
      id,
      text: "文字",
      x: source.pageSize.width / 2 - 30,
      y: source.pageSize.height / 2,
      fontSize: 24,
      color: "#111827",
    };
    setSelectedTextId(id);
    updateSource((current) => ({ ...current, texts: [...current.texts, nextText] }));
  }

  function updateSelectedText(patch: Partial<ImageTextBox>) {
    if (!selectedTextId) return;
    updateSource((current) => ({
      ...current,
      texts: current.texts.map((text) => (text.id === selectedTextId ? { ...text, ...patch } : text)),
    }));
  }

  function removeSelectedText() {
    if (!selectedTextId) return;
    updateSource((current) => ({
      ...current,
      texts: current.texts.filter((text) => text.id !== selectedTextId),
    }));
    setSelectedTextId(null);
  }

  function startTextDrag(event: PointerEvent<HTMLDivElement>, text: ImageTextBox) {
    event.stopPropagation();
    event.preventDefault();
    setSelectedTextId(text.id);
    dragRef.current = {
      kind: "text",
      pointerId: event.pointerId,
      textId: text.id,
      startX: event.clientX,
      startY: event.clientY,
      x: text.x,
      y: text.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function dragText(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!drag || drag.kind !== "text" || drag.pointerId !== event.pointerId || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    const dx = ((event.clientX - drag.startX) / rect.width) * source.pageSize.width;
    const dy = ((event.clientY - drag.startY) / rect.height) * source.pageSize.height;

    updateSource((current) => ({
      ...current,
      texts: current.texts.map((text) =>
        text.id === drag.textId ? { ...text, x: drag.x + dx, y: drag.y - dy } : text,
      ),
    }));
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="image-modal">
        <div className="modal-heading">
          <div>
            <h2>{source.name}</h2>
            <span>图片页编辑</span>
          </div>
          <button onClick={onClose} aria-label="关闭编辑器">
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div className="modal-canvas-wrap">
            <div className="image-page-wrap large">
              <div
                ref={canvasRef}
                className={selectedOrder ? "image-page selected" : "image-page"}
                style={{ aspectRatio: `${source.pageSize.width} / ${source.pageSize.height}` }}
              >
                <ImageCanvasPreview
                  source={source}
                  onImagePointerDown={startDrag}
                  onImagePointerMove={dragImage}
                  onImagePointerUp={stopDrag}
                  onTextPointerDown={startTextDrag}
                  onTextPointerMove={dragText}
                  onTextPointerUp={stopDrag}
                  selectedTextId={selectedTextId}
                />
              </div>
            </div>
          </div>

          <div className="modal-controls">
            <button className={selectedOrder ? "selected-toggle active" : "selected-toggle"} onClick={onTogglePage}>
              {selectedOrder ? `已加入 #${selectedOrder}` : "加入新 PDF"}
            </button>

            <label className="zoom-control">
              <span>缩放 {zoom}%</span>
              <input
                type="range"
                min="20"
                max="400"
                value={zoom}
                onChange={(event) => resizeFromZoom(Number(event.target.value))}
              />
            </label>

            <div className="preset-grid">
              <button onClick={() => applyPreset("fit")}>适应</button>
              <button onClick={() => applyPreset("fill")}>填满</button>
              <button onClick={() => applyPreset("center")}>居中</button>
              <button onClick={() => applyPreset("top")}>置顶</button>
              <button onClick={() => applyPreset("bottom")}>置底</button>
              <button onClick={() => applyPreset("left")}>左靠齐</button>
              <button onClick={() => applyPreset("right")}>右靠齐</button>
            </div>

            <div className="control-section">
              <div className="control-title">
                <span>裁剪</span>
                <button onClick={() => setCrop({ x: 0, y: 0, width: source.imageSize.width, height: source.imageSize.height })}>重置</button>
              </div>
              <CropSlider label="左" value={source.crop.x} min={0} max={source.imageSize.width - 1} onChange={(value) => setCrop({ ...source.crop, x: value })} />
              <CropSlider label="上" value={source.crop.y} min={0} max={source.imageSize.height - 1} onChange={(value) => setCrop({ ...source.crop, y: value })} />
              <CropSlider label="宽" value={source.crop.width} min={1} max={source.imageSize.width - source.crop.x} onChange={(value) => setCrop({ ...source.crop, width: value })} />
              <CropSlider label="高" value={source.crop.height} min={1} max={source.imageSize.height - source.crop.y} onChange={(value) => setCrop({ ...source.crop, height: value })} />
            </div>

            <div className="control-section">
              <div className="control-title">
                <span>文字</span>
                <button onClick={addText}>
                  <Type size={15} />
                  添加
                </button>
              </div>
              {selectedText ? (
                <div className="text-editor-controls">
                  <textarea value={selectedText.text} onChange={(event) => updateSelectedText({ text: event.target.value })} />
                  <div className="text-control-row">
                    <label>
                      <span>字号</span>
                      <input type="number" min="8" max="120" value={selectedText.fontSize} onChange={(event) => updateSelectedText({ fontSize: Number(event.target.value) })} />
                    </label>
                    <label>
                      <span>颜色</span>
                      <input type="color" value={selectedText.color} onChange={(event) => updateSelectedText({ color: event.target.value })} />
                    </label>
                    <button onClick={removeSelectedText}>
                      <Trash2 size={15} />
                      删除
                    </button>
                  </div>
                </div>
              ) : (
                <div className="empty-mini">未选择文字</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CropSlider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const safeMax = Math.max(min, max);
  return (
    <label className="crop-slider">
      <span>{label}</span>
      <input type="range" min={min} max={safeMax} value={Math.min(value, safeMax)} onChange={(event) => onChange(Number(event.target.value))} />
      <input type="number" min={min} max={safeMax} value={Math.round(Math.min(value, safeMax))} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function clampCrop(crop: ImageCrop, imageSize: PageSize): ImageCrop {
  const x = Math.min(Math.max(0, crop.x), imageSize.width - 1);
  const y = Math.min(Math.max(0, crop.y), imageSize.height - 1);
  return {
    x,
    y,
    width: Math.min(Math.max(1, crop.width), imageSize.width - x),
    height: Math.min(Math.max(1, crop.height), imageSize.height - y),
  };
}

function ImageCanvasPreview({
  source,
  compact = false,
  selectedTextId,
  onImagePointerDown,
  onImagePointerMove,
  onImagePointerUp,
  onTextPointerDown,
  onTextPointerMove,
  onTextPointerUp,
}: {
  source: SourceImage;
  compact?: boolean;
  selectedTextId?: string | null;
  onImagePointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
  onImagePointerMove?: (event: PointerEvent<HTMLDivElement>) => void;
  onImagePointerUp?: (event: PointerEvent<HTMLDivElement>) => void;
  onTextPointerDown?: (event: PointerEvent<HTMLDivElement>, text: ImageTextBox) => void;
  onTextPointerMove?: (event: PointerEvent<HTMLDivElement>) => void;
  onTextPointerUp?: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  const placementTop = source.pageSize.height - source.placement.y - source.placement.height;
  const cropScaleX = source.imageSize.width / source.crop.width;
  const cropScaleY = source.imageSize.height / source.crop.height;
  const cropFrameStyle = {
    left: `${(source.placement.x / source.pageSize.width) * 100}%`,
    top: `${(placementTop / source.pageSize.height) * 100}%`,
    width: `${(source.placement.width / source.pageSize.width) * 100}%`,
    height: `${(source.placement.height / source.pageSize.height) * 100}%`,
  };
  const imageStyle = {
    left: `${-(source.crop.x / source.imageSize.width) * 100 * cropScaleX}%`,
    top: `${-(source.crop.y / source.imageSize.height) * 100 * cropScaleY}%`,
    width: `${100 * cropScaleX}%`,
    height: `${100 * cropScaleY}%`,
  };

  return (
    <>
      <div
        className="image-crop-frame"
        style={cropFrameStyle}
        onPointerDown={onImagePointerDown}
        onPointerMove={onImagePointerMove}
        onPointerUp={onImagePointerUp}
        onPointerCancel={onImagePointerUp}
      >
        <img className="image-page-asset" src={source.objectUrl} alt="" style={imageStyle} />
      </div>
      {!compact &&
        source.texts.map((text) => (
          <div
            key={text.id}
            className={text.id === selectedTextId ? "canvas-text selected" : "canvas-text"}
            style={{
              left: `${(text.x / source.pageSize.width) * 100}%`,
              top: `${((source.pageSize.height - text.y) / source.pageSize.height) * 100}%`,
              color: text.color,
              fontSize: `${(text.fontSize / source.pageSize.width) * 100}%`,
            }}
            onPointerDown={(event) => onTextPointerDown?.(event, text)}
            onPointerMove={onTextPointerMove}
            onPointerUp={onTextPointerUp}
            onPointerCancel={onTextPointerUp}
          >
            {text.text}
          </div>
        ))}
    </>
  );
}

function PageThumb({
  doc,
  pageIndex,
  selectedOrder,
  onToggle,
}: {
  doc: PDFDocumentProxy | null;
  pageIndex: number;
  selectedOrder?: number;
  onToggle: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!doc || !canvas) return;
    let cancelled = false;

    async function render() {
      const page = await doc!.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 0.28 });
      const context = canvas!.getContext("2d");
      if (!context || cancelled) return;

      canvas!.width = viewport.width;
      canvas!.height = viewport.height;
      await page.render({ canvasContext: context, viewport }).promise;
      if (!cancelled) setRendered(true);
    }

    void render();

    return () => {
      cancelled = true;
    };
  }, [doc, pageIndex]);

  return (
    <button className={selectedOrder ? "page-thumb selected" : "page-thumb"} onClick={onToggle}>
      <div className="thumb-canvas">
        {!rendered && <Loader2 className="spin" size={18} />}
        <canvas ref={canvasRef} />
      </div>
      <div className="thumb-meta">
        <span>第 {pageIndex + 1} 页</span>
        {selectedOrder && <strong>#{selectedOrder}</strong>}
      </div>
    </button>
  );
}

function SortableSelectedPage({
  page,
  index,
  onRemove,
}: {
  page: SelectedPage;
  index: number;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} className={isDragging ? "selected-page dragging" : "selected-page"} style={style}>
      <button className="drag-handle" {...attributes} {...listeners} aria-label="拖拽排序">
        <GripVertical size={18} />
      </button>
      <div className="selected-index">{index + 1}</div>
      <div className="selected-copy">
        <strong>{page.sourceFileName}</strong>
        <span>{page.sourceKind === "image" ? "图片页" : `原第 ${page.pageNumber} 页`}</span>
      </div>
      <button aria-label="删除页面" onClick={onRemove}>
        <Trash2 size={17} />
      </button>
    </div>
  );
}
