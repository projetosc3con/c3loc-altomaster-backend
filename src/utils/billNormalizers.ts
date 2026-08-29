import { BillStatementItem } from '../types/bill';

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
    invoice_number: row.invoice?.invoice_number ?? null,
    description: row.description,
    invoice_url: row.payment?.invoice_url ?? null,
    bank_slip_url: row.payment?.bank_slip_url ?? null,
    is_reconciled: row.reconciled_at != null || row.bank_transaction_date != null,
    created_by_name: row.creator?.full_name ?? null,
    created_by_photo: row.creator?.photo_url ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
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
    description: null,
    invoice_url: row.invoice_url ?? null,
    bank_slip_url: row.bank_slip_url ?? null,
    is_reconciled: false,
    raw: row,
  };
}
