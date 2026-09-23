import crypto from 'crypto';
import { Response } from 'express';
import { getSupabaseUserClient } from '../config/supabase';
import { AuthRequest } from '../middleware/auth';
import { BillStatementItem, CreateBillPayload } from '../types/bill';
import { normalizeBill, normalizePendingPayment, normalizeBankSlipUrls } from '../utils/billNormalizers';

// TODO(SECURITY): a tabela `bills` foi criada sem RLS/policies (confirmado
// via introspecção do schema em 02/08/2026). Esta rota já usa o client
// escopado pelo token do usuário (getSupabaseUserClient), no mesmo padrão de
// listPayments — mas sem RLS habilitada no banco, esse escopo não filtra
// nada de fato: qualquer usuário autenticado (qualquer role que passe pelo
// middleware `authorize` abaixo) enxerga todas as linhas de `bills`, de
// qualquer cliente. Antes de considerar esse endpoint pronto pra produção:
//   1. Habilitar RLS em `bills` (`alter table bills enable row level security`).
//   2. Criar as policies adequadas (leitura por role/tenant, igual às demais
//      tabelas financeiras — conferir o padrão já usado em `payments`/
//      `rental_invoices` como referência).
//   3. Remover este comentário quando a policy estiver validada em produção.
//
// Extrato bancário: mescla `bills` (já lançado, automático via webhook
// Asaas ou manual) com `payments` ainda sem bill vinculado (cobrança Asaas
// em aberto — ver createBillFromPayment em asaasWebhookController.ts).
// Um payment só some daqui quando o bill correspondente é criado de fato
// (não quando payments.status muda pra RECEIVED), porque o pedido de
// repasse ao Asaas pode falhar entre as duas coisas — nesse caso o payment
function groupBillsWithInstallments(items: BillStatementItem[]): BillStatementItem[] {
  const result: BillStatementItem[] = [];
  const groups = new Map<string, BillStatementItem[]>();

  for (const item of items) {
    if (item.origin === 'NFE' && item.type === 'payable') {
      const accessKey =
        item.access_key ||
        (item.raw as any)?.barcode ||
        (item.raw as any)?.bank_raw_snapshot?.access_key ||
        (item.raw as any)?.bank_raw_snapshot?.invoice_number ||
        item.id;

      const groupKey = `nfe_${accessKey}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(item);
    } else if ((item.raw as any)?.bank_raw_snapshot?.group_id) {
      const groupId = (item.raw as any).bank_raw_snapshot.group_id;
      const groupKey = `manual_${groupId}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(item);
    } else {
      result.push(item);
    }
  }

  for (const [groupKey, installments] of groups.entries()) {
    // Ordenar parcelas por installment_number ou due_date crescente
    installments.sort((a, b) => {
      const numA = Number((a.raw as any)?.bank_raw_snapshot?.installment_number) || 0;
      const numB = Number((b.raw as any)?.bank_raw_snapshot?.installment_number) || 0;
      if (numA && numB && numA !== numB) return numA - numB;
      if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
      return 0;
    });

    if (installments.length === 1) {
      const single = installments[0];
      result.push({
        ...single,
        installments: [single],
        installments_count: 1,
        paid_installments_count: single.status === 'Recebido' || single.status === 'Pago' || single.status === 'No prazo' ? 1 : 0,
      });
      continue;
    }

    const first = installments[0];
    const rawSnap = (first.raw as any)?.bank_raw_snapshot || {};
    const isNfe = groupKey.startsWith('nfe_');
    const totalCount = installments.length;

    const rawTotalInvoice = Number(rawSnap.total_value || rawSnap.total_invoice);
    const sumGross = installments.reduce((acc, curr) => acc + (Number(curr.gross_value) || 0), 0);
    const totalGross = (!isNaN(rawTotalInvoice) && rawTotalInvoice > 0) ? rawTotalInvoice : Math.round(sumGross * 100) / 100;
    const sumNet = installments.reduce((acc, curr) => acc + (Number(curr.net_value ?? curr.gross_value) || 0), 0);
    const totalNet = Math.round(sumNet * 100) / 100;
    const sumFee = installments.reduce((acc, curr) => acc + (Number(curr.fee_amount) || 0), 0);
    const totalFee = Math.round(sumFee * 100) / 100;

    const paidCount = installments.filter((i) => i.status === 'Recebido' || i.status === 'Pago' || i.status === 'No prazo').length;
    const allReconciled = installments.every((i) => i.is_reconciled);

    // Próximo vencimento pendente (ou o último se todos quitados)
    const pendingInst = installments.find((i) => i.status !== 'Recebido' && i.status !== 'Pago' && i.status !== 'No prazo');
    const targetDueDate = pendingInst?.due_date || installments[installments.length - 1]?.due_date || first.due_date;

    let consolidatedStatus = 'Pendente';
    if (paidCount === totalCount) {
      consolidatedStatus = first.type === 'payable' ? 'Pago' : 'Recebido';
    } else if (paidCount > 0) {
      consolidatedStatus = `Parcial (${paidCount}/${totalCount})`;
    } else {
      const anyOverdue = installments.some((i) => i.status === 'Atrasado');
      if (anyOverdue) {
        consolidatedStatus = 'Atrasado';
      }
    }

    let invoiceNum: string;
    let counterparty: string;
    let descriptionText: string;

    if (isNfe) {
      invoiceNum = rawSnap.invoice_number ? `NF-e ${rawSnap.invoice_number}` : (first.invoice_number || 'NF-e');
      counterparty = first.counterparty_name || first.client_name || rawSnap.issuer_name || 'Fornecedor NF-e';
      descriptionText = `${invoiceNum} (${totalCount} parcelas) - ${counterparty}`;
    } else {
      const baseDesc = rawSnap.original_description || first.description?.replace(/ - Parcela \d+\/\d+.*$/, '') || 'Lançamento Manual';
      invoiceNum = first.invoice_number || (rawSnap.invoice_number ? (String(rawSnap.invoice_number).toUpperCase().startsWith('NF') ? String(rawSnap.invoice_number) : `NF-e ${rawSnap.invoice_number}`) : baseDesc);
      counterparty = first.counterparty_name || first.client_name || (first.type === 'receivable' ? 'Cliente' : 'Fornecedor');
      descriptionText = `${baseDesc} (${totalCount} parcelas)${counterparty ? ' - ' + counterparty : ''}`;
    }

    const groupedItem: BillStatementItem = {
      ...first,
      id: first.id,
      description: descriptionText,
      invoice_number: invoiceNum,
      counterparty_name: counterparty,
      gross_value: totalGross,
      net_value: totalNet,
      fee_amount: totalFee,
      due_date: targetDueDate,
      status: consolidatedStatus,
      is_reconciled: allReconciled,
      installments: installments,
      installments_count: totalCount,
      paid_installments_count: paidCount,
      access_key: first.access_key || (first.raw as any)?.barcode || rawSnap.access_key || null,
      bank_slip_url: normalizeBankSlipUrls(first.bank_slip_url || (first.raw as any)?.bank_slip_url) || normalizeBankSlipUrls(installments.find((i) => i.bank_slip_url)?.bank_slip_url) || null,
    };

    result.push(groupedItem);
  }

  return result;
}

