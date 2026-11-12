import { Router } from 'express';
import * as clientController from '../controllers/clientController';
import { authorize } from '../middleware/auth';

const router = Router();

const fullAccess = authorize(['Administrador', 'Diretoria', 'Gerente']);
// Rotas de integração Asaas (não CRUD geral de cliente): Financeiro também
// tem acesso (ler e alterar), critério confirmado com o Victor em 19/08/2026.
const financeAccess = authorize(['Administrador', 'Diretoria', 'Gerente', 'Financeiro']);

router.get('/', clientController.getAllClients);
router.get('/lookup-cnpj/:cnpj', clientController.lookupCnpj);
router.get('/:id', clientController.getClientById);
router.post('/', fullAccess, clientController.createClient);
router.put('/:id', clientController.updateClient); // Assuming Comercial can edit clients as they can access /clientes/:id
router.post('/:id/asaas-sync', financeAccess, clientController.syncClientAsaas);
router.get('/:id/asaas-verify', financeAccess, clientController.verifyClientAsaas);
router.delete('/:id', fullAccess, clientController.deleteClient);

export default router;
