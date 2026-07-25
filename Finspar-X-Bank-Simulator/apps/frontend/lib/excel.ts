/**
 * Dependency-free Excel export. Emits a genuine .xls workbook using the
 * SpreadsheetML/HTML-table format that Excel (and LibreOffice/Google Sheets)
 * open natively — real columns, and numeric cells that Excel can sum.
 *
 * Keep it simple: one sheet, a header row, and typed cells. Strings are
 * HTML-escaped; numbers are emitted as x:num so they stay numeric.
 */

export type Cell = string | number | null | undefined;
export interface ExcelColumn {
  header: string;
  /** Emit as a real number so Excel can sum it (default: auto-detect). */
  numeric?: boolean;
  /** Force Excel text format — keeps long IDs (account numbers) from becoming 2.01E+11. */
  text?: boolean;
}

function esc(v: Cell): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Build the workbook markup for a single sheet. */
function workbook(sheetName: string, columns: ExcelColumn[], rows: Cell[][]): string {
  const head = columns.map((c) => `<th>${esc(c.header)}</th>`).join('');
  const body = rows
    .map((row) => {
      const cells = row
        .map((cell, i) => {
          // Force text format for IDs so Excel doesn't convert them to
          // scientific notation (e.g. account number 20100... -> 2.01E+11).
          if (columns[i]?.text) {
            return `<td style="mso-number-format:'\\@'">${esc(cell)}</td>`;
          }
          // Everything else: emit the raw value and let Excel auto-detect.
          // Numbers passed as JS numbers become numeric cells naturally.
          return `<td>${esc(cell)}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>${esc(sheetName)}</x:Name>
<x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>th{background:#1e293b;color:#fff;font-weight:bold;text-align:left;border:1px solid #cbd5e1;padding:4px 8px}td{border:1px solid #cbd5e1;padding:4px 8px}</style>
</head>
<body><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}

/** Trigger a browser download of the rows as an .xls file. */
export function exportToExcel(
  filename: string,
  columns: ExcelColumn[],
  rows: Cell[][],
  sheetName = 'Sheet1',
): void {
  const html = workbook(sheetName, columns, rows);
  const blob = new Blob(['﻿', html], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.xls') ? filename : `${filename}.xls`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
