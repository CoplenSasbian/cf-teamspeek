import { type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';

import { cn } from '~/lib/utils';

/**
 * 后台通用分页表格。
 *
 * 服务端分页 + 筛选 + 排序都由调用方自己拉数据，这里只负责：
 *   - 表格骨架（列定义 → thead/tbody）
 *   - 筛选输入条（关键字 / 自定义控件 / 刷新按钮）
 *   - 分页条（上一页/下一页 + 页码窗口 + 每页条数选择 + 总数展示）
 *
 * 空状态 / 加载态也在这里收口，各 tab 不用重复写。
 */

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** 单元格渲染 */
  render: (row: T) => ReactNode;
  /** 列宽提示（className，如 w-40） */
  className?: string;
}

export interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  /** 每页条数选项 */
  pageSizeOptions?: number[];
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  pagination,
  loading,
  emptyText = '没有数据',
  toolbar,
  onRowClick,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  pagination?: PaginationState;
  loading?: boolean;
  emptyText?: string;
  /** 表格上方的工具条（筛选 / 操作按钮） */
  toolbar?: ReactNode;
  onRowClick?: (row: T) => void;
}) {
  const totalPages = pagination ? Math.max(1, Math.ceil(pagination.total / pagination.pageSize)) : 1;

  return (
    <div className="flex flex-col gap-3">
      {toolbar && <div className="flex flex-wrap items-center gap-2">{toolbar}</div>}

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line-soft text-xs text-ink-3">
              {columns.map((c) => (
                <th key={c.key} className={cn('px-4 py-3 font-medium', c.className)}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-16 text-center">
                  <span className="inline-flex items-center gap-2 text-sm text-ink-3">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink-3 border-t-transparent" />
                    加载中…
                  </span>
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-16 text-center text-sm text-ink-3">
                  {emptyText}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    'border-b border-line-soft last:border-0',
                    onRowClick && 'cursor-pointer transition hover:bg-surface-2/60',
                  )}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={cn('px-4 py-2.5 align-middle', c.className)}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pagination && (
        <PaginationBar
          page={pagination.page}
          pageSize={pagination.pageSize}
          total={pagination.total}
          totalPages={totalPages}
          options={pagination.pageSizeOptions ?? [10, 20, 50, 100]}
          onPageChange={pagination.onPageChange}
          onPageSizeChange={pagination.onPageSizeChange}
        />
      )}
    </div>
  );
}

/** 页码窗口：当前页前后各 1 页 + 首尾，中间用 … 折叠 */
function pageWindow(page: number, totalPages: number): Array<number | '…'> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);

  const out: Array<number | '…'> = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);

  if (start > 2) out.push('…');
  for (let p = start; p <= end; p++) out.push(p);
  if (end < totalPages - 1) out.push('…');
  out.push(totalPages);
  return out;
}

function PaginationBar({
  page,
  pageSize,
  total,
  totalPages,
  options,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  options: number[];
  onPageChange: (p: number) => void;
  onPageSizeChange?: (s: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-ink-3">
        共 <span className="font-medium text-ink-2">{total}</span> 条 · 第 {page}/{totalPages} 页
      </p>

      <div className="flex items-center gap-1.5">
        {onPageSizeChange && (
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            title="每页条数"
            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs outline-none focus:border-accent"
          >
            {options.map((n) => (
              <option key={n} value={n}>
                {n} 条/页
              </option>
            ))}
          </select>
        )}

        <button
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          title="上一页"
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 transition hover:bg-surface-2 disabled:opacity-40"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>

        {pageWindow(page, totalPages).map((p, i) =>
          p === '…' ? (
            <span key={`gap-${i}`} className="px-1 text-xs text-ink-3">
              …
            </span>
          ) : (
            <button
              key={p}
              onClick={() => onPageChange(p)}
              className={cn(
                'h-7 min-w-7 rounded-lg px-1.5 text-xs font-medium transition',
                p === page
                  ? 'bg-accent text-white'
                  : 'border border-line bg-surface text-ink-2 hover:bg-surface-2',
              )}
            >
              {p}
            </button>
          ),
        )}

        <button
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          title="下一页"
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 transition hover:bg-surface-2 disabled:opacity-40"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** 搜索输入框（回车触发）—— 工具条里最常用的控件，顺手收进来 */
export function TableSearch({
  value,
  onChange,
  onSearch,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  onSearch: () => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSearch();
        }}
        placeholder={placeholder}
        className="w-full rounded-lg border border-line bg-surface py-1.5 pl-8 pr-3 text-xs outline-none transition focus:border-accent"
      />
    </div>
  );
}
