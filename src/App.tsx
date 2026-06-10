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
  Eye,
  FilePlus2,
  GripVertical,
  Loader2,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { buildMergedPdf, getPageCount, loadPreviewDocument } from "./pdf";
import type { PdfError, SelectedPage, SourcePdf } from "./types";

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_TOTAL_SIZE = 200 * 1024 * 1024;
const MAX_TOTAL_PAGES = 300;

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function App() {
  const [sourcePdfs, setSourcePdfs] = useState<SourcePdf[]>([]);
  const [selectedPages, setSelectedPages] = useState<SelectedPage[]>([]);
  const [errors, setErrors] = useState<PdfError[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [isBuilding, setIsBuilding] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const totalSize = sourcePdfs.reduce((sum, file) => sum + file.size, 0);
  const totalPages = sourcePdfs.reduce((sum, file) => sum + file.pageCount, 0);
  const canBuild = selectedPages.length > 0 && !isBuilding;

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function importFiles(fileList: FileList | null) {
    if (!fileList?.length) return;
    setIsImporting(true);
    setErrors([]);

    const incoming = Array.from(fileList).filter((file) => {
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        return true;
      }
      setErrors((current) => [
        ...current,
        { id: createId("error"), message: `${file.name} 不是 PDF 文件。` },
      ]);
      return false;
    });

    const loaded: SourcePdf[] = [];

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
        const pageCount = await getPageCount(arrayBuffer);

        if (totalPages + loaded.reduce((sum, item) => sum + item.pageCount, 0) + pageCount > MAX_TOTAL_PAGES) {
          setErrors((current) => [
            ...current,
            { id: createId("error"), message: `总页数超过 300 页，${file.name} 已跳过。` },
          ]);
          continue;
        }

        loaded.push({
          id: createId("pdf"),
          name: file.name,
          size: file.size,
          arrayBuffer,
          pageCount,
        });
      } catch {
        setErrors((current) => [
          ...current,
          { id: createId("error"), message: `${file.name} 无法读取，可能已加密或损坏。` },
        ]);
      }
    }

    if (loaded.length) {
      setSourcePdfs((current) => [...current, ...loaded]);
      clearPreview();
    }

    setIsImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function togglePage(source: SourcePdf, pageIndex: number) {
    setSelectedPages((current) => {
      const existing = current.find(
        (page) => page.sourcePdfId === source.id && page.pageIndex === pageIndex,
      );

      if (existing) return current.filter((page) => page.id !== existing.id);

      return [
        ...current,
        {
          id: createId("page"),
          sourcePdfId: source.id,
          sourcePdfName: source.name,
          pageIndex,
          pageNumber: pageIndex + 1,
        },
      ];
    });
    clearPreview();
  }

  function removeSourcePdf(sourceId: string) {
    setSourcePdfs((current) => current.filter((source) => source.id !== sourceId));
    setSelectedPages((current) => current.filter((page) => page.sourcePdfId !== sourceId));
    clearPreview();
  }

  function removeSelectedPage(pageId: string) {
    setSelectedPages((current) => current.filter((page) => page.id !== pageId));
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
      const blob = await buildMergedPdf(sourcePdfs, selectedPages);
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
    setSourcePdfs([]);
    setSelectedPages([]);
    setErrors([]);
    clearPreview();
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <h1>PDF 拼接工具</h1>
          <p>上传多个 PDF，按勾选顺序组合页面，并在导出前调整顺序。</p>
        </div>
        <div className="toolbar">
          <input
            ref={fileInputRef}
            className="hidden-input"
            type="file"
            accept="application/pdf,.pdf"
            multiple
            onChange={(event) => importFiles(event.target.files)}
          />
          <button className="primary-button" onClick={() => fileInputRef.current?.click()} disabled={isImporting}>
            {isImporting ? <Loader2 className="spin" size={18} /> : <Upload size={18} />}
            上传 PDF
          </button>
          <button onClick={clearAll} disabled={!sourcePdfs.length && !selectedPages.length}>
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
            <span>{sourcePdfs.length} 个 PDF</span>
          </div>

          {sourcePdfs.length === 0 ? (
            <button className="empty-upload" onClick={() => fileInputRef.current?.click()}>
              <FilePlus2 size={30} />
              <span>选择 PDF 文件</span>
            </button>
          ) : (
            <div className="file-list">
              {sourcePdfs.map((source) => (
                <div className="file-item" key={source.id}>
                  <div>
                    <strong>{source.name}</strong>
                    <span>
                      {source.pageCount} 页 · {formatSize(source.size)}
                    </span>
                  </div>
                  <button aria-label={`移除 ${source.name}`} onClick={() => removeSourcePdf(source.id)}>
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
            {sourcePdfs.length === 0 ? (
              <EmptyState title="等待上传" text="添加 PDF 后，这里会显示每一页的缩略图。" />
            ) : (
              sourcePdfs.map((source) => (
                <PdfPageGrid
                  key={source.id}
                  source={source}
                  selectedPages={selectedPages}
                  onTogglePage={togglePage}
                />
              ))
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
      if (page.sourcePdfId === source.id) map.set(page.pageIndex, index + 1);
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
        <strong>{page.sourcePdfName}</strong>
        <span>原第 {page.pageNumber} 页</span>
      </div>
      <button aria-label="删除页面" onClick={onRemove}>
        <Trash2 size={17} />
      </button>
    </div>
  );
}
