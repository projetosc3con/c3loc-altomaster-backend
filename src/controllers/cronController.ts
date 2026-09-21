import { Request, Response } from 'express';
import { updateOverdueBills } from '../services/billOverdueService';

/**
 * Controller para endpoints de Cron jobs (ex: Vercel Cron).
 */
export const handleUpdateOverdueBillsCron = async (req: Request, res: Response) => {
  try {
    // Validação de segurança opcional se CRON_SECRET estiver configurado nas variáveis da Vercel
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const authHeader = req.headers['authorization'];
      const vercelCronHeader = req.headers['x-vercel-cron'];

      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

      if (bearerToken !== cronSecret && !vercelCronHeader) {
        return res.status(401).json({ error: 'Não autorizado para executar este cron job.' });
      }
    }

    const result = await updateOverdueBills();
    return res.status(200).json(result);
  } catch (error: any) {
    console.error('[handleUpdateOverdueBillsCron] Erro ao executar cron:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno ao processar atualização de contas vencidas.',
    });
  }
};
