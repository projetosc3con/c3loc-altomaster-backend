import { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';

export const getPowerBiOverview = async (req: Request, res: Response) => {
  return res.json({
    status: 'ok',
    message: 'API Power BI - RentDesk / C3Loc',
    endpoints: {
      rental_invoices: '/api/powerbi/rental_invoices',
      bills: '/api/powerbi/bills',
      clients: '/api/powerbi/clients',
      equipments: '/api/powerbi/equipments',
      users_profiles: '/api/powerbi/users_profiles',
      crm_deals: '/api/powerbi/crm_deals',
      crm_deal_contracts: '/api/powerbi/crm_deal_contracts',
      parts: '/api/powerbi/parts',
      rental_billing_invoices: '/api/powerbi/rental_billing_invoices',
      rental_invoice_equipments: '/api/powerbi/rental_invoice_equipments',
      service_order_parts: '/api/powerbi/service_order_parts',
      service_orders: '/api/powerbi/service_orders',
      stock_movements: '/api/powerbi/stock_movements'
    }
  });
};

export const getRentalInvoices = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('rental_invoices')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getBills = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('bills')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getClients = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('clients')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getEquipments = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('equipments')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getUsersProfiles = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users_profiles')
      .select('id, full_name, cpf, birth_date, phone, email, address_street, address_number, address_complement, address_city, address_state, address_zip, role_title, access_level, active, created_at, updated_at, photo_url')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getCrmDeals = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('crm_deals')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getCrmDealContracts = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('crm_deal_contracts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getParts = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('parts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getRentalBillingInvoices = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('rental_billing_invoices')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getRentalInvoiceEquipments = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('rental_invoice_equipments')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getServiceOrderParts = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('service_order_parts')
      .select('*');

    if (error) throw error;
    return res.json(data || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getServiceOrders = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('service_orders')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getStockMovements = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('stock_movements')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data || []);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};
