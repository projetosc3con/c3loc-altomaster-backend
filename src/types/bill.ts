export type BillOrigin = 'ASAAS' | 'MANUAL' | 'NFE';
export type BillType = 'receivable' | 'payable';
export type BillStatus = 'Pendente' | 'Atrasado' | 'Recebido' | 'Divergente' | 'No prazo';

export interface Bill {
  id: string;
  origin: BillOrigin;
  type: BillType;
  rental_invoice_id: string | null;
  payment_id: string | null;
  client_id: string | null;
  counterparty_name: string | null;
  description: string | null;
  gross_value: number;
  fee_amount: number | null;
  net_value: number;
  due_date: string | null;
  pix_end_to_end_id: string | null;
  bank_transaction_date: string | null;
  bank_raw_snapshot: Record<string, unknown> | null;
  barcode: string | null;
  status: BillStatus;
  reconciled_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ManualInstallmentInput {
  installment_number: number;
  due_date: string;
  gross_value: number;
}

export interface CreateBillPayload {
  type: BillType;
  counterparty_name?: string;
  description?: string;
  barcode?: string;
  gross_value: number;
  due_date: string;
  status?: BillStatus;
  is_reconciled?: boolean;
  already_settled?: boolean;
  settled_date?: string;
  bank_transaction_date?: string;
  bank_raw_snapshot?: Record<string, unknown>;
  created_by?: string;
  payment_type?: 'a_vista' | 'parcelado';
  installments?: ManualInstallmentInput[];
  bank_slip_url?: string | null;
}

export interface UpdateBillPayload {
  status?: BillStatus;
  is_reconciled?: boolean;
  bank_slip_url?: string | null;
}

// Item normalizado do extrato bancário (GET /api/bills): mescla `bills`
// (já conciliado, automático ou manual) com `payments` ainda sem bill
// vinculado (cobrança Asaas em aberto). `raw` mantém a linha original
// completa para qualquer campo que o front precise além do shape comum
// (ex: invoice_url, bank_slip_url, pix_end_to_end_id).
export interface BillStatementItem {
  source: 'bill' | 'payment';
  id: string;
  type: BillType;
  status: string;
  origin: BillOrigin | null;
  gross_value: number;
  net_value: number | null;
  fee_amount: number | null;
  due_date: string | null;
  settled_date: string | null;
  client_id: string | null;
  client_name: string | null;
  counterparty_name: string | null;
  invoice_number: string | null;
  rental_invoice_id?: string | null;
  description: string | null;
  invoice_url: string | null;
  bank_slip_url: string | null;
  is_reconciled: boolean;
  created_by_name?: string | null;
  created_by_photo?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  access_key?: string | null;
  installments?: BillStatementItem[];
  installments_count?: number;
  paid_installments_count?: number;
  raw: Record<string, unknown>;
}

// Linha normalizada do extrato bancário do BB (ver bbExtratoService), já
// mapeada pro vocabulário de `bills` (D/C -> payable/receivable).
export interface BankStatementLine {
  bank_date: string; // YYYY-MM-DD
  value: number;
  dc_indicator: 'D' | 'C';
  type: BillType;
  description: string | null;
  document_number: string | null;
  // `textoIdentificadorUnicoTransacao` do BB — quando presente, cruza
  // diretamente com `bills.pix_end_to_end_id` (ver reconcileBankStatement)
  // pra um match autoritativo, sem depender de tipo+data+valor.
  unique_transaction_id: string | null;
  raw: Record<string, unknown>;
}

export type BankStatementMatchStatus = 'matched' | 'unmatched';

export interface BankStatementMatchResult extends BankStatementLine {
  match_status: BankStatementMatchStatus;
  matched_bill_id: string | null;
  matched_bill: BillStatementItem | null;
}

export interface ReconcileBankStatementResponse {
  period: { from: string; to: string };
  simulated: boolean;
  lines: BankStatementMatchResult[];
  matched_count: number;
  unmatched_count: number;
}

// Envelope paginado de GET /api/bills — só usado no ramo "merge completo"
// (bills + payments pendentes, sem filtros de bills). O ramo com filtros
// (picker de lançamentos não conciliados) continua devolvendo array puro.
export interface PaginatedBillStatement {
  data: BillStatementItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
