import { Router } from 'express';
import * as trainingController from '../controllers/trainingController';
import { authorize } from '../middleware/auth';

const router = Router();
const managerAccess = authorize(['Administrador', 'Diretoria']);

// Catálogo e listagens gerais
router.get('/', trainingController.getTrainings);
router.get('/categories', trainingController.getCategories);
router.get('/topics-catalog', trainingController.getTopicCatalog);
router.get('/assignments/all', managerAccess, trainingController.getAllAssignments);
router.get('/:id', trainingController.getTrainingById);

// Gestão de treinamentos (Administrador e Diretoria)
router.post('/', managerAccess, trainingController.createTraining);
router.put('/:id', managerAccess, trainingController.updateTraining);
router.delete('/:id', managerAccess, trainingController.deleteTraining);

// Atribuição de treinamentos (Administrador e Diretoria)
router.post('/:id/assign', managerAccess, trainingController.assignTraining);
router.delete('/:id/assign/:assignmentId', managerAccess, trainingController.unassignTraining);
router.delete('/assignments/:id', managerAccess, trainingController.unassignTrainingById);

// Progresso e conclusão do colaborador / gestor
router.patch('/assignments/:id/progress', trainingController.updateProgress);
router.patch('/assignments/:id/complete', trainingController.completeTraining);

export default router;
