import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { supabaseAdmin } from '../config/supabase';

/**
 * GET /api/notifications
 * Lista notificações endereçadas ao usuário autenticado (`notificar = req.user.id`).
 */
export const getMyNotifications = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
    const unreadOnly = req.query.unread_only === 'true';

    let query = supabaseAdmin
      .from('notifications')
      .select(`
        id,
        titulo,
        descricao,
        tabelaOrigem,
        uid,
        timestamp,
        notificar,
        lido,
        registroId,
        actor:users_profiles!notifications_uid_fkey(id, full_name, email, role_title, photo_url, access_level)
      `)
      .eq('notificar', userId)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (unreadOnly) {
      query = query.eq('lido', false);
    }

    const { data, error } = await query;

    if (error) throw error;

    return res.json(data || []);
  } catch (error: any) {
    console.error('[getMyNotifications] Erro:', error.message);
    return res.status(500).json({ error: error.message || 'Erro ao carregar notificações' });
  }
};

/**
 * PATCH /api/notifications/:id/read
 * Marca uma notificação específica como lida (ou alterna o status se `lido` for enviado no body).
 */
export const markNotificationAsRead = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const lido = req.body?.lido !== undefined ? Boolean(req.body.lido) : true;

    const { data, error } = await supabaseAdmin
      .from('notifications')
      .update({ lido })
      .eq('id', id)
      .eq('notificar', userId)
      .select()
      .single();

    if (error) throw error;

    return res.json(data);
  } catch (error: any) {
    console.error('[markNotificationAsRead] Erro:', error.message);
    return res.status(500).json({ error: error.message || 'Erro ao atualizar notificação' });
  }
};

/**
 * PATCH /api/notifications/read-all
 * Marca todas as notificações do usuário logado como lidas.
 */
export const markAllNotificationsAsRead = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    const { error } = await supabaseAdmin
      .from('notifications')
      .update({ lido: true })
      .eq('notificar', userId)
      .eq('lido', false);

    if (error) throw error;

    return res.json({ success: true });
  } catch (error: any) {
    console.error('[markAllNotificationsAsRead] Erro:', error.message);
    return res.status(500).json({ error: error.message || 'Erro ao marcar notificações como lidas' });
  }
};

/**
 * DELETE /api/notifications/:id
 * Remove uma notificação do usuário autenticado.
 */
export const deleteNotification = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    const { error } = await supabaseAdmin
      .from('notifications')
      .delete()
      .eq('id', id)
      .eq('notificar', userId);

    if (error) throw error;

    return res.status(204).send();
  } catch (error: any) {
    console.error('[deleteNotification] Erro:', error.message);
    return res.status(500).json({ error: error.message || 'Erro ao excluir notificação' });
  }
};

