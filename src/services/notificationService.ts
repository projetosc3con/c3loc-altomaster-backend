import { supabaseAdmin } from '../config/supabase';

export interface CreateSystemNotificationParams {
  titulo: string;
  descricao: string;
  tabelaOrigem: string;
  actorUid?: string | null;
  registroId?: string | number | null;
}

/**
 * Cria registros de notificação na tabela `public.notifications` para todos os
 * usuários ativos com `access_level` em ('Administrador', 'Diretoria'),
 * exceto o próprio usuário que realizou a ação (`actorUid`).
 */
export const notifyAdminsAndDirectors = async ({
  titulo,
  descricao,
  tabelaOrigem,
  actorUid,
  registroId,
}: CreateSystemNotificationParams): Promise<void> => {
  try {
    let query = supabaseAdmin
      .from('users_profiles')
      .select('id, full_name, access_level')
      .in('access_level', ['Administrador', 'Diretoria'])
      .eq('active', true);

    if (actorUid) {
      query = query.neq('id', actorUid);
    }

    const { data: recipients, error: fetchError } = await query;

    if (fetchError) {
      console.error('[notificationService] Erro ao buscar destinatários:', fetchError.message);
      return;
    }

    if (!recipients || recipients.length === 0) {
      return;
    }

    const nowIso = new Date().toISOString();
    const rows = recipients.map((r: any) => ({
      titulo,
      descricao,
      tabelaOrigem,
      uid: actorUid || null,
      timestamp: nowIso,
      notificar: r.id,
      lido: false,
      registroId: registroId != null ? String(registroId) : null,
    }));

    const { error: insertError } = await supabaseAdmin
      .from('notifications')
      .insert(rows);

    if (insertError) {
      console.error('[notificationService] Erro ao inserir notificações:', insertError.message);
    }
  } catch (err: any) {
    console.error('[notificationService] Erro inesperado ao gerar notificações:', err?.message || err);
  }
};

