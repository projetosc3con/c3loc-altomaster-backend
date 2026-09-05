import crypto from 'crypto';
import { Response } from 'express';
import { getSupabaseUserClient } from '../config/supabase';
import { AuthRequest } from '../middleware/auth';
import { BillStatementItem, CreateBillPayload } from '../types/bill';
import { normalizeBill, normalizePendingPayment } from '../utils/billNormalizers';

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
    } else if (item.origin === 'MANUAL' && item.type === 'payable' && (item.raw as any)?.bank_raw_snapshot?.group_id) {
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
        paid_installments_count: single.status === 'Recebido' || single.status === 'No prazo' ? 1 : 0,
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

    const paidCount = installments.filter((i) => i.status === 'Recebido' || i.status === 'No prazo').length;
    const allReconciled = installments.every((i) => i.is_reconciled);

    // Próximo vencimento pendente (ou o último se todos quitados)
    const pendingInst = installments.find((i) => i.status !== 'Recebido' && i.status !== 'No prazo');
    const targetDueDate = pendingInst?.due_date || installments[installments.length - 1]?.due_date || first.due_date;

    let consolidatedStatus = 'Pendente';
    if (paidCount === totalCount) {
      consolidatedStatus = 'Recebido';
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
      invoiceNum = baseDesc;
      counterparty = first.counterparty_name || first.client_name || 'Fornecedor';
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
      bank_slip_url: first.bank_slip_url || (first.raw as any)?.bank_slip_url || installments.find((i) => i.bank_slip_url)?.bank_slip_url || null,
    };

    result.push(groupedItem);
  }

  return result;
}

const groupNfeBills = groupBillsWithInstallments;

export const listBills = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { client_id, status, origin, from, to, type, unreconciled } = req.query;

    // Paginação só se aplica ao ramo "merge completo" abaixo (bills +
    // payments pendentes) — é a única consulta que vira uma tabela grande
    // sem fim. O ramo com filtros (picker de "vincular a lançamento
    // existente") continua devolvendo array puro, sem paginar.
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit as string) || 20));

    let billsQuery = supabase
      .from('bills')
      .select('*, invoice:rental_invoices(invoice_number, client_name), client:clients(company_name, cnpj), payment:payments(invoice_url, bank_slip_url), creator:users_profiles!created_by(id, full_name, photo_url)')
      .order('created_at', { ascending: false });

    const shouldGroupNfe =
      unreconciled !== 'true' &&
      (req.query.group_nfe === 'true' || (type === 'payable' && req.query.group_nfe !== 'false'));

    if (client_id) billsQuery = billsQuery.eq('client_id', client_id as string);
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

      const reconciledPaymentIds = new Set((reconciled ?? []).map((r) => r.payment_id));

      let paymentsQuery = supabase
        .from('payments')
        .select('*, invoice:rental_invoices(invoice_number, client_name)')
        .order('created_at', { ascending: false });

      if (client_id) paymentsQuery = paymentsQuery.eq('client_id', client_id as string);
      if (from) paymentsQuery = paymentsQuery.gte('due_date', from as string);
      if (to) paymentsQuery = paymentsQuery.lte('due_date', to as string);

      if (status) {
        if (status === 'Pendente') paymentsQuery = paymentsQuery.eq('status', 'PENDING');
        else if (status === 'Atrasado') paymentsQuery = paymentsQuery.eq('status', 'OVERDUE');
        else if (status === 'Recebido') paymentsQuery = paymentsQuery.eq('status', 'RECEIVED');
        else if (status === 'Aguardando compensação') paymentsQuery = paymentsQuery.eq('status', 'CONFIRMED');
        else paymentsQuery = paymentsQuery.eq('status', '__NONE__');
      }

      const { data: payments, error: paymentsError } = await paymentsQuery;
      if (paymentsError) throw paymentsError;

      const pending = (payments ?? []).filter((p) => !reconciledPaymentIds.has(p.id));
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

    finalItems.sort((a, b) => {
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return b.due_date.localeCompare(a.due_date);
    });

    // Se a rota foi chamada especificamente para o modal de conciliação (unreconciled === 'true'), retorna array simples
    if (unreconciled === 'true') {
      return res.json(finalItems);
    }

    // Retorno paginado padrão para a tabela do extrato
    const total = finalItems.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;
    const paginated = finalItems.slice(start, start + limit);

    return res.json({ data: paginated, total, page, limit, totalPages });
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
      bank_slip_url,
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

    const resolvedStatus = status || (already_settled ? 'Recebido' : 'Pendente');

    let reconciledAt: string | null = null;
    if (is_reconciled !== undefined) {
      if (is_reconciled) {
        reconciledAt = settled_date ? new Date(settled_date as string).toISOString() : new Date().toISOString();
      } else {
        reconciledAt = null;
      }
    } else if (already_settled) {
      reconciledAt = settled_date ? new Date(settled_date as string).toISOString() : new Date().toISOString();
    }

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
          counterparty_name: counterparty_name?.trim() || null,
          description: instDesc,
          gross_value: instGross,
          fee_amount: 0,
          net_value: instGross,
          due_date: instDueDate,
          status: resolvedStatus,
          reconciled_at: reconciledAt,
          bank_transaction_date: bank_transaction_date || null,
          bank_slip_url: bank_slip_url || null,
          bank_raw_snapshot: {
            source: 'MANUAL_INSTALLMENT',
            group_id: groupId,
            installment_number: instNum,
            total_installments: totalCount,
            total_value: gross_value,
            original_description: baseDesc,
            ...(bank_raw_snapshot || {}),
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
        counterparty_name: counterparty_name || null,
        description: description || null,
        gross_value,
        fee_amount: 0,
        net_value: gross_value,
        due_date,
        status: resolvedStatus,
        reconciled_at: reconciledAt,
        bank_transaction_date: bank_transaction_date || null,
        bank_slip_url: bank_slip_url || null,
        bank_raw_snapshot: bank_raw_snapshot || null,
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
    const { status, is_reconciled, bank_slip_url } = req.body;

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

    if (bank_slip_url !== undefined) {
      updatePayload.bank_slip_url = bank_slip_url;
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
          .update({ bank_slip_url, updated_at: new Date().toISOString() })
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
