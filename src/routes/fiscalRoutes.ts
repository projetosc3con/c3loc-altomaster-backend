import { Router } from 'express';
import { emitNfse, getNfseStatus } from '../controllers/fiscalController';
import * as nfeImportController from '../controllers/nfeImportController';
import {
  emitShippingNfeSaida,
  emitShippingNfeRetorno,
  registerExternalShippingNfe,
  getShippingDocuments,
  cancelShippingNfe,
} from '../controllers/shippingNfeController';
import { authorize } from '../middleware/auth';

const router = Router();

// Acesso NFS-e: Administrador/Diretoria/Gerente/Financeiro
const fullAccess = authorize(['Administrador', 'Diretoria', 'Gerente', 'Financeiro']);
// Acesso Importação e Emissão NF-e: Administrador/Diretoria/Gerente/Financeiro/Manutenção/Logística
const nfeAccess = authorize(['Administrador', 'Diretoria', 'Gerente', 'Financeiro', 'Manutenção', 'Logística']);

// Emissão e consulta de NFS-e de locação
router.post('/invoices/:id/nfse', fullAccess, emitNfse);
router.get('/invoices/:id/nfse', fullAccess, getNfseStatus);

// Importação e processamento de NF-e XML (Entrada/Saída de Peças, Ativos, Consumo, EPI)
router.post('/nfe/parse', nfeAccess, nfeImportController.parseXml);
router.post('/nfe/process', nfeAccess, nfeImportController.processImport);
router.get('/nfe/history', nfeAccess, nfeImportController.listImports);
router.get('/nfe/:id', nfeAccess, nfeImportController.getImportById);

// --- Rotas de Emissão de NF-e de Remessa e Retorno (Modelo 55) ---
router.post('/shipping/saida/:contractId', nfeAccess, emitShippingNfeSaida);
router.post('/shipping/retorno/:rentalId', nfeAccess, emitShippingNfeRetorno);
router.post('/shipping/retorno-externo/:rentalId', nfeAccess, registerExternalShippingNfe);
router.post('/shipping/cancel/:shippingInvoiceId', nfeAccess, cancelShippingNfe);
router.get('/shipping/documents/:rentalOrContractId', nfeAccess, getShippingDocuments);

export default router;
