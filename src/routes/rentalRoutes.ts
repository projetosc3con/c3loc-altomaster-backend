import { Router } from 'express';
import * as rentalController from '../controllers/rentalController';

const router = Router();

router.get('/', rentalController.getAllInvoices);
router.get('/:id/contract-deal', rentalController.getOrCreateRentalContractDeal);
router.get('/:id/contracts', rentalController.getRentalContracts);
router.post('/:id/service-orders', rentalController.createRentalServiceOrder);
router.post('/:id/extend', rentalController.extendInvoice);
router.get('/:id', rentalController.getInvoiceById);
router.post('/', rentalController.createInvoice);
router.put('/:id', rentalController.updateInvoice);
router.delete('/:id', rentalController.deleteInvoice);

export default router;