const groupNfeBills = groupBillsWithInstallments;

export const getFilteredBills = async (supabase: any, query: any): Promise<BillStatementItem[]> => {
  const { client_id, status, origin, from, to, type, unreconciled, invoice_number, search, rental_invoice_id, sort_by, sort_order } = query;

  let billsQuery = supabase
    .from('bills')
    .select('*, invoice:rental_invoices(invoice_number, client_name), client:clients(company_name, cnpj), payment:payments(invoice_url, bank_slip_url), creator:users_profiles!created_by(id, full_name, photo_url), fatura:rental_billing_invoices(id, invoice_number, sequence_number, pdf_url, invoice_type, total_amount)')
    .order('created_at', { ascending: false });

  const shouldGroupNfe =
    unreconciled !== 'true' &&
    (query.group_nfe === 'true' || query.group_nfe !== 'false');

  if (client_id) billsQuery = billsQuery.eq('client_id', client_id as string);
  if (rental_invoice_id) billsQuery = billsQuery.eq('rental_invoice_id', rental_invoice_id as string);
  if (status && !shouldGroupNfe) billsQuery = billsQuery.eq('status', status as string);
  if (origin) billsQuery = billsQuery.eq('origin', origin as string);
  if (type) billsQuery = billsQuery.eq('type', type as string);
  if (from) billsQuery = billsQuery.gte('due_date', from as string);
  if (to) billsQuery = billsQuery.lte('due_date', to as string);
  if (unreconciled === 'true') billsQuery = billsQuery.is('bank_transaction_date', null).is('reconciled_at', null);

  const { data: bills, error: billsError } = await billsQuery;
  if (billsError) throw billsError;

  const items: BillStatementItem[] = (bills ?? []).map(normalizeBill);

  // Inclui pagamentos Asaas pendentes de reconciliação caso o filtro permita (tipo receivable e origem ASAAS ou sem filtro)
  const shouldIncludePayments =
    unreconciled !== 'true' &&
    (!type || type === 'receivable') &&
    (!origin || origin === 'ASAAS');

  if (shouldIncludePayments) {
    const { data: reconciled, error: reconciledError } = await supabase
      .from('bills')
      .select('payment_id')
      .not('payment_id', 'is', null);
    if (reconciledError) throw reconciledError;

    const reconciledPaymentIds = new Set((reconciled ?? []).map((r: any) => r.payment_id));

    let paymentsQuery = supabase
      .from('payments')
      .select('*, invoice:rental_invoices(invoice_number, client_name)')
      .order('created_at', { ascending: false });

    if (client_id) paymentsQuery = paymentsQuery.eq('client_id', client_id as string);
    if (rental_invoice_id) paymentsQuery = paymentsQuery.eq('invoice_id', rental_invoice_id as string);
    if (from) paymentsQuery = paymentsQuery.gte('due_date', from as string);
    if (to) paymentsQuery = paymentsQuery.lte('due_date', to as string);

    if (status) {
      if (status === 'Pendente') paymentsQuery = paymentsQuery.eq('status', 'PENDING');
      else if (status === 'Atrasado') paymentsQuery = paymentsQuery.eq('status', 'OVERDUE');
      else if (status === 'Recebido' || status === 'Pago') paymentsQuery = paymentsQuery.eq('status', 'RECEIVED');
      else if (status === 'Aguardando compensação') paymentsQuery = paymentsQuery.eq('status', 'CONFIRMED');
      else paymentsQuery = paymentsQuery.eq('status', '__NONE__');
    }

    const { data: payments, error: paymentsError } = await paymentsQuery;
    if (paymentsError) throw paymentsError;

    const pending = (payments ?? []).filter((p: any) => !reconciledPaymentIds.has(p.id));
    items.push(...pending.map(normalizePendingPayment));
  }

  let finalItems = shouldGroupNfe ? groupNfeBills(items) : items;

  if (status && shouldGroupNfe) {
    finalItems = finalItems.filter((item) => {
      if (item.status === status) return true;
      if (item.status.startsWith('Parcial') && status === 'Pendente') return true;
      return false;
    });
  }

  const searchRaw = (typeof search === 'string' && search.trim()) ||
                    (typeof invoice_number === 'string' && invoice_number.trim()) ||
                    '';

  if (searchRaw) {
    const term = searchRaw.toLowerCase();
    finalItems = finalItems.filter((item) => {
      const itemInv = item.invoice_number ? String(item.invoice_number).toLowerCase() : '';
      const rawInv = (item.raw as any)?.invoice?.invoice_number ? String((item.raw as any).invoice.invoice_number).toLowerCase() : '';
      const rawSnapInv = (item.raw as any)?.bank_raw_snapshot?.invoice_number ? String((item.raw as any).bank_raw_snapshot.invoice_number).toLowerCase() : '';
      const faturaNum = item.fatura_numero ? String(item.fatura_numero).toLowerCase() : '';
      const counterparty = (item.counterparty_name || (item.raw as any)?.counterparty_name || '').toLowerCase();
      const issuerName = ((item.raw as any)?.bank_raw_snapshot?.issuer_name || '').toLowerCase();
      const clientName = (item.client_name || (item.raw as any)?.client?.company_name || '').toLowerCase();
      const desc = (item.description || '').toLowerCase();

      const matchDirect =
        itemInv.includes(term) ||
        rawInv.includes(term) ||
        rawSnapInv.includes(term) ||
        faturaNum.includes(term) ||
        counterparty.includes(term) ||
        issuerName.includes(term) ||
        clientName.includes(term) ||
        desc.includes(term);

      if (matchDirect) return true;

      if (Array.isArray(item.installments)) {
        return item.installments.some((inst) => {
          const instInv = inst.invoice_number ? String(inst.invoice_number).toLowerCase() : '';
          const instCounterparty = (inst.counterparty_name || '').toLowerCase();
          const instSnapInv = (inst.raw as any)?.bank_raw_snapshot?.invoice_number ? String((inst.raw as any).bank_raw_snapshot.invoice_number).toLowerCase() : '';
          const instIssuer = ((inst.raw as any)?.bank_raw_snapshot?.issuer_name || '').toLowerCase();
          const instDesc = (inst.description || '').toLowerCase();
          return (
            instInv.includes(term) ||
            instCounterparty.includes(term) ||
            instSnapInv.includes(term) ||
            instIssuer.includes(term) ||
            instDesc.includes(term)
          );
        });
      }

      return false;
    });
  }

  const sortBy = (sort_by as string) || 'due_date';
  const sortOrder = (sort_order as string) === 'asc' ? 'asc' : 'desc';

  finalItems.sort((a, b) => {
    let comparison = 0;
    switch (sortBy) {
      case 'due_date': {
        const valA = a.due_date || '';
        const valB = b.due_date || '';
        if (!valA && !valB) comparison = 0;
        else if (!valA) comparison = 1;
        else if (!valB) comparison = -1;
        else comparison = valA.localeCompare(valB);
        break;
      }
      case 'gross_value': {
        const valA = Number(a.gross_value) || 0;
        const valB = Number(b.gross_value) || 0;
        comparison = valA - valB;
        break;
      }
      case 'net_value': {
        const valA = Number(a.net_value ?? a.gross_value) || 0;
        const valB = Number(b.net_value ?? b.gross_value) || 0;
        comparison = valA - valB;
        break;
      }
      case 'counterparty_name':
      case 'client_name': {
        const valA = (a.counterparty_name || a.client_name || '').toLowerCase();
        const valB = (b.counterparty_name || b.client_name || '').toLowerCase();
        comparison = valA.localeCompare(valB, 'pt-BR');
        break;
      }
      case 'origin': {
        const valA = (a.origin || a.source || '').toLowerCase();
        const valB = (b.origin || b.source || '').toLowerCase();
        comparison = valA.localeCompare(valB, 'pt-BR');
        break;
      }
      case 'status': {
        const valA = (a.status || '').toLowerCase();
        const valB = (b.status || '').toLowerCase();
        comparison = valA.localeCompare(valB, 'pt-BR');
        break;
      }
      case 'is_reconciled': {
        const valA = a.is_reconciled || Boolean(a.settled_date) ? 1 : 0;
        const valB = b.is_reconciled || Boolean(b.settled_date) ? 1 : 0;
        comparison = valA - valB;
        break;
      }
      default: {
        const valA = a.due_date || '';
        const valB = b.due_date || '';
        if (!valA && !valB) comparison = 0;
        else if (!valA) comparison = 1;
        else if (!valB) comparison = -1;
        else comparison = valA.localeCompare(valB);
        break;
      }
    }

    return sortOrder === 'asc' ? comparison : -comparison;
  });

  return finalItems;
};

