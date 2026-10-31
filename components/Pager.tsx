"use client";
import { useEffect, useState } from "react";

export const PAGE_SIZE = 15;

/** Slices a list into pages of 15. Jumps back to page 1 whenever `resetKey` changes (filters, search, sort, tab). */
export function usePaged<T>(items: T[], resetKey: string, size = PAGE_SIZE) {
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [resetKey]);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(page, pages); // list can shrink on refresh; never show an empty page
  return { page: current, pages, setPage, total: items.length, size, slice: items.slice((current - 1) * size, current * size) };
}

/** Compact page list: 1 … 4 5 [6] 7 8 … 20 */
function pageList(page: number, pages: number): (number | "gap")[] {
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  const out: (number | "gap")[] = [];
  let prev = 0;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (n - prev > 1) out.push("gap");
    out.push(n); prev = n;
  }
  return out;
}

export function Pager({ page, pages, setPage, total, size }: ReturnType<typeof usePaged<any>>) {
  if (total <= size) return total ? <div className="pager"><span className="pager-info">Showing all {total}</span></div> : null;
  const from = (page - 1) * size + 1, to = Math.min(page * size, total);
  return (
    <nav className="pager" aria-label="Pagination">
      <span className="pager-info">Showing {from}–{to} of {total}</span>
      <div className="pager-btns">
        <button onClick={() => setPage(page - 1)} disabled={page <= 1} aria-label="Previous page">Prev</button>
        {pageList(page, pages).map((n, i) =>
          n === "gap" ? <span key={`g${i}`} className="pager-gap">…</span> : (
            <button key={n} className={n === page ? "on" : ""} aria-current={n === page ? "page" : undefined} onClick={() => setPage(n)}>{n}</button>
          ))}
        <button onClick={() => setPage(page + 1)} disabled={page >= pages} aria-label="Next page">Next</button>
      </div>
    </nav>
  );
}