import { Response } from 'express';
import { getSupabaseUserClient } from '../config/supabase';
import { AuthRequest } from '../middleware/auth';
import { bbExtratoService } from '../services/bbExtratoService';
import { normalizeBill } from '../utils/billNormalizers';
import {
  BankStatementLine,
  BankStatementMatchResult,
  ReconcileBankStatementResponse,
} from '../types/bill';

const DEFAULT_PERIOD_DAYS = 30;
const VALUE_MATCH_TOLERANCE = 0.01;
const DATE_MATCH_TOLERANCE_DAYS = 5;

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const diffMs = new Date(a).getTime() - new Date(b).getTime();
  return Math.abs(diffMs) / (1000 * 60 * 60 * 24);
}

function resolvePeriod(from: unknown, to: unknown): { from: string; to: string } {
  if (typeof from === 'string' && typeof to === 'string' && from && to) {
    return { from, to };
  }
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - DEFAULT_PERIOD_DAYS);
  return { from: toIsoDate(start), to: toIsoDate(today) };
}

function cleanDocument(doc: unknown): string {
  return typeof doc === 'string' ? doc.replace(/\D/g, '') : '';
}

// Aplica o dado de uma linha do extrato bancário sobre um bill existente —
// usado tanto no match automático (reconcileBankStatement) quanto no vínculo
// manual (linkStatementLineToBill). O bill passa a refletir exatamente o que
// está no banco (due_date/valor), além de ficar marcado como conciliado.
async function applyBankLineToBill(supabase: ReturnType<typeof getSupabaseUserClient>, billId: string, line: BankStatementLine) {
  const { data: existing, error: fetchError } = await supabase
    .from('bills')
    .select('net_value, type, pix_end_to_end_id')
    .eq('id', billId)
    .single();
  if (fetchError) throw fetchError;

  // Mesma tolerância usada no match automático (VALUE_MATCH_TOLERANCE) — se
  // o valor que veio do banco divergir do valor originalmente cadastrado
  // além disso, o lançamento fica marcado como Divergente em vez de
  // Recebido, em vez de sobrescrever o valor original sem sinalizar nada.
  const isDivergent = Math.abs(existing.net_value - line.value) > VALUE_MATCH_TOLERANCE;

  const { data, error } = await supabase
    .from('bills')
    .update({
      due_date: line.bank_date,
      gross_value: line.value,
      net_value: line.value,
      bank_transaction_date: line.bank_date,
      bank_raw_snapshot: line.raw,
      pix_end_to_end_id: existing.pix_end_to_end_id || line.unique_transaction_id || null,
      status: isDivergent ? 'Divergente' : (existing.type === 'payable' ? 'Pago' : 'Recebido'),
      reconciled_at: new Date().toISOString(),
    })
    .eq('id', billId)
    .select('*, invoice:rental_invoices(invoice_number, client_name), client:clients(company_name, cnpj)')
    .single();
  if (error) throw error;
  return data;
}

