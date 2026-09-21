import { Router } from 'express';
import * as serviceOrderController from '../controllers/serviceOrderController';
import * as rcdController from '../controllers/serviceOrderRcdController';

const router = Router();

router.get('/', serviceOrderController.getAllServiceOrders);
router.get('/:id', serviceOrderController.getServiceOrderById);
router.post('/', serviceOrderController.createServiceOrder);
router.put('/:id', serviceOrderController.updateServiceOrder);
router.patch('/:id/status', serviceOrderController.updateServiceOrderStatus);
router.delete('/:id', serviceOrderController.deleteServiceOrder);

// RCD (Ressarcimento de Despesas e Danos)
router.get('/:id/rcd', rcdController.getRcdByServiceOrderId);
router.post('/:id/rcd', rcdController.saveServiceOrderRcd);
router.post('/:id/rcd/launch-bills', rcdController.launchRcdBills);
router.post('/:id/rcd/unlink-bills', rcdController.unlinkRcdBills);

export default router;