export const listBills = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { rental_invoice_id, unreconciled } = req.query;

    // Paginação só se aplica ao ramo "merge completo" abaixo (bills +
    // payments pendentes) — é a única consulta que vira uma tabela grande
    // sem fim. O ramo com filtros (picker de "vincular a lançamento
    // existente") continua devolvendo array puro, sem paginar.
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const defaultLimit = rental_invoice_id ? 100 : 20;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || defaultLimit));

    const finalItems = await getFilteredBills(supabase, req.query);

    // Se a rota foi chamada especificamente para uma locação (rental_invoice_id) ou conciliação (unreconciled === 'true'), retorna array simples
    if (rental_invoice_id || unreconciled === 'true') {
      return res.json(finalItems);
    }

    // Retorno paginado padrão para a tabela do extrato
    const total = finalItems.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;
    const paginated = finalItems.slice(start, start + limit);

    const totalGross = finalItems.reduce((acc, item) => acc + (Number(item.gross_value) || 0), 0);
    const totalNet = finalItems.reduce((acc, item) => acc + (Number(item.net_value ?? item.gross_value) || 0), 0);
    const totalPending = finalItems
      .filter((i) => !i.is_reconciled && !Boolean(i.settled_date) && i.status !== 'Recebido' && i.status !== 'Pago' && i.status !== 'No prazo')
      .reduce((acc, item) => acc + (Number(item.gross_value) || 0), 0);
    const totalSettled = finalItems
      .filter((i) => i.is_reconciled || Boolean(i.settled_date) || i.status === 'Recebido' || i.status === 'Pago' || i.status === 'No prazo')
      .reduce((acc, item) => acc + (Number(item.gross_value) || 0), 0);

    return res.json({
      data: paginated,
      total,
      page,
      limit,
      totalPages,
      summary: {
        total_gross: totalGross,
        total_net: totalNet,
        total_pending: totalPending,
        total_settled: totalSettled,
        count: total,
      }
    });
  } catch (error: any) {
    console.error('[listBills] Erro:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

// Lançamento manual de conta a pagar/receber. `bills.status` tem um CHECK
// constraint no banco que só aceita os 5 valores usados pro lado de
// recebível (Pendente/Atrasado/Recebido/Divergente/No prazo) — confirmado
// empiricamente tentando inserir 'Pago' (erro 23514). Por isso um lançamento
// de conta a pagar já quitada também usa status='Recebido', mesmo não sendo
// o nome ideal — mudar isso exigiria alterar o constraint no banco.
export const createBill = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const {
      type, counterparty_name, description, barcode,
      gross_value, due_date, status, is_reconciled, already_settled, settled_date,
      bank_transaction_date, bank_raw_snapshot, payment_type, installments,
      bank_slip_url, invoice_number, rental_invoice_id,
    } = req.body as CreateBillPayload;

    if (type !== 'receivable' && type !== 'payable') {
      return res.status(400).json({ error: "type deve ser 'receivable' ou 'payable'" });
    }
    if (!gross_value || gross_value <= 0) {
      return res.status(400).json({ error: 'gross_value é obrigatório e deve ser maior que zero' });
    }
    if (!due_date) {
      return res.status(400).json({ error: 'due_date é obrigatório' });
    }

    const defaultSettledStatus = type === 'payable' ? 'Pago' : 'Recebido';
    const resolvedStatus = status || (already_settled ? defaultSettledStatus : 'Pendente');

    let reconciledAt: string | null = null;
    const isSettled = resolvedStatus === 'Recebido' || resolvedStatus === 'Pago' || resolvedStatus === 'No prazo';
    if (is_reconciled !== undefined) {
      if (is_reconciled) {
        reconciledAt = settled_date ? new Date(settled_date as string).toISOString() : new Date().toISOString();
      } else {
        reconciledAt = null;
      }
    } else if (already_settled || isSettled) {
      reconciledAt = settled_date ? new Date(settled_date as string).toISOString() : new Date().toISOString();
    }

    const rawSnapshot: Record<string, unknown> = {
      ...(bank_raw_snapshot || {}),
      ...(invoice_number?.trim() ? { invoice_number: invoice_number.trim() } : {}),
    };

    const normalizedBankSlipUrls = normalizeBankSlipUrls(bank_slip_url);

    // MULTI-PARCELAS MANUAL
    if (payment_type === 'parcelado' && Array.isArray(installments) && installments.length > 1) {
      const groupId = crypto.randomUUID();
      const totalCount = installments.length;
      const baseDesc = description?.trim() || 'Lançamento Manual';

      const billsToInsert = installments.map((inst, index) => {
        const instNum = inst.installment_number || (index + 1);
        const instGross = Number(inst.gross_value) || 0;
        const instDueDate = inst.due_date ? inst.due_date.split('T')[0] : due_date;
        const instDesc = `${baseDesc} - Parcela ${instNum}/${totalCount}${counterparty_name ? ' - ' + counterparty_name.trim() : ''}`;

        return {
          origin: 'MANUAL' as const,
          type,
          client_id: null,
          rental_invoice_id: rental_invoice_id || null,
          counterparty_name: counterparty_name?.trim() || null,
          description: instDesc,
          gross_value: instGross,
          fee_amount: 0,
          net_value: instGross,
          due_date: instDueDate,
          status: resolvedStatus,
          reconciled_at: reconciledAt,
          bank_transaction_date: bank_transaction_date || null,
          bank_slip_url: normalizedBankSlipUrls,
          bank_raw_snapshot: {
            source: 'MANUAL_INSTALLMENT',
            group_id: groupId,
            installment_number: instNum,
            total_installments: totalCount,
            total_value: gross_value,
            original_description: baseDesc,
            ...rawSnapshot,
          },
          created_by: req.user?.id || req.body.created_by || null,
          ...(barcode ? { barcode: barcode.trim() } : {}),
        };
      });

      const { data: insertedBills, error: insertError } = await supabase
        .from('bills')
        .insert(billsToInsert)
        .select('*, invoice:rental_invoices(invoice_number, client_name), client:clients(company_name, cnpj), payment:payments(invoice_url, bank_slip_url), creator:users_profiles!created_by(id, full_name, photo_url)')
        .order('due_date', { ascending: true });

      if (insertError) throw insertError;

      return res.status(201).json(normalizeBill(insertedBills[0]));
    }

    // Lançamento manual não vincula a um cliente cadastrado — apenas um
    // nome livre (counterparty_name), tanto pra conta a pagar (fornecedor)
    // quanto a receber (quem vai pagar).
    const { data, error } = await supabase
      .from('bills')
      .insert({
        origin: 'MANUAL',
        type,
        client_id: null,
        rental_invoice_id: rental_invoice_id || null,
        counterparty_name: counterparty_name || null,
        description: description || null,
        gross_value,
        fee_amount: 0,
        net_value: gross_value,
        due_date,
        status: resolvedStatus,
        reconciled_at: reconciledAt,
        bank_transaction_date: bank_transaction_date || null,
        bank_slip_url: normalizedBankSlipUrls,
        bank_raw_snapshot: Object.keys(rawSnapshot).length > 0 ? rawSnapshot : null,
        created_by: req.user?.id || req.body.created_by || null,
        // Coluna `barcode` só existe depois da migração
        // `ALTER TABLE bills ADD COLUMN barcode text;` — incluída apenas
        // quando informada pra não quebrar lançamentos sem código de barras
        // caso a migração ainda não tenha rodado.
        ...(barcode ? { barcode: barcode.trim() } : {}),
      })
      .select('*, invoice:rental_invoices(invoice_number, client_name), client:clients(company_name, cnpj), payment:payments(invoice_url, bank_slip_url), creator:users_profiles!created_by(id, full_name, photo_url)')
      .single();
    if (error) throw error;

    return res.status(201).json(normalizeBill(data));
  } catch (error: any) {
    console.error('[createBill] Erro:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

export const updateBill = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { status, due_date, is_reconciled, bank_slip_url, bank_raw_snapshot } = req.body;

    // Buscar bill atual para validar existência e origem
    const { data: currentBill, error: fetchError } = await supabase
      .from('bills')
      .select('*, invoice:rental_invoices(invoice_number, client_name), client:clients(company_name, cnpj), payment:payments(invoice_url, bank_slip_url), creator:users_profiles!created_by(id, full_name, photo_url)')
      .eq('id', id)
      .single();

    if (fetchError || !currentBill) {
      return res.status(404).json({ error: 'Lançamento não encontrado' });
    }

    const updatePayload: Record<string, any> = {
      updated_at: new Date().toISOString()
    };

    if (status !== undefined) {
      updatePayload.status = status;
    }

    if (due_date !== undefined) {
      updatePayload.due_date = due_date;
    }

    if (bank_slip_url !== undefined) {
      updatePayload.bank_slip_url = normalizeBankSlipUrls(bank_slip_url);
    }

    if (bank_raw_snapshot !== undefined) {
      updatePayload.bank_raw_snapshot = {
        ...((currentBill.bank_raw_snapshot as Record<string, any>) || {}),
        ...bank_raw_snapshot,
      };
    }

    if (is_reconciled !== undefined) {
      if (is_reconciled) {
        // Forçar conciliação manual gravando reconciled_at com o timestamp atual
        updatePayload.reconciled_at = new Date().toISOString();
      } else {
        // Desmarcar conciliação
        updatePayload.reconciled_at = null;
        updatePayload.bank_transaction_date = null;
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from('bills')
      .update(updatePayload)
      .eq('id', id)
      .select('*, invoice:rental_invoices(invoice_number, client_name), client:clients(company_name, cnpj), payment:payments(invoice_url, bank_slip_url), creator:users_profiles!created_by(id, full_name, photo_url)')
      .single();

    if (updateError) throw updateError;

    // Se pertence a um grupo de parcelas manuais, atualizar bank_slip_url nas parcelas irmãs
    const groupId = (currentBill.bank_raw_snapshot as any)?.group_id;
    if (groupId && bank_slip_url !== undefined) {
      const { data: siblingBills } = await supabase
        .from('bills')
        .select('id, bank_raw_snapshot')
        .eq('origin', 'MANUAL');

      const idsToUpdate = (siblingBills || [])
        .filter((b: any) => b.bank_raw_snapshot?.group_id === groupId && b.id !== id)
        .map((b: any) => b.id);

      if (idsToUpdate.length > 0) {
        await supabase
          .from('bills')
          .update({ bank_slip_url: updatePayload.bank_slip_url, updated_at: new Date().toISOString() })
          .in('id', idsToUpdate);
      }
    }

    return res.json(normalizeBill(updated));
  } catch (error: any) {
    console.error('[updateBill] Erro:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

export const deleteBill = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);

    // Buscar bill atual para validar existência e origem
    const { data: currentBill, error: fetchError } = await supabase
      .from('bills')
      .select('id, origin, bank_raw_snapshot')
      .eq('id', id)
      .single();

    if (fetchError || !currentBill) {
      return res.status(404).json({ error: 'Lançamento não encontrado' });
    }

    if (currentBill.origin !== 'MANUAL') {
      return res.status(400).json({ error: 'Apenas lançamentos de origem MANUAL podem ser excluídos diretamente.' });
    }

    const groupId = (currentBill.bank_raw_snapshot as any)?.group_id;
    if (groupId) {
      // Se pertence a um grupo de parcelas manuais, excluir todas as parcelas do grupo
      const { data: siblingBills } = await supabase
        .from('bills')
        .select('id, bank_raw_snapshot')
        .eq('origin', 'MANUAL');

      const idsToDelete = (siblingBills || [])
        .filter((b: any) => b.bank_raw_snapshot?.group_id === groupId)
        .map((b: any) => b.id);

      if (idsToDelete.length > 0) {
        const { error: deleteGroupError } = await supabase
          .from('bills')
          .delete()
          .in('id', idsToDelete);

        if (deleteGroupError) throw deleteGroupError;
      }
    } else {
      const { error: deleteError } = await supabase
        .from('bills')
        .delete()
        .eq('id', id);

      if (deleteError) throw deleteError;
    }

    return res.json({ success: true, message: 'Lançamento excluído com sucesso.' });
  } catch (error: any) {
    console.error('[deleteBill] Erro:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

export const splitBillIntoInstallments = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);

    // 1. Validar payload
    const rawInstallments = req.body.installments;
    if (!Array.isArray(rawInstallments) || rawInstallments.length < 2) {
      return res.status(400).json({ error: 'O parcelamento requer no mínimo 2 parcelas.' });
    }

    const todayStr = new Date().toISOString().split('T')[0];

    const installments: Array<{ amount: number; due_date: string }> = [];
    for (let i = 0; i < rawInstallments.length; i++) {
      const inst = rawInstallments[i];
      const amount = Math.round((Number(inst.amount) || 0) * 100) / 100;
      const dueDate = inst.due_date ? String(inst.due_date).trim().split('T')[0] : '';

      if (amount <= 0) {
        return res.status(400).json({ error: `O valor da parcela ${i + 1} deve ser maior que zero.` });
      }
      if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        return res.status(400).json({ error: `Data de vencimento inválida para a parcela ${i + 1}.` });
      }

      installments.push({ amount, due_date: dueDate });
    }

    // 2. Buscar o lançamento atual
    const { data: currentBill, error: fetchError } = await supabase
      .from('bills')
      .select('*, invoice:rental_invoices(invoice_number, client_name), client:clients(company_name, cnpj), payment:payments(invoice_url, bank_slip_url), creator:users_profiles!created_by(id, full_name, photo_url)')
      .eq('id', id)
      .single();

    if (fetchError || !currentBill) {
      return res.status(404).json({ error: 'Lançamento não encontrado.' });
    }

    if (currentBill.status === 'Recebido' || currentBill.status === 'Pago') {
      return res.status(400).json({ error: 'Não é possível parcelar um lançamento que já foi recebido/pago integralmente.' });
    }

    const currentGross = Number(currentBill.gross_value) || 0;
    const currentSnap = (currentBill.bank_raw_snapshot as any) || {};

    // Valor total de referência: se já pertencia a um grupo anterior, pega o total_value do snapshot, senão currentGross
    const referenceTotal = Number(currentSnap.total_value) || currentGross;
    const sumInstallments = Math.round(installments.reduce((acc, it) => acc + it.amount, 0) * 100) / 100;

    // Verificar se a soma difere significativamente do valor de referência
    if (Math.abs(sumInstallments - referenceTotal) > 0.05 && Math.abs(sumInstallments - currentGross) > 0.05) {
      return res.status(400).json({
        error: `A soma das parcelas (R$ ${sumInstallments.toFixed(2)}) deve corresponder ao valor da fatura (R$ ${referenceTotal.toFixed(2)}).`
      });
    }

    // 3. Gerenciar grupo de parcelas
    let groupId = currentSnap.group_id;
    if (groupId) {
      // Se já pertencia a um grupo, verificar se alguma parcela irmã foi recebida
      const { data: siblingBills } = await supabase
        .from('bills')
        .select('id, status, bank_raw_snapshot')
        .filter('bank_raw_snapshot->>group_id', 'eq', groupId);

      const siblingsInGroup = (siblingBills || []).filter(
        (b: any) => b.bank_raw_snapshot?.group_id === groupId && b.id !== id
      );

      const anySiblingPaid = siblingsInGroup.some(
        (b: any) => b.status === 'Recebido' || b.status === 'Pago'
      );

      if (anySiblingPaid) {
        return res.status(400).json({
          error: 'Não é possível re-parcelar este lançamento pois já existem parcelas recebidas/pagas neste grupo.'
        });
      }

      // Remover parcelas irmãs anteriores para substituir pelas novas
      const siblingIdsToDelete = siblingsInGroup.map((b: any) => b.id);
      if (siblingIdsToDelete.length > 0) {
        await supabase.from('bills').delete().in('id', siblingIdsToDelete);
      }
    } else {
      groupId = crypto.randomUUID();
    }

    // 4. Descrição base limpa
    const rawDesc = currentSnap.original_description || currentBill.description || 'Fatura de Locação';
    const baseDesc = rawDesc.replace(/\s*-\s*Parcela\s+\d+\/\d+.*$/i, '').trim();

    // 5. Determinar status da Parcela 1
    const due1 = installments[0].due_date;
    const isOverdue1 = due1 < todayStr;
    const status1 = isOverdue1 ? 'Atrasado' : 'No prazo';

    const updatedSnap1 = {
      ...currentSnap,
      group_id: groupId,
      installment_number: 1,
      total_installments: installments.length,
      total_value: sumInstallments,
      original_description: baseDesc,
      split_at: new Date().toISOString(),
      split_by: req.user?.id || null
    };

    // Atualizar a 1ª parcela no registro existente
    const { data: updatedFirstBill, error: updateError } = await supabase
      .from('bills')
      .update({
        description: `${baseDesc} - Parcela 1/${installments.length}`,
        gross_value: installments[0].amount,
        net_value: installments[0].amount,
        fee_amount: 0,
        due_date: installments[0].due_date,
        status: status1,
        bank_raw_snapshot: updatedSnap1,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select('*, invoice:rental_invoices(invoice_number, client_name), client:clients(company_name, cnpj), payment:payments(invoice_url, bank_slip_url), creator:users_profiles!created_by(id, full_name, photo_url)')
      .single();

    if (updateError) throw updateError;

    // 6. Inserir novas contas a receber para as parcelas 2..N
    const newBillsToInsert = installments.slice(1).map((inst, idx) => {
      const instNum = idx + 2;
      const isOverdue = inst.due_date < todayStr;
      const instStatus = isOverdue ? 'Atrasado' : 'No prazo';

      return {
        origin: 'MANUAL',
        type: currentBill.type || 'receivable',
        rental_invoice_id: currentBill.rental_invoice_id || null,
        client_id: currentBill.client_id || null,
        counterparty_name: currentBill.counterparty_name || null,
        description: `${baseDesc} - Parcela ${instNum}/${installments.length}`,
        gross_value: inst.amount,
        fee_amount: 0,
        net_value: inst.amount,
        due_date: inst.due_date,
        status: instStatus,
        reconciled_at: null,
        created_by: req.user?.id || null,
        bank_slip_url: currentBill.bank_slip_url || null,
        bank_raw_snapshot: {
          ...currentSnap,
          group_id: groupId,
          installment_number: instNum,
          total_installments: installments.length,
          total_value: sumInstallments,
          original_description: baseDesc,
          parent_bill_id: id,
          split_at: new Date().toISOString(),
          split_by: req.user?.id || null
        }
      };
    });

    const { data: insertedSiblings, error: insertError } = await supabase
      .from('bills')
      .insert(newBillsToInsert)
      .select('*, invoice:rental_invoices(invoice_number, client_name), client:clients(company_name, cnpj), payment:payments(invoice_url, bank_slip_url), creator:users_profiles!created_by(id, full_name, photo_url)')
      .order('due_date', { ascending: true });

    if (insertError) throw insertError;

    // 7. Consolidar todas as parcelas do grupo
    const allGroupBills = [updatedFirstBill, ...(insertedSiblings || [])];
    const normalizedItems = allGroupBills.map(normalizeBill);
    const grouped = groupBillsWithInstallments(normalizedItems);

    const resultItem = grouped[0] || normalizeBill(updatedFirstBill);

    return res.json({
      success: true,
      message: `Fatura dividida com sucesso em ${installments.length} parcelas!`,
      item: resultItem,
      installments: normalizedItems
    });
  } catch (error: any) {
    console.error('[splitBillIntoInstallments] Erro:', error.message);
    return res.status(500).json({ error: error.message || 'Erro ao parcelar fatura.' });
  }
};