// Concilia o extrato bancário do BB (por período, default últimos 30 dias)
// contra os `bills` ainda não conciliados (`bank_transaction_date IS NULL`).
// Match, em ordem de prioridade:
// (1) autoritativo por identificador único: `line.unique_transaction_id === bill.pix_end_to_end_id`;
// (2) autoritativo por contrapartida: `cleanDocument(line.counterparty_document) === cleanDocument(bill.client.cnpj)` + valor exato;
// (3) fallback frouxo: tipo + proximidade de data + tolerância de valor.
//
// Também possui checagem de idempotência bancária: linhas cujo unique_transaction_id
// já consta em bills previamente conciliados são marcadas automaticamente como matched.
export const reconcileBankStatement = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const period = resolvePeriod(req.query.from, req.query.to);

    const { simulated, lines } = await bbExtratoService.fetchExtrato(period);

    // 1. Busca os bills candidatos ainda NÃO conciliados
    const { data: candidates, error: candidatesError } = await supabase
      .from('bills')
      .select('*, invoice:rental_invoices(invoice_number, client_name), client:clients(company_name, cnpj)')
      .is('bank_transaction_date', null);
    if (candidatesError) throw candidatesError;

    // 2. Busca também bills JÁ conciliados no período para garantir idempotência bancária
    // (evita que linhas já conciliadas em consultas anteriores apareçam falsamente como "Pendentes")
    const { data: alreadyReconciled, error: alreadyError } = await supabase
      .from('bills')
      .select('*, invoice:rental_invoices(invoice_number, client_name), client:clients(company_name, cnpj)')
      .gte('bank_transaction_date', period.from)
      .lte('bank_transaction_date', period.to);
    if (alreadyError) throw alreadyError;

    const availableCandidates = [...(candidates ?? [])];
    const results: BankStatementMatchResult[] = [];

    for (const line of lines) {
      // Checagem de idempotência bancária: verifica se a transação já foi conciliada em execução anterior
      if (line.unique_transaction_id) {
        const already = (alreadyReconciled ?? []).find((bill) => {
          if (bill.pix_end_to_end_id === line.unique_transaction_id) return true;
          const raw = bill.bank_raw_snapshot as Record<string, unknown> | null;
          return raw?.textoIdentificadorUnicoTransacao === line.unique_transaction_id;
        });

        if (already) {
          results.push({
            ...line,
            match_status: 'matched',
            matched_bill_id: already.id,
            matched_bill: normalizeBill(already),
          });
          continue;
        }
      }

      // Prioridade 1: Match forte por unique_transaction_id == pix_end_to_end_id
      let matchIndex = line.unique_transaction_id
        ? availableCandidates.findIndex((bill) => bill.pix_end_to_end_id === line.unique_transaction_id)
        : -1;

      // Prioridade 2: Match forte por CNPJ/CPF da contrapartida + Valor dentro da tolerância
      // (ex: Pix recebido onde o BB traz o CNPJ do cliente que bate com clients.cnpj)
      if (matchIndex === -1 && line.counterparty_document) {
        const cleanLineDoc = cleanDocument(line.counterparty_document);
        if (cleanLineDoc) {
          matchIndex = availableCandidates.findIndex((bill) => {
            if (bill.type !== line.type) return false;
            if (Math.abs(bill.net_value - line.value) > VALUE_MATCH_TOLERANCE) return false;

            const clientCnpj = cleanDocument(bill.client?.cnpj);
            if (clientCnpj && clientCnpj === cleanLineDoc) return true;

            const counterpartyDoc = cleanDocument(bill.counterparty_name);
            if (counterpartyDoc && counterpartyDoc === cleanLineDoc) return true;

            return false;
          });
        }
      }

      // Prioridade 3: Fallback frouxo por tipo + data próxima + valor tolerado
      if (matchIndex === -1) {
        matchIndex = availableCandidates.findIndex((bill) =>
          bill.type === line.type &&
          bill.due_date != null &&
          daysBetween(bill.due_date, line.bank_date) <= DATE_MATCH_TOLERANCE_DAYS &&
          Math.abs(bill.net_value - line.value) <= VALUE_MATCH_TOLERANCE
        );
      }

      if (matchIndex === -1) {
        results.push({ ...line, match_status: 'unmatched', matched_bill_id: null, matched_bill: null });
        continue;
      }

      const [candidate] = availableCandidates.splice(matchIndex, 1);
      const updatedBill = await applyBankLineToBill(supabase, candidate.id, line);
      results.push({
        ...line,
        match_status: 'matched',
        matched_bill_id: updatedBill.id,
        matched_bill: normalizeBill(updatedBill),
      });
    }

    const response: ReconcileBankStatementResponse = {
      period,
      simulated,
      lines: results,
      matched_count: results.filter((r) => r.match_status === 'matched').length,
      unmatched_count: results.filter((r) => r.match_status === 'unmatched').length,
    };

    return res.json(response);
  } catch (error: any) {
    console.error('[reconcileBankStatement] Erro:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

// Vincula manualmente uma linha do extrato (que não bateu automaticamente)
// a um bill já existente escolhido pelo usuário — o bill é atualizado pra
// bater com o extrato (mesma operação usada no match automático).
export const linkStatementLineToBill = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const id = req.params.id as string;
    const line = req.body as BankStatementLine;

    if (!line || !line.bank_date || typeof line.value !== 'number' || !line.dc_indicator || !line.type) {
      return res.status(400).json({ error: 'Linha do extrato inválida: bank_date, value, dc_indicator e type são obrigatórios' });
    }

    const updatedBill = await applyBankLineToBill(supabase, id, line);
    return res.json(updatedBill);
  } catch (error: any) {
    console.error('[linkStatementLineToBill] Erro:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
