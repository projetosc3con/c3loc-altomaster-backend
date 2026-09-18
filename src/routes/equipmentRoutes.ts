import { Router } from 'express';
import * as equipmentController from '../controllers/equipmentController';

const router = Router();

router.get('/', equipmentController.getAllEquipments);
router.get('/:id/rentals', equipmentController.getEquipmentRentals);
router.get('/:id/service-orders', equipmentController.getEquipmentServiceOrders);
router.get('/:id/hour-meter-logs', equipmentController.getEquipmentHourMeterLogs);
router.get('/:id/documents', equipmentController.getEquipmentDocuments);
router.post('/:id/documents', equipmentController.createEquipmentDocument);
router.put('/documents/:docId', equipmentController.updateEquipmentDocument);
router.delete('/documents/:docId', equipmentController.deleteEquipmentDocument);
router.get('/:id', equipmentController.getEquipmentById);
router.post('/', equipmentController.createEquipment);
router.put('/:id', equipmentController.updateEquipment);
router.delete('/:id', equipmentController.deleteEquipment);

export default router;

