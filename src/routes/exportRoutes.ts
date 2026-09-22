import { Router } from 'express';
import { exportClientsToXlsx, exportRentalsToXlsx, exportBillsToXlsx } from '../controllers/exportController';

const router = Router();

// GET /api/exports/clients → generates XLSX, uploads to storage, returns signed download URL
router.get('/clients', exportClientsToXlsx);

// GET /api/exports/rentals → generates XLSX for rental invoices with optional filters
router.get('/rentals', exportRentalsToXlsx);

// GET /api/exports/bills → generates XLSX for bills (payables / receivables) with optional filters
router.get('/bills', exportBillsToXlsx);

export default router;

