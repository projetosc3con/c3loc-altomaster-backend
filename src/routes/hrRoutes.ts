import { Router } from 'express';
import {
  getPositions, getLevels, createLevel, getLevelById, updateLevel, deleteLevel,
  getEmployees, getEmployeeById, updateEmployee,
  getEmployeeDocumentationDetails, getRecentActivities, getPositionHistory,
  getDocumentTypes, createDocumentType, updateDocumentType,
  createPosition, getPositionById, updatePosition, changeEmployeePosition,
  getEmployeeDocuments, createEmployeeDocument,
  // Ponto
  getEmployeeTimesheets, getEmployeeTimeRecords,
  createTimesheetReport, updateTimesheetStatus,
  getMyTodayRecords, clockIn,
  // Férias
  getEmployeeVacationRequests, createVacationRequest,
  // EPI
  getEpiCatalog, getEmployeeEpiRecords, createEpiRecord,
  // Treinamentos
  getTrainingCatalog, createTrainingCatalog, updateTrainingCatalog,
  getEmployeeTrainings, createEmployeeTraining, getTrainingMetrics,
  // Integrations
  getIntegrationTypes, createIntegrationType, updateIntegrationType,
  getEmployeeIntegrations, createEmployeeIntegration, getIntegrationMetrics,
} from '../controllers/hrController';

const router = Router();

// Positions
router.get('/positions', getPositions);
router.post('/positions', createPosition);
router.get('/positions/:id', getPositionById);
router.put('/positions/:id', updatePosition);

// Levels
router.get('/levels', getLevels);
router.post('/levels', createLevel);
router.get('/levels/:id', getLevelById);
router.put('/levels/:id', updateLevel);
router.delete('/levels/:id', deleteLevel);

// Employees
router.get('/employees', getEmployees);
router.get('/employees/:id', getEmployeeById);
router.put('/employees/:id', updateEmployee);
router.get('/employees/:id/documents', getEmployeeDocumentationDetails);
router.get('/employees/:id/timesheets', getEmployeeTimesheets);
router.post('/employees/:id/timesheets', createTimesheetReport);
router.patch('/timesheets/:timesheetId/status', updateTimesheetStatus);
router.get('/employees/:id/time-records', getEmployeeTimeRecords);

// Clock-in (próprio usuário)
router.get('/clock-in/today', getMyTodayRecords);
router.post('/clock-in', clockIn);
router.get('/employees/:id/vacation-requests', getEmployeeVacationRequests);
router.post('/employees/:id/vacation-requests', createVacationRequest);
router.get('/employees/:id/epi-records', getEmployeeEpiRecords);
router.post('/employees/:id/epi-records', createEpiRecord);

// Employee positions
router.post('/employee-positions', changeEmployeePosition);

// Recent activity / history
router.get('/recent-activities', getRecentActivities);
router.get('/position-history', getPositionHistory);

// Document types
router.get('/document-types', getDocumentTypes);
router.post('/document-types', createDocumentType);
router.put('/document-types/:id', updateDocumentType);

// Employee documents
router.get('/employee-documents', getEmployeeDocuments);
router.post('/employee-documents', createEmployeeDocument);

// EPI Catalog
router.get('/epi-catalog', getEpiCatalog);

// Trainings
router.get('/trainings/catalog', getTrainingCatalog);
router.post('/trainings/catalog', createTrainingCatalog);
router.put('/trainings/catalog/:id', updateTrainingCatalog);
router.get('/trainings/metrics', getTrainingMetrics);
router.get('/trainings', getEmployeeTrainings);
router.post('/trainings', createEmployeeTraining);

// Integrations
router.get('/integrations/types', getIntegrationTypes);
router.post('/integrations/types', createIntegrationType);
router.put('/integrations/types/:id', updateIntegrationType);
router.get('/integrations/metrics', getIntegrationMetrics);
router.get('/integrations', getEmployeeIntegrations);
router.post('/integrations', createEmployeeIntegration);

export default router;
