import { Router } from 'express';
import { validatePowerBiApiKey } from '../middleware/powerBiAuth';
import {
  getPowerBiOverview,
  getRentalInvoices,
  getBills,
  getClients,
  getEquipments,
  getUsersProfiles,
  getCrmDeals,
  getCrmDealContracts,
  getParts,
  getRentalBillingInvoices,
  getRentalInvoiceEquipments,
  getServiceOrderParts,
  getServiceOrders,
  getStockMovements
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

router.get('/crm_deals', getCrmDeals);
router.get('/deals', getCrmDeals); // Alias amigável

router.get('/crm_deal_contracts', getCrmDealContracts);
router.get('/deal_contracts', getCrmDealContracts); // Alias amigável

router.get('/parts', getParts);

router.get('/rental_billing_invoices', getRentalBillingInvoices);
router.get('/faturas', getRentalBillingInvoices); // Alias amigável

router.get('/rental_invoice_equipments', getRentalInvoiceEquipments);

router.get('/service_order_parts', getServiceOrderParts);

router.get('/service_orders', getServiceOrders);
router.get('/os', getServiceOrders); // Alias amigável

router.get('/stock_movements', getStockMovements);

export default router;
