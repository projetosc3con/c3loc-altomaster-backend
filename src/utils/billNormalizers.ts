import { BillStatementItem } from '../types/bill';

export function normalizeBankSlipUrls(val: any): string[] | null {
  if (!val) return null;
  if (Array.isArray(val)) {
    const cleaned = val.map((s) => String(s).trim()).filter(Boolean);
    return cleaned.length > 0 ? cleaned : null;
  }
  if (typeof val === 'string' && val.trim().length > 0) {
    return [val.trim()];
  }
  return null;
}

export function normalizeBill(row: any): BillStatementItem {
  return {
    source: 'bill',
    id: row.id,
    type: row.type,
    status: row.status,
    origin: row.origin,
    gross_value: row.gross_value,
    net_value: row.net_value,
    fee_amount: row.fee_amount,
    due_date: row.due_date,
    settled_date: row.reconciled_at,
    client_id: row.client_id,
    client_name: row.client?.company_name ?? null,
    counterparty_name: row.counterparty_name,
    invoice_number: row.invoice?.invoice_number ?? (row.bank_raw_snapshot?.invoice_number ? (String(row.bank_raw_snapshot.invoice_number).toUpperCase().startsWith('NF') ? String(row.bank_raw_snapshot.invoice_number) : `NF-e ${row.bank_raw_snapshot.invoice_number}`) : null) ?? null,
    fatura_numero: row.bank_raw_snapshot?.fatura_numero ?? null,
    rental_invoice_id: row.rental_invoice_id ?? null,
    description: row.description,
    invoice_url: row.bank_raw_snapshot?.fatura_pdf_url ?? row.payment?.invoice_url ?? null,
    bank_slip_url: normalizeBankSlipUrls(row.bank_slip_url)
      ?? normalizeBankSlipUrls(row.payment?.bank_slip_url)
      ?? normalizeBankSlipUrls(row.bank_raw_snapshot?.bank_slip_url)
      ?? null,
    is_reconciled: row.reconciled_at != null || row.bank_transaction_date != null,
    created_by_name: row.creator?.full_name ?? null,
    created_by_photo: row.creator?.photo_url ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    access_key: row.barcode || row.bank_raw_snapshot?.access_key || null,
    raw: row,
  };
}

export function normalizePendingPayment(row: any): BillStatementItem {
  return {
    source: 'payment',
    id: row.id,
    type: 'receivable',
    status: row.status,
    origin: null,
    gross_value: row.value,
    net_value: row.net_value,
    fee_amount: row.net_value != null ? row.value - row.net_value : null,
    due_date: row.due_date,
    settled_date: row.payment_date,
    client_id: row.client_id,
    client_name: row.invoice?.client_name ?? null,
    counterparty_name: null,
    invoice_number: row.invoice?.invoice_number ?? null,
    rental_invoice_id: row.invoice_id ?? row.rental_invoice_id ?? null,
    description: null,
    invoice_url: row.invoice_url ?? null,
    bank_slip_url: normalizeBankSlipUrls(row.bank_slip_url),
    is_reconciled: false,
    raw: row,
  };
}
