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

// Aplica o dado de uma linha do extrato bancário sobre um bill existente —
// usado tanto no match automático (reconcileBankStatement) quanto no vínculo
// manual (linkStatementLineToBill). O bill passa a refletir exatamente o que
// está no banco (due_date/valor), além de ficar marcado como conciliado.
async function applyBankLineToBill(supabase: ReturnType<typeof getSupabaseUserClient>, billId: string, line: BankStatementLine) {
  const { data: existing, error: fetchError } = await supabase
    .from('bills')
    .select('net_value, type')
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
// Match, em ordem de prioridade: (1) forte, unique_transaction_id da linha
// == pix_end_to_end_id do bill (autoritativo); (2) fallback frouxo, mesmo
// tipo (D->payable, C->receivable) + valor dentro de VALUE_MATCH_TOLERANCE +
// due_date dentro de DATE_MATCH_TOLERANCE_DAYS — usado só quando não há
// identificador forte dos dois lados (bill manual, ou repasse PIX ainda
// simulado). O critério frouxo é ambíguo por natureza: se dois bills
// diferentes tiverem tipo/valor/data parecidos, ele pode casar com o errado
// — ambiguidade não tratada por ora (não bloqueia nem sinaliza, só casa com
// o primeiro candidato encontrado). Cada bill só pode ser consumido por uma
// linha por execução. A tabela de extrato em si NÃO é persistida — só o
// resultado desta chamada (linhas + match) volta pro front, que guarda isso
// em estado local; os `bills` batidos são atualizados no banco via
// applyBankLineToBill.
export const reconcileBankStatement = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const period = resolvePeriod(req.query.from, req.query.to);

    const { simulated, lines } = await bbExtratoService.fetchExtrato(period);

    // Sem filtro de due_date aqui de propósito: o match forte por
    // unique_transaction_id/pix_end_to_end_id precisa poder alcançar um bill
    // mesmo que o cliente tenha pago fora da janela esperada (ex: fatura
    // vencida há semanas, quitada com atraso) — restringir por due_date
    // faria esse bill nunca aparecer entre os candidatos, mesmo tendo o
    // identificador forte batendo. O critério frouxo (fallback) já aplica
    // sua própria checagem de proximidade de data em memória logo abaixo,
    // então não perde precisão por não filtrar aqui. Aceitável escanear
    // todos os bills não conciliados: sistema single-tenant, baixo volume.
    const { data: candidates, error: candidatesError } = await supabase
      .from('bills')
      .select('*, invoice:rental_invoices(invoice_number, client_name), client:clients(company_name, cnpj)')
      .is('bank_transaction_date', null);
    if (candidatesError) throw candidatesError;

    const availableCandidates = [...(candidates ?? [])];
    const results: BankStatementMatchResult[] = [];

    for (const line of lines) {
      // Match forte: `unique_transaction_id` do extrato (identificador único
      // da transação no BB) bate exatamente com `bills.pix_end_to_end_id`.
      // É autoritativo: pula o critério frouxo abaixo por completo, então
      // não sofre com colisão de tipo+data+valor entre bills diferentes
      // (ex: dois clientes com parcela do mesmo valor vencendo na mesma
      // semana — sem esse match forte, o critério frouxo pode casar com o
      // bill errado e sobrescrever os dados dele com os dessa linha).
      // Hoje `pix_end_to_end_id` só é preenchido em bills lançados manualmente
      // com esse dado à mão — bills de origin=ASAAS nascem sempre com esse
      // campo null (não existe mais repasse PIX automático, ver
      // asaasWebhookController.createBillFromPayment), então praticamente
      // todo match de bill ASAAS cai no fallback frouxo abaixo.
      let matchIndex = line.unique_transaction_id
        ? availableCandidates.findIndex((bill) => bill.pix_end_to_end_id === line.unique_transaction_id)
        : -1;

      // Fallback frouxo: entra em jogo sempre que não há identificador forte
      // dos dois lados (hoje, praticamente sempre — ver comentário acima).
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
