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

    const applyFilters = (q: any) => {
      if (search) {
        q = q.or(
          `client_name.ilike.%${search}%,equipment_name.ilike.%${search}%,asset_number.ilike.%${search}%,invoice_number.ilike.%${search}%`
        );
      }
      if (billingStatus) {
        q = q.eq('billing_status', billingStatus);
      }
      if (reconciliationStatus) {
        q = q.eq('reconciliation_status', reconciliationStatus);
      }
      if (dateFrom) {
        q = q.gte('billing_period_start', dateFrom);
      }
      if (dateTo) {
        q = q.lte('billing_period_start', dateTo);
      }
      if (valueMin > 0) {
        q = q.gte('total_value', valueMin);
      }
      if (valueMax > 0) {
        q = q.lte('total_value', valueMax);
      }
      return q;
    };

    let dataQuery = supabase
      .from('rental_invoices')
      .select('*', { count: 'exact' });
    dataQuery = applyFilters(dataQuery);

    let statsQuery = supabase
      .from('rental_invoices')
      .select('reconciliation_status, total_value');
    statsQuery = applyFilters(statsQuery);

    const [dataResult, statsResult] = await Promise.all([
      dataQuery.order('created_at', { ascending: false }).range(from, to),
      statsQuery
    ]);

    if (dataResult.error) throw dataResult.error;
    if (statsResult.error) throw statsResult.error;

    const statsData = statsResult.data || [];
    const pendingCount = statsData.filter(
      item => item.reconciliation_status === 'No prazo' || item.reconciliation_status === 'Atrasado' || item.reconciliation_status === 'Pendente'
    ).length;
    const totalValue = statsData.reduce((acc, curr) => acc + Number(curr.total_value || 0), 0);

    const total = dataResult.count ?? 0;
    const totalPages = Math.ceil(total / limit);

    return res.json({
      data: dataResult.data,
      total,
      page,
      limit,
      totalPages,
      stats: {
        pendingReconciliationCount: pendingCount,
        totalValue,
        monthlyReceivedTotal: totalValue
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
      billing_method: req.body.billing_method || 'MANUAL',
      ...req.body,
      total_value: total_value
    };

    const { data, error } = await supabase
      .from('rental_invoices')
      .insert([invoiceData])
      .select()
      .single();

    if (error) throw error;

    // Side effect: Logic for equipment status
    let warningMessage: string | null = null;
    const todayStr = new Date().toISOString().split('T')[0];
    const returnDateStr = invoiceData.return_date ? String(invoiceData.return_date).split('T')[0] : null;
    const periodEndStr = invoiceData.billing_period_end ? String(invoiceData.billing_period_end).split('T')[0] : null;

    if (returnDateStr && invoiceData.equipment_id) {
        if (returnDateStr <= todayStr) {
            // Data de retorno preenchida e menor ou igual a hoje -> 'Disponível'
            await supabase
                .from('equipments')
                .update({ status: 'Disponível' })
                .eq('id', invoiceData.equipment_id);
        } else {
            // Data de retorno futura -> permanece 'Locado'
            await supabase
                .from('equipments')
                .update({ status: 'Locado' })
                .eq('id', invoiceData.equipment_id);
        }
    } else if (invoiceData.equipment_id) {
        if (periodEndStr && periodEndStr < todayStr) {
            // Sem data de retorno e período final no passado -> 'Disponível' com aviso
            await supabase
                .from('equipments')
                .update({ status: 'Disponível' })
                .eq('id', invoiceData.equipment_id);

            warningMessage = 'A locação foi cadastrada sem data de retorno mesmo sendo no passado, por isso o equipamento ficará disponível no estoque.';
        } else {
            // Sem data de retorno no presente/futuro -> 'Locado'
            await supabase
                .from('equipments')
                .update({ status: 'Locado' })
                .eq('id', invoiceData.equipment_id);
        }
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

    return res.status(201).json({
      ...data,
      ...(warningMessage ? { warning: warningMessage } : {})
    });
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
    const todayStr = new Date().toISOString().split('T')[0];
    const returnDate = updateData.return_date !== undefined ? updateData.return_date : data.return_date;
    const returnDateStr = returnDate ? String(returnDate).split('T')[0] : null;
    const periodEnd = updateData.billing_period_end !== undefined ? updateData.billing_period_end : data.billing_period_end;
    const periodEndStr = periodEnd ? String(periodEnd).split('T')[0] : null;
    const targetEquipId = updateData.equipment_id || data.equipment_id;

    if (returnDateStr && targetEquipId) {
        if (returnDateStr <= todayStr) {
            await supabase
                .from('equipments')
                .update({ status: 'Disponível' })
                .eq('id', targetEquipId);
        } else {
            await supabase
                .from('equipments')
                .update({ status: 'Locado' })
                .eq('id', targetEquipId);
        }
    } else if (targetEquipId) {
        if (periodEndStr && periodEndStr < todayStr) {
            await supabase
                .from('equipments')
                .update({ status: 'Disponível' })
                .eq('id', targetEquipId);
        } else {
            await supabase
                .from('equipments')
                .update({ status: 'Locado' })
                .eq('id', targetEquipId);
        }
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

export const getOrCreateRentalContractDeal = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const supabase = getSupabaseUserClient(req.token!);

    // 1. Fetch rental invoice
    const { data: rental, error: rentalError } = await supabase
      .from('rental_invoices')
      .select('*')
      .eq('id', id)
      .single();

    if (rentalError || !rental) {
      return res.status(404).json({ error: 'Fatura de locação não encontrada' });
    }

    // 2. If deal_id already exists in rental or crm_deals links to rental_invoice_id, fetch the deal
    if (rental.deal_id) {
      const { data: existingDeal } = await supabase
        .from('crm_deals')
        .select('*, clients(*)')
        .eq('id', rental.deal_id)
        .maybeSingle();

      if (existingDeal) {
        return res.json({ deal: existingDeal });
      }
    }

    const { data: dealByInvoice } = await supabase
      .from('crm_deals')
      .select('*, clients(*)')
      .eq('rental_invoice_id', rental.id)
      .maybeSingle();

    if (dealByInvoice) {
      if (!rental.deal_id) {
        await supabase
          .from('rental_invoices')
          .update({ deal_id: dealByInvoice.id })
          .eq('id', rental.id);
      }
      return res.json({ deal: dealByInvoice });
    }

    // 3. Find the "Fechado Ganho" stage in the CRM pipelines
    const { data: wonStage } = await supabase
      .from('crm_pipeline_stages')
      .select('id, pipeline_id')
      .eq('is_won', true)
      .order('position', { ascending: false })
      .limit(1)
      .maybeSingle();

    let stageId = wonStage?.id;
    let pipelineId = wonStage?.pipeline_id;

    if (!stageId) {
      const { data: stageByName } = await supabase
        .from('crm_pipeline_stages')
        .select('id, pipeline_id')
        .ilike('name', '%Ganho%')
        .limit(1)
        .maybeSingle();
      stageId = stageByName?.id;
      pipelineId = stageByName?.pipeline_id;
    }

    // 4. Build title: equipment_name + asset_number
    const titleParts = [rental.equipment_name, rental.asset_number].filter(Boolean);
    const title = titleParts.length > 0 ? titleParts.join(' - ') : `Locação Nº ${rental.invoice_number || rental.id.substring(0, 8)}`;

    const expectedCloseDate = rental.billing_period_start
      ? rental.billing_period_start.split('T')[0]
      : (rental.created_at ? rental.created_at.split('T')[0] : new Date().toISOString().split('T')[0]);

    const dealPayload = {
      pipeline_id: pipelineId || null,
      stage_id: stageId || null,
      client_id: rental.client_id || null,
      rental_invoice_id: rental.id,
      title: title,
      value: Number(rental.total_value) || 0,
      expected_close_date: expectedCloseDate,
      closed_at: new Date().toISOString(),
      owner_id: req.user?.id || rental.created_by || null,
      description: `Locação Nº ${rental.invoice_number || rental.id.substring(0, 8)}`,
    };

    const { data: newDeal, error: dealError } = await supabase
      .from('crm_deals')
      .insert(dealPayload)
      .select('*, clients(*)')
      .single();

    if (dealError) throw dealError;

    // 5. Update rental with deal_id
    await supabase
      .from('rental_invoices')
      .update({ deal_id: newDeal.id })
      .eq('id', rental.id);

    // 6. Pre-populate contract form for this deal if not already created
    const { data: existingForm } = await supabase
      .from('crm_deal_contract_forms')
      .select('id')
      .eq('deal_id', newDeal.id)
      .maybeSingle();

    if (!existingForm) {
      let clientAddressFull = '';
      let clientStateReg = '';
      let clientContactName = '';
      let clientPhone = '';
      if (rental.client_id) {
        const { data: clientData } = await supabase
          .from('clients')
          .select('*')
          .eq('id', rental.client_id)
          .maybeSingle();

        if (clientData) {
          clientContactName = clientData.contact_name || '';
          clientPhone = clientData.phone || '';
          clientStateReg = clientData.state_subscription || '';
          clientAddressFull = [
            clientData.address_street,
            clientData.address_number,
            clientData.address_complement,
            clientData.address_city && clientData.address_state ? `${clientData.address_city}/${clientData.address_state}` : clientData.address_city,
            clientData.address_zip ? `CEP: ${clientData.address_zip}` : ''
          ].filter(Boolean).join(', ');
        }
      }

      let durationDays = 30;
      if (rental.billing_period_start && rental.billing_period_end) {
        const start = new Date(rental.billing_period_start).getTime();
        const end = new Date(rental.billing_period_end).getTime();
        const diff = Math.round((end - start) / (1000 * 60 * 60 * 24));
        if (diff > 0) durationDays = diff;
      }

      const formPayload = {
        deal_id: newDeal.id,
        contract_date: new Date().toISOString().split('T')[0],
        locatario_company_name: rental.client_name || '',
        locatario_cnpj: rental.cnpj || '',
        locatario_state_registration: clientStateReg,
        locatario_address_full: clientAddressFull,
        equipment_description: rental.equipment_name ? `${rental.equipment_name} (${rental.asset_number || ''})`.trim() : '',
        equipment_model: rental.equipment_type || '',
        contract_duration_days: durationDays,
        period_start: rental.billing_period_start ? rental.billing_period_start.split('T')[0] : null,
        period_end: rental.billing_period_end ? rental.billing_period_end.split('T')[0] : null,
        cost_rental: Number(rental.cost_rental) || 0,
        cost_insurance: Number(rental.cost_insurance) || 0,
        cost_freight: Number(rental.cost_freight) || 0,
        cost_rcd: Number(rental.cost_rcd) || 0,
        cost_third_party: Number(rental.cost_third_party) || 0,
        cost_training: Number(rental.cost_training) || 0,
        cost_total: Number(rental.total_value) || 0,
        billing_interval_days: 28,
        work_site: rental.work_site || '',
        site_contact_name: clientContactName,
        site_contact_phone: clientPhone,
        notes: rental.notes || '',
        form_status: 'Rascunho',
        created_by: req.user?.id
      };

      const { data: createdForm } = await supabase
        .from('crm_deal_contract_forms')
        .insert(formPayload)
        .select()
        .single();

      if (createdForm) {
        await supabase
          .from('crm_deals')
          .update({ contract_form_id: createdForm.id })
          .eq('id', newDeal.id);
      }
    }

    return res.json({ deal: newDeal });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

