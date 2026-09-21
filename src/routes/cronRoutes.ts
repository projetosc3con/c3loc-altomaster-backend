import { Router } from 'express';
import { handleUpdateOverdueBillsCron } from '../controllers/cronController';

const router = Router();

// Endpoint para Vercel Cron (que envia requisição GET) ou acionamento manual (POST)
router.get('/update-overdue-bills', handleUpdateOverdueBillsCron);
router.post('/update-overdue-bills', handleUpdateOverdueBillsCron);

export default router;
