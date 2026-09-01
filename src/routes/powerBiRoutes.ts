import { Router } from 'express';
import { validatePowerBiApiKey } from '../middleware/powerBiAuth';
import {
  getPowerBiOverview,
  getRentalInvoices,
  getBills,
  getClients,
  getEquipments,
  getUsersProfiles
} from '../controllers/powerBiController';

const router = Router();

// Aplica validação de API Key estática em todas as rotas do Power BI
router.use(validatePowerBiApiKey);

router.get('/', getPowerBiOverview);

// Endpoints principais solicitados
router.get('/rental_invoices', getRentalInvoices);
router.get('/rentals', getRentalInvoices); // Alias amigável

router.get('/bills', getBills);

router.get('/clients', getClients);

router.get('/equipments', getEquipments);

router.get('/users_profiles', getUsersProfiles);
router.get('/users', getUsersProfiles); // Alias amigável

export default router;
