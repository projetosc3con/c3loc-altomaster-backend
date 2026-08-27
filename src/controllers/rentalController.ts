import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { getSupabaseUserClient } from '../config/supabase';

export const getAllInvoices = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 15));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // Extract filter params
    const search = (req.query.search as string) || '';
    const billingStatus = (req.query.billing_status as string) || '';
    const reconciliationStatus = (req.query.reconciliation_status as string) || '';
    const dateFrom = (req.query.date_from as string) || '';
    const dateTo = (req.query.date_to as string) || '';
    const valueMin = parseFloat(req.query.value_min as string) || 0;
    const valueMax = parseFloat(req.query.value_max as string) || 0;

    let query = supabase
      .from('rental_invoices')
      .select('*', { count: 'exact' });

    // Full-text search across multiple columns
    if (search) {
      query = query.or(
        `client_name.ilike.%${search}%,equipment_name.ilike.%${search}%,asset_number.ilike.%${search}%,invoice_number.ilike.%${search}%`
      );
    }

    // Status filters
    if (billingStatus) {
      query = query.eq('billing_status', billingStatus);
    }
    if (reconciliationStatus) {
      query = query.eq('reconciliation_status', reconciliationStatus);
    }

    // Date range filter (on billing_period_start)
    if (dateFrom) {
      query = query.gte('billing_period_start', dateFrom);
    }
    if (dateTo) {
      query = query.lte('billing_period_start', dateTo);
    }

    // Value range filter
    if (valueMin > 0) {
      query = query.gte('total_value', valueMin);
    }
    if (valueMax > 0) {
      query = query.lte('total_value', valueMax);
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw error;

    // Fetch extra stats for the cards
    // 1. Pending Reconciliation Count (No prazo or Atrasado)
    const { count: pendingCount } = await supabase
      .from('rental_invoices')
      .select('*', { count: 'exact', head: true })
      .or('reconciliation_status.eq.No prazo,reconciliation_status.eq.Atrasado');

    // 2. Monthly Received Total
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();

    const { data: receivedData } = await supabase
      .from('rental_invoices')
      .select('total_value')
      .eq('reconciliation_status', 'Recebido')
      .gte('bank_reconciliation_date', startOfMonth)
      .lte('bank_reconciliation_date', endOfMonth);

    const monthlyReceivedTotal = (receivedData || []).reduce((acc, curr) => acc + Number(curr.total_value || 0), 0);

    const total = count ?? 0;
    const totalPages = Math.ceil(total / limit);

    return res.json({
      data,
      total,
      page,
      limit,
      totalPages,
      stats: {
        pendingReconciliationCount: pendingCount || 0,
        monthlyReceivedTotal
      }
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getInvoiceById = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { data, error } = await supabase
      .from('rental_invoices')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const createInvoice = async (req: AuthRequest, res: Response) => {
  try {
    const supabase = getSupabaseUserClient(req.token!);
    
    // Business logic: Calculate total value if provided individual costs
    const { 
      cost_rental = 0, 
      cost_insurance = 0, 
      cost_freight = 0, 
      cost_rcd = 0, 
      cost_third_party = 0, 
      cost_training = 0 
    } = req.body;

    const total_value = 
      Number(cost_rental) + 
      Number(cost_insurance) + 
      Number(cost_freight) + 
      Number(cost_rcd) + 
      Number(cost_third_party) + 
      Number(cost_training);

    const invoiceData = {
      ...req.body,
      total_value: total_value
    };

    const { data, error } = await supabase
      .from('rental_invoices')
      .insert([invoiceData])
      .select()
      .single();

    if (error) throw error;

    // Side effect: If return_date is set, update equipment status to 'Disponível'
    if (invoiceData.return_date && invoiceData.equipment_id) {
        await supabase
            .from('equipments')
            .update({ status: 'Disponível' })
            .eq('id', invoiceData.equipment_id);
    } else if (invoiceData.equipment_id) {
        // If it's a new rental without return date, equipment becomes 'Locado'
        await supabase
            .from('equipments')
            .update({ status: 'Locado' })
            .eq('id', invoiceData.equipment_id);
    }

    // Disparar lançamento correspondente em `bills` (tipo receivable)
    if (data && data.client_id && data.due_date && total_value > 0) {
      const dueDate = String(data.due_date).split('T')[0];

      // Verifica se já existe um lançamento com o mesmo valor, mesma data e mesmo cliente
      const { data: existingBills, error: checkError } = await supabase
        .from('bills')
        .select('id')
        .eq('client_id', data.client_id)
        .eq('due_date', dueDate)
        .eq('gross_value', total_value);

      if (checkError) {
        console.error('[rentalController] Erro ao consultar duplicidade em bills:', checkError);
      }

      if (!checkError && (!existingBills || existingBills.length === 0)) {
        const billStatus = data.reconciliation_status || 'Pendente';
        const { error: billError } = await supabase
          .from('bills')
          .insert({
            origin: 'MANUAL',
            type: 'receivable',
            rental_invoice_id: data.id,
            client_id: data.client_id,
            counterparty_name: data.client_name || invoiceData.client_name || null,
            description: data.invoice_number ? `Fatura de Locação #${data.invoice_number}` : 'Fatura de Locação',
            gross_value: total_value,
            fee_amount: 0,
            net_value: total_value,
            due_date: dueDate,
            status: billStatus,
            reconciled_at: billStatus === 'Recebido' ? new Date().toISOString() : null,
            created_by: req.user?.id || null,
          });

        if (billError) {
          console.error('[rentalController] Erro ao criar lançamento em bills:', billError);
        }
      }
    }

    return res.status(201).json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const updateInvoice = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    
    // Recalculate total if costs changed
    const { 
      cost_rental, 
      cost_insurance, 
      cost_freight, 
      cost_rcd, 
      cost_third_party, 
      cost_training 
    } = req.body;

    let updateData = { ...req.body };

    if (cost_rental !== undefined || cost_insurance !== undefined || cost_freight !== undefined) {
        // Fetch current values for missing ones
        const { data: current } = await supabase.from('rental_invoices').select('*').eq('id', id).single();
        if (current) {
            const total_value = 
              Number(cost_rental ?? current.cost_rental ?? 0) + 
              Number(cost_insurance ?? current.cost_insurance ?? 0) + 
              Number(cost_freight ?? current.cost_freight ?? 0) + 
              Number(cost_rcd ?? current.cost_rcd ?? 0) + 
              Number(cost_third_party ?? current.cost_third_party ?? 0) + 
              Number(cost_training ?? current.cost_training ?? 0);
            updateData.total_value = total_value;
        }
    }

    const { data, error } = await supabase
      .from('rental_invoices')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // Side effect logic for equipment status
    if (updateData.return_date && data.equipment_id) {
        await supabase
            .from('equipments')
            .update({ status: 'Disponível' })
            .eq('id', data.equipment_id);
    }

    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const deleteInvoice = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);
    const { error } = await supabase
      .from('rental_invoices')
      .delete()
      .eq('id', id);

    if (error) throw error;
    return res.status(204).send();
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};
