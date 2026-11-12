import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { getSupabaseUserClient, supabaseAdmin } from '../config/supabase';
import { asaasService } from '../services/asaasService';
import { AsaasCustomerRequest } from '../types/asaas';
import { cnpjService } from '../services/cnpjService';

export const getAllClients = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .order('company_name', { ascending: true });

    if (error) throw error;
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const lookupCnpj = async (req: AuthRequest, res: Response) => {
  const { cnpj } = req.params;
  try {
    const cnpjStr = Array.isArray(cnpj) ? cnpj[0] : (cnpj || '');
    const result = await cnpjService.lookupCnpj(cnpjStr);
    return res.json(result);
  } catch (error: any) {
    return res.status(400).json({ error: error.message || 'Erro ao consultar CNPJ' });
  }
};

export const getClientById = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const createClient = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('clients')
      .insert([req.body])
      .select()
      .single();

    if (error) throw error;
    return res.status(201).json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const updateClient = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('clients')
      .update(req.body)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const syncClientAsaas = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);

    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('*')
      .eq('id', id)
      .single();
    if (clientError || !client) {
      return res.status(404).json({ error: 'Cliente não encontrado' });
    }

    const { data: settings, error: settingsError } = await supabaseAdmin
      .from('erp_company_settings')
      .select('asaas_api_key')
      .eq('active', true)
      .single();
    if (settingsError) {
      console.error('[syncClientAsaas] Erro ao ler erp_company_settings:', settingsError);
    }
    if (!settings?.asaas_api_key) {
      return res.status(400).json({ error: 'Locadora sem chave Asaas configurada' });
    }

    const customerData: AsaasCustomerRequest = {
      name: client.company_name,
      cpfCnpj: client.cnpj,
      email: client.email || undefined,
      phone: client.phone || undefined,
      mobilePhone: client.phone || undefined,
      postalCode: client.address_zip ? client.address_zip.replace(/\D/g, '') : undefined,
      address: client.address_street || undefined,
      addressNumber: client.address_number || undefined,
      externalReference: client.id,
    };

    const customer = await asaasService.createCustomer(settings.asaas_api_key, customerData);

    const { data: updatedClient, error: updateError } = await supabase
      .from('clients')
      .update({ asaas_customer_id: customer.id })
      .eq('id', id)
      .select()
      .single();
    if (updateError) throw updateError;

    return res.json(updatedClient);
  } catch (error: any) {
    console.error('[syncClientAsaas] Erro:', error.response?.data || error.message);
    return res.status(500).json({ error: error.message, asaas: error.response?.data });
  }
};

// Debug: confirma server-side (sem copy/paste manual) que o customer existe no Asaas.
export const verifyClientAsaas = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);

    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('asaas_customer_id')
      .eq('id', id)
      .single();
    if (clientError || !client) {
      return res.status(404).json({ error: 'Cliente não encontrado' });
    }
    if (!client.asaas_customer_id) {
      return res.status(400).json({ error: 'Cliente ainda não sincronizado (asaas_customer_id vazio)' });
    }

    const { data: settings, error: settingsError } = await supabaseAdmin
      .from('erp_company_settings')
      .select('asaas_api_key')
      .eq('active', true)
      .single();
    if (settingsError) {
      console.error('[verifyClientAsaas] Erro ao ler erp_company_settings:', settingsError);
    }
    if (!settings?.asaas_api_key) {
      return res.status(400).json({ error: 'Locadora sem chave Asaas configurada' });
    }

    const customer = await asaasService.getCustomer(settings.asaas_api_key, client.asaas_customer_id);
    return res.json(customer);
  } catch (error: any) {
    console.error('[verifyClientAsaas] Erro:', error.response?.data || error.message);
    return res.status(500).json({ error: error.message, asaas: error.response?.data });
  }
};

export const deleteClient = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { error } = await supabase
      .from('clients')
      .delete()
      .eq('id', id);

    if (error) throw error;
    return res.status(204).send();
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};
