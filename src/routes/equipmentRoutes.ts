import { Router } from 'express';
import * as equipmentController from '../controllers/equipmentController';

const router = Router();

router.get('/', equipmentController.getAllEquipments);
router.get('/:id/rentals', equipmentController.getEquipmentRentals);
router.get('/:id', equipmentController.getEquipmentById);
router.post('/', equipmentController.createEquipment);
router.put('/:id', equipmentController.updateEquipment);
router.delete('/:id', equipmentController.deleteEquipment);

export default router;
