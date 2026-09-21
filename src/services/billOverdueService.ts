import { supabaseAdmin } from '../config/supabase';

export interface OverdueUpdateResult {
  success: boolean;
  message: string;
  totalUpdated: number;
  today: string;
  updatedBills: Array<{
    id: string;
    description: string;
    due_date: string;
    previous_status: string;
    counterparty_name: string | null;
  }>;
}

/**
 * Rotina para verificar e atualizar contas vencidas na tabela `bills`.
 * Busca todos os registros com `due_date < hoje` e status em ('Pendente', 'No prazo'),
 * alterando seu status para 'Atrasado'.
 */
export const updateOverdueBills = async (): Promise<OverdueUpdateResult> => {
  // Obter data de hoje no fuso horário do Brasil (America/Sao_Paulo) no formato YYYY-MM-DD
  const now = new Date();
  const todayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  console.log(`[Cron/OverdueBills] Iniciando verificação de contas com vencimento antes de ${todayStr}...`);

  // 1. Localizar contas que vencem antes de hoje com status 'Pendente' ou 'No prazo'
  const { data: billsToUpdate, error: fetchError } = await supabaseAdmin
    .from('bills')
    .select('id, description, due_date, status, counterparty_name')
    .lt('due_date', todayStr)
    .in('status', ['Pendente', 'No prazo']);

  if (fetchError) {
    console.error('[Cron/OverdueBills] Erro ao consultar contas vencidas:', fetchError);
    throw new Error(`Erro ao consultar contas vencidas: ${fetchError.message}`);
  }

  if (!billsToUpdate || billsToUpdate.length === 0) {
    console.log('[Cron/OverdueBills] Nenhuma conta com vencimento anterior a hoje precisando de atualização.');
    return {
      success: true,
      message: 'Nenhuma conta pendente ou no prazo com vencimento anterior a hoje foi encontrada.',
      totalUpdated: 0,
      today: todayStr,
      updatedBills: [],
    };
  }

  const idsToUpdate = billsToUpdate.map((b: any) => b.id);

  // 2. Atualizar o status para 'Atrasado'
  const { error: updateError } = await supabaseAdmin
    .from('bills')
    .update({
      status: 'Atrasado',
      updated_at: new Date().toISOString(),
    })
    .in('id', idsToUpdate);

  if (updateError) {
    console.error('[Cron/OverdueBills] Erro ao atualizar status das contas:', updateError);
    throw new Error(`Erro ao atualizar status das contas para 'Atrasado': ${updateError.message}`);
  }

  console.log(`[Cron/OverdueBills] Sucesso: ${billsToUpdate.length} conta(s) atualizada(s) para 'Atrasado'.`);

  return {
    success: true,
    message: `${billsToUpdate.length} conta(s) atualizada(s) com sucesso para status 'Atrasado'.`,
    totalUpdated: billsToUpdate.length,
    today: todayStr,
    updatedBills: billsToUpdate.map((b: any) => ({
      id: b.id,
      description: b.description || 'Conta sem descrição',
      due_date: b.due_date,
      previous_status: b.status,
      counterparty_name: b.counterparty_name || null,
    })),
  };
};
